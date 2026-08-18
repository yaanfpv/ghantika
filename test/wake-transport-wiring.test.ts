/**
 * Proves `src/tasksAdapter.ts`'s `startTransportWakeOnTerminal` subscriber:
 * its server-operator-only `GHANTIKA_WAKE_TRANSPORT_ENABLED` opt-in gate, its
 * fail-closed behavior on every `WakeTargetResolution` state other than
 * `"resolved"`, and its dispatch through the real transport selector.
 *
 * Calls `maybeAugmentRunResult` directly and drives `jobStore` directly,
 * rather than a real spawned server - this file's subject is internal
 * gating/dispatch logic inside one function, given an already-resolved
 * `WakeTargetResolution`. It never re-proves the Tasks-extension wire
 * contract (capability negotiation, the six-tool mint rule, SDK-facing
 * minting/notification shapes) - that lives in `test/tasks.test.ts` and its
 * siblings, unaffected here. Reaching `WakeTargetResolution` from a
 * client-shaped request's `_meta.threadId` over the real wire - the
 * server-to-resolver hand-off itself - is covered separately, end to
 * end, by `test/modern-handshake.test.ts`'s spawned-process regressions,
 * which drive a real request over the real wire protocol; whether any
 * actual external client sends `threadId` that way is outside what
 * either file establishes.
 *
 * The three real transport classes making up `DEFAULT_TRANSPORTS` are
 * neither frozen nor injected via any seam in `tasksAdapter.ts` - it calls
 * `selectAndWake(DEFAULT_TRANSPORTS, ...)` directly, no DI point - so this
 * file spies on the real, singleton `DEFAULT_TRANSPORTS[0]`/`[1]`/`[2]`
 * instances' own `probe()`/`wake()` methods via `t.mock.method`. Importing
 * `DEFAULT_TRANSPORTS` from `../dist/wake/selectTransport.js` here is the
 * same module-cache singleton `../dist/tasksAdapter.js` itself imports and
 * calls `selectAndWake(DEFAULT_TRANSPORTS, ...)` against - Node's own ESM
 * module cache is what makes mutating a method on these instances here
 * visible to the adapter's own internal call.
 *
 * `DEFAULT_TRANSPORTS[0]` is `ClaudeMessagingWakeTransport`, added by
 * story-0264 - every test below neutralizes it first via
 * `neutralizeClaudeMessagingTransport` (see that function's own doc
 * comment for why this is required, not optional, in THIS process). The
 * app-server and desktop-IPC transports this file actually exercises sit
 * at indices 1 and 2.
 *
 * Jobs are created and driven terminal directly via `jobStore.createJob`/
 * `markExited`/`markKilled` - never a real spawned process, never
 * `requestSlot()` (this file never exercises admission control).
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

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

/**
 * Neutralizes the real `ClaudeMessagingWakeTransport` singleton at
 * `DEFAULT_TRANSPORTS[0]` for the duration of one test, mocking its
 * `probe()` to report unavailable - REQUIRED at the top of every test
 * below, not a convenience. This test process is itself a Claude Code
 * Bash-tool subprocess and genuinely inherits `CLAUDE_CODE_MESSAGING_SOCKET`/
 * `CLAUDE_CODE_MESSAGING_TOKEN` (Claude Code sets both for every stdio MCP
 * server subprocess AND every Bash/PowerShell tool subprocess it spawns,
 * mirroring `CLAUDECODE` itself - see `test/wake-select-transport.test.ts`'s
 * own `withClaudeCodeEnv` doc comment for that same fact about
 * `CLAUDECODE`, and this file's own header for why mutating a method on
 * these singletons here is visible to `tasksAdapter.ts`'s real call).
 * Left unmocked, the real transport's `probe()` would genuinely connect to
 * that real socket and report `available: true` - and because
 * `selectAndWake` tries transports strictly in array order, it would then
 * be the one every "delivered" assertion below actually exercises, ahead
 * of the app-server/desktop-IPC mocks this file exists to test, sending a
 * live NDJSON payload into whichever real session owns that socket. This
 * function exists specifically to make that impossible.
 */
function neutralizeClaudeMessagingTransport(t: TestContext): void {
  t.mock.method(
    DEFAULT_TRANSPORTS[0]!,
    "probe",
    unavailable(
      "neutralized for this test - see neutralizeClaudeMessagingTransport's own doc comment"
    )
  );
}

// =============================================================================
// "absent" AND "malformed" never call selectAndWake - asserted against
// real spies, never reasoned about.
// =============================================================================

test("with the gate ON, resolution 'absent' never calls selectAndWake - the real transports' probe()/wake() are never invoked", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    neutralizeClaudeMessagingTransport(t);
    const probeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", unreachableWake);
    const probeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);
    const wakeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "wake", unreachableWake);

    const job = createNonTerminalJob("resolution-absent");
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

test("with the gate ON, resolution 'malformed' never calls selectAndWake either - logged via console.error, but still zero transport calls", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    neutralizeClaudeMessagingTransport(t);
    const probeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", unreachableWake);
    const probeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);
    const wakeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "wake", unreachableWake);
    const errorSpy = t.mock.method(console, "error");

    const job = createNonTerminalJob("resolution-malformed");
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
    neutralizeClaudeMessagingTransport(t);
    const probeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", unreachableWake);
    const probeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);
    const wakeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "wake", unreachableWake);

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
  neutralizeClaudeMessagingTransport(t);
  const probeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);
  const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", unreachableWake);
  const probeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);
  const wakeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "wake", unreachableWake);

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
    neutralizeClaudeMessagingTransport(t);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", delivers("codex-app-server-goal"));
    // The second transport must never even be probed once the first
    // delivers - selectAndWake's own already-proven short-circuit (see
    // test/wake-select-transport.test.ts's "first transport probes
    // available and delivers ... second transport's probe/wake are never
    // called" test); re-asserted here against the REAL DEFAULT_TRANSPORTS
    // array this adapter actually calls through.
    const probeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);
    const wakeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "wake", unreachableWake);

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
// A selectAndWake result other than "delivered" (refused / unavailable /
// a thrown rejection) never propagates into the tool-call response - the
// minted CreateTaskResult from maybeAugmentRunResult is unaffected either
// way, and the failure is logged rather than thrown.
// =============================================================================

