import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COVERAGE_FLOORS, checkCoverageFloors } from "../scripts/check-coverage-floor.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/check-coverage-floor.mjs", import.meta.url));

function summaryWith(pcts) {
  const total = {};
  for (const [metric, pct] of Object.entries(pcts)) {
    total[metric] = { pct };
  }
  return { total };
}

test("every configured floor is a percentage between 0 and 100", () => {
  for (const [metric, floor] of Object.entries(COVERAGE_FLOORS)) {
    assert.ok(
      floor > 0 && floor <= 100,
      `floor for "${metric}" should be a real percentage, got ${floor}`
    );
  }
});

test("a summary at exactly the floors passes (floor is inclusive)", () => {
  const summary = summaryWith(COVERAGE_FLOORS);
  assert.deepEqual(checkCoverageFloors(summary), []);
});

test("a summary comfortably above every floor passes", () => {
  const above = Object.fromEntries(
    Object.entries(COVERAGE_FLOORS).map(([metric, floor]) => [metric, floor + 10])
  );
  assert.deepEqual(checkCoverageFloors(summaryWith(above)), []);
});

// Mutation control: drop one metric below its floor and confirm the check
// names exactly that metric and the shortfall, then confirm restoring it
// goes clean again - proving this reacts to the real number, not just
// always failing or always passing.
test("mutation control: one metric dropping below its floor is caught by name", () => {
  const summary = summaryWith(COVERAGE_FLOORS);
  const floor = COVERAGE_FLOORS.branches;
  summary.total.branches.pct = floor - 5;

  const errors = checkCoverageFloors(summary);
  assert.equal(errors.length, 1, `expected exactly one error, got: ${JSON.stringify(errors)}`);
  assert.ok(errors[0].includes('"branches"'), `error should name "branches", got: ${errors[0]}`);
  assert.ok(
    errors[0].includes("5.00"),
    `error should report the 5-point shortfall, got: ${errors[0]}`
  );

  summary.total.branches.pct = floor;
  assert.deepEqual(checkCoverageFloors(summary), []);
});

test("mutation control: every metric dropping below its floor is caught, one error each", () => {
  const summary = summaryWith(
    Object.fromEntries(Object.entries(COVERAGE_FLOORS).map(([metric]) => [metric, 0]))
  );
  const errors = checkCoverageFloors(summary);
  assert.equal(errors.length, Object.keys(COVERAGE_FLOORS).length);
  for (const metric of Object.keys(COVERAGE_FLOORS)) {
    assert.ok(
      errors.some((error) => error.includes(`"${metric}"`)),
      `expected an error naming "${metric}", got: ${JSON.stringify(errors)}`
    );
  }
});

test("a missing metric in the summary is reported, not silently skipped", () => {
  const summary = summaryWith(COVERAGE_FLOORS);
  delete summary.total.functions;

  const errors = checkCoverageFloors(summary);
  assert.ok(
    errors.some((error) => error.includes('"functions"') && error.includes("missing")),
    `expected a missing-metric error, got: ${JSON.stringify(errors)}`
  );
});

test("an empty summary object is reported as every metric missing, not thrown", () => {
  const errors = checkCoverageFloors({});
  assert.equal(errors.length, Object.keys(COVERAGE_FLOORS).length);
});

test("a custom floor set is honored instead of the exported default", () => {
  const summary = summaryWith({ statements: 50 });
  assert.deepEqual(checkCoverageFloors(summary, { statements: 60 }).length, 1);
  assert.deepEqual(checkCoverageFloors(summary, { statements: 40 }), []);
});

/**
 * Runs the script's actual CLI entry point (not just checkCoverageFloors
 * above) as a real child process, pointed at a throwaway fixture file via
 * the GHANTIKA_COVERAGE_SUMMARY_PATH override the script honors, and
 * returns its exit code without letting a non-zero one throw past this
 * helper.
 *
 * @param {string | undefined} summaryContent omit to simulate a missing file
 * @returns {number}
 */
function runCliAgainstFixture(summaryContent) {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-coverage-floor-"));
  try {
    const summaryPath = path.join(dir, "coverage-summary.json");
    const env = { ...process.env };
    if (summaryContent !== undefined) {
      writeFileSync(summaryPath, summaryContent);
      env.GHANTIKA_COVERAGE_SUMMARY_PATH = summaryPath;
    } else {
      env.GHANTIKA_COVERAGE_SUMMARY_PATH = path.join(dir, "does-not-exist.json");
    }

    try {
      execFileSync(process.execPath, [SCRIPT_PATH], { env, stdio: "pipe" });
      return 0;
    } catch (err) {
      return typeof err.status === "number" ? err.status : 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI: exits 0 when every metric clears its floor", () => {
  const summary = summaryWith(
    Object.fromEntries(
      Object.entries(COVERAGE_FLOORS).map(([metric, floor]) => [metric, floor + 10])
    )
  );
  assert.equal(runCliAgainstFixture(JSON.stringify(summary)), 0);
});

// A CLI-level mutation control: proves the real entry point (not just the
// pure function) actually fails the process when a metric is under floor,
// and that a missing summary file is a failure too rather than a silent
// pass.
test("mutation control: CLI exits non-zero when a metric is under its floor", () => {
  const summary = summaryWith(
    Object.fromEntries(
      Object.entries(COVERAGE_FLOORS).map(([metric, floor]) => [metric, floor - 1])
    )
  );
  assert.notEqual(runCliAgainstFixture(JSON.stringify(summary)), 0);
});

test("mutation control: CLI exits non-zero when the summary file is missing, not a silent pass", () => {
  assert.notEqual(runCliAgainstFixture(undefined), 0);
});
