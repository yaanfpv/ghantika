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
 * The event-numbering scheme (real per-line `seq`, GLOBAL across a job's
 * stdout and stderr, and the "both" real-order merge) is IDENTICAL to
 * `src/tools/output.ts`'s - see that file's header for the full reasoning,
 * including the bounded drop-disclosure contract (`dropped`/
 * `droppedBeforeCursor`, never an exact per-seq range). The module-
 * boundary guard forbids a `tools/*.ts` file from importing a sibling
 * `tools/*.ts` file, and the frozen module list (also enforced by that
 * guard) forbids adding a new shared helper module - so the scheme is
 * necessarily REIMPLEMENTED here rather than imported, kept deliberately
 * in lockstep with output.ts's version.
 *
 * `tail`'s own addition on top of that shared scheme: it always reads
 * from the retained floor (`after_cursor` is implicitly 0 - there is no
 * cursor argument, by design, since "give me the last N" is a fixed-size
 * window request, not an incremental-since-last-read one) and returns
 * only the LAST `N` real events. Unlike a positional gap marker (which the
 * old exact-range design suppressed when a window didn't reach the
 * retained floor, since a mere trim isn't a loss), this file's
 * `dropped`/`droppedBeforeCursor` disclosure is a simple historical fact
 * about the stream (has it EVER suffered a discrete loss event - an
 * evicted line, a discarded pending fragment, or a post-reclaim arrival,
 * not just an evicted line - and where is its current floor) - it is
 * disclosed whenever `dropped > 0`, regardless
 * of whether this particular `lines` window happens to reach that floor.
 *
 * `truncated` covers two distinct causes, neither masking the other: this
 * stream (or, in "both" mode, either stream) has genuinely dropped some of
 * its own history forever (retention eviction), OR this call's own
 * `lines` window was smaller than what's currently available, so more
 * already-retained events exist beyond what this response returned.
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
  'Get the most recent output a background job has produced, for polling without re-reading everything already seen. Returns the last N real events of stdout, stderr, or both (merged in real line-materialization order, default). Once a selected stream has lost some of its own history - either under its own byte/line window cap while the job is still running, or because the job finished and its output later became eligible for job-output retention (see GHANTIKA_JOB_RETENTION_MS/GHANTIKA_MAX_RETAINED_JOBS) - the response discloses a bounded "dropped" count for that stream plus "droppedBeforeCursor" (the lowest seq still retained, or the stream\'s highest-ever-assigned seq - possibly 0 if no line was ever materialized - when nothing survives) - never which specific lines were lost, and never which of the two causes applied. "dropped" is ordinarily a count of complete lines, but it also counts two narrower events the same way: a not-yet-newline-terminated fragment discarded on reclaim, and a chunk arriving for a stream after its job is already reclaimed - neither is a materialized line, but each is real, permanent loss, so both count too rather than leaving the stream falsely indistinguishable from one that never received anything. For stream:"stdout"/"stderr" this is a scalar pair at the top level; for stream:"both" it is a nested object keyed by stream ({stdout?:{...}, stderr?:{...}}), since each stream\'s own loss is independent. Three distinct signals, never conflate them: "dropped" means this stream lost something forever; "truncated" means this specific call\'s own response window (from lines being smaller than what is available, or from that same loss) does not contain everything currently available; "next_cursor" is simply where to resume paging - it carries no information about loss on its own.';

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
        'Which stream to read. Defaults to "both" (merged in real line-materialization order; see output\'s docs for the exact merge scheme).',
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

export interface StreamDropInfo {
  readonly dropped: number;
  readonly droppedBeforeCursor: number;
}

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

  const view = readStreamView(jobId, stream, n);

  const items: OutputEvent[] = view.events;
  const nextCursor = computeNextCursor(view.head);

  const body: Record<string, unknown> = { events: items, next_cursor: nextCursor };
  // `truncated` covers BOTH real causes a caller might not have everything
  // this stream (or, in "both" mode, either stream) has ever produced - see
  // this file's header for the two distinct causes.
  if (view.truncated || view.windowClamped) body.truncated = true;

  applyDropDisclosure(body, stream, view.perStreamDrop);

  return toolSuccess(body);
}

/**
 * `next_cursor` is always this stream selection's own `head` - the true
 * highest `seq` this call's selected stream(s) have EVER produced, never
 * merely the last RETURNED event's own `seq`. `head` is by construction
 * always `>=` every event this call could possibly return (a single
 * stream's own `headSeq` bounds its own lines; "both"'s `head` is the max
 * of the two, and each stream's own retained lines are bounded by its own
 * `headSeq`) - so resubmitting `after_cursor: head` via `output()` can
 * never re-fetch anything this call already disclosed, in EVERY case,
 * including the documented "pending growth evicted even the newest
 * completed line" edge case (where the true head can exceed every
 * currently-retained line's own seq, real events or none at all).
 * Exported for direct unit testing, same rationale as
 * `buildSingleStreamEvents`.
 */
