import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGGREGATE_JOB_ID,
  findContinueOnError,
  findGateOwnContinueOnError,
  loadWorkflow,
} from "../scripts/lint-workflow-jobs.mjs";

// `findContinueOnError`'s exclusion of the aggregate by id and
// `findGateOwnContinueOnError`'s check of the aggregate against itself are
// deliberately two SEPARATE, complementary checks, not one superseding the
// other. `findContinueOnError` answers "does any job the aggregate depends
// on hide a failure behind continue-on-error"; the aggregate is excluded
// from that question on purpose, because the aggregate does not depend on
// itself. `findGateOwnContinueOnError` answers the other question that
// exclusion leaves open: does the aggregate itself (or one of its own
// steps) hide a failure the same way. The test below at "continue-on-error
// on the aggregate job itself is not flagged" is not an oversight left over
// from before `findGateOwnContinueOnError` existed - it still documents
// true, current behavior of `findContinueOnError` specifically.

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

// --- The gate aggregate's OWN continue-on-error (findGateOwnContinueOnError) ---
//
// findContinueOnError's exclusion of the aggregate above is exactly the gap
// findGateOwnContinueOnError exists to close: nothing before it checked
// whether the aggregate carries a continue-on-error on itself, which would
// let the one required check branch protection actually points at report
// success while its own literal-success check had failed.

test("mutation control: a planted continue-on-error on the gate job itself is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs[AGGREGATE_JOB_ID]["continue-on-error"] = true;

  assert.deepEqual(findGateOwnContinueOnError(mutated.jobs, AGGREGATE_JOB_ID), [
    `"${AGGREGATE_JOB_ID}" job level`,
  ]);

  delete mutated.jobs[AGGREGATE_JOB_ID]["continue-on-error"];
  assert.deepEqual(findGateOwnContinueOnError(mutated.jobs, AGGREGATE_JOB_ID), []);
});

test("mutation control: a planted continue-on-error on one of the gate job's own steps is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs[AGGREGATE_JOB_ID].steps.at(-1)["continue-on-error"] = true;

  assert.deepEqual(findGateOwnContinueOnError(mutated.jobs, AGGREGATE_JOB_ID), [
    `"${AGGREGATE_JOB_ID}".steps[${mutated.jobs[AGGREGATE_JOB_ID].steps.length - 1}]`,
  ]);

  delete mutated.jobs[AGGREGATE_JOB_ID].steps.at(-1)["continue-on-error"];
  assert.deepEqual(findGateOwnContinueOnError(mutated.jobs, AGGREGATE_JOB_ID), []);
});

// --- Mandatory protection: expression-valued continue-on-error ---
//
// continue-on-error accepts more than a literal boolean `true` - GitHub
// Actions also honors a quoted string like "true" and an expression like
// `${{ matrix.allow_failure }}` the exact same way at runtime, and an
// expression's real value can only be known then, never by a static check.
// The predicate below is deliberately the OLD, now-replaced `=== true`
// check - kept here ONLY to prove the escape it had was real.
// findContinueOnError itself no longer uses it.
function oldLiteralTrueOnlyCheck(jobs, aggregateId) {
  const offenders = [];
  for (const [jobId, job] of Object.entries(jobs ?? {})) {
    if (jobId === aggregateId) continue;
    const onJob = job?.["continue-on-error"] === true;
    const onAnyStep = (job?.steps ?? []).some((step) => step?.["continue-on-error"] === true);
    if (onJob || onAnyStep) offenders.push(jobId);
  }
  return offenders;
}

test("mutation control (expression-valued, job level): an expression continue-on-error is missed by the old literal-true-only check and caught by the fix", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs.lint["continue-on-error"] = "${{ vars.ALLOW_LINT_FAILURE }}";

  assert.deepEqual(
    oldLiteralTrueOnlyCheck(mutated.jobs, AGGREGATE_JOB_ID),
    [],
    "sanity check: the old === true check does not see an expression string as a violation - this is the escape this protection exists to close"
  );
  assert.deepEqual(findContinueOnError(mutated.jobs, AGGREGATE_JOB_ID), ["lint"]);
});

test("mutation control (expression-valued, step level): an expression continue-on-error on a step is missed by the old literal-true-only check and caught by the fix", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs.build.steps.at(-1)["continue-on-error"] = "${{ matrix.allow_failure }}";

  assert.deepEqual(
    oldLiteralTrueOnlyCheck(mutated.jobs, AGGREGATE_JOB_ID),
    [],
    "sanity check: the old === true check does not see an expression string as a violation - this is the escape this protection exists to close"
  );
  assert.deepEqual(findContinueOnError(mutated.jobs, AGGREGATE_JOB_ID), ["build"]);
});

test('mutation control (quoted string "true", job level): a string "true" continue-on-error is caught by the fix even though it is not the literal boolean', () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs.lint["continue-on-error"] = "true";

  assert.deepEqual(
    oldLiteralTrueOnlyCheck(mutated.jobs, AGGREGATE_JOB_ID),
    [],
    'sanity check: the old === true check does not see the string "true" as a violation either - same escape, different spelling'
  );
  assert.deepEqual(findContinueOnError(mutated.jobs, AGGREGATE_JOB_ID), ["lint"]);
});

test("green control: continue-on-error explicitly set to false is not flagged", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs.lint["continue-on-error"] = false;

  assert.deepEqual(findContinueOnError(mutated.jobs, AGGREGATE_JOB_ID), []);
});
