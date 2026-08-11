/**
 * Resolves a `WakeTarget` from the raw `_meta` object of an incoming
 * `tools/call` request, without ever fabricating one.
 *
 * This function treats `params._meta.threadId`, when present as a
 * non-empty string, as a thread-identity signal - the meaning this
 * codebase's own wake-target design assigns to that field. It makes no
 * claim about which real MCP client populates the field, how reliably,
 * or whether a given client's value stays stable and distinct across
 * sessions; that is outside what this function, or the tests exercising
 * it, establish. The same `_meta` object may also carry a
 * vendor-specific `x-codex-turn-metadata` block with an id under
 * `.thread_id`; the top-level, spec-shaped `threadId` is read instead of
 * that vendor field, since it is the less vendor-specific of the two.
 *
 * Any handler-visible metadata object lacking `threadId` resolves to the
 * `"absent"` case rather than an error - a fact about this resolver,
 * true regardless of which client sent the request, needing no claim
 * about any particular client's shape.
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
 * (not a UUID-format check, not a length check), since a stricter check
 * would risk rejecting a legitimate value on no stated authority. It
 * never falls back to anything else (an env var, a config guess, a
 * correlation heuristic) when a target cannot be extracted - a caller
 * holding anything other than `"resolved"` has definitively not been
 * given a target and must not construct one from another source.
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
