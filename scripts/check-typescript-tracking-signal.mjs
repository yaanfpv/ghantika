#!/usr/bin/env node
/**
 * Guards the OTHER half of the typescript peer-range decision: an open,
 * unmerged Dependabot pull request proposing a later typescript version
 * (one that lands outside typescript-eslint's declared peer range) is
 * deliberately left OPEN as a visible tracking signal.
 *
 * What it signals changed the moment this repo adopted the side-by-side
 * TypeScript 7 layout (see scripts/check-typescript-peer-range.mjs):
 * typescript-eslint's peer range still excludes TypeScript past 6.1, and
 * that constraint has not moved - the side-by-side aliasing ROUTES AROUND
 * it (typecheck/build run on a real TypeScript 7, while the plain
 * `typescript` import typescript-eslint resolves still lands on a 6.x
 * shim), it does not satisfy it. So this PR is no longer tracking "may we
 * take the bump" - it is tracking "has typescript-eslint's peer range
 * widened enough that the alias can be REMOVED and `typescript` can go
 * back to being one real package again." It fires (turns red) the day
 * this PR closes, is superseded, or dependabot.yml gains an "ignore" rule
 * for typescript - any of which would destroy the only signal watching
 * for that release. Silencing this PR with a Dependabot "ignore" rule
 * would hide the constraint instead of tracking it, so this guard checks
 * two things together:
 *
 *   1. .github/dependabot.yml carries no "ignore" rule matching
 *      "typescript" in any update block.
 *   2. the tracking pull request is actually OPEN on the real forge right
 *      now.
 *
 * Neither fact alone is sufficient proof the tracking signal is intact:
 * absence of an ignore rule is necessary but not sufficient, because a PR
 * that was closed (accidentally, or by someone cleaning up "stale" PRs)
 * with no ignore rule present looks byte-for-byte identical, ON DISK, to
 * an open PR with no ignore rule - the dependabot.yml file does not
 * change either way. The PR's open/closed state exists only on the forge,
 * never in this repo's own working tree, so checking it requires an
 * actual live read.
 *
 * Two layers, mirroring scripts/check-sha-parity.mjs's own split between a
 * pure comparison and the live inputs that feed it:
 *
 *   - checkDependabotHasNoTypescriptIgnore(text) - a pure parse of
 *     already-read YAML text. No filesystem, no network.
 *   - checkTrackingSignal({ prState, dependabotCheck }) - the pure
 *     combination of both facts. No filesystem, no network.
 *   - fetchLivePrState(...) - the one function in this file that touches
 *     the network (via the `gh` CLI, the same tool this repo's own
 *     maintainer already uses interactively). NEVER imported by any
 *     test/*.test.ts file - see test/actionlint-pin.test.js's own header
 *     comment for why this repo's automated suite never makes a real
 *     network call ("a fake curl, so nothing ever touches the network").
 *     Its OWN parsing/error-handling logic is proven in
 *     test/typescript-tracking-signal.test.ts with an INJECTED fake
 *     command runner instead, the same "inject the real side-effecting
 *     call" shape check-sha-parity.mjs's own readGitHeadSha/
 *     isWorkingTreeDirty use (there tested against a real scratch git
 *     repo instead of the real network, since git itself is local and
 *     network access is not).
 *
 * This script is intentionally NOT wired into `npm test`, for the exact
 * reason scripts/check-sha-parity.mjs is not (see that file's own header
 * comment): it needs live network access and real GitHub read
 * credentials, neither of which a hermetic local test run should ever
 * depend on. Run it standalone, wherever the `gh` CLI is authenticated:
 *
 *   npm run guard:typescript-tracking-signal
 *
 * On a forge-unreachable environment (no network, no `gh` binary on PATH,
 * no credentials) this reports a clear, named diagnostic and exits 1,
 * rather than a raw stack trace or - worse - a silent pass. A
 * silently-skipped check here would be indistinguishable from "verified
 * clean", which is exactly the vacuous-verification failure this repo's
 * other guards (see check-sha-parity.mjs's own header comment) already
 * refuse to produce.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { load as loadYaml } from "js-yaml";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The specific pull request this guard tracks - see this file's header comment. */
export const TRACKED_PR_REPO_SLUG = "yaanfpv/ghantika";
export const TRACKED_PR_NUMBER = 1;
/** The specific dependency name whose Dependabot ignore rule this guard forbids. */
export const TRACKED_DEPENDENCY_NAME = "typescript";

// ---------------------------------------------------------------------------
// checkDependabotHasNoTypescriptIgnore - a pure parse of already-read YAML
// text. Dependabot's own "ignore"."dependency-name" syntax supports a `*`
// wildcard (e.g. "typescript*" or "@typescript-eslint/*"), so a plain
// string-equality check would miss a glob rule that still matches
// "typescript" - dependabotNamePatternMatches below implements that glob
// semantics narrowly (only `*`, nothing else Dependabot's own docs don't
// define).
// ---------------------------------------------------------------------------

/**
 * @param {string} pattern - a Dependabot "dependency-name" glob pattern.
 * @param {string} name - the concrete dependency name to test.
 * @returns {boolean}
 */
export function dependabotNamePatternMatches(pattern, name) {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- every regex metacharacter in `pattern` is escaped above before reaching this constructor; the only unescaped construct that can appear in `escaped` is a bare `.*` substituted for `*`, which has no nested or overlapping quantifiers and cannot exhibit catastrophic backtracking.
  return new RegExp(`^${escaped}$`, "i").test(name);
}

