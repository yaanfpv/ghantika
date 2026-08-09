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
 * subscribing at all. The actual property a single-threaded event loop
 * guarantees is narrower, and different in kind, from "zero time passes":
 * no OTHER callback - not a timer, not an I/O completion, not some other
 * listener - can run between two synchronous statements with no `await`
 * between them. Real wall-clock time can still pass while those
 * statements themselves execute (ordinary CPU work is never free), but
 * nothing else gets a turn to run in between. So there is no gap for an
 * event to land in UNOBSERVED across that pair: anything that happens
 * after the subscribe call either fires the listener (caught by the
 * subscription, since nothing else could have run first to remove it) or
 * happens before it and is caught by the immediate recheck. Only once
 * BOTH come back false does this handler ever start a timer and actually
 * wait - see `handler`'s own body below for the exact sequence, which
 * mirrors the design one step at a time.
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
 * ## Cancellation tears down every subscription; a process-wide budget
 * bounds how many calls may wait at once
 *
 * `handler`'s second parameter is the calling MCP request's real
 * `AbortSignal` (`src/server.ts`'s `tools/call` dispatch forwards
 * `ctx.mcpReq.signal`, which the installed SDK fires when the client sends
 * `notifications/cancelled` for this exact request). If the request is
 * already cancelled before this handler even starts, nothing is ever
 * subscribed and no admission-budget slot is ever consumed - see
 * `handler`'s own body for exactly where that check runs, and why it runs
 * before the budget check below. Otherwise, once this call is genuinely
 * about to wait, an abort listener is registered alongside the output/
 * terminal subscriptions; firing it unsubscribes both, clears the pending
 * timer, and releases the admission slot immediately, rather than letting
 * the subscriptions and timer run to their own natural bound for a
 * response nobody will ever read (the SDK itself discards whatever a
 * cancelled request's handler returns).
 *
 * Because a subscribed-and-waiting `follow` call is the one thing this
 * server does that is NOT near-instant, this store also enforces a
 * process-wide cap on how many may be outstanding at once
 * (`src/jobStore.ts`'s `MAX_OUTSTANDING_FOLLOWS`/`tryAdmitFollow`/
 * `releaseFollowAdmission`) - a call made once that cap is already reached
 * is REJECTED outright with a tool error, never queued or coalesced with
 * an existing outstanding call on the same job (a waiter-sharing design
 * was considered and is explicitly out of scope for this fix - heavier
 * machinery than the resource-exhaustion problem this closes calls for).
 * The cap is process-wide, not per-connection or per-client - this server
 * tracks no connection/client identity today - so a single misbehaving
 * client can still exhaust it and deny `follow` to every other connection;
 * it can no longer do so silently or without bound, but per-connection
 * fairness stays explicitly out of scope, disclosed here rather than left
 * to be discovered. See `MAX_OUTSTANDING_FOLLOWS`'s own docs for the full
 * rationale and `description` below for the caller-facing contract.
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
  MAX_OUTSTANDING_FOLLOWS,
  toPublicProjection,
} from "../jobStore.js";

export const name = "follow";

