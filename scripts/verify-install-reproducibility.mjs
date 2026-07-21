#!/usr/bin/env node
/**
 * Proves that `npm ci` produces a byte-identical node_modules tree run to
 * run from the same package-lock.json, and that the comparison used to
 * check that would actually notice if it didn't.
 *
 * "Notice if it didn't" is checked three independent ways, each applied
 * and reverted on its own before the next runs, so node_modules is left
 * exactly as a clean `npm ci` leaves it when this script finishes:
 *   1. a changed SET OF PATHS (a new file appearing)
 *   2. an EXISTING file's CONTENT changing, same paths
 *   3. a symlink's TARGET changing, same paths
 * A hash that's only sensitive to (1) would miss a real corruption that
 * changes bytes in place or silently re-points a `.bin` shim without
 * touching which paths exist.
 *
 * This deletes and reinstalls node_modules twice and needs network
 * access, so it's a standalone script rather than part of the default
 * `npm test` suite. Run it with:
 *
 *   npm run verify:install-repro
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE_MODULES = path.join(REPO_ROOT, "node_modules");

/**
 * Walks a directory, treating symlinks as leaves (recording their target
 * rather than following them) so the tree hash stays well-defined even
 * for the symlinked `.bin` shims npm installs.
 */
function walk(dir, base) {
  const entries = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (dirent.isSymbolicLink()) {
      entries.push({ rel, kind: "symlink", data: Buffer.from(readlinkSync(full)) });
    } else if (dirent.isDirectory()) {
      entries.push(...walk(full, base));
    } else if (dirent.isFile()) {
      entries.push({ rel, kind: "file", data: readFileSync(full) });
    }
  }
  return entries;
}

/**
 * Normalized hash of a directory tree: sorted relative paths plus a
 * content digest per entry, deliberately excluding mtimes/timestamps so
 * the hash only reflects what actually ended up on disk. Defaults to
 * node_modules, but accepts any directory so the same function can hash
 * an isolated scratch fixture too (see runScratchSymlinkProbe below).
 */
