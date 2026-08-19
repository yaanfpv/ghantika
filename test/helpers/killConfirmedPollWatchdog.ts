/**
 * A TEST-HARNESS-ONLY watchdog for the `pollUntilKillConfirmed`-shaped
 * loops in this suite that poll `kill()`/`status()` until `kill_confirmed`
 * settles - currently `test/run.test.ts`'s and `test/tasks.test.ts`'s own
 * `pollUntilKillConfirmed` helpers and the four inline loops in
 * `test/kill.test.ts`; this list names the sites wired to it, not a proven
 * claim that no other such loop exists anywhere in the suite. NOT
 * production code - nothing under `src/` imports this.
 *
 * WHY THIS EXISTS, and why it is deliberately NOT a bound on `kill_confirmed`
 * itself: `src/tools/kill.ts`'s own doc comment on that field is explicit
 * that the gap between a process group emptying and the confirmation write
 * landing is real event-loop scheduling latency, "deliberately never stated
 * as a wall-clock bound" - every poll loop in this suite honors that by
 * carrying no deadline of its own on the field settling (see each loop's
 * own doc comment, and `scripts/check-no-bounded-kill-confirmed-wait.mjs`,
 * the structural guard that enforces it). That is still correct and this
 * file does not change it: the loops below still poll unboundedly for the
 * FIELD, exactly as before.
 *
 * What was missing is a bound on the TEST'S OWN PATIENCE, not on the field.
 * Before this, every one of these loops fell through to node:test's own
 * per-test ceiling (`testTimeoutMs`, 120_000ms - see
 * `scripts/run-tests.mjs`'s own doc comment on that constant) with a bare
 * "test timed out after 120000ms" and no indication of which job, which
 * field, or what the last observed state was. This watchdog fires FIRST,
 * well inside that ceiling, and reports the job id and the last observed
 * record instead - turning an opaque hang into a named, addressable
 * failure.
 *
 * HOW THIS AVOIDS RE-INTRODUCING A BOUND ON THE FIELD: the watchdog is an
 * independent `AbortController` armed by `setTimeout`, entirely OUTSIDE the
 * polling loop's own control flow - it never reads `Date.now()` inside the
 * loop and never races the field's own settling against a clock the loop
 * itself evaluates. A caller checks `throwIfTripped()` (a plain function
 * call, not an inline clock comparison) once per iteration and keeps
 * polling exactly as before until either the field settles or the
 * watchdog's own timer has fired - the loop's total patience is still, in
 * every practical sense, "as long as the test is willing to run"; this
 * only shortens that from node:test's opaque 120s to a shorter, generous,
 * self-explaining one. See `scripts/check-no-bounded-kill-confirmed-wait.mjs`'s
 * own doc comment for exactly which shape it flags (a loop body pairing a
 * `kill_confirmed` reference with an `if` whose condition calls
 * `Date.now()` and whose then-branch throws) - this is a different
 * mechanism on purpose, not a narrower rewrite of the forbidden one.
 *
 * A per-iteration `throwIfTripped()` call alone only catches a stall
 * BETWEEN poll attempts: a single awaited call that itself never resolves
 * still holds the loop past the bound, since nothing returns control for
 * the next check to run. `race()` closes that gap the same way - still a
 * bound on the test's own patience, never on the field - by racing the
 * specific outstanding call's PROMISE against the same abort signal.
 * That ends the loop's own wait with a named failure once the bound
 * elapses; it does not reach into the call itself, so whatever produced
 * that promise (an RPC round trip, a handler invocation already under
 * way) may still be running in the background, unobserved, after `race()`
 * has already rejected.
 *
 * `race()` is wired into `test/run.test.ts`'s and `test/tasks.test.ts`'s
 * poll loops, both of which await a call (`killTool.handler()`,
 * `client.callTool()`) with no bound of its own. It is deliberately NOT
 * wired into `test/kill.test.ts`'s four inline loops: their one awaited
 * call, `server.nextLine()` (`test/helpers/spawnServer.ts`), already
 * rejects on its own `DEFAULT_LINE_TIMEOUT_MS` (6000ms, both with and
 * without coverage instrumentation - see `spawnServer.ts`'s own comment
 * for why the two paths are unified) - always far under this watchdog's
 * own bound -
 * so those loops already avoid an indefinite await and fire well before
 * node:test's own per-test ceiling without `race()`'s help. That is not an
 * absolute guarantee that `nextLine()`'s own timeout never surfaces
 * instead of this watchdog's: `throwIfTripped()` only runs at the TOP of
 * an iteration, so an iteration that starts just before the watchdog's
 * bound elapses can still run to its own full 2s/6s budget and report a
 * generic line-timeout rather than this watchdog's named one. The
 * per-iteration `throwIfTripped()` those four loops already carry still
 * catches the other failure mode - many fast iterations that never reach
 * `kill_confirmed` - exactly as it does everywhere else.
 */

