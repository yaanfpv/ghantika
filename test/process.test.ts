import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import {
  MANAGED_CHILD_STDIO,
  POSIX_DEFAULT_PATH,
  buildChildEnv,
  resolveCaseInsensitivePathKey,
  resolveCwd,
  resolveExecutable,
  spawnManaged,
} from "../dist/process.js";
import {
  IDENTITY_TOLERANCE_SECONDS,
  GROUP_CONFIRMATION_TIMEOUT_MS,
  POSIX_KILL_GRACE_PERIOD_MS,
  PROCESS_IDENTITY_OBSERVATION_TIMEOUT_MS,
  captureBirthIdentityPosix,
  captureBirthIdentityPosixAsync,
  captureEscalationIdentitySnapshot,
  checkProcessIdentity,
  confirmProcessGroupReapedPosix,
  evaluateEscalationIdentityGate,
  evaluatePreSignalIdentityGate,
  hasLiveProcessGroupMembersPosix,
  identityElapsedTimesMatch,
  isProcessAlive,
  isProcessGroupAlive,
  killProcessGroupPosix,
  killProcessTreeWindows,
  parseEtime,
  parsePidLstartRow,
  readPidStartTimesBatchPosix,
  signalProcessGroupPosix,
  throwUnlessBenignAlreadyGoneRace,
  waitForProcessDeath,
} from "../dist/process.js";

// Explicit ".ts" extension - this helper has no relative imports of its
// own, so Node's native TypeScript support can load it directly without a
// build step - see test/kill.test.ts's identical comment on the same
// pattern for a sibling helper.
import {
  retryBirthIdentityCapture,
  BIRTH_IDENTITY_CAPTURE_RETRY_BOUND_MS,
} from "./helpers/birthIdentityRetry.ts";

// A handful of tests below exercise real POSIX process-GROUP primitives
// this codebase's own code never asks Windows to perform (real `ps`/`pgrep`
// invocations, `process.kill(-pid, ...)`'s negative-pid group form, and
// spawning bare `sleep`) - none of that has a win32 equivalent to run
// against, so these skip there rather than hang or fail on a platform gap
// this test is not measuring. This is a TEST-HARNESS gap, not a product
// scope decision. Windows is a supported platform; whether src/process.ts's
// own win32 kill path (taskkill-based process-tree termination) actually
// works is a separate question, not answered by skipping these.
const POSIX_PROCESS_GROUP_SKIP =
  process.platform === "win32"
    ? "exercises a real POSIX process-group primitive (ps/pgrep/negative-pid kill) with no win32 equivalent path here"
    : false;

// A structural guarantee: a real child's stdout must never
// be wired directly to the server's own stdout. "pipe" hands the server a
// stream it must explicitly read from and forward somewhere (JobStore) -
// "inherit" would connect the child's fd 1 straight to the MCP protocol
// channel, corrupting every message after the child writes anything.

test("MANAGED_CHILD_STDIO wires a future child's stdout through a pipe, never inherit", () => {
  assert.equal(MANAGED_CHILD_STDIO[1], "pipe");
  assert.notEqual(MANAGED_CHILD_STDIO[1], "inherit");
});

test("MANAGED_CHILD_STDIO wires a future child's stderr through a pipe too, for the same reason", () => {
  assert.equal(MANAGED_CHILD_STDIO[2], "pipe");
  assert.notEqual(MANAGED_CHILD_STDIO[2], "inherit");
});

test("MANAGED_CHILD_STDIO ignores stdin (run is fire-and-forget, not interactive)", () => {
  assert.equal(MANAGED_CHILD_STDIO[0], "ignore");
});

// mutation control: prove the assertion above is actually discriminating,
// not vacuously true for any array - an "inherit" value must fail it.
test("mutation control: a stdio config using inherit for stdout would fail the same assertion", () => {
  const mutant: readonly string[] = ["ignore", "inherit", "pipe"];
  assert.notEqual(mutant[1], "pipe");
  assert.throws(() => assert.equal(mutant[1], "pipe"));
});

// ---------------------------------------------------------------------------
// resolveCwd
// ---------------------------------------------------------------------------

test("resolveCwd with no cwd argument defaults to (and realpath-resolves) the server's own process.cwd()", () => {
  const result = resolveCwd(undefined);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.resolvedCwd, fs.realpathSync(process.cwd()));
  }
});

test("resolveCwd accepts and realpath-resolves an existing directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-resolvecwd-"));
  const result = resolveCwd(dir);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.resolvedCwd, fs.realpathSync(dir));
  }
});

test("resolveCwd rejects a nonexistent path with ok: false, never silently defaulting", () => {
  const result = resolveCwd("/no/such/directory/at/all/ghantika-test");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /does not exist/);
  }
});

test("resolveCwd rejects a path that exists but is a file, not a directory", () => {
  const filePath = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-resolvecwd-file-"));
  const file = path.join(filePath, "im-a-file");
  fs.writeFileSync(file, "not a directory");
  const result = resolveCwd(file);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /not a directory/);
  }
});

// ---------------------------------------------------------------------------
// buildChildEnv
// ---------------------------------------------------------------------------

test("buildChildEnv merge mode layers caller vars OVER a minimal base, never the full server process.env", () => {
  const env = buildChildEnv("merge", { CUSTOM_VAR: "value" });
  assert.equal(env.CUSTOM_VAR, "value");
  assert.equal(typeof env.PATH, "string");
  assert.ok(env.PATH.length > 0);
  // The server's own process.env almost certainly has variables NOT in our
  // curated minimal base (e.g. this test runner's own harness-injected
  // vars) - assert at least one such variable, if present on this host, is
  // NOT wholesale-inherited into the child's env.
  const serverOnlyKeys = Object.keys(process.env).filter(
    (key) => key !== "PATH" && key !== "HOME" && key !== "CUSTOM_VAR"
  );
  const leaked = serverOnlyKeys.filter((key) => key in env);
  assert.deepEqual(
    leaked,
    [],
    `merge mode must not wholesale-inherit process.env; leaked keys: ${leaked.join(", ")}`
  );
});

// ---------------------------------------------------------------------------
// "A job's env must NEVER be the server's own full process.env passed
// through wholesale" - a STRUCTURAL proof, not just "merge produces the
// expected output" (the existing test above already checks this
// incidentally against whatever happens to be in this test runner's own
// real process.env; these two are deterministic and don't depend on what
// the host environment happens to contain).
// ---------------------------------------------------------------------------

test("(structural) a DETERMINISTIC canary planted directly on process.env is never wholesale-inherited into a merge-mode child env", () => {
  const canaryKey = "GHANTIKA_TEST_FORBIDDEN_WHOLE_ENV_CANARY";
  const canaryValue = "must-never-leak-into-a-child-env";
  process.env[canaryKey] = canaryValue;
  try {
    const env = buildChildEnv("merge", { CUSTOM_VAR: "value" });
    assert.equal(
      canaryKey in env,
      false,
      "merge mode must never wholesale-inherit an arbitrary process.env key, however it got there"
    );
    assert.notEqual(
      JSON.stringify(env).includes(canaryValue),
      true,
      "the canary's VALUE must never leak into the child env either"
    );
  } finally {
    delete process.env[canaryKey];
  }
});

test("(structural) the SAME canary is ALSO absent in replace mode (replace mode's own docs already claim 'no base at all' - this proves it structurally, not just for the vars the caller happened to supply)", () => {
  const canaryKey = "GHANTIKA_TEST_FORBIDDEN_WHOLE_ENV_CANARY_REPLACE";
  process.env[canaryKey] = "also-must-never-leak";
  try {
    const env = buildChildEnv("replace", { ONLY_VAR: "x" });
    assert.equal(canaryKey in env, false);
    assert.deepEqual(
      Object.keys(env),
      ["ONLY_VAR"],
      "replace mode's key set must be EXACTLY the caller's own vars - nothing else, ever"
    );
  } finally {
    delete process.env[canaryKey];
  }
});

test("(structural) merge mode's key set is a subset of {the curated minimal base} UNION {the caller's own vars} - never anything wider, checked structurally against process.env's real current key set", () => {
  const callerVars = { CUSTOM_ONE: "a", CUSTOM_TWO: "b" };
  const env = buildChildEnv("merge", callerVars);
  const curatedBaseKeys =
    process.platform === "win32" ? ["PATH", "SystemRoot", "USERPROFILE"] : ["PATH", "HOME"];
  const allowedKeys = new Set([...curatedBaseKeys, ...Object.keys(callerVars)]);
  const unexpectedKeys = Object.keys(env).filter((key) => !allowedKeys.has(key));
  assert.deepEqual(
    unexpectedKeys,
    [],
    `merge mode produced key(s) outside the curated base + caller vars: ${unexpectedKeys.join(", ")} - this would mean something wider than the documented minimal base leaked through`
  );
});

test("buildChildEnv merge mode lets the caller override a minimal-base value (e.g. PATH)", () => {
  const env = buildChildEnv("merge", { PATH: "/custom/only" });
  assert.equal(env.PATH, "/custom/only");
});

test("buildChildEnv replace mode uses ONLY the caller's vars, no base at all", () => {
  const env = buildChildEnv("replace", { ONLY_VAR: "x" });
  assert.deepEqual(env, { ONLY_VAR: "x" });
  assert.equal("PATH" in env, false);
  assert.equal("HOME" in env, false);
});

test("buildChildEnv replace mode with no vars produces a genuinely empty environment object", () => {
  const env = buildChildEnv("replace", {});
  assert.deepEqual(env, {});
});

test("POSIX_DEFAULT_PATH matches the documented Node.js fallback (/usr/bin:/bin)", () => {
  assert.equal(POSIX_DEFAULT_PATH, "/usr/bin:/bin");
});

// ---------------------------------------------------------------------------
// resolveExecutable (the "bad binary" pre-flight check)
// ---------------------------------------------------------------------------

test("resolveExecutable finds a real command on PATH by bare name", () => {
  const env = buildChildEnv("merge", {});
  const resolved = resolveExecutable("true", process.cwd(), env);
  assert.notEqual(resolved, undefined);
  assert.ok(fs.existsSync(resolved!));
});

test("resolveExecutable returns undefined for a bare name that doesn't exist anywhere on PATH", () => {
  const env = buildChildEnv("merge", {});
  const resolved = resolveExecutable(
    "this-command-definitely-does-not-exist-xyz-ghantika",
    process.cwd(),
    env
  );
  assert.equal(resolved, undefined);
});

test("resolveExecutable resolves an absolute path directly, without a PATH search", () => {
  const env = buildChildEnv("merge", {});
  const resolved = resolveExecutable("/bin/sh", process.cwd(), env);
  assert.equal(resolved, "/bin/sh");
});

test("resolveExecutable returns undefined for a nonexistent absolute path", () => {
  const env = buildChildEnv("merge", {});
  const resolved = resolveExecutable("/no/such/binary/at/all", process.cwd(), env);
  assert.equal(resolved, undefined);
});

test("resolveExecutable returns undefined for an existing file that lacks the execute bit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-noexec-"));
  const file = path.join(dir, "not-executable");
  fs.writeFileSync(file, "#!/bin/sh\necho no\n");
  fs.chmodSync(file, 0o644);
  const env = buildChildEnv("merge", {});
  const resolved = resolveExecutable(file, process.cwd(), env);
  assert.equal(resolved, undefined);
});

test("resolveExecutable returns undefined for a directory (a directory is never a runnable command)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-dircheck-"));
  const env = buildChildEnv("merge", {});
  const resolved = resolveExecutable(dir, process.cwd(), env);
  assert.equal(resolved, undefined);
});

test("resolveExecutable resolves a relative path (with a slash) against the given cwd, not the server's own process.cwd()", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-relcwd-"));
  const script = path.join(dir, "myscript.sh");
  fs.writeFileSync(script, "#!/bin/sh\necho ran\n");
  fs.chmodSync(script, 0o755);
  const env = buildChildEnv("merge", {});
  assert.notEqual(process.cwd(), dir);
  const resolved = resolveExecutable("./myscript.sh", dir, env);
  assert.notEqual(resolved, undefined);
  // Compare via realpath on both sides - resolveExecutable itself does not
  // realpath-resolve (that's `resolveCwd`'s job for the job's cwd field),
  // and `os.tmpdir()` is itself a symlink on macOS (/tmp -> /private/tmp),
  // so a byte-for-byte string comparison would spuriously fail here even
  // though both paths genuinely point at the same file.
  assert.equal(fs.realpathSync(resolved!), fs.realpathSync(script));
});

