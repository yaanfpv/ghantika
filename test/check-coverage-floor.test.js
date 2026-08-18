import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COVERAGE_FLOORS,
  TRUNCATION_MARKER_FALLBACK_PATH,
  VOID_EXIT_CODE,
  checkCoverageFloors,
  loadTruncationMarker,
} from "../scripts/check-coverage-floor.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/check-coverage-floor.mjs", import.meta.url));
const RUN_TESTS_SCRIPT_PATH = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The tests below drive scripts/run-tests.mjs's own runOnce() against a
 * deliberately hanging fixture, in a spawned "driver" script, to force a
 * real idle-watchdog termination. The driver process's own process.exit(1)
 * (run-tests.mjs's own onIdleTimeout, see that file's header comment) does
 * NOT reap the hanging fixture's own OS process: node:test's isolation:
 * 'process' default spawns the fixture file as its own child of the driver,
 * and a parent's process.exit() does not kill its children - they simply
 * reparent to init, still running. Every driver spawn below is therefore
 * `detached: true`, making the driver the leader of its own process group
 * (pgid === its own pid), so the whole group - driver plus whatever
 * grandchild it left running - can be reaped by signalling the NEGATIVE
 * pid, the same technique test/loader-escape-matrix.test.ts's own
 * reapSupervisorProcessGroup already establishes for the identical shape of
 * problem. POSIX only, matching that function's own win32 no-op: `detached`
 * establishes no process-group leadership there.
 *
 * @param {number | undefined} pid
 */
function reapDriverProcessGroup(pid) {
  if (process.platform === "win32" || typeof pid !== "number") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH (nothing left - the common, healthy case) or EPERM; either way
    // there is nothing further this cleanup sweep can do.
  }
}

/**
 * @param {number} pid
 * @returns {number[]} every real pid currently in the process group led by
 *   `pid` - a genuine external observation via `pgrep -g`, never this
 *   file's own bookkeeping.
 */
