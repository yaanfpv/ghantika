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
import { readGitHeadSha } from "./check-sha-parity.mjs";

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

// Same override pattern, read from the same fallback location
// scripts/run-tests.mjs's own TRUNCATION_MARKER_FALLBACK_PATH writes to when
// the primary marker's own directory could not be written to - see that
// constant's doc comment for why a fallback exists at all, and
// loadTruncationMarker's own doc comment below for how the two are checked
// together.
export const TRUNCATION_MARKER_FALLBACK_PATH =
  process.env.GHANTIKA_TRUNCATION_MARKER_FALLBACK_PATH ??
  path.join(REPO_ROOT, ".run-truncated-fallback.json");

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
 * idle watchdog or wall cap fires, before it force-exits. Checks the
 * PRIMARY location first, then the FALLBACK - run-tests.mjs's own
 * writeTruncationMarkerSync tries the primary path first and only ever
 * falls back to the second when the primary write itself failed, so
 * checking both here is what actually closes that failure mode: a caller
 * that read only the primary path would read "absent" for exactly the
 * scenario where the primary marker directory cannot be written to (e.g.
 * read-only permissions), and report the truncated run's partial coverage
 * numbers as an ordinary verdict. Absence of BOTH is the common case, and
 * read as "the run completed" - never as an error: that is the expected
 * state after every ordinary, complete run (run-tests.mjs's own main()
 * ATTEMPTS TO CLEAR both locations on every successfully parsed run, before
 * test discovery and execution - a best-effort delete that swallows any
 * error, not only ENOENT. A run whose own delete failed can leave a stale
 * marker behind, which this function reads exactly like a fresh truncation
 * and REFUSES on - the safe direction for this particular gap to fail in,
 * since it costs a spurious VOID rather than ever letting a truncated
 * run's numbers read as a real verdict). Absence of BOTH is also what a run
 * whose OWN write of both markers failed looks like - loadCompletionMarker
 * below, and main()'s own use of it, is what closes that remaining gap.
 *
 * @param {string} [filePath]
 * @param {string} [fallbackPath]
 * @returns {{ reason: string, message: string, at: string } | null}
 */
export function loadTruncationMarker(
  filePath = TRUNCATION_MARKER_PATH,
  fallbackPath = TRUNCATION_MARKER_FALLBACK_PATH
) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  try {
    return JSON.parse(readFileSync(fallbackPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Same override pattern as the two constants above, read from the same
// location scripts/run-tests.mjs's own COMPLETION_MARKER_PATH writes to -
// see that constant's own doc comment for the fail-open this closes and
// loadCompletionMarker's own doc comment below for how it is used here.
export const COMPLETION_MARKER_PATH =
  process.env.GHANTIKA_COMPLETION_MARKER_PATH ??
  path.join(REPO_ROOT, "coverage", "run-completed.json");

/**
 * Reads the completion marker scripts/run-tests.mjs writes immediately
 * before a genuinely complete run sets its own exit code - see that
 * constant's own doc comment. Returns null (not a throw) when the file is
 * genuinely absent, mirroring loadTruncationMarker's own ENOENT handling
 * above: a run that never reached its own completion point looks exactly
 * like one whose completion-marker write itself failed, and main()'s own
 * use of this treats both the same way.
 *
 * @param {string} [filePath]
 * @returns {{ headSha: string, at: string } | null}
 */
export function loadCompletionMarker(filePath = COMPLETION_MARKER_PATH) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Same override pattern as the constants above, read from the same
// REPO_ROOT-level location scripts/run-tests.mjs's own RUN_TOKEN_PATH
// writes to - see that constant's own doc comment for the residual gap
// this closes (a stale, same-commit completion marker surviving a later
// run whose own truncation-marker writes also failed) and loadRunToken's
// own doc comment below for how it is used here.
export const RUN_TOKEN_PATH =
  process.env.GHANTIKA_RUN_TOKEN_PATH ?? path.join(REPO_ROOT, ".run-token.json");

/**
 * Reads the per-invocation run token scripts/run-tests.mjs ATTEMPTS TO
 * WRITE, unconditionally, before test discovery and execution on a
 * successfully parsed run of its own main() - see RUN_TOKEN_PATH's own doc
 * comment there for the full mechanism. Returns null (not a throw) when the
 * file is genuinely absent, mirroring loadCompletionMarker's own ENOENT
 * handling immediately above:
 * a token that was never written (main() reached, its own write failed)
 * looks exactly like one that is simply missing, and this script's own
 * main() treats both the same way - VOID.
 *
 * @param {string} [filePath]
 * @returns {{ token: string, at: string } | null}
 */
export function loadRunToken(filePath = RUN_TOKEN_PATH) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The exit code this script (and, by the same convention, any other check
 * that needs to report the identical "ran, but refuses to certify a
 * verdict" state) uses for VOID: a third outcome, distinguishable from both
 * PASS (exit 0) and FAIL (exit 1) by the exit code alone, before a reader
 * ever has to read the printed message. Any caller reading this exit code
 * can classify VOID as an outcome distinct from an ordinary failure.
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
      `  this is VOID, not a pass and not a fail - see ${path.relative(REPO_ROOT, TRUNCATION_MARKER_PATH)} ` +
        `(or its fallback, ${path.relative(REPO_ROOT, TRUNCATION_MARKER_FALLBACK_PATH)}, if the primary ` +
        `location could not be written to). Fix whatever made the run hang (see the run's own console ` +
        `output / :error: diagnostics for which file never completed) and re-run "npm run coverage" to ` +
        `produce a trustworthy summary.`
    );
    process.exitCode = VOID_EXIT_CODE;
    return;
  }

  // The other half of the same signal the truncation-marker check above
  // reads: proof a run actually reached its own completion point, bound to
  // the exact commit it ran against - see COMPLETION_MARKER_PATH's own doc
  // comment for the fail-open this closes (if BOTH of
  // writeTruncationMarkerSync's own writes fail on a genuinely truncated
  // run, the check above finds nothing and falls through to here). A
  // distinct reason from "idle-watchdog"/"wall-cap" - "no-completion-record"
  // - so a reader (and a test) can tell the two VOID causes apart.
  //
  // THIS SHA-BINDING ALONE IS NOT SUFFICIENT: it defends against a
  // completion marker left over from a DIFFERENT commit, but on its own it
  // cannot defend against the narrower three-way conjunction where (1) a
  // previous run at THIS SAME commit already completed successfully and
  // left a valid completion marker, (2) a LATER run at that identical
  // commit is truncated, and (3) both of THAT run's own truncation-marker
  // writes also fail. The truncation-marker check above runs FIRST, so if
  // either of those two writes had succeeded, that alone would VOID
  // regardless of whatever completion marker is sitting underneath it -
  // this gap is reachable only when truncation-marker persistence has also
  // failed. A truncated run must never produce a coverage verdict, however
  // narrow the path to it: the run-token check immediately below adds a
  // SECOND, wholly independent binding - not to the commit, which a stale
  // same-commit marker trivially satisfies, but to the exact INVOCATION of
  // run-tests.mjs that produced the completion marker. See RUN_TOKEN_PATH's
  // own doc comment in scripts/run-tests.mjs for the full mechanism.
  const completion = loadCompletionMarker();
  // Matches scripts/run-tests.mjs's own degrade path for the identical
  // condition: a git-less environment (no .git at all, e.g. a mount-none
  // clone that ships only tracked file CONTENT) makes this call throw,
  // exactly like the read run-tests.mjs performs when it writes the
  // completion marker in the first place.
  let currentHeadSha;
  try {
    currentHeadSha = readGitHeadSha();
  } catch {
    currentHeadSha = null;
  }
  if (currentHeadSha === null) {
    if (completion && completion.headSha === null) {
      // Both ends of the binding agree git was unavailable when they ran -
      // this specific check is UNSCANNED, disclosed as such, never
      // silently treated as a match. The run-token check just below is
      // git-independent and still enforced, so a truncated or stale run
      // is still caught by it.
      console.error(
        "coverage floor check: git unavailable - the completion marker's headSha binding is " +
          "UNSCANNED this run; the run-token binding below still applies"
      );
    } else {
      // git is unavailable HERE, but the completion marker either claims
      // a real commit or is absent - neither can be verified against an
      // unreadable current checkout, so this degrades to VOID rather than
      // guessing in either direction.
      console.error(
        `coverage floor check: REFUSED - git is unavailable here, so the completion marker's ` +
          `headSha (${completion ? JSON.stringify(completion.headSha) : "absent - no completion record"}) ` +
          `cannot be verified against the current checkout.`
      );
      console.error(
        `  this is VOID, not a pass and not a fail [no-git-headsha-verification] - see ` +
          `${path.relative(REPO_ROOT, COMPLETION_MARKER_PATH)}.`
      );
      process.exitCode = VOID_EXIT_CODE;
      return;
    }
  } else if (!completion || completion.headSha !== currentHeadSha) {
    console.error(
      `coverage floor check: REFUSED - no valid completion record for the current checkout ` +
        `(head ${currentHeadSha}). Either the run never reached its own completion point (it may ` +
        `have been truncated and both the truncation-marker writes also failed), or the completion ` +
        `record on disk belongs to a different commit.`
    );
    console.error(
      `  this is VOID, not a pass and not a fail [no-completion-record] - see ` +
        `${path.relative(REPO_ROOT, COMPLETION_MARKER_PATH)}. Re-run "npm run coverage" to produce a ` +
        `trustworthy, current completion record.`
    );
    process.exitCode = VOID_EXIT_CODE;
    return;
  }

  // Closes the residual the headSha check above cannot on its own: a
  // completion marker whose headSha DOES match the current checkout can
  // still be a STALE record from a PRIOR successful run at this exact same
  // commit, surviving because a LATER run's own truncation-marker writes
  // (both the primary and its fallback) also failed. scripts/run-tests.mjs
  // generates a fresh, per-invocation token, independent of git HEAD
  // entirely, before test discovery and execution on a successfully parsed
  // run of its own main(), and ATTEMPTS to write it to RUN_TOKEN_PATH -
  // embedding the exact in-memory value into the completion marker only if
  // THAT SAME invocation reaches genuine completion. Closure here does not
  // rest on that write succeeding: a completion marker whose embedded
  // runToken does not match the token found on disk RIGHT NOW cannot be
  // trusted as evidence that the CURRENT invocation of run-tests.mjs
  // completed, for either of two reasons - it is a stale record embedding
  // an earlier invocation's token, or this invocation's own token write
  // failed and nothing legitimate is on disk to compare against - and both
  // are VOID, never a silent fall-through to an ordinary verdict. The
  // guarantee is in the CHECK being fail-closed on a mismatch or an
  // absence, not in any assumption that the write always lands.
  const currentToken = loadRunToken();
  if (!currentToken || completion.runToken !== currentToken.token) {
    console.error(
      `coverage floor check: REFUSED - the completion record's embedded run token does not match this ` +
        `invocation's own current token (head ${currentHeadSha}). The completion record cannot be trusted ` +
        `as evidence that THIS invocation of "npm run coverage" completed - it may be a stale record left ` +
        `over from an earlier, genuinely successful run at this same commit, surviving because a later ` +
        `run's own truncation-marker writes also failed, or the run-token write itself may have failed.`
    );
    console.error(
      `  this is VOID, not a pass and not a fail [stale-completion-token] - see ` +
        `${path.relative(REPO_ROOT, RUN_TOKEN_PATH)}. Re-run "npm run coverage" to produce a trustworthy, ` +
        `current completion record.`
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