export function computeNextCursor(head: number): number {
  return head;
}

/**
 * Shapes the `dropped`/`droppedBeforeCursor` response fields - identical
 * to `output.ts`'s own `applyDropDisclosure` (duplicated per this file's
 * header), see that function's own docs for the full reasoning.
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
  readonly head: number;
  readonly truncated: boolean;
  /** True when this call's own `lines` window returned fewer events than are currently retained/available - a distinct cause from `truncated`'s retention-eviction meaning (see this file's header). */
  readonly windowClamped: boolean;
  /** Per-stream drop disclosure - populated only for the stream(s) actually selected (both entries for "both", one entry for a single-stream read). */
  readonly perStreamDrop: Partial<Record<ManagedStream, StreamDropInfo>>;
}

function readStreamView(jobId: string, stream: StreamSelector, n: number): StreamView {
  if (stream === "both") {
    // `jobStore.has(jobId)` was already confirmed true by the caller, so
    // both snapshots are guaranteed defined (createJob/createFailedJob
    // always initialize both stream buffers atomically with job
    // registration - see jobStore.ts).
    const stdoutSnapshot = jobStore.getStreamSnapshot(jobId, "stdout")!;
    const stderrSnapshot = jobStore.getStreamSnapshot(jobId, "stderr")!;
    const { events, head, reachesFloor, stdoutDrop, stderrDrop } = buildBothStreamsEvents(
      stdoutSnapshot,
      stderrSnapshot,
      n
    );
    return {
      events,
      head,
      truncated: stdoutSnapshot.truncated || stderrSnapshot.truncated,
      windowClamped: !reachesFloor,
      perStreamDrop: { stdout: stdoutDrop, stderr: stderrDrop },
    };
  }
  const snapshot = jobStore.getStreamSnapshot(jobId, stream)!;
  const { events, head, reachesFloor, drop } = buildSingleStreamEvents(stream, snapshot, n);
  return {
    events,
    head,
    truncated: snapshot.truncated,
    windowClamped: !reachesFloor,
    perStreamDrop: { [stream]: drop },
  };
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

/** Same bounded drop-disclosure derivation as output.ts's `computeDropInfo` - see that file's header. */
function computeDropInfo(snapshot: StreamBufferSnapshot): StreamDropInfo {
  const droppedBeforeCursor = snapshot.lines.length > 0 ? snapshot.lines[0]!.seq : snapshot.headSeq;
  return { dropped: snapshot.droppedCount, droppedBeforeCursor };
}

/**
 * Single-stream event view, always read from the floor and trimmed to the
 * last `n` real events. Exported for direct unit testing against synthetic
 * `StreamBufferSnapshot` values, mirroring output.ts's own exported
 * helpers.
 */
export function buildSingleStreamEvents(
  stream: ManagedStream,
  snapshot: StreamBufferSnapshot,
  n: number
): { events: OutputEvent[]; head: number; reachesFloor: boolean; drop: StreamDropInfo } {
  // Every retained line's `seq` is REAL and stable (see output.ts's own
  // header, which this file's scheme is kept in lockstep with) - `tail`
  // always reads from the floor, so every currently-retained line is a
  // real event, numbered by its own true seq.
  const allEvents = snapshot.lines.map((line) =>
    buildEvent(stream, line.seq, line.text, line.terminator)
  );
  const head = snapshot.headSeq;
  const reachesFloor = n >= allEvents.length;
  const events = reachesFloor ? allEvents : allEvents.slice(allEvents.length - n);
  return { events, head, reachesFloor, drop: computeDropInfo(snapshot) };
}

/**
 * Merged "both" event view, always read from the floor and trimmed to the
 * last `n` real events (merged across both streams). Exported for direct
 * unit testing, same rationale as `buildSingleStreamEvents`.
 */
export function buildBothStreamsEvents(
  stdoutSnapshot: StreamBufferSnapshot,
  stderrSnapshot: StreamBufferSnapshot,
  n: number
): {
  events: OutputEvent[];
  head: number;
  reachesFloor: boolean;
  stdoutDrop: StreamDropInfo;
  stderrDrop: StreamDropInfo;
} {
  const head = Math.max(stdoutSnapshot.headSeq, stderrSnapshot.headSeq);

  const allEvents = [
    ...stdoutSnapshot.lines.map((line) =>
      buildEvent("stdout", line.seq, line.text, line.terminator)
    ),
    ...stderrSnapshot.lines.map((line) =>
      buildEvent("stderr", line.seq, line.text, line.terminator)
    ),
  ].sort((a, b) => a.seq - b.seq);

  const reachesFloor = n >= allEvents.length;
  const events = reachesFloor ? allEvents : allEvents.slice(allEvents.length - n);

  return {
    events,
    head,
    reachesFloor,
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
