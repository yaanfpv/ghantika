/**
 * `tail` - returns a job's most recent output, for polling a still-running
 * command without re-reading everything it has already produced.
 * This file owns only `tail`'s registration/schema/
 * validation/response-shaping logic; it imports nothing from any sibling
 * under `src/tools/` and holds no state of its own (enforced by
 * `scripts/check-module-boundaries.mjs`) - every read routes through the
 * `jobStore` singleton (`src/jobStore.ts`), read-only from this file's
 * perspective.
 *
 * The event-numbering scheme (real per-line `seq`, the single-stream EXACT
 * gap disclosure, and the "both" cross-stream merge policy) is IDENTICAL to
 * `src/tools/output.ts`'s - see that file's header for the full reasoning,
 * including why `jobStore.ts` now exposes a real monotonic `seq`
 * (a later architectural addition that resolved an originally-disclosed
 * limitation from when this file couldn't yet touch `jobStore.ts` directly).
 * The module-boundary guard forbids a
 * `tools/*.ts` file from importing a sibling `tools/*.ts` file, and the
 * frozen module list (also enforced by that guard) forbids adding a new
 * shared helper module - so the scheme is necessarily REIMPLEMENTED here
 * rather than imported, kept deliberately in lockstep with output.ts's
 * version.
 *
 * `tail`'s own addition on top of that shared scheme: it always reads
 * from the retained floor (`after_cursor` is implicitly 0 - there is no
 * cursor argument, by design, since "give me the last N" is a fixed-size
 * window request, not an incremental-since-last-read one) and returns
 * only the LAST `N` real events (a gap marker, when present, is NEVER
 * counted against `N`), showing the gap only when the
 * requested window is large enough to actually reach back to the floor
 * (i.e. `N >= total available real events`) - a window that stops short
 * of the floor is a normal, non-lossy trim, not a disclosure-worthy gap.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

import {
  type ManagedStream,
  type StreamBufferSnapshot,
  type StreamLineTerminator,
  jobStore,
} from "../jobStore.js";

export const name = "tail";

export const description =
  "Get the most recent output a background job has produced, for polling without re-reading everything already seen. Returns the last N real events (a leading {gap:[start,end]} marker, if present, does not count against N) of stdout, stderr, or both (merged, default) - the marker discloses that older history is no longer available under the byte/line retention cap.";

const DEFAULT_TAIL_LINES = 100;

export const inputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {
    job_id: {
      type: "string",
      minLength: 1,
      description: "The job id returned by a prior run call.",
    },
    lines: {
      type: "number",
      description: `How many of the most recent real output events to return (a positive integer). Defaults to ${DEFAULT_TAIL_LINES}. If more than are available, all available events are returned.`,
    },
    stream: {
      type: "string",
      enum: ["stdout", "stderr", "both"],
      description:
        'Which stream to read. Defaults to "both" (merged in a stable, deterministic - but not necessarily true-chronological - global order; see output\'s docs for the exact merge policy).',
    },
  },
  required: ["job_id"],
};

// ---------------------------------------------------------------------------
// Response shapes - identical to output.ts's, duplicated per this file's
// header (no sibling import permitted between tools/*.ts files).
// ---------------------------------------------------------------------------

export interface OutputEvent {
  readonly seq: number;
  readonly stream: ManagedStream;
  readonly text: string;
  readonly partial?: true;
}

export interface GapMarker {
  readonly gap: readonly [number, number];
}

export type OutputItem = OutputEvent | GapMarker;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handler(args: Record<string, unknown> | undefined): CallToolResult {
  if (typeof args?.job_id !== "string" || args.job_id.length === 0) {
    return toolError('tail requires a non-empty string "job_id" argument');
  }
  const jobId = args.job_id;

  const streamResult = validateStream(args.stream);
  if (!streamResult.ok) return toolError(streamResult.message);
  const stream = streamResult.value;

  const linesResult = validateLines(args.lines);
  if (!linesResult.ok) return toolError(linesResult.message);
  const n = linesResult.value;

  if (!jobStore.has(jobId)) {
    return toolError(`tail: unknown job_id "${jobId}"`);
  }

  const view = readStreamView(jobId, stream);
  const reachesFloor = n >= view.events.length;
  const tailEvents = reachesFloor ? view.events : view.events.slice(view.events.length - n);
  const showGap = view.gap !== undefined && reachesFloor;

  const items: OutputItem[] = showGap ? [view.gap!, ...tailEvents] : tailEvents;
  const lastEvent = tailEvents[tailEvents.length - 1];
  const nextCursor =
    lastEvent !== undefined ? lastEvent.seq : view.gap !== undefined ? view.gap.gap[1] : view.head;

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
    message: 'tail\'s "stream" argument, if provided, must be "stdout", "stderr", or "both"',
  };
}

/** N <= 0 is a typed validation error. */
function validateLines(raw: unknown): ValidationResult<number> {
  if (raw === undefined) return { ok: true, value: DEFAULT_TAIL_LINES };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return {
      ok: false,
      message: 'tail\'s "lines" argument, if provided, must be a positive integer',
    };
  }
  return { ok: true, value: raw };
}

