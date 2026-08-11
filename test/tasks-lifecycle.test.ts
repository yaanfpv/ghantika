/**
 * The tasked wait lifecycle - keepalive / TTL / output-driven
 * wake (coalesced, rate-bounded, firehose-guarded) / terminal-flush
 * ordering / the output-arrival seam. Real client, real in-process
 * transport, real server - the SAME `createServer()`-over-`InMemoryTransport`
 * pattern `test/tasks.test.ts` already establishes, run IN-PROCESS
 * (never a spawned child) specifically so this file can:
 *
 *   1. drive `jobStore` DIRECTLY (imported from `../dist/jobStore.js`,
 *      the SAME module instance the in-process server itself uses, via
 *      Node's own ESM module cache - see test/jobStore.test.ts's own
 *      "singleton-sharing regression" docs for why this is only possible
 *      in-process) to feed deterministic, test-controlled stdout/stderr
 *      arrival, independent of real process scheduling jitter; and
 *   2. control time deterministically via `node:test`'s own `mock.timers`
 *      (never a real wall-clock sleep standing in for a timing assertion) -
 *      mocking `setTimeout`/`Date` globally, in THIS file's own process
 *      only (`run()`'s default `isolation: "process"` gives every test
 *      FILE its own Node process, so this file's mocking can never affect
 *      or be affected by any other test file running concurrently).
 *
 * `mock.timers` is enabled/reset PER TEST (never left dangling across
 * tests), and NEVER enabled around a call that exercises the real,
 * timer-driven kill sequence (`src/process.ts`'s own `setTimeout`-based
 * `waitForProcessDeath` polling) - a real kill/cleanup call always runs
 * with REAL timers restored first, so this file never risks the mocked
 * clock stalling `process.ts`'s own internal waits. Real-process fixtures
 * (a job's own backing command) are used throughout for realism and
 * genuine teardown (isProcessAlive/pgrep verification, no zombies) even
 * in tests whose OUTPUT is entirely synthetic - the fixture command
 * itself just idles (`setTimeout(() => {}, ...)`, produces nothing on its
 * own), letting the test drive stdout/stderr arrival directly.
 *
 * SCOPE NOTE: this file exercises the tasked wait lifecycle end to end -
 * keepalive status, TTL purge, the output-driven notification wake, AND
 * (below) `tasks/cancel`'s REAL kill-and-reap behavior: a real,
 * grandchild-deep process tree bound to the job's original POSIX process
 * group is genuinely signalled and reaped through `tasks/cancel` itself
 * (never the raw `kill` tool). Under the released contract
 * `tasks/cancel` returns a FIXED, empty acknowledgement regardless of
 * outcome (eventually consistent by design - it carries no status of its
 * own at all), so the cancel ack and the job's real terminal observation
 * are asserted as two DISTINCT steps for a different reason than before:
 * the ack is verified (via this file's own wire tap) to be exactly the
 * fixed shape every time, and ONLY a later, separate `tasks/get` proves
 * the kill actually took effect - never inferred from the ack. The real
 * terminal-status mapping is proven for every case tasks/cancel can
 * actually reach - a job that exited non-zero, a job that never spawned at
 * all, and a genuinely malformed request. The disclosed setsid()-escape
 * boundary this containment inherits from `src/tools/kill.ts` is proven
 * there, not duplicated here.
 * `test/tasks.test.ts`'s own "interim contract" tests keep covering
 * `tasks/update`'s read-only behavior and `tasks/cancel`'s unchanged
 * idempotent no-op on an already-terminal or unknown taskId - this file is
 * where a LIVE task's real cancellation is proven.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { StandardSchemaV1, Transport } from "@modelcontextprotocol/server";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import { createServer } from "../dist/server.js";
import { type OutputArrivalEvent, jobStore } from "../dist/jobStore.js";
import { isProcessAlive, killProcessGroupPosix } from "../dist/process.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  FIREHOSE_LINES_PER_SEC,
  FIREHOSE_SUSTAINED_MS,
  GHANTIKA_OUTPUT_WAKE_METHOD,
  TASKS_EXTENSION_URI,
  TASKS_NOTIFICATION_METHOD,
  TASK_TTL_MS,
  WAKE_COALESCE_WINDOW_MS,
  WAKE_MAX_RATE_PER_SEC,
  WATCH_STOP_REASON_FIREHOSE,
  getTask,
} from "../dist/tasksAdapter.js";

// ---------------------------------------------------------------------------
// Harness - mirrors test/tasks.test.ts's own startPair/tasksRequest/mintJob
// shape (never re-invented differently), so both files exercise the
// identical real client/server contract.
// ---------------------------------------------------------------------------

/**
 * See test/tasks.test.ts's own header ("why the harness itself grew a wire
 * tap") for the full grounding: the SDK Client's own decode pipeline
 * strips the wire-level `resultType` discriminator before any caller ever
 * sees the parsed result, on EVERY method, not just `tools/call` - so
 * `tasks/cancel`'s real emitted ack (`{resultType: "complete"}`, per
 * the released contract) decodes to a genuinely EMPTY object
 * through `tasksCancel`'s own `client.request(..., passthroughSchema())`
 * call below. This file's own "real kill-and-reap through tasks/cancel"
 * tests need to observe the ack's real wire shape directly, which only the
 * tap can do.
 */
interface WireTap {
  readonly latestResultFor: (method: string) => Record<string, unknown> | undefined;
}

function attachWireTap(clientTransport: Transport, serverTransport: Transport): WireTap {
  const methodById = new Map<unknown, string>();
  const resultByMethod = new Map<string, Record<string, unknown>>();

  const originalClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => {
    const candidate = message as { id?: unknown; method?: unknown };
    if (
      candidate &&
      typeof candidate === "object" &&
      typeof candidate.method === "string" &&
      "id" in candidate
    ) {
      methodById.set(candidate.id, candidate.method);
    }
    return originalClientSend(message, options);
  };

  const originalServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, options) => {
    const candidate = message as { id?: unknown; result?: unknown };
    if (candidate && typeof candidate === "object" && "result" in candidate) {
      const method = methodById.get(candidate.id);
      if (method !== undefined) {
        resultByMethod.set(method, candidate.result as Record<string, unknown>);
      }
    }
    return originalServerSend(message, options);
  };

  return { latestResultFor: (method) => resultByMethod.get(method) };
}

interface Pair {
  readonly client: Client;
  readonly wireTap: WireTap;
  readonly close: () => Promise<void>;
}

let pairCounter = 0;

async function startPair(capable = true): Promise<Pair> {
  pairCounter += 1;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const wireTap = attachWireTap(clientTransport, serverTransport);
  const instance = createServer(serverTransport);
  await instance.server.connect(instance.transport);

  const client = new Client(
    { name: `ghantika-tasks-lifecycle-test-client-${pairCounter}`, version: "0.0.0" },
    capable ? { capabilities: { extensions: { [TASKS_EXTENSION_URI]: {} } } } : {}
  );
  await client.connect(clientTransport);

  return {
    client,
    wireTap,
    close: () => instance.shutdown("tasks-lifecycle.test.ts complete"),
  };
}

/** A permissive Standard Schema that accepts any value unchanged - used only to read the raw params of a custom (non-spec) notification/request, mirroring test/tasks.test.ts's own `passthroughResultSchema`. */
function passthroughSchema(): StandardSchemaV1<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "ghantika-tasks-lifecycle-test",
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

async function tasksCancel(client: Client, taskId: string): Promise<Record<string, unknown>> {
  const result = await client.request(
    { method: "tasks/cancel", params: { taskId } },
    passthroughSchema()
  );
  return result as Record<string, unknown>;
}

function runResultStructured(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  assert.equal(typeof structured, "object");
  return structured as Record<string, unknown>;
}

/**
 * Calls `run()` on a CAPABLE connection and returns the CLIENT-DECODED
 * minted result directly - never via `runResultStructured` above, because
 * a minted result on the released-contract adapter has no
 * `structuredContent` at all (the whole `CallToolResult` object IS the
 * flat `CreateTaskResult`, cast - see `src/tasksAdapter.ts`'s own
 * `maybeAugmentRunResult` docs, and `test/tasks.test.ts`'s own header for
 * the full grounding). Every real `run()` call in this file runs on a
 * `startPair(true)` (or the file's own default-capable `startPair()`)
 * connection and expects a mint, so this is used everywhere - the ONE
 * genuinely plain (`startPair(false)`) call in this file reads
 * `structuredContent` directly inline instead (see that test's own
 * comment), never through a shared plain-run helper (there being only the
 * one call site made a dedicated `runJob` unnecessary here, unlike
 * test/tasks.test.ts and test/wake-integration.test.ts, which need both).
 */
