import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PINNED_DEV_PACKAGES,
  PINNED_PACKAGES,
  checkSdkExactPin,
  isExactSemver,
  resolveLockedVersion,
} from "../scripts/check-sdk-exact-pin.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const SERVER = "@modelcontextprotocol/server";
const CORE = "@modelcontextprotocol/core";
const CLIENT = "@modelcontextprotocol/client";

/**
 * Writes a minimal package.json/package-lock.json fixture pair into `dir`,
 * modeling this repo's real shape: `server` as a direct dependency,
 * `core` reached only transitively through `server`'s own recorded
 * dependency spec, and `client` as a dev-only dependency (present in the
 * lockfile, marked `dev: true`) - independent knobs for each of
 * `serverManifestSpec`/`serverLockedVersion`/`coreParentSpec`/
 * `coreLockedVersion`, so a test can exercise a defect in any one layer in
 * isolation.
 *
 * The dev-only client gets its own knob per SITE (`client.manifestField`
 * and `client.manifestSpec`, `client.lockRootField` and
 * `client.lockRootSpec`, `client.resolvedVersion`, `client.dev`), because
 * a dev dependency occupies three places at once and the interesting
 * defects each touch exactly one of them: a site deleted, a field moved
 * from devDependencies to dependencies, one otherwise-exact version
 * drifting away from the other two, a resolved version replaced by a tag.
 * Each knob moves one dimension so a mutation cannot be caught only in
 * combination with another. `"absent"` on any field omits that site.
 *
 * @param {string} dir
 * @param {{
 *   serverManifestSpec: string,
 *   serverLockedVersion: string,
 *   coreParentSpec: string,
 *   coreLockedVersion: string,
 *   client?: Partial<typeof CLEAN_CLIENT>,
 *   extraProductionPackages?: Record<string, string>,
 * }} opts
 */
function writeFixture(
  dir,
  {
    serverManifestSpec,
    serverLockedVersion,
    coreParentSpec,
    coreLockedVersion,
    client = {},
    extraProductionPackages = {},
  }
) {
  const c = { ...CLEAN_CLIENT, ...client };

  const manifest = {
    name: "fixture",
    version: "1.0.0",
    dependencies: { [SERVER]: serverManifestSpec },
  };
  if (c.manifestField !== "absent") {
    manifest[c.manifestField] = { ...manifest[c.manifestField], [CLIENT]: c.manifestSpec };
  }
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));

  const lockRoot = {
    name: "fixture",
    version: "1.0.0",
    dependencies: { [SERVER]: serverManifestSpec },
  };
  if (c.lockRootField !== "absent") {
    lockRoot[c.lockRootField] = { ...lockRoot[c.lockRootField], [CLIENT]: c.lockRootSpec };
  }

  const packages = {
    "": lockRoot,
    [`node_modules/${SERVER}`]: {
      version: serverLockedVersion,
      dependencies: { [CORE]: coreParentSpec },
    },
    [`node_modules/${CORE}`]: { version: coreLockedVersion },
  };
  if (c.resolvedVersion !== "absent") {
    const clientEntry = { version: c.resolvedVersion };
    if (c.dev !== "absent") clientEntry.dev = c.dev;
    packages[`node_modules/${CLIENT}`] = clientEntry;
  }
  for (const [name, version] of Object.entries(extraProductionPackages)) {
    packages[`node_modules/${name}`] = { version };
  }
  writeFileSync(
    path.join(dir, "package-lock.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages,
    })
  );
}

/** The dev-only client, internally consistent across all three of its sites. */
const CLEAN_CLIENT = {
  manifestField: "devDependencies",
  manifestSpec: "2.0.0-beta.4",
  lockRootField: "devDependencies",
  lockRootSpec: "2.0.0-beta.4",
  resolvedVersion: "2.0.0-beta.4",
  dev: true,
};

const CLEAN_FIXTURE = {
  serverManifestSpec: "2.0.0-beta.4",
  serverLockedVersion: "2.0.0-beta.4",
  coreParentSpec: "2.0.0-beta.4",
  coreLockedVersion: "2.0.0-beta.4",
};

function withScratchDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-sdk-pin-guard-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- isExactSemver: the pure predicate every mutation row below turns on. ---

