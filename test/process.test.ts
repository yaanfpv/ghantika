import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, test } from "node:test";

// Only the "Optional per-job execution deadline" section far below spawns a
// real job through the real `run` tool's handler (`runTool.handler`,
// imported locally there) - see test/helpers/requireSpawnPolicy.ts for what
// this checks and why. That section owns its own `before(requireSpawnPolicy)`
// inside a describe() block rather than registering the guard here at file
// scope: this file has 136 tests and only that section's spawn, so a
// file-level hook would fail every other test under an unset policy
// variable too.
import { requireSpawnPolicy } from "./helpers/requireSpawnPolicy.ts";

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
  checkProcessIdentity,
  confirmProcessGroupReapedPosix,
  evaluatePreSignalIdentityGate,
  hasLiveProcessGroupMembersPosix,
  identityElapsedTimesMatch,
  isProcessAlive,
  isProcessGroupAlive,
  killProcessGroupPosix,
  killProcessTreeWindows,
  parseEtime,
  parseLinuxStatStartTimeTicks,
  parseLstartBatchOutput,
  parsePidLstartRow,
  signalProcessGroupPosix,
  throwUnlessBenignAlreadyGoneRace,
  waitForProcessDeath,
} from "../dist/process.js";
import { TASK_TTL_MS, getTask } from "../dist/tasksAdapter.js";

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

// captureBirthIdentityPosixAsync's own fake-ps-on-PATH retry/timeout/
// aggregate-cap tests live in test/process-contention-timing.test.ts - see
// that file's own header for why they need a real spawned process rather
// than pure/injected fixtures.

// A handful of tests need a REAL, currently-alive process's genuine
// /proc/<pid>/stat entry (the "found" case) - macOS has no /proc filesystem
// at all, so every read against it fails with the identical ENOENT a
// genuinely-missing pid produces on Linux, which would make a "found"
// assertion read as a false "not-found" there rather than exercising
// anything real. This dev machine is macOS, so these run only in CI's
// ubuntu-latest legs - see this file's own header docs and this story's
// hand-back for exactly which tests this does and does not gate (the
// not-found-only cases below are deliberately left UNGATED, since ENOENT is
// ENOENT on either platform and they genuinely exercise the same code path
// everywhere).
const LINUX_ONLY_SKIP =
  process.platform !== "linux"
    ? "needs a real, currently-alive process's genuine /proc/<pid>/stat entry - Linux-only"
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
// resolveCwd - GHANTIKA_CWD_ROOTS (configured-root validation)
// ---------------------------------------------------------------------------

const CWD_ROOTS_ENV_VAR_NAME = "GHANTIKA_CWD_ROOTS";

test("resolveCwd with GHANTIKA_CWD_ROOTS unset accepts any real directory, exactly as before this story - opt-in, never a new silent default-deny", () => {
  assert.equal(process.env[CWD_ROOTS_ENV_VAR_NAME], undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-cwdroots-unset-"));
  const result = resolveCwd(dir);
  assert.equal(result.ok, true);
});

test("resolveCwd accepts a cwd that resolves inside a configured root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-cwdroots-root-"));
  const inside = fs.mkdtempSync(path.join(root, "job-"));
  const original = process.env[CWD_ROOTS_ENV_VAR_NAME];
  try {
    process.env[CWD_ROOTS_ENV_VAR_NAME] = root;
    const result = resolveCwd(inside);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.resolvedCwd, fs.realpathSync(inside));
  } finally {
    if (original === undefined) delete process.env[CWD_ROOTS_ENV_VAR_NAME];
    else process.env[CWD_ROOTS_ENV_VAR_NAME] = original;
  }
});

test("resolveCwd accepts a cwd equal to the configured root itself, not only a strict descendant", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-cwdroots-exact-"));
  const original = process.env[CWD_ROOTS_ENV_VAR_NAME];
  try {
    process.env[CWD_ROOTS_ENV_VAR_NAME] = root;
    const result = resolveCwd(root);
    assert.equal(result.ok, true);
  } finally {
    if (original === undefined) delete process.env[CWD_ROOTS_ENV_VAR_NAME];
    else process.env[CWD_ROOTS_ENV_VAR_NAME] = original;
  }
});

test("resolveCwd rejects a cwd outside every configured root, with a diagnostic naming the reason", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-cwdroots-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-cwdroots-outside-"));
  const original = process.env[CWD_ROOTS_ENV_VAR_NAME];
  try {
    process.env[CWD_ROOTS_ENV_VAR_NAME] = root;
    const result = resolveCwd(outside);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /outside the configured allowed roots/);
  } finally {
    if (original === undefined) delete process.env[CWD_ROOTS_ENV_VAR_NAME];
    else process.env[CWD_ROOTS_ENV_VAR_NAME] = original;
  }
});

test("resolveCwd's root check is a real directory-BOUNDARY comparison, not a bare string prefix: a sibling directory whose name happens to start with the root's name is rejected", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-cwdroots-boundary-"));
  const root = path.join(parent, "job");
  fs.mkdirSync(root);
  // A real, separate directory whose STRING is a prefix-match of `root`
  // (same parent, "job" + "-sibling") but is NOT a subdirectory of it at
  // all - a naive `resolvedCwd.startsWith(root)` (no trailing separator)
  // would wrongly accept this.
  const sibling = path.join(parent, "job-sibling");
  fs.mkdirSync(sibling);
  const original = process.env[CWD_ROOTS_ENV_VAR_NAME];
  try {
    process.env[CWD_ROOTS_ENV_VAR_NAME] = root;
    const result = resolveCwd(sibling);
    assert.equal(result.ok, false);
  } finally {
    if (original === undefined) delete process.env[CWD_ROOTS_ENV_VAR_NAME];
    else process.env[CWD_ROOTS_ENV_VAR_NAME] = original;
  }
});

