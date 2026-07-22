import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGGREGATE_JOB_ID,
  collectControllingExpressionText,
  hasLiteralSuccessCheck,
  loadWorkflow,
  normalizeNeeds,
  verifyIndependentRequiredJobs,
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

// Bypass A, found in QA review: replacing a job's literal-success clause
// with a trailing `|| true` disjunction (`needs.build.result == 'success'
// || true`) left the old check clean, because it only looked for an
// unbroken "== 'success'" right after the "needs.build.result" marker and
// never noticed the disjunction that makes the whole clause vacuously
// true regardless of build's actual result.
test("mutation control: a trailing || true disjunction after the literal-success check is caught (bypass A)", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  const step = mutated.jobs[AGGREGATE_JOB_ID].steps[0];
  const original = step.env.ALL_SUCCEEDED;

  step.env.ALL_SUCCEEDED = original.replace(
    "needs.build.result == 'success' &&",
    "needs.build.result == 'success' || true &&"
  );
  assert.notEqual(step.env.ALL_SUCCEEDED, original, "the mutation should have changed the text");

  const topologyErrors = verifyTopology(mutated.jobs, AGGREGATE_JOB_ID);
  assert.ok(
    topologyErrors.some((error) => error.includes('"build"') && error.includes("never checks")),
    `expected verifyTopology to flag the vacuously-true build clause, got: ${JSON.stringify(topologyErrors)}`
  );
  const independentErrors = verifyIndependentRequiredJobs(mutated.jobs, AGGREGATE_JOB_ID);
  assert.ok(
    independentErrors.some((error) => error.includes('"build"') && error.includes("never checks")),
    `expected verifyIndependentRequiredJobs to flag the vacuously-true build clause, got: ${JSON.stringify(independentErrors)}`
  );

  // Revert and confirm clean again - the check reacts to the actual
  // disjunction, it doesn't just always fail.
  step.env.ALL_SUCCEEDED = original;
  assert.deepEqual(verifyTopology(mutated.jobs, AGGREGATE_JOB_ID), []);
  assert.deepEqual(verifyIndependentRequiredJobs(mutated.jobs, AGGREGATE_JOB_ID), []);
});

// Bypass C, found in Manager review as a stated hypothesis and verified
// before implementing anything: a `||` disjunction can just as easily sit
// BEFORE the matched literal as after it (`(true || needs.build.result ==
// 'success')`), which the original bypass-A fix did not check for - it
// only looked at what FOLLOWS the literal. The clause is exactly as
// vacuously true either way, since `true ||` needs nothing else to hold;
// which side of the literal the `||` is written on is not a different
// bypass, it is the same class mirrored.
test("mutation control: a leading disjunction before the literal-success check is caught (bypass C)", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  const step = mutated.jobs[AGGREGATE_JOB_ID].steps[0];
  const original = step.env.ALL_SUCCEEDED;

  step.env.ALL_SUCCEEDED = original.replace(
    "needs.build.result == 'success' &&",
    "(true || needs.build.result == 'success') &&"
  );
  assert.notEqual(step.env.ALL_SUCCEEDED, original, "the mutation should have changed the text");

  const topologyErrors = verifyTopology(mutated.jobs, AGGREGATE_JOB_ID);
  assert.ok(
    topologyErrors.some((error) => error.includes('"build"') && error.includes("never checks")),
    `expected verifyTopology to flag the vacuously-true build clause, got: ${JSON.stringify(topologyErrors)}`
  );
  const independentErrors = verifyIndependentRequiredJobs(mutated.jobs, AGGREGATE_JOB_ID);
  assert.ok(
    independentErrors.some((error) => error.includes('"build"') && error.includes("never checks")),
    `expected verifyIndependentRequiredJobs to flag the vacuously-true build clause, got: ${JSON.stringify(independentErrors)}`
  );

  // Revert and confirm clean again.
  step.env.ALL_SUCCEEDED = original;
  assert.deepEqual(verifyTopology(mutated.jobs, AGGREGATE_JOB_ID), []);
  assert.deepEqual(verifyIndependentRequiredJobs(mutated.jobs, AGGREGATE_JOB_ID), []);
});