test("isExactSemver accepts a bare X.Y.Z", () => {
  assert.equal(isExactSemver("2.0.0"), true);
});

test("isExactSemver accepts a prerelease/build-metadata suffix (still an exact, single version)", () => {
  assert.equal(isExactSemver("2.0.0-beta.4"), true);
  assert.equal(isExactSemver("2.0.0+build.5"), true);
});

test("isExactSemver rejects every range/wildcard/tag shape", () => {
  for (const spec of [
    "^2.0.0-beta.4",
    "~2.0.0-beta.4",
    ">=2.0.0-beta.4",
    "<=2.0.0-beta.4",
    ">2.0.0-beta.4",
    "<2.0.0-beta.4",
    "2.x",
    "2.0.x",
    "*",
    "latest",
    "next",
  ]) {
    assert.equal(isExactSemver(spec), false, `"${spec}" must not be treated as an exact pin`);
  }
});

test("isExactSemver rejects a workspace/file/git protocol reference", () => {
  for (const spec of ["workspace:*", "file:../local-sdk", "git+https://example.invalid/sdk.git"]) {
    assert.equal(isExactSemver(spec), false, `"${spec}" must not be treated as an exact pin`);
  }
});

test("isExactSemver rejects a non-string value", () => {
  assert.equal(isExactSemver(undefined), false);
  assert.equal(isExactSemver(null), false);
  assert.equal(isExactSemver(129), false);
});

// --- resolveLockedVersion: both supported lockfile shapes. ---

test('resolveLockedVersion reads the lockfileVersion 3 shape (packages["node_modules/<name>"].version)', () => {
  const lockfile = { packages: { [`node_modules/${SERVER}`]: { version: "2.0.0-beta.4" } } };
  assert.equal(resolveLockedVersion(lockfile, SERVER), "2.0.0-beta.4");
});

test("resolveLockedVersion falls back to the legacy lockfileVersion 1/2 shape (dependencies[<name>].version)", () => {
  const lockfile = { dependencies: { [SERVER]: { version: "2.0.0-beta.4" } } };
  assert.equal(resolveLockedVersion(lockfile, SERVER), "2.0.0-beta.4");
});

test("resolveLockedVersion returns null when the package has no resolved entry in either shape", () => {
  assert.equal(resolveLockedVersion({ packages: {} }, SERVER), null);
});

// --- PINNED_PACKAGES: the known package SET itself. ---

test("PINNED_PACKAGES names exactly server (direct) and core (transitive, via server)", () => {
  assert.deepEqual(Object.keys(PINNED_PACKAGES).sort(), [CORE, SERVER]);
  assert.equal(PINNED_PACKAGES[SERVER].directDependency, true);
  assert.equal(PINNED_PACKAGES[CORE].directDependency, false);
  assert.equal(PINNED_PACKAGES[CORE].via, SERVER);
});

// --- checkSdkExactPin: the direct dependency (server), every mutation row. ---

test("mutation control: a caret range on the direct dependency (server) is flagged", () => {
  withScratchDir((dir) => {
    writeFixture(dir, { ...CLEAN_FIXTURE, serverManifestSpec: "^2.0.0-beta.4" });
    const problems = checkSdkExactPin(dir);
    assert.equal(problems.length, 1, "a caret range must fail the exact-pin check");
    assert.match(problems[0], /not an exact version/);
  });
});

test("mutation control: a tilde range on the direct dependency (server) is flagged", () => {
  withScratchDir((dir) => {
    writeFixture(dir, { ...CLEAN_FIXTURE, serverManifestSpec: "~2.0.0-beta.4" });
    const problems = checkSdkExactPin(dir);
    assert.equal(problems.length, 1, "a tilde range must fail the exact-pin check");
    assert.match(problems[0], /not an exact version/);
  });
});

test("mutation control: a dist-tag (`latest`) on the direct dependency (server) is flagged", () => {
  withScratchDir((dir) => {
    writeFixture(dir, { ...CLEAN_FIXTURE, serverManifestSpec: "latest" });
    const problems = checkSdkExactPin(dir);
    assert.equal(problems.length, 1, "a dist-tag name must fail the exact-pin check");
    assert.match(problems[0], /not an exact version/);
  });
});