test(
  "resolveCwd's root check validates the REAL, symlink-resolved target - a symlink whose own path sits inside an allowed root but that POINTS OUTSIDE every root is rejected",
  {
    skip:
      process.platform === "win32"
        ? "symlink creation needs elevated privileges on win32 in CI"
        : false,
  },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-cwdroots-symlink-root-"));
    const outsideTarget = fs.mkdtempSync(
      path.join(os.tmpdir(), "ghantika-cwdroots-symlink-target-")
    );
    const linkPath = path.join(root, "escape-link");
    fs.symlinkSync(outsideTarget, linkPath, "dir");
    const original = process.env[CWD_ROOTS_ENV_VAR_NAME];
    try {
      process.env[CWD_ROOTS_ENV_VAR_NAME] = root;
      // The literal path is INSIDE root by string shape; the real target
      // it resolves to is not. Rejecting proves the check follows the
      // symlink before comparing, rather than judging the literal spelling.
      const result = resolveCwd(linkPath);
      assert.equal(result.ok, false);
    } finally {
      if (original === undefined) delete process.env[CWD_ROOTS_ENV_VAR_NAME];
      else process.env[CWD_ROOTS_ENV_VAR_NAME] = original;
    }
  }
);

test(
  "resolveCwd's root check resolves a configured root that is ITSELF a symlink to its real target before comparing - a cwd matching that real target is accepted even though the configured string named the symlink",
  {
    skip:
      process.platform === "win32"
        ? "symlink creation needs elevated privileges on win32 in CI"
        : false,
  },
  () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-cwdroots-real-root-"));
    const linkRoot = path.join(
      os.tmpdir(),
      `ghantika-cwdroots-link-root-${process.pid}-${Date.now()}`
    );
    fs.symlinkSync(realRoot, linkRoot, "dir");
    const original = process.env[CWD_ROOTS_ENV_VAR_NAME];
    try {
      process.env[CWD_ROOTS_ENV_VAR_NAME] = linkRoot; // the symlink path, not the real one
      const result = resolveCwd(realRoot); // the job's cwd is the REAL directory
      assert.equal(result.ok, true);
    } finally {
      if (original === undefined) delete process.env[CWD_ROOTS_ENV_VAR_NAME];
      else process.env[CWD_ROOTS_ENV_VAR_NAME] = original;
      fs.unlinkSync(linkRoot);
    }
  }
);

test("resolveCwd's root check accepts multiple path.delimiter-separated roots, matching against any of them", () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-cwdroots-multi-a-"));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-cwdroots-multi-b-"));
  const insideB = fs.mkdtempSync(path.join(rootB, "job-"));
  const original = process.env[CWD_ROOTS_ENV_VAR_NAME];
  try {
    process.env[CWD_ROOTS_ENV_VAR_NAME] = `${rootA}${path.delimiter}${rootB}`;
    const result = resolveCwd(insideB);
    assert.equal(result.ok, true);
  } finally {
    if (original === undefined) delete process.env[CWD_ROOTS_ENV_VAR_NAME];
    else process.env[CWD_ROOTS_ENV_VAR_NAME] = original;
  }
});

test("resolveCwd's root check silently drops a configured root that cannot itself be resolved, rather than crashing or treating it as a wildcard match - a genuinely valid sibling root still works", () => {
  const staleRoot = path.join(os.tmpdir(), `ghantika-cwdroots-stale-${process.pid}-${Date.now()}`);
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-cwdroots-real-"));
  const inside = fs.mkdtempSync(path.join(realRoot, "job-"));
  const original = process.env[CWD_ROOTS_ENV_VAR_NAME];
  try {
    process.env[CWD_ROOTS_ENV_VAR_NAME] = `${staleRoot}${path.delimiter}${realRoot}`;
    const result = resolveCwd(inside);
    assert.equal(result.ok, true);
  } finally {
    if (original === undefined) delete process.env[CWD_ROOTS_ENV_VAR_NAME];
    else process.env[CWD_ROOTS_ENV_VAR_NAME] = original;
  }
});

test("REGRESSION: resolveCwd rejects every cwd when GHANTIKA_CWD_ROOTS is a non-empty value that splits and filters to zero effective roots - a lone path.delimiter is NOT read as unrestricted", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-cwdroots-delimonly-"));
  const original = process.env[CWD_ROOTS_ENV_VAR_NAME];
  try {
    process.env[CWD_ROOTS_ENV_VAR_NAME] = path.delimiter;
    const result = resolveCwd(outside);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /outside the configured allowed roots/);
  } finally {
    if (original === undefined) delete process.env[CWD_ROOTS_ENV_VAR_NAME];
    else process.env[CWD_ROOTS_ENV_VAR_NAME] = original;
  }
});

