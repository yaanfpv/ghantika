import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FROZEN_MODULES, checkModuleBoundaries } from "../scripts/check-module-boundaries.mjs";
import { checkNoTasksImport } from "../scripts/check-no-tasks-import.mjs";
import { checkStdioPurity } from "../scripts/check-stdio-purity.mjs";
import { pgrepGroupMembers, waitForPgrepGroupMembers } from "./harness.ts";

/**
 * Executes 45 physical mutation-test cases covering the module-loader
 * guards' full documented escape-route class. Every case runs a real
 * fixture against the real, current guard code on every invocation,
 * rather than asserting a cached or hardcoded result.
 *
 * PLUS three additional cases (grouped in their own section below) that
 * are not required to red: they evidence a two-hop acquisition frontier
 * this guard intentionally leaves open, one hop past the closed one-hop
 * alias/computed-member forms earlier in this file.
 *
 * PLUS four unrelated classifier self-tests, also in their own section
 * (CLASSIFIER SELF-TESTS below): not module-loader escape-route cases at
 * all, these cover this file's own spawnSync-termination-classification
 * helper used by the nested-process timeout guard further below.
 *
 * Methodology, matching test/guard-mutation-coverage.test.ts: a real
 * scratch directory on disk (`mkdtempSync`), a fixture file written into
 * it containing the EXACT code shape a case describes, then the REAL
 * orchestrating guard function (`checkModuleBoundaries`/`checkNoTasksImport`
 * imported from the actual `scripts/*.mjs` guards, never the low-level
 * `find*` helpers) run against that scratch directory - proving each case
 * is caught at the SAME layer `npm run guard:*` runs at. Every scratch
 * directory is removed (`rmSync`) immediately after its assertions.
 *
 * The kill criterion: a case is killed only when the NAMED OWNING GUARD
 * rejects it and the rejection matches that case's OWNING PREDICATE - the
 * specific diagnostic text the guard is expected to emit. A red from the
 * other guard, a parse error, or a generic non-zero exit is NOT a kill.
 * Every assertion below matches on the exact predicate substring expected
 * for that case, not merely "some violation exists".
 *
 * The guard-self-mutation cases near the end of this file are different
 * in kind from the fixture-mutation cases earlier: those mutate a FIXTURE
 * and run the real, unmutated guard against it; the guard-self-mutation
 * cases mutate the GUARD ITSELF. The TRACKED guard files
 * (scripts/check-module-boundaries.mjs,
 * scripts/check-no-tasks-import.mjs, scripts/check-stdio-purity.mjs,
 * scripts/lib/ts-ast.mjs) are never modified - those cases instead copy
 * the guard's own source text (plus its unmutated scripts/lib/*.mjs
 * dependencies) into a scratch directory, apply one exact, deterministic
 * textual mutation to the COPY, dynamically `import()` the mutated copy,
 * and run its OWN exported orchestrating function - never touching the
 * real file on disk. See `loadMutatedGuardCopy` below.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The two TRACKED guard files' bytes, captured ONCE at module load - before
 * any test in this file has run, and in particular before any guard-self
 * mutation case below has copied and mutated them. The final restoration
 * check re-reads both files fresh and compares against these captured
 * bytes directly, so a guard-self case that accidentally wrote to the
 * TRACKED file (instead of only ever its own scratch copy) is caught by an
 * actual content comparison - not by `existsSync`, which stays true no
 * matter what bytes a file holds and would pass unchanged even if a case
 * overwrote the tracked guard with arbitrary content.
 */
const ORIGINAL_MODULE_BOUNDARIES_GUARD_TEXT = readFileSync(
  path.join(REPO_ROOT, "scripts", "check-module-boundaries.mjs"),
  "utf8"
);
const ORIGINAL_NO_TASKS_GUARD_TEXT = readFileSync(
  path.join(REPO_ROOT, "scripts", "check-no-tasks-import.mjs"),
  "utf8"
);

/**
 * Builds a scratch src/-shaped tree from a flat map of relative path ->
 * file contents. Mirrors test/guard-mutation-coverage.test.ts's own helper
 * of the same name.
 *
 * Also where ensureBaseline() is forced to run - not merely invoked in the
 * first declared test, which only guarantees the baseline predates a
 * mutation as long as declaration order is never disturbed. This is the
 * entry point every fixture/acquisition case that mutates a scratch
 * src/-shaped tree calls before writing its mutant, so calling it here
 * guarantees the baseline is captured before that mutation BY
 * CONSTRUCTION, regardless of test order - the same structural guarantee
 * the old before() hook gave, for those cases. It does NOT cover the
 * three guard-self-mutation cases below (loadMutatedGuardCopy()), which
 * each write their own mutant - a scratch copy of the guard script
 * itself - before ever calling this function. That is safe for a
 * different reason: loadMutatedGuardCopy() writes its mutant under its
 * own temp subdirectory, while runPermanentGuardSuite()'s spawn always
 * runs with cwd REPO_ROOT against the real guard scripts, so the
 * baseline it computes never reads that scratch copy at all.
 */
function buildScratchSrc(files: Record<string, string>): string {
  ensureBaseline();
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-loader-escape-"));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/**
 * Builds a scratch tree containing EVERY file `FROZEN_MODULES` requires
 * (a trivial `export {};` stub for each), then overwrites `mutantRelPath`
 * - one of those same frozen names, never an extra file - with the real
 * fixture content. `checkModuleBoundaries`'s frozen-module-completeness
 * check and `checkNoTasksImport`'s whole-tree scan both return a
 * literal, unfiltered empty array against a tree built this way, which
 * is the stronger, more defensible form for a case that must prove
 * "genuinely unflagged," not merely "unflagged once an unrelated
 * check's noise is filtered out."
 */
function buildCompleteFrozenScratchSrc(mutantRelPath: string, mutantContent: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-loader-escape-frozen-"));
  for (const rel of FROZEN_MODULES) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "export {};\n");
  }
  const mutantAbs = path.join(dir, mutantRelPath);
  mkdirSync(path.dirname(mutantAbs), { recursive: true });
  writeFileSync(mutantAbs, mutantContent);
  return dir;
}

/**
 * Replaces `search` with `replace` in `text`, but only after confirming
 * `search` appears EXACTLY ONCE. Refuses an ambiguous (zero, or more than
 * one occurrence) mutation rather than silently guessing.
 */
function mutateExactlyOnce(text: string, search: string, replace: string): string {
  const occurrences = text.split(search).length - 1;
  assert.equal(
    occurrences,
    1,
    `expected the mutation target text to appear EXACTLY once in the source, found ${occurrences} - refusing an ambiguous or vacuous mutation. Target was:\n${search}`
  );
  return text.replace(search, replace);
}

/**
 * Guard-self-mutation cases only. Copies `guardRelFile` (e.g.
 * "check-module-boundaries.mjs") from the REAL `scripts/` directory, plus
 * its unmutated `scripts/lib/*.mjs` dependencies, into a fresh scratch
 * directory placed directly under the repo root (never inside an OS
 * tmpdir) so that `import ts from "typescript"` inside the copied
 * `ts-ast.mjs` still resolves via Node's ordinary node_modules ancestor
 * walk, which finds this repo's own `node_modules/typescript` from the
 * scratch directory's parent. Applies `mutate` to the target guard file's
 * text (via `mutateExactlyOnce`, so a mutation that doesn't land exactly
 * once throws rather than silently doing nothing), writes the mutated copy,
 * and dynamically `import()`s it - the REAL tracked file at
 * `scripts/<guardRelFile>` is read but never written. The caller is
 * responsible for `rmSync`-ing the returned `scratchDir` once done.
 */
