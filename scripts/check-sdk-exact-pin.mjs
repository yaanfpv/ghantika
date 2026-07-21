#!/usr/bin/env node
/**
 * Guards against ANY production `@modelcontextprotocol/*` dependency
 * silently regressing from an EXACT version pin (no `^`, `~`, range
 * operator, wildcard, or tag) to a range that lets `npm ci` resolve a
 * different version than the one this repo was built and tested against.
 * An exact pin plus a matching, committed package-lock.json is what makes
 * every `npm ci` install byte-for-byte reproducible (see
 * verify-install-reproducibility.mjs); a caret or tilde range reopens
 * exactly the drift that guard exists to rule out, even though the
 * lockfile itself may not change at the moment the range is loosened.
 *
 * The unit of analysis is the SET of production `@modelcontextprotocol/*`
 * packages this repo actually depends on, not one hardcoded name - this
 * repo depends on `server` directly and `core` transitively (through
 * `server`'s own exact pin on it), and both must stay exact:
 *
 *   1. `@modelcontextprotocol/server` - package.json's own "dependencies"
 *      entry must be a bare exact semver, AND package-lock.json's
 *      RESOLVED version for it must match that exact pin.
 *   2. `@modelcontextprotocol/core` - not a direct dependency of this repo
 *      (reached only through `server`), so there is no package.json entry
 *      to read directly. Instead, `server`'s OWN recorded dependency
 *      requirement on it (package-lock.json's
 *      `packages["node_modules/@modelcontextprotocol/server"].dependencies`
 *      map - what `server`'s package.json itself asked for) must be a bare
 *      exact semver, AND package-lock.json's resolved version for `core`
 *      must match THAT.
 *   3. FAILS CLOSED on an unrecognised package: every OTHER production
 *      `@modelcontextprotocol/*` package present in package-lock.json (a
 *      package NOT marked `dev: true`) is reported as unexpected rather
 *      than silently ignored - this is what catches a future SDK
 *      restructuring, or an accidental new production dependency, that
 *      this guard has not been taught about yet.
 *   4. DEV-ONLY `@modelcontextprotocol/*` packages are ALLOWED to exist,
 *      and each EXPECTED one (PINNED_DEV_PACKAGES) is checked across all
 *      three sites it occupies at once: package.json's "devDependencies",
 *      package-lock.json's mirrored record of the root package, and the
 *      resolved lockfile entry. All three must be present, name the SAME
 *      exact version, and the resolved entry must be marked `dev`.
 *      `@modelcontextprotocol/client` is the live example: the tests pair
 *      a real Client against the real Server over the SDK's own
 *      InMemoryTransport rather than hand-rolling protocol frames, so the
 *      client's version decides what those tests actually prove, and a
 *      version that drifts at any one of the three sites means the suite
 *      is no longer proving what it says it proves. This is an integrity
 *      rule, not a ban - an exact-pinned, internally consistent dev
 *      dependency stays clean at any version. A dev-only
 *      `@modelcontextprotocol/*` package that is NOT expected is reported
 *      rather than trusted, the same way an unrecognised production
 *      package is.
 *
 * Run with:
 *
 *   npm run guard:sdk-pin
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The exact production `@modelcontextprotocol/*` package SET this repo
 * depends on. `directDependency: true` means package.json's own
 * "dependencies" carries the pin directly; `false` means it is reached
 * only transitively, through another package in this same set (`via`
 * names that parent), and its pin is read from the PARENT's own recorded
 * dependency requirement in package-lock.json instead.
 */
export const PINNED_PACKAGES = {
  "@modelcontextprotocol/server": { directDependency: true },
  "@modelcontextprotocol/core": { directDependency: false, via: "@modelcontextprotocol/server" },
};

/**
 * The dev-only `@modelcontextprotocol/*` packages this repo expects, held
 * separately from the production set above because they are checked
 * differently: a dev dependency is verified across all three of its sites
 * (see checkExpectedDevPackage), while production pins are read from the
 * manifest or from a parent's recorded requirement. Any dev-only
 * `@modelcontextprotocol/*` package NOT named here is reported as
 * unexpected rather than trusted.
 */
export const PINNED_DEV_PACKAGES = ["@modelcontextprotocol/client"];

