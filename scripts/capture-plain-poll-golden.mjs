#!/usr/bin/env node
/**
 * Deliberate, MANUALLY-INVOKED tool that regenerates
 * test/fixtures/plain-poll-golden.json - the frozen, byte-identical golden
 * test/wake-integration.test.ts compares every plain (non-Tasks-capable)
 * connection's tool response against, under canonical projection. See that
 * file's own golden-provenance doc comment (immediately above where it
 * loads the golden) for the full story of which commit a given regenerated
 * fixture was captured from, and why that commit was chosen.
 *
 * NEVER wired into `npm test`, `npm run coverage`, any `guard:*` check, or
 * any CI workflow, and never invoked by any of them - run this by hand, on
 * purpose, only when a genuine tool-surface or response-shape change means
 * the golden itself must legitimately move.
 * A golden that silently re-baselines itself against whatever the code
 * currently emits asserts nothing at all - it would always agree with
 * itself. This script exists to make a regeneration a deliberate, STATED
 * act instead: it prints exactly what it captured and from which commit
 * (see main() below), and the accompanying source-code change (this
 * script's own commit, test/wake-integration.test.ts's updated provenance
 * comment, and the regenerated fixture itself) is what actually records
 * the decision for anyone reading history later.
 *
 * Speaks REAL, raw JSON-RPC over a REAL spawned server's real
 * stdin/stdout - the same test/harness.ts/test/helpers/spawnServer.ts
 * machinery every spawned-real-child test in this repo already uses (see
 * spawnServer.ts's own header for why this and the in-process
 * `InMemoryTransport` the live comparison test itself uses are
 * DELIBERATELY different transports) - to a PLAIN (non-Tasks-capable)
 * connection: completeHandshake sends a bare `capabilities: {}` and never
 * declares the Tasks extension.
 *
 * Drives the identical scenarios test/wake-integration.test.ts's own
 * runPlainPollScenarios drives: the same commands, labels, and arguments
 * for the six pre-existing tools (list/run/status/output/tail/kill), so
 * those six golden values never shift for no reason, plus a seventh
 * `follow` scenario (see captureFollow below) built to genuinely exercise
 * a bounded, non-instant wait rather than an already-satisfied immediate
 * return. Every result is canonicalized with the SAME
 * canonicalizePlainPollResponse/toCanonicalResultPair functions that test
 * file imports from test/helpers/plainPollCanonicalization.ts - one
 * shared implementation on both the capture side and the comparison side,
 * never two copies that could quietly drift apart.
 *
 * Requires a fresh `dist/` build to spawn against - runs `npm run build`
 * itself, first, before spawning the server, so a captured golden always
 * reflects the exact source this script is run against rather than a
 * stale `dist/` left over from an earlier checkout (matching
 * `npm test`/`npm run coverage`'s own `npm run build && ...` convention -
 * see package.json).
 *
 * The regenerated file is re-formatted with this repo's own installed
 * prettier (`--write`, not merely `JSON.stringify`'s own output) so it
 * passes `npm run format:check` without a second, separate formatting
 * step.
 *
 * Usage: `node scripts/capture-plain-poll-golden.mjs <expected-base-revision>`.
 * The argument is required and is checked against the checkout's actual
 * `HEAD` BEFORE anything else runs (see requireExpectedBase below) -
 * stating and enforcing the intended base is what makes "deliberate,
 * STATED act" above a real property of a run rather than only of the
 * printed summary a run produces afterward.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  callTool,
  completeHandshake,
  requireStructuredContent,
  spawnServer,
} from "../test/harness.ts";
import {
  canonicalizePlainPollResponse,
  toCanonicalResultPair,
} from "../test/helpers/plainPollCanonicalization.ts";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GOLDEN_PATH = path.join(REPO_ROOT, "test", "fixtures", "plain-poll-golden.json");
const PRETTIER_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "prettier");

/**
 * The SAME command-policy allowlist scripts/run-tests.mjs's own
 * TEST_POLICY_ALLOW_PATH sets for every spawned test-file child process
 * (see that file's own doc comment on the constant) - `run()` denies
 * every command outright, fail-closed, when GHANTIKA_POLICY_FILE is unset
 * (src/policy.ts), so a spawned server with no policy configured cannot
 * execute `true`, `node -e ...`, or anything else this script's own
 * scenarios need: every one of them would settle straight to a
 * `policy-denied` failed state instead of the real running/exited/killed
 * states the golden actually needs to capture. Set on THIS script's own
 * process.env before spawnServer() is ever called, so the spawned child
 * inherits it the same way Node's child_process.spawn inherits the
 * parent's env by default whenever no explicit `env` option overrides it.
 */
