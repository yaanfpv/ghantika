#!/usr/bin/env node
/**
 * scripts/dogfood-gh-run-checker.mjs - the real, concrete checker for a
 * manual run of scripts/dogfood-external-wake.mjs: one specific GitHub
 * Actions run of THIS repository reaching a terminal state, read through
 * the `gh` CLI. See local/dogfood/RUNBOOK.md for how to point a real run
 * id at this.
 *
 * Why this state class, and not something already covered: nothing in
 * this codebase, or in this repository's own tracked configuration,
 * already tells a seat when a GitHub Actions run of this repo reaches a
 * terminal state - every wake this codebase ships today fires on a job
 * ghantika itself started and is tracking in its own job store (a
 * process this server spawned), never on something that happens entirely
 * outside ghantika's own process tree, triggered by something else
 * (a push, a PR, a scheduled workflow). See test/dogfood-external.test.ts
 * for the mechanical proof that no existing tracked source in this repo
 * already produces this signal.
 *
 * This is a single, synchronous check - it runs once, prints one line per
 * the checker contract in scripts/dogfood-external-wake.mjs's own header
 * comment, and exits. It is never itself a persistent watcher; repeatedly
 * invoking it IS the poll, and that repetition is scripts/dogfood-
 * external-wake.mjs's own job, not this file's.
 *
 * Usage: `node scripts/dogfood-gh-run-checker.mjs <run-id>`
 */
import { execFileSync } from "node:child_process";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: dogfood-gh-run-checker.mjs <run-id>");
  process.exit(2);
}

let raw;
try {
  raw = execFileSync(
    "gh",
    ["run", "view", runId, "--json", "status,conclusion,headBranch,url,displayTitle"],
    { encoding: "utf8" }
  );
} catch (error) {
  console.error(`gh run view failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  console.error(`gh run view produced unparseable JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// "completed" is gh's own terminal status for a run - queued/in_progress
// are the two non-terminal statuses it reports; see `gh run view --help`.
// A conclusion (success/failure/cancelled/...) is only meaningful once
// status is already "completed", so status alone is the terminal signal
// this checker acts on - the conclusion rides along in the payload for
// whoever reads the eventual wake message, uninterpreted here.
if (parsed.status === "completed") {
  process.stdout.write(`EXTERNAL_STATE_TERMINAL:${JSON.stringify(parsed)}\n`);
} else {
  process.stdout.write("EXTERNAL_STATE_PENDING\n");
}