test("a 'refused' selectAndWake outcome never propagates into the already-minted CallToolResult - the poll floor stays authoritative", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    neutralizeClaudeMessagingTransport(t);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", refuses("codex-app-server-goal"));
    t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unavailable("skip for this scenario"));
    const errorSpy = t.mock.method(console, "error");

    const job = createNonTerminalJob("outcome-refused");
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

test("an 'unavailable' selectAndWake outcome never propagates into the already-minted CallToolResult", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    neutralizeClaudeMessagingTransport(t);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", reportsUnavailable("codex-app-server-goal"));
    t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unavailable("skip for this scenario"));
    const errorSpy = t.mock.method(console, "error");

    const job = createNonTerminalJob("outcome-unavailable");
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

test("selectAndWake itself rejecting (a transport throwing/rejecting all the way out) never propagates into the already-minted CallToolResult, and never crashes the process - caught by this adapter's own .catch", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    neutralizeClaudeMessagingTransport(t);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", rejectsAsync("connection reset"));
    t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[2]!, "wake", rejectsAsync("no owning client"));
    const errorSpy = t.mock.method(console, "error");

    const job = createNonTerminalJob("outcome-rejects");
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
    neutralizeClaudeMessagingTransport(t);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", delivers("codex-app-server-goal"));
    t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);

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
// 6. startTransportWakeOnTerminal is NOT gated by isCapableConnection - it
//    subscribes on the real job run() already created, never on the
//    minted task-shaped response. The README records, narrowly, that
//    neither of the two tested hosts (Claude Code, Codex CLI)
//    advertised the extension at handshake - evidence about those
//    tested hosts, not a permanent property of either client, and the
//    README itself says so ("Read this as evidence about today's
//    hosts, not about the mechanism"). These four exercise
//    the isCapableConnection FALSE side of that boundary directly: #1
//    shows the mechanism fires for a non-capable connection with the
//    gate ON; #2 shows the default (gate OFF) code path, as run in this
//    test process, makes zero transport calls regardless of capability;
//    #3 and #4 show the two capability-gated siblings and the
//    minted-vs-passthrough response shape behave identically on both
//    sides of the isCapableConnection boundary - only the transport-wake
//    registration itself is independent of it.
// =============================================================================

test("gate ON + resolution 'resolved' + isCapableConnection FALSE - wake() fires, since startTransportWakeOnTerminal does not read isCapableConnection at all", async (t) => {
  await withWakeTransportEnabled("1", async () => {
    neutralizeClaudeMessagingTransport(t);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", delivers("codex-app-server-goal"));

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
    // from startTransportWakeOnTerminal's own subscription. It must
    // unsubscribe itself once its terminal callback has run, or this would
    // read 1 - the closure, and the target-resolution data it captured,
    // retained forever until an unrelated deleteJob.
    assert.equal(
      jobStore.getJobTerminalListenerCount(job.job_id),
      0,
      "the transport-wake listener must unsubscribe itself once its terminal callback has run, not linger for the job's remaining life"
    );
  });
});

test('gate OFF (the default code path) + resolution "resolved" + isCapableConnection FALSE - the subscription now reaches this codepath but STILL makes zero transport calls, proving no observable behavior changes on the default code path', async (t) => {
  neutralizeClaudeMessagingTransport(t);
  const probeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);
  const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", unreachableWake);
  const probeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);
  const wakeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "wake", unreachableWake);

  const job = createNonTerminalJob("non-capable-gate-off-resolved");
  const target: WakeTarget = "thread-non-capable-gate-off-target";
  const resolution: WakeTargetResolution = { state: "resolved", target };
  // No withWakeTransportEnabled wrapper - this deliberately runs under
  // whatever this test process's own env already has
  // GHANTIKA_WAKE_TRANSPORT_ENABLED set to, which is unset here (nothing
  // in this file's own module scope sets it globally). This establishes
  // only that THIS process's default is unset, not any claim about every
  // real deployment; `src/tasksAdapter.ts` expressly permits an operator
  // to set the variable to `"1"`.
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
    neutralizeClaudeMessagingTransport(t);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", rejectsAsync("connection reset"));
    t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[2]!, "wake", rejectsAsync("no owning client"));
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
    neutralizeClaudeMessagingTransport(t);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", delivers("codex-app-server-goal"));

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
    neutralizeClaudeMessagingTransport(t);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", delivers("codex-app-server-goal"));

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
    // shape assertions (see the selectAndWake-outcome-propagation tests
    // above, which read `minted.structuredContent` the same way).
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
      "the transport wake fires for a capable connection exactly as it does for a non-capable one"
    );
    assert.equal(
      notifierCalls > 0,
      true,
      "a capable connection must receive at least one notifier call (startTaskWatch's output-delta wake fires on markExited too, ahead of/alongside startTaskStatusNotifier's own notification) - the two capability-gated siblings behave normally here, same as this file's other capable-connection tests"
    );
  });
});
