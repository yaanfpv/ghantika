import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGGREGATE_JOB_ID,
  findContinueOnError,
  loadWorkflow,
} from "../scripts/lint-workflow-jobs.mjs";

test("no job the gate depends on sets continue-on-error: true", () => {
  const workflow = loadWorkflow();
  assert.deepEqual(findContinueOnError(workflow.jobs, AGGREGATE_JOB_ID), []);
});

// Mutation control: plant a continue-on-error on a copy of a real job and
// confirm the lint actually reacts to it, then confirm reverting it goes
// clean again - proving this isn't a check that's always green.
test("mutation control: a planted continue-on-error on a step is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs.build.steps.at(-1)["continue-on-error"] = true;

  assert.deepEqual(findContinueOnError(mutated.jobs, AGGREGATE_JOB_ID), ["build"]);

  delete mutated.jobs.build.steps.at(-1)["continue-on-error"];
  assert.deepEqual(findContinueOnError(mutated.jobs, AGGREGATE_JOB_ID), []);
});

test("mutation control: a planted continue-on-error on the job itself is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs.lint["continue-on-error"] = true;

  assert.deepEqual(findContinueOnError(mutated.jobs, AGGREGATE_JOB_ID), ["lint"]);
});

test("continue-on-error on the aggregate job itself is not flagged (it is excluded by id)", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs[AGGREGATE_JOB_ID]["continue-on-error"] = true;

  assert.deepEqual(findContinueOnError(mutated.jobs, AGGREGATE_JOB_ID), []);
});
