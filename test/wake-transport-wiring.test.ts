/**
 * Proves `src/tasksAdapter.ts`'s `startTransportWakeOnTerminal` subscriber:
 * its internal-only `GHANTIKA_WAKE_TRANSPORT_ENABLED` opt-in gate, its
 * fail-closed behavior on every `WakeTargetResolution` state other than
 * `"resolved"`, and its dispatch through the real transport selector.
 *
 * Calls `maybeAugmentRunResult` directly and drives `jobStore` directly,
 * rather than a real spawned server - this file's subject is internal
 * gating/dispatch logic inside one function, given an already-resolved
 * `WakeTargetResolution`. It never re-proves the Tasks-extension wire
 * contract (capability negotiation, the six-tool mint rule, SDK-facing
 * minting/notification shapes) - that lives in `test/tasks.test.ts` and its
 * siblings, unaffected here. Reaching `WakeTargetResolution` from a real
 * client's actual `_meta.threadId` over the real wire - the server-to-
 * resolver hand-off itself - is covered separately, end to end, by
 * `test/modern-handshake.test.ts`'s spawned-process regressions.
 *
 * The two real transport classes making up `DEFAULT_TRANSPORTS` are
 * neither frozen nor injected via any seam in `tasksAdapter.ts` - it calls
 * `selectAndWake(DEFAULT_TRANSPORTS, ...)` directly, no DI point - so this
 * file spies on the real, singleton `DEFAULT_TRANSPORTS[0]`/`[1]` instances'
 * own `probe()`/`wake()` methods via `t.mock.method`. Importing
 * `DEFAULT_TRANSPORTS` from `../dist/wake/selectTransport.js` here is the
 * same module-cache singleton `../dist/tasksAdapter.js` itself imports and
 * calls `selectAndWake(DEFAULT_TRANSPORTS, ...)` against - Node's own ESM
 * module cache is what makes mutating a method on these instances here
 * visible to the adapter's own internal call.
 *
 * Jobs are created and driven terminal directly via `jobStore.createJob`/
 * `markExited`/`markKilled` - never a real spawned process, never
 * `requestSlot()` (this file never exercises admission control).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/server";

import { jobStore } from "../dist/jobStore.js";
import { maybeAugmentRunResult } from "../dist/tasksAdapter.js";
import type { WakeTargetResolution } from "../dist/wake/resolveWakeTarget.js";
import { DEFAULT_TRANSPORTS } from "../dist/wake/selectTransport.js";
import type { Capability, WakeResult, WakeTarget } from "../dist/wake/wakeTransport.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The exact literal this codebase's own `isTransportWakeEnabled()` reads - not exported from `src/tasksAdapter.ts` (matching `src/process.ts`'s own un-exported `GHANTIKA_TEST_DEGRADE_PROC_READ`, read the same way by `test/process.test.ts`: a literal string, never re-derived). */
const WAKE_TRANSPORT_ENABLED_ENV_VAR = "GHANTIKA_WAKE_TRANSPORT_ENABLED";

/** Saves, sets (or deletes), runs `fn`, then restores the gate env var around one test - the SAME save/mutate/restore-in-finally shape `test/wake-select-transport.test.ts`'s own `withClaudeCodeEnv` establishes for `CLAUDECODE`, adapted for this gate. */
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

/** A fresh, real `JobRecord` in `starting` state (non-terminal) - no real backing process, no admission control involved (never `requestSlot()`). */
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

/** The minimal shape `extractJobId` (inside `maybeAugmentRunResult`) actually reads - `structuredContent.job_id` - matching `src/tools/run.ts`'s own `PublicJobProjection` shape closely enough for this file's own purposes, never a full `CallToolResult` construction. */
function makeRunResult(jobId: string): CallToolResult {
  return { content: [], structuredContent: { job_id: jobId } } as unknown as CallToolResult;
}

/** A `TaskWakeNotifier` that does nothing - this file never asserts on `GHANTIKA_OUTPUT_WAKE_METHOD`/`notifications/tasks` (already covered elsewhere), so the two sibling subscribers `maybeAugmentRunResult` also starts stay harmlessly inert throughout. */
function noopNotifier(): void {
  // intentionally empty
}

