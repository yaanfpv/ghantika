import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACCURATE_FLOOR,
  README_PATH,
  checkSection,
  extractConfigurationSection,
  findUniversalPollingClaims,
} from "../scripts/check-polling-claim.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/check-polling-claim.mjs", import.meta.url));

// The exact defect this guard exists to catch, verbatim from the commit that
// removed it (f954524) - the closing sentence of the Configuration section's
// auto-background-wake subsection.
const SHIPPED_DEFECT_SENTENCE =
  "None of this is required for ghantika to work: every tool answers by polling on every client " +
  "regardless, and this wake is strictly an upgrade on top of that same poll floor, never a " +
  "replacement for it.";

// The corrected replacement, also verbatim from that same commit - this is
// what actually ships in README.md today.
const CORRECTED_SENTENCE =
  "None of this is required for ghantika to work: `status`, `output`, and `tail` remain the " +
  "retrieval floor for any job id, retrievable by polling on every client with no configuration " +
  "needed. `follow` stays available as a client-independent bounded wait on that same floor - " +
  "the very tool this document tells you to reach for instead of polling - and needs neither " +
  "variable set to work. `run`, `kill`, and `list` are ordinary request-response operations, " +
  "never polling endpoints in the first place. This wake is strictly an upgrade on top of that " +
  "floor, never a replacement for it.";

// README.md's own true workflow statement, near the top of the file (well
// outside the Configuration section this guard scopes to) - a claim about
// what a CLIENT can do end to end, not that each tool is a polling endpoint.
const WORKFLOW_STATEMENT =
  "It's a standard [MCP](https://modelcontextprotocol.io) server over stdio, so every client " +
  "that speaks MCP can start jobs and read them back with the same seven tools, by polling.";

test("mutation control: the exact shipped defect is caught, naming the offending phrase", () => {
  const hits = findUniversalPollingClaims(SHIPPED_DEFECT_SENTENCE);
  assert.equal(hits.length, 1, `expected exactly one hit, got: ${JSON.stringify(hits)}`);
  assert.equal(hits[0].match, "every tool");
  assert.equal(hits[0].sentence, SHIPPED_DEFECT_SENTENCE);
});

test("mutation control: the diagnostic names both the offending phrase and the accurate floor", () => {
  const messages = checkSection(SHIPPED_DEFECT_SENTENCE);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /"every tool"/);
  assert.ok(
    messages[0].includes(ACCURATE_FLOOR),
    `diagnostic must name the accurate floor (${ACCURATE_FLOOR}), got: ${messages[0]}`
  );
});

test("green control: the corrected replacement text (what actually ships) is clean", () => {
  assert.deepEqual(findUniversalPollingClaims(CORRECTED_SENTENCE), []);
});

test("green control (AC2 - preserves follow as a bounded wait): the corrected text still names follow as available and non-polling, and the guard does not choke on that sentence either", () => {
  const followSentence =
    "`follow` stays available as a client-independent bounded wait on that same floor - the " +
    "very tool this document tells you to reach for instead of polling - and needs neither " +
    "variable set to work.";
  assert.deepEqual(findUniversalPollingClaims(followSentence), []);
});

test("green control (AC3): README's own true workflow statement - a client capability claim, not a per-tool polling claim - is never flagged", () => {
  assert.deepEqual(findUniversalPollingClaims(WORKFLOW_STATEMENT), []);
});

test("mutation control: the 'whole tool surface' phrasing (the defect class's other wording) is caught the same way", () => {
  const hits = findUniversalPollingClaims(
    "There's nothing more to configure - polling is how the whole seven-tool surface answers, " +
      "always."
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].match, "whole seven-tool surface");
});

test("mutation control: 'all tools' is caught the same way as 'every tool'", () => {
  const hits = findUniversalPollingClaims("All tools poll; there is no other path.");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].match, "All tools");
});

test("mutation control: 'each tool' is caught the same way", () => {
  const hits = findUniversalPollingClaims("Each tool answers by polling, without exception.");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].match, "Each tool");
});

test("mutation control: 'every one of the tools' is caught", () => {
  const hits = findUniversalPollingClaims("Every one of the tools polls for its result.");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].match, "Every one of the tools");
});

test("green control: 'all take' (a schema-shape sentence, not a polling claim) is never flagged - it has no poll word in the same sentence", () => {
  const hits = findUniversalPollingClaims(
    "`status`, `output`, `tail`, and `follow` all take `job_id`."
  );
  assert.deepEqual(hits, []);
});

test("green control: a sentence mentioning both 'every client' and polling, with no per-tool quantifier, is never flagged - the quantifier must attach to tool(s), not client(s)", () => {
  const hits = findUniversalPollingClaims(
    "Every client reads the same jobs the same way, and the job runs regardless, by polling."
  );
  assert.deepEqual(hits, []);
});

test("green control: cross-sentence proximity does not falsely join an unrelated quantifier to an unrelated poll word", () => {
  const hits = findUniversalPollingClaims(
    "Every tool has its own input schema. Polling is unrelated to this sentence entirely."
  );
  assert.deepEqual(hits, [], "the sentence split must keep the two clauses from being conflated");
});