test("resolveExecutable searches PATH from the given (child) env, not the server's own process.env.PATH", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-custompath-"));
  const onlyHere = path.join(dir, "onlyhere-ghantika-test");
  fs.writeFileSync(onlyHere, "#!/bin/sh\necho found\n");
  fs.chmodSync(onlyHere, 0o755);
  const customEnv = { PATH: dir };
  const resolved = resolveExecutable("onlyhere-ghantika-test", process.cwd(), customEnv);
  assert.notEqual(resolved, undefined);
  // realpath both sides - see the comment in the relative-cwd test above for why.
  assert.equal(fs.realpathSync(resolved!), fs.realpathSync(onlyHere));
  // And with the SERVER's own real PATH (which does not contain `dir`), it must NOT be found.
  const serverPathEnv = { PATH: process.env.PATH ?? POSIX_DEFAULT_PATH };
  const notFound = resolveExecutable("onlyhere-ghantika-test", process.cwd(), serverPathEnv);
  assert.equal(notFound, undefined);
});

// ---------------------------------------------------------------------------
// A RELATIVE PATH entry (e.g. PATH: ".") must be resolved against the
// job's own `cwd`, never this server's own `process.cwd()`.
// ---------------------------------------------------------------------------

test('resolveExecutable resolves a RELATIVE PATH entry (PATH: ".") against the given cwd, not the server\'s own process.cwd()', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-relativepath-"));
  const fixture = path.join(dir, "gh-relative-tool");
  fs.writeFileSync(fixture, "#!/bin/sh\necho ran\n");
  fs.chmodSync(fixture, 0o755);

  // Sanity: this server's OWN cwd is genuinely different from `dir` - if it
  // weren't, a bug that resolved "." against process.cwd() instead of the
  // given cwd could accidentally still find the fixture and pass for the
  // wrong reason.
  assert.notEqual(process.cwd(), dir);
  assert.equal(
    fs.existsSync(path.join(process.cwd(), "gh-relative-tool")),
    false,
    "sanity: the fixture must not also exist relative to the server's own cwd"
  );

  const resolved = resolveExecutable("gh-relative-tool", dir, { PATH: "." });
  assert.notEqual(
    resolved,
    undefined,
    "a relative PATH entry must resolve against the job's own cwd, not the server's process.cwd()"
  );
  assert.equal(fs.realpathSync(resolved!), fs.realpathSync(fixture));
});

test("(green control) a relative PATH entry that does NOT contain the command still correctly resolves to undefined (never a false positive from the cwd-resolution logic)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-relativepath-empty-"));
  const resolved = resolveExecutable("this-does-not-exist-ghantika-relpath", dir, { PATH: "." });
  assert.equal(resolved, undefined);
});

test("an ABSOLUTE PATH entry is completely unaffected by relative-PATH resolution (existing behavior preserved)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-abspath-"));
  const fixture = path.join(dir, "gh-abs-tool");
  fs.writeFileSync(fixture, "#!/bin/sh\necho ran\n");
  fs.chmodSync(fixture, 0o755);
  // cwd here is deliberately something ELSE entirely - an absolute PATH
  // entry must never depend on cwd at all.
  const resolved = resolveExecutable("gh-abs-tool", process.cwd(), { PATH: dir });
  assert.notEqual(resolved, undefined);
  assert.equal(fs.realpathSync(resolved!), fs.realpathSync(fixture));
});

// ---------------------------------------------------------------------------
// Windows env-key casing collision - resolveCaseInsensitivePathKey,
// exported so this real algorithm can be unit-tested independent of
// process.platform (see its own docs for why).
// ---------------------------------------------------------------------------

test("resolveCaseInsensitivePathKey resolves a PATH/Path/path casing collision to the lexicographically-FIRST key, mirroring Node's own documented Windows env-key handling", () => {
  // ASCII sort: uppercase letters sort before lowercase, so "PATH" < "Path" < "path".
  const merged = { Path: "/from-Path", PATH: "/from-PATH", path: "/from-path" };
  assert.equal(resolveCaseInsensitivePathKey(merged), "PATH");
});

test("resolveCaseInsensitivePathKey with only ONE case-spelling present still finds it, whatever the spelling", () => {
  assert.equal(resolveCaseInsensitivePathKey({ Path: "/only-here" }), "Path");
  assert.equal(resolveCaseInsensitivePathKey({ path: "/only-here" }), "path");
  assert.equal(resolveCaseInsensitivePathKey({ PATH: "/only-here" }), "PATH");
});

test("(green control) resolveCaseInsensitivePathKey returns undefined when no key case-insensitively matches PATH at all", () => {
  assert.equal(resolveCaseInsensitivePathKey({ HOME: "/home", CUSTOM: "x" }), undefined);
  assert.equal(resolveCaseInsensitivePathKey({}), undefined);
});

test("(green control) a PATH-prefixed but non-matching key (e.g. PATHEXT) is never mistaken for a case variant of PATH", () => {
  assert.equal(resolveCaseInsensitivePathKey({ PATHEXT: ".COM;.EXE" }), undefined);
});

// ---------------------------------------------------------------------------
// spawnManaged: real child processes
// ---------------------------------------------------------------------------

interface Recorder {
  spawned: number;
  errors: string[];
  exits: Array<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout: Buffer[];
  stderr: Buffer[];
  stdoutEnded: boolean;
  stderrEnded: boolean;
}

function recorder(): Recorder {
  return {
    spawned: 0,
    errors: [],
    exits: [],
    stdout: [],
    stderr: [],
    stdoutEnded: false,
    stderrEnded: false,
  };
}

function callbacksFor(rec: Recorder) {
  return {
    onSpawn: () => {
      rec.spawned += 1;
    },
    onError: (message: string) => {
      rec.errors.push(message);
    },
    onExit: (code: number | null, signal: NodeJS.Signals | null) => {
      rec.exits.push({ code, signal });
    },
    onStdoutChunk: (chunk: Buffer) => {
      rec.stdout.push(chunk);
    },
    onStderrChunk: (chunk: Buffer) => {
      rec.stderr.push(chunk);
    },
    onStdoutEnd: () => {
      rec.stdoutEnded = true;
    },
    onStderrEnd: () => {
      rec.stderrEnded = true;
    },
  };
}

function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor: timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("spawnManaged runs a real command and reports spawn -> stdout -> exit(0) in order, returning a real ChildProcess", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  const child = spawnManaged(
    { argv: ["node", "-e", "console.log('hello-from-child')"], cwd: process.cwd(), env },
    callbacksFor(rec)
  );
  assert.notEqual(child, undefined);
  await waitFor(() => rec.exits.length > 0);
  assert.equal(rec.spawned, 1);
  assert.equal(rec.errors.length, 0);
  assert.equal(rec.exits[0]!.code, 0);
  assert.equal(Buffer.concat(rec.stdout).toString("utf8").trim(), "hello-from-child");
});

// --- A spawn path that ignores MANAGED_CHILD_STDIO or uses stdio:
// "inherit" would itself be a stdio-purity violation (a child's output
// wired directly to this server's own stdout/stderr). Verified against
// the real src/process.ts source: `spawnManaged` has exactly two
// `spawn()` call sites (the shellCommand branch and the argv branch), and
// BOTH hardcode `stdio: MANAGED_CHILD_STDIO` literally - `SpawnManagedOptions`
// exposes no caller-overridable stdio option at all, so there is no code
// path through which a caller could ever cause `stdio: "inherit"` to
// reach a real `spawn()` call. Existing coverage for this was indirect
// (MANAGED_CHILD_STDIO's own array values, plus output only ever arriving
// via the piped-stream data callbacks, which would be structurally
// impossible under "inherit" - Node reports `child.stdout`/`child.stderr`
// as `null` for an "inherit"-wired fd, so the
// `child.stdout?.on("data", ...)` listener in spawnManaged would silently
// never fire). These two tests make the property explicit and direct:
// the real `ChildProcess` object a real spawn returns must have non-null
// piped stdout/stderr streams and a null stdin (ignore mode) - the one
// observable signature "inherit" could never produce. ---

test("spawnManaged's real ChildProcess has non-null PIPED stdout/stderr and null (ignored) stdin - the exact shape 'inherit' could never produce, proving no spawn path here ever uses stdio: \"inherit\"", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  const child = spawnManaged(
    { argv: ["node", "-e", "console.log('x')"], cwd: process.cwd(), env },
    callbacksFor(rec)
  );
  assert.notEqual(child, undefined);
  // Node's own documented behavior: a stdio slot wired "inherit" produces
  // a `null` stream on the ChildProcess object (there is no piped Readable/
  // Writable to hand back at all, since the fd is connected directly to
  // the PARENT's own fd) - "pipe" always produces a real stream object.
  assert.notEqual(
    child!.stdout,
    null,
    "stdout must be a real piped stream, never null (which 'inherit' would produce)"
  );
  assert.notEqual(
    child!.stderr,
    null,
    "stderr must be a real piped stream, never null (which 'inherit' would produce)"
  );
  assert.equal(
    child!.stdin,
    null,
    "stdin must be null (ignore mode) - run is fire-and-forget, never interactive/inherited"
  );
  await waitFor(() => rec.exits.length > 0);
});

test("spawnManaged's shell branch: the same non-null-piped-streams shape holds for a shellCommand spawn too", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  const child = spawnManaged(
    { argv: [], shellCommand: "echo x", cwd: process.cwd(), env },
    callbacksFor(rec)
  );
  assert.notEqual(child, undefined);
  assert.notEqual(child!.stdout, null);
  assert.notEqual(child!.stderr, null);
  assert.equal(child!.stdin, null);
  await waitFor(() => rec.exits.length > 0);
});

test("spawnManaged captures a nonzero real exit code", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  spawnManaged(
    { argv: ["node", "-e", "process.exit(7)"], cwd: process.cwd(), env },
    callbacksFor(rec)
  );
  await waitFor(() => rec.exits.length > 0);
  assert.equal(rec.exits[0]!.code, 7);
  assert.equal(rec.exits[0]!.signal, null);
});

test("spawnManaged reports a real invalid-binary attempt via onError, asynchronously, never a synchronous throw", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  assert.doesNotThrow(() =>
    spawnManaged(
      { argv: ["/no/such/binary/at/all/ghantika"], cwd: process.cwd(), env },
      callbacksFor(rec)
    )
  );
  await waitFor(() => rec.errors.length > 0);
  assert.match(rec.errors[0]!, /ENOENT/);
  assert.equal(rec.spawned, 0);
});

test("spawnManaged's synchronous-throw defense-in-depth path (a cwd that is a file, not a directory) reports onError instead of throwing out of spawnManaged itself", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-spawnmanaged-notdir-"));
  const file = path.join(dir, "im-a-file");
  fs.writeFileSync(file, "x");
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  let returned: unknown;
  assert.doesNotThrow(() => {
    returned = spawnManaged({ argv: ["echo", "hi"], cwd: file, env }, callbacksFor(rec));
  });
  assert.equal(returned, undefined);
  assert.equal(rec.errors.length, 1);
  assert.match(rec.errors[0]!, /ENOTDIR/);
});

test("spawnManaged wires shellCommand through the platform shell (pipes/interpretation work)", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  spawnManaged(
    { argv: [], shellCommand: "echo shell-one && echo shell-two", cwd: process.cwd(), env },
    callbacksFor(rec)
  );
  await waitFor(() => rec.exits.length > 0);
  assert.equal(rec.exits[0]!.code, 0);
  assert.equal(Buffer.concat(rec.stdout).toString("utf8").trim(), "shell-one\nshell-two");
});

test("spawnManaged: stdout/stderr end events fire for a real completed process", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  spawnManaged(
    { argv: ["node", "-e", "console.log('o'); console.error('e')"], cwd: process.cwd(), env },
    callbacksFor(rec)
  );
  await waitFor(() => rec.stdoutEnded && rec.stderrEnded);
  assert.equal(Buffer.concat(rec.stdout).toString("utf8").trim(), "o");
  assert.equal(Buffer.concat(rec.stderr).toString("utf8").trim(), "e");
});

