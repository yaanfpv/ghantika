import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// package.json is the first thing a contributor reads to learn what
// commands exist in this repo, so its scripts block staying well-formed -
// every entry a real, non-empty command string - and covering the core
// commands a contributor actually needs (build, typecheck, lint, test) is
// worth guarding directly.

const PACKAGE_URL = new URL("../package.json", import.meta.url);
const REQUIRED_SCRIPTS = ["build", "typecheck", "lint", "test"];

function loadPackageJson() {
  return JSON.parse(readFileSync(PACKAGE_URL, "utf8"));
}

/**
 * Returns the subset of `required` that either don't exist in `scripts`
 * at all, or exist but aren't a real (non-whitespace-only) command
 * string. Trimmed before the length check, so a script set to a few
 * spaces - which parses as a non-empty string but runs no real command -
 * is treated as missing, not present. Shared by the real package.json
 * check below and the mutation-control test, so both use the exact same
 * validation logic.
 *
 * @param {Record<string, unknown>} scripts
 * @param {string[]} required
 * @returns {string[]}
 */
function findMissingRequiredScripts(scripts, required) {
  return required.filter((name) => {
    const value = scripts?.[name];
    return typeof value !== "string" || value.trim().length === 0;
  });
}

test("package.json parses and has a scripts object", () => {
  const pkg = loadPackageJson();
  assert.equal(typeof pkg, "object");
  assert.ok(pkg !== null, "package.json must parse to an object");
  assert.equal(typeof pkg.scripts, "object");
  assert.ok(pkg.scripts !== null, "package.json must declare a scripts object");
});

test("every scripts entry is a real (non-whitespace-only) command string", () => {
  const pkg = loadPackageJson();
  for (const [name, value] of Object.entries(pkg.scripts)) {
    assert.equal(typeof value, "string", `scripts["${name}"] must be a string`);
    assert.ok(value.trim().length > 0, `scripts["${name}"] must not be empty or whitespace-only`);
  }
});

test("the core scripts a contributor needs are present and non-empty", () => {
  const pkg = loadPackageJson();
  const missing = findMissingRequiredScripts(pkg.scripts, REQUIRED_SCRIPTS);
  assert.deepEqual(missing, [], `missing or empty required scripts: ${JSON.stringify(missing)}`);
});

test("mutation control: deleting a required script from an in-memory copy is caught by the validation helper", () => {
  const pkg = loadPackageJson();

  // Applied to an in-memory copy only - package.json on disk is never
  // touched, so there's nothing to revert afterward; re-checking the
  // real scripts block at the end is what proves it.
  const mutated = { ...pkg.scripts };
  delete mutated.build;

  const missing = findMissingRequiredScripts(mutated, REQUIRED_SCRIPTS);
  assert.deepEqual(
    missing,
    ["build"],
    "deleting build from the scripts block should be reported as missing"
  );

  // Restore: confirm the real, on-disk scripts block remains clean.
  assert.deepEqual(
    findMissingRequiredScripts(pkg.scripts, REQUIRED_SCRIPTS),
    [],
    "the real package.json scripts block should remain clean after the mutation-control check"
  );
});

test("mutation control: a whitespace-only script value is reported as missing, not accepted as a real command", () => {
  const pkg = loadPackageJson();

  // "   " (three spaces) parses as a non-empty string but runs no real
  // command - length > 0 alone would wrongly accept it.
  const mutated = { ...pkg.scripts, lint: "   " };

  const missing = findMissingRequiredScripts(mutated, REQUIRED_SCRIPTS);
  assert.deepEqual(missing, ["lint"], "a whitespace-only value must be treated as missing");

  assert.deepEqual(
    findMissingRequiredScripts(pkg.scripts, REQUIRED_SCRIPTS),
    [],
    "the real package.json scripts block should remain clean after the mutation-control check"
  );
});

test("mutation control: a whitespace-only entry fails the general non-empty-string invariant too", () => {
  const pkg = loadPackageJson();
  const mutated = { ...pkg.scripts, lint: "   " };
  const violations = Object.entries(mutated).filter(
    ([, value]) => typeof value !== "string" || value.trim().length === 0
  );
  assert.deepEqual(
    violations.map(([name]) => name),
    ["lint"]
  );
});
