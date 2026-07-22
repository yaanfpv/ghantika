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
 *
 * The literal-success search is bound to the job's CONTROLLING expression
 * only - the specific `env` value some step's `run` script actually reads
 * to decide pass/fail (see `collectControllingExpressionText`) - and, once
 * found there, is rejected if it sits inside a `||` disjunction on EITHER
 * side rather than being genuinely AND-conjoined with the rest of the
 * expression (see `hasLiteralSuccessCheck`, `isFollowedByDisjunction`,
 * `isPrecededByDisjunction`). These restrictions close a proven set of
 * bypasses that a plain "does this substring appear anywhere on the job"
 * search could not: (1) `needs.build.result == 'success' || true`, a
 * trailing disjunction that makes the clause vacuously true regardless of
 * the job's real result while the substring search still finds an
 * unbroken "== 'success'" right after the marker; (2) `(true ||
 * needs.build.result == 'success')`, the same vacuous-truth bypass
 * mirrored onto a LEADING disjunction - which side of the literal the
 * `||` is written on is an implementation detail, not a different class;
 * and (3) removing a job from the REAL controlling expression while
 * leaving decoy literal text (an unused env entry, a comment inside an
 * unrelated step, a step that never runs) elsewhere on the job, which a
 * search over the job's ENTIRE flattened env/run/if text would still find
 * and wrongly call clean.
 *
 * A fourth bypass sits one level up, in which STEP counts as controlling
 * at all (see `stepIsUnconditionallyControlling`): a step's own `if`
 * being anything other than absent or literally `true` - a computed
 * expression, say - means this file cannot confirm it actually executes,
 * so it is excluded from the search entirely, rather than assumed to run.
 * The earlier version of this check asked the opposite question (does
 * the step run at all, treating anything but the literal string "false"
 * as running), which failed OPEN: a step disabled by a usually-false
 * computed condition still had its env text searched and could satisfy a
 * job's check even though that check might never actually execute at
 * runtime. Requiring the controlling step to be unconditional instead
 * fails CLOSED - an edit that makes the controlling step conditional
 * stops this file from trusting it, which then reports every job's
 * literal-success check as missing.
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
 * The independent, hard-coded inventory of jobs `gate` must require - read
 * directly off the real `ci.yml`'s job set and written here as a literal
 * array, never derived from the workflow file `verifyTopology` below
 * parses. `verifyTopology` computes "which jobs must gate depend on" as
 * `Object.keys(jobs)` on the SAME file it is checking, so a coordinated
 * edit that deletes a job ENTIRELY - not just from `gate.needs`, but the
 * job definition itself, plus its `needs` edge, plus its clause in
 * `gate`'s success-expression, all at once - removes that job from
 * consideration everywhere in the same motion, and `verifyTopology` has
 * nothing left in the mutated file to compare it against.
 * `verifyIndependentRequiredJobs` below checks against THIS list instead,
 * so a coordinated deletion like that still gets caught, by name.
 */
export const INDEPENDENT_REQUIRED_JOB_IDS = [
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

/**
 * @param {string} [filePath]
 * @returns {{ jobs: Record<string, any> }}
 */
export function loadWorkflow(filePath = WORKFLOW_PATH) {
  return loadYaml(readFileSync(filePath, "utf8"));
}

/**
 * If `rest` (the text immediately following a `needs.<id>.result` marker)
 * goes on, after only whitespace, to compare that result against the
 * literal string "success" with `==`, returns the text remaining right
 * after that literal - so the caller can inspect what comes next (a real
 * `&&` conjunction, the end of the expression, or a `||` disjunction).
 * Returns `null` when `rest` does not open with a literal-success
 * comparison at all.
 *
 * Written as plain string scanning rather than a dynamically-built regular
 * expression: the marker text itself comes from a job id parsed out of the
 * workflow file, and building a RegExp out of untrusted-shaped input is a
 * pattern static analysis (rightly) flags, even though a job id here can
 * only ever be workflow-author-controlled text, never end-user input.
 *
 * @param {string} rest
 * @returns {string | null}
 */
function matchLiteralSuccessRemainder(rest) {
  const afterWhitespace = rest.trimStart();
  if (!afterWhitespace.startsWith("==")) {
    return null;
  }
  const afterOperator = afterWhitespace.slice(2).trimStart();
  for (const literal of ["'success'", '"success"']) {
    if (afterOperator.startsWith(literal)) {
      return afterOperator.slice(literal.length);
    }
  }
  return null;
}

/**
 * Whether `remainder` (the text immediately following a matched
 * `needs.<id>.result == 'success'` literal) opens - after skipping only
 * whitespace and any closing parens a grouped clause like
 * `(needs.x.result == 'success')` would interpose - onto a `||`
 * disjunction.
 *
 * A disjunction there can make the whole clause true regardless of
 * whether `needs.<id>` actually succeeded: `... == 'success' || true` is
 * the textbook case, but `|| anything-else` is exactly as vacuous, since a
 * disjunction only needs ONE side to be true. This is therefore a general
 * rejection of "what follows is a `||`", not a special case for the
 * literal text `|| true`: a legitimate chain of required checks joins
 * every clause with `&&` (every side must be true for the chain to be
 * true), so the only place `||` is safe to allow is nowhere within a
 * clause this check is trusting to gate the job.
 *
 * @param {string} remainder
 * @returns {boolean}
 */
function isFollowedByDisjunction(remainder) {
  let text = remainder;
  for (;;) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith(")")) {
      text = trimmed.slice(1);
      continue;
    }
    text = trimmed;
    break;
  }
  return text.startsWith("||");
}