// A bare X.Y.Z, with an optional -prerelease and/or +build-metadata
// suffix (both valid parts of semver proper) - and nothing else. Any
// leading range operator (^ ~ >= <= > < the "||"/" - " range-join forms),
// an "x"/"*" wildcard component, a dist-tag name (`latest`, `next`), or a
// protocol prefix (`workspace:`, `file:`, `git+https://...`) all fail
// this, because none of them begin with a literal digit followed
// immediately by the rest of the pattern the way a bare version does.
const EXACT_SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * @param {unknown} versionSpec
 * @returns {boolean}
 */
export function isExactSemver(versionSpec) {
  return typeof versionSpec === "string" && EXACT_SEMVER_PATTERN.test(versionSpec.trim());
}

/**
 * Reads the RESOLVED version npm actually locked for `packageName` out of
 * a parsed package-lock.json, supporting both the current lockfileVersion
 * 3 shape (a flat `packages["node_modules/<name>"].version` map) and the
 * older lockfileVersion 1/2 shape (`dependencies[<name>].version`) - this
 * repo's own lockfile is v3, but a guard that only understood v3 would
 * silently stop working the moment npm's lockfile format moves again.
 *
 * @param {Record<string, unknown>} lockfile
 * @param {string} packageName
 * @returns {string | null}
 */
export function resolveLockedVersion(lockfile, packageName) {
  const packages = /** @type {Record<string, { version?: unknown }> | undefined} */ (
    lockfile.packages
  );
  const nodeModulesEntry = packages?.[`node_modules/${packageName}`];
  if (nodeModulesEntry && typeof nodeModulesEntry.version === "string") {
    return nodeModulesEntry.version;
  }

  const legacyDependencies = /** @type {Record<string, { version?: unknown }> | undefined} */ (
    lockfile.dependencies
  );
  const legacyEntry = legacyDependencies?.[packageName];
  if (legacyEntry && typeof legacyEntry.version === "string") {
    return legacyEntry.version;
  }

  return null;
}

/**
 * The dependency SPEC a parent package (already resolved in the lockfile)
 * itself recorded for `childName` - what that parent's own package.json
 * asked for, as captured in package-lock.json's per-package
 * `dependencies` map. `null` when the parent has no recorded dependency
 * on that child at all.
 *
 * @param {Record<string, unknown>} lockfile
 * @param {string} parentName
 * @param {string} childName
 * @returns {string | null}
 */
function resolveParentRequestedSpec(lockfile, parentName, childName) {
  const packages =
    /** @type {Record<string, { dependencies?: Record<string, string> }> | undefined} */ (
      lockfile.packages
    );
  const parentEntry = packages?.[`node_modules/${parentName}`];
  const spec = parentEntry?.dependencies?.[childName];
  return typeof spec === "string" ? spec : null;
}

/**
 * Every `@modelcontextprotocol/*` package name present in package-lock.json
 * that is reachable from PRODUCTION dependencies - a package marked
 * `dev: true` (reachable only through devDependencies, e.g. the test-only
 * `@modelcontextprotocol/client`) is excluded, since this guard's whole
 * concern is the PRODUCTION install a real `npm ci --omit=dev` produces.
 *
 * @param {Record<string, unknown>} lockfile
 * @returns {string[]}
 */
function productionModelContextProtocolPackages(lockfile) {
  const packages = /** @type {Record<string, { dev?: boolean }> | undefined} */ (lockfile.packages);
  if (packages === undefined) return [];
  return Object.entries(packages)
    .filter(([name, entry]) => name.startsWith("node_modules/@modelcontextprotocol/") && !entry.dev)
    .map(([name]) => name.slice("node_modules/".length));
}

/**
 * Every `@modelcontextprotocol/*` package name present in package-lock.json
 * that is reachable ONLY through devDependencies (`dev: true`). Used to
 * spot a dev-only package this guard has never been told to expect; the
 * expected ones are checked in full by checkExpectedDevPackage.
 *
 * @param {Record<string, unknown>} lockfile
 * @returns {string[]}
 */
function developmentModelContextProtocolPackages(lockfile) {
  const packages = /** @type {Record<string, { dev?: boolean }> | undefined} */ (lockfile.packages);
  if (packages === undefined) return [];
  return Object.entries(packages)
    .filter(
      ([name, entry]) =>
        name.startsWith("node_modules/@modelcontextprotocol/") && entry.dev === true
    )
    .map(([name]) => name.slice("node_modules/".length));
}

