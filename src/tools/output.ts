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
 * ## `seq` is a real, per-job GLOBAL event sequence
 *
 * `jobStore.ts` assigns every materialized line's `seq` from ONE counter
 * shared across a job's stdout AND stderr (see `JobSeqCounter`'s own
 * docs) - never two independent per-stream counters. That single fact is
 * what lets this file treat `seq` as a genuine cross-stream ordering axis
 * everywhere below:
 *
 * - **Single-stream reads (`stream: "stdout"`/`"stderr"`):** every event's
 *   `seq` is that line's own real, stable, globally-unique value - exact
 *   whether or not the stream has ever been truncated, so filtering by
 *   `seq > after_cursor` is correct either way.
 * - **`stream: "both"`:** since stdout and stderr never collide on `seq`
 *   (they share one counter), merging is simply "concatenate both
 *   streams' currently-retained lines and sort by their own real `seq`" -
 *   no synthetic interleave policy needed.
 *
 * ## Bounded drop disclosure, not exact per-seq ranges (v1)
 *
 * A response never claims WHICH specific lines a stream dropped. Instead,
 * once a selected stream has ever evicted any of its own lines (under the
 * byte/line retention cap - see `MAX_BUFFER_LINES`/`MAX_BUFFER_BYTES` in
 * `src/jobStore.ts`), the response discloses a bounded, honest pair for
 * that stream: `dropped` (how many of that stream's own lines have ever
 * been evicted - `StreamBufferSnapshot.droppedCount`) and
 * `droppedBeforeCursor` (that stream's own current retained floor - the
 * lowest `seq` still retained, or its `headSeq` if nothing survives). This
 * never names a seq value, so it can never misattribute a still-live
 * SIBLING stream's own event as this stream's loss - the exact fabrication
 * class every earlier per-seq-range design (a single scalar boundary, then
 * a bounded/coalesced set of exact `[start, end]` runs) kept reintroducing
 * across several review rounds, since a widened/coalesced range is itself
 * a scalar-boundary-shaped claim again. See `jobStore.ts`'s own
 * `StreamBufferSnapshot.droppedCount` docs for the fuller architectural
 * history. Exact per-line gap-range disclosure is deferred to a follow-up
 * story.
 *
 * `stream: "both"` discloses this per stream independently under a nested
 * `dropped` object (`{ stdout?: {...}, stderr?: {...} }`), omitting
 * either side whose own count is 0 and omitting the whole field when
 * neither stream has ever dropped anything - never a single merged count
 * across both streams, which would itself imply one shared boundary
 * across two streams' independent eviction timelines.
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
  'Get a background job\'s accumulated stdout/stderr output, paginated by a monotonic cursor. Pass after_cursor (from a prior call\'s next_cursor) to fetch only new events since your last read. stream selects stdout, stderr, or both (merged in real line-materialization order, default). Once a selected stream has dropped its own old lines under its byte/line cap, the response discloses a bounded "dropped" count for that stream (how many of its own lines were ever dropped) plus "droppedBeforeCursor" (the boundary before which that happened) - never which specific lines were lost. For stream:"stdout"/"stderr" this is a scalar pair at the top level; for stream:"both" it is a nested object keyed by stream ({stdout?:{...}, stderr?:{...}}), since each stream\'s own loss is independent. Three distinct signals, never conflate them: "dropped" means this stream lost lines forever; "truncated" means this specific call\'s own response window (from limit, or from the same lifetime loss) does not contain everything currently available; "next_cursor" is simply where to resume paging - it carries no information about loss on its own.';

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
        'Which stream to read. Defaults to "both" (merged in real line-materialization order - stdout and stderr never collide on seq, so no synthetic interleave is needed).',
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

/** A stream's own bounded drop disclosure - see this file's header. */
export interface StreamDropInfo {
  readonly dropped: number;
  readonly droppedBeforeCursor: number;
}

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

  // `limit` bounds how many events this one response discloses. A follow-up
  // call with `after_cursor: nextCursor` is guaranteed to pick up exactly
  // where this page left off, never skipping or re-showing anything.
  let items: OutputEvent[] = view.events;
  let nextCursor = view.head;
  let limitClamped = false;
  if (limit !== undefined && view.events.length > limit) {
    items = view.events.slice(0, limit);
    nextCursor = items[items.length - 1]!.seq;
    limitClamped = true;
  }

  const body: Record<string, unknown> = { events: items, next_cursor: nextCursor };
  // `truncated` covers BOTH real causes a caller might not have everything:
  // this stream (or, in "both" mode, either stream) has genuinely dropped
  // some of its own history forever (retention eviction - see
  // `view.truncated`), OR this specific call's own `limit` left more
  // already-available events undisclosed this time (`limitClamped`) -
  // never masking one cause with the other.
  if (view.truncated || limitClamped) body.truncated = true;

  applyDropDisclosure(body, stream, view.perStreamDrop);

  return toolSuccess(body);
}

/**
 * Shapes the `dropped`/`droppedBeforeCursor` response fields per this
 * file's header - a top-level scalar pair for a single-stream read, or a
 * nested per-stream object for `stream: "both"` - omitting whatever has
 * never actually dropped anything, on both stream selectors.
 */
