#!/usr/bin/env node
/**
 * Guards the reason this repo pins `typescript` to an exact version below
 * 6.1.0 in the first place: `typescript-eslint` declares a peer dependency
 * on `typescript` of `>=4.8.4 <6.1.0`, and the pin exists ONLY because of
 * that range - 6.0.3 is simply the highest version that satisfies it. This
 * script itself reads whatever range is CURRENTLY installed and checks two
 * things against it: that every checked package agrees, and that the
 * pinned `typescript` version satisfies it. It does not hardcode the range
 * anywhere in its own pass/fail logic, so a legitimate `typescript-eslint`
 * upgrade that widens the range in agreement across every package stays
 * green here - that is this script's job, and it is not the mechanism that
 * catches a widening. The companion test file (test/typescript-peer-range.
 * test.ts) is what does that: one of its tests asserts the real, installed
 * range against a hardcoded literal, so a future widening shows up there as
 * a failing diff rather than as a stale number nobody re-reads.
 *
 * `typescript-eslint` is a monorepo of several published packages, and the
 * peer constraint is not declared in only one place: the top-level
 * `typescript-eslint` meta-package and every sub-package this repo actually
 * resolves that declares its own `peerDependencies.typescript` - all eight
 * of them (`@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`,
 * `@typescript-eslint/project-service`, `@typescript-eslint/tsconfig-utils`,
 * `@typescript-eslint/type-utils`, `@typescript-eslint/typescript-estree`,
 * `@typescript-eslint/utils`, and the `typescript-eslint` meta-package
 * itself) - each carry their OWN `peerDependencies.typescript` entry
 * (confirmed by reading each package's real, installed `package.json`
 * directly - never assumed from the top-level package alone).
 * `@typescript-eslint/typescript-estree` is treated as the canonical source
 * below because it is the package that actually wraps the TypeScript
 * compiler API and is where the constraint originates; the others
 * redeclare the identical range because they depend on it and need to
 * guarantee the same compiler surface. Every checked package's range is
 * compared for AGREEMENT, not just read from the canonical one alone, so a
 * partial or inconsistent release (one sub-package widened, another not)
 * is caught rather than silently trusted from whichever package happens to
 * be read.
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
import { readFileSync, readdirSync } from "node:fs";
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
  "@typescript-eslint/project-service",
  "@typescript-eslint/tsconfig-utils",
  "@typescript-eslint/type-utils",
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

  const inventory = verifyPeerPackageInventoryComplete(
    discoverInstalledTypescriptPeerPackages(root),
    PEER_RANGE_PACKAGES_TO_CHECK
  );
  if (!inventory.ok) {
    if (inventory.installedButNotChecked.length > 0) {
      problems.push(
        `PEER_RANGE_PACKAGES_TO_CHECK is missing installed peer-declaring package(s): ${inventory.installedButNotChecked.join(", ")} - a real installed package was dropped from the checked list`
      );
    }
    if (inventory.checkedButNotInstalled.length > 0) {
      problems.push(
        `PEER_RANGE_PACKAGES_TO_CHECK names package(s) not actually installed: ${inventory.checkedButNotInstalled.join(", ")}`
      );
    }
    if (inventory.indeterminate.length > 0) {
      problems.push(
        `the installed-package inventory could not be fully verified, so it cannot be trusted as complete - ${inventory.indeterminate
          .map((entry) => `${entry.path}: ${entry.reason}`)
          .join("; ")}`
      );
    }
  }

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

// ---------------------------------------------------------------------------
// An INDEPENDENT completeness oracle for PEER_RANGE_PACKAGES_TO_CHECK itself.
// Everything above trusts that constant's membership; nothing above would
// notice if a real installed package that declares peerDependencies.typescript
// were quietly dropped from it - checkTypescriptPeerRange iterates exactly the
// list it's handed, so a shrunk list still passes every one of its own checks.
// This function discovers the real answer independently, by scanning the
// installed tree itself (every entry directly under node_modules/@typescript-
// eslint/, plus the top-level typescript-eslint meta-package), rather than by
// reading PEER_RANGE_PACKAGES_TO_CHECK at all. A caller compares the two sets
// for exact agreement; this function never sees or consults the production
// list, so it cannot rubber-stamp a shrunk copy of itself.
// ---------------------------------------------------------------------------

/**
 * Reads and parses a package.json, distinguishing three outcomes that a bare
 * try/catch cannot: the file genuinely does not exist at this exact path,
 * versus it exists but could not be read or parsed (a real, reportable
 * problem - permission denied, truncated write, corrupted JSON). Collapsing
 * the second case into the first is exactly the bug this function exists to
 * avoid: it would silently convert "we could not verify this entry" into
 * "this entry is absent", which the exact-set comparison downstream cannot
 * tell apart from a genuine absence.
 *
 * Whether a missing file is actually benign depends on what the CALLER
 * already knows, not on anything this function can decide - it only reports
 * what it found at the one path it was given. See the two call sites below:
 * the top-level check treats "absent" as benign (the package simply isn't
 * installed), while the scoped-directory loop does not, because it already
 * confirmed the containing directory itself exists.
 *
 * @param {string} packageJsonPath
 * @returns {{ kind: "absent" } | { kind: "indeterminate", reason: string } | { kind: "parsed", json: Record<string, unknown> }}
 */
