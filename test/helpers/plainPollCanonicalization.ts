/**
 * Shared by test/wake-integration.test.ts (the live byte-identical golden
 * comparison) and scripts/capture-plain-poll-golden.mjs (the deliberate,
 * manually-invoked tool that regenerates test/fixtures/plain-poll-golden.json
 * itself) - moved out of wake-integration.test.ts so both the comparison
 * side and the capture side of that golden run the EXACT SAME
 * canonicalization/extraction code, never two independently hand-rolled
 * copies that could quietly drift apart. Not itself a `*.test.ts` file, so
 * it is never discovered as a suite of its own - mirrors
 * test/helpers/spawnServer.ts's/test/helpers/killScenarios.ts's identical
 * pattern.
 *
 * The two capture paths are still deliberately DIFFERENT at the transport
 * layer (a real spawned build speaking raw JSON-RPC over its real
 * stdin/stdout for the capture script, the SDK `Client` over an
 * `InMemoryTransport` pair for the live comparison test) - see
 * wake-integration.test.ts's own golden-provenance doc comment for why
 * that asymmetry is intentional. What lives here is only the part that
 * MUST be identical on both sides for a byte comparison to mean anything:
 * how a raw tool result gets reduced to the canonical shape that is
 * actually compared.
 */
import assert from "node:assert/strict";

// -----------------------------------------------------------------------
// RACY_IN_PRESENCE_CONFIRMATION_FIELDS / canonicalizePlainPollResponse
// -----------------------------------------------------------------------

// These five fields are real, pre-existing (unchanged by the wake-layer
// story) process-GROUP confirmation fields whose PRESENCE, not just value,
// is a genuine timing race independent of the wake layer entirely -
// kill_confirmed/identity_confirmed depend on whether an async pgrep-based
// reap has settled by the moment a response is read, identity_capture on
// whether the async ps-based birth-identity capture has settled, and
// escalation_refused_reason only ever appears on a SIGKILL-escalation
// identity mismatch. Confirmed directly against src/jobStore.ts's own
// `PublicJobProjection`/`toPublicProjection`: all five are declared OPTIONAL
// and are passed through verbatim from a `JobRecord` field that is itself
// only ever written once its own async, fire-and-forget confirmation
// settles - and JSON serialization drops an unset optional field entirely
// rather than carrying it as `null`. So a real, honest capture can
// legitimately have any of these five present or fully absent depending on
// nothing but timing, independent of any real bug. That is why these five
// are EXCLUDED from the comparison below rather than masked to a stable
// token the way job_id/started_at/ended_at/label are: masking replaces the
// VALUE of a field that is always PRESENT, but forcing one of these five to
// always compare as present (or always absent) would fabricate a
// determinism the real wire protocol does not have - which would silently
// paper over a genuine regression in their presence rather than prove
// anything about it. None of the five is something the wake layer (or
// anything else this canonicalization protects) could plausibly regress
// (already governed by test/kill.test.ts and friends) - excluding them
// keeps the comparison this feeds scoped to the additivity property it
// exists to prove.
//
// `last_wake_attempt` (see src/jobStore.ts's own `JobRecord.
// last_wake_attempt` docs) is the FIFTH, and its race is even wider than
// its four siblings': it depends not only
// on whether `tasksAdapter.ts`'s own `startTransportWakeOnTerminal` fire-
// and-forget `selectAndWake().then()/.catch()` handler has settled by the
// moment a response is read (the same async-settle race the other four
// already have), but ALSO on whether a wake was ever ATTEMPTED at all for
// this specific job - which itself depends on which wake transports are
// eligible in the ambient process environment this test suite happens to
// run under (e.g. whether CLAUDE_CODE_MESSAGING_SOCKET/
// CLAUDE_CODE_MESSAGING_TOKEN are genuinely set on the host, since these
// InMemoryTransport-based scenarios run in-process rather than through
// spawnServer()'s own env-stripping - see test/helpers/spawnServer.ts's own
// header). None of that is a fact about the projection shape this file's
// golden proves additive; it is a fact about this specific host's own
// ambient environment at test-run time.
export const RACY_IN_PRESENCE_CONFIRMATION_FIELDS = new Set([
  "kill_confirmed",
  "identity_confirmed",
  "identity_capture",
  "escalation_refused_reason",
  "last_wake_attempt",
]);

