/**
 * `output` - returns a job's accumulated stdout/stderr output, with
 * cursor-based pagination. This file owns only
 * `output`'s registration/schema/validation/response-shaping logic; it
 * imports nothing from any sibling under `src/tools/` and holds no state
 * of its own (enforced by `scripts/check-module-boundaries.mjs`: no
 * `Map`/`Set`/`WeakMap`/`WeakSet` construction anywhere in this file, no
 * module-scope `let`/`var`) - every read routes through the `jobStore`
 * singleton (`src/jobStore.ts`), read-only from this file's perspective.
 *
 * ## `seq` is real data, not a per-call approximation
 *
 * `jobStore.getStreamSnapshot` returns each line's real, stable
 * `StreamLineEntry.seq` (assigned once, at materialization time, never
 * reused - see that field's own docs in `jobStore.ts`) plus the stream's
 * real `totalEverMaterialized` count. This file consumes that real data
 * directly:
 *
 * - **Single-stream reads (`stream: "stdout"`/`"stderr"`):** every event's
 *   `seq` is the line's own REAL, stable `StreamLineEntry.seq` - exact
 *   whether or not the stream has ever been truncated (no more untruncated-
 *   vs-truncated code-path split; filtering by `seq > after_cursor` is
 *   correct either way, since a real seq never changes once assigned). Once
 *   truncated, the disclosed gap is the EXACT dropped range
 *   `[1, oldestSurvivingSeq - 1]` (see `computeExactGap`), narrowed to
 *   whatever portion of that range is still relevant to THIS caller's own
 *   `after_cursor` (a cursor already past everything ever dropped gets no
 *   gap marker at all, since there is genuinely nothing to disclose to
 *   that caller).
 * - **`stream: "both"`:** see the next section. The real per-line `seq`
 *   this section describes is a per-STREAM value; "both"'s own merged
 *   numbering is a deliberately separate, arbitrary interleave axis
 *   (below), and mixing two streams' independent real seq spaces into one
 *   shared axis with no way to know their true interleave order would be
 *   a fabrication - so "both" keeps its own synthetic parity numbering
 *   and its own best-effort (not exact) gap disclosure.
 *
 * ## Cross-stream ("both") merge order - a disclosed policy, not a truth
 * claim
 *
 * `jobStore` gives no timing signal to correlate stdout/stderr arrival
 * order (`StreamLineEntry` carries no timestamp) - only per-stream append
 * order is preserved. So `stream: "both"` merges the two per-stream
 * sequences via a FIXED, DETERMINISTIC, PREFIX-STABLE parity split:
 * stdout's i-th (0-based) currently-retained line always lands at an ODD
 * merged position, stderr's i-th line always lands at the following EVEN
 * position (see `buildBothStreamsEvents`). This is an explicit ARBITRARY
 * interleave policy (documented as such), never a reconstruction of real
 * chronological order - and it is deliberately prefix-stable (a stream's
 * Nth retained line always maps to the same merged position regardless of
 * how much the OTHER stream grows), so merged numbering doesn't shift
 * around under the caller while both streams are un-truncated. Once either
 * stream has been truncated, "both" still discloses only a single leading
 * width-1 `{gap: [X, X]}` marker (the same best-effort shape single-stream
 * reads use) - a real per-stream exact count exists for EACH stream, but
 * there is no sound way to
 * express "N stdout lines and M stderr lines were dropped, in this unknown
 * relative order" as one exact range in the single shared merged-position
 * axis "both" uses, so this deliberately does not attempt to.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

import {
  type ManagedStream,
  type StreamBufferSnapshot,
  type StreamLineTerminator,
  jobStore,
} from "../jobStore.js";

export const name = "output";

export const description =
  "Get a background job's accumulated stdout/stderr output, paginated by a monotonic cursor. Pass after_cursor (from a prior call's next_cursor) to fetch only new events since your last read. stream selects stdout, stderr, or both (merged, default). Once a stream has dropped old data under its byte/line cap, a leading {gap:[start,end]} marker discloses that some history is no longer available.";

const DEFAULT_LIMIT: number | undefined = undefined;

export const inputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {
    job_id: {
      type: "string",
      minLength: 1,
      description: "The job id returned by a prior run call.",
    },
    stream: {
      type: "string",
      enum: ["stdout", "stderr", "both"],
      description:
        'Which stream to read. Defaults to "both" (merged in a stable, deterministic - but not necessarily true-chronological - global order).',
    },
    after_cursor: {
      type: "number",
      description:
        "Only return events after this cursor (from a prior call's next_cursor). Omit or 0 to read from the earliest still-retained event. Must be a non-negative integer.",
    },
    limit: {
      type: "number",
      description:
        "Cap the number of events returned in this call (a positive integer). Omit for no cap - next_cursor still lets you page through incrementally either way.",
    },
  },
  required: ["job_id"],
};

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface OutputEvent {
  readonly seq: number;
  readonly stream: ManagedStream;
  readonly text: string;
  readonly partial?: true;
}

/** A leading marker disclosing dropped history - see this file's header. */
export interface GapMarker {
  readonly gap: readonly [number, number];
}

