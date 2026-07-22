import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXPECTED_NODE,
  EXPECTED_OS,
  TEST_JOB_ID,
  computeMatrixLegs,
  loadWorkflow,
  verifyMatrixCompleteness,
} from "../scripts/lint-workflow-jobs.mjs";

test("the real test job's matrix covers all 4 OS x Node legs", () => {
  const workflow = loadWorkflow();
  const testJob = workflow.jobs[TEST_JOB_ID];
  assert.ok(testJob, `expected a "${TEST_JOB_ID}" job in the workflow`);
  assert.deepEqual(verifyMatrixCompleteness(testJob), []);

  const legs = computeMatrixLegs(testJob.strategy.matrix);
  assert.equal(
    legs.length,
    EXPECTED_OS.length * EXPECTED_NODE.length,
    "expected exactly 4 legs, no more, no fewer"
  );
});

// Mutation control: drop one operating system from a copy of the real
// matrix and confirm the check names exactly the two legs (one per Node
// version) that go missing with it - then confirm restoring it goes clean
// again. Retargeted at macos-latest (was windows-latest, before Windows
// was temporarily removed from the matrix - see CHANGELOG); a future
// sprint restoring the Windows leg re-aims this back at windows-latest.
test("mutation control: dropping macos-latest from the matrix is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs[TEST_JOB_ID].strategy.matrix.os = mutated.jobs[
    TEST_JOB_ID
  ].strategy.matrix.os.filter((os) => os !== "macos-latest");

  const missing = verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]);
  assert.deepEqual(missing.sort(), ["macos-latest::22", "macos-latest::24"].sort());
});

test("mutation control: dropping node 24 from the matrix is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs[TEST_JOB_ID].strategy.matrix.node = mutated.jobs[
    TEST_JOB_ID
  ].strategy.matrix.node.filter((node) => String(node) !== "24");

  const missing = verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]);
  assert.deepEqual(missing.sort(), ["ubuntu-latest::24", "macos-latest::24"].sort());
});

test("mutation control: an exclude entry silently dropping one leg is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs[TEST_JOB_ID].strategy.matrix.exclude = [{ os: "macos-latest", node: "24" }];

  const missing = verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]);
  assert.deepEqual(missing, ["macos-latest::24"]);
});

test("restoring the full matrix after a mutation goes clean again", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  const originalOs = mutated.jobs[TEST_JOB_ID].strategy.matrix.os;
  mutated.jobs[TEST_JOB_ID].strategy.matrix.os = originalOs.filter((os) => os !== "macos-latest");
  assert.notDeepEqual(verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]), []);

  mutated.jobs[TEST_JOB_ID].strategy.matrix.os = originalOs;
  assert.deepEqual(verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]), []);
});

// --- Mandatory protection: paired-shrink independent literal oracle ---
//
// verifyMatrixCompleteness above derives "what's expected" from
// EXPECTED_OS/EXPECTED_NODE, imported from the very module it is checking.
// A coordinated edit that shrinks ci.yml's real matrix AND EXPECTED_OS or
// EXPECTED_NODE together (in the same commit) leaves nothing for
// verifyMatrixCompleteness to notice: both sides moved together. The
// closed set below is a genuinely independent, hard-coded expectation
// written directly in this test file rather than imported from anywhere -
// a coordinated edit to the workflow and to lint-workflow-jobs.mjs's own
// constants would ALSO have to touch this file to keep the suite green.
const INDEPENDENT_EXPECTED_LEGS = [
  "ubuntu-latest::22",
  "ubuntu-latest::24",
  "macos-latest::22",
  "macos-latest::24",
];

function independentLegsMissingFrom(actualLegs) {
  const present = new Set(actualLegs);
  return INDEPENDENT_EXPECTED_LEGS.filter((leg) => !present.has(leg));
}

test("independent literal oracle: the real matrix legs exactly match a hard-coded closed set", () => {
  const workflow = loadWorkflow();
  const legs = computeMatrixLegs(workflow.jobs[TEST_JOB_ID].strategy.matrix);
  assert.deepEqual(independentLegsMissingFrom(legs), []);
  assert.equal(legs.length, INDEPENDENT_EXPECTED_LEGS.length);
});

// One row per axis value (ubuntu, macos, node 22, node 24). Each row
// simulates the coordinated edit - the real matrix AND a locally-computed,
// equally-shrunk copy of EXPECTED_OS/EXPECTED_NODE both drop the same
// value - and first proves (as a sanity check) that verifyMatrixCompleteness
// alone is fooled by it, before proving the independent oracle above,
// which never reads EXPECTED_OS/EXPECTED_NODE at all, still catches it.
for (const [axis, droppedValue] of [
  ["os", "ubuntu-latest"],
  ["os", "macos-latest"],
  ["node", "22"],
  ["node", "24"],
]) {
  test(`mutation control (paired shrink): dropping ${droppedValue} from both the real matrix and a simulated EXPECTED_${axis.toUpperCase()} is still caught by the independent oracle`, () => {
    const workflow = loadWorkflow();
    const mutated = structuredClone(workflow);
    const matrix = mutated.jobs[TEST_JOB_ID].strategy.matrix;
    matrix[axis] = matrix[axis].filter((value) => String(value) !== droppedValue);

    const pairedExpectedOs =
      axis === "os" ? EXPECTED_OS.filter((value) => value !== droppedValue) : EXPECTED_OS;
    const pairedExpectedNode =
      axis === "node"
        ? EXPECTED_NODE.filter((value) => String(value) !== droppedValue)
        : EXPECTED_NODE;

    // Sanity check: this is the escape itself. Given an equally-shrunk
    // "expected" set, the derived checker sees nothing missing.
    assert.deepEqual(
      verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID], pairedExpectedOs, pairedExpectedNode),
      [],
      "sanity check: the derived checker, given a paired-shrink expectation, sees nothing missing - this is the escape this protection exists to close"
    );

    // The independent oracle never derived its expectations from
    // EXPECTED_OS/EXPECTED_NODE, so the coordinated edit above cannot
    // reach it - it still reports the dropped leg(s) as missing.
    const actualLegs = computeMatrixLegs(matrix);
    const missing = independentLegsMissingFrom(actualLegs);
    assert.ok(
      missing.length > 0,
      `expected the independent oracle to catch the dropped ${axis} "${droppedValue}", got no missing legs`
    );
  });
}
