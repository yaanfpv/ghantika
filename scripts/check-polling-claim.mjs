#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
// Overridable so a test can drive the real CLI end to end against a scratch
// copy of README.md - the same GHANTIKA_*_PATH override shape already used
// by scripts/check-coverage-floor.mjs for the identical reason.
export const README_PATH = process.env.GHANTIKA_README_PATH ?? path.join(REPO_ROOT, "README.md");

const CONFIGURATION_HEADING = /^## Configuration\s*$/m;
const NEXT_TOP_LEVEL_HEADING = /^## /m;

const UNIVERSAL_TOOL_QUANTIFIER =
  /\b(?:every|all|each)(?:\s+one\s+of\s+the|\s+of\s+the)?\s+(?:seven\s+)?tools?\b/i;
const WHOLE_TOOL_SURFACE = /\bwhole\s+(?:seven-)?tool\s+surface\b/i;
const POLL_WORD = /\bpoll(?:s|ing|ed)?\b/i;

export const ACCURATE_FLOOR = "`status`, `output`, and `tail`";

/**
 * Slices out the "## Configuration" section of a README-shaped document -
 * from just past that heading up to (not including) the next top-level "## "
 * heading, or the end of the text if there is none.
 */
export function extractConfigurationSection(readmeText) {
  const headingMatch = CONFIGURATION_HEADING.exec(readmeText);
  if (!headingMatch) {
    throw new Error('no "## Configuration" heading found to scope the check to');
  }
  const start = headingMatch.index + headingMatch[0].length;
  const rest = readmeText.slice(start);
  const nextMatch = NEXT_TOP_LEVEL_HEADING.exec(rest);
  const end = nextMatch ? start + nextMatch.index : readmeText.length;
  return readmeText.slice(start, end);
}

// A pragmatic sentence splitter: break after a period/exclamation/question
// mark that is followed by whitespace. Good enough for prose that carries no
// mid-sentence abbreviations in the guarded section - the point of splitting
// at all is only to keep proximity bounded to "the same sentence", not to
// build a general-purpose tokenizer.
function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/);
}

/**
 * Finds every sentence in `text` that asserts, with a universal quantifier,
 * that the whole tool surface (or "every"/"all"/"each" tool) answers by
 * polling. This is the defect class: the accurate claim names the actual
 * poll-based floor (status/output/tail) rather than generalizing across every
 * tool, and follow is a bounded wait rather than a polling endpoint at all.
 */
export function findUniversalPollingClaims(text) {
  const hits = [];
  for (const rawSentence of splitSentences(text)) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    const universal =
      sentence.match(UNIVERSAL_TOOL_QUANTIFIER) ?? sentence.match(WHOLE_TOOL_SURFACE);
    if (universal && POLL_WORD.test(sentence)) {
      hits.push({ match: universal[0], sentence });
    }
  }
  return hits;
}

function describeHit(hit) {
  return (
    `README.md's Configuration section claims "${hit.match}" polls, universally, in: ` +
    `"${hit.sentence}" - but the actual poll-based retrieval floor is ${ACCURATE_FLOOR}; ` +
    `run, kill, and list are one-shot request-response operations, and follow is a ` +
    `client-independent bounded wait, never a polling endpoint.`
  );
}

export function checkSection(sectionText) {
  return findUniversalPollingClaims(sectionText).map(describeHit);
}

function main() {
  const readme = readFileSync(README_PATH, "utf8");
  const section = extractConfigurationSection(readme);
  const messages = checkSection(section);
  if (messages.length > 0) {
    for (const message of messages) {
      console.error(message);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    "README.md's Configuration section makes no universalized polling claim across the tool surface."
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