test("mutation control: the direct dependency (server) manifest pin DRIFTED from the lockfile's resolved version is flagged", () => {
  withScratchDir((dir) => {
    writeFixture(dir, { ...CLEAN_FIXTURE, serverLockedVersion: "2.0.0-beta.5" });
    const problems = checkSdkExactPin(dir);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /drifted apart/);
  });
});

// --- checkSdkExactPin: the transitive dependency (core, via server), every mutation row. ---

test("mutation control: a caret range on the transitive dependency's parent-recorded spec (server -> core) is flagged", () => {
  withScratchDir((dir) => {
    writeFixture(dir, { ...CLEAN_FIXTURE, coreParentSpec: "^2.0.0-beta.4" });
    const problems = checkSdkExactPin(dir);
    assert.equal(
      problems.length,
      1,
      "a caret range on the transitive spec must fail the exact-pin check"
    );
    assert.match(problems[0], /not an exact version/);
    assert.match(problems[0], /own recorded dependency/);
  });
});

test("mutation control: the transitive dependency's resolved version DRIFTED from what its parent recorded is flagged", () => {
  withScratchDir((dir) => {
    writeFixture(dir, { ...CLEAN_FIXTURE, coreLockedVersion: "2.0.0-beta.3" });
    const problems = checkSdkExactPin(dir);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /drifted apart/);
  });
});

test("mutation control: a missing transitive dependency (server records no core spec at all) is flagged", () => {
  withScratchDir((dir) => {
    writeFixture(dir, CLEAN_FIXTURE);
    const pkgLockPath = path.join(dir, "package-lock.json");
    const lockfile = JSON.parse(readFileSync(pkgLockPath, "utf8"));
    delete lockfile.packages[`node_modules/${SERVER}`].dependencies[CORE];
    writeFileSync(pkgLockPath, JSON.stringify(lockfile));
    const problems = checkSdkExactPin(dir);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /entry is missing/);
  });
});

// --- checkSdkExactPin: fails CLOSED on an unrecognised production package. ---

test("mutation control: an unrecognised production @modelcontextprotocol/* package in the lockfile is flagged, not silently ignored", () => {
  withScratchDir((dir) => {
    writeFixture(dir, {
      ...CLEAN_FIXTURE,
      extraProductionPackages: { "@modelcontextprotocol/node": "2.0.0-beta.4" },
    });
    const problems = checkSdkExactPin(dir);
    assert.equal(
      problems.length,
      1,
      `expected exactly one unrecognised-package problem, got: ${JSON.stringify(problems)}`
    );
    assert.match(problems[0], /does not recognise/);
    assert.match(problems[0], /@modelcontextprotocol\/node/);
  });
});

test("green control: a dev-only @modelcontextprotocol/* package (client) is never flagged as unrecognised - it is correctly excluded as non-production", () => {
  withScratchDir((dir) => {
    writeFixture(dir, CLEAN_FIXTURE);
    assert.deepEqual(checkSdkExactPin(dir), []);
  });
});

// --- checkSdkExactPin: the dev-only dependency (client), one dimension at
// a time. ---
//
// A dev dependency is not one value, it is the same value written in three
// places: package.json's devDependencies, package-lock.json's mirrored
// record of the root package, and the resolved entry npm installs. Being
// clean means all three exist, all three agree, and the resolved entry is
// genuinely marked dev. Every row below mutates exactly ONE of those
// dimensions and leaves the rest valid, because a defect that only shows
// up when two things are wrong at once is a defect that ships.

/**
 * Runs the guard over a fixture whose only difference from clean is the
 * given client mutation, and returns the problems.
 *
 * @param {string} dir
 * @param {Partial<typeof CLEAN_CLIENT>} clientMutation
 */
function problemsForClientMutation(dir, clientMutation) {
  writeFixture(dir, { ...CLEAN_FIXTURE, client: clientMutation });
  return checkSdkExactPin(dir);
}

/**
 * @param {string[]} problems
 * @param {RegExp} pattern
 */
function assertSomeProblem(problems, pattern) {
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `expected a problem matching ${pattern}, got: ${JSON.stringify(problems, null, 2)}`
  );
}

// Presence: each of the three sites, deleted on its own.

