#!/usr/bin/env node
/**
 * Temporary measurement scaffolding, NOT the production test runner and
 * not meant to survive past the follow-up PR that lands the value this
 * script measures (see the workflow file that invokes this script for the
 * removal note). It exists to answer one question with real data: what
 * file-concurrency value can each GitHub-hosted runner (ubuntu-latest,
 * macos-latest) sustain, on its own hardware, before this repo's
 * process-spawning tests start losing their wall-clock race.
 *
 * WHICH JOB THIS MIRRORS, AND WHY IT MATTERS: this repo's CI runs the test
 * suite through two structurally different paths. The `coverage` job
 * wraps scripts/run-tests.mjs in c8, which - per that file's own header
 * comment - forces a single concurrent file regardless of any concurrency
 * value passed to node:test's run(); measuring concurrency through that
 * path always reports a flat, meaningless result. The `test` job (the
 * os x node matrix in ci.yml) runs `node scripts/run-tests.mjs
 * --test-timeout=120000` directly, with no c8 wrapper at all - that is the
 * only path where file concurrency changes anything, and it is the path
 * this script reproduces: same discovery, same skip-baseline and
 * critical-test machinery, same GHANTIKA_POLICY_FILE setup, same
 * --test-timeout default, no coverage instrumentation anywhere in this
 * process. Confirmed by reading GHANTIKA_JUNIT's env in ci.yml directly
 * rather than assumed - see .github/workflows/measure-hosted-concurrency.yml
 * for which job this is dispatched from.
 *
 * It imports run-tests.mjs's own exported discovery/skip-baseline
 * functions rather than re-deriving them, and never modifies that file -
 * this pass is measurement only; the value it produces lands in a later
 * change, once a separate in-flight change that also touches ci.yml and
 * run-tests.mjs has merged (landing both together would collide on the
 * same files), that wires the measured value into ci.yml and
 * run-tests.mjs directly and states it explicitly rather than reading it
 * off `process.env.CI`.
 *
 * SELECTION RULE this script's aggregation implements (mirrors the local
 * 8-core measurement that produced "4, not 8" for local dev): ship the
 * highest candidate value with zero failures across every repeat AND at
 * least one higher candidate that DID fail, so "safe" is bounded by an
 * observed unsafe point rather than merely being the largest number this
 * run happened to try. A candidate range with no failing member anywhere
 * in it does not establish a boundary and is reported as inconclusive
 * rather than silently upgraded into a recommendation.
 *
 * WHAT COUNTS AS "A RUN" HERE: three repeats of the same concurrency value
 * run sequentially inside one job/VM rather than on three separate hosted
 * runners. That is a real, disclosed tradeoff - a fresh VM per repeat
 * would rule out any warm-cache bias between repeats, at the cost of
 * roughly 3x the job count for the same data. Sequential-in-one-VM was
 * chosen for a first measurement pass because it keeps the workflow small
 * enough to review by eye, and because a warm-cache bias would bias
 * TOWARD later repeats looking safer, not less safe - the failure
 * direction this measurement cares about (a value that is unsafe) is not
 * the direction that bias could hide.
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
} from "./run-tests.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_DIR = path.join(REPO_ROOT, "test");
// Mirrors run-tests.mjs's own TEST_POLICY_ALLOW_PATH exactly (that
// constant is module-local there, not exported, so it is recomputed here
// rather than imported - see test/helpers/requireSpawnPolicy.ts for why
// every spawn-through-policy test needs this set at all).
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
    repeats: 3,
    testTimeoutMs: 120_000,
    // Per-repeat wall cap - a genuinely hung run at some tested
    // concurrency value is itself a finding (report it), but it must not
    // consume the whole job's timeout-minutes budget and hide every
    // candidate value queued behind it.
    repeatWallCapMs: 300_000,
    label: "run",
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
  }
  return out;
}

/**
 * Runs the real suite once at the given node:test `concurrency` value and
 * returns the PASS SET and FAIL SET for that single run, not a collapsed
 * pass/fail boolean - disagreement between repeats at one value is
 * exactly the thing this measurement is trying to catch, and a boolean
 * throws that disagreement away before it can be seen.
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
    // mechanism run-tests.mjs's own main() uses immediately before its
    // own run() call.
    process.env.GHANTIKA_POLICY_FILE = TEST_POLICY_ALLOW_PATH;

    const wallStart = Date.now();
    const passedTests = [];
    const failedTests = [];
    const skipResults = [];
    let timedOut = false;

    const wallCap = setTimeout(() => {
      timedOut = true;
      reject(
        new Error(
          `measure-hosted-concurrency: repeat wall cap (${wallCapMs}ms) exceeded at concurrency=${concurrency}`
        )
      );
    }, wallCapMs);
    wallCap.unref();

    const stream = run({ files: discovered, timeout: testTimeoutMs, concurrency });

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
    stream.on("end", () => {
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
    });
    stream.on("error", (err) => {
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
 * Selection rule over the collected per-value results, sorted by
 * ascending concurrency. See this file's header for the rule statement.
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
  const { concurrencyValues, repeats, testTimeoutMs, repeatWallCapMs, label } = parseArgs(
    process.argv.slice(2)
  );

  if (!concurrencyValues || concurrencyValues.length === 0) {
    console.error("measure-hosted-concurrency: --concurrency-values=N,N,... is required");
    process.exitCode = 1;
    return;
  }
  if (!concurrencyValues.every((v) => Number.isInteger(v) && v > 0)) {
    console.error(
      `measure-hosted-concurrency: every concurrency value must be a positive integer, got: ${concurrencyValues.join(",")}`
    );
    process.exitCode = 1;
    return;
  }

  const discovered = discoverTestFiles(TEST_DIR);
  if (discovered.length === 0) {
    // Same "an empty match must be loud" reasoning as run-tests.mjs's own
    // main() - this is a harness fault, not a measurement outcome, and
    // the only condition in this whole script that exits nonzero.
    console.error(
      `measure-hosted-concurrency: discovered zero test files under ${rel(TEST_DIR)} - aborting`
    );
    process.exitCode = 1;
    return;
  }

  const skipBaseline = loadSkipBaseline();
  const criticalTests = loadCriticalTests();

  console.log(`=== measure-hosted-concurrency: ${label} ===`);
  console.log(
    `discovered ${discovered.length} test file(s); ${repeats} repeat(s) per candidate value`
  );
  console.log(`candidate concurrency values: ${concurrencyValues.join(", ")}`);
  console.log(`per-run --test-timeout: ${testTimeoutMs}ms (matches ci.yml's real test job flag)\n`);

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

  console.log(`\n=== ${label}: per-value summary ===`);
  for (const v of perValue) {
    console.log(
      `concurrency=${v.concurrency}: ${v.allClean ? "CLEAN (0 failures, all repeats)" : "FAILED"}` +
        (v.consistentAcrossRepeats ? "" : "  <-- DISAGREEMENT between repeats, see failedTestUnion")
    );
    if (v.failedTestUnion.length > 0) {
      for (const t of v.failedTestUnion) console.log(`    - ${t}`);
    }
  }

  console.log(`\n=== ${label}: recommendation ===`);
  console.log(JSON.stringify(recommendation, null, 2));

  const report = {
    label,
    testTimeoutMs,
    repeats,
    fileCount: discovered.length,
    perValue,
    recommendation,
  };
  console.log(`\n=== ${label}: full machine-readable report ===`);
  console.log(JSON.stringify(report));

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [];
    lines.push(`## measure-hosted-concurrency: ${label}`);
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
        `measure-hosted-concurrency: could not write GITHUB_STEP_SUMMARY: ${err.message}`
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
  console.error("measure-hosted-concurrency: unexpected error:", err);
  process.exitCode = 1;
});
