/**
 * Drives `src/tasksAdapter.ts`'s `startTransportWakeOnOutput` subscriber
 * directly against `jobStore` (`createJob`/`appendOutput`/`markExited`/
 * `markKilled`, never a real spawned process, never `requestSlot()`) and
 * through `maybeAugmentRunResult`'s own public entry point to register the
 * real subscription, never negotiating Tasks capability. Spies on the
 * real, singleton `DEFAULT_TRANSPORTS` array via `t.mock.method` - the
 * same module-cache singleton `../dist/tasksAdapter.js` itself calls
 * through. Every test neutralizes `DEFAULT_TRANSPORTS[0]`
 * (`ClaudeMessagingWakeTransport`) unless it is the one thing that test
 * exists to exercise, exactly matching `test/wake-transport-wiring.test.ts`'s
 * own `neutralizeClaudeMessagingTransport` reasoning.
 * `test/wake-output-real-topology.test.ts` exercises the same mechanism
 * against a real fswatch process and the real inherited Claude messaging
 * socket.
 *
 * `t.mock.timers` (`apis: ["setTimeout"]`) drives the batching window, and
 * this file imports the real exported constant (`WAKE_COALESCE_WINDOW_MS`)
 * rather than hardcoding a duplicate of it, so a future change to that
 * constant moves this file's own ticks with it instead of silently
 * drifting apart. `setImmediate` is unaffected by faking `setTimeout`
 * alone, so the `settle()` helper below (identical to the sibling file's
 * own) still lets `dispatchTransportWake`'s real, un-faked
 * `selectAndWake(...).then(...)` promise chain actually settle after each
 * `tick()`.
 *
 * The mechanism applies one rate control - a fixed, non-rolling ~200ms
 * batching window - and nothing above it: no repeat gate, no cooldown, no
 * flood handling of any kind. The window opens on a job's first new
 * output line and every later line arriving before it closes joins that
 * same window rather than resetting it, so a sustained stream keeps
 * flushing on successive windows throughout its run rather than holding
 * everything back until it goes quiet.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/server";

import { jobStore } from "../dist/jobStore.js";
import { maybeAugmentRunResult, WAKE_COALESCE_WINDOW_MS } from "../dist/tasksAdapter.js";
import type { WakeTargetResolution } from "../dist/wake/resolveWakeTarget.js";
import { DEFAULT_TRANSPORTS } from "../dist/wake/selectTransport.js";
import type { Capability, WakeResult, WakeTarget } from "../dist/wake/wakeTransport.js";

// ---------------------------------------------------------------------------
// Harness - deliberately identical shape to test/wake-transport-wiring.test.ts
// ---------------------------------------------------------------------------

const WAKE_TRANSPORT_ENABLED_ENV_VAR = "GHANTIKA_WAKE_TRANSPORT_ENABLED";
const CLAUDE_MESSAGING_WAKE_DISABLE_ENV_VAR = "GHANTIKA_DISABLE_CLAUDE_MESSAGING_WAKE";

async function withEnvVar(
  name: string,
  value: string | undefined,
  fn: () => Promise<void>
): Promise<void> {
  const original = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    await fn();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

let jobLabelCounter = 0;

/** A fresh, real `JobRecord` in `starting` state - no backing process, no admission control. */
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

/** Same two-tick settle pattern test/wake-transport-wiring.test.ts already establishes for this exact class of fire-and-forget async wake dispatch. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function unreachableProbe(): Promise<Capability> {
  throw new Error("probe() should never have been called for this scenario");
}

function unreachableWake(): Promise<WakeResult> {
  throw new Error("wake() should never have been called for this scenario");
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

/** Required at the top of every test that does not itself exercise the Claude transport - matching test/wake-transport-wiring.test.ts's own neutralizeClaudeMessagingTransport reasoning verbatim: left unmocked, this process's genuinely-inherited Claude Code messaging socket would make DEFAULT_TRANSPORTS[0] the one every "delivered" assertion below actually exercises, ahead of the Codex mocks these tests exist for. */
function neutralizeClaudeMessagingTransport(t: TestContext): void {
  t.mock.method(
    DEFAULT_TRANSPORTS[0]!,
    "probe",
    unavailable(
      "neutralized for this test - see neutralizeClaudeMessagingTransport's own doc comment"
    )
  );
}

