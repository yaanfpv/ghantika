/**
 * The SOLE owner of ghantika's in-memory job/output state. No handler file under `src/tools/`
 * may hold its own buffer or job-state variable - every read or write of
 * "what jobs exist, what state are they in, what output have they
 * produced" routes through the `jobStore` singleton this module exports.
 * That is a hard module-boundary rule, enforced mechanically by
 * `scripts/check-module-boundaries.mjs` (see its test in
 * `test/module-boundaries.test.ts`), not just documented here.
 *
 * ## Why a module-level singleton rather than an instance threaded through
 * `src/server.ts` -> `src/registry.ts` -> each tool handler
 *
 * Threading a `JobStore` instance through `src/server.ts` -> `registry.ts`
 * -> each tool handler would mean giving `registry.ts`'s `ToolModule`
 * handler signature (and therefore EVERY one of the six tool modules,
 * including the five `run` itself does not touch) a store parameter - a
 * much wider surface than a single shared store needs. Exporting a
 * single module-level instance from this file gets the same property
 * (exactly one instance, and tool handlers are the only code that
 * touches job state through it) with a far smaller surface: a tool
 * handler just imports `jobStore` from here.
 * `status`/`output`/`tail`/`kill` import the same singleton too.
 *
 * ## Frozen shapes
 *
 * `JobRecord` is the INTERNAL shape - never serialized to an MCP client
 * as-is. `PublicJobProjection` (built by `toPublicProjection`) is the ONLY
 * shape any tool handler may return to a client; it deliberately omits
 * `env` and the raw `argv` array (see that function's own docs) and
 * reduces the command down to a redacted `command_summary`.
 *
 * `JobState` is a CLOSED five-value enum - `starting`, `running`,
 * `exited`, `killed`, `failed` - forever. `run` alone only ever produces
 * `starting`/`running`/`exited`/`failed`; `markKilled` (below) is what
 * produces `killed`, without needing to touch this already-closed union.
 */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

// ---------------------------------------------------------------------------
// Frozen shapes
// ---------------------------------------------------------------------------

/** The closed, five-value job lifecycle state enum. Never add a sixth value. */
export type JobState = "starting" | "running" | "exited" | "killed" | "failed";

/**
 * The SAME five values as `JobState`, as a real runtime array - the type
 * union alone is a compile-time-only concept, so this is what makes the
 * "closed enum, exactly five values" guarantee something a test can
 * actually observe and catch a regression in at runtime (introducing a
 * 6th state must make a real test go red). Also used by `isJobState`
 * below.
 */
export const ALL_JOB_STATES: readonly JobState[] = [
  "starting",
  "running",
  "exited",
  "killed",
  "failed",
];

/** Runtime type guard mirroring `ALL_JOB_STATES`. */
export function isJobState(value: unknown): value is JobState {
  return typeof value === "string" && (ALL_JOB_STATES as readonly string[]).includes(value);
}

/** Why a job ended up `failed` (today, always `spawn-error` - see `src/tools/run.ts`). */
export interface JobDiagnostic {
  readonly reason: string;
  readonly message: string;
}

/**
 * The INTERNAL job record (the frozen internal shape), plus one
 * deliberate addition beyond the literal field list: `is_shell`.
 *
 * `is_shell` exists because `command_summary` (see `toPublicProjection`)
 * must NEVER leak a shell command's arguments - only `argv[0]`'s basename
 * for an ordinary (non-shell) job, but the analogous "safe first token" for
 * a shell job whose `argv[0]` is the entire raw shell command line (see
 * `src/tools/run.ts`'s command-validation comments for why `argv` holds the
 * whole shell string as its one element in that case). Recording whether a
 * job is a shell job is the least surprising way to make that projection
 * correct without re-deriving it heuristically from `argv` shape alone.
 * It is intentionally excluded from `PublicJobProjection`.
 */
export interface JobRecord {
  readonly job_id: string;
  readonly argv: readonly string[];
  /** Realpath-resolved at job-creation time. */
  readonly cwd: string;
  /** The fully resolved environment actually passed (or that would have been passed) to the child. */
  readonly env: Readonly<Record<string, string>>;
  state: JobState;
  readonly started_at: string;
  ended_at?: string;
  exit_code?: number;
  signal?: string;
  diagnostic?: JobDiagnostic;
  readonly label?: string;
  queue_position?: number;
  readonly seq: number;
  readonly is_shell: boolean;
}

/**
 * The PUBLIC projection (the frozen public shape) - the only
 * shape `run` (and, later, `status`/`list`) may return to an MCP client.
 * Never includes `env` or the raw `argv` array in any form, and reduces the
 * command down to `command_summary` (see `toPublicProjection`).
 */
