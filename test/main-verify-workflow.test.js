import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { load as loadYaml } from "js-yaml";

import { loadWorkflow as loadCiWorkflow, TEST_JOB_ID } from "../scripts/lint-workflow-jobs.mjs";

/**
 * ci.yml's own `test` job never runs against `main` itself -
 * ci.yml triggers on `pull_request:` alone (see that file's own header
 * comment). main-verify.yml closes that by
 * running the SAME test matrix on every push to main, in its OWN workflow
 * file rather than a job added into ci.yml - adding a job there would put
 * it inside scripts/verify-workflow-topology.mjs's blanket "gate depends on
 * every job in this file" check, and a job that only ever runs on push
 * would show up "skipped" on every PR and make the required `gate` check
 * red on every PR (see main-verify.yml's own header for the full
 * reasoning).
 *
 * Being a separate file means it is a DELIBERATE, DISCLOSED duplicate of
 * ci.yml's `test` job rather than a shared definition - both files' own
 * header comments say so. This test is what keeps that duplicate honest:
 * it asserts the two `test` jobs' matrices and functionally load-bearing
 * steps stay identical, so an edit to one that isn't mirrored in the other
 * fails HERE, in milliseconds, rather than drifting silently until main's
 * own run behaves differently from what a PR just verified.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAIN_VERIFY_PATH = path.join(REPO_ROOT, ".github", "workflows", "main-verify.yml");
const MAIN_VERIFY_TEST_JOB_ID = "test";
const REPORT_FAILURE_JOB_ID = "report-failure";

function loadMainVerifyWorkflow() {
  return loadYaml(readFileSync(MAIN_VERIFY_PATH, "utf8"));
}

/**
 * Steps are compared on everything EXCEPT their display `name` - the two
 * jobs are legitimately named differently ("test (...)" vs "main-verify
 * (...)", "annotate ... on the PR" vs "annotate ..." since main-verify has
 * no PR) without that being a real functional divergence. `uses`/`run`/
 * `env`/`with`/`if` are what actually determine what a step DOES.
 *
 * @param {any} step
 */
function stripDisplayName(step) {
  const rest = { ...step };
  delete rest.name;
  return rest;
}

test("main-verify.yml's test job matrix is identical to ci.yml's test job matrix", () => {
  const ciWorkflow = loadCiWorkflow();
  const mainVerifyWorkflow = loadMainVerifyWorkflow();

  const ciTestJob = ciWorkflow.jobs[TEST_JOB_ID];
  const mainVerifyTestJob = mainVerifyWorkflow.jobs[MAIN_VERIFY_TEST_JOB_ID];
  assert.ok(ciTestJob, `expected a "${TEST_JOB_ID}" job in ci.yml`);
  assert.ok(mainVerifyTestJob, `expected a "${MAIN_VERIFY_TEST_JOB_ID}" job in main-verify.yml`);

  assert.deepEqual(
    mainVerifyTestJob.strategy.matrix,
    ciTestJob.strategy.matrix,
    "main-verify.yml's test matrix must cover exactly the same OS x Node legs as ci.yml's - a cell not run is a cell not covered"
  );
  assert.equal(
    mainVerifyTestJob["timeout-minutes"],
    ciTestJob["timeout-minutes"],
    "the two jobs' wall-clock timeouts must agree"
  );
});

test("main-verify.yml's test job runs the same functionally load-bearing steps as ci.yml's test job, in the same order", () => {
  const ciWorkflow = loadCiWorkflow();
  const mainVerifyWorkflow = loadMainVerifyWorkflow();

  const ciSteps = ciWorkflow.jobs[TEST_JOB_ID].steps.map(stripDisplayName);
  const mainVerifySteps =
    mainVerifyWorkflow.jobs[MAIN_VERIFY_TEST_JOB_ID].steps.map(stripDisplayName);

  assert.deepEqual(
    mainVerifySteps,
    ciSteps,
    "main-verify.yml's test job must run byte-identical steps (checkout/setup-node/npm ci/build/test invocation/annotate action) to ci.yml's - LOCKSTEP WARNING in both files' headers explains why this is a deliberate duplicate rather than a shared definition"
  );
});

test("main-verify.yml triggers on push to main only, never on pull_request - it must never contribute to a PR's mergeability", () => {
  const mainVerifyWorkflow = loadMainVerifyWorkflow();
  assert.ok(mainVerifyWorkflow.on.push, "expected an on.push trigger");
  assert.deepEqual(mainVerifyWorkflow.on.push.branches, ["main"]);
  assert.equal(
    mainVerifyWorkflow.on.pull_request,
    undefined,
    "main-verify.yml must never trigger on pull_request - that would make it a candidate for a PR's required checks"
  );
});

test("main-verify.yml's own jobs never appear in ci.yml - the two workflows share no job graph, which is what makes 'never added to the required gate context' true by construction rather than by convention", () => {
  const ciWorkflow = loadCiWorkflow();
  assert.equal(
    Object.keys(ciWorkflow.jobs).includes(REPORT_FAILURE_JOB_ID),
    false,
    `ci.yml must never define a "${REPORT_FAILURE_JOB_ID}" job - that job belongs only to main-verify.yml's post-merge path`
  );
  // gate's own needs list is exactly what scripts/verify-workflow-topology.mjs
  // already pins to the real job set (via INDEPENDENT_REQUIRED_JOB_IDS) - this
  // repeats none of that machinery, it only confirms adding main-verify.yml
  // did not grow ci.yml's own job count by leaking a job into the wrong file.
  assert.equal(
    Object.keys(ciWorkflow.jobs).length,
    15, // build, typecheck, lint, format, coverage, test, codeql, semgrep, zizmor, actionlint, changelog-presence, guards, sha-parity, install-repro, gate
    "ci.yml's job count must be unchanged by adding main-verify.yml - if this needs to change, it means a job was added to the wrong file"
  );
});

test("the report-failure job only runs when test fails, names the real merge commit, and never blocks (never required by any check)", () => {
  const mainVerifyWorkflow = loadMainVerifyWorkflow();
  const reportJob = mainVerifyWorkflow.jobs[REPORT_FAILURE_JOB_ID];
  assert.ok(reportJob, `expected a "${REPORT_FAILURE_JOB_ID}" job in main-verify.yml`);
  assert.equal(reportJob.if, "failure()", "report-failure must only run on a genuine test failure");
  assert.equal(reportJob.needs, MAIN_VERIFY_TEST_JOB_ID);

  const serialized = JSON.stringify(reportJob);
  assert.match(
    serialized,
    /github\.sha/,
    "the failure report must name the real merge commit (github.sha), not an anonymous red"
  );
  assert.match(
    serialized,
    /github\.run_id/,
    "the failure report must link to the actual run, not just assert a failure happened"
  );
});

test("main-verify.yml never cancels an in-progress run - a cancelled run's failure would be lost or misattributed to a different merge", () => {
  const mainVerifyWorkflow = loadMainVerifyWorkflow();
  assert.equal(mainVerifyWorkflow.concurrency["cancel-in-progress"], false);
});
