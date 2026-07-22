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

// --- Mandatory protection: paired-deletion independent required-job inventory ---
//
// verifyTopology derives "which jobs must gate depend on" from
// Object.keys(jobs) on the SAME workflow file it is checking. So a
// coordinated edit that deletes a job entirely - not just from gate.needs,
// but the job definition itself, plus its needs entry, plus its clause in
// gate's success-expression, all at once - removes that job from
// consideration everywhere in the same motion, and verifyTopology has
// nothing left to compare it against. The list below is read directly off
// the real ci.yml's job set and hard-coded here, independent of the
// workflow file - a coordinated deletion like that would ALSO have to
// touch this file to keep the suite green.
const INDEPENDENT_REQUIRED_JOB_IDS = [
  "build",
  "typecheck",
  "lint",
  "test",
  "format",
  "coverage",
  "codeql",
  "semgrep",
  "zizmor",
  "actionlint",
  "changelog-presence",
  "guards",
  "sha-parity",
  "install-repro",
];

test("independent inventory: gate.needs and gate's literal success-checks cover every hard-coded required job", () => {
  const workflow = loadWorkflow();
  const gate = workflow.jobs[AGGREGATE_JOB_ID];
  const needs = normalizeNeedsForTest(gate.needs);
  const jobText = flattenJobTextForTest(gate);
  for (const jobId of INDEPENDENT_REQUIRED_JOB_IDS) {
    assert.ok(
      needs.includes(jobId),
      `gate.needs is missing the independently-required job "${jobId}"`
    );
    assert.ok(
      jobText.includes(`needs.${jobId}.result`) && jobText.includes("'success'"),
      `gate does not appear to literally check needs.${jobId}.result == 'success'`
    );
  }
});

// Mutation control: a coordinated deletion of a whole job - "coverage",
// chosen because it has nothing to do with Windows/OS matrix work - is
// removed from the job list itself, from gate.needs, and from gate's
// success-expression all at once, in a test-local mutated copy.
// verifyTopology alone (proven below as a sanity check) reports this clean,
// because it derives its own expectations from the same mutated file. The
// independent inventory above never reads the workflow file for its
// expectations, so it still catches the deletion.
test("mutation control (paired deletion): wholesale-deleting the coverage job is invisible to verifyTopology alone but caught by the independent inventory", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  delete mutated.jobs.coverage;
  mutated.jobs[AGGREGATE_JOB_ID].needs = mutated.jobs[AGGREGATE_JOB_ID].needs.filter(
    (id) => id !== "coverage"
  );
  mutated.jobs[AGGREGATE_JOB_ID].steps[0].env.ALL_SUCCEEDED = mutated.jobs[
    AGGREGATE_JOB_ID
  ].steps[0].env.ALL_SUCCEEDED.replace("needs.coverage.result == 'success' &&", "");

  // Sanity check: proves the escape is real. verifyTopology, given only
  // this mutated file, has nothing left in it to compare "coverage"
  // against, so it reports clean.
  assert.deepEqual(
    verifyTopology(mutated.jobs, AGGREGATE_JOB_ID),
    [],
    "sanity check: verifyTopology alone does not notice a wholesale job deletion - this is the escape this protection exists to close"
  );

  // The independent inventory never derived its expectations from the
  // workflow file, so the same mutated file still fails it.
  const needs = normalizeNeedsForTest(mutated.jobs[AGGREGATE_JOB_ID].needs);
  const missing = INDEPENDENT_REQUIRED_JOB_IDS.filter((jobId) => !needs.includes(jobId));
  assert.deepEqual(missing, ["coverage"]);
});

function normalizeNeedsForTest(needs) {
  if (!needs) return [];
  return Array.isArray(needs) ? needs : [needs];
}

function flattenJobTextForTest(job) {
  const parts = [];
  if (job?.env) parts.push(JSON.stringify(job.env));
  for (const step of job?.steps ?? []) {
    if (step.run) parts.push(step.run);
    if (step.env) parts.push(JSON.stringify(step.env));
    if (step.if) parts.push(step.if);
  }
  return parts.join("\n");
}