test("spawnManaged: a command run with env replace mode sees ONLY the vars we gave it (real child, real echo of its own env)", async () => {
  const rec = recorder();
  const env = buildChildEnv("replace", {
    MY_ONLY_VAR: "only-value",
    PATH: process.env.PATH ?? POSIX_DEFAULT_PATH,
  });
  spawnManaged(
    { argv: ["node", "-e", "console.log(JSON.stringify(process.env))"], cwd: process.cwd(), env },
    callbacksFor(rec)
  );
  await waitFor(() => rec.exits.length > 0);
  const childEnv = JSON.parse(Buffer.concat(rec.stdout).toString("utf8")) as Record<string, string>;
  // macOS itself injects __CF_USER_TEXT_ENCODING into every process at
  // launch (a CoreFoundation/dyld-level default, verified empirically -
  // not something child_process's `env` option can suppress), so it's
  // stripped before comparing rather than asserted on: this test's own
  // point is that OUR base/inherited vars are absent, not that the OS
  // injects nothing of its own.
  delete childEnv.__CF_USER_TEXT_ENCODING;
  // c8 injects NODE_V8_COVERAGE into every child it instruments - a real
  // measurement artifact of running under coverage, not something replace
  // mode itself adds. Subtracted only when the parent actually has it set,
  // so an uninstrumented run still asserts on the whole object, and a real
  // leak of this var outside coverage instrumentation still reds.
  if (process.env.NODE_V8_COVERAGE !== undefined) {
    delete childEnv.NODE_V8_COVERAGE;
  }
  assert.deepEqual(childEnv, {
    MY_ONLY_VAR: "only-value",
    PATH: process.env.PATH ?? POSIX_DEFAULT_PATH,
  });
});

// ---------------------------------------------------------------------------
// kill: process-tree containment and termination
// ---------------------------------------------------------------------------

test(
  "spawnManaged (POSIX): a detached child is the LEADER of its own process group (pgid === its own pid) - the containment kill relies on, confirmed via a REAL external ps lookup",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "2"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;
    const pgidOutput = execFileSync("ps", ["-p", String(pid), "-o", "pgid="], {
      encoding: "utf8",
    }).trim();
    assert.equal(
      Number(pgidOutput),
      pid,
      "the child's own pgid must equal its own pid - it must be its own group leader, assigned atomically at spawn time"
    );
    process.kill(-pid, "SIGKILL"); // cleanup
  }
);

// --- captureBirthIdentityPosixAsync (the non-blocking counterpart run()'s
// own production handler actually calls - see src/tools/run.ts's docs) ---

test(
  "captureBirthIdentityPosixAsync: a successful real capture reads a near-zero elapsed age for a freshly spawned process, same as the sync version",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const child = spawnManaged(
      { argv: ["sleep", "2"], cwd: process.cwd(), env: buildChildEnv("merge", {}) },
      callbacksFor(recorder())
    );
    const identity = await retryBirthIdentityCapture(
      () => captureBirthIdentityPosixAsync(child!.pid!),
      "captureBirthIdentityPosixAsync"
    );
    assert.notEqual(identity, undefined, "expected a real captured identity");
    assert.equal(typeof identity!.capturedAtMs, "number");
    assert.ok(
      identity!.elapsedSecondsAtCapture >= 0 && identity!.elapsedSecondsAtCapture < 5,
      `expected a near-zero elapsed age, got ${identity!.elapsedSecondsAtCapture}`
    );
    process.kill(-child!.pid!, "SIGKILL"); // cleanup
  }
);

test(
  "captureBirthIdentityPosixAsync: projects forward to the same real elapsed time an independent SYNC captureBirthIdentityPosix reading observes moments later - proving both are the same genuine external observation, not two different mechanisms",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const child = spawnManaged(
      { argv: ["sleep", "2"], cwd: process.cwd(), env: buildChildEnv("merge", {}) },
      callbacksFor(recorder())
    );
    const asyncIdentity = await retryBirthIdentityCapture(
      () => captureBirthIdentityPosixAsync(child!.pid!),
      "captureBirthIdentityPosixAsync"
    );
    assert.notEqual(asyncIdentity, undefined);
    const syncIdentity = await retryBirthIdentityCapture(
      () => captureBirthIdentityPosix(child!.pid!),
      "captureBirthIdentityPosix"
    );
    assert.notEqual(syncIdentity, undefined);
    const projected =
      asyncIdentity!.elapsedSecondsAtCapture +
      (syncIdentity!.capturedAtMs - asyncIdentity!.capturedAtMs) / 1000;
    assert.ok(
      Math.abs(projected - syncIdentity!.elapsedSecondsAtCapture) <= 5,
      `expected the async capture to project forward to the same real elapsed time the sync capture just observed - async: ${JSON.stringify(asyncIdentity)}, sync: ${JSON.stringify(syncIdentity)}`
    );
    process.kill(-child!.pid!, "SIGKILL"); // cleanup
  }
);

test(
  "captureBirthIdentityPosixAsync: a genuinely HUNG ps observer is forcibly killed once the bound elapses and resolves to undefined - never left unsettled indefinitely",
  {
    skip: process.platform === "win32" ? "shadows a slow ps on PATH, POSIX-only" : false,
  },
  async () => {
    const realPath = process.env.PATH;
    // A ps that sleeps far longer (5s) than the short custom timeout this
    // test passes (300ms) - if execFile's own `timeout` option didn't
    // actually SIGTERM this child at the bound, this promise would never
    // settle within any reasonable window and the test would time out
    // instead of completing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-hung-ps-"));
    const psPath = path.join(dir, "ps");
    fs.writeFileSync(psPath, "#!/bin/sh\nsleep 5\necho '00:00'\n");
    fs.chmodSync(psPath, 0o755);

    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    let elapsedMs: number;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      const before = Date.now();
      identity = await captureBirthIdentityPosixAsync(process.pid, 300);
      elapsedMs = Date.now() - before;
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(
      identity,
      undefined,
      "a ps that never answers within the bound must resolve to undefined (unavailable), never fabricate a value"
    );
    assert.ok(
      elapsedMs < 2000,
      `expected the bounded timeout to actually fire well before the ps's own 5s sleep - took ${elapsedMs}ms`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: on Windows, never even attempted - always resolves to undefined there",
  { skip: process.platform !== "win32" ? "Windows-only assertion" : false },
  async () => {
    assert.equal(await captureBirthIdentityPosixAsync(process.pid), undefined);
  }
);

// --- retryBirthIdentityCapture (test/helpers/birthIdentityRetry.ts - the
// bounded retry every immediate-capture-then-assert test call site below
// and elsewhere now uses to absorb the real fork-visibility race, per this
// story's own ACs). Proven here with pure, injected fake captures - no
// real spawn or `ps` needed at all - since this is a proof about the
// RETRY LOOP's own logic, not about the real OS-level capture functions
// (those are already covered exhaustively by the real-process tests
// throughout this file). Both directions (eventually succeeds / never
// succeeds), for both call shapes (sync-returning / Promise-returning),
// as separate tests - they exercise genuinely different code inside the
// retry loop's `await attemptCapture()` (a no-op await vs a real one), not
// just the same path with different fixtures. ---

test("retryBirthIdentityCapture: a SYNC-shaped capture that returns undefined for its first attempts and succeeds on the Nth still resolves - proves the loop genuinely RETRIES rather than merely succeeding by luck on the first call", async () => {
  const successOnAttempt = 4;
  const fakeIdentity = { capturedAtMs: Date.now(), elapsedSecondsAtCapture: 0 };
  let calls = 0;
  const result = await retryBirthIdentityCapture(() => {
    calls += 1;
    return calls >= successOnAttempt ? fakeIdentity : undefined;
  }, "captureBirthIdentityPosix (fake, sync)");
  assert.equal(result, fakeIdentity);
  assert.notEqual(result, undefined);
  assert.equal(
    calls,
    successOnAttempt,
    "expected exactly the Nth attempt to succeed, not the first - a loop that returned early on attempt 1 (or kept going past a real success) would fail this count"
  );
});

test("retryBirthIdentityCapture: a SYNC-shaped capture that ALWAYS returns undefined still FAILS at the bound - a diagnostic naming the capture function, never a silent resolve to undefined and never an unbounded retry", async () => {
  let calls = 0;
  const before = Date.now();
  await assert.rejects(
    () =>
      retryBirthIdentityCapture(() => {
        calls += 1;
        return undefined;
      }, "captureBirthIdentityPosix (fake, sync, always-undefined)"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /captureBirthIdentityPosix \(fake, sync, always-undefined\)/,
        "the thrown diagnostic must name the capture function, never a generic timeout message"
      );
      assert.match(error.message, /attempt/);
      return true;
    }
  );
  const elapsedMs = Date.now() - before;
  assert.ok(
    calls > 1,
    `expected more than one attempt before giving up (proves a genuine bounded RETRY, not a single try) - got ${calls}`
  );
  assert.ok(
    elapsedMs >= BIRTH_IDENTITY_CAPTURE_RETRY_BOUND_MS,
    `expected the loop to actually spend the full bound retrying before giving up, got ${elapsedMs}ms`
  );
  assert.ok(
    elapsedMs < BIRTH_IDENTITY_CAPTURE_RETRY_BOUND_MS + 500,
    `expected the bound to actually be enforced (never drift far past it), got ${elapsedMs}ms`
  );
});

test("retryBirthIdentityCapture: an ASYNC-shaped capture (a real Promise that resolves after a real delay on each attempt) that fails for its first attempts and succeeds on the Nth still resolves - a genuinely separate code path from the sync-shaped case above (a real await, not a no-op one)", async () => {
  const successOnAttempt = 3;
  const fakeIdentity = { capturedAtMs: Date.now(), elapsedSecondsAtCapture: 0 };
  let calls = 0;
  const result = await retryBirthIdentityCapture(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return calls >= successOnAttempt ? fakeIdentity : undefined;
  }, "captureBirthIdentityPosixAsync (fake, async)");
  assert.equal(result, fakeIdentity);
  assert.notEqual(result, undefined);
  assert.equal(calls, successOnAttempt);
});

test("retryBirthIdentityCapture: an ASYNC-shaped capture that ALWAYS resolves undefined still FAILS at the bound, with a diagnostic naming the capture function", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryBirthIdentityCapture(async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return undefined;
      }, "captureBirthIdentityPosixAsync (fake, async, always-undefined)"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /captureBirthIdentityPosixAsync \(fake, async, always-undefined\)/
      );
      return true;
    }
  );
  assert.ok(calls > 1, `expected more than one attempt before giving up - got ${calls}`);
});

// --- parseEtime (pure, no real process needed) ---

test("parseEtime parses mm:ss", () => {
  assert.equal(parseEtime("00:00"), 0);
  assert.equal(parseEtime("01:30"), 90);
  assert.equal(parseEtime("59:59"), 3599);
});

test("parseEtime parses hh:mm:ss", () => {
  assert.equal(parseEtime("01:02:03"), 3723);
});

test("parseEtime parses dd-hh:mm:ss", () => {
  assert.equal(parseEtime("2-03:04:05"), 2 * 86_400 + 3 * 3600 + 4 * 60 + 5);
});

test("parseEtime returns undefined for unrecognized shapes - defensive: never silently treats bad ps output as '0 seconds old'", () => {
  assert.equal(parseEtime(""), undefined);
  assert.equal(parseEtime("not-a-time"), undefined);
  assert.equal(parseEtime("1:2:3:4"), undefined);
  assert.equal(parseEtime(":30"), undefined);
});

test("parseEtime rejects a non-2-digit mm/ss/hh field, even when every character is a digit - a malformed or concatenated read must fail closed, never parse as a syntactically-valid but physically-impossible elapsed time", () => {
  // The exact shape a real CI failure produced: minutes="0" (unpadded,
  // real ps never emits this - see this file's own mm:ss/hh:mm:ss cases
  // above, all zero-padded), seconds a 14-digit run. Before this
  // tightening this parsed as a "found" reading of 38,109,073,018,720
  // seconds (~1.2 million years) instead of the observer-failure a
  // malformed read actually is.
  assert.equal(parseEtime("0:38109073018720"), undefined);
  // Single-digit (unpadded) fields alone, the narrower case: real ps
  // always zero-pads mm/ss/hh to two digits.
  assert.equal(parseEtime("0:5"), undefined);
  assert.equal(parseEtime("1:02:03"), undefined);
  assert.equal(parseEtime("01:2:03"), undefined);
  assert.equal(parseEtime("01:02:3"), undefined);
  // Three-or-more-digit fields, the wider case the real corruption hit.
  assert.equal(parseEtime("00:123"), undefined);
  assert.equal(parseEtime("123:00:00"), undefined);
});

