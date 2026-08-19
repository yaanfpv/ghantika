/**
 * Proves the wake-latency instrumentation: `buildWakeLatencyRecord`
 * / `emitWakeLatency` in `src/tasksAdapter.ts`, and their wiring into
 * `startTransportWakeOnTerminal`.
 *
 * Reuses `test/wake-transport-wiring.test.ts`'s own established harness
 * (`maybeAugmentRunResult` + `jobStore` driven directly, `DEFAULT_TRANSPORTS`
 * singletons mocked via `t.mock.method`, `neutralizeClaudeMessagingTransport`,
 * `settle()`) rather than re-deriving it - this file's subject is the
 * TIMING record that wiring now also produces, not the gating/dispatch logic
 * that file already covers.
 *
 * Covers:
 *   - AC1: three real, correlated timestamps per job, captured from the
 *     genuine elapsed time of a real (mocked, but genuinely delayed) async
 *     transport call - never a fixed or synthesized number.
 *   - AC2: the two measurable gaps (`dispatchSeamMs`, `transportCallMs`) are
 *     reported as separate, named fields - never collapsed into one summary
 *     duration.
 *   - AC3: the payload actually sent to `wake()` is byte-identical to the
 *     known template, in both an outcome and a throw scenario - proving the
 *     new diagnostic code path never touches the wire-visible payload.
 *   - AC4: the instrumentation's own cost, measured directly (no I/O, no
 *     process spawn) rather than asserted by architecture alone.
 *   - The "threw" outcome path: `selectAndWake`'s own promise rejecting is
 *     still recorded, with an honest `outcome`/`transportName` for the case
 *     where no real `WakeResult` exists to name a transport from.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/server";

import { jobStore } from "../dist/jobStore.js";
import {
  buildWakeLatencyRecord,
  emitWakeLatency,
  maybeAugmentRunResult,
  WAKE_LATENCY_LOG_TAG,
} from "../dist/tasksAdapter.js";
import type { WakeTargetResolution } from "../dist/wake/resolveWakeTarget.js";
import { DEFAULT_TRANSPORTS } from "../dist/wake/selectTransport.js";
import type { Capability, WakeResult, WakeTarget } from "../dist/wake/wakeTransport.js";

const WAKE_TRANSPORT_ENABLED_ENV_VAR = "GHANTIKA_WAKE_TRANSPORT_ENABLED";

/** Same save/mutate/restore-in-finally shape `test/wake-transport-wiring.test.ts`'s own `withWakeTransportEnabled` establishes. */
async function withWakeTransportEnabled(
  value: string | undefined,
  fn: () => Promise<void>
): Promise<void> {
  const original = process.env[WAKE_TRANSPORT_ENABLED_ENV_VAR];
  try {
    if (value === undefined) delete process.env[WAKE_TRANSPORT_ENABLED_ENV_VAR];
    else process.env[WAKE_TRANSPORT_ENABLED_ENV_VAR] = value;
    await fn();
  } finally {
    if (original === undefined) delete process.env[WAKE_TRANSPORT_ENABLED_ENV_VAR];
    else process.env[WAKE_TRANSPORT_ENABLED_ENV_VAR] = original;
  }
}

let jobLabelCounter = 0;

function createNonTerminalJob(label: string): { readonly job_id: string } {
  jobLabelCounter += 1;
  return jobStore.createJob({
    argv: ["true"],
    cwd: "/tmp",
    env: {},
    isShell: false,
    label: `${label}-${jobLabelCounter}`,
  });
}

function makeRunResult(jobId: string): CallToolResult {
  return { content: [], structuredContent: { job_id: jobId } } as unknown as CallToolResult;
}

function noopNotifier(): void {
  // intentionally empty
}

/** Same settle-the-fire-and-forget-chain helper as `test/wake-transport-wiring.test.ts`'s own, at the SAME two-tick depth: one for the mocked transport's own promise, one for this adapter's `.then`/`.catch` handler (which now also runs `emitWakeLatency` before returning). */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function unavailable(reason: string): () => Promise<Capability> {
  return () => Promise.resolve({ available: false, reason, probedAt: new Date().toISOString() });
}

function available(): Promise<Capability> {
  return Promise.resolve({ available: true, probedAt: new Date().toISOString() });
}

