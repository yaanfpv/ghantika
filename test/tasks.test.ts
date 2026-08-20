/**
 * Real end-to-end coverage for the io.modelcontextprotocol/tasks adapter:
 * every test here drives a REAL `@modelcontextprotocol/client` `Client`
 * against a REAL `createServer()` instance over the SDK's own
 * `InMemoryTransport` (the same pattern `test/jobStore.test.ts`'s
 * singleton-sharing regression already uses) - never a bypass straight to
 * `dispatchToolCall` or `tasksAdapter`'s functions in isolation, because
 * the contract under test is what a real client observes on the wire:
 * capability negotiation, the run-only mint rule, the three registered
 * task methods, and the always-on plain poll floor.
 *
 * `startPair(capable)` builds one such real Client/Server pair, optionally
 * advertising `io.modelcontextprotocol/tasks` in the CLIENT's own
 * `initialize` capabilities - this is deliberately the ONLY per-test knob;
 * nothing here ever sets a per-request opt-in field, which is itself part
 * of what proves minting is connection-level, not per-request.
 *
 * ## Rewritten for the released-contract adapter - why the harness
 * itself grew a wire tap
 *
 * Previously, `maybeAugmentRunResult` returned a REAL, complete
 * `CallToolResult` (content + structuredContent both present) for a
 * minted task, so `client.callTool()`'s own decode pipeline passed every
 * field straight through untouched and a test could read `result.
 * structuredContent` directly. The released contract's `CreateTaskResult`
 * is a FLAT shape with no `content`/`structuredContent` at all - and two
 * real, EMPIRICALLY MEASURED facts about the installed
 * `@modelcontextprotocol/client`/`@modelcontextprotocol/server@2.0.0`
 * packages follow from that (verified for this story by wrapping a real
 * `InMemoryTransport` pair's `send` and inspecting the raw pre-decode
 * JSON-RPC messages directly, not inferred from reading types):
 *
 * 1. The wire-level `resultType` discriminator (`"task"` on a mint,
 *    `"complete"` on `tasks/get`/the acks) is stripped by the SDK's own
 *    legacy-era codec (`rev2025Codec.decodeResult`) BEFORE any caller -
 *    `client.callTool()`, or even `client.request(..., aFullyPermissive
 *    PassthroughSchema)` - ever sees the parsed result. There is NO way to
 *    observe `resultType` through the ordinary Client API on this era; it
 *    is consumed entirely inside the protocol layer.
 * 2. The installed server's own `tools/call` result encoding (the SAME
 *    `CallToolResultWireSchema` transform+pipe chain the client uses to
 *    decode) unconditionally injects a synthetic `content: []` onto ANY
 *    `tools/call` result missing `content` UNLESS that result already
 *    carries one of `["task", "inputRequests", "requestState"]` - the
 *    OLDER `input_required` result family's own escape hatch. This
 *    installed SDK version has not been taught the Tasks extension's own
 *    `resultType: "task"` as an equivalent family to protect, so a
 *    genuinely flat `CreateTaskResult` mint STILL reaches the wire with
 *    one extra key beyond what `tasksAdapter.ts`'s own `buildCreateTaskResult`
 *    constructs: `content: []`. This is a real, disclosed WIRE artifact of
 *    the installed SDK version, not a defect in this adapter (see
 *    `maybeAugmentRunResult`'s own doc comment in `src/tasksAdapter.ts`
 *    for the full grounding) - and it is bounded and asserted below, never
 *    silently tolerated or silently worked around.
 *
 * So this file adds `attachWireTap` (below): it wraps the transport pair's
 * `send` calls to capture the RAW, pre-decode JSON-RPC `result` object a
 * `tools/call`/`tasks/*` request actually receives - the only way to
 * observe `resultType`, and the only way to confirm the wire-exact shape
 * (including the one disclosed `content` artifact) against the vendored,
 * digest-verified schema. Field-VALUE assertions (taskId, status,
 * createdAt, exitCode, ...) still go through the ordinary
 * `client.callTool()`/`client.request()` path wherever that is sufficient
 * - those fields survive the SDK's decode untouched, only `resultType` (and,
 * for `tools/call` specifically, `content`) are affected.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { CallToolResult, StandardSchemaV1, Transport } from "@modelcontextprotocol/server";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import { createServer } from "../dist/server.js";
import { jobStore } from "../dist/jobStore.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  TASKS_CAPABILITY_DESCRIPTOR,
  TASKS_EXTENSION_URI,
  TASK_STATUSES,
  TASK_TTL_MS,
  isTaskStatusValue,
  taskIdParamsSchema,
} from "../dist/tasksAdapter.js";
// The test-harness-only watchdog `pollUntilKillConfirmed` (below) arms -
// see that helper's own header doc comment for the full "why".
import { armKillConfirmedWatchdog } from "./helpers/killConfirmedPollWatchdog.ts";

import { requireSpawnPolicy } from "./helpers/requireSpawnPolicy.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA_PATH = path.join(REPO_ROOT, "schema", "tasks-extension.schema.json");

// The following sections' tests mint a real job through the real `run`
// tool - see test/helpers/requireSpawnPolicy.ts for what this checks and
// why. The schema-validation controls, the capability-negotiation checks
// that never call run() (initialize-negotiation, the live registry
// set-equality introspection, and TASK_STATUSES-vs-schema), the taskId
// tests that only exercise an unknown/empty id, and the completeness
// sweep mint no job of their own - so requireSpawnPolicy is scoped via a
// local before() inside a describe() around only the tests that actually
// spawn (below), rather than run file-wide: node:test fails EVERY test in
// a file when a top-level before() hook throws, which would fail even the
// pure tests above (and the ones interleaved below) that never touch
// policy or spawn anything at all, the moment GHANTIKA_POLICY_FILE is
// unset.

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * See this file's own header ("why the harness itself grew a wire tap") for
 * the full grounding. Wraps the CLIENT transport's `send` (to record which
 * outgoing request id maps to which method) and the SERVER transport's
 * `send` (to record the raw, pre-decode `result` object each response
 * carries) - both wired BEFORE either side's `.connect()` runs, matching
 * `src/server.ts`'s own established pattern for observing a transport
 * without disturbing it (`Protocol.connect()` reads whatever
 * `transport.onmessage`/`.send` was already set at connect-time and
 * chains its own dispatch onto it - confirmed by that file's own header
 * doc, and `.send` specifically is looked up fresh on every call rather
 * than cached, so wrapping it is safe regardless of ordering relative to
 * `.connect()`).
 */
interface WireTap {
  /**
   * The most recent RAW `result` object the server actually sent back for
   * a request whose OUTGOING method was `method` - `undefined` if none
   * yet. Keyed by METHOD, not by request id, and always the MOST RECENT
   * one: correct for this suite's own usage (read immediately after the
   * one relevant call, before any later call of the SAME method), never a
   * general-purpose per-request correlation store.
   */
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

async function startPair(capable: boolean): Promise<Pair> {
  pairCounter += 1;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const wireTap = attachWireTap(clientTransport, serverTransport);
  const instance = createServer(serverTransport);
  await instance.server.connect(instance.transport);

  const client = new Client(
    { name: `ghantika-tasks-test-client-${pairCounter}`, version: "0.0.0" },
    capable ? { capabilities: { extensions: { [TASKS_EXTENSION_URI]: {} } } } : {}
  );
  await client.connect(clientTransport);

  return {
    client,
    wireTap,
    close: () => instance.shutdown("tasks.test.ts complete"),
  };
}

/** A permissive Standard Schema that accepts any value unchanged - used only to read the raw (post-decode, pre-resultType-strip is NOT possible here - see this file's header) result of a custom (non-spec) request via `Client.request`, mirroring `src/tasksAdapter.ts`'s own hand-rolled `taskIdParamsSchema` rather than pulling in a real validation library for a test-only need. */
function passthroughResultSchema(): StandardSchemaV1<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "ghantika-tasks-test",
      validate: (value: unknown) => ({ value }),
    },
  };
}

/**
 * Calls one of the three registered `tasks/*` methods and returns the
 * CLIENT-DECODED result - i.e. with `resultType` already stripped by the
 * SDK (see this file's header). Still the right tool for asserting on
 * field VALUES (taskId, status, createdAt, result/error, ...), which
 * survive the decode untouched. `tasks/update`/`tasks/cancel`'s ack
 * carries NOTHING but `resultType`, so their client-decoded result is a
 * genuinely EMPTY object (`{}`) - proven, not assumed, by this story's own
 * wire probe - which is why every test asserting on the ack's real shape
 * reads `pair.wireTap.latestResultFor(method)` instead of this helper's
 * return value.
 *
 * A THROWN error (an unknown/expired taskId's `task_not_found`, or an
 * empty-string taskId's request-validation rejection) propagates as a
 * REJECTED promise - never a tagged `{error: ...}` success value, matching
 * `tasksAdapter.ts`'s throw-based contract. Callers
 * expecting that use `assert.rejects`.
 */
async function tasksRequest(
  client: Client,
  method: "tasks/get" | "tasks/update" | "tasks/cancel",
  taskId: string
): Promise<Record<string, unknown>> {
  const result = await client.request({ method, params: { taskId } }, passthroughResultSchema());
  return result as Record<string, unknown>;
}

/** Same as `tasksRequest`, but for `tasks/update` with an explicit `inputResponses` param - the released spec's own request shape (`{taskId, inputResponses}`), never exercised by the plain `tasksRequest` helper above. */
async function tasksUpdateRequestWithInputResponses(
  client: Client,
  taskId: string,
  inputResponses: unknown
): Promise<Record<string, unknown>> {
  const result = await client.request(
    { method: "tasks/update", params: { taskId, inputResponses } },
    passthroughResultSchema()
  );
  return result as Record<string, unknown>;
}

