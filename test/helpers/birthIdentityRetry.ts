/**
 * Test-support-only bounded retry around a birth-identity capture invoked
 * immediately after a real spawn. NOT production code - nothing under
 * src/ imports this, and it changes no behavior `captureBirthIdentityPosix`/
 * `captureBirthIdentityPosixAsync` (both in ../../dist/process.js) actually
 * have. It exists to absorb a real, confirmed-live TEST-HARNESS race: on a
 * contended CI host, a just-forked child is not always yet visible to `ps`
 * at the exact instant a capture call runs immediately after
 * `spawnManaged()` returns, so a test that captures-then-asserts in strict
 * sequence can occasionally observe `undefined` even though the process
 * is, in fact, alive and about to become visible a few milliseconds later.
 *
 * This is not a defect in the capture functions themselves, and it is not
 * a defect `run()`'s own production path can ever hit: `run()` fires
 * `captureBirthIdentityPosixAsync` off UNAWAITED rather than capturing
 * synchronously-in-sequence right after spawn (see src/tools/run.ts's own
 * docs), specifically so a slow or racing `ps` can never block or corrupt
 * its response. This helper exists only for the many test call sites that
 * deliberately DO capture immediately in sequence, in order to prove
 * things about the capture functions themselves - it gives exactly those
 * call sites more real, independent chances to observe a child the OS has
 * not finished registering yet, never a reason to trust the result any
 * less once it succeeds.
 *
 * Modeled on this codebase's own two existing bounded-wait idioms, not a
 * third invented shape:
 *  - the POLL-UNTIL-CONDITION-OR-DEADLINE loop `waitForProcessDeath` (in
 *    src/process.ts) already uses: a named ms ceiling, a poll interval
 *    capped to never overshoot the remaining budget, and a plain
 *    boolean-or-Promise<boolean> predicate re-evaluated fresh on every
 *    tick - never a cached "already tried" result.
 *  - the explicit, NAMED ms-ceiling constant plus honest,
 *    diagnostic-naming failure `ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS`/
 *    `readProcessElapsedSecondsAsync` use: give the real observer bounded
 *    real chances, then fail LOUDLY and NAME what failed - never silently
 *    widen the caller's own assertion instead.
 */

/**
 * Total real wall-clock time this retry gives a racing capture to
 * eventually succeed before treating it as a genuine failure rather than
 * the transient fork-visibility race it exists to absorb. Chosen the same
 * way this codebase's own IDENTITY_TOLERANCE_SECONDS/
 * ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS were (src/process.ts's own
 * docs): generous enough that even a heavily contended CI host's `ps` has
 * long caught up to a freshly forked child before this elapses (the race
 * this closes is a same-tick/single-digit-millisecond visibility gap, not
 * a multi-second one), while staying far below
 * ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS (3000ms) so this retry can never
 * be mistaken for, or mask, a genuinely HUNG observer - that failure mode
 * is `captureBirthIdentityPosixAsync`'s own internal settlement bound's
 * job (see that function's own docs and test/process.test.ts's/
 * test/process-slow-paths.test.ts's hung/resistant-observer tests), never
 * this one's. A capture that is still coming back `undefined` after a
 * full second of real retrying is a genuine capture failure, not this
 * race, and must fail loudly rather than retry forever.
 */
export const BIRTH_IDENTITY_CAPTURE_RETRY_BOUND_MS = 1000;

/**
 * How long this retry waits between attempts - short enough that a
 * handful of retries still land comfortably inside
 * BIRTH_IDENTITY_CAPTURE_RETRY_BOUND_MS, matching `waitForProcessDeath`'s
 * own 50ms default poll cadence in spirit (kept a little tighter here
 * since the condition each attempt evaluates - a real `ps` invocation -
 * is itself real wall-clock work, not free, so a shorter interval still
 * fits several real attempts inside the bound above).
 */
export const BIRTH_IDENTITY_CAPTURE_RETRY_POLL_INTERVAL_MS = 20;