test("parseEtime rejects an implausibly large leading days field, even when every other field is validly formatted - the same corrupted-value class the mm/ss/hh tightening closes can equally corrupt the unbounded days field", () => {
  // The exact second real CI failure this closes: a genuinely real,
  // synchronous `ps -p <pid> -o etime=` read against a freshly spawned
  // process (alive for well under a second) parsed - through the
  // already-tightened hh/mm/ss check above - as 38,109,073,018,720
  // seconds via this decomposition: 441,077,234 days (~1.2 million years)
  // plus a validly-2-digit-formatted "00:18:40" remainder. The mm/ss/hh
  // fix alone does not catch this shape, since every field it checks is
  // correctly 2 digits; only bounding the days field itself does.
  assert.equal(parseEtime("441077234-00:18:40"), undefined);
  // A merely large but genuinely plausible days count must still parse -
  // this bound must never reject a real long-lived process.
  assert.equal(parseEtime("100-00:00:00"), 100 * 86_400);
});

// --- identityElapsedTimesMatch (pure comparison, checkProcessIdentity's building block) ---

test("identityElapsedTimesMatch: within tolerance is a match", () => {
  assert.equal(identityElapsedTimesMatch(100, 102, 5), true);
});

test("identityElapsedTimesMatch: exactly at the tolerance boundary is a match", () => {
  assert.equal(identityElapsedTimesMatch(100, 105, 5), true);
});

test("identityElapsedTimesMatch: just past the tolerance boundary is NOT a match", () => {
  assert.equal(identityElapsedTimesMatch(100, 105.1, 5), false);
});

test("identityElapsedTimesMatch defaults to IDENTITY_TOLERANCE_SECONDS when no tolerance is given", () => {
  assert.equal(identityElapsedTimesMatch(0, IDENTITY_TOLERANCE_SECONDS), true);
  assert.equal(identityElapsedTimesMatch(0, IDENTITY_TOLERANCE_SECONDS + 0.5), false);
});

// --- checkProcessIdentity ---
//
// `checkProcessIdentity` now takes a real `ProcessBirthIdentity` (captured
// via `captureBirthIdentityPosix`, per src/process.ts's own docs), never a
// raw `Date.now()`-derived number - these tests build one the same way
// production code does (`captureBirthIdentityPosix` right after a real
// spawn), or construct one directly for the synthetic not-found/mismatch
// cases below.

test("checkProcessIdentity: not-found for a pid that plainly doesn't exist", async () => {
  const result = await checkProcessIdentity(999_999, {
    capturedAtMs: Date.now(),
    elapsedSecondsAtCapture: 0,
  });
  assert.equal(result.status, "not-found");
});

test(
  "checkProcessIdentity: alive-confirmed for a real process whose ACTUAL captured birth identity matches",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "3"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const birthIdentity = await retryBirthIdentityCapture(
      () => captureBirthIdentityPosix(child!.pid!),
      "captureBirthIdentityPosix"
    );
    assert.notEqual(birthIdentity, undefined, "expected a real, successful capture");
    const result = await checkProcessIdentity(child!.pid!, birthIdentity!);
    assert.equal(result.status, "alive-confirmed");
    process.kill(-child!.pid!, "SIGKILL"); // cleanup
  }
);

test(
  "checkProcessIdentity REFUSES to confirm a real, currently-alive process when the captured birth identity is far in the past - a convincing simulation of PID reuse",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    // Real pid recycling can't be forced deterministically from a test, so
    // this simulates its ESSENCE instead: a REAL, currently-alive process
    // (ps reports its REAL, near-0s elapsed time) checked against a
    // captured birth identity that claims capture happened far in the
    // past - exactly what a stale, post-reuse bookkeeping record would
    // look like from the outside (our record still points at this pid,
    // but the REAL process now living there started at a very different
    // time than the one we originally spawned). How convincing this is:
    // fully real `ps` call and fully real elapsed-time comparison logic,
    // on a genuinely live process - just not an actual OS-level pid
    // recycling event, which this environment cannot force to order.
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "3"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const fakeBirthIdentity = {
      capturedAtMs: Date.now() - 10 * 60 * 1000, // 10 minutes "ago"
      elapsedSecondsAtCapture: 0,
    };
    const result = await checkProcessIdentity(child!.pid!, fakeBirthIdentity);
    assert.equal(result.status, "identity-mismatch");
    if (result.status === "identity-mismatch") {
      assert.match(result.reason, /reused pid/);
    }
    process.kill(-child!.pid!, "SIGKILL"); // cleanup
  }
);

// --- evaluatePreSignalIdentityGate (the single real entry point every kill
// caller uses - wraps checkProcessIdentity plus the "no identity captured
// at all" case that function can't handle on its own) ---

test(
  "evaluatePreSignalIdentityGate: alive-confirmed identity -> proceed with identityConfirmed: true",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "3"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const birthIdentity = await retryBirthIdentityCapture(
      () => captureBirthIdentityPosix(child!.pid!),
      "captureBirthIdentityPosix"
    );
    assert.notEqual(birthIdentity, undefined);
    const gate = await evaluatePreSignalIdentityGate(child!.pid!, birthIdentity);
    assert.deepEqual(gate, { action: "proceed", identityConfirmed: true });
    process.kill(-child!.pid!, "SIGKILL"); // cleanup
  }
);

test("evaluatePreSignalIdentityGate: no captured identity at all (undefined) -> proceed, honestly degraded (identityConfirmed: false)", async () => {
  const gate = await evaluatePreSignalIdentityGate(999_999, undefined);
  assert.deepEqual(gate, { action: "proceed", identityConfirmed: false });
});

test("evaluatePreSignalIdentityGate: a genuinely gone pid -> skip (nothing to signal)", async () => {
  const gate = await evaluatePreSignalIdentityGate(999_999, {
    capturedAtMs: Date.now(),
    elapsedSecondsAtCapture: 0,
  });
  assert.deepEqual(gate, { action: "skip" });
});

test(
  "evaluatePreSignalIdentityGate: a real identity mismatch -> refuse, with an honest reason",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "3"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const fakeBirthIdentity = {
      capturedAtMs: Date.now() - 10 * 60 * 1000,
      elapsedSecondsAtCapture: 0,
    };
    const gate = await evaluatePreSignalIdentityGate(child!.pid!, fakeBirthIdentity);
    assert.equal(gate.action, "refuse");
    if (gate.action === "refuse") assert.match(gate.reason, /reused pid/);
    process.kill(-child!.pid!, "SIGKILL"); // cleanup
  }
);

// --- isProcessAlive ---

test("isProcessAlive: true for a real running process, false once it's actually exited", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  const child = spawnManaged(
    { argv: ["node", "-e", "setTimeout(() => {}, 100)"], cwd: process.cwd(), env },
    callbacksFor(rec)
  );
  await waitFor(() => rec.spawned > 0);
  assert.equal(isProcessAlive(child!.pid!), true);
  await waitFor(() => rec.exits.length > 0, 3000);
  // Node's own exit event fires only once libuv has already reaped the
  // child, so this should already be false immediately - a tiny buffer
  // just absorbs any scheduler jitter.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(isProcessAlive(child!.pid!), false);
});

test("isProcessAlive: false for a pid that plainly doesn't exist", () => {
  assert.equal(isProcessAlive(999_999), false);
});

// --- signalProcessGroupPosix ---

test(
  "signalProcessGroupPosix: signaling the group actually reaches it",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const result = signalProcessGroupPosix(child!.pid!, "SIGKILL");
    assert.equal(result.ok, true);
    await waitFor(() => rec.exits.length > 0, 3000);
    assert.equal(rec.exits[0]!.signal, "SIGKILL");
  }
);

test(
  "signalProcessGroupPosix: signaling an already-gone group is treated as success (ESRCH), not a failure",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  () => {
    const result = signalProcessGroupPosix(999_999, "SIGTERM");
    assert.equal(result.ok, true);
  }
);

// --- hasLiveProcessGroupMembersPosix (the EPERM-vs-already-gone disambiguator) ---

test(
  "hasLiveProcessGroupMembersPosix: reports true for a REAL, genuinely alive process group",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    assert.equal(hasLiveProcessGroupMembersPosix(child!.pid!), true);
    process.kill(-child!.pid!, "SIGKILL"); // cleanup
  }
);

test(
  "hasLiveProcessGroupMembersPosix: reports false for a group that was never real (a fake/already-gone pid)",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  () => {
    assert.equal(hasLiveProcessGroupMembersPosix(999_999), false);
  }
);

test(
  "hasLiveProcessGroupMembersPosix: a real pgrep EXECUTION failure (missing binary) fails CLOSED to true ('still alive/unconfirmed'), never rethrown",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;

    const realPath = process.env.PATH;
    // A real ENOENT fault injection - a PATH with no `pgrep` binary on it
    // at all - not a mock. hasLiveProcessGroupMembersPosix has no `env`
    // parameter of its own (it always shells out against this PROCESS's
    // own process.env), so mutating process.env.PATH is the real fault
    // path a broken deployment PATH would actually hit.
    process.env.PATH = "/tmp/does-not-exist-ghantika-empty-path-dir";
    let result: boolean | undefined;
    let thrown: unknown;
    try {
      result = hasLiveProcessGroupMembersPosix(pid);
    } catch (error) {
      thrown = error;
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(
      thrown,
      undefined,
      `must never rethrow a pgrep execution failure - got: ${thrown instanceof Error ? thrown.stack : String(thrown)}`
    );
    assert.equal(
      result,
      true,
      "a broken observer must fail CLOSED to true ('cannot confirm gone'), never silently report false ('confirmed zero survivors')"
    );

    process.kill(-pid, "SIGKILL"); // cleanup
  }
);

test(
  "confirmProcessGroupReapedPosix: a broken pgrep observer never throws - it honestly reports unconfirmed (false) once its own bound elapses, rather than an uncaught exception",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;

    const realPath = process.env.PATH;
    process.env.PATH = "/tmp/does-not-exist-ghantika-empty-path-dir";
    let confirmed: boolean | undefined;
    let thrown: unknown;
    try {
      // A short bound - the fail-closed "still alive" result from a
      // broken observer means this loops until the bound elapses, never
      // resolving early.
      confirmed = await confirmProcessGroupReapedPosix(pid, 150);
    } catch (error) {
      thrown = error;
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(
      thrown,
      undefined,
      `confirmProcessGroupReapedPosix must never throw when pgrep is broken - this is exactly the bug that reached src/tools/kill.ts's handler as an uncaught exception pre-fix - got: ${thrown instanceof Error ? thrown.stack : String(thrown)}`
    );
    assert.equal(
      confirmed,
      false,
      "a broken observer must honestly resolve to unconfirmed (false) once the bound elapses, never silently upgraded to true"
    );

    process.kill(-pid, "SIGKILL"); // cleanup
  }
);

// --- confirmProcessGroupReapedPosix (the FINAL, external process-group confirmation) ---

test(
  "confirmProcessGroupReapedPosix: resolves true once a real process group is genuinely gone",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;
    process.kill(-pid, "SIGKILL");
    await waitFor(() => isProcessAlive(pid) === false);
    const confirmed = await confirmProcessGroupReapedPosix(pid, 1000);
    assert.equal(confirmed, true);
  }
);

test(
  "confirmProcessGroupReapedPosix: resolves false within the bound for a group that is genuinely STILL alive - never falsely claims confirmed",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "10"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;
    const start = Date.now();
    const confirmed = await confirmProcessGroupReapedPosix(pid, 150);
    const elapsed = Date.now() - start;
    assert.equal(
      confirmed,
      false,
      "a group that is genuinely still alive must never be reported as confirmed-gone"
    );
    assert.ok(
      elapsed >= 150 && elapsed < 1000,
      `expected to resolve close to the 150ms bound, took ${elapsed}ms`
    );
    process.kill(-pid, "SIGKILL"); // cleanup
  }
);