/**
 * Masks volatile fields to the SAME stable placeholder tokens the golden
 * fixture was frozen with, and drops any key whose value is `undefined` -
 * real wire JSON serialization always drops these (which is how the golden
 * was captured), so this keeps the comparison correct regardless of
 * whether a given live call happens to travel over a real byte-serialized
 * transport or an in-process one that can leak an explicitly-undefined key
 * no real client would ever observe. `label` is masked too - it is a
 * caller-supplied literal input (not a server invariant), and every real
 * caller of this function needs a distinct, real label per run (so a
 * scenario's own single-entry isolation still holds when several
 * scenarios share one process) rather than reusing the golden's exact
 * literal string. The four `RACY_IN_PRESENCE_CONFIRMATION_FIELDS` are
 * dropped (never given a placeholder value) - see that constant's own
 * docs for why deletion, not masking, is the honest choice for a field
 * whose real PRESENCE is racy, not just its value.
 *
 * `pid` (status only - see `src/tools/status.ts`'s `StatusProjection`) is
 * a real, per-run OS process id, so it is masked to a stable placeholder
 * the same way `job_id` is - its PRESENCE is deterministic (set
 * synchronously by `run()` before this file's own `runJob` helper ever
 * returns), only its numeric value varies between runs. `birth_identity`
 * (same source file) is masked WHOLE, never recursed into: unlike `pid`
 * its real value can legitimately take one of several different SHAPES
 * depending purely on timing (still `"pending"`, or already `"captured"`
 * with a platform-tagged identity payload whose own fields - a raw
 * kernel tick count on Linux, a captured timestamp/elapsed-seconds pair
 * everywhere else - are themselves real and non-reproducible) - the same
 * underlying async birth-identity capture `identity_capture` already
 * names, just carrying the settled payload alongside the state instead of
 * a bare string. A single flat placeholder collapses every legitimate
 * outcome to one canonical token, exactly like the other masked fields,
 * without needing this function to also special-case `identity_capture`'s
 * PRESENCE-racing treatment for a field whose presence here is not racy.
 */
export function canonicalizePlainPollResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizePlainPollResponse);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (RACY_IN_PRESENCE_CONFIRMATION_FIELDS.has(key)) continue;
      if (key === "job_id") out[key] = "<JOB_ID>";
      else if (key === "started_at" || key === "ended_at") out[key] = "<TIMESTAMP>";
      else if (key === "label") out[key] = "<LABEL>";
      else if (key === "pid") out[key] = "<PID>";
      else if (key === "birth_identity") out[key] = "<BIRTH_IDENTITY>";
      else out[key] = canonicalizePlainPollResponse(v);
    }
    return out;
  }
  return value;
}

// -----------------------------------------------------------------------
// toCanonicalResultPair
// -----------------------------------------------------------------------

/**
 * Extracts BOTH halves of a real `CallToolResult` a golden comparison (or
 * capture) needs: `structuredContent` as-is, and `content`'s own FIRST
 * text block independently re-parsed from its raw JSON string - never
 * assumed equal to `structuredContent` just because that is every handler's
 * current contract. A future regression that lets the two drift (a stale
 * `content` string a handler forgot to update alongside a real
 * `structuredContent` change, say) is exactly what capturing both
 * separately is for.
 *
 * The boundary this does NOT cover, stated explicitly rather than left
 * implied: only the first `content` block's parsed body is compared. The
 * array's own length and ordering, each block's `type`, any additional
 * blocks beyond the first, and every other `CallToolResult` envelope
 * field are outside what this - and therefore any additivity proof built
 * on it - actually establishes.
 *
 * The parameter type is deliberately loose (`content`/`structuredContent`
 * on a bare object) rather than the SDK's own `CallToolResult`: this same
 * function is called against BOTH the SDK `Client`'s decoded result shape
 * AND a raw-wire `tools/call` response's own `result` object read directly
 * off JSON-RPC bytes (see this module's own header doc for why those two
 * transports are deliberately different call sites) - a required `text:
 * string` on the raw-wire shape is structurally assignable to this
 * function's optional `text?: string`, so one implementation serves both
 * without either caller needing its own copy.
 */
export function toCanonicalResultPair(result: {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}): { structuredContent: unknown; content: unknown } {
  const text = result.content?.[0]?.text;
  assert.equal(
    typeof text,
    "string",
    `expected a text content block, got: ${JSON.stringify(result.content)}`
  );
  return {
    structuredContent: result.structuredContent,
    content: JSON.parse(text as string),
  };
}