/**
 * Retries `attemptCapture` - a fresh, real, independent invocation of
 * either `captureBirthIdentityPosix` or `captureBirthIdentityPosixAsync`
 * on EVERY call, never a memoized or cached prior answer - until it
 * returns something other than `undefined`, or `boundMs` of real
 * wall-clock time elapses, whichever comes first.
 *
 * `attemptCapture` may return its result directly or as a `Promise` - the
 * same "may return a value directly, or a Promise" shape
 * `waitForProcessDeath`'s own `isAlive` parameter already uses in
 * src/process.ts, reused here rather than inventing a second convention
 * for the same idea. The synchronous shape (`captureBirthIdentityPosix`)
 * is used as-is - a synchronous call has already fully run by the time it
 * returns, so there is nothing to bound. The Promise shape
 * (`captureBirthIdentityPosixAsync`) is raced against a timer bounded by
 * whatever real time remains before `deadline`, rather than merely
 * `await`ed and checked afterward: an unbounded `await` on the attempt
 * itself would let this function's own wait run past `boundMs` before it
 * ever got a chance to notice, since the deadline check can only run once
 * the `await` returns control. Racing closes that gap - whichever settles
 * first, the attempt or the timer, decides what happens next, so THIS
 * FUNCTION's own wait, and its willingness to accept a late answer, can
 * never outlive the bound it was given. That bound is on the wrapper's
 * wait and acceptance window, not on the attempt itself - the underlying
 * capture (a real `ps`-backed observation) is never cancelled and can
 * genuinely keep running past `boundMs`; only this function's own
 * decision to wait for or accept its answer is what stops at the bound.
 *
 * A losing attempt (the timer wins the race) is abandoned, never awaited
 * further - but it is not forgotten, and it is not cancelled. Its promise
 * keeps running in the background exactly as any real `ps`-backed capture
 * would, entirely outside this function's own bound, and it can still
 * settle - successfully, to `undefined`, or by throwing - well after this
 * function has already thrown its own failure and returned control to the
 * caller. A no-op rejection handler is attached to every Promise-shaped
 * attempt up front, before it is ever raced, so a later rejection from an
 * abandoned attempt can never surface as a process-level unhandled
 * rejection - it is safely observed and discarded, not prevented from
 * happening.
 *
 * NEVER weakens a caller's own assertion - the opposite: a caller's
 * `assert.notEqual(result, undefined, ...)` immediately after this call
 * stays exactly as strict as it always was. What changes is only how many
 * real, independent chances the capture gets to succeed before that
 * assertion ever runs. If every attempt within `boundMs` still comes back
 * `undefined`, or one simply never settles in time, this throws - loudly,
 * naming `captureFunctionName` and the attempt count so the failure is
 * never confused with a generic timeout - rather than ever resolving to
 * `undefined` itself and leaving a caller's assertion to produce a vaguer
 * failure with no idea which capture function, or how many real attempts,
 * were involved.
 */
export async function retryBirthIdentityCapture<T>(
  attemptCapture: () => T | undefined | Promise<T | undefined>,
  captureFunctionName: string,
  boundMs: number = BIRTH_IDENTITY_CAPTURE_RETRY_BOUND_MS,
  pollIntervalMs: number = BIRTH_IDENTITY_CAPTURE_RETRY_POLL_INTERVAL_MS
): Promise<T> {
  const deadline = Date.now() + boundMs;
  let attempts = 0;
  // Distinguishes, in the final thrown message, "every attempt personally
  // finished and just kept saying undefined" from "the last attempt never
  // finished at all within its remaining time" - only ever true right
  // before the one `giveUp()` call it caused, never stale from an earlier
  // iteration (every path that reaches `giveUp()` either sets this first
  // or has already reset it false on a prior attempt's clean settlement).
  let lastAttemptTimedOut = false;

  const giveUp = (): never => {
    const timeoutNote = lastAttemptTimedOut
      ? " (the final attempt never settled within its remaining time budget - a stalled observer, not merely another undefined answer)"
      : "";
    throw new Error(
      `${captureFunctionName} still returned undefined after ${attempts} attempt(s) over ${boundMs}ms of bounded retrying${timeoutNote} - a genuine capture failure, not the transient fork-visibility race this retry exists to absorb`
    );
  };

  for (;;) {
    // Checked BEFORE starting a new attempt, not just after the previous
    // one settles: once the deadline has already passed, a fresh attempt
    // is never even started.
    if (deadline - Date.now() <= 0) {
      giveUp();
    }
    attempts += 1;

    const attemptReturn = attemptCapture();
    let result: T | undefined;

    if (attemptReturn instanceof Promise) {
      const attemptPromise = attemptReturn as Promise<T | undefined>;
      // Attach a no-op rejection handler on the REAL attempt promise
      // immediately, before racing it against anything below. If this
      // attempt loses the race (the timer fires first), its eventual
      // settlement - success, undefined, or a thrown error, arriving at
      // any point after this function has already thrown and returned
      // control to its caller - must never become an unhandled rejection
      // just because nothing else is still listening for it by the time
      // it finally happens.
      attemptPromise.catch(() => {});

      const remainingForThisAttempt = deadline - Date.now();
      const TIMED_OUT = Symbol("retryBirthIdentityCapture: attempt exceeded its remaining budget");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), Math.max(remainingForThisAttempt, 0));
      });

      const raced = await Promise.race([attemptPromise, timedOut]);
      clearTimeout(timer);

      if (raced === TIMED_OUT) {
        // The timer won: treat this exactly like the deadline having
        // passed. Do NOT wait for the losing attempt to ever resolve -
        // its `.catch` above already guarantees it can settle safely
        // without us.
        lastAttemptTimedOut = true;
        giveUp();
      }
      lastAttemptTimedOut = false;
      result = raced as T | undefined;
    } else {
      // Already a plain value - a synchronous call has nothing to race,
      // and forcing it through Promise.race would be harmless but is
      // unneeded indirection for the shape this retry serves fastest.
      result = attemptReturn;
    }

    if (result !== undefined) return result;

    const remainingAfterAttempt = deadline - Date.now();
    if (remainingAfterAttempt <= 0) {
      giveUp();
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, remainingAfterAttempt))
    );
  }
}