export const description =
  'Wait, bounded, for a background job started by run to have something new to report: new output on the selected stream(s), the job reaching a terminal state (exited/killed/failed), or this call\'s own bound elapsing - whichever happens first. A timeout is a normal, non-error result, never a hang: it means nothing happened within the bound, nothing more. status, output, and tail remain the complete way to check a job\'s state and output, whether or not follow is ever called - before this call, after it, or instead of it. cursor, if given, only counts output strictly newer than that seq; omit it to wait for output past whatever already exists on the selected stream(s) at the moment of this call - never for output that already existed before this call started, so a bare call never trivially returns on old backlog. stream picks which stream(s) count toward a return: "stdout", "stderr", or "both" (the default) - this selection scopes the underlying subscription itself, not just what the response later shows, so an arrival on a stream you did not select can never end this call early. Output arrival means a newly materialized line on the selected stream; a buffered fragment without a terminator does not wake the call on its own, but becomes a partial event when the selected stream finalizes; terminal state can still settle the call. timeout_ms bounds how long this one call may wait before returning on its own: omitted, it defaults to 45000ms, a value safe to rely on for any caller; an explicit value above the hard ceiling of 3600000ms (one hour) is silently clamped down to it rather than rejected, since that ceiling only bounds this one call\'s own subscription lifetime and has no other significance. Asking for longer than the default only pays off with a caller whose own setup actually lets one tool call stay outstanding that long - this tool has no way to see that, and claims nothing about it either way. A caller whose own execution context cannot leave a tool call outstanding for the requested duration - a subagent or background-task turn reclaimed or torn down before this call would return - never gets this tool\'s benefit, the same as any other call that context cannot hold open that long; that is simply how a tool call behaves there, not something this tool detects or works around. If the calling request is cancelled before this call would otherwise settle, everything it holds open (its subscriptions and its timer) is torn down immediately rather than left to run to its own natural bound. This server also caps how many follow calls may be outstanding (subscribed and waiting) at once, across every connection it serves, at 128; a call made once that cap is already reached is REJECTED outright with a tool error - never queued, never silently delayed - so a caller hitting it should back off and retry shortly, or use status/output/tail instead. That cap is enforced process-wide, not per connection or per client, since this server tracks no connection/client identity today - one connection exhausting it can still deny follow to every other connection, though never silently or without bound.';

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