/**
 * How long a `kill_confirmed` poll loop's own watchdog waits before giving
 * up and reporting a named failure - independent of, and well inside,
 * node:test's own 120_000ms per-test ceiling (`testTimeoutMs` in
 * `scripts/run-tests.mjs`) so this fires first, with a diagnostic, rather
 * than that ceiling firing second with none.
 *
 * Chosen the same way this suite's own `BIRTH_IDENTITY_CAPTURE_RETRY_BOUND_MS`
 * was (see `test/helpers/birthIdentityRetry.ts`'s own docs): generous
 * enough that it is not itself a source of false failures. Every real
 * settling this suite's own polling loops depend on - the eager reap's
 * synchronous liveness probe on the fast path, and ordinary retry settling
 * on the slow path - completes well under a second in practice, so
 * 60_000ms leaves ample margin without itself becoming a plausible source
 * of a false failure under real scheduling pressure, while still firing
 * this watchdog's own diagnostic before node:test's own per-test timeout
 * could otherwise pre-empt it with none.
 */
export const KILL_CONFIRMED_POLL_BOUND_MS = 60_000;

/**
 * `JSON.stringify` on a circular structure throws, which - called from
 * inside this error's own constructor - would replace the named,
 * actionable failure this whole watchdog exists to produce with an
 * unrelated "Converting circular structure to JSON" TypeError instead.
 * Falls back to a plain description rather than ever letting that happen.
 */
function stringifyDiagnostic(diagnostic: Record<string, unknown>): string {
  try {
    return JSON.stringify(diagnostic);
  } catch {
    return "[diagnostic could not be serialized - contains a circular reference]";
  }
}

/**
 * Thrown by a `kill_confirmed` poll loop's watchdog once
 * `KILL_CONFIRMED_POLL_BOUND_MS` has elapsed with no settlement. This is
 * NEVER a claim about the field's own contract - see this file's own
 * header doc comment - purely a test-harness backstop that names the job
 * id, the field, and the last observed record instead of leaving a bare
 * "test timed out after 120000ms" for a human to reconstruct from
 * breadcrumbs after the fact.
 */
export class KillConfirmedPollTimeoutError extends Error {
  constructor(jobId: string, boundMs: number, diagnostic: Record<string, unknown>) {
    super(
      `kill_confirmed did not settle for job ${jobId} within this test's own ` +
        `${boundMs}ms watchdog bound (a test-harness backstop, never a claim ` +
        `about kill_confirmed's own contract - see KILL_CONFIRMED_POLL_BOUND_MS's ` +
        `own doc comment). Last observed: ${stringifyDiagnostic(diagnostic)}`
    );
    this.name = "KillConfirmedPollTimeoutError";
  }
}

