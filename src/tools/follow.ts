/**
 * `follow` - a bounded wait on a job's next event: new output on a
 * selected stream, the job reaching a terminal state, or an explicit
 * timeout, whichever comes first. This is the 7th tool, and the only one
 * of the seven that does not resolve near-instantly: every other tool is
 * a single synchronous (or near-instant) read/write, so a client that
 * wants to know "has anything new happened yet" without a fixed
 * sleep-and-recheck loop has had no way to ask, until this one. This file
 * owns only `follow`'s registration/schema/validation/response-shaping
 * logic; it imports nothing from any sibling under `src/tools/` and holds
 * no state of its own (enforced by `scripts/check-module-boundaries.mjs`:
 * no `Map`/`Set`/`WeakMap`/`WeakSet` construction anywhere in this file,
 * no module-scope `let`/`var`) - every read routes through the `jobStore`
 * singleton (`src/jobStore.ts`), and the two subscribe primitives this
 * tool is built on (`onOutputArrival`/`onJobTerminal`) are that same
 * singleton's own public seams, never a second/derived notification
 * mechanism.
 *
 * ## Subscribe-then-check: what actually closes the lost-wakeup race
 *
 * The one correctness property this whole tool rests on: a client must
 * never miss an event that happens to land in the gap between "read the
 * job's current state" and "start listening for the next change." The
 * real sequence has three synchronous steps, not two: first, an initial
 * snapshot read of the job's current state - the cursor default, when
 * `cursor` is omitted, needs the job's CURRENT head seq to resolve at all
 * (see `currentHeadSeq`'s own docs) - THEN subscribe to both
 * `onOutputArrival` and `onJobTerminal`; THEN, with NO `await` between the
 * subscribe call and this last step, an immediate recheck of whether
 * either condition is ALREADY true against that same current state. The
 * safety property rests on that second pair - subscribe immediately
 * followed by recheck, with no `await` between them - never on the
 * stronger-sounding but false claim that no state was read before
 * subscribing at all. A single-threaded event loop guarantees zero
 * wall-clock time passes between two synchronous statements with no
 * `await` between them, so there is no gap for an event to land in
 * unobserved across that pair: anything that happens after the subscribe
 * call either fires the listener (caught by the subscription) or happens
 * before it and is caught by the immediate recheck. Only once BOTH come
 * back false does this handler ever start a timer and actually wait - see
 * `handler`'s own body below for the exact sequence, which mirrors the
 * design one step at a time.
 *
 * ## The stream filter is on the SUBSCRIPTION, not just the response
 *
 * `stream` narrows which arrivals count as a genuine wake, not merely
 * which events a response later shows: an arrival on a stream the caller
 * did not select must never end this call with `reason: "output"` and an
 * empty `events` array. So the `onOutputArrival` listener itself checks
 * the arriving event's own `stream` against the selection before ever
 * settling - an arrival on an unselected stream is silently ignored by
 * the listener and this call keeps waiting, exactly as if nothing had
 * happened. The terminal listener carries no such filter: any terminal
 * transition ends the wait, regardless of `stream`.
 *
 * ## Built on `toPublicProjection`, additively - the same pattern
 * `status.ts` uses
 *
 * `FollowProjection` below `extends PublicJobProjection` and is built by
 * spreading `toPublicProjection`'s own UNTOUCHED result plus this file's
 * own additive fields (`events`/`next_cursor`/`reason`/`note`) - never by
 * hand-rolling a partial projection. See `src/jobStore.ts`'s own doc
 * comment on `toPublicProjection`: it is "the ONLY function any tool
 * handler may use to shape a `JobRecord` into something returned to an
 * MCP client." Read fresh at the moment of building the response (see
 * `buildFollowProjection` below) - a job's state, and its output, can
 * both have changed during the wait, so nothing captured earlier in the
 * handler (before the subscribe/wait) is ever reused here.
 *
 * ## Deliberately narrower than `output`/`tail`
 *
 * `events`/`next_cursor` below are a small, local reimplementation of
 * `output.ts`'s single/both-stream event-collection scheme (real,
 * per-job-global `seq`, `stdout`/`stderr` merged by real materialization
 * order for `stream: "both"` - see `output.ts`'s own header for the full
 * reasoning this file does not repeat), scoped to ONLY what `follow`
 * needs. It deliberately carries none of `output.ts`'s
 * `dropped`/`droppedBeforeCursor`/`truncated` disclosure machinery -
 * that is `output`'s own job, and a caller who wants that detail calls
 * `output` directly. `follow`'s whole purpose is "tell me something
 * happened," never a second, competing way to read a job's full history.
 * No sibling import is possible here either way (the sibling-import ban
 * in `scripts/check-module-boundaries.mjs` forbids one `tools/*.ts` file
 * from importing another), so this reimplementation is kept deliberately
 * small rather than mirroring `output.ts` in full.
 *
 * ## Never mints a Tasks handle, structurally
 *
 * `src/server.ts`'s `tools/call` dispatch only ever hands a result to
 * `tasksAdapter.maybeAugmentRunResult` when `request.params.name === "run"`
 * - a bare string-literal check naming exactly one tool. `follow` reaches
 * that dispatch site under its own name, never `"run"`, so it structurally
 * cannot mint a Tasks handle without a change to that check itself; this
 * file needs no code of its own to enforce that.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

import {
  type ManagedStream,
  type PublicJobProjection,
  type StreamBufferSnapshot,
  type StreamLineTerminator,
  isTerminalJobState,
  jobStore,
  toPublicProjection,
} from "../jobStore.js";

export const name = "follow";

export const description =
  'Wait, bounded, for a background job started by run to have something new to report: new output on the selected stream(s), the job reaching a terminal state (exited/killed/failed), or this call\'s own bound elapsing - whichever happens first. A timeout is a normal, non-error result, never a hang: it means nothing happened within the bound, nothing more. status, output, and tail remain the complete way to check a job\'s state and output, whether or not follow is ever called - before this call, after it, or instead of it. cursor, if given, only counts output strictly newer than that seq; omit it to wait for output past whatever already exists on the selected stream(s) at the moment of this call - never for output that already existed before this call started, so a bare call never trivially returns on old backlog. stream picks which stream(s) count toward a return: "stdout", "stderr", or "both" (the default) - this selection scopes the underlying subscription itself, not just what the response later shows, so an arrival on a stream you did not select can never end this call early. Output arrival means a newly materialized line on the selected stream; a buffered fragment without a terminator does not wake the call on its own, but becomes a partial event when the selected stream finalizes; terminal state can still settle the call. timeout_ms bounds how long this one call may wait before returning on its own: omitted, it defaults to 45000ms, a value safe to rely on for any caller; an explicit value above the hard ceiling of 3600000ms (one hour) is silently clamped down to it rather than rejected, since that ceiling only bounds this one call\'s own subscription lifetime and has no other significance. Asking for longer than the default only pays off with a caller whose own setup actually lets one tool call stay outstanding that long - this tool has no way to see that, and claims nothing about it either way. A caller whose own execution context cannot leave a tool call outstanding for the requested duration - a subagent or background-task turn reclaimed or torn down before this call would return - never gets this tool\'s benefit, the same as any other call that context cannot hold open that long; that is simply how a tool call behaves there, not something this tool detects or works around.';

export const DEFAULT_TIMEOUT_MS = 45_000;
/** A hard sanity ceiling on `timeout_ms`, bounding a single subscription's own lifetime - see `description` above for why this is silently clamped to, never an error. */
export const MAX_TIMEOUT_MS = 3_600_000; // one hour