export async function handler(
  args: Record<string, unknown> | undefined,
  signal?: AbortSignal
): Promise<CallToolResult> {
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

  // If the calling MCP request was already cancelled before this handler
  // even started running, there is nothing left to do: nothing has been
  // subscribed yet, so nothing needs cleanup, and this call never consumes
  // an admission-budget slot for work it was never going to perform any of
  // - see this file's header doc ("Cancellation tears down every
  // subscription...") and `src/jobStore.ts`'s own `tryAdmitFollow` docs for
  // why this check runs BEFORE the budget gate below, not after. A normal
  // outcome, never an error: the caller already knows it cancelled the
  // call, and the MCP SDK itself never delivers whatever this handler
  // returns for an aborted request anyway (see `src/server.ts`'s
  // `tools/call` dispatch, which checks `abortController.signal.aborted`
  // before sending any response at all) - a plain, cheap, non-error text
  // result is returned here rather than a full `FollowProjection`, since
  // nobody ever reads it either way.
  if (signal?.aborted === true) {
    return toolAlreadyCancelledResult();
  }

  // The admission budget - a process-wide cap on how many `follow` calls
  // may sit outstanding at once (see `src/jobStore.ts`'s own
  // `MAX_OUTSTANDING_FOLLOWS`/`tryAdmitFollow` docs for the full
  // rationale). Checked here, AFTER the already-aborted early return above
  // and BEFORE subscribing anything: a rejected call must never subscribe
  // an output/terminal listener at all. `admitted`/`releaseAdmission`
  // below are this handler's own LOCAL record of whether it actually holds
  // a slot - see `releaseFollowAdmission`'s own docs for why the release
  // side cannot safely infer that on its own.
  if (!jobStore.tryAdmitFollow()) {
    return toolError(
      `follow: the server's outstanding-follow budget (${MAX_OUTSTANDING_FOLLOWS}) is exhausted - retry shortly, or use status/output/tail instead`
    );
  }
  let admitted = true;
  const releaseAdmission = (): void => {
    if (!admitted) return;
    admitted = false;
    jobStore.releaseFollowAdmission();
  };

  // Resolve the effective cursor - the caller's own explicit value, or
  // (when omitted) the CURRENT head seq for the selected stream(s), so a
  // bare `follow(job_id)` waits only for something NEW rather than
  // trivially returning on backlog that already existed. See
  // `currentHeadSeq`'s own docs below for exactly how this is computed -
  // the same inputs `output.ts`'s own head computation reads.
  const effectiveCursor = explicitCursor ?? currentHeadSeq(jobId, stream);

  // Subscribe next, synchronously - see this file's header
  // ("Subscribe-then-check") for why the ordering relative to the
  // IMMEDIATE RECHECK just below is what closes the lost-wakeup race: an
  // initial snapshot read of current state (the cursor resolution above,
  // and `currentHeadSeq`/`isTerminalJobState` in the recheck), THEN
  // subscribe, THEN, with NO `await` between the subscribe calls and the
  // recheck, ask whether either condition is already true. `settle`
  // resolves `settlement` exactly once; every later call to it (from
  // either listener, the timer, or an abort - all started below) is a
  // harmless no-op, per ordinary Promise semantics.
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
    releaseAdmission();
    const reason: FollowReason = alreadyTerminal ? "terminal" : "output";
    return toolSuccess(buildFollowProjection(jobId, stream, effectiveCursor, reason));
  }

  // Otherwise: start a bounded timer and await whichever of the output
  // listener, the terminal listener, this timer, or (once `signal` is
  // provided) an abort of `signal` settles first.
  const timer = setTimeout(() => settle("timeout"), timeoutMs);

  // Register the abort listener only now, once this call is genuinely
  // about to wait - the two early-return paths above (already cancelled
  // before this handler even started; already settled at subscribe time)
  // never reach here, so neither one needs an abort listener registered
  // and then immediately torn down again. `signal` undefined (a caller
  // that does not pass one - a future/test caller, say) simply means this
  // call is never abort-cancellable, the same as before this fix existed.
  // Firing `onAbort` does every bit of cleanup this call owes on its own:
  // unsubscribe both listeners, clear the timer, and release the
  // admission slot - all before `settlement` even resolves.
  let abortedWhileWaiting = false;
  const onAbort = (): void => {
    abortedWhileWaiting = true;
    unsubscribeBoth();
    clearTimeout(timer);
    releaseAdmission();
    settle("timeout"); // the value passed here is never read - see below
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const reason = await settlement;

  if (abortedWhileWaiting) {
    // `onAbort` already performed every bit of cleanup this call owes.
    // Nothing reads `reason` on this path (it is a fixed placeholder, not
    // a real outcome), and nobody reads this response either - the same
    // "the SDK discards a cancelled request's result" fact the
    // already-aborted-at-start branch above documents. A minimal,
    // non-error result closes this call out cleanly regardless.
    return toolAlreadyCancelledResult();
  }

  // The instant one settles via a NON-abort path, unsubscribe BOTH
  // listeners, clear the timer, release the admission slot, and remove
  // the (still-registered - it never fired) abort listener: unconditional
  // cleanup on every remaining path, since nothing should be left
  // subscribed, pending, or holding a slot once this has resolved.
  unsubscribeBoth();
  clearTimeout(timer);
  releaseAdmission();
  signal?.removeEventListener("abort", onAbort);

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

/**
 * The minimal, non-error result returned when this call never actually
 * waited on anything because the calling MCP request was already
 * cancelled before the handler started, or was cancelled while it WAS
 * waiting - see `handler`'s own docs for why a full `FollowProjection` is
 * never built on either path: the MCP SDK itself discards whatever a
 * cancelled request's handler returns (`src/server.ts`'s `tools/call`
 * dispatch), so nothing ever reads this result either way. Deliberately
 * NOT shaped as a `FollowProjection` and carries no `reason` value at all
 * - inventing a new public `reason` enum member for "cancelled" is out of
 * scope for this fix (the contract stays `"output" | "terminal" |
 * "timeout"`, unchanged), and reusing `"timeout"` here would misrepresent
 * what actually happened to anything that DOES inspect this response
 * directly (a direct-handler test not driven through the real SDK
 * dispatch this normally goes through, say).
 */
function toolAlreadyCancelledResult(): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: "follow: the calling request was cancelled - this call never subscribed to the job and holds no admission-budget slot",
      },
    ],
  };
}