/**
 * How much output a job's stdout/stderr streams have produced, TOTAL and
 * EVER (never decremented by the byte/line retention cap's eviction - see
 * `StreamBufferState`'s own docs) - the
 * `PublicJobProjection.counts` field.
 *
 * - `*_lines`: how many stream entries have ever been MATERIALIZED on that
 *   stream (a real newline-terminated line, a forced `oversized-split`
 *   piece, or a final `stream-end` partial - see `StreamLineTerminator`) -
 *   i.e. the stream's own monotonic `StreamLineEntry.seq` counter, which by
 *   construction equals this count (see that field's docs). Survives
 *   eviction: a stream that has produced 20,000 lines and been trimmed down
 *   to the newest 10,000 still reports `20000` here, never the smaller
 *   currently-retained count (`getStreamSnapshot(...).lines.length`), which
 *   answers a different question ("how much can I read right now").
 * - `*_bytes`: total RAW bytes ever received from the child on that stream
 *   (every `appendChunkToBuffer` call's chunk size, summed - see that
 *   function's own docs), counted BEFORE any newline-splitting/CRLF-
 *   stripping/oversized-marker processing, and independent of `*_lines`'
 *   eviction-survival property in the same way.
 */
export interface JobOutputCounts {
  readonly stdout_lines: number;
  readonly stdout_bytes: number;
  readonly stderr_lines: number;
  readonly stderr_bytes: number;
}

/** All-zero counts - `JobStore.getOutputCounts`'s answer for an unknown job id. A single frozen constant rather than a fresh object literal per call, since it is never mutated. */
const ZERO_JOB_OUTPUT_COUNTS: JobOutputCounts = {
  stdout_lines: 0,
  stdout_bytes: 0,
  stderr_lines: 0,
  stderr_bytes: 0,
};

export interface PublicJobProjection {
  readonly job_id: string;
  readonly state: JobState;
  readonly started_at: string;
  readonly ended_at?: string;
  readonly exit_code?: number;
  readonly signal?: string;
  readonly diagnostic?: JobDiagnostic;
  readonly queue_position?: number;
  readonly command_summary: string;
  readonly label: string;
  readonly counts: JobOutputCounts;
}

/**
 * The ONLY function any tool handler may use to shape a `JobRecord` into
 * something returned to an MCP client. Never hand-roll a
 * partial projection elsewhere.
 *
 * - `command_summary` is ONLY `argv[0]`'s basename, never the full argv
 *   array and never any arguments - for a shell job (`is_shell: true`),
 *   `argv[0]` is the entire raw shell command line, so the safe basename is
 *   taken of its REAL command token instead (see `computeCommandSummary`'s
 *   own docs for why that is NOT simply "the first whitespace token"),
 *   never the full string.
 * - `label` falls back to `"job " + job_id` when the caller didn't provide one.
 * - `counts` is supplied by the caller (read fresh from `JobStore`'s own
 *   per-stream buffer state via `JobStore.getOutputCounts` - see that
 *   method's docs) rather than derived here, since this function is a pure
 *   `JobRecord` shaper with no access to the store's separate `buffers`
 *   map.
 */
export function toPublicProjection(
  record: JobRecord,
  counts: JobOutputCounts
): PublicJobProjection {
  return {
    job_id: record.job_id,
    state: record.state,
    started_at: record.started_at,
    ended_at: record.ended_at,
    exit_code: record.exit_code,
    signal: record.signal,
    diagnostic: record.diagnostic,
    queue_position: record.queue_position,
    command_summary: computeCommandSummary(record),
    label: record.label ?? `job ${record.job_id}`,
    counts,
  };
}

