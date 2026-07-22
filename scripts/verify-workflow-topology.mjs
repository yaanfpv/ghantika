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
 * to decide pass/fail (see `collectControllingExpressionText`). Establishing
 * that a job's check is genuinely load-bearing is NOT a text-adjacency
 * question: GitHub Actions binds `&&` tighter than `||` (same as JS), so a
 * disjunction can govern a literal from any distance away - `needs.build.
 * result == 'success' && false || true` is unconditionally true regardless
 * of build's result, even though the disjunction sits two operands away
 * from the literal, not beside it. No fixed adjacency distance can bound
 * "how far away can the disjunction be", since there is always one more
 * operand of distance between the literal and whatever governs it - which
 * is why this parses the expression and asks a semantic question instead
 * of a shape question.
 *
 * WHAT THIS FILE NOW ESTABLISHES, so it does not need re-deriving by hand:
 * `hasLiteralSuccessCheck(expressionText, jobId)` parses `expressionText`
 * into a small boolean-expression tree (`parseControllingExpression`,
 * `&&`/`||`/parentheses/`true`/`false`/`needs.<id>.result == 'success'`
 * comparisons only - GitHub Actions binds `&&` tighter than `||`, same as
 * JS, and the parser respects that), then evaluates that tree under
 * three-valued (Kleene) logic with `jobId`'s OWN success-comparison node(s)
 * forced to `FALSE` - EVERY occurrence of it, not merely the first match -
 * and every OTHER job's comparison, and anything outside the understood
 * grammar, left `UNKNOWN` (see `evaluateForcingJobFalse`). The check reports
 * "safe" only when that forced evaluation is a DEFINITE `FALSE` - meaning no
 * matter what any other unknown resolves to at real runtime, this job
 * failing to succeed makes the whole expression un-satisfiable. That is the
 * actual property "genuinely AND-conjoined with the complete expression, not
 * released by an OR anywhere" was always claiming; evaluating it under
 * precedence is what makes it true instead of assumed, and it is not bounded
 * by how many operators of distance separate the literal from a disjunction
 * - any such distance falls out of the same evaluation.
 *
 * THE BOUNDARY - what this does NOT establish: the grammar understood is
 * deliberately narrow (`&&`, `||`, parentheses, the literal booleans `true`/
 * `false`, and exactly the `needs.<id>.result == 'success'`/`== "success"`
 * comparison shape). Negation (`!`), function calls (`always()`,
 * `contains(...)`), any OTHER comparison operator or literal (`!=`, `<`,
 * `== 'failure'`), and anything the parser cannot make sense of at all
 * (malformed/unbalanced input) are NOT understood - they become an opaque
 * `UNKNOWN` leaf. Because `UNKNOWN` can never make an evaluation resolve to
 * a definite `FALSE` on its own, an expression using any of those
 * constructs is reported as NOT ESTABLISHED (the job's check is flagged as
 * missing) rather than silently accepted - this file fails CLOSED on
 * anything outside the grammar it actually understands, it does not attempt
 * to understand a wider GitHub Actions expression grammar and does not
 * claim to.
 *
 * A separate, one-level-up bypass concerns which STEP counts as controlling
 * at all (see `stepIsUnconditionallyControlling`): a step's own `if` being
 * anything other than absent or literally `true` - a computed expression,
 * say - means this file cannot confirm it actually executes, so it is
 * excluded from the search entirely, rather than assumed to run. The
 * earlier version of this check asked the opposite question (does the step
 * run at all, treating anything but the literal string "false" as running),
 * which failed OPEN: a step disabled by a usually-false computed condition
 * still had its env text searched and could satisfy a job's check even
 * though that check might never actually execute at runtime. Requiring the
 * controlling step to be unconditional instead fails CLOSED - an edit that
 * makes the controlling step conditional stops this file from trusting it,
 * which then reports every job's literal-success check as missing.
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
 * Splits `text` on every top-level occurrence of `operator` (`"&&"` or
 * `"||"`) - "top-level" meaning at paren-depth 0, so an occurrence nested
 * inside `(...)` is never a split point. Depth is tracked by a plain
 * left-to-right scan; an unmatched closing paren drives depth negative,
 * which this function does not special-case or throw on - it simply means
 * depth is never again 0 for the rest of the scan (since it would have to
 * climb back through zero from below), so no further split point is found
 * there either. That is deliberate: malformed input degrades to "no
 * top-level split found" (the whole text returned as one piece), which
 * downstream ends up an unrecognized, and therefore `UNKNOWN`, atom - never
 * a crash and never a split made up from a false read of the structure.
 *
 * @param {string} text
 * @param {"&&" | "||"} operator
 * @returns {string[]}
 */
