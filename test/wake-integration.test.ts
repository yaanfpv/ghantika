/**
 * Proves the output-driven wake (`src/tasksAdapter.ts`, already merged) is
 * STRICTLY ADDITIVE from a plain, non-Tasks client's point of view, plus a
 * handful of stateless/lifecycle properties the wake layer must not have
 * disturbed. This file does NOT redefine the coalescing window or the
 * firehose policy - both are owned entirely by `tasksAdapter.ts` and its
 * own exported constants, imported here and never duplicated as new magic
 * literals - and it does NOT re-cover ground `test/tasks-lifecycle.test.ts`
 * already owns (keepalive status, TTL purge, terminal-flush ordering,
 * cooperative-cancel scope). What this file adds:
 *
 *   - observable ordering (the real adapter path, never a hardcoded
 *     order) plus non-blocking / genuinely-concurrent `run()` calls.
 *   - the frozen terminal result shape, a stateless-handle proof (a
 *     totally separate connection resolves a real taskId purely from the
 *     argument), and a finite, bounded shutdown reap of a genuinely-live
 *     task (the reused pgrep oracle from `test/shutdown.test.ts`).
 *   - a re-verification (never a redefinition) that the wake's
 *     cardinality still matches the already-owned policy, and that
 *     `tasks/get` and `output`/`tail` stay two genuinely distinct surfaces.
 *   - the core regression guarantee - a frozen, checked-in golden
 *     (`test/fixtures/plain-poll-golden.json`, captured from a real
 *     spawned build of the commit right before the wake layer merged) that
 *     every plain-poll response must still match under canonical projection,
 *     whether or not the Tasks adapter is actively engaged elsewhere in the
 *     same process.
 *   - the wake proof itself - a SIMULATED/mock capable client is
 *     genuinely woken through the real notification path, explicitly
 *     labeled as simulated (never claiming a real installed host's own
 *     auto-resume; a real host's own auto-resume remains a separate,
 *     disclosed-pending verification, gated on an actual such host
 *     existing to test against).
 *
 * Same real-client/real-server/`InMemoryTransport` pattern
 * `test/tasks-lifecycle.test.ts` and `test/tasks.test.ts` already
 * establish for most of this file; the one shutdown-reap test spawns a
 * REAL child process instead (mirroring `test/shutdown.test.ts`'s own
 * pattern exactly), since a real, external `pgrep` confirmation is only
 * meaningful against a real, separate OS process.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { StandardSchemaV1 } from "@modelcontextprotocol/server";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import { createServer } from "../dist/server.js";
import { jobStore } from "../dist/jobStore.js";
import { isProcessAlive, killProcessGroupPosix } from "../dist/process.js";
import {
  FIREHOSE_LINES_PER_SEC,
  FIREHOSE_SUSTAINED_MS,
  TASKS_EXTENSION_URI,
  TASKS_STATUS_NOTIFICATION_METHOD,
  WAKE_COALESCE_WINDOW_MS,
  WATCH_STOP_REASON_FIREHOSE,
} from "../dist/tasksAdapter.js";

import {
  type SpawnedServer,
  parsesAsPgid,
  pgrepGroupMembers,
  spawnServer,
  waitForFile,
  waitForPgrepGroupMembers,
} from "./harness.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GOLDEN_PATH = path.join(REPO_ROOT, "test", "fixtures", "plain-poll-golden.json");

// Real, external POSIX process-group confirmation has no Windows
// equivalent - matching every other identity/reap test in this codebase.
const PGREP_ORACLE_SKIP =
  process.platform === "win32"
    ? "confirms the result via a real external `pgrep -g`, POSIX-only"
    : false;

// ---------------------------------------------------------------------------
// Harness - mirrors test/tasks-lifecycle.test.ts's own startPair/tasksGet/
// runJob shape (never reinvented differently), so this file exercises the
// identical real client/server contract.
// ---------------------------------------------------------------------------

interface Pair {
  readonly client: Client;
  readonly close: () => Promise<void>;
}

let pairCounter = 0;

async function startPair(capable: boolean): Promise<Pair> {
  pairCounter += 1;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const instance = createServer(serverTransport);
  await instance.server.connect(instance.transport);

  const client = new Client(
    { name: `ghantika-wake-integration-test-client-${pairCounter}`, version: "0.0.0" },
    capable ? { capabilities: { extensions: { [TASKS_EXTENSION_URI]: {} } } } : {}
  );
  await client.connect(clientTransport);

  return {
    client,
    close: () => instance.shutdown("wake-integration.test.ts complete"),
  };
}

/** A permissive Standard Schema that accepts any value unchanged - reads the raw params/result of a custom (non-spec) request/notification, mirroring test/tasks.test.ts's own passthroughResultSchema. */
function passthroughSchema(): StandardSchemaV1<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "ghantika-wake-integration-test",
      validate: (value: unknown) => ({ value }),
    },
  };
}

async function tasksGet(client: Client, taskId: string): Promise<Record<string, unknown>> {
  const result = await client.request(
    { method: "tasks/get", params: { taskId } },
    passthroughSchema()
  );
  return result as Record<string, unknown>;
}

function runResultStructured(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  assert.equal(typeof structured, "object");
  return structured as Record<string, unknown>;
}

async function runJob(
  client: Client,
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: "run",
    arguments: { command: ["true"], ...overrides },
  });
  assert.notEqual((result as { isError?: boolean }).isError, true);
  return runResultStructured(result);
}

/** An idle, real, backing command that produces NOTHING on its own - the SAME fixture pattern test/tasks-lifecycle.test.ts already establishes for a genuine process to mint a task around, kill, and reap, while a test drives observable stdout/stderr independently. */
const IDLE_COMMAND = [process.execPath, "-e", "setTimeout(() => {}, 600000);"];

/**
 * A real, backing command that reaches its OWN natural terminal after a
 * short, real delay - used only by the firehose green control below, which
 * needs to observe the job complete on its own rather than being killed and
 * standing in a "cancelled" terminal for "normal." The delay is comfortably
 * longer than the synchronous mock-timer injection block it runs alongside
 * (that block advances a fake clock and never actually waits in real time),
 * and short enough not to meaningfully slow the suite down.
 */
const SHORT_LIVED_COMMAND = [process.execPath, "-e", "setTimeout(() => {}, 300);"];