function readAndParsePackageJson(packageJsonPath) {
  let raw;
  try {
    raw = readFileSync(packageJsonPath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return { kind: "absent" };
    }
    return {
      kind: "indeterminate",
      reason: `could not read ${packageJsonPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    return { kind: "parsed", json: JSON.parse(raw) };
  } catch (err) {
    return {
      kind: "indeterminate",
      reason: `${packageJsonPath} exists but could not be parsed as JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * @param {string} [root]
 * @returns {{ packages: string[], indeterminate: Array<{ path: string, reason: string }> }}
 *   `packages` is every installed package name (the "typescript-eslint"
 *   meta-package plus any "@typescript-eslint/*" sub-package) whose real,
 *   installed package.json declares a "peerDependencies"."typescript" entry -
 *   sorted for a stable, diffable comparison. `indeterminate` lists every
 *   entry this function found but could NOT verify as either present-with-a-
 *   valid-manifest or genuinely not installed at all. The meaning of a
 *   missing package.json differs by call site: for the top-level
 *   "typescript-eslint" meta-package, it means the package simply isn't
 *   installed (benign, not indeterminate). For an entry already enumerated
 *   under the "@typescript-eslint" scope directory, the directory or symlink
 *   itself is confirmed to exist, so a missing package.json there is an
 *   anomaly, not an absence, and IS indeterminate. A non-empty
 *   `indeterminate` means the discovered `packages` set cannot be trusted
 *   as complete: the caller must treat that as a failure, never as if the
 *   unverifiable entry simply were not installed.
 */
export function discoverInstalledTypescriptPeerPackages(root = REPO_ROOT) {
  const found = [];
  const indeterminate = [];

  const metaPackageJsonPath = path.join(root, "node_modules", "typescript-eslint", "package.json");
  const metaResult = readAndParsePackageJson(metaPackageJsonPath);
  if (metaResult.kind === "indeterminate") {
    indeterminate.push({ path: metaPackageJsonPath, reason: metaResult.reason });
  } else if (
    metaResult.kind === "parsed" &&
    typeof metaResult.json.peerDependencies?.typescript === "string"
  ) {
    found.push("typescript-eslint");
  }

  const scopeDir = path.join(root, "node_modules", "@typescript-eslint");
  let scopeEntries;
  try {
    scopeEntries = readdirSync(scopeDir, { withFileTypes: true });
  } catch (err) {
    // A missing @typescript-eslint scope directory entirely (e.g. before a
    // fresh `npm ci`) is NOT indeterminate: every checked package would then
    // show up as checkedButNotInstalled in the comparison downstream, which
    // already fails loudly - there is nothing this function needs to add.
    // Anything else (permission denied, a path that exists but is not a
    // directory) genuinely could not be verified and must be reported.
    if (!(err && typeof err === "object" && "code" in err && err.code === "ENOENT")) {
      indeterminate.push({
        path: scopeDir,
        reason: `could not enumerate ${scopeDir}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    scopeEntries = [];
  }
  // INVARIANT: for every entry this loop ADMITS past the dirent-type check
  // below, the read outcome is fully DETERMINED (found, or a parsed
  // manifest that plainly declares no peer - a real, confirmed "no", not
  // an unverifiable entry) or marked INDETERMINATE. There are three
  // dispositions here (determined-yes, determined-no, indeterminate) but
  // only two arrays: determined-yes goes in `packages`, indeterminate goes
  // in `indeterminate`, and determined-no belongs in NEITHER array -
  // "no third bucket" describes the disposition space (nothing is silently
  // dropped without being one of the three), not array membership. The
  // switch below is exhaustive over readAndParsePackageJson's three-way
  // return type and throws on anything else, so a future change to that
  // return shape fails loudly here instead of silently reintroducing an
  // unaccounted-for path once an entry has already been admitted.
  //
  // The switch guards what happens to an ADMITTED entry. It does not, and
  // cannot, guard the ADMISSION decision itself - the dirent-type check
  // immediately below runs before any entry reaches the switch, so an
  // entry excluded there never becomes a candidate the switch's
  // exhaustiveness could protect. That check must independently be sound:
  // a plain file is a legitimate, fully determined exclusion (decided by
  // type alone, before any read - no npm package can live at a bare file),
  // but a symlink is not safely excludable this way, since it can resolve
  // to a real peer-declaring package. Both directories and symlinks must
  // be admitted; excluding either would silently narrow what this function
  // discovers without the switch below ever getting a chance to object.
  for (const entry of scopeEntries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const entryPath = path.join(scopeDir, entry.name);
    const packageJsonPath = path.join(entryPath, "package.json");
    const result = readAndParsePackageJson(packageJsonPath);
    switch (result.kind) {
      case "parsed": {
        // Determined either way: a manifest that parses cleanly but simply
        // does not declare a typescript peer is a real, confirmed "no" -
        // not an unverifiable entry, so it correctly lands in neither
        // bucket below.
        if (typeof result.json.peerDependencies?.typescript === "string") {
          found.push(`@typescript-eslint/${entry.name}`);
        }
        break;
      }
      case "indeterminate": {
        indeterminate.push({ path: packageJsonPath, reason: result.reason });
        break;
      }
      case "absent": {
        // Unlike the top-level check above, "absent" here is NOT benign:
        // readdirSync already confirmed entryPath itself exists as a real
        // directory or symlink under the @typescript-eslint scope, so a
        // missing package.json inside it is not "this simply isn't a
        // package" - every real scoped npm package's manifest lives at
        // exactly this path. It is an anomaly (a corrupted or incomplete
        // install, a manually deleted manifest, a symlink resolving to
        // nowhere), and the only honest response is to report it as
        // unverifiable, not to silently treat the entry as not installed.
        indeterminate.push({
          path: packageJsonPath,
          reason: `${entryPath} exists as a directory or symlink but has no package.json`,
        });
        break;
      }
      default: {
        // Exhaustiveness guard, not a case this code expects to hit: if
        // readAndParsePackageJson's return shape ever grows a fourth kind,
        // this throws immediately rather than silently falling through to
        // "neither found nor indeterminate" - the invariant is enforced by
        // construction, not by remembering to update this switch every
        // time a new failure mode is discovered.
        throw new Error(
          `unhandled readAndParsePackageJson result for ${packageJsonPath}: ${JSON.stringify(result)}`
        );
      }
    }
  }

  return { packages: found.sort(), indeterminate };
}

/**
 * Compares an independently-discovered set of real peer-declaring packages
 * against the list PEER_RANGE_PACKAGES_TO_CHECK actually checks, for EXACT
 * agreement in both directions - a package installed but not checked, or
 * checked but no longer installed, are both reported by name. A non-empty
 * `indeterminate` list (an entry that could not be read or parsed, per
 * discoverInstalledTypescriptPeerPackages above) always makes this fail,
 * regardless of what the exact-set comparison itself finds - an inventory
 * built from a set that could not be fully verified is not a verified
 * inventory, whatever it happens to report.
 *
 * @param {{ packages: string[], indeterminate: Array<{ path: string, reason: string }> }} discovered
 * @param {string[]} checkedPackages
 * @returns {{ ok: boolean, installedButNotChecked: string[], checkedButNotInstalled: string[], indeterminate: Array<{ path: string, reason: string }> }}
 */
export function verifyPeerPackageInventoryComplete(discovered, checkedPackages) {
  const discoveredSet = new Set(discovered.packages);
  const checkedSet = new Set(checkedPackages);
  const installedButNotChecked = [...discoveredSet].filter((name) => !checkedSet.has(name)).sort();
  const checkedButNotInstalled = [...checkedSet].filter((name) => !discoveredSet.has(name)).sort();
  return {
    ok:
      installedButNotChecked.length === 0 &&
      checkedButNotInstalled.length === 0 &&
      discovered.indeterminate.length === 0,
    installedButNotChecked,
    checkedButNotInstalled,
    indeterminate: discovered.indeterminate,
  };
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
