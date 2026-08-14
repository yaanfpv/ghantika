#!/usr/bin/env node
/**
 * One spelling of the test run, on every platform. This replaces the three
 * different `node --test '<glob>'` invocations (package.json's `test`,
 * package.json's `coverage`, and CI's own `test` job step) with a single
 * program that discovers files itself instead of handing a glob string to a
 * shell.
 *
 * Why a glob string is the wrong tool: `'test/**\/*.test.ts'` is quoted for
 * a POSIX shell. On Windows, `npm run test` invokes the script through
 * `cmd.exe`, which does not expand globs and does not strip the single
 * quotes - it hands `node --test` the literal six-character string
 * `'test/**\/*.test.ts'` (quotes included), which matches nothing. That
 * invocation exits 0 having run zero tests, silently. Walking `test/` with
 * `node:fs` and matching filenames against a regex never touches a shell,
 * so this bug class cannot recur here on any platform.
 *
 * Why `run()` from node:test instead of spawning `node --test` as a child:
 * `run()` returns a stream that emits a named event (`test:start`,
 * `test:pass`, `test:fail`, `test:complete`, ...) for everything the test
 * runner does, tagged with the file it came from. A spawned `node --test`
 * subprocess gives none of that until it exits (or never does) - you only
 * get its stdout/stderr and, eventually, an exit code. The per-file event
 * visibility `run()` gives is what makes the post-completion detection
 * below possible at all: without it there is no way to tell "no more
 * output is coming because everything genuinely finished" apart from "no
 * more output is coming because something over there is stuck", short of
 * guessing from silence.
 *
 * THE BUG THIS FILE EXISTS TO NAME: a `node --test` process can have every
 * one of its tests pass and still never exit, because something it (or a
 * file it ran) spawned or scheduled keeps the event loop alive after the
 * last test finished. `--test-timeout` cannot catch this by construction -
 * it bounds how long a single test's own function is allowed to run, never
 * whether the whole process exits afterward. On Windows CI this has shown
 * up as: every test in a run passes, then complete silence for the rest of
 * the job's time budget, then the job is cancelled at its ceiling with zero
 * indication of which file, or why. That is a cancelled job with no named
 * failure - exactly what this wrapper turns into a named one.
 *
 * Three termination paths below, and on every one of them `process.exit()`
 * is called EXPLICITLY:
 *
 *   idle watchdog       no test-runner event of any kind for --idle-timeout
 *   wall cap            the whole run exceeds --wall-timeout regardless
 *   post-completion leak the run's own event stream says "done" and the
 *                        process is still alive --leak-window later
 *
 * Every other script in this repo ends its failure path with
 * `process.exitCode = 1; return;` (see check-coverage-floor.mjs,
 * lint-workflow-jobs.mjs, verify-workflow-topology.mjs) and that is
 * correct there, because in every one of those scripts nothing is holding
 * the event loop open - setting exitCode and returning lets Node's own
 * natural drain exit with the right code. That idiom is *wrong* on all
 * three paths above, on purpose: the entire premise of this file is that
 * something might be holding the event loop open, and `exitCode` alone
 * cannot terminate a process a live handle is keeping alive - it just sets
 * the number a drain that may never come would have used. Copying that
 * idiom into any of the three paths reproduces, inside the tool built to
 * catch the hang, the exact hang it exists to catch. So: every one of the
 * three paths calls `process.exit(1)` directly, after writing its
 * diagnostic and flushing junit synchronously first.
 *
 * The post-completion path is the mirror image of `--test-force-exit`.
 * `forceExit` makes a run that never would have exited on its own look
 * green by exiting it anyway - it hides the bug. This path does the
 * opposite: it *proves* the process would not have exited (by actually
 * watching it fail to, for a bounded window, via a timer that does not
 * itself keep the process alive) and then reports that as a named failure
 * before forcing the exit itself. The failure is surfaced, not hidden. If
 * you are reading this because you are tempted to add `forceExit: true` to
 * the `run()` call below to quiet a hang: don't - that deletes the one
 * thing this file is for.
 *
 * A hard `process.exit()` drops whatever has not been flushed yet. The
 * junit buffer is flushed with a synchronous `writeFileSync` immediately
 * before every `process.exit()` call for exactly this reason. The `spec`
 * reporter's stdout has no equivalent synchronous flush available here, so
 * on the two hang paths (idle, wall) its trailing output may be truncated
 * - the stderr "start:" markers (one per test, written before that test
 * runs) are the durable record of how far the run actually got, and they
 * are what the diagnostics below point at.
 *
 * Known limitation, stated plainly: on an idle-watchdog or wall-cap fire,
 * this process exits and leaves whatever it was waiting on to the OS. On a
 * hosted CI runner the whole VM is discarded at the end of the job, so
 * this is harmless. Run locally, the diagnostic below names the stuck
 * file/handle so a human can go kill it by hand if the OS does not reap it
 * on its own.
 *
 * Locating the 2026-08-03 orphan remedy (spawn detached, signal the
 * process group) at THIS file specifically: this file never calls
 * child_process.spawn/spawnSync itself for the per-test-file children
 * above - node:test's own run() spawns and reaps them internally
 * (isolation:'process' is its default), with no documented option to
 * spawn them detached. So the remedy cannot be applied at that layer from
 * here, and the "known limitation" paragraph above is not narrowed by it:
 * on a watchdog fire, whatever run() was still running is still left to
 * the OS exactly as described.
 *
 * The nested supervisor the remedy actually targets - the one whose own
 * timeout's SIGTERM reaches only its immediate child, never a
 * grandchild, per nodejs/node#43704 (cited above) - is
 * runPermanentGuardSuite() in test/loader-escape-matrix.test.ts, one
 * level down: it is itself one of the test files this script discovers
 * and runs, and it spawns its OWN nested `node --test` process over three
 * other test files. As of 2026-08-14 that spawnSync call spawns detached
 * (POSIX only) and a SIGKILL sweep of the whole process group runs after
 * every invocation, closing the SIGTERM-survives residual this file used
 * to leave open. See that function's own doc comment for the mechanism
 * and its remaining disclosed limits (win32, the PGID-reuse race).
 *
 * One environment variable this script consults at all: GHANTIKA_JUNIT,
 * additive-only - setting it adds a junit XML file at that path; leaving it
 * unset means no junit file is written at all, and it cannot narrow the
 * discovered file set, lower any floor, or disable any check below.
 *
 * This entrypoint takes no caller-controlled redirect of the test
 * directory, the skip baseline, or the critical-test list, and consults no
 * environment variable to decide any of the three. An earlier version of
 * this file accepted three such redirect variables, gated behind a fourth
 * (a fixed token string a caller also had to supply), on the theory that
 * requiring a secret value alongside the redirect would keep casual misuse
 * out. That boundary proved insufficient: the token was a
 * plain string constant sitting in this file's own tracked source, so
 * anyone able to set one environment variable for this process could read
 * the token's value and set the redirect variables themselves, reaching
 * the exact same bypass - point discovery at a trivial fixture tree,
 * supply a fabricated baseline and critical-test list, and walk away with
 * a fabricated green exit from what is supposed to be the real check. A
 * check that can be switched off from outside by setting environment
 * variables is not a check, no matter how many of them have to be set
 * together, so this file no longer reads any environment variable for this
 * purpose anywhere in its own code path - not "reads the value but ignores
 * it", genuinely absent from this source.
 *
 * The functions below that do discovery, load the skip baseline, load the
 * critical-test list, and check tracked-file parity (discoverTestFiles,
 * loadSkipBaseline, loadCriticalTests, checkTrackedFileParity) all take
 * the paths they need as explicit function arguments, with defaults
 * computed unconditionally from REPO_ROOT. main() below - what runs for
 * `npm test`, `npm run coverage`, every CI workflow step, and any other
 * normal automated invocation of this script - always calls them with
 * those real repository paths.
 *
 * Proving the skip-discipline check end to end against a throwaway
 * fixture tree, rather than only ever against this repo's own real,
 * always-clean test/ directory, now goes through a separate file this one
 * never imports and no production caller ever invokes:
 * scripts/run-tests-fixture-harness.mjs. That file imports the same
 * discovery/baseline/critical-test/classification functions this one does
 * and calls them with fixture paths supplied as its own explicit
 * arguments - never via an environment variable this file reads. See that
 * file's own header comment, and the structural check in
 * test/skip-discipline.test.ts confirming nothing production-facing ever
 * invokes it.
 */
