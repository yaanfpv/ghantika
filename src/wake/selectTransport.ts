/**
 * The ordered wake-selection function a real caller actually invokes to
 * request a wake, trying each configured transport in turn until one
 * delivers or the list is exhausted.
 *
 * This file needs to see both concrete transports at once, which is
 * exactly why it cannot live behind `wakeTransport.ts`'s door instead of
 * beside it: `wakeTransport.ts` is a deliberately type-only, zero-runtime
 * contract (see its own header, and `test/wake-transport.test.ts`'s "zero
 * runtime footprint" proof, which this file leaves untouched), and adding
 * a real function export to it would break that guarantee for every
 * future consumer of the pure contract. So this file is admitted as a
 * second, genuinely public door in
 * `scripts/check-wake-transport-boundaries.mjs`'s `WAKE_PUBLIC_FILES` set,
 * alongside `wakeTransport.ts` - see that script's own header for the full
 * boundary design. A caller who wants both the shared types and the
 * selector imports from both files separately - that split is the
 * intended shape, not a workaround.
 *
 * `selectAndWake` never fabricates a "delivered" outcome - see that
 * function's own doc comment for the invariant this whole file exists to
 * protect.
 */
import { AppServerGoalWakeTransport } from "./appServerTransport.js";
import { ClaudeMessagingWakeTransport } from "./claudeMessagingTransport.js";
import { DesktopIpcWakeTransport } from "./desktopIpcTransport.js";
import type {
  Capability,
  WakeOutcome,
  WakeResult,
  WakeTarget,
  WakeTransport,
} from "./wakeTransport.js";

/**
 * The `transportName` recorded on the aggregate `WakeResult` this module
 * returns when no real transport delivered - deliberately never a real
 * transport's own name, so a caller or a log reader can tell an
 * aggregated "nothing worked" result apart from a genuine single-transport
 * result at a glance.
 */
export const SELECTOR_TRANSPORT_NAME = "wake-transport-selector";

/**
 * The default, real-world attempt order a real caller passes to
 * `selectAndWake`: the Claude Code messaging transport first, then the
 * app-server transport, then the desktop-IPC transport.
 *
 * Ordering rationale (a real decision, not arbitrary): `claudeMessagingTransport`
 * probes by reading two environment variables and, at most, opening a local
 * socket connection - no subprocess spawn, no GUI dependency - so trying it
 * first costs nothing when it does not apply (a caller not running as a
 * Claude Code subprocess simply has neither env var set, and `probe()`
 * returns `unavailable` near-instantly) and is the harness's own genuine
 * push-wake mechanism when it does. `appServerTransport` talks to the
 * documented, versioned `codex app-server` subcommand and has exactly one
 * well-defined reason to report itself unavailable - the running
 * app-server not reporting its `"goals"` experimental feature enabled (see
 * that file's own `probe()`). `desktopIpcTransport` instead depends on a
 * live GUI window with the exact target conversation currently open in it,
 * and reaches into the ChatGPT desktop app's undocumented internals over a
 * socket path that has already relocated once inside a single app update
 * (see that file's own header for the measured history). Trying the
 * better-documented, more narrowly-scoped mechanisms first means a caller
 * only ever falls through to the riskier, GUI-dependent one once the safer
 * ones have already ruled themselves out for this specific target - never
 * the other way around.
 *
 * In practice these three transports are mutually exclusive by harness (a
 * Claude Code subprocess has the messaging env vars set and neither `codex`
 * nor the desktop app's socket meaningfully reachable in a useful way; a
 * Codex thread has neither messaging env var set), so this ordering rarely
 * matters for which one actually delivers - it matters for which one is
 * asked first when more than one might, in principle, answer.
 *
 * Built once, at module load, with each transport's own defaults - cheap
 * and side-effect-free, since none of these constructors does anything
 * beyond assigning its own option fields (see each class's own
 * constructor). A caller that needs different transport options (a
 * different socket path, a different token budget) builds its own array
 * instead of using this one - `selectAndWake` takes the transport list as a
 * plain parameter specifically so this default is a convenience, never the
 * only path.
 */
export const DEFAULT_TRANSPORTS: readonly WakeTransport[] = [
  new ClaudeMessagingWakeTransport(),
  new AppServerGoalWakeTransport(),
  new DesktopIpcWakeTransport(),
];

/** Turns a caught value of unknown shape (per `catch`'s own typing under `strict`) into a readable message - for a transport that violates its own contract by throwing or rejecting instead of resolving a `WakeResult`. */
function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One transport's outcome for a single `selectAndWake` call - kept only
 * long enough to build the aggregate `detail` string if nothing delivers.
 */
interface Attempt {
  readonly summary: string;
  /**
   * True only when an invoked `wake()` call actually resolved with
   * `outcome: "refused"` - never set for a probe-skip, a thrown `wake()`,
   * or a `wake()` that resolved `"unavailable"`. This is the only signal
   * the aggregate-outcome rule below reads; see `selectAndWake`'s own doc
   * comment for why a refusal specifically is what earns the aggregate
   * `"refused"` outcome.
   */
  readonly wasRefused: boolean;
}

/**
 * Composes the aggregate `detail` string for `selectAndWake`'s exhaustion
 * path - called only after the loop above has confirmed nothing delivered.
 *
 * A bare per-transport enumeration, always - no harness-specific
 * special-casing. `DEFAULT_TRANSPORTS` now includes
 * `ClaudeMessagingWakeTransport`, so there is no longer a harness with
 * zero configured transports serving it; the per-transport log already
 * says, per transport, exactly what happened (skipped as unavailable,
 * attempted and refused, or attempted and unavailable), which is the
 * accurate report whether or not the caller happens to be running under
 * Claude Code. See `test/wake-select-transport.test.ts` for the exact
 * strings this is pinned against.
 */
