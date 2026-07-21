import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FORBIDDEN_JOB_IDS,
  findForbiddenGovernanceJobs,
  loadWorkflow,
} from "../scripts/lint-workflow-jobs.mjs";

// Secret scanning, push protection, and Dependabot alerts are GitHub
// repository settings, not something a workflow job can stand in for - so
// the workflow's job list should never contain one pretending to be them.
test("the real workflow does not contain a fake secret-scan or dependabot job", () => {
  const workflow = loadWorkflow();
  assert.deepEqual(findForbiddenGovernanceJobs(workflow.jobs), []);
});

test("mutation control: a job named after a forbidden governance check is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs["secret-scan"] = { "runs-on": "ubuntu-latest", steps: [] };

  assert.deepEqual(findForbiddenGovernanceJobs(mutated.jobs), ["secret-scan"]);
});

test("every documented forbidden id is actually forbidden", () => {
  for (const id of FORBIDDEN_JOB_IDS) {
    const jobs = { [id]: { "runs-on": "ubuntu-latest", steps: [] } };
    assert.deepEqual(findForbiddenGovernanceJobs(jobs), [id]);
  }
});
