import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  checkShaParity,
  isWorkingTreeDirty,
  readEnvShaParityInputs,
  readGitHeadSha,
  readGitPorcelainStatus,
} from "../scripts/check-sha-parity.mjs";

const SAMPLE_SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SAMPLE_SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MERGE_COMMIT_SHA = "cccccccccccccccccccccccccccccccccccccccc".slice(0, 40);

// =============================================================================
// checkShaParity - the pure comparison. An explicit
// four-cell matrix: green (all three agree, clean tree), merge-ref
// substitution (red), dirty tree (red), HEAD != sha (red).
// =============================================================================

test("cell 1 (green): github.sha == git HEAD == PR head, clean tree", () => {
  const result = checkShaParity({
    githubSha: SAMPLE_SHA_A,
    gitHeadSha: SAMPLE_SHA_A,
    prHeadSha: SAMPLE_SHA_A,
    isDirty: false,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test("cell 2 (red, merge-ref substitution): github.sha/git HEAD both equal a synthetic merge-commit SHA, which differs from the PR's real head - the classic pull_request-synthetic-merge-ref footgun", () => {
  // Exactly what checking out refs/pull/N/merge looks like: GitHub's own
  // fresh merge commit is what's ACTUALLY checked out (so github.sha and
  // git HEAD legitimately agree with each other), but neither equals the
  // PR's real head commit.
  const result = checkShaParity({
    githubSha: MERGE_COMMIT_SHA,
    gitHeadSha: MERGE_COMMIT_SHA,
    prHeadSha: SAMPLE_SHA_A,
    isDirty: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0]!.reason, "sha-mismatch");
  assert.match(result.problems[0]!.detail, /synthetic merge ref/);
});

test("cell 3 (red, dirty tree): every SHA agrees, but the working tree has uncommitted modifications", () => {
  const result = checkShaParity({
    githubSha: SAMPLE_SHA_A,
    gitHeadSha: SAMPLE_SHA_A,
    prHeadSha: SAMPLE_SHA_A,
    isDirty: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0]!.reason, "dirty-tree");
});

test("cell 4 (red, HEAD != sha): the real git checkout disagrees with the CI environment's own reported SHA - a context/environment inconsistency, distinct from the merge-ref case", () => {
  const result = checkShaParity({
    githubSha: SAMPLE_SHA_A,
    gitHeadSha: SAMPLE_SHA_B,
    prHeadSha: SAMPLE_SHA_A,
    isDirty: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0]!.reason, "context-mismatch");
});

test("multiple independent problems are all reported together, never short-circuited to just the first one found", () => {
  const result = checkShaParity({
    githubSha: SAMPLE_SHA_A,
    gitHeadSha: SAMPLE_SHA_B,
    prHeadSha: MERGE_COMMIT_SHA,
    isDirty: true,
  });
  assert.equal(result.ok, false);
  const reasons = result.problems.map((p) => p.reason).sort();
  assert.deepEqual(reasons, ["context-mismatch", "dirty-tree", "sha-mismatch"]);
});

// --- mutation control: proves the guard actually reacts to the change,
// never vacuously red or vacuously green (matches this repo's established
// test/npm-ci-guard.test.js "mutation control" pattern). ---

test("mutation control: a clean, fully-agreeing input is green; flipping ANY one field alone makes it red; restoring it makes it green again", () => {
  const clean = {
    githubSha: SAMPLE_SHA_A,
    gitHeadSha: SAMPLE_SHA_A,
    prHeadSha: SAMPLE_SHA_A,
    isDirty: false,
  };
  assert.equal(
    checkShaParity(clean).ok,
    true,
    "the clean baseline must be green before any mutation"
  );

  const mutantDirty = { ...clean, isDirty: true };
  assert.equal(checkShaParity(mutantDirty).ok, false, "mutating isDirty alone must go red");

  const mutantHead = { ...clean, gitHeadSha: SAMPLE_SHA_B };
  assert.equal(checkShaParity(mutantHead).ok, false, "mutating gitHeadSha alone must go red");

  const mutantPrHead = { ...clean, prHeadSha: SAMPLE_SHA_B };
  assert.equal(checkShaParity(mutantPrHead).ok, false, "mutating prHeadSha alone must go red");

  // Restored - proves this isn't a guard that got stuck red, it genuinely
  // tracks the input.
  assert.equal(
    checkShaParity(clean).ok,
    true,
    "the unmutated clean baseline must still read green after the mutants above"
  );
});

// =============================================================================
// readGitHeadSha / isWorkingTreeDirty - the real git-wrapping halves,
// proven against a REAL scratch git repository (not synthetic strings),
// so the "reads live git state, never trusts an env var" claim in this
// guard's own docs is itself verified, not just asserted in prose.
// =============================================================================

function makeScratchGitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-sha-parity-scratch-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "ghantika-test"], { cwd: dir });
  writeFileSync(path.join(dir, "file.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: dir });
  return dir;
}

test("readGitHeadSha returns the real, live commit SHA of a scratch repo, matching a direct `git rev-parse HEAD`", () => {
  const dir = makeScratchGitRepo();
  try {
    const expected = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    assert.equal(readGitHeadSha(dir), expected);
    assert.match(
      readGitHeadSha(dir),
      /^[0-9a-f]{40}$/,
      "a real git SHA is 40 lowercase hex characters"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readGitHeadSha changes after a real new commit - proves it reads LIVE state, never a cached/stale value", () => {
  const dir = makeScratchGitRepo();
  try {
    const before = readGitHeadSha(dir);
    writeFileSync(path.join(dir, "file.txt"), "changed\n");
    execFileSync("git", ["commit", "--quiet", "-am", "second"], { cwd: dir });
    const after = readGitHeadSha(dir);
    assert.notEqual(after, before, "a real new commit must change the live-read HEAD sha");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readGitHeadSha throws against a REAL directory that is not a git working tree at all - the exact shape a mount-none guest clone (tracked file content, no .git) produces", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-sha-parity-no-git-"));
  try {
    writeFileSync(path.join(dir, "file.txt"), "hello\n");
    assert.throws(() => readGitHeadSha(dir), /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isWorkingTreeDirty/readGitPorcelainStatus: a genuinely clean scratch repo reads clean; a real uncommitted modification makes it dirty; reverting the modification makes it clean again (mutate/red/restore/green, against real git)", () => {
  const dir = makeScratchGitRepo();
  try {
    assert.equal(
      isWorkingTreeDirty(dir),
      false,
      "a freshly committed scratch repo must read clean"
    );
    assert.equal(readGitPorcelainStatus(dir), "");

    // Mutate: a real uncommitted modification.
    writeFileSync(path.join(dir, "file.txt"), "dirtied\n");
    assert.equal(
      isWorkingTreeDirty(dir),
      true,
      "an uncommitted modification must be detected as dirty"
    );
    assert.notEqual(readGitPorcelainStatus(dir), "");

    // Restore: commit it away, back to clean.
    execFileSync("git", ["commit", "--quiet", "-am", "cleanup"], { cwd: dir });
    assert.equal(
      isWorkingTreeDirty(dir),
      false,
      "committing the modification must restore a clean read"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isWorkingTreeDirty is also true for a real UNTRACKED new file, not just a modified tracked one", () => {
  const dir = makeScratchGitRepo();
  try {
    writeFileSync(path.join(dir, "untracked.txt"), "new\n");
    assert.equal(
      isWorkingTreeDirty(dir),
      true,
      "an untracked file is exactly the class of change `git status --porcelain` surfaces and this guard must catch"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// readEnvShaParityInputs - the env-var reading half, tested against a
// synthetic env object (never process.env itself, so this test never
// depends on or mutates the real running environment).
// =============================================================================

test("readEnvShaParityInputs reads GITHUB_SHA and GHANTIKA_PR_HEAD_SHA independently from a given env object", () => {
  const result = readEnvShaParityInputs({
    GITHUB_SHA: SAMPLE_SHA_A,
    GHANTIKA_PR_HEAD_SHA: SAMPLE_SHA_B,
  });
  assert.equal(result.githubSha, SAMPLE_SHA_A);
  assert.equal(result.prHeadSha, SAMPLE_SHA_B);
});

test("readEnvShaParityInputs returns undefined for either field when genuinely absent from the env - never a fabricated fallback", () => {
  assert.deepEqual(readEnvShaParityInputs({}), { githubSha: undefined, prHeadSha: undefined });
});
