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
 * for the same idea. `await`ing it is a no-op for the synchronous case
 * (`captureBirthIdentityPosix`) and a real await for the async one
 * (`captureBirthIdentityPosixAsync`), so this one implementation serves
 * both call shapes unchanged.
 *
 * NEVER weakens a caller's own assertion - the opposite: a caller's
 * `assert.notEqual(result, undefined, ...)` immediately after this call
 * stays exactly as strict as it always was. What changes is only how many
 * real, independent chances the capture gets to succeed before that
 * assertion ever runs. If every attempt within `boundMs` still comes back
 * `undefined`, this throws - loudly, naming `captureFunctionName` and the
 * attempt count so the failure is never confused with a generic timeout -
 * rather than ever resolving to `undefined` itself and leaving a caller's
 * assertion to produce a vaguer failure with no idea which capture
 * function, or how many real attempts, were involved.
 */
export async function retryBirthIdentityCapture<T>(
  attemptCapture: () => T | undefined | Promise<T | undefined>,
  captureFunctionName: string,
  boundMs: number = BIRTH_IDENTITY_CAPTURE_RETRY_BOUND_MS,
  pollIntervalMs: number = BIRTH_IDENTITY_CAPTURE_RETRY_POLL_INTERVAL_MS
): Promise<T> {
  const deadline = Date.now() + boundMs;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const result = await attemptCapture();
    if (result !== undefined) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `${captureFunctionName} still returned undefined after ${attempts} attempt(s) over ${boundMs}ms of bounded retrying - a genuine capture failure, not the transient fork-visibility race this retry exists to absorb`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }
}