/**
 * Registers both the terminal and output transport-wake subscriptions for
 * a fresh job via the real public entry point, matching
 * startTransportWakeOnOutput's own doc comment that it is wired
 * unconditionally alongside (never instead of) the terminal one.
 *
 * isCapableConnection is fixed to `false` here, deliberately, on every
 * call - both transport-wake starters run regardless of it (see
 * maybeAugmentRunResult's own doc comment), but `startTaskWatch` ALSO
 * subscribes via `jobStore.onOutputArrival` for its own, unrelated
 * Tasks-notification path when isCapableConnection is true. `false` is
 * what makes `jobStore.getOutputArrivalListenerCount` in these tests
 * reflect startTransportWakeOnOutput's own subscription alone - the same
 * isolation test/wake-transport-wiring.test.ts's own non-capable-path
 * tests already establish for `getJobTerminalListenerCount`.
 */
function registerOutputWake(jobId: string, resolution: WakeTargetResolution): void {
  maybeAugmentRunResult(makeRunResult(jobId), false, noopNotifier, resolution);
}

// =============================================================================
// 1. An instant burst inside the fixed window collapses into exactly one
//    wake() call, carrying the output payload wording.
// =============================================================================

test("an instant burst of near-simultaneous output lines collapses into exactly one wake() call, carrying the output payload wording", async (t) => {
  await withEnvVar(WAKE_TRANSPORT_ENABLED_ENV_VAR, "1", async () => {
    neutralizeClaudeMessagingTransport(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", delivers("codex-app-server-goal"));
    t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);

    const job = createNonTerminalJob("instant-burst");
    const target: WakeTarget = "thread-instant-burst";
    registerOutputWake(job.job_id, { state: "resolved", target });

    // Three lines land before the window's own timer ever fires - real
    // JobStore.appendOutput calls, each a genuine onOutputArrival event,
    // none of them ticking the fake clock in between.
    jobStore.appendOutput(job.job_id, "stdout", Buffer.from("line one\n"));
    jobStore.appendOutput(job.job_id, "stdout", Buffer.from("line two\n"));
    jobStore.appendOutput(job.job_id, "stdout", Buffer.from("line three\n"));

    t.mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    await settle();

    assert.equal(
      wakeA.mock.callCount(),
      1,
      `expected exactly one wake() call for a three-line instant burst, got ${wakeA.mock.callCount()}`
    );
    const [calledTarget, calledPayload] = wakeA.mock.calls[0]!.arguments;
    assert.equal(calledTarget, target);
    assert.ok(
      (calledPayload as string).includes("produced new output while still running"),
      `expected the output-trigger payload wording, got: ${calledPayload as string}`
    );
    assert.ok(
      !(calledPayload as string).includes("reached"),
      "the output payload must never carry the terminal payload's own 'reached <state>' wording"
    );

    t.mock.timers.reset();
  });
});

// =============================================================================
// 2. The fixed-vs-rolling discriminator - a sustained sub-window stream
//    keeps flushing on successive fixed windows throughout, rather than
//    waiting for the stream to go quiet. A rolling debounce would pass
//    every other test in this file but fail this one specifically.
// =============================================================================

