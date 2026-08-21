#!/usr/bin/env node
/**
 * A permanent, tracked measurement tool - not scaffolding meant for removal.
 * It answers one question with real data, repeatedly over this repo's life
 * rather than once: what node:test file-concurrency value can a given
 * GitHub-hosted runner sustain, on its own hardware, before this repo's
 * process-spawning tests start losing their wall-clock race - measured
 * separately for the plain test path and for the same suite wrapped in c8's
 * coverage instrumentation, since those are two structurally different
 * execution paths with different per-file cost.
 *
 * WHY THIS STAYS IN THE TREE RATHER THAN BEING REMOVED ONCE A VALUE LANDS:
 * a concurrency ceiling is a property of the SUITE (how many files, how
 * expensive each one is) crossed with the HARDWARE (how many usable cores
 * a runner actually offers), and both sides of that move. The suite's own
 * file count and content change as tests are added, split, or quarantined;
 * GitHub's hosted-runner hardware changes on its own schedule, outside this
 * repo's control. A value measured once and then hardcoded into ci.yml
 * silently goes stale the moment either side moves, with nothing to notice
 * when it does - the value is re-run deliberately, on demand, rather than
 * assumed to still hold.
 *
 * WHAT COUNTS AS "A RUN" HERE: all repeats for one concurrency value run
 * sequentially inside one job/VM rather than on separate hosted runners
 * per repeat. That is a real, disclosed tradeoff - a fresh VM per repeat
 * would rule out any warm-cache bias between repeats, at the cost of many
 * times the job count for the same data. Sequential-in-one-VM keeps the
 * workflow small enough to review by eye, and a warm-cache bias would bias
 * toward LATER repeats looking safer, not less safe - the direction this
 * measurement actually cares about (a value that is unsafe) is not the
 * direction that bias could hide.
 *
 * SELECTION RULE over the collected per-value results: report the highest
 * candidate value with zero failures across every repeat AND at least one
 * higher candidate that DID fail, so "safe" is bounded by an observed
 * unsafe point rather than merely being the largest number this run
 * happened to try. A candidate range with no failing member anywhere in it
 * does not establish a boundary and is reported as inconclusive rather than
 * silently upgraded into a recommendation.
 */
import { run } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverTestFiles,
  loadSkipBaseline,
  loadCriticalTests,
  checkSkipDiscipline,
  classifyTestCompletionForSkipDiscipline,
  partitionTestFilesForBatches,
} from "./run-tests.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_DIR = path.join(REPO_ROOT, "test");
// Mirrors run-tests.mjs's own TEST_POLICY_ALLOW_PATH exactly - that
// constant is module-local there, not exported, so it is recomputed here
// rather than imported. See test/helpers/requireSpawnPolicy.ts for why
// every spawn-through-policy test needs this set at all.
const TEST_POLICY_ALLOW_PATH = path.join(REPO_ROOT, "test", "fixtures", "policy-allow.json");

function rel(absPath) {
  return path.relative(REPO_ROOT, absPath);
}

function isFileSyntheticCompletion(data) {
  return data.name === data.file && Object.getPrototypeOf(data) === null;
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const out = {
    concurrencyValues: null,
    repeats: 10,
    testTimeoutMs: 120_000,
    // Per-repeat wall cap - a genuinely hung run at some tested
    // concurrency value is itself a finding (report it), but it must not
    // consume the whole job's timeout-minutes budget and hide every
    // candidate value queued behind it.
    repeatWallCapMs: 300_000,
    label: "run",
    leg: "test",
  };
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (eq === -1) continue;
    const flag = arg.slice(0, eq);
    const val = arg.slice(eq + 1);
    if (flag === "--concurrency-values") {
      out.concurrencyValues = val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number);
    }
    if (flag === "--repeats") out.repeats = Number(val);
    if (flag === "--test-timeout") out.testTimeoutMs = Number(val);
    if (flag === "--repeat-wall-cap") out.repeatWallCapMs = Number(val);
    if (flag === "--label") out.label = val;
    if (flag === "--leg") out.leg = val;
  }
  return out;
}

