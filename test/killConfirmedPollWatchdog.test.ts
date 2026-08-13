import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KILL_CONFIRMED_POLL_BOUND_MS,
  KillConfirmedPollTimeoutError,
  armKillConfirmedWatchdog,
} from "./helpers/killConfirmedPollWatchdog.ts";

/**
 * Every test below passes an explicit short `boundMs` - never the real
 * `KILL_CONFIRMED_POLL_BOUND_MS` (60_000ms), which would make this file
 * itself either slow or a false pass on a suite that never actually waited
 * long enough to exercise the trip. `armKillConfirmedWatchdog`'s own
 * `boundMs` parameter exists exactly for this: production call sites use
 * the default, this file proves the mechanism fast.
 */
const SHORT_BOUND_MS = 30;

test("armKillConfirmedWatchdog: throwIfTripped is a no-op before the bound elapses - a healthy, quickly-settling poll is never disturbed", () => {
  const watchdog = armKillConfirmedWatchdog("job-fast-settle", SHORT_BOUND_MS);
  try {
    // Called several times in immediate succession, mirroring a real poll
    // loop's first few iterations - none of these may throw.
    assert.doesNotThrow(() => watchdog.throwIfTripped({ state: "running" }));
    assert.doesNotThrow(() => watchdog.throwIfTripped({ state: "running" }));
    assert.doesNotThrow(() => watchdog.throwIfTripped({ state: "exited", kill_confirmed: true }));
  } finally {
    watchdog.dispose();
  }
});

test("armKillConfirmedWatchdog: throwIfTripped throws KillConfirmedPollTimeoutError once the bound has genuinely elapsed - RED half of the pair, a poll that never settles now fails with a named diagnostic instead of hanging forever", async () => {
  const watchdog = armKillConfirmedWatchdog("job-never-settles", SHORT_BOUND_MS);
  try {
    // Real wall-clock wait, comfortably past SHORT_BOUND_MS - this is what
    // an unbounded `for (;;)` poll loop would keep doing forever against a
    // job whose kill_confirmed never settles: iterate, observe undefined,
    // sleep, iterate again.
    await new Promise((resolve) => setTimeout(resolve, SHORT_BOUND_MS * 3));

    const lastObserved = {
      job_id: "job-never-settles",
      state: "exited",
      exit_code: 0,
      identity_capture: "captured",
      // kill_confirmed deliberately absent - this is the exact CI-observed
      // shape: a job that ran to completion with kill_confirmed still
      // undefined.
    };

    assert.throws(
      () => watchdog.throwIfTripped(lastObserved),
      (err: unknown) => {
        assert.ok(err instanceof KillConfirmedPollTimeoutError);
        assert.equal(err.name, "KillConfirmedPollTimeoutError");
        // The error names both the job id and the field that never
        // settled.
        assert.match(err.message, /job-never-settles/);
        assert.match(err.message, /kill_confirmed/);
        // Never a bare file-level "test timed out after 120000ms" - the
        // last observed record travels with the error.
        assert.match(err.message, /"state":"exited"/);
        assert.match(err.message, /"identity_capture":"captured"/);
        // Explicitly disclaims being a claim about the field's own
        // contract - see this file's own header doc comment and
        // KillConfirmedPollTimeoutError's own docs for why that
        // distinction is load-bearing (it is what keeps this watchdog from
        // re-tripping scripts/check-no-bounded-kill-confirmed-wait.mjs's
        // own structural guard).
        assert.match(err.message, /never a claim/);
        return true;
      }
    );
  } finally {
    watchdog.dispose();
  }
});

test("armKillConfirmedWatchdog: a settled poll's own dispose() call prevents ANY later trip - a timer cleared before it fires can never trip afterward", async () => {
  const watchdog = armKillConfirmedWatchdog("job-settles-then-disposed", SHORT_BOUND_MS);
  // Settles immediately (mirrors the real call sites' own "return the
  // moment kill_confirmed !== undefined" shape) - dispose() right away,
  // exactly as every real call site's own `finally` block does.
  watchdog.dispose();

  // Wait well past the bound - if dispose() had not actually cleared the
  // underlying timer, this is exactly when a stray abort would land.
  await new Promise((resolve) => setTimeout(resolve, SHORT_BOUND_MS * 3));

  // A disposed watchdog's own signal must never have tripped - proves
  // dispose() actually clears the timer rather than merely being advisory.
  assert.equal(
    watchdog.signal.aborted,
    false,
    "a watchdog disposed before its bound elapsed must never report aborted, even long afterward"
  );
});