// mutation control: prove the boundary check above is actually discriminating,
// not vacuously true - a bare (no trailing separator) startsWith on the two
// real fixture strings themselves WOULD wrongly match, showing the naive
// version this function deliberately does not use.
test("mutation control: a bare startsWith without a trailing separator would wrongly treat a prefix-sharing sibling as inside the root", () => {
  const root = "/tmp/ghantika-mutant-job";
  const sibling = "/tmp/ghantika-mutant-job-sibling";
  assert.equal(sibling.startsWith(root), true); // the naive check a mutant would use
  assert.equal(sibling.startsWith(root.endsWith(path.sep) ? root : root + path.sep), false); // the real one
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

/**
 * Polls a real `pgrep -g <pgid>` count until the process GROUP has at
 * least `minMembers` live members, rather than guessing a fixed delay for
 * real forked descendants to actually land - the same real external
 * process-table observation test/harness.ts's own
 * pgrepGroupMembers/waitForPgrepGroupMembers pair uses (this file drives
 * src/process.ts's primitives directly rather than over the wire, so it
 * does not already import that harness).
 */
async function waitForGroupMemberCount(
  pgid: number,
  minMembers: number,
  timeoutMs = 3000
): Promise<number> {
  const start = Date.now();
  for (;;) {
    let count = 0;
    try {
      const output = execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" });
      count = output.split("\n").filter((line) => line.trim().length > 0).length;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { status?: number };
      if (err.status !== 1) throw error; // pgrep's own "nothing matched" exit code - a real, expected zero-members result
    }
    if (count >= minMembers) return count;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForGroupMemberCount: timed out after ${timeoutMs}ms waiting for pgid ${pgid} to reach >= ${minMembers} members, last saw ${count}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
    { argv: [], shellCommand: "echo x", shellExecutable: "/bin/sh", cwd: process.cwd(), env },
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
    {
      argv: [],
      shellCommand: "echo shell-one && echo shell-two",
      shellExecutable: "/bin/sh",
      cwd: process.cwd(),
      env,
    },
    callbacksFor(rec)
  );
  await waitFor(() => rec.exits.length > 0);
  assert.equal(rec.exits[0]!.code, 0);
  assert.equal(Buffer.concat(rec.stdout).toString("utf8").trim(), "shell-one\nshell-two");
});

test("spawnManaged refuses to spawn a shell job without an explicit shellExecutable - a non-spawn regression proving the vulnerable implicit shell:true resolution path (which would have let a job's own env pick the shell binary) is structurally unreachable, never merely avoided by callers agreeing to pass the right thing", async () => {
  const rec = recorder();
  const env = buildChildEnv("merge", {});
  const child = spawnManaged(
    // Deliberately omits shellExecutable - the exact shape the pre-fix
    // code always used (shell: true with no separately-approved
    // identity). See test/policy.test.ts's "a trusted PATH and a job's
    // own PATH genuinely resolve... to DIFFERENT real executables" for
    // the complementary proof that this shape was genuinely exploitable
    // (env-dependent resolution really does diverge), not merely a
    // theoretical concern.
    { argv: [], shellCommand: "echo should-never-run", cwd: process.cwd(), env },
    callbacksFor(rec)
  );
  // No child, no spawn, no OS-level attempt at all - the contract
  // violation is caught before child_process.spawn is ever called, so
  // this settles via the SAME onError path spawnManaged already uses for
  // a real OS-level spawn failure (see its own docs), never a real spawn
  // that then gets killed or ignored.
  assert.equal(child, undefined);
  await waitFor(() => rec.errors.length > 0);
  assert.match(rec.errors[0]!, /shellExecutable is required/);
  assert.equal(rec.spawned, 0, "no spawn event may ever fire for this job");
  assert.equal(rec.exits.length, 0, "no exit event may ever fire - there is no child to exit");
});

test("spawnManaged actually invokes the LITERAL shellExecutable path given - never silently falls back to the OS default shell - proven live: a custom shell wrapper, not named /bin/sh and not on PATH, must be the one that runs", async () => {
  // The prior tests prove (a) omitting shellExecutable is refused, and (b)
  // a shellCommand runs correctly when shellExecutable happens to be
  // "/bin/sh" - but "/bin/sh" IS shell:true's own POSIX default, so neither
  // test can tell "spawn used our literal shellExecutable string" apart
  // from "spawn silently used shell:true and got the same binary by luck".
  // This test uses a DIFFERENT real executable - not /bin/sh, not
  // discoverable via PATH - and proves it specifically is what ran, which
  // is only possible if `shell: options.shellExecutable` is a real string
  // passed through to spawn(), not a stale `shell: true` regression.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-custom-shell-"));
  const customShell = path.join(dir, "not-named-sh");
  const marker = path.join(dir, "custom-shell-was-invoked");
  // Node's shell-invocation contract calls the shell as `<shell> -c
  // "<command>"` - this wrapper records that IT was the one invoked, then
  // delegates to a real shell so the actual command still runs normally.
  fs.writeFileSync(customShell, `#!/bin/sh\ntouch '${marker}'\nexec /bin/sh "$@"\n`);
  fs.chmodSync(customShell, 0o755);

  const rec = recorder();
  const env = buildChildEnv("merge", {});
  spawnManaged(
    {
      argv: [],
      shellCommand: "echo via-custom-shell",
      shellExecutable: customShell,
      cwd: process.cwd(),
      env,
    },
    callbacksFor(rec)
  );
  await waitFor(() => rec.exits.length > 0);

  assert.equal(
    fs.existsSync(marker),
    true,
    "the custom shellExecutable's own marker must exist - if spawn() had used shell: true (or any default) instead of this literal path, this exact binary would never have run and the marker would never appear"
  );
  assert.equal(rec.exits[0]!.code, 0);
  assert.equal(
    Buffer.concat(rec.stdout).toString("utf8").trim(),
    "via-custom-shell",
    "the actual command must still have run correctly, delegated through the custom shell to a real one"
  );
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

// captureBirthIdentityPosixAsync's own retry semantics - the two-bound
// model (a RETRY budget governing whether another retry may start, and the
// pre-existing AGGREGATE cap kill()/the shutdown reaper already document,
// which the retry addition must never widen) - are exercised directly
// against the production function via a fake `ps` shadowed onto PATH in
// test/process-contention-timing.test.ts; see that file's own header.

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

// --- retryBirthIdentityCapture: per-attempt deadline enforcement (the
// race, not just a post-await check). The four tests above prove the
// retry LOOP's own logic (does it retry, does it eventually give up); the
// four below prove the DEADLINE is enforced around each individual
// attempt rather than only checked once an attempt has already settled
// on its own schedule - a slow or hung attempt must never be able to run
// past its own configured bound. ---

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

// --- parseLinuxStatStartTimeTicks (pure, no real process needed - the
// LINUX counterpart of parseEtime above, run on EVERY platform since it is
// a pure string parser with no OS dependency at all: a synthetic, injected
// /proc/<pid>/stat-shaped string is all it needs). ---

test("parseLinuxStatStartTimeTicks: extracts field 22 (starttime) from an ordinary, simple comm field", () => {
  // A realistic (abbreviated - only the fields up to and including
  // starttime are load-bearing here, everything after is never read)
  // /proc/<pid>/stat line: pid (comm) state ppid pgrp session tty_nr
  // tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime
  // priority nice num_threads itrealvalue starttime ...
  const raw =
    "123 (bash) S 1 123 123 0 -1 4194304 100 200 0 0 10 20 5 3 20 0 1 0 12345 10000000 500";
  assert.equal(parseLinuxStatStartTimeTicks(raw), "12345");
});

test("parseLinuxStatStartTimeTicks: a comm field containing its OWN spaces and a nested parenthesis is handled correctly via the LAST ')' in the line, never the first", () => {
  // `comm` (field 2) can contain almost any byte the kernel allows in a
  // process name, including spaces and parens - a real, legal
  // /proc/<pid>/stat line, not a contrived edge case (see this function's
  // own docs: the standard technique `man proc` itself documents). A naive
  // first-')'-wins parser would stop at the ")" after "weird", leaving a
  // garbage tail that starts mid-comm rather than at the real field 3.
  const raw =
    "456 (my (weird) program name) S 1 456 456 0 -1 4194304 100 200 0 0 10 20 5 3 20 0 1 0 67890";
  assert.equal(parseLinuxStatStartTimeTicks(raw), "67890");
});

test("parseLinuxStatStartTimeTicks: a leading-zero digit string is accepted as-is (never parsed to a number, so no octal/precision concern)", () => {
  const raw = "123 (bash) S 1 123 123 0 -1 4194304 100 200 0 0 10 20 5 3 20 0 1 0 007";
  assert.equal(parseLinuxStatStartTimeTicks(raw), "007");
});

test("parseLinuxStatStartTimeTicks: returns undefined for a line with no ')' at all - never guessed at", () => {
  assert.equal(parseLinuxStatStartTimeTicks(""), undefined);
  assert.equal(parseLinuxStatStartTimeTicks("123 no-parens-here-at-all S 1 2 3"), undefined);
});

test("parseLinuxStatStartTimeTicks: returns undefined when the tail after ')' has fewer than 20 fields - a truncated or malformed read, never a fabricated value", () => {
  assert.equal(parseLinuxStatStartTimeTicks("123 (bash) S 1 2 3"), undefined);
});

test("parseLinuxStatStartTimeTicks: returns undefined when the field-22 position holds a non-digit token - a malformed/corrupted read fails closed, exactly like parseEtime's own equivalent discipline", () => {
  const raw = "123 (bash) S 1 123 123 0 -1 4194304 100 200 0 0 10 20 5 3 20 0 1 0 not-a-number";
  assert.equal(parseLinuxStatStartTimeTicks(raw), undefined);
});

// readLinuxStartTimeTicksAsync's own hang-safety bound (a real, confirmed
// defect: it used to `await` its `/proc/<pid>/stat` read directly, with no
// timeout/AbortController/race at all), and the GHANTIKA_TEST_DEGRADE_PROC_READ
// failure-only hatch's own mode-space matrix (including its mutation
// control on an unrecognized value), are exercised in
// test/process-contention-timing.test.ts; see that file's own header.

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

test("checkProcessIdentity: not-found for a pid that plainly doesn't exist (posix-elapsed identity)", async () => {
  const result = await checkProcessIdentity(999_999, {
    platform: "posix-elapsed",
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
      platform: "posix-elapsed" as const,
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
    platform: "posix-elapsed",
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
      platform: "posix-elapsed" as const,
      capturedAtMs: Date.now() - 10 * 60 * 1000,
      elapsedSecondsAtCapture: 0,
    };
    const gate = await evaluatePreSignalIdentityGate(child!.pid!, fakeBirthIdentity);
    assert.equal(gate.action, "refuse");
    if (gate.action === "refuse") assert.match(gate.reason, /reused pid/);
    process.kill(-child!.pid!, "SIGKILL"); // cleanup
  }
);

// --- The Linux birth-identity path end to end, against a REAL process -
// mirrors the posix-elapsed coverage above exactly, just for the other
// branch of the discriminated union. Gated LINUX_ONLY (see that constant's
// own docs): the "found" case needs a genuine /proc/<pid>/stat entry, which
// only exists on a real Linux host - this dev machine is macOS, so these
// run only in CI's ubuntu-latest legs. ---

test(
  "checkProcessIdentity (LINUX): alive-confirmed for a real process whose ACTUAL captured start-time ticks match",
  { skip: LINUX_ONLY_SKIP },
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
    assert.equal(birthIdentity!.platform, "linux-starttime-ticks");
    const result = await checkProcessIdentity(child!.pid!, birthIdentity!);
    assert.equal(result.status, "alive-confirmed");
    process.kill(-child!.pid!, "SIGKILL"); // cleanup
  }
);

test(
  "checkProcessIdentity (LINUX): REFUSES to confirm a real, currently-alive process when the captured start-time ticks do not match - a convincing simulation of PID reuse, with NO tolerance window at all (unlike the posix-elapsed branch)",
  { skip: LINUX_ONLY_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "3"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    // A real capture, then deliberately corrupted to a DIFFERENT well-formed
    // digit string - appending a digit always changes the value while
    // staying a valid /^\d+$/ token, exactly the shape a genuine pid-reuse
    // scenario would produce (a different real process, a different real
    // start-time tick count).
    const realIdentity = await retryBirthIdentityCapture(
      () => captureBirthIdentityPosix(child!.pid!),
      "captureBirthIdentityPosix"
    );
    assert.notEqual(realIdentity, undefined);
    assert.equal(realIdentity!.platform, "linux-starttime-ticks");
    const fakeBirthIdentity = {
      platform: "linux-starttime-ticks" as const,
      startTimeTicks:
        realIdentity!.platform === "linux-starttime-ticks"
          ? `${realIdentity!.startTimeTicks}0`
          : "0",
    };
    const result = await checkProcessIdentity(child!.pid!, fakeBirthIdentity);
    assert.equal(result.status, "identity-mismatch");
    if (result.status === "identity-mismatch") {
      assert.match(result.reason, /reused pid/);
    }
    process.kill(-child!.pid!, "SIGKILL"); // cleanup
  }
);

test("checkProcessIdentity (LINUX): not-found for a pid that plainly doesn't exist - UNGATED, since ENOENT is ENOENT on any platform (macOS has no /proc filesystem at all, so this exercises the identical code path there too)", async () => {
  const result = await checkProcessIdentity(999_999, {
    platform: "linux-starttime-ticks",
    startTimeTicks: "12345",
  });
  assert.equal(result.status, "not-found");
});

test(
  "evaluatePreSignalIdentityGate (LINUX): alive-confirmed identity -> proceed with identityConfirmed: true",
  { skip: LINUX_ONLY_SKIP },
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

test(
  "evaluatePreSignalIdentityGate (LINUX): a real identity mismatch -> refuse, with an honest reason",
  { skip: LINUX_ONLY_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "3"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const realIdentity = await retryBirthIdentityCapture(
      () => captureBirthIdentityPosix(child!.pid!),
      "captureBirthIdentityPosix"
    );
    assert.notEqual(realIdentity, undefined);
    const fakeBirthIdentity = {
      platform: "linux-starttime-ticks" as const,
      startTimeTicks:
        realIdentity!.platform === "linux-starttime-ticks"
          ? `${realIdentity!.startTimeTicks}0`
          : "0",
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
// The escalation identity gate: before the SIGKILL escalation, prove the
// process group is still the one this codebase spawned. The batched/
// bounded/force-reaped observer (readPidStartTimesBatchPosix), the
// pre-SIGTERM snapshot (captureEscalationIdentitySnapshot) and its own
// fail-closed cells, and the escalation-time decision
// (evaluateEscalationIdentityGate) are exercised in
// test/process-contention-timing.test.ts; see that file's own header. What
// stays here is the frozen six-token ps grammar those functions are built
// on (parsePidLstartRow, immediately below) and its own timing-constant
// sanity check.
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

// --- parseLstartBatchOutput: the pure row-parsing-and-discard logic,
// isolated from the spawn/observe/timeout machinery entirely ---

test("parseLstartBatchOutput: a mix of one well-formed row and one malformed row keeps the well-formed one - a malformed row is discarded, never poisoning the others (PURE - no spawn, no real ps, no PATH manipulation, no timeout at all; this is what actually makes the assertion timing-independent, not the widened-timeout integration test below)", () => {
  const pid = 12345;
  // The exact literal row-text shapes the integration test below feeds a
  // real fake `ps` - reused verbatim here so both tests exercise the same
  // input shape, just through different doors. The malformed row is
  // missing its year token (five tokens instead of six), the same defect
  // `parsePidLstartRow`'s own dedicated test above already names.
  const stdout = "12345 Sat Jul 25 13:39:12 2026\n999999 Sat Jul 25 13:39:12\n";
  const rows = parseLstartBatchOutput(stdout);
  assert.equal(rows.length, 1, "expected only the well-formed row to survive");
  assert.equal(rows[0]!.pid, pid);
  assert.equal(rows[0]!.startTimeMs, Date.UTC(2026, 6, 25, 13, 39, 12));
  assert.ok(
    !rows.some((row) => row.pid === 999_999),
    "the malformed row must never contribute an entry, under its own pid or any other"
  );
});

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
    await waitForGroupMemberCount(leaderPid, 4); // let descendants fork

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

// -----------------------------------------------------------------------------
// Optional per-job execution deadline: run() accepts an optional deadline_ms.
// Once it elapses on a still-running job, this codebase's own real
// process-group kill machinery (the same primitives exercised throughout
// this file - evaluatePreSignalIdentityGate, killProcessGroupPosix) is used
// to terminate it, and the job is recorded as failed - never a new status.
// Exercised end to end through run()'s real handler and the real jobStore
// it's built on, never by re-implementing any kill logic here.
//
// A note on distinctness from the Tasks-extension's own TTL purge
// (src/tasksAdapter.ts): the deadline transition itself never removes the
// job's record - it only fails the job, exactly like any other failure
// path. The record can still be purged later, on a subsequent
// `tasks/get` read, once it has been terminal for at least TASK_TTL_MS -
// the SAME lazy, on-read purge every other terminal job is already
// subject to, nothing deadline-specific about it. The tests below assert
// the deadline half directly (expiring fails the job, the record is
// present immediately after); the combined test further down proves the
// TTL half actually reaches a deadline-failed record too, rather than
// leaving that as an unverified assumption.
// -----------------------------------------------------------------------------

import { jobStore } from "../dist/jobStore.js";
import * as runTool from "../dist/tools/run.js";

/** The closed set of job states this codebase's job model has, spelled out
 * as an independent literal oracle (not imported from jobStore.ts) so a
 * future change that quietly widens the real union cannot also widen what
 * this file checks against. */
const KNOWN_JOB_STATES = ["starting", "running", "exited", "killed", "failed"];

function runJobIdOf(result: ReturnType<typeof runTool.handler>): string {
  const structured = result.structuredContent as Record<string, unknown>;
  const jobId = structured.job_id;
  assert.equal(typeof jobId, "string", `expected a real job_id, got: ${JSON.stringify(result)}`);
  return jobId as string;
}

// This suite's spawning children need requireSpawnPolicy; its pre-policy
// validation children do not: each of the four tests below returns
// before src/tools/run.ts ever reaches
// decideRunPolicy/decideShellPolicy - the cwd-roots regression settles via
// createFailedJob from resolveCwd, and the three deadline_ms rejections
// settle via validateRunInput - so none of them needs, or is affected by,
// GHANTIKA_POLICY_FILE being set. Guarding this describe would fail these
// four under an unset policy for no reason connected to what they assert.
describe("Optional per-job execution deadline (real run() tool) - pre-policy validation", () => {
  // REGRESSION for the fail-open GHANTIKA_CWD_ROOTS bug: a non-empty raw
  // value that splits and filters down to zero effective roots (a lone
  // `path.delimiter`, on its own) must NOT be read as "unrestricted" - it
  // must deny every cwd. Exercised through the REAL run() production path
  // (not resolveCwd directly), because the real defect was reachable there:
  // a job with this env var set could spawn and exit 0 in an arbitrary
  // directory outside every intended root.
  test("REGRESSION: run() rejects every cwd, never spawning, when GHANTIKA_CWD_ROOTS is set to a non-empty value that filters to zero effective roots", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-cwdroots-run-delimonly-"));
    const original = process.env[CWD_ROOTS_ENV_VAR_NAME];
    try {
      process.env[CWD_ROOTS_ENV_VAR_NAME] = path.delimiter;
      const result = runTool.handler({ command: ["true"], cwd: outside });
      const jobId = runJobIdOf(result);
      const record = jobStore.get(jobId)!;
      // createFailedJob settles the job synchronously and immediately - no
      // real child was ever spawned, so no wait-for-terminal is needed.
      assert.equal(record.state, "failed");
      assert.equal(record.diagnostic?.reason, "spawn-error");
      assert.match(record.diagnostic!.message, /outside the configured allowed roots/);
    } finally {
      if (original === undefined) delete process.env[CWD_ROOTS_ENV_VAR_NAME];
      else process.env[CWD_ROOTS_ENV_VAR_NAME] = original;
    }
  });

  test("run(): deadline_ms rejects a non-positive or non-finite value rather than silently accepting it", () => {
    for (const badValue of [
      0,
      -1,
      -1000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const result = runTool.handler({ command: ["true"], deadline_ms: badValue });
      assert.equal(result.isError, true, `expected deadline_ms: ${badValue} to be rejected`);
    }
  });

  test("run(): deadline_ms rejects a non-number value", () => {
    for (const badValue of ["1000", true, [], {}, null]) {
      const result = runTool.handler({
        command: ["true"],
        deadline_ms: badValue as unknown as number,
      });
      assert.equal(
        result.isError,
        true,
        `expected deadline_ms: ${JSON.stringify(badValue)} to be rejected`
      );
    }
  });

  test("run(): deadline_ms rejects the first value above Node's own timer maximum, before ever spawning - Node itself would otherwise silently clamp this to a near-immediate deadline rather than honoring the requested one", () => {
    const result = runTool.handler({ command: ["sleep", "60"], deadline_ms: 2_147_483_648 });
    assert.equal(result.isError, true, "the first overflowing value must be rejected outright");
    assert.match(
      (result.content[0] as { text: string }).text,
      /2147483647/,
      "the rejection message must name Node's own maximum, not just say the value is invalid"
    );
    // validateRunInput (see validateDeadlineMs) fails and this handler
    // returns via toolError() BEFORE ever reaching the block that resolves
    // cwd/executable, calls spawnManaged, or generates a job id - reading
    // that control flow directly shows no path from a rejected deadline_ms
    // to a real spawn. So the isError assertion above already establishes
    // "no job started" by construction; there is no observable job id or
    // process to additionally check, the same way the sibling rejection
    // tests below (non-positive/non-finite, non-number) don't either.
  });
});

// Every test below is POSIX_PROCESS_GROUP_SKIP on win32, so the
// registration is conditioned on the same predicate - otherwise the hook
// would throw on unset policy on win32 with nothing left to guard.
describe("Optional per-job execution deadline (real run() tool)", () => {
  if (process.platform !== "win32") {
    before(requireSpawnPolicy);
  }

  test(
    "run(): omitting deadline_ms leaves a job's own natural lifecycle completely untouched, even across a huge mocked time jump - no deadline was ever scheduled to expire",
    { skip: POSIX_PROCESS_GROUP_SKIP },
    async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const result = runTool.handler({ command: ["sleep", "60"] }); // deadline_ms omitted entirely
      const jobId = runJobIdOf(result);
      const handle = jobStore.getChildHandle(jobId)!;

      // A jump far larger than any deadline this file sets anywhere else -
      // if this feature's mere existence affected an un-timed job at all,
      // this is where it would show up.
      t.mock.timers.tick(10 * 60 * 1000);
      t.mock.timers.reset();
      await new Promise((resolve) => setTimeout(resolve, 100));

      try {
        assert.equal(
          jobStore.get(jobId)!.state,
          "running",
          "an un-timed job must still be running after a huge mocked time jump - nothing was ever scheduled to end it early"
        );
        assert.equal(
          isProcessGroupAlive(handle.pid),
          true,
          "a real, external liveness check must confirm the process is still genuinely alive, not merely trust the job record's own state"
        );
      } finally {
        process.kill(-handle.pid, "SIGKILL");
      }
    }
  );

  test(
    "run(): a still-running job whose deadline_ms elapses is terminated through the real process-group kill machinery, recorded as failed with its record still present - driven entirely by a deterministic mocked clock, never a real sleep for the deadline itself",
    { skip: POSIX_PROCESS_GROUP_SKIP },
    async (t) => {
      const deadlineMs = 200_000; // reachable only by advancing the mocked clock - a real wait this long would make this test itself the thing it is meant to prove unnecessary
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const result = runTool.handler({ command: ["sleep", "600"], deadline_ms: deadlineMs });
      const jobId = runJobIdOf(result);
      const handle = jobStore.getChildHandle(jobId)!;
      const pid = handle.pid;

      assert.notEqual(
        jobStore.get(jobId)!.state,
        "failed",
        "the job must not already be failed before its deadline has elapsed at all"
      );

      // Advance the mocked clock past the deadline - the entire "wait" this
      // test ever performs for the deadline itself - then hand real timers
      // back so the real kill mechanics this fires off (the identity gate,
      // the real SIGTERM, the grace-period wait, the external confirmation)
      // run and complete against the real spawned process on real time,
      // exactly as this file's own existing kill tests already do elsewhere.
      t.mock.timers.tick(deadlineMs);
      t.mock.timers.reset();

      await waitFor(() => jobStore.get(jobId)?.state === "failed", 5000);
      // A real, external, no-zombie-survivors liveness check - polled rather
      // than sampled once, so a process still mid-death from the SIGTERM this
      // codebase just sent cannot read as a flaky failure.
      await waitFor(() => !isProcessGroupAlive(pid), 5000);

      const record = jobStore.get(jobId)!;
      assert.equal(record.state, "failed");
      assert.ok(
        KNOWN_JOB_STATES.includes(record.state),
        `expected one of this codebase's five pre-existing job states, got "${record.state}"`
      );
      assert.notEqual(record.state, "expired", "a deadline must never introduce a new job status");
      assert.equal(
        record.diagnostic?.reason,
        "watcher/runtime-error",
        "a deadline-exceeded job must reuse the same closed diagnostic-reason enum every other failed job already uses, never a bespoke one"
      );
      assert.match(record.diagnostic!.message, /deadline/i);
      assert.equal(
        isProcessGroupAlive(pid),
        false,
        "the real process group must be genuinely dead - an external liveness observation, not merely a claimed state"
      );

      // A deadline is a job-layer concern only - it must never surface as
      // anything other than an ordinary failed job's own real output counts.
      assert.equal(jobStore.getOutputCounts(jobId).stdout_lines, 0);

      // The deadline transition itself does not remove the job's record -
      // it is present immediately after the deadline failure. This does not
      // claim the record is retained forever: see the combined test below
      // for what happens once TASK_TTL_MS has also elapsed and a Tasks read
      // triggers the purge.
      assert.equal(
        jobStore.has(jobId),
        true,
        "a deadline-expired job's record must be present immediately after the deadline fires"
      );
      assert.notEqual(jobStore.get(jobId), undefined);
    }
  );

  test(
    "run(): a deadline-expired job's record, present right after the deadline fires, is later purged by the ordinary Tasks-extension TTL read once TASK_TTL_MS has also elapsed - the two mechanisms compose, proving the distinctness claim above rather than merely asserting it",
    { skip: POSIX_PROCESS_GROUP_SKIP },
    async (t) => {
      const deadlineMs = 200_000;
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const result = runTool.handler({ command: ["sleep", "600"], deadline_ms: deadlineMs });
      const jobId = runJobIdOf(result);
      const handle = jobStore.getChildHandle(jobId)!;
      const pid = handle.pid;

      t.mock.timers.tick(deadlineMs);
      t.mock.timers.reset();

      await waitFor(() => jobStore.get(jobId)?.state === "failed", 5000);
      await waitFor(() => !isProcessGroupAlive(pid), 5000);

      // Immediately after the deadline fires: failed, record present -
      // the same claim the test above already covers, re-asserted here as
      // the starting point this test's own TTL half builds on.
      assert.equal(jobStore.get(jobId)!.state, "failed");
      assert.equal(jobStore.has(jobId), true);

      // getTask takes an explicit `now`, so the TTL half needs no timer
      // mock at all - just a computed instant past TASK_TTL_MS from this
      // job's real end time.
      const endedAtMs = jobStore.get(jobId)!.ended_at
        ? new Date(jobStore.get(jobId)!.ended_at!).getTime()
        : Date.now();
      const notYetPastTtl = getTask(jobId, endedAtMs + TASK_TTL_MS - 1000);
      assert.equal(
        notYetPastTtl.status,
        "failed",
        "just under TASK_TTL_MS since the deadline-driven end, the record must still read normally"
      );
      assert.equal(jobStore.has(jobId), true, "not yet purged - still under TASK_TTL_MS");

      // getTask THROWS (task_not_found, -32602) rather than returning a
      // tagged success value on the released contract - see
      // src/tasksAdapter.ts's own taskNotFoundError docs.
      assert.throws(
        () => getTask(jobId, endedAtMs + TASK_TTL_MS + 1000),
        (error: unknown) => {
          const message = String((error as { message?: unknown })?.message ?? error);
          return /-32602|not found|task_not_found/i.test(message);
        },
        "expected the deadline-failed record to be purged past TASK_TTL_MS by the ordinary TTL read, throwing task_not_found"
      );
      assert.equal(
        jobStore.has(jobId),
        false,
        "the TTL read must have actually removed the record from jobStore, not merely reported it as gone"
      );
    }
  );

  test(
    "run(): a job that finishes naturally well before its own deadline keeps its natural outcome - the deadline timer never fires and never overrides a real result",
    { skip: POSIX_PROCESS_GROUP_SKIP },
    async () => {
      const result = runTool.handler({
        command: ["sh", "-c", "exit 7"],
        deadline_ms: 3000, // a real deadline the job's own near-instant exit will always beat
      });
      const jobId = runJobIdOf(result);

      await waitFor(() => jobStore.get(jobId)?.state === "exited", 5000);

      const record = jobStore.get(jobId)!;
      assert.equal(record.state, "exited");
      assert.equal(record.exit_code, 7);
      assert.equal(
        record.diagnostic,
        undefined,
        "a job that finished on its own must never carry a deadline-exceeded diagnostic"
      );
    }
  );

  test(
    "run(): deadline_ms accepts Node's own exact timer maximum (2147483647) - the supported boundary is not accidentally excluded by the overflow rejection above",
    { skip: POSIX_PROCESS_GROUP_SKIP },
    async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const result = runTool.handler({
        command: ["sleep", "600"],
        deadline_ms: 2_147_483_647,
      });
      assert.equal(result.isError, undefined, "the exact supported maximum must be accepted");
      const jobId = runJobIdOf(result);
      assert.notEqual(
        jobStore.get(jobId)!.state,
        "failed",
        "the job must be running normally immediately after accepting the boundary deadline"
      );

      // Prove the timer was genuinely scheduled at this exact value, not
      // silently rounded or dropped - tick the mocked clock to one
      // millisecond short of it first (must NOT fire), then to the exact
      // value (must fire), reusing this file's own real-kill-verification
      // pattern rather than a bare timer-scheduled assertion.
      t.mock.timers.tick(2_147_483_646);
      assert.notEqual(
        jobStore.get(jobId)!.state,
        "failed",
        "the deadline must not fire one millisecond early"
      );
      t.mock.timers.tick(1);
      t.mock.timers.reset();

      await waitFor(() => jobStore.get(jobId)?.state === "failed", 5000);
      const handle = jobStore.getChildHandle(jobId);
      if (handle !== undefined) {
        await waitFor(() => !isProcessGroupAlive(handle.pid), 5000);
      }
      assert.equal(jobStore.get(jobId)!.diagnostic?.reason, "watcher/runtime-error");
    }
  );
});