test("GROUP_CONFIRMATION_TIMEOUT_MS defaults confirmProcessGroupReapedPosix's own bound", () => {
  assert.equal(typeof GROUP_CONFIRMATION_TIMEOUT_MS, "number");
  assert.ok(GROUP_CONFIRMATION_TIMEOUT_MS > 0);
});

// --- waitForProcessDeath ---

test("waitForProcessDeath resolves true quickly once a process actually dies within the window", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  const child = spawnManaged(
    { argv: ["node", "-e", "setTimeout(() => {}, 100)"], cwd: process.cwd(), env },
    callbacksFor(rec)
  );
  await waitFor(() => rec.spawned > 0);
  const died = await waitForProcessDeath(child!.pid!, 3000, 20);
  assert.equal(died, true);
});

test(
  "waitForProcessDeath resolves false once the timeout elapses for a still-alive process",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const start = Date.now();
    const died = await waitForProcessDeath(child!.pid!, 150, 20);
    const elapsed = Date.now() - start;
    assert.equal(died, false);
    assert.ok(
      elapsed >= 150 && elapsed < 1000,
      `expected to resolve close to the 150ms timeout, took ${elapsed}ms`
    );
    process.kill(-child!.pid!, "SIGKILL"); // cleanup
  }
);

// --- killProcessGroupPosix (the real phase split) ---

test(
  "killProcessGroupPosix: a normal (non-resistant) process dies from SIGTERM alone - no escalation needed",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "10"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const result = await killProcessGroupPosix(child!.pid!, 2000);
    assert.equal(result.finalSignal, "SIGTERM");
    assert.equal(result.escalated, false);
    assert.equal(isProcessAlive(child!.pid!), false);
    assert.equal(
      result.confirmed,
      true,
      "the FINAL external pgrep-based process-group check must confirm zero survivors for a real, fully dead group"
    );
  }
);

test(
  "a SIGTERM-resistant process is escalated to SIGKILL after the grace period and actually dies",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    // Ignores SIGTERM entirely and stays alive on its own - proves
    // escalation is REQUIRED (not merely possible) for this test to pass.
    // Prints a "ready" marker AFTER registering the handler, and the test
    // waits for it before sending any signal - without this synchronization,
    // a SIGTERM landing in the tiny startup window BEFORE `process.on` runs
    // would hit Node's default (terminating) disposition instead of the
    // no-op handler, making the child die from plain SIGTERM and falsely
    // "pass" without ever exercising real escalation - exactly what a first,
    // unsynchronized version of this test did.
    const child = spawnManaged(
      {
        argv: [
          "node",
          "-e",
          "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
        ],
        cwd: process.cwd(),
        env,
      },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    await waitFor(() => Buffer.concat(rec.stdout).toString("utf8").includes("ready"));
    // A real wait, short only to keep the suite fast - the SAME code path as
    // the real 5000ms production default (POSIX_KILL_GRACE_PERIOD_MS),
    // exercised here with an injected, still-genuine, non-instant grace
    // period via killProcessGroupPosix's own `graceMs` parameter.
    const shortGraceMs = 300;
    const result = await killProcessGroupPosix(child!.pid!, shortGraceMs);
    assert.equal(result.finalSignal, "SIGKILL");
    assert.equal(result.escalated, true);
    assert.equal(
      isProcessAlive(child!.pid!),
      false,
      "the SIGTERM-resistant process must actually be dead after SIGKILL escalation"
    );
    assert.equal(
      result.confirmed,
      true,
      "the FINAL external pgrep-based process-group check must confirm zero survivors after escalation too"
    );
  }
);

// --- isProcessGroupAlive: the exact distinction isProcessAlive alone misses ---

test(
  "isProcessGroupAlive: true while ANY group member is alive, even after the LEADER itself is confirmed dead - isProcessAlive(leaderPid) alone cannot see this",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    // The leader forks a detached-looking grandchild that ignores SIGTERM
    // and stays in the SAME process group (backgrounding in a
    // non-interactive shell does not create a new one) - then the leader
    // itself is killed by its OWN single pid, leaving the grandchild
    // untouched and still running elsewhere in the group.
    const child = spawnManaged(
      {
        argv: [
          "bash",
          "-c",
          '(trap "" TERM; echo GRANDCHILD_READY; sleep 60) & echo "GRANDCHILD_PID:$!"; wait',
        ],
        cwd: process.cwd(),
        env,
      },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    await waitFor(() => {
      const out = Buffer.concat(rec.stdout).toString("utf8");
      return out.includes("GRANDCHILD_READY") && out.includes("GRANDCHILD_PID:");
    });
    const leaderPid = child!.pid!;
    const grandchildPid = Number(
      Buffer.concat(rec.stdout)
        .toString("utf8")
        .match(/GRANDCHILD_PID:(\d+)/)![1]
    );
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

    process.kill(leaderPid, "SIGKILL"); // the leader's own single pid, NOT the group
    await waitFor(() => isProcessAlive(leaderPid) === false);

    assert.equal(isProcessAlive(leaderPid), false, "the leader itself must actually be dead");
    assert.equal(
      isProcessGroupAlive(leaderPid),
      true,
      "the GROUP must still read as alive: the grandchild, a different pid in the same pgid, is still running - exactly what isProcessAlive(leaderPid) alone cannot see"
    );
    assert.equal(
      isProcessAlive(grandchildPid),
      true,
      "sanity check: the grandchild really is still alive, independent of the group-level check"
    );

    process.kill(-leaderPid, "SIGKILL"); // cleanup: reap the grandchild too
  }
);

// REGRESSION: the exact defect an executable fixture demonstrated. Waiting
// only for the group LEADER's own pid let a SIGTERM-resistant descendant
// survive while killProcessGroupPosix reported escalated: false - as if
// SIGTERM alone had been sufficient, when a real process in the group it
// was asked to terminate was still running.
test(
  "REGRESSION: killProcessGroupPosix escalates to SIGKILL when the LEADER dies from SIGTERM but a descendant survives, and the descendant actually ends up dead",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    // The LEADER has no SIGTERM trap of its own, so it dies immediately
    // and normally from the plain SIGTERM sent to the group - exactly the
    // shape that let the old, leader-pid-only wait wrongly conclude the
    // whole group was gone. The GRANDCHILD it forks, staying in the same
    // process group, traps and ignores SIGTERM, so it keeps running after
    // the leader is already dead.
    const child = spawnManaged(
      {
        argv: [
          "bash",
          "-c",
          '(trap "" TERM; echo GRANDCHILD_READY; sleep 60) & echo "GRANDCHILD_PID:$!"; wait',
        ],
        cwd: process.cwd(),
        env,
      },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    await waitFor(() => {
      const out = Buffer.concat(rec.stdout).toString("utf8");
      return out.includes("GRANDCHILD_READY") && out.includes("GRANDCHILD_PID:");
    });
    const grandchildPid = Number(
      Buffer.concat(rec.stdout)
        .toString("utf8")
        .match(/GRANDCHILD_PID:(\d+)/)![1]
    );
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

    const shortGraceMs = 300;
    const result = await killProcessGroupPosix(child!.pid!, shortGraceMs);

    // The real, load-bearing assertion: escalation must have happened,
    // because the group was NOT actually dead after the grace period. The
    // buggy version of this function checked only the leader's own pid,
    // saw it gone (it dies immediately, with no trap), and wrongly
    // reported escalated: false while the grandchild kept running.
    assert.equal(
      result.escalated,
      true,
      "the group was not actually dead after SIGTERM alone (a descendant survived) - escalation to SIGKILL must have been triggered"
    );
    assert.equal(result.finalSignal, "SIGKILL");

    // Independent verification, external to killProcessGroupPosix's own
    // bookkeeping: the grandchild's OWN pid, checked directly, must
    // actually be dead - not merely presumed dead because the leader
    // exited.
    assert.equal(
      isProcessAlive(grandchildPid),
      false,
      "the SIGTERM-resistant grandchild must actually be dead after escalation, not merely presumed dead because the leader exited"
    );
  }
);

// --- throwUnlessBenignAlreadyGoneRace: the EPERM-vs-already-gone shutdown
// race arbitration, tested directly against its own inputs (a plain
// SignalResult value), not through a mocked `process.kill` - this is the
// ONE function both the SIGTERM and the SIGKILL call sites in
// killProcessGroupPosix share, so testing it directly here covers both
// sites by construction: there is no second, duplicated copy of this
// logic anywhere else to go untested. `hasLiveProcessGroupMembersPosix`
// itself is NEVER mocked - it runs for real against either a genuinely
// spawned child (so pgrep truly finds it) or a pid that was never real
// (so pgrep truly doesn't), keeping the survivor-oracle half of every
// assertion honest.

test("throwUnlessBenignAlreadyGoneRace: a successful signal result is a no-op regardless of signal name", async () => {
  await assert.doesNotReject(() =>
    throwUnlessBenignAlreadyGoneRace(900_101, "SIGTERM", { ok: true })
  );
  await assert.doesNotReject(() =>
    throwUnlessBenignAlreadyGoneRace(900_101, "SIGKILL", { ok: true })
  );
});

test(
  "throwUnlessBenignAlreadyGoneRace: EPERM against a group that is genuinely still alive throws, for either signal name",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;
    try {
      const epermResult = { ok: false, code: "EPERM", message: "kill EPERM" };
      await assert.rejects(
        () => throwUnlessBenignAlreadyGoneRace(pid, "SIGTERM", epermResult),
        /failed to send SIGTERM to process group/,
        "a genuinely alive, unsignalable group must surface a real error on the SIGTERM name"
      );
      await assert.rejects(
        () => throwUnlessBenignAlreadyGoneRace(pid, "SIGKILL", epermResult),
        /failed to send SIGKILL to process group/,
        "a genuinely alive, unsignalable group must surface a real error on the SIGKILL name too - the same function, the same arbitration, for both call sites"
      );
    } finally {
      process.kill(-pid, "SIGKILL");
    }
  }
);

test("throwUnlessBenignAlreadyGoneRace: EPERM against a group that is already gone is the benign race, no error, for either signal name", async () => {
  const fakePid = 900_102; // never a real group in this process's lifetime
  const epermResult = { ok: false, code: "EPERM", message: "kill EPERM" };
  await assert.doesNotReject(() =>
    throwUnlessBenignAlreadyGoneRace(fakePid, "SIGTERM", epermResult)
  );
  await assert.doesNotReject(() =>
    throwUnlessBenignAlreadyGoneRace(fakePid, "SIGKILL", epermResult)
  );
});

test("throwUnlessBenignAlreadyGoneRace: a non-EPERM failure surfaces unconditionally, even when the group is already gone - never consults the survivor oracle at all", async () => {
  const fakePid = 900_103; // never a real group in this process's lifetime
  const einvalResult = { ok: false, code: "EINVAL", message: "kill EINVAL" };
  await assert.rejects(
    () => throwUnlessBenignAlreadyGoneRace(fakePid, "SIGTERM", einvalResult),
    /failed to send SIGTERM to process group/,
    "a non-EPERM failure must surface unconditionally, fail-closed, regardless of whether the group happens to be gone"
  );
  await assert.rejects(
    () => throwUnlessBenignAlreadyGoneRace(fakePid, "SIGKILL", einvalResult),
    /failed to send SIGKILL to process group/
  );
});

// --- End-to-end wiring proof: both killProcessGroupPosix call sites
// actually invoke the shared function above, not a copy of its logic. ---