test("armKillConfirmedWatchdog: constructs without a boundMs argument without throwing; KILL_CONFIRMED_POLL_BOUND_MS holds the documented default value", () => {
  // Not a timing assertion (this file never waits the real 60s): calling
  // with no second argument at all must not throw during setup, and the
  // constant every real call site implicitly relies on is exported and
  // has the documented value.
  assert.equal(KILL_CONFIRMED_POLL_BOUND_MS, 60_000);
  const watchdog = armKillConfirmedWatchdog("job-default-bound");
  try {
    assert.doesNotThrow(() => watchdog.throwIfTripped({}));
  } finally {
    watchdog.dispose();
  }
});

/**
 * Mirrors the EXACT integration shape used by `test/run.test.ts`'s and
 * `test/tasks.test.ts`'s own `pollUntilKillConfirmed`: arm, poll in a
 * `for (;;)` calling `throwIfTripped` first each iteration, race each
 * fetch attempt against the watchdog, dispose in a `finally`. `fetch`
 * stands in for the real `killTool.handler()` / `client.callTool()` call
 * each of those two loops makes - routed through `watchdog.race()`, not a
 * bare `await`, so this shape actually exercises the wiring those two real
 * call sites carry rather than only the between-iteration check the four
 * `test/kill.test.ts` loops rely on instead.
 */