/** What `armKillConfirmedWatchdog` returns - see that function's own docs. */
export interface KillConfirmedWatchdog {
  /**
   * Trips `KILL_CONFIRMED_POLL_BOUND_MS` after `armKillConfirmedWatchdog`
   * was called. Never read via `Date.now()` inside a caller's own loop -
   * see this file's own header doc comment for why that distinction is
   * load-bearing.
   */
  readonly signal: AbortSignal;
  /**
   * Call once per poll iteration with the most recently observed record
   * (or an empty object on the very first iteration, before any response
   * has come back yet). Throws `KillConfirmedPollTimeoutError` once
   * `signal` has tripped; otherwise returns without side effects, letting
   * the caller's own loop continue polling exactly as it already does.
   */
  throwIfTripped(diagnostic: Record<string, unknown>): void;
  /**
   * Races `promise` against this watchdog's own bound: resolves or
   * rejects exactly as `promise` would if it settles first, or rejects
   * with `KillConfirmedPollTimeoutError` if the bound elapses first,
   * before `promise` has settled at all.
   *
   * This is the case a per-iteration `throwIfTripped()` call cannot
   * reach on its own: that check only runs at the TOP of a poll
   * iteration, so a single awaited call that never resolves - a hung RPC
   * or transport read - never returns control to the loop for the next
   * check to happen. Wrapping that same awaited call in `race()` ends
   * the loop's own wait on it with a named failure once the bound
   * elapses, instead of leaving the loop stuck until node:test's own
   * per-test ceiling. It does not cancel or interrupt the call itself -
   * whatever produced `promise` may still be running after `race()` has
   * already rejected; nothing awaits its eventual result.
   */
  race<T>(promise: Promise<T>, diagnostic: Record<string, unknown>): Promise<T>;
  /**
   * Clears the underlying timer. MUST be called exactly once the poll has
   * settled, in a `finally` - otherwise the timer keeps the event loop
   * alive for the remainder of `KILL_CONFIRMED_POLL_BOUND_MS`, uselessly,
   * even after the loop it was guarding has already returned.
   */
  dispose(): void;
}

/**
 * Arms one watchdog for one `kill_confirmed` poll loop - see this file's
 * own header doc comment for the full "why" and
 * `KILL_CONFIRMED_POLL_BOUND_MS`'s own docs for why this default is safe.
 * Every call site below follows the same shape:
 *
 * ```ts
 * const watchdog = armKillConfirmedWatchdog(jobId);
 * try {
 *   for (;;) {
 *     watchdog.throwIfTripped(lastSeenSoFar);
 *     const result = await watchdog.race(callSomeRpc(), lastSeenSoFar);
 *     // ... existing poll body, completely unchanged ...
 *   }
 * } finally {
 *   watchdog.dispose();
 * }
 * ```
 */
export function armKillConfirmedWatchdog(
  jobId: string,
  boundMs: number = KILL_CONFIRMED_POLL_BOUND_MS
): KillConfirmedWatchdog {
  const controller = new AbortController();
  // Deliberately NOT `.unref()`'d: an unref'd timer that fires while
  // `race()` is still waiting on an unsettled promise collides with
  // node:test's own event-loop-idle detection and cancels every other
  // test still queued in this file. Every real call site already disposes
  // in a `finally` (see this file's own header doc comment), so a normal,
  // ref'd timer is cleared through the ordinary path in practice; a call
  // site that forgets to dispose keeps the TEST process alive for up to
  // `boundMs`, which `scripts/run-tests.mjs`'s own idle-watchdog then
  // catches loudly rather than the timer silently never being why
  // anything hangs.
  const timer = setTimeout(() => controller.abort(), boundMs);
  return {
    signal: controller.signal,
    throwIfTripped(diagnostic: Record<string, unknown>): void {
      if (controller.signal.aborted) {
        throw new KillConfirmedPollTimeoutError(jobId, boundMs, diagnostic);
      }
    },
    race<T>(promise: Promise<T>, diagnostic: Record<string, unknown>): Promise<T> {
      if (controller.signal.aborted) {
        return Promise.reject(new KillConfirmedPollTimeoutError(jobId, boundMs, diagnostic));
      }
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          reject(new KillConfirmedPollTimeoutError(jobId, boundMs, diagnostic));
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
          (value) => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (err: unknown) => {
            controller.signal.removeEventListener("abort", onAbort);
            reject(err);
          }
        );
      });
    },
    dispose(): void {
      clearTimeout(timer);
    },
  };
}