test("mutation control: the dev-only client missing from package.json's devDependencies is flagged", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, { manifestField: "absent" });
    assertSomeProblem(problems, /package\.json.+"@modelcontextprotocol\/client".+is missing/);
  });
});

test("mutation control: the dev-only client missing from the lockfile root package is flagged", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, { lockRootField: "absent" });
    assertSomeProblem(problems, /package-lock\.json's root package.+is missing/);
  });
});

test("mutation control: the dev-only client missing its resolved lockfile entry is flagged", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, { resolvedVersion: "absent" });
    assertSomeProblem(problems, /no resolved entry for "@modelcontextprotocol\/client"/);
  });
});

// Exactness: a range at each request site, on its own and together.

test("mutation control: a caret range on the dev-only client request is flagged in package.json", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, { manifestSpec: "^2.0.0-beta.4" });
    assertSomeProblem(problems, /package\.json.+"\^2\.0\.0-beta\.4".+not an exact version/);
  });
});

test("mutation control: a caret range on the dev-only client request is flagged in the lockfile root package", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, { lockRootSpec: "^2.0.0-beta.4" });
    assertSomeProblem(
      problems,
      /package-lock\.json's root package.+"\^2\.0\.0-beta\.4".+not an exact version/
    );
  });
});

test("mutation control: a caret range on the dev-only client request in BOTH manifest and lockfile is flagged, with the resolved dev entry left intact", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, {
      manifestSpec: "^2.0.0-beta.4",
      lockRootSpec: "^2.0.0-beta.4",
      resolvedVersion: "2.0.0-beta.4",
    });
    assertSomeProblem(problems, /package\.json.+"\^2\.0\.0-beta\.4".+not an exact version/);
    assertSomeProblem(
      problems,
      /package-lock\.json's root package.+"\^2\.0\.0-beta\.4".+not an exact version/
    );
  });
});

test("mutation control: a tilde range on the dev-only client request is flagged in package.json", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, { manifestSpec: "~2.0.0-beta.4" });
    assertSomeProblem(problems, /package\.json.+"~2\.0\.0-beta\.4".+not an exact version/);
  });
});

test("mutation control: a tilde range on the dev-only client request is flagged in the lockfile root package", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, { lockRootSpec: "~2.0.0-beta.4" });
    assertSomeProblem(
      problems,
      /package-lock\.json's root package.+"~2\.0\.0-beta\.4".+not an exact version/
    );
  });
});

test("mutation control: a tilde range on the dev-only client request in BOTH manifest and lockfile is flagged", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, {
      manifestSpec: "~2.0.0-beta.4",
      lockRootSpec: "~2.0.0-beta.4",
    });
    assertSomeProblem(problems, /package\.json.+"~2\.0\.0-beta\.4".+not an exact version/);
    assertSomeProblem(
      problems,
      /package-lock\.json's root package.+"~2\.0\.0-beta\.4".+not an exact version/
    );
  });
});

test("mutation control: a dist-tag on the dev-only client request is flagged", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, {
      manifestSpec: "latest",
      lockRootSpec: "latest",
    });
    assertSomeProblem(problems, /package\.json.+"latest".+not an exact version/);
    assertSomeProblem(
      problems,
      /package-lock\.json's root package.+"latest".+not an exact version/
    );
  });
});

// Agreement: one otherwise-exact value drifting away from the others.

test("mutation control: the dev-only client requested at one exact version in package.json and another in the lockfile root is flagged", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, { manifestSpec: "2.0.0-beta.5" });
    assertSomeProblem(problems, /does not name the same version everywhere/);
    assertSomeProblem(problems, /2\.0\.0-beta\.5/);
  });
});

test("mutation control: the dev-only client resolved at a different exact version than both requests is flagged", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, { resolvedVersion: "2.0.0-beta.5" });
    assertSomeProblem(problems, /does not name the same version everywhere/);
  });
});

test("mutation control: a resolved dev-only client version that is not a concrete version is flagged", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, { resolvedVersion: "latest" });
    assertSomeProblem(problems, /resolved "@modelcontextprotocol\/client" to "latest"/);
  });
});

// The dev marker itself, and the field the entry sits under.

test("mutation control: a resolved dev-only client entry with no dev marker is flagged", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, { dev: "absent" });
    assertSomeProblem(problems, /is not marked "dev": true/);
  });
});

