#!/usr/bin/env node
/**
 * Statically proves that the aggregate "gate" job in .github/workflows/ci.yml
 * really depends on every other job in that file, and that its own success
 * check requires each of those jobs' results to literally equal "success" -
 * not merely "did not fail" - before it will pass.
 *
 * Why a static check at all, instead of just trusting the YAML by eye or
 * trusting a live run: there's no cheap, repeatable way to make an actual
 * GitHub Actions run exercise "someone removed a job from gate's needs
 * list" and watch the aggregate wrongly pass. A live run is slow, needs a
 * real push, and by the time it would catch the mistake the mistake is
 * already merged. Parsing the workflow file here and checking its shape is
 * something a plain local test can do in milliseconds, and the test suite
 * proves this check is real (not just always green) by mutating a parsed
 * copy of the workflow and confirming it goes red.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
export const AGGREGATE_JOB_ID = "gate";

/**
 * @param {string} [filePath]
 * @returns {{ jobs: Record<string, any> }}
 */
export function loadWorkflow(filePath = WORKFLOW_PATH) {
  return loadYaml(readFileSync(filePath, "utf8"));
}

/**
 * Whether `rest` (the text immediately following a `needs.<id>.result`
 * marker) goes on, after only whitespace, to compare that result against
 * the literal string "success" with `==`.
 *
 * Written as plain string scanning rather than a dynamically-built regular
 * expression: the marker text itself comes from a job id parsed out of the
 * workflow file, and building a RegExp out of untrusted-shaped input is a
 * pattern static analysis (rightly) flags, even though a job id here can
 * only ever be workflow-author-controlled text, never end-user input.
 *
 * @param {string} rest
 * @returns {boolean}
 */
function looksLikeEqualsSuccess(rest) {
  const afterWhitespace = rest.trimStart();
  if (!afterWhitespace.startsWith("==")) {
    return false;
  }
  const afterOperator = afterWhitespace.slice(2).trimStart();
  return afterOperator.startsWith("'success'") || afterOperator.startsWith('"success"');
}

/**
 * Scans `jobText` for every occurrence of `needs.<jobId>.result` and
 * returns true if any of them is immediately followed (modulo whitespace)
 * by `== 'success'` or `== "success"`.
 *
 * @param {string} jobText
 * @param {string} jobId
 * @returns {boolean}
 */
function hasLiteralSuccessCheck(jobText, jobId) {
  const marker = `needs.${jobId}.result`;
  let searchFrom = 0;
  for (;;) {
    const at = jobText.indexOf(marker, searchFrom);
    if (at === -1) {
      return false;
    }
    if (looksLikeEqualsSuccess(jobText.slice(at + marker.length))) {
      return true;
    }
    searchFrom = at + marker.length;
  }
}

/**
 * @param {string[] | string | undefined} needs
 * @returns {string[]}
 */
function normalizeNeeds(needs) {
  if (!needs) return [];
  return Array.isArray(needs) ? needs : [needs];
}

/**
 * Flattens every run script, env value, and if-condition on a job's steps
 * (plus the job's own env block) into one string, so the literal-success
 * check below can grep it without having to evaluate GitHub's expression
 * syntax itself.
 *
 * @param {any} job
 * @returns {string}
 */
function collectJobText(job) {
  const parts = [];
  if (job?.env) parts.push(JSON.stringify(job.env));
  for (const step of job?.steps ?? []) {
    if (step.run) parts.push(step.run);
    if (step.env) parts.push(JSON.stringify(step.env));
    if (step.if) parts.push(step.if);
  }
  return parts.join("\n");
}

/**
 * Checks that `jobs[aggregateId]`:
 *   1. exists,
 *   2. lists every other job in `jobs` in its `needs`,
 *   3. has `if: always()` (so a failed/cancelled dependency can't make
 *      GitHub mark this job "skipped" instead of running it),
 *   4. somewhere in its steps, literally requires `needs.<id>.result ==
 *      'success'` for every job it depends on.
 *
 * @param {Record<string, any>} jobs
 * @param {string} [aggregateId]
 * @returns {string[]} human-readable problems found; empty means clean.
 */
export function verifyTopology(jobs, aggregateId = AGGREGATE_JOB_ID) {
  const errors = [];
  const aggregate = jobs?.[aggregateId];
  if (!aggregate) {
    return [`no "${aggregateId}" job found in the workflow`];
  }

  const otherJobIds = Object.keys(jobs).filter((id) => id !== aggregateId);
  if (otherJobIds.length === 0) {
    errors.push(`"${aggregateId}" is the only job in the workflow - nothing for it to gate`);
  }

  const needs = normalizeNeeds(aggregate.needs);
  for (const jobId of otherJobIds) {
    if (!needs.includes(jobId)) {
      errors.push(`"${aggregateId}".needs is missing "${jobId}"`);
    }
  }

  const ifCondition = typeof aggregate.if === "string" ? aggregate.if.trim() : "";
  if (ifCondition !== "always()") {
    errors.push(
      `"${aggregateId}".if must be exactly "always()" (got ${JSON.stringify(aggregate.if ?? null)})`
    );
  }

  const jobText = collectJobText(aggregate);
  for (const jobId of otherJobIds) {
    if (!hasLiteralSuccessCheck(jobText, jobId)) {
      errors.push(
        `"${aggregateId}" never checks that needs.${jobId}.result == 'success' literally - a skip or a non-success result for "${jobId}" would not be caught`
      );
    }
  }

  return errors;
}

function main() {
  const workflow = loadWorkflow();
  const errors = verifyTopology(workflow.jobs, AGGREGATE_JOB_ID);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`workflow topology error: ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `"${AGGREGATE_JOB_ID}" depends on every other job in ${path.relative(REPO_ROOT, WORKFLOW_PATH)} and literally requires each to succeed`
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
