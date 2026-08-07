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
 * `selectAndWake`: the app-server transport first, then the desktop-IPC
 * transport.
 *
 * Ordering rationale (a real decision, not arbitrary): `appServerTransport`
 * talks to the documented, versioned `codex app-server` subcommand and has
 * exactly one well-defined reason to report itself unavailable - the
 * running app-server not reporting its `"goals"` experimental feature
 * enabled (see that file's own `probe()`). `desktopIpcTransport` instead
 * depends on a live GUI window with the exact target conversation
 * currently open in it, and reaches into the ChatGPT desktop app's
 * undocumented internals over a socket path that has already relocated
 * once inside a single app update (see that file's own header for the
 * measured history). Trying the better-documented, more narrowly-scoped
 * mechanism first means a caller only ever falls through to the riskier,
 * GUI-dependent one once the safer one has already ruled itself out for
 * this specific target - never the other way around.
 *
 * Built once, at module load, with each transport's own defaults - cheap
 * and side-effect-free, since neither constructor does anything beyond
 * assigning its own option fields (see each class's own constructor). A
 * caller that needs different transport options (a different socket path,
 * a different token budget) builds its own array instead of using this
 * one - `selectAndWake` takes the transport list as a plain parameter
 * specifically so this default is a convenience, never the only path.
 */
export const DEFAULT_TRANSPORTS: readonly WakeTransport[] = [
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
 * True only when THIS process is itself running as a stdio MCP server
 * subprocess Claude Code spawned - the one signal Claude Code documents as
 * set for that case (confirmed by fetching
 * https://code.claude.com/docs/en/env-vars.md: "Set to 1 in subprocesses
 * Claude Code spawns (Bash and PowerShell tools, tmux sessions, hook
 * commands, status line commands, stdio MCP server subprocesses)").
 * ghantika itself runs exactly that way when Claude Code is the caller, so
 * this env var is a real, first-party fact about this process's own
 * parentage - never a platform or harness guess. Read on demand rather
 * than cached at module load: nothing in this module needs the answer
 * before the exhaustion path below actually runs, and a fresh read costs
 * nothing measurable.
 *
 * Deliberately the ONLY signal this function checks. A second heuristic
 * stacked on top (a parent-process name sniff, another env var) would only
 * widen the surface for a false read without adding real confidence - this
 * one is already a documented, first-party fact rather than an inference.
 *
 * Used for exactly one thing: composing the exhaustion `detail` string
 * below. See `selectAndWake`'s own doc comment for the hard boundary this
 * respects - it never changes which transports are tried, in what order,
 * or what `outcome` this function returns.
 */
function isRunningUnderClaudeCode(): boolean {
  return process.env.CLAUDECODE === "1";
}

/**
 * Composes the aggregate `detail` string for `selectAndWake`'s exhaustion
 * path - called only after the loop above has confirmed nothing delivered,
 * with `outcome` already decided by the caller and passed in read-only.
 * This function never influences that decision, only how it reads.
 *
 * On `"unavailable"` specifically - never `"refused"`, since a refusal
 * means some live transport actually answered, and that answer belongs in
 * the log verbatim and unqualified, never reframed - this leads with a
 * plain-language summary when `isRunningUnderClaudeCode()` is true: none
 * of today's `DEFAULT_TRANSPORTS` serve that harness at all (both are
 * Codex-specific), so "tried 2, here's why each individually fell short"
 * reads as two unrelated near-misses when the honest fact is one absent
 * capability - this client has no configured push-wake mechanism at all,
 * and the caller's real working path is the poll floor
 * (`status`/`output`/`tail`). The full per-transport log still follows,
 * unchanged, for a reader who wants the mechanical detail underneath -
 * this PREPENDS the clearer summary rather than replacing the log, so
 * nothing already true about this run is lost.
 *
 * Every other case (a non-empty attempt list on any other outcome, or an
 * empty one) returns exactly the wording this produced before this
 * function existed - see `test/wake-select-transport.test.ts` for the
 * exact strings this is pinned against.
 */
function buildExhaustionDetail(attempts: readonly Attempt[], outcome: WakeOutcome): string {
  if (attempts.length === 0) {
    return "no transports were configured to try";
  }

  const perTransportLog = `tried ${attempts.length} in order - ${attempts
    .map((attempt) => attempt.summary)
    .join("; ")}`;

  if (outcome === "unavailable" && isRunningUnderClaudeCode()) {
    return (
      `no transport delivered; this process is running under Claude Code, and none of the ` +
      `${attempts.length} configured transport(s) serve that client - there is no push-wake ` +
      `mechanism available here, poll status/output/tail instead. ${perTransportLog}`
    );
  }

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
 * below, which on the `"unavailable"` outcome may lead with a plain-
 * language summary when the CURRENT PROCESS is running under Claude Code
 * (see `isRunningUnderClaudeCode`'s own doc comment) - today's
 * `DEFAULT_TRANSPORTS` are both Codex-specific, so on that harness a bare
 * per-transport enumeration reads as "two things broke" rather than "this
 * client has no push-wake mechanism at all." This affects MESSAGE TEXT
 * ONLY: it changes no branch above, decides no `outcome`, and requires no
 * caller of this function to know or pass in which harness it runs on -
 * this function's own signature is unchanged.
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
    detail: buildExhaustionDetail(attempts, outcome),
    transportName: SELECTOR_TRANSPORT_NAME,
  };
}
