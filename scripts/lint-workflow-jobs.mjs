#!/usr/bin/env node
/**
 * Structural lints over .github/workflows/ci.yml that go beyond the
 * needs/if topology scripts/verify-workflow-topology.mjs checks:
 *
 *  - no job the "gate" aggregate depends on may set `continue-on-error:
 *    true` anywhere, since that would let a step (and therefore the job)
 *    report success on GitHub's dashboard while actually having failed -
 *    exactly the kind of pass-that-isn't-a-pass the gate job exists to
 *    rule out.
 *  - the `test` job's matrix has to cover every combination of operating
 *    system and Node version this project claims to support, so a leg
 *    can't quietly go missing (e.g. nobody notices Windows + Node 24 was
 *    dropped from the matrix).
 *  - the workflow's job list must never contain a job pretending to be
 *    secret scanning or Dependabot - those are GitHub repository settings
 *    (and, for Dependabot, a separate .github/dependabot.yml config file),
 *    not something a workflow job can meaningfully stand in for.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

import { isMainModule } from "./lib/is-main.mjs";
import { forEachDescendant, parseSourceFile, ts } from "./lib/ts-ast.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const THIS_FILE_PATH = fileURLToPath(import.meta.url);

export const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
export const AGGREGATE_JOB_ID = "gate";
export const TEST_JOB_ID = "test";
export const EXPECTED_OS = ["ubuntu-latest", "macos-latest"];
export const EXPECTED_NODE = ["22", "24"];

/**
 * The independent, hard-coded closed set of "<os>::<node>" legs the real
 * `test` job matrix must contain - written directly here as a literal
 * array of string literals, never derived from `EXPECTED_OS`/
 * `EXPECTED_NODE` above. This is the PRODUCTION location the underlying
 * design specifies: a constant declared only in a test file protects
 * just that test, while this file's own `main()` - which CI's `lint` job
 * actually runs - would keep shipping the weaker, derived check. A
 * coordinated edit that shrinks BOTH the real workflow matrix AND
 * `EXPECTED_OS`/`EXPECTED_NODE` together leaves this list untouched, so
 * `verifyIndependentMatrixLegs` below still catches it.
 *
 * See `verifyIndependentLegsIsLiteral` for the SEPARATE, mandatory
 * guarantee that this declaration STAYS a literal - the entry a coordinated
 * edit would need to touch to defeat this list is exactly the shape that
 * function is built to catch.
 */
export const INDEPENDENT_EXPECTED_LEGS = [
  "ubuntu-latest::22",
  "ubuntu-latest::24",
  "macos-latest::22",
  "macos-latest::24",
];

export const FORBIDDEN_JOB_IDS = [
  "secret-scan",
  "secret_scan",
  "secret-scanning",
  "dependabot",
  "dependabot-alerts",
  "dependabot_alerts",
];

/**
 * @param {string} [filePath]
 * @returns {{ jobs: Record<string, any> }}
 */
export function loadWorkflow(filePath = WORKFLOW_PATH) {
  return loadYaml(readFileSync(filePath, "utf8"));
}

/**
 * Whether a `continue-on-error` value should be treated as a violation.
 * Only two values are safe: the field being absent, or the literal boolean
 * `false`. Everything else is a violation - not just the literal boolean
 * `true`, but also a quoted string like `"true"` (YAML accepts
 * continue-on-error as a string and GitHub Actions treats it the same as
 * the boolean at runtime) and, most importantly, a GitHub Actions
 * expression such as `${{ matrix.allow_failure }}`. An expression's actual
 * value can only be known at real runtime, from context this static check
 * never has - so it cannot be waved through just because it isn't the
 * literal boolean `true`. An expression that MIGHT resolve to true is
 * exactly as dangerous as one that always does: it lets a step (and
 * therefore the job) report success while having actually failed, on some
 * runs and not others, which is worse than the always-true case because it
 * would pass a naive `=== true` check forever.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isContinueOnErrorViolation(value) {
  return value !== undefined && value !== false;
}

/**
 * Every job except the aggregate is a job the aggregate is meant to be
 * gating on, so a truthy or expression-valued `continue-on-error` is
 * forbidden anywhere in it - on the job itself or on any of its steps.
 *
 * @param {Record<string, any>} jobs
 * @param {string} [aggregateId]
 * @returns {string[]} ids of jobs with a forbidden continue-on-error
 */
export function findContinueOnError(jobs, aggregateId = AGGREGATE_JOB_ID) {
  const offenders = [];
  for (const [jobId, job] of Object.entries(jobs ?? {})) {
    if (jobId === aggregateId) continue;
    const onJob = isContinueOnErrorViolation(job?.["continue-on-error"]);
    const onAnyStep = (job?.steps ?? []).some((step) =>
      isContinueOnErrorViolation(step?.["continue-on-error"])
    );
    if (onJob || onAnyStep) {
      offenders.push(jobId);
    }
  }
  return offenders;
}