/** Real external process-group death confirmation - the SAME pgrep pattern test/tasks-lifecycle.test.ts, test/kill.test.ts, and test/shutdown.test.ts each already establish, reusing test/harness.ts's canonical pgrepGroupMembers rather than a fresh local copy. */
async function waitForRealDeath(pid: number, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!isProcessAlive(pid) && pgrepGroupMembers(pid).length === 0) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `pid ${pid} (and/or its group) still alive after ${timeoutMs}ms: isProcessAlive=${isProcessAlive(pid)}, pgrep=${JSON.stringify(pgrepGroupMembers(pid))}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Kills the REAL backing process for `jobId` via the real, real-timer-driven process-group primitives (never a mocked clock) and confirms, via a real external check, it is genuinely gone. A no-op if the job never had a tracked child at all. */
async function killAndReapRealChild(jobId: string): Promise<void> {
  const handle = jobStore.getChildHandle(jobId);
  if (handle === undefined) return;
  await killProcessGroupPosix(handle.pid, 500);
  await waitForRealDeath(handle.pid);
}

/** A single stdout line's buffer form - matches real stream traffic. */
function line(text: string): Buffer {
  return Buffer.from(`${text}\n`);
}

interface WakeNotification {
  readonly params: Record<string, unknown>;
}

/** Registers a real handler on the mock client's own notification dispatch - never an adapter-internal counter. */
function registerWakeSpy(client: Client): WakeNotification[] {
  const received: WakeNotification[] = [];
  client.setNotificationHandler(
    TASKS_STATUS_NOTIFICATION_METHOD,
    { params: passthroughSchema() },
    (params) => {
      received.push({ params: params as Record<string, unknown> });
    }
  );
  return received;
}

async function pollUntilTerminal(
  client: Client,
  jobId: string,
  maxAttempts = 200
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await client.callTool({ name: "status", arguments: { job_id: jobId } });
    const structured = runResultStructured(result);
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

async function pollTaskUntilTerminal(
  client: Client,
  taskId: string,
  maxAttempts = 200
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const taskGet = await tasksGet(client, taskId);
    if (
      taskGet.status === "completed" ||
      taskGet.status === "failed" ||
      taskGet.status === "cancelled"
    ) {
      return taskGet;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`task ${taskId} never reached a terminal status within ${maxAttempts} polls`);
}

// =============================================================================
// Observable ordering (via the real adapter) + non-blocking concurrency
// =============================================================================

test("run()'s CreateTaskResult response is observed before any wake (a genuine race, needing no foreknowledge of the job's id), before the job's real completion becomes visible through tasks/get, and before any of its output becomes observable through output (three provably non-trivial reads, not a pre-seeded order), and run() does not block on an earlier still-running task", async () => {
  const pair = await startPair(true);
  let orderJobId: string | undefined;
  let keepaliveJobId: string | undefined;
  let secondJobId: string | undefined;
  try {
    let orderCounter = 0;
    const orderLog: Array<{ type: string; order: number }> = [];
    const recordOrder = (type: string): number => {
      const order = orderCounter;
      orderCounter += 1;
      orderLog.push({ type, order });
      return order;
    };

    // A real handler on the real client, registered BEFORE run() is ever
    // called, recording the exact moment a wake notification's own handler
    // actually runs. This is what makes the wake comparison a genuine
    // race: a wake is PUSHED to the client, so observing it needs no
    // foreknowledge of the job's id, and nothing in this test's own code
    // forces an order between it and the run() response - only whatever
    // the real adapter actually delivers first does.
    pair.client.setNotificationHandler(
      TASKS_STATUS_NOTIFICATION_METHOD,
      { params: passthroughSchema() },
      () => {
        recordOrder("wake");
      }
    );

    // PART A - ordering. tasks/get CANNOT be attempted before the job's id
    // exists - the extension's own shape requires it, and that id only
    // ever comes back on run()'s own response - so unlike the wake above,
    // this half can never be a symmetric race where either side might
    // arrive first, and no amount of promise restructuring changes that.
    // What makes it a genuine, non-trivial proof instead: a real child
    // process (forked, run, and reaped by the OS) reliably takes real
    // wall-clock time longer than this client's own in-process round trip
    // back from run(), so the FIRST tasks/get read - sent the instant the
    // id is known, with nothing else interposed - still observes the job
    // genuinely incomplete. That is asserted directly below, not assumed:
    // if it ever stopped holding, the "before" claim this test makes would
    // be proven vacuous rather than merely imposed by construction, which
    // is exactly the defect this rewrite fixes.
    const runResult = await pair.client.callTool({
      name: "run",
      arguments: {
        command: [process.execPath, "-e", "process.stdout.write('ordering-proof-line\\n');"],
        label: "ordering-proof",
      },
    });
    const runResponseOrder = recordOrder("run-response");
    assert.notEqual((runResult as { isError?: boolean }).isError, true);
    const minted = runResultStructured(runResult);
    orderJobId = minted.taskId as string;
    assert.equal(typeof orderJobId, "string");

    // tasks/get alone can only prove "the job isn't terminal yet" -
    // buildTaskResult never includes output until a job reaches its own
    // terminal state, so even a hypothetical implementation that buffered
    // real output before this response ever committed would still read
    // exactly the same way there. output is a genuinely different surface:
    // it is a live read of the same per-stream buffer jobStore.appendOutput
    // itself writes into, never gated on terminal state, so it is what can
    // actually tell "no output yet" apart from "output exists, but the job
    // isn't done." A real stdout line already sitting in that buffer at
    // this exact instant, with nothing interposed since the response above
    // was received, would mean the child's output had already been
    // captured before the response that is supposed to precede it.
    const firstOutputPoll = (await pair.client.callTool({
      name: "output",
      arguments: { job_id: orderJobId, stream: "stdout" },
    })) as { structuredContent?: { events?: unknown[] } };
    assert.deepEqual(
      firstOutputPoll.structuredContent?.events ?? [],
      [],
      "expected zero stdout events on the very first output poll, sent immediately after learning the job id with nothing interposed - any line here would mean the child's output had already been captured before the run() response that is supposed to precede it"
    );

    // Poll tasks/get for real until it becomes genuinely OUTPUT-BEARING
    // (terminal - buildTaskResult only includes `output` once terminal).
    // The very first attempt, sent immediately with nothing interposed,
    // must NOT yet be output-bearing - see the comment above for why that
    // is provable rather than assumed, and why its failure would mean this
    // test no longer proves anything about ordering at all.
    let firstOutputBearingOrder: number | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const taskGet = await tasksGet(pair.client, orderJobId);
      if (attempt === 0) {
        assert.equal(
          taskGet.output,
          undefined,
          "expected the job to still be genuinely incomplete on the very first tasks/get read, sent immediately after learning the id - otherwise this test no longer proves anything about ordering, it just observes an outcome that was already decided before the check ran"
        );
      }
      if (taskGet.output !== undefined) {
        firstOutputBearingOrder = recordOrder("output-bearing");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(
      firstOutputBearingOrder !== undefined,
      "expected tasks/get to eventually become output-bearing"
    );
    assert.ok(
      firstOutputBearingOrder! > runResponseOrder,
      `the first output-bearing tasks/get (order ${firstOutputBearingOrder}) must arrive strictly after the run() response (order ${runResponseOrder})`
    );

    // Confirms the same output surface DOES carry the real line once the
    // job has actually run - proving the empty read above was a genuine
    // "not yet," not a surface that can never show output at all.
    const laterOutputPoll = (await pair.client.callTool({
      name: "output",
      arguments: { job_id: orderJobId, stream: "stdout" },
    })) as { structuredContent?: { events?: Array<{ text: string }> } };
    const laterOutputTexts = (laterOutputPoll.structuredContent?.events ?? []).map(
      (event) => event.text
    );
    assert.ok(
      laterOutputTexts.includes("ordering-proof-line"),
      `expected the job's real stdout line to eventually appear through the output poll, got ${JSON.stringify(laterOutputTexts)}`
    );

    // The job's own terminal flush guarantees a real wake for a job this
    // short-lived: src/tasksAdapter.ts's startTaskWatch flushes any output
    // still sitting in an open coalescing window as one final wake once the
    // job goes terminal - a flush of already-produced output, not a wake
    // for the terminal transition itself - rather than leaving it stranded
    // for a window that will never close on its own. So this MUST have fired at
    // least once here - not "if any did" - or the check below would be
    // satisfied vacuously over zero entries, proving nothing about
    // ordering. A short, bounded settle covers the real notification's own
    // round trip landing a beat after the poll loop above already observed
    // the terminal read.
    for (
      let attempt = 0;
      orderLog.filter((entry) => entry.type === "wake").length === 0 && attempt < 50;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const wakeEntries = orderLog.filter((entry) => entry.type === "wake");
    assert.ok(
      wakeEntries.length > 0,
      "expected this short-lived job's terminal flush to have produced at least one real wake - a zero count here would make the ordering check below vacuous"
    );
    for (const wakeEntry of wakeEntries) {
      assert.ok(
        wakeEntry.order > runResponseOrder,
        `a wake fired at order ${wakeEntry.order}, before the run() response at order ${runResponseOrder}`
      );
    }

    // PART B - non-blocking: spawn a never-self-completing keepalive FIRST,
    // then confirm a SECOND same-session run() request completes normally
    // while that first task is observably still in a non-terminal status.
    const mintedKeepalive = await runJob(pair.client, {
      command: IDLE_COMMAND,
      label: "keepalive-first",
    });
    keepaliveJobId = mintedKeepalive.taskId as string;
    const statusBefore = await tasksGet(pair.client, keepaliveJobId);
    assert.equal(statusBefore.status, "working");

    // Bounded, tight deadline - if run() genuinely blocked on the keepalive
    // task's completion (which never happens on its own), this would hang
    // past the bound instead of merely being slow.
    const startSecond = Date.now();
    const mintedSecond = (await Promise.race([
      runJob(pair.client, { command: IDLE_COMMAND, label: "second-request" }),
      new Promise((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "the second run() call did not return within the bound - it may be blocking on the first, still-running task"
              )
            ),
          3000
        )
      ),
    ])) as Record<string, unknown>;
    const elapsedSecond = Date.now() - startSecond;
    secondJobId = mintedSecond.taskId as string;
    assert.ok(
      elapsedSecond < 3000,
      `expected the second run() call to return quickly, took ${elapsedSecond}ms`
    );

    const statusAfter = await tasksGet(pair.client, keepaliveJobId);
    assert.equal(
      statusAfter.status,
      "working",
      "the keepalive task must still be non-terminal after the second run() call completed - proves run() did not wait for it to finish"
    );
  } finally {
    if (orderJobId !== undefined) await killAndReapRealChild(orderJobId);
    if (keepaliveJobId !== undefined) await killAndReapRealChild(keepaliveJobId);
    if (secondJobId !== undefined) await killAndReapRealChild(secondJobId);
    await pair.close();
  }
});