function splitTopLevel(text, operator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && text.startsWith(operator, i)) {
      parts.push(text.slice(start, i));
      i += operator.length - 1;
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * If `text`, once trimmed, is wrapped in a SINGLE pair of parentheses that
 * genuinely encloses the whole thing - not two adjacent balanced groups
 * sitting next to each other with no operator between them, like `(a) (b)`
 * - returns the inner content (still untrimmed of its own surrounding
 * whitespace). Returns `null` otherwise.
 *
 * "Genuinely encloses the whole thing" is checked by scanning depth from
 * the first `(` and confirming it first returns to 0 exactly at the LAST
 * character, not earlier - `(a) (b)` returns to depth 0 right after `(a)`,
 * well before the string ends, so it is correctly refused here (and falls
 * through to being treated as a single unrecognized atom, not silently
 * misread as one enclosing group).
 *
 * @param {string} text
 * @returns {string | null}
 */
function stripOuterGroup(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return null;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "(") depth++;
    else if (trimmed[i] === ")") {
      depth--;
      if (depth === 0) {
        return i === trimmed.length - 1 ? trimmed.slice(1, -1) : null;
      }
    }
  }
  return null;
}

/**
 * Classifies a single atom-level term - text with no top-level `&&`/`||`
 * left to split on, and no single enclosing paren group left to strip -
 * as one of exactly three node shapes this file understands:
 *
 *  - `{ type: "literal", value: true | false }` for the bare words `true`/
 *    `false`,
 *  - `{ type: "successCheck", jobId }` for exactly `needs.<jobId>.result ==
 *    'success'` or `== "success"` (job ids may contain letters, digits,
 *    underscores and hyphens - real job ids in this repo's workflow use
 *    hyphens, e.g. `changelog-presence`),
 *  - `{ type: "unknown" }` for anything else at all: negation, a function
 *    call, a different comparison operator or literal, a malformed or
 *    truncated fragment - anything outside the three shapes above.
 *
 * `unknown` is the deliberate catch-all this file's fail-closed behavior
 * rests on: see `evaluateForcingJobFalse` for why an atom this file cannot
 * classify can never, by itself, make a forced evaluation come out
 * `FALSE` - which is the only outcome `hasLiteralSuccessCheck` accepts as
 * safe.
 *
 * @param {string} text
 * @returns {{ type: "literal", value: boolean } | { type: "successCheck", jobId: string } | { type: "unknown" }}
 */