// ---------------------------------------------------------------------------
// Snapshot -> event-view construction (pure, stateless - identical scheme
// to output.ts's; see that file's header for the full reasoning)
// ---------------------------------------------------------------------------

interface StreamView {
  readonly events: OutputEvent[];
  readonly gap?: GapMarker;
  readonly head: number;
  readonly truncated: boolean;
}

function readStreamView(jobId: string, stream: StreamSelector): StreamView {
  if (stream === "both") {
    // `jobStore.has(jobId)` was already confirmed true by the caller, so
    // both snapshots are guaranteed defined (createJob/createFailedJob
    // always initialize both stream buffers atomically with job
    // registration - see jobStore.ts).
    const stdoutSnapshot = jobStore.getStreamSnapshot(jobId, "stdout")!;
    const stderrSnapshot = jobStore.getStreamSnapshot(jobId, "stderr")!;
    const { events, gap, head } = buildBothStreamsEvents(stdoutSnapshot, stderrSnapshot);
    return { events, gap, head, truncated: stdoutSnapshot.truncated || stderrSnapshot.truncated };
  }
  const snapshot = jobStore.getStreamSnapshot(jobId, stream)!;
  const { events, gap, head } = buildSingleStreamEvents(stream, snapshot);
  return { events, gap, head, truncated: snapshot.truncated };
}

/** Same partial-terminator rule as output.ts - see that file's docs. */
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
 * Single-stream event view, always read from the floor (`afterCursor`
 * fixed at 0 - `tail` has no cursor argument). Exported for direct unit
 * testing against synthetic `StreamBufferSnapshot` values, mirroring
 * output.ts's own exported helpers.
 */
export function buildSingleStreamEvents(
  stream: ManagedStream,
  snapshot: StreamBufferSnapshot
): { events: OutputEvent[]; gap?: GapMarker; head: number } {
  // Every retained line's `seq` is REAL and stable (see output.ts's own
  // header, which this file's scheme is kept in lockstep with) - `tail`
  // always reads from the floor (afterCursor implicitly 0), so every
  // currently-retained line is a real event, numbered by its own true seq.
  const events = snapshot.lines.map((line) =>
    buildEvent(stream, line.seq, line.text, line.terminator)
  );
  const head = snapshot.totalEverMaterialized;

  if (!snapshot.truncated) {
    return { events, head };
  }

  // EXACT dropped range, same algorithm as output.ts's `computeExactGap`
  // with `afterCursor` fixed at 0 (so `gapStart` is always 1): everything
  // with seq 1 through `oldestSurvivingSeq - 1` is gone forever.
  // `oldestSurvivingSeq` is `undefined` when nothing is currently retained
  // at all, in which case the dropped range runs through
  // `totalEverMaterialized`.
  const oldestSurvivingSeq = snapshot.lines.length > 0 ? snapshot.lines[0]!.seq : undefined;
  const droppedThrough = (oldestSurvivingSeq ?? snapshot.totalEverMaterialized + 1) - 1;
  if (droppedThrough < 1) return { events, head }; // defensive - truncated:true implies this is >= 1
  return { events, gap: { gap: [1, droppedThrough] }, head };
}

/**
 * Merged "both" event view, always read from the floor. Exported for
 * direct unit testing, same rationale as `buildSingleStreamEvents`.
 */
export function buildBothStreamsEvents(
  stdoutSnapshot: StreamBufferSnapshot,
  stderrSnapshot: StreamBufferSnapshot
): { events: OutputEvent[]; gap?: GapMarker; head: number } {
  const stdoutCount = stdoutSnapshot.lines.length;
  const stderrCount = stderrSnapshot.lines.length;
  const anyTruncated = stdoutSnapshot.truncated || stderrSnapshot.truncated;

  if (!anyTruncated) {
    // Same fixed parity split as output.ts: stdout's i-th line -> 2i+1,
    // stderr's i-th line -> 2i+2.
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
    return { events: merged, head };
  }

  const eventsStartSeq = 2;
  const stdoutEvents = stdoutSnapshot.lines.map((line, i) =>
    buildEvent("stdout", eventsStartSeq + 2 * i, line.text, line.terminator)
  );
  const stderrEvents = stderrSnapshot.lines.map((line, i) =>
    buildEvent("stderr", eventsStartSeq + 2 * i + 1, line.text, line.terminator)
  );
  const merged = [...stdoutEvents, ...stderrEvents].sort((a, b) => a.seq - b.seq);
  const lastEvent = merged[merged.length - 1];
  const head = lastEvent !== undefined ? lastEvent.seq : 1;
  return { events: merged, gap: { gap: [1, 1] }, head };
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