test("two run() calls spawn CONCURRENTLY - both real backing processes are observably alive at the same moment, catching a subtler mutex bug where a fast-returning second call silently queues its real spawn behind the first job finishing", async () => {
  const pair = await startPair(true);
  let jobAId: string | undefined;
  let jobBId: string | undefined;
  try {
    const mintedA = await runJob(pair.client, {
      command: IDLE_COMMAND,
      label: "concurrent-a",
    });
    jobAId = mintedA.taskId as string;
    const mintedB = await runJob(pair.client, {
      command: IDLE_COMMAND,
      label: "concurrent-b",
    });
    jobBId = mintedB.taskId as string;

    const handleA = jobStore.getChildHandle(jobAId);
    const handleB = jobStore.getChildHandle(jobBId);
    assert.ok(handleA, "expected job A to have a real tracked child");
    assert.ok(handleB, "expected job B to have a real tracked child");
    assert.notEqual(
      handleA!.pid,
      handleB!.pid,
      "expected two genuinely distinct real backing processes"
    );
    assert.ok(
      isProcessAlive(handleA!.pid),
      "expected job A's real process to be alive concurrently with job B"
    );
    assert.ok(
      isProcessAlive(handleB!.pid),
      "expected job B's real process to be alive concurrently with job A - proves run() does not serialize the actual spawn behind A's own completion"
    );

    const statusA = await tasksGet(pair.client, jobAId);
    const statusB = await tasksGet(pair.client, jobBId);
    assert.equal(statusA.status, "working");
    assert.equal(statusB.status, "working");
  } finally {
    if (jobAId !== undefined) await killAndReapRealChild(jobAId);
    if (jobBId !== undefined) await killAndReapRealChild(jobBId);
    await pair.close();
  }
});

// =============================================================================
// Output-driven wake cardinality re-verification, strictly additive to
// the already-owned coalescing/firehose policy. This file does NOT define
// WAKE_COALESCE_WINDOW_MS/FIREHOSE_LINES_PER_SEC/FIREHOSE_SUSTAINED_MS -
// every derived count below comes from the imported constant, never a
// hardcoded magic number.
// =============================================================================

test("a burst of stdout within one WAKE_COALESCE_WINDOW_MS window collapses into exactly ONE wake, and tasks/get vs output/tail stay two genuinely distinct surfaces - the wake's own line payload is never routed through tasks/get", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await runJob(pair.client, { command: IDLE_COMMAND, label: "burst-window" });
    jobId = minted.taskId as string;
    const received = registerWakeSpy(pair.client);

    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      jobStore.appendOutput(jobId, "stdout", Buffer.concat([line("burst-x"), line("burst-y")]));
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      received.length,
      1,
      `a burst within one coalescing window must collapse into exactly one wake, got ${received.length}`
    );
    assert.deepEqual(
      (received[0]!.params.stdout as Array<{ text: string }>).map((entry) => entry.text),
      ["burst-x", "burst-y"]
    );

    // tasks/get is a pure status/count projection - it must NEVER carry the
    // wake's own line payload.
    const taskGet = await tasksGet(pair.client, jobId);
    assert.equal(taskGet.status, "working");
    assert.equal(taskGet.stdout, undefined, "tasks/get must never carry a raw stdout line payload");
    assert.equal(taskGet.lines, undefined, "tasks/get must never carry a raw lines payload");

    // output/tail (the per-line cursor) is the ONLY surface that carries
    // the wake's own line content.
    const outputResult = (await pair.client.callTool({
      name: "output",
      arguments: { job_id: jobId, stream: "stdout" },
    })) as { structuredContent?: { events?: Array<{ text: string }> } };
    const texts = (outputResult.structuredContent?.events ?? []).map((event) => event.text);
    assert.deepEqual(texts, ["burst-x", "burst-y"]);
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

test("a line arriving after WAKE_COALESCE_WINDOW_MS has closed opens a NEW, separate wake - exact wake count derived from the imported constant, never a hardcoded number", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await runJob(pair.client, {
      command: IDLE_COMMAND,
      label: "post-window",
    });
    jobId = minted.taskId as string;
    const received = registerWakeSpy(pair.client);

    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      jobStore.appendOutput(jobId, "stdout", line("post-window-first"));
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS + 1); // closes window 1
      jobStore.appendOutput(jobId, "stdout", line("post-window-second"));
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS + 1); // closes window 2
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      received.length,
      2,
      `expected exactly 2 wakes, one per WAKE_COALESCE_WINDOW_MS(${WAKE_COALESCE_WINDOW_MS}) window, got ${received.length}`
    );
    assert.deepEqual(
      (received[0]!.params.stdout as Array<{ text: string }>).map((entry) => entry.text),
      ["post-window-first"]
    );
    assert.deepEqual(
      (received[1]!.params.stdout as Array<{ text: string }>).map((entry) => entry.text),
      ["post-window-second"]
    );
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

test("a sustained stream above FIREHOSE_LINES_PER_SEC for FIREHOSE_SUSTAINED_MS rate-limits and auto-stops ONLY the notification watch - the job itself is never killed", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await runJob(pair.client, {
      command: IDLE_COMMAND,
      label: "firehose-trigger",
    });
    jobId = minted.taskId as string;
    const received = registerWakeSpy(pair.client);

    // Derived directly from the exported constants - never a magic
    // literal. See test/tasks-lifecycle.test.ts's own identical firehose
    // test for the full derivation rationale this mirrors.
    const TICK_MS = 1000;
    const LINES_PER_TICK = Math.ceil(((FIREHOSE_LINES_PER_SEC * TICK_MS) / 1000) * 1.2);
    const TICKS_NEEDED = Math.ceil(FIREHOSE_SUSTAINED_MS / TICK_MS);

    function manyLines(count: number): Buffer {
      const parts: Buffer[] = [];
      for (let i = 0; i < count; i += 1) parts.push(Buffer.from(`f${i}\n`));
      return Buffer.concat(parts);
    }

    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      jobStore.appendOutput(jobId, "stdout", manyLines(LINES_PER_TICK));
      for (let i = 0; i < TICKS_NEEDED; i += 1) {
        mock.timers.tick(TICK_MS);
        jobStore.appendOutput(jobId, "stdout", manyLines(LINES_PER_TICK));
      }

      const taskGet = await tasksGet(pair.client, jobId);
      assert.equal(
        taskGet.status,
        "working",
        "the job must still be working - only the watch stopped"
      );
      const watchStopped = taskGet.watchStopped as { reason?: string } | undefined;
      assert.ok(
        watchStopped,
        `expected watchStopped to be present, got ${JSON.stringify(taskGet)}`
      );
      assert.equal(watchStopped!.reason, WATCH_STOP_REASON_FIREHOSE);

      const wakeCountAtStop = received.length;
      jobStore.appendOutput(jobId, "stdout", line("after-firehose-stop"));
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS * 2);
      assert.equal(
        received.length,
        wakeCountAtStop,
        "no additional wake may fire once the watch has auto-stopped"
      );
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setImmediate(resolve));

    // The job stays genuinely alive/pollable - the watch stopping never
    // touches the backing process.
    const handle = jobStore.getChildHandle(jobId);
    assert.ok(
      handle && isProcessAlive(handle.pid),
      "the backing job must still be a live real process"
    );
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