function parseAtom(text) {
  const trimmed = text.trim();
  if (trimmed === "true") return { type: "literal", value: true };
  if (trimmed === "false") return { type: "literal", value: false };
  const match = trimmed.match(/^needs\.([A-Za-z0-9_-]+)\.result\s*==\s*(['"])success\2$/);
  if (match) return { type: "successCheck", jobId: match[1] };
  return { type: "unknown" };
}

/**
 * @param {string} text
 * @returns {object} an AST node - see `parseAtom`'s three leaf shapes, plus
 *   `{ type: "and" | "or", children: object[] }` for a conjunction/
 *   disjunction of two or more of the same.
 */
function parseAtomOrGroup(text) {
  const inner = stripOuterGroup(text);
  return inner === null ? parseAtom(text) : parseOrExpression(inner);
}

/** @param {string} text @returns {object} */
function parseAndExpression(text) {
  const parts = splitTopLevel(text, "&&");
  if (parts.length === 1) return parseAtomOrGroup(parts[0]);
  return { type: "and", children: parts.map(parseAtomOrGroup) };
}

/** @param {string} text @returns {object} */
function parseOrExpression(text) {
  const parts = splitTopLevel(text, "||");
  if (parts.length === 1) return parseAndExpression(parts[0]);
  return { type: "or", children: parts.map(parseAndExpression) };
}

/**
 * Parses `expressionText` - the job's CONTROLLING expression text (see
 * `collectControllingExpressionText`) - into the small boolean AST
 * `evaluateForcingJobFalse` understands.
 *
 * The real text collected from a workflow's `${{ ... }}` GitHub Actions
 * expression syntax still carries its `${{`/`}}` delimiters (this file
 * only ever collects raw YAML string values - it does not evaluate GitHub
 * Actions expressions, only this deliberately narrow subset of their
 * grammar), so those markers are stripped globally before parsing; neither
 * is part of the boolean grammar this file understands, and leaving either
 * in place would make even a fully well-formed expression fail to parse as
 * a single top-level structure.
 *
 * @param {string} expressionText
 * @returns {object} an AST node (see `parseAtom`/`parseAndExpression`/`parseOrExpression`)
 */
export function parseControllingExpression(expressionText) {
  const cleaned = expressionText.replace(/\$\{\{|\}\}/g, "");
  return parseOrExpression(cleaned);
}

/**
 * True if `node` (or any of its descendants) is a `successCheck` atom for
 * exactly `jobId`. `hasLiteralSuccessCheck` uses this first, before any
 * evaluation, so a job whose success comparison never appears in the
 * expression at all is still reported as unchecked - matching the original
 * behavior of "the marker was never found."
 *
 * @param {object} node
 * @param {string} jobId
 * @returns {boolean}
 */
function containsSuccessCheckForJob(node, jobId) {
  if (node.type === "successCheck") return node.jobId === jobId;
  if (node.type === "and" || node.type === "or") {
    return node.children.some((child) => containsSuccessCheckForJob(child, jobId));
  }
  return false;
}

/**
 * Evaluates `node` under three-valued (Kleene) logic, with EVERY
 * `successCheck` atom for `jobId` - not merely the first one encountered;
 * this function has no shared/mutable state, so an atom's evaluation
 * never depends on whether an earlier occurrence of the same job's atom
 * was already visited - forced to `FALSE`. Every OTHER job's `successCheck`
 * atom, and every `unknown` atom (anything outside the grammar `parseAtom`
 * understands: negation, function calls, other operators, malformed
 * fragments), evaluates to `UNKNOWN`, since its real runtime value cannot
 * be known statically and treating it as knowable in either direction
 * would be unsound.
 *
 * Returns one of the three literal strings `"TRUE"`, `"FALSE"`, `"UNKNOWN"`:
 *  - `AND`: `FALSE` if any child is `FALSE` (regardless of the others -
 *    this is what makes an `unknown`/malformed sibling harmless when
 *    ANDed with a job's now-forced-false check); `TRUE` only if every
 *    child is `TRUE`; otherwise `UNKNOWN`.
 *  - `OR`: `TRUE` if any child is `TRUE` (this is what makes a disjunction
 *    with a literal `true` anywhere in it - adjacent to the literal or not
 *    - correctly resolve `TRUE` regardless of the forced job); `FALSE`
 *    only if every child is `FALSE`; otherwise `UNKNOWN`.
 *
 * `hasLiteralSuccessCheck` reports the job's check as established only
 * when this returns a definite `FALSE` for the whole tree - meaning no
 * matter what any `UNKNOWN` resolves to at real runtime, forcing this
 * job's result away from `'success'` makes the entire expression
 * unsatisfiable. Reporting "safe" on anything less certain (`UNKNOWN` or
 * `TRUE`) would be exactly the class of bypass this file exists to close.
 *
 * @param {object} node
 * @param {string} jobId
 * @returns {"TRUE" | "FALSE" | "UNKNOWN"}
 */
export function evaluateForcingJobFalse(node, jobId) {
  if (node.type === "literal") return node.value ? "TRUE" : "FALSE";
  if (node.type === "successCheck") return node.jobId === jobId ? "FALSE" : "UNKNOWN";
  if (node.type === "unknown") return "UNKNOWN";

  const values = node.children.map((child) => evaluateForcingJobFalse(child, jobId));
  if (node.type === "and") {
    if (values.some((v) => v === "FALSE")) return "FALSE";
    if (values.every((v) => v === "TRUE")) return "TRUE";
    return "UNKNOWN";
  }
  // node.type === "or"
  if (values.some((v) => v === "TRUE")) return "TRUE";
  if (values.every((v) => v === "FALSE")) return "FALSE";
  return "UNKNOWN";
}

/**
 * Whether `expressionText` genuinely requires `needs.<jobId>.result ==
 * 'success'` for the whole expression to be able to evaluate true - see
 * this file's own top-of-file doc comment for the full property this
 * establishes and its boundary. In short: parses `expressionText` into a
 * small boolean AST (`parseControllingExpression`), confirms a
 * success-check atom for `jobId` appears in it at all, then evaluates the
 * whole tree with every occurrence of that atom forced `FALSE`
 * (`evaluateForcingJobFalse`) - reporting safe only when that forced
 * evaluation is a definite `FALSE`, regardless of how many operators of
 * distance separate the literal from any disjunction, and regardless of
 * whether the expression also contains constructs outside this file's
 * understood grammar (which evaluate to `UNKNOWN` and can therefore never
 * by themselves turn a forced evaluation `FALSE` into something else).
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
  const ast = parseControllingExpression(expressionText);
  if (!containsSuccessCheckForJob(ast, jobId)) return false;
  return evaluateForcingJobFalse(ast, jobId) === "FALSE";
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
 *      == 'success'`, genuinely a conjunct of the whole expression rather
 *      than reachable to `true` through any disjunction (see
 *      `hasLiteralSuccessCheck`), for every job it depends on.
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
 * Reuses `hasLiteralSuccessCheck` - the same precedence-aware, disjunction-
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
