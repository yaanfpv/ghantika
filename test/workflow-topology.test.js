import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGGREGATE_JOB_ID,
  loadWorkflow,
  verifyTopology,
} from "../scripts/verify-workflow-topology.mjs";

test("the real workflow's gate job depends on every other job and checks each literally", () => {
  const workflow = loadWorkflow();
  const errors = verifyTopology(workflow.jobs, AGGREGATE_JOB_ID);
  assert.deepEqual(errors, []);
});

test("gate's needs list covers every non-aggregate job in the real workflow", () => {
  const workflow = loadWorkflow();
  const otherJobIds = Object.keys(workflow.jobs).filter((id) => id !== AGGREGATE_JOB_ID);
  assert.ok(otherJobIds.length > 0, "the workflow should have jobs besides the aggregate");
  for (const jobId of otherJobIds) {
    assert.ok(
      workflow.jobs[AGGREGATE_JOB_ID].needs.includes(jobId),
      `gate.needs should include "${jobId}"`
    );
  }
});

// A mutation control: proves the validator is actually load-bearing, not
// something that would report clean no matter what the workflow looked
// like. Drop one job from a *copy* of the real, parsed gate.needs array
// and confirm verifyTopology notices.
test("mutation control: removing a job from gate.needs is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  const droppedJobId = mutated.jobs[AGGREGATE_JOB_ID].needs[0];
  mutated.jobs[AGGREGATE_JOB_ID].needs = mutated.jobs[AGGREGATE_JOB_ID].needs.filter(
    (id) => id !== droppedJobId
  );

  const errors = verifyTopology(mutated.jobs, AGGREGATE_JOB_ID);
  assert.ok(
    errors.some((error) => error.includes(droppedJobId) && error.includes("needs is missing")),
    `expected an error naming the dropped job "${droppedJobId}", got: ${JSON.stringify(errors)}`
  );

  // And restoring the edge makes the same input clean again, so the check
  // is reacting to the actual edge, not just always failing.
  mutated.jobs[AGGREGATE_JOB_ID].needs.push(droppedJobId);
  assert.deepEqual(verifyTopology(mutated.jobs, AGGREGATE_JOB_ID), []);
});

test("mutation control: an if condition other than always() is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs[AGGREGATE_JOB_ID].if = "success()";

  const errors = verifyTopology(mutated.jobs, AGGREGATE_JOB_ID);
  assert.ok(
    errors.some((error) => error.includes('"gate".if must be exactly "always()"')),
    `expected an if-condition error, got: ${JSON.stringify(errors)}`
  );
});

test("mutation control: weakening the literal-success check for one job is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  const step = mutated.jobs[AGGREGATE_JOB_ID].steps[0];
  // Simulate someone loosening the check from "== 'success'" to merely
  // "!= 'failure'" for the build job, which would let a skipped/cancelled
  // build job slip the gate through.
  step.env.ALL_SUCCEEDED = step.env.ALL_SUCCEEDED.replace(
    "needs.build.result == 'success'",
    "needs.build.result != 'failure'"
  );

  const errors = verifyTopology(mutated.jobs, AGGREGATE_JOB_ID);
  assert.ok(
    errors.some((error) => error.includes("needs.build.result == 'success'")),
    `expected an error about the weakened build check, got: ${JSON.stringify(errors)}`
  );
});

test("no job found under the given aggregate id is reported, not thrown", () => {
  const errors = verifyTopology({ build: {} }, "no-such-job");
  assert.deepEqual(errors, ['no "no-such-job" job found in the workflow']);
});