test(
  "killProcessGroupPosix: the SIGTERM-site already-gone race is treated as success end to end, via a mocked process.kill (EPERM) on a fake pid, WITHOUT ever claiming a delivery that never happened",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async (t) => {
    const fakePid = 900_104; // never a real group in this process's lifetime
    const realKill = process.kill.bind(process);
    t.mock.method(process, "kill", (target: number, signal?: string | number) => {
      if (target === -fakePid && signal === 0) return undefined; // the pre-signal existence check reports "alive", so the SIGTERM attempt below is actually reached rather than short-circuited
      if (target === -fakePid && signal === "SIGTERM") {
        const err = new Error("kill EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return realKill(target, signal);
    });

    const signaled: string[] = [];
    const result = await killProcessGroupPosix(fakePid, 50, {
      onSignaled: (sig) => signaled.push(sig),
    });
    // confirmed: true - a fake pid was never a real group, so the FINAL
    // external pgrep-based process-group check correctly reports zero survivors.
    assert.deepEqual(result, { finalSignal: "SIGTERM", escalated: false, confirmed: true });
    assert.deepEqual(
      signaled,
      [],
      "onSignaled must NOT fire for the benign already-gone race - nothing was ever delivered, so a caller claiming a terminal kill on the strength of this callback would be recording a natural exit as a requested one"
    );
  }
);

test(
  "killProcessGroupPosix: the SIGKILL-site already-gone race is treated as success end to end, via a REAL SIGTERM-resistant process the mock itself genuinely ends right before reporting a fake EPERM, WITHOUT claiming the SIGKILL half was delivered when it never was",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async (t) => {
    // A totally fake, never-real pid can no longer reach this far: the
    // escalation identity gate now runs before ANY SIGKILL is even
    // attempted, and it requires a real, matching originally-recorded
    // member - a fake pid produces zero usable records and is refused
    // long before this benign-already-gone arbitration is ever reached
    // (see the REGRESSION CLOSED test below, which proves exactly that).
    // So this test now needs a REAL, genuinely alive, SIGTERM-resistant
    // process for the identity gate to capture and re-confirm - the mock's
    // own job is narrowed to simulating the SIGKILL-send race itself: it
    // genuinely ends the real process (so the external pgrep-based
    // survivor check the arbitration relies on finds it truly gone) and
    // THEN reports the fake EPERM, reproducing "the group emptied in the
    // instant between the identity gate's own re-read and the SIGKILL
    // syscall" - precisely the narrowed (never closed) residual the escalation identity gate discloses.
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      {
        argv: [
          "node",
          "-e",
          "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
        ],
        cwd: process.cwd(),
        env,
      },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    await waitFor(() => Buffer.concat(rec.stdout).toString("utf8").includes("ready"));
    const pid = child!.pid!;

    const realKill = process.kill.bind(process);
    t.mock.method(process, "kill", (target: number, signal?: string | number) => {
      if (target === -pid && signal === "SIGKILL") {
        // Genuinely end the real process FIRST, via the real, unmocked
        // kill - so the external pgrep-based survivor check moments later
        // truthfully finds nothing, exactly like the real benign race.
        realKill(-pid, "SIGKILL");
        const err = new Error("kill EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return realKill(target, signal);
    });

    const signaled: string[] = [];
    const result = await killProcessGroupPosix(pid, 300, {
      onSignaled: (sig) => signaled.push(sig),
    });
    // The real process genuinely dies from the mock's own realKill call
    // above, so the FINAL external pgrep-based check truthfully confirms
    // zero survivors.
    assert.deepEqual(result, { finalSignal: "SIGKILL", escalated: true, confirmed: true });
    // The SIGTERM half was a genuine delivery (the real, resistant process
    // ignored it and survived the grace period), so it correctly fires.
    // The SIGKILL half hit the benign already-gone race (EPERM, confirmed
    // gone) - nothing was delivered BY THIS CALL (the process died from
    // the mock's own realKill, not from a signal this function's own send
    // ever successfully delivered), so it must NOT appear here, even
    // though the overall result still reports the call as a successful,
    // confirmed escalation.
    assert.deepEqual(
      signaled,
      ["SIGTERM"],
      "onSignaled must fire for the genuinely-delivered SIGTERM but NOT for the benign already-gone SIGKILL race"
    );
  }
);

test(
  "killProcessGroupPosix: the SIGKILL-site EPERM-while-genuinely-alive case is a real, surfaced error end to end, via a mocked process.kill against a real SIGTERM-resistant process",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async (t) => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    // Ignores SIGTERM entirely so the escalation path is genuinely reached
    // (unmocked - the real signal is sent and really ignored), then the
    // mock intercepts ONLY the SIGKILL send and reports a fake EPERM
    // WITHOUT actually sending a real SIGKILL - the process is therefore
    // unambiguously, still genuinely alive when the arbitration's survivor
    // check runs, with no reliance on how quickly any OS reclaims a killed
    // group from its process table (observed to vary significantly by
    // platform - the reason the already-gone branch is tested directly
    // against `throwUnlessBenignAlreadyGoneRace` above instead, where the
    // "gone" precondition is a pid that was simply never real, not a
    // process this test has to actually kill and then race to observe).
    // This proves the SIGKILL call site is wired to the shared function at
    // all, which is this test's whole purpose - the arbitration logic
    // itself, including its already-gone branch, is already exhaustively
    // covered above without any process-kill timing dependency.
    const child = spawnManaged(
      {
        argv: [
          "node",
          "-e",
          "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
        ],
        cwd: process.cwd(),
        env,
      },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    await waitFor(() => Buffer.concat(rec.stdout).toString("utf8").includes("ready"));
    const pid = child!.pid!;

    const realKill = process.kill.bind(process);
    t.mock.method(process, "kill", (target: number, signal?: string | number) => {
      if (target === -pid && signal === "SIGKILL") {
        const err = new Error("kill EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return realKill(target, signal);
    });

    try {
      await assert.rejects(
        () => killProcessGroupPosix(pid, 300),
        /failed to send SIGKILL to process group/,
        "a genuinely alive, unsignalable group at the SIGKILL site must surface a real error, not be swallowed as the benign already-gone case"
      );
    } finally {
      realKill(-pid, "SIGKILL"); // cleanup - the mock never let the real signal through
    }
  }
);

// REGRESSION CLOSED: this test used to reproduce the OLD, wide-open
// residual - a totally fake, never-real pid, with existence checks alone
// mocked to always report "alive", used to escalate to SIGKILL anyway,
// because a bare kill(pid, 0) liveness poll cannot distinguish a survived
// original group from a coincidentally-reused (or entirely fictitious)
// one. The escalation identity gate closes EXACTLY that case: a fake pid
// produces zero usable identity records at the pre-SIGTERM snapshot (no
// real process ever existed to read pid+lstart from), so escalation is
// now REFUSED before any SIGKILL is even attempted - existence-alone can
// no longer carry a fake pid all the way to a real SIGKILL send.
//
// The gate's OWN disclosed residual is narrower, not eliminated: the real
// gap now lives strictly between the gate's OWN successful re-read (which
// requires a genuine, matching original member) and the actual SIGKILL
// syscall - a window real pid reuse cannot be forced to land in
// deterministically from a test. That narrower gap is what the
// "already-gone race" test above this one demonstrates directly: a REAL,
// live, matching process whose mock only intervenes at the SIGKILL send
// itself, genuinely ending it right there rather than lying about its
// existence throughout.
test(
  "killProcessGroupPosix: a totally fake, never-real pid - the OLD wide-open escalation residual - is now REFUSED at the identity gate before any SIGKILL is attempted, closing exactly the case the prior version of this test used to reproduce",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async (t) => {
    const fakePid = 900_106; // never a real group in this process's lifetime
    const realKill = process.kill.bind(process);

    let sawSigkillAttempt = false;
    t.mock.method(process, "kill", (target: number, signal?: string | number) => {
      if (target !== -fakePid) return realKill(target, signal);
      if (signal === "SIGTERM") return undefined; // succeeds - reaches the grace period
      if (signal === 0) return undefined; // "still alive" for the whole grace period, forcing the escalation decision to actually be reached
      if (signal === "SIGKILL") sawSigkillAttempt = true;
      return undefined;
    });

    const signaled: string[] = [];
    const result = await killProcessGroupPosix(fakePid, 60, {
      onSignaled: (sig) => signaled.push(sig),
    });

    assert.equal(
      result.finalSignal,
      "SIGTERM",
      "expected escalation to be REFUSED, not proceed to SIGKILL, against a pid with zero real identity records"
    );
    assert.equal(result.escalated, false);
    assert.equal(
      typeof result.escalationRefusedReason,
      "string",
      "expected an honest, disclosed reason for the refusal"
    );
    assert.match(result.escalationRefusedReason!, /zero usable identity records|snapshot/);
    assert.deepEqual(
      signaled,
      ["SIGTERM"],
      "onSignaled must fire for the genuinely-delivered SIGTERM but never for a SIGKILL that was correctly refused"
    );
    assert.equal(
      sawSigkillAttempt,
      false,
      "the mock must never even observe a SIGKILL attempt against this fake pid - the gate refuses before that send is ever reached"
    );
  }
);

test("POSIX_KILL_GRACE_PERIOD_MS is the real 5-second default ('a real grace period, not a token delay')", () => {
  assert.equal(POSIX_KILL_GRACE_PERIOD_MS, 5000);
});

// --- killProcessTreeWindows (honest best-effort, no graceful phase) ---

test("killProcessTreeWindows: synchronous and immediate - no waiting, no grace period, no claim of graceful Windows behavior", () => {
  assert.equal(
    killProcessTreeWindows.constructor.name,
    "Function",
    "must be a plain synchronous function - an async function here would imply a wait/grace step that this Windows path explicitly forbids"
  );
  const start = Date.now();
  // On a Windows leg this reaches the real `taskkill` against a pid that
  // does not exist; everywhere else there is no such binary and the call
  // fails with ENOENT. Both land in the same swallowed-error path, and the
  // assertions below hold either way.
  const result = killProcessTreeWindows(999_999);
  const elapsed = Date.now() - start;
  assert.equal(result.method, "taskkill-tree");
  assert.ok(
    elapsed < 2000,
    `must return immediately - no waiting/grace-period logic on the Windows path, took ${elapsed}ms`
  );
});

// ---------------------------------------------------------------------------
// The escalation identity gate: before the SIGKILL escalation,
// prove the process group is still the one this codebase spawned. Covers
// the frozen six-token ps grammar (parsePidLstartRow), the batched/bounded/
// force-reaped observer (readPidStartTimesBatchPosix), the pre-SIGTERM
// snapshot (captureEscalationIdentitySnapshot) and its own fail-closed
// cells, and the escalation-time decision (evaluateEscalationIdentityGate).
// ---------------------------------------------------------------------------

test("PROCESS_IDENTITY_OBSERVATION_TIMEOUT_MS is the named 2000ms whole-phase budget, and is strictly less than POSIX_KILL_GRACE_PERIOD_MS - asserted directly, never eyeballed", () => {
  assert.equal(PROCESS_IDENTITY_OBSERVATION_TIMEOUT_MS, 2000);
  assert.ok(
    PROCESS_IDENTITY_OBSERVATION_TIMEOUT_MS < POSIX_KILL_GRACE_PERIOD_MS,
    `expected the observation budget (${PROCESS_IDENTITY_OBSERVATION_TIMEOUT_MS}ms) to be strictly less than the grace period (${POSIX_KILL_GRACE_PERIOD_MS}ms), so neither observation phase can ever outlast the window it sits beside`
  );
});

// --- parsePidLstartRow: the frozen six-token grammar (pure, no real process needed) ---

test("parsePidLstartRow parses a well-formed six-token row into the correct epoch-millisecond instant under UTC0", () => {
  const parsed = parsePidLstartRow("12345 Sat Jul 25 13:39:12 2026");
  assert.notEqual(parsed, undefined);
  assert.equal(parsed!.pid, 12345);
  assert.equal(parsed!.startTimeMs, Date.UTC(2026, 6, 25, 13, 39, 12));
});

test("parsePidLstartRow collapses ps's own column-padding whitespace (a single-digit day is padded with an extra space) rather than shifting tokens off by one", () => {
  // 5 July 2026 is genuinely a Sunday - the weekday token here must agree
  // with the actual date (see the dedicated contradictory-weekday test
  // below), not merely be A recognized abbreviation.
  const parsed = parsePidLstartRow("12345 Sun Jul  5 13:39:12 2026");
  assert.notEqual(parsed, undefined);
  assert.equal(parsed!.pid, 12345);
  assert.equal(parsed!.startTimeMs, Date.UTC(2026, 6, 5, 13, 39, 12));
});

test("parsePidLstartRow tolerates leading/trailing whitespace around the whole row", () => {
  const parsed = parsePidLstartRow("   12345 Sat Jul 25 13:39:12 2026   ");
  assert.notEqual(parsed, undefined);
  assert.equal(parsed!.pid, 12345);
});

test("parsePidLstartRow REFUSES a row with only FIVE tokens (a missing field) - never a partial/best-effort parse", () => {
  assert.equal(parsePidLstartRow("12345 Sat Jul 25 13:39:12"), undefined);
});

test("parsePidLstartRow REFUSES a row with SEVEN tokens (an extra field) - never silently drops the extra one", () => {
  assert.equal(parsePidLstartRow("12345 Sat Jul 25 13:39:12 2026 EXTRA"), undefined);
});

test("parsePidLstartRow REFUSES an unrecognized weekday token", () => {
  assert.equal(parsePidLstartRow("12345 Xyz Jul 25 13:39:12 2026"), undefined);
});

test("parsePidLstartRow REFUSES an unrecognized month abbreviation", () => {
  assert.equal(parsePidLstartRow("12345 Sat Xyz 25 13:39:12 2026"), undefined);
});

test("parsePidLstartRow REFUSES a malformed HH:MM:SS time field (wrong shape, not just wrong value)", () => {
  assert.equal(parsePidLstartRow("12345 Sat Jul 25 13:39 2026"), undefined);
  assert.equal(parsePidLstartRow("12345 Sat Jul 25 13-39-12 2026"), undefined);
});

test("parsePidLstartRow REFUSES a non-numeric or non-positive pid token", () => {
  assert.equal(parsePidLstartRow("abc Sat Jul 25 13:39:12 2026"), undefined);
  assert.equal(parsePidLstartRow("0 Sat Jul 25 13:39:12 2026"), undefined);
  assert.equal(parsePidLstartRow("-5 Sat Jul 25 13:39:12 2026"), undefined);
});

test("parsePidLstartRow REFUSES a value that does not ROUND-TRIP through Date.UTC (an out-of-range day Date would otherwise silently normalize into the next month)", () => {
  // February never has a 30th - Date.UTC would normalize this into March,
  // which would silently misreport the month were this not checked.
  assert.equal(parsePidLstartRow("12345 Mon Feb 30 13:39:12 2026"), undefined);
});

test("parsePidLstartRow REFUSES a recognized-but-CONTRADICTORY weekday token - the weekday must match the day-of-week its own year/month/day actually compute to, never merely be a recognized abbreviation", () => {
  // 25 July 2026 is genuinely a Saturday - the correctly-paired row parses
  // cleanly, and this is what the contradictory row below is compared
  // against: same pid, same date, same time, only the weekday differs.
  const correct = parsePidLstartRow("123 Sat Jul 25 15:00:00 2026");
  assert.notEqual(correct, undefined);
  assert.equal(correct!.pid, 123);
  assert.equal(correct!.startTimeMs, Date.UTC(2026, 6, 25, 15, 0, 0));
  // `Date.UTC` never looks at the weekday token at all, so a parser that
  // only checks the weekday is a RECOGNIZED abbreviation (never that it
  // agrees with the computed date) would parse this identically to the
  // row above - the exact bug this test exists to close.
  assert.equal(parsePidLstartRow("123 Mon Jul 25 15:00:00 2026"), undefined);
});

test("parsePidLstartRow REFUSES an empty string", () => {
  assert.equal(parsePidLstartRow(""), undefined);
  assert.equal(parsePidLstartRow("   "), undefined);
});

// --- readPidStartTimesBatchPosix: the batched, bounded, force-reaped observer ---

test("readPidStartTimesBatchPosix: an empty pids array is a defensive no-op, never shelling out at all", async () => {
  const result = await readPidStartTimesBatchPosix([]);
  assert.deepEqual(result, { status: "ok", rows: [] });
});

test(
  "readPidStartTimesBatchPosix: reads a real, single, freshly-spawned process's own pid+lstart correctly",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;
    const before = Date.now();
    const result = await readPidStartTimesBatchPosix([pid]);
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0]!.pid, pid);
      // A freshly-spawned process's real start time must land within a
      // generous window around "now" - never a stale/fabricated value.
      assert.ok(
        Math.abs(result.rows[0]!.startTimeMs - before) < 15_000,
        `expected a near-now start time, got ${result.rows[0]!.startTimeMs} vs before=${before}`
      );
    }
    process.kill(-pid, "SIGKILL");
  }
);

test(
  "readPidStartTimesBatchPosix: reads MULTIPLE real pids in ONE batched call (a fake ps counts its own invocations to prove this), returning every one's own correct row",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec1 = recorder();
    const rec2 = recorder();
    const env = buildChildEnv("merge", {});
    const child1 = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec1)
    );
    const child2 = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec2)
    );
    await waitFor(() => rec1.spawned > 0 && rec2.spawned > 0);
    const pid1 = child1!.pid!;
    const pid2 = child2!.pid!;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-batch-count-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    const realPsPath = execFileSync("which", ["ps"], { encoding: "utf8" }).trim();
    const wrapperPath = path.join(dir, "ps");
    fs.writeFileSync(
      wrapperPath,
      `#!/bin/sh\necho x >> '${invocationMarker}'\nexec '${realPsPath}' "$@"\n`
    );
    fs.chmodSync(wrapperPath, 0o755);

    const realPath = process.env.PATH;
    let result: Awaited<ReturnType<typeof readPidStartTimesBatchPosix>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      result = await readPidStartTimesBatchPosix([pid1, pid2]);
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      const foundPids = result.rows.map((row) => row.pid).sort((a, b) => a - b);
      assert.deepEqual(
        foundPids,
        [pid1, pid2].sort((a, b) => a - b)
      );
    }
    const invocationCount = fs
      .readFileSync(invocationMarker, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    assert.equal(
      invocationCount,
      1,
      `expected exactly ONE real ps invocation for both pids (call count must stay independent of group size), saw ${invocationCount}`
    );

    process.kill(-pid1, "SIGKILL");
    process.kill(-pid2, "SIGKILL");
  }
);

