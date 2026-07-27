#!/usr/bin/env node
/**
 * Guards the reason this repo pins `typescript` to an exact version below
 * 6.1.0 in the first place: `typescript-eslint` declares a peer dependency
 * on `typescript` of `>=4.8.4 <6.1.0`, and the pin exists ONLY because of
 * that range - 6.0.3 is simply the highest version that satisfies it. If
 * the range ever widens (a `typescript-eslint` upgrade whose peer support
 * catches up), the number this repo is pinned to stops being a live
 * decision and turns into folklore nobody re-checks. This file makes the
 * range itself a machine-checked, regenerated-every-run fact instead: the
 * exact range STRING is read from the real, installed package (never
 * copied into a comment), so a widening shows up as a failing assertion
 * diff the moment it happens, not as a stale number someone eventually
 * notices is wrong.
 *
 * `typescript-eslint` is a monorepo of several published packages, and the
 * peer constraint is not declared in only one place: the top-level
 * `typescript-eslint` meta-package AND every sub-package this repo
 * actually resolves (`@typescript-eslint/eslint-plugin`,
 * `@typescript-eslint/parser`, `@typescript-eslint/utils`,
 * `@typescript-eslint/typescript-estree`) each carry their OWN
 * `peerDependencies.typescript` entry (confirmed by reading each package's
 * real, installed `package.json` directly - never assumed from the
 * top-level package alone). `@typescript-eslint/typescript-estree` is
 * treated as the canonical source below because it is the package that
 * actually wraps the TypeScript compiler API and is where the constraint
 * originates; the others redeclare the identical range because they
 * depend on it and need to guarantee the same compiler surface. Every
 * checked package's range is compared for AGREEMENT, not just read from
 * the canonical one alone, so a partial or inconsistent release (one
 * sub-package widened, another not) is caught rather than silently
 * trusted from whichever package happens to be read.
 *
 * The range parser below (parseMinInclusiveMaxExclusiveRange) understands
 * exactly one shape: ">=X.Y.Z <A.B.C", the two-clause form
 * `typescript-eslint` actually publishes. This is deliberately not a
 * general semver-range parser - that would be untested surface for range
 * shapes this repo never actually encounters.
 *
 * Run with:
 *
 *   npm run guard:typescript-peer-range
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The typescript-eslint sub-package treated as the canonical source of the
 * peer range - see this file's header comment for why.
 */
export const PEER_RANGE_SOURCE_PACKAGE = "@typescript-eslint/typescript-estree";

/**
 * Every installed package expected to declare the SAME typescript peer
 * range, checked together for agreement rather than trusting the
 * canonical source package alone.
 */
export const PEER_RANGE_PACKAGES_TO_CHECK = [
  "typescript-eslint",
  "@typescript-eslint/eslint-plugin",
  "@typescript-eslint/parser",
  "@typescript-eslint/utils",
  PEER_RANGE_SOURCE_PACKAGE,
];

// ---------------------------------------------------------------------------
// A narrow, purpose-built semver comparator - just enough to evaluate a
// ">=X.Y.Z <A.B.C" range against a bare X.Y.Z version, both pure and
// directly unit-testable with no filesystem or network access.
// ---------------------------------------------------------------------------

/**
 * @param {string} version - a bare "X.Y.Z" (a leading pre-release/build
 *   suffix, if any, is ignored - every version this file compares is a
 *   plain release version).
 * @returns {[number, number, number]}
 */
