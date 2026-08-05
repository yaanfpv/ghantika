import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  TRACKED_DEPENDENCY_NAME,
  checkDependabotHasNoTypescriptIgnore,
  dependabotNamePatternMatches,
} from "../scripts/check-typescript-tracking-signal.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// This suite proves the guard's pure logic: parsing already-read YAML text
// and matching Dependabot's own "*"-wildcard glob syntax. No filesystem
// access beyond one real read of this repo's own tracked
// .github/dependabot.yml below, and no network access at all - see
// scripts/check-typescript-tracking-signal.mjs's own header comment for
// why this guard no longer needs a live forge read.

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
    "a Dependabot ignore rule for typescript would silence Dependabot's own ability to ever propose a newer typescript once typescript-eslint's peer range widens"
  );
});

// =============================================================================
// TRACKED_DEPENDENCY_NAME sanity: this whole file is scoped to exactly the
// dependency this pin decision concerns.
// =============================================================================

test('this guard is scoped to exactly the "typescript" dependency', () => {
  assert.equal(TRACKED_DEPENDENCY_NAME, "typescript");
});