test("green control (AC4 - a CHANGELOG-shaped entry describing the correction): the raw DETECTOR still fires on quoted defect text (documenting why production scope matters), but the guard's real scan surface never reaches CHANGELOG.md at all", () => {
  const changelogEntry =
    "Fixed: the Configuration section previously claimed every tool answers by polling on every " +
    "client regardless, which was false about the shipped surface. It now names the actual floor " +
    "precisely.";
  // The bare detector, given this text directly, still flags the quoted
  // defect - this is exactly the false-positive AC4 warns about, and it is
  // why the real check below never scans CHANGELOG.md in the first place.
  assert.equal(
    findUniversalPollingClaims(changelogEntry).length,
    1,
    "sanity: the raw detector does fire on prose that quotes the defect - proving scope, not the detector, is what protects a CHANGELOG entry"
  );
});

test("extractConfigurationSection slices from just past the heading to the next top-level heading", () => {
  const doc = [
    "## Using it",
    "",
    "irrelevant prose here",
    "",
    "## Configuration",
    "",
    "configuration prose line one",
    "configuration prose line two",
    "",
    "## Roadmap",
    "",
    "roadmap prose",
    "",
  ].join("\n");
  const section = extractConfigurationSection(doc);
  assert.ok(section.includes("configuration prose line one"));
  assert.ok(section.includes("configuration prose line two"));
  assert.ok(!section.includes("irrelevant prose here"));
  assert.ok(!section.includes("roadmap prose"));
});

test("extractConfigurationSection runs to the end of the document when Configuration is the last section", () => {
  const doc = ["## Configuration", "", "only section content", ""].join("\n");
  const section = extractConfigurationSection(doc);
  assert.ok(section.includes("only section content"));
});

test("extractConfigurationSection throws when the document has no Configuration heading at all - fails closed, never silently scans nothing", () => {
  assert.throws(() => extractConfigurationSection("## Something Else\n\nprose\n"), /Configuration/);
});

test("green control (AC3, at the scope level): README:15's workflow statement lives outside the Configuration section and is never even part of the scanned text", () => {
  const readme = readFileSync(README_PATH, "utf8");
  assert.ok(
    readme.includes(WORKFLOW_STATEMENT),
    "sanity: the real README.md must still contain this exact workflow sentence"
  );
  const section = extractConfigurationSection(readme);
  assert.ok(
    !section.includes(WORKFLOW_STATEMENT),
    "the workflow statement must fall outside the Configuration section's scanned text"
  );
});

test("green control: the real, current README.md's Configuration section makes no universalized polling claim", () => {
  const readme = readFileSync(README_PATH, "utf8");
  const section = extractConfigurationSection(readme);
  const messages = checkSection(section);
  assert.deepEqual(
    messages,
    [],
    `the real README.md's Configuration section must be clean, got: ${JSON.stringify(messages)}`
  );
});

// --- AC5: negative control, observed to red then reverted - drives the real
// CLI end to end via GHANTIKA_README_PATH, against a scratch copy of the real
// README.md with the exact shipped defect planted back in. ---

function runCliAgainst(readmeContent) {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-polling-claim-guard-"));
  try {
    const readmePath = path.join(dir, "README.md");
    writeFileSync(readmePath, readmeContent);
    try {
      const output = execFileSync(process.execPath, [SCRIPT_PATH], {
        env: { ...process.env, GHANTIKA_README_PATH: readmePath },
        encoding: "utf8",
      });
      return { status: 0, output };
    } catch (err) {
      return {
        status: typeof err.status === "number" ? err.status : 1,
        output: (err.stdout ?? "") + (err.stderr ?? ""),
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("negative control, observed not asserted: planting the exact shipped defect into a scratch copy of the real README makes the real CLI red, naming the phrase and the accurate floor; restoring makes it green again", () => {
  const realReadme = readFileSync(README_PATH, "utf8");
  assert.ok(
    realReadme.includes(CORRECTED_SENTENCE),
    "sanity: the real README.md must currently contain the corrected sentence"
  );

  // Plant: swap the corrected sentence back to the exact historical defect.
  const mutated = realReadme.replace(CORRECTED_SENTENCE, SHIPPED_DEFECT_SENTENCE);
  assert.notEqual(mutated, realReadme, "the replace must have actually matched something");

  const redResult = runCliAgainst(mutated);
  assert.equal(
    redResult.status,
    1,
    `expected the planted defect to red; output: ${redResult.output}`
  );
  assert.match(redResult.output, /"every tool"/);
  assert.ok(
    redResult.output.includes(ACCURATE_FLOOR),
    `red output must name the accurate floor; got: ${redResult.output}`
  );

  // Restore: the untouched real README.md content.
  const greenResult = runCliAgainst(realReadme);
  assert.equal(
    greenResult.status,
    0,
    `expected the restored real README.md to pass; output: ${greenResult.output}`
  );
});

test("the real CLI, run with no override, checks the repo's own README.md and passes", () => {
  const result = execFileSync(process.execPath, [SCRIPT_PATH], { encoding: "utf8" });
  assert.match(result, /makes no universalized polling claim/);
});

test("mutation control: the real CLI exits 1 and prints a violation when GHANTIKA_README_PATH points at a fixture carrying the defect, distinct from the default-path green run above", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-polling-claim-cli-"));
  try {
    const readmePath = path.join(dir, "README.md");
    writeFileSync(readmePath, ["## Configuration", "", SHIPPED_DEFECT_SENTENCE, ""].join("\n"));
    let status = null;
    let output = "";
    try {
      output = execFileSync(process.execPath, [SCRIPT_PATH], {
        env: { ...process.env, GHANTIKA_README_PATH: readmePath },
        encoding: "utf8",
      });
      status = 0;
    } catch (err) {
      status = err.status ?? null;
      output = (err.stdout ?? "") + (err.stderr ?? "");
    }
    assert.equal(status, 1);
    assert.match(output, /"every tool"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