/**
 * The gate aggregate's OWN `continue-on-error` usage - deliberately a
 * SEPARATE check from `findContinueOnError` above, which excludes the
 * aggregate by id on purpose (it is checking jobs the aggregate DEPENDS
 * on, and the aggregate does not depend on itself). That exclusion left a
 * real gap: nothing checked whether `gate` itself, or any of its own
 * steps - including the one step that exits 1 when a required job did not
 * literally succeed - carries a `continue-on-error` that would let GATE
 * ITSELF report success while its own check failed. That is strictly
 * worse than the excluded case, since `gate` is the one required check a
 * branch-protection rule actually points at. Same
 * `isContinueOnErrorViolation` predicate (only absent or literal `false`
 * is safe), applied to the aggregate job and each of its own steps by
 * index, so a violation names exactly where it was found.
 *
 * @param {Record<string, any>} jobs
 * @param {string} [aggregateId]
 * @returns {string[]} human-readable locations where the aggregate itself carries a forbidden continue-on-error
 */
export function findGateOwnContinueOnError(jobs, aggregateId = AGGREGATE_JOB_ID) {
  const aggregate = jobs?.[aggregateId];
  if (aggregate === undefined) return [];
  const violations = [];
  if (isContinueOnErrorViolation(aggregate["continue-on-error"])) {
    violations.push(`"${aggregateId}" job level`);
  }
  (aggregate.steps ?? []).forEach((step, index) => {
    if (isContinueOnErrorViolation(step?.["continue-on-error"])) {
      violations.push(`"${aggregateId}".steps[${index}]`);
    }
  });
  return violations;
}

/**
 * Cross-products a matrix's `os` and `node` axes, honoring `exclude`
 * entries, into a flat list of "<os>::<node>" leg keys.
 *
 * @param {{ os?: string[], node?: (string | number)[], exclude?: any[] }} [matrix]
 * @returns {string[]}
 */
export function computeMatrixLegs(matrix) {
  const osList = matrix?.os ?? [];
  const nodeList = matrix?.node ?? [];
  const excludes = matrix?.exclude ?? [];
  const legs = [];
  for (const os of osList) {
    for (const node of nodeList) {
      const excluded = excludes.some(
        (entry) =>
          (entry.os === undefined || entry.os === os) && String(entry.node) === String(node)
      );
      if (!excluded) {
        legs.push(`${os}::${node}`);
      }
    }
  }
  return legs;
}

/**
 * @param {any} job
 * @param {string[]} [expectedOs]
 * @param {string[]} [expectedNode]
 * @returns {string[]} "<os>::<node>" keys that are missing from the matrix
 */
export function verifyMatrixCompleteness(
  job,
  expectedOs = EXPECTED_OS,
  expectedNode = EXPECTED_NODE
) {
  const present = new Set(computeMatrixLegs(job?.strategy?.matrix));
  const missing = [];
  for (const os of expectedOs) {
    for (const node of expectedNode) {
      const key = `${os}::${node}`;
      if (!present.has(key)) {
        missing.push(key);
      }
    }
  }
  return missing;
}

/**
 * Checks the real matrix's legs against `INDEPENDENT_EXPECTED_LEGS`
 * directly - never against `EXPECTED_OS`/`EXPECTED_NODE`, which is
 * exactly the derivation `verifyMatrixCompleteness` above uses and which
 * a coordinated edit could shrink in lockstep with the real matrix. This
 * is the independent oracle the mutation matrix's SELF/KEEP/WIN sections
 * require.
 *
 * @param {any} job
 * @returns {{ missing: string[], extra: string[] }}
 */
export function verifyIndependentMatrixLegs(job) {
  const actualLegs = computeMatrixLegs(job?.strategy?.matrix);
  const actualSet = new Set(actualLegs);
  const missing = INDEPENDENT_EXPECTED_LEGS.filter((leg) => !actualSet.has(leg));
  const extra = actualLegs.filter((leg) => !INDEPENDENT_EXPECTED_LEGS.includes(leg));
  return { missing, extra };
}

