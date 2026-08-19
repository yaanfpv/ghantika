import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  README_PATH,
  checkReadme,
  findWakeReplacesPollClaims,
} from "../scripts/check-wake-claim.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/check-wake-claim.mjs", import.meta.url));

// Three real sentences this repo actually shipped, taken verbatim from the
// EC4 public-claim audit (local/qa-evidence/reviews/2026-08-15-sprint-3b-ec4-
// public-claim-audit-e443639.md, V10/V11/V12) - not invented text. The
// condition on this guard was explicit: a checker whose self-test and
// negative control both pass while the predicate is wrong on every real hit
// is worse than useless, so the negative control below plants one of these
// exact historical violations rather than a synthetic stand-in.
const V10 =
  "On a Tasks-capable connection, ghantika also rings directly the moment the job produces " +
  "output, instead of the agent having to ask";
const V11 =
  "a client declaring the Tasks extension URI (see above) gets rung as new output arrives " +
  "on either stream instead of having to ask";
const V12 =
  "The pattern is: start it, do something else, check in by asking whenever it's actually " +
  "relevant - or, on a Tasks-capable connection, let ghantika ring you directly instead of " +
  "asking at all.";

test("mutation control: V10 (shipped, README.md line 39 before the fix) is caught", () => {
  const hits = findWakeReplacesPollClaims(V10);
  assert.equal(hits.length, 1, `expected exactly one hit, got: ${JSON.stringify(hits)}`);
  assert.equal(hits[0].match, "instead of the agent having to ask");
});

test("mutation control: V11 (shipped, README.md line 194 before the fix) is caught", () => {
  const hits = findWakeReplacesPollClaims(V11);
  assert.equal(hits.length, 1, `expected exactly one hit, got: ${JSON.stringify(hits)}`);
  assert.equal(hits[0].match, "instead of having to ask");
});

test("mutation control: V12 (shipped, README.md line 184 before the fix) is caught, and the unrelated 'asking' earlier in the same sentence does not cause a double-count or a wrong match", () => {
  const hits = findWakeReplacesPollClaims(V12);
  assert.equal(hits.length, 1, `expected exactly one hit, got: ${JSON.stringify(hits)}`);
  assert.equal(hits[0].match, "instead of asking at all");
});

test("mutation control: the diagnostic names the offending phrase and states the poll floor is never replaced", () => {
  const messages = checkReadme(V10);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /"instead of the agent having to ask"/);
  assert.match(messages[0], /never replaced by a wake/);
});

test("mutation control: a bare 'instead of X asking' with a different filler phrase in between is still caught", () => {
  const hits = findWakeReplacesPollClaims(
    "Every job finishes and ghantika rings you, instead of your agent having to ask."
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].match, "instead of your agent having to ask");
});

test("green control: 'ghantika sends' with no consequence clause - the corrected form actually shipped for V10's site - is never flagged", () => {
  const corrected =
    "On a Tasks-capable connection, ghantika also rings directly the moment the job produces " +
    "output - the poll floor sits underneath it unchanged either way.";
  assert.deepEqual(findWakeReplacesPollClaims(corrected), []);
});

test("green control: 'gets rung' with no consequence clause - the corrected form actually shipped for V11's site - is never flagged", () => {
  const corrected =
    "a client declaring the Tasks extension URI (see above) gets rung as new output arrives " +
    "on either stream.";
  assert.deepEqual(findWakeReplacesPollClaims(corrected), []);
});

test("green control: an unrelated use of 'ask' with no 'instead of' nearby is never flagged", () => {
  const hits = findWakeReplacesPollClaims(
    "check in by asking whenever it's actually relevant, the same way you always could."
  );
  assert.deepEqual(hits, []);
});

test("green control: 'instead of' with no 'ask' anywhere near it is never flagged", () => {
  const hits = findWakeReplacesPollClaims(
    "It queues the job instead of rejecting it outright, and starts it once a slot frees up."
  );
  assert.deepEqual(hits, []);
});

test("green control: a claim that a specific, observed-worked route wakes something (app-server transport, per the wake support matrix) is out of this guard's scope and never flagged - only the 'instead of asking' shape is checked, since whether a bare 'wakes' claim is true depends on which route it names and cannot be decided by text alone", () => {
  const hits = findWakeReplacesPollClaims(
    "One wakes an idle Codex thread by spawning `codex app-server` and driving its documented JSON-RPC protocol."
  );
  assert.deepEqual(hits, []);
});

test("green control: the real, current README.md makes no wake-replaces-poll claim", () => {
  const readme = readFileSync(README_PATH, "utf8");
  const messages = checkReadme(readme);
  assert.deepEqual(
    messages,
    [],
    `the real README.md must be clean, got: ${JSON.stringify(messages)}`
  );
});

// --- Negative control: observed to red then reverted, driving the real CLI
// end to end via GHANTIKA_README_PATH against a scratch copy of the real,
// current README.md with one shipped historical violation planted back in
// verbatim. ---

function runCliAgainst(readmeContent) {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-wake-claim-guard-"));
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

test("negative control, observed not asserted: planting V12 verbatim into a scratch copy of the real README makes the real CLI red, naming the exact shipped phrase; restoring makes it green again", () => {
  const realReadme = readFileSync(README_PATH, "utf8");
  assert.ok(
    !realReadme.includes("instead of asking at all"),
    "sanity: the real README.md must not currently contain V12's phrase"
  );

  // Plant: append V12's exact shipped sentence into a scratch copy of the
  // real README - a real historical violation, not an invented one.
  const mutated = `${realReadme}\n\n${V12}\n`;

  const redResult = runCliAgainst(mutated);
  assert.equal(
    redResult.status,
    1,
    `expected the planted V12 sentence to red; output: ${redResult.output}`
  );
  assert.match(redResult.output, /"instead of asking at all"/);
  assert.match(redResult.output, /never replaced by a wake/);

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
  assert.match(result, /makes no claim that a wake replaces the need to poll/);
});

test("mutation control: the real CLI exits 1 and prints a violation when GHANTIKA_README_PATH points at a fixture carrying V11's exact shipped phrase, distinct from the default-path green run above", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-wake-claim-cli-"));
  try {
    const readmePath = path.join(dir, "README.md");
    writeFileSync(readmePath, `${V11}\n`);
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
    assert.match(output, /"instead of having to ask"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