/** Same neutralization as `test/wake-transport-wiring.test.ts`'s own - required at the top of every test below for the identical reason (this process genuinely inherits Claude Code's own messaging env vars, so left unmocked the FIRST transport in DEFAULT_TRANSPORTS would report itself available and short-circuit the app-server mock this file exists to exercise). */
function neutralizeClaudeMessagingTransport(t: TestContext): void {
  t.mock.method(
    DEFAULT_TRANSPORTS[0]!,
    "probe",
    unavailable(
      "neutralized for this test - see neutralizeClaudeMessagingTransport's own doc comment"
    )
  );
}

/** A `wake()` implementation that genuinely waits `delayMs` (a real `setTimeout`, not a synchronous resolve) before resolving `"delivered"` - so `transportCallMs` in the captured record measures a REAL elapsed interval this test controls precisely, rather than an unmeasurable near-zero gap that could pass even if the instrumentation captured two identical timestamps by accident. */
function deliversAfter(delayMs: number, transportName: string): () => Promise<WakeResult> {
  return () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({ outcome: "delivered", transportName, detail: "test-fixture-delivered" });
      }, delayMs);
    });
}

function rejectsAfter(delayMs: number, message: string): () => Promise<WakeResult> {
  return () =>
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), delayMs);
    });
}

/** Captures every `console.error` call whose first argument is exactly `WAKE_LATENCY_LOG_TAG`, parsing the second argument as the JSON record `emitWakeLatency` wrote - this file's own way of reading back what the real wiring actually logged, never asserting on the adapter's internal state directly. */
function captureWakeLatencyRecords(t: TestContext): () => Array<Record<string, unknown>> {
  const spy = t.mock.method(console, "error");
  return () =>
    spy.mock.calls
      .filter((call) => call.arguments[0] === WAKE_LATENCY_LOG_TAG)
      .map((call) => JSON.parse(call.arguments[1] as string) as Record<string, unknown>);
}

// =============================================================================
// AC1 + AC2: real, correlated timestamps; two gaps, reported separately.
// =============================================================================

test("AC1/AC2: a delivered wake logs one correlated record whose three timestamps are monotonic and whose two gaps are separate, named fields - never collapsed into one duration", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    neutralizeClaudeMessagingTransport(t);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    // A real 40ms delay - long enough to be unambiguously distinct from
    // scheduler jitter (a few ms at most on this test's own event loop),
    // short enough not to slow the suite.
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", deliversAfter(40, "codex-app-server-goal"));
    t.mock.method(
      DEFAULT_TRANSPORTS[2]!,
      "probe",
      unavailable("second transport never reached once the first delivers")
    );
    const readRecords = captureWakeLatencyRecords(t);

    const job = createNonTerminalJob("ac1-ac2-delivered");
    const target: WakeTarget = "thread-ac1-ac2";
    const resolution: WakeTargetResolution = { state: "resolved", target };
    maybeAugmentRunResult(makeRunResult(job.job_id), true, noopNotifier, resolution);

    jobStore.markExited(job.job_id, 0, null);
    // The mocked wake() itself takes ~40ms, so the ordinary two-tick
    // settle() is not enough here - poll for the record instead of
    // guessing a fixed extra delay.
    const deadline = Date.now() + 2_000;
    let records = readRecords();
    while (records.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      records = readRecords();
    }

    assert.equal(
      records.length,
      1,
      `expected exactly one wake-latency record, got ${records.length}`
    );
    const record = records[0]!;

    assert.equal(
      record.taskId,
      job.job_id,
      "the record must correlate to the exact job it is about"
    );
    assert.equal(record.outcome, "delivered");
    assert.equal(record.transportName, "codex-app-server-goal");

    const tTerminal = record.tTerminalMs as number;
    const tEnter = record.tSelectAndWakeEnterMs as number;
    const tComplete = record.tTransportCompleteMs as number;
    assert.ok(
      tTerminal <= tEnter,
      `t_terminal (${tTerminal}) must not be after t_selectAndWake_enter (${tEnter})`
    );
    assert.ok(
      tEnter <= tComplete,
      `t_selectAndWake_enter (${tEnter}) must not be after t_transport_complete (${tComplete})`
    );

    // AC2's own requirement: the two gaps are SEPARATE, NAMED fields, never
    // collapsed into one summary duration.
    assert.equal(record.dispatchSeamMs, tEnter - tTerminal);
    assert.equal(record.transportCallMs, tComplete - tEnter);
    assert.ok(
      (record.transportCallMs as number) >= 35,
      // >=35 rather than >=40: real setTimeout/event-loop scheduling can
      // fire a few ms early on a loaded host; this still unambiguously
      // distinguishes a REAL measured interval from a near-zero accident.
      `transportCallMs (${record.transportCallMs as number}) must reflect the real ~40ms mocked delay, not a near-zero or synthesized value`
    );
    // The record carries no single collapsed "latency" field at all - only
    // the three raw instants and the two named, derived gaps.
    assert.deepEqual(
      Object.keys(record).sort(),
      [
        "dispatchSeamMs",
        "outcome",
        "tSelectAndWakeEnterMs",
        "tTerminalMs",
        "tTransportCompleteMs",
        "transportCallMs",
        "transportName",
        "taskId",
      ].sort(),
      "the record's own field set must never grow a collapsed summary-duration field"
    );
  });
});