const TEST_POLICY_ALLOW_PATH = path.join(REPO_ROOT, "test", "fixtures", "policy-allow.json");

/**
 * Every job this run mints carries this prefix - purely for readability
 * while debugging a capture run gone wrong. It has zero bearing on the
 * captured golden's own bytes: canonicalizePlainPollResponse masks every
 * `label` field to the stable `<LABEL>` token, exactly as it does for the
 * live comparison test's own scenario labels.
 */
const LABEL_PREFIX = "golden-capture";

/** The SAME idle, real, backing command test/wake-integration.test.ts's own IDLE_COMMAND uses - a real process that produces nothing on its own until killed. */
const IDLE_COMMAND = [process.execPath, "-e", "setTimeout(() => {}, 600000);"];

let nextRequestId = 1;
function nextId() {
  const value = nextRequestId;
  nextRequestId += 1;
  return value;
}

/** The SAME polling shape test/wake-integration.test.ts's own pollUntilTerminal uses, driven over raw JSON-RPC instead of the SDK Client. */
async function pollUntilTerminal(server, jobId, maxAttempts = 200) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const body = await callTool(server, nextId(), "status", { job_id: jobId });
    const structured = requireStructuredContent(
      body,
      `status(${jobId}) while polling for terminal`
    );
    if (
      structured.state === "exited" ||
      structured.state === "killed" ||
      structured.state === "failed"
    ) {
      return structured;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${jobId} never reached a terminal state within ${maxAttempts} polls`);
}

// ---------------------------------------------------------------------------
// Scenario captures - each one mirrors ONE block of
// test/wake-integration.test.ts's own runPlainPollScenarios, over raw
// JSON-RPC. The six pre-existing scenarios reproduce that function's exact
// commands/labels/arguments; the seventh (follow) is new, added by this
// same change.
// ---------------------------------------------------------------------------

async function captureList(server) {
  const listJobLabel = `${LABEL_PREFIX}-list-job`;
  const runBody = await callTool(server, nextId(), "run", {
    command: ["true"],
    label: listJobLabel,
  });
  const minted = requireStructuredContent(runBody, "run (list scenario mint)");
  const jobId = minted.job_id;
  await pollUntilTerminal(server, jobId);

  const listBody = await callTool(server, nextId(), "list", {});
  const structured = requireStructuredContent(listBody, "list");
  const allJobs = structured.jobs ?? [];
  const mine = allJobs.filter((entry) => entry.label === listJobLabel);
  if (mine.length !== 1) {
    throw new Error(
      `list scenario: expected exactly one list entry for ${listJobLabel}, got ${mine.length}`
    );
  }

  const listText = listBody.result?.content?.[0]?.text;
  if (typeof listText !== "string") {
    throw new Error("list scenario: expected list's content block to carry text");
  }
  const allJobsFromContent = JSON.parse(listText);
  const mineFromContent = allJobsFromContent.filter((entry) => entry.label === listJobLabel);
  if (mineFromContent.length !== 1) {
    throw new Error(
      `list scenario: expected exactly one list entry (from content) for ${listJobLabel}, got ${mineFromContent.length}`
    );
  }

  // Deliberately the SAME hand-built shape runPlainPollScenarios itself
  // returns for "list": ONLY `{jobs: mine}`, never the real
  // structuredContent's own `concurrency_cap` field alongside it - a
  // process-wide value with nothing scenario-specific to pin it to.
  return { structuredContent: { jobs: mine }, content: mineFromContent };
}

async function captureRun(server) {
  const body = await callTool(server, nextId(), "run", {
    command: ["true"],
    label: `${LABEL_PREFIX}-run-immediate`,
  });
  if (body.error) throw new Error(`run scenario: JSON-RPC error: ${JSON.stringify(body.error)}`);
  return toCanonicalResultPair(body.result);
}

async function captureStatus(server) {
  const runBody = await callTool(server, nextId(), "run", {
    command: ["true"],
    label: `${LABEL_PREFIX}-status-terminal`,
  });
  const minted = requireStructuredContent(runBody, "run (status scenario mint)");
  const jobId = minted.job_id;
  await pollUntilTerminal(server, jobId);

  // pollUntilTerminal's own return value exists to wait, not to capture -
  // a fresh direct call here is what actually captures this scenario's
  // own content+structuredContent pair, matching runPlainPollScenarios.
  const statusBody = await callTool(server, nextId(), "status", { job_id: jobId });
  if (statusBody.error) {
    throw new Error(`status scenario: JSON-RPC error: ${JSON.stringify(statusBody.error)}`);
  }
  return toCanonicalResultPair(statusBody.result);
}

async function captureOutputAndTail(server) {
  // stdout-only, deliberately - the SAME reasoning
  // runPlainPollScenarios's own output/tail scenario states: the
  // cross-stream MERGE order between stdout and stderr depends on real
  // OS-level pipe scheduling, genuinely non-deterministic across runs, so
  // a single-stream command keeps this scenario's seq/order assignment
  // reproducible.
  const runBody = await callTool(server, nextId(), "run", {
    command: [
      process.execPath,
      "-e",
      "process.stdout.write('golden-stdout-1\\n'); process.stdout.write('golden-stdout-2\\n'); process.stdout.write('golden-stdout-3\\n');",
    ],
    label: `${LABEL_PREFIX}-output-job`,
  });
  const minted = requireStructuredContent(runBody, "run (output/tail scenario mint)");
  const jobId = minted.job_id;
  await pollUntilTerminal(server, jobId);

  const outputBody = await callTool(server, nextId(), "output", { job_id: jobId, stream: "both" });
  if (outputBody.error) {
    throw new Error(`output scenario: JSON-RPC error: ${JSON.stringify(outputBody.error)}`);
  }
  const output = toCanonicalResultPair(outputBody.result);

  const tailBody = await callTool(server, nextId(), "tail", { job_id: jobId, lines: 5 });
  if (tailBody.error) {
    throw new Error(`tail scenario: JSON-RPC error: ${JSON.stringify(tailBody.error)}`);
  }
  const tail = toCanonicalResultPair(tailBody.result);

  return { output, tail };
}

async function captureKill(server) {
  const runBody = await callTool(server, nextId(), "run", {
    command: IDLE_COMMAND,
    label: `${LABEL_PREFIX}-kill-job`,
  });
  const minted = requireStructuredContent(runBody, "run (kill scenario mint)");
  const jobId = minted.job_id;

  const killBody = await callTool(server, nextId(), "kill", { job_id: jobId });
  if (killBody.error)
    throw new Error(`kill scenario: JSON-RPC error: ${JSON.stringify(killBody.error)}`);
  return toCanonicalResultPair(killBody.result);
}

/**
 * `follow` (the 7th tool) - the only plain tool that does not resolve
 * near-instantly, so this scenario is built to genuinely EXERCISE the
 * wait rather than return on an already-satisfied condition: an
 * immediate-return scenario would assert almost nothing about the one
 * thing that makes this tool different from the other six (see
 * test/follow.test.ts's own "already true at call time" tests for that
 * near-instant path, which this scenario deliberately does NOT take).
 *
 * The backing job writes its one line only after a real, short delay
 * (200ms) and then keeps running past it (a second, much longer timer) -
 * so `follow`, called immediately after minting and well before that
 * delayed write lands, is still genuinely SUBSCRIBED and WAITING when the
 * write happens, and the job's own `state` is deterministically still
 * "running" (never "exited") at the exact moment follow's response is
 * built. That is what keeps this scenario's captured shape reproducible
 * rather than racing the child's own natural exit against follow's own
 * wake - see test/wake-integration.test.ts's own matching comment on its
 * live copy of this scenario for the full reasoning.
 *
 * `timeout_ms: 5000` is a real, explicit bound - comfortably longer than
 * the 200ms write delay, and nowhere near the 45000ms default - so this
 * scenario is a genuine bounded wait that resolves on its own terms
 * (`reason: "output"`), never an accidental timeout.
 */
async function captureFollow(server) {
  const runBody = await callTool(server, nextId(), "run", {
    command: [
      process.execPath,
      "-e",
      "setTimeout(() => { process.stdout.write('golden-follow-line\\n'); }, 200); setTimeout(() => {}, 600000);",
    ],
    label: `${LABEL_PREFIX}-follow-job`,
  });
  const minted = requireStructuredContent(runBody, "run (follow scenario mint)");
  const jobId = minted.job_id;

  const followBody = await callTool(
    server,
    nextId(),
    "follow",
    { job_id: jobId, timeout_ms: 5000 },
    // A generous timeout on the WIRE round trip itself (independent of
    // follow's own timeout_ms argument above) - this call is expected to
    // take ~200ms in practice, comfortably inside callTool's own 10s
    // default, but stated explicitly here since this is the one capture
    // call in this script that is expected to take meaningfully longer
    // than an ordinary near-instant tools/call round trip.
    15_000
  );
  if (followBody.error) {
    throw new Error(`follow scenario: JSON-RPC error: ${JSON.stringify(followBody.error)}`);
  }
  const follow = toCanonicalResultPair(followBody.result);

  // Fail closed rather than silently accept whatever shape this run
  // happened to produce: this scenario exists specifically to capture a
  // genuine bounded wait resolved by real output while the job was still
  // live (see this function's own header doc) - a timeout-shaped or
  // already-terminal result would freeze the WRONG thing into the golden
  // while still passing every check above it.
  const capturedReason = follow.structuredContent?.reason;
  const capturedState = follow.structuredContent?.state;
  if (capturedReason !== "output" || capturedState !== "running") {
    throw new Error(
      `follow scenario: expected reason "output" with state "running" (a genuine bounded ` +
        `wait resolved by real output while the job was still live), got reason=` +
        `${JSON.stringify(capturedReason)} state=${JSON.stringify(capturedState)} - refusing ` +
        "to capture a timeout-shaped or otherwise-unintended follow result into the frozen golden"
    );
  }

  // The backing job is still alive (blocked on its own long second timer,
  // deliberately, per this function's own doc comment) - killed here
  // purely for real-process hygiene, uncaptured and never part of this
  // scenario's own result or the golden.
  await callTool(server, nextId(), "kill", { job_id: jobId });

  return follow;
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * SIGTERM, then wait (bounded) for the real exit - the same
 * server.child.kill("SIGTERM") pattern
 * test/wake-integration.test.ts's own shutdown-reap test uses. The
 * server's own shutdown path (src/server.ts's runServer, its
 * SIGTERM/SIGINT handlers) reaps any still-live backing job process group
 * on the way down, so this alone is what cleans up anything this script's
 * own scenario-level kill calls did not already reach (there should be
 * none by the time this runs, but this is the same unconditional
 * guaranteed-cleanup shape test/modern-handshake.test.ts's and
 * test/wake-integration.test.ts's own shutdown test both already
 * establish, never left to a best-effort assumption).
 */
async function shutdownServer(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  const exited = await Promise.race([
    server.waitForExit().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);
  // Escalation is decided by `exited` (whether waitForExit() actually
  // resolved) - never by `server.child.killed`, which Node sets to `true`
  // the instant a signal is successfully SENT, not once the child has
  // actually exited. A detached child that ignores or survives SIGTERM
  // already reads `killed: true` right after the send above, so gating
  // escalation on that flag (the earlier shape here) made the fallback
  // SIGKILL unreachable for exactly the case it exists to catch.
  if (!exited) {
    server.child.kill("SIGKILL");
    await Promise.race([server.waitForExit(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Refuses to run at all unless the checkout's actual HEAD matches an
 * expected base revision the caller states explicitly - printing the
 * captured commit AFTER the write (as main() already did) is a record of
 * what happened, not a control on what is allowed to happen: nothing
 * stopped an invocation on a later checkout from silently rewriting the
 * frozen golden to whatever the code currently emits, including a
 * timeout-shaped follow result, while the printout dutifully reported
 * that wrong commit as though it were the intended one. Both `expected`
 * and the live `HEAD` are resolved through `git rev-parse` (so an
 * abbreviated SHA or a ref name works identically to a full SHA) and
 * compared for exact equality - never a prefix or "close enough" match.
 */
function requireExpectedBase(expected) {
  if (!expected) {
    console.error(
      "capture-plain-poll-golden: usage: node scripts/capture-plain-poll-golden.mjs <expected-base-revision>\n" +
        "  Pass the exact commit (a full/abbreviated SHA or any ref git can resolve) this\n" +
        "  capture is intended to run against - required so a run against the wrong\n" +
        "  checkout is refused before it can silently rewrite the frozen golden."
    );
    process.exitCode = 1;
    return false;
  }
  const expectedSha = execFileSync("git", ["rev-parse", expected], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  const actualSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (expectedSha !== actualSha) {
    console.error(
      `capture-plain-poll-golden: refusing to run - expected base "${expected}" resolves to ` +
        `${expectedSha}, but the current checkout's HEAD is ${actualSha}. Check out the ` +
        "intended base before capturing, or pass the current HEAD explicitly if this " +
        "checkout genuinely IS the new intended base."
    );
    process.exitCode = 1;
    return false;
  }
  return true;
}