export type OutputItem = OutputEvent | GapMarker;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handler(args: Record<string, unknown> | undefined): CallToolResult {
  if (typeof args?.job_id !== "string" || args.job_id.length === 0) {
    return toolError('output requires a non-empty string "job_id" argument');
  }
  const jobId = args.job_id;

  const streamResult = validateStream(args.stream);
  if (!streamResult.ok) return toolError(streamResult.message);
  const stream = streamResult.value;

  const cursorResult = validateAfterCursor(args.after_cursor);
  if (!cursorResult.ok) return toolError(cursorResult.message);
  const afterCursor = cursorResult.value;

  const limitResult = validateLimit(args.limit);
  if (!limitResult.ok) return toolError(limitResult.message);
  const limit = limitResult.value;

  if (!jobStore.has(jobId)) {
    return toolError(`output: unknown job_id "${jobId}"`);
  }

  const view = readStreamView(jobId, stream, afterCursor);

  let events = view.events;
  let nextCursor = view.head;
  if (limit !== undefined && events.length > limit) {
    events = events.slice(0, limit);
    const lastEvent = events[events.length - 1];
    nextCursor = lastEvent !== undefined ? lastEvent.seq : view.gap ? view.gap.gap[1] : view.head;
  }

  const items: OutputItem[] = view.gap ? [view.gap, ...events] : events;
  const body: Record<string, unknown> = { events: items, next_cursor: nextCursor };
  if (view.truncated) body.truncated = true;

  return toolSuccess(body);
}

// ---------------------------------------------------------------------------
// Validation (mirrors src/tools/run.ts's ValidationResult style)
// ---------------------------------------------------------------------------

type ValidationResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

type StreamSelector = ManagedStream | "both";

function validateStream(raw: unknown): ValidationResult<StreamSelector> {
  if (raw === undefined) return { ok: true, value: "both" };
  if (raw === "stdout" || raw === "stderr" || raw === "both") return { ok: true, value: raw };
  return {
    ok: false,
    message: 'output\'s "stream" argument, if provided, must be "stdout", "stderr", or "both"',
  };
}

/** A non-integer or negative after_cursor is a typed validation error. */
function validateAfterCursor(raw: unknown): ValidationResult<number> {
  if (raw === undefined) return { ok: true, value: 0 };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return {
      ok: false,
      message: 'output\'s "after_cursor" argument, if provided, must be a non-negative integer',
    };
  }
  return { ok: true, value: raw };
}

function validateLimit(raw: unknown): ValidationResult<number | undefined> {
  if (raw === undefined) return { ok: true, value: DEFAULT_LIMIT };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return {
      ok: false,
      message: 'output\'s "limit" argument, if provided, must be a positive integer',
    };
  }
  return { ok: true, value: raw };
}

// ---------------------------------------------------------------------------
// Snapshot -> event-view construction (pure, stateless - see this file's
// header for the full reasoning behind this scheme)
// ---------------------------------------------------------------------------