test("sustained output at half the window's own width keeps flushing on successive FIXED windows throughout - never holding everything until the stream goes quiet, which is what a rolling debounce would do instead", async (t) => {
  await withEnvVar(WAKE_TRANSPORT_ENABLED_ENV_VAR, "1", async () => {
    neutralizeClaudeMessagingTransport(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", delivers("codex-app-server-goal"));
    t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);

    const job = createNonTerminalJob("sustained-sub-window");
    registerOutputWake(job.job_id, { state: "resolved", target: "thread-sustained" });

    const lineIntervalMs = WAKE_COALESCE_WINDOW_MS / 2;
    // Ten lines, one every half-window - a genuinely continuous stream
    // with no real pause anywhere in it. A ROLLING debounce would reset
    // on every one of these and never flush until the tenth line's own
    // window finally elapsed with nothing left to reset it - one wake,
    // right at the very end. This mechanism's own FIXED window instead
    // opens once and lets every later line inside it join, without
    // resetting the clock - so it flushes repeatedly, throughout, and the
    // wake count at the halfway point is already nonzero.
    for (let i = 0; i < 10; i += 1) {
      jobStore.appendOutput(job.job_id, "stdout", Buffer.from(`sustained line ${i}\n`));
      t.mock.timers.tick(lineIntervalMs);
      await settle();
    }

    const countAfterTenLines = wakeA.mock.callCount();
    assert.ok(
      countAfterTenLines >= 2,
      `expected multiple wakes to have already fired DURING the sustained stream (fixed-window behavior), got only ${countAfterTenLines} - a count of exactly 1 here would mean the window rolled/reset on every line instead of flushing on its own fixed schedule`
    );

    // Let the stream's own tail window close.
    t.mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    await settle();

    const finalCount = wakeA.mock.callCount();
    assert.ok(
      finalCount > countAfterTenLines || countAfterTenLines >= 2,
      "expected the tail window to close on schedule too, producing at least one more flush if one was still pending"
    );
    // Ten lines at one every 100ms (half of a 200ms window) must produce
    // roughly five flushes of two lines each, not one flush of ten - the
    // exact shape a fixed window (as opposed to a rolling one) produces.
    assert.ok(
      finalCount >= 4 && finalCount <= 6,
      `expected roughly five flushes (two lines per fixed 200ms window at a 100ms line interval), got ${finalCount} total wake() calls`
    );

    t.mock.timers.reset();
  });
});

test("output going genuinely quiet never produces an extra wake for nothing - only real output ever reopens the window", async (t) => {
  await withEnvVar(WAKE_TRANSPORT_ENABLED_ENV_VAR, "1", async () => {
    neutralizeClaudeMessagingTransport(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", delivers("codex-app-server-goal"));
    t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);

    const job = createNonTerminalJob("goes-quiet");
    registerOutputWake(job.job_id, { state: "resolved", target: "thread-goes-quiet" });

    jobStore.appendOutput(job.job_id, "stdout", Buffer.from("one line\n"));
    t.mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    await settle();
    assert.equal(wakeA.mock.callCount(), 1);

    // A long real quiet period - nothing arrives, nothing must fire.
    t.mock.timers.tick(WAKE_COALESCE_WINDOW_MS * 50);
    await settle();
    assert.equal(
      wakeA.mock.callCount(),
      1,
      "a quiet job must never produce a second wake merely because time passed"
    );

    t.mock.timers.reset();
  });
});

// =============================================================================
// 3. Each distinct event OUTSIDE the window produces its own separate
//    wake attempt - there is no rate limit above the fixed window itself.
// =============================================================================

test("two distinct bursts separated by more than the window each produce their own separate wake() call - no rate limit above the window", async (t) => {
  await withEnvVar(WAKE_TRANSPORT_ENABLED_ENV_VAR, "1", async () => {
    neutralizeClaudeMessagingTransport(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", delivers("codex-app-server-goal"));
    t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);

    const job = createNonTerminalJob("distinct-bursts");
    registerOutputWake(job.job_id, { state: "resolved", target: "thread-distinct-bursts" });

    jobStore.appendOutput(job.job_id, "stdout", Buffer.from("burst one\n"));
    t.mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    await settle();
    assert.equal(wakeA.mock.callCount(), 1, "expected the first burst's own wake");

    // A real pause, well clear of the window, then a second, wholly
    // separate burst - immediately eligible for its own wake, with
    // nothing gating a repeat.
    t.mock.timers.tick(WAKE_COALESCE_WINDOW_MS * 10);
    await settle();
    jobStore.appendOutput(job.job_id, "stdout", Buffer.from("burst two\n"));
    t.mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    await settle();

    assert.equal(
      wakeA.mock.callCount(),
      2,
      "expected the second, distinct burst to produce its own separate wake immediately - there is no cooldown or repeat gate above the coalescing window"
    );

    // A third burst, immediately after the second (well inside the
    // window this time never matters - distinct meaning "its own window",
    // not "far apart in wall-clock time"): still its own wake, not
    // suppressed or delayed by the one before it.
    jobStore.appendOutput(job.job_id, "stdout", Buffer.from("burst three\n"));
    t.mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    await settle();
    assert.equal(
      wakeA.mock.callCount(),
      3,
      "a third distinct event must produce a third wake - nothing above the window ever throttles a repeat"
    );

    t.mock.timers.reset();
  });
});

