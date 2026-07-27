import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  TRACKED_DEPENDENCY_NAME,
  TRACKED_PR_NUMBER,
  TRACKED_PR_REPO_SLUG,
  checkDependabotHasNoTypescriptIgnore,
  checkTrackingSignal,
  dependabotNamePatternMatches,
  fetchLivePrState,
} from "../scripts/check-typescript-tracking-signal.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// This suite proves the PURE logic (parsing, glob matching, combining
// already-resolved facts) and fetchLivePrState's own parsing/error-
// handling against an INJECTED fake command runner. It never calls the
// real `gh` binary or touches the network - see
// scripts/check-typescript-tracking-signal.mjs's own header comment, and
// test/actionlint-pin.test.js's identical "a fake curl, so nothing ever
// touches the network" convention this suite follows.

// =============================================================================
// dependabotNamePatternMatches - Dependabot's own "*"-wildcard glob syntax
// for "dependency-name", narrowly implemented.
// =============================================================================

test("dependabotNamePatternMatches: an exact literal pattern matches only that exact name", () => {
  assert.equal(dependabotNamePatternMatches("typescript", "typescript"), true);
  assert.equal(dependabotNamePatternMatches("typescript", "typescript-eslint"), false);
  assert.equal(dependabotNamePatternMatches("typescript-eslint", "typescript"), false);
});

test("dependabotNamePatternMatches: is case-insensitive, matching npm's own case-insensitive package-name convention", () => {
  assert.equal(dependabotNamePatternMatches("TypeScript", "typescript"), true);
});

test("dependabotNamePatternMatches: a trailing wildcard matches the bare name and any suffix", () => {
  assert.equal(dependabotNamePatternMatches("typescript*", "typescript"), true);
  assert.equal(dependabotNamePatternMatches("typescript*", "typescript-eslint"), true);
  assert.equal(dependabotNamePatternMatches("typescript*", "not-typescript"), false);
});

test("dependabotNamePatternMatches: a bare wildcard matches everything, including typescript", () => {
  assert.equal(dependabotNamePatternMatches("*", "typescript"), true);
});

// =============================================================================
// checkDependabotHasNoTypescriptIgnore - a pure parse of synthetic YAML
// text, then a real read of THIS repo's own tracked .github/dependabot.yml.
// =============================================================================

test("checkDependabotHasNoTypescriptIgnore: a config with no ignore rules at all is clean", () => {
  const yaml = [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "npm"',
    '    directory: "/"',
  ].join("\n");
  const result = checkDependabotHasNoTypescriptIgnore(yaml);
  assert.deepEqual(result, { ok: true, problems: [] });
});

test("checkDependabotHasNoTypescriptIgnore: an ignore rule for an unrelated dependency is clean", () => {
  const yaml = [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "npm"',
    '    directory: "/"',
    "    ignore:",
    '      - dependency-name: "eslint"',
  ].join("\n");
  const result = checkDependabotHasNoTypescriptIgnore(yaml);
  assert.deepEqual(result, { ok: true, problems: [] });
});

test("checkDependabotHasNoTypescriptIgnore: an exact typescript ignore rule reds, naming the pattern and the ecosystem", () => {
  const yaml = [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "npm"',
    '    directory: "/"',
    "    ignore:",
    '      - dependency-name: "typescript"',
  ].join("\n");
  const result = checkDependabotHasNoTypescriptIgnore(yaml);
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.ok(result.problems[0]!.includes('"typescript"'));
  assert.ok(result.problems[0]!.includes("npm"));
});

test("checkDependabotHasNoTypescriptIgnore: a wildcard typescript ignore rule ALSO reds - a glob that matches typescript is exactly as forbidden as a literal one", () => {
  const yaml = [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "npm"',
    '    directory: "/"',
    "    ignore:",
    '      - dependency-name: "typescript*"',
  ].join("\n");
  const result = checkDependabotHasNoTypescriptIgnore(yaml);
  assert.equal(result.ok, false);
  assert.ok(result.problems[0]!.includes("typescript*"));
});

test("checkDependabotHasNoTypescriptIgnore: an ignore rule under a DIFFERENT update block (github-actions) still reds - every update block is checked, not just the first", () => {
  const yaml = [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "npm"',
    '    directory: "/"',
    '  - package-ecosystem: "github-actions"',
    '    directory: "/"',
    "    ignore:",
    '      - dependency-name: "typescript"',
  ].join("\n");
  const result = checkDependabotHasNoTypescriptIgnore(yaml);
  assert.equal(result.ok, false);
  assert.ok(result.problems[0]!.includes("github-actions"));
});

test("mutation control: clean config is green; adding a typescript ignore rule reds; removing it restores green", () => {
  const clean = [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "npm"',
    '    directory: "/"',
  ].join("\n");
  assert.equal(checkDependabotHasNoTypescriptIgnore(clean).ok, true);

  const mutated = [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "npm"',
    '    directory: "/"',
    "    ignore:",
    '      - dependency-name: "typescript"',
  ].join("\n");
  assert.equal(checkDependabotHasNoTypescriptIgnore(mutated).ok, false);

  assert.equal(checkDependabotHasNoTypescriptIgnore(clean).ok, true);
});