test("green control: a bounded stream UNDER FIREHOSE_LINES_PER_SEC runs to its own real, natural terminal completely UNTOUCHED - the watch is never auto-stopped", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await runJob(pair.client, {
      command: SHORT_LIVED_COMMAND,
      label: "firehose-green-control",
    });
    jobId = minted.taskId as string;
    const received = registerWakeSpy(pair.client);

    // Comfortably under the threshold and comfortably longer than
    // FIREHOSE_SUSTAINED_MS - matching the same well-under-threshold shape
    // test/tasks-lifecycle.test.ts's own green control already uses. This
    // whole block runs on a MOCKED clock (real wall-clock time spent here is
    // just ordinary synchronous JS execution, a few milliseconds at most),
    // well inside SHORT_LIVED_COMMAND's own real 300ms lifetime, so the
    // backing process is still alive and the watch is still subscribed for
    // every tick.
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      for (let tick = 0; tick < 12; tick += 1) {
        const parts: Buffer[] = [];
        for (let i = 0; i < 10; i += 1) parts.push(line(`slow-${tick}-${i}`));
        jobStore.appendOutput(jobId, "stdout", Buffer.concat(parts));
        mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
      }
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setImmediate(resolve));

    const taskGet = await tasksGet(pair.client, jobId);
    assert.equal(taskGet.status, "working");
    assert.equal(
      taskGet.watchStopped,
      undefined,
      "a bounded, under-threshold stream must NEVER trigger the firehose auto-stop"
    );
    assert.ok(received.length > 0, "the watch must still have delivered normal wakes throughout");

    // Runs to its own REAL, natural terminal - nothing here ever signals
    // this job - completely untouched by any firehose guard. A killed job's
    // terminal state is not the same claim as "ran to normal completion,"
    // so this waits for the real backing process to exit on its own.
    const finalGet = await pollTaskUntilTerminal(pair.client, jobId);
    assert.equal(
      finalGet.status,
      "completed",
      `expected the job to reach its own natural terminal, got ${JSON.stringify(finalGet)}`
    );
    assert.equal(finalGet.watchStopped, undefined);
  } finally {
    if (jobId !== undefined && jobStore.getChildHandle(jobId) !== undefined) {
      await killAndReapRealChild(jobId);
    }
    await pair.close();
  }
});

// =============================================================================
// Strictly additive: canonicalized plain poll against a frozen golden.
// The golden was captured from a REAL spawned build of the commit right
// before the wake layer merged (f56dfd7), speaking real, raw JSON-RPC over
// its real stdin/stdout to a plain (non-Tasks-capable) connection, running
// the same six scenarios runPlainPollScenarios below runs and canonicalizing
// them the same way canonicalizePlainPollResponse below does. The fixture
// file itself is bare JSON with no header or provenance record of its own -
// this comment is where that provenance lives, not an in-file header. It is
// LOADED here, not regenerated from the currently-running server. The
// comparison below is against this canonical projection, not literal wire
// bytes - see the field-exclusion rationale below for exactly what it masks
// and why.
//
// Each tool's golden entry carries BOTH `structuredContent` and a second
// value captured from `content` - but that second value is only the
// independently JSON-parsed body of `content[0].text`, not `content`
// itself: the array's length and ordering, each block's type, any
// additional or non-text blocks, and every other CallToolResult envelope
// field are captured nowhere in this fixture and compared nowhere below.
// Every tool handler in this codebase builds `content[0].text` as
// `JSON.stringify(structuredContent, null, 2)` - a real, source-verified
// invariant at capture time, not an assumed one - but that is exactly the
// kind of parity a future edit could break without touching
// structuredContent at all (a stale or hand-edited content string, say).
// Comparing only structuredContent, as this file used to, would pass
// right through such a break; capturing and comparing the first block's
// parsed body closes that one specific gap, and only that one.
// =============================================================================

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, unknown>;

// These four fields are real, pre-existing (unchanged by the wake-layer
// story) process-GROUP confirmation fields whose PRESENCE, not just value,
// is a genuine timing race independent of the wake layer entirely -
// kill_confirmed/identity_confirmed depend on whether an async pgrep-based
// reap has settled by the moment a response is read, identity_capture on
// whether the async ps-based birth-identity capture has settled, and
// escalation_refused_reason only ever appears on a SIGKILL-escalation
// identity mismatch. Confirmed directly against src/jobStore.ts's own
// `PublicJobProjection`/`toPublicProjection`: all four are declared OPTIONAL
// and are passed through verbatim from a `JobRecord` field that is itself
// only ever written once its own async, fire-and-forget confirmation
// settles - and JSON serialization drops an unset optional field entirely
// rather than carrying it as `null`. So a real, honest capture can
// legitimately have any of these four present or fully absent depending on
// nothing but timing, independent of any real bug. That is why these four
// are EXCLUDED from the comparison below rather than masked to a stable
// token the way job_id/started_at/ended_at/label are: masking replaces the
// VALUE of a field that is always PRESENT, but forcing one of these four to
// always compare as present (or always absent) would fabricate a
// determinism the real wire protocol does not have - which would silently
// paper over a genuine regression in their presence rather than prove
// anything about it. None of the four is something this story's wake layer
// could plausibly regress (already governed by test/kill.test.ts and
// friends) - excluding them keeps this comparison scoped to the
// wake-additivity property it exists to prove.
const RACY_IN_PRESENCE_CONFIRMATION_FIELDS = new Set([
  "kill_confirmed",
  "identity_confirmed",
  "identity_capture",
  "escalation_refused_reason",
]);

/**
 * Masks volatile fields to the SAME stable placeholder tokens the golden
 * fixture was frozen with, and drops any key whose value is `undefined` -
 * real wire JSON serialization always drops these (which is how the golden
 * was captured), so this keeps the comparison correct regardless of
 * whether a given live call happens to travel over a real byte-serialized
 * transport or an in-process one that can leak an explicitly-undefined key
 * no real client would ever observe. `label` is masked too - it is a
 * caller-supplied literal input (not a server invariant), and this file's
 * own scenarios need a distinct, real label per run (so `list`'s own
 * single-entry isolation still holds when several scenarios share one
 * process) rather than reusing the golden's exact literal string. The four
 * `RACY_IN_PRESENCE_CONFIRMATION_FIELDS` are dropped (never given a
 * placeholder value) - see that constant's own docs for why deletion, not
 * masking, is the honest choice for a field whose real PRESENCE is racy,
 * not just its value.
 */
function canonicalizePlainPollResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizePlainPollResponse);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (RACY_IN_PRESENCE_CONFIRMATION_FIELDS.has(key)) continue;
      if (key === "job_id") out[key] = "<JOB_ID>";
      else if (key === "started_at" || key === "ended_at") out[key] = "<TIMESTAMP>";
      else if (key === "label") out[key] = "<LABEL>";
      else out[key] = canonicalizePlainPollResponse(v);
    }
    return out;
  }
  return value;
}

/**
 * Compares `live` (after canonicalization) against `golden` via actual
 * SERIALIZED BYTES - two independent `JSON.stringify` calls compared as
 * plain strings - rather than `assert.deepEqual`. `deepEqual` on two JS
 * objects does not care about key order or the exact serialized shape a
 * real wire response has; a byte comparison does, so a key reordering, an
 * added field, a removed field, or a renamed field are all caught here,
 * where a structural-equality check could let some of those slide. Both
 * sides are re-serialized fresh (never a raw-text comparison against the
 * fixture file's own on-disk formatting), so this is exact on MEANING, not
 * on incidental whitespace.
 */