export const inputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {
    job_id: {
      type: "string",
      minLength: 1,
      description: "The job id returned by a prior run call.",
    },
    cursor: {
      type: "number",
      description:
        "Only counts output strictly newer than this seq toward a return. Omit to wait for output past whatever is already present on the selected stream(s) at call time (the job's current head seq for the selected stream(s), computed fresh at call time) - never 0, so a bare call never trivially returns on backlog that already existed. Must be a non-negative integer if provided.",
    },
    stream: {
      type: "string",
      enum: ["stdout", "stderr", "both"],
      description:
        'Which stream(s) count toward a return. Defaults to "both". This selection scopes the SUBSCRIPTION itself, not just the response - an arrival on a stream you did not select never ends this call early.',
    },
    timeout_ms: {
      type: "number",
      description: `How long, in milliseconds, this call may wait before returning on its own. Omitted, defaults to ${DEFAULT_TIMEOUT_MS}ms, safe to rely on for any caller. An explicit value above the hard ceiling of ${MAX_TIMEOUT_MS}ms (one hour) is silently clamped down to it rather than rejected. Asking for longer than the default only pays off with a caller whose own setup actually lets one tool call stay outstanding that long - this tool has no way to see that.`,
    },
  },
  required: ["job_id"],
};

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface FollowEvent {
  readonly seq: number;
  readonly stream: ManagedStream;
  readonly text: string;
  readonly partial?: true;
}