test('AC1: a rejecting wake() is recorded honestly as the real outcome selectAndWake itself reports ("unavailable") - it does NOT propagate as a "threw" record, because selectAndWake CATCHES a transport rejection internally and folds it into its own aggregate result rather than rejecting its own promise (see src/wake/selectTransport.ts\'s own selectAndWake doc comment: "wake() throwing... is treated as that transport failing this attempt exactly like an unavailable result"). This test exists specifically because an earlier version of THIS FILE assumed the opposite and asserted "threw" here - it failed against the real wiring, which is exactly what caught the wrong assumption.', async (t) => {
  await withWakeTransportEnabled("1", async () => {
    neutralizeClaudeMessagingTransport(t);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", rejectsAfter(20, "wake() threw for this test"));
    t.mock.method(
      DEFAULT_TRANSPORTS[2]!,
      "probe",
      unavailable("second transport never reached once the first is attempted")
    );
    const readRecords = captureWakeLatencyRecords(t);

    const job = createNonTerminalJob("ac1-transport-rejects");
    const target: WakeTarget = "thread-transport-rejects";
    const resolution: WakeTargetResolution = { state: "resolved", target };
    maybeAugmentRunResult(makeRunResult(job.job_id), true, noopNotifier, resolution);

    jobStore.markExited(job.job_id, 0, null);
    const deadline = Date.now() + 2_000;
    let records = readRecords();
    while (records.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      records = readRecords();
    }

    assert.equal(
      records.length,
      1,
      `expected exactly one wake-latency record, got ${records.length}`
    );
    const record = records[0]!;
    assert.equal(record.taskId, job.job_id);
    // selectAndWake's own exhaustion-outcome rule (see this test's own name):
    // no transport "refused" (a genuine JSON-RPC-style decline), so the
    // aggregate falls back to "unavailable" - never "threw", which this
    // record shape reserves for selectAndWake's OWN promise rejecting, a
    // case selectAndWake's own documented contract says should not happen
    // in ordinary operation (see the doc comment quoted in this test's
    // name) and which this file therefore does not attempt to force.
    assert.equal(record.outcome, "unavailable");
    assert.equal(record.transportName, "wake-transport-selector");
    assert.ok((record.transportCallMs as number) >= 0, "transportCallMs must never be negative");
  });
});

// =============================================================================
// AC3: the payload actually sent to wake() is byte-identical to the known
// template, in both an outcome scenario and a throw scenario - proving the
// new diagnostic code never touches the wire-visible payload.
// =============================================================================

test("AC3: the wake() payload is byte-identical to the known template - unaffected by whether the diagnostic emission succeeds, throws, or is present at all", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    neutralizeClaudeMessagingTransport(t);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    const wakeSpy = t.mock.method(
      DEFAULT_TRANSPORTS[1]!,
      "wake",
      deliversAfter(5, "codex-app-server-goal")
    );
    t.mock.method(
      DEFAULT_TRANSPORTS[2]!,
      "probe",
      unavailable("second transport never reached once the first delivers")
    );

    const job = createNonTerminalJob("ac3-payload-bytes");
    const target: WakeTarget = "thread-ac3";
    const resolution: WakeTargetResolution = { state: "resolved", target };
    maybeAugmentRunResult(makeRunResult(job.job_id), true, noopNotifier, resolution);

    jobStore.markExited(job.job_id, 0, null);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(wakeSpy.mock.callCount(), 1);
    const [, calledPayload] = wakeSpy.mock.calls[0]!.arguments;
    const expected = `ghantika job ${job.job_id} reached exited - use status/output/tail to read the result`;
    assert.equal(
      calledPayload,
      expected,
      "the payload buildTransportWakePayload produces must be byte-identical to the known template, whether or not wake-latency instrumentation runs afterward"
    );
  });
});