function assertPlainPollByteIdentical(live: unknown, context: string): void {
  const liveBytes = JSON.stringify(canonicalizePlainPollResponse(live));
  const goldenBytes = JSON.stringify(golden);
  assert.equal(
    liveBytes,
    goldenBytes,
    `${context}: live plain-poll response is not byte-identical to the frozen golden after canonicalization`
  );
}

/**
 * Extracts BOTH halves of a real `CallToolResult` a golden comparison
 * needs: `structuredContent` as-is, and `content`'s own FIRST text block
 * independently re-parsed from its raw JSON string - never assumed equal
 * to `structuredContent` just because that is every handler's current
 * contract. A future regression that lets the two drift (a stale
 * `content` string a handler forgot to update alongside a real
 * `structuredContent` change, say) is exactly what capturing both
 * separately is for.
 *
 * The boundary this does NOT cover, stated explicitly rather than left
 * implied: only the first `content` block's parsed body is compared. The
 * array's own length and ordering, each block's `type`, any additional
 * blocks beyond the first, and every other `CallToolResult` envelope
 * field are outside what this - and therefore the additivity proof built
 * on it - actually establishes.
 */
function toCanonicalResultPair(result: {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}): { structuredContent: unknown; content: unknown } {
  const text = result.content?.[0]?.text;
  assert.equal(
    typeof text,
    "string",
    `expected a text content block, got: ${JSON.stringify(result.content)}`
  );
  return {
    structuredContent: result.structuredContent,
    content: JSON.parse(text as string),
  };
}

/** Runs the same six deterministic scenarios the golden was captured from, against a PLAIN (non-Tasks-capable) client, and returns each tool's canonicalized {structuredContent, content} pair keyed by tool name. */
async function runPlainPollScenarios(
  client: Client,
  labelPrefix: string
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};

  {
    const minted = await runJob(client, { command: ["true"], label: `${labelPrefix}-list-job` });
    const jobId = minted.job_id as string;
    await pollUntilTerminal(client, jobId);
    const listResult = (await client.callTool({ name: "list", arguments: {} })) as {
      structuredContent?: { jobs?: Array<Record<string, unknown>> };
      content?: Array<{ type: string; text?: string }>;
    };
    const allJobs = listResult.structuredContent?.jobs ?? [];
    const mine = allJobs.filter((entry) => entry.label === `${labelPrefix}-list-job`);
    assert.equal(
      mine.length,
      1,
      `expected exactly one list entry for this scenario's own job, got ${mine.length}`
    );
    // The REAL, process-wide list response can legitimately carry other
    // jobs too - a separate Tasks-capable connection's own keepalive job,
    // in the cross-connection scenario below, since jobStore is a single
    // process-wide singleton shared by every connection. The golden
    // comparison below is necessarily scoped to this scenario's own entry
    // (job COUNT varies by design between scenarios), but that alone would
    // miss an additivity regression that corrupts OTHER entries without
    // touching this one - an extra field leaking onto every job the Tasks
    // adapter can see, say, which a purely label-filtered view can never
    // observe because it discards every entry but its own before any
    // assertion runs. So every real entry in the UNFILTERED response is
    // first asserted to share this job-entry's own canonical key set.
    const expectedKeys = Object.keys(canonicalizePlainPollResponse(mine[0]) as object).sort();
    for (const entry of allJobs) {
      const entryKeys = Object.keys(canonicalizePlainPollResponse(entry) as object).sort();
      assert.deepEqual(
        entryKeys,
        expectedKeys,
        `every real entry in the process-wide list response must share this job-entry shape - found ${JSON.stringify(entry)}, expected keys ${JSON.stringify(expectedKeys)}`
      );
    }
    // `list`'s own content text is a bare array (not wrapped under
    // `jobs`, unlike structuredContent) - see src/tools/list.ts. Narrowed
    // and shape-checked the same way as the structuredContent array above.
    const listText = listResult.content?.[0]?.text;
    assert.equal(typeof listText, "string", "expected list's content block to carry text");
    const allJobsFromContent = JSON.parse(listText as string) as Array<Record<string, unknown>>;
    const mineFromContent = allJobsFromContent.filter(
      (entry) => entry.label === `${labelPrefix}-list-job`
    );
    assert.equal(
      mineFromContent.length,
      1,
      `expected exactly one list entry (from content) for this scenario's own job, got ${mineFromContent.length}`
    );
    for (const entry of allJobsFromContent) {
      const entryKeys = Object.keys(canonicalizePlainPollResponse(entry) as object).sort();
      assert.deepEqual(
        entryKeys,
        expectedKeys,
        `every real entry in the process-wide list content must share this job-entry shape - found ${JSON.stringify(entry)}, expected keys ${JSON.stringify(expectedKeys)}`
      );
    }
    results.list = { structuredContent: { jobs: mine }, content: mineFromContent };
  }

  {
    const result = await client.callTool({
      name: "run",
      arguments: { command: ["true"], label: `${labelPrefix}-run-immediate` },
    });
    results.run = toCanonicalResultPair(
      result as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown }
    );
  }

  {
    const minted = await runJob(client, {
      command: ["true"],
      label: `${labelPrefix}-status-terminal`,
    });
    const jobId = minted.job_id as string;
    await pollUntilTerminal(client, jobId);
    // pollUntilTerminal's own return value is structuredContent-only (it
    // exists to wait, not to capture) - a fresh direct call here is what
    // actually captures this scenario's own content+structuredContent pair.
    const statusResult = await client.callTool({ name: "status", arguments: { job_id: jobId } });
    results.status = toCanonicalResultPair(
      statusResult as {
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: unknown;
      }
    );
  }

  {
    // stdout-only, deliberately: the cross-stream MERGE order between
    // stdout and stderr depends on real OS-level pipe scheduling, which is
    // genuinely non-deterministic across runs - a single-stream command
    // keeps this scenario's seq/order assignment reproducible.
    const minted = await runJob(client, {
      command: [
        process.execPath,
        "-e",
        "process.stdout.write('golden-stdout-1\\n'); process.stdout.write('golden-stdout-2\\n'); process.stdout.write('golden-stdout-3\\n');",
      ],
      label: `${labelPrefix}-output-job`,
    });
    const jobId = minted.job_id as string;
    await pollUntilTerminal(client, jobId);
    const outputResult = (await client.callTool({
      name: "output",
      arguments: { job_id: jobId, stream: "both" },
    })) as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
    results.output = toCanonicalResultPair(outputResult);
    const tailResult = (await client.callTool({
      name: "tail",
      arguments: { job_id: jobId, lines: 5 },
    })) as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
    results.tail = toCanonicalResultPair(tailResult);
  }

  {
    const minted = await runJob(client, {
      command: IDLE_COMMAND,
      label: `${labelPrefix}-kill-job`,
    });
    const jobId = minted.job_id as string;
    const killResult = (await client.callTool({
      name: "kill",
      arguments: { job_id: jobId },
    })) as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
    results.kill = toCanonicalResultPair(killResult);
  }

  return results;
}

test("all six tools' plain-poll responses stay byte-identical (canonical projection) to the frozen pre-wake golden, with no OTHER connection ever engaging Tasks capability", async () => {
  const pair = await startPair(false);
  try {
    const live = await runPlainPollScenarios(pair.client, "plain-poll-absent");
    assertPlainPollByteIdentical(live, "no other connection engaging Tasks capability");
  } finally {
    await pair.close();
  }
});