import { run } from "node:test";
import { spec, junit } from "node:test/reporters";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// The real repo's own test/ directory, computed unconditionally from
// REPO_ROOT. This entrypoint consults no environment variable to decide
// where discovery looks - see the module doc comment above for why, and
// scripts/run-tests-fixture-harness.mjs for how a fixture tree is
// exercised instead.
const TEST_DIR = path.join(REPO_ROOT, "test");

// Where a truncation is recorded so scripts/check-coverage-floor.mjs (a
// SEPARATE process, invoked as its own later gate leg after `npm run
// coverage` - see that script's own header) can tell a genuinely partial
// run apart from a complete one. c8's own coverage-summary.json carries no
// such signal: it honestly reports whatever coverage it collected up to
// whatever point this process exited, and that table is indistinguishable
// from a real, complete run's - exactly the shape of a real incident where a
// coverage run silently truncated on the idle watchdog and its honest
// partial numbers read as a real 0-50% coverage regression. Lives under
// coverage/ (gitignored, same directory c8 itself writes into) rather than
// test/ or scripts/, so it is never mistaken for a tracked, checked-in
// artifact.
export const TRUNCATION_MARKER_PATH = path.join(REPO_ROOT, "coverage", "run-truncated.json");

// The `.test.` infix, not merely a directory, is what makes something a
// suite. `test/harness.ts` and `test/helpers/spawnServer.ts` sit under
// test/ but carry no `.test.` infix and are never discovered here - they
// are helpers the real suites import, not suites themselves.
const TEST_FILE_PATTERN = /\.test\.(ts|js|mjs|cjs|mts|cts)$/;

// Every event name the test runner emits that can carry a `.file`
// property, used both to reset the idle watchdog on ANY sign of life and
// to record which files have been heard from at all. See node:test's
// TestsStream documentation for the full event list this is drawn from.
const LIVENESS_EVENT_NAMES = [
  "test:enqueue",
  "test:dequeue",
  "test:start",
  "test:pass",
  "test:fail",
  "test:complete",
  "test:diagnostic",
  "test:stdout",
  "test:stderr",
  "test:plan",
  "test:coverage",
  "test:watch:drained",
];

