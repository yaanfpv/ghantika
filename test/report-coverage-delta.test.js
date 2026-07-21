import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  METRICS,
  computeCoverageDelta,
  formatDeltaMarkdown,
} from "../scripts/report-coverage-delta.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/report-coverage-delta.mjs", import.meta.url));

function summaryWith(pcts) {
  const total = {};
  for (const [metric, pct] of Object.entries(pcts)) {
    total[metric] = { pct };
  }
  return { total };
}

test("computeCoverageDelta reports 0 for every metric when current equals baseline", () => {
  const baseline = { statements: 80, branches: 70, functions: 90, lines: 80 };
  const rows = computeCoverageDelta(summaryWith(baseline), baseline);
  for (const row of rows) {
    assert.equal(row.delta, 0, `expected a zero delta for "${row.metric}"`);
  }
});

test("computeCoverageDelta reports the real signed distance, up and down", () => {
  const baseline = { statements: 80, branches: 70, functions: 90, lines: 80 };
  const current = { statements: 85, branches: 65, functions: 90, lines: 80 };
  const rows = computeCoverageDelta(summaryWith(current), baseline);

  const byMetric = Object.fromEntries(rows.map((row) => [row.metric, row.delta]));
  assert.equal(byMetric.statements, 5);
  assert.equal(byMetric.branches, -5);
  assert.equal(byMetric.functions, 0);
  assert.equal(byMetric.lines, 0);
});

test("computeCoverageDelta covers every documented metric, in order", () => {
  const rows = computeCoverageDelta(summaryWith({}), {});
  assert.deepEqual(
    rows.map((row) => row.metric),
    METRICS
  );
});

test("computeCoverageDelta treats a missing metric on either side as 0, not a throw", () => {
  const rows = computeCoverageDelta(summaryWith({ statements: 90 }), { statements: 80 });
  const byMetric = Object.fromEntries(rows.map((row) => [row.metric, row.delta]));
  assert.equal(byMetric.statements, 10);
  assert.equal(byMetric.branches, 0);
});

test("formatDeltaMarkdown labels itself informational and does not read as a gate result", () => {
  const markdown = formatDeltaMarkdown(
    computeCoverageDelta(summaryWith({ statements: 80 }), { statements: 80 })
  );
  assert.ok(
    markdown.includes("informational only"),
    "the table must disclose that it never affects the job result"
  );
  assert.ok(markdown.includes("| statements |"), "the table should list the statements row");
});

test("formatDeltaMarkdown signs a positive delta with a leading +", () => {
  const rows = computeCoverageDelta(summaryWith({ statements: 90 }), { statements: 80 });
  const markdown = formatDeltaMarkdown(rows);
  assert.ok(markdown.includes("+10.00"), `expected a signed positive delta in: ${markdown}`);
});

/**
 * Runs the script's actual CLI entry point (not just the pure functions
 * above) as a real child process against a pair of throwaway fixture
 * files, pointed at via the GHANTIKA_COVERAGE_SUMMARY_PATH /
 * GHANTIKA_COVERAGE_BASELINE_PATH overrides the script honors, and
 * returns its exit code without letting a non-zero one throw past this
 * helper - the whole point of the test below is to observe that code, not
 * to have the test framework treat it as a crash.
 *
 * @param {{ summary?: string, baseline?: string }} fixture
 * @returns {number}
 */
function runScriptAgainstFixture({ summary, baseline }) {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-coverage-delta-"));
  try {
    const summaryPath = path.join(dir, "coverage-summary.json");
    const baselinePath = path.join(dir, "coverage-baseline.json");
    const env = { ...process.env };
    if (summary !== undefined) {
      writeFileSync(summaryPath, summary);
      env.GHANTIKA_COVERAGE_SUMMARY_PATH = summaryPath;
    } else {
      env.GHANTIKA_COVERAGE_SUMMARY_PATH = path.join(dir, "does-not-exist.json");
    }
    if (baseline !== undefined) {
      writeFileSync(baselinePath, baseline);
      env.GHANTIKA_COVERAGE_BASELINE_PATH = baselinePath;
    } else {
      env.GHANTIKA_COVERAGE_BASELINE_PATH = path.join(dir, "also-does-not-exist.json");
    }

    try {
      execFileSync(process.execPath, [SCRIPT_PATH], { env, stdio: "pipe" });
      return 0;
    } catch (err) {
      // execFileSync throws on a non-zero exit; that IS the failure signal
      // this test is checking for, so surface the real code instead of
      // letting the throw propagate as a test crash.
      return typeof err.status === "number" ? err.status : 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A mutation control: proves there is no code path where the delta
// computation's result - or a bad input - can influence the process exit
// code. Every case below is engineered to be as bad as possible for this
// script (a real regression, an improvement, a missing file on each side,
// malformed JSON on each side) and every one of them must still come back
// 0.
test("mutation control: the CLI exits 0 no matter what the delta or the inputs look like", () => {
  const cases = [
    {
      name: "a real regression (current far below baseline)",
      summary: JSON.stringify(
        summaryWith({ statements: 10, branches: 10, functions: 10, lines: 10 })
      ),
      baseline: JSON.stringify({ statements: 90, branches: 90, functions: 90, lines: 90 }),
    },
    {
      name: "an improvement (current far above baseline)",
      summary: JSON.stringify(
        summaryWith({ statements: 99, branches: 99, functions: 99, lines: 99 })
      ),
      baseline: JSON.stringify({ statements: 10, branches: 10, functions: 10, lines: 10 }),
    },
    {
      name: "missing coverage summary file",
      summary: undefined,
      baseline: JSON.stringify({ statements: 10 }),
    },
    {
      name: "missing baseline file",
      summary: JSON.stringify(summaryWith({ statements: 50 })),
      baseline: undefined,
    },
    {
      name: "malformed JSON in the coverage summary",
      summary: "{not valid json",
      baseline: JSON.stringify({ statements: 10 }),
    },
    {
      name: "malformed JSON in the baseline",
      summary: JSON.stringify(summaryWith({ statements: 50 })),
      baseline: "{not valid json",
    },
    {
      name: "both files missing",
      summary: undefined,
      baseline: undefined,
    },
  ];

  for (const { name, summary, baseline } of cases) {
    const exitCode = runScriptAgainstFixture({ summary, baseline });
    assert.equal(exitCode, 0, `case "${name}" should exit 0, got exit code ${exitCode}`);
  }
});