test("run/status/output/tail/kill stay byte-identical (canonical projection) to the SAME frozen golden, and so does list's own scenario-owned entry, even while the Tasks adapter is ACTIVELY engaged elsewhere in the same process (a separate capable connection minting and wake-watching its own job) - every OTHER entry in the real process-wide list response is confirmed to share that entry's canonical key shape, not compared against a golden value", async () => {
  const capablePair = await startPair(true);
  const plainPair = await startPair(false);
  let capableJobId: string | undefined;
  try {
    const mintedCapable = await runJob(capablePair.client, {
      command: IDLE_COMMAND,
      label: "adapter-present-capable-keepalive",
    });
    capableJobId = mintedCapable.taskId as string;
    // Actually exercise the wake for this other job, so the adapter is
    // genuinely "loaded" (subscriptions live, timers armed), not merely
    // theoretically present.
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      jobStore.appendOutput(capableJobId, "stdout", line("adapter-present-line"));
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setImmediate(resolve));

    const live = await runPlainPollScenarios(plainPair.client, "plain-poll-present");
    assertPlainPollByteIdentical(live, "a separate capable connection actively engaged elsewhere");
  } finally {
    if (capableJobId !== undefined) await killAndReapRealChild(capableJobId);
    await capablePair.close();
    await plainPair.close();
  }
});

// =============================================================================
// Frozen result shape + stateless handle + finite teardown
// =============================================================================

test("a terminal task's tasks/get response has an EXACT key set (no missing field, no extra field), and a terminal task never reports a non-terminal status value", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await runJob(pair.client, {
      command: ["true"],
      label: "frozen-terminal-shape",
    });
    jobId = minted.taskId as string;
    const taskGet = await pollTaskUntilTerminal(pair.client, jobId);

    const expectedKeys = [
      "createdAt",
      "exitCode",
      "extension",
      "output",
      "pollIntervalMs",
      "status",
      "taskId",
    ];
    assert.deepEqual(
      Object.keys(taskGet).sort(),
      expectedKeys,
      `expected the EXACT terminal key set ${JSON.stringify(expectedKeys)}, got ${JSON.stringify(Object.keys(taskGet).sort())}`
    );

    assert.equal(taskGet.extension, TASKS_EXTENSION_URI);
    assert.equal(taskGet.taskId, jobId);
    assert.equal(taskGet.exitCode, 0);
    assert.ok(
      ["completed", "failed", "cancelled"].includes(taskGet.status as string),
      `expected a genuinely terminal status, got ${JSON.stringify(taskGet.status)}`
    );
    assert.notEqual(
      taskGet.status,
      "working",
      "a terminal task must never report the non-terminal 'working' status"
    );

    const output = taskGet.output as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(output).sort(),
      ["stderr_bytes", "stderr_lines", "stdout_bytes", "stdout_lines"],
      `expected the frozen output-counts key set, got ${JSON.stringify(Object.keys(output).sort())}`
    );
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

test("a task handle resolves PURELY from the passed argument - a totally separate connection that never observed the mint can still resolve the real taskId, and a wrong taskId on that same connection genuinely fails closed (no hidden per-connection session-state shortcut)", async () => {
  const pairA = await startPair(true);
  // pairB is a COMPLETELY SEPARATE server + client - a distinct Server
  // object, distinct capability negotiation, distinct everything except
  // the one thing they actually share: the process-wide jobStore
  // singleton. It is also deliberately NON-capable, to make the proof
  // stronger still: even a connection that never negotiated Tasks support
  // at all can resolve a real taskId, because resolution never depends on
  // capability or on any other per-connection state - only on the
  // argument.
  const pairB = await startPair(false);
  let jobId: string | undefined;
  try {
    const minted = await runJob(pairA.client, {
      command: ["true"],
      label: "stateless-handle",
    });
    jobId = minted.taskId as string;
    await pollTaskUntilTerminal(pairA.client, jobId);

    const viaB = await tasksGet(pairB.client, jobId);
    assert.equal(
      viaB.status,
      "completed",
      `expected pairB to resolve the SAME task purely via the taskId argument, got ${JSON.stringify(viaB)}`
    );
    assert.equal(viaB.exitCode, 0);

    // Negative control: a wrong/unknown taskId on that same separate
    // connection must genuinely fail closed, never fall back to some
    // hidden per-connection "last minted task" shortcut.
    const wrongId = "00000000-0000-4000-8000-000000000000";
    assert.notEqual(wrongId, jobId);
    const viaBWrong = await tasksGet(pairB.client, wrongId);
    assert.equal(
      viaBWrong.error,
      "task_not_found",
      `expected a genuinely wrong taskId to fail closed, got ${JSON.stringify(viaBWrong)}`
    );
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pairA.close();
    await pairB.close();
  }
});

/** A minimal `initialize` request advertising Tasks capability - completeHandshake (test/helpers/spawnServer.ts) hardcodes `capabilities: {}`, so this test builds its own handshake instead. */
async function completeCapableHandshake(
  server: SpawnedServer,
  id: number | string = 1
): Promise<void> {
  server.send({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: { extensions: { [TASKS_EXTENSION_URI]: {} } },
      clientInfo: { name: "ghantika-wake-integration-shutdown-test", version: "0.0.0" },
    },
  });
  await server.nextLine();
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

interface RunResponseBody {
  readonly error?: unknown;
  readonly result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
}

interface TasksGetResponseBody {
  readonly error?: unknown;
  readonly result?: Record<string, unknown>;
}