/**
 * The mirror of `isFollowedByDisjunction`: whether `precedingText` (the
 * text immediately BEFORE a matched `needs.<id>.result == 'success'`
 * literal) ends - after skipping only whitespace and any opening parens a
 * grouped clause like `(needs.x.result == 'success')` would interpose -
 * in a `||` disjunction.
 *
 * The bypass this closes is the mirror image of the trailing case:
 * `(true || needs.build.result == 'success') && ...` presents the literal
 * with nothing but `)` then `&&` AFTER it, so a trailing-only check
 * accepts it - but the clause is exactly as vacuously true as `needs.
 * build.result == 'success' || true` is, since `true ||` needs nothing
 * else to be true. The class this guards against is "the literal sits
 * inside a disjunction", and which side of the literal the `||` is
 * written on is an implementation detail of how someone phrases it, not a
 * different bypass.
 *
 * @param {string} precedingText
 * @returns {boolean}
 */
function isPrecededByDisjunction(precedingText) {
  let text = precedingText;
  for (;;) {
    const trimmed = text.trimEnd();
    if (trimmed.endsWith("(")) {
      text = trimmed.slice(0, -1);
      continue;
    }
    text = trimmed;
    break;
  }
  return text.endsWith("||");
}

/**
 * Scans `expressionText` for every occurrence of `needs.<jobId>.result`
 * and returns true if any of them is immediately followed (modulo
 * whitespace) by a literal `== 'success'`/`== "success"` comparison that
 * is not itself sitting inside a `||` disjunction on EITHER side - not
 * immediately released into one after the literal (see
 * `isFollowedByDisjunction`: `needs.x.result == 'success' || true`), and
 * not immediately entered from one before the marker (see
 * `isPrecededByDisjunction`: `(true || needs.x.result == 'success')`).
 * Both spellings make the surrounding clause true regardless of the job's
 * actual result, since a disjunction only needs one side to hold - which
 * side of the literal it is written on does not change that.
 *
 * `expressionText` is expected to be the job's CONTROLLING expression text
 * (see `collectControllingExpressionText`), not the job's entire
 * flattened env/run/if text: a decoy occurrence of this same substring
 * sitting anywhere else on the job (an unused env entry, a comment inside
 * an unrelated step's run script, a step that never runs) is never part
 * of that corpus in the first place, so it cannot satisfy this check no
 * matter how it is shaped.
 *
 * @param {string} expressionText
 * @param {string} jobId
 * @returns {boolean}
 */
export function hasLiteralSuccessCheck(expressionText, jobId) {
  const marker = `needs.${jobId}.result`;
  let searchFrom = 0;
  for (;;) {
    const at = expressionText.indexOf(marker, searchFrom);
    if (at === -1) {
      return false;
    }
    const remainder = matchLiteralSuccessRemainder(expressionText.slice(at + marker.length));
    if (
      remainder !== null &&
      !isFollowedByDisjunction(remainder) &&
      !isPrecededByDisjunction(expressionText.slice(0, at))
    ) {
      return true;
    }
    searchFrom = at + marker.length;
  }
}