/** A leading `NAME=value` shell-assignment token (POSIX allows zero or more of these before the real command word - e.g. `A=1 B=2 /bin/echo hi` still just runs `/bin/echo`). */
const SHELL_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A token wrapped in one matching pair of single or double quotes, captured without the quotes. */
const QUOTED_TOKEN_PATTERN = /^(['"])([\s\S]*)\1$/;
/** Returned when a shell command's tokens are ALL leading assignments (or the command is empty/unparseable) - never falls through to leaking assignment text. */
const FALLBACK_SHELL_SUMMARY = "(shell)";

function stripMatchedQuotes(token: string): string {
  const match = QUOTED_TOKEN_PATTERN.exec(token);
  return match ? match[2]! : token;
}

/** True for a token that is a shell variable assignment, quoted or not - see `safeShellCommandSummary`'s own docs for why quoted tokens are checked too. */
function isShellAssignmentToken(token: string): boolean {
  return SHELL_ASSIGNMENT_PATTERN.test(stripMatchedQuotes(token));
}

/**
 * A naive derivation that takes "the first whitespace-delimited token" of a
 * shell command line unconditionally and basenames it would leak a real
 * redaction bypass: `SUPERSECRET=abc123 /bin/echo hello` (a real, legal
 * POSIX shell command - a LEADING INLINE ENVIRONMENT ASSIGNMENT before the
 * actual command) would produce `command_summary: "SUPERSECRET=abc123"`,
 * since the assignment IS the first token - leaking caller-controlled,
 * potentially secret-looking text straight into the PUBLIC projection.
 *
 * Fix: walk the whitespace-split tokens in order, SKIPPING any that look
 * like a shell assignment (`NAME=value`, POSIX identifier rules), and
 * basename the first token that does NOT. `A=1 B=2 /bin/echo hi` correctly
 * yields `"echo"`. A command that is ENTIRELY assignments (or empty/
 * unparseable) falls back to `FALLBACK_SHELL_SUMMARY` - NEVER any
 * assignment token's own text, whatever the input shape.
 *
 * Quoting: a token like `'SUPERSECRET=abc123'` (the assignment wrapped in
 * matching quotes) is ALSO treated as an assignment to skip, via
 * `isShellAssignmentToken`'s quote-stripping - deliberately conservative
 * rather than attempting a real POSIX-correct parse of when quoting does or
 * doesn't suppress assignment-word treatment (a genuinely ambiguous, shell-
 * dependent question this whitespace-split approximation was never trying
 * to resolve exactly). Treating it as an assignment and skipping it is the
 * SAFE choice in both possible real-shell interpretations: if the shell
 * really would treat it as an assignment, skipping is correct; if the shell
 * would instead try to execute a literally-named `SUPERSECRET=abc123`
 * program (unlikely in practice), skipping still never leaks the secret-
 * shaped text - the alternative (basenaming the quoted token as "the
 * command") would leak it. A recognized command token that happens to be
 * quoted (e.g. `'/bin/echo' hi`) has its quotes stripped before basenaming,
 * so the summary reads `"echo"`, not the literal `"echo'"` a bare
 * `path.basename` on the still-quoted string would produce.
 */
function safeShellCommandSummary(shellCommand: string): string {
  const tokens = shellCommand
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  for (const token of tokens) {
    if (isShellAssignmentToken(token)) continue;
    return path.basename(stripMatchedQuotes(token));
  }
  return FALLBACK_SHELL_SUMMARY;
}

function computeCommandSummary(record: JobRecord): string {
  const argv0 = record.argv[0] ?? "";
  if (!record.is_shell) {
    return path.basename(argv0);
  }
  return safeShellCommandSummary(argv0);
}

// ---------------------------------------------------------------------------
// Byte/line-accounted per-stream output buffers
// ---------------------------------------------------------------------------

/** Caps applied per stream buffer: whichever limit is hit first wins. */
export const MAX_BUFFER_LINES = 10_000;
export const MAX_BUFFER_BYTES = 1_048_576; // 1 MiB
/** The per-line forced-split threshold is the SAME 1 MiB constant, applied to a single not-yet-terminated line. */
export const MAX_LINE_BYTES = MAX_BUFFER_BYTES;

const NEWLINE_BYTE = 0x0a; // '\n'
const CARRIAGE_RETURN_BYTE = 0x0d; // '\r'
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_VALUE = 0x80;
/** UTF-8's longest sequence is 4 bytes, so at most 3 continuation bytes can ever precede a boundary. */
const MAX_UTF8_BACKTRACK = 3;

const OVERSIZED_LINE_MARKER = "…[line exceeds 1 MiB, continues]";

/**
 * Why a `StreamLineEntry` ends where it does:
 * - `newline`: the original stream had a real `\n` (or `\r\n`) here - a
 *   genuinely complete line.
 * - `oversized-split`: forced materialization because an unterminated line
 *   reached the 1 MiB single-line cap before any `\n` appeared; more bytes
 *   for the SAME logical line follow as later entries (themselves possibly
 *   also `oversized-split`), eventually ending in `newline` or, if the
 *   stream ends first, `stream-end`. Carries an explicit textual
 *   continuation marker, so a caller can tell a long line was split
 *   rather than silently dropped or truncated.
 * - `stream-end`: the stream closed with a trailing, never-newline-
 *   terminated line still pending (a genuine "partial final line").
 *   The text is preserved verbatim, unmarked - the
 *   `terminator` value itself is the flag.
 */
export type StreamLineTerminator = "newline" | "oversized-split" | "stream-end";

export interface StreamLineEntry {
  readonly text: string;
  readonly terminator: StreamLineTerminator;
  /**
   * A REAL monotonic per-line sequence number: assigned once, at
   * materialization time, from `StreamBufferState.nextLineSeq`, and NEVER
   * reset or reused for the life of this job's stream - even across
   * eviction. Because it survives eviction, `output.ts`/`tail.ts` can use
   * this STABLE, GLOBALLY-MEANINGFUL value instead of the line's array
   * position (which drifts once eviction starts), and can compute an
   * EXACT dropped-range gap from it (see
   * `StreamBufferState.nextLineSeq`'s own docs).
   */
  readonly seq: number;
}

export interface StreamBufferSnapshot {
  readonly lines: readonly StreamLineEntry[];
  readonly truncated: boolean;
  /**
   * The stream's REAL total-ever-materialized line count at snapshot time
   * (`StreamBufferState.nextLineSeq - 1`). Lets a consumer
   * (`output.ts`/`tail.ts`) compute an EXACT dropped-range gap once
   * truncation starts (`[1, oldestSurvivingSeq - 1]`) and a stable `head`
   * cursor, without depending on array position, which drifts once
   * eviction starts.
   */
  readonly totalEverMaterialized: number;
}

/** Internal, mutable per-stream buffer state. Exported only so tests can drive it directly with synthetic byte sequences. */
export interface StreamBufferState {
  /** Undecoded bytes carried over across `appendChunkToBuffer` calls - may hold a genuinely incomplete line, a partial multi-byte UTF-8 sequence, or both. */
  pending: Buffer;
  lines: StreamLineEntry[];
  /** Bytes of the currently-RETAINED `lines` only (materialized entries still in the array after eviction) - the byte half of the eviction-cap accounting; see `evictToFitBudget`'s docs for why this alone is not the full cap check. */
  totalBytes: number;
  truncated: boolean;
  finalized: boolean;
  /**
   * The NEXT `seq` value to assign - starts at 1, incremented by exactly 1
   * every time a line is materialized (`materializeLine`), NEVER reset or
   * decremented (not even by eviction). Two things fall out of this single
   * counter, by construction:
   *
   * - It IS the source of each new `StreamLineEntry.seq` (assigned, then
   *   incremented).
   * - `nextLineSeq - 1` is exactly "how many lines has this stream EVER
   *   materialized, total" - `JobStore.getOutputCounts`'s `*_lines` field
   *   reads this directly, with no separate counter needed.
   */
  nextLineSeq: number;
  /**
   * Total RAW bytes ever received on this stream from the child, summed
   * across every `appendChunkToBuffer` call by that call's chunk size -
   * BEFORE any newline-splitting/CRLF-stripping/oversized-marker
   * processing, and never decremented by eviction. Deliberately decoupled
   * from the line-materialization machinery (a pure input-side counter),
   * so it stays simple and unambiguous regardless of how a given byte ends
   * up split/merged/marked in `lines`. `JobStore.getOutputCounts`'s
   * `*_bytes` field reads this directly.
   */
  bytesEverReceived: number;
}

export function createStreamBufferState(): StreamBufferState {
  return {
    pending: Buffer.alloc(0),
    lines: [],
    totalBytes: 0,
    truncated: false,
    finalized: false,
    nextLineSeq: 1,
    bytesEverReceived: 0,
  };
}

/**
 * Finds the largest offset `<= maxOffset` in `buffer` that does not fall in
 * the middle of a multi-byte UTF-8 sequence, walking backward over
 * continuation bytes (`10xxxxxx`, i.e. `(byte & 0xC0) === 0x80`). ASCII
 * bytes 0x00-0x7F (which includes `\n`/`\r`) never appear as part of a
 * multi-byte sequence in valid UTF-8, so this is only ever needed at the
 * forced 1 MiB split point, never at a real newline.
 *
 * Bounded to at most `MAX_UTF8_BACKTRACK` steps back (UTF-8's longest
 * sequence is 4 bytes = at most 3 continuation bytes), so this always
 * terminates and never turns a huge buffer scan into an unbounded walk. In
 * the pathological case of genuinely malformed (non-UTF-8) input where that
 * bound is hit without finding a lead byte, the caller falls back to a hard
 * byte cut (`Buffer#toString("utf8")` replaces any resulting broken
 * sequence with U+FFFD rather than throwing, so this never crashes).
 */
export function findUtf8SafeCutPoint(buffer: Buffer, maxOffset: number): number {
  let cut = Math.min(maxOffset, buffer.length);
  let backtrack = 0;
  while (
    cut > 0 &&
    backtrack < MAX_UTF8_BACKTRACK &&
    (buffer[cut]! & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_VALUE
  ) {
    cut -= 1;
    backtrack += 1;
  }
  return cut;
}

function materializeLine(
  state: StreamBufferState,
  text: string,
  terminator: StreamLineTerminator
): void {
  const seq = state.nextLineSeq;
  state.nextLineSeq += 1;
  state.lines.push({ text, terminator, seq });
  state.totalBytes += Buffer.byteLength(text, "utf8");
  // `> 1`, not `> 0`: "retain the newest data" must guarantee the single
  // most-recent entry always survives, even if IT ALONE exceeds the byte
  // cap. This is not just a hypothetical edge case: an `oversized-split`
  // entry's on-disk size is the raw MAX_LINE_BYTES-bounded cut PLUS the
  // continuation marker's own bytes, so it is BY CONSTRUCTION always
  // slightly over MAX_BUFFER_BYTES (the same 1 MiB constant) - without this
  // guard, materializing the very first oversized-split entry would
  // immediately evict itself, silently producing an empty buffer instead
  // of "split with an explicit continuation marker". This
  // check is MATERIALIZED-bytes-only (never `pending`) deliberately - see
  // `evictToFitBudget`'s own docs for the separate, `pending`-aware pass
  // that runs once per `appendChunkToBuffer` call.
  while (
    state.lines.length > 1 &&
    (state.lines.length > MAX_BUFFER_LINES || state.totalBytes > MAX_BUFFER_BYTES)
  ) {
    const removed = state.lines.shift();
    if (!removed) break;
    state.totalBytes -= Buffer.byteLength(removed.text, "utf8");
    state.truncated = true;
  }
}

/**
 * `materializeLine`'s own eviction loop above only ever accounts for
 * `state.totalBytes` (MATERIALIZED lines) - `state.pending` (the
 * not-yet-newline-terminated tail, which can legitimately hold up to just
 * under `MAX_LINE_BYTES` before a forced oversized-split kicks in) is
 * NEVER counted there. A stream holding one 600,000-byte materialized line
 * plus one 600,000-byte pending partial has 1,200,000 bytes genuinely
 * resident, while `state.totalBytes` alone (600,000) stays comfortably
 * under the 1,048,576-byte cap - so eviction would never trigger despite
 * the stream actually holding more than the cap allows.
 *
 * This runs as a SEPARATE pass, once at the end of EVERY
 * `appendChunkToBuffer` call (an "append boundary" - the point right after
 * `state.pending` is finalized for that call, before any caller could next
 * observe state via `getStreamSnapshot` or call `appendChunkToBuffer`
 * again) - never only inside `materializeLine`, since `pending` can grow
 * across MANY calls with no new line ever materializing in between (a
 * second phase of chunks that never contain a newline), and
 * `materializeLine`'s own loop only re-runs when a NEW line completes.
 *
 * The floor differs deliberately from `materializeLine`'s own `length > 1`
 * guard: this pass CAN evict every currently-materialized line, down to
 * zero, when that is what is needed to bring `totalBytes + pending.length`
 * back under the cap - `pending` is not itself a `StreamLineEntry` (never
 * exposed by `getStreamSnapshot`), so clearing materialized lines to make
 * room for a large pending partial never makes previously OBSERVABLE data
 * disappear; a caller polling mid-line simply sees an empty `lines` array,
 * the same as before that partial line ever started. The ONE case this
 * pass still protects, matching `materializeLine`'s own documented
 * exception verbatim ("the single most-recent entry always survives, even
 * if IT ALONE exceeds the byte cap"): when exactly one materialized line
 * remains AND that line's OWN size (ignoring `pending` entirely) already
 * exceeds `MAX_BUFFER_BYTES` on its own (the oversized-split case) - that
 * line is never evicted by this pass, regardless of how large `pending`
 * additionally is, so the two forced-split regression tests in this file's
 * test suite (a lone oversized-split entry surviving its own creation, and
 * surviving a smaller trailing pending remainder afterward) are unaffected.
 *
 * Net effect, proven by this file's tests: at the return of every
 * `appendChunkToBuffer` call, `sum(state.lines bytes) + state.pending.length
 * <= MAX_BUFFER_BYTES`, UNLESS `state.lines.length === 1` and that lone
 * entry's own bytes already exceed the cap (the documented exception).
 */
function evictToFitBudget(state: StreamBufferState): void {
  for (;;) {
    if (state.lines.length === 0) return;
    const overLineCount = state.lines.length > MAX_BUFFER_LINES;
    const overByteCount = state.totalBytes + state.pending.length > MAX_BUFFER_BYTES;
    if (!overLineCount && !overByteCount) return;
    if (state.lines.length === 1 && state.totalBytes > MAX_BUFFER_BYTES) return; // the documented single-entry exception - see this function's own docs
    const removed = state.lines.shift();
    if (!removed) return;
    state.totalBytes -= Buffer.byteLength(removed.text, "utf8");
    state.truncated = true;
  }
}

/**
 * Appends one raw stdout/stderr data chunk to a stream buffer. Works
 * entirely in `Buffer` (byte) space until a segment is ready to
 * materialize, which is what makes this correct for:
 *
 * - CRLF: a `\r` immediately before a `\n` is stripped so Windows-style
 *   line endings never produce a spurious empty trailing line.
 * - UTF-8 split across chunk boundaries: any bytes after the last `\n` in
 *   this chunk (which might end mid-character) are carried over as
 *   `pending` and decoded together with the NEXT chunk's bytes, rather than
 *   being decoded (and potentially mangled/replaced with U+FFFD) in
 *   isolation. Scanning for the raw byte `0x0A` to find line boundaries is
 *   always safe even before that carry-over happens: valid UTF-8 continuation
 *   bytes are always `0x80`-`0xBF`, so `0x0A` can only ever be a literal
 *   newline, never part of a wider character.
 * - Oversized single line: if the not-yet-newline-terminated tail exceeds
 *   `MAX_LINE_BYTES`, it's eagerly cut (at a UTF-8-safe boundary) into an
 *   `oversized-split` entry instead of growing `pending` unboundedly.
 *
 * Also the single input-side hook for `state.bytesEverReceived` (this
 * call's raw `chunk.length`, counted once, up front, before any of the
 * above processing - see that field's own docs) and ends every call with
 * `evictToFitBudget` (see its own docs for why this must run at the end
 * of EVERY call here, not only inside `materializeLine`).
 */
export function appendChunkToBuffer(state: StreamBufferState, chunk: Buffer): void {
  state.bytesEverReceived += chunk.length;
  const working = state.pending.length > 0 ? Buffer.concat([state.pending, chunk]) : chunk;
  state.pending = Buffer.alloc(0);

  // Walks forward from `position`, materializing every complete segment it
  // can: either a real newline-terminated line, OR - critically - a forced
  // `oversized-split` cut BEFORE reaching a newline that's more than
  // `MAX_LINE_BYTES` away (or that never comes at all). A single newline
  // scan alone would happily materialize one arbitrarily large "newline"
  // segment as long as a `\n` eventually shows up anywhere in `working` -
  // the forced-split budget has to be checked on the way to that newline,
  // not only on the leftover tail once no newline is found at all.
  let position = 0;
  for (;;) {
    const remaining = working.length - position;
    if (remaining <= 0) break;

    const newlineIndex = working.indexOf(NEWLINE_BYTE, position);
    const distanceToNewline = newlineIndex === -1 ? Infinity : newlineIndex - position;

    if (distanceToNewline <= MAX_LINE_BYTES) {
      // A real newline exists within the forced-split budget - a genuine line.
      let segmentEnd = newlineIndex;
      if (segmentEnd > position && working[segmentEnd - 1] === CARRIAGE_RETURN_BYTE) {
        segmentEnd -= 1; // strip a CRLF's '\r'
      }
      const segment = working.subarray(position, segmentEnd);
      materializeLine(state, segment.toString("utf8"), "newline");
      position = newlineIndex + 1;
      continue;
    }

    if (remaining > MAX_LINE_BYTES) {
      // No newline within budget (found further away, or none at all) AND
      // more than the budget is already buffered - force a UTF-8-safe cut
      // now rather than growing `pending` unboundedly.
      const cutPoint = findUtf8SafeCutPoint(working.subarray(position), MAX_LINE_BYTES);
      const cut = cutPoint > 0 ? cutPoint : MAX_LINE_BYTES; // pathological-input fallback, see findUtf8SafeCutPoint's docs
      const piece = working.subarray(position, position + cut);
      materializeLine(state, piece.toString("utf8") + OVERSIZED_LINE_MARKER, "oversized-split");
      position += piece.length;
      continue;
    }

    // Under the forced-split budget with no newline yet - genuinely
    // pending, wait for more data.
    break;
  }

  // Copy (never retain a view into `working`/`chunk`) - a caller is free to
  // do whatever it wants with the chunk it handed us once this returns.
  state.pending = Buffer.from(working.subarray(position));

  // `state.pending` is now settled for this call - the real "append
  // boundary" `evictToFitBudget`'s own docs describe. Runs
  // unconditionally (even when nothing was materialized this call), since
  // pending-only growth across many newline-less calls is exactly the gap
  // being closed.
  evictToFitBudget(state);
}

/**
 * Call once a stream has genuinely ended (its `end` event fired). If a
 * never-newline-terminated line is still pending, materializes it as a
 * `stream-end` entry (the "partial final line" requirement) -
 * text preserved exactly, unmarked, flagged only via `terminator`.
 * Idempotent: a second call is a no-op.
 */
export function finalizeStreamBuffer(state: StreamBufferState): void {
  if (state.finalized) return;
  state.finalized = true;
  if (state.pending.length > 0) {
    materializeLine(state, state.pending.toString("utf8"), "stream-end");
    state.pending = Buffer.alloc(0);
  }
}

export function snapshotStreamBuffer(state: StreamBufferState): StreamBufferSnapshot {
  return {
    lines: [...state.lines],
    truncated: state.truncated,
    totalEverMaterialized: state.nextLineSeq - 1,
  };
}

// ---------------------------------------------------------------------------
// JobStore
// ---------------------------------------------------------------------------

export type ManagedStream = "stdout" | "stderr";

interface CreateJobInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly label?: string;
  readonly isShell: boolean;
}

interface CreateFailedJobInput extends CreateJobInput {
  readonly diagnosticMessage: string;
}

/**
 * What `JobStore` tracks about a job's real, live child process, alongside
 * the `ChildProcess` handle itself - the pid and the (approximate) real
 * spawn time, both used by `kill` as the birth-identity
 * marker it checks, via a real external OS lookup, before ever signaling a
 * pid. See `attachChild`'s docs for why `spawnedAtMs` is recorded exactly
 * when it is.
 */
interface TrackedChild {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly spawnedAtMs: number;
}

/**
 * The sole owner of ghantika's job/output state. Tool handlers use the
 * `jobStore` singleton this module exports below - never construct their
 * own `JobStore` (see this file's header for why a singleton rather than a
 * threaded-through instance).
 */
export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly children = new Map<string, TrackedChild>();
  private readonly buffers = new Map<string, Record<ManagedStream, StreamBufferState>>();
  private seqCounter = 0;

  /** True if a job with this id has ever been registered. */
  has(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  /** The record for a tracked job, or `undefined` if no such job exists. */
  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  /** Every currently-tracked job, in insertion order. */
  list(): JobRecord[] {
    return [...this.jobs.values()];
  }

  /** How many jobs are currently tracked. */
  size(): number {
    return this.jobs.size;
  }

  /**
   * Registers a fresh job in `starting` state and initializes its (empty)
   * stdout/stderr buffers. Used for a job that IS about to be (or just was)
   * handed to `process.spawnManaged` - never for a job that's already known
   * to be un-spawnable (use `createFailedJob` for that).
   */
  createJob(input: CreateJobInput): JobRecord {
    const now = new Date().toISOString();
    const record: JobRecord = {
      job_id: randomUUID(),
      argv: input.argv,
      cwd: input.cwd,
      env: input.env,
      state: "starting",
      started_at: now,
      label: input.label,
      seq: this.nextSeq(),
      is_shell: input.isShell,
    };
    this.jobs.set(record.job_id, record);
    this.buffers.set(record.job_id, {
      stdout: createStreamBufferState(),
      stderr: createStreamBufferState(),
    });
    return record;
  }

  /**
   * Registers a job that never actually reached `child_process.spawn` (a
   * validated-bad cwd) or is otherwise already known to be un-spawnable -
   * a failed-to-spawn attempt is still a real job with a
   * real id, it just starts already-terminal. `started_at`/`ended_at` are
   * the same timestamp.
   */
  createFailedJob(input: CreateFailedJobInput): JobRecord {
    const now = new Date().toISOString();
    const record: JobRecord = {
      job_id: randomUUID(),
      argv: input.argv,
      cwd: input.cwd,
      env: input.env,
      state: "failed",
      started_at: now,
      ended_at: now,
      diagnostic: { reason: "spawn-error", message: input.diagnosticMessage },
      label: input.label,
      seq: this.nextSeq(),
      is_shell: input.isShell,
    };
    this.jobs.set(record.job_id, record);
    this.buffers.set(record.job_id, {
      stdout: createStreamBufferState(),
      stderr: createStreamBufferState(),
    });
    return record;
  }

  /**
   * Stores the live `ChildProcess` handle for a job, plus its pid and the
   * (approximate) real spawn time recorded at THIS moment - `Date.now()`
   * here, not the async `spawn` event that fires slightly later, since
   * `run.ts` calls this synchronously, immediately after
   * `process.spawnManaged` returns (itself synchronous - see that
   * function's own docs), so the gap to the real OS-level process creation
   * is at most low single-digit milliseconds - comfortably inside
   * `process.checkProcessIdentity`'s multi-second tolerance. Internal
   * bookkeeping only, never exposed publicly except through
   * `getChildHandle`'s narrow `{pid, spawnedAtMs}` view (never the raw
   * `ChildProcess` itself) - used by `kill`.
   */
  attachChild(jobId: string, child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) return; // defensive: spawnManaged only ever returns a child when it has a real pid - see its own docs
    this.children.set(jobId, { child, pid, spawnedAtMs: Date.now() });
  }

  /**
   * The tracked child's pid and the (approximate) OS-confirmed spawn time
   * recorded when it was attached (see `attachChild`) - the birth-identity
   * marker `kill` checks, via a real external OS lookup,
   * before ever signaling a pid. `undefined` when no child was ever
   * attached (a job that started already-failed never gets one - see
   * `createFailedJob`) or the job id is unknown.
   */
  getChildHandle(
    jobId: string
  ): { readonly pid: number; readonly spawnedAtMs: number } | undefined {
    const tracked = this.children.get(jobId);
    if (!tracked) return undefined;
    return { pid: tracked.pid, spawnedAtMs: tracked.spawnedAtMs };
  }

  /** `starting` -> `running`, once the OS has actually confirmed the process started (the `spawn` event). No-op if the job is already terminal or already running. */
  markRunning(jobId: string): void {
    const record = this.jobs.get(jobId);
    if (!record || record.state !== "starting") return;
    record.state = "running";
  }

  /**
   * `starting`/`running` -> `failed`, for a REAL async OS-level spawn
   * failure that slipped past `run`'s own pre-flight validation (a TOCTOU
   * race, or any failure class that check doesn't anticipate) - see
   * `src/process.ts`'s `spawnManaged`. No-op once the job is already
   * terminal, so a late/duplicate event can never overwrite a real result.
   */
  markSpawnFailed(jobId: string, message: string): void {
    const record = this.jobs.get(jobId);
    if (!record || isTerminalJobState(record.state)) return;
    record.state = "failed";
    record.diagnostic = { reason: "spawn-error", message };
    record.ended_at = new Date().toISOString();
  }

  /** `starting`/`running` -> `exited`. Never `killed` here - that state is reserved exclusively for a real `kill` tool to set. No-op once terminal. */
  markExited(jobId: string, exitCode: number | null, signal: NodeJS.Signals | null): void {
    const record = this.jobs.get(jobId);
    if (!record || isTerminalJobState(record.state)) return;
    record.state = "exited";
    record.exit_code = exitCode ?? undefined;
    record.signal = signal ?? undefined;
    record.ended_at = new Date().toISOString();
  }

  /**
   * `starting`/`running` -> `killed`, from a REAL `kill` completion:
   * a job this codebase itself deliberately terminated, as
   * opposed to one that ended on its own (`markExited`) or never spawned
   * at all (`markSpawnFailed`). `signal` is whichever signal actually
   * finished the job - `"SIGTERM"` if the grace period alone was enough,
   * `"SIGKILL"` after escalation, or the caller's own explicit signal (see
   * `src/tools/kill.ts`). Follows the IDENTICAL terminal-state guard every
   * other `mark*` transition uses (a kill/exit race
   * resolves deterministically, first write wins) - so a job that already
   * finished on its own a moment before `kill` reached it is left exactly
   * as it was, and calling this on an already-terminal job is a safe
   * no-op, never an error.
   */
  markKilled(jobId: string, signal: string): void {
    const record = this.jobs.get(jobId);
    if (!record || isTerminalJobState(record.state)) return;
    record.state = "killed";
    record.signal = signal;
    record.ended_at = new Date().toISOString();
  }

  /**
   * Corrects an ALREADY-`killed` job's recorded `signal` - never a state
   * transition, and a no-op unless the job is already `killed` (never
   * touches an `exited`/`failed` record `markKilled` didn't claim). Exists
   * for exactly one case (the escalation path): `kill`'s handler
   * calls `markKilled(jobId, "SIGTERM")` synchronously, right when it
   * sends the FIRST signal, so it deterministically wins the kill/exit
   * race against that job's own natural `exit` event -
   * but if SIGTERM alone wasn't enough and SIGKILL had to escalate, the
   * signal that ACTUALLY finished the job should read `SIGKILL`, not the
   * optimistic `SIGTERM` recorded before that was known. See
   * `process.killProcessGroupPosix`'s `onSignaled` callback for the other
   * half of this mechanism.
   */
  updateKillSignal(jobId: string, signal: string): void {
    const record = this.jobs.get(jobId);
    if (!record || record.state !== "killed") return;
    record.signal = signal;
  }

  /** Appends one raw data chunk from a job's stdout or stderr to that stream's independent buffer. */
  appendOutput(jobId: string, stream: ManagedStream, chunk: Buffer): void {
    const buffers = this.buffers.get(jobId);
    if (!buffers) return;
    appendChunkToBuffer(buffers[stream], chunk);
  }

  /** Call when a job's stdout or stderr stream has ended, to flush any pending partial final line. */
  finalizeStream(jobId: string, stream: ManagedStream): void {
    const buffers = this.buffers.get(jobId);
    if (!buffers) return;
    finalizeStreamBuffer(buffers[stream]);
  }

  /** A snapshot of a job's stream buffer (lines + truncated flag), or `undefined` if the job/stream isn't tracked. Exposed for `status`/`output`/`tail` and for this module's own tests. */
  getStreamSnapshot(jobId: string, stream: ManagedStream): StreamBufferSnapshot | undefined {
    const buffers = this.buffers.get(jobId);
    if (!buffers) return undefined;
    return snapshotStreamBuffer(buffers[stream]);
  }

  /**
   * How much output a job's stdout/stderr streams have produced, total and
   * ever (the `PublicJobProjection.counts` field - see
   * `JobOutputCounts`'s own docs for exactly what `*_lines`/
   * `*_bytes` measure). Reads the live per-stream `StreamBufferState`
   * counters directly - never a cached/derived value, so it is always
   * fresh. An unknown job id safely returns all-zero counts, matching this
   * store's established "unknown ids are safely ignored" convention (see
   * `appendOutput`/`finalizeStream`/`getStreamSnapshot` above) - every REAL
   * job always has buffers (`createJob`/`createFailedJob` initialize both
   * atomically with job registration), so this only ever fires for a
   * genuinely unknown id.
   */
  getOutputCounts(jobId: string): JobOutputCounts {
    const buffers = this.buffers.get(jobId);
    if (!buffers) return ZERO_JOB_OUTPUT_COUNTS;
    return {
      stdout_lines: buffers.stdout.nextLineSeq - 1,
      stdout_bytes: buffers.stdout.bytesEverReceived,
      stderr_lines: buffers.stderr.nextLineSeq - 1,
      stderr_bytes: buffers.stderr.bytesEverReceived,
    };
  }

  private nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }
}

/**
 * True for any of `JobState`'s three terminal values (`exited`/`killed`/
 * `failed`) - the single source of truth every `mark*` transition's own
 * terminal-state guard uses internally, and that `kill`
 * also uses externally to treat an already-terminal job as a no-op rather
 * than re-signaling a job that's already done.
 */
export function isTerminalJobState(state: JobState): boolean {
  return state === "exited" || state === "killed" || state === "failed";
}

/**
 * The single shared `JobStore` instance - see this file's header for why
 * this is a module-level singleton rather than an instance threaded
 * through `src/server.ts`/`src/registry.ts`.
 */
export const jobStore = new JobStore();