interface StreamView {
  readonly events: OutputEvent[];
  readonly gap?: GapMarker;
  /** The seq of the newest currently-known event (or, if none exist yet, a value >= any valid after_cursor a caller should resubmit). */
  readonly head: number;
  readonly truncated: boolean;
}

function readStreamView(jobId: string, stream: StreamSelector, afterCursor: number): StreamView {
  if (stream === "both") {
    // `jobStore.has(jobId)` was already confirmed true by the caller, so
    // both snapshots are guaranteed defined (createJob/createFailedJob
    // always initialize both stream buffers atomically with job
    // registration - see jobStore.ts).
    const stdoutSnapshot = jobStore.getStreamSnapshot(jobId, "stdout")!;
    const stderrSnapshot = jobStore.getStreamSnapshot(jobId, "stderr")!;
    const { events, gap, head } = buildBothStreamsEvents(
      stdoutSnapshot,
      stderrSnapshot,
      afterCursor
    );
    return { events, gap, head, truncated: stdoutSnapshot.truncated || stderrSnapshot.truncated };
  }
  const snapshot = jobStore.getStreamSnapshot(jobId, stream)!;
  const { events, gap, head } = buildSingleStreamEvents(stream, snapshot, afterCursor);
  return { events, gap, head, truncated: snapshot.truncated };
}

/**
 * `oversized-split` (forced mid-line cut, more bytes for the same logical
 * line still to come) and `stream-end` (the stream closed with no
 * trailing newline) both represent "not a genuinely complete line yet" -
 * a partial final line must always be flagged as such - so both terminators
 * map to `partial: true`. Only `newline` (a real, complete line) omits
 * the flag.
 */
function isPartialTerminator(terminator: StreamLineTerminator): boolean {
  return terminator === "stream-end" || terminator === "oversized-split";
}

function buildEvent(
  stream: ManagedStream,
  seq: number,
  text: string,
  terminator: StreamLineTerminator
): OutputEvent {
  return isPartialTerminator(terminator)
    ? { seq, stream, text, partial: true }
    : { seq, stream, text };
}

/**
 * Single-stream event view - see this file's header for the exact/
 * best-effort split. Exported for direct unit testing against synthetic
 * `StreamBufferSnapshot` values (mirroring jobStore.test.ts's own style of
 * testing the buffer layer directly), independent of a real spawned
 * process.
 */
export function buildSingleStreamEvents(
  stream: ManagedStream,
  snapshot: StreamBufferSnapshot,
  afterCursor: number
): { events: OutputEvent[]; gap?: GapMarker; head: number } {
  // Every retained line's `seq` is REAL and stable (see this file's own
  // header) - filtering by `seq > afterCursor` is correct whether or not
  // the stream has ever been truncated, so there is no more untruncated-
  // vs-truncated code-path split for the EVENTS themselves. `head` is the
  // stream's true newest-ever-materialized seq (0 if nothing yet) -
  // exact and eviction-independent.
  const events = snapshot.lines
    .filter((line) => line.seq > afterCursor)
    .map((line) => buildEvent(stream, line.seq, line.text, line.terminator));
  const head = snapshot.totalEverMaterialized;

  if (!snapshot.truncated) {
    return { events, head };
  }

  // The oldest currently-retained line's real seq anchors the exact
  // dropped range - `undefined` when eviction has cleared every
  // materialized line (evictToFitBudget, in jobStore.ts, can do this), in
  // which case everything up through
  // `totalEverMaterialized` is gone.
  const oldestSurvivingSeq = snapshot.lines.length > 0 ? snapshot.lines[0]!.seq : undefined;
  const gap = computeExactGap(afterCursor, oldestSurvivingSeq, snapshot.totalEverMaterialized);
  return { events, gap, head };
}