function applyDropDisclosure(
  body: Record<string, unknown>,
  stream: StreamSelector,
  perStreamDrop: Partial<Record<ManagedStream, StreamDropInfo>>
): void {
  if (stream === "both") {
    const dropped: Partial<Record<ManagedStream, StreamDropInfo>> = {};
    for (const side of ["stdout", "stderr"] as const) {
      const info = perStreamDrop[side]!;
      if (info.dropped > 0) dropped[side] = info;
    }
    if (Object.keys(dropped).length > 0) body.dropped = dropped;
    return;
  }
  const info = perStreamDrop[stream]!;
  if (info.dropped > 0) {
    body.dropped = info.dropped;
    body.droppedBeforeCursor = info.droppedBeforeCursor;
  }
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
  /** The seq of the newest currently-known event (or, if none exist yet, a value >= any valid after_cursor a caller should resubmit). */
  readonly head: number;
  readonly truncated: boolean;
  /** Per-stream drop disclosure - populated only for the stream(s) actually selected (both entries for "both", one entry for a single-stream read). */
  readonly perStreamDrop: Partial<Record<ManagedStream, StreamDropInfo>>;
}

function readStreamView(jobId: string, stream: StreamSelector, afterCursor: number): StreamView {
  if (stream === "both") {
    // `jobStore.has(jobId)` was already confirmed true by the caller, so
    // both snapshots are guaranteed defined (createJob/createFailedJob
    // always initialize both stream buffers atomically with job
    // registration - see jobStore.ts).
    const stdoutSnapshot = jobStore.getStreamSnapshot(jobId, "stdout")!;
    const stderrSnapshot = jobStore.getStreamSnapshot(jobId, "stderr")!;
    const { events, head, stdoutDrop, stderrDrop } = buildBothStreamsEvents(
      stdoutSnapshot,
      stderrSnapshot,
      afterCursor
    );
    return {
      events,
      head,
      truncated: stdoutSnapshot.truncated || stderrSnapshot.truncated,
      perStreamDrop: { stdout: stdoutDrop, stderr: stderrDrop },
    };
  }
  const snapshot = jobStore.getStreamSnapshot(jobId, stream)!;
  const { events, head, drop } = buildSingleStreamEvents(stream, snapshot, afterCursor);
  return {
    events,
    head,
    truncated: snapshot.truncated,
    perStreamDrop: { [stream]: drop },
  };
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
 * This stream's own bounded drop disclosure (see this file's header):
 * `dropped` is `StreamBufferSnapshot.droppedCount` verbatim (how many of
 * this stream's own lines have ever been evicted); `droppedBeforeCursor`
 * is this stream's own current retained floor - the lowest `seq` still in
 * `lines`, or its `headSeq` when nothing currently survives (nothing
 * retained at all, so "everything up to and including the highest seq
 * this stream ever produced" is the honest floor).
 */
function computeDropInfo(snapshot: StreamBufferSnapshot): StreamDropInfo {
  const droppedBeforeCursor = snapshot.lines.length > 0 ? snapshot.lines[0]!.seq : snapshot.headSeq;
  return { dropped: snapshot.droppedCount, droppedBeforeCursor };
}

/**
 * Single-stream event view - see this file's header. Exported for direct
 * unit testing against synthetic `StreamBufferSnapshot` values (mirroring
 * jobStore.test.ts's own style of testing the buffer layer directly),
 * independent of a real spawned process.
 */
export function buildSingleStreamEvents(
  stream: ManagedStream,
  snapshot: StreamBufferSnapshot,
  afterCursor: number
): { events: OutputEvent[]; head: number; drop: StreamDropInfo } {
  // Every retained line's `seq` is REAL and stable (see this file's own
  // header) - filtering by `seq > afterCursor` is correct whether or not
  // the stream has ever been truncated. `head` is this STREAM's own
  // highest-ever-assigned seq (0 if nothing yet) - exact and
  // eviction-independent (see StreamBufferSnapshot.headSeq's own docs).
  const events = snapshot.lines
    .filter((line) => line.seq > afterCursor)
    .map((line) => buildEvent(stream, line.seq, line.text, line.terminator));
  const head = snapshot.headSeq;
  return { events, head, drop: computeDropInfo(snapshot) };
}

/**
 * Merged "both" event view - see this file's header for the real-seq
 * merge. Exported for direct unit testing, same rationale as
 * `buildSingleStreamEvents`.
 */
export function buildBothStreamsEvents(
  stdoutSnapshot: StreamBufferSnapshot,
  stderrSnapshot: StreamBufferSnapshot,
  afterCursor: number
): { events: OutputEvent[]; head: number; stdoutDrop: StreamDropInfo; stderrDrop: StreamDropInfo } {
  const head = Math.max(stdoutSnapshot.headSeq, stderrSnapshot.headSeq);

  const stdoutEvents = stdoutSnapshot.lines
    .filter((line) => line.seq > afterCursor)
    .map((line) => buildEvent("stdout", line.seq, line.text, line.terminator));
  const stderrEvents = stderrSnapshot.lines
    .filter((line) => line.seq > afterCursor)
    .map((line) => buildEvent("stderr", line.seq, line.text, line.terminator));
  const events = [...stdoutEvents, ...stderrEvents].sort((a, b) => a.seq - b.seq);

  return {
    events,
    head,
    stdoutDrop: computeDropInfo(stdoutSnapshot),
    stderrDrop: computeDropInfo(stderrSnapshot),
  };
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