// =============================================================================
// 4. Terminal-trigger independence and cleanup - the terminal transition
//    fires its own, separately-worded wake, and unconditionally tears down
//    the output subscription so no further output-triggered wake can ever
//    fire for this job again.
// =============================================================================

test("a terminal transition fires the terminal-worded wake independently of the output trigger, and tears down the output subscription so a still-open window can never fire again", async (t) => {
  await withEnvVar(WAKE_TRANSPORT_ENABLED_ENV_VAR, "1", async () => {
    neutralizeClaudeMessagingTransport(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", delivers("codex-app-server-goal"));
    t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);

    const job = createNonTerminalJob("terminal-independence");
    registerOutputWake(job.job_id, { state: "resolved", target: "thread-terminal-independence" });

    assert.equal(
      jobStore.getOutputArrivalListenerCount(job.job_id),
      1,
      "expected the output-wake subscription registered before any output arrives"
    );

    // One output-triggered wake, with a fresh window still open.
    jobStore.appendOutput(job.job_id, "stdout", Buffer.from("before terminal, line one\n"));
    t.mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    await settle();
    assert.equal(wakeA.mock.callCount(), 1);
    const [, outputPayload] = wakeA.mock.calls[0]!.arguments;
    assert.ok((outputPayload as string).includes("produced new output while still running"));

    // A second line opens a NEW window that is still open (has not yet
    // flushed) at the exact moment the job reaches terminal.
    jobStore.appendOutput(job.job_id, "stdout", Buffer.from("right before terminal\n"));

    jobStore.markExited(job.job_id, 0, null);
    await settle();

    assert.equal(
      wakeA.mock.callCount(),
      2,
      "expected the terminal transition to fire its own independent wake, on top of the earlier output-triggered one"
    );
    const [, terminalPayload] = wakeA.mock.calls[1]!.arguments;
    assert.ok(
      (terminalPayload as string).includes("reached exited"),
      `expected the terminal payload's own 'reached <state>' wording, got: ${terminalPayload as string}`
    );

    assert.equal(
      jobStore.getOutputArrivalListenerCount(job.job_id),
      0,
      "the output-wake subscription must be torn down once the job reaches terminal, not left registered for the job's remaining life"
    );
    assert.equal(jobStore.getJobTerminalListenerCount(job.job_id), 0);

    // The window that was still open at terminal time must never fire an
    // output wake after teardown, even once its own WAKE_COALESCE_WINDOW_MS
    // interval has fully elapsed.
    t.mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    await settle();
    assert.equal(
      wakeA.mock.callCount(),
      2,
      "a window still open at terminal time must never fire an output wake after the subscription has been torn down"
    );

    t.mock.timers.reset();
  });
});

// =============================================================================
// 5. Both output-path operator gates - GHANTIKA_WAKE_TRANSPORT_ENABLED
//    (Codex-gated transports) and GHANTIKA_DISABLE_CLAUDE_MESSAGING_WAKE
//    (the Claude transport) govern an output-triggered wake exactly as
//    they govern the terminal one, since eligibleWakeTransports is the one
//    shared gate check both dispatch sites call.
// =============================================================================

test("output-path gate OFF (default): a resolved target's output arrival still never calls the Codex-gated transports' probe()/wake()", async (t) => {
  neutralizeClaudeMessagingTransport(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const probeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);
  const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", unreachableWake);
  const probeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);
  const wakeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "wake", unreachableWake);

  const job = createNonTerminalJob("output-gate-off");
  registerOutputWake(job.job_id, { state: "resolved", target: "thread-output-gate-off" });
  jobStore.appendOutput(job.job_id, "stdout", Buffer.from("a line\n"));
  t.mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
  await settle();

  assert.equal(probeA.mock.callCount(), 0);
  assert.equal(wakeA.mock.callCount(), 0);
  assert.equal(probeB.mock.callCount(), 0);
  assert.equal(wakeB.mock.callCount(), 0);

  t.mock.timers.reset();
});