function buildExhaustionDetail(attempts: readonly Attempt[]): string {
  if (attempts.length === 0) {
    return "no transports were configured to try";
  }

  const perTransportLog = `tried ${attempts.length} in order - ${attempts
    .map((attempt) => attempt.summary)
    .join("; ")}`;

  return `no transport delivered; ${perTransportLog}`;
}

/**
 * Tries each transport in `transports`, strictly in array order, one at a
 * time - never concurrently, since a later transport is only ever worth
 * trying once an earlier one has conclusively failed to deliver for this
 * specific attempt. For each transport: `probe()` runs first, and
 * `wake()` is invoked only when `probe()` reports `available: true` -
 * never otherwise.
 *
 * THE ONE INVARIANT THIS FUNCTION EXISTS TO PROTECT: it returns
 * `outcome: "delivered"` in exactly one place in this function's body -
 * passing through, unchanged, a real transport's own `wake()` result the
 * instant that result's `outcome` is exactly (`===`) `"delivered"`.
 * Nothing in this function's own aggregation logic ever constructs,
 * infers, or defaults to a `"delivered"` outcome. If every transport is
 * exhausted with no delivery, the aggregate result built below is
 * `"refused"` or `"unavailable"` - never `"delivered"` - no matter how
 * many transports were tried or how close any of them came. A transport
 * whose `wake()` resolves with some other, malformed value for `outcome`
 * (a runtime contract violation the type system can't prevent) is treated
 * exactly like a `"refused"`/`"unavailable"` result: recorded, and the
 * loop moves on - the strict `===` check means only the literal string
 * `"delivered"` can ever short-circuit this loop.
 *
 * Aggregate-outcome rule on exhaustion (documented rather than arbitrary,
 * since the two outcomes carry different remedies for a caller): the
 * result is `"unavailable"` unless at least one transport was genuinely
 * attempted (its `wake()` actually invoked) AND that attempt resolved with
 * `outcome: "refused"` - only then is the aggregate `"refused"`. "At least
 * one live transport actively declined this wake" is a meaningfully
 * stronger, more actionable claim than "nothing here could even be
 * reached", so a real refusal is the only thing that earns it. A
 * transport that was merely skipped (probe reported unavailable), one
 * whose `wake()` itself resolved `"unavailable"` (a probe/wake race), and
 * one whose `wake()` threw outright all read the same here - "we never
 * got a clean, positive answer from this one" - and fall back to the more
 * conservative `"unavailable"`. A caller reading `"refused"` back can
 * reasonably infer some live mechanism actively said no and retrying
 * immediately is unlikely to help; a caller reading `"unavailable"` should
 * not assume that, and might reasonably retry once conditions change.
 *
 * `wake()` throwing, or its returned promise rejecting - a transport
 * violating its own contract, since the interface promises a resolved
 * `WakeResult` - is treated as that transport failing this attempt exactly
 * like an `"unavailable"` result: recorded with the thrown message, and
 * the loop falls through to the next transport rather than letting the
 * rejection propagate out of this function and crash the caller. The same
 * handling applies to `probe()` itself throwing, before `wake()` is ever
 * reached.
 *
 * An empty `transports` array returns cleanly with a non-`"delivered"`
 * outcome and a detail explaining nothing was configured to try - the
 * loop below simply never runs, so this needs no special-cased branch.
 *
 * The exhaustion `detail` string itself is built by `buildExhaustionDetail`
 * below - a plain per-transport enumeration, the same on every harness. See
 * that function's own doc comment for why no harness-specific wording is
 * needed once every configured harness has a transport of its own in
 * `DEFAULT_TRANSPORTS`.
 */
export async function selectAndWake(
  transports: readonly WakeTransport[],
  target: WakeTarget,
  payload: string
): Promise<WakeResult> {
  const attempts: Attempt[] = [];

  for (const transport of transports) {
    let capability: Capability;
    try {
      capability = await transport.probe();
    } catch (error) {
      attempts.push({
        summary: `${transport.name}: probe() threw before reporting availability - ${describeThrown(error)}`,
        wasRefused: false,
      });
      continue;
    }

    if (capability.available !== true) {
      const reason = capability.reason ?? "no reason given";
      attempts.push({
        summary: `${transport.name}: skipped, probe reported unavailable - ${reason}`,
        wasRefused: false,
      });
      continue;
    }

    let result: WakeResult;
    try {
      result = await transport.wake(target, payload);
    } catch (error) {
      attempts.push({
        summary: `${transport.name}: probed available, but wake() threw rather than resolving - ${describeThrown(error)}`,
        wasRefused: false,
      });
      continue;
    }

    if (result.outcome === "delivered") {
      // The ONLY line in this function that returns "delivered" - a real
      // transport's own result, returned exactly as that transport built
      // it, never re-synthesized or approximated here. See this
      // function's own header for why this line is the whole point of
      // the file.
      return result;
    }

    const detail = result.detail ?? "no detail given";
    attempts.push({
      summary: `${transport.name}: attempted, ${result.outcome} - ${detail}`,
      wasRefused: result.outcome === "refused",
    });
  }

  const anyGenuineRefusal = attempts.some((attempt) => attempt.wasRefused);
  const outcome: WakeOutcome = anyGenuineRefusal ? "refused" : "unavailable";

  return {
    outcome,
    detail: buildExhaustionDetail(attempts),
    transportName: SELECTOR_TRANSPORT_NAME,
  };
}