/**
 * Runs ONE node:test `run()` call over a fixed file list and resolves with
 * its raw pass/fail/skip events - no batching, no wall-cap, no skip-
 * discipline check. Those are runSweepOnce's job, once per batch; this is
 * the single-stream primitive both batches share.
 *
 * @param {{files: string[], concurrency: number | undefined, testTimeoutMs: number}} args
 */
function runOneBatch({ files, concurrency, testTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const passedTests = [];
    const failedTests = [];
    const skipResults = [];

    const stream = run({ files, timeout: testTimeoutMs, concurrency });

    stream.on("test:complete", (data) => {
      const classified = classifyTestCompletionForSkipDiscipline(data);
      if (classified) skipResults.push(classified);
    });
    stream.on("test:pass", (data) => {
      if (data?.file && !isFileSyntheticCompletion(data)) {
        passedTests.push(`${rel(data.file)}::${data.name}`);
      }
    });
    stream.on("test:fail", (data) => {
      if (data?.file && !isFileSyntheticCompletion(data)) {
        failedTests.push(`${rel(data.file)}::${data.name}`);
      }
    });
    // Force flowing mode - matches run-tests.mjs's own stream handling;
    // without a consumer attached to "data" the stream never drains.
    stream.on("data", () => {});
    stream.on("end", () => resolve({ passedTests, failedTests, skipResults }));
    stream.on("error", (err) => reject(err));
  });
}

/**
 * Runs the real suite once at the given node:test `concurrency` value and
 * returns the PASS SET and FAIL SET for that single run, not a collapsed
 * pass/fail boolean - disagreement between repeats at one value is exactly
 * the thing this measurement is trying to catch, and a boolean throws that
 * disagreement away before it can be seen.
 *
 * Two batches, run SEQUENTIALLY, exactly matching run-tests.mjs's own
 * runOnce(): the SERIAL_ONLY_TEST_FILES members alone first (no
 * `concurrency` key at all), then everything else under the requested
 * concurrency. A single `run()` call over every discovered file - what
 * this function did before - measures a configuration the real runner
 * never uses, since the quarantined files would then contend with every
 * other file at every candidate value instead of never sharing a host
 * with anything.
 *
 * @param {{discovered: string[], skipBaseline: object, criticalTests: string[], concurrency: number, testTimeoutMs: number, wallCapMs: number}} args
 */
function runSweepOnce({
  discovered,
  skipBaseline,
  criticalTests,
  concurrency,
  testTimeoutMs,
  wallCapMs,
}) {
  return new Promise((resolve, reject) => {
    // Every spawned test-file child process inherits this via env - same
    // mechanism run-tests.mjs's own main() uses immediately before its own
    // run() call.
    process.env.GHANTIKA_POLICY_FILE = TEST_POLICY_ALLOW_PATH;

    const { serialBatchFiles, concurrentBatchFiles } = partitionTestFilesForBatches(discovered);

    const wallStart = Date.now();
    let timedOut = false;

    const wallCap = setTimeout(() => {
      timedOut = true;
      reject(
        new Error(
          `measure-concurrency-ceiling: repeat wall cap (${wallCapMs}ms) exceeded at concurrency=${concurrency}`
        )
      );
    }, wallCapMs);
    wallCap.unref();

    (async () => {
      const passedTests = [];
      const failedTests = [];
      const skipResults = [];

      // Sequential, matching runOnce()'s own batch ordering: the serial
      // batch never overlaps the concurrent one, since node:test resolves
      // one run() call's "end" event before this awaits the next call.
      if (serialBatchFiles.length > 0) {
        const batch = await runOneBatch({
          files: serialBatchFiles,
          concurrency: undefined,
          testTimeoutMs,
        });
        passedTests.push(...batch.passedTests);
        failedTests.push(...batch.failedTests);
        skipResults.push(...batch.skipResults);
      }
      if (timedOut) return;
      if (concurrentBatchFiles.length > 0) {
        const batch = await runOneBatch({
          files: concurrentBatchFiles,
          concurrency,
          testTimeoutMs,
        });
        passedTests.push(...batch.passedTests);
        failedTests.push(...batch.failedTests);
        skipResults.push(...batch.skipResults);
      }
      if (timedOut) return;

      clearTimeout(wallCap);
      const wallMs = Date.now() - wallStart;
      const skipErrors = checkSkipDiscipline({
        results: skipResults,
        baseline: skipBaseline,
        criticalTests,
        platform: process.platform,
      });
      resolve({
        wallMs,
        passedTests: passedTests.sort(),
        failedTests: failedTests.sort(),
        skipErrors,
      });
    })().catch((err) => {
      if (timedOut) return;
      clearTimeout(wallCap);
      reject(err);
    });
  });
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((x) => bs.has(x));
}

