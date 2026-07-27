import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PEER_RANGE_PACKAGES_TO_CHECK,
  PEER_RANGE_SOURCE_PACKAGE,
  checkTypescriptPeerRange,
  compareSemver,
  parseMinInclusiveMaxExclusiveRange,
  parseSemverTuple,
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

test("7.0.2 (Dependabot's proposed bump, still open as PR #1) does NOT satisfy the range", () => {
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