async function pollShapeUnderTest(
  jobId: string,
  boundMs: number,
  fetch: () => Promise<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const watchdog = armKillConfirmedWatchdog(jobId, boundMs);
  let lastSeen: Record<string, unknown> = {};
  try {
    for (;;) {
      watchdog.throwIfTripped(lastSeen);
      const structured = await watchdog.race(fetch(), lastSeen);
      lastSeen = structured;
      if (structured.kill_confirmed !== undefined) {
        return structured;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    watchdog.dispose();
  }
}

test("the real poll-loop SHAPE (arm, check first, dispose in finally) settles normally against a fetcher that eventually returns kill_confirmed - GREEN half, a healthy settlement is completely unaffected by the watchdog", async () => {
  let calls = 0;
  const result = await pollShapeUnderTest("job-shape-settles", SHORT_BOUND_MS * 10, async () => {
    calls += 1;
    if (calls < 3) return { state: "exited" };
    return { state: "exited", kill_confirmed: true };
  });
  assert.deepEqual(result, { state: "exited", kill_confirmed: true });
  assert.equal(calls, 3, "must have actually retried, never returned on the first unsettled read");
});

test("the real poll-loop SHAPE fails with KillConfirmedPollTimeoutError, never hangs, against a fetcher that never returns kill_confirmed - RED half, the exact CI-observed shape (state exited, exit_code 0, kill_confirmed permanently undefined) reproduced against the fixed poll loop", async () => {
  const staleForever = {
    job_id: "job-shape-never-settles",
    state: "exited",
    exit_code: 0,
    identity_capture: "captured",
    // kill_confirmed deliberately never present, permanently undefined.
  };
  await assert.rejects(
    () => pollShapeUnderTest("job-shape-never-settles", SHORT_BOUND_MS, async () => staleForever),
    (err: unknown) => {
      assert.ok(err instanceof KillConfirmedPollTimeoutError);
      assert.match(err.message, /job-shape-never-settles/);
      assert.match(err.message, /"exit_code":0/);
      return true;
    }
  );
});

test("the real poll-loop SHAPE fails with KillConfirmedPollTimeoutError against a fetcher whose PROMISE never resolves at all - proves this shape exercises watchdog.race(), not just throwIfTripped(): a bare `await fetch()` here would hang past this test's own timeout instead of surfacing the watchdog's named error", async () => {
  const before = Date.now();
  await assert.rejects(
    () =>
      pollShapeUnderTest(
        "job-shape-hung-fetch",
        SHORT_BOUND_MS,
        () =>
          new Promise<Record<string, unknown>>(() => {
            // Deliberately never settles - the exact shape a hung RPC or
            // transport read takes. throwIfTripped() alone cannot reach
            // this: it only runs at the top of each iteration, and a fetch
            // that never resolves never returns control to the loop for
            // the next check to happen.
          })
      ),
    (err: unknown) => {
      assert.ok(err instanceof KillConfirmedPollTimeoutError);
      assert.match(err.message, /job-shape-hung-fetch/);
      return true;
    }
  );
  const elapsedMs = Date.now() - before;
  // Settles near the watchdog's own short bound - proves the FIRST fetch
  // attempt itself was raced, not merely bounded by some later,
  // unrelated ceiling.
  assert.ok(
    elapsedMs < SHORT_BOUND_MS * 20,
    `expected the shape to fail near the watchdog's own ${SHORT_BOUND_MS}ms bound, took ${elapsedMs}ms`
  );
});

test("KillConfirmedPollTimeoutError: a circular diagnostic does not replace the named failure with an unrelated JSON error - RED half, a bare JSON.stringify would throw here instead", async () => {
  const watchdog = armKillConfirmedWatchdog("job-circular-diagnostic", SHORT_BOUND_MS);
  try {
    await new Promise((resolve) => setTimeout(resolve, SHORT_BOUND_MS * 3));
    const circular: Record<string, unknown> = {
      job_id: "job-circular-diagnostic",
      state: "exited",
    };
    circular.self = circular;
    assert.throws(
      () => watchdog.throwIfTripped(circular),
      (err: unknown) => {
        assert.ok(err instanceof KillConfirmedPollTimeoutError);
        assert.equal(err.name, "KillConfirmedPollTimeoutError");
        assert.match(err.message, /job-circular-diagnostic/);
        assert.match(err.message, /circular reference/);
        return true;
      }
    );
  } finally {
    watchdog.dispose();
  }
});

test("armKillConfirmedWatchdog: race() ends the caller's wrapper wait on a promise that never resolves at all - RED half, a bare per-iteration throwIfTripped() cannot reach this case since a hung await never returns control for the next check to run", async () => {
  const watchdog = armKillConfirmedWatchdog("job-hung-await", SHORT_BOUND_MS);
  try {
    const neverResolves = new Promise<never>(() => {
      // Deliberately never settles - the shape a hung RPC or transport
      // read takes. `race()` must reach a verdict anyway.
    });
    const before = Date.now();
    await assert.rejects(
      () => watchdog.race(neverResolves, { state: "awaiting-hung-call" }),
      (err: unknown) => {
        assert.ok(err instanceof KillConfirmedPollTimeoutError);
        assert.equal(err.name, "KillConfirmedPollTimeoutError");
        assert.match(err.message, /job-hung-await/);
        assert.match(err.message, /awaiting-hung-call/);
        return true;
      }
    );
    const elapsedMs = Date.now() - before;
    // Proves the named error arrives at the watchdog's own short bound,
    // not at some later, unrelated ceiling (node:test's own per-test
    // timeout is 120_000ms in this suite's real configuration) - a
    // generous multiple of SHORT_BOUND_MS, nowhere close to that.
    assert.ok(
      elapsedMs < SHORT_BOUND_MS * 20,
      `expected the race to settle near the watchdog's own ${SHORT_BOUND_MS}ms bound, took ${elapsedMs}ms`
    );
  } finally {
    watchdog.dispose();
  }
});

test("armKillConfirmedWatchdog: race() resolves normally when the raced promise settles well before the bound - GREEN control, the mechanism above does not disturb a healthy call", async () => {
  const watchdog = armKillConfirmedWatchdog("job-race-healthy", SHORT_BOUND_MS);
  try {
    const settlesFast = Promise.resolve({ state: "exited", kill_confirmed: true });
    const result = await watchdog.race(settlesFast, {});
    assert.deepEqual(result, { state: "exited", kill_confirmed: true });
  } finally {
    watchdog.dispose();
  }
});

test("armKillConfirmedWatchdog: race() propagates a genuine rejection from the raced promise unchanged when it rejects before the bound - the watchdog never masks a real error with its own timeout", async () => {
  const watchdog = armKillConfirmedWatchdog("job-race-real-error", SHORT_BOUND_MS);
  try {
    const realError = new Error("a genuine RPC failure, unrelated to the watchdog");
    await assert.rejects(
      () => watchdog.race(Promise.reject(realError), {}),
      (err: unknown) => err === realError
    );
  } finally {
    watchdog.dispose();
  }
});