test("mutation control: a resolved dev-only client entry marked dev false is flagged", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, { dev: false });
    assertSomeProblem(problems, /is not marked "dev": true/);
  });
});

test("mutation control: the client moved into package.json's production dependencies is flagged", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, { manifestField: "dependencies" });
    assertSomeProblem(problems, /package\.json lists.+under "dependencies"/);
  });
});

test("mutation control: the client moved into the lockfile root package's production dependencies is flagged", () => {
  withScratchDir((dir) => {
    const problems = problemsForClientMutation(dir, { lockRootField: "dependencies" });
    assertSomeProblem(problems, /package-lock\.json's root package lists.+under "dependencies"/);
  });
});

// The fail-closed scan for a dev-only package the guard was never told about.

test("mutation control: an unrecognised dev-only @modelcontextprotocol/* package in the lockfile is flagged rather than trusted", () => {
  withScratchDir((dir) => {
    writeFixture(dir, CLEAN_FIXTURE);
    const pkgLockPath = path.join(dir, "package-lock.json");
    const lockfile = JSON.parse(readFileSync(pkgLockPath, "utf8"));
    lockfile.packages["node_modules/@modelcontextprotocol/inspector"] = {
      version: "2.0.0-beta.4",
      dev: true,
    };
    writeFileSync(pkgLockPath, JSON.stringify(lockfile));
    const problems = checkSdkExactPin(dir);
    assert.equal(problems.length, 1, `got: ${JSON.stringify(problems)}`);
    assert.match(problems[0], /does not recognise/);
    assert.match(problems[0], /@modelcontextprotocol\/inspector/);
  });
});

// --- green controls ---

test("green control: PINNED_DEV_PACKAGES names exactly the client, held apart from the production set", () => {
  assert.deepEqual(PINNED_DEV_PACKAGES, [CLIENT]);
  assert.equal(Object.keys(PINNED_PACKAGES).includes(CLIENT), false);
});

test("green control: an exact-pinned dev-only client is permitted and stays clean", () => {
  withScratchDir((dir) => {
    writeFixture(dir, CLEAN_FIXTURE);
    assert.deepEqual(
      checkSdkExactPin(dir),
      [],
      "an exact dev-only client is legitimate; the guard must not become a blanket dev-dependency ban"
    );
  });
});

test("green control: a dev-only client exact-pinned at a different version than production, consistently across all three sites, is still clean", () => {
  withScratchDir((dir) => {
    writeFixture(dir, {
      ...CLEAN_FIXTURE,
      client: {
        manifestSpec: "2.0.0-beta.5",
        lockRootSpec: "2.0.0-beta.5",
        resolvedVersion: "2.0.0-beta.5",
      },
    });
    assert.deepEqual(
      checkSdkExactPin(dir),
      [],
      "the rule is exactness and internal agreement, not a hardcoded version"
    );
  });
});

test("green control: the real, current exact-pinned repo state passes with zero problems", () => {
  const problems = checkSdkExactPin(REPO_ROOT);
  assert.deepEqual(
    problems,
    [],
    "this repo's real package.json/package-lock.json must already satisfy the exact-pin guard"
  );
});

test("green control: a fully clean fixture (direct + transitive both exact, no unrecognised packages) passes", () => {
  withScratchDir((dir) => {
    writeFixture(dir, CLEAN_FIXTURE);
    assert.deepEqual(checkSdkExactPin(dir), []);
  });
});

test("mutation control: a missing package-lock.json resolved entry for the direct dependency is flagged", () => {
  withScratchDir((dir) => {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        dependencies: { [SERVER]: "2.0.0-beta.4" },
      })
    );
    writeFileSync(
      path.join(dir, "package-lock.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": {} },
      })
    );
    const problems = checkSdkExactPin(dir);
    assert.ok(problems.some((p) => /no resolved entry/.test(p)));
  });
});

test("mutation control: a missing package.json dependency entry for the direct dependency is flagged", () => {
  withScratchDir((dir) => {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: {} })
    );
    writeFileSync(
      path.join(dir, "package-lock.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": {} },
      })
    );
    const problems = checkSdkExactPin(dir);
    assert.ok(problems.some((p) => /entry is missing/.test(p)));
  });
});
