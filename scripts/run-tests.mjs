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
 * The only environment input this script reads is GHANTIKA_JUNIT, and it
 * is additive-only: setting it adds a junit XML file at that path. It
 * cannot narrow the discovered file set, lower any floor, or disable any
 * check below. Leaving it unset means no junit file is written at all.
 */
import { run } from "node:test";
import { spec, junit } from "node:test/reporters";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_DIR = path.join(REPO_ROOT, "test");

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
    // Matches the --test-timeout=30000 already in package.json's test and
    // coverage scripts and in ci.yml's test job at the time this file was
    // written (checked directly, not assumed).
    testTimeoutMs: 30_000,
    // No event of any kind (not just no test finishing - ANY event,
    // including test:start on some other still-running test) for this
    // long means something is stuck badly enough that the test runner
    // itself has gone quiet. 60s is deliberately generous: real local
    // suite runs land well under half of this between any two
    // consecutive events even on the slowest file.
    idleTimeoutMs: 60_000,
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

function rel(absPath) {
  return path.relative(REPO_ROOT, absPath);
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
  console.error(`\n=== ${title} ===`);
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
 * Runs the discovered suite once. Resolves once the process's own decision
 * about its exit code has been made (either by setting process.exitCode
 * for a clean run, or by calling process.exit(1) directly on one of the
 * three termination paths). Exported for tests to drive against a
 * throwaway fixture directory instead of this repo's real test/.
 *
 * @param {{
 *   discovered: string[],
 *   tracked: string[] | null,
 *   junitPath: string | null,
 *   options: { testTimeoutMs: number, idleTimeoutMs: number, wallTimeoutMs: number, leakWindowMs: number },
 * }} args
 */
export function runOnce({ discovered, tracked, junitPath, options }) {
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
      flushJunitSync(junitPath, junitBuffer);
      const ok = !didFail && missingFloor.length === 0;
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
      printDiagnosticHeader(`IDLE WATCHDOG: no test-runner event for ${options.idleTimeoutMs}ms`, [
        `last event received: ${JSON.stringify(lastEvent)}`,
        "input files with no completion event of their own yet " +
          "(their process may still be running, or may have exited " +
          "without ever reporting completion - e.g. an import-time hang):",
        ...incomplete.map((f) => `  - ${rel(f)}`),
      ]);
      flushJunitSync(junitPath, junitBuffer);
      process.exit(1);
    }

    function onWallTimeout() {
      if (terminationFired || streamEnded) return;
      terminationFired = true;
      clearTimeout(idleTimer);
      printDiagnosticHeader(`WALL CAP: total run time exceeded ${options.wallTimeoutMs}ms`, [
        `last event received: ${JSON.stringify(lastEvent)}`,
      ]);
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

  const tracked = getTrackedTestFiles();
  if (tracked === null) {
    console.error(
      "run-tests: git unavailable (or this is not a git working tree) - " +
        "tracked-file parity is UNSCANNED this run; every other check " +
        "below still runs"
    );
  } else {
    const discoveredSet = new Set(discovered);
    const missingFromDisk = tracked.filter((f) => !discoveredSet.has(f));
    if (missingFromDisk.length > 0) {
      console.error(
        "run-tests: git tracks the following test file(s), but they were not found on disk:"
      );
      for (const f of missingFromDisk) console.error(`  - ${rel(f)}`);
      process.exitCode = 1;
      return;
    }
    const trackedSet = new Set(tracked);
    const untrackedExtra = discovered.filter((f) => !trackedSet.has(f));
    if (untrackedExtra.length > 0) {
      console.error(
        "run-tests: untracked test file(s) discovered (permitted, informational only):"
      );
      for (const f of untrackedExtra) console.error(`  - ${rel(f)}`);
    }
  }

  const junitPath = process.env.GHANTIKA_JUNIT ? path.resolve(process.env.GHANTIKA_JUNIT) : null;

  await runOnce({ discovered, tracked, junitPath, options });
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("run-tests: unexpected error:", err);
    process.exitCode = 1;
  });
}