/**
 * The lockfile's own entry for `packageName` (not just its version), so
 * the `dev` marker can be read alongside it. Supports the lockfileVersion
 * 3 shape and the older 1/2 shape, for the same reason
 * resolveLockedVersion does.
 *
 * @param {Record<string, unknown>} lockfile
 * @param {string} packageName
 * @returns {{ version?: unknown, dev?: unknown } | null}
 */
function resolveLockEntry(lockfile, packageName) {
  const packages = /** @type {Record<string, object> | undefined} */ (lockfile.packages);
  const entry = packages?.[`node_modules/${packageName}`];
  if (entry) return entry;

  const legacyDependencies = /** @type {Record<string, object> | undefined} */ (
    lockfile.dependencies
  );
  return legacyDependencies?.[packageName] ?? null;
}

/**
 * The full integrity check for one EXPECTED dev-only package. A dev
 * dependency lives in three places at once - package.json's
 * "devDependencies", package-lock.json's mirrored record of the root
 * package, and the resolved entry npm actually installs - and being clean
 * means all three are present, all three name the SAME exact version, and
 * the resolved entry is genuinely marked dev.
 *
 * Checking only the shape of whichever specs happen to be present is not
 * enough, because every interesting way this can rot leaves each
 * individual spec looking perfectly well-formed: a site quietly deleted, a
 * request and the resolved version drifting to different exact versions, a
 * resolved version replaced by a tag, the whole entry moved out of
 * devDependencies and into production. Each of those is checked here on
 * its own, so a mutation to any single site is caught by itself rather
 * than only in combination with another.
 *
 * @param {Record<string, unknown>} pkg
 * @param {Record<string, unknown>} lockfile
 * @param {string} packageName
 * @returns {string[]}
 */
function checkExpectedDevPackage(pkg, lockfile, packageName) {
  const problems = [];

  const manifestDeps = /** @type {Record<string, unknown> | undefined} */ (pkg.dependencies);
  const manifestDevDeps = /** @type {Record<string, unknown> | undefined} */ (pkg.devDependencies);
  const lockPackages =
    /** @type {Record<string, Record<string, Record<string, unknown> | undefined>> | undefined} */ (
      lockfile.packages
    );
  const lockRoot = lockPackages?.[""];

  const manifestSpec = manifestDevDeps?.[packageName];
  const lockRootSpec = lockRoot?.devDependencies?.[packageName];
  const lockEntry = resolveLockEntry(lockfile, packageName);

  // Misplacement: a dev-only package listed as production would ship to
  // every consumer of this package, and reads as production to any tool
  // that trusts the manifest.
  if (typeof manifestDeps?.[packageName] === "string") {
    problems.push(
      `package.json lists "${packageName}" under "dependencies", but it is test-only and belongs in "devDependencies"`
    );
  }
  if (typeof lockRoot?.dependencies?.[packageName] === "string") {
    problems.push(
      `package-lock.json's root package lists "${packageName}" under "dependencies", but it is test-only and belongs in "devDependencies"`
    );
  }

  // Presence, then exactness, at each of the two request sites.
  if (typeof manifestSpec !== "string") {
    problems.push(`package.json's "devDependencies"."${packageName}" entry is missing`);
  } else if (!isExactSemver(manifestSpec)) {
    problems.push(
      `package.json's "devDependencies"."${packageName}" pins "${packageName}" to "${manifestSpec}", which is not an exact version - ` +
        "use a bare X.Y.Z with no range operator, wildcard, or tag"
    );
  }

  if (typeof lockRootSpec !== "string") {
    problems.push(
      `package-lock.json's root package "devDependencies"."${packageName}" entry is missing`
    );
  } else if (!isExactSemver(lockRootSpec)) {
    problems.push(
      `package-lock.json's root package "devDependencies"."${packageName}" pins "${packageName}" to "${lockRootSpec}", which is not an exact version - ` +
        "use a bare X.Y.Z with no range operator, wildcard, or tag"
    );
  }

  // The resolved entry: present, exactly versioned, and marked dev.
  const resolvedVersion = typeof lockEntry?.version === "string" ? lockEntry.version : null;
  if (lockEntry === null) {
    problems.push(`package-lock.json has no resolved entry for "${packageName}"`);
  } else {
    if (resolvedVersion === null) {
      problems.push(`package-lock.json's resolved entry for "${packageName}" has no version`);
    } else if (!isExactSemver(resolvedVersion)) {
      problems.push(
        `package-lock.json resolved "${packageName}" to "${resolvedVersion}", which is not an exact version - ` +
          "a resolved entry must name one concrete version"
      );
    }
    if (lockEntry.dev !== true) {
      problems.push(
        `package-lock.json's resolved entry for "${packageName}" is not marked "dev": true, so it is reachable from production - ` +
          "it is test-only and must stay a dev dependency"
      );
    }
  }

  // Agreement: whatever is present must all name the same version, so an
  // otherwise-exact value cannot drift at one site alone.
  const sites = [
    { label: 'package.json\'s "devDependencies"', value: manifestSpec },
    { label: "package-lock.json's root package", value: lockRootSpec },
    { label: "package-lock.json's resolved entry", value: resolvedVersion },
  ].filter((site) => typeof site.value === "string");
  if (new Set(sites.map((site) => site.value)).size > 1) {
    const rendered = sites.map((site) => `${site.label} says "${site.value}"`).join(", ");
    problems.push(
      `"${packageName}" does not name the same version everywhere: ${rendered} - ` +
        "the manifest request, the lockfile's root request, and the resolved entry must agree"
    );
  }

  return problems;
}

