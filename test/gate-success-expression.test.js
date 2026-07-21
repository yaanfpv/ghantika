import assert from "node:assert/strict";
import { test } from "node:test";

import { allJobsSucceeded } from "../scripts/gate-success-expression.mjs";

// Synthetic job-result inputs modeling what `needs` looks like in the real
// workflow: only the all-success case should ever pass.

test("all jobs succeeded -> passes", () => {
  const results = { build: "success", typecheck: "success", lint: "success", test: "success" };
  assert.equal(allJobsSucceeded(results), true);
});

test("one job failed -> does not pass", () => {
  const results = { build: "success", typecheck: "success", lint: "failure", test: "success" };
  assert.equal(allJobsSucceeded(results), false);
});

test("one job cancelled -> does not pass", () => {
  const results = { build: "success", typecheck: "cancelled", lint: "success", test: "success" };
  assert.equal(allJobsSucceeded(results), false);
});

test("one job skipped -> does not pass (a skip must not count as passing)", () => {
  const results = { build: "success", typecheck: "success", lint: "success", test: "skipped" };
  assert.equal(allJobsSucceeded(results), false);
});

test("every job skipped -> does not pass", () => {
  const results = { build: "skipped", typecheck: "skipped" };
  assert.equal(allJobsSucceeded(results), false);
});

test("no jobs at all -> does not pass (an empty needs list should never read as a green gate)", () => {
  assert.equal(allJobsSucceeded({}), false);
});
