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

test("the real test job's matrix covers all 6 OS x Node legs", () => {
  const workflow = loadWorkflow();
  const testJob = workflow.jobs[TEST_JOB_ID];
  assert.ok(testJob, `expected a "${TEST_JOB_ID}" job in the workflow`);
  assert.deepEqual(verifyMatrixCompleteness(testJob), []);

  const legs = computeMatrixLegs(testJob.strategy.matrix);
  assert.equal(
    legs.length,
    EXPECTED_OS.length * EXPECTED_NODE.length,
    "expected exactly 6 legs, no more, no fewer"
  );
});

// Mutation control: drop one operating system from a copy of the real
// matrix and confirm the check names exactly the two legs (one per Node
// version) that go missing with it - then confirm restoring it goes
// clean again.
test("mutation control: dropping windows-latest from the matrix is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs[TEST_JOB_ID].strategy.matrix.os = mutated.jobs[
    TEST_JOB_ID
  ].strategy.matrix.os.filter((os) => os !== "windows-latest");

  const missing = verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]);
  assert.deepEqual(missing.sort(), ["windows-latest::22", "windows-latest::24"].sort());
});

test("mutation control: dropping node 24 from the matrix is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs[TEST_JOB_ID].strategy.matrix.node = mutated.jobs[
    TEST_JOB_ID
  ].strategy.matrix.node.filter((node) => String(node) !== "24");

  const missing = verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]);
  assert.deepEqual(
    missing.sort(),
    ["ubuntu-latest::24", "macos-latest::24", "windows-latest::24"].sort()
  );
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
  mutated.jobs[TEST_JOB_ID].strategy.matrix.os = originalOs.filter((os) => os !== "windows-latest");
  assert.notDeepEqual(verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]), []);

  mutated.jobs[TEST_JOB_ID].strategy.matrix.os = originalOs;
  assert.deepEqual(verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]), []);
});
