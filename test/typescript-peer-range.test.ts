import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PEER_RANGE_PACKAGES_TO_CHECK,
  PEER_RANGE_SOURCE_PACKAGE,
  checkTypescriptPeerRange,
  compareSemver,
  discoverInstalledTypescriptPeerPackages,
  parseMinInclusiveMaxExclusiveRange,
  parseSemverTuple,
  verifyPeerPackageInventoryComplete,
  versionSatisfiesRange,
} from "../scripts/check-typescript-peer-range.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// =============================================================================
// parseSemverTuple / compareSemver - the pure comparator primitives.
// =============================================================================

test("parseSemverTuple reads a bare X.Y.Z into its three numeric components", () => {
  assert.deepEqual(parseSemverTuple("6.0.3"), [6, 0, 3]);
  assert.deepEqual(parseSemverTuple("4.8.4"), [4, 8, 4]);
});

test("parseSemverTuple throws on an unparseable version", () => {
  assert.throws(() => parseSemverTuple("not-a-version"), /not a parseable/);
});

test("compareSemver orders by major, then minor, then patch, and returns 0 for equal versions", () => {
  assert.ok(compareSemver("6.0.3", "6.0.3") === 0);
  assert.ok(compareSemver("6.0.3", "6.1.0") < 0);
  assert.ok(compareSemver("6.1.0", "6.0.3") > 0);
  assert.ok(compareSemver("5.9.3", "6.0.3") < 0);
  assert.ok(
    compareSemver("6.0.10", "6.0.9") > 0,
    "patch comparison must be numeric, not lexicographic"
  );
});

// =============================================================================
// parseMinInclusiveMaxExclusiveRange - the exact two-clause shape
// typescript-eslint actually publishes.
// =============================================================================

test("parseMinInclusiveMaxExclusiveRange parses typescript-eslint's real published range shape", () => {
  assert.deepEqual(parseMinInclusiveMaxExclusiveRange(">=4.8.4 <6.1.0"), {
    min: "4.8.4",
    max: "6.1.0",
  });
});