export function parseSemverTuple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    throw new Error(`not a parseable "X.Y.Z" semver version: "${version}"`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b, positive if a > b, 0 if equal -
 *   the standard comparator contract.
 */
export function compareSemver(a, b) {
  const [aMajor, aMinor, aPatch] = parseSemverTuple(a);
  const [bMajor, bMinor, bPatch] = parseSemverTuple(b);
  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  return aPatch - bPatch;
}

/**
 * Parses exactly the two-clause range shape typescript-eslint publishes:
 * a minimum-INCLUSIVE bound and a maximum-EXCLUSIVE bound, both bare
 * "X.Y.Z" versions separated by a single space, e.g. ">=4.8.4 <6.1.0".
 * Throws on anything else - this guard would rather fail loudly on an
 * unrecognised range shape than silently misread it.
 *
 * @param {string} rangeString
 * @returns {{ min: string, max: string }}
 */
export function parseMinInclusiveMaxExclusiveRange(rangeString) {
  const match = /^>=(\d+\.\d+\.\d+)\s+<(\d+\.\d+\.\d+)$/.exec(rangeString.trim());
  if (!match) {
    throw new Error(
      `expected a ">=X.Y.Z <A.B.C" range, got: "${rangeString}" - this guard only understands that exact two-clause minimum-inclusive/maximum-exclusive shape`
    );
  }
  return { min: match[1], max: match[2] };
}

/**
 * @param {string} version - a bare "X.Y.Z" version to test.
 * @param {string} rangeString - a ">=X.Y.Z <A.B.C" range.
 * @returns {boolean} true iff version >= min AND version < max.
 */
export function versionSatisfiesRange(version, rangeString) {
  const { min, max } = parseMinInclusiveMaxExclusiveRange(rangeString);
  return compareSemver(version, min) >= 0 && compareSemver(version, max) < 0;
}

// ---------------------------------------------------------------------------
// The real check: reads every package in PEER_RANGE_PACKAGES_TO_CHECK's
// actual installed peerDependencies.typescript entry, confirms they all
// agree, and confirms this repo's own pinned typescript version satisfies
// the agreed-upon range.
// ---------------------------------------------------------------------------

/**
 * @param {string} [root]
 * @returns {{ ok: boolean, problems: string[], range: string | null }}
 */
export function checkTypescriptPeerRange(root = REPO_ROOT) {
  const problems = [];
  /** @type {Map<string, string>} */
  const rangesByPackage = new Map();

  for (const packageName of PEER_RANGE_PACKAGES_TO_CHECK) {
    const packageJsonPath = path.join(root, "node_modules", packageName, "package.json");
    let installedPackageJson;
    try {
      installedPackageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    } catch (err) {
      problems.push(
        `could not read the installed package.json for "${packageName}" at ${packageJsonPath}: ${err.message}`
      );
      continue;
    }
    const declaredRange = installedPackageJson.peerDependencies?.typescript;
    if (typeof declaredRange !== "string") {
      problems.push(
        `"${packageName}"'s installed package.json declares no "peerDependencies"."typescript" entry`
      );
      continue;
    }
    rangesByPackage.set(packageName, declaredRange);
  }

  const distinctRanges = new Set(rangesByPackage.values());
  if (distinctRanges.size > 1) {
    problems.push(
      `the checked typescript-eslint packages disagree on their declared typescript peer range: ${JSON.stringify(Object.fromEntries(rangesByPackage))}`
    );
  }

  const range = rangesByPackage.get(PEER_RANGE_SOURCE_PACKAGE) ?? [...distinctRanges][0] ?? null;
  if (range === null) {
    problems.push(
      "could not determine a typescript peer range from any of the checked typescript-eslint packages"
    );
    return { ok: false, problems, range };
  }

  let parsedRange;
  try {
    parsedRange = parseMinInclusiveMaxExclusiveRange(range);
  } catch (err) {
    problems.push(err.message);
    return { ok: false, problems, range };
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch (err) {
    problems.push(`could not read package.json: ${err.message}`);
    return { ok: false, problems, range };
  }

  const pinnedVersion = pkg.devDependencies?.typescript;
  if (typeof pinnedVersion !== "string") {
    problems.push(
      'package.json has no "devDependencies"."typescript" entry to check against the peer range'
    );
  } else if (!versionSatisfiesRange(pinnedVersion, range)) {
    problems.push(
      `package.json pins typescript to "${pinnedVersion}", which does NOT satisfy typescript-eslint's declared peer range "${range}" (requires >= ${parsedRange.min} and < ${parsedRange.max})`
    );
  }

  return { ok: problems.length === 0, problems, range };
}

function main() {
  const { ok, problems, range } = checkTypescriptPeerRange();
  if (!ok) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
    return;
  }
  console.log(
    `typescript peer range clean: typescript-eslint's installed packages agree on "${range}" for typescript, and this repo's pinned typescript version satisfies it`
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