/**
 * Selection rule over the collected per-value results, sorted by ascending
 * concurrency. See this file's header for the rule statement.
 */
function selectRecommendation(perValue) {
  const sorted = [...perValue].sort((a, b) => a.concurrency - b.concurrency);
  const cleanValues = sorted.filter((v) => v.allClean).map((v) => v.concurrency);
  const dirtyValues = sorted.filter((v) => !v.allClean).map((v) => v.concurrency);

  if (cleanValues.length === 0) {
    return {
      verdict: "no-safe-value",
      recommended: null,
      note:
        "Every tested concurrency value produced at least one failure in at least one repeat. " +
        "This runner does not beat serial safely within the tested range - report that as the complete answer.",
    };
  }

  const highestClean = Math.max(...cleanValues);
  const hasFailureAbove = dirtyValues.some((v) => v > highestClean);

  if (!hasFailureAbove) {
    return {
      verdict: "inconclusive-no-ceiling-found",
      recommended: null,
      highestCleanTested: highestClean,
      note:
        `Every tested value up to ${highestClean} was clean and no HIGHER tested value failed, so the ` +
        "unsafe boundary has not actually been observed - the headroom requirement below is not yet " +
        "satisfied. The candidate range needs to extend higher before a recommendation can be shipped.",
    };
  }

  const firstFailureAbove = Math.min(...dirtyValues.filter((v) => v > highestClean));
  return {
    verdict: "recommended",
    recommended: highestClean,
    firstFailureAbove,
    note:
      `concurrency=${highestClean} was clean across every repeat, and concurrency=${firstFailureAbove} ` +
      "failed - the boundary is observed, and the recommendation sits below it with headroom.",
  };
}