test("output-path gate ON (GHANTIKA_WAKE_TRANSPORT_ENABLED=1): a resolved target's output arrival DOES call the first Codex-gated transport's wake(), with the exact resolved target", async (t) => {
  await withEnvVar(WAKE_TRANSPORT_ENABLED_ENV_VAR, "1", async () => {
    neutralizeClaudeMessagingTransport(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", available);
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "wake", delivers("codex-app-server-goal"));
    const probeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);

    const job = createNonTerminalJob("output-gate-on");
    const target: WakeTarget = "thread-output-gate-on";
    registerOutputWake(job.job_id, { state: "resolved", target });
    jobStore.appendOutput(job.job_id, "stdout", Buffer.from("a line\n"));
    t.mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    await settle();

    assert.equal(wakeA.mock.callCount(), 1);
    const [calledTarget] = wakeA.mock.calls[0]!.arguments;
    assert.equal(calledTarget, target);
    assert.equal(
      probeB.mock.callCount(),
      0,
      "the short-circuit already proven elsewhere applies here too"
    );

    t.mock.timers.reset();
  });
});

test("GHANTIKA_DISABLE_CLAUDE_MESSAGING_WAKE=1: an output-triggered wake attempt never calls the Claude messaging transport's wake() - the Codex-gated transports stay excluded too since the gate they need is unset", async (t) => {
  await withEnvVar(CLAUDE_MESSAGING_WAKE_DISABLE_ENV_VAR, "1", async () => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    // Deliberately NOT neutralized - this test proves the disable gate
    // itself keeps it from ever being probed at all.
    const probeClaude = t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", unreachableProbe);
    const wakeClaude = t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", unreachableWake);
    t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);
    t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);

    const job = createNonTerminalJob("output-claude-disabled");
    registerOutputWake(job.job_id, { state: "absent" });
    jobStore.appendOutput(job.job_id, "stdout", Buffer.from("a line\n"));
    t.mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
    await settle();

    assert.equal(
      probeClaude.mock.callCount(),
      0,
      "the disable gate must keep the Claude messaging transport from ever being probed for an output-triggered wake"
    );
    assert.equal(wakeClaude.mock.callCount(), 0);

    t.mock.timers.reset();
  });
});

test("without GHANTIKA_DISABLE_CLAUDE_MESSAGING_WAKE set: an output-triggered wake DOES call the Claude messaging transport's wake(), carrying the output payload", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const probeClaude = t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", available);
  const wakeClaude = t.mock.method(
    DEFAULT_TRANSPORTS[0]!,
    "wake",
    delivers("claude-code-uds-messaging")
  );
  const probeA = t.mock.method(DEFAULT_TRANSPORTS[1]!, "probe", unreachableProbe);
  const probeB = t.mock.method(DEFAULT_TRANSPORTS[2]!, "probe", unreachableProbe);

  const job = createNonTerminalJob("output-claude-enabled");
  registerOutputWake(job.job_id, { state: "absent" });
  jobStore.appendOutput(job.job_id, "stdout", Buffer.from("a line\n"));
  t.mock.timers.tick(WAKE_COALESCE_WINDOW_MS);
  await settle();

  assert.equal(
    probeClaude.mock.callCount(),
    1,
    "expected the Claude messaging transport to be probed before this attempt"
  );
  assert.equal(
    wakeClaude.mock.callCount(),
    1,
    "the Claude messaging transport must be attempted for an output-triggered wake when the disable gate is unset, regardless of Codex resolution state - it needs no target"
  );
  const [, calledPayload] = wakeClaude.mock.calls[0]!.arguments;
  assert.ok((calledPayload as string).includes("produced new output while still running"));
  assert.equal(
    probeA.mock.callCount(),
    0,
    "an 'absent' resolution must still exclude the Codex-gated transports regardless of this gate"
  );
  assert.equal(probeB.mock.callCount(), 0);

  t.mock.timers.reset();
});