test(
  "readPidStartTimesBatchPosix: a mix of one alive and one already-gone pid returns ONLY the alive one's row, ok - never an error for the merely-absent one",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;

    // A genuinely dead-but-plausible pid: spawn and let it actually exit and
    // be reaped, so its pid is a real, in-range, but no-longer-live value -
    // never an out-of-range synthetic pid `ps` itself would reject outright.
    const shortRec = recorder();
    const shortChild = spawnManaged(
      { argv: ["true"], cwd: process.cwd(), env },
      callbacksFor(shortRec)
    );
    await waitFor(() => shortRec.exits.length > 0);
    const deadPid = shortChild!.pid!;

    const result = await readPidStartTimesBatchPosix([pid, deadPid]);
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0]!.pid, pid);
    }
    process.kill(-pid, "SIGKILL");
  }
);

test("readPidStartTimesBatchPosix: when NONE of the requested pids exist, resolves ok with genuinely empty rows (ps's own exit-1 'nothing matched' code), never an observer failure", async () => {
  const result = await readPidStartTimesBatchPosix([88_888_881, 88_888_882]);
  assert.deepEqual(result, { status: "ok", rows: [] });
});

test("readPidStartTimesBatchPosix: a real execution failure (missing ps binary) reports observer-failure, never a false 'ok'", async () => {
  const realPath = process.env.PATH;
  process.env.PATH = "/tmp/does-not-exist-ghantika-empty-path-dir-3";
  let result: Awaited<ReturnType<typeof readPidStartTimesBatchPosix>>;
  try {
    result = await readPidStartTimesBatchPosix([12345]);
  } finally {
    process.env.PATH = realPath;
  }
  assert.equal(result.status, "observer-failure");
});

test(
  "readPidStartTimesBatchPosix: a mix of one well-formed row and one malformed row keeps the well-formed one - a malformed row is discarded, never poisoning the others",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-malformed-ps-"));
    const fakePsPath = path.join(dir, "ps");
    // Emits one genuinely well-formed row for the real pid, plus one
    // deliberately malformed row (missing the year token) for a synthetic
    // second pid - a real ps would never produce this shape; this
    // simulates it directly to prove malformed-row handling.
    fs.writeFileSync(
      fakePsPath,
      `#!/bin/sh\necho '${pid} Sat Jul 25 13:39:12 2026'\necho '999999 Sat Jul 25 13:39:12'\n`
    );
    fs.chmodSync(fakePsPath, 0o755);

    const realPath = process.env.PATH;
    let result: Awaited<ReturnType<typeof readPidStartTimesBatchPosix>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      result = await readPidStartTimesBatchPosix([pid, 999_999]);
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.rows.length, 1, "expected only the well-formed row to survive");
      assert.equal(result.rows[0]!.pid, pid);
    }
    process.kill(-pid, "SIGKILL");
  }
);

// --- captureEscalationIdentitySnapshot: the pre-SIGTERM membership snapshot ---

test(
  "captureEscalationIdentitySnapshot: a real, single-process group (no descendants) captures exactly the leader's own pid+start time",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;
    const snapshot = await captureEscalationIdentitySnapshot(pid);
    assert.equal(snapshot.degraded, false);
    assert.equal(snapshot.members.length, 1);
    assert.equal(snapshot.members[0]!.pid, pid);
    process.kill(-pid, "SIGKILL");
  }
);

test(
  "captureEscalationIdentitySnapshot: a real group with descendants captures the leader PLUS every live descendant",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["bash", "-c", "sleep 30 & sleep 30 & wait"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const leaderPid = child!.pid!;
    // Let the two descendants actually fork before snapshotting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const snapshot = await captureEscalationIdentitySnapshot(leaderPid);
    assert.equal(snapshot.degraded, false);
    assert.ok(
      snapshot.members.length >= 3,
      `expected the leader plus 2 descendants (>= 3 members), got ${snapshot.members.length}`
    );
    assert.ok(snapshot.members.some((member) => member.pid === leaderPid));
    process.kill(-leaderPid, "SIGKILL");
  }
);

test(
  "captureEscalationIdentitySnapshot: PRE-SNAPSHOT NEGATIVE - the initial leader read timing out degrades the WHOLE snapshot to zero usable members",
  {
    skip: process.platform === "win32" ? "shadows a slow ps on PATH, POSIX-only" : false,
  },
  async () => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-leader-hang-ps-"));
    const psPath = path.join(dir, "ps");
    // Hangs unconditionally regardless of which pid(s) it was asked about -
    // this is specifically "the initial leader read" (the very first
    // observer call the snapshot phase makes).
    fs.writeFileSync(psPath, "#!/bin/sh\ntrap '' TERM\nsleep 5\n");
    fs.chmodSync(psPath, 0o755);

    let snapshot: Awaited<ReturnType<typeof captureEscalationIdentitySnapshot>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      snapshot = await captureEscalationIdentitySnapshot(999_111, 300);
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(snapshot.degraded, true);
    assert.equal(snapshot.members.length, 0);
    assert.match(snapshot.degradedReason ?? "", /leader/i);
  }
);

test(
  "captureEscalationIdentitySnapshot: PRE-SNAPSHOT NEGATIVE - member enumeration (pgrep) timing out degrades the WHOLE snapshot, even though the leader's own read would otherwise have succeeded",
  {
    skip: process.platform === "win32" ? "shadows a slow pgrep on PATH, POSIX-only" : false,
  },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;

    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-enum-hang-pgrep-"));
    const pgrepPath = path.join(dir, "pgrep");
    fs.writeFileSync(pgrepPath, "#!/bin/sh\ntrap '' TERM\nsleep 5\n");
    fs.chmodSync(pgrepPath, 0o755);

    let snapshot: Awaited<ReturnType<typeof captureEscalationIdentitySnapshot>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      snapshot = await captureEscalationIdentitySnapshot(pid, 300);
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(
      snapshot.degraded,
      true,
      "expected the whole snapshot to degrade, even though the leader's own read alone would have succeeded"
    );
    assert.match(snapshot.degradedReason ?? "", /enumeration/i);
    process.kill(-pid, "SIGKILL");
  }
);

test(
  "captureEscalationIdentitySnapshot: PRE-SNAPSHOT NEGATIVE - malformed pgrep enumeration output degrades the whole snapshot rather than guessing at a partial member list",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;

    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-malformed-pgrep-"));
    const pgrepPath = path.join(dir, "pgrep");
    fs.writeFileSync(pgrepPath, "#!/bin/sh\necho 'not-a-pid'\n");
    fs.chmodSync(pgrepPath, 0o755);

    let snapshot: Awaited<ReturnType<typeof captureEscalationIdentitySnapshot>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      snapshot = await captureEscalationIdentitySnapshot(pid, 300);
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(snapshot.degraded, true);
    process.kill(-pid, "SIGKILL");
  }
);

