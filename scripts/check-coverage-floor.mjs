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