test("parseMinInclusiveMaxExclusiveRange throws on a shape it does not understand", () => {
  assert.throws(() => parseMinInclusiveMaxExclusiveRange("^4.8.4"), /expected a ">=X\.Y\.Z/);
  assert.throws(() => parseMinInclusiveMaxExclusiveRange(">=4.8.4"), /expected a ">=X\.Y\.Z/);
  assert.throws(() => parseMinInclusiveMaxExclusiveRange("4.8.4 - 6.1.0"), /expected a ">=X\.Y\.Z/);
});

// =============================================================================
// versionSatisfiesRange - the exact boundary this pin decision rests on.
// The peer range is ">=4.8.4 <6.1.0": 6.0.3 is the highest version that
// satisfies it, so the boundary at 6.1.0 (excluded) and at 4.8.4
// (included) are both proven directly, not just the interior case.
// =============================================================================

const REAL_PEER_RANGE = ">=4.8.4 <6.1.0";

test("6.0.3 (this repo's pinned version) satisfies the real typescript-eslint peer range", () => {
  assert.equal(versionSatisfiesRange("6.0.3", REAL_PEER_RANGE), true);
});

test("6.1.0 does NOT satisfy the range - the upper bound is exclusive", () => {
  assert.equal(versionSatisfiesRange("6.1.0", REAL_PEER_RANGE), false);
});

test("6.2.0 does NOT satisfy the range", () => {
  assert.equal(versionSatisfiesRange("6.2.0", REAL_PEER_RANGE), false);
});

test("7.0.2 (the version now shipped via the @typescript/native alias) does NOT satisfy the range", () => {
  assert.equal(versionSatisfiesRange("7.0.2", REAL_PEER_RANGE), false);
});

test("4.8.4 satisfies the range - the lower bound is inclusive", () => {
  assert.equal(versionSatisfiesRange("4.8.4", REAL_PEER_RANGE), true);
});

test("4.8.3 does NOT satisfy the range - just below the inclusive lower bound", () => {
  assert.equal(versionSatisfiesRange("4.8.3", REAL_PEER_RANGE), false);
});

test("5.9.3 (the version this repo was pinned to before this change) satisfies the range too", () => {
  assert.equal(versionSatisfiesRange("5.9.3", REAL_PEER_RANGE), true);
});

// =============================================================================
// checkTypescriptPeerRange - against THIS repo's real, currently-installed
// node_modules and package.json. No mocking: this is the live fact the
// pin decision depends on, read the same way `npm run
// guard:typescript-peer-range` reads it. Recording the range STRING
// directly in the assertion (never merely "it satisfies some range this
// file also computed") is what makes a later typescript-eslint widening
// show up as a failing diff here, rather than living only as a comment
// nobody re-reads.
// =============================================================================

test('the real, installed typescript-eslint peer range is exactly ">=4.8.4 <6.1.0" right now, and this repo\'s pinned typescript version satisfies it', () => {
  const result = checkTypescriptPeerRange(REPO_ROOT);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(
    result.range,
    ">=4.8.4 <6.1.0",
    "if this fails, typescript-eslint's declared peer range has changed since this test was written - re-read the acceptance criteria before assuming 6.0.3 is still the right pin"
  );
});

test("every checked typescript-eslint package - the top-level meta-package and every sub-package this repo resolves - is actually present and inspected, not just the canonical source package alone", () => {
  // Guards against the check silently degrading to "only the canonical
  // package was ever readable" - every name in PEER_RANGE_PACKAGES_TO_CHECK
  // must resolve to a real, installed package.json under this repo's own
  // node_modules.
  for (const packageName of PEER_RANGE_PACKAGES_TO_CHECK) {
    const packageJsonPath = path.join(REPO_ROOT, "node_modules", packageName, "package.json");
    const raw = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    assert.equal(
      typeof raw.peerDependencies?.typescript,
      "string",
      `${packageName} must declare peerDependencies.typescript`
    );
  }
  assert.ok(
    PEER_RANGE_PACKAGES_TO_CHECK.includes(PEER_RANGE_SOURCE_PACKAGE),
    "the canonical source package must be one of the packages actually checked"
  );
});

// =============================================================================
// checkTypescriptPeerRange - mutation control against a scratch fixture
// tree, proving the guard actually reacts to real drift rather than being
// vacuously green. Matches this repo's established mutation-control
// pattern (test/sha-parity.test.ts, test/npm-ci-guard.test.js).
// =============================================================================

function writeFixturePackageJson(dir: string, packageName: string, peerRange: string | undefined) {
  const pkgDir = path.join(dir, "node_modules", packageName);
  mkdirSync(pkgDir, { recursive: true });
  const body: Record<string, unknown> = { name: packageName, version: "8.65.0" };
  if (peerRange !== undefined) {
    body.peerDependencies = { typescript: peerRange };
  }
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(body));
}

/**
 * Writes the fixture's resolved `node_modules/typescript/package.json`,
 * mirroring what a real install resolves to regardless of aliasing - the
 * production guard reads this file's "version" field, never the raw
 * devDependencies spec string in package.json.
 */
function writeFixtureResolvedTypescript(dir: string, resolvedVersion: string) {
  const pkgDir = path.join(dir, "node_modules", "typescript");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "typescript", version: resolvedVersion })
  );
}

function makeFixtureRoot({
  pinnedVersion,
  ranges,
}: {
  pinnedVersion: string;
  ranges: Partial<Record<string, string>>;
}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-peer-range-fixture-"));
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ devDependencies: { typescript: pinnedVersion } })
  );
  writeFixtureResolvedTypescript(dir, pinnedVersion);
  for (const packageName of PEER_RANGE_PACKAGES_TO_CHECK) {
    writeFixturePackageJson(dir, packageName, ranges[packageName] ?? ">=4.8.4 <6.1.0");
  }
  return dir;
}