// Bypass B, found in QA review: removing a job's clause from the REAL
// controlling expression (the env value the gate step's run script
// actually reads) while leaving the decoy literal text
// "needs.build.result == 'success'" in some other, unused location on the
// job - an env entry no run script ever reads - left the old check
// clean, because it flattened the whole job's env/run/if text into one
// blob and searched that, so the decoy satisfied it just as well as the
// real clause it replaced.
test("mutation control: a decoy literal-success check in an unused env entry does not substitute for the real one (bypass B)", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  const step = mutated.jobs[AGGREGATE_JOB_ID].steps[0];
  const original = step.env.ALL_SUCCEEDED;

  // Remove build's clause from the real controlling expression...
  step.env.ALL_SUCCEEDED = original.replace("needs.build.result == 'success' &&", "");
  assert.notEqual(step.env.ALL_SUCCEEDED, original, "the mutation should have changed the text");
  // ...then plant the decoy where nothing reads it: a second env entry on
  // the same step that the step's own run script never references.
  step.env.DECOY_UNUSED = "needs.build.result == 'success'";
  assert.ok(
    !step.run.includes("$DECOY_UNUSED") && !step.run.includes("${DECOY_UNUSED}"),
    "test assumption: the decoy env entry must not be referenced by the step's run script"
  );

  const topologyErrors = verifyTopology(mutated.jobs, AGGREGATE_JOB_ID);
  assert.ok(
    topologyErrors.some((error) => error.includes('"build"') && error.includes("never checks")),
    `expected verifyTopology to flag the removed build check despite the decoy, got: ${JSON.stringify(topologyErrors)}`
  );
  const independentErrors = verifyIndependentRequiredJobs(mutated.jobs, AGGREGATE_JOB_ID);
  assert.ok(
    independentErrors.some((error) => error.includes('"build"') && error.includes("never checks")),
    `expected verifyIndependentRequiredJobs to flag the removed build check despite the decoy, got: ${JSON.stringify(independentErrors)}`
  );

  // Revert and confirm clean again.
  step.env.ALL_SUCCEEDED = original;
  delete step.env.DECOY_UNUSED;
  assert.deepEqual(verifyTopology(mutated.jobs, AGGREGATE_JOB_ID), []);
  assert.deepEqual(verifyIndependentRequiredJobs(mutated.jobs, AGGREGATE_JOB_ID), []);
});