/**
 * @param {string[] | string | undefined} needs
 * @returns {string[]}
 */
export function normalizeNeeds(needs) {
  if (!needs) return [];
  return Array.isArray(needs) ? needs : [needs];
}

/**
 * Whether `step`'s own `if` can be TRUSTED to mean "this step
 * unconditionally executes" - a POSITIVE requirement, not a guess at
 * whether some other condition happens to be resolvable. Exactly two
 * shapes qualify: no `if` at all, or an `if` that is the literal `true`
 * (as a YAML boolean or as the string `"true"`). Anything else - `false`,
 * `always()`, or any computed GitHub Actions expression - means this file
 * cannot confirm the step actually runs, so it must not be trusted as a
 * job's controlling step.
 *
 * This used to ask the opposite question (`stepActuallyRuns`: does
 * GitHub Actions actually execute this step, treating anything other
 * than the literal string "false" as running) - which failed OPEN. A
 * step disabled by a computed, usually-false `if` still counted as
 * running, so its env text still entered the search corpus and could
 * satisfy a job's literal-success check even though that step's real
 * runtime behavior is to be skipped - reporting "checked" for a job whose
 * only real check might never execute. Requiring the controlling step to
 * be unconditional instead fails CLOSED: an edit that gives the
 * controlling step any conditional `if` makes this file stop trusting it
 * (see `collectControllingExpressionText`), which then makes every job's
 * literal-success check report missing - noisy if that edit was
 * legitimate, but never silently blind to it either way.
 *
 * This is entirely separate from a JOB-level `if` (e.g. `gate`'s own
 * `if: always()`, required so a failed dependency doesn't leave `gate`
 * marked "skipped" instead of run) - this function only ever inspects a
 * STEP's own `if`, never a job's.
 *
 * @param {any} step
 * @returns {boolean}
 */
function stepIsUnconditionallyControlling(step) {
  const condition = step?.if;
  if (condition === undefined) return true;
  if (condition === true) return true;
  return typeof condition === "string" && condition.trim() === "true";
}

/**
 * Finds `job`'s CONTROLLING expression text: the `env` value(s) that some
 * step's own `run` script actually reads (as a shell variable, `$NAME` or
 * `${NAME}`) while deciding whether to exit non-zero, joined into one
 * string.
 *
 * This is the corpus `hasLiteralSuccessCheck` searches, and it is
 * deliberately narrower than flattening the whole job's env/run/if text
 * into one blob (this file's previous approach): a literal-success
 * comparison sitting somewhere no run script ever reads - an unused
 * `env:` entry, a comment inside an unrelated step, a step whose `if`
 * never runs - is exactly the kind of decoy that let the old, wider
 * search be satisfied without the gate actually requiring that job to
 * succeed. Restricting the search surface to text genuinely wired into a
 * pass/fail decision means a decoy planted anywhere else on the job never
 * enters the corpus at all, regardless of what words it contains.
 *
 * "actually reads ... while deciding whether to exit non-zero" is, like
 * the rest of this file, plain string scanning rather than a shell
 * parser: a step counts as controlling when it (a) is UNCONDITIONAL (see
 * `stepIsUnconditionallyControlling` - no `if` at all, or a literal
 * `true`; anything else means this file cannot trust that the step
 * genuinely runs, so it is excluded rather than assumed to run), (b) has
 * a `run` script, (c) that script contains the literal substring "exit"
 * (so the script can plausibly terminate the job, not merely log
 * something), and (d) that script also shell-references one of its own
 * env keys (`$KEY` or `${KEY}`, checked against the merged job-level +
 * step-level env). This matches the real `gate` job's single "require
 * every job above to have literally succeeded" step exactly (which has
 * no `if` today), and generalizes to any workflow shaped the same way
 * (one or more unconditional steps that read an env-carried boolean
 * expression and exit non-zero when it isn't "true"), without
 * hard-coding the variable's name.
 *
 * @param {any} job
 * @returns {string} the controlling expression text (empty if none found)
 */
export function collectControllingExpressionText(job) {
  const texts = [];
  const jobEnv = job?.env ?? {};
  for (const step of job?.steps ?? []) {
    if (!stepIsUnconditionallyControlling(step)) continue;
    if (typeof step.run !== "string" || !step.run.includes("exit")) continue;
    const env = { ...jobEnv, ...(step.env ?? {}) };
    for (const [key, value] of Object.entries(env)) {
      if (step.run.includes(`$${key}`) || step.run.includes(`\${${key}}`)) {
        texts.push(String(value));
      }
    }
  }
  return texts.join("\n");
}