test("mutation control: a clean fixture (every package agrees, pin satisfies the range) is green; a widened range alone makes the pinned version's check moot but the fixture still agrees and is green", () => {
  const dir = makeFixtureRoot({ pinnedVersion: "6.0.3", ranges: {} });
  try {
    const result = checkTypescriptPeerRange(dir);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.range, ">=4.8.4 <6.1.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation control: pinning typescript OUTSIDE the declared range reds, naming the pinned version and the range", () => {
  const dir = makeFixtureRoot({ pinnedVersion: "6.1.0", ranges: {} });
  try {
    const result = checkTypescriptPeerRange(dir);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("6.1.0") && p.includes("does NOT satisfy")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation control: one sub-package disagreeing with the rest on its declared range reds, naming the disagreement - a partial/inconsistent release is never silently trusted from the canonical package alone", () => {
  const dir = makeFixtureRoot({
    pinnedVersion: "6.0.3",
    ranges: { "@typescript-eslint/parser": ">=4.8.4 <7.0.0" },
  });
  try {
    const result = checkTypescriptPeerRange(dir);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("disagree")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation control: a widened range that ALL packages agree on (a genuine typescript-eslint upgrade) is read faithfully - the guard follows the real installed range, it does not hardcode the old one", () => {
  const dir = makeFixtureRoot({
    pinnedVersion: "6.0.3",
    ranges: Object.fromEntries(PEER_RANGE_PACKAGES_TO_CHECK.map((p) => [p, ">=4.8.4 <7.1.0"])),
  });
  try {
    const result = checkTypescriptPeerRange(dir);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.range, ">=4.8.4 <7.1.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation control: a missing peerDependencies.typescript entry on the canonical source package reds, naming which package is missing it", () => {
  const dir = makeFixtureRoot({ pinnedVersion: "6.0.3", ranges: {} });
  try {
    // Overwrite the canonical package's fixture with no peerDependencies at all.
    writeFixturePackageJson(dir, PEER_RANGE_SOURCE_PACKAGE, undefined);
    const result = checkTypescriptPeerRange(dir);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some(
        (p) => p.includes(PEER_RANGE_SOURCE_PACKAGE) && p.includes("declares no")
      )
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation control: restoring a clean fixture after each red case above is green again - proves this isn't a guard stuck red, it genuinely tracks its input", () => {
  const dir = makeFixtureRoot({ pinnedVersion: "6.0.3", ranges: {} });
  try {
    assert.equal(checkTypescriptPeerRange(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// Independent completeness oracle for PEER_RANGE_PACKAGES_TO_CHECK itself.
// Every test above (and checkTypescriptPeerRange itself) trusts that
// constant's membership - it iterates exactly the list it's handed, so a real
// installed peer-declaring package quietly dropped FROM that list would still
// pass every test above unchanged. discoverInstalledTypescriptPeerPackages
// never reads PEER_RANGE_PACKAGES_TO_CHECK; it scans the real, installed
// node_modules tree directly, so comparing its answer against the production
// list is a genuine independent check, not a re-derivation of the same
// source it verifies.
// =============================================================================

test("the real, installed set of typescript peer-declaring packages, discovered independently by scanning node_modules directly, is EXACTLY the eight packages PEER_RANGE_PACKAGES_TO_CHECK actually checks - proves the production list is not merely internally consistent but complete against reality", () => {
  const discovered = discoverInstalledTypescriptPeerPackages(REPO_ROOT);
  assert.deepEqual(
    discovered.indeterminate,
    [],
    `expected every real installed entry to be readable; got indeterminate entries: ${JSON.stringify(discovered.indeterminate)}`
  );
  const result = verifyPeerPackageInventoryComplete(discovered, PEER_RANGE_PACKAGES_TO_CHECK);
  assert.deepEqual(
    result,
    { ok: true, installedButNotChecked: [], checkedButNotInstalled: [], indeterminate: [] },
    `discovered: ${JSON.stringify(discovered)}, checked: ${JSON.stringify(PEER_RANGE_PACKAGES_TO_CHECK)}`
  );
  assert.equal(
    discovered.packages.length,
    8,
    `expected exactly 8 real installed peer-declaring packages, found ${discovered.packages.length}: ${JSON.stringify(discovered.packages)}`
  );
});

test("mutation control: removing a real installed peer-declaring package from the CHECKED list (simulating a production-entry omission) is caught by the independent inventory oracle, naming the dropped package - this is the exact class the 20 focused checkTypescriptPeerRange tests above cannot see, since they iterate whatever list they're handed", () => {
  const discovered = discoverInstalledTypescriptPeerPackages(REPO_ROOT);
  assert.ok(
    discovered.packages.includes("@typescript-eslint/type-utils"),
    "this mutation control assumes @typescript-eslint/type-utils is really installed and peer-declaring; if this fails, the fixture assumption itself is stale"
  );
  const shrunkCheckedList = PEER_RANGE_PACKAGES_TO_CHECK.filter(
    (name) => name !== "@typescript-eslint/type-utils"
  );
  const result = verifyPeerPackageInventoryComplete(discovered, shrunkCheckedList);
  assert.equal(result.ok, false, "expected the shrunk list to be reported incomplete");
  assert.deepEqual(result.installedButNotChecked, ["@typescript-eslint/type-utils"]);
  assert.deepEqual(result.checkedButNotInstalled, []);
});

test("mutation control: a checked package name that is not actually installed is caught too, naming it distinctly from a dropped-installed-package omission", () => {
  const discovered = discoverInstalledTypescriptPeerPackages(REPO_ROOT);
  const inflatedCheckedList = [
    ...PEER_RANGE_PACKAGES_TO_CHECK,
    "@typescript-eslint/not-a-real-package",
  ];
  const result = verifyPeerPackageInventoryComplete(discovered, inflatedCheckedList);
  assert.equal(result.ok, false);
  assert.deepEqual(result.installedButNotChecked, []);
  assert.deepEqual(result.checkedButNotInstalled, ["@typescript-eslint/not-a-real-package"]);
});

test("green control: a clean, exactly-matching discovered/checked pair (no indeterminate entries) reports ok with both diff arrays empty, order-independent", () => {
  const result = verifyPeerPackageInventoryComplete(
    { packages: ["b-package", "a-package"], indeterminate: [] },
    ["a-package", "b-package"]
  );
  assert.deepEqual(result, {
    ok: true,
    installedButNotChecked: [],
    checkedButNotInstalled: [],
    indeterminate: [],
  });
});

// --- A discovered entry that could not be read or parsed (malformed JSON,
// permission denied) must never be silently treated as "not installed".
// These tests directly exercise the production entry point
// (discoverInstalledTypescriptPeerPackages, against a REAL scratch
// node_modules/@typescript-eslint tree, not a synthetic object) so they
// prove the actual behavior, not just the comparison function's contract. ---

function makeScratchScopeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-peer-range-indeterminate-"));
  mkdirSync(path.join(dir, "node_modules", "@typescript-eslint"), { recursive: true });
  return dir;
}

test("a scoped package.json that exists but is malformed JSON is reported as indeterminate, NOT silently treated as absent - a discovery function that discards a malformed manifest instead of surfacing it as indeterminate would report ok:true over a real read failure", () => {
  const dir = makeScratchScopeDir();
  try {
    const brokenDir = path.join(dir, "node_modules", "@typescript-eslint", "broken-package");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, "package.json"), "{ this is not valid JSON");

    const discovered = discoverInstalledTypescriptPeerPackages(dir);
    assert.equal(
      discovered.indeterminate.length,
      1,
      `expected exactly one indeterminate entry for the malformed package.json, got: ${JSON.stringify(discovered.indeterminate)}`
    );
    assert.match(discovered.indeterminate[0].path, /broken-package[/\\]package\.json$/);
    assert.doesNotMatch(
      discovered.packages.join(","),
      /broken-package/,
      "a package whose metadata could not be parsed must never appear in the discovered packages list either way"
    );

    // The comparison must fail regardless of what the checked list says -
    // an indeterminate entry poisons the whole inventory, it is not simply
    // one more package name to reconcile.
    const result = verifyPeerPackageInventoryComplete(discovered, PEER_RANGE_PACKAGES_TO_CHECK);
    assert.equal(
      result.ok,
      false,
      "an indeterminate entry must make the inventory comparison fail, even though it changes neither installedButNotChecked nor checkedButNotInstalled"
    );
    assert.equal(result.indeterminate.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real production guard (checkTypescriptPeerRange) goes red with a useful diagnostic naming the unreadable path when a scoped package's metadata cannot be parsed, and returns to green once it is fixed - run against the real function, not a synthetic re-implementation", () => {
  const dir = makeScratchScopeDir();
  try {
    // Populate every checked package's fixture so only the one broken entry
    // is the difference from a clean run.
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "6.0.3" } })
    );
    writeFixtureResolvedTypescript(dir, "6.0.3");
    for (const packageName of PEER_RANGE_PACKAGES_TO_CHECK) {
      const pkgDir = path.join(dir, "node_modules", packageName);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: packageName, peerDependencies: { typescript: ">=4.8.4 <6.1.0" } })
      );
    }

    const cleanResult = checkTypescriptPeerRange(dir);
    assert.equal(cleanResult.ok, true, JSON.stringify(cleanResult.problems));

    // Now corrupt one scoped package's metadata after the clean baseline.
    const targetPath = path.join(
      dir,
      "node_modules",
      "@typescript-eslint",
      "type-utils",
      "package.json"
    );
    const original = readFileSync(targetPath, "utf8");
    writeFileSync(targetPath, "{ not valid json at all");

    const brokenResult = checkTypescriptPeerRange(dir);
    assert.equal(brokenResult.ok, false, "expected the real guard to red on unreadable metadata");
    assert.ok(
      brokenResult.problems.some(
        (p) => p.includes("could not be fully verified") && p.includes("type-utils")
      ),
      `expected a problem naming the unverifiable inventory and the broken package path, got: ${JSON.stringify(brokenResult.problems)}`
    );

    // Restore and confirm it's green again - proves this isn't a guard
    // stuck red, it genuinely tracks its input.
    writeFileSync(targetPath, original);
    const restoredResult = checkTypescriptPeerRange(dir);
    assert.equal(restoredResult.ok, true, JSON.stringify(restoredResult.problems));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a present directory under the @typescript-eslint scope with NO package.json at all is reported as indeterminate, NOT silently treated as absent - an empty scoped directory discarded by the discovery function would make the comparison report ok:true over a real gap", () => {
  const dir = makeScratchScopeDir();
  try {
    const emptyDir = path.join(dir, "node_modules", "@typescript-eslint", "replacement");
    mkdirSync(emptyDir, { recursive: true });
    // Deliberately no package.json written here at all.

    const discovered = discoverInstalledTypescriptPeerPackages(dir);
    assert.equal(
      discovered.indeterminate.length,
      1,
      `expected exactly one indeterminate entry for the directory with no package.json, got: ${JSON.stringify(discovered.indeterminate)}`
    );
    assert.match(discovered.indeterminate[0].path, /replacement[/\\]package\.json$/);
    assert.doesNotMatch(
      discovered.packages.join(","),
      /replacement/,
      "a directory whose package.json is missing must never appear in the discovered packages list either way"
    );

    const result = verifyPeerPackageInventoryComplete(discovered, PEER_RANGE_PACKAGES_TO_CHECK);
    assert.equal(
      result.ok,
      false,
      "an indeterminate entry from a present-but-manifestless directory must make the inventory comparison fail"
    );
    assert.equal(result.indeterminate.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real production guard (checkTypescriptPeerRange) goes red with a useful diagnostic naming the manifestless path when a scoped directory exists but has no package.json, and returns to green once the directory is removed - run against the real function, not a synthetic re-implementation", () => {
  const dir = makeScratchScopeDir();
  try {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "6.0.3" } })
    );
    writeFixtureResolvedTypescript(dir, "6.0.3");
    for (const packageName of PEER_RANGE_PACKAGES_TO_CHECK) {
      const pkgDir = path.join(dir, "node_modules", packageName);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: packageName, peerDependencies: { typescript: ">=4.8.4 <6.1.0" } })
      );
    }

    const cleanResult = checkTypescriptPeerRange(dir);
    assert.equal(cleanResult.ok, true, JSON.stringify(cleanResult.problems));

    // Add a present, but entirely manifestless, directory under the scope -
    // no package.json edit, no deletion of a checked package; a brand-new
    // directory the checked list never even names.
    const emptyDir = path.join(dir, "node_modules", "@typescript-eslint", "replacement");
    mkdirSync(emptyDir, { recursive: true });

    const brokenResult = checkTypescriptPeerRange(dir);
    assert.equal(
      brokenResult.ok,
      false,
      "expected the real guard to red on a present-but-manifestless scoped directory"
    );
    assert.ok(
      brokenResult.problems.some(
        (p) => p.includes("could not be fully verified") && p.includes("replacement")
      ),
      `expected a problem naming the unverifiable inventory and the manifestless directory's path, got: ${JSON.stringify(brokenResult.problems)}`
    );

    // Remove it and confirm it's green again - proves this isn't a guard
    // stuck red, it genuinely tracks its input.
    rmSync(emptyDir, { recursive: true, force: true });
    const restoredResult = checkTypescriptPeerRange(dir);
    assert.equal(restoredResult.ok, true, JSON.stringify(restoredResult.problems));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PROPERTY: every entry discoverInstalledTypescriptPeerPackages ADMITS under the @typescript-eslint scope (a directory or a symlink) lands in exactly one of two arrays - found (a parsed manifest declaring a typescript peer) or indeterminate (anything admitted but not fully verifiable) - or is a determined-no that belongs in neither. This battery covers six admitted-entry read outcomes (directory-with-peer, directory-without-peer, malformed, missing-manifest, symlink-with-peer, and a plain file that is never admitted at all); it does not, by itself, prove every possible ADMISSION decision is sound - the dedicated mutation test below covers that boundary directly, since a battery over read outcomes cannot detect a change to what gets admitted in the first place", () => {
  const dir = makeScratchScopeDir();
  try {
    const scopeDir = path.join(dir, "node_modules", "@typescript-eslint");

    // 1. A real package that DOES declare a typescript peer - must be found.
    mkdirSync(path.join(scopeDir, "declares-peer"), { recursive: true });
    writeFileSync(
      path.join(scopeDir, "declares-peer", "package.json"),
      JSON.stringify({ peerDependencies: { typescript: ">=4.8.4 <6.1.0" } })
    );

    // 2. A real, well-formed manifest that does NOT declare a typescript
    // peer - a determined "no", correctly excluded from BOTH buckets.
    mkdirSync(path.join(scopeDir, "no-peer-declared"), { recursive: true });
    writeFileSync(
      path.join(scopeDir, "no-peer-declared", "package.json"),
      JSON.stringify({ name: "no-peer-declared" })
    );

    // 3. Malformed JSON - indeterminate.
    mkdirSync(path.join(scopeDir, "malformed"), { recursive: true });
    writeFileSync(path.join(scopeDir, "malformed", "package.json"), "{ not valid json");

    // 4. A present, enumerated directory with no package.json at all -
    // indeterminate.
    mkdirSync(path.join(scopeDir, "missing-manifest"), { recursive: true });

    // 5. A SYMLINK (not a directory dirent) resolving to a real,
    // peer-declaring package elsewhere - must be found exactly like a
    // real directory would be. A symlink is not safely excludable by
    // dirent type: unlike a plain file, it can genuinely resolve to an
    // installed package.
    const realPeerTarget = path.join(dir, "real-peer-target");
    mkdirSync(realPeerTarget, { recursive: true });
    writeFileSync(
      path.join(realPeerTarget, "package.json"),
      JSON.stringify({ peerDependencies: { typescript: ">=4.8.4 <6.1.0" } })
    );
    symlinkSync(realPeerTarget, path.join(scopeDir, "symlinked-peer"), "dir");

    // 6. A plain file, not a directory or symlink, sitting directly under
    // the scope - categorically cannot be a package (this is the one
    // exclusion decided by dirent type alone, before any read), correctly
    // excluded from both buckets and never admitted as a candidate at all.
    writeFileSync(path.join(scopeDir, "not-a-package.txt"), "just a stray file, not a package");

    const discovered = discoverInstalledTypescriptPeerPackages(dir);

    assert.deepEqual(
      discovered.packages,
      ["@typescript-eslint/declares-peer", "@typescript-eslint/symlinked-peer"],
      `expected both the real directory and the symlink that actually declare a typescript peer, got: ${JSON.stringify(discovered.packages)}`
    );

    const indeterminatePaths = discovered.indeterminate.map((e) => e.path);
    assert.ok(
      indeterminatePaths.some((p) => p.includes("malformed")),
      `expected the malformed entry to be indeterminate, got: ${JSON.stringify(discovered.indeterminate)}`
    );
    assert.ok(
      indeterminatePaths.some((p) => p.includes("missing-manifest")),
      `expected the manifestless directory to be indeterminate, got: ${JSON.stringify(discovered.indeterminate)}`
    );
    assert.equal(
      discovered.indeterminate.length,
      2,
      `expected EXACTLY the malformed and missing-manifest entries to be indeterminate - a well-formed no-peer manifest, a symlinked peer, and a plain non-package file must never appear here, got: ${JSON.stringify(discovered.indeterminate)}`
    );

    // Accounting for all six fixtures: "declares-peer" and
    // "symlinked-peer" are found; "malformed" and "missing-manifest" are
    // indeterminate; "no-peer-declared" (determined-no) and
    // "not-a-package.txt" (never admitted) appear in neither array. None
    // is silently missing from every list this function returns.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a DANGLING symlink (resolving to a target that does not exist at all) is admitted like any other symlink and reported indeterminate, not silently dropped - distinct from a real directory missing its package.json, since resolving the symlink itself fails rather than merely its manifest", () => {
  const dir = makeScratchScopeDir();
  try {
    const scopeDir = path.join(dir, "node_modules", "@typescript-eslint");
    symlinkSync(
      path.join(dir, "nowhere", "does-not-exist"),
      path.join(scopeDir, "dangling"),
      "dir"
    );

    const discovered = discoverInstalledTypescriptPeerPackages(dir);
    assert.doesNotMatch(
      discovered.packages.join(","),
      /dangling/,
      "a dangling symlink must never appear in the discovered packages list"
    );
    assert.equal(
      discovered.indeterminate.length,
      1,
      `expected the dangling symlink to be the sole indeterminate entry, got: ${JSON.stringify(discovered.indeterminate)}`
    );
    assert.match(discovered.indeterminate[0].path, /dangling[/\\]package\.json$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Copies scripts/check-typescript-peer-range.mjs (and its one lib
 * dependency) into a scratch directory under the repo root, applies a
 * textual mutation to the COPY, and dynamically `import()`s the mutated
 * copy - the real tracked file is read but never written. Mirrors the
 * established scratch-copy mutation pattern used elsewhere in this repo
 * (test/loader-escape-matrix.test.ts's loadMutatedGuardCopy) rather than
 * inventing a new one. The scratch directory must be placed under the
 * repo root, not an OS tmpdir, so relative imports inside the copy still
 * resolve.
 */
async function loadMutatedPeerRangeCopy(
  mutate: (originalText: string) => string
): Promise<{ mod: Record<string, unknown>; scratchDir: string }> {
  const scratchDir = mkdtempSync(path.join(REPO_ROOT, ".ghantika-peer-range-mutant-"));
  try {
    const scriptsDir = path.join(scratchDir, "scripts");
    const libDir = path.join(scriptsDir, "lib");
    mkdirSync(libDir, { recursive: true });
    writeFileSync(
      path.join(libDir, "is-main.mjs"),
      readFileSync(path.join(REPO_ROOT, "scripts", "lib", "is-main.mjs"), "utf8")
    );
    const originalText = readFileSync(
      path.join(REPO_ROOT, "scripts", "check-typescript-peer-range.mjs"),
      "utf8"
    );
    const mutatedText = mutate(originalText);
    assert.notEqual(
      mutatedText,
      originalText,
      "the mutation must actually change the source text - a no-op mutation proves nothing"
    );
    const mutatedPath = path.join(scriptsDir, "check-typescript-peer-range.mjs");
    writeFileSync(mutatedPath, mutatedText);
    const mod = (await import(pathToFileURL(mutatedPath).href)) as Record<string, unknown>;
    return { mod, scratchDir };
  } catch (err) {
    rmSync(scratchDir, { recursive: true, force: true });
    throw err;
  }
}

test("mutation control: narrowing the dirent-ADMISSION check to directories only (dropping the symlink branch) silently drops a real, peer-declaring symlink - the exhaustive switch cannot catch this, because a narrowed admission check excludes the entry before the switch ever sees it. The mutant: if (!entry.isDirectory()) continue; in place of the real check's isDirectory() || isSymbolicLink()", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-peer-range-symlink-mutant-"));
  let scratchDir: string | undefined;
  try {
    const scopeDir = path.join(dir, "node_modules", "@typescript-eslint");
    mkdirSync(scopeDir, { recursive: true });
    const realPeerTarget = path.join(dir, "real-peer-target");
    mkdirSync(realPeerTarget, { recursive: true });
    writeFileSync(
      path.join(realPeerTarget, "package.json"),
      JSON.stringify({ peerDependencies: { typescript: ">=4.8.4 <6.1.0" } })
    );
    symlinkSync(realPeerTarget, path.join(scopeDir, "symlinked-peer"), "dir");

    // Baseline: the real, unmutated production function finds the symlink.
    const cleanDiscovered = discoverInstalledTypescriptPeerPackages(dir);
    assert.ok(
      cleanDiscovered.packages.includes("@typescript-eslint/symlinked-peer"),
      `expected the unmutated function to find the peer-declaring symlink, got: ${JSON.stringify(cleanDiscovered.packages)}`
    );
    assert.equal(cleanDiscovered.indeterminate.length, 0);

    // Mutant: narrow the admission check to directories only.
    const loaded = await loadMutatedPeerRangeCopy((text) => {
      const target = "if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;";
      assert.ok(text.includes(target), "expected to find the exact admission-check line to mutate");
      return text.replace(target, "if (!entry.isDirectory()) continue;");
    });
    scratchDir = loaded.scratchDir;
    const mutatedDiscover = loaded.mod
      .discoverInstalledTypescriptPeerPackages as typeof discoverInstalledTypescriptPeerPackages;

    const mutatedDiscovered = mutatedDiscover(dir);
    assert.ok(
      !mutatedDiscovered.packages.includes("@typescript-eslint/symlinked-peer"),
      `expected the mutant to silently drop the symlinked peer, got: ${JSON.stringify(mutatedDiscovered.packages)}`
    );
    assert.equal(
      mutatedDiscovered.indeterminate.length,
      0,
      `expected the mutant to drop the symlink WITHOUT reporting it indeterminate either - this is what makes it a silent admission failure rather than a caught one, got: ${JSON.stringify(mutatedDiscovered.indeterminate)}`
    );
    // The replacement lands in neither returned array: the exhaustive
    // switch never gets a chance to object, because the entry never
    // reaches it. This proves the admission check, not the switch, is
    // what has to stay correct for this class of entry.
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  }
});

// checkTypescriptPeerRange's own inventory wiring is exercised, not just
// documented, by the existing 'the real, installed typescript-eslint peer
// range is exactly ">=4.8.4 <6.1.0"' test above: it already calls
// checkTypescriptPeerRange(REPO_ROOT) - the SAME function, now including the
// inventory check inline - against the real root and asserts ok:true. A
// separate test repeating that exact call would prove nothing new.