/**
 * THE MANDATORY META-GUARD (mutation matrix row SELF-8): confirms
 * `INDEPENDENT_EXPECTED_LEGS` above is STILL a genuine hard-coded literal
 * - a plain array of string literals with no computed element - and not
 * quietly weakened back into a derived product of `EXPECTED_OS` x
 * `EXPECTED_NODE`. Proven necessary, not theoretical: QA mutated the
 * declaration to `EXPECTED_OS.flatMap((os) => EXPECTED_NODE.map((node) =>
 * \`${os}::${node}\`))` and the full guard-test suite still passed 10/10,
 * because nothing checked the declaration's own SHAPE. Every other check
 * in this file only ever reads the exported VALUE of
 * `INDEPENDENT_EXPECTED_LEGS`, which looks identical whether it came from
 * a literal or a derivation that happens to currently agree with it - the
 * escape is invisible from the value alone, which is why this reads the
 * declaration's SOURCE instead.
 *
 * Parses THIS FILE'S OWN source text (via the same real TypeScript AST
 * machinery `scripts/lib/ts-ast.mjs` already uses for the module-loader
 * guards, not string matching) and walks it looking for the
 * `INDEPENDENT_EXPECTED_LEGS` variable declaration. Passes only when its
 * initializer is an `ArrayLiteralExpression` whose every element is a
 * plain string literal (or no-substitution template) - fails closed on
 * anything else: a call expression, a spread, an identifier reference
 * (which would mean it now reads from somewhere else, e.g.
 * `EXPECTED_OS`), a template with interpolation, or the declaration being
 * missing entirely.
 *
 * @param {string} [sourceText] defaults to reading this file's own source from disk
 * @returns {{ isLiteral: boolean, reason?: string }}
 */
export function verifyIndependentLegsIsLiteral(sourceText = readFileSync(THIS_FILE_PATH, "utf8")) {
  const sourceFile = parseSourceFile(THIS_FILE_PATH, sourceText);
  let declaration;
  forEachDescendant(sourceFile, (node) => {
    if (declaration !== undefined) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "INDEPENDENT_EXPECTED_LEGS"
    ) {
      declaration = node;
    }
  });

  if (declaration === undefined) {
    return { isLiteral: false, reason: "INDEPENDENT_EXPECTED_LEGS declaration not found at all" };
  }
  const initializer = declaration.initializer;
  if (initializer === undefined || !ts.isArrayLiteralExpression(initializer)) {
    return {
      isLiteral: false,
      reason: "INDEPENDENT_EXPECTED_LEGS is not initialized with a plain array literal",
    };
  }
  for (const element of initializer.elements) {
    const isPlainString =
      ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element);
    if (!isPlainString) {
      return {
        isLiteral: false,
        reason: `INDEPENDENT_EXPECTED_LEGS contains a non-literal element (kind ${ts.SyntaxKind[element.kind]}) - it is no longer a genuine hard-coded closed set`,
      };
    }
  }
  return { isLiteral: true };
}

/**
 * @param {Record<string, any>} jobs
 * @returns {string[]} forbidden job ids present in the workflow
 */
export function findForbiddenGovernanceJobs(jobs) {
  return Object.keys(jobs ?? {}).filter((id) => FORBIDDEN_JOB_IDS.includes(id));
}

function main() {
  const workflow = loadWorkflow();
  const jobs = workflow.jobs ?? {};
  const errors = [];

  const continueOnErrorOffenders = findContinueOnError(jobs, AGGREGATE_JOB_ID);
  for (const jobId of continueOnErrorOffenders) {
    errors.push(
      `job "${jobId}" sets continue-on-error: true, which would let it report success while actually failing`
    );
  }

  const gateOwnOffenders = findGateOwnContinueOnError(jobs, AGGREGATE_JOB_ID);
  for (const location of gateOwnOffenders) {
    errors.push(
      `${location} sets continue-on-error to something other than absent/false, which would let the aggregate itself report success while its own required-success check failed`
    );
  }

  const testJob = jobs[TEST_JOB_ID];
  if (!testJob) {
    errors.push(`no "${TEST_JOB_ID}" job found in the workflow`);
  } else {
    const missingLegs = verifyMatrixCompleteness(testJob);
    for (const leg of missingLegs) {
      errors.push(`"${TEST_JOB_ID}" matrix is missing the ${leg.replace("::", " / node ")} leg`);
    }

    const independentResult = verifyIndependentMatrixLegs(testJob);
    for (const leg of independentResult.missing) {
      errors.push(`"${TEST_JOB_ID}" matrix is missing the independently-required leg ${leg}`);
    }
    for (const leg of independentResult.extra) {
      errors.push(
        `"${TEST_JOB_ID}" matrix contains ${leg}, which is not in the independent expected-legs list`
      );
    }
  }

  const literalCheck = verifyIndependentLegsIsLiteral();
  if (!literalCheck.isLiteral) {
    errors.push(`meta-guard failure: ${literalCheck.reason}`);
  }

  const forbiddenJobs = findForbiddenGovernanceJobs(jobs);
  for (const jobId of forbiddenJobs) {
    errors.push(
      `job "${jobId}" is a repository setting (or a dependabot.yml config), not a workflow job - remove it`
    );
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`workflow lint error: ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `${path.relative(REPO_ROOT, WORKFLOW_PATH)} is clean: no continue-on-error (including on gate itself), full test matrix against both the derived and independent oracles, no fake governance jobs`
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