async function mintJob(
  client: Client,
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: "run",
    arguments: { command: ["true"], ...overrides },
  });
  assert.notEqual((result as { isError?: boolean }).isError, true);
  return result as unknown as Record<string, unknown>;
}

/** An idle, real, backing command that produces NOTHING on its own - the fixture every synthetic-output test uses so it has a genuine process to mint a task around, kill, and reap, while the test itself drives all observable stdout/stderr through direct jobStore calls. */
const IDLE_COMMAND = [process.execPath, "-e", "setTimeout(() => {}, 600000);"];

// ---------------------------------------------------------------------------
// Real external process-group observer - the SAME pgrep pattern
// test/kill.test.ts's own centerpiece and test/harness.ts already
// establish, never this codebase's own bookkeeping.
// ---------------------------------------------------------------------------

function pgrepGroupMembers(pgid: number): number[] {
  try {
    const output = execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(Number);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number };
    if (err.status === 1) return []; // pgrep's own "nothing matched" exit code
    throw error;
  }
}

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

/** Polls a real external `pgrep -g <pgid>` read until `condition` holds, or returns whatever the LAST read was once `timeoutMs` elapses - the same shape test/harness.ts's own `waitForPgrepGroupMembers` establishes, kept local here (matching this file's own established self-contained-helper convention - see `pgrepGroupMembers` above) rather than imported. */
async function waitForPgrepGroupMembers(
  pgid: number,
  condition: (members: number[]) => boolean,
  timeoutMs: number
): Promise<number[]> {
  const start = Date.now();
  for (;;) {
    const members = pgrepGroupMembers(pgid);
    if (condition(members)) return members;
    if (Date.now() - start > timeoutMs) return members;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** True once `content` (a marker file's raw bytes) holds a single, complete, newline-terminated positive integer - a real pid or pgid. A shell `echo $$ > marker` redirect can be observed mid-write, and the leading digits of a longer pid parse as a perfectly valid (but wrong, truncated) smaller integer - the trailing newline is what says the whole number actually landed. */
function parsesAsSinglePid(content: string): boolean {
  if (!content.endsWith("\n")) return false;
  const text = content.trim();
  if (!/^\d+$/.test(text)) return false;
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 0;
}

/** Polls a marker file for a COMPLETE single pid/pgid, never mere existence - a file appears the instant a shell redirect opens it, well before any bytes land (see `parsesAsSinglePid`'s own docs). */
async function waitForPidMarker(filePath: string, timeoutMs = 8000): Promise<number> {
  const start = Date.now();
  let lastRead: string | undefined;
  for (;;) {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf8");
      lastRead = content;
      if (parsesAsSinglePid(content)) return Number(content.trim());
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        lastRead === undefined
          ? `timed out waiting for ${filePath} to appear`
          : `timed out waiting for ${filePath} to hold a complete pid; last read ${JSON.stringify(lastRead)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Kills the REAL backing process for `jobId` via the real, real-timer-driven process-group primitives (never the mocked clock - callers must `mock.timers.reset()` BEFORE calling this) and confirms, via a real external check, that it is genuinely gone. A no-op (nothing to verify) if the job never had a tracked child at all. */
async function killAndReapRealChild(jobId: string): Promise<void> {
  const handle = jobStore.getChildHandle(jobId);
  if (handle === undefined) return;
  await killProcessGroupPosix(handle.pid, 500);
  await waitForRealDeath(handle.pid);
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

// ---------------------------------------------------------------------------
// The wake spy - a real handler registered on the MOCK CLIENT's own
// notification dispatch, never an adapter-internal counter. `fallback`
// asserts NO notification of any OTHER method ever arrives, which is the
// other half of the "exact, not substring" proof: a near-miss
// method name would route to fallback, not to the exact-string handler
// below, and this makes that observable as a hard failure rather than a
// silent non-match.
// ---------------------------------------------------------------------------

interface WakeNotification {
  readonly params: Record<string, unknown>;
}

function registerWakeSpy(client: Client): WakeNotification[] {
  const received: WakeNotification[] = [];
  client.setNotificationHandler(
    GHANTIKA_OUTPUT_WAKE_METHOD,
    { params: passthroughSchema() },
    (params) => {
      received.push({ params: params as Record<string, unknown> });
    }
  );
  // The released spec's own `notifications/tasks` per-transition status
  // notification (src/tasksAdapter.ts's own startTaskStatusNotifier, added
  // by a later story than this file's own tests otherwise cover - see
  // test/wake-integration.test.ts for the tests that actually exercise
  // this surface) fires on the SAME terminal transitions many of this
  // file's own tests already drive, on a GENUINELY SEPARATE subscription
  // from the one above. Registered here with a real, silently-discarding
  // handler purely so it never routes to `fallbackNotificationHandler`
  // below - that handler exists to catch a mistyped/near-miss METHOD NAME
  // on GHANTIKA_OUTPUT_WAKE_METHOD itself (this file's own exact-string
  // proof, below), never to assert that no OTHER, entirely legitimate
  // notification this codebase now also sends could ever exist.
  client.setNotificationHandler(TASKS_NOTIFICATION_METHOD, { params: passthroughSchema() }, () => {
    // Intentionally discarded - not this file's concern, see the comment
    // above.
  });
  client.fallbackNotificationHandler = async (notification) => {
    assert.fail(
      `received a notification via a method OTHER than the exact "${GHANTIKA_OUTPUT_WAKE_METHOD}" or "${TASKS_NOTIFICATION_METHOD}" strings: ${JSON.stringify(notification)}`
    );
  };
  return received;
}

/** A real ISO-8601 millisecond timestamp shape - used to check `watchStopped.stoppedAt`'s FORMAT; exact-value checks against a real, tracked mocked instant are done separately per test. */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A single stdout line's buffer form - a plain "text\n" encode, matching real stream traffic. */
function line(text: string): Buffer {
  return Buffer.from(`${text}\n`);
}

// ---------------------------------------------------------------------------
// Keepalive: a real, deterministic never-completing job stays
// status:'working' (exact-equality) across repeated tasks/get reads; ONLY
// a real terminal event, a tool error, or a cancel is terminal. Explicit
// cleanup: the fixture job is killed+reaped at teardown, verified by a
// real-liveness observation.
// ---------------------------------------------------------------------------

test("a real never-completing job keeps tasks/get status EXACTLY 'working' across repeated reads, and is killed+reaped at teardown with zero real survivors", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await mintJob(pair.client, { command: IDLE_COMMAND, label: "keepalive" });
    jobId = minted.taskId as string;
    assert.equal(typeof jobId, "string");

    for (let i = 0; i < 5; i += 1) {
      const taskGet = await tasksGet(pair.client, jobId);
      assert.equal(
        taskGet.status,
        "working",
        `read #${i}: keepalive task must read EXACTLY 'working', got ${JSON.stringify(taskGet.status)}`
      );
      assert.equal(taskGet.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const handle = jobStore.getChildHandle(jobId);
    assert.ok(handle, "expected the keepalive job to have a real tracked child");
    assert.ok(isProcessAlive(handle.pid), "expected the keepalive job's real process to be alive");
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// TTL purge, frozen separation. TTL purge REMOVES a completed
// record after TASK_TTL_MS; a still-'working' task of the SAME age
// SURVIVES regardless (the terminal-only guard). `Date` is mocked
// (`setTimeout` stays real, so real polling below is unaffected) so the
// test never waits out TASK_TTL_MS in real wall-clock time.
// ---------------------------------------------------------------------------

test("TTL purge removes a completed record past TASK_TTL_MS while a still-working task of the SAME age survives untouched - one sweep, both directions", async () => {
  const pair = await startPair(true);
  let workingJobId: string | undefined;
  try {
    // A quick, real command that completes almost immediately.
    const completedMinted = await mintJob(pair.client, {
      command: ["true"],
      label: "ttl-completed-fixture",
    });
    const completedJobId = completedMinted.taskId as string;
    await pollUntilTerminal(pair.client, completedJobId);
    const completedBefore = await tasksGet(pair.client, completedJobId);
    assert.equal(completedBefore.status, "completed");

    // A real, still-working job started at the SAME rough age.
    const workingMinted = await mintJob(pair.client, {
      command: IDLE_COMMAND,
      label: "ttl-working-fixture",
    });
    workingJobId = workingMinted.taskId as string;
    const workingBefore = await tasksGet(pair.client, workingJobId);
    assert.equal(workingBefore.status, "working");

    const realNow = Date.now();
    mock.timers.enable({ apis: ["Date"], now: realNow });
    try {
      // Not yet past TTL - both must read exactly as they did before.
      mock.timers.tick(TASK_TTL_MS - 1000);
      assert.equal((await tasksGet(pair.client, completedJobId)).status, "completed");
      assert.equal((await tasksGet(pair.client, workingJobId)).status, "working");

      // Past TTL now - the SAME sweep of reads must disagree: the
      // completed one is purged (throws task_not_found - the released
      // contract's own -32602 error, never a tagged success value), the
      // still-working one is untouched (still 'working', never an
      // 'expired' status of any kind - the closed four-value TASK_STATUSES
      // set has no such member).
      mock.timers.tick(2000); // TASK_TTL_MS - 1000 + 2000 > TASK_TTL_MS
      await assert.rejects(
        () => tasksGet(pair.client, completedJobId),
        (error: unknown) => {
          const message = String((error as { message?: unknown })?.message ?? error);
          return /-32602|not found|task_not_found/i.test(message);
        },
        "expected the completed record to be purged past TTL, throwing task_not_found"
      );
      const workingAfter = await tasksGet(pair.client, workingJobId);
      assert.equal(
        workingAfter.status,
        "working",
        "a still-working task of the SAME age must NEVER be purged, regardless of age - the terminal-only guard"
      );
    } finally {
      mock.timers.reset();
    }
  } finally {
    if (workingJobId !== undefined) await killAndReapRealChild(workingJobId);
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// TTL purge must NEVER reclaim a job whose concurrency slot is still
// stranded: deleteJob cannot touch activeSlots (a store-wide counter, not
// part of any one job's own record), so purging a stranded job's record
// erases the only durable, attributable trace of a held slot while the
// slot itself stays held forever with no path back. Driven directly
// against the singleton jobStore (`../dist/jobStore.js`, the SAME module
// instance getTask itself reads from) with a synthetic stranded release -
// a real kernel-forced unconfirmed reap cannot be produced deterministically
// from a test, exactly as this repo's own reap-once tests document, so this
// exercises the safety property directly via releaseSlot's own public
// contract. `getTask`'s own `now` parameter (mirroring
// `process.checkProcessIdentity`'s pattern) makes this deterministic with
// no real wall-clock wait and no `mock.timers` needed.
// ---------------------------------------------------------------------------

test("TTL purge REFUSES a job whose concurrency slot is still stranded, however far past TASK_TTL_MS it is - and purges it normally the moment a later reap actually confirms", async () => {
  // Drives the singleton jobStore directly (getTask itself has no
  // injectable-store seam - see this file's own header), so, matching
  // every other test in this file, opens a real pair purely for
  // createServer()'s own documented side effect of reopening the
  // shutdown gate at construction time: an earlier test's pair.close()
  // leaves that gate closed, and requestSlot() below would otherwise
  // reject as "shutting-down" rather than exercising the real admission
  // path this test needs.
  const pair = await startPair(true);
  const job = jobStore.createJob({
    argv: ["true"],
    cwd: "/tmp",
    env: {},
    isShell: false,
    label: "ttl-stranded-fixture",
  });
  try {
    assert.deepEqual(jobStore.requestSlot(), { kind: "admit" });
    jobStore.markExited(job.job_id, 0, null);
    await jobStore.releaseSlot(job.job_id, Promise.resolve("unconfirmed"));
    assert.equal(jobStore.isJobSlotStranded(job.job_id), true, "expected the slot to be stranded");

    const endedAtMs = Date.parse(jobStore.get(job.job_id)!.ended_at!);
    const wayPastTtl = endedAtMs + TASK_TTL_MS * 10; // far past TTL, not just barely

    // A refusal to purge is now the ABSENCE of a throw (getTask() returns
    // the real snapshot normally) - the released contract's own
    // throw-on-purge design (see src/tasksAdapter.ts's taskNotFoundError
    // docs) means there is no longer a tagged "found but refused" value to
    // distinguish structurally; simply reaching the assertions below
    // without an exception already proves the refusal, and the status
    // check confirms it is a genuine, untouched snapshot.
    const stillStranded = getTask(job.job_id, wayPastTtl);
    assert.equal(
      stillStranded.status,
      "completed",
      `TTL purge must refuse a still-stranded job however far past TTL it is (returning its real, untouched snapshot), got ${JSON.stringify(stillStranded)}`
    );
    assert.equal(
      jobStore.has(job.job_id),
      true,
      "the record itself must survive, not just the read"
    );
    assert.equal(
      jobStore.isJobSlotStranded(job.job_id),
      true,
      "the stranded slot's own tracking entry must survive too - that IS the durable recovery/observability record this guard exists to protect"
    );

    // The guard is temporary, tied to stranded status - not a permanent
    // block that would itself leak memory forever. Once a later reap
    // actually confirms (the automatic retry's or a manual kill()'s own
    // commit path), the SAME job becomes purgeable again on a subsequent
    // read past TTL, exactly like any other terminal record.
    await jobStore.releaseSlot(job.job_id, Promise.resolve("confirmed"));
    assert.equal(
      jobStore.isJobSlotStranded(job.job_id),
      false,
      "expected recovery to clear stranding"
    );

    // getTask THROWS (task_not_found, -32602) rather than returning a
    // tagged success value once genuinely purged - see
    // src/tasksAdapter.ts's own taskNotFoundError docs.
    assert.throws(
      () => getTask(job.job_id, wayPastTtl),
      (error: unknown) => {
        const message = String((error as { message?: unknown })?.message ?? error);
        return /-32602|not found|task_not_found/i.test(message);
      },
      "expected a NOW-confirmed, still-past-TTL record to purge normally, throwing task_not_found"
    );
    assert.equal(
      jobStore.has(job.job_id),
      false,
      "expected deleteJob to have actually run this time"
    );
  } finally {
    jobStore.deleteJob(job.job_id); // safe no-op if the recovery branch above already purged it
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// The output-driven wake: exact notification method name,
// output-driven per-batch delta on either stream, time-window batching.
// All driven via DIRECT jobStore.appendOutput calls on a real, minted,
// idle-backed task - deterministic content and timing, never real process
// scheduling jitter.
// ---------------------------------------------------------------------------

test("the output-delta wake's notification method is the EXACT string 'notifications/ghantika/outputWake' - a mistyped/near-miss method would route to the fallback handler instead, which is asserted to never fire", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await mintJob(pair.client, { command: IDLE_COMMAND, label: "exact-method" });
    jobId = minted.taskId as string;
    const received = registerWakeSpy(pair.client);

    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      jobStore.appendOutput(jobId, "stdout", line("exact-method-line"));
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    } finally {
      mock.timers.reset();
    }

    // Give the notification microtask a chance to run - `server.notification`
    // resolves asynchronously even though the mocked timer fired
    // synchronously.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(received.length, 1, `expected exactly one wake, got ${JSON.stringify(received)}`);

    // Suppressed-notification case: a SEPARATE, non-subscribing
    // client must still observe everything via the poll floor. Registering
    // NEITHER a handler NOR a fallback for a method means the SDK's own
    // dispatch silently drops it client-side - the terminal must still be
    // observable via tasks/get and output regardless.
    const quiet = await startPair(true);
    try {
      const quietMinted = await mintJob(quiet.client, {
        command: [process.execPath, "-e", "process.stdout.write('suppressed-poll-floor\\n');"],
        label: "suppressed-notifications",
      });
      const quietJobId = quietMinted.taskId as string;
      await pollUntilTerminal(quiet.client, quietJobId);
      const quietGet = await tasksGet(quiet.client, quietJobId);
      assert.equal(quietGet.status, "completed");
      const outputResult = (await quiet.client.callTool({
        name: "output",
        arguments: { job_id: quietJobId },
      })) as { structuredContent?: { events?: Array<{ text: string }> } };
      const texts = (outputResult.structuredContent?.events ?? []).map((event) => event.text);
      assert.ok(
        texts.includes("suppressed-poll-floor"),
        `expected the poll floor to surface the real line even with no notification handler registered, got ${JSON.stringify(texts)}`
      );
    } finally {
      await quiet.close();
    }
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

test("one stdout batch fires one wake carrying EXACTLY that batch's new stdout delta, deepEqual against the poll floor's own view of the same lines - never the cumulative buffer", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await mintJob(pair.client, { command: IDLE_COMMAND, label: "batch-delta" });
    jobId = minted.taskId as string;
    const received = registerWakeSpy(pair.client);

    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      jobStore.appendOutput(
        jobId,
        "stdout",
        Buffer.concat([line("alpha"), line("beta"), line("gamma")])
      );
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(received.length, 1);
    const wake = received[0]!.params;
    assert.equal(wake.extension, TASKS_EXTENSION_URI);
    assert.equal(wake.taskId, jobId);
    const wakeStdout = wake.stdout as Array<{ seq: number; text: string; partial?: true }>;
    assert.deepEqual(
      wakeStdout.map((entry) => entry.text),
      ["alpha", "beta", "gamma"],
      "the wake's stdout delta must contain EXACTLY this batch's lines, in order"
    );
    for (const entry of wakeStdout) assert.equal(entry.partial, undefined);

    // Cross-check against the poll floor's own canonical view of the SAME
    // lines - proves the wake never carries state the poll floor can't
    // independently surface.
    const outputResult = (await pair.client.callTool({
      name: "output",
      arguments: { job_id: jobId, stream: "stdout" },
    })) as {
      structuredContent?: { events?: Array<{ seq: number; text: string; partial?: true }> };
    };
    const polledEvents = (outputResult.structuredContent?.events ?? []).map((event) => ({
      seq: event.seq,
      text: event.text,
      ...(event.partial ? { partial: event.partial } : {}),
    }));
    assert.deepEqual(
      wakeStdout,
      polledEvents,
      "the wake's stdout delta must deepEqual the poll floor's own view of the same lines"
    );
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

test("with the wake handler entirely unregistered on a capable connection, tasks/get + output/tail still surface every line and the terminal identically to pre-Tasks (Phase 1) behavior", async () => {
  const pair = await startPair(true); // capable connection, but no wake handler ever registered
  let jobId: string | undefined;
  try {
    const minted = await mintJob(pair.client, {
      command: [process.execPath, "-e", "process.stdout.write('phase1-a\\nphase1-b\\n');"],
      label: "poll-floor-parity",
    });
    jobId = minted.taskId as string;
    await pollUntilTerminal(pair.client, jobId);

    const taskGet = await tasksGet(pair.client, jobId);
    assert.equal(taskGet.status, "completed");

    const tailResult = (await pair.client.callTool({
      name: "tail",
      arguments: { job_id: jobId, lines: 5 },
    })) as { structuredContent?: { events?: Array<{ text: string }> } };
    const tailTexts = (tailResult.structuredContent?.events ?? []).map((entry) => entry.text);
    assert.deepEqual(tailTexts, ["phase1-a", "phase1-b"]);
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

test("a stderr-only batch wakes on its own carrying ONLY the stderr key; a batch mixing both streams in the SAME window wakes once carrying BOTH keys", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await mintJob(pair.client, { command: IDLE_COMMAND, label: "stderr-wakes" });
    jobId = minted.taskId as string;
    const received = registerWakeSpy(pair.client);

    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      jobStore.appendOutput(jobId, "stderr", line("stderr-only-line"));
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(received.length, 1, "a stderr-only batch must wake exactly once, on its own");
    assert.equal(
      received[0]!.params.stdout,
      undefined,
      "a stderr-only wake must not carry a stdout key at all"
    );
    const wakeStderr = received[0]!.params.stderr as Array<{ text: string }>;
    assert.deepEqual(
      wakeStderr.map((entry) => entry.text),
      ["stderr-only-line"]
    );

    // stderr is ALSO observable via the poll floor - the wake is additive,
    // never a substitute for it.
    const outputResult = (await pair.client.callTool({
      name: "output",
      arguments: { job_id: jobId, stream: "stderr" },
    })) as { structuredContent?: { events?: Array<{ text: string }> } };
    const stderrTexts = (outputResult.structuredContent?.events ?? []).map((event) => event.text);
    assert.deepEqual(stderrTexts, ["stderr-only-line"]);

    // A batch mixing both streams within the SAME open window collapses
    // into ONE wake carrying both keys, not two separate wakes.
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      jobStore.appendOutput(jobId, "stdout", line("mixed-stdout-line"));
      jobStore.appendOutput(jobId, "stderr", line("mixed-stderr-line"));
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(received.length, 2, "the mixed batch must add exactly one more wake");
    const mixedWake = received[1]!.params;
    assert.deepEqual(
      (mixedWake.stdout as Array<{ text: string }>).map((entry) => entry.text),
      ["mixed-stdout-line"]
    );
    assert.deepEqual(
      (mixedWake.stderr as Array<{ text: string }>).map((entry) => entry.text),
      ["mixed-stderr-line"]
    );
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

test("lines within one WAKE_COALESCE_WINDOW_MS window collapse into ONE wake; two batches more than the window apart fire TWO wakes - deterministic injected clock, never a real sleep", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await mintJob(pair.client, { command: IDLE_COMMAND, label: "coalesce-window" });
    jobId = minted.taskId as string;
    const received = registerWakeSpy(pair.client);

    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      jobStore.appendOutput(jobId, "stdout", line("w1-a"));
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS - 10);
      jobStore.appendOutput(jobId, "stdout", line("w1-b"));
      mock.timers.tick(10); // exactly closes window 1 (w1-a's own scheduled timer)
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 1, "both lines within one window must collapse into ONE wake");
    assert.deepEqual(
      (received[0]!.params.stdout as Array<{ text: string }>).map((entry) => entry.text),
      ["w1-a", "w1-b"]
    );

    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      jobStore.appendOutput(jobId, "stdout", line("w2"));
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS + 1); // opens and closes a SECOND, later window
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      received.length,
      2,
      "a batch more than one window later must fire a SECOND, distinct wake"
    );
    assert.deepEqual(
      (received[1]!.params.stdout as Array<{ text: string }>).map((entry) => entry.text),
      ["w2"]
    );
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// Firehose rate-limit + auto-stop, and its required green control
// (a bounded stream stays completely untouched).
// ---------------------------------------------------------------------------

/** One synthetic stdout line's worth of bytes for the firehose fixtures below - short and cheap to materialize many thousands of times per test. */
function firehoseLine(i: number): Buffer {
  return Buffer.from(`f${i}\n`);
}

function manyFirehoseLines(count: number): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < count; i += 1) parts.push(firehoseLine(i));
  return Buffer.concat(parts);
}

test("a sustained firehose rate rate-limits wakes and auto-stops ONLY the notification watch - the job stays alive/pollable, the terminal is later observable, and zero wakes fire after the stop", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await mintJob(pair.client, { command: IDLE_COMMAND, label: "firehose-trigger" });
    jobId = minted.taskId as string;
    const received = registerWakeSpy(pair.client);

    // Derived directly from the exported constants (never magic literals):
    // TICK_MS ticks, each carrying LINES_PER_TICK synthetic lines - a
    // sustained rate of LINES_PER_TICK/TICK_MS*1000 (a 20% margin over
    // FIREHOSE_LINES_PER_SEC), sustained for TICKS_NEEDED ticks so the
    // cumulative elapsed span reaches (and this ticks one further, to
    // cross) FIREHOSE_SUSTAINED_MS. With the window anchored on the very
    // first line and never resetting (every subsequent line's own
    // computed rate stays above threshold throughout), the auto-stop
    // triggers deterministically on the FIRST line of the LAST call below
    // - at real-elapsed TICKS_NEEDED * TICK_MS, i.e. the first tick count
    // whose cumulative span is >= FIREHOSE_SUSTAINED_MS.
    const TICK_MS = 1000;
    const LINES_PER_TICK = Math.ceil(((FIREHOSE_LINES_PER_SEC * TICK_MS) / 1000) * 1.2);
    const TICKS_NEEDED = Math.ceil(FIREHOSE_SUSTAINED_MS / TICK_MS);

    const realStart = Date.now();
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: realStart });
    let stoppedAtBeforeReset: string | undefined;
    try {
      jobStore.appendOutput(jobId, "stdout", manyFirehoseLines(LINES_PER_TICK));
      for (let i = 0; i < TICKS_NEEDED; i += 1) {
        mock.timers.tick(TICK_MS);
        jobStore.appendOutput(jobId, "stdout", manyFirehoseLines(LINES_PER_TICK));
      }

      const taskGet = await tasksGet(pair.client, jobId);
      assert.equal(
        taskGet.status,
        "working",
        "the JOB must still be 'working' - only the watch stopped"
      );
      // A still-WORKING task carries the watch-stop fact rendered as TEXT
      // into statusMessage, per the released contract - see
      // src/tasksAdapter.ts's own renderWatchStoppedStatusMessage docs (a
      // working task has no result/error container the way a terminal task
      // does, so there is no structured watchStopped field to read here at
      // all anymore).
      const statusMessage = taskGet.statusMessage as string | undefined;
      assert.ok(
        statusMessage,
        `expected statusMessage to be present, got ${JSON.stringify(taskGet)}`
      );
      const rendered = statusMessage!.match(/^output watch auto-stopped \(([^)]+)\) at (.+)$/);
      assert.ok(
        rendered,
        `expected statusMessage to match the rendered watch-stop format, got ${JSON.stringify(statusMessage)}`
      );
      const [, renderedReason, renderedStoppedAt] = rendered!;
      assert.equal(renderedReason, WATCH_STOP_REASON_FIREHOSE);
      assert.match(renderedStoppedAt!, ISO_TIMESTAMP_PATTERN);
      const expectedStoppedAt = new Date(realStart + TICKS_NEEDED * TICK_MS).toISOString();
      assert.equal(
        renderedStoppedAt,
        expectedStoppedAt,
        "the rendered stoppedAt must equal the EXACT injected-clock stop instant"
      );
      stoppedAtBeforeReset = renderedStoppedAt;

      const wakeCountAtStop = received.length;
      const totalSpanSec = (TICKS_NEEDED * TICK_MS) / 1000;
      assert.ok(
        wakeCountAtStop <= WAKE_MAX_RATE_PER_SEC * Math.ceil(totalSpanSec) + 1,
        `expected the wake rate to stay bounded at <= ${WAKE_MAX_RATE_PER_SEC}/sec, got ${wakeCountAtStop} wakes over a ~${totalSpanSec}s window`
      );

      // Emitting further output after auto-stop must fire ZERO additional wakes.
      jobStore.appendOutput(jobId, "stdout", line("after-firehose-stop"));
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS * 2);
      assert.equal(
        received.length,
        wakeCountAtStop,
        "no additional wake may fire once the watch has auto-stopped"
      );

      // The watch's own onJobTerminal subscription must already be gone at
      // this point too - not merely inert, genuinely unsubscribed. A
      // callback that merely goes inert via its own "if (stopped) return"
      // guard, without ever calling its own unsubscribe, would stay
      // registered until the job's eventual TTL purge; this assertion
      // would not catch that as a leak by itself, since inert and
      // unregistered look identical to any caller that never inspects the
      // listener count directly.
      //
      // The count this asserts is 2: two genuinely SEPARATE, independent
      // `onJobTerminal` subscribers share the same guard block in
      // `maybeAugmentRunResult` alongside the watch under test here - the
      // `notifications/tasks` per-transition status notifier
      // (startTaskStatusNotifier, see its own docs) and the
      // transport-layer wake subscriber (startTransportWakeOnTerminal, see
      // its own docs - gated OFF by default via
      // GHANTIKA_WAKE_TRANSPORT_ENABLED, but its SUBSCRIPTION is
      // unconditional). Both must still be live here, since the job has
      // not reached its real terminal transition yet - only the OTHER
      // watch auto-stopped. If startTaskWatch's own listener were ever
      // left registered instead of genuinely unsubscribed, this count
      // would read 3 (the leaked one plus both siblings' own live ones),
      // not 2.
      assert.equal(
        jobStore.getJobTerminalListenerCount(jobId),
        2,
        "expected exactly the two independent onJobTerminal subscribers (notifications/tasks status notifier + transport-layer wake) to remain - the auto-stopped watch's own listener must be genuinely unsubscribed, not merely left inert"
      );
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setImmediate(resolve));

    // The job stays genuinely alive and pollable via output - the watch
    // stopping never touches the backing process.
    const handle = jobStore.getChildHandle(jobId);
    assert.ok(
      handle && isProcessAlive(handle.pid),
      "the backing job must still be a live real process"
    );
    const outputResult = (await pair.client.callTool({
      name: "output",
      arguments: { job_id: jobId, stream: "stdout", limit: 1 },
    })) as { isError?: boolean };
    assert.notEqual(
      outputResult.isError,
      true,
      "output must still work normally on the firehosed job"
    );

    // The real, later terminal is STILL observable through tasks/get once
    // the job actually ends - the auto-stop never blinds tasks/get to the
    // real terminal transition.
    await killAndReapRealChild(jobId);
    const finalGet = await tasksGet(pair.client, jobId);
    assert.equal(finalGet.status, "cancelled");
    assert.ok(stoppedAtBeforeReset, "sanity: the earlier stoppedAt capture must have happened");
  } finally {
    if (jobId !== undefined && jobStore.getChildHandle(jobId) !== undefined) {
      await killAndReapRealChild(jobId);
    }
    await pair.close();
  }
});

test("green control: a bounded stream UNDER FIREHOSE_LINES_PER_SEC runs to its normal terminal completely UNTOUCHED - the watch is never auto-stopped", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await mintJob(pair.client, {
      command: IDLE_COMMAND,
      label: "firehose-green-control",
    });
    jobId = minted.taskId as string;
    const received = registerWakeSpy(pair.client);

    // Well under the threshold: 10 lines per 200ms tick == 50 lines/sec,
    // for 12 ticks (2400ms) - comfortably longer than FIREHOSE_SUSTAINED_MS
    // (2000ms), and FIREHOSE_LINES_PER_SEC (5000) is two orders of
    // magnitude above this rate.
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
      taskGet.statusMessage,
      undefined,
      "a bounded, under-threshold stream must NEVER trigger the firehose auto-stop (no statusMessage rendered)"
    );
    assert.ok(received.length > 0, "the watch must still have delivered normal wakes throughout");

    // Runs to its normal (here: killed) terminal, untouched by any
    // firehose guard. A CancelledTaskResult carries no result/error
    // container at all on the released contract, so there is no
    // watchStopped field of any shape to check here anymore - the
    // never-auto-stopped claim is already fully proven by the
    // still-working check above.
    await killAndReapRealChild(jobId);
    const finalGet = await tasksGet(pair.client, jobId);
    assert.equal(finalGet.status, "cancelled");
    assert.equal(finalGet.result, undefined);
    assert.equal(finalGet.error, undefined);
  } finally {
    if (jobId !== undefined && jobStore.getChildHandle(jobId) !== undefined) {
      await killAndReapRealChild(jobId);
    }
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// Exit ends the watch: the terminal is reached, the exit code is
// reported (both 0 and non-zero), and the job/process is genuinely reaped.
// ---------------------------------------------------------------------------

test("a REAL exit-0 job reports exitCode 0 and is genuinely reaped, and further synthetic output after exit fires ZERO wakes (the watch really stopped)", async () => {
  const pair = await startPair(true);
  const minted = await mintJob(pair.client, {
    command: [process.execPath, "-e", "process.exit(0);"],
    label: "exit-zero",
  });
  const jobId = minted.taskId as string;
  const received = registerWakeSpy(pair.client);
  const handle = jobStore.getChildHandle(jobId);
  assert.ok(handle, "expected a real tracked child before exit");

  try {
    await pollUntilTerminal(pair.client, jobId);
    await waitForRealDeath(handle!.pid);

    const taskGet = await tasksGet(pair.client, jobId);
    assert.equal(taskGet.status, "completed");
    assert.equal((taskGet.result as Record<string, unknown> | undefined)?.exitCode, 0);

    const beforeCount = received.length;
    jobStore.appendOutput(jobId, "stdout", line("after-exit-should-not-wake"));
    await new Promise((resolve) => setTimeout(resolve, WAKE_COALESCE_WINDOW_MS + 50));
    assert.equal(
      received.length,
      beforeCount,
      "no wake may fire once the job's own exit has ended the watch"
    );
  } finally {
    await pair.close();
  }
});

test("a REAL non-zero exit job reports its exact exit code and is genuinely reaped", async () => {
  const pair = await startPair(true);
  const minted = await mintJob(pair.client, {
    command: [process.execPath, "-e", "process.exit(7);"],
    label: "exit-nonzero",
  });
  const jobId = minted.taskId as string;
  const handle = jobStore.getChildHandle(jobId);
  assert.ok(handle, "expected a real tracked child before exit");

  try {
    await pollUntilTerminal(pair.client, jobId);
    await waitForRealDeath(handle!.pid);

    const taskGet = await tasksGet(pair.client, jobId);
    assert.equal(taskGet.status, "completed");
    assert.equal((taskGet.result as Record<string, unknown> | undefined)?.exitCode, 7);
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// Terminal flush ordering: stdout buffered inside an OPEN window at
// the moment of terminal is flushed as a final wake BEFORE the terminal
// close completes; NO wake fires for the terminal transition itself, and
// NO wake fires after. The terminal transition here is forced
// DIRECTLY via jobStore.markKilled (bypassing the real kill sequence
// entirely) so the mocked clock never has to interact with process.ts's
// own real-timer-driven wait - the real underlying process is separately,
// genuinely killed+reaped afterward, with real timers restored first.
// ---------------------------------------------------------------------------

test("lines emitted inside an open coalescing window, then terminal forced before WAKE_COALESCE_WINDOW_MS elapses - the pending batch arrives as ONE final pre-close wake, and ZERO wakes fire after", async () => {
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await mintJob(pair.client, { command: IDLE_COMMAND, label: "flush-ordering" });
    jobId = minted.taskId as string;
    const received = registerWakeSpy(pair.client);

    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      jobStore.appendOutput(jobId, "stdout", Buffer.concat([line("pending-1"), line("pending-2")]));
      // The window is open (WAKE_COALESCE_WINDOW_MS hasn't elapsed) -
      // force the terminal transition NOW, directly, before ever ticking.
      jobStore.markKilled(jobId, "SIGTERM-test-forced");
      // The flush call itself runs synchronously inside markKilled's own
      // fireJobTerminal dispatch, but actual DELIVERY to the mock client
      // (server.notification -> InMemoryTransport.send -> the client's
      // own Promise.resolve().then(...)-deferred dispatch) is
      // asynchronous - settle that before asserting on `received`.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        received.length,
        1,
        "the pending open-window lines must flush as ONE wake, at the moment of terminal"
      );
      assert.deepEqual(
        (received[0]!.params.stdout as Array<{ text: string }>).map((entry) => entry.text),
        ["pending-1", "pending-2"]
      );

      // Advancing time past the window's own original deadline must fire
      // NOTHING further - the watch was stopped synchronously above.
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS * 3);
      assert.equal(received.length, 1, "no wake may fire after the terminal close");
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      received.length,
      1,
      "still exactly one wake after settling any pending microtasks"
    );

    const taskGet = await tasksGet(pair.client, jobId);
    assert.equal(taskGet.status, "cancelled");
  } finally {
    // markKilled only touched the STATE record - the real underlying
    // process is still alive and must be genuinely killed+reaped
    // separately, with real timers (mock.timers is already reset above).
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// The notification is optional; proof here is via a SIMULATED/mock
// capable client + the poll floor. Real-host auto-resume (a genuine
// installed Tasks-capable GUI host observing the notification and
// resuming on its own) is explicitly DISCLOSED-PENDING - launch-gated on
// the maintainer's own machine, never asserted here.
// ---------------------------------------------------------------------------

test("the wake path is proven here via a SIMULATED/mock capable client and the poll floor only - real-host auto-resume is explicitly disclosed-pending, not asserted from this suite", async () => {
  // This test asserts nothing new; it exists to carry, in the test
  // suite itself, the explicit label that
  // separates what THIS suite proves from what remains disclosed-pending:
  //
  //   PROVEN HERE (simulated/mock):
  //     - a mock @modelcontextprotocol/client, driven entirely by this
  //       test file, receives notifications/ghantika/outputWake wakes with
  //       the exact delta on either stream (stdout, stderr, or both
  //       together in one window), respects the coalescing window,
  //       rate-limits and auto-stops under a firehose,
  //       and the poll floor (tasks/get + output/tail) surfaces
  //       everything regardless of whether the wake handler is
  //       registered at all.
  //
  //   DISCLOSED-PENDING (launch-gated, NOT proven by this suite):
  //     - that a REAL, installed Tasks-capable GUI host (an actual MCP
  //       client application, not this test's hand-rolled mock) is
  //       genuinely auto-resumed by the optional notification when it
  //       arrives. That claim can only be verified by hand, on the
  //       maintainer's own machine, against a real such host once one
  //       exists to test against - never inferred from this suite's own
  //       mock/poll proof, however thorough.
  const pair = await startPair(true);
  let jobId: string | undefined;
  try {
    const minted = await mintJob(pair.client, {
      command: IDLE_COMMAND,
      label: "wake-path-label-only",
    });
    jobId = minted.taskId as string;
    const received = registerWakeSpy(pair.client);

    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      jobStore.appendOutput(jobId, "stdout", line("wake-path-simulated-line"));
      mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    } finally {
      mock.timers.reset();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 1, "the simulated/mock client path must observe the wake");

    const outputResult = (await pair.client.callTool({
      name: "output",
      arguments: { job_id: jobId, stream: "stdout" },
    })) as { structuredContent?: { events?: Array<{ text: string }> } };
    const texts = (outputResult.structuredContent?.events ?? []).map((event) => event.text);
    assert.ok(
      texts.includes("wake-path-simulated-line"),
      "the poll floor must independently surface the same line"
    );
  } finally {
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// The output-arrival seam itself: a generic, core-decoupled
// subscribe/listener mechanism on src/jobStore.ts's JobStore.appendOutput.
// The first two tests below drive a real run() path with a real spawned
// process, proving multi-line, in-order delivery; the remaining tests use
// a synthetic job (jobStore.createJob - no real child at all, matching
// this file's own established low-level-mechanics convention) for byte-
// exact control over split-chunk/stream-end/unsubscribe/isolation, none of
// which need real process timing.
// ---------------------------------------------------------------------------

test("a registered listener receives each REAL stdout line, in order, as the REAL run.ts -> jobStore.appendOutput path materializes them", async () => {
  const pair = await startPair(false); // non-capable: no tasksAdapter watch competes for the same listener slot
  const scratchDir = mkdtempSync(path.join(tmpdir(), "ghantika-seam-real-path-"));
  const goMarker = path.join(scratchDir, "go");
  try {
    // The child spins on `goMarker`'s existence before writing anything, so
    // its real output can only arrive AFTER this test has subscribed - a
    // real process race, closed deterministically rather than papered over
    // with an `if (received.length > 0)` guard that would pass vacuously on
    // zero observed lines.
    // Inlined rather than routed through the shared runJob/mintJob helpers
    // below: this is the ONE genuinely PLAIN (non-minting) run() call in
    // this whole file (startPair(false) above), so it reads the ordinary
    // structuredContent-nested job_id directly.
    const runResult = await pair.client.callTool({
      name: "run",
      arguments: {
        command: [
          process.execPath,
          "-e",
          `const fs=require('fs');const m=${JSON.stringify(goMarker)};while(!fs.existsSync(m)){}process.stdout.write('seam-1\\nseam-2\\nseam-3\\n');`,
        ],
        label: "seam-real-path",
      },
    });
    assert.notEqual((runResult as { isError?: boolean }).isError, true);
    const minted = runResultStructured(runResult);
    const jobId = minted.job_id as string;

    const received: OutputArrivalEvent[] = [];
    const unsubscribe = jobStore.onOutputArrival(jobId, (event) => {
      received.push(event);
    });
    try {
      writeFileSync(goMarker, "go");
      await pollUntilTerminal(pair.client, jobId);
      assert.ok(
        received.length > 0,
        "expected at least one real stdout line via the real path - zero observed lines is a failure, not a vacuous pass"
      );
      assert.deepEqual(
        received.map((event) => event.line.text),
        ["seam-1", "seam-2", "seam-3"],
        "lines received via the real path must arrive in exact materialization order"
      );
      for (const event of received) assert.equal(event.stream, "stdout");
    } finally {
      unsubscribe();
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
    await pair.close();
  }
});

test("a synthetic MULTI-LINE chunk delivers one event per line, IN ORDER, via jobStore.appendOutput directly", () => {
  const record = jobStore.createJob({
    argv: ["synthetic-seam-multiline"],
    cwd: process.cwd(),
    env: {},
    isShell: false,
  });
  const received: OutputArrivalEvent[] = [];
  const unsubscribe = jobStore.onOutputArrival(record.job_id, (event) => received.push(event));
  try {
    jobStore.appendOutput(
      record.job_id,
      "stdout",
      Buffer.concat([line("m1"), line("m2"), line("m3")])
    );
    assert.deepEqual(
      received.map((event) => event.line.text),
      ["m1", "m2", "m3"]
    );
    for (const event of received) {
      assert.equal(event.stream, "stdout");
      assert.equal(event.line.terminator, "newline");
    }
  } finally {
    unsubscribe();
  }
});

test("a SPLIT-CHUNK partial line is held until completed, then delivered WHOLE - no event fires for the incomplete half", () => {
  const record = jobStore.createJob({
    argv: ["synthetic-seam-split"],
    cwd: process.cwd(),
    env: {},
    isShell: false,
  });
  const received: OutputArrivalEvent[] = [];
  const unsubscribe = jobStore.onOutputArrival(record.job_id, (event) => received.push(event));
  try {
    jobStore.appendOutput(record.job_id, "stdout", Buffer.from("partial-fi"));
    assert.equal(received.length, 0, "an incomplete line must not fire any event yet");
    jobStore.appendOutput(record.job_id, "stdout", Buffer.from("rst-line\n"));
    assert.equal(received.length, 1);
    assert.equal(received[0]!.line.text, "partial-first-line");
    assert.equal(received[0]!.line.terminator, "newline");
  } finally {
    unsubscribe();
  }
});

test("a STREAM-END partial (no trailing newline) is materialized at close, firing exactly one event", () => {
  const record = jobStore.createJob({
    argv: ["synthetic-seam-streamend"],
    cwd: process.cwd(),
    env: {},
    isShell: false,
  });
  const received: OutputArrivalEvent[] = [];
  const unsubscribe = jobStore.onOutputArrival(record.job_id, (event) => received.push(event));
  try {
    jobStore.appendOutput(record.job_id, "stdout", Buffer.from("no-trailing-newline"));
    assert.equal(received.length, 0);
    jobStore.finalizeStream(record.job_id, "stdout");
    assert.equal(received.length, 1);
    assert.equal(received[0]!.line.text, "no-trailing-newline");
    assert.equal(received[0]!.line.terminator, "stream-end");
  } finally {
    unsubscribe();
  }
});

test("UNSUBSCRIBE stops further delivery to that listener - later lines are simply never seen by it", () => {
  const record = jobStore.createJob({
    argv: ["synthetic-seam-unsubscribe"],
    cwd: process.cwd(),
    env: {},
    isShell: false,
  });
  const received: OutputArrivalEvent[] = [];
  const unsubscribe = jobStore.onOutputArrival(record.job_id, (event) => received.push(event));
  jobStore.appendOutput(record.job_id, "stdout", line("before-unsubscribe"));
  assert.equal(received.length, 1);
  unsubscribe();
  jobStore.appendOutput(record.job_id, "stdout", line("after-unsubscribe"));
  assert.equal(received.length, 1, "no further event may reach an unsubscribed listener");
  assert.equal(received[0]!.line.text, "before-unsubscribe");
});

test("ISOLATION: a listener registered on job A never receives job B's lines, and the seam stays core-decoupled (jobStore.ts carries no Tasks-specific import - enforced separately by scripts/check-no-tasks-import.mjs)", () => {
  const jobA = jobStore.createJob({
    argv: ["synthetic-seam-isolation-a"],
    cwd: process.cwd(),
    env: {},
    isShell: false,
  });
  const jobB = jobStore.createJob({
    argv: ["synthetic-seam-isolation-b"],
    cwd: process.cwd(),
    env: {},
    isShell: false,
  });
  const receivedA: OutputArrivalEvent[] = [];
  const receivedB: OutputArrivalEvent[] = [];
  const unsubA = jobStore.onOutputArrival(jobA.job_id, (event) => receivedA.push(event));
  const unsubB = jobStore.onOutputArrival(jobB.job_id, (event) => receivedB.push(event));
  try {
    jobStore.appendOutput(jobA.job_id, "stdout", line("only-for-a"));
    jobStore.appendOutput(jobB.job_id, "stdout", line("only-for-b"));

    assert.deepEqual(
      receivedA.map((event) => event.line.text),
      ["only-for-a"]
    );
    assert.deepEqual(
      receivedB.map((event) => event.line.text),
      ["only-for-b"]
    );
  } finally {
    unsubA();
    unsubB();
  }
});

// ---------------------------------------------------------------------------
// tasks/cancel: REAL kill-and-reap of the job's ORIGINAL process group,
// reusing src/tools/kill.ts's own POSIX-process-group containment (never
// reimplementing it) - proven end to end through the Tasks adapter surface
// itself (tasks/cancel, never the raw "kill" tool), non-vacuously, with the
// cancel acknowledgement and a later, separate tasks/get terminal
// observation asserted as two distinct steps.
// ---------------------------------------------------------------------------

test("tasks/cancel kills and reaps a real grandchild-deep process tree bound to the job's original process group: the direct child and grandchild are observed live and RECORDED before any cancel is issued, the grandchild confirmed a member of the job's original pgid; the cancel acknowledgement is asserted independently; the recorded pids are confirmed gone afterward via a real external process-group observer, never the cancel call's own return value alone; and a LATER, separate tasks/get call independently confirms the cancelled terminal", async () => {
  const pair = await startPair(true);
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-cancel-tree-"));
  let jobId: string | undefined;
  try {
    const pgidMarker = path.join(dir, "pgid.txt");
    const childMarker = path.join(dir, "child.txt");
    const grandchildMarker = path.join(dir, "grandchild.txt");
    // A real shell tree three levels deep. The top-level shell is the
    // job's own leader (and, since spawnManaged always spawns detached,
    // the process group's own pgid). It backgrounds a subshell - the
    // CHILD, a real, distinct forked process - and captures that
    // subshell's own real pid via `$!` in THIS outer shell, immediately
    // after backgrounding it: `$$` INSIDE a backgrounded subshell reports
    // the PARENT shell's pid in every POSIX shell (bash and dash both), so
    // `$!` in the parent is the only portable way to capture the
    // subshell's own real identity. The subshell in turn backgrounds a
    // real `sleep` - the GRANDCHILD - capturing ITS pid via its OWN `$!`,
    // then `wait`s on it, which is what keeps the whole three-level tree
    // (leader -> child -> grandchild), all sharing the leader's original
    // process group (none of them ever call setsid()), genuinely alive
    // until cancelled.
    const shellCommand =
      `echo $$ > '${pgidMarker}'; ` +
      `( sleep 300 & echo $! > '${grandchildMarker}'; wait ) & ` +
      `echo $! > '${childMarker}'; ` +
      `wait`;

    const minted = await mintJob(pair.client, {
      command: shellCommand,
      shell: true,
      label: "cancel-grandchild-tree",
    });
    jobId = minted.taskId as string;
    assert.equal(typeof jobId, "string");

    // -------------------------------------------------------------------
    // PRE-CANCEL LIVENESS, anti-vacuity: the direct child AND the
    // grandchild are observed live and RECORDED, the grandchild confirmed
    // a member of the job's ORIGINAL process group, BEFORE any cancel is
    // issued. Synchronizing on this real, external state - never a fixed
    // sleep, never merely "the fixture was launched" - is what rules out
    // cancel winning a race against the grandchild's own fork: if cancel
    // could ever run before the grandchild genuinely exists in this group,
    // this wait is exactly what would time out rather than silently
    // passing having proven nothing.
    // -------------------------------------------------------------------
    const pgid = await waitForPidMarker(pgidMarker);
    const childPid = await waitForPidMarker(childMarker);
    const grandchildPid = await waitForPidMarker(grandchildMarker);
    assert.notEqual(
      childPid,
      grandchildPid,
      "the child and grandchild must be genuinely distinct real processes"
    );
    assert.notEqual(childPid, pgid, "the child must be distinct from the leader/pgid");
    assert.notEqual(grandchildPid, pgid, "the grandchild must be distinct from the leader/pgid");

    const beforeMembers = await waitForPgrepGroupMembers(
      pgid,
      (members) => members.includes(childPid) && members.includes(grandchildPid),
      8000
    );
    assert.ok(
      beforeMembers.includes(childPid),
      `expected the direct child (pid ${childPid}) to be a live member of the original pgid ${pgid} BEFORE cancel, pgrep saw: ${JSON.stringify(beforeMembers)}`
    );
    assert.ok(
      beforeMembers.includes(grandchildPid),
      `expected the grandchild (pid ${grandchildPid}) to be a live member of the SAME original pgid ${pgid} BEFORE cancel - the non-vacuity proof this test exists for - pgrep saw: ${JSON.stringify(beforeMembers)}`
    );
    assert.ok(isProcessAlive(childPid), "expected the direct child to be alive before cancel");
    assert.ok(isProcessAlive(grandchildPid), "expected the grandchild to be alive before cancel");

    // -------------------------------------------------------------------
    // CANCEL ACK: tasks/cancel returns the released spec's own fixed,
    // empty acknowledgement (`{resultType: "complete"}`) - eventually
    // consistent by design, so it deliberately carries NO status/taskId/
    // extension field of any kind (see src/tasksAdapter.ts's own
    // cancelTask docs; previously the ack WAS a fresh snapshot and this
    // section asserted its status already
    // reflected the kill). The client-decoded value is genuinely EMPTY
    // (the SDK strips the wire-level resultType before this test ever sees
    // it - see this file's own WireTap docs), so the real ack shape is
    // read via the wire tap instead. Confirmation that the kill actually
    // took effect is now what the LATER, separate tasks/get read below
    // proves - never inferred from this ack.
    // -------------------------------------------------------------------
    const cancelAck = await tasksCancel(pair.client, jobId);
    assert.deepEqual(
      cancelAck,
      {},
      `expected tasks/cancel's client-decoded ack to be genuinely empty (only resultType, which the SDK strips), got ${JSON.stringify(cancelAck)}`
    );
    const rawCancelAck = pair.wireTap.latestResultFor("tasks/cancel");
    assert.deepEqual(
      rawCancelAck,
      { resultType: "complete" },
      `expected tasks/cancel's real wire ack to be exactly the fixed emittedAckResult shape, got ${JSON.stringify(rawCancelAck)}`
    );

    // -------------------------------------------------------------------
    // POST-CANCEL DEATH: the pids RECORDED above are genuinely gone - an
    // observer bound to the ORIGINAL pgid finds no surviving member, and
    // the direct child (and the grandchild) are genuinely reaped. Real,
    // external process-state checks (pgrep + isProcessAlive), never a
    // trust in the cancel call's own return value alone.
    // -------------------------------------------------------------------
    const afterMembers = await waitForPgrepGroupMembers(
      pgid,
      (members) => members.length === 0,
      8000
    );
    assert.deepEqual(
      afterMembers,
      [],
      `expected zero surviving members of the ORIGINAL process group ${pgid} after tasks/cancel, pgrep still saw: ${JSON.stringify(afterMembers)}`
    );
    assert.equal(
      isProcessAlive(childPid),
      false,
      "expected the direct child to be genuinely gone after cancel"
    );
    assert.equal(
      isProcessAlive(grandchildPid),
      false,
      "expected the grandchild to be genuinely gone after cancel"
    );

    // -------------------------------------------------------------------
    // LATER TERMINAL: a LATER, SEPARATE tasks/get call - never inferred
    // from the cancel acknowledgement above - independently observes the
    // cancelled terminal status.
    // -------------------------------------------------------------------
    const laterGet = await tasksGet(pair.client, jobId);
    assert.equal(
      laterGet.status,
      "cancelled",
      `expected a LATER, separate tasks/get to report the cancelled terminal status, got ${JSON.stringify(laterGet)}`
    );
  } finally {
    // Best-effort safety net: if an earlier assertion above threw before
    // tasks/cancel ever ran (or before it could complete), this still
    // reaps the real backing process rather than leaking it - a no-op
    // when tasks/cancel already succeeded (see killAndReapRealChild's own
    // docs; every other test in this file follows the identical pattern).
    if (jobId !== undefined) await killAndReapRealChild(jobId);
    rmSync(dir, { recursive: true, force: true });
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// TERMINAL SHAPES vs PROTOCOL ERROR: tasks/cancel on an already-terminal
// job never errors and never varies its ack by the job's own outcome - the
// released contract's cancelTask (src/tasksAdapter.ts) always returns the
// same fixed, empty acknowledgement (see the CANCEL ACK section above),
// whether the job exited non-zero or never spawned at all. What DOES still
// vary by outcome is the job's own real terminal shape, which this test
// reads through a SEPARATE tasks/get call made after the cancel (never
// through cancel's own return value, which the released contract emptied
// out). A job that ran and exited non-zero reads as a normal "completed"
// taskResult, with the real exit code carried separately from status; a
// job that never spawned at all (a genuine spawn error) reads as a normal
// "failed" taskResult, a materially different case from a completed job
// whose command happened to fail. Neither of those is ever a JSON-RPC
// protocol error - only a genuinely malformed request (an empty taskId) is.
// ---------------------------------------------------------------------------

test("through tasks/cancel: the ack never varies by outcome, and a subsequent tasks/get shows a job that ran and exited non-zero as a normal completed taskResult (exit code carried separately from status), a job that never spawned at all as a normal failed taskResult, neither is ever a JSON-RPC protocol error, and only a genuinely malformed request (an empty taskId) is", async () => {
  const pair = await startPair(true);
  try {
    // Case 1: a job that RAN and exited non-zero. mapJobStateToTaskStatus
    // (src/tasksAdapter.ts) folds an "exited" job state to task status
    // "completed" REGARDLESS of its real exit code - the exit code travels
    // separately in the result, never folded into the status itself.
    const exitedJob = await mintJob(pair.client, {
      command: [process.execPath, "-e", "process.exitCode = 3;"],
      label: "cancel-completed-mapping",
    });
    const exitedJobId = exitedJob.taskId as string;
    await pollUntilTerminal(pair.client, exitedJobId);

    // tasks/cancel on this already-terminal job still succeeds (kills
    // nothing - see cancelTask's own docs on ignoring killTool's isError
    // outcomes) and returns the SAME fixed, empty ack as every other
    // cancel call, never a snapshot of the job it was just asked to kill.
    const exitedAck = await tasksCancel(pair.client, exitedJobId);
    assert.deepEqual(
      exitedAck,
      {},
      `expected tasks/cancel's client-decoded ack to be genuinely empty regardless of the job's own outcome, got ${JSON.stringify(exitedAck)}`
    );
    assert.deepEqual(
      pair.wireTap.latestResultFor("tasks/cancel"),
      { resultType: "complete" },
      "expected the real wire ack for an already-completed job's cancel to still be exactly the fixed emittedAckResult shape"
    );

    // The job's real terminal shape is read through a fresh, separate
    // tasks/get call - never inferred from the cancel ack above, which the
    // released contract emptied out.
    const exitedResult = await tasksGet(pair.client, exitedJobId);
    assert.equal(
      exitedResult.status,
      "completed",
      `expected a job that exited non-zero to read as task status 'completed' through a post-cancel tasks/get, got ${JSON.stringify(exitedResult)}`
    );
    assert.equal(
      (exitedResult.result as Record<string, unknown> | undefined)?.exitCode,
      3,
      "the real non-zero exit code must be reflected separately from status, not folded into it"
    );
    assert.equal(
      exitedResult.error,
      undefined,
      "a completed taskResult carries no error field at all - error belongs only to the separate taskNotFound shape"
    );

    // Case 2: a job that NEVER RAN - a genuine spawn-error (an executable
    // that doesn't resolve at all). mapJobStateToTaskStatus folds this
    // job-store "failed" state to task status "failed" - a DIFFERENT
    // status from case 1's "completed", since this task itself never ran,
    // distinct from a completed task whose command happened to exit
    // non-zero.
    const neverRanJob = await mintJob(pair.client, {
      command: ["this-command-definitely-does-not-exist-ghantika-cancel-test"],
      label: "cancel-failed-mapping",
    });
    const neverRanJobId = neverRanJob.taskId as string;
    await pollUntilTerminal(pair.client, neverRanJobId);

    // Same fixed ack again, this time for a job that never spawned at all
    // - proving the ack's shape truly does not vary by outcome.
    const neverRanAck = await tasksCancel(pair.client, neverRanJobId);
    assert.deepEqual(
      neverRanAck,
      {},
      `expected tasks/cancel's client-decoded ack to be genuinely empty for a never-spawned job too, got ${JSON.stringify(neverRanAck)}`
    );
    assert.deepEqual(
      pair.wireTap.latestResultFor("tasks/cancel"),
      { resultType: "complete" },
      "expected the real wire ack for a never-spawned job's cancel to still be exactly the fixed emittedAckResult shape"
    );

    const neverRanResult = await tasksGet(pair.client, neverRanJobId);
    assert.equal(
      neverRanResult.status,
      "failed",
      `expected a job that never spawned to read as task status 'failed' through a post-cancel tasks/get, got ${JSON.stringify(neverRanResult)}`
    );

    // Neither cancel call above ever threw, and neither of the two
    // tasks/get reads above did either - all resolved as normal,
    // successful RPC results (a JSON-RPC protocol error would have made
    // the `await` itself reject). That IS the "never a JSON-RPC error"
    // half of this criterion, asserted by the calls above having already
    // returned rather than a separate check.

    // Case 3: a genuinely malformed tasks/cancel request (an empty-string
    // taskId, failing this adapter's own request-validation schema - the
    // same request-validation boundary test/tasks.test.ts's own
    // completeness sweep already proves for all three tasks/* methods
    // generically) IS a real JSON-RPC protocol error - never silently
    // accepted, never converted into a normal task result of any shape.
    await assert.rejects(
      () =>
        pair.client.request(
          { method: "tasks/cancel", params: { taskId: "" } },
          passthroughSchema()
        ),
      (error: unknown) => {
        const message = String((error as { message?: unknown })?.message ?? error);
        return /-32602|invalid|taskId/i.test(message);
      },
      "expected tasks/cancel to reject an empty-string taskId as a genuine JSON-RPC protocol error, never as a normal (possibly isError) result"
    );
  } finally {
    await pair.close();
  }
});
