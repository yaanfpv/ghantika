import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COVERAGE_FLOORS,
  VOID_EXIT_CODE,
  checkCoverageFloors,
  loadTruncationMarker,
} from "../scripts/check-coverage-floor.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/check-coverage-floor.mjs", import.meta.url));
const RUN_TESTS_SCRIPT_PATH = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

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
 * returns its exit code AND captured stdout+stderr without letting a
 * non-zero exit throw past this helper.
 *
 * @param {string | undefined} summaryContent omit to simulate a missing file
 * @param {{ markerContent?: string }} [opts] `markerContent`, if given, is
 *   written to a throwaway file and pointed at via
 *   GHANTIKA_TRUNCATION_MARKER_PATH - omitted means the env
 *   var is left unset, so the script falls back to its own real default
 *   TRUNCATION_MARKER_PATH (coverage/run-truncated.json, in THIS repo),
 *   which every test below that does not pass markerContent relies on
 *   being absent - true in a clean checkout, and restored by the
 *   real-end-to-end test further down via its own explicit cleanup.
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

    let driverExit = null;
    let driverOutput = "";
    try {
      driverOutput = execFileSync(process.execPath, [driverPath], {
        cwd: REPO_ROOT,
        env: driverEnv,
        encoding: "utf8",
      });
      driverExit = 0;
    } catch (err) {
      driverExit = err.status ?? null;
      driverOutput = (err.stdout ?? "") + (err.stderr ?? "");
    }
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

    // RESTORE: clear the marker, confirm a verdict is reported again.
    rmSync(markerPath, { force: true });
    let restoredStatus = null;
    let restoredOutput = "";
    try {
      restoredOutput = execFileSync(process.execPath, [SCRIPT_PATH], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      restoredStatus = 0;
    } catch (err) {
      restoredStatus = err.status ?? null;
      restoredOutput = (err.stdout ?? "") + (err.stderr ?? "");
    }
    assert.notEqual(
      restoredStatus,
      VOID_EXIT_CODE,
      `restoring must produce a real verdict, never VOID again; output: ${restoredOutput}`
    );
    assert.ok(
      !restoredOutput.includes("REFUSED"),
      `restored run must not still be refusing; output: ${restoredOutput}`
    );
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
    rmSync(markerPath, { force: true });
    if (hadPriorMarker) writeFileSync(markerPath, priorMarkerContent);
  }
});