/**
 * `status.ts`'s own `StatusProjection` pattern, applied here: extends
 * `PublicJobProjection` and is built by spreading `toPublicProjection`'s
 * untouched result plus these additive fields, entirely local to this
 * file - see this file's own header docs ("Built on toPublicProjection").
 */
export interface FollowProjection extends PublicJobProjection {
  /** New lines since the effective cursor, on the selected stream(s) - see this file's header ("Deliberately narrower than output/tail"). */
  readonly events: FollowEvent[];
  /** Where to resume - the same next_cursor semantics as output.ts's own: the current head seq for the selected stream(s), fresh at response-building time. */
  readonly next_cursor: number;
  readonly reason: "output" | "terminal" | "timeout";
  /** Present ONLY when reason === "timeout" - states plainly that nothing arrived within the bound, and that status/output/tail remain the way to check the job (the same fallback description above states, restated here so a caller reading only this one response still sees it). */
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

type StreamSelector = ManagedStream | "both";
type FollowReason = FollowProjection["reason"];

export async function handler(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  if (typeof args?.job_id !== "string" || args.job_id.length === 0) {
    return toolError('follow requires a non-empty string "job_id" argument');
  }
  const jobId = args.job_id;

  const streamResult = validateStream(args.stream);
  if (!streamResult.ok) return toolError(streamResult.message);
  const stream = streamResult.value;

  const cursorResult = validateCursor(args.cursor);
  if (!cursorResult.ok) return toolError(cursorResult.message);
  const explicitCursor = cursorResult.value;

  const timeoutResult = validateTimeoutMs(args.timeout_ms);
  if (!timeoutResult.ok) return toolError(timeoutResult.message);
  const timeoutMs = timeoutResult.value;

  if (!jobStore.has(jobId)) {
    return toolError(`follow: unknown job_id "${jobId}"`);
  }

  // Resolve the effective cursor - the caller's own explicit value, or
  // (when omitted) the CURRENT head seq for the selected stream(s), so a
  // bare `follow(job_id)` waits only for something NEW rather than
  // trivially returning on backlog that already existed. See
  // `currentHeadSeq`'s own docs below for exactly how this is computed -
  // the same inputs `output.ts`'s own head computation reads.
  const effectiveCursor = explicitCursor ?? currentHeadSeq(jobId, stream);

  // Subscribe FIRST, synchronously, before any other work - see this
  // file's header ("Subscribe-then-check") for why the ordering itself is
  // what closes the lost-wakeup race. `settle` resolves `settlement`
  // exactly once; every later call to it (from either listener, or the
  // timer started below) is a harmless no-op, per ordinary Promise
  // semantics.
  let settle!: (reason: FollowReason) => void;
  const settlement = new Promise<FollowReason>((resolve) => {
    settle = resolve;
  });

  const unsubscribeOutput = jobStore.onOutputArrival(jobId, (event) => {
    // (a) the stream filter - see this file's header. (b) strictly newer
    // than the effective cursor. BOTH must hold for a genuine wake.
    if (stream !== "both" && event.stream !== stream) return;
    if (event.line.seq <= effectiveCursor) return;
    settle("output");
  });
  const unsubscribeTerminal = jobStore.onJobTerminal(jobId, () => {
    settle("terminal");
  });
  const unsubscribeBoth = (): void => {
    unsubscribeOutput();
    unsubscribeTerminal();
  };

  // Then, synchronously, with NO await between the subscribe calls above
  // and this check: is either condition ALREADY true, right now? If
  // BOTH are somehow already true, "terminal" is the more complete
  // signal and wins - see this file's header. No timer is ever started
  // on this path.
  const alreadyTerminal = isTerminalJobState(jobStore.get(jobId)!.state);
  const alreadyHasOutput = currentHeadSeq(jobId, stream) > effectiveCursor;

  if (alreadyTerminal || alreadyHasOutput) {
    unsubscribeBoth();
    const reason: FollowReason = alreadyTerminal ? "terminal" : "output";
    return toolSuccess(buildFollowProjection(jobId, stream, effectiveCursor, reason));
  }

  // Otherwise: start a bounded timer and await whichever of the three
  // (the output listener, the terminal listener, or this timer) settles
  // first.
  //
  // RESOURCE-SAFETY NOTE: if the calling client abandons/cancels the
  // underlying MCP call before it settles, this handler has no way to
  // observe that - there is no cancellation signal wired through the
  // tool-handler contract (`registry.ts`'s `ToolModule.handler` returns a
  // plain `CallToolResult | Promise<CallToolResult>`, nothing more). The
  // subscriptions and this timer still run to their own natural bound and
  // clean up themselves when they do; nothing leaks, it is simply wasted
  // work for a response nobody reads. A known, accepted v1 limitation,
  // not something this story fixes.
  const timer = setTimeout(() => settle("timeout"), timeoutMs);
  const reason = await settlement;
  // The instant one settles, unsubscribe BOTH listeners and clear the
  // timer unconditionally - defensive cleanup on every path, since
  // nothing should be left subscribed or pending once this has resolved
  // (the promise itself only ever resolves once, per the note above).
  unsubscribeBoth();
  clearTimeout(timer);

  return toolSuccess(buildFollowProjection(jobId, stream, effectiveCursor, reason));
}

/**
 * The current head seq for the selected stream(s) - the SAME computation
 * `output.ts`'s own `readStreamView`/`head` logic uses (see that file's
 * header): for a single stream, that stream's own `headSeq`; for "both",
 * `Math.max` of both streams' `headSeq`. Cannot be imported from
 * `output.ts` (the sibling-import ban - see this file's header), so it is
 * a small local function reading only `jobStore.ts`'s public API, exactly
 * the same inputs `output.ts` reads. `jobStore.has(jobId)` is already
 * confirmed true by every caller in this file, so both snapshots below
 * are guaranteed defined (`createJob`/`createFailedJob` always initialize
 * both stream buffers atomically with job registration - see
 * `jobStore.ts`).
 */
function currentHeadSeq(jobId: string, stream: StreamSelector): number {
  if (stream === "both") {
    const stdoutSnapshot = jobStore.getStreamSnapshot(jobId, "stdout")!;
    const stderrSnapshot = jobStore.getStreamSnapshot(jobId, "stderr")!;
    return Math.max(stdoutSnapshot.headSeq, stderrSnapshot.headSeq);
  }
  return jobStore.getStreamSnapshot(jobId, stream)!.headSeq;
}

/**
 * `oversized-split`/`stream-end` both mean "not a genuinely complete line
 * yet" - the identical rule `output.ts`'s own `isPartialTerminator` uses,
 * re-derived locally rather than imported (see this file's header).
 */
function isPartialTerminator(terminator: StreamLineTerminator): boolean {
  return terminator === "stream-end" || terminator === "oversized-split";
}

function buildStreamEvents(
  stream: ManagedStream,
  snapshot: StreamBufferSnapshot,
  afterCursor: number
): FollowEvent[] {
  return snapshot.lines
    .filter((line) => line.seq > afterCursor)
    .map((line) =>
      isPartialTerminator(line.terminator)
        ? { seq: line.seq, stream, text: line.text, partial: true }
        : { seq: line.seq, stream, text: line.text }
    );
}

/**
 * New events since `afterCursor`, on the selected stream(s) - see this
 * file's header ("Deliberately narrower than output/tail"). For "both",
 * both streams' new events are concatenated and sorted by their own real
 * `seq` (stdout and stderr never collide on `seq` - see `output.ts`'s own
 * header for why), the same merge `output.ts`'s `buildBothStreamsEvents`
 * performs.
 */
function collectEvents(jobId: string, stream: StreamSelector, afterCursor: number): FollowEvent[] {
  if (stream === "both") {
    const stdoutSnapshot = jobStore.getStreamSnapshot(jobId, "stdout")!;
    const stderrSnapshot = jobStore.getStreamSnapshot(jobId, "stderr")!;
    const events = [
      ...buildStreamEvents("stdout", stdoutSnapshot, afterCursor),
      ...buildStreamEvents("stderr", stderrSnapshot, afterCursor),
    ];
    return events.sort((a, b) => a.seq - b.seq);
  }
  const snapshot = jobStore.getStreamSnapshot(jobId, stream)!;
  return buildStreamEvents(stream, snapshot, afterCursor);
}

const TIMEOUT_NOTE =
  "Nothing arrived within the bound - this is a normal, non-error result. status, output, and tail remain the way to check this job.";

/**
 * Builds this file's own `FollowProjection` on top of `toPublicProjection`'s
 * unmodified result - see this file's header docs ("Built on
 * toPublicProjection") for why. Reads EVERYTHING fresh, at the moment of
 * building the response: job state may have changed during the wait, so
 * nothing captured earlier in the handler (before the subscribe/wait) is
 * ever reused here.
 */
function buildFollowProjection(
  jobId: string,
  stream: StreamSelector,
  effectiveCursor: number,
  reason: FollowReason
): FollowProjection {
  const base = toPublicProjection(jobStore.get(jobId)!, jobStore.getOutputCounts(jobId));
  const projection: FollowProjection = {
    ...base,
    events: collectEvents(jobId, stream, effectiveCursor),
    next_cursor: currentHeadSeq(jobId, stream),
    reason,
  };
  return reason === "timeout" ? { ...projection, note: TIMEOUT_NOTE } : projection;
}

// ---------------------------------------------------------------------------
// Validation (mirrors src/tools/output.ts's ValidationResult<T> pattern)
// ---------------------------------------------------------------------------

type ValidationResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function validateStream(raw: unknown): ValidationResult<StreamSelector> {
  if (raw === undefined) return { ok: true, value: "both" };
  if (raw === "stdout" || raw === "stderr" || raw === "both") return { ok: true, value: raw };
  return {
    ok: false,
    message: 'follow\'s "stream" argument, if provided, must be "stdout", "stderr", or "both"',
  };
}

/**
 * Unlike `output.ts`'s own `validateAfterCursor`, `undefined` here does
 * NOT resolve to a fixed default (`0`) - it stays `undefined`, so the
 * handler can tell "the caller explicitly asked for everything since seq
 * 0" apart from "the caller omitted cursor entirely" and resolve the
 * latter from the current head instead (see this file's header,
 * `description` above, and the `cursor` field's own schema description).
 */
function validateCursor(raw: unknown): ValidationResult<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return {
      ok: false,
      message: 'follow\'s "cursor" argument, if provided, must be a non-negative integer',
    };
  }
  return { ok: true, value: raw };
}

/**
 * Exported (matching this repo's own established pattern - see
 * `output.ts`'s exported `buildSingleStreamEvents`/`buildBothStreamsEvents`
 * - of exposing a pure function for direct unit testing) so the default
 * value and the clamp ceiling can both be asserted directly, without
 * actually waiting 45 real seconds or a real hour in a test.
 */
export function validateTimeoutMs(raw: unknown): ValidationResult<number> {
  if (raw === undefined) return { ok: true, value: DEFAULT_TIMEOUT_MS };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return {
      ok: false,
      message: 'follow\'s "timeout_ms" argument, if provided, must be a positive integer',
    };
  }
  return { ok: true, value: Math.min(raw, MAX_TIMEOUT_MS) };
}

// ---------------------------------------------------------------------------

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolSuccess(projection: FollowProjection): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(projection, null, 2) }],
    structuredContent: { ...projection },
  };
}