const CLI_FLAGS = {
  "--test-timeout": "testTimeoutMs",
  "--idle-timeout": "idleTimeoutMs",
  "--wall-timeout": "wallTimeoutMs",
  "--leak-window": "leakWindowMs",
};

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = {
    // Raised from 30_000 to 120_000, final rather than provisional. The
    // prior 30s ceiling was clamping process.test.ts, kill-slow-paths.test.ts,
    // and (under c8 coverage instrumentation) loader-escape-matrix.test.ts on
    // CI's node 22 legs while all three passed clean on node 24 - confirmed
    // pre-existing (the same three files already failed on the commit before
    // any test-file split) and confirmed NOT generic node22 JS-execution
    // slowness (most per-test durations match or beat node24), but real
    // OS-level subprocess/signal-wait latency specific to this workload plus
    // c8's per-module instrumentation cost.
    //
    // Real, unclamped node22 completion times measured at this ceiling
    // (first-test-start to last-test-completion, per file): process.test.ts
    // 6.6s (126 tests), kill-slow-paths.test.ts 31.4s (7 tests, the worst
    // observed), process-slow-paths.test.ts 14.4s (5 tests),
    // loader-escape-matrix.test.ts 33ms (49 tests, under the coverage job).
    // 120_000 gives ~3.8x headroom over the worst observed file, and no
    // previously-timing-out file has hit a file-level timeout since.
    //
    // One number in that run complicated its own recommendation rather than
    // being quietly dropped: process.test.ts's pre-raise completion, still
    // clamped at the old 30s ceiling, clustered tightly at 29.85-29.93s
    // across three separate node22 legs - close enough to the ceiling to
    // look like the file's real cost. Unclamped at 120s it came in at 6.6s,
    // matching node24 exactly and matching the file's own per-test duration
    // sum (6.66s). The best-supported reading is that the ~29.9s reading was
    // contention - several files sitting near their own 30s ceilings at once
    // on a shared, noisy CI runner - rather than a measurement of this file's
    // true cost; that is a reading of the numbers, not something measured
    // directly, and is disclosed as such rather than asserted as fact.
    // Trimming the ceiling toward a single clean run was rejected precisely
    // because a noisier day could reproduce the 29.9s reading.
    //
    // Matches the explicit --test-timeout flag in ci.yml's test job - the
    // two move together; package.json's test and coverage scripts carry no
    // such flag at all and rely on this default.
    testTimeoutMs: 120_000,
    // No event of any kind (not just no test finishing - ANY event,
    // including test:start on some other still-running test) for this
    // long means something is stuck badly enough that the test runner
    // itself has gone quiet.
    //
    // Raised from 60_000 to 180_000 after the 60s ceiling started firing
    // on a legitimate, already-bounded operation rather than a genuine
    // hang. loader-escape-matrix.test.ts's own first test blocks
    // synchronously on a nested `node --test` supervisor (spawnSync with
    // its own timeout: 45_000, added in the same repo's history to bound
    // that supervisor - see runPermanentGuardSuite's doc comment); it
    // used to run inside a before() hook, which this file no longer has
    // - the call now happens as the first statement of that test's own
    // callback, immediately after an explicit yield lets that test's
    // test:dequeue reach the parent first. While the blocking call is in
    // flight, this file still emits nothing this wrapper's stream ever
    // sees, because test:start for that same test does not arrive until
    // the callback (block included) has already settled. Under coverage
    // (c8 forces this run() call to a single concurrent file), no OTHER
    // file is running at the same time to paper over the silence either.
    //
    // Measured directly, not assumed: instrumenting this file's own
    // noteEvent() to log the gap before every liveness event and running
    // `npm run coverage` end to end on this machine (macOS, arm64, node
    // 26.5.1) put the worst observed gap at 40.8s, landing immediately
    // before loader-escape-matrix.test.ts's own test:enqueue - the same
    // file, the same shape, as the two real hosted-CI failures this
    // raise responds to. Both of those (ubuntu-24.04, node 22, ghantika
    // PR #63) show the full configured 60000ms elapsing in total silence
    // with test:dequeue for that same file as the last liveness event -
    // a LOWER bound on the real CI-side gap, not a measured upper one:
    // the watchdog fires and the process exits at exactly that point, so
    // what the gap would have grown to if left alone is unmeasured. CI
    // is the slower host here (this repo's own testTimeoutMs comment
    // above already documents CI's node22 legs running visibly slower
    // than a local run), so the true CI-side gap is expected to sit
    // above the 40.8s measured locally, and reaching the old 60s ceiling
    // twice in two independent runs is consistent with that.
    //
    // 180_000 is roughly 4x the measured local worst case and 4x the
    // nested spawnSync's own already-configured 45_000ms bound - real
    // headroom for that already-approved recovery mechanism (SIGTERM,
    // its grace period, and whatever it takes the OS to actually reap
    // the child) to finish under real CI scheduling latency before this
    // wrapper's own patience runs out from underneath it.
    //
    // Disclosed limit, not solved by this change: if the underlying
    // stranding is a genuinely PERMANENT hang rather than a slow-but-
    // completing one - consistent with an upstream report (nodejs/node#43704,
    // closed as not_planned in 2023, cited here for the mechanism it
    // documents, not as an open issue) that a child_process timeout's
    // SIGTERM reaches only the immediate child, never a grandchild it
    // spawned - this raise does not fix that. It only stops killing a
    // run that was legitimately still finishing its own already-configured
    // recovery; a genuinely permanent hang is still caught, just 120s
    // later than before, and that added latency is the real, honest cost
    // of this change.
    idleTimeoutMs: 180_000,
    // Backstop for the whole run regardless of how the time is spent -
    // catches a death by a thousand near-idle-but-not-quite-idle cuts
    // that never individually trips the idle watchdog. 600s against a
    // measured healthy full-suite run in the low tens of seconds leaves
    // an order of magnitude of headroom.
    wallTimeoutMs: 600_000,
    // How long the process is allowed to keep breathing after the test
    // runner's own event stream says every file is done before that is
    // treated as proof something is holding the event loop open. 5s is
    // deliberately generous relative to how fast a genuinely clean
    // process actually exits (single-digit milliseconds, observed) - it
    // exists to absorb real but boring async cleanup (a stream's own
    // internal teardown, a reporter's last flush), not to paper over a
    // slow-but-real leak. See the header doc comment for why this timer
    // is `.unref()`'d: a clean process exits long before this fires and
    // the fire never happens; a stuck one is still here 5s later
    // regardless of what this timer does, so the timer only ever reports
    // what was already true.
    leakWindowMs: 5_000,
  };
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (eq === -1) continue;
    const flag = arg.slice(0, eq);
    const key = CLI_FLAGS[flag];
    if (!key) continue;
    const raw = arg.slice(eq + 1);
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${flag} requires a positive number of milliseconds, got "${raw}"`);
    }
    options[key] = value;
  }
  return options;
}

/**
 * Walks `dir` with node:fs (never a shell glob), returning every file
 * whose name matches TEST_FILE_PATTERN, sorted.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function discoverTestFiles(dir) {
  const found = [];
  walk(dir, found);
  found.sort();
  return found;
}

function walk(dir, found) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, found);
    } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
      found.push(full);
    }
  }
}

/**
 * The set of test files git considers tracked under test/, filtered to the
 * same suite pattern discovery uses. Returns null (UNSCANNED) if git is
 * unavailable or REPO_ROOT is not a git working tree - callers must treat
 * null as "cannot enforce the tracked-file floor this run", never as "zero
 * tracked files", and every other check below still runs regardless.
 *
 * @returns {string[] | null}
 */
export function getTrackedTestFiles() {
  let out;
  try {
    out = execFileSync("git", ["ls-files", "--", "test"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((relPath) => TEST_FILE_PATTERN.test(relPath))
    .map((relPath) => path.join(REPO_ROOT, relPath))
    .sort();
}

/**
 * Compares node:fs-discovered test files against getTrackedTestFiles()'s
 * git-tracked set, both scoped to this repo's own test/ directory via
 * REPO_ROOT. Takes the already-discovered file list as its only argument
 * rather than a test-directory path: tracked-file parity is inherently a
 * fact about THIS repo's own git history, so there is nothing meaningful
 * to check it against for a throwaway fixture tree under a temp
 * directory - scripts/run-tests-fixture-harness.mjs never calls this at
 * all, exactly as this production entrypoint never reads a path override
 * for it.
 *
 * @param {string[]} discovered - absolute paths, exactly what
 *   discoverTestFiles(TEST_DIR) already returned for this same run.
 * @returns {{ tracked: string[] | null, missingFromDisk: string[], untrackedExtra: string[] }}
 *   `tracked` is null when git itself is unavailable (see
 *   getTrackedTestFiles) - callers must treat that as UNSCANNED, never as
 *   zero tracked files; `missingFromDisk`/`untrackedExtra` are both empty
 *   in that case since neither has anything real to compare against.
 */
export function checkTrackedFileParity(discovered) {
  const tracked = getTrackedTestFiles();
  if (tracked === null) {
    return { tracked: null, missingFromDisk: [], untrackedExtra: [] };
  }
  const discoveredSet = new Set(discovered);
  const missingFromDisk = tracked.filter((f) => !discoveredSet.has(f));
  const trackedSet = new Set(tracked);
  const untrackedExtra = discovered.filter((f) => !trackedSet.has(f));
  return { tracked, missingFromDisk, untrackedExtra };
}

function rel(absPath) {
  return path.relative(REPO_ROOT, absPath);
}

/**
 * Skip discipline: the guard against a test being quietly switched to
 * `skip: true` (or otherwise disappearing) while the rest of the suite
 * still reports green. Setting a test's `skip` unconditionally produces
 * no red and no warning on its own: the run finishes, every remaining
 * test passes, and the process exits 0. Because this repo's own guards
 * (module-boundaries, no-tasks-import, stdio-purity, ...) are themselves
 * tests, a one-line skip on any of them silently disables the thing that
 * proves that guard can ever fail.
 *
 * Two tracked, hand-maintained files this reads and never re-derives:
 *
 *   test/skip-baseline.json    per-platform SET of test identities that
 *                              are legitimately skipped there (a
 *                              POSIX-only test skipped on win32, say)
 *   test/critical-tests.json   the exact identities of tests that must
 *                              always run and pass - never skipped,
 *                              never absent
 *
 * A test's identity is `${posixRelativePathFromRepoRoot}::${test name}`
 * (see buildTestIdentity below), normalized with the same
 * path.relative(...).split(path.sep).join("/") idiom scripts/check-no-
 * tasks-import.mjs, scripts/check-stdio-purity.mjs, scripts/check-npm-
 * ci-usage.mjs, and scripts/verify-install-reproducibility.mjs already
 * use - without it, a hand-written baseline entry (always written with
 * forward slashes) would silently fail to match on win32, where
 * path.sep is "\\".
 *
 * There is no `test:skip` event. node:test's TestsStream reports skip as
 * PAYLOAD STATE instead: the TestPass, TestFail, and TestComplete event
 * payloads each carry an optional `skip?: string | boolean` field (see
 * node_modules/@types/node/test.d.ts). A result is treated as skipped
 * when that field is `true` or a non-empty string; `false`, an empty
 * string, and absent all mean "ran" (confirmed empirically against a
 * throwaway fixture covering all four shapes, not assumed from the
 * type alone). isSkippedValue below is the single classification every
 * check in this file shares - the unsanctioned-skip check, the
 * critical-must-run check, and their diagnostics all read the exact same
 * classified result, never a second, independently-derived notion of
 * "skipped".
 */
export function isSkippedValue(skip) {
  return skip === true || (typeof skip === "string" && skip.length > 0);
}

/**
 * A TODO test carries the same two-shape payload field as skip
 * (`todo?: string | boolean`), classified by the identical rule: a bare
 * `true` or a non-empty reason string both count, `false`/empty/absent
 * mean "not TODO" (confirmed empirically against a throwaway fixture: a
 * `todo` test declared with no function body at all completes with
 * `passed: true` and `skip` absent, indistinguishable from a genuinely
 * executed passing test unless this field is also read). Node's own
 * `todo` semantics differ from `skip` - a todo test whose body IS
 * provided and throws still runs that body and is not counted as a
 * fatal failure - but that distinction does not matter here: this guard
 * only needs to know whether a declared-critical test's completion
 * carries a truthy `todo`, exactly as it already needs to know whether
 * it carries a truthy `skip`.
 */
export function isTodoValue(todo) {
  return todo === true || (typeof todo === "string" && todo.length > 0);
}

/**
 * @param {string} absFile
 * @param {string} testName
 * @param {{
 *   baseDir?: string,
 *   pathImpl?: { relative: (from: string, to: string) => string, sep: string },
 * }} [opts] `pathImpl` is injectable so a test can prove the normalization
 *   is correct for a win32-style separator from any host OS, via node's
 *   own `path.win32` - production always uses the real, host-native
 *   `node:path`.
 * @returns {string}
 */
export function buildTestIdentity(
  absFile,
  testName,
  { baseDir = REPO_ROOT, pathImpl = path } = {}
) {
  const relPath = pathImpl.relative(baseDir, absFile).split(pathImpl.sep).join("/");
  return `${relPath}::${testName}`;
}

/**
 * True only for node:test's own synthetic "this whole file, as a test"
 * completion - the rollup isolation:'process' emits once a file's child
 * process has actually exited - and never for a real test's own
 * completion, even one that happens to be named identically to its own
 * absolute file path. node:test allows a real `test()` to be declared
 * with that name; it is then a genuine, distinct completion with its
 * own source line, indistinguishable from the synthetic wrapper by name
 * alone.
 *
 * `data.name === data.file` is necessary but not sufficient: it is also
 * true for that legitimately-named real test, so relying on it alone
 * drops the real test's own result (and any skip on it) from the
 * results this guard collects. The second, reliable signal - confirmed
 * empirically against a throwaway fixture, not assumed - is that the
 * synthetic wrapper's event payload is built with a null prototype
 * (`Object.getPrototypeOf(data) === null`), while every real per-test
 * completion carries the ordinary `Object.prototype`, regardless of its
 * name, its line, or whether it is itself skipped or TODO. The wrapper
 * is also always reported at line 1, column 1 - the position of the
 * file itself, never any specific `test()` call site - but that is
 * corroborating, not primary: a single-statement CJS file can place a
 * real test's own call site at line 1 too (confirmed empirically), so
 * only the null-prototype check is treated as authoritative here.
 *
 * @param {{ name: string, file?: string }} data
 * @returns {boolean}
 */
function isFileSyntheticCompletion(data) {
  return data.name === data.file && Object.getPrototypeOf(data) === null;
}

/**
 * Classifies one raw `test:complete` payload for the skip-discipline
 * guard: null when the event is not a real, individually-identified
 * test (the file's own synthetic completion, or a suite/"describe"
 * node), otherwise the `{ identity, skip, todo }` record this guard
 * feeds into checkSkipDiscipline's `results`. Exported and pure - no
 * TestsStream or child process needed - so the classification itself is
 * directly unit-testable against a hand-built event object, in
 * particular the case a real fixture proved matters: a real test named
 * identically to its own file must classify as a real result, never be
 * mistaken for the synthetic wrapper.
 *
 * @param {{
 *   name: string,
 *   file?: string,
 *   skip?: string | boolean,
 *   todo?: string | boolean,
 *   details?: { type?: string },
 * }} data
 * @returns {{ identity: string, skip: string | boolean | undefined, todo: string | boolean | undefined } | null}
 */
export function classifyTestCompletionForSkipDiscipline(data) {
  if (!data?.file) return null;
  if (isFileSyntheticCompletion(data)) return null;
  if (data?.details?.type === "suite") return null;
  return { identity: buildTestIdentity(data.file, data.name), skip: data.skip, todo: data.todo };
}

/**
 * Pure core of the guard. Takes already-collected results (as run-
 * tests.mjs's own real run() wiring builds them below) rather than a live
 * TestsStream, so it is directly unit-testable without spawning anything.
 *
 * @param {{
 *   results: { identity: string, skip: string | boolean | undefined, todo?: string | boolean }[],
 *   baseline: Record<string, string[]>,
 *   criticalTests: string[],
 *   platform?: string,
 * }} args `baseline` is keyed by platform (`process.platform`'s own
 *   values, e.g. "win32"); `platform` selects which key is consulted and
 *   defaults to the real `process.platform` so callers never have to pass
 *   it in production, only in a test that wants to exercise another
 *   platform's legitimacy rules from this host.
 * @returns {string[]} human-readable problems found; empty means clean.
 */
export function checkSkipDiscipline({
  results,
  baseline,
  criticalTests,
  platform = process.platform,
}) {
  const errors = [];
  const sanctioned = new Set(baseline?.[platform] ?? []);

  // Every completion for an identity is kept, never collapsed to the
  // last one seen. node:test allows duplicate test names within one
  // file - two `test('same name', ...)` calls, or a colliding subtest
  // name - so a `[skip: true, skip: false]` pair for the same identity
  // is real input, not malformed data. A last-write-wins Map here would
  // let the second, non-skipped completion silently erase the first
  // one's skip, and a declared-critical identity in that state would
  // read as clean when it was not. Failing closed on this: an identity
  // is classified as skipped (or TODO) if ANY of its occurrences is, so
  // one real skip anywhere in the set can never be overwritten by a
  // later completion of the same identity.
  const seen = new Map();
  for (const { identity, skip, todo } of results) {
    let occurrences = seen.get(identity);
    if (!occurrences) {
      occurrences = [];
      seen.set(identity, occurrences);
    }
    occurrences.push({ skip, todo });
  }

  // The set is real per-platform data, kept narrow: an identity is
  // legitimate only when it appears in THIS platform's own sanctioned
  // list, never because some other platform's list is non-empty and
  // never because other, unrelated skips on this same platform are
  // legitimate. Sorted so the diagnostic order is deterministic.
  const unsanctioned = [...seen.entries()]
    .filter(
      ([identity, occurrences]) =>
        occurrences.some((o) => isSkippedValue(o.skip)) && !sanctioned.has(identity)
    )
    .map(([identity]) => identity)
    .sort();
  for (const identity of unsanctioned) {
    errors.push(
      `unsanctioned skip: "${identity}" was reported skipped, but is not in the "${platform}" set of test/skip-baseline.json`
    );
  }

  // A declared-critical test that never showed up in the results at all
  // (renamed or deleted), one that showed up but reported skipped, and
  // one that showed up only as TODO (declared but never genuinely run -
  // node:test still reports a passing-shaped completion for a
  // no-body-yet todo test) are all failures, named distinctly so the
  // reader knows which happened. Set membership on `identity` is
  // exact-string, never substring or prefix, so a renamed critical test
  // cannot be satisfied by an unrelated survivor whose name happens to
  // contain it. Skipped takes priority over TODO when a duplicate
  // identity's occurrences carry both, since a real skip is the more
  // specific, more actionable diagnosis.
  for (const identity of criticalTests) {
    const occurrences = seen.get(identity);
    if (!occurrences) {
      errors.push(`critical test did not run (absent from the results): "${identity}"`);
    } else if (occurrences.some((o) => isSkippedValue(o.skip))) {
      errors.push(`critical test reported skipped: "${identity}"`);
    } else if (occurrences.some((o) => isTodoValue(o.todo))) {
      errors.push(`critical test reported TODO (did not genuinely run): "${identity}"`);
    }
  }

  return errors;
}

// The real repo's own tracked baseline and critical-test list, computed
// unconditionally from REPO_ROOT. loadSkipBaseline and loadCriticalTests
// below each accept an explicit path argument - that parameter, supplied
// by a caller, is how scripts/run-tests-fixture-harness.mjs points the
// same loaders at a fixture tree's own files instead. This entrypoint
// itself never reads an environment variable to change either default.
const SKIP_BASELINE_PATH = path.join(REPO_ROOT, "test", "skip-baseline.json");
const CRITICAL_TESTS_PATH = path.join(REPO_ROOT, "test", "critical-tests.json");

/**
 * The command-policy allowlist every spawned test-file child process
 * inherits by default, via GHANTIKA_POLICY_FILE (see src/policy.ts) - a
 * small, fixed set of well-known executables (a POSIX shell, and the
 * handful of ordinary binaries the existing suite's own fixtures spawn:
 * node, echo, ls, true, sleep, fswatch) the wider suite's pre-existing
 * tests need to keep exercising a real `run` the same way they did before
 * the policy gate existed - fswatch specifically for test/dogfood.test.ts's
 * own real fswatch job, without which that file's run() call denies the
 * command outright and settles the job to "failed" on any host where
 * fswatch happens to be installed (confirmed directly: before this entry
 * existed, that file's real-fswatch run failed exactly that way on a host
 * where DOGFOOD_SKIP's own fswatchIsInstalled() check is true, rather than
 * skipping or passing). A fixed path computed unconditionally from REPO_ROOT, the
 * same pattern SKIP_BASELINE_PATH/CRITICAL_TESTS_PATH above already use -
 * this file still reads/consults no environment variable to change ANY of
 * its own behavior (see this file's own header doc comment); this is the
 * one place it SETS one, for the child processes it spawns, to a value
 * nothing external can redirect. test/policy.test.ts exercises the policy
 * gate's own default-deny/malformed-source behavior directly, reassigning
 * this variable only within its own isolated child process (node:test's
 * default per-file process isolation means that never affects a sibling
 * test file's own process).
 */
const TEST_POLICY_ALLOW_PATH = path.join(REPO_ROOT, "test", "fixtures", "policy-allow.json");

/** @param {string} [filePath] @returns {Record<string, string[]>} */
export function loadSkipBaseline(filePath = SKIP_BASELINE_PATH) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** @param {string} [filePath] @returns {string[]} */
export function loadCriticalTests(filePath = CRITICAL_TESTS_PATH) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * Summarizes process._getActiveHandles() by constructor name, pulling out
 * pid/spawnargs for anything that looks like a ChildProcess since that is
 * the single most useful fact on a hung-child scenario: it names exactly
 * which command is still alive and holding the process open.
 */
function activeHandleSummary() {
  const getHandles = process._getActiveHandles;
  if (typeof getHandles !== "function") {
    return ["process._getActiveHandles() is not available on this runtime"];
  }
  const byType = new Map();
  for (const handle of getHandles.call(process)) {
    const type = handle?.constructor?.name ?? typeof handle;
    let entry = byType.get(type);
    if (!entry) {
      entry = { count: 0, details: [] };
      byType.set(type, entry);
    }
    entry.count += 1;
    if (typeof handle?.pid === "number") {
      entry.details.push({
        pid: handle.pid,
        spawnargs: Array.isArray(handle.spawnargs) ? handle.spawnargs : undefined,
      });
    }
  }
  const lines = [];
  for (const [type, { count, details }] of byType) {
    lines.push(`  ${type}: ${count}${details.length ? " " + JSON.stringify(details) : ""}`);
  }
  return lines.length > 0 ? lines : ["  (none)"];
}

function printDiagnosticHeader(title, context) {
  // The `::error::` prefix is a GitHub Actions workflow command: a line
  // starting with it (recognized per-line, regardless of surrounding
  // output) becomes a job annotation, hoisted into the run summary instead
  // of sitting unread inside a runner-level failure with no individual
  // failing test to point at. Only this one line gets the prefix - the
  // active-resources/active-handles dump below stays plain stderr, since
  // it is structured detail rather than the single fact a reader needs
  // first.
  console.error(`\n::error::${title}`);
  for (const line of context) console.error(line);
  console.error("active resources (process.getActiveResourcesInfo()):");
  console.error(`  ${JSON.stringify(process.getActiveResourcesInfo())}`);
  console.error("active handle summary (process._getActiveHandles()):");
  for (const line of activeHandleSummary()) console.error(line);
}

function flushJunitSync(junitPath, buffer) {
  if (!junitPath) return;
  try {
    mkdirSync(path.dirname(junitPath), { recursive: true });
    writeFileSync(junitPath, buffer);
  } catch (err) {
    console.error(`run-tests: failed to flush junit output to ${junitPath}: ${err.message}`);
  }
}

/**
 * Records that this run terminated via one of the three hang-recovery
 * paths, BEFORE the matching process.exit(1) call - synchronous, same
 * write-then-hard-exit shape as flushJunitSync above, for the same reason:
 * a hard exit drops anything not already durably on disk. Read by
 * scripts/check-coverage-floor.mjs, a later, separate gate leg, so it can
 * refuse to compare whatever coverage numbers this run's own partial
 * execution produced rather than reporting them as a real verdict. Overwrites
 * unconditionally - only ONE of the three termination paths can ever fire per
 * run (each sets `terminationFired` before doing anything else), so there is
 * never a stale-vs-fresh marker to reconcile within a single invocation.
 *
 * @param {string} markerPath where to write it - the real production path
 *   by default, but see runOnce's own `truncationMarkerPath` parameter for
 *   why a caller driving this against a throwaway fixture tree must redirect
 *   it elsewhere.
 * @param {"idle-watchdog" | "wall-cap" | "post-completion-leak"} reason
 * @param {string} message human-readable - the same text already printed
 *   via printDiagnosticHeader, so a reader of the marker sees the identical
 *   explanation a reader of the console output would.
 */
function writeTruncationMarkerSync(markerPath, reason, message) {
  try {
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({ reason, message, at: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    console.error(`run-tests: failed to write truncation marker to ${markerPath}: ${err.message}`);
  }
}

/**
 * Runs the discovered suite once. Resolves once the process's own decision
 * about its exit code has been made (either by setting process.exitCode
 * for a clean run, or by calling process.exit(1) directly on one of the
 * three termination paths). Exported for tests to drive against a
 * throwaway fixture directory instead of this repo's real test/.
 *
 * `truncationMarkerPath` defaults to the real, shared TRUNCATION_MARKER_PATH
 * - correct for the production CLI entrypoint (main(), below), which never
 * overrides it. Any OTHER caller driving this function directly against a
 * throwaway fixture tree - scripts/run-tests-fixture-harness.mjs, or a test
 * deliberately forcing a watchdog fire to prove the mechanism itself - MUST
 * redirect it to a path scoped to that caller's own fixture directory.
 * Leaving it at the shared default in that case writes a truncation marker
 * into the real repo's own coverage/ directory as a side effect of testing
 * something unrelated, where it then sits until the next real `main()`
 * invocation clears it at its own start - meaning a later, genuinely
 * complete top-level `npm run coverage` run occurring in the SAME process
 * tree before that clearing happens would find the stale marker and wrongly
 * refuse to certify its own honest result. Measured, not hypothetical: this
 * exact sequence happened via scripts/run-tests-fixture-harness.mjs's own
 * deliberately-hung-fixture test (test/skip-discipline.test.ts) running
 * ahead of the real `coverage` gate leg inside one canonical local-gate
 * invocation, before this parameter existed.
 *
 * @param {{
 *   discovered: string[],
 *   tracked: string[] | null,
 *   junitPath: string | null,
 *   options: { testTimeoutMs: number, idleTimeoutMs: number, wallTimeoutMs: number, leakWindowMs: number },
 *   skipBaseline: Record<string, string[]>,
 *   criticalTests: string[],
 *   truncationMarkerPath?: string,
 * }} args
 */
export function runOnce({
  discovered,
  tracked,
  junitPath,
  options,
  skipBaseline,
  criticalTests,
  truncationMarkerPath = TRUNCATION_MARKER_PATH,
}) {
  return new Promise((resolve) => {
    const stream = run({ files: discovered, timeout: options.testTimeoutMs });

    let junitBuffer = "";
    let junitFinished = false;
    let streamEnded = false;
    let terminationFired = false;
    let didFail = false;
    let lastEvent = null;

    // Any event referencing a file at all - the file-floor check in
    // onNormalCompletion() below.
    const filesWithAnyEvent = new Set();
    // Only the file's OWN top-level completion event (name === file,
    // node:test's synthetic "this whole file, as a test" result) - the
    // signal the idle-watchdog diagnostic uses to name a file whose
    // *process* never reported back, as distinct from a file whose
    // individual tests reported in but which then never let its own
    // process exit (isolation:'process' is node:test's default, so a
    // file's own top-level test:complete does not fire until its child
    // process has actually exited - confirmed empirically against a
    // throwaway fixture, not assumed).
    const filesWithOwnCompletion = new Set();

    // Skip-discipline results, collected from the SAME "test:complete"
    // payloads noteEvent() below is already watching for the hang
    // watchdog, filtered down to real, individual tests via
    // classifyTestCompletionForSkipDiscipline (see its header comment for
    // why `name === file` alone is not a safe filter: a real test can be
    // named identically to its own file). See checkSkipDiscipline's
    // header comment above for why "test:complete" (never
    // "test:pass"/"test:fail" alone) is the right event: it fires exactly
    // once per real test regardless of pass, fail, or skip outcome,
    // carrying the same `skip`/`todo` fields either way (confirmed
    // empirically: a skipped test always reports via "test:pass", never
    // "test:fail").
    const skipResults = [];
    stream.on("test:complete", (data) => {
      const classified = classifyTestCompletionForSkipDiscipline(data);
      if (classified) skipResults.push(classified);
    });

    function noteEvent(name, data) {
      lastEvent = { name, file: data?.file, name_: data?.name };
      if (data?.file) {
        filesWithAnyEvent.add(data.file);
        if (name === "test:complete" && data.name === data.file) {
          filesWithOwnCompletion.add(data.file);
        }
      }
      resetIdleTimer();
    }

    let idleTimer = setTimeout(onIdleTimeout, options.idleTimeoutMs);
    function resetIdleTimer() {
      if (terminationFired || streamEnded) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdleTimeout, options.idleTimeoutMs);
    }

    const wallTimer = setTimeout(onWallTimeout, options.wallTimeoutMs);

    for (const name of LIVENESS_EVENT_NAMES) {
      stream.on(name, (data) => {
        noteEvent(name, data);
        if (name === "test:fail") didFail = true;
        if (name === "test:start" && data?.file) {
          // "stderr always carries the name of the last test started" -
          // written before the test runs, per the design this
          // implements. This is a claim about stderr alone: stdout (the
          // spec reporter, piped separately below) and stderr are
          // different pipes with no interleaving guarantee, so the
          // combined log is not claimed to end with this line, only
          // stderr on its own.
          process.stderr.write(`start: ${rel(data.file)} :: ${data.name}\n`);
        }
      });
    }

    stream.compose(spec).pipe(process.stdout);

    const junitSink = new Writable({
      write(chunk, _enc, cb) {
        junitBuffer += chunk;
        cb();
      },
    });
    stream.compose(junit).pipe(junitSink);
    junitSink.on("finish", () => {
      junitFinished = true;
      tryFinalizeNormal();
    });

    stream.on("end", () => {
      streamEnded = true;
      clearTimeout(idleTimer);
      clearTimeout(wallTimer);
      tryFinalizeNormal();
    });

    function tryFinalizeNormal() {
      if (terminationFired || !streamEnded || !junitFinished) return;
      onNormalCompletion();
    }

    function onNormalCompletion() {
      const missingFloor = (tracked ?? []).filter((f) => !filesWithAnyEvent.has(f));
      if (missingFloor.length > 0) {
        console.error("run-tests: tracked test file(s) produced no test-runner event at all:");
        for (const f of missingFloor) console.error(`  - ${rel(f)}`);
      }

      const skipErrors = checkSkipDiscipline({
        results: skipResults,
        baseline: skipBaseline,
        criticalTests,
        platform: process.platform,
      });
      if (skipErrors.length > 0) {
        console.error("run-tests: skip-discipline violation(s):");
        for (const error of skipErrors) console.error(`  - ${error}`);
      }

      flushJunitSync(junitPath, junitBuffer);
      const ok = !didFail && missingFloor.length === 0 && skipErrors.length === 0;
      process.exitCode = ok ? 0 : 1;

      // The post-completion leak check. This timer is .unref()'d on
      // purpose: it does not itself keep the process alive. If nothing
      // else is either, Node drains and exits on its own before this
      // timer's leakWindowMs elapses and the callback below never runs -
      // that is the success case, and it is indistinguishable from "this
      // timer was never scheduled" from the outside. If something else
      // IS still holding the loop open, .unref() does not stop this timer
      // from firing once leakWindowMs really has elapsed; it only opts
      // this timer itself out of being that something.
      const leakTimer = setTimeout(onPostCompletionLeak, options.leakWindowMs);
      leakTimer.unref();

      resolve();
    }

    function onIdleTimeout() {
      if (terminationFired || streamEnded) return;
      terminationFired = true;
      clearTimeout(wallTimer);
      const incomplete = discovered.filter((f) => !filesWithOwnCompletion.has(f));
      const idleMessage = `IDLE WATCHDOG: no test-runner event for ${options.idleTimeoutMs}ms - ${incomplete.length} input file(s) never reported their own completion (last event: ${JSON.stringify(lastEvent)})`;
      printDiagnosticHeader(`IDLE WATCHDOG: no test-runner event for ${options.idleTimeoutMs}ms`, [
        `last event received: ${JSON.stringify(lastEvent)}`,
        "input files with no completion event of their own yet " +
          "(their process may still be running, or may have exited " +
          "without ever reporting completion - e.g. an import-time hang):",
        ...incomplete.map((f) => `  - ${rel(f)}`),
      ]);
      writeTruncationMarkerSync(truncationMarkerPath, "idle-watchdog", idleMessage);
      flushJunitSync(junitPath, junitBuffer);
      process.exit(1);
    }

    function onWallTimeout() {
      if (terminationFired || streamEnded) return;
      terminationFired = true;
      clearTimeout(idleTimer);
      const wallMessage = `WALL CAP: total run time exceeded ${options.wallTimeoutMs}ms (last event: ${JSON.stringify(lastEvent)})`;
      printDiagnosticHeader(`WALL CAP: total run time exceeded ${options.wallTimeoutMs}ms`, [
        `last event received: ${JSON.stringify(lastEvent)}`,
      ]);
      writeTruncationMarkerSync(truncationMarkerPath, "wall-cap", wallMessage);
      flushJunitSync(junitPath, junitBuffer);
      process.exit(1);
    }

    function onPostCompletionLeak() {
      if (terminationFired) return;
      terminationFired = true;
      printDiagnosticHeader("LEAKED HANDLES AFTER COMPLETION", [
        `the test runner's own event stream reported every file complete, ` +
          `and reporters finished flushing, ${options.leakWindowMs}ms ago - ` +
          `yet this process is still alive. This is the opposite of ` +
          `--test-force-exit: the process is being forced to exit anyway, ` +
          `but only after naming that it should not have needed to be.`,
      ]);
      // NOT a truncation in the same sense as the other two paths: every
      // file's own test:complete DID fire (streamEnded is true by the time
      // this can run - see tryFinalizeNormal/onNormalCompletion above), so
      // whatever coverage c8 collected reflects a run that node:test itself
      // considers finished. What is stuck is a lingering handle, not an
      // unfinished test file - c8's own numbers here are not the same kind
      // of untrustworthy the idle/wall paths produce, so this path
      // deliberately does NOT write the truncation marker.
      flushJunitSync(junitPath, junitBuffer);
      process.exit(1);
    }
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`run-tests: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // A stale marker from a PREVIOUS truncated run must never be read as
  // belonging to THIS one - clear it unconditionally before anything else
  // runs, so a normal completion always starts (and, if it completes
  // normally, ends) with no marker on disk. Only the three termination
  // paths in runOnce() ever write it back. Absence is not an error (the
  // common case, and the very first run ever).
  try {
    unlinkSync(TRUNCATION_MARKER_PATH);
  } catch {
    // ENOENT (nothing to clear - normal) or any other error; either way
    // there is nothing actionable here, and a failed best-effort delete
    // must never block the run it is merely tidying up before.
  }

  const discovered = discoverTestFiles(TEST_DIR);
  if (discovered.length === 0) {
    // The whole reason discovery walks the filesystem itself instead of
    // handing a glob to a shell: an empty match must be loud. See the
    // header doc comment for the Windows cmd.exe glob-quoting bug this
    // closes - that bug's symptom was exactly this state (zero files
    // selected) exiting 0.
    console.error(
      `run-tests: discovered zero test files under ${rel(TEST_DIR)} - refusing to report a silent pass`
    );
    process.exitCode = 1;
    return;
  }

  // Always the real check, unconditionally: this entrypoint has no path
  // by which tracked-file parity is ever skipped except git itself being
  // genuinely unavailable (see checkTrackedFileParity's own doc comment).
  const parity = checkTrackedFileParity(discovered);
  const tracked = parity.tracked;
  if (tracked === null) {
    console.error(
      "run-tests: git unavailable (or this is not a git working tree) - " +
        "tracked-file parity is UNSCANNED this run; every other check " +
        "below still runs"
    );
  } else {
    if (parity.missingFromDisk.length > 0) {
      console.error(
        "run-tests: git tracks the following test file(s), but they were not found on disk:"
      );
      for (const f of parity.missingFromDisk) console.error(`  - ${rel(f)}`);
      process.exitCode = 1;
      return;
    }
    if (parity.untrackedExtra.length > 0) {
      console.error(
        "run-tests: untracked test file(s) discovered (permitted, informational only):"
      );
      for (const f of parity.untrackedExtra) console.error(`  - ${rel(f)}`);
    }
  }

  let skipBaseline;
  try {
    skipBaseline = loadSkipBaseline();
  } catch (err) {
    console.error(`run-tests: could not read ${rel(SKIP_BASELINE_PATH)}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  let criticalTests;
  try {
    criticalTests = loadCriticalTests();
  } catch (err) {
    console.error(`run-tests: could not read ${rel(CRITICAL_TESTS_PATH)}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const junitPath = process.env.GHANTIKA_JUNIT ? path.resolve(process.env.GHANTIKA_JUNIT) : null;

  // Every spawned test-file child process inherits this - see
  // TEST_POLICY_ALLOW_PATH's own doc comment above for why.
  process.env.GHANTIKA_POLICY_FILE = TEST_POLICY_ALLOW_PATH;

  await runOnce({ discovered, tracked, junitPath, options, skipBaseline, criticalTests });
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("run-tests: unexpected error:", err);
    process.exitCode = 1;
  });
}
