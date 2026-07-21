#!/usr/bin/env node
/**
 * Prints an ADVISORY coverage delta vs the checked-in reference point in
 * config/coverage-baseline.json. This is deliberately the *only* thing
 * this script does - it never sets a non-zero exit code and never throws
 * past its own main(), on any input, including a missing or unreadable
 * coverage summary or baseline file. scripts/check-coverage-floor.mjs is
 * the one thing in the CI "coverage" job allowed to fail it; this script
 * exists purely to leave an informational trail on the run so a coverage
 * swing is visible without anyone having to go compare two JSON files by
 * hand.
 *
 * Baseline choice, and its limits: the alternative designs considered were
 * fetching the last successful run's coverage artifact from `main` via the
 * GitHub API, or checking out `main` in a second step and re-running
 * coverage against it. Both work, but both add real CI plumbing (artifact
 * retention, workflow-run lookups, a second install-and-run) for a report
 * that never gates anything. Comparing against a small JSON file checked
 * into the repo is the simplest thing that is still correct: a human
 * updates config/coverage-baseline.json by hand - re-run `npm run
 * coverage`, copy the new "total" row's percentages in - in the same PR
 * that genuinely improves coverage. The limits that come with that
 * simplicity: the baseline can go stale if a real improvement lands
 * without anyone bumping it (the delta then just under-reports the gain
 * on every later run, it doesn't fabricate a regression), and because the
 * file isn't tied to a specific commit on `main` this script can't tell
 * "the baseline is stale" apart from "coverage genuinely regressed" - it
 * only ever reports the raw distance between the two numbers. That
 * ambiguity is exactly why this stays advisory instead of blocking.
 */
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Overridable via env var so the CLI's actual failure paths (missing file,
// malformed JSON) are exercisable from a test as a real child process
// against throwaway fixture files, instead of only ever seeing this
// repo's own real coverage output. Production CI never sets these, so the
// defaults are what actually runs there.
export const COVERAGE_SUMMARY_PATH =
  process.env.GHANTIKA_COVERAGE_SUMMARY_PATH ??
  path.join(REPO_ROOT, "coverage", "coverage-summary.json");
export const COVERAGE_BASELINE_PATH =
  process.env.GHANTIKA_COVERAGE_BASELINE_PATH ??
  path.join(REPO_ROOT, "config", "coverage-baseline.json");
export const METRICS = ["statements", "branches", "functions", "lines"];

/**
 * @param {string} filePath
 * @returns {any}
 */
function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * @typedef {{ metric: string, baseline: number, current: number, delta: number }} DeltaRow
 */

/**
 * @param {{ total: Record<string, { pct: number }> }} summary
 * @param {Record<string, number>} baseline
 * @param {string[]} [metrics]
 * @returns {DeltaRow[]}
 */
export function computeCoverageDelta(summary, baseline, metrics = METRICS) {
  const total = summary?.total ?? {};
  return metrics.map((metric) => {
    const current = typeof total[metric]?.pct === "number" ? total[metric].pct : 0;
    const base = typeof baseline?.[metric] === "number" ? baseline[metric] : 0;
    return { metric, baseline: base, current, delta: Math.round((current - base) * 100) / 100 };
  });
}

/**
 * Renders delta rows as a Markdown table, labelled as informational so
 * anyone reading the step summary doesn't mistake it for a gate result.
 *
 * @param {DeltaRow[]} rows
 * @returns {string}
 */
export function formatDeltaMarkdown(rows) {
  const lines = [
    "### Coverage delta vs baseline (informational only - does not affect this job's result)",
    "",
    "| Metric | Baseline | Current | Delta |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const sign = row.delta > 0 ? "+" : "";
    lines.push(
      `| ${row.metric} | ${row.baseline.toFixed(2)}% | ${row.current.toFixed(2)}% | ${sign}${row.delta.toFixed(2)} |`
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Everything below is wrapped in one try/catch, on purpose: whatever goes
 * wrong here - a missing file, malformed JSON, an unwritable step-summary
 * path - is logged and swallowed, never rethrown, so this script always
 * exits 0. There is no code path here that sets process.exitCode or calls
 * process.exit with anything but success.
 */
function main() {
  try {
    const summary = loadJson(COVERAGE_SUMMARY_PATH);
    const baseline = loadJson(COVERAGE_BASELINE_PATH);
    const rows = computeCoverageDelta(summary, baseline);
    const markdown = formatDeltaMarkdown(rows);
    console.log(markdown);

    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) {
      appendFileSync(summaryFile, markdown);
    }
  } catch (err) {
    console.log(`coverage delta: skipped (${err.message}) - this never fails the job`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