async function main() {
  if (!requireExpectedBase(process.argv[2])) return;

  console.log("capture-plain-poll-golden: building dist/ from current source...");
  execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

  console.log("capture-plain-poll-golden: spawning a real server process...");
  // See TEST_POLICY_ALLOW_PATH's own doc comment above - this must be set
  // BEFORE spawnServer() so the spawned child inherits it.
  process.env.GHANTIKA_POLICY_FILE = TEST_POLICY_ALLOW_PATH;
  const server = spawnServer();
  try {
    await completeHandshake(server);
    console.log(
      "capture-plain-poll-golden: handshake complete (plain, non-Tasks-capable connection)"
    );

    const results = {};

    console.log("capture-plain-poll-golden: capturing list...");
    results.list = await captureList(server);

    console.log("capture-plain-poll-golden: capturing run...");
    results.run = await captureRun(server);

    console.log("capture-plain-poll-golden: capturing status...");
    results.status = await captureStatus(server);

    console.log("capture-plain-poll-golden: capturing output/tail...");
    const { output, tail } = await captureOutputAndTail(server);
    results.output = output;
    results.tail = tail;

    console.log("capture-plain-poll-golden: capturing kill...");
    results.kill = await captureKill(server);

    console.log("capture-plain-poll-golden: capturing follow (a real ~200ms bounded wait)...");
    results.follow = await captureFollow(server);

    const canonicalized = canonicalizePlainPollResponse(results);
    const json = `${JSON.stringify(canonicalized, null, 2)}\n`;
    writeFileSync(GOLDEN_PATH, json, "utf8");
    execFileSync(PRETTIER_BIN, ["--write", GOLDEN_PATH], { cwd: REPO_ROOT, stdio: "inherit" });

    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    const tools = Object.keys(results).sort();
    console.log("");
    console.log("capture-plain-poll-golden: regeneration complete.");
    console.log(`  wrote: ${path.relative(REPO_ROOT, GOLDEN_PATH)}`);
    console.log(`  from commit: ${sha}`);
    console.log(`  captured at: ${new Date().toISOString()}`);
    console.log(`  tools captured (${tools.length}): ${tools.join(", ")}`);
    console.log(
      "  this was a DELIBERATE, MANUAL regeneration - this script is never run automatically as part of the gate/CI, npm test, or npm run coverage."
    );
  } finally {
    await shutdownServer(server);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("capture-plain-poll-golden: failed:", err);
    process.exitCode = 1;
  });
}