function processGroupMembers(pid) {
  try {
    const output = execFileSync("pgrep", ["-g", String(pid)], { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(Number);
  } catch (err) {
    if (err.status === 1) return []; // pgrep's own "nothing matched" exit code
    throw err;
  }
}

/**
 * Best-effort, guaranteed cleanup for the driver scripts below - meant to
 * be called from a `finally`, which is why it never throws or asserts: a
 * throw inside `finally` would replace whatever real assertion failure
 * sent execution there in the first place, masking it. Reaps the whole
 * process group led by `pid`, then confirms (logs, never asserts) that
 * nothing outlives a short poll window.
 *
 * @param {number | undefined} pid
 */
async function reapAndConfirmGone(pid) {
  if (process.platform === "win32" || typeof pid !== "number") return;
  reapDriverProcessGroup(pid);
  const deadline = Date.now() + 3000;
  let members = processGroupMembers(pid);
  while (members.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    members = processGroupMembers(pid);
  }
  if (members.length > 0) {
    console.error(
      `reapAndConfirmGone: process group ${pid} still has member(s) after the guaranteed reap: ${JSON.stringify(members)}`
    );
  }
}

/**
 * @param {string} [cwd]
 * @returns {string} `git rev-parse HEAD`, trimmed
 */
function gitHeadSha(cwd = REPO_ROOT) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

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

// The token every DEFAULT completion marker below embeds, matched by the
// DEFAULT run-token file runCliAgainstFixture also writes - see that
// function's own doc comment for why both defaults have to agree now that
// check-coverage-floor.mjs requires a matching token alongside a
// SHA-matching completion marker.
const DEFAULT_FIXTURE_RUN_TOKEN = "fixture-run-token";

/**
 * Runs the script's actual CLI entry point (not just checkCoverageFloors
 * above) as a real child process, pointed at a throwaway fixture file via
 * the GHANTIKA_COVERAGE_SUMMARY_PATH override the script honors, and
 * returns its exit code AND captured stdout+stderr without letting a
 * non-zero exit throw past this helper.
 *
 * @param {string | undefined} summaryContent omit to simulate a missing file
 * @param {{ markerContent?: string, completionMarkerContent?: string, omitCompletionMarker?: boolean }} [opts]
 *   `markerContent`, if given, is written to a throwaway file and pointed
 *   at via GHANTIKA_TRUNCATION_MARKER_PATH - omitted means the env var is
 *   left unset, so the script falls back to its own real default
 *   TRUNCATION_MARKER_PATH (coverage/run-truncated.json, in THIS repo),
 *   which every test below that does not pass markerContent relies on
 *   being absent - true in a clean checkout, and restored by the
 *   real-end-to-end test further down via its own explicit cleanup.
 *
 *   By DEFAULT (neither completionMarkerContent nor omitCompletionMarker
 *   given), a valid completion marker bound to the REAL current HEAD SHA,
 *   embedding DEFAULT_FIXTURE_RUN_TOKEN, is written and pointed at via
 *   GHANTIKA_COMPLETION_MARKER_PATH - and a matching run-token file,
 *   holding that SAME token, is written and pointed at via
 *   GHANTIKA_RUN_TOKEN_PATH - matching the ordinary production state
 *   (scripts/run-tests.mjs already wrote a real, matching pair before this
 *   script ever runs) so every test below NOT specifically exercising the
 *   completion-marker or run-token mechanism itself keeps testing whatever
 *   it actually tests (a floor comparison, a missing summary file, the
 *   truncation-marker VOID path) instead of universally VOIDing on
 *   no-completion-record or stale-completion-token now that both a
 *   SHA-matching marker AND a matching token are required.
 *   `completionMarkerContent` overrides the completion-marker default with
 *   an explicit, custom marker (a stale-commit scenario, for example) -
 *   the run-token file is still written with DEFAULT_FIXTURE_RUN_TOKEN
 *   regardless, since every existing caller of this override is exercising
 *   the headSha check, which VOIDs before the token check is ever reached;
 *   `omitCompletionMarker: true` points GHANTIKA_COMPLETION_MARKER_PATH at
 *   a path that does not exist, so no completion marker is present at all
 *   - both used by the completion-marker-specific tests further down.
 * @returns {{ status: number, output: string }}
 */
function runCliAgainstFixture(summaryContent, opts = {}) {
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
    if (opts.markerContent !== undefined) {
      const markerPath = path.join(dir, "run-truncated.json");
      writeFileSync(markerPath, opts.markerContent);
      env.GHANTIKA_TRUNCATION_MARKER_PATH = markerPath;
    }

    // Always written, regardless of which completion-marker branch below
    // runs: every completion-marker override in this file's own tests
    // (a different-commit headSha, an omitted marker entirely) VOIDs on
    // the headSha check BEFORE the token check is ever reached, so this
    // default token file is harmless to those cases and load-bearing for
    // every other test that relies on an ordinary, SHA-matching marker
    // proceeding to a real verdict.
    const runTokenPath = path.join(dir, "run-token.json");
    writeFileSync(runTokenPath, JSON.stringify({ token: DEFAULT_FIXTURE_RUN_TOKEN }, null, 2));
    env.GHANTIKA_RUN_TOKEN_PATH = runTokenPath;

    const completionMarkerPath = path.join(dir, "run-completed.json");
    if (opts.completionMarkerContent !== undefined) {
      writeFileSync(completionMarkerPath, opts.completionMarkerContent);
      env.GHANTIKA_COMPLETION_MARKER_PATH = completionMarkerPath;
    } else if (opts.omitCompletionMarker) {
      env.GHANTIKA_COMPLETION_MARKER_PATH = path.join(dir, "does-not-exist-completion.json");
    } else {
      writeFileSync(
        completionMarkerPath,
        JSON.stringify(
          {
            headSha: gitHeadSha(),
            at: new Date().toISOString(),
            runToken: DEFAULT_FIXTURE_RUN_TOKEN,
          },
          null,
          2
        )
      );
      env.GHANTIKA_COMPLETION_MARKER_PATH = completionMarkerPath;
    }

    try {
      const output = execFileSync(process.execPath, [SCRIPT_PATH], { env, encoding: "utf8" });
      return { status: 0, output };
    } catch (err) {
      return {
        status: typeof err.status === "number" ? err.status : 1,
        output: (err.stdout ?? "") + (err.stderr ?? ""),
      };
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
  assert.equal(runCliAgainstFixture(JSON.stringify(summary)).status, 0);
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
  assert.notEqual(runCliAgainstFixture(JSON.stringify(summary)).status, 0);
});

test("mutation control: CLI exits non-zero when the summary file is missing, not a silent pass", () => {
  assert.notEqual(runCliAgainstFixture(undefined).status, 0);
});

// =============================================================================
// VOID: a truncated run must not produce a coverage verdict, and the
// refusal must be a THIRD, distinguishable outcome - never silently PASS,
// never indistinguishable from an ordinary content-based FAIL. The three
// tests below drive the real CLI via GHANTIKA_TRUNCATION_MARKER_PATH; the
// fourth is a real end-to-end negative control - a genuine idle-watchdog
// fire from scripts/run-tests.mjs's own runOnce(), through to the real
// refusal, then restored to a real verdict.
// =============================================================================

test("VOID: a present truncation marker makes the CLI refuse and exit VOID_EXIT_CODE, distinct from 0 and 1", () => {
  assert.equal(
    VOID_EXIT_CODE,
    2,
    "sanity: this test's other assertions assume the documented value"
  );
  const summary = summaryWith(
    Object.fromEntries(
      Object.entries(COVERAGE_FLOORS).map(([metric, floor]) => [metric, floor + 10])
    )
  );
  const { status, output } = runCliAgainstFixture(JSON.stringify(summary), {
    markerContent: JSON.stringify({
      reason: "idle-watchdog",
      message: "test fixture",
      at: "2026-01-01T00:00:00.000Z",
    }),
  });
  assert.equal(status, VOID_EXIT_CODE);
  assert.notEqual(status, 0, "VOID must never read as PASS");
  assert.notEqual(status, 1, "VOID must never collapse into the ordinary FAIL exit code");
  assert.ok(
    output.includes("REFUSED"),
    `expected the refusal to be named explicitly, got: ${output}`
  );
  assert.ok(
    output.includes("idle-watchdog"),
    `expected the marker's own reason to be surfaced, got: ${output}`
  );
});

test("VOID takes priority even when the summary underneath would otherwise fail its floor - refusal, not a coincidental FAIL", () => {
  const summary = summaryWith(
    Object.fromEntries(
      Object.entries(COVERAGE_FLOORS).map(([metric, floor]) => [metric, floor - 50])
    )
  );
  const { status, output } = runCliAgainstFixture(JSON.stringify(summary), {
    markerContent: JSON.stringify({
      reason: "wall-cap",
      message: "test fixture",
      at: "2026-01-01T00:00:00.000Z",
    }),
  });
  assert.equal(
    status,
    VOID_EXIT_CODE,
    "a present marker must refuse BEFORE ever comparing the summary, regardless of what it would have said"
  );
  assert.ok(
    !output.includes("below the"),
    `must never print a floor-comparison message once VOID - got: ${output}`
  );
});

test("no marker present: the CLI falls through to an ordinary verdict, unaffected by the VOID path", () => {
  const summary = summaryWith(
    Object.fromEntries(
      Object.entries(COVERAGE_FLOORS).map(([metric, floor]) => [metric, floor + 10])
    )
  );
  const { status } = runCliAgainstFixture(JSON.stringify(summary));
  assert.equal(status, 0);
});

test("loadTruncationMarker returns null (not a throw) when the file is genuinely absent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-coverage-floor-marker-"));
  try {
    assert.equal(loadTruncationMarker(path.join(dir, "does-not-exist.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A negative control: force a truncated run via a deliberately hanging
// fixture file and a lowered idleTimeoutMs, driving production runOnce()
// from scripts/run-tests.mjs in its own child process (its termination
// path calls process.exit(1), which would kill this test process too if
// imported and called in-process). The marker is written by run-tests.mjs
// itself; the check-coverage-floor.mjs CLI then refuses on it, and after
// restoring (deleting the marker) the CLI reports a verdict again. This
// exercises the whole VOID mechanism end to end.
test("an idle-watchdog fire produces VOID; restoring produces a verdict again", async () => {
  const scratchDir = mkdtempSync(path.join(tmpdir(), "ghantika-void-e2e-"));
  const markerPath = path.join(REPO_ROOT, "coverage", "run-truncated.json");
  const hadPriorMarker = existsSync(markerPath);
  const priorMarkerContent = hadPriorMarker ? readFileSync(markerPath, "utf8") : null;
  let driverPid;
  try {
    rmSync(markerPath, { force: true });

    // The pending promise alone is not enough: node:test's own runtime
    // detects an unsettled promise once nothing else is keeping the event
    // loop alive and cancels the test itself, well under this test's own
    // idleTimeoutMs - confirmed on node 22.23.2, where that self-cancel
    // fires in ~3.5ms with "Promise resolution is still pending but the
    // event loop has already resolved" and produces a fast, marker-less
    // exit that looks identical to this control never having exercised the
    // idle-watchdog path at all. The uncleared interval keeps a real handle
    // alive so the only way this ever terminates is run-tests.mjs's own
    // idle-watchdog, on every Node version.
    const hangingFile = path.join(scratchDir, "hangs.test.mjs");
    writeFileSync(
      hangingFile,
      `import { test } from "node:test";\n` +
        `test("never resolves", () => new Promise(() => { setInterval(() => {}, 1_000_000); }));\n`
    );

    const driverPath = path.join(scratchDir, "drive.mjs");
    writeFileSync(
      driverPath,
      `import { runOnce } from ${JSON.stringify(RUN_TESTS_SCRIPT_PATH)};\n` +
        `await runOnce({\n` +
        `  discovered: [${JSON.stringify(hangingFile)}],\n` +
        `  tracked: null,\n` +
        `  junitPath: null,\n` +
        `  options: { testTimeoutMs: 60000, idleTimeoutMs: 400, wallTimeoutMs: 60000, leakWindowMs: 5000 },\n` +
        `  skipBaseline: {},\n` +
        `  criticalTests: [],\n` +
        `  completionMarkerPath: ${JSON.stringify(path.join(scratchDir, "unused-completion-marker.json"))},\n` +
        `});\n`
    );

    // This test file itself runs under an outer `node --test`, which sets
    // NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID and, being ordinary env vars,
    // they would otherwise be inherited by this child driver process too -
    // making ITS OWN run() call think it is a recursive re-entry and skip
    // running the hanging file entirely (node:test's own documented
    // recursion guard - the exact mechanism
    // test/loader-escape-matrix.test.ts's runPermanentGuardSuite already
    // has to strip for its own nested spawnSync, see that function's own
    // doc comment). Stripped here for the identical reason.
    const driverEnv = { ...process.env };
    delete driverEnv.NODE_TEST_CONTEXT;
    delete driverEnv.NODE_TEST_WORKER_ID;

    // spawnSync (not execFileSync) so the driver's own pid is available for
    // reapAndConfirmGone below - `detached: true` makes it the leader of
    // its own process group, the same reason and the same technique
    // reapDriverProcessGroup's own doc comment describes above. The
    // driver's own onIdleTimeout calls process.exit(1) without reaping
    // whatever node:test's internal run() spawned for the hanging fixture
    // file - that grandchild survives the driver's own exit, still running
    // its setInterval, unless this test reaps the whole group itself.
    const driverResult = spawnSync(process.execPath, [driverPath], {
      cwd: REPO_ROOT,
      env: driverEnv,
      encoding: "utf8",
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    driverPid = driverResult.pid;
    const driverExit = driverResult.status;
    const driverOutput = (driverResult.stdout ?? "") + (driverResult.stderr ?? "");
    assert.equal(
      driverExit,
      1,
      `run-tests.mjs's own idle-watchdog path must still exit 1 - unchanged by adding the truncation marker; driver output:\n${driverOutput}`
    );

    assert.ok(
      existsSync(markerPath),
      `runOnce()'s own idle-watchdog path must have written the real marker file; driver output:\n${driverOutput}`
    );
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.equal(marker.reason, "idle-watchdog");

    let floorStatus = null;
    let floorOutput = "";
    try {
      floorOutput = execFileSync(process.execPath, [SCRIPT_PATH], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      floorStatus = 0;
    } catch (err) {
      floorStatus = err.status ?? null;
      floorOutput = (err.stdout ?? "") + (err.stderr ?? "");
    }
    assert.equal(
      floorStatus,
      VOID_EXIT_CODE,
      `expected the real CLI to refuse VOID against the real marker it just wrote; output: ${floorOutput}`
    );
    assert.ok(floorOutput.includes("REFUSED"));

    // RESTORE: clear the marker, confirm a REAL VERDICT is produced again -
    // not merely that VOID/REFUSED is absent, which an unrelated failure
    // (this repo's own coverage/coverage-summary.json need not exist, or
    // need not already clear every floor, at the moment this test runs)
    // would also satisfy: a missing summary file exits 1 with neither
    // VOID_EXIT_CODE nor the string "REFUSED" anywhere in its output,
    // passing both of the assertions this block used to make without a
    // floor comparison ever happening. Point the restored run at a
    // controlled, synthetic, comfortably-above-every-floor summary via the
    // same GHANTIKA_COVERAGE_SUMMARY_PATH override runCliAgainstFixture
    // uses everywhere else in this file, then assert both the exact
    // success exit code and the exact success message the script only
    // prints once it has actually compared real numbers against every
    // floor and found them all clear - proving a verdict was produced, not
    // just that a refusal was avoided.
    rmSync(markerPath, { force: true });
    const restoredSummary = summaryWith(
      Object.fromEntries(
        Object.entries(COVERAGE_FLOORS).map(([metric, floor]) => [metric, floor + 10])
      )
    );
    const { status: restoredStatus, output: restoredOutput } = runCliAgainstFixture(
      JSON.stringify(restoredSummary)
    );
    assert.equal(
      restoredStatus,
      0,
      `restoring must produce a real PASS verdict against the synthetic above-floor summary, not merely avoid VOID; output: ${restoredOutput}`
    );
    assert.ok(
      restoredOutput.includes("every coverage metric is at or above its configured floor"),
      `restored run must print the real success verdict, not just any exit-0 output; output: ${restoredOutput}`
    );
    assert.ok(
      !restoredOutput.includes("REFUSED"),
      `restored run must not still be refusing; output: ${restoredOutput}`
    );
  } finally {
    // Guaranteed cleanup, on every path: reaps the driver's own process
    // group (its own onIdleTimeout does not reap the hanging fixture's OS
    // process itself - see the block comment above reapDriverProcessGroup)
    // so a thrown assertion above can never leave it running.
    await reapAndConfirmGone(driverPid);
    rmSync(scratchDir, { recursive: true, force: true });
    rmSync(markerPath, { force: true });
    if (hadPriorMarker) writeFileSync(markerPath, priorMarkerContent);
  }
});

// =============================================================================
// Fail-open: a genuinely truncated run must produce VOID even when its
// primary truncation-marker location cannot be written to. Before this fix,
// an unwritable primary marker directory (chmod'd read-only, with a genuine
// idle-watchdog fire on top) meant writeTruncationMarkerSync's write failure
// was only logged - the marker never landed anywhere - so
// loadTruncationMarker() found nothing and check-coverage-floor.mjs reported
// the truncated run's partial coverage numbers as an ordinary verdict. The
// two tests below drive the real CLI and the real runOnce() end to end,
// exactly like the idle-watchdog control above, but with the primary marker
// directory deliberately locked down first.
// =============================================================================

test("sanity: the real production fallback path lives at REPO_ROOT, not under coverage/", () => {
  // REPO_ROOT (from fileURLToPath on a URL directory) carries a trailing
  // separator; path.dirname() never does - trim before comparing.
  assert.equal(path.dirname(TRUNCATION_MARKER_FALLBACK_PATH) + path.sep, REPO_ROOT);
  assert.equal(path.basename(TRUNCATION_MARKER_FALLBACK_PATH), ".run-truncated-fallback.json");
});

test("fail-open: an unwritable primary marker directory still produces VOID, via the fallback location", async () => {
  const scratchDir = mkdtempSync(path.join(tmpdir(), "ghantika-ac1-failclosed-"));
  const unwritableDir = path.join(scratchDir, "locked-coverage");
  mkdirSync(unwritableDir, { recursive: true });
  const primaryMarkerPath = path.join(unwritableDir, "run-truncated.json");
  const fallbackMarkerPath = path.join(scratchDir, "fallback-marker.json");
  let driverPid;
  try {
    // Lock the primary marker's own directory down AFTER creating it -
    // reproducing the unwritable-coverage-directory scenario (chmod
    // coverage/ to 0500) rather than a directory that never existed, which
    // would exercise mkdirSync's own ENOENT/EACCES on the parent instead of
    // writeFileSync's on the file itself. 0500 = read + execute (list +
    // traverse) but not write.
    chmodSync(unwritableDir, 0o500);

    const hangingFile = path.join(scratchDir, "hangs.test.mjs");
    writeFileSync(
      hangingFile,
      `import { test } from "node:test";\n` +
        `test("never resolves", () => new Promise(() => { setInterval(() => {}, 1_000_000); }));\n`
    );

    const driverPath = path.join(scratchDir, "drive.mjs");
    writeFileSync(
      driverPath,
      `import { runOnce } from ${JSON.stringify(RUN_TESTS_SCRIPT_PATH)};\n` +
        `await runOnce({\n` +
        `  discovered: [${JSON.stringify(hangingFile)}],\n` +
        `  tracked: null,\n` +
        `  junitPath: null,\n` +
        `  options: { testTimeoutMs: 60000, idleTimeoutMs: 400, wallTimeoutMs: 60000, leakWindowMs: 5000 },\n` +
        `  skipBaseline: {},\n` +
        `  criticalTests: [],\n` +
        `  truncationMarkerPath: ${JSON.stringify(primaryMarkerPath)},\n` +
        `  truncationMarkerFallbackPath: ${JSON.stringify(fallbackMarkerPath)},\n` +
        `  completionMarkerPath: ${JSON.stringify(path.join(scratchDir, "unused-completion-marker.json"))},\n` +
        `});\n`
    );

    // Same recursion-guard strip as the idle-watchdog control above - see
    // its own comment for why.
    const driverEnv = { ...process.env };
    delete driverEnv.NODE_TEST_CONTEXT;
    delete driverEnv.NODE_TEST_WORKER_ID;

    // spawnSync (not execFileSync) so the driver's own pid is available for
    // reapAndConfirmGone below - see reapDriverProcessGroup's own doc
    // comment for why this matters.
    const driverResult = spawnSync(process.execPath, [driverPath], {
      cwd: REPO_ROOT,
      env: driverEnv,
      encoding: "utf8",
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    driverPid = driverResult.pid;
    const driverExit = driverResult.status;
    const driverOutput = (driverResult.stdout ?? "") + (driverResult.stderr ?? "");
    assert.equal(
      driverExit,
      1,
      `the idle-watchdog path must still exit 1 even when its primary marker write fails; driver output:\n${driverOutput}`
    );

    // The primary write must have genuinely FAILED and been reported by
    // name - not silently skipped, not silently succeeded despite the
    // chmod. This control is void (proves nothing about the fix) if the
    // directory turned out writable after all.
    assert.ok(
      driverOutput.includes("failed to write truncation marker") &&
        driverOutput.includes(primaryMarkerPath),
      `expected the primary write's own failure to be reported by name; driver output:\n${driverOutput}`
    );
    assert.ok(
      !existsSync(primaryMarkerPath),
      "the primary marker path must genuinely not exist - a real write failure, not a partial one"
    );

    // THE FIX: the fallback write must have landed, and been reported.
    assert.ok(
      existsSync(fallbackMarkerPath),
      `expected the fallback truncation marker to exist once the primary write failed; driver output:\n${driverOutput}`
    );
    assert.ok(
      driverOutput.includes("wrote the truncation marker to its fallback location"),
      `expected the fallback write to be reported by name; driver output:\n${driverOutput}`
    );
    const fallbackMarker = JSON.parse(readFileSync(fallbackMarkerPath, "utf8"));
    assert.equal(fallbackMarker.reason, "idle-watchdog");

    // THE READER SIDE OF THE FIX: check-coverage-floor.mjs, pointed at the
    // SAME two paths, must find the fallback marker and refuse VOID - never
    // silently fall through to an ordinary verdict against whatever partial
    // (or, here, entirely absent) coverage-summary.json this truncated run
    // produced.
    const floorEnv = {
      ...process.env,
      GHANTIKA_TRUNCATION_MARKER_PATH: primaryMarkerPath,
      GHANTIKA_TRUNCATION_MARKER_FALLBACK_PATH: fallbackMarkerPath,
      GHANTIKA_COVERAGE_SUMMARY_PATH: path.join(scratchDir, "does-not-exist-summary.json"),
    };
    let floorStatus = null;
    let floorOutput = "";
    try {
      floorOutput = execFileSync(process.execPath, [SCRIPT_PATH], {
        cwd: REPO_ROOT,
        env: floorEnv,
        encoding: "utf8",
      });
      floorStatus = 0;
    } catch (err) {
      floorStatus = err.status ?? null;
      floorOutput = (err.stdout ?? "") + (err.stderr ?? "");
    }
    assert.equal(
      floorStatus,
      VOID_EXIT_CODE,
      `THE FAIL-OPEN THIS CONTROL EXISTS TO CATCH: an unwritable primary marker directory must never yield ` +
        `an exit-0 or exit-1-from-a-missing-summary floor verdict - it must VOID. Before the fallback fix, ` +
        `this exited 1 here (an ordinary FAIL from the missing coverage-summary.json) rather than VOID, ` +
        `because loadTruncationMarker found neither marker and never refused. output:\n${floorOutput}`
    );
    assert.ok(floorOutput.includes("REFUSED"));
  } finally {
    // Guaranteed cleanup, on every path: reaps the driver's own process
    // group (see reapDriverProcessGroup's own doc comment above) so a
    // thrown assertion above can never leave the hanging fixture's own OS
    // process running.
    await reapAndConfirmGone(driverPid);
    // Restore permissions BEFORE recursive removal - rmSync recursing into
    // a still-0500 directory to delete its own entries would itself fail.
    try {
      chmodSync(unwritableDir, 0o700);
    } catch {
      // best-effort; the recursive rm below will surface anything real
    }
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

// Green control, paired with the negative control above: when the primary
// location IS writable, the fallback must never be touched at all. Without
// this, a bug that always wrote both locations (a silent, undocumented
// double-write) would pass the negative control above just as easily as the
// real fix does - this is what actually proves the fallback is a genuine
// RESCUE path, not a routine second copy.
test("green control: a writable primary marker location never touches the fallback", async () => {
  const scratchDir = mkdtempSync(path.join(tmpdir(), "ghantika-ac1-green-"));
  const primaryMarkerPath = path.join(scratchDir, "run-truncated.json");
  const fallbackMarkerPath = path.join(scratchDir, "fallback-marker.json");
  let driverPid;
  try {
    const hangingFile = path.join(scratchDir, "hangs.test.mjs");
    writeFileSync(
      hangingFile,
      `import { test } from "node:test";\n` +
        `test("never resolves", () => new Promise(() => { setInterval(() => {}, 1_000_000); }));\n`
    );
    const driverPath = path.join(scratchDir, "drive.mjs");
    writeFileSync(
      driverPath,
      `import { runOnce } from ${JSON.stringify(RUN_TESTS_SCRIPT_PATH)};\n` +
        `await runOnce({\n` +
        `  discovered: [${JSON.stringify(hangingFile)}],\n` +
        `  tracked: null,\n` +
        `  junitPath: null,\n` +
        `  options: { testTimeoutMs: 60000, idleTimeoutMs: 400, wallTimeoutMs: 60000, leakWindowMs: 5000 },\n` +
        `  skipBaseline: {},\n` +
        `  criticalTests: [],\n` +
        `  truncationMarkerPath: ${JSON.stringify(primaryMarkerPath)},\n` +
        `  truncationMarkerFallbackPath: ${JSON.stringify(fallbackMarkerPath)},\n` +
        `  completionMarkerPath: ${JSON.stringify(path.join(scratchDir, "unused-completion-marker.json"))},\n` +
        `});\n`
    );
    const driverEnv = { ...process.env };
    delete driverEnv.NODE_TEST_CONTEXT;
    delete driverEnv.NODE_TEST_WORKER_ID;
    // spawnSync (not execFileSync) so the driver's own pid is available for
    // reapAndConfirmGone below - see reapDriverProcessGroup's own doc
    // comment for why this matters.
    const driverResult = spawnSync(process.execPath, [driverPath], {
      cwd: REPO_ROOT,
      env: driverEnv,
      encoding: "utf8",
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    driverPid = driverResult.pid;
    const driverOutput = (driverResult.stdout ?? "") + (driverResult.stderr ?? "");
    assert.ok(
      existsSync(primaryMarkerPath),
      `expected the primary marker to exist when its directory is writable; driver output:\n${driverOutput}`
    );
    assert.ok(
      !existsSync(fallbackMarkerPath),
      "the fallback must never be written when the primary write already succeeded"
    );
    assert.ok(
      !driverOutput.includes("wrote the truncation marker to its fallback location"),
      `must not report a fallback write that never happened; driver output:\n${driverOutput}`
    );
  } finally {
    // Guaranteed cleanup, on every path - see reapDriverProcessGroup's own
    // doc comment above.
    await reapAndConfirmGone(driverPid);
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

// =============================================================================
// COMPLETION MARKER: the other half of the fail-open fix above. Even when
// BOTH of a truncated run's own truncation-marker writes fail (the fail-open
// tests above), an absent truncation marker alone still reads as "the run
// completed" - the completion marker is the positive record that closes
// that gap, bound to the exact commit it ran against so a stale record left
// over from a different commit can never be read as current. Three
// scenarios below: a fresh, matching completion marker lets the ordinary
// verdict proceed (the GREEN control every OTHER test in this file already
// depends on, by default, via runCliAgainstFixture); a completion marker
// left over from a DIFFERENT commit is treated as absent and VOIDs with a
// distinct reason; and the narrower, same-commit residual the SHA-binding
// alone cannot close - see the run-token test's own block comment further
// below for exactly what that residual was and how the run-token mechanism
// closes it.
// =============================================================================

test("a fresh completion marker matching the current commit lets the ordinary verdict proceed", () => {
  const summary = summaryWith(
    Object.fromEntries(
      Object.entries(COVERAGE_FLOORS).map(([metric, floor]) => [metric, floor + 10])
    )
  );
  const { status, output } = runCliAgainstFixture(JSON.stringify(summary));
  assert.equal(
    status,
    0,
    `a fresh, SHA-matching completion marker (runCliAgainstFixture's own default) must let the ordinary verdict proceed; output:\n${output}`
  );
  assert.ok(output.includes("every coverage metric is at or above its configured floor"));
  assert.ok(!output.includes("REFUSED"));
});

test("VOID [no-completion-record]: a completion marker from a DIFFERENT commit is treated as absent - the SHA binding at work", () => {
  const staleSha = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  const currentSha = gitHeadSha();
  assert.notEqual(
    staleSha,
    currentSha,
    "setup check: the repo's own initial commit must differ from the current HEAD for this control to prove anything"
  );

  const summary = summaryWith(
    Object.fromEntries(
      Object.entries(COVERAGE_FLOORS).map(([metric, floor]) => [metric, floor + 10])
    )
  );
  const { status, output } = runCliAgainstFixture(JSON.stringify(summary), {
    completionMarkerContent: JSON.stringify({
      headSha: staleSha,
      at: "2026-01-01T00:00:00.000Z",
    }),
  });
  assert.equal(
    status,
    VOID_EXIT_CODE,
    `a completion marker bound to a different commit must VOID, never fall through to an ordinary verdict; output:\n${output}`
  );
  assert.ok(
    output.includes("no-completion-record"),
    `expected the distinct no-completion-record reason, got: ${output}`
  );
  assert.ok(
    !output.includes("idle-watchdog") && !output.includes("wall-cap"),
    `must not be confused with the OTHER VOID reason (an absent truncation marker); output: ${output}`
  );
});

test("VOID [no-completion-record]: no completion marker at all is treated the same as one from a different commit", () => {
  const summary = summaryWith(
    Object.fromEntries(
      Object.entries(COVERAGE_FLOORS).map(([metric, floor]) => [metric, floor + 10])
    )
  );
  const { status, output } = runCliAgainstFixture(JSON.stringify(summary), {
    omitCompletionMarker: true,
  });
  assert.equal(status, VOID_EXIT_CODE, `output:\n${output}`);
  assert.ok(output.includes("no-completion-record"));
});

// =============================================================================
// THE RUN-TOKEN CLOSURE: the SHA-binding above defends against a completion
// marker left over from a DIFFERENT commit. On its own it could not defend
// against the narrower three-way conjunction where (1) a previous run at
// THIS SAME commit already completed and left a valid completion marker,
// (2) a LATER run at that identical commit is truncated, and (3) both of
// THAT run's own truncation-marker writes also fail. check-coverage-floor.mjs
// checks the truncation marker FIRST - if either write had succeeded, that
// alone would VOID regardless of the completion marker underneath it - so
// this gap was reachable only when truncation-marker persistence had ALSO
// failed, exactly the fail-open double-write-failure scenario already
// exercised above (see the "fail-open: an unwritable primary marker
// directory..." test). A truncated run must never produce a coverage
// verdict, however narrow the path to it. scripts/run-tests.mjs now
// generates a fresh token, independent of git HEAD, before test
// discovery and execution, and embeds it in the completion marker only
// on that run's genuine completion. A stale, same-commit completion
// marker necessarily embeds an EARLIER invocation's token, which can never
// match the fresh one the CURRENT invocation of check-coverage-floor.mjs
// finds on disk. Under this design, that setup VOIDs with the distinct
// [stale-completion-token] reason rather than falling through to an
// ordinary PASS.
// =============================================================================

test("the run-token mechanism closes the residual: a stale completion marker from a prior same-commit run no longer survives when both truncation-marker writes also fail on the current run", async () => {
  const scratchDir = mkdtempSync(path.join(tmpdir(), "ghantika-completion-residual-"));
  const unwritablePrimaryDir = path.join(scratchDir, "locked-coverage");
  const unwritableFallbackDir = path.join(scratchDir, "locked-fallback");
  mkdirSync(unwritablePrimaryDir, { recursive: true });
  mkdirSync(unwritableFallbackDir, { recursive: true });
  const primaryMarkerPath = path.join(unwritablePrimaryDir, "run-truncated.json");
  const fallbackMarkerPath = path.join(unwritableFallbackDir, "fallback-marker.json");
  const completionMarkerPath = path.join(scratchDir, "run-completed.json");
  // Deliberately NOT inside either locked directory above - lives at
  // REPO_ROOT-equivalent for this fixture, exactly as RUN_TOKEN_PATH's own
  // doc comment in scripts/run-tests.mjs describes for the real production
  // path: the whole point of the token is to detect that a completion
  // marker (which lives under coverage/, the two locked directories here)
  // is stale, so the token itself must not share a failure mode with
  // coverage/ becoming unwritable.
  const runTokenPath = path.join(scratchDir, "run-token.json");
  let driverPid;
  try {
    // The prior, successfully-completed run's own leftover marker, bound to
    // the REAL current HEAD - exactly what a genuine earlier
    // `npm run coverage` at this same commit would have written - carrying
    // ITS OWN, now-stale run token, distinct from the fresh token the
    // CURRENT invocation below generates.
    const staleRunToken = "stale-prior-run-token";
    writeFileSync(
      completionMarkerPath,
      JSON.stringify(
        { headSha: gitHeadSha(), at: "2026-01-01T00:00:00.000Z", runToken: staleRunToken },
        null,
        2
      )
    );

    // Lock BOTH marker directories down - reproducing the "fail-open"
    // test's own double-write-failure scenario above, but for both the
    // primary AND the fallback this time, since only their joint failure
    // reaches the completion-marker (and now the run-token) check at all.
    chmodSync(unwritablePrimaryDir, 0o500);
    chmodSync(unwritableFallbackDir, 0o500);

    const hangingFile = path.join(scratchDir, "hangs.test.mjs");
    writeFileSync(
      hangingFile,
      `import { test } from "node:test";\n` +
        `test("never resolves", () => new Promise(() => { setInterval(() => {}, 1_000_000); }));\n`
    );

    // The CURRENT invocation's own fresh token - what main() would have
    // generated and written to RUN_TOKEN_PATH before ever calling
    // runOnce(), see that function's own doc comment. Written to the
    // isolated, writable runTokenPath BEFORE the watchdog fires, and handed
    // to the driver below as its own in-memory runToken exactly as main()
    // hands it to runOnce() - the idle watchdog fires before this run ever
    // reaches its own completion, so this value is never actually embedded
    // anywhere by THIS run, but it is what the CLI compares the stale,
    // leftover completion marker against.
    const currentRunToken = "fresh-current-run-token";
    writeFileSync(runTokenPath, JSON.stringify({ token: currentRunToken }, null, 2));

    const driverPath = path.join(scratchDir, "drive.mjs");
    writeFileSync(
      driverPath,
      `import { runOnce } from ${JSON.stringify(RUN_TESTS_SCRIPT_PATH)};\n` +
        `await runOnce({\n` +
        `  discovered: [${JSON.stringify(hangingFile)}],\n` +
        `  tracked: null,\n` +
        `  junitPath: null,\n` +
        `  options: { testTimeoutMs: 60000, idleTimeoutMs: 400, wallTimeoutMs: 60000, leakWindowMs: 5000 },\n` +
        `  skipBaseline: {},\n` +
        `  criticalTests: [],\n` +
        `  truncationMarkerPath: ${JSON.stringify(primaryMarkerPath)},\n` +
        `  truncationMarkerFallbackPath: ${JSON.stringify(fallbackMarkerPath)},\n` +
        `  completionMarkerPath: ${JSON.stringify(path.join(scratchDir, "unused-completion-marker.json"))},\n` +
        `  runToken: ${JSON.stringify(currentRunToken)},\n` +
        `});\n`
    );

    const driverEnv = { ...process.env };
    delete driverEnv.NODE_TEST_CONTEXT;
    delete driverEnv.NODE_TEST_WORKER_ID;

    const driverResult = spawnSync(process.execPath, [driverPath], {
      cwd: REPO_ROOT,
      env: driverEnv,
      encoding: "utf8",
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    driverPid = driverResult.pid;
    const driverExit = driverResult.status;
    const driverOutput = (driverResult.stdout ?? "") + (driverResult.stderr ?? "");
    assert.equal(
      driverExit,
      1,
      `the idle-watchdog path must still exit 1; driver output:\n${driverOutput}`
    );
    assert.ok(
      !existsSync(primaryMarkerPath) && !existsSync(fallbackMarkerPath),
      `setup check: BOTH truncation-marker writes must have genuinely failed for this control to mean ` +
        `anything - primary exists: ${existsSync(primaryMarkerPath)}, fallback exists: ${existsSync(fallbackMarkerPath)}`
    );

    const summary = summaryWith(
      Object.fromEntries(
        Object.entries(COVERAGE_FLOORS).map(([metric, floor]) => [metric, floor + 10])
      )
    );
    const summaryPath = path.join(scratchDir, "coverage-summary.json");
    writeFileSync(summaryPath, JSON.stringify(summary));

    const floorEnv = {
      ...process.env,
      GHANTIKA_COVERAGE_SUMMARY_PATH: summaryPath,
      GHANTIKA_TRUNCATION_MARKER_PATH: primaryMarkerPath,
      GHANTIKA_TRUNCATION_MARKER_FALLBACK_PATH: fallbackMarkerPath,
      GHANTIKA_COMPLETION_MARKER_PATH: completionMarkerPath,
      GHANTIKA_RUN_TOKEN_PATH: runTokenPath,
    };
    let floorStatus = null;
    let floorOutput = "";
    try {
      floorOutput = execFileSync(process.execPath, [SCRIPT_PATH], {
        cwd: REPO_ROOT,
        env: floorEnv,
        encoding: "utf8",
      });
      floorStatus = 0;
    } catch (err) {
      floorStatus = err.status ?? null;
      floorOutput = (err.stdout ?? "") + (err.stderr ?? "");
    }

    // A same-commit completion marker left over from a prior successful run,
    // combined with both of THIS run's truncation-marker writes failing, is
    // not certified as an ordinary verdict: the stale marker's own embedded
    // runToken ("stale-prior-run-token") does not match the fresh token this
    // invocation finds on disk ("fresh-current-run-token"), so it VOIDs
    // rather than falling through.
    assert.equal(
      floorStatus,
      VOID_EXIT_CODE,
      `A same-commit completion marker left over from a prior successful run, combined with both of ` +
        `THIS run's truncation-marker writes failing, must not produce a coverage verdict - the run-token ` +
        `mismatch must VOID it; output:\n${floorOutput}`
    );
    assert.ok(
      floorOutput.includes("[stale-completion-token]"),
      `expected the distinct stale-completion-token VOID reason; output: ${floorOutput}`
    );
    assert.ok(
      floorOutput.includes("REFUSED"),
      `expected the run to REFUSE a verdict now that the fix is in place; output: ${floorOutput}`
    );
  } finally {
    try {
      chmodSync(unwritablePrimaryDir, 0o700);
    } catch {
      // best-effort; the recursive rm below will surface anything real
    }
    try {
      chmodSync(unwritableFallbackDir, 0o700);
    } catch {
      // best-effort; the recursive rm below will surface anything real
    }
    // Guaranteed cleanup, on every path - see reapDriverProcessGroup's own
    // doc comment above.
    await reapAndConfirmGone(driverPid);
    rmSync(scratchDir, { recursive: true, force: true });
  }
});