/**
 * Runs every check described in the header comment against a real
 * package.json/package-lock.json pair under `root`, returning a list of
 * human-readable problem strings (empty when everything is clean). A test
 * can pass a scratch fixture directory to exercise every mutation shape
 * in isolation; production defaults to the real repo root.
 *
 * @param {string} [root]
 * @returns {string[]}
 */
export function checkSdkExactPin(root = REPO_ROOT) {
  const problems = [];

  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));

  for (const [packageName, spec] of Object.entries(PINNED_PACKAGES)) {
    const requestedSpec = spec.directDependency
      ? pkg.dependencies?.[packageName]
      : resolveParentRequestedSpec(lockfile, spec.via, packageName);
    const specSource = spec.directDependency
      ? `package.json's "dependencies"."${packageName}"`
      : `"${spec.via}"'s own recorded dependency on "${packageName}" (package-lock.json)`;

    if (typeof requestedSpec !== "string") {
      problems.push(`${specSource} entry is missing`);
      continue;
    }
    if (!isExactSemver(requestedSpec)) {
      problems.push(
        `${specSource} pins "${packageName}" to "${requestedSpec}", which is not an exact version - ` +
          "use a bare X.Y.Z with no range operator, wildcard, or tag"
      );
    }

    const lockedVersion = resolveLockedVersion(lockfile, packageName);
    if (lockedVersion === null) {
      problems.push(`package-lock.json has no resolved entry for "${packageName}"`);
    } else if (isExactSemver(requestedSpec) && lockedVersion !== requestedSpec) {
      problems.push(
        `${specSource} pins "${packageName}" to "${requestedSpec}" but package-lock.json resolved "${lockedVersion}" - ` +
          "the requested spec and the lockfile have drifted apart"
      );
    }
  }

  const knownPackageNames = new Set(Object.keys(PINNED_PACKAGES));
  for (const packageName of productionModelContextProtocolPackages(lockfile)) {
    if (!knownPackageNames.has(packageName)) {
      problems.push(
        `package-lock.json resolves a PRODUCTION dependency on "${packageName}", which this guard does not recognise - ` +
          "either it is a genuine new dependency that needs adding to PINNED_PACKAGES, or it should not be a production dependency at all"
      );
    }
  }

  for (const packageName of PINNED_DEV_PACKAGES) {
    problems.push(...checkExpectedDevPackage(pkg, lockfile, packageName));
  }

  const expectedDevPackageNames = new Set(PINNED_DEV_PACKAGES);
  for (const packageName of developmentModelContextProtocolPackages(lockfile)) {
    if (!expectedDevPackageNames.has(packageName)) {
      problems.push(
        `package-lock.json resolves a development-only dependency on "${packageName}", which this guard does not recognise - ` +
          "either it is a genuine new dev dependency that needs adding to PINNED_DEV_PACKAGES, or it should not be installed at all"
      );
    }
  }

  return problems;
}

function main() {
  const problems = checkSdkExactPin();
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `${Object.keys(PINNED_PACKAGES).join(", ")}: every production @modelcontextprotocol/* dependency is exactly pinned and matches package-lock.json's resolved versions, and ${PINNED_DEV_PACKAGES.join(", ")} is exactly pinned and consistent across manifest, lockfile root, and resolved entry`
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