/**
 * The exact dropped-range gap for a single stream: everything with `seq` from 1 through
 * `oldestSurvivingSeq - 1` is gone forever (real per-stream `seq` values
 * are assigned strictly sequentially, starting at 1, never reused - see
 * `StreamLineEntry.seq`'s own docs - so eviction always removes the
 * lowest-`seq` entries first, meaning nothing between 1 and the current
 * oldest survivor's seq can still exist). `oldestSurvivingSeq` is
 * `undefined` when nothing is currently retained at all (everything ever
 * materialized has been evicted), in which case the dropped range extends
 * all the way through `totalEverMaterialized`.
 *
 * The result is narrowed to what is still relevant to THIS caller's own
 * `afterCursor`: a cursor already at or past the last-ever-dropped seq
 * gets `undefined` - no gap to disclose, since nothing beyond their
 * cursor was ever lost.
 */
function computeExactGap(
  afterCursor: number,
  oldestSurvivingSeq: number | undefined,
  totalEverMaterialized: number
): GapMarker | undefined {
  const droppedThrough = (oldestSurvivingSeq ?? totalEverMaterialized + 1) - 1;
  if (droppedThrough < 1) return undefined; // nothing has ever been dropped (defensive - truncated:true implies this is >= 1)
  const gapStart = Math.max(afterCursor + 1, 1);
  if (gapStart > droppedThrough) return undefined; // the caller's own cursor is already past everything ever dropped
  return { gap: [gapStart, droppedThrough] };
}

/**
 * Merged "both" event view - see this file's header for the parity-split
 * merge policy and its prefix-stability property. Exported for direct
 * unit testing, same rationale as `buildSingleStreamEvents`.
 */
export function buildBothStreamsEvents(
  stdoutSnapshot: StreamBufferSnapshot,
  stderrSnapshot: StreamBufferSnapshot,
  afterCursor: number
): { events: OutputEvent[]; gap?: GapMarker; head: number } {
  const stdoutCount = stdoutSnapshot.lines.length;
  const stderrCount = stderrSnapshot.lines.length;
  const anyTruncated = stdoutSnapshot.truncated || stderrSnapshot.truncated;

  if (!anyTruncated) {
    // Fixed parity split: stdout's i-th line -> odd position 2i+1,
    // stderr's i-th line -> even position 2i+2. Depends ONLY on each
    // stream's own index, never on the other stream's length - so
    // existing positions never shift as either stream grows
    // (prefix-stable), and natural seq-filtering (`seq > afterCursor`)
    // correctly produces an empty result for a cursor at or beyond head,
    // with no separate "beyond head" special case needed.
    const stdoutEvents = stdoutSnapshot.lines.map((line, i) =>
      buildEvent("stdout", 2 * i + 1, line.text, line.terminator)
    );
    const stderrEvents = stderrSnapshot.lines.map((line, i) =>
      buildEvent("stderr", 2 * i + 2, line.text, line.terminator)
    );
    const merged = [...stdoutEvents, ...stderrEvents].sort((a, b) => a.seq - b.seq);
    const head = Math.max(
      stdoutCount > 0 ? 2 * (stdoutCount - 1) + 1 : 0,
      stderrCount > 0 ? 2 * (stderrCount - 1) + 2 : 0
    );
    return { events: merged.filter((event) => event.seq > afterCursor), head };
  }

  // BEST-EFFORT mode, same shape as the single-stream case: one width-1
  // gap, then the full current window of BOTH streams, parity-merged and
  // renumbered starting right after the gap.
  const gapStart = afterCursor + 1;
  const eventsStartSeq = afterCursor + 2;
  const stdoutEvents = stdoutSnapshot.lines.map((line, i) =>
    buildEvent("stdout", eventsStartSeq + 2 * i, line.text, line.terminator)
  );
  const stderrEvents = stderrSnapshot.lines.map((line, i) =>
    buildEvent("stderr", eventsStartSeq + 2 * i + 1, line.text, line.terminator)
  );
  const merged = [...stdoutEvents, ...stderrEvents].sort((a, b) => a.seq - b.seq);
  const lastEvent = merged[merged.length - 1];
  const head = lastEvent !== undefined ? lastEvent.seq : afterCursor + 1;
  return { events: merged, gap: { gap: [gapStart, gapStart] }, head };
}

// ---------------------------------------------------------------------------

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolSuccess(body: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  };
}