function runResultStructured(result: CallToolResult | unknown): Record<string, unknown> {
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

/**
 * Calls `run()` on `pair` and returns the CLIENT-DECODED minted result -
 * NOT via `runResultStructured`/`runJob` above, because a minted result on
 * this adapter has no `structuredContent` at all (the whole
 * `CallToolResult` object IS the flat `CreateTaskResult`, cast - see
 * `maybeAugmentRunResult`'s own docs). The raw `client.callTool()` return
 * value itself carries `taskId`/`status`/`createdAt`/etc. directly (plus
 * the SDK's own synthetic `content: []` - see this file's header), never
 * nested under `.structuredContent`.
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

/**
 * Polls `jobStore` for `taskId` (== `job_id`, see tasksAdapter.ts's own
 * "taskId == job_id, one handle namespace" docs) to actually reach
 * `state`, rather than guessing a fixed delay for the real async
 * `onSpawn` callback (which drives `markRunning`, see src/jobStore.ts) to
 * have landed - the same real-predicate-poll shape as
 * test/process.test.ts's own local `waitFor`, scoped here to a job's real
 * recorded state.
 */
function waitForJobState(taskId: string, state: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (jobStore.get(taskId)?.state === state) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(
            `waitForJobState: timed out after ${timeoutMs}ms waiting for job ${taskId} to reach state "${state}" (currently "${jobStore.get(taskId)?.state}")`
          )
        );
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A real `Date#toISOString()` shape - shared by every check below that validates a genuinely nondeterministic (real wall-clock) timestamp field's FORMAT rather than skipping it outright. */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Validates that `record[field]` is a real ISO-8601 millisecond timestamp
 * for every field in `fields`, then returns a COPY of `record` with those
 * fields deleted - so the caller can still run a genuine `assert.deepEqual`
 * against a literal expected object for every OTHER field, without having
 * to skip timestamp fields' verification entirely.
 *
 * IMPORTANT: this ONLY checks shape (a real `Date#toISOString()` pattern) -
 * it does NOT by itself prove the value is genuine rather than a
 * stable-but-wrong placeholder. Closing that gap is the CALLER's job, not
 * this helper's: every call site below additionally brackets the parsed
 * timestamp against a real wall-clock window the test itself captured.
 */
function withTimestampFieldsChecked(
  record: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> {
  const rest = { ...record };
  for (const field of fields) {
    assert.match(
      rest[field] as string,
      ISO_TIMESTAMP_PATTERN,
      `expected "${field}" to be a real ISO-8601 millisecond timestamp, got ${JSON.stringify(rest[field])}`
    );
    delete rest[field];
  }
  return rest;
}

/**
 * Validates `record.last_wake_attempt`'s SHAPE when it is present, and does
 * nothing when it is not - matching every OTHER call site's own reasoning
 * for `identity_capture`/`pid`/`birth_identity`: whether
 * `startTransportWakeOnTerminal`'s fire-and-forget async handler
 * (`src/tasksAdapter.ts`) has settled by the moment a caller reads a
 * job's projection is a genuine timing race no plain (non-explicitly-
 * polling) call site in this file gates on, and its settled VALUE (which
 * transport, what detail string, whether the decline is permanent) depends
 * on the ambient environment this suite happens to run under - neither is
 * something a call site can pin to a literal. Never asserts PRESENCE;
 * only ever asserts that a PRESENT value is internally well-formed.
 */
function assertLastWakeAttemptStructurallyValidIfPresent(record: Record<string, unknown>): void {
  const wakeAttempt = record.last_wake_attempt as
    | {
        outcome?: unknown;
        transportName?: unknown;
        detail?: unknown;
        permanent?: unknown;
        attemptedAt?: unknown;
      }
    | undefined;
  if (wakeAttempt === undefined) return;

  assert.ok(
    ["delivered", "refused", "unavailable", "threw"].includes(wakeAttempt.outcome as string),
    `expected last_wake_attempt.outcome to be one of delivered/refused/unavailable/threw, got: ${JSON.stringify(wakeAttempt.outcome)}`
  );
  assert.equal(
    typeof wakeAttempt.transportName,
    "string",
    `expected last_wake_attempt.transportName to be a string, got: ${JSON.stringify(wakeAttempt.transportName)}`
  );
  assert.equal(
    typeof wakeAttempt.detail,
    "string",
    `expected last_wake_attempt.detail to be a string, got: ${JSON.stringify(wakeAttempt.detail)}`
  );
  assert.equal(
    typeof wakeAttempt.attemptedAt,
    "string",
    `expected last_wake_attempt.attemptedAt to be a string, got: ${JSON.stringify(wakeAttempt.attemptedAt)}`
  );
  assert.ok(
    !Number.isNaN(Date.parse(wakeAttempt.attemptedAt as string)),
    `expected last_wake_attempt.attemptedAt to be a real parseable timestamp, got: ${JSON.stringify(wakeAttempt.attemptedAt)}`
  );
  // permanent is meaningful only for a non-"delivered" outcome (see
  // JobWakeAttempt.permanent's own docs) - absent for "delivered", a real
  // boolean for everything else.
  if (wakeAttempt.outcome === "delivered") {
    assert.ok(
      !("permanent" in wakeAttempt),
      `expected last_wake_attempt.permanent to be absent for a "delivered" outcome, got: ${JSON.stringify(wakeAttempt)}`
    );
  } else {
    assert.equal(
      typeof wakeAttempt.permanent,
      "boolean",
      `expected last_wake_attempt.permanent to be a boolean for a non-delivered outcome, got: ${JSON.stringify(wakeAttempt.permanent)}`
    );
  }
}

async function pollUntilTerminal(
  client: Client,
  jobId: string,
  maxAttempts = 100
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

/**
 * Asserts a task's own `status` field against `expected`, and on mismatch
 * enriches the failure with the BACKING JOB's own `diagnostic` (see
 * `src/jobStore.ts`'s `JobDiagnostic`) when one is present - a task snapshot
 * from `tasks/get` never carries that field itself (`GhantikaResultExtras`,
 * the shape behind a task's `result`/`error`, has no such member - see
 * `src/tasksAdapter.ts`), so a plain `assert.equal` on `status` alone
 * discards the one piece of information that would explain an unexpected
 * `"failed"`: a spawn denied by the command policy gate reads identically to
 * any other unrelated state mismatch unless something goes and looks.
 *
 * The extra `status` tool call only happens on an actual mismatch (never on
 * the passing path), and its result is folded into `assert.equal`'s own
 * message rather than replacing the assertion - the real expected/actual
 * values still print exactly as they always did.
 */
async function assertTaskStatus(
  client: Client,
  jobId: string,
  actual: unknown,
  expected: string,
  message: string
): Promise<void> {
  if (actual === expected) return;
  let diagnosticNote = "";
  try {
    const statusResult = runResultStructured(
      await client.callTool({ name: "status", arguments: { job_id: jobId } })
    );
    if (statusResult.diagnostic) {
      diagnosticNote = ` (job diagnostic: ${JSON.stringify(statusResult.diagnostic)})`;
    }
  } catch {
    // Best effort only - fall through to the plain assertion below even if
    // this extra status read itself fails for some unrelated reason.
  }
  assert.equal(actual, expected, `${message}${diagnosticNote}`);
}

/**
 * Calls `kill` again for the SAME `jobId` (never re-signals once a job is
 * already terminal - see `src/tools/kill.ts`'s own doc comment: a repeat
 * "kill" call against an already-terminal record only re-checks whether
 * the group has since become empty, it never sends another signal)
 * repeatedly, until `kill_confirmed` has actually settled to something
 * other than `undefined` - never a single unconditional read right after
 * the FIRST kill call resolves.
 *
 * Why this is needed at all: `kill_confirmed` is written by an async
 * confirmation callback inside `kill`'s own implementation, and
 * `src/tools/kill.ts`'s own doc comment on the field is explicit that the
 * gap between the process group actually emptying and that confirmation
 * write landing is real event-loop scheduling latency - "deliberately
 * never stated as a wall-clock bound." Reading `kill_confirmed` from a
 * single, synchronously-captured response can therefore race a real,
 * observed (not hypothetical) non-determinism on a loaded CI runner.
 * `test/kill.test.ts`'s own "root-exits-first" poll loop (waiting on the
 * eager reap's confirmation, the same field/gap under a different
 * trigger) already solves this with the identical shape this mirrors,
 * adapted here to the MCP client (`client.callTool`) instead of raw
 * JSON-RPC lines.
 *
 * This loop carries NO wall-clock deadline on `kill_confirmed` itself and
 * never throws on elapsed time reading that field - a fixed bound there
 * would assert a limit on a quantity the contract above says has none, so
 * any number picked is arbitrary and can lose under enough scheduling
 * pressure regardless of size. It polls for as long as a REAL settlement
 * takes, exactly as before. What it also carries now is a test-harness-only
 * watchdog (see `test/helpers/killConfirmedPollWatchdog.ts`'s own header
 * doc comment for the full "why" - it is a bound on this TEST's own
 * patience, never on the field): previously a genuine hang here fell
 * through to node:test's own opaque 120s per-test ceiling with no
 * indication of which job or field was involved (the exact shape a real
 * CI occurrence hit); now it fails first, well inside that ceiling, naming
 * the job id and the last observed record. A breadcrumb to stderr on a
 * fixed logging cadence (never a threshold) still keeps this legible while
 * it waits either way, carrying the same job snapshot the watchdog's own
 * eventual diagnostic reports.
 */
async function pollUntilKillConfirmed(
  client: Client,
  jobId: string
): Promise<Record<string, unknown>> {
  const breadcrumbIntervalMs = 5000;
  let lastBreadcrumbAt = Date.now();
  let iteration = 0;
  let lastSeen: Record<string, unknown> = {};
  const watchdog = armKillConfirmedWatchdog(jobId);
  try {
    for (;;) {
      watchdog.throwIfTripped(lastSeen);
      iteration += 1;
      const result = await watchdog.race(
        client.callTool({ name: "kill", arguments: { job_id: jobId } }),
        lastSeen
      );
      const last = runResultStructured(result);
      lastSeen = last;
      if (last.kill_confirmed !== undefined) {
        return last;
      }
      if (Date.now() - lastBreadcrumbAt >= breadcrumbIntervalMs) {
        const hasChild = jobStore.getChildHandle(jobId) !== undefined;
        const reapAttempted = jobStore.hasReapBeenAttempted(jobId);
        console.error(
          `still waiting for kill_confirmed to settle for job ${jobId}, iteration ${iteration}, ` +
            `hasChild=${hasChild}, reapAttempted=${reapAttempted}, ` +
            `last saw: ${JSON.stringify(last)}`
        );
        lastBreadcrumbAt = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    watchdog.dispose();
  }
}

/**
 * The number of consecutive, identical `counts` reads `pollUntilCountsSettled`
 * requires before it accepts the value as genuinely final - see that
 * function's own docs for why more than one match is worth requiring even
 * though the underlying counters are monotonically non-decreasing.
 */
const COUNTS_STABLE_READS_REQUIRED = 3;

/**
 * Polls `status()` for an ALREADY-terminal `jobId` (see `pollUntilTerminal`
 * above - this never checks `state` itself, it assumes the caller already
 * confirmed terminality) until its `counts` field has stopped changing
 * across `COUNTS_STABLE_READS_REQUIRED` consecutive reads, then returns
 * that settled response - never a single read taken immediately after
 * `state` turns terminal.
 *
 * Why this is needed even though `pollUntilTerminal` already waited for a
 * terminal `state`: `counts.stdout_lines`/`.stdout_bytes`/`.stderr_lines`/
 * `.stderr_bytes` are populated by `JobStore.appendOutput`/`.finalizeStream`
 * (see `src/jobStore.ts`), a code path entirely independent of the `state`
 * transition `pollUntilTerminal` waits on. `src/tools/run.ts`'s own
 * `createTerminalMarkGate` documents exactly why: in the ordinary case the
 * terminal mark (`jobStore.markExited`/`markKilled`) fires only once BOTH
 * stdout and stderr have actually ENDED (and, with them, been finalized via
 * `jobStore.finalizeStream`, which flushes any still-pending partial final
 * line into `linesEverMaterialized`) - but that SAME gate has a documented
 * "disclosed residual" branch that accepts a still-open stream once the
 * process group's reap has settled and one full scheduling tick has passed
 * with no further stream progress, WITHOUT ever waiting for that stream's
 * real `end` event. For an ordinary (non-orphaned) job the real `end` event
 * - and the `finalizeStream` flush it triggers - still lands shortly after,
 * but strictly AFTER `state` has already read terminal. So `counts` can
 * genuinely still be incomplete for a short (real, event-loop-scheduling-
 * dependent, never a stated wall-clock bound) window right after a terminal
 * `status()` read - this is the exact, measured shape of the failure this
 * helper fixes: `state` already "exited" while
 * `counts.stdout_lines` still read 0 for a job that had already written its
 * one byte, on macos-latest/node-24, in a PR run where the very same job's
 * `kill_confirmed`-equivalent race (fixed by `pollUntilKillConfirmed` above,
 * for a DIFFERENT job in this same file) never happened to trip.
 *
 * `StreamBufferState.linesEverMaterialized`/`.bytesEverReceived` (see their
 * own docs in `src/jobStore.ts`) are both documented as monotonically
 * NON-DECREASING for a job's whole life - never reset, never decremented,
 * not even by retention eviction. That invariant is what makes "stable
 * across several consecutive reads" a sound completion signal here, not a
 * coincidence: a value that can only grow can never settle at a stale
 * reading and then silently revert to something smaller, so once it has
 * held steady across `COUNTS_STABLE_READS_REQUIRED` separate polls it has
 * either genuinely finished, or (for a truly escaped descendant that keeps
 * a pipe open forever, out of scope for any job this test file ever spawns)
 * will keep reading "still stable" right up to this poll's own deadline,
 * which then THROWS rather than silently accepting a stale value as final -
 * never the reverse (a real completion masquerading as still-changing).
 * Requiring several consecutive matches, not just two, narrows the
 * already-narrow residual risk of catching an early plateau inside the
 * single short window `createTerminalMarkGate`'s own residual-accept tick
 * opens.
 */
async function pollUntilCountsSettled(
  client: Client,
  jobId: string,
  deadlineMs = 5000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + deadlineMs;
  let lastCountsKey: string | undefined;
  let stableStreak = 0;
  for (;;) {
    const result = await client.callTool({ name: "status", arguments: { job_id: jobId } });
    const structured = runResultStructured(result);
    const countsKey = JSON.stringify(structured.counts);
    if (countsKey === lastCountsKey) {
      stableStreak += 1;
      if (stableStreak >= COUNTS_STABLE_READS_REQUIRED) {
        return structured;
      }
    } else {
      lastCountsKey = countsKey;
      stableStreak = 1;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for counts to settle for job ${jobId} (last observed: ${JSON.stringify(structured.counts)}, required ${COUNTS_STABLE_READS_REQUIRED} identical consecutive reads)`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------
// The vendored schema itself - loaded fresh from disk, never hand-copied,
// so every assertion below that "validates against the schema" or "matches
// the schema's status enum" is checked against the REAL, digest-verified
// file (see scripts/check-sdk-exact-pin.mjs / test/check-sdk-exact-pin.test.js
// for the digest-enforcement half of that same pin).
// ---------------------------------------------------------------------------

type JsonSchemaNode = Record<string, unknown>;

interface TasksSchema {
  readonly $defs: Record<string, JsonSchemaNode>;
}

function loadSchema(): TasksSchema {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as TasksSchema;
}

/**
 * Resolves a LOCAL, fragment-only `$ref` (`"#/$defs/getTaskResult"`, the
 * only form this vendored schema ever uses - confirmed by reading the
 * whole file, never an external URI) against the schema's own root object.
 */
function resolveLocalRef(rootSchema: TasksSchema, ref: string): JsonSchemaNode {
  const segments = ref.replace(/^#\//, "").split("/");
  let node: unknown = rootSchema;
  for (const segment of segments) {
    node = (node as Record<string, unknown>)[segment];
  }
  return node as JsonSchemaNode;
}

/**
 * A REAL, GENUINE JSON Schema validator - not a partial approximation -
 * for exactly the keyword set `schema/tasks-extension.schema.json` (the
 * vendored, digest-verified schema this adapter's results are pinned
 * against) actually uses: `$ref` resolution, `oneOf`, `const`, `enum`,
 * `type` (`object`/`string`/`integer`/`null`, as either a bare string or
 * an ARRAY of strings - the vendored schema's own `ttlMs` field is typed
 * `["integer", "null"]`, the one place this repo's schema actually needs
 * `type`'s full JSON-Schema-legal shape, not a new keyword - `type` was
 * already in this validator's supported set), `properties`, `required`,
 * `additionalProperties`, `minLength`, `minimum`, `exclusiveMinimum`. See
 * `src/tasksAdapter.ts`'s own `taskIdParamsSchema` doc comment for why
 * this repo hand-rolls small schema-shaped checks rather than adding an
 * undeclared JSON Schema validator dependency. This function is
 * deliberately NOT a general-purpose JSON Schema engine - a keyword this
 * vendored schema never uses (`patternProperties`, `allOf`, `anyOf`,
 * numeric `maximum`, string `pattern`, array validation, and more) is not
 * implemented, and a schema node this function does not recognise reds
 * LOUDLY (an "unsupported schema node" problem) rather than silently
 * passing everything through.
 *
 * @param rootSchema the whole parsed schema document, for `$ref` resolution
 * @param schemaNode the sub-schema `value` is checked against
 * @param value the value under test
 * @param path a human-readable location, for problem messages only
 * @returns every problem found; empty means `value` is valid against `schemaNode`
 */
function validateAgainstSchema(
  rootSchema: TasksSchema,
  schemaNode: JsonSchemaNode,
  value: unknown,
  path: string
): string[] {
  if (typeof schemaNode.$ref === "string") {
    return validateAgainstSchema(
      rootSchema,
      resolveLocalRef(rootSchema, schemaNode.$ref),
      value,
      path
    );
  }

  if (Array.isArray(schemaNode.oneOf)) {
    const branchResults = (schemaNode.oneOf as JsonSchemaNode[]).map((branch) =>
      validateAgainstSchema(rootSchema, branch, value, path)
    );
    const matchingBranches = branchResults.filter((problems) => problems.length === 0);
    if (matchingBranches.length === 1) return [];
    return [
      `${path}: expected exactly one "oneOf" branch to validate, ${matchingBranches.length} did (branch problems: ${JSON.stringify(branchResults)})`,
    ];
  }

  if ("const" in schemaNode) {
    return value === schemaNode.const
      ? []
      : [
          `${path}: expected const ${JSON.stringify(schemaNode.const)}, got ${JSON.stringify(value)}`,
        ];
  }

  if (Array.isArray(schemaNode.enum)) {
    return schemaNode.enum.includes(value)
      ? []
      : [
          `${path}: expected one of ${JSON.stringify(schemaNode.enum)}, got ${JSON.stringify(value)}`,
        ];
  }

  if (typeof schemaNode.type === "string") {
    return validateAgainstSingleType(rootSchema, schemaNode.type, schemaNode, value, path);
  }

  if (Array.isArray(schemaNode.type)) {
    const candidateTypes = schemaNode.type as readonly string[];
    for (const typeName of candidateTypes) {
      const problems = validateAgainstSingleType(rootSchema, typeName, schemaNode, value, path);
      if (problems.length === 0) return [];
    }
    return [
      `${path}: expected one of types ${JSON.stringify(candidateTypes)}, got ${JSON.stringify(value)}`,
    ];
  }

  return [
    `${path}: unsupported schema node ${JSON.stringify(schemaNode)} - this validator only implements the keywords schema/tasks-extension.schema.json actually uses`,
  ];
}

/** The single-type dispatch `validateAgainstSchema`'s `type` handling (string or array-of-strings) both reduce to - one candidate type name against one value. */
function validateAgainstSingleType(
  rootSchema: TasksSchema,
  typeName: string,
  schemaNode: JsonSchemaNode,
  value: unknown,
  path: string
): string[] {
  if (typeName === "null") {
    return value === null ? [] : [`${path}: expected null, got ${JSON.stringify(value)}`];
  }

  if (typeName === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [`${path}: expected an object, got ${JSON.stringify(value)}`];
    }
    const problems: string[] = [];
    const obj = value as Record<string, unknown>;
    const properties = (schemaNode.properties as Record<string, JsonSchemaNode> | undefined) ?? {};
    const required = (schemaNode.required as readonly string[] | undefined) ?? [];
    for (const key of required) {
      if (!(key in obj)) problems.push(`${path}: missing required property "${key}"`);
    }
    if (schemaNode.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) problems.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in obj) {
        problems.push(...validateAgainstSchema(rootSchema, subSchema, obj[key], `${path}.${key}`));
      }
    }
    return problems;
  }

  if (typeName === "string") {
    if (typeof value !== "string")
      return [`${path}: expected a string, got ${JSON.stringify(value)}`];
    const minLength = schemaNode.minLength as number | undefined;
    if (typeof minLength === "number" && value.length < minLength) {
      return [`${path}: expected length >= ${minLength}, got ${value.length} ("${value}")`];
    }
    return [];
  }

  if (typeName === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return [`${path}: expected an integer, got ${JSON.stringify(value)}`];
    }
    const problems: string[] = [];
    const minimum = schemaNode.minimum as number | undefined;
    if (typeof minimum === "number" && value < minimum) {
      problems.push(`${path}: expected >= ${minimum}, got ${value}`);
    }
    const exclusiveMinimum = schemaNode.exclusiveMinimum as number | undefined;
    if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
      problems.push(`${path}: expected > ${exclusiveMinimum}, got ${value}`);
    }
    return problems;
  }

  return [
    `${path}: unsupported type "${typeName}" - this validator only implements object/string/integer/null`,
  ];
}

function validatesAgainst(schema: TasksSchema, defName: string, value: unknown): string[] {
  return validateAgainstSchema(
    schema,
    resolveLocalRef(schema, `#/$defs/${defName}`),
    value,
    defName
  );
}

/**
 * Strips the ONE disclosed, bounded SDK-injected artifact key
 * (`content: []`) from a raw wire `tools/call` result before validating it
 * against `createTaskResult` - see this file's header for the full,
 * empirically-measured grounding. Throws loudly if `content` is present
 * but is NOT exactly `[]` (an unbounded/different artifact would be a
 * genuinely new fact worth failing loudly on, never silently swallowed by
 * this helper).
 */
function stripDisclosedContentArtifact(raw: Record<string, unknown>): Record<string, unknown> {
  if (!("content" in raw)) return raw;
  assert.deepEqual(
    raw.content,
    [],
    `expected the disclosed SDK content-injection artifact to be exactly an empty array, got ${JSON.stringify(raw.content)} - this is either a NEW artifact or a real adapter bug, not the known one`
  );
  const rest = { ...raw };
  delete rest.content;
  return rest;
}

// ---------------------------------------------------------------------------
// The schema validator's own mutation controls: proving validateAgainstSchema
// GENUINELY enforces the vendored schema's real constraints - type
// (including the array-of-types / null form `ttlMs` needs), minLength,
// const, enum, and the numeric minimum/exclusiveMinimum bounds - not merely
// required-key presence and additional-property names.
// ---------------------------------------------------------------------------

const VALID_WORKING_TASK: Record<string, unknown> = {
  taskId: "11111111-1111-4111-8111-111111111111",
  status: "working",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUpdatedAt: "2026-01-01T00:00:00.000Z",
  ttlMs: null,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
};

const VALID_COMPLETED_TASK: Record<string, unknown> = {
  ...VALID_WORKING_TASK,
  status: "completed",
  ttlMs: TASK_TTL_MS,
  result: {
    exitCode: 0,
    output: { stdout_lines: 1, stdout_bytes: 10, stderr_lines: 0, stderr_bytes: 0 },
  },
};

const VALID_CREATE_TASK_RESULT: Record<string, unknown> = {
  taskId: "11111111-1111-4111-8111-111111111111",
  status: "working",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUpdatedAt: "2026-01-01T00:00:00.000Z",
  ttlMs: null,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  resultType: "task",
};

const VALID_GET_TASK_RESULT_WORKING: Record<string, unknown> = {
  ...VALID_WORKING_TASK,
  resultType: "complete",
};

const VALID_EMITTED_ACK_RESULT: Record<string, unknown> = { resultType: "complete" };

test("green control: a genuinely valid, minimal workingTask (no optional fields beyond ttlMs:null) passes schema validation", () => {
  const schema = loadSchema();
  assert.deepEqual(validatesAgainst(schema, "workingTask", VALID_WORKING_TASK), []);
});

test("green control: a genuinely valid, terminal completedTask (with result.exitCode + result.output) passes schema validation", () => {
  const schema = loadSchema();
  assert.deepEqual(validatesAgainst(schema, "completedTask", VALID_COMPLETED_TASK), []);
});

test("green control: a genuinely valid createTaskResult passes schema validation", () => {
  const schema = loadSchema();
  assert.deepEqual(validatesAgainst(schema, "createTaskResult", VALID_CREATE_TASK_RESULT), []);
});

test("green control: a genuinely valid getTaskResult (working branch) passes schema validation", () => {
  const schema = loadSchema();
  assert.deepEqual(validatesAgainst(schema, "getTaskResult", VALID_GET_TASK_RESULT_WORKING), []);
});

test("green control: a genuinely valid emittedAckResult passes schema validation", () => {
  const schema = loadSchema();
  assert.deepEqual(validatesAgainst(schema, "emittedAckResult", VALID_EMITTED_ACK_RESULT), []);
});

test("mutation control: an INVALID-TYPE taskId (a number instead of a string) is caught - the hollow helper never checked types at all", () => {
  const schema = loadSchema();
  const problems = validatesAgainst(schema, "workingTask", {
    ...VALID_WORKING_TASK,
    taskId: 12345,
  });
  assert.ok(problems.length > 0, "a numeric taskId must fail schema validation");
  assert.ok(
    problems.some((p) => /expected a string/.test(p)),
    `got: ${JSON.stringify(problems)}`
  );
});

test("mutation control: an EMPTY-STRING taskId is caught - violates the schema's minLength: 1", () => {
  const schema = loadSchema();
  const problems = validatesAgainst(schema, "workingTask", { ...VALID_WORKING_TASK, taskId: "" });
  assert.ok(problems.length > 0, "an empty taskId must fail schema validation");
  assert.ok(
    problems.some((p) => /minLength|length >=/.test(p)),
    `got: ${JSON.stringify(problems)}`
  );
});

test("mutation control: an INVALID status enum value is caught - violates the schema's closed taskStatus const on the workingTask variant", () => {
  const schema = loadSchema();
  const problems = validatesAgainst(schema, "workingTask", {
    ...VALID_WORKING_TASK,
    status: "bogus-status",
  });
  assert.ok(problems.length > 0, "an out-of-const status must fail schema validation");
});

test("mutation control: an INVALID NUMERIC BOUNDARY - pollIntervalMs of 0 - is caught, violating the schema's exclusiveMinimum: 0 (must be strictly positive)", () => {
  const schema = loadSchema();
  const problems = validatesAgainst(schema, "workingTask", {
    ...VALID_WORKING_TASK,
    pollIntervalMs: 0,
  });
  assert.ok(
    problems.length > 0,
    "a zero pollIntervalMs must fail schema validation (exclusiveMinimum: 0)"
  );
});

test("mutation control: ttlMs as a NEGATIVE integer is caught, violating ttlMs' own minimum: 0 - proving the array-typed ['integer','null'] form still enforces the numeric bound, not just the type union", () => {
  const schema = loadSchema();
  const problems = validatesAgainst(schema, "workingTask", { ...VALID_WORKING_TASK, ttlMs: -1 });
  assert.ok(problems.length > 0, "a negative ttlMs must fail schema validation");
});

test("mutation control: ttlMs as a STRING is caught - fails BOTH members of the ['integer','null'] type union, proving this is a real union check and not an accidental always-pass", () => {
  const schema = loadSchema();
  const problems = validatesAgainst(schema, "workingTask", { ...VALID_WORKING_TASK, ttlMs: "24h" });
  assert.ok(
    problems.length > 0,
    'a string ttlMs must fail schema validation ("24h" is neither an integer nor null)'
  );
});

test("mutation control: ttlMs of exactly null IS valid on a workingTask - the green half of the ['integer','null'] union, proving null is genuinely accepted and not merely un-rejected by an always-pass bug", () => {
  const schema = loadSchema();
  assert.deepEqual(
    validatesAgainst(schema, "workingTask", { ...VALID_WORKING_TASK, ttlMs: null }),
    []
  );
});

test("mutation control: a NEGATIVE nested output count (result.output.stdout_bytes: -1) is caught, violating taskOutputCounts' minimum: 0 - a NESTED $ref-resolved constraint", () => {
  const schema = loadSchema();
  const problems = validatesAgainst(schema, "completedTask", {
    ...VALID_COMPLETED_TASK,
    result: {
      ...(VALID_COMPLETED_TASK.result as Record<string, unknown>),
      output: {
        ...((VALID_COMPLETED_TASK.result as Record<string, unknown>).output as object),
        stdout_bytes: -1,
      },
    },
  });
  assert.ok(problems.length > 0, "a negative stdout_bytes must fail schema validation");
  assert.ok(
    problems.some((p) => /expected >= 0/.test(p)),
    `got: ${JSON.stringify(problems)}`
  );
});

test("mutation control: an extra key inside result (matching ghantikaResultExtras' additionalProperties: false) is caught", () => {
  const schema = loadSchema();
  const problems = validatesAgainst(schema, "completedTask", {
    ...VALID_COMPLETED_TASK,
    result: { ...(VALID_COMPLETED_TASK.result as object), unexpected_field: 1 },
  });
  assert.ok(problems.length > 0, "an extra key inside result must fail schema validation");
  assert.ok(
    problems.some((p) => /unexpected property "unexpected_field"/.test(p)),
    `got: ${JSON.stringify(problems)}`
  );
});

test("mutation control: a createTaskResult carrying a stray content key (matching the disclosed SDK wire artifact this suite strips before validating) FAILS validation - proving the schema genuinely forbids it, which is exactly why the wire-artifact strip in this suite's own harness is necessary rather than decorative", () => {
  const schema = loadSchema();
  const problems = validatesAgainst(schema, "createTaskResult", {
    ...VALID_CREATE_TASK_RESULT,
    content: [],
  });
  assert.ok(problems.length > 0, "a createTaskResult carrying content must fail schema validation");
  assert.ok(
    problems.some((p) => /unexpected property "content"/.test(p)),
    `got: ${JSON.stringify(problems)}`
  );
});

test("mutation control: createTaskResult missing resultType is caught (required)", () => {
  const schema = loadSchema();
  const withoutResultType = { ...VALID_CREATE_TASK_RESULT };
  delete withoutResultType.resultType;
  const problems = validatesAgainst(schema, "createTaskResult", withoutResultType);
  assert.ok(
    problems.length > 0,
    "a createTaskResult missing resultType must fail schema validation"
  );
  assert.ok(problems.some((p) => /missing required property "resultType"/.test(p)));
});

test("mutation control: emittedAckResult's wrong resultType const value is caught - additionalProperties:false also rejects an extra key", () => {
  const schema = loadSchema();
  assert.ok(
    validatesAgainst(schema, "emittedAckResult", { resultType: "task" }).length > 0,
    "a wrong resultType const must fail"
  );
  assert.ok(
    validatesAgainst(schema, "emittedAckResult", { resultType: "complete", extra: 1 }).length > 0,
    "an extra key must fail (additionalProperties: false)"
  );
});

// ---------------------------------------------------------------------------
// Capability advertisement: the initialize result's capabilities include
// io.modelcontextprotocol/tasks, with the RELEASED spec's own empty
// TasksExtensionCapability descriptor (reversed from the earlier design: the
// previous {methods: [...]} addition is gone, additionalProperties:false
// on the real spec schema forbids any key at all)
// ---------------------------------------------------------------------------

test("the server advertises io.modelcontextprotocol/tasks in its initialize-negotiated capabilities, on both a capable and a non-capable client connection", async () => {
  for (const capable of [true, false]) {
    const pair = await startPair(capable);
    try {
      const serverCapabilities = pair.client.getServerCapabilities();
      assert.ok(
        serverCapabilities?.extensions,
        "expected the server to advertise an extensions bag"
      );
      assert.ok(
        Object.hasOwn(serverCapabilities!.extensions!, TASKS_EXTENSION_URI),
        `expected "${TASKS_EXTENSION_URI}" among the advertised extensions, got: ${JSON.stringify(serverCapabilities?.extensions)}`
      );
    } finally {
      await pair.close();
    }
  }
});

test("the advertised io.modelcontextprotocol/tasks capability descriptor is exactly an empty object - the released spec's own TasksExtensionCapability forbids any key at all, so the pre-story {methods:[...]} addition is gone, not merely unused", async () => {
  assert.deepEqual(TASKS_CAPABILITY_DESCRIPTOR, {});
  const pair = await startPair(true);
  try {
    const serverCapabilities = pair.client.getServerCapabilities();
    assert.deepEqual(
      serverCapabilities?.extensions?.[TASKS_EXTENSION_URI],
      {},
      `expected the negotiated descriptor to be exactly {}, got: ${JSON.stringify(serverCapabilities?.extensions?.[TASKS_EXTENSION_URI])}`
    );
  } finally {
    await pair.close();
  }
});

// Capability negotiation is purely a per-connection/per-request property,
// read from the connection's declared capabilities bag - it never touches
// job admission, so whether the underlying run() job was policy-allowed or
// denied cannot change whether a taskId is minted. Neither of the two tests
// below needs a real spawn.

// ---------------------------------------------------------------------------
// A client that declares ONLY the SDK-deprecated
// `capabilities.tasks` shape (never `extensions`/`experimental`) must still
// not reach the extension - `isConnectionTasksCapable` has never read that
// field, so this is unchanged behavior; asserted directly here so it cannot
// regress.
// ---------------------------------------------------------------------------

test("a client declaring ONLY the SDK-deprecated capabilities.tasks shape (no extensions/experimental bag at all) still gets the plain poll floor, not the extension", async () => {
  pairCounter += 1;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const instance = createServer(serverTransport);
  await instance.server.connect(instance.transport);

  const client = new Client(
    { name: `ghantika-tasks-test-client-${pairCounter}`, version: "0.0.0" },
    // The SDK-deprecated shape: a bare `tasks` key, never `extensions` or
    // `experimental` - the two bags `isConnectionTasksCapable` actually
    // reads (see src/tasksAdapter.ts's own `hasTasksExtensionKey`).
    { capabilities: { tasks: {} } as Record<string, unknown> }
  );
  await client.connect(clientTransport);

  try {
    const structured = await runJob(client, { label: "deprecated-tasks-shape" });
    assert.equal(
      structured.taskId,
      undefined,
      `a capabilities.tasks-only declaration must never mint a Task result, got: ${JSON.stringify(structured)}`
    );
    assert.equal(
      typeof structured.job_id,
      "string",
      "the plain poll floor (a bare job_id) must still be returned"
    );
  } finally {
    await instance.shutdown("tasks.test.ts deprecated-capabilities-shape regression complete");
  }
});

// ---------------------------------------------------------------------------
// Capability negotiation matches the finalized extension contract exactly,
// which designates `extensions` as the sole bag - a client declaring Tasks
// support only under the older, free-form `experimental` bag must not be
// recognized as capable. `extensions` and `capabilities.tasks` are already
// proven not to leak into each other above; `experimental` is the third bag
// capability negotiation deliberately never reads.
// ---------------------------------------------------------------------------

test("a client declaring Tasks support ONLY under the older experimental bag (never extensions) still gets the plain poll floor, not the extension", async () => {
  pairCounter += 1;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const instance = createServer(serverTransport);
  await instance.server.connect(instance.transport);

  const client = new Client(
    { name: `ghantika-tasks-test-client-${pairCounter}`, version: "0.0.0" },
    {
      capabilities: {
        experimental: { [TASKS_EXTENSION_URI]: {} },
      } as Record<string, unknown>,
    }
  );
  await client.connect(clientTransport);

  try {
    const structured = await runJob(client, { label: "experimental-bag-only" });
    assert.equal(
      structured.taskId,
      undefined,
      `an experimental-bag-only declaration must never mint a Task result, got: ${JSON.stringify(structured)}`
    );
    assert.equal(
      typeof structured.job_id,
      "string",
      "the plain poll floor (a bare job_id) must still be returned"
    );
  } finally {
    await instance.shutdown("tasks.test.ts experimental-bag-only regression complete");
  }
});

// ---------------------------------------------------------------------------
// The run-only mint rule: run() mints unsolicited on a capable connection,
// with no per-request opt-in field involved at all
// ---------------------------------------------------------------------------

// This test genuinely needs a real spawn: mapJobStateToTaskStatus (src/
// tasksAdapter.ts) maps a policy-denied job's "failed" state to task status
// "failed", never "working" - so asserting status === "working" requires a
// genuinely non-terminal (policy-allowed) job.
describe("spawning tests: connection capability and mint mechanics - mint status needs a genuinely non-terminal job", () => {
  before(requireSpawnPolicy);

  test("a Tasks-advertised connection gets an unsolicited server-minted task handle on a bare run() call - no opt-in field anywhere in the request", async () => {
    const pair = await startPair(true);
    try {
      const minted = await mintJob(pair.client, { label: "mint-unsolicited" });
      assert.equal(typeof minted.taskId, "string");
      assert.equal(minted.status, "working");
      assert.equal(
        minted.job_id,
        undefined,
        "the plain {job_id} shape must not also appear on a minted result"
      );
    } finally {
      await pair.close();
    }
  });
});

// Minting is a wire-shape decision derived from connection capability, not
// job outcome - buildCreateTaskResult mints a full CreateTaskResult even for
// an already-terminal (denied) job (see the module-scope comment on
// mapJobStateToTaskStatus above), so none of the wire-shape/schema
// assertions below need a real spawn.

test("on a capable connection, run() mints a CreateTaskResult even though the call carries no request-level capability/task field whatsoever - minting depends only on the connection", async () => {
  const pair = await startPair(true);
  try {
    // Deliberately no `task`, no `_meta`, no capability-shaped argument of
    // any kind beyond what `run` already accepts - proving the mint
    // decision reads nothing from the individual request.
    const minted = await mintJob(pair.client, { command: ["true"], label: "no-opt-in-field" });
    assert.equal(typeof minted.taskId, "string");
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// The minted result's REAL wire shape (via the wire tap, resultType
// included) validates against the pinned, digest-verified schema, and the
// one disclosed SDK content-injection artifact is bounded exactly
// ---------------------------------------------------------------------------

test("the minted result's RAW wire shape - resultType included, the disclosed content:[] SDK artifact stripped - validates against the real, digest-verified vendored createTaskResult schema", async () => {
  const pair = await startPair(true);
  try {
    await mintJob(pair.client, { label: "schema-validate" });
    const raw = pair.wireTap.latestResultFor("tools/call");
    assert.ok(raw, "expected a captured raw tools/call result");
    assert.equal(raw!.resultType, "task", "the wire-level resultType discriminator must be 'task'");
    const stripped = stripDisclosedContentArtifact(raw!);
    const schema = loadSchema();
    const problems = validatesAgainst(schema, "createTaskResult", stripped);
    assert.deepEqual(
      problems,
      [],
      `minted result (post content-artifact strip) failed schema validation: ${JSON.stringify(problems)}`
    );
  } finally {
    await pair.close();
  }
});

test("the minted result's RAW wire shape carries EXACTLY one key beyond what buildCreateTaskResult constructs - the disclosed content:[] artifact - never structuredContent, never an unbounded extra field set", async () => {
  const pair = await startPair(true);
  try {
    await mintJob(pair.client, { label: "artifact-bound" });
    const raw = pair.wireTap.latestResultFor("tools/call");
    assert.ok(raw);
    assert.equal(
      raw!.structuredContent,
      undefined,
      "a minted result must never carry structuredContent"
    );
    const keys = Object.keys(raw!).sort();
    const expectedTaskKeys = [
      "taskId",
      "status",
      "createdAt",
      "lastUpdatedAt",
      "ttlMs",
      "pollIntervalMs",
      "resultType",
    ];
    const extraKeys = keys.filter((k) => !expectedTaskKeys.includes(k));
    assert.deepEqual(
      extraKeys,
      ["content"],
      `expected the ONLY key beyond the real CreateTaskResult fields to be the disclosed "content" artifact, got extra keys: ${JSON.stringify(extraKeys)}`
    );
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// A non-capable connection is byte-stable with the plain {job_id} shape -
// no CreateTaskResult ever appears
// ---------------------------------------------------------------------------

// This test genuinely needs a real spawn: it explicitly asserts state ===
// "starting" (a freshly-started job's synchronous projection), which a
// policy-denied job can never be - a denial resolves synchronously to state
// "failed".
describe("spawning tests: connection capability and mint mechanics - plain projection state needs a genuinely non-terminal job", () => {
  before(requireSpawnPolicy);

  test("a non-capable connection's run() returns the plain job projection - a genuine deep-equality check of the COMPLETE real plain PublicJobProjection response across BOTH structuredContent and content, key set AND field values (started_at format-checked AND bracketed against a real wall-clock window this test itself observed around the run() call, so a stable-but-wrong ISO value cannot survive), not just presence/absence of a few named fields", async () => {
    const pair = await startPair(false);
    try {
      // Not `runJob` here, deliberately - that helper (see `runResultStructured`
      // above) discards `CallToolResult.content` entirely and returns only
      // `structuredContent`, which is exactly the gap previously demonstrated
      // for this test: a mutant changing ONLY `content` (leaving
      // `structuredContent` untouched) still passed. The raw `CallToolResult`
      // is kept here so both halves of the real tool result can be checked.
      const beforeRunMs = Date.now();
      const result = await pair.client.callTool({
        name: "run",
        arguments: { command: ["true"], label: "plain-poll-floor" },
      });
      const afterRunMs = Date.now();
      assert.notEqual((result as { isError?: boolean }).isError, true);
      const structured = runResultStructured(result);
      assert.equal(typeof structured.job_id, "string");
      assert.equal(
        structured.taskId,
        undefined,
        "a non-capable connection must never see a minted taskId field"
      );

      // The COMPLETE key set the real PublicJobProjection shape carries -
      // see src/jobStore.ts's own toPublicProjection, which always writes
      // all thirteen fields (the seven optional ones included, EXPLICITLY as
      // `undefined` when a job hasn't reached that point yet - verified
      // empirically here rather than assumed: InMemoryTransport passes the
      // structured content through without an actual JSON.stringify pass,
      // so an `undefined`-valued own property survives as a present key,
      // unlike what a real JSON-serialized wire would show).
      assert.deepEqual(
        Object.keys(structured).sort(),
        [
          "command_summary",
          "counts",
          "diagnostic",
          "ended_at",
          "escalation_refused_reason",
          "exit_code",
          "identity_capture",
          "identity_confirmed",
          "job_id",
          "kill_confirmed",
          "label",
          "last_wake_attempt",
          "queue_position",
          "signal",
          "started_at",
          "state",
        ].sort(),
        `expected the plain projection's key set to deep-equal the real plain job-projection shape exactly, got: ${JSON.stringify(Object.keys(structured).sort())}`
      );
      assert.equal(
        structured.state,
        "starting",
        "a freshly-started job's synchronous projection must be exactly 'starting'"
      );
      for (const key of [
        "ended_at",
        "exit_code",
        "signal",
        "diagnostic",
        "queue_position",
        "kill_confirmed",
        "identity_confirmed",
        "escalation_refused_reason",
        // last_wake_attempt: only ever written once a real wake ATTEMPT has
        // settled (see JobRecord.last_wake_attempt's own docs) - this job
        // is still synchronously "starting" (asserted just above), so
        // startTransportWakeOnTerminal has not even subscribed on its
        // terminal transition yet, let alone attempted anything.
        "last_wake_attempt",
      ]) {
        assert.equal(
          structured[key],
          undefined,
          `expected "${key}" to be unset on a freshly-started job, got ${JSON.stringify(structured[key])}`
        );
      }
      assert.equal(
        structured.identity_capture,
        "pending",
        `expected a freshly-started job's identity_capture to be "pending" at this synchronous instant, got ${JSON.stringify(structured.identity_capture)}`
      );

      assert.equal(
        structured.label,
        "plain-poll-floor",
        "expected the real label supplied to run(), not a placeholder"
      );
      assert.equal(
        structured.command_summary,
        "true",
        'expected the real argv[0] basename of the default ["true"] command, not a placeholder'
      );
      assert.match(
        structured.started_at as string,
        ISO_TIMESTAMP_PATTERN,
        `expected started_at to be a real ISO-8601 millisecond timestamp (Date#toISOString() shape), got ${JSON.stringify(structured.started_at)}`
      );
      const structuredStartedAtMs = Date.parse(structured.started_at as string);
      assert.ok(
        structuredStartedAtMs >= beforeRunMs && structuredStartedAtMs <= afterRunMs,
        `expected started_at (${JSON.stringify(structured.started_at)}) to fall inside the real wall-clock bracket [${beforeRunMs}, ${afterRunMs}] this test captured around the actual run() call - a stable-but-wrong ISO-shaped value would fall outside it`
      );
      assert.deepEqual(
        structured.counts,
        { stdout_lines: 0, stdout_bytes: 0, stderr_lines: 0, stderr_bytes: 0 },
        `expected the real, freshly-started zero counts by full value, not just the right key set - got ${JSON.stringify(structured.counts)}`
      );

      const contentBlocks = (result as CallToolResult).content;
      assert.ok(
        Array.isArray(contentBlocks) && contentBlocks.length === 1,
        `expected exactly one content block, got ${JSON.stringify(contentBlocks)}`
      );
      const [contentBlock] = contentBlocks;
      assert.equal(
        (contentBlock as { type?: string }).type,
        "text",
        `expected the content block's type to be "text", got ${JSON.stringify(contentBlock)}`
      );
      const contentText = (contentBlock as { text?: unknown }).text;
      assert.equal(
        typeof contentText,
        "string",
        "expected the content block's text to be a string"
      );

      let parsedContent: unknown;
      try {
        parsedContent = JSON.parse(contentText as string);
      } catch (error) {
        throw new Error(
          `expected content[0].text to be valid, parseable JSON - src/tools/run.ts's own toolSuccess builds it via JSON.stringify(projection, null, 2) - got ${JSON.stringify(contentText)}`,
          { cause: error }
        );
      }
      const parsedContentRecord = parsedContent as Record<string, unknown>;

      assert.deepEqual(
        Object.keys(parsedContentRecord).sort(),
        ["command_summary", "counts", "identity_capture", "job_id", "label", "started_at", "state"],
        `expected content's real JSON-serialized key set to be exactly the DEFINED PublicJobProjection fields (JSON.stringify drops undefined optional fields), got: ${JSON.stringify(Object.keys(parsedContentRecord).sort())}`
      );

      assert.deepEqual(
        parsedContentRecord,
        JSON.parse(JSON.stringify(structured)),
        `expected content's parsed JSON to agree with structuredContent on every field it carries - got content=${JSON.stringify(parsedContentRecord)} vs structuredContent=${JSON.stringify(structured)}`
      );

      assert.equal(parsedContentRecord.job_id, structured.job_id);
      assert.equal(parsedContentRecord.state, "starting");
      assert.equal(parsedContentRecord.label, "plain-poll-floor");
      assert.equal(parsedContentRecord.command_summary, "true");
      assert.match(
        parsedContentRecord.started_at as string,
        ISO_TIMESTAMP_PATTERN,
        `expected content's started_at to be a real ISO-8601 millisecond timestamp, got ${JSON.stringify(parsedContentRecord.started_at)}`
      );
      const contentStartedAtMs = Date.parse(parsedContentRecord.started_at as string);
      assert.ok(
        contentStartedAtMs >= beforeRunMs && contentStartedAtMs <= afterRunMs,
        `expected content's started_at (${JSON.stringify(parsedContentRecord.started_at)}) to fall inside the real wall-clock bracket [${beforeRunMs}, ${afterRunMs}] this test captured around the actual run() call - a stable-but-wrong ISO-shaped value would fall outside it`
      );
      assert.deepEqual(
        parsedContentRecord.counts,
        { stdout_lines: 0, stdout_bytes: 0, stderr_lines: 0, stderr_bytes: 0 },
        `expected content's counts to deep-equal the real, freshly-started zero counts, got ${JSON.stringify(parsedContentRecord.counts)}`
      );
    } finally {
      await pair.close();
    }
  });
});

// taskId generation/uniqueness and server-side method registration are both
// independent of job admission outcome, so neither test below needs a real
// spawn.

// ---------------------------------------------------------------------------
// N mints produce N distinct, high-entropy (v4 UUID) taskIds
// ---------------------------------------------------------------------------

test("N mints on a capable connection produce N distinct, high-entropy v4-UUID-format taskIds", async () => {
  const pair = await startPair(true);
  try {
    const N = 12;
    const taskIds: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const minted = await mintJob(pair.client, { label: `entropy-${i}` });
      taskIds.push(minted.taskId as string);
    }
    assert.equal(new Set(taskIds).size, N, "every minted taskId must be distinct");
    for (const id of taskIds) {
      assert.ok(UUID_V4_PATTERN.test(id), `taskId "${id}" is not a v4-UUID-shaped string`);
    }
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// The registered task method set deep-equals exactly {tasks/get,
// tasks/update, tasks/cancel} - set-equality, no legacy result/list surface,
// no seventh tool
// ---------------------------------------------------------------------------

test("the registered task method set is exactly {tasks/get, tasks/update, tasks/cancel} - no tasks/list, no tasks/result, no seventh method", async () => {
  const pair = await startPair(true);
  try {
    const minted = await mintJob(pair.client, { label: "method-set-fixture" });
    const taskId = minted.taskId as string;

    // tasks/get must succeed and name this exact task.
    const getResult = await tasksRequest(pair.client, "tasks/get", taskId);
    assert.equal(getResult.taskId, taskId);

    // tasks/update and tasks/cancel must succeed too (their client-decoded
    // shape is an empty object post resultType-strip - see this file's
    // header - so "succeeds without throwing" is what this loop checks for
    // them; their exact ack shape is proven via the wire tap elsewhere).
    await tasksRequest(pair.client, "tasks/update", taskId);
    await tasksRequest(pair.client, "tasks/cancel", taskId);

    // The legacy surface must NOT exist - a real JSON-RPC method-not-found
    // error (-32601), not a well-formed response of any shape.
    for (const method of ["tasks/list", "tasks/result"]) {
      await assert.rejects(
        () => pair.client.request({ method, params: {} }, passthroughResultSchema()),
        (error: unknown) => {
          const message = String((error as { message?: unknown })?.message ?? error);
          return /-32601|not found|unknown method/i.test(message);
        },
        `expected ${method} to be unregistered (method not found)`
      );
    }
  } finally {
    await pair.close();
  }
});

test("the registered task/* method set is a genuine SET-EQUALITY over the server's OWN real registration mechanism, not merely '3 named methods answer and 2 named methods 404' - a REAL seventh handler injected into the live registry is caught, which the presence/absence check above cannot see since it never enumerates the registry at all", async () => {
  const [, serverTransport] = InMemoryTransport.createLinkedPair();
  const instance = createServer(serverTransport);
  await instance.server.connect(instance.transport);
  try {
    // The SDK's Protocol class exposes no PUBLIC way to enumerate its
    // registered methods - `_requestHandlers` is a real runtime Map,
    // merely typed `private` at compile time (TypeScript's `private` is
    // erased at emit; it does not exist as a runtime access restriction).
    const requestHandlers = (
      instance.server as unknown as { _requestHandlers: Map<string, unknown> }
    )._requestHandlers;
    assert.ok(
      requestHandlers instanceof Map,
      "expected the server's real request-handler registry to be a Map - this test's introspection technique itself needs revisiting if this changes"
    );

    const registeredTaskMethods = () =>
      [...requestHandlers.keys()].filter((method) => method.startsWith("tasks/")).sort();

    assert.deepEqual(
      registeredTaskMethods(),
      ["tasks/cancel", "tasks/get", "tasks/update"],
      `expected the registered tasks/* method set to deep-equal exactly {tasks/get, tasks/update, tasks/cancel}, got: ${JSON.stringify(registeredTaskMethods())}`
    );

    // Inject a REAL seventh tasks/* handler into the LIVE registry, using
    // the SAME 3-arg setRequestHandler form and the SAME params schema
    // src/server.ts's own real registrations use - a genuine handler,
    // callable exactly like the other three, not a fake entry. Returns the
    // released spec's own ack shape (never the pre-story `extension` field,
    // which is no longer part of this adapter's vocabulary) purely so this
    // fixture stays consistent with the rest of this suite.
    instance.server.setRequestHandler(
      "tasks/seventh",
      { params: taskIdParamsSchema() },
      async (params) => ({ resultType: "complete", taskId: params.taskId, injected: true })
    );

    const afterInjection = registeredTaskMethods();
    assert.deepEqual(
      afterInjection,
      ["tasks/cancel", "tasks/get", "tasks/seventh", "tasks/update"],
      "expected the injected 7th handler to be visible in the real registry - proving this introspection is live, not a stale snapshot"
    );
    assert.notDeepEqual(
      afterInjection,
      ["tasks/cancel", "tasks/get", "tasks/update"],
      "a genuine set-equality check must now DISAGREE with the frozen expected 3-method set once a 7th handler is live - this is exactly the escape previously demonstrated to slip past the old presence/absence check"
    );
  } finally {
    await instance.shutdown("tasks.test.ts complete");
  }
});

// ---------------------------------------------------------------------------
// The adapter's task-status set is a SUBSET of the pinned schema's status
// enum (never a deep-equals - the schema now pins the SPEC's full 5-value
// enum, and this adapter emits only 4 of them), and 'expired'/'input_required'
// are never emitted members
// ---------------------------------------------------------------------------

test("TASK_STATUSES is a SUBSET of the vendored schema's own taskStatus enum (never a deep-equals, now that the schema pins the spec's full 5-value enum) - 'input_required' is excluded because it is structurally UNREACHABLE for a job-backed task (no client-input step ever occurs), not merely unobserved so far, and 'expired' is never a member of either", () => {
  const schema = loadSchema();
  const statusEnum = schema.$defs.taskStatus.enum as readonly string[];
  for (const status of TASK_STATUSES) {
    assert.ok(
      statusEnum.includes(status),
      `expected every emitted status "${status}" to be a member of the schema's taskStatus enum ${JSON.stringify(statusEnum)}`
    );
  }
  assert.equal(
    statusEnum.length,
    TASK_STATUSES.length + 1,
    `expected the schema's taskStatus enum to have exactly one more member than TASK_STATUSES (input_required) - schema enum: ${JSON.stringify(statusEnum)}, emitted: ${JSON.stringify(TASK_STATUSES)}`
  );
  assert.ok(
    statusEnum.includes("input_required"),
    "expected the spec's own enum to still legally include input_required - a conformant client must handle it from OTHER servers even though ghantika never emits it"
  );
  assert.ok(
    !TASK_STATUSES.includes("input_required" as never),
    "ghantika must never emit input_required"
  );
  assert.ok(!TASK_STATUSES.includes("expired" as never));
  assert.ok(
    !statusEnum.includes("expired"),
    "'expired' is not a legal spec value either - see getTask's own TTL-purge docs"
  );
  assert.equal(isTaskStatusValue("expired"), false);
  assert.equal(
    isTaskStatusValue("input_required"),
    false,
    "input_required is a legal SPEC value but not a value THIS adapter's own isTaskStatusValue recognizes as emittable"
  );
  for (const status of TASK_STATUSES) {
    assert.equal(isTaskStatusValue(status), true);
  }
});

// This test's assertions are self-referential rather than fixed: it derives
// the EXPECTED task status from status()'s own OBSERVED state via the
// documented mapping table (which includes failed -> "failed"), and
// createdAt is compared against status()'s own observed started_at - not
// asserting any specific state. So it holds identically whether the
// underlying job was policy-allowed or denied, and needs no real spawn to
// be genuine.

// ---------------------------------------------------------------------------
// tasks/get(taskId) resolves via the documented status mapping to the SAME
// job status() already reports, live, cross-checked on createdAt/started_at
// agreement with the real job record - self-referential rather than fixed:
// it derives the EXPECTED task status from status()'s own OBSERVED state
// through the mapping table, whatever that state happens to be, so it never
// waits for or asserts a specific terminal state or output
// ---------------------------------------------------------------------------

test("tasks/get(taskId) resolves to the SAME job status()/output() reports - not just a matching taskId, but genuine cross-field agreement with the real status(), including createdAt/lastUpdatedAt agreement with the real job record", async () => {
  const pair = await startPair(true);
  try {
    const minted = await mintJob(pair.client, { label: "identity-mapping" });
    const taskId = minted.taskId as string;

    const statusResult = runResultStructured(
      await pair.client.callTool({ name: "status", arguments: { job_id: taskId } })
    );
    assert.equal(statusResult.job_id, taskId, "taskId must equal the real job_id");

    const taskGet = await tasksRequest(pair.client, "tasks/get", taskId);
    assert.equal(taskGet.taskId, taskId);

    const expectedTaskStatus: Record<string, string> = {
      starting: "working",
      running: "working",
      exited: "completed",
      failed: "failed",
      killed: "cancelled",
    };
    const jobState = statusResult.state as string;
    assert.equal(
      taskGet.status,
      expectedTaskStatus[jobState],
      `expected tasks/get's status to map from status()'s real state "${jobState}" via the documented mapping, got ${JSON.stringify(taskGet.status)}`
    );
    assert.equal(
      taskGet.createdAt,
      statusResult.started_at,
      "tasks/get's createdAt must equal status()'s real started_at - the same underlying job record"
    );
    assert.match(taskGet.lastUpdatedAt as string, ISO_TIMESTAMP_PATTERN);
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// An unresolvable taskId THROWS the fixed task_not_found JSON-RPC error
// (-32602), never a crash or a fabricated success value - the released
// spec's own contract, which collapses ghantika's former
// unknown-vs-TTL-purged distinction into one error code
// ---------------------------------------------------------------------------

test("an unresolvable taskId THROWS a -32602 (Invalid params) JSON-RPC error on all three registered methods, never a tagged success value", async () => {
  const pair = await startPair(true);
  try {
    const bogusId = "00000000-0000-4000-8000-000000000000";
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"] as const) {
      await assert.rejects(
        () => tasksRequest(pair.client, method, bogusId),
        (error: unknown) => {
          const candidate = error as { code?: unknown; message?: unknown };
          const messageText = String(candidate?.message ?? error);
          return candidate?.code === -32602 || /-32602|not found|task_not_found/i.test(messageText);
        },
        `expected ${method} to reject an unknown taskId with a -32602 error`
      );
    }
  } finally {
    await pair.close();
  }
});

test("an EMPTY-STRING taskId is REJECTED at the request-validation boundary on all three task methods, never silently echoed through - the vendored schema pins minLength: 1 on every taskId field, so a validated empty taskId would itself violate the schema this adapter's responses are pinned against", async () => {
  const pair = await startPair(true);
  try {
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"] as const) {
      await assert.rejects(
        () => tasksRequest(pair.client, method, ""),
        (error: unknown) => {
          const message = String((error as { message?: unknown })?.message ?? error);
          return /-32602|invalid|taskId/i.test(message);
        },
        `expected ${method} to reject an empty-string taskId at the request-validation boundary`
      );
    }
  } finally {
    await pair.close();
  }
});

// tasks/update's fixed ack shape ({resultType: "complete"}) never varies with
// job state - a denied job still mints, and the ack is unaffected by
// inputResponses' content either way, so this needs no real spawn.
test("tasks/update accepts (and structurally ignores) an inputResponses param, matching the released spec's own {taskId, inputResponses} request shape - ghantika never has a pending input_required step, so the value itself is never interpreted, but the request-validation boundary must not reject the field's mere presence", async () => {
  const pair = await startPair(true);
  try {
    const minted = await mintJob(pair.client, { label: "input-responses-accepted" });
    const taskId = minted.taskId as string;
    // Should resolve without throwing, whatever shape inputResponses takes -
    // it is accepted-but-unread (see tasksAdapter.ts's own updateTask docs).
    await tasksUpdateRequestWithInputResponses(pair.client, taskId, {});
    await tasksUpdateRequestWithInputResponses(pair.client, taskId, {
      someKey: "someElicitResponse",
    });
    const raw = pair.wireTap.latestResultFor("tasks/update");
    assert.deepEqual(
      raw,
      { resultType: "complete" },
      "the ack shape must be unaffected by inputResponses' content"
    );
  } finally {
    await pair.close();
  }
});

// This test genuinely needs a real spawn: it asserts a real exit code (7)
// and real non-zero stdout_bytes, which only a genuinely-run child produces.
describe("spawning tests: task lifecycle - terminal-state reflection needs a real spawn", () => {
  before(requireSpawnPolicy);

  test("after the backing job reaches a REAL terminal state (known exit code, known output), tasks/get(taskId) reflects that real state under result.exitCode/result.output - never a canned 'working' decoupled from the job, and never top-level exitCode/output (the released spec nests them under the status-specific result/error container)", async () => {
    const pair = await startPair(true);
    try {
      const minted = await mintJob(pair.client, {
        command: [
          process.execPath,
          "-e",
          "process.stdout.write('hello-from-task'); process.exitCode = 7;",
        ],
        label: "terminal-reflection",
      });
      const taskId = minted.taskId as string;

      await pollUntilTerminal(pair.client, taskId);

      const taskGet = await tasksRequest(pair.client, "tasks/get", taskId);
      assert.equal(
        taskGet.status,
        "completed",
        `expected a completed task, got status ${JSON.stringify(taskGet.status)}`
      );
      assert.equal(
        taskGet.exitCode,
        undefined,
        "exitCode must never be top-level on the released contract"
      );
      assert.equal(
        taskGet.output,
        undefined,
        "output must never be top-level on the released contract"
      );
      const result = taskGet.result as Record<string, unknown> | undefined;
      assert.ok(result, "expected a real result container on a completed task");
      assert.equal(
        result!.exitCode,
        7,
        "the real exit code must be reflected under result.exitCode, not a canned value"
      );
      const output = result!.output as Record<string, number> | undefined;
      assert.ok(output, "expected real output counts under result.output on a terminal task");
      // A `> 0` threshold, not `pollUntilCountsSettled`'s exact-value shape:
      // `stdout_bytes` (`JobStore`'s `bytesEverReceived`) is bumped
      // synchronously on every raw chunk ARRIVAL (`appendChunkToBuffer`),
      // independent of the stream ending or `finalizeStream` ever running -
      // unlike `stdout_lines` (`linesEverMaterialized`), which specifically
      // needs a trailing-newline-less final fragment to be FLUSHED at stream
      // end. This job's write happens well before its process exits, so the
      // byte has already arrived (and been counted) long before
      // `pollUntilTerminal` above could observe a terminal state at all -
      // a value written synchronously and safe to sample once, just via
      // chunk-arrival timing rather than the state transition itself.
      assert.ok(
        output!.stdout_bytes > 0,
        `expected non-zero stdout_bytes reflecting real output, got ${JSON.stringify(output)}`
      );
      // ttlMs is a real, exposed, non-null number for a terminal task -
      // never the still-working null.
      assert.equal(
        taskGet.ttlMs,
        TASK_TTL_MS,
        "expected the real, exposed TASK_TTL_MS on a terminal task"
      );
    } finally {
      await pair.close();
    }
  });
});

// This test's command is deliberately unresolvable, so it returns BEFORE the
// policy decision (src/tools/run.ts's resolveExecutable() step, ahead of
// decideRunPolicy()) - it fails the same way whether a spawn policy is
// configured or not, so it needs no real spawn to be genuine.
test("a job that never spawns (spawn-error class) maps to task status 'failed' with the diagnostic nested under error, distinct from a completed task whose command happened to exit non-zero", async () => {
  const pair = await startPair(true);
  try {
    const minted = await mintJob(pair.client, {
      command: ["this-command-definitely-does-not-exist-ghantika-tasks-test"],
      label: "spawn-failure-mapping",
    });
    const taskId = minted.taskId as string;
    await pollUntilTerminal(pair.client, taskId);

    const taskGet = await tasksRequest(pair.client, "tasks/get", taskId);
    assert.equal(taskGet.status, "failed");
    assert.ok(taskGet.error, "expected a real error container on a failed task");
    assert.equal(taskGet.result, undefined, "a failed task must never carry a result container");
  } finally {
    await pair.close();
  }
});

// This test genuinely needs a real spawn: killing an already-terminal
// (policy-denied) job has nothing real to kill, so the cancelled-state
// transition it asserts needs a genuinely running job.
describe("spawning tests: task lifecycle - kill-to-cancelled mapping needs a real spawn", () => {
  before(requireSpawnPolicy);

  test("a killed job maps to task status 'cancelled', with no result/error container at all - the spec's own CancelledTask shape", async () => {
    const pair = await startPair(true);
    try {
      const minted = await mintJob(pair.client, {
        command: [process.execPath, "-e", "setTimeout(() => {}, 60000);"],
        label: "kill-mapping",
      });
      const taskId = minted.taskId as string;

      // Give the process a moment to actually spawn before killing it.
      await waitForJobState(taskId, "running");
      await pair.client.callTool({ name: "kill", arguments: { job_id: taskId } });
      await pollUntilTerminal(pair.client, taskId);

      const taskGet = await tasksRequest(pair.client, "tasks/get", taskId);
      assert.equal(taskGet.status, "cancelled");
      assert.equal(taskGet.result, undefined);
      assert.equal(taskGet.error, undefined);
    } finally {
      await pair.close();
    }
  });
});

// ---------------------------------------------------------------------------
// lastUpdatedAt: starts equal to createdAt, advances on real output arrival
// and on the terminal transition - the src/jobStore.ts half of this contract
// ---------------------------------------------------------------------------

// jobStore.ts's createFailedJob() (the policy-denial path) computes ONE
// shared `now` for started_at/last_updated_at/ended_at, so a freshly-minted
// denied job's lastUpdatedAt equals its createdAt exactly as a freshly-
// admitted one's does - this holds identically either way and needs no real
// spawn.
test("a freshly-minted task's lastUpdatedAt equals its createdAt - no state change has happened yet", async () => {
  const pair = await startPair(true);
  try {
    const minted = await mintJob(pair.client, {
      command: [process.execPath, "-e", "setTimeout(() => {}, 60000);"],
      label: "last-updated-fresh",
    });
    assert.equal(minted.lastUpdatedAt, minted.createdAt);
    await pair.client.callTool({ name: "kill", arguments: { job_id: minted.taskId as string } });
  } finally {
    await pair.close();
  }
});

// The three tests below all genuinely need a real spawn: lastUpdatedAt
// ADVANCING past createdAt over real elapsed time, a "still-working"
// pre-terminal status, and a "completed" (never "failed") terminal status
// are all properties a policy-denied job - immediately and synchronously
// terminal as "failed" - can never exhibit.
describe("spawning tests: task lifecycle - timing/status transitions need a real spawn", () => {
  before(requireSpawnPolicy);

  test("lastUpdatedAt advances past createdAt once the job produces real output and reaches its terminal instant - proving jobStore.ts's touch runs on output-arrival regardless of whether a watch is subscribed (a legacy-era connection here never starts a watch at all) and on every terminal transition", async () => {
    const pair = await startPair(true);
    try {
      const minted = await mintJob(pair.client, {
        command: [
          process.execPath,
          "-e",
          "process.stdout.write('line-1\\n'); setTimeout(() => { process.exitCode = 0; }, 30);",
        ],
        label: "last-updated-advances",
      });
      const taskId = minted.taskId as string;
      const createdAtMs = Date.parse(minted.createdAt as string);

      await pollUntilTerminal(pair.client, taskId);
      const taskGet = await tasksRequest(pair.client, "tasks/get", taskId);
      const lastUpdatedAtMs = Date.parse(taskGet.lastUpdatedAt as string);
      assert.ok(
        lastUpdatedAtMs > createdAtMs,
        `expected lastUpdatedAt (${taskGet.lastUpdatedAt}) to have advanced past createdAt (${minted.createdAt}) once output arrived and the job terminated`
      );
    } finally {
      await pair.close();
    }
  });

  // ---------------------------------------------------------------------------
  // statusMessage / watchStopped: this adapter's own new construction logic
  // for a pre-recorded watch-stop annotation, poked directly via the shared
  // jobStore singleton (in-process, same module registry - see
  // src/server.ts's own header doc on why this is possible without a real
  // firehose) rather than driving 5000 lines/sec for real - the firehose
  // TRIGGER itself (startTaskWatch/checkFirehose) is explicitly OUT of scope
  // here (see tasksAdapter.ts's own section header), but the
  // RENDERING of an already-recorded watch-stop into statusMessage/result/
  // error is new code and is tested here directly.
  // ---------------------------------------------------------------------------

  test("a pre-terminal watch-stop annotation renders as text into statusMessage on a still-working task - the spec-legal, otherwise-unused field this adapter's ONE use of it targets", async () => {
    const pair = await startPair(true);
    try {
      const minted = await mintJob(pair.client, {
        command: [process.execPath, "-e", "setTimeout(() => {}, 60000);"],
        label: "watch-stop-pre-terminal",
      });
      const taskId = minted.taskId as string;
      jobStore.recordOutputWatchStopped(taskId, "firehose", "2026-01-01T00:00:00.000Z");

      const taskGet = await tasksRequest(pair.client, "tasks/get", taskId);
      assert.equal(taskGet.status, "working");
      assert.equal(
        taskGet.statusMessage,
        "output watch auto-stopped (firehose) at 2026-01-01T00:00:00.000Z"
      );

      await pair.client.callTool({ name: "kill", arguments: { job_id: taskId } });
    } finally {
      await pair.close();
    }
  });

  test("the SAME watch-stop fact renders STRUCTURALLY, under result.watchStopped, once the task reaches a terminal state - never as statusMessage text on a terminal task", async () => {
    const pair = await startPair(true);
    try {
      const minted = await mintJob(pair.client, { label: "watch-stop-terminal" });
      const taskId = minted.taskId as string;
      await pollUntilTerminal(pair.client, taskId);
      jobStore.recordOutputWatchStopped(taskId, "firehose", "2026-01-01T00:00:00.000Z");

      const taskGet = await tasksRequest(pair.client, "tasks/get", taskId);
      assert.equal(taskGet.status, "completed");
      assert.equal(
        taskGet.statusMessage,
        undefined,
        "a terminal task must never carry the pre-terminal statusMessage rendering"
      );
      const result = taskGet.result as Record<string, unknown>;
      assert.deepEqual(result.watchStopped, {
        reason: "firehose",
        stoppedAt: "2026-01-01T00:00:00.000Z",
      });
    } finally {
      await pair.close();
    }
  });
});

// ---------------------------------------------------------------------------
// On a capable connection, the backing job stays pollable via the PLAIN
// status/output surface on the mapped job_id after an unsolicited handle is
// minted - the handle augments the poll floor, it never replaces it
// ---------------------------------------------------------------------------

// status()/output()/tail() never error against any TRACKED job_id, admitted
// or denied - a denied job is still a real, tracked record with zero output,
// never an untracked/unknown one - so this holds either way and needs no
// real spawn.
test("on a capable connection, status/output/tail on the mapped job_id keep working normally after a handle is minted - the plain poll floor is never replaced", async () => {
  const pair = await startPair(true);
  try {
    const minted = await mintJob(pair.client, {
      command: [process.execPath, "-e", "process.stdout.write('poll-floor-line\\n');"],
      label: "poll-floor-still-reachable",
    });
    const taskId = minted.taskId as string;

    const statusResult = runResultStructured(
      await pair.client.callTool({ name: "status", arguments: { job_id: taskId } })
    );
    assert.equal(statusResult.job_id, taskId);

    const outputResult = (await pair.client.callTool({
      name: "output",
      arguments: { job_id: taskId },
    })) as { isError?: boolean };
    assert.notEqual(
      outputResult.isError,
      true,
      "the plain output tool must still work on a minted job_id"
    );

    const tailResult = (await pair.client.callTool({
      name: "tail",
      arguments: { job_id: taskId },
    })) as { isError?: boolean };
    assert.notEqual(
      tailResult.isError,
      true,
      "the plain tail tool must still work on a minted job_id"
    );
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// tasks/update's own interim contract, on the released spec: a fixed,
// empty ack (resultType: "complete") that mutates NOTHING observable -
// asserted via the wire tap, since the client-decoded value strips
// resultType and leaves nothing else to look at. tasks/cancel shares the
// SAME fixed ack shape now, but is covered by its own idempotency test
// below since it ALSO has a real side effect the first time it runs.
// ---------------------------------------------------------------------------

// Both tests below explicitly assert on a specific NON-"failed" status
// ("working" / "completed") before checking idempotency - a property a
// policy-denied job (immediately "failed") can never satisfy - so both
// genuinely need a real spawn.
describe("spawning tests: task lifecycle - ack idempotency needs a genuinely live/completed job", () => {
  before(requireSpawnPolicy);

  test("tasks/update on a LIVE (working) task returns the fixed emittedAckResult on the wire and mutates NOTHING observable - proven by a full-object deep-equality of tasks/get before and after", async () => {
    const pair = await startPair(true);
    try {
      const minted = await mintJob(pair.client, {
        command: [process.execPath, "-e", "setTimeout(() => {}, 60000);"],
        label: "live-interim-contract",
      });
      const taskId = minted.taskId as string;
      await waitForJobState(taskId, "running"); // let it actually start running

      const before = await tasksRequest(pair.client, "tasks/get", taskId);
      await assertTaskStatus(
        pair.client,
        taskId,
        before.status,
        "working",
        "expected the task to still be working"
      );

      await tasksRequest(pair.client, "tasks/update", taskId);
      const raw = pair.wireTap.latestResultFor("tasks/update");
      assert.deepEqual(raw, { resultType: "complete" });
      const schema = loadSchema();
      assert.deepEqual(validatesAgainst(schema, "emittedAckResult", raw), []);

      const after = await tasksRequest(pair.client, "tasks/get", taskId);
      assert.deepEqual(
        after,
        before,
        "tasks/update must not have altered the observable job state in ANY field"
      );

      // Clean up the still-live background process.
      await pair.client.callTool({ name: "kill", arguments: { job_id: taskId } });
    } finally {
      await pair.close();
    }
  });

  test("tasks/update and tasks/cancel are each IDEMPOTENT on a TERMINAL task - both return the identical fixed ack every time, and repeated calls never alter the real tasks/get snapshot", async () => {
    const pair = await startPair(true);
    try {
      const minted = await mintJob(pair.client, {
        command: [process.execPath, "-e", "process.exitCode = 0;"],
        label: "terminal-interim-contract",
      });
      const taskId = minted.taskId as string;
      await pollUntilTerminal(pair.client, taskId);

      const firstGet = await tasksRequest(pair.client, "tasks/get", taskId);
      await assertTaskStatus(
        pair.client,
        taskId,
        firstGet.status,
        "completed",
        "expected the task to have completed"
      );

      await tasksRequest(pair.client, "tasks/update", taskId);
      const firstUpdateRaw = pair.wireTap.latestResultFor("tasks/update");
      await tasksRequest(pair.client, "tasks/update", taskId);
      const secondUpdateRaw = pair.wireTap.latestResultFor("tasks/update");
      assert.deepEqual(firstUpdateRaw, secondUpdateRaw);
      assert.deepEqual(firstUpdateRaw, { resultType: "complete" });

      await tasksRequest(pair.client, "tasks/cancel", taskId);
      const firstCancelRaw = pair.wireTap.latestResultFor("tasks/cancel");
      await tasksRequest(pair.client, "tasks/cancel", taskId);
      const secondCancelRaw = pair.wireTap.latestResultFor("tasks/cancel");
      assert.deepEqual(firstCancelRaw, secondCancelRaw);
      assert.deepEqual(firstCancelRaw, { resultType: "complete" });

      const finalGet = await tasksRequest(pair.client, "tasks/get", taskId);
      assert.deepEqual(finalGet, firstGet, "neither method may have altered the terminal snapshot");
    } finally {
      await pair.close();
    }
  });
});

test("on an UNKNOWN taskId, tasks/get, tasks/update, and tasks/cancel all THROW the IDENTICAL fixed task_not_found error - never an arbitrary/varying shape, and never a value the pre-story tagged-success contract would have returned", async () => {
  const pair = await startPair(true);
  try {
    const bogusId = "11111111-1111-4111-8111-111111111111";
    const messages: string[] = [];
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"] as const) {
      try {
        await tasksRequest(pair.client, method, bogusId);
        assert.fail(`expected ${method} to throw for an unknown taskId`);
      } catch (error) {
        messages.push(String((error as { message?: unknown })?.message ?? error));
      }
    }
    assert.equal(
      new Set(messages).size,
      1,
      `expected all three methods to throw the IDENTICAL message, got: ${JSON.stringify(messages)}`
    );
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// The seven-tool mint rule, from the other direction: run() mints,
// status/output/tail/kill/list/follow never mint, regardless of
// connection capability
// ---------------------------------------------------------------------------

// Every field name a minted CreateTaskResult/live handle carries that a
// PLAIN response must never carry any trace of, checked as a SET below -
// not merely "taskId is undefined". "resultType" replaces the pre-story
// "extension" discriminator (which no longer exists in this adapter's
// vocabulary at all).
const HANDLE_TELL_TALE_FIELDS = ["taskId", "pollIntervalMs", "resultType"] as const;

/** True when NONE of HANDLE_TELL_TALE_FIELDS appears anywhere in `body`'s own JSON serialization - a whole-object sweep, not a check of one named field. */
function carriesNoHandleTellTale(body: unknown): boolean {
  const serialized = JSON.stringify(body);
  return HANDLE_TELL_TALE_FIELDS.every((field) => !serialized.includes(`"${field}"`));
}

describe("spawning tests: seven-tool mint rule (run mints, every other tool stays plain)", () => {
  before(requireSpawnPolicy);

  test("seven-tool mint rule: on a capable connection, run() mints a handle while status/output/tail/kill/list/follow each return their PLAIN response with no handle minted - status/kill (both real PublicJobProjection shapes) are checked by full key-set AND VALUE deep-equality against the real plain job-projection shape, list/output/tail are checked by a genuine whole-object comparison against their real, complete values, and follow (called against this same, already-terminal job) is checked for the same absence of any minted-handle field", async () => {
    const pair = await startPair(true);
    try {
      const beforeFirstJobMs = Date.now();
      const minted = await mintJob(pair.client, {
        command: [process.execPath, "-e", "process.stdout.write('x');"],
        label: "seven-tool-mint-rule",
      });
      const taskId = minted.taskId as string;
      assert.equal(typeof minted.taskId, "string", "run() must mint on a capable connection");

      await pollUntilTerminal(pair.client, taskId);

      const PUBLIC_JOB_PROJECTION_KEYS = [
        "command_summary",
        "counts",
        "diagnostic",
        "ended_at",
        "exit_code",
        "escalation_refused_reason",
        "identity_capture",
        "identity_confirmed",
        "job_id",
        "kill_confirmed",
        "label",
        "last_wake_attempt",
        "queue_position",
        "signal",
        "started_at",
        "state",
      ].sort();

      // status's own response carries two ADDITIVE fields no other tool's
      // response does - `pid`/`birth_identity` (see
      // `src/tools/status.ts`'s `StatusProjection`) - so it gets its own key
      // set, layered on top of the shared PublicJobProjection one, rather
      // than widening PUBLIC_JOB_PROJECTION_KEYS itself: kill's own
      // assertion below still checks against the UNCHANGED shared set,
      // which is what actually proves status gained fields kill did not.
      const STATUS_PROJECTION_KEYS = [
        ...PUBLIC_JOB_PROJECTION_KEYS,
        "pid",
        "birth_identity",
      ].sort();

      // TWO further async-materialized fields the deep-equal below pins to an
      // exact value, neither of which `pollUntilTerminal` above ever waited
      // on (it only watches `state`) - a SIBLING of this same test's own
      // `kill_confirmed` fix a little further down (the SECOND job's
      // `kill_confirmed`), found here by sweeping this test by the general
      // shape of the race rather than by the specific `stdout_lines` field
      // name PR #88's measured failure happened to name.
      //
      // `kill_confirmed`: this job was never explicitly killed - it exits on
      // its own - so its `kill_confirmed` is populated ENTIRELY by
      // `src/tools/run.ts`'s `beginSpawn`'s own eager, fire-and-forget
      // `jobStore.reapProcessGroupOnce` call at the child's OS-level exit,
      // never awaited by any client-facing call. `createTerminalMarkGate`'s
      // "both streams already ended" FAST PATH can mark `state` "exited"
      // with NO dependency on that reap promise at all, so a plain
      // `pollUntilTerminal` can observe a terminal `state` before the reap's
      // own `JobStore.setKillConfirmation` write - real, asynchronous
      // event-loop scheduling latency with no ordering guarantee against
      // that read, never gated on the job's own state (see that setter's
      // own doc comment for why it no longer requires the record already
      // be terminal) - has landed. Poll via `pollUntilKillConfirmed` (established by commit
      // c12b111 for exactly this class, just triggered there by an explicit
      // `kill()` call instead of the natural-exit eager reap) exactly like
      // this test's own second job does below.
      //
      // `counts`: see `pollUntilCountsSettled`'s own docs immediately above
      // for the full mechanism - this is the exact failure PR #88 measured
      // (actual `stdout_lines` value 0, expected 1).
      //
      // Order matters only in that both must settle before `statusResult` is
      // captured for the deep-equal below; `pollUntilCountsSettled`'s own
      // status() reads happen strictly after `pollUntilKillConfirmed`
      // resolves, so its returned snapshot reflects both settled fields at
      // once.
      await pollUntilKillConfirmed(pair.client, taskId);
      const statusResult = await pollUntilCountsSettled(pair.client, taskId);
      const afterFirstJobMs = Date.now();
      assert.equal(statusResult.job_id, taskId);
      assert.deepEqual(
        Object.keys(statusResult).sort(),
        STATUS_PROJECTION_KEYS,
        `expected status's response to deep-equal STATUS_PROJECTION_KEYS exactly (no minted field, no dropped field, and including status's own additive pid/birth_identity fields), got: ${JSON.stringify(Object.keys(statusResult).sort())}`
      );

      assert.ok(
        Date.parse(statusResult.ended_at as string) >=
          Date.parse(statusResult.started_at as string),
        `expected status's ended_at (${JSON.stringify(statusResult.ended_at)}) to be at or after started_at (${JSON.stringify(statusResult.started_at)})`
      );
      const statusStartedAtMs = Date.parse(statusResult.started_at as string);
      const statusEndedAtMs = Date.parse(statusResult.ended_at as string);
      assert.ok(
        statusStartedAtMs >= beforeFirstJobMs && statusStartedAtMs <= afterFirstJobMs,
        `expected status's started_at (${JSON.stringify(statusResult.started_at)}) to fall inside the real wall-clock bracket [${beforeFirstJobMs}, ${afterFirstJobMs}] this test captured around the job's actual run`
      );
      assert.ok(
        statusEndedAtMs >= beforeFirstJobMs && statusEndedAtMs <= afterFirstJobMs,
        `expected status's ended_at (${JSON.stringify(statusResult.ended_at)}) to fall inside the real wall-clock bracket [${beforeFirstJobMs}, ${afterFirstJobMs}] this test captured around the job's actual run`
      );
      assert.ok(
        ["pending", "captured", "unavailable"].includes(statusResult.identity_capture as string),
        `expected status's identity_capture to be one of pending/captured/unavailable, got: ${JSON.stringify(statusResult.identity_capture)}`
      );

      // pid/birth_identity (see src/tools/status.ts's StatusProjection) are
      // status-only additive fields, sourced from the same real tracked
      // child jobStore.getChildHandle exposes - this job DID get a live
      // child (a real `node` process), so both must be present. pid is
      // checked as a real positive OS pid; birth_identity's exact settled
      // shape races the same async capture identity_capture already names
      // above (still "pending", or already "captured" with a real
      // platform-tagged identity payload, or "unavailable" if the capture
      // genuinely failed) - checked for STRUCTURAL validity here (never a
      // stray/malformed shape, and never a "captured" state missing its
      // identity payload or a non-captured state carrying one), then both
      // are excluded from the exact-literal comparison below for the same
      // reason identity_capture is: genuinely outside this test's control.
      assert.equal(
        typeof statusResult.pid,
        "number",
        `expected status's pid to be a real number, got: ${JSON.stringify(statusResult.pid)}`
      );
      assert.ok(
        (statusResult.pid as number) > 0,
        `expected status's pid to be a positive OS pid, got: ${JSON.stringify(statusResult.pid)}`
      );
      const birthIdentity = statusResult.birth_identity as { state?: string; identity?: unknown };
      assert.ok(
        typeof birthIdentity === "object" &&
          birthIdentity !== null &&
          ["pending", "captured", "unavailable"].includes(birthIdentity.state as string),
        `expected status's birth_identity.state to be one of pending/captured/unavailable, got: ${JSON.stringify(statusResult.birth_identity)}`
      );
      assert.equal(
        "identity" in birthIdentity,
        birthIdentity.state === "captured",
        `expected birth_identity to carry an "identity" payload if and only if its state is "captured" - never a "pending"/"unavailable" state carrying one, and never a "captured" state missing one - got: ${JSON.stringify(statusResult.birth_identity)}`
      );
      if (birthIdentity.state === "captured") {
        const identity = birthIdentity.identity as { platform?: string };
        assert.ok(
          identity.platform === "linux-starttime-ticks" || identity.platform === "posix-elapsed",
          `expected a captured birth_identity's platform to be linux-starttime-ticks or posix-elapsed, got: ${JSON.stringify(identity)}`
        );
      }

      // last_wake_attempt is excluded from the exact-value comparison below
      // for the SAME reason identity_capture/pid/birth_identity are - see
      // assertLastWakeAttemptStructurallyValidIfPresent's own doc comment
      // for the full reasoning. Structural validity is checked instead.
      assertLastWakeAttemptStructurallyValidIfPresent(statusResult);

      const statusWithoutIdentityCapture = { ...statusResult };
      delete statusWithoutIdentityCapture.identity_capture;
      delete statusWithoutIdentityCapture.pid;
      delete statusWithoutIdentityCapture.birth_identity;
      delete statusWithoutIdentityCapture.last_wake_attempt;
      assert.deepEqual(
        withTimestampFieldsChecked(statusWithoutIdentityCapture, ["started_at", "ended_at"]),
        {
          job_id: taskId,
          state: "exited",
          exit_code: 0,
          signal: undefined,
          diagnostic: undefined,
          queue_position: undefined,
          command_summary: path.basename(process.execPath),
          label: "seven-tool-mint-rule",
          counts: { stdout_lines: 1, stdout_bytes: 1, stderr_lines: 0, stderr_bytes: 0 },
          kill_confirmed: true,
          identity_confirmed: undefined,
          escalation_refused_reason: undefined,
        },
        `expected status's response to deep-equal its real, complete values, not just the right key set - got: ${JSON.stringify(statusResult)}`
      );

      const listResult = runResultStructured(
        await pair.client.callTool({ name: "list", arguments: {} })
      );
      assert.deepEqual(
        Object.keys(listResult).sort(),
        ["concurrency_cap", "jobs"],
        `expected list's response to deep-equal the real {jobs, concurrency_cap} key set exactly, got: ${JSON.stringify(Object.keys(listResult).sort())}`
      );
      const listedJobs = listResult.jobs as unknown[];
      assert.ok(
        Array.isArray(listedJobs),
        `expected list's jobs field to be an array, got: ${JSON.stringify(listResult.jobs)}`
      );
      assert.ok(
        carriesNoHandleTellTale(listedJobs),
        `list's response must carry NONE of ${JSON.stringify(HANDLE_TELL_TALE_FIELDS)} anywhere, got: ${JSON.stringify(listedJobs)}`
      );
      const listedEntry = (listedJobs as Array<Record<string, unknown>>).find(
        (job) => job.job_id === taskId
      );
      assert.ok(
        listedEntry,
        `expected list to include the minted, now-terminal job ${taskId}, got: ${JSON.stringify(listedJobs)}`
      );
      assert.deepEqual(
        listedEntry,
        {
          job_id: taskId,
          label: "seven-tool-mint-rule",
          state: "exited",
          started_at: statusResult.started_at,
          queue_position: undefined,
        },
        `expected list's entry for the minted job to deep-equal its real, complete values - got: ${JSON.stringify(listedEntry)}`
      );

      const outputResult = runResultStructured(
        await pair.client.callTool({ name: "output", arguments: { job_id: taskId } })
      );
      assert.ok(
        carriesNoHandleTellTale(outputResult),
        `output's response must carry NONE of ${JSON.stringify(HANDLE_TELL_TALE_FIELDS)} anywhere, got: ${JSON.stringify(outputResult)}`
      );
      assert.deepEqual(
        outputResult,
        { events: [{ seq: 1, stream: "stdout", text: "x", partial: true }], next_cursor: 1 },
        `expected output's response to deep-equal its real, complete values exactly - got: ${JSON.stringify(outputResult)}`
      );

      const tailResult = runResultStructured(
        await pair.client.callTool({ name: "tail", arguments: { job_id: taskId } })
      );
      assert.ok(
        carriesNoHandleTellTale(tailResult),
        `tail's response must carry NONE of ${JSON.stringify(HANDLE_TELL_TALE_FIELDS)} anywhere, got: ${JSON.stringify(tailResult)}`
      );
      assert.deepEqual(
        tailResult,
        outputResult,
        `expected tail's response to deep-equal output's real response exactly for this single-line, now-terminal job - got: ${JSON.stringify(tailResult)}`
      );

      // follow, the seventh tool: on this same capable connection, against
      // this same already-terminal job, it must stay exactly as plain as
      // the other five - no minted handle, ever, regardless of capability
      // (server.ts's tools/call dispatch only ever hands a result to the
      // adapter when request.params.name === "run", so this is a structural
      // guarantee, not merely an observed one). The job is already terminal,
      // so this resolves via follow's own immediate-return path (no timer
      // ever starts) rather than genuinely waiting out timeout_ms.
      const followResult = runResultStructured(
        await pair.client.callTool({
          name: "follow",
          arguments: { job_id: taskId, timeout_ms: 60_000 },
        })
      );
      assert.ok(
        carriesNoHandleTellTale(followResult),
        `follow's response must carry NONE of ${JSON.stringify(HANDLE_TELL_TALE_FIELDS)} anywhere, got: ${JSON.stringify(followResult)}`
      );
      assert.equal(
        followResult.reason,
        "terminal",
        `expected follow on this already-terminal job to return immediately via reason: "terminal" (never a 60s wait), got: ${JSON.stringify(followResult)}`
      );

      const beforeSecondJobMs = Date.now();
      const second = await mintJob(pair.client, {
        command: [process.execPath, "-e", "setTimeout(() => {}, 60000);"],
        label: "seven-tool-mint-rule-kill-target",
      });
      const secondTaskId = second.taskId as string;
      await waitForJobState(secondTaskId, "running"); // let it actually start running
      const killResult = runResultStructured(
        await pair.client.callTool({ name: "kill", arguments: { job_id: secondTaskId } })
      );
      const afterKillMs = Date.now();
      assert.deepEqual(
        Object.keys(killResult).sort(),
        PUBLIC_JOB_PROJECTION_KEYS,
        `expected kill's response to deep-equal the real PublicJobProjection key set exactly, got: ${JSON.stringify(Object.keys(killResult).sort())}`
      );

      // The checks below read `killResult` - the FIRST, synchronously
      // captured kill() response - directly, on purpose, never the later
      // poll-settled one: `src/tools/kill.ts`'s own doc comment is explicit
      // that the job's "killed" state (and, with it, started_at/ended_at,
      // which are only ever touched by a real state transition) is reported
      // SYNCHRONOUSLY, at kill-time, regardless of when the separate async
      // `kill_confirmed`/`identity_confirmed` confirmation later lands. So
      // this wall-clock bracket - captured around this FIRST call alone -
      // stays the right one to check against even though the poll below can
      // take real additional time afterward: nothing it does changes
      // started_at/ended_at, only kill_confirmed.
      assert.ok(
        Date.parse(killResult.ended_at as string) >= Date.parse(killResult.started_at as string),
        `expected kill's ended_at (${JSON.stringify(killResult.ended_at)}) to be at or after started_at (${JSON.stringify(killResult.started_at)})`
      );
      const killStartedAtMs = Date.parse(killResult.started_at as string);
      const killEndedAtMs = Date.parse(killResult.ended_at as string);
      assert.ok(
        killStartedAtMs >= beforeSecondJobMs && killStartedAtMs <= afterKillMs,
        `expected kill's started_at (${JSON.stringify(killResult.started_at)}) to fall inside the real wall-clock bracket [${beforeSecondJobMs}, ${afterKillMs}] this test captured around the killed job's actual run`
      );
      assert.ok(
        killEndedAtMs >= beforeSecondJobMs && killEndedAtMs <= afterKillMs,
        `expected kill's ended_at (${JSON.stringify(killResult.ended_at)}) to fall inside the real wall-clock bracket [${beforeSecondJobMs}, ${afterKillMs}] this test captured around the killed job's actual run`
      );
      // identity_confirmed/identity_capture are read from the same FIRST
      // `killResult` too - this test has never observed these two flaking
      // the way kill_confirmed does, and they are excluded from the final
      // deep-equal below anyway (deleted before the comparison, exactly as
      // before), so there is nothing riding on their exact settle timing
      // here.
      assert.equal(
        typeof killResult.identity_confirmed,
        "boolean",
        `expected kill's identity_confirmed to be present as a boolean once terminal, got: ${JSON.stringify(killResult.identity_confirmed)}`
      );
      assert.ok(
        ["pending", "captured", "unavailable"].includes(killResult.identity_capture as string),
        `expected kill's identity_capture to be one of pending/captured/unavailable, got: ${JSON.stringify(killResult.identity_capture)}`
      );

      // THE FIX: `kill_confirmed` is written by an async confirmation
      // callback inside kill's OWN implementation (see
      // `pollUntilKillConfirmed`'s own doc comment above, and
      // `src/tools/kill.ts`'s doc comment on the field itself) - the write
      // can genuinely lag this call's own promise resolution by real
      // event-loop scheduling latency, so `killResult.kill_confirmed` above
      // can legitimately still read `undefined` on a loaded CI runner even
      // though every OTHER field checked above is already final. Poll
      // (via repeated, idempotent `kill` calls against the same job_id -
      // never a second signal, see the poll helper's own docs) until it has
      // actually settled, and use THAT settled response - never the
      // original `killResult` - for the exact-value comparison below, which
      // is the one assertion that actually depends on kill_confirmed's real
      // value.
      const confirmedKillResult = await pollUntilKillConfirmed(pair.client, secondTaskId);
      // See assertLastWakeAttemptStructurallyValidIfPresent's own doc
      // comment (called on the first job's statusResult above) for why
      // last_wake_attempt is excluded from the exact-value comparison below
      // rather than asserted either present or absent.
      assertLastWakeAttemptStructurallyValidIfPresent(confirmedKillResult);
      const killResultWithoutIdentityFields = { ...confirmedKillResult };
      delete killResultWithoutIdentityFields.identity_confirmed;
      delete killResultWithoutIdentityFields.identity_capture;
      delete killResultWithoutIdentityFields.last_wake_attempt;
      // `counts` below needs no `pollUntilCountsSettled`-style wait, unlike
      // the first job above: this job's own command
      // (`setTimeout(() => {}, 60000)`) never writes a single byte to either
      // stream for its whole life, so `linesEverMaterialized`/
      // `bytesEverReceived` (see `pollUntilCountsSettled`'s own docs) start
      // at their all-zero initial value and have nothing to ever
      // materialize - there is no async output-arrival path in flight here
      // for a poll to race, only the SIGTERM handling's own kill_confirmed
      // gap this poll already covers.
      assert.deepEqual(
        withTimestampFieldsChecked(killResultWithoutIdentityFields, ["started_at", "ended_at"]),
        {
          job_id: secondTaskId,
          state: "killed",
          exit_code: undefined,
          signal: "SIGTERM",
          diagnostic: undefined,
          queue_position: undefined,
          command_summary: path.basename(process.execPath),
          label: "seven-tool-mint-rule-kill-target",
          counts: { stdout_lines: 0, stdout_bytes: 0, stderr_lines: 0, stderr_bytes: 0 },
          kill_confirmed: true,
          escalation_refused_reason: undefined,
        },
        `expected kill's response to deep-equal its real, complete values, not just the right key set - got: ${JSON.stringify(confirmedKillResult)}`
      );
    } finally {
      await pair.close();
    }
  });
}); // end describe("spawning tests: seven-tool mint rule (run mints, every other tool stays plain)")

describe("spawning tests: simulated end-to-end host proof", () => {
  before(requireSpawnPolicy);

  // ---------------------------------------------------------------------------
  // A deterministic, simulated stand-in for verification against a real
  // Tasks-capable host - that verification needs an actual external client
  // and is not exercised here. A SIMULATED Tasks-capable client observes the
  // FULL negotiate -> unsolicited-handle -> tasks/get sequence, and this test
  // fails closed (throws) if any step in that sequence is skipped or silently
  // absent, so a hollow fixture could never masquerade as this proof. It
  // explicitly requires the final status to be "completed" - a policy-denied
  // job resolves "failed" instead - so it genuinely needs a real spawn.
  // ---------------------------------------------------------------------------

  test("simulated Tasks-capable host: negotiate -> unsolicited handle -> tasks/get poll, every step observed and none skippable", async () => {
    const pair = await startPair(true);
    try {
      const serverCapabilities = pair.client.getServerCapabilities();
      const negotiated = Boolean(serverCapabilities?.extensions?.[TASKS_EXTENSION_URI]);
      if (!negotiated) {
        throw new Error(
          "simulated host: negotiation step failed - server never advertised the Tasks extension"
        );
      }

      const minted = await mintJob(pair.client, { label: "simulated-host-e2e" });
      if (typeof minted.taskId !== "string") {
        throw new Error(
          `simulated host: unsolicited-handle step failed - expected a minted CreateTaskResult, got ${JSON.stringify(minted)}`
        );
      }
      const taskId = minted.taskId;

      await pollUntilTerminal(pair.client, taskId);
      const finalTask = await tasksRequest(pair.client, "tasks/get", taskId);
      if (finalTask.status !== "completed") {
        throw new Error(
          `simulated host: tasks/get poll step failed - expected a completed task, got ${JSON.stringify(finalTask)}`
        );
      }

      assert.equal(negotiated, true);
      assert.equal(typeof taskId, "string");
      assert.equal(finalTask.status, "completed");
    } finally {
      await pair.close();
    }
  });
}); // end describe("spawning tests: simulated end-to-end host proof")

// tasksAdapter.ts's buildCreateTaskResult() sets `pollIntervalMs:
// DEFAULT_POLL_INTERVAL_MS` unconditionally on every mint response - it is
// projected from record.state via mapJobStateToTaskStatus with no branch on
// admission at all, so a policy-denied mint carries the exact same constant.
// This needs no real spawn.
test("the poll interval hint is a positive, stable constant on every minted/live result", async () => {
  const pair = await startPair(true);
  try {
    const minted = await mintJob(pair.client, { label: "poll-interval-hint" });
    assert.equal(minted.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    assert.ok((minted.pollIntervalMs as number) > 0);
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// A completeness sweep: every tracked behavioral commitment this capability
// makes has a real, findable test backing it SOMEWHERE in this suite - never
// a silently-dropped area. Kept LIGHT, on purpose: each entry names the file
// the commitment is proven in and a short, distinctive substring its real
// test title must contain - not a re-derivation of any internal planning
// document, just a checklist of the behaviors this capability's own design
// commits to, each pointed at the real test that proves it. A stale
// substring (a renamed test whose title changed) reds this exactly as
// loudly as a genuinely missing test would.
// ---------------------------------------------------------------------------

interface CompletenessArea {
  readonly area: string;
  readonly file: string;
  readonly titleContains: string;
}

/**
 * COMPLETENESS_AREAS is declared in THIS file, so a naive substring search
 * of test/tasks.test.ts's own source text against a same-file row's
 * `titleContains` would trivially "find" the string inside the array's OWN
 * field value below - even after the real test it names has been deleted
 * entirely. Every row whose `file` is this same file is therefore checked
 * against this file's text with the array's OWN source region excised
 * first (see `textExcludingCompletenessAreasSource` below), so a same-file
 * row can only be satisfied by a REAL test title living elsewhere in the
 * file, never by matching its own row.
 */
const SELF_FILE = "test/tasks.test.ts";

function textExcludingCompletenessAreasSource(rawText: string): string {
  const start = rawText.indexOf("const COMPLETENESS_AREAS");
  const closeMarker = "\n];\n";
  const end = start === -1 ? -1 : rawText.indexOf(closeMarker, start);
  if (start === -1 || end === -1) {
    throw new Error(
      "expected to find the COMPLETENESS_AREAS array's exact source region in " +
        `${SELF_FILE} - the same-file self-reference guard cannot verify same-file ` +
        "completeness rows without it"
    );
  }
  return rawText.slice(0, start) + rawText.slice(end + closeMarker.length);
}

const COMPLETENESS_AREAS: readonly CompletenessArea[] = [
  {
    area: "capability advertisement at initialize, on both a capable and a non-capable connection",
    file: "test/tasks.test.ts",
    titleContains:
      "advertises io.modelcontextprotocol/tasks in its initialize-negotiated capabilities",
  },
  {
    area: "the advertised capability descriptor is exactly {} per the released spec",
    file: "test/tasks.test.ts",
    titleContains: "the released spec's own TasksExtensionCapability forbids any key at all",
  },
  {
    area: "unsolicited mint on a bare run() call, no per-request opt-in field involved",
    file: "test/tasks.test.ts",
    titleContains: "unsolicited server-minted task handle on a bare run() call",
  },
  {
    area: "minting depends only on the connection, never a request-level capability/task field",
    file: "test/tasks.test.ts",
    titleContains: "no request-level capability/task field whatsoever",
  },
  {
    area: "a non-capable connection stays byte-stable with the real plain job_id shape",
    file: "test/tasks.test.ts",
    titleContains: "returns the plain job projection",
  },
  {
    area: "the minted result's RAW wire shape validates against the vendored createTaskResult schema, resultType included, the disclosed content artifact stripped",
    file: "test/tasks.test.ts",
    titleContains: "validates against the real, digest-verified vendored createTaskResult schema",
  },
  {
    area: "the disclosed SDK content-injection artifact on a mint is bounded to exactly that one key",
    file: "test/tasks.test.ts",
    titleContains: "never structuredContent, never an unbounded extra field set",
  },
  {
    area: "N mints produce N distinct, high-entropy taskIds under the identity mapping",
    file: "test/tasks.test.ts",
    titleContains: "distinct, high-entropy v4-UUID-format taskIds",
  },
  {
    area: "the registered task method set is exactly {tasks/get, tasks/update, tasks/cancel}, by real set-equality",
    file: "test/tasks.test.ts",
    titleContains: "a genuine SET-EQUALITY over the server's OWN real registration mechanism",
  },
  {
    area: "checkSdkExactPin() enforces the exact split-package pin, the required frozen version, and lockfile agreement",
    file: "test/check-sdk-exact-pin.test.js",
    titleContains: "the real, current exact-pinned repo state passes with zero problems",
  },
  {
    area: "the vendored extension schema pin is in-repo and never a fabricated npm dependency",
    file: "test/check-sdk-exact-pin.test.js",
    titleContains: "fabricated io.modelcontextprotocol Tasks npm dependency",
  },
  {
    area: "the vendored schema's recorded digest is ENFORCED against its real bytes, not merely present",
    file: "test/check-sdk-exact-pin.test.js",
    titleContains: "the recorded digest is ENFORCED, not decorative",
  },
  {
    area: "the symbol-aware Tasks-import guard flags a Tasks symbol reaching a core module, adapter excepted",
    file: "test/no-tasks-import.test.ts",
    titleContains:
      "the real src/ tree references nothing from the Tasks extension outside the permitted adapter carveout",
  },
  {
    area: "the adapter carveout is narrow: it suppresses only its own legitimate Tasks-symbol use, never every finding class",
    file: "test/no-tasks-import.test.ts",
    titleContains: "the adapter carveout is narrow: a MIXED adapter file",
  },
  {
    area: "a simulated Tasks-capable host proves the full negotiate -> unsolicited handle -> tasks/get sequence end to end",
    file: "test/tasks.test.ts",
    titleContains: "simulated Tasks-capable host",
  },
  {
    area: "TASK_STATUSES is a subset of, never equal to, the schema's status enum, and input_required/expired are excluded for stated reasons",
    file: "test/tasks.test.ts",
    titleContains: "is a SUBSET of the vendored schema's own taskStatus enum",
  },
  {
    area: "tasks/get resolves to the same JobRecord status() reports, with genuine cross-field agreement",
    file: "test/tasks.test.ts",
    titleContains: "not just a matching taskId, but genuine cross-field agreement",
  },
  {
    area: "tasks/get reflects a real terminal job state under result.exitCode/result.output, never a top-level field or a canned working status",
    file: "test/tasks.test.ts",
    titleContains: "never top-level exitCode/output",
  },
  {
    area: "the plain poll floor stays reachable after a handle is minted",
    file: "test/tasks.test.ts",
    titleContains: "the plain poll floor is never replaced",
  },
  {
    area: "tasks/update's interim contract on a LIVE task is the fixed ack, verified via the wire tap, with state preservation proven by full-object comparison",
    file: "test/tasks.test.ts",
    titleContains: "mutates NOTHING observable - proven by a full-object deep-equality",
  },
  {
    area: "tasks/update and tasks/cancel are each idempotent on a terminal task",
    file: "test/tasks.test.ts",
    titleContains: "are each IDEMPOTENT on a TERMINAL task",
  },
  {
    area: "an unknown taskId throws the identical fixed task_not_found error across get/update/cancel",
    file: "test/tasks.test.ts",
    titleContains: "all THROW the IDENTICAL fixed task_not_found error",
  },
  {
    area: "module-boundary admission adds the adapter without opening the frozen set to any new module",
    file: "test/module-boundaries.test.ts",
    titleContains:
      "the frozen set admits src/tasksAdapter.ts, and a DIFFERENT unknown new src/ module is still rejected",
  },
  {
    area: "run() mints while every other tool stays plain, regardless of capability",
    file: "test/tasks.test.ts",
    titleContains:
      "status/kill (both real PublicJobProjection shapes) are checked by full key-set AND VALUE deep-equality",
  },
  {
    area: "an empty-string taskId is rejected at the request-validation boundary, never silently echoed through",
    file: "test/tasks.test.ts",
    titleContains: "REJECTED at the request-validation boundary on all three task methods",
  },
  {
    area: "tasks/update accepts an inputResponses param per the released spec's request shape, without interpreting it",
    file: "test/tasks.test.ts",
    titleContains: "matching the released spec's own {taskId, inputResponses} request shape",
  },
  {
    area: "a client declaring ONLY the SDK-deprecated capabilities.tasks shape (never extensions/experimental) never reaches the extension",
    file: "test/tasks.test.ts",
    titleContains:
      "declaring ONLY the SDK-deprecated capabilities.tasks shape (no extensions/experimental bag at all)",
  },
  {
    area: "a pre-terminal watch-stop annotation renders into statusMessage; the same fact renders structurally under result/error once terminal",
    file: "test/tasks.test.ts",
    titleContains: "renders as text into statusMessage on a still-working task",
  },
  {
    area: "lastUpdatedAt starts equal to createdAt and advances on real output arrival and terminal transition",
    file: "test/tasks.test.ts",
    titleContains: "advances past createdAt once the job produces real output",
  },
  {
    area: "the SAME SDK-deprecated capabilities.tasks-only proof, on the MODERN era's own per-request envelope read - a distinct code path from the legacy connection-level getClientCapabilities() the row above exercises, so one proof does not stand in for the other",
    file: "test/modern-handshake.test.ts",
    titleContains:
      "the modern era's own per-request envelope read, not the legacy connection-level one",
  },
  {
    area: "server/discover's real wire response advertises the exact Tasks extension descriptor tasksAdapter constructs, not merely a truthy or locally-imported stand-in - the baseline discover test",
    file: "test/modern-handshake.test.ts",
    titleContains:
      "returns a successful result advertising the 2026-07-28 revision and the tools capability",
  },
  {
    area: "a modern-era (2026-07-28) tools/call whose OWN per-request envelope declares io.modelcontextprotocol/tasks mints a real Task result",
    file: "test/modern-handshake.test.ts",
    titleContains:
      "mints a real Task result whose taskId is a real, present string, on the RAW wire shape",
  },
  {
    area: "the modern era's per-request declaration is genuinely per-request, not cached at the connection level - an immediately-following incapable request on the SAME connection never mints",
    file: "test/modern-handshake.test.ts",
    titleContains:
      "proving the negotiation above is genuinely per-request, not cached at the connection level",
  },
  {
    area: "the seven-tool mint rule, on the MODERN wire: status/output/tail/kill/list/follow all stay plain even with Tasks capability declared on their own request, on the SAME connection where run() just minted",
    file: "test/modern-handshake.test.ts",
    titleContains:
      "run() mints while status/output/tail/kill/list/follow each stay plain, even with Tasks capability declared on their OWN request too",
  },
];

test("completeness sweep: every tracked behavioral commitment for this capability has a real, findable test backing it - the absence of any one reds this assertion, so a silently-dropped area or a stale/renamed test title cannot go unnoticed", () => {
  const missing: string[] = [];
  const fileTextCache = new Map<string, string>();
  for (const { area, file, titleContains } of COMPLETENESS_AREAS) {
    let text = fileTextCache.get(file);
    if (text === undefined) {
      const rawText = readFileSync(path.join(REPO_ROOT, file), "utf8");
      text = file === SELF_FILE ? textExcludingCompletenessAreasSource(rawText) : rawText;
      fileTextCache.set(file, text);
    }
    if (!text.includes(titleContains)) {
      missing.push(`${area} (expected to find "${titleContains}" in ${file})`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `orphaned/uncovered areas - a tracked commitment with no findable backing test: ${JSON.stringify(missing, null, 2)}`
  );
});