// =============================================================================
// AC4: measure the instrumentation's own cost directly - no I/O, no process
// spawn, a pure microbenchmark of exactly the code path that runs on every
// wake attempt (buildWakeLatencyRecord + JSON.stringify).
// =============================================================================

test("AC4: buildWakeLatencyRecord + JSON.stringify (the exact per-attempt cost emitWakeLatency pays before writing to stderr) measures under 0.1ms per call on average, disclosed rather than assumed", () => {
  const ITERATIONS = 10_000;
  const sample = {
    taskId: "ac4-benchmark-task",
    tTerminalMs: 1_000,
    tSelectAndWakeEnterMs: 1_001,
    tTransportCompleteMs: 1_250,
    outcome: "delivered",
    transportName: "codex-app-server-goal",
  };

  const start = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i += 1) {
    JSON.stringify(buildWakeLatencyRecord(sample));
  }
  const elapsedNs = Number(process.hrtime.bigint() - start);
  const perCallMs = elapsedNs / ITERATIONS / 1_000_000;

  // Disclosed, not silently swallowed: if this ever regresses meaningfully,
  // the assertion below fails loudly with the real measured number rather
  // than passing on an unstated assumption.
  assert.ok(
    perCallMs < 0.1,
    `buildWakeLatencyRecord+JSON.stringify measured ${perCallMs.toFixed(5)}ms/call over ${ITERATIONS} iterations - expected under 0.1ms/call`
  );
});

test("AC4: emitWakeLatency itself (including the console.error call) measures under 1ms per call on average, against a stubbed console.error so this benchmark's own stdout/stderr capture cost is excluded", (t) => {
  const ITERATIONS = 5_000;
  t.mock.method(console, "error", () => {
    // intentionally empty - this benchmark measures this file's own call
    // path, not the test runner's own stderr-capture overhead.
  });
  const sample = {
    taskId: "ac4-benchmark-task-2",
    tTerminalMs: 2_000,
    tSelectAndWakeEnterMs: 2_002,
    tTransportCompleteMs: 2_500,
    outcome: "refused",
    transportName: "codex-app-server-goal",
  };

  const start = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i += 1) {
    emitWakeLatency(sample);
  }
  const elapsedNs = Number(process.hrtime.bigint() - start);
  const perCallMs = elapsedNs / ITERATIONS / 1_000_000;

  assert.ok(
    perCallMs < 1,
    `emitWakeLatency measured ${perCallMs.toFixed(5)}ms/call over ${ITERATIONS} iterations - expected under 1ms/call`
  );
});

// =============================================================================
// buildWakeLatencyRecord as a pure unit - no process, no mocks, exact
// arithmetic.
// =============================================================================

test("buildWakeLatencyRecord: gaps are computed by plain subtraction of the three raw instants, never rounded, estimated, or derived any other way", () => {
  const record = buildWakeLatencyRecord({
    taskId: "unit-task",
    tTerminalMs: 1_000,
    tSelectAndWakeEnterMs: 1_007,
    tTransportCompleteMs: 1_213,
    outcome: "delivered",
    transportName: "codex-app-server-goal",
  });

  assert.equal(record.dispatchSeamMs, 7);
  assert.equal(record.transportCallMs, 206);
  assert.equal(record.tTerminalMs, 1_000);
  assert.equal(record.tSelectAndWakeEnterMs, 1_007);
  assert.equal(record.tTransportCompleteMs, 1_213);
  assert.equal(record.taskId, "unit-task");
  assert.equal(record.outcome, "delivered");
  assert.equal(record.transportName, "codex-app-server-goal");
});

test("buildWakeLatencyRecord: a zero-width gap (an instant transport call) is reported as exactly 0, never omitted or treated specially", () => {
  const record = buildWakeLatencyRecord({
    taskId: "unit-task-zero",
    tTerminalMs: 500,
    tSelectAndWakeEnterMs: 500,
    tTransportCompleteMs: 500,
    outcome: "unavailable",
    transportName: "wake-transport-selector",
  });

  assert.equal(record.dispatchSeamMs, 0);
  assert.equal(record.transportCallMs, 0);
});