test(
  "captureEscalationIdentitySnapshot: PRE-SNAPSHOT NEGATIVE - zero usable records when the leader has ALREADY exited by snapshot time (no observer failure at all, just genuinely nothing there)",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged({ argv: ["true"], cwd: process.cwd(), env }, callbacksFor(rec));
    await waitFor(() => rec.exits.length > 0);
    const pid = child!.pid!;
    const snapshot = await captureEscalationIdentitySnapshot(pid);
    assert.equal(snapshot.degraded, true);
    assert.equal(snapshot.members.length, 0);
    assert.match(snapshot.degradedReason ?? "", /zero usable/i);
  }
);

// --- evaluateEscalationIdentityGate: the escalation-time decision ---

test(
  "evaluateEscalationIdentityGate: THE HAPPY PATH - a real member with an exactly-matching current start time escalates",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;
    const snapshot = await captureEscalationIdentitySnapshot(pid);
    assert.equal(snapshot.degraded, false);
    const gate = await evaluateEscalationIdentityGate(snapshot);
    assert.deepEqual(gate, { action: "escalate" });
    process.kill(-pid, "SIGKILL");
  }
);

test("evaluateEscalationIdentityGate: a degraded snapshot (zero members) always refuses, regardless of what the escalation-time re-read would find", async () => {
  const gate = await evaluateEscalationIdentityGate({
    members: [],
    degraded: true,
    degradedReason: "test-injected degradation",
  });
  assert.equal(gate.action, "refuse");
});

test(
  "evaluateEscalationIdentityGate: NEGATIVE - every recorded member is gone at re-read - REFUSES, no positive match possible",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;
    const snapshot = await captureEscalationIdentitySnapshot(pid);
    assert.equal(snapshot.degraded, false);
    process.kill(-pid, "SIGKILL");
    await waitFor(() => isProcessAlive(pid) === false);
    const gate = await evaluateEscalationIdentityGate(snapshot);
    assert.equal(gate.action, "refuse");
  }
);

test("evaluateEscalationIdentityGate: NEGATIVE - a recorded pid is still present but its start time DIFFERS from the record (the recycled-pid simulation) - REFUSES", async () => {
  // Uses this process's own real, currently-alive pid, but with a
  // deliberately WRONG recorded start time - simulating exactly what a
  // stale, post-reuse bookkeeping record would look like.
  const snapshot = {
    members: [{ pid: process.pid, startTimeMs: Date.UTC(2000, 0, 1, 0, 0, 0) }],
    degraded: false,
  };
  const gate = await evaluateEscalationIdentityGate(snapshot);
  assert.equal(gate.action, "refuse");
});

test(
  "evaluateEscalationIdentityGate: a legitimately disappeared member is NOT a failure - with one other original still matching exactly, escalation proceeds",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    // The leader backgrounds the child, `wait`s on that ONE specific pid
    // (so the child is genuinely reaped rather than left a <defunct>
    // zombie once killed - a zombie's pid stays "alive" to a plain
    // `kill(pid, 0)` probe until its parent reaps it, which would hang
    // this test's own liveness wait forever), THEN runs its own
    // independent, long-running sleep - so the leader stays genuinely
    // alive and unaffected once the child is killed, rather than exiting
    // the instant a blind `wait` (with no target) would have returned.
    const child = spawnManaged(
      {
        argv: [
          "bash",
          "-c",
          'sleep 30 & CPID=$!; echo "CHILD_PID:$CPID"; wait "$CPID" 2>/dev/null; sleep 30',
        ],
        cwd: process.cwd(),
        env,
      },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    await waitFor(() => Buffer.concat(rec.stdout).toString("utf8").includes("CHILD_PID:"));
    const leaderPid = child!.pid!;
    const childPid = Number(
      Buffer.concat(rec.stdout)
        .toString("utf8")
        .match(/CHILD_PID:(\d+)/)![1]
    );

    const snapshot = await captureEscalationIdentitySnapshot(leaderPid);
    assert.equal(snapshot.degraded, false);
    assert.ok(snapshot.members.some((member) => member.pid === childPid));

    // The descendant legitimately disappears on its own - not a failure,
    // just the normal case a positive match elsewhere must still cover.
    process.kill(childPid, "SIGKILL");
    await waitFor(() => isProcessAlive(childPid) === false);

    const gate = await evaluateEscalationIdentityGate(snapshot);
    assert.deepEqual(
      gate,
      { action: "escalate" },
      "expected the still-alive, still-matching leader to be sufficient proof, despite the descendant's own legitimate disappearance"
    );
    process.kill(-leaderPid, "SIGKILL");
  }
);

test(
  "evaluateEscalationIdentityGate: ANY-ONE sufficiency - a group of many descendants where only a SINGLE one still matches still escalates (never requires full-set survival)",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      {
        argv: [
          "bash",
          "-c",
          'sleep 30 & echo "P1:$!"; sleep 30 & echo "P2:$!"; sleep 30 & echo "P3:$!"; wait',
        ],
        cwd: process.cwd(),
        env,
      },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    await waitFor(() => {
      const out = Buffer.concat(rec.stdout).toString("utf8");
      return out.includes("P1:") && out.includes("P2:") && out.includes("P3:");
    });
    const leaderPid = child!.pid!;
    const out = Buffer.concat(rec.stdout).toString("utf8");
    const p1 = Number(out.match(/P1:(\d+)/)![1]);
    const p2 = Number(out.match(/P2:(\d+)/)![1]);

    const snapshot = await captureEscalationIdentitySnapshot(leaderPid);
    assert.equal(snapshot.degraded, false);
    assert.ok(
      snapshot.members.length >= 4,
      `expected the leader plus 3 descendants recorded, got ${snapshot.members.length}`
    );

    // Kill the LEADER and two of the three descendants - only ONE
    // descendant (p2) survives to prove the group's identity.
    process.kill(leaderPid, "SIGKILL");
    process.kill(p1, "SIGKILL");
    await waitFor(() => isProcessAlive(leaderPid) === false && isProcessAlive(p1) === false);

    const gate = await evaluateEscalationIdentityGate(snapshot);
    assert.deepEqual(
      gate,
      { action: "escalate" },
      "expected the single surviving, still-matching descendant to be sufficient - the gate never requires full-set survival"
    );
    process.kill(p2, "SIGKILL"); // cleanup the sole survivor
  }
);

test(
  "evaluateEscalationIdentityGate: the leader is compared by the SAME exact-match rule as any descendant, no tolerance window - a recorded value off by even a single millisecond REFUSES",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;
    const realSnapshot = await captureEscalationIdentitySnapshot(pid);
    assert.equal(realSnapshot.degraded, false);
    const real = realSnapshot.members.find((member) => member.pid === pid)!;

    // A snapshot claiming the SAME pid but a start time off by exactly one
    // millisecond from the real, current value - this must REFUSE, proving
    // no tolerance window (unlike the pre-signal birth-identity check's
    // several-second etime tolerance, which is a wholly separate,
    // out-of-scope mechanism here).
    const offByOneMs = {
      members: [{ pid, startTimeMs: real.startTimeMs + 1 }],
      degraded: false,
    };
    const gate = await evaluateEscalationIdentityGate(offByOneMs);
    assert.equal(
      gate.action,
      "refuse",
      "expected an off-by-one-millisecond recorded value to REFUSE - the leader gets no tolerance window, exactly like any descendant"
    );
    process.kill(-pid, "SIGKILL");
  }
);

test(
  "evaluateEscalationIdentityGate: NEGATIVE - the bounded re-read TIMES OUT - refuses rather than defaulting to escalation",
  {
    skip: process.platform === "win32" ? "shadows a slow ps on PATH, POSIX-only" : false,
  },
  async () => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-reread-hang-ps-"));
    const psPath = path.join(dir, "ps");
    fs.writeFileSync(psPath, "#!/bin/sh\ntrap '' TERM\nsleep 5\n");
    fs.chmodSync(psPath, 0o755);

    const snapshot = { members: [{ pid: 424_242, startTimeMs: Date.now() }], degraded: false };
    let gate: Awaited<ReturnType<typeof evaluateEscalationIdentityGate>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      gate = await evaluateEscalationIdentityGate(snapshot, 300);
    } finally {
      process.env.PATH = realPath;
    }
    assert.equal(gate.action, "refuse");
  }
);

test("evaluateEscalationIdentityGate: NEGATIVE - a malformed re-read row for the only recorded member REFUSES, never guessed at", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-reread-malformed-ps-"));
  const psPath = path.join(dir, "ps");
  fs.writeFileSync(psPath, "#!/bin/sh\necho '424242 Sat Jul 25 13:39:12'\n"); // missing year token
  fs.chmodSync(psPath, 0o755);

  const realPath = process.env.PATH;
  const snapshot = {
    members: [{ pid: 424_242, startTimeMs: Date.UTC(2026, 6, 25, 13, 39, 12) }],
    degraded: false,
  };
  let gate: Awaited<ReturnType<typeof evaluateEscalationIdentityGate>>;
  try {
    process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
    gate = await evaluateEscalationIdentityGate(snapshot);
  } finally {
    process.env.PATH = realPath;
  }
  assert.equal(gate.action, "refuse");
});

test(
  "evaluateEscalationIdentityGate: NEGATIVE - partial re-read (one recorded member gone, the other unreadable) with no positive proof anywhere - REFUSES",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    // pidA is genuinely gone at re-read time; pidB's row is deliberately
    // malformed - between the two of them, NOTHING positively matches.
    const snapshot = {
      members: [
        { pid: 88_888_883, startTimeMs: Date.now() },
        { pid: 88_888_884, startTimeMs: Date.UTC(2026, 6, 25, 13, 39, 12) },
      ],
      degraded: false,
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-partial-reread-ps-"));
    const psPath = path.join(dir, "ps");
    // Only ever emits a malformed row for 88888884 - never anything for
    // 88888883 (simulating it being genuinely gone), and never a
    // well-formed, matching row for either.
    fs.writeFileSync(psPath, "#!/bin/sh\necho '88888884 not-a-valid-lstart-row'\n");
    fs.chmodSync(psPath, 0o755);

    const realPath = process.env.PATH;
    let gate: Awaited<ReturnType<typeof evaluateEscalationIdentityGate>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      gate = await evaluateEscalationIdentityGate(snapshot);
    } finally {
      process.env.PATH = realPath;
    }
    assert.equal(gate.action, "refuse");
  }
);

// --- structural prohibition - the escalation path never signals an individual member's own pid, only kill(-pgid, ...) ---

test(
  "STRUCTURAL: across a real multi-descendant escalation, every process.kill call this codebase's own escalation path makes targets ONLY the group's negative pgid - never an individual member's own positive pid",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async (t) => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    // A SIGTERM-resistant leader with real descendants, forcing a genuine
    // escalation - exactly the shape that would (if the prohibition were
    // ever violated) have a real, plausible reason to try signalling a
    // descendant individually.
    const child = spawnManaged(
      {
        argv: ["bash", "-c", "sleep 60 & sleep 60 & (trap '' TERM; sleep 60) & trap '' TERM; wait"],
        cwd: process.cwd(),
        env,
      },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const leaderPid = child!.pid!;
    await new Promise((resolve) => setTimeout(resolve, 200)); // let descendants fork

    const realKill = process.kill.bind(process);
    const observedTargets: number[] = [];
    t.mock.method(process, "kill", (target: number, signal?: string | number) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") observedTargets.push(target);
      return realKill(target, signal);
    });

    await killProcessGroupPosix(leaderPid, 300);

    const realSignalSends = observedTargets.filter((target) => target !== undefined);
    assert.ok(
      realSignalSends.length > 0,
      "expected at least one real signal send to have been observed"
    );
    for (const target of realSignalSends) {
      assert.ok(
        target < 0,
        `expected every real SIGTERM/SIGKILL send to target a NEGATIVE (group) pid, got ${target} - an individual member's own positive pid must never be signalled directly`
      );
      assert.equal(
        target,
        -leaderPid,
        `expected every send to target exactly -leaderPid (${-leaderPid}), got ${target} - identity is the GATE, never the target`
      );
    }

    // Best-effort cleanup: killProcessGroupPosix above already escalated to
    // a real SIGKILL, so the group is normally already gone by this point -
    // an ESRCH here is the expected, benign "nothing left to signal"
    // outcome, not a real failure, and the mock (still active until this
    // test ends) does not itself catch it.
    try {
      realKill(-leaderPid, "SIGKILL");
    } catch {
      // already gone - fine.
    }
  }
);