/**
 * Lets `startTransportWakeOnTerminal`'s own fire-and-forget
 * `selectAndWake(...).then(...).catch(...)` chain settle before an
 * assertion reads the transport spies - the SAME `await new
 * Promise((resolve) => setImmediate(resolve));` settle pattern
 * `test/wake-integration.test.ts` already establishes for this exact class
 * of async, non-`await`ed notification/wake delivery. Two ticks: one for
 * the mocked transport's own resolved/rejected promise, one for this
 * adapter's own `.then`/`.catch` handler running after it.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// --- fake transport method implementations, mirroring test/wake-select-transport.test.ts's own naming convention ---

function unreachableProbe(): Promise<Capability> {
  throw new Error("probe() should never have been called for this resolution/gate state");
}

function unreachableWake(): Promise<WakeResult> {
  throw new Error("wake() should never have been called for this resolution/gate state");
}

function available(): Promise<Capability> {
  return Promise.resolve({ available: true, probedAt: new Date().toISOString() });
}

function unavailable(reason: string): () => Promise<Capability> {
  return () => Promise.resolve({ available: false, reason, probedAt: new Date().toISOString() });
}

function delivers(transportName: string): () => Promise<WakeResult> {
  return () =>
    Promise.resolve({ outcome: "delivered", transportName, detail: "test-fixture-delivered" });
}

function refuses(transportName: string): () => Promise<WakeResult> {
  return () =>
    Promise.resolve({ outcome: "refused", transportName, detail: "test-fixture-refused" });
}

function reportsUnavailable(transportName: string): () => Promise<WakeResult> {
  return () =>
    Promise.resolve({ outcome: "unavailable", transportName, detail: "test-fixture-unavailable" });
}

function rejectsAsync(message: string): () => Promise<WakeResult> {
  return () => Promise.reject(new Error(message));
}

// =============================================================================
// 1. AC17, the load-bearing one: "absent" AND "malformed" never call
//    selectAndWake - asserted against real spies, never reasoned about.
// =============================================================================

test("AC17: with the gate ON, resolution 'absent' never calls selectAndWake - the real transports' probe()/wake() are never invoked", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    const probeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", unreachableProbe);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", unreachableWake);
    const probeB = t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);
    const wakeB = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", unreachableWake);

    const job = createNonTerminalJob("ac17-absent");
    const resolution: WakeTargetResolution = { state: "absent" };
    maybeAugmentRunResult(makeRunResult(job.job_id), true, noopNotifier, resolution);

    jobStore.markExited(job.job_id, 0, null);
    await settle();

    assert.equal(
      probeA.mock.callCount(),
      0,
      "AppServerGoalWakeTransport.probe() must never be called for an 'absent' resolution"
    );
    assert.equal(
      wakeA.mock.callCount(),
      0,
      "AppServerGoalWakeTransport.wake() must never be called for an 'absent' resolution"
    );
    assert.equal(
      probeB.mock.callCount(),
      0,
      "DesktopIpcWakeTransport.probe() must never be called for an 'absent' resolution"
    );
    assert.equal(
      wakeB.mock.callCount(),
      0,
      "DesktopIpcWakeTransport.wake() must never be called for an 'absent' resolution"
    );
  });
});

test("AC17: with the gate ON, resolution 'malformed' never calls selectAndWake either - logged via console.error (the loud half of AC8), but still zero transport calls", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    const probeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", unreachableProbe);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", unreachableWake);
    const probeB = t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);
    const wakeB = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", unreachableWake);
    const errorSpy = t.mock.method(console, "error");

    const job = createNonTerminalJob("ac17-malformed");
    const resolution: WakeTargetResolution = {
      state: "malformed",
      reason: "threadId present but is null, expected non-empty string",
    };
    maybeAugmentRunResult(makeRunResult(job.job_id), true, noopNotifier, resolution);

    jobStore.markExited(job.job_id, 0, null);
    await settle();

    assert.equal(probeA.mock.callCount(), 0);
    assert.equal(wakeA.mock.callCount(), 0);
    assert.equal(probeB.mock.callCount(), 0);
    assert.equal(wakeB.mock.callCount(), 0);

    assert.equal(
      errorSpy.mock.callCount(),
      1,
      `expected exactly one console.error call for a malformed target, got ${errorSpy.mock.callCount()}`
    );
    const loggedArgs = errorSpy.mock.calls[0]!.arguments;
    assert.equal(loggedArgs.length, 1);
    assert.equal(
      loggedArgs[0],
      `[ghantika] transport wake skipped for task ${job.job_id}: wake target ${resolution.reason}`
    );
  });
});

// =============================================================================
// 2. Gate OFF (default, no env var set): "resolved" still never calls
//    selectAndWake - the default-off behavior, proven directly.
// =============================================================================

test("gate OFF (default, no env var set): a 'resolved' target still never calls selectAndWake - proves the default-off behavior directly", async (t) => {
  await withWakeTransportEnabled(undefined, async () => {
    const probeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", unreachableProbe);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", unreachableWake);
    const probeB = t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);
    const wakeB = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", unreachableWake);

    const job = createNonTerminalJob("gate-off-resolved");
    const resolution: WakeTargetResolution = { state: "resolved", target: "thread-gate-off" };
    maybeAugmentRunResult(makeRunResult(job.job_id), true, noopNotifier, resolution);

    jobStore.markExited(job.job_id, 0, null);
    await settle();

    assert.equal(
      probeA.mock.callCount(),
      0,
      "the gate is OFF - probe() must never be called even for a resolved target"
    );
    assert.equal(wakeA.mock.callCount(), 0);
    assert.equal(probeB.mock.callCount(), 0);
    assert.equal(wakeB.mock.callCount(), 0);
  });
});

test('the gate is an EXACT match on "1" - "true"/"0"/"yes"/empty-string all read as OFF, never a truthy/falsy env-var check', async (t) => {
  const probeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", unreachableProbe);
  const wakeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", unreachableWake);
  const probeB = t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);
  const wakeB = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", unreachableWake);

  for (const value of ["true", "0", "yes", ""]) {
    await withWakeTransportEnabled(value, async () => {
      const job = createNonTerminalJob(`gate-exact-match-${value.length}`);
      const resolution: WakeTargetResolution = { state: "resolved", target: "thread-exact-match" };
      maybeAugmentRunResult(makeRunResult(job.job_id), true, noopNotifier, resolution);
      jobStore.markExited(job.job_id, 0, null);
      await settle();
    });
  }

  assert.equal(
    probeA.mock.callCount(),
    0,
    `env var values other than the exact string "1" must read as OFF - got ${probeA.mock.callCount()} probe() calls`
  );
  assert.equal(wakeA.mock.callCount(), 0);
  assert.equal(probeB.mock.callCount(), 0);
  assert.equal(wakeB.mock.callCount(), 0);
});

// =============================================================================
// 3. Gate ON + "resolved": selectAndWake IS called, with the exact target
//    and a non-empty payload.
// =============================================================================

test("gate ON + resolution 'resolved': the first real transport's wake() is called with the exact resolved target and a non-empty, factual payload naming the task", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", available);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", delivers("codex-app-server-goal"));
    // The second transport must never even be probed once the first
    // delivers - selectAndWake's own already-proven short-circuit (see
    // test/wake-select-transport.test.ts's "first transport probes
    // available and delivers ... second transport's probe/wake are never
    // called" test); re-asserted here against the REAL DEFAULT_TRANSPORTS
    // array this adapter actually calls through.
    const probeB = t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);
    const wakeB = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", unreachableWake);

    const job = createNonTerminalJob("gate-on-resolved");
    const target: WakeTarget = "thread-resolved-target";
    const resolution: WakeTargetResolution = { state: "resolved", target };
    maybeAugmentRunResult(makeRunResult(job.job_id), true, noopNotifier, resolution);

    jobStore.markExited(job.job_id, 0, null);
    await settle();

    assert.equal(
      wakeA.mock.callCount(),
      1,
      `expected exactly one wake() call, got ${wakeA.mock.callCount()}`
    );
    const [calledTarget, calledPayload] = wakeA.mock.calls[0]!.arguments;
    assert.equal(
      calledTarget,
      target,
      "selectAndWake must be called with the exact resolved WakeTarget"
    );
    assert.equal(typeof calledPayload, "string");
    assert.ok((calledPayload as string).length > 0, "the wake payload must be non-empty");
    assert.ok(
      (calledPayload as string).includes(job.job_id),
      `the payload must name the task id, got: ${calledPayload as string}`
    );
    assert.ok(
      (calledPayload as string).includes("exited"),
      `the payload must name the terminal JobState it reached, got: ${calledPayload as string}`
    );

    assert.equal(probeB.mock.callCount(), 0);
    assert.equal(wakeB.mock.callCount(), 0);
  });
});

// =============================================================================
// 4. AC9: a selectAndWake result other than "delivered" (refused /
//    unavailable / a thrown rejection) never propagates into the
//    tool-call response - the minted CreateTaskResult from
//    maybeAugmentRunResult is unaffected either way, and the failure is
//    logged rather than thrown.
// =============================================================================

test("AC9: a 'refused' selectAndWake outcome never propagates into the already-minted CallToolResult - the poll floor stays authoritative", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", refuses("codex-app-server-goal"));
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unavailable("skip for this scenario"));
    const errorSpy = t.mock.method(console, "error");

    const job = createNonTerminalJob("ac9-refused");
    const resolution: WakeTargetResolution = { state: "resolved", target: "thread-refused" };
    const minted = maybeAugmentRunResult(makeRunResult(job.job_id), true, noopNotifier, resolution);
    const mintedSnapshot = JSON.stringify(minted);

    jobStore.markExited(job.job_id, 0, null);
    await settle();

    assert.equal(
      JSON.stringify(minted),
      mintedSnapshot,
      "the minted CreateTaskResult must be byte-identical before and after a refused wake attempt"
    );
    assert.equal((minted as { taskId?: unknown }).taskId, job.job_id);
    assert.ok(
      errorSpy.mock.callCount() > 0,
      "a refused outcome must be logged via console.error, not silently dropped"
    );
  });
});

test("AC9: an 'unavailable' selectAndWake outcome never propagates into the already-minted CallToolResult", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", reportsUnavailable("codex-app-server-goal"));
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unavailable("skip for this scenario"));
    const errorSpy = t.mock.method(console, "error");

    const job = createNonTerminalJob("ac9-unavailable");
    const resolution: WakeTargetResolution = { state: "resolved", target: "thread-unavailable" };
    const minted = maybeAugmentRunResult(makeRunResult(job.job_id), true, noopNotifier, resolution);
    const mintedSnapshot = JSON.stringify(minted);

    jobStore.markExited(job.job_id, 0, null);
    await settle();

    assert.equal(
      JSON.stringify(minted),
      mintedSnapshot,
      "the minted CreateTaskResult must be byte-identical before and after an unavailable wake attempt"
    );
    assert.equal((minted as { taskId?: unknown }).taskId, job.job_id);
    assert.ok(
      errorSpy.mock.callCount() > 0,
      "an unavailable outcome must be logged via console.error, not silently dropped"
    );
  });
});

test("AC9: selectAndWake itself rejecting (a transport throwing/rejecting all the way out) never propagates into the already-minted CallToolResult, and never crashes the process - caught by this adapter's own .catch", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", rejectsAsync("connection reset"));
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", rejectsAsync("no owning client"));
    const errorSpy = t.mock.method(console, "error");

    const job = createNonTerminalJob("ac9-rejects");
    const resolution: WakeTargetResolution = { state: "resolved", target: "thread-rejects" };
    const minted = maybeAugmentRunResult(makeRunResult(job.job_id), true, noopNotifier, resolution);
    const mintedSnapshot = JSON.stringify(minted);

    jobStore.markExited(job.job_id, 0, null);
    await settle();

    assert.equal(
      JSON.stringify(minted),
      mintedSnapshot,
      "the minted CreateTaskResult must be byte-identical before and after selectAndWake's own promise settles"
    );
    assert.equal((minted as { taskId?: unknown }).taskId, job.job_id);
    // selectAndWake itself never lets a transport's rejection escape (see
    // test/wake-select-transport.test.ts's own "when EVERY transport's
    // wake() throws, the selector still returns cleanly with a
    // non-delivered outcome" test) - so this lands in the `.then` branch's
    // non-"delivered" log, not the `.catch` branch. Either branch is a
    // console.error, never a throw, which is the property this test
    // exists to prove: it is not asserting WHICH branch, only that the
    // process never crashed and something was logged.
    assert.ok(
      errorSpy.mock.callCount() > 0,
      "a fully-exhausted, rejecting transport set must still be logged via console.error, never silently dropped and never thrown"
    );
  });
});

// =============================================================================
// 5. The subscriber fires AT MOST ONCE per task - jobStore's own
//    already-proven no-op guard on a repeated mark* call is what makes
//    this true, exercised here against this specific new subscriber.
// =============================================================================

test("the transport-wake subscriber fires AT MOST ONCE per task - a duplicate markExited/markKilled on an already-terminal job is jobStore's own no-op, so selectAndWake is never called twice", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", available);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", delivers("codex-app-server-goal"));
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);

    const job = createNonTerminalJob("fires-once");
    const resolution: WakeTargetResolution = { state: "resolved", target: "thread-fires-once" };
    maybeAugmentRunResult(makeRunResult(job.job_id), true, noopNotifier, resolution);

    assert.equal(
      jobStore.getJobTerminalListenerCount(job.job_id),
      3,
      "expected all three onJobTerminal subscribers (output watch, status notifier, transport wake) registered before the terminal transition"
    );

    jobStore.markExited(job.job_id, 0, null);
    await settle();
    assert.equal(
      wakeA.mock.callCount(),
      1,
      "expected exactly one wake() call after the real terminal transition"
    );

    // A second markExited on an already-terminal job is jobStore's own
    // documented no-op ("No-op once the job is already terminal, so a
    // late/duplicate event can never overwrite a real result" - see
    // JobStore.markExited's own docs) - it must never re-fire this
    // subscriber's callback.
    jobStore.markExited(job.job_id, 0, null);
    // markKilled on the same already-terminal job is the identical no-op
    // guard, exercised too - proving the fires-at-most-once property holds
    // regardless of which mark* call is retried afterward.
    jobStore.markKilled(job.job_id, "SIGTERM");
    await settle();

    assert.equal(
      wakeA.mock.callCount(),
      1,
      "a duplicate terminal-transition attempt must never call wake() a second time"
    );
  });
});

// =============================================================================
// 6. Capability-gate fix: startTransportWakeOnTerminal must NOT be gated by
//    isCapableConnection - it subscribes on the real job run() already
//    created, never on the minted task-shaped response, and Codex (this
//    layer's own target client) never declares Tasks-extension capability
//    (README's own measured claim: "Neither host advertises the extension
//    at handshake in the first place"). Before this fix, `if
//    (!isCapableConnection) return result;` at the top of
//    maybeAugmentRunResult made this branch structurally unreachable with
//    isCapableConnection false - every test above (all written before this
//    fix) passes `true`. These four prove the boundary directly: #1 shows
//    the mechanism now genuinely fires for a non-capable connection with
//    the gate ON (the fix working); #2 shows today's default deployment
//    (gate OFF) is unaffected by a non-capable connection now reaching this
//    code (the "zero observable behavior change today" claim, evidenced
//    rather than asserted); #3 and #4 show the two capability-gated
//    siblings and the minted-vs-passthrough response shape are unchanged
//    on both sides of the isCapableConnection boundary - this fix moves
//    only the transport-wake registration, nothing else.
// =============================================================================

test("gate ON + resolution 'resolved' + isCapableConnection FALSE - wake() still fires, where the branch was previously unreachable with isCapableConnection false at all", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", available);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", delivers("codex-app-server-goal"));

    const job = createNonTerminalJob("non-capable-gate-on-resolved");
    const target: WakeTarget = "thread-non-capable-target";
    const resolution: WakeTargetResolution = { state: "resolved", target };
    maybeAugmentRunResult(makeRunResult(job.job_id), false, noopNotifier, resolution);

    jobStore.markExited(job.job_id, 0, null);
    await settle();

    assert.equal(
      wakeA.mock.callCount(),
      1,
      `isCapableConnection=false must not block the transport wake once the gate is on and the target resolved - got ${wakeA.mock.callCount()} wake() calls`
    );
    const [calledTarget] = wakeA.mock.calls[0]!.arguments;
    assert.equal(calledTarget, target);
    // With isCapableConnection false, this listener is the ONLY one
    // maybeAugmentRunResult ever registers for this job - startTaskWatch/
    // startTaskStatusNotifier are both gated behind isCapableConnection (see
    // that function's own source), so a non-zero count here could only come
    // from startTransportWakeOnTerminal's own subscription. Proves the fix:
    // before it, this stayed at 1 - the closure, and the target-resolution
    // data it captured, retained forever until an unrelated deleteJob.
    assert.equal(
      jobStore.getJobTerminalListenerCount(job.job_id),
      0,
      "the transport-wake listener must unsubscribe itself once its terminal callback has run, not linger for the job's remaining life"
    );
  });
});

test('gate OFF (default) + resolution "resolved" + isCapableConnection FALSE - the subscription now reaches this codepath but STILL makes zero transport calls, proving no observable behavior changes in today\'s default deployment', async (t) => {
  const probeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", unreachableProbe);
  const wakeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", unreachableWake);
  const probeB = t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);
  const wakeB = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", unreachableWake);

  const job = createNonTerminalJob("non-capable-gate-off-resolved");
  const target: WakeTarget = "thread-non-capable-gate-off-target";
  const resolution: WakeTargetResolution = { state: "resolved", target };
  // No withWakeTransportEnabled wrapper - this deliberately runs under
  // whatever the process env already has GHANTIKA_WAKE_TRANSPORT_ENABLED
  // set to, which in every real deployment and in this test run (nothing
  // in this file's own module scope sets it globally) is unset - the
  // exact "every real deployment today" state this test's own name claims.
  assert.equal(
    process.env.GHANTIKA_WAKE_TRANSPORT_ENABLED,
    undefined,
    "sanity: this test must run with the gate genuinely unset, not merely assume it"
  );
  maybeAugmentRunResult(makeRunResult(job.job_id), false, noopNotifier, resolution);

  jobStore.markExited(job.job_id, 0, null);
  await settle();

  assert.equal(probeA.mock.callCount(), 0, "gate OFF must still make zero probe() calls");
  assert.equal(wakeA.mock.callCount(), 0, "gate OFF must still make zero wake() calls");
  assert.equal(probeB.mock.callCount(), 0);
  assert.equal(wakeB.mock.callCount(), 0);
  // Same non-confounded oracle as the gate-ON sibling above: with
  // isCapableConnection false, startTaskWatch/startTaskStatusNotifier never
  // register, so this listener count reflects startTransportWakeOnTerminal's
  // own subscription alone. The gate being OFF only makes isTransportWakeEnabled()
  // return early inside the callback - the callback still runs and must still
  // unsubscribe first, regardless of what it goes on to do (or not do) next.
  assert.equal(
    jobStore.getJobTerminalListenerCount(job.job_id),
    0,
    "the transport-wake listener must unsubscribe itself once its terminal callback has run, even when the gate itself is off"
  );
});

test("gate ON + resolution 'resolved' + isCapableConnection FALSE + wake() rejects - the listener still unsubscribes, proving the cleanup is unconditional on the async outcome", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", rejectsAsync("connection reset"));
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", rejectsAsync("no owning client"));
    const errorSpy = t.mock.method(console, "error");

    const job = createNonTerminalJob("non-capable-gate-on-rejects");
    const resolution: WakeTargetResolution = {
      state: "resolved",
      target: "thread-non-capable-rejects",
    };
    maybeAugmentRunResult(makeRunResult(job.job_id), false, noopNotifier, resolution);

    jobStore.markExited(job.job_id, 0, null);

    // The unsubscribe call is the callback's own FIRST synchronous
    // statement, before selectAndWake is even called - markExited's own
    // fireJobTerminal dispatch is fully synchronous through that point, so
    // this has already happened by the time markExited returns, well
    // before selectAndWake's returned promise gets a chance to settle
    // either way (the settle() below is what lets that promise's own
    // rejection actually surface).
    assert.equal(
      jobStore.getJobTerminalListenerCount(job.job_id),
      0,
      "the transport-wake listener must already be unsubscribed synchronously inside its own terminal callback, before selectAndWake's promise has any chance to settle"
    );

    await settle();

    assert.ok(
      errorSpy.mock.callCount() > 0,
      "a fully-exhausted, rejecting transport set must still be logged via console.error"
    );
    assert.equal(
      jobStore.getJobTerminalListenerCount(job.job_id),
      0,
      "the listener must stay unsubscribed after selectAndWake's rejected promise settles too - nothing re-registers it"
    );
  });
});

test("regression guard: isCapableConnection FALSE never starts startTaskWatch/startTaskStatusNotifier - notifier is never invoked, even with a resolved transport target and the gate on", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", delivers("codex-app-server-goal"));

    const job = createNonTerminalJob("non-capable-notifier-guard");
    const resolution: WakeTargetResolution = {
      state: "resolved",
      target: "thread-notifier-guard-target",
    };
    let notifierCalls = 0;
    const countingNotifier: TaskWakeNotifier = () => {
      notifierCalls += 1;
    };
    maybeAugmentRunResult(makeRunResult(job.job_id), false, countingNotifier, resolution);

    jobStore.markExited(job.job_id, 0, null);
    await settle();

    assert.equal(
      notifierCalls,
      0,
      "a non-capable connection must never receive startTaskWatch's output-delta notification or startTaskStatusNotifier's notifications/tasks status notification - only the out-of-band transport wake may fire for it"
    );
  });
});

test("regression guard: the capable path is byte-for-byte unchanged - isCapableConnection TRUE still starts all three mechanisms and still returns the minted CreateTaskResult shape, never the raw passthrough result", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", available);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", delivers("codex-app-server-goal"));

    const job = createNonTerminalJob("capable-unchanged");
    const resolution: WakeTargetResolution = {
      state: "resolved",
      target: "thread-capable-unchanged-target",
    };
    let notifierCalls = 0;
    const countingNotifier: TaskWakeNotifier = () => {
      notifierCalls += 1;
    };
    const rawResult = makeRunResult(job.job_id);
    const minted = maybeAugmentRunResult(rawResult, true, countingNotifier, resolution);

    // The minted shape is returned immediately, before the job ever goes
    // terminal - `buildCreateTaskResult` reads the record's PRE-terminal
    // state, matching every other test in this file's own established
    // shape assertions (see the AC9 tests above, which read
    // `minted.structuredContent` the same way).
    assert.notEqual(
      minted,
      rawResult,
      "a capable connection must still get the minted CreateTaskResult object, never the raw passthrough result"
    );
    assert.equal((minted as unknown as { resultType?: string }).resultType, "task");

    jobStore.markExited(job.job_id, 0, null);
    await settle();

    assert.equal(
      wakeA.mock.callCount(),
      1,
      "the transport wake must still fire for a capable connection exactly as before this fix"
    );
    assert.equal(
      notifierCalls > 0,
      true,
      "a capable connection must still receive at least one notifier call (startTaskWatch's output-delta wake fires on markExited too, ahead of/alongside startTaskStatusNotifier's own notification) - the two capability-gated siblings are unchanged by this fix"
    );
  });
});
