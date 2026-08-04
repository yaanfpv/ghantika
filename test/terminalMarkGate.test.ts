/**
 * `createTerminalMarkGate` (`src/tools/run.ts`) decides WHEN a job's
 * client-visible terminal transition fires - see its own doc comment for
 * the full contract. This file proves the exact property a real spawned
 * process cannot reliably force: that its own leader-exit reap settling
 * BEFORE this job's stdout/stderr have finished draining - a genuine JS
 * event-loop scheduling accident, not merely a hypothetical - never lets
 * the terminal mark fire early for an ORDINARY job (no escaped
 * descendant), while still firing promptly for a genuinely escaped,
 * silent holder. A real process's OS-level timing cannot deterministically
 * force this exact interleaving without flakiness, so this drives the
 * gate directly against a synthetic, test-controlled scheduler instead -
 * the real end-to-end wiring (the production `setImmediate` default) is
 * covered separately by test/wake-integration.test.ts's real-spawned-
 * process "TERMINAL ORDER" and "BOUNDED TERMINAL WAIT" tests.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createTerminalMarkGate } from "../dist/tools/run.js";

/** A synthetic `scheduleCheck` - collects callbacks instead of running them, so a test drives exactly one settle-check tick at a time in a fully controlled order. */
function createSyntheticScheduler() {
  const pending: Array<() => void> = [];
  const scheduleCheck = (callback: () => void): void => {
    pending.push(callback);
  };
  const tick = (): void => {
    const callbacks = pending.splice(0);
    for (const callback of callbacks) callback();
  };
  return { scheduleCheck, tick, pendingCount: () => pending.length };
}

test("terminal mark gate: reap settling before stream drain does not fire for an ordinary job still producing output", () => {
  const fired: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
  const scheduler = createSyntheticScheduler();
  const gate = createTerminalMarkGate(
    (code, signal) => fired.push({ code, signal }),
    scheduler.scheduleCheck
  );

  gate.onExit(0, null);
  assert.equal(fired.length, 0, "must not fire before either stream has ended");

  // An ordinary job's own group-scoped reap can settle before its real,
  // already-buffered output has finished draining through Node's stream
  // machinery. An unconditional `(streamsEnded || reapSettled)` OR would
  // fire right here.
  gate.onReapSettled();
  assert.equal(
    fired.length,
    0,
    "reap settling alone must never fire the terminal mark while a stream is still open and undrained"
  );
  assert.equal(scheduler.pendingCount(), 1, "exactly one settle-check tick must be scheduled");

  // Real draining still in progress on stdout - a chunk arrives before the
  // scheduled tick runs.
  gate.onStdoutChunk();
  scheduler.tick();
  assert.equal(
    fired.length,
    0,
    "a stream that is still actively producing chunks must keep deferring, never accept the residual early"
  );
  assert.equal(
    scheduler.pendingCount(),
    1,
    "progress re-arms exactly one further settle-check tick"
  );

  // Draining genuinely finishes now - both streams end for real.
  gate.onStdoutEnd();
  gate.onStderrEnd();
  assert.deepEqual(
    fired,
    [{ code: 0, signal: null }],
    "the fast path fires the instant both real streams have ended, without waiting on the stale scheduled tick"
  );
});

test("terminal mark gate: a genuinely escaped, silent descendant still resolves via the disclosed residual", () => {
  const fired: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
  const scheduler = createSyntheticScheduler();
  const gate = createTerminalMarkGate(
    (code, signal) => fired.push({ code, signal }),
    scheduler.scheduleCheck
  );

  gate.onExit(0, "SIGTERM");
  gate.onReapSettled();
  assert.equal(
    scheduler.pendingCount(),
    1,
    "a settle-check tick is scheduled once the reap settles"
  );

  // No chunk activity on either stream this tick - nothing more is
  // arriving because the holder escaped process-group containment and is
  // not writing, exactly the disclosed residual this mechanism exists to
  // bound rather than hang on forever.
  scheduler.tick();
  assert.deepEqual(
    fired,
    [{ code: 0, signal: "SIGTERM" }],
    "a full quiet tick with the reap already settled accepts the residual and fires"
  );
});

test("terminal mark gate: both streams ending before the reap ever settles fires immediately, never touching the settle-check path", () => {
  const fired: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
  const scheduler = createSyntheticScheduler();
  const gate = createTerminalMarkGate(
    (code, signal) => fired.push({ code, signal }),
    scheduler.scheduleCheck
  );

  gate.onExit(0, null);
  gate.onStdoutEnd();
  gate.onStderrEnd();
  assert.deepEqual(fired, [{ code: 0, signal: null }]);
  assert.equal(
    scheduler.pendingCount(),
    0,
    "the ordinary fast path never schedules a settle-check tick"
  );
});

test("terminal mark gate: a stale settle-check tick left pending after the fast path already fired does not fire a second time", () => {
  const fired: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
  const scheduler = createSyntheticScheduler();
  const gate = createTerminalMarkGate(
    (code, signal) => fired.push({ code, signal }),
    scheduler.scheduleCheck
  );

  gate.onExit(0, null);
  // Reap settles while both streams are still open - this schedules a
  // settle-check tick and leaves it PENDING (never ticked).
  gate.onReapSettled();
  assert.equal(scheduler.pendingCount(), 1, "a settle-check tick is scheduled and left pending");

  // Before that stale tick ever runs, both streams genuinely end - the
  // fast path inside `evaluate` fires immediately on its own.
  gate.onStdoutEnd();
  gate.onStderrEnd();
  assert.deepEqual(fired, [{ code: 0, signal: null }], "the fast path fires exactly once");

  // Now run the STALE pending settle-check tick that was queued before the
  // fast path fired. Without the gate's own exactly-once guard, this tick
  // re-checks stdoutEnded/stderrEnded (both still true) and fires AGAIN -
  // a real double-fire this exact sequence produces whenever that guard
  // is absent.
  scheduler.tick();
  assert.deepEqual(
    fired,
    [{ code: 0, signal: null }],
    "the stale tick must not produce a second terminal mark - the gate promises exactly once, regardless of how many code paths reach a firing condition"
  );
});
