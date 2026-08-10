/**
 * Resolves a `WakeTarget` from the raw `_meta` object of an incoming
 * `tools/call` request, without ever fabricating one.
 *
 * A Codex client sends the calling thread's identity in
 * `params._meta.threadId` - a UUID string, stable across multiple calls
 * within one session and distinct across separate sessions, exactly the
 * property a wake target needs. The same `_meta` object may also carry a
 * vendor-specific `x-codex-turn-metadata` block with the same id under
 * `.thread_id`; `threadId` (top-level, spec-shaped) is read instead, since
 * it is the more stable, less vendor-specific of the two.
 *
 * Claude Code sends `_meta` shaped as `{claudecode/toolUseId,
 * progressToken}` - no thread identity at all. That is an ordinary,
 * expected shape for this function, not an error: Claude Code has its own
 * client-side auto-backgrounding as its wake path and does not need this
 * transport layer, so `"absent"` is the correct, unremarkable answer for
 * it.
 *
 * Three states, matching `src/tools/status.ts`'s own
 * `PublicBirthIdentityProjection` pattern - narrowing on `state` alone
 * gets the right shape or none, rather than a `{state, target?}` shape
 * with a nullable field, where a caller would have to cross-check a
 * second field by convention to tell "no target available" apart from "a
 * target that failed to extract."
 *
 * This is a pure extraction function, not an authentication one: it never
 * validates `threadId`'s shape beyond "present and a non-empty string"
 * (not a UUID-format check, not a length check), since imposing a
 * stricter format than the measured wire evidence actually constrains
 * would be inventing a rule with no evidence behind it. It never falls
 * back to anything else (an env var, a config guess, a correlation
 * heuristic) when a target cannot be extracted - a caller holding
 * anything other than `"resolved"` has definitively not been given a
 * target and must not construct one from another source.
 */
import type { WakeTarget } from "./wakeTransport.js";

export type WakeTargetResolution =
  | { readonly state: "resolved"; readonly target: WakeTarget }
  | { readonly state: "absent" }
  | { readonly state: "malformed"; readonly reason: string };

/**
 * Describes what was found at `meta.threadId` when it is present but not a
 * usable target, for `"malformed"`'s own `reason` string. Each shape gets
 * its own wording rather than one generic message reused for every case,
 * so a caller reading a log actually learns what was wrong instead of
 * just that something was.
 */
function describeMalformedThreadId(value: unknown): string {
  if (value === null) return "is null";
  if (Array.isArray(value)) return "is an array";
  if (typeof value === "string") return "is an empty string";
  return `is type '${typeof value}'`;
}

/**
 * @param meta - the raw `_meta` object of an incoming `tools/call`
 *   request, exactly as the client sent it (unvalidated).
 */
export function resolveWakeTarget(meta: Record<string, unknown> | undefined): WakeTargetResolution {
  if (meta === undefined) {
    return { state: "absent" };
  }

  const threadId = meta.threadId;
  if (threadId === undefined) {
    return { state: "absent" };
  }

  if (typeof threadId === "string" && threadId.length > 0) {
    return { state: "resolved", target: threadId };
  }

  return {
    state: "malformed",
    reason: `threadId present but ${describeMalformedThreadId(threadId)}, expected non-empty string`,
  };
}