async function loadMutatedGuardCopy(
  guardRelFile: string,
  mutate: (originalText: string) => string
): Promise<{ mod: Record<string, unknown>; scratchDir: string }> {
  const scratchDir = mkdtempSync(path.join(REPO_ROOT, ".ghantika-self-mutant-"));
  try {
    const scriptsDir = path.join(scratchDir, "scripts");
    const libDir = path.join(scriptsDir, "lib");
    mkdirSync(libDir, { recursive: true });
    for (const libFile of ["ts-ast.mjs", "is-main.mjs"]) {
      writeFileSync(
        path.join(libDir, libFile),
        readFileSync(path.join(REPO_ROOT, "scripts", "lib", libFile), "utf8")
      );
    }
    const originalText = readFileSync(path.join(REPO_ROOT, "scripts", guardRelFile), "utf8");
    const mutatedText = mutate(originalText);
    assert.notEqual(
      mutatedText,
      originalText,
      "the mutation must actually change the source text - a no-op mutation proves nothing"
    );
    const mutatedPath = path.join(scriptsDir, guardRelFile);
    writeFileSync(mutatedPath, mutatedText);
    const mod = (await import(pathToFileURL(mutatedPath).href)) as Record<string, unknown>;
    return { mod, scratchDir };
  } catch (err) {
    rmSync(scratchDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Classifies a `spawnSync` result that ended in a signal, and throws with a
 * message specific to the real cause - module-scoped, not exported outside
 * this file, rather than inlined in `runPermanentGuardSuite`, so it can be
 * driven directly with real termination shapes. Its parameter is
 * structurally typed (`Pick<ReturnType<typeof spawnSync>, "signal" | "error">`)
 * with no runtime provenance check, so it accepts any object of that shape;
 * this file's own tests drive it with real child-process results only,
 * never a synthetic one.
 *
 * `spawnSync`'s own `timeout` option kills the child and sets BOTH
 * `result.signal` and `result.error.code === "ETIMEDOUT"` when it fires;
 * `maxBuffer` overflow kills the child the same way but sets
 * `result.error.code === "ENOBUFS"` instead; a child that receives an
 * ordinary external signal (or sends itself one) sets `result.signal` with
 * NO `result.error` at all. `result.signal !== null` alone cannot tell these
 * apart - checking `result.error?.code === "ETIMEDOUT"` specifically is what
 * distinguishes "this call's own configured timeout fired" from every other
 * way a child can end in a signal. `ETIMEDOUT` proves only that the call did
 * not complete inside its configured duration - it does not by itself prove
 * the call was genuinely stuck rather than legitimately slow, so the message
 * below states the observed fact and does not characterize the cause.
 */
function classifyTerminatedSpawnSync(
  result: Pick<ReturnType<typeof spawnSync>, "signal" | "error">,
  context: string
): void {
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${context} did not complete within its configured timeout and was killed`);
  }
  if (result.signal !== null) {
    throw new Error(
      `${context} was terminated by signal ${result.signal}${result.error ? ` (${result.error.code})` : ""} before completing - not the configured timeout`
    );
  }
}

/**
 * Best-effort cleanup for runPermanentGuardSuite()'s nested supervisor. A
 * child_process timeout's SIGTERM reaches only the immediate child, never
 * a grandchild it spawned (nodejs/node#43704, cited in
 * scripts/run-tests.mjs's idleTimeoutMs comment, documents the
 * mechanism), so a nested `node --test` supervisor whose OWN timeout
 * fires can still leave its own per-file test children (each
 * isolation:'process' spawns one) running after the supervisor itself is
 * gone.
 *
 * Spawning the supervisor with `detached: true` (POSIX only - see below)
 * makes it the leader of its own process group, so `-supervisorPid`
 * addresses that whole group rather than the single process - the same
 * `pgrep -g <pgid>` / `process.kill(-pgid, ...)` shape
 * test/helpers/hostileGroupKillProbe.ts already establishes for this
 * repo's own production kill() containment, reused here rather than
 * re-derived. Calling this unconditionally after every spawnSync call -
 * success, timeout, or any other exit - rather than only after a detected
 * timeout, keeps the call site branch-free: on a normal completion the
 * supervisor and every process it spawned have already exited on their
 * own, so this call hits ESRCH (nothing left to signal) and is a no-op;
 * on a hang, it is what actually reaps the SIGTERM-surviving grandchild
 * spawnSync's own timeout could not reach.
 *
 * SIGKILL, not SIGTERM: this call runs only as a cleanup sweep AFTER
 * spawnSync's own timeout has already attempted the graceful signal, so
 * there is no remaining reason to give a straggler a chance to shut down
 * cleanly - and SIGKILL, unlike SIGTERM, cannot be trapped or ignored, so
 * a nested child that explicitly traps and ignores SIGTERM is still
 * reached (see runPermanentGuardSuite's own doc comment below).
 *
 * Two remaining residuals, disclosed rather than hidden:
 *
 *  - Windows has no POSIX process-group semantics, and `detached` means
 *    something unrelated there (a new console) rather than group
 *    leadership, so this whole mechanism is POSIX-only; on win32 nothing
 *    is attempted here, and the pre-existing single-child-only reach
 *    (spawnSync's own timeout, signalling the supervisor alone) remains
 *    exactly as it was for every prior version of this file.
 *  - Between spawnSync reaping its direct child and this call issuing
 *    the group signal, the OS is, in principle, free to recycle that
 *    now-exited PID for an unrelated process; sending SIGKILL to `-pid`
 *    in that vanishingly narrow window would signal the WRONG group.
 *    This is the same PGID-reuse residual this repo has already
 *    disclosed elsewhere (kill.ts) rather than a new one, and it is not
 *    re-derived or re-solved here.
 *
 * @param supervisorPid - `spawnSync`'s own returned `.pid` for the nested
 *   supervisor process, valid whether or not the process is still
 *   believed to be running.
 */
function reapSupervisorProcessGroup(supervisorPid: number | undefined): void {
  if (process.platform === "win32" || typeof supervisorPid !== "number") return;
  try {
    process.kill(-supervisorPid, "SIGKILL");
  } catch {
    // ESRCH (nothing left - the common, healthy case) or EPERM; either
    // way there is nothing further this cleanup sweep can do.
  }
}

/**
 * Spawns a FRESH `node --test` process over the three permanent guard test
 * files, and parses the real, current pass/fail/tests counts off its
 * summary lines - never a hardcoded historical figure. Node's default
 * (non-TTY) test-runner summary reporter prints `ℹ tests N` / `ℹ pass N` /
 * `ℹ fail N`; the `#`-prefixed TAP form is accepted too as a defensive
 * fallback in case the reporter's exact prefix ever changes.
 *
 * This bounds the direct `node --test` supervisor process spawnSync itself
 * controls. Each of the three nested test files runs as its OWN CHILD
 * PROCESS of that supervisor (Node's default `--test-isolation=process`,
 * not a worker thread - confirmed empirically: each nested file reports a
 * distinct `process.pid` and `isMainThread: true`, never a shared parent
 * PID). Sending the timeout's default `SIGTERM` to the supervisor was
 * observed, in one manual, single-host (macOS) reproduction, to also
 * terminate an already-hung nested child with no orphan left behind - a
 * manual observation, not a tracked, repeatable check, and not confirmed
 * across every platform this guard runs on.
 *
 * A nested child that explicitly traps and ignores `SIGTERM` (none of the
 * three files here do that) is still reached: the supervisor spawns
 * detached and reapSupervisorProcessGroup() (see its own doc comment
 * above) sweeps the whole process group with SIGKILL, unconditionally,
 * after every call - SIGKILL cannot be trapped or ignored. What remains
 * open is POSIX-only reach (win32 has no process-group signalling) and
 * the PGID-reuse race reapSupervisorProcessGroup's own comment discloses.
 */
function runPermanentGuardSuite(): { tests: number; pass: number; fail: number; raw: string } {
  // NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID are set by the OUTER `node
  // --test` process running THIS file and, being ordinary environment
  // variables, are inherited by spawnSync's child by default - which makes
  // the child's own `node --test` invocation think it is a recursive
  // re-entry into an already-running test file and print "run() is being
  // called recursively within a test file. skipping running files."
  // instead of actually running anything: without this strip, the child
  // prints only that warning and zero test output. Stripping just these
  // two lets the child run as a genuinely independent process, matching
  // how CI or a bare terminal invocation would run it.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "test/guard-mutation-coverage.test.ts",
      "test/module-boundaries.test.ts",
      "test/no-tasks-import.test.ts",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
      env: childEnv,
      timeout: 45_000,
      // POSIX only (see reapSupervisorProcessGroup's own doc comment) -
      // makes this supervisor the leader of its own process group, so the
      // SIGKILL sweep below reaches every grandchild it spawned, not just
      // itself. Omitted on win32: `detached` means something unrelated
      // there (a new console), never process-group leadership.
      ...(process.platform === "win32" ? {} : { detached: true }),
    }
  );
  // Spawns detached and signals the whole group; runs unconditionally,
  // before the classify-and-maybe-throw call below, so cleanup happens
  // regardless of outcome - see reapSupervisorProcessGroup's own doc
  // comment.
  reapSupervisorProcessGroup(result.pid);
  classifyTerminatedSpawnSync(
    result,
    'the nested "node --test" run (guard-mutation-coverage/module-boundaries/no-tasks-import)'
  );
  const raw = `${result.stdout}\n${result.stderr}`;
  const testsMatch = raw.match(/[ℹ#] tests (\d+)/);
  const passMatch = raw.match(/[ℹ#] pass (\d+)/);
  const failMatch = raw.match(/[ℹ#] fail (\d+)/);
  if (!testsMatch || !passMatch || !failMatch) {
    throw new Error(`could not parse node --test summary from output:\n${raw}`);
  }
  return {
    tests: Number(testsMatch[1]),
    pass: Number(passMatch[1]),
    fail: Number(failMatch[1]),
    raw,
  };
}

/**
 * Captured once, on FIRST ACCESS rather than in a `before()` hook - the
 * pre-mutation baseline the later denominator/consistency checks compare
 * against. This used to run inside a `before()` hook, but node:test's own
 * TestsStream never emits a reportable event for a hook's own execution -
 * only for an actual test - so the entire blocking nested `node --test`
 * call ran in a window with zero test-runner events, leaving this file's
 * outer idle-watchdog with nothing to reset on until the call finished.
 * `ensureBaseline()` is instead invoked as the first statement inside this
 * file's own first test - and that test's own callback begins with an
 * explicit yield (`await new Promise((resolve) => setImmediate(resolve))`)
 * BEFORE calling this, specifically so `test:dequeue` for that test can
 * finish delivering to the parent process before the synchronous block
 * begins. `test:dequeue`, not `test:start`, is what resets the idle
 * watchdog here: node:test never emits `test:start` for a given test
 * until that test's own callback has already settled, so for this
 * particular test `test:start` necessarily arrives together with
 * `test:complete`, after the blocking call is already done - confirmed
 * directly against this file's own shape (parent-process TestsStream
 * probe: `test:dequeue` at 98ms, then the block, then `test:complete`,
 * `test:start`, and `test:pass` together at ~1116ms). The yield narrows
 * the gap between the outer watchdog's last reset and the start of the
 * blocking call to whatever `setImmediate` takes to fire - it does not
 * make the two bounds begin at the same instant, and nothing here claims
 * that it does. Memoized so every later caller (including the two tests
 * below that depend on it) gets the identical value regardless of call
 * order.
 */
let baseline: ReturnType<typeof runPermanentGuardSuite> | undefined;
function ensureBaseline(): NonNullable<typeof baseline> {
  if (baseline === undefined) baseline = runPermanentGuardSuite();
  return baseline;
}

// =============================================================================
// ACQUISITION: how the loader capability is OBTAINED (19 executions). All
// must RED. The first ten are owned by the no-tasks guard except for two
// specifier-resolution cases owned by module-boundaries; the remaining
// eight (acquisition escapes reached via aliasing, computed access, and
// property-descriptor reads) are all owned by the
// no-tasks guard, which walks the whole src/ tree.
//
// The one-hop alias and computed-member acquisition cases close the
// ONE-HOP form. A second hop of the identical kind is a separate,
// disclosed boundary - see the dedicated section below, immediately after
// this one - never folded into these 19 RED executions.
// =============================================================================

test('import { createRequire } from "node:module" - the recognised path, the control that already works - must ALSO red on the unmutated tree as the guard\'s liveness control', async () => {
  // First test in the file - see ensureBaseline()'s own doc comment above
  // for why the blocking nested run happens here rather than in a
  // before() hook. A synchronous callback that calls ensureBaseline() as
  // its first statement never yields the event loop before that call
  // blocks the whole process, so this test's own test:dequeue event may
  // not finish delivering to the parent process before the freeze - an
  // explicit yield here guarantees that delivery completes first.
  await new Promise((resolve) => setImmediate(resolve));
  ensureBaseline();
  const dir = buildScratchSrc({
    "tools/mutant.ts": 'import { createRequire } from "node:module";\n',
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("imports createRequire from node:module")),
      `expected the named-import createRequire diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('process.getBuiltinModule("node:module").createRequire(...) - a runtime-executing escape from the recognised import path - is caught by the banned-acquisition diagnostic naming the property access, not merely the specifier "node:module"', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      'const req = process.getBuiltinModule("node:module").createRequire(import.meta.url);',
      'req("./sibling.js");',
      "",
    ].join("\n"),
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("process's dangerous properties")),
      `expected the process.getBuiltinModule acquisition diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('require("module").createRequire(...) is caught at the bare require reference itself, naming require as a banned construct', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": 'const req = require("module").createRequire(import.meta.url);\n',
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("references the global require")),
      `expected the bare-require acquisition diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(await import("node:module")).createRequire(...) is caught on the awaited-import member access', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts":
      'const req = (await import("node:module")).createRequire(import.meta.url);\n',
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("dynamically imports node:module")),
      `expected the awaited dynamic-import createRequire diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('import("node:module").then(m => m.createRequire(...)) is caught despite the capability being reached in a callback, never bound at module scope - a scope-limited check would fail this row', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      'import("node:module").then((m) => {',
      "  const req = m.createRequire(import.meta.url);",
      '  req("./sibling.js");',
      "});",
      "",
    ].join("\n"),
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("dynamically imports node:module")),
      `expected the .then-chained dynamic-import createRequire diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('destructured off an intermediate - const {createRequire: cr} = process.getBuiltinModule("node:module") - is caught under its ALIAS cr, at the acquisition site regardless of the downstream destructure', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      'const { createRequire: cr } = process.getBuiltinModule("node:module");',
      "const req = cr(import.meta.url);",
      "",
    ].join("\n"),
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("process's dangerous properties")),
      `expected the process.getBuiltinModule acquisition diagnostic despite the destructured alias, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aliased through a variable - const g = process.getBuiltinModule; g("node:module").createRequire(...) - is caught despite the callee being an alias; a callee-name-only check would fail this row', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      "const g = process.getBuiltinModule;",
      'const req = g("node:module").createRequire(import.meta.url);',
      "",
    ].join("\n"),
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("process's dangerous properties")),
      `expected the process.getBuiltinModule acquisition diagnostic at the ALIASED access site, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("module.constructor.createRequire(...) is caught via the .constructor banned-property-access diagnostic", () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": "const req = module.constructor.createRequire(import.meta.url);\n",
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("reads a .constructor property")),
      `expected the .constructor property-access diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prototype-chain reach to the same constructor - Object.getPrototypeOf(module).constructor - is caught the same way; a distinct physical mutation from the direct .constructor access above", () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      "const proto = Object.getPrototypeOf(module);",
      "const req = proto.constructor.createRequire(import.meta.url);",
      "",
    ].join("\n"),
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("reads a .constructor property")),
      `expected the prototype-chain .constructor property-access diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('import.meta.resolve("../tools/sibling.js") handing the resolved URL to a process.getBuiltinModule loader is caught by the SPECIFIER check itself - not merely by the separate, already-banned process.getBuiltinModule acquisition', () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": [
      'const resolvedUrl = import.meta.resolve("../tools/sibling.js");',
      'const req = process.getBuiltinModule("node:module").createRequire(import.meta.url);',
      "req(resolvedUrl);",
      "",
    ].join("\n"),
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "../tools/sibling.js"')
      ),
      `expected the import.meta.resolve specifier itself to be flagged as a sibling reference, got: ${JSON.stringify(violations)}`
    );
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes("process's dangerous properties")
      ),
      `expected the process.getBuiltinModule acquisition to ALSO be flagged (both are real), got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bare module.require(...) in a CJS-shaped context is caught, naming module.require's own reachable-global acquisition", () => {
  const dir = buildScratchSrc({ "tools/mutant.ts": 'module.require("./sibling.js");\n' });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes("references the global module")
      ),
      `expected the module.require diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Object.getOwnPropertyDescriptor(globalThis, "eval")?.value is caught by the property-descriptor-access diagnostic', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts":
      "const e = Object.getOwnPropertyDescriptor(globalThis, 'eval')?.value;\ne?.('1');\n",
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("getOwnPropertyDescriptor")),
      `expected the descriptor-read acquisition diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Object.getOwnPropertyDescriptor(Object.getPrototypeOf(fn), "constructor")?.value is caught the same way, unconditional on the target (an arbitrary function, not globalThis/process)', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      "function fn() {}",
      "const F = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(fn), 'constructor')?.value;",
      "",
    ].join("\n"),
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("getOwnPropertyDescriptor")),
      `expected the descriptor-read acquisition diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one-hop alias acquisition - const g = globalThis; g.eval(x) / const p = process; p.getBuiltinModule(...) / const {getBuiltinModule} = process - each caught through exactly one local alias hop to the real base", () => {
  const dirA = buildScratchSrc({ "tools/mutant.ts": "const g = globalThis;\ng.eval('1');\n" });
  const dirB = buildScratchSrc({
    "tools/mutant.ts": [
      "const p = process;",
      'const req = p.getBuiltinModule("node:module").createRequire(import.meta.url);',
      "",
    ].join("\n"),
  });
  const dirC = buildScratchSrc({
    "tools/mutant.ts": [
      "const { getBuiltinModule } = process;",
      'const req = getBuiltinModule("node:module").createRequire(import.meta.url);',
      "",
    ].join("\n"),
  });
  try {
    const violationsA = checkNoTasksImport(dirA);
    assert.ok(
      violationsA.some((v) => v.specifier.includes("references the global eval")),
      `expected the globalThis one-hop-alias eval diagnostic, got: ${JSON.stringify(violationsA)}`
    );
    const violationsB = checkNoTasksImport(dirB);
    assert.ok(
      violationsB.some((v) => v.specifier.includes("process's dangerous properties")),
      `expected the process one-hop-alias getBuiltinModule diagnostic, got: ${JSON.stringify(violationsB)}`
    );
    const violationsC = checkNoTasksImport(dirC);
    assert.ok(
      violationsC.some((v) => v.specifier.includes("process's dangerous properties")),
      `expected the destructured-directly-off-process getBuiltinModule diagnostic, got: ${JSON.stringify(violationsC)}`
    );
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(dirC, { recursive: true, force: true });
  }
});

test('variable-keyed .constructor - const k="constructor"; (()=>{})[k] - is caught on a computed key foldable to the literal through one local alias hop', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": "const k = 'constructor';\nconst F = (() => {})[k];\n",
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("reads a .constructor property")),
      `expected the variable-keyed .constructor diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("destructured .constructor - const {constructor: F} = (()=>{}) - is caught unconditionally on the destructuring source", () => {
  const dir = buildScratchSrc({ "tools/mutant.ts": "const { constructor: F } = (() => {});\n" });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("reads a .constructor property")),
      `expected the destructured .constructor diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cast / non-null base - globalThis!.eval(x) / (globalThis as typeof globalThis).eval(x) - neither defeats detection after stripping the transparent syntax wrapper", () => {
  const dirA = buildScratchSrc({ "tools/mutant.ts": "globalThis!.eval('1');\n" });
  const dirB = buildScratchSrc({
    "tools/mutant.ts": "(globalThis as typeof globalThis).eval('1');\n",
  });
  try {
    const violationsA = checkNoTasksImport(dirA);
    assert.ok(
      violationsA.some((v) => v.specifier.includes("references the global eval")),
      `expected the non-null-assertion form to be caught, got: ${JSON.stringify(violationsA)}`
    );
    const violationsB = checkNoTasksImport(dirB);
    assert.ok(
      violationsB.some((v) => v.specifier.includes("references the global eval")),
      `expected the as-cast form to be caught, got: ${JSON.stringify(violationsB)}`
    );
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("process.dlopen(...) / process.binding(...) are caught, naming a dangerous process property from the extended set, not only getBuiltinModule", () => {
  const dirA = buildScratchSrc({
    "tools/mutant.ts": "process.dlopen({ exports: {} }, './native.node');\n",
  });
  const dirB = buildScratchSrc({
    "tools/mutant.ts": "const b = process.binding('fs');\nvoid b;\n",
  });
  try {
    const violationsA = checkNoTasksImport(dirA);
    assert.ok(
      violationsA.some((v) => v.specifier.includes("process's dangerous properties")),
      `expected process.dlopen to be flagged, got: ${JSON.stringify(violationsA)}`
    );
    const violationsB = checkNoTasksImport(dirB);
    assert.ok(
      violationsB.some((v) => v.specifier.includes("process's dangerous properties")),
      `expected process.binding to be flagged, got: ${JSON.stringify(violationsB)}`
    );
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('ambient declare const Reflect: {...}; Reflect.get(globalThis, "eval") is caught - an Ambient-flagged declaration is not a runtime shadow', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      "declare const Reflect: { get: (t: unknown, k: string) => unknown };",
      "const e = Reflect.get(globalThis, 'eval');",
      "e('1');",
      "",
    ].join("\n"),
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("references the global Reflect")),
      `expected the ambient-declare Reflect diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// THE INTENTIONALLY OPEN TWO-HOP FRONTIER (3 executions). This guard is a
// hop-bounded HYGIENE contract, never a security boundary: the one-hop
// alias and computed-member acquisition cases above are checked, and a
// second hop of the identical kind is outside this guard's scope. Closing
// it would only move the boundary to three hops, which this guard does
// not chase - the same bounded scope `check-stdio-purity.mjs`'s own
// `MAX_ALIAS_CHAIN_HOPS` doc comment states for a sibling guard's
// stdout/stderr-purity check.
//
// Each case is EVIDENCED, not merely asserted not-to-red: every fixture is
// confirmed BOTH guard-green at both production entry points
// (`checkNoTasksImport`/`checkModuleBoundaries`, LITERAL empty offender
// arrays - via `buildCompleteFrozenScratchSrc`, a scratch tree containing
// every file `FROZEN_MODULES` requires, so `checkModuleBoundaries`'s
// unrelated completeness check never has anything to report and there is
// no filtering to explain away) AND a real, successfully-EXECUTING use of
// the forbidden capability under Node - so this is a proven open route,
// never an artifact of a fixture that merely never ran. These cases are
// GREEN CONTROLS demonstrating the two-hop boundary - the mirror image of
// the green controls near the end of this file (which guard already-
// covered green paths against a false red). This guard's checked scope
// stops at one hop; these cases exist to keep that boundary visible.
// =============================================================================

test("TWO-HOP globalThis-base alias - const g = globalThis; const h = g; h.eval(x) - stays guard-green (both guards LITERALLY empty, no filtering) at both entry points AND genuinely executes - the disclosed one-hop hygiene boundary", async () => {
  const src = "const g = globalThis;\nconst h = g;\nexport const result = h.eval('40 + 2');\n";
  const dir = buildCompleteFrozenScratchSrc("tools/run.ts", src);
  try {
    assert.deepEqual(
      checkNoTasksImport(dir),
      [],
      "expected the two-hop globalThis-base alias to stay guard-green (checkNoTasksImport) - a real hit here would mean this disclosed boundary has moved"
    );
    assert.deepEqual(
      checkModuleBoundaries(dir),
      [],
      "expected the two-hop globalThis-base alias to stay LITERALLY guard-green, unfiltered (checkModuleBoundaries) - the scratch tree here is complete against FROZEN_MODULES, so a real hit is never masked by an unrelated frozen-module-completeness finding"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const execDir = mkdtempSync(path.join(tmpdir(), "ghantika-loader-escape-exec-"));
  const execFile = path.join(execDir, "probe.mjs");
  writeFileSync(execFile, src);
  try {
    const mod = await import(pathToFileURL(execFile).href);
    assert.equal(
      mod.result,
      42,
      "expected the two-hop globalThis.eval alias to genuinely evaluate '40 + 2' under Node - proving this is a working escape, not a fixture that merely never ran"
    );
  } finally {
    rmSync(execDir, { recursive: true, force: true });
  }
});

test("TWO-HOP process-base alias - const p = process; const q = p; q.getBuiltinModule(...).createRequire(...) - stays guard-green (both guards LITERALLY empty, no filtering) at both entry points AND genuinely loads a real builtin module", async () => {
  const src =
    "const p = process;\n" +
    "const q = p;\n" +
    'const req = q.getBuiltinModule("node:module").createRequire(import.meta.url);\n' +
    'export const fs = req("node:fs");\n';
  const dir = buildCompleteFrozenScratchSrc("tools/run.ts", src);
  try {
    assert.deepEqual(
      checkNoTasksImport(dir),
      [],
      "expected the two-hop process-base alias to stay guard-green (checkNoTasksImport) - a real hit here would mean this disclosed boundary has moved"
    );
    assert.deepEqual(
      checkModuleBoundaries(dir),
      [],
      "expected the two-hop process-base alias to stay LITERALLY guard-green, unfiltered (checkModuleBoundaries) - the scratch tree here is complete against FROZEN_MODULES, so a real hit is never masked by an unrelated frozen-module-completeness finding"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const execDir = mkdtempSync(path.join(tmpdir(), "ghantika-loader-escape-exec-"));
  const execFile = path.join(execDir, "probe.mjs");
  writeFileSync(execFile, src);
  try {
    const mod = await import(pathToFileURL(execFile).href);
    assert.equal(
      typeof mod.fs.readFileSync,
      "function",
      "expected the two-hop process.getBuiltinModule alias to genuinely load node:fs via createRequire under Node - proving this is a working escape, not a fixture that merely never ran"
    );
  } finally {
    rmSync(execDir, { recursive: true, force: true });
  }
});

test('TWO-HOP variable-keyed computed .constructor - const k1 = "constructor"; const k2 = k1; (()=>{})[k2] - stays guard-green (both guards LITERALLY empty, no filtering) at both entry points AND genuinely constructs and runs a real function', async () => {
  const src =
    'const k1 = "constructor";\n' +
    "const k2 = k1;\n" +
    "const F = (() => {})[k2];\n" +
    'export const result = new F("return 40 + 2")();\n';
  const dir = buildCompleteFrozenScratchSrc("tools/run.ts", src);
  try {
    assert.deepEqual(
      checkNoTasksImport(dir),
      [],
      "expected the two-hop variable-keyed .constructor access to stay guard-green (checkNoTasksImport) - a real hit here would mean this disclosed boundary has moved"
    );
    assert.deepEqual(
      checkModuleBoundaries(dir),
      [],
      "expected the two-hop variable-keyed .constructor access to stay LITERALLY guard-green, unfiltered (checkModuleBoundaries) - the scratch tree here is complete against FROZEN_MODULES, so a real hit is never masked by an unrelated frozen-module-completeness finding"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const execDir = mkdtempSync(path.join(tmpdir(), "ghantika-loader-escape-exec-"));
  const execFile = path.join(execDir, "probe.mjs");
  writeFileSync(execFile, src);
  try {
    const mod = await import(pathToFileURL(execFile).href);
    assert.equal(
      mod.result,
      42,
      "expected the two-hop variable-keyed .constructor access to genuinely construct and run a real function under Node - proving this is a working escape, not a fixture that merely never ran"
    );
  } finally {
    rmSync(execDir, { recursive: true, force: true });
  }
});

// =============================================================================
// THE SPECIFIER, once a capability exists (12 executions). Each fixture
// uses a PERMITTED loader form (an ordinary static import, or - for a
// shape a static import cannot syntactically carry - a permitted dynamic
// import()) so the module-boundary specifier diagnostic is the ONLY thing
// that can produce the red, never an acquisition diagnostic from a banned
// loader, which would mask the specifier check behind an unrelated
// acquisition red - a self-masking failure mode worth guarding against
// explicitly.
// =============================================================================

test("an ordinary string literal relative specifier naming a sibling is caught, naming the resolved sibling path", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": 'import { x } from "./sibling.js";\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "./sibling.js"')
      ),
      `expected the ordinary-literal sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a no-substitution TEMPLATE LITERAL specifier, via a permitted dynamic import(), is read as a literal and caught the same as a plain string", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": "import(`./sibling.js`);\n",
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "./sibling.js"')
      ),
      `expected the template-literal sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an INTERPOLATED template specifier, via a permitted dynamic import(), fails CLOSED - a SKIP is a FAIL", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": 'const seg = "sibling";\nimport(`./${seg}.js`);\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes("computed/non-literal specifier")
      ),
      `expected the interpolated-template specifier to fail closed, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a string-CONCATENATION specifier, via a permitted dynamic import(), fails CLOSED", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": 'import("./" + "sibling.js");\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes("computed/non-literal specifier")
      ),
      `expected the concatenated specifier to fail closed, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a COMPUTED / VARIABLE specifier, via a permitted dynamic import(), fails CLOSED", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": "const specifier = getSiblingPath();\nimport(specifier);\n",
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes("computed/non-literal specifier")
      ),
      `expected the computed specifier to fail closed, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a relative specifier crossing up-and-back (../tools/sibling.js) resolves via the real resolver, canonical compare, sibling named", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": 'import { x } from "../tools/sibling.js";\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "../tools/sibling.js"')
      ),
      `expected the up-and-back relative sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an ABSOLUTE PATH specifier pointing at a real sibling file is caught - the fast path skips non-dot specifiers entirely, only the real resolver sees this; a prefix/suffix test passes this and must not", () => {
  const dir = buildScratchSrc({ "tools/sibling.ts": "export const marker = 1;\n" });
  try {
    const toolsDir = path.join(dir, "tools");
    const absSpecifier = path.join(toolsDir, "sibling.js");
    writeFileSync(path.join(toolsDir, "mutant.ts"), `import { x } from "${absSpecifier}";\n`);
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes(`imports sibling "${absSpecifier}"`)
      ),
      `expected the absolute-path sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an EXTENSIONLESS relative specifier resolving to a real sibling .ts file is caught, via real-resolver resolution", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": 'import { x } from "../tools/sibling";\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "../tools/sibling"')
      ),
      `expected the extensionless sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a DIRECTORY-INDEX specifier (trailing slash, resolving to the real index.ts) is caught; a distinct physical mutation from the extensionless case above", () => {
  const dir = buildScratchSrc({
    "tools/index.ts": "export const marker = 2;\n",
    "tools/mutant.ts": 'import { x } from "../tools/";\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "../tools/"')
      ),
      `expected the directory-index sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file:// URL specifier pointing at a real sibling file is caught - URL normalised through the real resolver before compare", () => {
  const dir = buildScratchSrc({ "tools/sibling.ts": "export const marker = 1;\n" });
  try {
    const toolsDir = path.join(dir, "tools");
    const fileUrl = pathToFileURL(path.join(toolsDir, "sibling.js")).href;
    writeFileSync(path.join(toolsDir, "mutant.ts"), `import { x } from "${fileUrl}";\n`);
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes(`imports sibling "${fileUrl}"`)
      ),
      `expected the file:// URL sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a SYMLINK resolving to the same real sibling file is caught via realpath compare - a string compare passes this and must not", () => {
  const dir = buildScratchSrc({ "tools/sibling.ts": "export const marker = 1;\n" });
  try {
    const toolsDir = path.join(dir, "tools");
    const libDir = path.join(dir, "lib");
    mkdirSync(libDir, { recursive: true });
    symlinkSync(path.join(toolsDir, "sibling.ts"), path.join(libDir, "sibling-alias.ts"));
    writeFileSync(
      path.join(toolsDir, "mutant.ts"),
      'import { x } from "../lib/sibling-alias.js";\n'
    );
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) =>
          v.includes("tools/mutant.ts") && v.includes('imports sibling "../lib/sibling-alias.js"')
      ),
      `expected the symlink-indirection sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a PACKAGE/SUBPATH-IMPORT ALIAS (package.json\'s own "imports" field) resolving to a real sibling file is caught via resolver-based compare; a distinct physical mutation from the symlink case above', () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "package.json": JSON.stringify({
      name: "fixture",
      imports: { "#sibling": "./tools/sibling.ts" },
    }),
    "tools/mutant.ts": 'import { x } from "#sibling";\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "#sibling"')
      ),
      `expected the package-alias sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// STATIC-ANALYSIS EVASION (5 executions).
// =============================================================================

test('a side-effect-only static import - import "../tools/sibling.js" - is caught on the specifier alone, since a bare side-effect import has no binding to inspect', () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": 'import "../tools/sibling.js";\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "../tools/sibling.js"')
      ),
      `expected the side-effect-import sibling violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a re-export BARREL that pulls the sibling transitively is caught, naming both the barrel and the transitively-reached sibling", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "barrel.ts": 'export * from "./tools/sibling.js";\n',
    "tools/mutant.ts": 'export * from "../barrel.js";\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) =>
          v.includes("tools/mutant.ts") &&
          v.includes("../barrel.js") &&
          v.includes("transitively") &&
          v.includes("sibling.ts")
      ),
      `expected a transitive-barrel violation naming both the barrel and the sibling, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a specifier ASSEMBLED so it is not statically resolvable (an array .join call) fails CLOSED, never skipped", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": 'const parts = ["./", "sibling.js"];\nimport(parts.join(""));\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes("computed/non-literal specifier")
      ),
      `expected the assembled specifier to fail closed, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eval(\"require('./sibling.js')\") is caught as a banned construct naming eval - a prohibition of the construct, never a claim that its string argument was analysed", () => {
  const dir = buildScratchSrc({ "tools/mutant.ts": "eval(\"require('./sibling.js')\");\n" });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("references the global eval")),
      `expected the banned-construct diagnostic naming the global eval reference, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('new Function("return require")() is caught as a banned construct naming Function - the same prohibition-not-analysis boundary as the eval(...) case above', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": 'const makeFn = new Function("return require");\nmakeFn();\n',
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("references the global Function constructor")),
      `expected the Function-constructor banned-construct diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// THE GUARD GUARDS ITSELF (4 executions: one asserts only that a
// standalone external integrity guard is absent from the frozen module
// list and performs no mutation; the other three are each executed via
// a mutated SCRATCH COPY of the guard source - the TRACKED files under
// scripts/ are never written to.
// =============================================================================

test("no standalone integrity guard exists in the frozen module list, so this test asserts only that dependency's absence and performs no guard mutation", () => {
  // No standalone integrity guard exists in FROZEN_MODULES, so this test
  // asserts only that dependency's absence and cannot perform the
  // described guard mutation. No mutation is invented here to force an
  // artificial result on a guard that does not exist, because doing so
  // would fabricate evidence about absent code.
  assert.ok(
    !FROZEN_MODULES.some((m) => /integrity/i.test(m)),
    "no external integrity guard appears in the frozen module list, so this case cannot perform its described mutation"
  );
});

test("replace canonical resolution (remove the real resolver, reverting to layer-1-only string/path arithmetic) - the specifier-resolution cases' owning assertions go RED under the mutant, proving those assertions are non-vacuous: removing the resolver they depend on makes them fail", async () => {
  // This case exercises the real resolver that the absolute-path,
  // file-URL, and package-alias specifier cases above depend on:
  // resolveModuleSpecifierRealPath (scripts/lib/ts-ast.mjs) plus a
  // canonical isRealPathInsideDir containment compare (path.relative-
  // based, in scripts/check-module-boundaries.mjs).
  //
  // Replacing only isRealPathInsideDir's path.relative-based compare with
  // a naive startsWith prefix test on the ALREADY-RESOLVED real path does
  // not distinguish these fixtures, because a genuinely-resolved absolute
  // real path is a valid string prefix of its real containing directory
  // too, absent an adversarial "shares-a-string-prefix-but-isn't-really-
  // inside" sibling like tools-backup/ - which these fixtures don't
  // construct, since that tests OVER-blocking prevention, a different
  // property than this case asks about.
  //
  // The mutation this case actually applies - "replace CANONICAL
  // RESOLUTION" - is the whole real-resolver step, not merely its
  // downstream compare: resolveModuleSpecifierRealPath (scripts/lib/
  // ts-ast.mjs) forced to return undefined, reverting to exactly the
  // "string/path arithmetic" (layer-1 dot-specifier fast path) behavior
  // the code falls back to without a real resolver. This mutation
  // produces the expected cascade across the absolute-path/directory-
  // index/file-URL/symlink/package-alias/transitive-barrel cases above.
  const { mod, scratchDir } = await loadMutatedGuardCopy("check-module-boundaries.mjs", (text) =>
    mutateExactlyOnce(
      text,
      '  resolveModuleSpecifierRealPath,\n  ts,\n} from "./lib/ts-ast.mjs";',
      '  ts,\n} from "./lib/ts-ast.mjs";\n' +
        "/* GUARD-SELF MUTANT: canonical resolution replaced - the real resolver is gone, falling back to string/path arithmetic (layer 1) alone */\n" +
        "function resolveModuleSpecifierRealPath() {\n  return undefined;\n}"
    )
  );
  const absolutePathDir = buildScratchSrc({ "tools/sibling.ts": "export const marker = 1;\n" });
  const symlinkDir = buildScratchSrc({ "tools/sibling.ts": "export const marker = 1;\n" });
  const packageAliasDir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "package.json": JSON.stringify({
      name: "fixture",
      imports: { "#sibling": "./tools/sibling.ts" },
    }),
  });
  try {
    const mutatedCheckModuleBoundaries = mod.checkModuleBoundaries as (dir?: string) => string[];

    const absolutePathToolsDir = path.join(absolutePathDir, "tools");
    const absolutePathSpecifier = path.join(absolutePathToolsDir, "sibling.js");
    writeFileSync(
      path.join(absolutePathToolsDir, "mutant.ts"),
      `import { x } from "${absolutePathSpecifier}";\n`
    );
    const absolutePathMutatedViolations = mutatedCheckModuleBoundaries(absolutePathDir);
    assert.equal(
      absolutePathMutatedViolations.filter(
        (v) => v.includes("tools/mutant.ts") && v.includes("imports sibling")
      ).length,
      0,
      `expected the absolute-path case's assertion to go RED (zero violations) under the resolver-removal mutant, got: ${JSON.stringify(absolutePathMutatedViolations)}`
    );

    const symlinkToolsDir = path.join(symlinkDir, "tools");
    const symlinkLibDir = path.join(symlinkDir, "lib");
    mkdirSync(symlinkLibDir, { recursive: true });
    symlinkSync(
      path.join(symlinkToolsDir, "sibling.ts"),
      path.join(symlinkLibDir, "sibling-alias.ts")
    );
    writeFileSync(
      path.join(symlinkToolsDir, "mutant.ts"),
      'import { x } from "../lib/sibling-alias.js";\n'
    );
    const symlinkMutatedViolations = mutatedCheckModuleBoundaries(symlinkDir);
    assert.equal(
      symlinkMutatedViolations.filter(
        (v) => v.includes("tools/mutant.ts") && v.includes("imports sibling")
      ).length,
      0,
      `expected the symlink case's assertion to go RED (zero violations) under the resolver-removal mutant, got: ${JSON.stringify(symlinkMutatedViolations)}`
    );

    writeFileSync(
      path.join(packageAliasDir, "tools", "mutant.ts"),
      'import { x } from "#sibling";\n'
    );
    const packageAliasMutatedViolations = mutatedCheckModuleBoundaries(packageAliasDir);
    assert.equal(
      packageAliasMutatedViolations.filter(
        (v) => v.includes("tools/mutant.ts") && v.includes("imports sibling")
      ).length,
      0,
      `expected the package-alias case's assertion to go RED (zero violations) under the resolver-removal mutant, got: ${JSON.stringify(packageAliasMutatedViolations)}`
    );

    // Contrast: the REAL, unmutated guard (imported at the top of this
    // file) DOES catch all three on the identical fixtures - proving the
    // mutation genuinely matters and the fixtures are valid.
    const absolutePathRealViolations = checkModuleBoundaries(absolutePathDir);
    assert.ok(
      absolutePathRealViolations.some(
        (v) =>
          v.includes("tools/mutant.ts") && v.includes(`imports sibling "${absolutePathSpecifier}"`)
      ),
      `expected the REAL guard to still catch the absolute-path fixture, got: ${JSON.stringify(absolutePathRealViolations)}`
    );
    const symlinkRealViolations = checkModuleBoundaries(symlinkDir);
    assert.ok(
      symlinkRealViolations.some(
        (v) =>
          v.includes("tools/mutant.ts") && v.includes('imports sibling "../lib/sibling-alias.js"')
      ),
      `expected the REAL guard to still catch the symlink fixture, got: ${JSON.stringify(symlinkRealViolations)}`
    );
    const packageAliasRealViolations = checkModuleBoundaries(packageAliasDir);
    assert.ok(
      packageAliasRealViolations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "#sibling"')
      ),
      `expected the REAL guard to still catch the package-alias fixture, got: ${JSON.stringify(packageAliasRealViolations)}`
    );
  } finally {
    rmSync(absolutePathDir, { recursive: true, force: true });
    rmSync(symlinkDir, { recursive: true, force: true });
    rmSync(packageAliasDir, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("make the fail-closed branch fail OPEN (in a scratch COPY of check-module-boundaries.mjs, never the tracked file) - the non-literal-specifier cases' owning assertions go RED under the mutant, proving those assertions are non-vacuous", async () => {
  const { mod, scratchDir } = await loadMutatedGuardCopy("check-module-boundaries.mjs", (text) =>
    mutateExactlyOnce(
      text,
      "      if (isDynamicImportCall(node) || isRequireCall(node)) {\n" +
        "        hits.push(UNRESOLVABLE_SIBLING_SPECIFIER_LABEL);\n" +
        "      }\n",
      "      if (isDynamicImportCall(node) || isRequireCall(node)) {\n" +
        "        /* GUARD-SELF MUTANT: fail-closed push removed - now fails OPEN */\n" +
        "      }\n"
    )
  );
  const fixtureDir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/interpolated-template.ts": 'const seg = "sibling";\nimport(`./${seg}.js`);\n',
    "tools/string-concat.ts": 'import("./" + "sibling.js");\n',
    "tools/computed-variable.ts": "const specifier = getSiblingPath();\nimport(specifier);\n",
    "tools/assembled-join.ts": 'const parts = ["./", "sibling.js"];\nimport(parts.join(""));\n',
  });
  try {
    const mutatedCheckModuleBoundaries = mod.checkModuleBoundaries as (dir?: string) => string[];
    const mutatedViolations = mutatedCheckModuleBoundaries(fixtureDir);
    assert.equal(
      mutatedViolations.filter((v) => v.includes("computed/non-literal specifier")).length,
      0,
      `expected the MUTATED (fail-open) guard to report ZERO computed/non-literal violations - proving the non-literal-specifier cases' owning assertion would go RED under this mutant, got: ${JSON.stringify(mutatedViolations)}`
    );

    // Contrast: the REAL, unmutated guard (imported at the top of this
    // file) DOES catch all four on the identical fixture tree - proving
    // the mutation genuinely matters and the fixture is valid, not merely
    // that the mutated import failed silently.
    const realViolations = checkModuleBoundaries(fixtureDir);
    for (const file of [
      "interpolated-template.ts",
      "string-concat.ts",
      "computed-variable.ts",
      "assembled-join.ts",
    ]) {
      assert.ok(
        realViolations.some(
          (v) => v.includes(`tools/${file}`) && v.includes("computed/non-literal specifier")
        ),
        `expected the REAL guard to catch tools/${file} on the identical fixture, got: ${JSON.stringify(realViolations)}`
      );
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("narrow the guard's file glob so src/tools/ is no longer scanned (in a scratch COPY of check-no-tasks-import.mjs, never the tracked file) - every acquisition case above loses its red simultaneously; the named-import liveness control goes RED under the mutant", async () => {
  const { mod, scratchDir } = await loadMutatedGuardCopy("check-no-tasks-import.mjs", (text) =>
    mutateExactlyOnce(
      text,
      "    if (dirent.isDirectory()) {\n      out.push(...listTsFilesUnder(full));\n",
      '    if (dirent.isDirectory()) {\n      if (dirent.name === "tools") continue; /* GUARD-SELF MUTANT: narrows the glob so src/tools/ is never scanned */\n      out.push(...listTsFilesUnder(full));\n'
    )
  );
  const fixtureDir = buildScratchSrc({
    "tools/named-import-create-require.ts": 'import { createRequire } from "node:module";\n',
  });
  try {
    const mutatedCheckNoTasksImport = mod.checkNoTasksImport as (
      dir?: string
    ) => { file: string; specifier: string }[];
    const mutatedViolations = mutatedCheckNoTasksImport(fixtureDir);
    assert.equal(
      mutatedViolations.length,
      0,
      `expected the MUTATED (tools/-excluded) guard to report ZERO violations for the named-import fixture - proving that case's owning assertion would go RED under this glob-narrowing mutant, got: ${JSON.stringify(mutatedViolations)}`
    );

    // Contrast: the REAL, unmutated guard DOES catch it on the identical
    // fixture tree.
    const realViolations = checkNoTasksImport(fixtureDir);
    assert.ok(
      realViolations.some((v) => v.specifier.includes("imports createRequire from node:module")),
      `expected the REAL guard to catch the named-import fixture on the identical tree, got: ${JSON.stringify(realViolations)}`
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

// =============================================================================
// GREEN CONTROLS (5 executions). A guard that reds on everything is as
// useless as one that reds on nothing.
// =============================================================================

test("a permitted import of a non-sibling module is never flagged as a sibling-import violation - both guards exit clean with an empty offender list, not merely a zero exit", () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": 'import { readFile } from "node:fs/promises";\n',
  });
  try {
    const moduleBoundaryViolations = checkModuleBoundaries(dir).filter((v) =>
      v.includes("imports sibling")
    );
    assert.deepEqual(
      moduleBoundaryViolations,
      [],
      `expected zero sibling-import violations, got: ${JSON.stringify(moduleBoundaryViolations)}`
    );
    const tasksViolations = checkNoTasksImport(dir);
    assert.deepEqual(
      tasksViolations,
      [],
      `expected an empty offender list, got: ${JSON.stringify(tasksViolations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the string "createRequire" inside a comment or a string literal is never flagged - it is not a call', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      "// this comment mentions createRequire but never calls it",
      'const label = "createRequire";',
      "",
    ].join("\n"),
  });
  try {
    const tasksViolations = checkNoTasksImport(dir);
    assert.deepEqual(
      tasksViolations,
      [],
      `expected an empty offender list, got: ${JSON.stringify(tasksViolations)}`
    );
    const moduleBoundaryViolations = checkModuleBoundaries(dir).filter((v) =>
      v.includes("imports sibling")
    );
    assert.deepEqual(moduleBoundaryViolations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exactly one fixture - import { readFile } from "node:fs/promises" - is never flagged against the real allow-list; pinned to ONE named import so no open-ended set is silently satisfied', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": 'import { readFile } from "node:fs/promises";\n',
  });
  try {
    const tasksViolations = checkNoTasksImport(dir);
    assert.deepEqual(
      tasksViolations,
      [],
      `expected an empty offender list, got: ${JSON.stringify(tasksViolations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the existing permanent guard-test suite is unchanged - same denominator - after every scratch mutation case in this file has run and been restored", () => {
  ensureBaseline();
  const after = runPermanentGuardSuite();
  assert.equal(
    after.fail,
    0,
    `expected zero failures in the permanent suite after all scratch mutations, got:\n${after.raw}`
  );
  assert.equal(
    after.pass,
    baseline!.pass,
    `expected the SAME pass count as the pre-mutation baseline (${baseline!.pass}) - a mismatch would mean a scratch mutation leaked into or altered production source; got ${after.pass}`
  );
});

test("the three permanent guard test files pass at a literal, self-consistent, runtime-derived baseline - both production guard commands also exit 0", () => {
  ensureBaseline();
  assert.equal(
    baseline!.fail,
    0,
    `expected zero failures in the real baseline run, got:\n${baseline!.raw}`
  );
  assert.equal(
    baseline!.tests,
    baseline!.pass,
    "self-consistency: with fail=0 (and no skipped/cancelled tests), the tests count must equal the pass count"
  );
  const mb = spawnSync(process.execPath, ["scripts/check-module-boundaries.mjs"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const nt = spawnSync(process.execPath, ["scripts/check-no-tasks-import.mjs"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(
    mb.status,
    0,
    `expected "npm run guard:module-boundaries" to exit 0, got ${mb.status}, stderr=${mb.stderr}`
  );
  assert.equal(
    nt.status,
    0,
    `expected "npm run guard:no-tasks-import" to exit 0, got ${nt.status}, stderr=${nt.stderr}`
  );
});

// =============================================================================
// CLASSIFIER SELF-TESTS (5 executions). NOT part of the 45 physical
// mutation-test cases above, and not module-loader escape-route cases at
// all: these test this file's OWN spawnSync-termination-classification and
// orphan-cleanup helpers (`classifyTerminatedSpawnSync`,
// `reapSupervisorProcessGroup`), used by `runPermanentGuardSuite`'s
// nested-process timeout handling. Of the first four, three deliberately
// throw and are asserted for their thrown message, not green pass/fail
// behavior; the fourth is the green control proving the other three are a
// real discriminating signal rather than a function that always throws.
// The fifth proves `reapSupervisorProcessGroup` genuinely reaches a
// grandchild a direct signal to its parent cannot. Each is driven with a
// real, short-lived child process and a real classifier/cleanup call
// against real process state - never a synthetic result object.
// =============================================================================

test("classifyTerminatedSpawnSync throws the timeout-specific message when spawnSync's OWN timeout genuinely fires - driven with a real hung child and a short injected timeout, never a synthetic result object", () => {
  const result = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    timeout: 200,
    encoding: "utf8",
  });
  assert.equal(
    result.error?.code,
    "ETIMEDOUT",
    "setup check: spawnSync's own timeout must have actually fired for this test to mean anything"
  );
  assert.throws(
    () => classifyTerminatedSpawnSync(result, "the test child"),
    /did not complete within its configured timeout/,
    "a genuine ETIMEDOUT result must throw the timeout-specific message"
  );
});

test("classifyTerminatedSpawnSync throws a DISTINCT, non-timeout message when the child is terminated by an ordinary signal with no timeout involved - proving result.signal!==null alone is not what this function keys on, AND that the reported signal name is genuinely interpolated from result.signal rather than a hardcoded string (a different signal than every other fixture in this file uses)", () => {
  const result = spawnSync(process.execPath, ["-e", "process.kill(process.pid, 'SIGINT')"], {
    timeout: 60_000,
    encoding: "utf8",
  });
  assert.equal(
    result.signal,
    "SIGINT",
    "setup check: the child must have genuinely died by signal"
  );
  assert.equal(
    result.error,
    undefined,
    "setup check: this signal must NOT have come from spawnSync's own timeout/maxBuffer mechanism"
  );
  assert.throws(
    () => classifyTerminatedSpawnSync(result, "the test child"),
    (err: unknown) =>
      err instanceof Error &&
      /terminated by signal SIGINT/.test(err.message) &&
      !/terminated by signal SIGTERM/.test(err.message) &&
      !/configured timeout and was killed/.test(err.message),
    "a non-timeout signal must throw a message naming the REAL signal (SIGINT here), never the timeout-specific wording and never a different, hardcoded signal name"
  );
});

test("classifyTerminatedSpawnSync does not throw for a clean, signal-free exit - the green control proving the two tests above are a real discriminating signal, not a function that always throws", () => {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    timeout: 60_000,
    encoding: "utf8",
  });
  assert.equal(result.signal, null);
  assert.doesNotThrow(() => classifyTerminatedSpawnSync(result, "the test child"));
});

test("classifyTerminatedSpawnSync classifies a maxBuffer overflow (ENOBUFS) the same non-timeout way as an ordinary signal, never as the configured timeout - the exact misclassification the bare result.signal!==null check produced", () => {
  const result = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(1024 * 1024))"],
    { timeout: 60_000, maxBuffer: 16, encoding: "utf8" }
  );
  assert.equal(
    result.error?.code,
    "ENOBUFS",
    "setup check: maxBuffer must have genuinely overflowed"
  );
  assert.throws(
    () => classifyTerminatedSpawnSync(result, "the test child"),
    (err: unknown) =>
      err instanceof Error &&
      /terminated by signal/.test(err.message) &&
      /ENOBUFS/.test(err.message) &&
      !/configured timeout and was killed/.test(err.message),
    "a maxBuffer overflow must be classified as a non-timeout termination, distinctly naming ENOBUFS, never conflated with the ETIMEDOUT case"
  );
});

test(
  "reapSupervisorProcessGroup reaps a grandchild that survives a signal sent only to its immediate parent - the exact orphan shape nodejs/node#43704 documents (cited in scripts/run-tests.mjs's idleTimeoutMs comment)",
  {
    skip:
      process.platform === "win32"
        ? "POSIX process-group signalling only - see reapSupervisorProcessGroup's own doc comment"
        : false,
  },
  async () => {
    const supervisor = spawn(
      process.execPath,
      [
        "-e",
        "const { spawn } = require('node:child_process');" +
          "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);" +
          "process.stdout.write(JSON.stringify({ grandchildPid: g.pid }) + '\\n');" +
          "setTimeout(() => {}, 60000);",
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] }
    );
    const supervisorPid = supervisor.pid;
    try {
      assert.ok(typeof supervisorPid === "number", "setup check: supervisor must have a real pid");
      supervisor.on("error", (err) => {
        throw new Error(`setup check: supervisor failed to spawn: ${err.message}`);
      });

      let stdoutBuffer = "";
      const grandchildPid = await new Promise<number>((resolve, reject) => {
        const timeoutHandle = setTimeout(
          () => reject(new Error("setup check: supervisor never reported its grandchild's pid")),
          5000
        );
        const onData = (chunk: Buffer) => {
          stdoutBuffer += chunk.toString("utf8");
          const newlineIndex = stdoutBuffer.indexOf("\n");
          if (newlineIndex === -1) return;
          supervisor.stdout?.off("data", onData);
          clearTimeout(timeoutHandle);
          try {
            const parsed = JSON.parse(stdoutBuffer.slice(0, newlineIndex)) as {
              grandchildPid: number;
            };
            resolve(parsed.grandchildPid);
          } catch (err) {
            reject(err);
          }
        };
        supervisor.stdout?.on("data", onData);
      });

      // BASELINE: signal only the supervisor's own pid - exactly what
      // spawnSync's `timeout` option does internally (`child.kill(killSignal)`,
      // never the group) - and confirm the grandchild survives, reproducing
      // the orphan nodejs/node#43704 documents.
      process.kill(supervisorPid, "SIGTERM");
      await waitForPgrepGroupMembers(
        supervisorPid,
        (members) => !members.includes(supervisorPid),
        3000
      );
      const survivorsAfterDirectKill = pgrepGroupMembers(supervisorPid);
      assert.ok(
        survivorsAfterDirectKill.includes(grandchildPid),
        `setup check: the grandchild (pid ${grandchildPid}) must survive a signal sent only to the supervisor - if it does not, this environment does not reproduce the orphan this test exists to close, and the assertion below would prove nothing. Survivors observed: ${JSON.stringify(survivorsAfterDirectKill)}`
      );

      // Reap: spawns detached and signals the whole group.
      reapSupervisorProcessGroup(supervisorPid);
      const survivorsAfterReap = await waitForPgrepGroupMembers(
        supervisorPid,
        (members) => members.length === 0,
        3000
      );
      assert.deepEqual(
        survivorsAfterReap,
        [],
        `reapSupervisorProcessGroup must reap every remaining member of the group, including the grandchild a direct signal to the supervisor alone could not reach; still alive: ${JSON.stringify(survivorsAfterReap)}`
      );
    } finally {
      // Guaranteed cleanup, on every path: reapSupervisorProcessGroup is
      // idempotent (it catches ESRCH/EPERM internally and never throws), so
      // a thrown setup check or assertion above - before the try body's own
      // reap ever ran - can never leave the supervisor or its grandchild
      // running. Deliberately never throws or asserts here: a throw inside
      // `finally` would replace whatever real assertion failure sent
      // execution here in the first place, masking it.
      if (typeof supervisorPid === "number") {
        reapSupervisorProcessGroup(supervisorPid);
        const stillAlive = await waitForPgrepGroupMembers(
          supervisorPid,
          (members) => members.length === 0,
          3000
        );
        if (stillAlive.length > 0) {
          console.error(
            `reapSupervisorProcessGroup test cleanup: pgid ${supervisorPid} still has member(s) after the guaranteed finally-block reap: ${JSON.stringify(stillAlive)}`
          );
        }
      }
    }
  }
);

// =============================================================================
// FINAL RESTORATION CHECK - not one of the 45 physical executions above,
// an additional closing proof: the REAL src/ tree
// (no argument -> the guards' own default SRC_DIR) is still completely
// clean on all three guards after every scratch mutation case in this file
// has run and been torn down.
// =============================================================================

test("final restoration check: the REAL (non-scratch) src/ tree is still completely clean on all three guards - no scratch mutation from any case above ever leaked into, or was satisfied by, production source", () => {
  assert.deepEqual(
    checkModuleBoundaries(),
    [],
    "the real src/ tree must report zero module-boundary violations"
  );
  assert.deepEqual(
    checkNoTasksImport(),
    [],
    "the real src/ tree must report zero Tasks-import violations"
  );
  assert.deepEqual(
    checkStdioPurity(),
    [],
    "the real src/ tree must report zero stdio-purity violations"
  );
  // The two TRACKED guard files the guard-self cases above read (but only
  // ever copied, never wrote to) must also still be byte-identical to the
  // content captured at module load, before any case ran - a real content
  // comparison, not merely a presence check, so a case that wrote to the
  // tracked file instead of its own scratch copy would be caught here.
  assert.equal(
    readFileSync(path.join(REPO_ROOT, "scripts", "check-module-boundaries.mjs"), "utf8"),
    ORIGINAL_MODULE_BOUNDARIES_GUARD_TEXT,
    "the tracked check-module-boundaries.mjs must be byte-identical to what it was before any guard-self case ran"
  );
  assert.equal(
    readFileSync(path.join(REPO_ROOT, "scripts", "check-no-tasks-import.mjs"), "utf8"),
    ORIGINAL_NO_TASKS_GUARD_TEXT,
    "the tracked check-no-tasks-import.mjs must be byte-identical to what it was before any guard-self case ran"
  );
});