/**
 * Checks that `jobs[aggregateId]`:
 *   1. exists,
 *   2. lists every other job in `jobs` in its `needs`,
 *   3. has `if: always()` (so a failed/cancelled dependency can't make
 *      GitHub mark this job "skipped" instead of running it),
 *   4. within its CONTROLLING expression (see
 *      `collectControllingExpressionText` - the text some step's `run`
 *      script actually reads to decide pass/fail, not the job's entire
 *      flattened env/run/if text), literally requires `needs.<id>.result
 *      == 'success'`, genuinely AND-conjoined with the rest of that
 *      expression rather than released by a trailing `||` disjunction
 *      (see `hasLiteralSuccessCheck`), for every job it depends on.
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

  const controllingText = collectControllingExpressionText(aggregate);
  for (const jobId of otherJobIds) {
    if (!hasLiteralSuccessCheck(controllingText, jobId)) {
      errors.push(
        `"${aggregateId}" never checks that needs.${jobId}.result == 'success' literally - a skip or a non-success result for "${jobId}" would not be caught`
      );
    }
  }

  return errors;
}

/**
 * Checks `jobs[aggregateId]` against `INDEPENDENT_REQUIRED_JOB_IDS`
 * instead of `Object.keys(jobs)` - see that constant's own doc comment for
 * why: `verifyTopology` above derives its own expectations from the same
 * file it is checking, so a coordinated edit that deletes a job entirely
 * (its definition, its `needs` edge, and its clause in `gate`'s
 * success-expression, all at once) removes that job from consideration on
 * BOTH sides of `verifyTopology`'s comparison in the same motion, leaving
 * nothing in the mutated file for it to notice against. This function's
 * expectation is a literal array written directly in this file, so that
 * same coordinated deletion still leaves an id this check names by hand
 * and can report as missing.
 *
 * Reuses `hasLiteralSuccessCheck` - the same ADJACENCY-aware, disjunction-
 * rejecting check `verifyTopology` uses, not a weaker two-independent-
 * substrings test: `jobText.includes("needs.x.result") &&
 * jobText.includes("'success'")` would pass even when those two
 * substrings belong to two DIFFERENT jobs' checks rather than the same
 * one, which is exactly the escape a paired-shrink mutation could walk
 * through undetected. Likewise searches only `job`'s CONTROLLING
 * expression text (see `collectControllingExpressionText`), not its
 * entire flattened env/run/if text, so a literal-success comparison
 * planted anywhere else on the job - a decoy env entry no run script
 * reads, a step that never runs - cannot satisfy this check either.
 *
 * @param {Record<string, any>} jobs
 * @param {string} [aggregateId]
 * @returns {string[]} human-readable problems found; empty means clean.
 */
export function verifyIndependentRequiredJobs(jobs, aggregateId = AGGREGATE_JOB_ID) {
  const errors = [];
  const aggregate = jobs?.[aggregateId];
  if (!aggregate) {
    return [`no "${aggregateId}" job found in the workflow`];
  }

  const needs = normalizeNeeds(aggregate.needs);
  const controllingText = collectControllingExpressionText(aggregate);

  for (const jobId of INDEPENDENT_REQUIRED_JOB_IDS) {
    if (jobs?.[jobId] === undefined) {
      errors.push(
        `"${jobId}" is on the independent required-job list but no longer exists as a job in the workflow at all`
      );
      continue;
    }
    if (!needs.includes(jobId)) {
      errors.push(`"${aggregateId}".needs is missing "${jobId}" (independent required-job list)`);
    }
    if (!hasLiteralSuccessCheck(controllingText, jobId)) {
      errors.push(
        `"${aggregateId}" never checks that needs.${jobId}.result == 'success' literally for "${jobId}" (independent required-job list) - a skip or a non-success result would not be caught`
      );
    }
  }

  return errors;
}

function main() {
  const workflow = loadWorkflow();
  const errors = [
    ...verifyTopology(workflow.jobs, AGGREGATE_JOB_ID),
    ...verifyIndependentRequiredJobs(workflow.jobs, AGGREGATE_JOB_ID),
  ];
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