async function main() {
  const { concurrencyValues, repeats, testTimeoutMs, repeatWallCapMs, label, leg } = parseArgs(
    process.argv.slice(2)
  );

  if (!concurrencyValues || concurrencyValues.length === 0) {
    console.error("measure-concurrency-ceiling: --concurrency-values=N,N,... is required");
    process.exitCode = 1;
    return;
  }
  if (!concurrencyValues.every((v) => Number.isInteger(v) && v > 0)) {
    console.error(
      `measure-concurrency-ceiling: every concurrency value must be a positive integer, got: ${concurrencyValues.join(",")}`
    );
    process.exitCode = 1;
    return;
  }

  const discovered = discoverTestFiles(TEST_DIR);
  if (discovered.length === 0) {
    // Same "an empty match must be loud" reasoning as run-tests.mjs's own
    // main() - this is a harness fault, not a measurement outcome, and the
    // only condition in this whole script that exits nonzero.
    console.error(
      `measure-concurrency-ceiling: discovered zero test files under ${rel(TEST_DIR)} - aborting`
    );
    process.exitCode = 1;
    return;
  }

  const skipBaseline = loadSkipBaseline();
  const criticalTests = loadCriticalTests();

  console.log(`=== measure-concurrency-ceiling: ${label} (${leg} leg) ===`);
  console.log(
    `discovered ${discovered.length} test file(s); ${repeats} repeat(s) per candidate value`
  );
  console.log(`candidate concurrency values: ${concurrencyValues.join(", ")}`);
  console.log(`per-run --test-timeout: ${testTimeoutMs}ms\n`);

  const perValue = [];

  for (const concurrency of concurrencyValues) {
    const repeatResults = [];
    for (let r = 1; r <= repeats; r++) {
      process.stdout.write(`  concurrency=${concurrency} repeat=${r}/${repeats} ... `);
      let result;
      try {
        result = await runSweepOnce({
          discovered,
          skipBaseline,
          criticalTests,
          concurrency,
          testTimeoutMs,
          wallCapMs: repeatWallCapMs,
        });
      } catch (err) {
        console.log(`ERROR: ${err.message}`);
        result = {
          wallMs: null,
          passedTests: [],
          failedTests: ["<harness error - see message>"],
          skipErrors: [],
          harnessError: err.message,
        };
      }
      const status =
        result.failedTests.length === 0 && result.skipErrors.length === 0 ? "clean" : "FAILED";
      console.log(
        `${status} (${result.wallMs ?? "?"}ms, ${result.passedTests.length} passed, ${result.failedTests.length} failed)`
      );
      repeatResults.push(result);
    }

    const failedSets = repeatResults.map((r) => r.failedTests);
    const allClean = repeatResults.every(
      (r) => r.failedTests.length === 0 && r.skipErrors.length === 0
    );
    const consistentAcrossRepeats = failedSets.every((s) => sameSet(s, failedSets[0]));
    const failedTestUnion = [...new Set(failedSets.flat())].sort();

    perValue.push({
      concurrency,
      repeats: repeatResults,
      allClean,
      consistentAcrossRepeats,
      failedTestUnion,
    });
  }

  const recommendation = selectRecommendation(perValue);

  console.log(`\n=== ${label} (${leg} leg): per-value summary ===`);
  for (const v of perValue) {
    console.log(
      `concurrency=${v.concurrency}: ${v.allClean ? "CLEAN (0 failures, all repeats)" : "FAILED"}` +
        (v.consistentAcrossRepeats ? "" : "  <-- DISAGREEMENT between repeats, see failedTestUnion")
    );
    if (v.failedTestUnion.length > 0) {
      for (const t of v.failedTestUnion) console.log(`    - ${t}`);
    }
  }

  console.log(`\n=== ${label} (${leg} leg): recommendation ===`);
  console.log(JSON.stringify(recommendation, null, 2));

  const report = {
    label,
    leg,
    testTimeoutMs,
    repeats,
    fileCount: discovered.length,
    perValue,
    recommendation,
  };
  console.log(`\n=== ${label} (${leg} leg): full machine-readable report ===`);
  console.log(JSON.stringify(report));

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [];
    lines.push(`## measure-concurrency-ceiling: ${label} (${leg} leg)`);
    lines.push("");
    lines.push(
      `${discovered.length} test files, ${repeats} repeats per candidate, --test-timeout=${testTimeoutMs}ms`
    );
    lines.push("");
    lines.push(
      "| concurrency | clean across all repeats | consistent across repeats | failed tests (union) |"
    );
    lines.push("|---|---|---|---|");
    for (const v of perValue) {
      const failed =
        v.failedTestUnion.length > 0 ? v.failedTestUnion.map((t) => `\`${t}\``).join("<br>") : "-";
      lines.push(
        `| ${v.concurrency} | ${v.allClean ? "yes" : "no"} | ${v.consistentAcrossRepeats ? "yes" : "**no**"} | ${failed} |`
      );
    }
    lines.push("");
    lines.push(
      `**recommendation:** ${recommendation.verdict}` +
        (recommendation.recommended !== null ? ` -> concurrency=${recommendation.recommended}` : "")
    );
    lines.push("");
    lines.push(recommendation.note);
    lines.push("");
    try {
      const fs = await import("node:fs");
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
    } catch (err) {
      console.error(
        `measure-concurrency-ceiling: could not write GITHUB_STEP_SUMMARY: ${err.message}`
      );
    }
  }

  // This is a measurement tool, not a gate: a failure at some candidate
  // concurrency value is the data this script exists to produce, not a
  // reason to fail the job. Only a harness fault (handled above via an
  // early return with process.exitCode = 1) should ever make this job go
  // red - a red job here would misread as "something is broken" when the
  // whole point is finding the value at which something breaks.
  process.exitCode = 0;
}

main().catch((err) => {
  console.error("measure-concurrency-ceiling: unexpected error:", err);
  process.exitCode = 1;
});
