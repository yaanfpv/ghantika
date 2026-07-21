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
  POSIX_KILL_GRACE_PERIOD_MS,
  checkProcessIdentity,
  identityElapsedTimesMatch,
  isProcessAlive,
  killProcessGroupPosix,
  killProcessTreeWindows,
  parseEtime,
  signalProcessGroupPosix,
  waitForProcessDeath,
} from "../dist/process.js";

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

test("spawnManaged (POSIX): a detached child is the LEADER of its own process group (pgid === its own pid) - the containment kill relies on, confirmed via a REAL external ps lookup", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  const child = spawnManaged({ argv: ["sleep", "2"], cwd: process.cwd(), env }, callbacksFor(rec));
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

test("checkProcessIdentity: not-found for a pid that plainly doesn't exist", () => {
  const result = checkProcessIdentity(999_999, Date.now());
  assert.equal(result.status, "not-found");
});

test("checkProcessIdentity: alive-confirmed for a real process whose ACTUAL recorded spawn time matches", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  const spawnedAtMs = Date.now();
  const child = spawnManaged({ argv: ["sleep", "3"], cwd: process.cwd(), env }, callbacksFor(rec));
  await waitFor(() => rec.spawned > 0);
  const result = checkProcessIdentity(child!.pid!, spawnedAtMs);
  assert.equal(result.status, "alive-confirmed");
  process.kill(-child!.pid!, "SIGKILL"); // cleanup
});

test("checkProcessIdentity REFUSES to confirm a real, currently-alive process when the expected spawn time is far in the past - a convincing simulation of PID reuse", async () => {
  // Real pid recycling can't be forced deterministically from a test, so
  // this simulates its ESSENCE instead: a REAL, currently-alive process
  // (ps reports its REAL, near-0s elapsed time) checked against an
  // `expectedSpawnedAtMs` far in the past - exactly what a stale, post-
  // reuse bookkeeping record would look like from the outside (our record
  // still points at this pid, but the REAL process now living there
  // started at a very different time than the one we originally spawned).
  // How convincing this is: fully real `ps` call and fully real elapsed-
  // time comparison logic, on a genuinely live process - just not an
  // actual OS-level pid recycling event, which this environment cannot
  // force to order.
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  const child = spawnManaged({ argv: ["sleep", "3"], cwd: process.cwd(), env }, callbacksFor(rec));
  await waitFor(() => rec.spawned > 0);
  const fakeExpectedSpawnedAtMs = Date.now() - 10 * 60 * 1000; // 10 minutes "ago"
  const result = checkProcessIdentity(child!.pid!, fakeExpectedSpawnedAtMs);
  assert.equal(result.status, "identity-mismatch");
  if (result.status === "identity-mismatch") {
    assert.match(result.reason, /reused pid/);
  }
  process.kill(-child!.pid!, "SIGKILL"); // cleanup
});

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

test("signalProcessGroupPosix: signaling the group actually reaches it (green control, precursor to the real external-lineage e2e proof in test/kill.test.ts)", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  const child = spawnManaged({ argv: ["sleep", "5"], cwd: process.cwd(), env }, callbacksFor(rec));
  await waitFor(() => rec.spawned > 0);
  const result = signalProcessGroupPosix(child!.pid!, "SIGKILL");
  assert.equal(result.ok, true);
  await waitFor(() => rec.exits.length > 0, 3000);
  assert.equal(rec.exits[0]!.signal, "SIGKILL");
});

test("signalProcessGroupPosix: signaling an already-gone group is treated as success (ESRCH), not a failure", () => {
  const result = signalProcessGroupPosix(999_999, "SIGTERM");
  assert.equal(result.ok, true);
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

test("waitForProcessDeath resolves false once the timeout elapses for a still-alive process", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  const child = spawnManaged({ argv: ["sleep", "5"], cwd: process.cwd(), env }, callbacksFor(rec));
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
});

// --- killProcessGroupPosix (the real phase split) ---

test("killProcessGroupPosix: a normal (non-resistant) process dies from SIGTERM alone - no escalation needed", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  const child = spawnManaged({ argv: ["sleep", "10"], cwd: process.cwd(), env }, callbacksFor(rec));
  await waitFor(() => rec.spawned > 0);
  const result = await killProcessGroupPosix(child!.pid!, 2000);
  assert.equal(result.finalSignal, "SIGTERM");
  assert.equal(result.escalated, false);
  assert.equal(isProcessAlive(child!.pid!), false);
});

test("a SIGTERM-resistant process is escalated to SIGKILL after the grace period and actually dies", async () => {
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
});

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