// Bypass D, found in Manager review while checking the if:"false" question
// above: the controlling step's own `if` being anything other than absent
// or literally true - a computed, usually-false GitHub Actions expression,
// say - previously still counted as "running" (the old stepActuallyRuns
// only excluded the literal string "false"), so the step's real,
// still-present literal-success text kept satisfying the check even
// though that step might never actually execute at runtime. A gate whose
// own required-success step is silently skipped would report success
// trivially, regardless of what actually failed - defeating the WHOLE
// aggregate check in one move, not just one job's clause the way A/B/C
// each do. The gate's JOB-level `if: always()` (required, untouched by
// this test) is a completely separate concern from this STEP-level `if`;
// see stepIsUnconditionallyControlling's own docs for why they need
// opposite treatment.
test("mutation control: a conditional if on the controlling step itself is caught (bypass D)", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  const step = mutated.jobs[AGGREGATE_JOB_ID].steps[0];
  assert.equal(step.if, undefined, "test assumption: the real controlling step has no if today");

  step.if = "${{ github.run_number > 999999 }}";

  const topologyErrors = verifyTopology(mutated.jobs, AGGREGATE_JOB_ID);
  assert.ok(
    topologyErrors.length > 0,
    `expected verifyTopology to flag every job once the controlling step can't be trusted to run, got: ${JSON.stringify(topologyErrors)}`
  );
  const independentErrors = verifyIndependentRequiredJobs(mutated.jobs, AGGREGATE_JOB_ID);
  assert.ok(
    independentErrors.length > 0,
    `expected verifyIndependentRequiredJobs to flag every job once the controlling step can't be trusted to run, got: ${JSON.stringify(independentErrors)}`
  );

  // Revert and confirm clean again. Also confirm the job-level if:
  // always() (a completely separate concern) is untouched by this
  // mutation and still exactly "always()".
  delete step.if;
  assert.deepEqual(verifyTopology(mutated.jobs, AGGREGATE_JOB_ID), []);
  assert.deepEqual(verifyIndependentRequiredJobs(mutated.jobs, AGGREGATE_JOB_ID), []);
  assert.equal(mutated.jobs[AGGREGATE_JOB_ID].if, "always()");
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
  const needs = normalizeNeeds(gate.needs);
  // collectControllingExpressionText (imported from production, not
  // reimplemented here) is what the shipped verify*/hasLiteralSuccessCheck
  // pair actually searches: the job's CONTROLLING expression text only,
  // not its entire flattened env/run/if text - see that function's own
  // doc comment for why a wider search is unsafe.
  const controllingText = collectControllingExpressionText(gate);
  for (const jobId of INDEPENDENT_REQUIRED_JOB_IDS) {
    assert.ok(
      needs.includes(jobId),
      `gate.needs is missing the independently-required job "${jobId}"`
    );
    // hasLiteralSuccessCheck (imported from production, not reimplemented
    // here) is ADJACENCY-aware: it requires the SAME jobId's own
    // "needs.<id>.result" marker to be immediately followed by
    // "== 'success'"/"== \"success\"", not merely that both substrings
    // appear SOMEWHERE in the job text independently of each other. A
    // weaker two-independent-substrings check
    // (jobText.includes("needs.x.result") && jobText.includes("'success'"))
    // would pass even when those two pieces belong to two DIFFERENT jobs'
    // checks - exactly the kind of paired-shrink escape this independent
    // inventory exists to close, so reusing the same non-vacuous mechanism
    // here (not a hand-rolled weaker one) matters as much as the
    // independent job-id list does. It also rejects a trailing `||`
    // disjunction after the match, so a vacuously-true clause doesn't
    // count either.
    assert.ok(
      hasLiteralSuccessCheck(controllingText, jobId),
      `gate does not appear to literally check needs.${jobId}.result == 'success'`
    );
  }
});

// Proves the SHIPPED production check (the one "guards"/lint invokes, via
// npm run verify:workflow-topology) actually agrees with this test file's
// own independently-hardcoded list against the real workflow - so a drift
// between the two hardcoded copies (this file's INDEPENDENT_REQUIRED_JOB_IDS
// above and verify-workflow-topology.mjs's own) would show up as a real
// test failure here, not silently diverge unnoticed.
test("the shipped verifyIndependentRequiredJobs check is clean against the real workflow", () => {
  const workflow = loadWorkflow();
  assert.deepEqual(verifyIndependentRequiredJobs(workflow.jobs, AGGREGATE_JOB_ID), []);
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
  // workflow file, so the same mutated file still fails it - proven two
  // ways: this file's own hardcoded list directly, and the shipped
  // production function against the same mutated jobs.
  const needs = normalizeNeeds(mutated.jobs[AGGREGATE_JOB_ID].needs);
  const missing = INDEPENDENT_REQUIRED_JOB_IDS.filter((jobId) => !needs.includes(jobId));
  assert.deepEqual(missing, ["coverage"]);

  const productionErrors = verifyIndependentRequiredJobs(mutated.jobs, AGGREGATE_JOB_ID);
  assert.ok(
    productionErrors.some((error) => error.includes("coverage")),
    `expected the shipped check to name "coverage", got: ${JSON.stringify(productionErrors)}`
  );
});
