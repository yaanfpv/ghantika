#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
// Overridable so a test can drive the real CLI end to end against a scratch
// copy of README.md - the same GHANTIKA_*_PATH override shape already used by
// scripts/check-polling-claim.mjs and scripts/check-coverage-floor.mjs.
export const README_PATH = process.env.GHANTIKA_README_PATH ?? path.join(REPO_ROOT, "README.md");

// This is the one claim shape that is architecturally wrong for this project
// no matter which wake route it names or whether that route has ever been
// observed delivering: the poll floor (status/output/tail) is always
// authoritative regardless, so a wake is an accelerator on top of it, never a
// replacement for it. "instead of X asking" / "instead of asking" states or
// implies the opposite - that polling is no longer necessary - which is a
// claim about this project's own design, not merely an unproven one. Unlike a
// bare "wakes"/"gets woken" claim (whose truth genuinely depends on which
// route it names and what has been observed for it - see
// docs/wake-support-matrix.md), this specific phrase is never true here,
// which is what makes it mechanically, unambiguously checkable.
const INSTEAD_OF_ASKING = /\binstead\s+of\s+(?:[a-z]+\s+){0,4}?ask(?:ing)?(?:\s+at\s+all)?\b/i;

// A pragmatic sentence splitter, identical in shape to
// scripts/check-polling-claim.mjs's: break after a period/exclamation/
// question mark followed by whitespace. Good enough to bound "the same
// sentence" for this check's purposes.
function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/);
}

/**
 * Finds every sentence asserting that a wake replaces the need to ask
 * (poll) - "instead of it having to ask", "instead of asking", "instead of
 * asking at all", "instead of having to ask". This is the defect class: the
 * poll floor is never replaced by any wake route in this project's design,
 * so no sentence may say or imply otherwise, regardless of which route it
 * names or what has been observed for that route.
 */
export function findWakeReplacesPollClaims(text) {
  const hits = [];
  for (const rawSentence of splitSentences(text)) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    const match = sentence.match(INSTEAD_OF_ASKING);
    if (match) {
      hits.push({ match: match[0], sentence });
    }
  }
  return hits;
}

function describeHit(hit) {
  return (
    `README.md claims "${hit.match}" in: "${hit.sentence}" - but ghantika's poll floor ` +
    `(status/output/tail, always authoritative for any initialized client with no ` +
    `wake-specific setup) is never replaced by a wake, on any route, whether or not that ` +
    `route has been observed delivering - a wake is strictly an accelerator on top of it.`
  );
}

export function checkReadme(readmeText) {
  return findWakeReplacesPollClaims(readmeText).map(describeHit);
}

function main() {
  const readme = readFileSync(README_PATH, "utf8");
  const messages = checkReadme(readme);
  if (messages.length > 0) {
    for (const message of messages) {
      console.error(message);
    }
    process.exitCode = 1;
    return;
  }
  console.log("README.md makes no claim that a wake replaces the need to poll.");
}

if (isMainModule(import.meta.url)) {
  main();
}