test(
  "shutdown finitely reaps a genuinely-live task's real backing job within a bounded deadline on POSIX (a hang is a distinct failure from a skip) - the real process is confirmed dead via the reused pgrep oracle, and an already-terminal task alongside it is read AGAIN mid-shutdown and found byte-for-byte unchanged",
  { skip: PGREP_ORACLE_SKIP },
  async () => {
    const server = spawnServer();
    await completeCapableHandshake(server);

    const dir = mkdtempSync(path.join(tmpdir(), "ghantika-wake-shutdown-reap-"));
    const marker = path.join(dir, "pgid.txt");
    // A real shell job (shell: true) that reports its own pid (== its own
    // pgid, since spawnManaged spawns it detached) then sleeps well past
    // this test's own bound - a genuinely-live, never-self-completing
    // backing job for the live task.
    const shellCommand = `echo $$ > '${marker}'; sleep 60`;

    server.send({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "run",
        arguments: { command: shellCommand, shell: true, label: "shutdown-live-task" },
      },
    });
    const liveRunLine = await server.nextLine();
    const liveRunBody = liveRunLine.parsed as RunResponseBody;
    assert.notEqual(
      liveRunBody.result?.isError,
      true,
      `run() must succeed: ${JSON.stringify(liveRunBody)}`
    );
    const liveTaskId = liveRunBody.result?.structuredContent?.taskId as string;
    assert.equal(typeof liveTaskId, "string");

    const pgidText = await waitForFile(marker, { until: parsesAsPgid });
    const pgid = Number(pgidText.trim());
    assert.ok(
      Number.isInteger(pgid) && pgid > 0,
      `expected a real numeric pgid, got ${JSON.stringify(pgidText)}`
    );

    server.send({ jsonrpc: "2.0", id: 11, method: "tasks/get", params: { taskId: liveTaskId } });
    const liveGetLine = await server.nextLine();
    const liveGetBody = liveGetLine.parsed as TasksGetResponseBody;
    assert.equal(
      liveGetBody.result?.status,
      "working",
      "expected the live task to be genuinely working before shutdown"
    );

    const beforeMembers = await waitForPgrepGroupMembers(
      pgid,
      (members) => members.length >= 1,
      3000
    );
    assert.ok(
      beforeMembers.length >= 1,
      `expected the live task's real process group alive BEFORE shutdown, pgrep saw: ${JSON.stringify(beforeMembers)}`
    );

    // The green control: an ALREADY-TERMINAL task alongside the live one.
    server.send({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "run",
        arguments: { command: ["true"], label: "shutdown-terminal-control" },
      },
    });
    const terminalRunLine = await server.nextLine();
    const terminalRunBody = terminalRunLine.parsed as RunResponseBody;
    const terminalTaskId = terminalRunBody.result?.structuredContent?.taskId as string;
    assert.equal(typeof terminalTaskId, "string");

    let terminalRecordBeforeShutdown: Record<string, unknown> | undefined;
    for (
      let attempt = 0;
      attempt < 100 && terminalRecordBeforeShutdown === undefined;
      attempt += 1
    ) {
      server.send({
        jsonrpc: "2.0",
        id: 200 + attempt,
        method: "tasks/get",
        params: { taskId: terminalTaskId },
      });
      const line = await server.nextLine();
      const body = line.parsed as TasksGetResponseBody;
      if (body.result?.status === "completed") terminalRecordBeforeShutdown = body.result;
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(
      terminalRecordBeforeShutdown !== undefined,
      "expected the control task to reach its own real terminal before shutdown"
    );

    // Trigger the real shutdown path via SIGTERM rather than stdin EOF.
    // src/server.ts documents both (plus SIGINT) as funneling through the
    // exact same shutdown() function, so this exercises identical reap
    // logic - see attachProcessShutdownHandlers's own docs. SIGTERM is used
    // here specifically because it leaves stdin open: the process only
    // calls process.exit(0) once its own async reap
    // (reapLiveJobsOnShutdown, bounded by SHUTDOWN_KILL_GRACE_PERIOD_MS for
    // the live task) has actually finished, and the transport keeps
    // answering requests for that whole window - unlike stdin EOF, which
    // closes the one channel a further request could ever travel over.
    server.child.kill("SIGTERM");

    // Nothing between the kill call above and a request landing proves that
    // request was served after the reap actually began - the signal
    // handler and the transport's own message dispatch are two separate
    // async paths with no ordering guarantee between them, so a request
    // sent right after the kill call could just as easily be answered
    // before shutdown's reap logic ever ran at all. The real barrier used
    // here instead: poll the live task's own status until it leaves
    // "working". reapOneJobOnShutdown's live-job branch marks that task
    // killed the moment it actually sends SIGTERM to its process group (see
    // killProcessGroupPosix's onSignaled callback, wired in
    // reapOneJobOnShutdown), so observing that transition is a direct proof
    // that shutdown() ran, reached reapLiveJobsOnShutdown, and
    // reapOneJobOnShutdown genuinely signaled the live task - all strictly
    // before the same Promise.all that also drives the control task's own
    // (here, already-reaped, so effectively no-op) reap step can settle and
    // the transport closes behind it.
    let liveStatusAfterKill: string | undefined;
    for (let attempt = 0; attempt < 200 && liveStatusAfterKill === undefined; attempt += 1) {
      server.send({
        jsonrpc: "2.0",
        id: 1000 + attempt,
        method: "tasks/get",
        params: { taskId: liveTaskId },
      });
      const pollLine = await server.nextLine();
      const pollBody = pollLine.parsed as TasksGetResponseBody;
      const status = pollBody.result?.status;
      if (status !== "working") liveStatusAfterKill = status as string;
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      liveStatusAfterKill,
      "cancelled",
      "expected the live task's own status to leave 'working' during shutdown - its absence would mean shutdown's reap pass was never actually observed to run before the control task's record is re-read below, so the re-read could not prove anything about ordering either"
    );

    server.send({
      jsonrpc: "2.0",
      id: 300,
      method: "tasks/get",
      params: { taskId: terminalTaskId },
    });
    const afterLine = await server.nextLine();
    const afterBody = afterLine.parsed as TasksGetResponseBody;
    assert.deepEqual(
      afterBody.result,
      terminalRecordBeforeShutdown,
      `expected the already-terminal control task's record to be byte-for-byte unchanged, read after the live task's own status was confirmed to have left "working" (proving shutdown's reap pass had genuinely started by this point) - before: ${JSON.stringify(terminalRecordBeforeShutdown)}, after: ${JSON.stringify(afterBody.result)}`
    );

    const exitResult = await Promise.race([
      server.waitForExit(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "shutdown did not complete within the bounded deadline on POSIX - a hang, not a clean reap"
              )
            ),
          8000
        )
      ),
    ]);
    assert.equal(exitResult.code, 0, "the server's own shutdown handler must exit cleanly");
    assert.equal(exitResult.signal, null);

    // THE proof: a REAL, independent `pgrep -g <pgid>` call AFTER
    // shutdown - the SAME reused oracle test/shutdown.test.ts's own
    // process-group-reap tests already establish - must show ZERO
    // survivors for the genuinely-live task's own process group.
    const afterMembers = await waitForPgrepGroupMembers(
      pgid,
      (members) => members.length === 0,
      3000
    );
    assert.deepEqual(
      afterMembers,
      [],
      `expected zero surviving process-group members after shutdown, pgrep still saw: ${JSON.stringify(afterMembers)}`
    );

    // The task record itself is confirmed gone too, once the process has
    // fully exited - not by querying it (the server PROCESS that held
    // jobStore, in memory, no longer exists to ask once it has actually
    // exited), but by the definitional fact that the process holding it has
    // now exited cleanly: there is no separate durable store it could have
    // survived in (see README.md's documented process-lifetime-only fact).
    // The read above, taken while the process was still alive mid-shutdown,
    // is what actually proves the reap left the already-terminal record
    // alone; this final exit is the proof that nothing survives the process
    // itself either.

    // Green control, confirmed by the SAME shutdown call succeeding
    // cleanly with both tasks present: the already-terminal control task
    // never caused shutdown to hang or error, and its record came back
    // unchanged from the read taken mid-shutdown above.
  }
);

// =============================================================================
// The wake proof, part 1: the plain-poll floor stays byte-stable (proven by
// the tests above) AND a deterministic SIMULATED/mock Tasks-capable client
// is genuinely woken by output flowing through the real adapter's
// notification path - never just the poll. Part 2 (a real installed
// Tasks-capable host auto-resuming) is explicitly disclosed-pending,
// verifiable only by hand once such a real host exists to test against -
// not asserted anywhere in this suite.
// =============================================================================

test("WAKE PROOF (SIMULATED/mock client only - never a real installed host): a deterministic mock Tasks-capable client is genuinely woken by real output flowing through the real adapter's notification path, independently corroborated by the poll floor", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await runJob(pair.client, {
      command: IDLE_COMMAND,
      label: "wake-proof-simulated",
    });
    jobId = minted.taskId as string;
    const received = registerWakeSpy(pair.client);

    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      jobStore.appendOutput(jobId, "stdout", line("wake-proof-simulated-line"));
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      received.length,
      1,
      "the SIMULATED mock capable client must observe exactly one real wake through the real notification path"
    );
    assert.deepEqual(
      (received[0]!.params.stdout as Array<{ text: string }>).map((entry) => entry.text),
      ["wake-proof-simulated-line"]
    );

    // The poll floor independently corroborates the same line, exactly as
    // a plain (non-Tasks) client would see it - never a substitute for the
    // wake proof above, an additional, independent surface confirming it.
    const outputResult = (await pair.client.callTool({
      name: "output",
      arguments: { job_id: jobId, stream: "stdout" },
    })) as { structuredContent?: { events?: Array<{ text: string }> } };
    const texts = (outputResult.structuredContent?.events ?? []).map((event) => event.text);
    assert.ok(texts.includes("wake-proof-simulated-line"));
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

