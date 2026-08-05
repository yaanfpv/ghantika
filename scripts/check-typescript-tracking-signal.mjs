#!/usr/bin/env node
/**
 * Guards one narrow invariant left over from this repo's `typescript`
 * peer-range pin decision: `.github/dependabot.yml` carries no "ignore"
 * rule that would silence Dependabot's ability to propose a newer
 * `typescript` version.
 *
 * This file used to also track a specific pull request's open/closed
 * state on the live forge (Dependabot's own PR #1, proposing a bump past
 * the range `typescript-eslint` declares). That half is gone, and it is
 * worth recording why rather than leaving a silent gap where a check used
 * to be.
 *
 * `typescript-eslint`'s declared peer range still excludes TypeScript
 * past 6.1 - moving this project onto TypeScript 7 (via the side-by-side
 * `@typescript/native` alias; see scripts/check-typescript-peer-range.mjs)
 * ROUTES AROUND that constraint, it does not satisfy it. The moment that
 * alias landed, Dependabot recognized - correctly, on its own - that the
 * `typescript` bump PR #1 had been proposing was no longer something it
 * needed to keep open, and closed it. Nothing here was silenced or
 * mishandled: an open PR tied to one specific number is simply a fragile
 * way to track an ongoing constraint, because the PR can legitimately
 * close for a reason that has nothing to do with the constraint itself
 * resolving - which is exactly what happened. Reopening a correctly-closed
 * PR to make a check pass again would hide that gap instead of fixing it,
 * so this file no longer tries.
 *
 * The genuinely open question - has `typescript-eslint` widened its
 * declared peer range enough that the `typescript` alias can be dropped -
 * is already tracked, automatically, by test/typescript-peer-range.test.ts:
 * one of its own assertions compares the real, currently-installed peer
 * range against a hardcoded literal, so a future widening shows up there
 * as a failing diff the moment `npm test` next runs against it (see that
 * script's own header comment for why its pass/fail logic deliberately
 * reads the live range instead of hardcoding one, and its companion
 * test's own header comment for why the hardcoded literal lives there
 * instead). That mechanism needs no live forge read, no `gh` CLI, and no
 * standing pull request to stay open - it already runs on every `npm
 * test` invocation, which means every CI run, with nothing further to
 * maintain here.
 *
 * What is still worth guarding on its own, independent of any of that, is
 * that nobody quietly tells Dependabot to stop proposing `typescript`
 * bumps at all. Dependabot remains the mechanism that will eventually
 * open a PR proposing a real (non-aliased) newer `typescript` once the
 * peer-range constraint actually lifts, and an "ignore" rule for it in
 * `.github/dependabot.yml` would suppress that proposal permanently and
 * silently - the file would look identical to a clean one, and nothing
 * would ever again prompt a look at whether the pin can be revisited.
 *
 *   - checkDependabotHasNoTypescriptIgnore(text) - a pure parse of
 *     already-read YAML text. No filesystem, no network.
 *
 * Run with:
 *
 *   npm run guard:typescript-tracking-signal
 *
 * This check reads only a tracked file already on disk, so unlike the
 * live-forge read it replaced, it needs no network access and no
 * credentials, and its own companion test exercises the same pure
 * function directly.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { load as loadYaml } from "js-yaml";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

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
          `.github/dependabot.yml has an "ignore" rule ("dependency-name": "${pattern}") in its "${update["package-ecosystem"] ?? "?"}" update block that matches "${TRACKED_DEPENDENCY_NAME}" - this would silence Dependabot's ability to ever propose a newer typescript once typescript-eslint's peer range widens enough to allow one`
        );
      }
    }
  }

  return { ok: problems.length === 0, problems };
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

  const result = checkDependabotHasNoTypescriptIgnore(dependabotYamlText);
  if (!result.ok) {
    console.error("check-typescript-tracking-signal: problem(s) found:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `typescript tracking signal intact: .github/dependabot.yml carries no ignore rule matching "${TRACKED_DEPENDENCY_NAME}"`
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
