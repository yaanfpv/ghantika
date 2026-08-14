#!/usr/bin/env node
/**
 * Fails when any metric in coverage/coverage-summary.json (produced by
 * `npm run coverage`, which is c8 wrapping the test suite) drops below its
 * configured floor. This is the blocking half of the CI "coverage" job -
 * scripts/report-coverage-delta.mjs is the advisory half and, unlike this
 * script, is never allowed to affect the job's exit code.
 *
 * Where the floors below came from: on 2026-07-20, `npm run coverage`
 * against this project's real test suite (including the tests for this
 * script and scripts/report-coverage-delta.mjs) measured, from the
 * "total" row of coverage/coverage-summary.json - statements 87.23%,
 * branches 81.6%, functions 85.18%, lines 87.23%. Each floor is set
 * several points below its matching baseline on purpose. A tight floor
 * pinned to the exact current number would break on the next ordinary
 * fluctuation (a new file with one untested branch, a refactor that
 * shifts which lines execute) and train everyone to bump the floor
 * without looking closely, which defeats the point of having one; a floor
 * with several points of headroom absorbs that noise while still being
 * narrow enough that a real regression - a chunk of dead code, a whole
 * skipped code path - has to cross a wide gap it can't cross by accident.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Overridable via env var so the CLI's own success and failure paths
// (missing summary file, a metric under floor) are exercisable from a
// test as a real child process against a throwaway fixture, instead of
// only ever seeing this repo's own real coverage output. Production CI
// never sets this, so the default is what actually runs there.
export const COVERAGE_SUMMARY_PATH =
  process.env.GHANTIKA_COVERAGE_SUMMARY_PATH ??
  path.join(REPO_ROOT, "coverage", "coverage-summary.json");

// Same override pattern as COVERAGE_SUMMARY_PATH above, and read from the
// same directory scripts/run-tests.mjs's own TRUNCATION_MARKER_PATH writes
// to - deliberately not IMPORTED from that module (this script must be
// able to run, and to be tested, with no dependency on run-tests.mjs ever
// having executed in the same process; the two are coupled only through
// this one well-known path on disk, the same loose coupling
// COVERAGE_SUMMARY_PATH already has with c8's own output).
export const TRUNCATION_MARKER_PATH =
  process.env.GHANTIKA_TRUNCATION_MARKER_PATH ??
  path.join(REPO_ROOT, "coverage", "run-truncated.json");

/**
 * Metric name -> minimum acceptable percentage. See the module doc comment
 * above for the measured baseline each floor is set below, and why.
 */
export const COVERAGE_FLOORS = {
  statements: 80, // measured baseline (2026-07-20): 87.23%
  branches: 73, // measured baseline (2026-07-20): 81.6%
  functions: 77, // measured baseline (2026-07-20): 85.18%
  lines: 80, // measured baseline (2026-07-20): 87.23%
};

/**
 * @param {string} [filePath]
 * @returns {{ total: Record<string, { pct: number }> }}
 */
export function loadCoverageSummary(filePath = COVERAGE_SUMMARY_PATH) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * Reads the truncation marker scripts/run-tests.mjs writes when its own
 * idle watchdog or wall cap fires, before it force-exits. Returns null
 * when the file is absent - the common case, and read as "the run
 * completed" - never as an error: a missing marker is the expected state
 * after every ordinary, complete run (run-tests.mjs's own main() clears it
 * unconditionally at the START of every invocation, so a stale marker from
 * a PRIOR truncated run can never survive into reading a fresh, complete
 * one's summary).
 *
 * @param {string} [filePath]
 * @returns {{ reason: string, message: string, at: string } | null}
 */
export function loadTruncationMarker(filePath = TRUNCATION_MARKER_PATH) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The exit code this script (and, by the same convention, any other gate
 * leg that needs to report the identical "ran, but refuses to certify a
 * verdict" state) uses for VOID: a third outcome, distinguishable from both
 * PASS (exit 0) and FAIL (exit 1) by the exit code alone, before a reader
 * ever has to read the printed message. This repo's own local gate tooling
 * reads this same value to classify a leg's outcome as voided rather than
 * an ordinary failure.
 */
export const VOID_EXIT_CODE = 2;

/**
 * Compares a coverage summary's "total" row against a set of floors.
 *
 * @param {{ total: Record<string, { pct: number }> }} summary
 * @param {Record<string, number>} [floors]
 * @returns {string[]} human-readable problems found; empty means clean.
 */
export function checkCoverageFloors(summary, floors = COVERAGE_FLOORS) {
  const errors = [];
  const total = summary?.total ?? {};
  for (const [metric, floor] of Object.entries(floors)) {
    const pct = total[metric]?.pct;
    if (typeof pct !== "number") {
      errors.push(
        `coverage summary is missing a numeric "${metric}" total - can't check its floor`
      );
      continue;
    }
    if (pct < floor) {
      const shortfall = (floor - pct).toFixed(2);
      errors.push(
        `coverage for "${metric}" is ${pct.toFixed(2)}%, below the ${floor}% floor (short by ${shortfall} points)`
      );
    }
  }
  return errors;
}

function main() {
  // A truncated run must not produce a coverage verdict. Checked BEFORE the
  // summary is even loaded - a truncated run's coverage-summary.json is not
  // wrong to read, it is simply not evidence of anything: c8 honestly
  // reports whatever partial coverage it collected before
  // scripts/run-tests.mjs's own idle watchdog or wall cap force-exited it,
  // and that table is indistinguishable, by itself, from a real, complete
  // run's. Refusing here, before ever computing a single percentage, is
  // what makes this the check that prevents a partial run from ever being
  // reported as a real coverage regression.
  const truncation = loadTruncationMarker();
  if (truncation) {
    console.error(
      `coverage floor check: REFUSED - the underlying test run was truncated (${truncation.reason} at ${truncation.at}), ` +
        `so coverage/coverage-summary.json describes a partial execution and cannot be compared to a floor.`
    );
    console.error(`  run-tests.mjs's own diagnostic: ${truncation.message}`);
    console.error(
      `  this is VOID, not a pass and not a fail - see ${path.relative(REPO_ROOT, TRUNCATION_MARKER_PATH)}. ` +
        `Fix whatever made the run hang (see the run's own console output / :error: diagnostics for which ` +
        `file never completed) and re-run "npm run coverage" to produce a trustworthy summary.`
    );
    process.exitCode = VOID_EXIT_CODE;
    return;
  }

  let summary;
  try {
    summary = loadCoverageSummary();
  } catch (err) {
    console.error(
      `coverage floor check: could not read ${path.relative(REPO_ROOT, COVERAGE_SUMMARY_PATH)}: ${err.message}`
    );
    console.error(`run "npm run coverage" first to generate it.`);
    process.exitCode = 1;
    return;
  }

  const errors = checkCoverageFloors(summary, COVERAGE_FLOORS);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`coverage floor error: ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("every coverage metric is at or above its configured floor");
}

if (isMainModule(import.meta.url)) {
  main();
}