test("STDERR WAKE PROOF (real spawned process, zero stdout): a command that writes ONLY to stderr and produces no stdout at all still wakes a capable client through the real adapter path - not a mixed-stream command, which would pass on the stdout path alone and prove nothing about this change", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const received = registerWakeSpy(pair.client);
    const minted = await runJob(pair.client, {
      command: [process.execPath, "-e", "process.stderr.write('real-stderr-only-line\\n');"],
      label: "stderr-wake-proof",
    });
    jobId = minted.taskId as string;

    // Real wall-clock wait, not a mocked clock: a genuinely spawned child's
    // stderr write travels through a real OS pipe, so this cannot be driven
    // by mock.timers the way the synthetic jobStore.appendOutput proofs
    // above are. Bounded polling for the wake to arrive, well past
    // WAKE_COALESCE_WINDOW_MS on each attempt.
    for (let attempt = 0; received.length === 0 && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(
      received.length,
      1,
      `expected exactly one real wake from a genuinely stderr-only command, got ${JSON.stringify(received)}`
    );
    assert.equal(
      received[0]!.params.stdout,
      undefined,
      "a genuinely stderr-only command's wake must carry no stdout key at all - proves this is not the stdout path passing incidentally"
    );
    const wakeStderr = received[0]!.params.stderr as Array<{ text: string }>;
    assert.deepEqual(
      wakeStderr.map((entry) => entry.text),
      ["real-stderr-only-line"]
    );

    // Confirm, independently of the wake, that the real command genuinely
    // produced zero stdout - the negative half of "stderr-only": without
    // this, a bug that silently duplicated the line onto stdout too would
    // still pass the assertions above.
    await pollTaskUntilTerminal(pair.client, jobId);
    const stdoutResult = (await pair.client.callTool({
      name: "output",
      arguments: { job_id: jobId, stream: "stdout" },
    })) as { structuredContent?: { events?: Array<{ text: string }> } };
    assert.deepEqual(
      stdoutResult.structuredContent?.events ?? [],
      [],
      "expected genuinely zero stdout events from a command that only ever wrote to stderr"
    );
    const stderrResult = (await pair.client.callTool({
      name: "output",
      arguments: { job_id: jobId, stream: "stderr" },
    })) as { structuredContent?: { events?: Array<{ text: string }> } };
    const stderrTexts = (stderrResult.structuredContent?.events ?? []).map((event) => event.text);
    assert.ok(stderrTexts.includes("real-stderr-only-line"));
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

test("TERMINAL ORDER (real spawned process, backgrounded grandchild): a job's terminal state never becomes observable before its last output line has arrived, even when a backgrounded grandchild inherits stdout and outlives the immediate child", async () => {
  const pair = await startPair(false);
  let jobId: string | undefined;
  try {
    // The immediate child backgrounds a subshell that inherits its stdout fd
    // and outlives it - an ordinary shell idiom (`some_task &`). The
    // immediate child's own `exit` fires well before the grandchild's
    // `sleep` returns and it writes its own line, and the stdout pipe's
    // `end` event does not fire until every process still holding that fd
    // open - including the grandchild - has closed it.
    //
    // The `trap '' TERM` is load-bearing against a SEPARATE mechanism, not
    // a workaround for anything this test is checking: `beginSpawn`'s own
    // `onExit` handler signals the job's whole process group the instant
    // the leader exits (`reapProcessGroupOnce`, this file's primary
    // leader-exit reap path). Without the trap, that signal reaches the
    // grandchild well before its 20ms sleep elapses and kills it before it
    // ever reaches its own `echo` - the line is lost, not merely delayed,
    // on BOTH the buggy and the fixed code, which makes the assertion
    // below vacuous either way. Trapping the signal lets the grandchild
    // finish its short sleep and write its line regardless of when the
    // reap's signal arrives, then exit voluntarily right after - well
    // inside the reap's own multi-second grace period, so this never
    // depends on an escalation to SIGKILL.
    const shellCommand =
      "(trap '' TERM; sleep 0.02; echo late-from-grandchild) & echo immediate-done";
    const minted = await runJob(pair.client, {
      command: shellCommand,
      shell: true,
      label: "terminal-order-grandchild",
    });
    jobId = minted.job_id as string;
    assert.equal(typeof jobId, "string");

    // The property under test: the FIRST poll to observe a terminal state
    // must already see the grandchild's delayed line in stdout. Reading
    // `output` immediately after `pollUntilTerminal` returns - not after any
    // further wait - is what makes this a genuine ordering assertion rather
    // than a timing coincidence: on the pre-fix code, `markExited` fires
    // synchronously in `onExit`, well before the grandchild's 20ms sleep has
    // elapsed, so the poll that first observes "terminal" sees only the
    // immediate child's own line, not the grandchild's. On the fix, the
    // terminal marking is deferred until stdout AND stderr have both ended,
    // which for this command only happens once the grandchild has also
    // closed its inherited stdout fd - by which point its line is already
    // in the buffer.
    await pollUntilTerminal(pair.client, jobId);
    const outputResult = (await pair.client.callTool({
      name: "output",
      arguments: { job_id: jobId, stream: "stdout" },
    })) as { structuredContent?: { events?: Array<{ text: string }> } };
    const texts = (outputResult.structuredContent?.events ?? []).map((event) => event.text);
    assert.ok(
      texts.includes("immediate-done"),
      `expected the immediate child's own line to have arrived, got: ${JSON.stringify(texts)}`
    );
    assert.ok(
      texts.includes("late-from-grandchild"),
      `expected the grandchild's delayed line to have already arrived by the time the job's ` +
        `terminal state first became observable, got: ${JSON.stringify(texts)}`
    );
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

test(
  "BOUNDED TERMINAL WAIT (real spawned process, process-group-escaped grandchild): a job's terminal state becomes observable within a normal poll bound even when a descendant has escaped this job's process group and holds a stream open indefinitely",
  { skip: process.platform === "win32" ? "POSIX process-group semantics only" : false },
  async () => {
    const pair = await startPair(false);
    let jobId: string | undefined;
    let escapedPid: number | undefined;
    const dir = mkdtempSync(path.join(tmpdir(), "ghantika-wake-escape-"));
    const marker = path.join(dir, "escaped-pid.txt");
    const escapeScriptPath = path.join(dir, "escape.mjs");
    // A descendant that detaches into its OWN process group - the same
    // primitive the `setsid` shell command wraps, invoked here through
    // Node's own `detached: true` rather than that command so this runs
    // on every platform in the matrix (macOS has no `setsid` binary by
    // default; Linux does). It holds this job's inherited stdout fd open
    // for 30s - well past `pollUntilTerminal`'s own default poll bound
    // (200 attempts * 20ms = 4s) below, which is what makes this test
    // genuinely discriminating rather than a coincidental pass: without
    // the reap-settled fallback, the terminal mark would wait on this
    // descendant's OWN 30s bound rather than the job's reap, and the poll
    // would time out first. 30s is still bounded, not indefinite, so a
    // missed explicit reap in this test's cleanup below still
    // self-terminates rather than leaking a real process.
    writeFileSync(
      escapeScriptPath,
      [
        `import { spawn } from "node:child_process";`,
        `import { writeFileSync } from "node:fs";`,
        `const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000);"], {`,
        `  detached: true,`,
        `  stdio: ["ignore", "inherit", "inherit"],`,
        `});`,
        `writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
        `child.unref();`,
      ].join("\n")
    );
    try {
      const shellCommand = `${process.execPath} ${escapeScriptPath}; echo immediate-done`;
      const minted = await runJob(pair.client, {
        command: shellCommand,
        shell: true,
        label: "terminal-order-escaped-grandchild",
      });
      jobId = minted.job_id as string;
      assert.equal(typeof jobId, "string");

      const pidText = await waitForFile(marker, {
        until: (content) => content.trim().length > 0,
      });
      escapedPid = Number(pidText.trim());
      assert.ok(
        Number.isInteger(escapedPid) && escapedPid > 0,
        `expected a real numeric pid, got ${JSON.stringify(pidText)}`
      );

      // The property under test: even though the escaped descendant is
      // still alive and still holding this job's stdout fd open, the
      // FIRST poll to observe a terminal state arrives within the poll's
      // own ordinary bound (4s at the default 200 attempts * 20ms) -
      // never hangs waiting on a stream `end` this job's own process-
      // group reap has no way to produce, since the escaped descendant is
      // no longer a member of the group `reapProcessGroupOnce` signals.
      const terminalStatus = await pollUntilTerminal(pair.client, jobId);
      assert.ok(
        terminalStatus.state === "exited" || terminalStatus.state === "killed",
        `expected a real terminal state, got: ${JSON.stringify(terminalStatus)}`
      );
    } finally {
      if (jobId !== undefined) await killAndReapRealChild(jobId);
      if (escapedPid !== undefined) {
        try {
          process.kill(escapedPid, "SIGKILL");
        } catch {
          // Already gone - its own 30s bound elapsed, or this ran after a
          // prior cleanup already reaped it. Either way, nothing to do.
        }
      }
      await pair.close();
    }
  }
);