/**
 * @param {string} dependabotYamlText
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkDependabotHasNoTypescriptIgnore(dependabotYamlText) {
  const problems = [];
  const doc = loadYaml(dependabotYamlText);
  const updates = Array.isArray(doc?.updates) ? doc.updates : [];

  for (const update of updates) {
    const ignoreRules = Array.isArray(update?.ignore) ? update.ignore : [];
    for (const rule of ignoreRules) {
      const pattern = rule?.["dependency-name"];
      if (typeof pattern !== "string") continue;
      if (dependabotNamePatternMatches(pattern, TRACKED_DEPENDENCY_NAME)) {
        problems.push(
          `.github/dependabot.yml has an "ignore" rule ("dependency-name": "${pattern}") in its "${update["package-ecosystem"] ?? "?"}" update block that matches "${TRACKED_DEPENDENCY_NAME}" - this would silence the open tracking pull request, which the pin decision requires to stay visible`
        );
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// checkTrackingSignal - the pure combination of the two facts. Neither
// input is fetched here; both are handed in already-resolved, so this
// function itself needs no filesystem or network access and is directly
// unit-testable with synthetic values.
// ---------------------------------------------------------------------------

/**
 * @param {{ prState: string, dependabotCheck: { ok: boolean, problems: string[] } }} args
 *   `prState` is compared case-insensitively - GitHub's GraphQL-flavoured
 *   reads (e.g. `gh pr view --json state`) return "OPEN"/"CLOSED", while
 *   the plain REST API returns "open"/"closed"; this guard does not care
 *   which casing its caller's read happened to use.
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkTrackingSignal({ prState, dependabotCheck }) {
  const problems = [...dependabotCheck.problems];
  if (prState.toUpperCase() !== "OPEN") {
    problems.push(
      `${TRACKED_PR_REPO_SLUG}#${TRACKED_PR_NUMBER} is not open (live state: "${prState}") - the pin decision requires it to stay open as the visible tracking signal for when typescript-eslint's peer range widens`
    );
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// fetchLivePrState - the one real, network-touching read in this file.
// `run` is injectable so its own parsing/error-handling can be proven
// against a synthetic command runner (test/typescript-tracking-signal.test.ts)
// without ever invoking the real `gh` binary.
// ---------------------------------------------------------------------------

/**
 * @param {string[]} args
 * @returns {string}
 */
function runGh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

/**
 * Fetches the tracked pull request's live state from the real forge via
 * the `gh` CLI. Never called from any test/*.test.ts file - see this
 * file's header comment. Throws a single, clearly-labelled Error rather
 * than letting a raw ENOENT (`gh` not installed), a raw network failure,
 * or a JSON.parse SyntaxError propagate unlabelled, so a caller can
 * report "could not reach the forge" as a distinct, actionable diagnostic
 * instead of a bare stack trace.
 *
 * @param {{ repoSlug?: string, prNumber?: number, run?: (args: string[]) => string }} [options]
 * @returns {{ state: string }}
 */
export function fetchLivePrState({
  repoSlug = TRACKED_PR_REPO_SLUG,
  prNumber = TRACKED_PR_NUMBER,
  run = runGh,
} = {}) {
  let raw;
  try {
    raw = run(["pr", "view", String(prNumber), "--repo", repoSlug, "--json", "state"]);
  } catch (err) {
    throw new Error(
      `could not reach the forge to read ${repoSlug}#${prNumber}'s live state via the "gh" CLI (no network, "gh" not installed or not authenticated, or no read access): ${err.message}`,
      { cause: err }
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `"gh pr view ${prNumber} --repo ${repoSlug} --json state" did not return parseable JSON: ${err.message} (raw output: ${JSON.stringify(raw)})`,
      { cause: err }
    );
  }

  if (typeof parsed?.state !== "string") {
    throw new Error(
      `"gh pr view ${prNumber} --repo ${repoSlug} --json state" returned no usable "state" string field (raw output: ${JSON.stringify(raw)})`
    );
  }

  return { state: parsed.state };
}

function main() {
  const dependabotPath = path.join(REPO_ROOT, ".github", "dependabot.yml");
  let dependabotYamlText;
  try {
    dependabotYamlText = readFileSync(dependabotPath, "utf8");
  } catch (err) {
    console.error(
      `check-typescript-tracking-signal: could not read ${dependabotPath}: ${err.message}`
    );
    process.exitCode = 1;
    return;
  }

  const dependabotCheck = checkDependabotHasNoTypescriptIgnore(dependabotYamlText);

  let prState;
  try {
    ({ state: prState } = fetchLivePrState());
  } catch (err) {
    console.error(
      `check-typescript-tracking-signal: ${err.message} - this check needs live forge access and cannot verify the tracking-signal invariant without it`
    );
    process.exitCode = 1;
    return;
  }

  const result = checkTrackingSignal({ prState, dependabotCheck });
  if (!result.ok) {
    console.error("check-typescript-tracking-signal: problem(s) found:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `typescript tracking signal intact: ${TRACKED_PR_REPO_SLUG}#${TRACKED_PR_NUMBER} is open, and .github/dependabot.yml carries no ignore rule matching "${TRACKED_DEPENDENCY_NAME}"`
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
