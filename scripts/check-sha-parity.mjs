#!/usr/bin/env node
/**
 * Guards CI checkout provenance: every CI leg must prove its checkout is the real
 * PR head commit, never a synthetic merge ref and never a dirty working
 * tree. GitHub Actions' `pull_request` trigger checks out a FRESH,
 * synthetic merge commit (`refs/pull/N/merge`) by default - a real commit
 * GitHub itself creates on the fly, whose own SHA is neither the PR's real
 * head commit nor anything the PR's author actually wrote. Running tests
 * against that merge commit instead of the real head is a well-known CI
 * footgun: a leg can go green against code that was never actually pushed
 * (an accidental merge-conflict "resolution" the synthetic commit
 * introduces, or simply staleness against a since-force-pushed branch).
 * This guard closes that gap mechanically rather than relying on every
 * workflow author to remember `ref: ${{ github.event.pull_request.head.sha }}`.
 *
 * Three inputs, three independent failure reasons (never collapsed into one
 * opaque "mismatch"):
 *
 *   - `githubSha` - the SHA the caller states is checked out.
 *   - `gitHeadSha` - what git ACTUALLY has checked out right now
 *     (`git rev-parse HEAD`), read live, never trusted from an env var -
 *     the whole point is not to trust the caller's own claim blindly.
 *   - `prHeadSha` - the pull request's real head commit SHA.
 *
 * `isDirty` (`git status --porcelain` non-empty) is checked independently
 * too: even a perfectly correct SHA checkout is not good enough if local,
 * uncommitted modifications are layered on top of it.
 *
 * What the CI wiring actually proves, stated plainly. The workflow's
 * sha-parity job checks out `github.event.pull_request.head.sha` and hands
 * that same value to the guard as BOTH `GITHUB_SHA` and
 * `GHANTIKA_PR_HEAD_SHA`. The `githubSha` vs `prHeadSha` comparison is
 * therefore TAUTOLOGICAL in CI: it compares a value against itself and can
 * never fail there. Two checks stay live, and they are the real protection:
 *
 *   1. `gitHeadSha` vs `githubSha` - git's actual HEAD really is the PR head
 *      commit. This is what catches the default `refs/pull/N/merge`
 *      checkout described above.
 *   2. `isDirty` - nothing uncommitted is layered on top of it.
 *
 * No wiring of a `pull_request` event keeps all three inputs independent AND
 * lets them agree. `github.sha` IS the synthetic merge commit there, so
 * passing it through would fail every run, and passing the head SHA instead
 * is exactly what collapses the third comparison. `checkShaParity` itself
 * keeps the three inputs separate and test/sha-parity.test.ts drives them
 * independently with synthetic values, so that third reason is exercised
 * there even though CI cannot trip it. Giving it teeth in CI would be a
 * redesign of this guard rather than a change of wiring.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * @param {string} [cwd]
 * @returns {string} the real, live `git rev-parse HEAD` output for `cwd`
 */
export function readGitHeadSha(cwd = REPO_ROOT) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

/**
 * @param {string} [cwd]
 * @returns {string} the raw `git status --porcelain` output for `cwd`
 *   (empty string for a clean tree)
 */
export function readGitPorcelainStatus(cwd = REPO_ROOT) {
  return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
}

/**
 * @param {string} [cwd]
 * @returns {boolean} true if `cwd`'s working tree has any uncommitted
 *   modification (staged, unstaged, or untracked) - `git status
 *   --porcelain` prints one line per such change, nothing at all for a
 *   genuinely clean tree.
 */
export function isWorkingTreeDirty(cwd = REPO_ROOT) {
  return readGitPorcelainStatus(cwd).trim().length > 0;
}

/**
 * The pure comparison at the heart of this guard - takes three already-
 * resolved SHA strings plus a dirty-tree flag, returns every problem found
 * (empty when clean). Split out from any git/env access specifically so it
 * is directly unit-testable against synthetic values (exercised by the
 * four-cell matrix in test/sha-parity.test.ts), matching this repo's established
 * `identityElapsedTimesMatch`/`checkProcessIdentity` split in
 * src/process.ts.
 *
 * @param {{ githubSha: string, gitHeadSha: string, prHeadSha: string, isDirty: boolean }} input
 * @returns {{ ok: boolean, problems: Array<{ reason: "dirty-tree" | "context-mismatch" | "sha-mismatch", detail: string }> }}
 */
export function checkShaParity({ githubSha, gitHeadSha, prHeadSha, isDirty }) {
  const problems = [];

  if (isDirty) {
    problems.push({
      reason: "dirty-tree",
      detail:
        "the working tree has uncommitted modifications (git status --porcelain is non-empty) - a CI leg must test a clean checkout of the exact commit, never a working tree with local changes layered on top",
    });
  }

  if (gitHeadSha !== githubSha) {
    problems.push({
      reason: "context-mismatch",
      detail: `the real checked-out commit (git rev-parse HEAD = "${gitHeadSha}") does not match the environment's own reported checkout SHA ("${githubSha}") - the CI context's claim about what's checked out disagrees with what git actually has checked out`,
    });
  }

  if (githubSha !== prHeadSha) {
    problems.push({
      reason: "sha-mismatch",
      detail: `the checked-out SHA ("${githubSha}") does not equal the PR's real head commit SHA ("${prHeadSha}") - this is exactly what checking out a pull_request event's synthetic merge ref (refs/pull/N/merge) looks like instead of the real PR head commit, or what a stale/since-force-pushed checkout looks like`,
    });
  }

  return { ok: problems.length === 0, problems };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ githubSha: string | undefined, prHeadSha: string | undefined }}
 */
export function readEnvShaParityInputs(env = process.env) {
  return {
    githubSha: env.GITHUB_SHA,
    // Deliberately its OWN env var, never re-derived from GITHUB_SHA - a
    // workflow step must explicitly wire
    // `${{ github.event.pull_request.head.sha }}` in here, which is the
    // one authoritative source for "what the PR's real head actually is",
    // independent of whatever `github.sha`/the checkout happens to be.
    prHeadSha: env.GHANTIKA_PR_HEAD_SHA,
  };
}

function main() {
  const { githubSha, prHeadSha } = readEnvShaParityInputs();
  if (!githubSha || !prHeadSha) {
    console.error(
      "check-sha-parity: requires both GITHUB_SHA and GHANTIKA_PR_HEAD_SHA to be set (the latter wired from the workflow's own `${{ github.event.pull_request.head.sha }}` context value) - refusing to run with either missing, since a silently-skipped SHA-parity check is worse than an explicit failure. Both values come from a pull request's own event context, so this guard only has anything to check inside a CI leg running on one."
    );
    process.exitCode = 1;
    return;
  }
  const gitHeadSha = readGitHeadSha();
  const isDirty = isWorkingTreeDirty();
  const result = checkShaParity({ githubSha, gitHeadSha, prHeadSha, isDirty });
  if (!result.ok) {
    for (const problem of result.problems) {
      console.error(`check-sha-parity: [${problem.reason}] ${problem.detail}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `sha parity clean: github.sha == git HEAD == PR head (${githubSha}), working tree clean`
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