test('the real, tracked .github/dependabot.yml carries no ignore rule matching "typescript" right now', () => {
  const dependabotYamlText = readFileSync(
    path.join(REPO_ROOT, ".github", "dependabot.yml"),
    "utf8"
  );
  const result = checkDependabotHasNoTypescriptIgnore(dependabotYamlText);
  assert.deepEqual(
    result,
    { ok: true, problems: [] },
    "a Dependabot ignore rule for typescript would silence the open PR #1 tracking signal the pin decision requires"
  );
});

// =============================================================================
// checkTrackingSignal - the pure combination of both facts.
// =============================================================================

const CLEAN_DEPENDABOT_CHECK = { ok: true, problems: [] as string[] };
const DIRTY_DEPENDABOT_CHECK = {
  ok: false,
  problems: ['.github/dependabot.yml has an "ignore" rule matching "typescript"'],
};

test("checkTrackingSignal: PR open + clean dependabot config is green", () => {
  const result = checkTrackingSignal({ prState: "OPEN", dependabotCheck: CLEAN_DEPENDABOT_CHECK });
  assert.deepEqual(result, { ok: true, problems: [] });
});

test('checkTrackingSignal: is case-insensitive on the PR state, matching both the GraphQL-flavoured ("OPEN") and plain REST ("open") casings', () => {
  assert.equal(
    checkTrackingSignal({ prState: "open", dependabotCheck: CLEAN_DEPENDABOT_CHECK }).ok,
    true
  );
});

test("checkTrackingSignal: PR closed reds, naming the repo/PR and the live state - even with a clean dependabot config, absence of an ignore rule alone is not sufficient", () => {
  const result = checkTrackingSignal({
    prState: "CLOSED",
    dependabotCheck: CLEAN_DEPENDABOT_CHECK,
  });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.ok(result.problems[0]!.includes(`${TRACKED_PR_REPO_SLUG}#${TRACKED_PR_NUMBER}`));
  assert.ok(result.problems[0]!.includes("CLOSED"));
});

test("checkTrackingSignal: a dirty dependabot config reds even with the PR open, and both problem sets are combined, never short-circuited", () => {
  const result = checkTrackingSignal({
    prState: "CLOSED",
    dependabotCheck: DIRTY_DEPENDABOT_CHECK,
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.problems.length,
    2,
    "both the dependabot problem and the PR-state problem must be reported together"
  );
});

test("mutation control: clean+open is green; flipping the PR to closed alone reds; flipping the dependabot check alone (with PR open) also reds; restoring both is green again", () => {
  const clean = { prState: "OPEN", dependabotCheck: CLEAN_DEPENDABOT_CHECK };
  assert.equal(checkTrackingSignal(clean).ok, true);

  assert.equal(checkTrackingSignal({ ...clean, prState: "CLOSED" }).ok, false);
  assert.equal(
    checkTrackingSignal({ ...clean, dependabotCheck: DIRTY_DEPENDABOT_CHECK }).ok,
    false
  );

  assert.equal(checkTrackingSignal(clean).ok, true);
});

// =============================================================================
// fetchLivePrState - proven against an INJECTED fake command runner. The
// real `run = runGh` default (which shells out to the real `gh` binary)
// is NEVER exercised here - every call below supplies its own synthetic
// `run` function, so this suite makes zero network calls.
// =============================================================================

test("fetchLivePrState: a successful run returns the parsed state, and calls the injected runner with the expected gh arguments", () => {
  const calls: string[][] = [];
  const result = fetchLivePrState({
    repoSlug: "yaanfpv/ghantika",
    prNumber: 1,
    run: (args) => {
      calls.push(args);
      return JSON.stringify({ state: "OPEN" });
    },
  });
  assert.deepEqual(result, { state: "OPEN" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["pr", "view", "1", "--repo", "yaanfpv/ghantika", "--json", "state"]);
});

test("fetchLivePrState: defaults to the tracked repo slug and PR number when not overridden", () => {
  const calls: string[][] = [];
  fetchLivePrState({
    run: (args) => {
      calls.push(args);
      return JSON.stringify({ state: "OPEN" });
    },
  });
  assert.deepEqual(calls[0], [
    "pr",
    "view",
    String(TRACKED_PR_NUMBER),
    "--repo",
    TRACKED_PR_REPO_SLUG,
    "--json",
    "state",
  ]);
});

test("fetchLivePrState: a throwing runner (simulating no network, no gh binary, or no auth) is reported as a clear, labelled 'could not reach the forge' error - never a raw, unlabelled exception", () => {
  assert.throws(
    () =>
      fetchLivePrState({
        run: () => {
          throw new Error("spawnSync gh ENOENT");
        },
      }),
    /could not reach the forge/
  );
});

test("fetchLivePrState: a runner returning unparseable output is reported as a clear, labelled error naming what was returned", () => {
  assert.throws(
    () =>
      fetchLivePrState({
        run: () => "not json at all",
      }),
    /did not return parseable JSON/
  );
});

test('fetchLivePrState: a runner returning valid JSON with no usable "state" field is reported as a clear, labelled error - never silently treated as any particular state', () => {
  assert.throws(
    () =>
      fetchLivePrState({
        run: () => JSON.stringify({ number: 1 }),
      }),
    /no usable "state"/
  );
});

// =============================================================================
// TRACKED_DEPENDENCY_NAME sanity: this whole file is scoped to exactly the
// dependency this pin decision concerns.
// =============================================================================

test('this guard is scoped to exactly the "typescript" dependency', () => {
  assert.equal(TRACKED_DEPENDENCY_NAME, "typescript");
});