function hashTree(dir = NODE_MODULES) {
  const entries = walk(dir, dir)
    .map((entry) => ({
      rel: entry.rel,
      digest: createHash("sha256").update(entry.kind).update(entry.data).digest("hex"),
    }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const overall = createHash("sha256");
  for (const entry of entries) {
    overall.update(entry.rel);
    overall.update("\0");
    overall.update(entry.digest);
    overall.update("\n");
  }
  return overall.digest("hex");
}

function freshInstall() {
  rmSync(NODE_MODULES, { recursive: true, force: true });
  execFileSync("npm", ["ci"], { cwd: REPO_ROOT, stdio: "inherit" });
}

/**
 * Adds a new file to node_modules, confirms the hash changes, then removes
 * it and confirms the hash returns to `baseline` - proves the hash notices
 * a changed set of paths.
 */
function runPathSetNegativeControl(baseline) {
  const probeFile = path.join(NODE_MODULES, ".ghantika-repro-probe");
  let perturbed;
  try {
    writeFileSync(probeFile, "perturbed");
    perturbed = hashTree();
  } finally {
    rmSync(probeFile, { force: true });
  }

  if (perturbed === baseline) {
    console.error(
      "FAIL: adding a new file to node_modules did not change the tree hash - the oracle is vacuous to a changed path set"
    );
    return false;
  }
  const restored = hashTree();
  if (restored !== baseline) {
    console.error(
      "FAIL: removing the probe file did not restore the baseline hash - node_modules was left dirty"
    );
    return false;
  }
  console.log(
    `PASS (path-set control): adding a file changed the hash (${baseline} -> ${perturbed}) and reverting it restored the baseline`
  );
  return true;
}

/**
 * Picks the smallest regular file under node_modules to mutate - cheap to
 * flip a byte in and restore, and any regular file works equally well for
 * proving the hash is content-sensitive.
 */
function pickSmallestFile() {
  const files = walk(NODE_MODULES, NODE_MODULES).filter((entry) => entry.kind === "file");
  if (files.length === 0) {
    throw new Error(
      "no regular files found under node_modules to mutate for the content-sensitivity check"
    );
  }
  return files.reduce((smallest, entry) =>
    entry.data.length < smallest.data.length ? entry : smallest
  );
}

/**
 * Changes an EXISTING file's bytes without touching which paths exist.
 * The path-set check above only proves the hash notices a file appearing
 * or disappearing - it says nothing about a file whose path stays put but
 * whose content is different, which is a real corruption shape that check
 * would miss.
 */
function runContentNegativeControl(baseline) {
  const target = pickSmallestFile();
  const absolute = path.join(NODE_MODULES, ...target.rel.split("/"));
  const original = readFileSync(absolute);
  let perturbed;
  try {
    writeFileSync(
      absolute,
      Buffer.concat([original, Buffer.from("\nghantika-repro-content-probe\n")])
    );
    perturbed = hashTree();
  } finally {
    // Always restore the original bytes, whether or not the hash check
    // below passes - a failed check here must never leave a real
    // dependency file corrupted.
    writeFileSync(absolute, original);
  }

  if (perturbed === baseline) {
    console.error(
      `FAIL: changing the content of ${target.rel} did not change the tree hash - the oracle is vacuous to a same-path content change`
    );
    return false;
  }
  const restored = hashTree();
  if (restored !== baseline) {
    console.error(
      `FAIL: restoring ${target.rel}'s original bytes did not restore the baseline hash - node_modules was left dirty`
    );
    return false;
  }
  console.log(
    `PASS (content control): mutating ${target.rel}'s bytes changed the hash (${baseline} -> ${perturbed}) and reverting it restored the baseline`
  );
  return true;
}

function findSymlink() {
  return walk(NODE_MODULES, NODE_MODULES).find((entry) => entry.kind === "symlink") ?? null;
}

/**
 * Retargets an existing symlink already present in this project's real
 * node_modules (e.g. one of the `.bin` shims npm creates) and confirms the
 * hash is sensitive to that, not just to the symlink's presence or absence.
 */
function runLiveSymlinkNegativeControl(baseline, existing) {
  const absolute = path.join(NODE_MODULES, ...existing.rel.split("/"));
  const originalTarget = readlinkSync(absolute);
  const bogusTarget = `${originalTarget}-ghantika-repro-probe`;
  let perturbed;
  try {
    unlinkSync(absolute);
    symlinkSync(bogusTarget, absolute);
    perturbed = hashTree();
  } finally {
    unlinkSync(absolute);
    symlinkSync(originalTarget, absolute);
  }

  if (perturbed === baseline) {
    console.error(
      `FAIL: changing ${existing.rel}'s symlink target did not change the tree hash - the oracle is vacuous to a same-path symlink-target change`
    );
    return false;
  }
  const restored = hashTree();
  if (restored !== baseline) {
    console.error(
      `FAIL: restoring ${existing.rel}'s original symlink target did not restore the baseline hash - node_modules was left dirty`
    );
    return false;
  }
  console.log(
    `PASS (symlink control, live tree): retargeting ${existing.rel} changed the hash (${baseline} -> ${perturbed}) and reverting it restored the baseline`
  );
  return true;
}

/**
 * Fallback for when this project's own node_modules has no symlinks on the
 * current platform: proves the hashing function itself is sensitive to a
 * symlink's target against an isolated fixture instead, independent of
 * whatever this project's dependency tree happens to contain.
 */
function runScratchSymlinkNegativeControl() {
  const scratch = mkdtempSync(path.join(tmpdir(), "ghantika-repro-symlink-probe-"));
  try {
    const linkPath = path.join(scratch, "link");
    symlinkSync("target-a", linkPath);
    const before = hashTree(scratch);

    unlinkSync(linkPath);
    symlinkSync("target-b", linkPath);
    const after = hashTree(scratch);

    if (before === after) {
      console.error(
        "FAIL: the hashing function is not sensitive to a changed symlink target, even in an isolated scratch fixture"
      );
      return false;
    }
    console.log(
      `PASS (symlink control, scratch fixture): retargeting an isolated symlink changed the hash (${before} -> ${after})`
    );
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runSymlinkNegativeControl(baseline) {
  const existing = findSymlink();
  if (existing) {
    return runLiveSymlinkNegativeControl(baseline, existing);
  }
  console.log(
    "note: this project's node_modules tree contains no symlinks after `npm ci` on this platform - exercising the hashing function's symlink-target sensitivity against an isolated scratch fixture instead."
  );
  return runScratchSymlinkNegativeControl();
}

function main() {
  console.log("first clean `npm ci`...");
  freshInstall();
  const first = hashTree();
  console.log(`first tree hash:  ${first}`);

  console.log("second clean `npm ci`...");
  freshInstall();
  const baseline = hashTree();
  console.log(`second tree hash: ${baseline}`);

  if (first !== baseline) {
    console.error("FAIL: two clean `npm ci` runs produced different node_modules trees");
    process.exitCode = 1;
    return;
  }
  console.log("PASS: two clean `npm ci` runs are byte-identical (modulo timestamps)");

  // Three independent checks, each applied and reverted on its own before
  // the next runs, prove the hash actually reacts to a changed path set, a
  // same-path content change, and a same-path symlink-target change.
  if (!runPathSetNegativeControl(baseline)) {
    process.exitCode = 1;
    return;
  }
  if (!runContentNegativeControl(baseline)) {
    process.exitCode = 1;
    return;
  }
  if (!runSymlinkNegativeControl(baseline)) {
    process.exitCode = 1;
    return;
  }

  console.log(
    "\nPASS: the reproducibility oracle is sensitive to a changed path set, a same-path content change, and a same-path symlink-target change - not vacuous on any of the three."
  );
}

main();
