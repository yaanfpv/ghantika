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
 * handler signature (and therefore EVERY one of the seven tool modules,
 * including the six `run` itself does not touch) a store parameter - a
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

import {
  POSIX_KILL_GRACE_PERIOD_MS,
  killProcessGroupPosix,
  confirmProcessGroupReapedPosix,
} from "./process.js";
import type { ProcessBirthIdentity } from "./process.js";
import {
  type AdmissionDecision,
  type ConcurrencyConfig,
  type RetentionConfig,
  decideAdmission,
  decideRetentionEvictions,
  loadConcurrencyConfigFromEnv,
  loadRetentionConfigFromEnv,
  normalizeConcurrencyConfig,
  normalizeRetentionConfig,
} from "./scheduler.js";

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

/**
 * The closed, three-value set of legal `JobDiagnostic.reason` values - the
 * SAME real-runtime-array pattern `ALL_JOB_STATES`/`isJobState` above use to
 * make a closed union something a test can actually observe, not just a
 * compile-time-only guarantee. See `JobDiagnostic`'s own docs for what each
 * value means and which are actually producible by this codebase's real
 * code paths today.
 */
export const ALL_JOB_DIAGNOSTIC_REASONS = [
  "spawn-error",
  "policy-denied",
  "watcher/runtime-error",
] as const;

export type JobDiagnosticReason = (typeof ALL_JOB_DIAGNOSTIC_REASONS)[number];

/** Runtime type guard mirroring `ALL_JOB_DIAGNOSTIC_REASONS`. */
export function isJobDiagnosticReason(value: unknown): value is JobDiagnosticReason {
  return (
    typeof value === "string" && (ALL_JOB_DIAGNOSTIC_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Why a job ended up `failed`. `reason` is a CLOSED three-value set, never
 * an open string:
 *
 * - `spawn-error`: a cwd/executable pre-flight rejection (`createFailedJob`,
 *   called from `src/tools/run.ts` before ever attempting a real spawn) or
 *   a genuine async OS-level spawn failure (`markSpawnFailed`, called from
 *   `src/process.ts`'s `spawnManaged` `onError` callback).
 * - `policy-denied`: the resolved command (or, with `shell: true`, the
 *   resolved platform shell binary) was rejected by the command allowlist
 *   gate - `createFailedJob`, called from `src/tools/run.ts` with this
 *   reason when `src/policy.ts`'s `decideRunPolicy`/`decideShellPolicy`
 *   returns `allowed: false`, before ever attempting a real spawn. See
 *   `src/policy.ts`'s own docs for how that decision is made.
 * - `watcher/runtime-error`: a background timer watching over a job's own
 *   optional run deadline (`markDeadlineExceeded`, wired from
 *   `src/tools/run.ts` - see that file's own docs) - the command started
 *   fine and ran for a while, then this codebase itself decided it had run
 *   long enough. Distinct from a spawn-time failure, and from the
 *   pre-flight `policy-denied` rejection above.
 *
 * All three values have a real producer; none is reserved-but-unused.
 */
export interface JobDiagnostic {
  readonly reason: JobDiagnosticReason;
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
  /**
   * The last time this record genuinely changed in a way an outside reader
   * could observe - never merely a mirror of `started_at`. Starts equal to
   * `started_at` at creation (see `createJob`/`createFailedJob`), then
   * advances on every real state change this store already tracks: a
   * materialized output line on either stream (see `appendOutput`/
   * `finalizeStream`'s shared `touchLastUpdatedAt` call, run regardless of
   * whether any `onOutputArrival` listener is actually subscribed - a task
   * poller with no active watch must still see an accurate value), and
   * every terminal transition (`markSpawnFailed`/`markDeadlineExceeded`/
   * `markExited`/`markKilled`, stamped with the SAME timestamp as
   * `ended_at` there, never a separately-captured `Date.now()`). Added for
   * `src/tasksAdapter.ts`'s `lastUpdatedAt` field, which the released
   * `io.modelcontextprotocol/tasks` contract requires on every task-shaped
   * response - but this field is deliberately generic, jobStore-owned state
   * like every other field here, not something the adapter computes or
   * caches itself (this store is the sole owner of job/output state - see
   * this file's own header). A job that completes with zero output still
   * genuinely changes state at its terminal transition, so this is never
   * left frozen at creation time for such a job - the terminal-transition
   * write is what keeps that true even when no output-arrival write ever
   * ran.
   */
  last_updated_at: string;
  ended_at?: string;
  exit_code?: number;
  signal?: string;
  diagnostic?: JobDiagnostic;
  readonly label?: string;
  queue_position?: number;
  readonly seq: number;
  readonly is_shell: boolean;
  /**
   * Set only once `state` is TERMINAL (`killed`, `exited`, or `failed` -
   * broadened from an earlier "only `killed`" restriction so a
   * root-exits-first terminal-record reap can disclose its own honest
   * outcome regardless of the leader's own disposition; see
   * `setKillConfirmation`'s own docs), and only for a POSIX kill (Windows
   * has no process-group verification mechanism today - see
   * `killProcessTreeWindows`'s own docs - so this is left `undefined` there
   * rather than claiming a confirmation that was never attempted): whether
   * a bounded, external `pgrep`-based process-group check
   * (`process.confirmProcessGroupReapedPosix`) actually observed zero
   * surviving process-group members after the kill signal(s) completed
   * (`true`), or the bound elapsed without confirming (`false` - an honest
   * "attempted, not confirmed" disclosure, NEVER silently upgraded to
   * `true`). Set via `setKillConfirmation`, which itself only ever WRITES
   * once the record is already terminal - on the DEFAULT path (no caller
   * signal, or `SIGTERM`) that write happens strictly AFTER, and never
   * gates, the synchronous `killed` state transition `markKilled`/
   * `markExited` already performed, so this field only ever refines an
   * already-settled result's honesty there. A caller-supplied signal other
   * than `SIGTERM` is the one exception, and it splits in two: for a
   * signal with no termination guarantee (SIGSTOP is the worked case),
   * THIS check's own result is what decides whether the job becomes
   * terminal at all (see `src/tools/kill.ts`'s explicit-signal branch), so
   * the field is the gate there, not a refinement after one. For a signal
   * that cannot be caught or ignored (an explicit SIGKILL), the job's
   * state can independently reach terminal via its own real exit
   * (`markExited`), unmediated by this check - but this field itself
   * still only ever gets written once this check actually confirms, so it
   * stays absent, never `false`, for as long as it hasn't - regardless of
   * whether the record itself is already terminal by then.
   */
  kill_confirmed?: boolean;
  /**
   * Whether the PRE-signal identity check (`process.evaluatePreSignalIdentityGate`)
   * that ran before a real signal was actually sent to this job's process
   * group came back genuinely CONFIRMED (`true`), or had to proceed via
   * the honest DEGRADED path - no captured birth identity was ever
   * available, or the kill-time observer itself failed - without
   * verifying identity at all (`false`). On the DEFAULT path (no caller
   * signal, or `SIGTERM`), set as soon as this codebase actually attempts
   * to signal the group, since that path's `killed` transition is
   * synchronous and unconditional. A caller-supplied signal other than
   * `SIGTERM` is different: a real signal is still attempted, but this
   * field is only ever recorded once the confirmation check itself
   * actually resolves - for a signal with no termination guarantee
   * (SIGSTOP is the worked case), that is also the only way the job ever
   * reaches a terminal state at all, so a signal genuinely being sent is
   * NOT enough on its own to guarantee this field gets set. For a signal
   * that cannot be caught or ignored (an explicit SIGKILL), the job's
   * state can independently turn terminal via its own real exit before
   * this field is ever written - but the field itself still waits on
   * confirmation regardless, staying absent until it resolves.
   * Never set for a job that was refused (identity-mismatch) or skipped
   * (already gone). Distinct from `kill_confirmed` above, which is a
   * POST-signal process-group confirmation - this is the PRE-signal identity
   * confirmation. POSIX only, matching `kill_confirmed`.
   */
  identity_confirmed?: boolean;
  /**
   * The real-time state of this job's ASYNC, fire-and-forget
   * birth-identity capture (see `process.captureBirthIdentityPosixAsync`) -
   * distinct from `identity_confirmed` above, which is a PRE-SIGNAL check
   * that only ever runs during an actual kill/reap attempt. This field is
   * about whether a birth identity exists to compare against AT ALL, at
   * any moment, whether or not a kill has ever been attempted:
   *
   * - `undefined`: no capture was ever kicked off for this job (a job that
   *   never got a live child attached at all, e.g. `createFailedJob`) or
   *   this is Windows, where capture is never attempted (see
   *   `captureBirthIdentityPosixAsync`'s own docs).
   * - `"pending"`: the capture is in flight, from the instant it starts
   *   (set by `JobStore.attachPendingIdentityCapture`, called synchronously
   *   right alongside kicking off the capture) until it settles.
   * - `"captured"`: the capture settled with a real birth identity.
   * - `"unavailable"`: the capture settled with no identity at all (`ps`
   *   missing, erroring, unparseable output, or the capture's own bounded
   *   timeout was hit).
   *
   * Purely informational/disclosure - `kill`/the shutdown reaper never
   * read THIS field to decide anything; they read the tracked child's own
   * `birthIdentity` (see `TrackedChild`'s own docs), awaiting the
   * underlying capture promise themselves via
   * `JobStore.resolveBirthIdentityForKill` when it's still in flight at
   * the exact moment they need it.
   */
  identity_capture?: "pending" | "captured" | "unavailable";
  /**
   * Present only when the DEFAULT terminating path's escalation identity
   * gate (`process.evaluateEscalationIdentityGate`) actually ran and
   * REFUSED to send SIGKILL - i.e. the group survived the SIGTERM grace
   * period, but no originally-recorded process-group member could be
   * re-confirmed at escalation time (see that function's own docs for the
   * full enumeration of why: a degraded pre-SIGTERM snapshot, a timed-out
   * or failed re-read, every recorded member gone, or every present one
   * reporting a different start time). A short, honest description of
   * which cell fired - never a claim that the process group is confirmed
   * gone (it may still be alive; this codebase simply never sent it a
   * second signal), and never a claim that the earlier SIGTERM was
   * "confirmed" or "guarded" when identity could not be verified at
   * either the pre-signal (`identity_confirmed`) or this pre-SIGTERM-
   * snapshot layer - see `src/tools/kill.ts`'s own docs for that combined
   * cell. Absent whenever escalation was never reached at all (the group
   * died within grace, or was already gone) or when escalation proceeded.
   */
  escalation_refused_reason?: string;
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
 *   i.e. the stream's own `StreamBufferState.linesEverMaterialized` pure
 *   per-stream COUNT (a genuinely SEPARATE number from `StreamLineEntry.seq`
 *   now that `seq` is a per-JOB GLOBAL value shared across stdout and
 *   stderr - see that field's own docs for why the two diverge). Survives
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
  /** See `JobRecord.kill_confirmed`'s own docs - the same value, passed through verbatim. */
  readonly kill_confirmed?: boolean;
  /** See `JobRecord.identity_confirmed`'s own docs - the same value, passed through verbatim. */
  readonly identity_confirmed?: boolean;
  /** See `JobRecord.identity_capture`'s own docs - the same value, passed through verbatim. */
  readonly identity_capture?: "pending" | "captured" | "unavailable";
  /** See `JobRecord.escalation_refused_reason`'s own docs - the same value, passed through verbatim. */
  readonly escalation_refused_reason?: string;
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
    kill_confirmed: record.kill_confirmed,
    identity_confirmed: record.identity_confirmed,
    identity_capture: record.identity_capture,
    escalation_refused_reason: record.escalation_refused_reason,
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

/** How often `startRetentionSweeper`'s real timer re-checks retention - see that method's own docs for what this bounds. Independent of any configured `retentionMs`: a fixed, small interval regardless of how long or short retention itself is configured to be. */
export const RETENTION_SWEEP_INTERVAL_MS = 30_000;

const NEWLINE_BYTE = 0x0a; // '\n'
const CARRIAGE_RETURN_BYTE = 0x0d; // '\r'
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_VALUE = 0x80;
/** UTF-8's longest sequence is 4 bytes, so at most 3 continuation bytes can ever precede a boundary. */
const MAX_UTF8_BACKTRACK = 3;

const OVERSIZED_LINE_MARKER = "…[line exceeds 1 MiB, continues]";

/**
 * A tiny mutable counter, shared BY REFERENCE between a single job's
 * stdout and stderr `StreamBufferState`s (see `JobStore.createJob`/
 * `createFailedJob`) so that `materializeLine` on EITHER stream draws its
 * `seq` from the SAME source. This is what makes `StreamLineEntry.seq` a
 * REAL per-JOB GLOBAL event sequence - one monotonic axis spanning both
 * streams, ordered by real materialization time - rather than two
 * independent per-stream counters that could each assign the same number
 * to an unrelated stdout and stderr line. `createStreamBufferState`
 * defaults to a fresh PRIVATE counter when none is supplied, so this file's
 * own standalone buffer-layer tests (which drive a lone `StreamBufferState`
 * with no sibling stream at all) keep their existing single-stream
 * seq-starts-at-1 behavior unchanged.
 */
export interface JobSeqCounter {
  next(): number;
}

/** Starts at 1 (matching the old per-stream `nextLineSeq`'s starting value) - never reset or reused. */
export function createJobSeqCounter(): JobSeqCounter {
  let nextValue = 1;
  return {
    next(): number {
      const value = nextValue;
      nextValue += 1;
      return value;
    },
  };
}

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
   * A REAL monotonic sequence number, GLOBAL across this JOB's stdout and
   * stderr COMBINED (never just this one stream) - assigned once, at
   * materialization time, from the job's shared `JobSeqCounter` (see its
   * own docs), and NEVER reset or reused for the life of this job, even
   * across eviction. Because stdout and stderr draw from the SAME counter,
   * a stdout line and a stderr line can never collide on the same `seq`
   * value, and sorting any mix of the two streams' lines by `seq` alone
   * always recovers their real, true materialization order - no synthetic
   * interleave policy (odd/even parity or similar) is needed to merge them,
   * and `output.ts`/`tail.ts`'s "both" mode uses exactly this real ordering
   * (see those files' own headers).
   *
   * (Earlier architectural history: this field used to be assigned from a
   * PER-STREAM-only counter, and before that didn't exist at all -
   * `output.ts`/`tail.ts` had to approximate `seq` as the line's array
   * INDEX, exact only until the first eviction, and disclose only a
   * deliberately-narrow `{gap: [X, X]}` placeholder. A real, persistent,
   * now-GLOBAL `seq` removes both limitations at once.)
   */
  readonly seq: number;
}

export interface StreamBufferSnapshot {
  readonly lines: readonly StreamLineEntry[];
  readonly truncated: boolean;
  /**
   * The highest `seq` EVER assigned to a line on THIS stream specifically,
   * persisting through eviction (0 if this stream has never materialized a
   * line) - a consumer's per-stream `head`/next-cursor value for a
   * single-stream (`stdout`-only or `stderr`-only) read. Because `seq` is
   * now a per-JOB GLOBAL value (see `StreamLineEntry.seq`'s own docs), this
   * is no longer the same number as "how many lines has this stream
   * materialized" (a stream's own line COUNT and the highest GLOBAL seq
   * value one of its lines happened to receive are now two genuinely
   * different numbers, since the other stream's own activity advances the
   * shared counter too) - see `JobStore.getOutputCounts`'s own docs for the
   * separate, pure per-stream COUNT that answers that different question.
   */
  readonly headSeq: number;
  /**
   * How many discrete loss events THIS stream has EVER suffered, over its
   * whole life - a pure per-stream COUNT, never a claim about WHICH `seq`
   * values were lost (see `JobStore`'s own file-header note on why v1
   * deliberately stops at a bounded count rather than exact per-seq
   * disclosure). 0 if this stream has never lost anything. Ordinarily one
   * event equals one materialized line, but see the writer list below for
   * the two narrower cases where a single event does not correspond to a
   * complete line at all.
   *
   * (Architectural history: an earlier revision of this fix tracked the
   * exact SET of this stream's own evicted `seq` values, as the fewest
   * possible disjoint `[start, end]` runs, specifically to avoid a single
   * scalar boundary expanding into a contiguous range that could wrongly
   * claim a still-alive SIBLING stream's `seq` as this stream's own loss -
   * a real bug once `seq` became a per-job GLOBAL value shared across
   * stdout/stderr, since this stream's own evicted set can itself be
   * non-contiguous whenever the sibling owns one of the intervening
   * values. An exact per-seq range representation is unbounded because
   * stdout and stderr share one sequence counter, so a stream's own
   * retained-line seqs can interleave with the sibling's, and any bounded
   * collapse of that range representation (a hard cap, a response-side cap)
   * reintroduces the same fabrication risk, since a widened/coalesced range
   * is itself a scalar-boundary-shaped claim again. Scrapped in favor of
   * this much simpler, deliberately WEAKER contract: a count and a
   * boundary, never a value. A count can never misname a seq, because it
   * never names one at all - see `droppedBeforeCursor`'s own computation in
   * `src/tools/output.ts`/`src/tools/tail.ts` for the paired boundary.)
   *
   * Incremented by THREE writers, never reset or decremented:
   * `evictOldestLine` bumps it by exactly 1 every time it removes one of
   * this stream's own lines (ordinary byte/line-cap eviction, one line at
   * a time); `evictAllLines` bumps it by however many lines it drains in
   * one bulk step, PLUS one further event when a pending fragment - never
   * materialized into a line at all - is discarded alongside them (both
   * job-output retention's own reclaim, see that function's own docs); and
   * `appendOutput` bumps it by 1 for a chunk arriving after this stream's
   * job is already reclaimed, which can never become a line either. The
   * first writer's unit is exactly "materialized lines"; the other two
   * widen that to "discrete loss events" specifically so this field can
   * express sub-line loss without ever pairing `truncated:true` with
   * `droppedCount:0` (see `evictAllLines`'s own docs for why that pairing
   * is reserved for response pagination and never used for genuine loss).
   * Matches this file's other `*EverMaterialized`/`*EverReceived`
   * per-stream counters in shape (a single unbounded NUMBER, cheap
   * regardless of a job's lifetime, unlike the abandoned per-seq-range
   * design's array).
   */
  readonly droppedCount: number;
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
   * The source of each new `StreamLineEntry.seq` (`materializeLine` calls
   * `.next()`, once per materialized line) - shared BY REFERENCE with the
   * sibling stream of the SAME job (see `JobSeqCounter`'s own docs), which
   * is what makes `seq` a real per-job GLOBAL value rather than a
   * per-stream-only one. `createStreamBufferState` defaults to a fresh
   * PRIVATE counter when none is supplied, so a standalone
   * `StreamBufferState` (this file's own buffer-layer tests) still behaves
   * exactly as a lone per-stream counter would.
   */
  seqCounter: JobSeqCounter;
  /**
   * How many lines THIS stream specifically has EVER materialized, total -
   * a pure per-stream COUNT, incremented by exactly 1 every time THIS
   * stream materializes a line (`materializeLine`), NEVER reset or
   * decremented (not even by eviction). Deliberately a SEPARATE counter
   * from `seqCounter` now that `seq` is shared/global: this stream's own
   * line count and the highest `seq` value one of its lines happened to
   * receive are two different numbers once a sibling stream's activity can
   * also advance the shared counter (see `StreamLineEntry.seq`'s own
   * docs). `JobStore.getOutputCounts`'s `*_lines` field reads this
   * directly.
   */
  linesEverMaterialized: number;
  /**
   * The highest `seq` EVER assigned to a line on THIS stream, persisting
   * through eviction (0 if this stream has never materialized a line) -
   * the source of `StreamBufferSnapshot.headSeq` (see its own docs).
   */
  highestSeqAssigned: number;
  /**
   * How many discrete loss events THIS stream has EVER suffered, over its
   * whole life - the source of `StreamBufferSnapshot.droppedCount` (see its
   * own docs for why a bounded count, never a per-seq range, is what v1
   * discloses, and for the full writer list: `evictOldestLine` and
   * `evictAllLines`'s line-based bumps, plus `evictAllLines`'s
   * pending-fragment case and `appendOutput`'s post-reclaim-arrival case,
   * neither of which corresponds to a materialized line). Never reset or
   * decremented. Matches this struct's other
   * `*EverMaterialized`/`*EverReceived` counters in shape: a single
   * unbounded NUMBER, cheap regardless of a job's lifetime.
   */
  droppedCount: number;
  /**
   * Total RAW bytes ever received on this stream from the child, summed
   * across every `appendChunkToBuffer` call by that call's chunk size -
   * BEFORE any newline-splitting/CRLF-stripping/oversized-marker
   * processing, and never decremented by eviction. Deliberately decoupled
   * from the line-materialization machinery (a pure input-side counter),
   * so it stays simple and unambiguous regardless of how a given byte ends
   * up split/merged/marked in `lines`. `JobStore.getOutputCounts`'s
   * `*_bytes` field reads this directly.
   *
   * A SECOND consumer as of job-output retention: `sweepRetention`'s
   * holds-output filter tests `bytesEverReceived > 0` (see that method's
   * own docs), so "never decremented" is also what makes a job that has
   * ever received a byte pass that filter FOREVER, including after its
   * own output has already been reclaimed - `retentionEvicted` is the
   * only thing that then keeps it from re-entering candidacy (see that
   * field's own docs).
   */
  bytesEverReceived: number;
}

/**
 * @param seqCounter - the seq source this stream's materialized lines draw
 *   from. Omit for a STANDALONE buffer (this file's own buffer-layer tests
 *   drive one in isolation, with no sibling stream) - a fresh private
 *   counter is created, so a solo stream's `seq` still starts at 1 and
 *   increments by exactly 1 per line, unaffected by this change. `JobStore`
 *   (below) always supplies one SHARED counter across a job's stdout and
 *   stderr, which is what makes `seq` genuinely global for a real job.
 */
export function createStreamBufferState(
  seqCounter: JobSeqCounter = createJobSeqCounter()
): StreamBufferState {
  return {
    pending: Buffer.alloc(0),
    lines: [],
    totalBytes: 0,
    truncated: false,
    finalized: false,
    seqCounter,
    linesEverMaterialized: 0,
    highestSeqAssigned: 0,
    droppedCount: 0,
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

/**
 * The ONE place either eviction loop in this file (`materializeLine`'s own
 * loop below, and `evictToFitBudget`'s separate pass) actually removes a
 * line from `state.lines` - shared so `totalBytes`/`truncated` accounting
 * and the `droppedCount` increment (see that field's own docs) can never
 * drift apart between the two call sites by one of them forgetting a step.
 * Returns the removed entry, or `undefined` if there was nothing to evict.
 */
function evictOldestLine(state: StreamBufferState): StreamLineEntry | undefined {
  const removed = state.lines.shift();
  if (!removed) return undefined;
  state.totalBytes -= Buffer.byteLength(removed.text, "utf8");
  state.truncated = true;
  state.droppedCount += 1;
  return removed;
}

/**
 * Drops every currently-retained line on `state`, in one bulk step, AND
 * discards any not-yet-materialized pending fragment - the retention
 * sweep's own reclaim primitive, deliberately separate from
 * `evictOldestLine` above. That function removes ONE line via
 * `Array.shift()`, which is the right shape for ordinary cap eviction
 * (one line evicted per newly-materialized one, so the per-call cost is
 * already bounded) but is the WRONG shape for retention, which drops an
 * entire stream's retained set at once: calling `evictOldestLine` in a
 * loop would `shift()` once per retained line, and repeated front-removal
 * from an array is itself linear per call - making the whole drain
 * quadratic in the stream's own retained-line count. This does the same
 * per-line `droppedCount` accounting `evictOldestLine` does, but in one
 * bulk assignment - the whole operation is a fixed number of field writes
 * regardless of how many lines or pending bytes it drops.
 *
 * `state.pending` is cleared here UNCONDITIONALLY, not just `state.lines`:
 * once retention calls this, `appendOutput`/`finalizeStream`'s own
 * `retentionEvicted` guards (see their docs) permanently refuse to ever
 * flush a pending fragment for this job again, so bytes left sitting in
 * `pending` after this call would otherwise be retained forever, reachable
 * by nothing - up to just under 1 MiB per stream, entirely outside the
 * cap this whole mechanism exists to enforce. Dropping them here is what
 * actually closes that window; leaving them for a `finalizeStream` that
 * can now never run would not.
 *
 * `truncated` and `droppedCount` are always set TOGETHER, never one without
 * the other - the invariant `evictOldestLine` already keeps and that a
 * caught-up stream's public response depends on (`truncated:true` paired
 * with `droppedCount:0` is reserved for mid-response pagination, never for
 * genuine loss). `droppedCount` counts DISCRETE LOSS EVENTS, not materialized
 * lines: the `count` materialized lines dropped this call contribute `count`
 * (identical to `evictOldestLine`'s own one-at-a-time accounting), and a
 * pending fragment cleared alongside them contributes a FURTHER, SEPARATE
 * `+1` if one existed (`state.pending.length > 0` before the clear above) -
 * it is REAL DATA THE CALLER CAN NEVER SEE AGAIN, exactly like a dropped
 * line, and its own discard is never folded into the line count regardless
 * of whether this call also dropped zero, one, or many lines. That is a
 * deliberate widening of what `droppedCount` counts - from "materialized
 * lines dropped" to "discrete loss events", the smallest change that lets
 * this signal express sub-line loss at all without ever producing the
 * forbidden `truncated:true`/`droppedCount:0` pair, and without silently
 * absorbing a fragment's own loss into an unrelated line count on the one
 * call where both happen together. `headSeq` (see
 * `StreamBufferState.highestSeqAssigned`) is deliberately left untouched by
 * the fragment's contribution: a fragment never received a `seq`, so there
 * is no boundary value to report for it without fabricating one - the same
 * never-name-a-value discipline `droppedBeforeCursor`'s own docs already
 * describe. `appendOutput` registers the other new loss-event source (a
 * chunk arriving for an already-reclaimed stream); see its own docs.
 * Returns how many materialized LINES were actually dropped (0 if none
 * were retained), so a caller can tell a genuine line-drain from a
 * pending-only or no-op reclaim; the returned count is unaffected by
 * whether a pending fragment was also discarded.
 */
function evictAllLines(state: StreamBufferState): number {
  const count = state.lines.length;
  const hadPending = state.pending.length > 0;
  state.lines = [];
  state.pending = Buffer.alloc(0);
  state.totalBytes = 0;
  if (count > 0 || hadPending) {
    state.truncated = true;
    state.droppedCount += count + (hadPending ? 1 : 0);
  }
  return count;
}

function materializeLine(
  state: StreamBufferState,
  text: string,
  terminator: StreamLineTerminator,
  onLine?: (line: StreamLineEntry) => void
): void {
  const seq = state.seqCounter.next();
  state.linesEverMaterialized += 1;
  state.highestSeqAssigned = seq;
  const entry: StreamLineEntry = { text, terminator, seq };
  state.lines.push(entry);
  state.totalBytes += Buffer.byteLength(text, "utf8");
  // Fired BEFORE the eviction loop below, with the freshly-materialized
  // entry itself - a caller (JobStore.appendOutput/finalizeStream, see
  // their own docs) retains its own reference regardless of whether
  // eviction later drops this entry from `state.lines`, so a real-time
  // arrival observer never misses a line merely because it was later
  // evicted from the retained buffer window.
  onLine?.(entry);
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
    if (!evictOldestLine(state)) break;
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
 * remains, that line's OWN size (ignoring `pending` entirely) already
 * exceeds `MAX_BUFFER_BYTES` on its own (the oversized-split case), AND
 * THIS `appendChunkToBuffer` call is the one that just materialized it (see
 * `materializedALineThisCall` below) - that line is never evicted by this
 * pass, so the forced-split regression tests proving a lone oversized-split
 * entry survives the very call that creates it are unaffected - EVEN THOUGH
 * that same call's own cut can naturally leave a leftover in `pending` up
 * to just under `MAX_LINE_BYTES` (almost another full line-cap's worth),
 * so resident bytes (this one oversized entry plus that leftover) can
 * genuinely peak near double `MAX_BUFFER_BYTES` for the DURATION of the
 * call that creates the entry, before the next call's own eviction pass
 * brings it back down.
 * On any LATER, SEPARATE call where no new line materializes at all -
 * genuinely new bytes simply growing `pending` on top of an entry that was
 * already sitting there before this call began - the exception no longer
 * applies and this pass falls through to evict the old entry like any
 * other. So the exception protects a single oversized ENTRY only at the
 * instant it is created, never a license for `pending` to then grow
 * unboundedly on top of it forever across further, separate calls (a real
 * prior bug: the old entry sat protected no matter how large `pending`
 * grew afterward, since the exception ignored `pending` entirely, checking
 * only `state.lines.length`/`state.totalBytes`).
 *
 * Net effect, proven by this file's tests: at the return of every
 * `appendChunkToBuffer` call, `sum(state.lines bytes) + state.pending.length
 * <= MAX_BUFFER_BYTES`, UNLESS `state.lines.length === 1`, that lone entry's
 * own bytes already exceed the cap, AND this same call is the one that just
 * materialized it (the documented exception, which holds only for the call
 * that creates the oversized entry - never for a later call that merely
 * grows `pending` on top of an already-existing one).
 *
 * @param materializedALineThisCall - whether `materializeLine` ran at least
 *   once during the SAME `appendChunkToBuffer` call this pass is closing out
 *   (see that call site for how this is tracked). This is the discriminator
 *   the single-entry exception above needs - see this function's own docs
 *   above for why `state.pending.length` alone can't serve the same role.
 */
function evictToFitBudget(state: StreamBufferState, materializedALineThisCall: boolean): void {
  for (;;) {
    if (state.lines.length === 0) return;
    const overLineCount = state.lines.length > MAX_BUFFER_LINES;
    const overByteCount = state.totalBytes + state.pending.length > MAX_BUFFER_BYTES;
    if (!overLineCount && !overByteCount) return;
    // The documented single-entry exception - see this function's own docs.
    // Only holds for the call that just materialized this entry; a later,
    // separate call that merely grows `pending` on top of an
    // already-existing lone oversized entry falls through and evicts it.
    if (
      state.lines.length === 1 &&
      state.totalBytes > MAX_BUFFER_BYTES &&
      materializedALineThisCall
    ) {
      return;
    }
    if (!evictOldestLine(state)) return;
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
 * of EVERY call here, not only inside `materializeLine`) - passed whether
 * this call materialized at least one line, by comparing
 * `state.linesEverMaterialized` before and after this call's own loop (see
 * `evictToFitBudget`'s `materializedALineThisCall` param docs for why that
 * distinction, not `state.pending.length` alone, is what its single-entry
 * exception needs).
 */
export function appendChunkToBuffer(
  state: StreamBufferState,
  chunk: Buffer,
  onLine?: (line: StreamLineEntry) => void
): void {
  state.bytesEverReceived += chunk.length;
  const linesMaterializedBeforeThisCall = state.linesEverMaterialized;
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
      materializeLine(state, segment.toString("utf8"), "newline", onLine);
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
      materializeLine(
        state,
        piece.toString("utf8") + OVERSIZED_LINE_MARKER,
        "oversized-split",
        onLine
      );
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
  const materializedALineThisCall = state.linesEverMaterialized > linesMaterializedBeforeThisCall;
  evictToFitBudget(state, materializedALineThisCall);
}

/**
 * Call once a stream has genuinely ended (its `end` event fired). If a
 * never-newline-terminated line is still pending, materializes it as a
 * `stream-end` entry (the "partial final line" requirement) -
 * text preserved exactly, unmarked, flagged only via `terminator`.
 * Idempotent: a second call is a no-op.
 */
export function finalizeStreamBuffer(
  state: StreamBufferState,
  onLine?: (line: StreamLineEntry) => void
): void {
  if (state.finalized) return;
  state.finalized = true;
  if (state.pending.length > 0) {
    materializeLine(state, state.pending.toString("utf8"), "stream-end", onLine);
    state.pending = Buffer.alloc(0);
  }
}

export function snapshotStreamBuffer(state: StreamBufferState): StreamBufferSnapshot {
  return {
    lines: [...state.lines],
    truncated: state.truncated,
    headSeq: state.highestSeqAssigned,
    droppedCount: state.droppedCount,
  };
}

// ---------------------------------------------------------------------------
// JobStore
// ---------------------------------------------------------------------------

export type ManagedStream = "stdout" | "stderr";

// ---------------------------------------------------------------------------
// The generic output-arrival + job-terminal observation seams. Neither
// concept here is Tasks-shaped, or shaped for any other single consumer -
// they are plain core hooks over facts this store already tracks (a line
// was just materialized on one of a job's streams; a job's state just
// transitioned into a terminal one), so ANY future consumer could register
// on them the same way `src/tasksAdapter.ts` does today. This store still
// holds every listener itself (below, in `JobStore`'s own fields) - a
// consumer only ever gets a subscribe call and the unsubscribe function it
// returns, never a container of its own to manage.
// ---------------------------------------------------------------------------

/** One materialized line, on one of a job's two streams, the instant it was appended - see `JobStore.onOutputArrival`. */
export interface OutputArrivalEvent {
  readonly stream: ManagedStream;
  readonly line: StreamLineEntry;
}

export type OutputArrivalListener = (event: OutputArrivalEvent) => void;

/** Fires once, the moment `jobId`'s OWN state transitions into a terminal one - see `JobStore.onJobTerminal`. */
export type JobTerminalListener = (jobId: string) => void;

/**
 * A generic, opaque annotation a consumer of `onOutputArrival` can record
 * against a job to say why it stopped watching that job's output - never
 * interpreted by this store (the `reason` string carries whatever meaning
 * the recording consumer gives it; `src/tasksAdapter.ts` is the one real
 * consumer today, recording `"firehose"`, but this store neither knows nor
 * cares). See `JobStore.recordOutputWatchStopped`/`getOutputWatchStopInfo`.
 */
export interface OutputWatchStopInfo {
  readonly reason: string;
  readonly stoppedAt: string;
}

interface CreateJobInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly label?: string;
  readonly isShell: boolean;
}

interface CreateFailedJobInput extends CreateJobInput {
  readonly diagnosticMessage: string;
  /**
   * Defaults to `"spawn-error"` - the reason every call site had before the
   * command-policy gate existed. `src/tools/run.ts` passes
   * `"policy-denied"` explicitly for a job rejected by
   * `src/policy.ts`'s `decideRunPolicy`/`decideShellPolicy`; every other
   * existing call site (a bad `cwd`, an unresolvable executable) is
   * unchanged and keeps relying on this default.
   */
  readonly diagnosticReason?: JobDiagnosticReason;
}

/**
 * One job waiting in the FIFO concurrency queue - see `JobStore.enqueueJob`'s
 * own docs for the full contract `onDequeued` operates under.
 */
interface QueuedJob {
  readonly jobId: string;
  readonly onDequeued: () => void;
}

/**
 * What `JobStore` tracks about a job's real, live child process, alongside
 * the `ChildProcess` handle itself - the pid, the (approximate) real spawn
 * time, and the leader's real captured birth identity (nullable), the
 * last of which `kill`/the shutdown reaper actually compare against a
 * real external OS lookup before ever signaling a pid. See `attachChild`'s
 * docs for why `spawnedAtMs` is recorded exactly when it is, and
 * `TrackedChild.birthIdentity`'s own docs for why that field, not
 * `spawnedAtMs`, is what identity comparison actually uses.
 */
interface TrackedChild {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly spawnedAtMs: number;
  /**
   * The leader's real, `ps`-captured birth identity - `undefined` when
   * capture itself failed (or was never attempted, e.g. this handle
   * predates the capture lifecycle), or when an ASYNC capture (see
   * `identityCapture` below) is still genuinely in flight. Every
   * kill/shutdown caller uses THIS field for identity comparison now, not
   * `spawnedAtMs` above (kept only as an informational/back-compat
   * timestamp - see its own docs) - via `JobStore.resolveBirthIdentityForKill`,
   * never read directly, so an in-flight `identityCapture` gets a real
   * chance to settle first (see that method's own docs).
   */
  readonly birthIdentity: ProcessBirthIdentity | undefined;
  /**
   * The ASYNC birth-identity capture kicked off for this job (see
   * `process.captureBirthIdentityPosixAsync`) - `undefined` only if none
   * was ever kicked off in the first place (e.g. this handle predates the
   * async-capture lifecycle, or the platform is Windows). This field is
   * NOT cleared once the capture settles: the same promise reference stays
   * stored for the tracked child's whole lifetime, and `identity_capture`
   * on the public `JobRecord` (`"pending"` / `"captured"` / `"unavailable"`)
   * is the field that reflects settlement, not this one. Awaiting an
   * already-settled promise resolves immediately, so `resolveBirthIdentityForKill`
   * reading this field is cheap either way - a genuinely in-flight
   * `identityCapture` gets a real chance to settle first, and an already-
   * settled one costs nothing extra, without needing this field itself to
   * be reset to `undefined` to tell the two cases apart (that distinction
   * lives in `birthIdentity` above and in `identity_capture`).
   */
  readonly identityCapture: Promise<ProcessBirthIdentity | undefined> | undefined;
  /**
   * The real `setTimeout` handle backing this job's own optional run
   * deadline (see `attachDeadlineTimer`/`clearDeadlineTimer`) - `undefined`
   * when this job was never given a deadline, or its deadline timer has
   * already fired or been cleared. Stored here rather than in a separate
   * map for the same reason `identityCapture` lives here: a tool handler
   * under `src/tools/` may hold no state of its own (see this file's own
   * header and `scripts/check-module-boundaries.mjs`), so the one real
   * per-job timer this feature needs lives alongside this job's other
   * tracked-child bookkeeping instead.
   */
  readonly deadlineTimer: NodeJS.Timeout | undefined;
}

/**
 * The result of one `reapProcessGroupOnce` call. `"confirmed"` and
 * `"no-child"` both mean there is nothing outstanding - safe to release a
 * concurrency slot. `"unconfirmed"` means the reaper ran but could not
 * externally confirm zero survivors within its bound - NOT safe to
 * release (see `releaseSlot`'s fail-closed handling). `"already-attempted"`
 * means the reap-once guard (`reapAttempted`) was already set for this job
 * BEFORE this call - but that guard has more than one writer (this
 * function's own confirmed path, `kill.ts`'s explicit-SIGKILL branch, and
 * `server.ts`'s shutdown live-job branch), and the SIGKILL/shutdown
 * writers mark it UNCONDITIONALLY, before any confirmation ever lands -
 * so `already-attempted` alone does NOT mean "safe to release." Its own
 * `confirmed` field reports the job's REAL, current `kill_confirmed`
 * state at the moment of the short-circuit, so a caller can tell an
 * already-attempted-and-confirmed reap from an already-attempted-but-
 * still-unconfirmed one (see `reapOutcomeToReleaseDecision`, the single
 * shared function every caller must use to turn this into a release
 * decision - never re-derive that mapping ad hoc at a call site).
 */
export type ReapOutcome =
  | { readonly kind: "confirmed" }
  | { readonly kind: "unconfirmed" }
  | { readonly kind: "no-child" }
  | { readonly kind: "already-attempted"; readonly confirmed: boolean };

/**
 * What `releaseSlot` actually needs to know about a reap: `"confirmed"` -
 * safe to free the slot; `"unconfirmed"` - the reap ran but did not
 * confirm zero survivors; `"errored"` - the reap attempt itself threw
 * (a real signal-send failure, not merely an inconclusive observation).
 * `releaseSlot` treats `"unconfirmed"` and `"errored"` identically (both
 * fail closed) but keeps them as distinct values so a caller's own
 * diagnostic logging can say which one actually happened.
 */
export type ReapReleaseDecision = "confirmed" | "unconfirmed" | "errored";

/**
 * The ONE place a `ReapOutcome` becomes a release decision - every real
 * caller (`src/tools/run.ts`'s eager onExit wrapper, this file's own
 * automatic stranded-slot retry, `src/tools/kill.ts`'s manual late-
 * recovery branch) must go through this function rather than each
 * inventing its own mapping. This is deliberate: an earlier draft of this
 * fix had two independently-reasoned mappings that silently disagreed on
 * what `already-attempted` means, which is exactly the kind of drift a
 * single shared function exists to prevent.
 */
export function reapOutcomeToReleaseDecision(outcome: ReapOutcome): "confirmed" | "unconfirmed" {
  switch (outcome.kind) {
    case "confirmed":
    case "no-child":
      return "confirmed";
    case "already-attempted":
      return outcome.confirmed ? "confirmed" : "unconfirmed";
    case "unconfirmed":
      return "unconfirmed";
  }
}

// ---------------------------------------------------------------------------
// follow() admission budget - process-wide, not per-connection
// ---------------------------------------------------------------------------

/**
 * The maximum number of `follow` calls this store will let sit outstanding
 * (subscribed and waiting on a job's next event) AT ONCE, across every
 * connection this process serves - see `JobStore.tryAdmitFollow`/
 * `releaseFollowAdmission`'s own docs for the accounting this bounds, and
 * `src/tools/follow.ts`'s own `description` for the caller-facing contract:
 * a call made once this budget is exhausted is REJECTED outright with a
 * tool error, never queued or coalesced with an existing outstanding call
 * on the same job. A deliberately modest, round default - disclosed rather
 * than measured, the same kind of number `follow.ts`'s own
 * `MAX_TIMEOUT_MS` is for the same reason (see that constant's own docs):
 * this store has no real production traffic to calibrate a budget against
 * yet, so 128 is chosen as comfortably above any single well-behaved
 * caller's own realistic concurrent-wait count, not derived from a load
 * test. The budget is enforced PROCESS-WIDE, not per-connection or
 * per-client - this server tracks no connection/client identity today, so
 * one connection's outstanding `follow` calls draw from the exact same
 * shared pool every other connection does. A single misbehaving client can
 * therefore still exhaust this budget and deny `follow` to every other
 * connection - it can no longer do so silently or without bound (a caller
 * now gets an immediate, clear rejection instead of this store quietly
 * accumulating unbounded listeners and timers), but per-connection
 * fairness is explicitly out of scope for this budget, disclosed here
 * rather than left to be discovered.
 */
export const MAX_OUTSTANDING_FOLLOWS = 128;

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
  private readonly outputArrivalListeners = new Map<string, Set<OutputArrivalListener>>();
  private readonly jobTerminalListeners = new Map<string, Set<JobTerminalListener>>();
  private readonly outputWatchStops = new Map<string, OutputWatchStopInfo>();
  /**
   * Job ids whose process group has already had a real CLEANUP-REAP
   * attempt against a TERMINAL record - not a record of every signal this
   * codebase has ever sent. Two distinct paths write to this set, and only
   * one of them is gated by it:
   *
   * - `reapProcessGroupOnce` (the eager reap at leader-exit, and the
   *   terminal-record fallback a `kill()`/shutdown call reaching an
   *   already-terminal record now also routes through) CHECKS this set
   *   before ever signaling, and marks it as part of the same call. This
   *   set alone is NOT what makes "at most one SIGNAL-CAPABLE cleanup-reap
   *   attempt per job" true under concurrency - it is written only AFTER
   *   `reapProcessGroupOnce`'s own signal-capable attempt has already
   *   resolved, which is too late to stop two calls reaching that method
   *   for the same job at once from both taking the signal-capable branch
   *   (see `reapEntered`'s own docs for the pre-await marker that
   *   actually closes that window). What this set DOES guarantee is
   *   idempotence across calls that are NOT racing: once a signal-capable
   *   attempt has genuinely CONFIRMED the group empty, no later call -
   *   concurrent or not - re-signals a recycled pgid. An unconfirmed
   *   first attempt does NOT set this marker, so a later call still
   *   reaches `reapProcessGroupOnce` again - it just takes that method's
   *   own existence-only retry branch instead of re-entering the signal-
   *   capable one (see `src/tools/kill.ts`'s own docs for the disclosed
   *   PGID-reuse
   *   residual this narrows).
   * - A LIVE job's own explicit `kill()` signal marks this set too (so a
   *   later terminal-record reap knows a cleanup attempt already covered
   *   this job), but does NOT check it first - a live signal is a
   *   caller-requested action, never suppressed by this flag. The default
   *   path marks ONLY once its own external process-group confirmation
   *   actually observes zero survivors (`result.confirmed` - see
   *   `src/tools/kill.ts`'s own docs on why this moved off the front of
   *   that call): an UNCONFIRMED outcome - including the combined-
   *   degraded cell where neither identity layer could confirm anything
   *   and the SIGKILL escalation was correctly refused - leaves this flag
   *   UNSET, precisely so a still-genuinely-alive group is not
   *   permanently stranded by a call that never actually reaped it. The
   *   custom-signal path marks ONLY for `SIGKILL` (the one signal this
   *   codebase treats as unable to be caught or ignored, so sending it
   *   genuinely IS a cleanup reap) - a non-terminating custom signal
   *   (`SIGSTOP`/`SIGCONT`) never marks this set, since nothing was
   *   reaped and the real cleanup-reap opportunity must stay available
   *   for whenever the leader eventually exits on its own.
   */
  private readonly reapAttempted = new Set<string>();
  /**
   * Tracks, independently of `reapAttempted`/`kill_confirmed`, whether a
   * SIGNAL-CAPABLE `reapProcessGroupOnce` attempt has already BEGUN for
   * this job - set synchronously, in the same tick as the guard that
   * reads it, before that method's own `await`. This is a distinct
   * question from either existing marker: `kill_confirmed` answers "did
   * the reap CONFIRM", and only gets written after the awaited reaper
   * settles; `reapAttempted` answers "did a signal-capable attempt
   * CONFIRM zero survivors" and has other writers besides this method.
   * Neither can double as "has an attempt been ENTERED", because both are
   * written too late (after an `await`) to close the window this set
   * exists for: two callers reaching `reapProcessGroupOnce` for the same
   * job at once - genuinely reachable from two ordinary public `kill`
   * `tools/call` requests, since the installed MCP SDK dispatches each
   * inbound request independently rather than awaiting the previous one -
   * could otherwise both read `kill_confirmed` as still `undefined` and
   * both take the signal-capable branch, each sending a real signal. A
   * synchronous, pre-await entry marker closes that: JS's own run-to-
   * completion semantics mean whichever call's synchronous prologue runs
   * first sets this before yielding at its `await`, so the second call -
   * however soon after - sees it already set and takes the existence-only
   * retry path instead. Never cleared and never used for anything but
   * that one guard read; `hasReapBeenAttempted`/`markReapAttempted` above
   * remain the outward-facing "did cleanup already run" answer.
   */
  private readonly reapEntered = new Set<string>();
  private seqCounter = 0;

  /**
   * The concurrency-cap + max-queue-depth policy this store enforces - see
   * `src/scheduler.ts`'s own header for why the POLICY lives there (pure
   * functions over plain numbers) while the actual COUNTS live here (this
   * store is the sole designated owner of persistent state). Defaults to
   * the real, production, environment-sourced config; a test constructs a
   * fresh `JobStore` with an explicit small config instead, or calls
   * `setConcurrencyConfig` to reconfigure an already-constructed store
   * (e.g. the shared singleton) without a fresh instance.
   */
  private concurrencyConfig: ConcurrencyConfig;
  /** The retention policy for a terminal job's BUFFERED OUTPUT - see `src/scheduler.ts`'s `RetentionConfig`/`decideRetentionEvictions` for the pure decision, and `sweepRetention` below for the only place this store acts on it. */
  private retentionConfig: RetentionConfig;
  /**
   * Job ids whose buffered stdout/stderr have already been reclaimed by
   * `sweepRetention`. Its independently load-bearing use is in
   * `appendOutput` (see its own docs): checking this Set there is what
   * closes the exit-before-stream-end race, where a child's `exit` and
   * its stdout/stderr `end` fire as independent, unordered events -
   * without that check, a chunk arriving AFTER eviction would run
   * through the ordinary append path and materialize as plain content
   * with no loss signal at all, silently re-populating a buffer this
   * store has already told every caller is empty, rather than the
   * active `truncated`/`droppedCount` disclosure `appendOutput`'s guard
   * produces today. `finalizeStream`'s own check against this Set is
   * DEFENSE-IN-DEPTH, not independently necessary: `evictAllLines` (see
   * its own docs) always empties `pending` on reclaim, and it is
   * `appendOutput`'s own guard above - not `finalizeStream`'s - that
   * keeps `pending` from ever becoming non-empty again for a reclaimed
   * job, so there is never anything left for a post-reclaim
   * `finalizeStream` call to flush regardless of whether its own check
   * runs first. `getRetentionEvictedCount()` reads this Set's size directly for
   * observability, and `deleteJob` reclaims this entry too, the same
   * discipline as every other per-job Set/Map in this file.
   *
   * ITS OWN exclusion check inside `sweepRetention`'s candidate loop is
   * INDEPENDENTLY NECESSARY, not defense-in-depth: `sweepRetention`'s
   * holds-output filter (see that method's own docs) tests
   * `bytesEverReceived > 0` on each stream, a cumulative counter that
   * only ever grows (see that field's own docs) and that `evictAllLines`
   * never touches when it drains a stream's lines and pending bytes on
   * reclaim. So a job that has ever received any output keeps
   * `holdsOutput === true` forever, including after this Set has already
   * reclaimed it - this Set's own membership check is what actually
   * stops such a job from re-entering candidacy and being selected again
   * by a later sweep.
   */
  private readonly retentionEvicted = new Set<string>();
  /**
   * Job ids for which `releaseSlot` has STARTED awaiting a reap decision
   * but that decision has not yet resolved - the window `isJobSlotStranded`
   * cannot see, since it only becomes true once a reap has ALREADY
   * resolved unconfirmed/errored (`markSlotStranded`). A job in this set
   * is terminal but its process-group cleanup outcome is still unknown:
   * `sweepRetention` must treat it exactly like a confirmed-stranded job
   * (deferring output reclamation), because the diagnostic trace it would
   * reclaim may turn out to be the only one this store ever gets if the
   * reap comes back unconfirmed. Added the instant `releaseSlot` is
   * called with a real reap promise, removed the instant that promise
   * settles (in a `finally`, so a decision that somehow throws instead of
   * resolving still clears it rather than leaving the job wrongly
   * protected forever).
   *
   * SCOPE, STATED DELIBERATELY NARROW: this protects only the window that
   * begins when `releaseSlot` is actually called with a reap promise, and
   * only for as long as that specific promise is unsettled. It says
   * nothing about, and does not protect, an EARLIER window some call
   * sites can produce - `src/tools/run.ts`'s deadline-enforcement path
   * (and the equivalent live `kill()` path) can mark a record terminal
   * (`markDeadlineExceeded`) from inside `killProcessGroupPosix`'s
   * `onSignaled` callback, which fires the moment a signal is sent, well
   * BEFORE that same call's eventual `releaseSlot(jobId, reapPromise)`
   * ever runs. Between those two moments the job is terminal, its
   * concurrency slot has not been released, and neither this Set nor
   * `isJobSlotStranded` has anything to say about it - `sweepRetention`
   * can reclaim its output in that specific window today. That gap
   * predates this file (the deadline and kill paths have always marked a
   * record terminal before their own cleanup could confirm it); retention
   * is what made the gap reachable, not what created it, and widening
   * this mechanism to also cover it is tracked separately (a change to
   * the deadline/kill subsystem itself, not to this store's retention
   * sweep) rather than folded in here.
   */
  private readonly reapPending = new Set<string>();
  /** The real periodic timer behind `startRetentionSweeper` - `undefined` whenever no real production process has started it (every test-constructed `JobStore` instance, by design; see that method's own docs). */
  private retentionTimer: NodeJS.Timeout | undefined;
  /** How many jobs currently hold a concurrency slot - spawned and not yet reaped. See `releaseSlot`'s own docs for exactly when a slot is freed. */
  private activeSlots = 0;
  /** The FIFO queue of jobs admitted into the queue (the cap was full when they arrived, but queue depth allowed it) - this array's own push/shift order IS insertion order, the queue's own tie-break. */
  private readonly queue: QueuedJob[] = [];
  /** Job ids whose concurrency slot has already been released once - see `releaseSlot`'s own docs for why a SECOND release for the same id must be a no-op rather than a real second decrement/dequeue. */
  private readonly slotReleased = new Set<string>();
  /**
   * Job ids that GENUINELY, RIGHT NOW, hold a reserved concurrency slot -
   * checked by `releaseSlot`'s own ownership guard before it ever
   * decrements `activeSlots` on a job's behalf. The two are meant to move
   * together exactly: a job id is added here at the same moment
   * `activeSlots` is incremented for it, and there are only two such
   * moments - an immediate `"admit"` (via `createJob`, since `run()`'s
   * handler calls it right after `requestSlot()` returns `"admit"`, with
   * no `await` in between - see `src/tools/run.ts`'s own docs) and a
   * later dequeue-promotion (`dequeueNext`, at its own `activeSlots += 1`).
   *
   * A job admitted with `{kind: "queue"}` is the one wrinkle: `createJob`
   * cannot yet know, at the moment it runs, whether ITS caller's
   * `requestSlot()` returned `"admit"` or `"queue"` (the two are separate,
   * uncoupled calls - see `requestSlot`'s own docs), so it marks every job
   * id optimistically, on the assumption it is being admitted right now.
   * `enqueueJob` - which is called if and only if the real answer was
   * `"queue"` - corrects that assumption immediately, in the same
   * synchronous step as the job's own admission decision, by removing the
   * id again (see that method's own docs for why nothing can ever observe
   * the job as reserved in between). `dequeueNext` then re-adds it later,
   * at the exact point this job actually takes a slot. Net effect: a
   * queued-but-not-yet-dequeued job is never a member of this set, so
   * `removeFromQueue` and `drainQueueOnShutdown` - the two ways such a job
   * can be cancelled before ever reaching `dequeueNext` - have nothing of
   * their own to revoke here (see their own docs).
   *
   * A job id absent from this set never holds a slot: a preflight failure
   * in `src/tools/run.ts` - invalid cwd, missing executable, or a policy
   * denial - creates a terminal record via `createFailedJob`, which never
   * touches this set at all; a queued job is absent for as long as it
   * remains queued, by the mechanism above.
   */
  private readonly slotReserved = new Set<string>();
  /**
   * Job ids whose concurrency slot `releaseSlot` refused to free because
   * the reap that would have justified freeing it never confirmed zero
   * survivors (or errored outright) - see `releaseSlot`'s own fail-closed
   * docs and `markSlotStranded`/`retryStrandedSlot`. `attempts` counts
   * real `reapProcessGroupOnce` cycles this store has run for the job so
   * far (the initial one plus any AUTOMATIC retry - never a manual
   * `kill()` retry, which is unbounded by design and does not touch this
   * counter). `retryTimer` is the pending automatic-retry handle, or
   * `undefined` once the retry budget (`MAX_STRANDED_SLOT_ATTEMPTS`) is
   * exhausted or a retry has already fired and is awaiting its own
   * result. `deleteJob` clears both the timer and this entry, the same
   * discipline `getSlotReleasedCount`'s own docs establish for
   * `slotReleased` - otherwise a TTL-purged job would leave an orphaned
   * timer firing against a job no longer in the store.
   */
  private readonly strandedSlots = new Map<
    string,
    { attempts: number; retryTimer: NodeJS.Timeout | undefined }
  >();
  /** The total number of real `reapProcessGroupOnce` cycles a stranded job ever gets (the initial attempt plus automatic retries) before this store gives up and leaves it a permanent, disclosed residual - see `markSlotStranded`/`retryStrandedSlot`. Never bounds a manual `kill()` retry, which a caller can always attempt again by hand regardless of this budget. */
  private static readonly MAX_STRANDED_SLOT_ATTEMPTS = 2;
  /** How long `markSlotStranded`/`retryStrandedSlot` wait before running a stranded job's next automatic retry - long enough that a genuinely-in-progress kernel-level reap has a real chance to finish first, short enough that a real stranding resolves without the caller needing to notice and retry manually. */
  private static readonly STRANDED_SLOT_RETRY_DELAY_MS = 3000;
  /** Whether this store has begun shutting down - see `beginShutdown`'s own docs for exactly what that gates and why it is permanent on a real server. */
  private shuttingDown = false;
  /**
   * How many `follow` calls currently hold an admission slot against
   * `MAX_OUTSTANDING_FOLLOWS` - see `tryAdmitFollow`/`releaseFollowAdmission`'s
   * own docs for the exactly-once accounting contract this counter depends
   * on. Process-wide, not keyed by job id or connection - see
   * `MAX_OUTSTANDING_FOLLOWS`'s own docs for why.
   */
  private outstandingFollowCount = 0;

  constructor(
    concurrencyConfig: ConcurrencyConfig = loadConcurrencyConfigFromEnv(),
    retentionConfig: RetentionConfig = loadRetentionConfigFromEnv()
  ) {
    this.concurrencyConfig = normalizeConcurrencyConfig(concurrencyConfig);
    this.retentionConfig = normalizeRetentionConfig(retentionConfig);
  }

  /** Reconfigures the retention policy on an already-constructed store (e.g. the shared singleton) - mirrors `setConcurrencyConfig`. Takes effect on the next `sweepRetention` call; does not retroactively re-judge anything already reclaimed. */
  setRetentionConfig(config: RetentionConfig): void {
    this.retentionConfig = normalizeRetentionConfig(config);
  }

  /**
   * Reclaims a TERMINAL job's BUFFERED OUTPUT past retention - the ONE
   * place this store acts on `decideRetentionEvictions`'s decision. Does
   * NOT delete the job's own record: `has`/`get`/`status`/`list` still
   * find it exactly as before. What changes is `output`/`tail`: every
   * currently-retained line on both streams is dropped (`headSeq` is
   * untouched since it already tracks the true highest-ever-assigned
   * value), applied in bulk to every retained line at once via
   * `evictAllLines` (see its own docs), which ALSO discards any
   * not-yet-newline-terminated pending fragment on each stream - the one
   * thing `evictOldestLine`'s ordinary per-line eviction never has to
   * touch, since a byte/line-cap eviction only ever removes complete
   * lines. The unit these two paths increment `droppedCount` by is
   * therefore NOT the same: `evictOldestLine` counts materialized lines
   * one at a time; reclamation counts DISCRETE LOSS EVENTS (a
   * materialized line, a discarded fragment, or - via `appendOutput`'s
   * own post-reclaim branch - a later arriving chunk, each exactly one).
   * A caller reading a retention-evicted job's output still sees the
   * SAME kind of honest, bounded, in-stream "this stream lost something
   * forever" signal `output.ts`/`tail.ts` already report for ordinary
   * byte/line-cap eviction - never a bare "job not found" that reads
   * identically to a job that never existed at all - but the count
   * behind that signal is a wider unit on this path than on the cap
   * path.
   *
   * Synchronous and non-`await`ing throughout, like every other mutation
   * in this file, so a concurrent read (`get`/`getStreamSnapshot`/etc.,
   * themselves plain synchronous reads) can never observe a
   * partially-evicted buffer: Node's single-threaded execution means a
   * call to this method and a call to a read method can never interleave
   * mid-operation, only run fully before or fully after each other - so a
   * caller sees either the buffer's real final state or the fully-dropped
   * one, never a torn read. Calling `evictAllLines` on the SAME job's
   * streams twice is itself a harmless no-op (nothing left to drop the
   * second time) - but the `retentionEvicted` exclusion below is what
   * stops a reclaimed job from being re-selected as a CANDIDATE at all
   * on a later sweep (see that field's own docs: it is independently
   * necessary for this, not defense-in-depth), so this method's own
   * idempotence as observed by a caller - a second sweep returning an
   * empty list for an already-reclaimed job - rests on that exclusion,
   * not on `evictAllLines` alone. Synchronous latency per call is
   * proportional to the total number of terminal job RECORDS this store
   * currently holds (one pass over `this.jobs.values()` to build
   * candidates - that population has no cap of its own on the non-Tasks
   * path, since retention bounds accumulated OUTPUT, never accumulated
   * RECORD count), plus a FIXED, small amount of additional work per job
   * this call actually evicts: `evictAllLines` (see its own docs) drains
   * an entire stream's retained lines and pending bytes in one bulk step,
   * never a per-line `Array.shift()`, so the number of lines or bytes
   * being dropped does not itself add proportional cost.
   *
   * Four exclusions before a terminal job is even considered eligible:
   * - Non-terminal (still-running) jobs are never terminal in the first
   *   place, so `isTerminalJobState` alone excludes them.
   * - A job currently holding no output at all on EITHER stream - checked
   *   via `bytesEverReceived`, not `lines.length`, so a job whose only
   *   content is a pending fragment that never formed a complete line is
   *   still a real candidate - is skipped regardless of age or the cap:
   *   there is nothing to reclaim, and letting a genuinely empty record
   *   occupy a `maxRetainedJobs` slot would let it displace an older job
   *   that still holds real output, which is exactly backwards from what
   *   the cap exists to bound.
   * - A job whose slot is currently STRANDED (`isJobSlotStranded`), or
   *   whose reap decision is still being awaited (`reapPending` - see
   *   that field's own docs for the timing gap this closes), is excluded
   *   even though it IS terminal - mirrors `src/tasksAdapter.ts`'s
   *   `isExpiredTerminalRecord` guard, which checks the identical
   *   confirmed-stranded flag before its own (separate) full-record
   *   reclamation, for the analogous reason: a stranded or
   *   cleanup-pending job's output is often the only remaining
   *   diagnostic trace of what a still-held process group was doing, and
   *   this store has no way to know a caller isn't about to inspect it
   *   as part of the manual `kill()` recovery path.
   * - A job already in `retentionEvicted` is skipped - INDEPENDENTLY
   *   NECESSARY, not covered by the holds-output filter above: that
   *   filter tests cumulative `bytesEverReceived`, which reclaiming a
   *   job's streams never resets (see that field's own docs), so a
   *   reclaimed job keeps `holdsOutput === true` forever and this Set's
   *   own membership check is what stops it re-entering candidacy here.
   *
   * A fresh, separate lifecycle from `src/tasksAdapter.ts`'s task-record
   * TTL purge (which reclaims the whole record, output included, on its
   * own much longer trigger) and from concurrency-slot release - see
   * `RetentionConfig`'s own docs. Each acts only on its own trigger
   * (`createJob`/`createFailedJob` call this method below, and so does
   * `startRetentionSweeper`'s periodic timer; the task TTL purge is
   * lazy-on-`tasks/get` read; a slot is released only on its own
   * confirmed reap) - with two named exceptions, never a blanket "none":
   * both this method and the task-record TTL purge independently defer
   * their own reclamation while a job's slot is stranded, for the
   * identical reason (protecting the only remaining trace of a held
   * slot). Every other cross-lifecycle interaction remains forbidden.
   */
  sweepRetention(now: number = Date.now()): string[] {
    const candidates: { jobId: string; endedAtMs: number }[] = [];
    for (const record of this.jobs.values()) {
      if (!isTerminalJobState(record.state)) continue;
      const streams = this.buffers.get(record.job_id);
      const holdsOutput =
        streams !== undefined &&
        (streams.stdout.bytesEverReceived > 0 || streams.stderr.bytesEverReceived > 0);
      if (!holdsOutput) continue;
      if (this.isJobSlotStranded(record.job_id) || this.reapPending.has(record.job_id)) continue;
      if (this.retentionEvicted.has(record.job_id)) continue;
      if (record.ended_at === undefined) continue; // defensive only - every real terminal record sets this
      const endedAtMs = Date.parse(record.ended_at);
      if (Number.isNaN(endedAtMs)) continue; // defensive only - ended_at is always a real toISOString() value
      candidates.push({ jobId: record.job_id, endedAtMs });
    }
    const evicted = decideRetentionEvictions(candidates, now, this.retentionConfig);
    for (const jobId of evicted) {
      const streams = this.buffers.get(jobId);
      if (streams !== undefined) {
        evictAllLines(streams.stdout);
        evictAllLines(streams.stderr);
      }
      this.retentionEvicted.add(jobId);
    }
    return evicted;
  }

  /** How many jobs currently have an entry in `retentionEvicted` - the same observability shape `getReapEnteredCount`/`getStrandedSlotCount` already establish for this file's other per-job Sets. */
  getRetentionEvictedCount(): number {
    return this.retentionEvicted.size;
  }

  /**
   * Starts the REAL periodic timer that makes retention check on a
   * schedule rather than only ever firing when a new job happens to
   * arrive (`createJob`/`createFailedJob` already call `sweepRetention`
   * opportunistically, but on an otherwise-idle server nothing would
   * ever trigger it again). In PRODUCTION this is called exactly once,
   * from `src/server.ts`'s `runServer` - the real production entrypoint
   * - never from `createServer()` (which every test in this codebase's
   * own suite calls directly, often many times against this one
   * process-lifetime singleton); a test that specifically exercises the
   * timer itself calls this method directly instead. That production
   * split is deliberate and load-bearing: starting this timer from the
   * `JobStore` CONSTRUCTOR, instead, would mean every test-constructed
   * instance spins up its own background interval, accreting across a
   * whole test run - which is exactly why the constructor never calls it
   * and every caller that wants the timer, production or test, must ask
   * for it explicitly. Idempotent - a second call while one is already
   * running is a no-op, matching this file's other start/stop pairs.
   *
   * `RETENTION_SWEEP_INTERVAL_MS` sets how often the check is
   * SCHEDULED, not a guaranteed maximum delay: it is an ordinary
   * `setInterval`, and its callback only runs once the event loop is
   * free to reach it, so a job's actual reclamation can lag this
   * interval by however long the loop is busy with other work at that
   * moment (a blocking synchronous call elsewhere in the process, or
   * genuine host contention) - the schedule names the cadence the check
   * is attempted at, not a wall-clock ceiling on when it completes.
   * `.unref()`'d so this timer is never, on its own, the reason a real
   * MCP stdio server's process stays alive - the transport connection
   * already governs that.
   */
  startRetentionSweeper(): void {
    if (this.retentionTimer !== undefined) return;
    this.retentionTimer = setInterval(() => this.sweepRetention(), RETENTION_SWEEP_INTERVAL_MS);
    this.retentionTimer.unref();
  }

  /** Stops the timer `startRetentionSweeper` started, if any - a harmless no-op for a store that never started one (every test-constructed instance, by design; see that method's own docs). Called from `src/server.ts`'s shutdown path unconditionally, for the same reason it's harmless there. */
  stopRetentionSweeper(): void {
    if (this.retentionTimer === undefined) return;
    clearInterval(this.retentionTimer);
    this.retentionTimer = undefined;
  }

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
   * How many OTHER jobs currently have a real, tracked spawned child AND
   * are still genuinely live - not yet terminal - excluding the one job
   * named by `excludeJobId`. A proxy for "spawned-process load" distinct
   * from `size()`'s plain job-record count: a job record can exist with no
   * live child at all (capture never reached that point, or the child was
   * already reaped), and `markExited`/`markKilled`/`markSpawnFailed` all
   * transition a job's `state` to terminal WITHOUT removing its child
   * handle from `this.children` - the handle is retained for later reads
   * (output, tail, status) even after the process itself is long gone. So
   * a plain count of `this.children` entries counts every job that ever
   * had a child, including ones that exited minutes ago, which is not
   * "live" by any definition this signal needs. This counts only entries
   * whose job record is both present and non-terminal, and never counts
   * the job under test against itself.
   */
  otherLiveChildCount(excludeJobId: string): number {
    let count = 0;
    for (const jobId of this.children.keys()) {
      if (jobId === excludeJobId) continue;
      const record = this.jobs.get(jobId);
      if (record === undefined || isTerminalJobState(record.state)) continue;
      count += 1;
    }
    return count;
  }

  /**
   * Registers a fresh job in `starting` state and initializes its (empty)
   * stdout/stderr buffers. Used for a job that IS about to be (or just was)
   * handed to `process.spawnManaged` - never for a job that's already known
   * to be un-spawnable (use `createFailedJob` for that).
   */
  createJob(input: CreateJobInput): JobRecord {
    // Opportunistic retention sweep - a new job arriving is a convenient
    // moment to reclaim eligible output immediately, ahead of the periodic
    // timer's next tick (`startRetentionSweeper` is what supplies the real
    // time bound on an idle server - see `sweepRetention`'s own docs).
    // Never changes the admission decision below - its result is
    // discarded here, and a caller that wants the evicted ids calls
    // `sweepRetention` directly. It does run synchronously before that
    // decision, so it adds the sweep's own synchronous work to this call's
    // latency; it is not free, and that work scales with the total number
    // of terminal job RECORDS this store currently holds (see
    // `sweepRetention`'s own docs for why that population has no cap of
    // its own on the non-Tasks path).
    this.sweepRetention();
    const now = new Date().toISOString();
    const record: JobRecord = {
      job_id: randomUUID(),
      argv: input.argv,
      cwd: input.cwd,
      env: input.env,
      state: "starting",
      started_at: now,
      // Starts equal to started_at - a fresh record's own creation IS its
      // most recent real change so far. See JobRecord.last_updated_at's
      // own docs for every later writer.
      last_updated_at: now,
      label: input.label,
      seq: this.nextSeq(),
      is_shell: input.isShell,
    };
    this.jobs.set(record.job_id, record);
    // Optimistically marks this job reserved, on the assumption it is
    // being admitted right now - true whenever the caller's own
    // `requestSlot()` returned `"admit"`, since `run()`'s handler never
    // calls `createJob` at all except after that decision (see
    // `slotReserved`'s own field doc for the full contract). When the
    // real answer was `"queue"` instead, `enqueueJob` corrects this in
    // the same synchronous step, immediately after - this store cannot
    // know which answer applies AT this exact call, since `createJob` and
    // `requestSlot` are two separate, uncoupled calls (see `requestSlot`'s
    // own docs), so it marks first and the very next step corrects it.
    this.slotReserved.add(record.job_id);
    // ONE shared JobSeqCounter for this job's stdout and stderr - see its
    // own docs for why sharing it is what makes StreamLineEntry.seq a real
    // per-job GLOBAL event sequence.
    const eventSeq = createJobSeqCounter();
    this.buffers.set(record.job_id, {
      stdout: createStreamBufferState(eventSeq),
      stderr: createStreamBufferState(eventSeq),
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
    this.sweepRetention(); // same forward-progress trigger as createJob - see that method's own comment
    const now = new Date().toISOString();
    const record: JobRecord = {
      job_id: randomUUID(),
      argv: input.argv,
      cwd: input.cwd,
      env: input.env,
      state: "failed",
      started_at: now,
      // Starts equal to started_at/ended_at - a failed-to-spawn job's
      // creation and its (immediate) terminal transition are the same
      // instant. See JobRecord.last_updated_at's own docs.
      last_updated_at: now,
      ended_at: now,
      diagnostic: {
        reason: input.diagnosticReason ?? "spawn-error",
        message: input.diagnosticMessage,
      },
      label: input.label,
      seq: this.nextSeq(),
      is_shell: input.isShell,
    };
    this.jobs.set(record.job_id, record);
    // Same shared-counter construction as createJob above, even though a
    // failed-to-spawn job will realistically never produce any output -
    // keeping both constructors identical means there is no separate,
    // easy-to-forget code path for the event-seq wiring.
    const eventSeq = createJobSeqCounter();
    this.buffers.set(record.job_id, {
      stdout: createStreamBufferState(eventSeq),
      stderr: createStreamBufferState(eventSeq),
    });
    return record;
  }

  // ---------------------------------------------------------------------------
  // Concurrency cap + FIFO queue
  // ---------------------------------------------------------------------------

  /** The currently configured concurrency cap - `src/tools/list.ts`'s own response surfaces this. */
  getConcurrencyCap(): number {
    return this.concurrencyConfig.maxConcurrentJobs;
  }

  /** How many jobs are currently waiting in the FIFO queue - exposed for observability/testing, the same "real oracle" role `getJobTerminalListenerCount` already plays for its own subscriber count. */
  getQueueLength(): number {
    return this.queue.length;
  }

  /** How many concurrency slots are currently held (spawned and not yet reaped) - exposed for the same observability/testing reason as `getQueueLength`. */
  getActiveSlotCount(): number {
    return this.activeSlots;
  }

  /**
   * How many job ids currently hold a `slotReleased` dedupe entry - exposed
   * for the same observability/testing reason as `getQueueLength`/
   * `getActiveSlotCount`. `deleteJob` reclaims a job's entry from
   * `slotReleased` when it purges everything else this store holds for
   * that job, so this count returning to (or staying at) its
   * pre-purge-cycle value across repeated create/release/delete cycles is
   * the real oracle proving `slotReleased` does not grow without bound on
   * a long-running server, rather than merely trusting that the deletion
   * line was added.
   */
  getSlotReleasedCount(): number {
    return this.slotReleased.size;
  }

  /**
   * Reconfigures the concurrency cap / max-queue-depth this store
   * enforces, from this call onward. Never touches the CURRENT active
   * count: lowering the cap below a currently-elevated active count just
   * means no NEW slot opens up until enough jobs finish to bring it back
   * under the new cap (nothing already running is ever killed just
   * because the configured cap changed under it).
   *
   * Raising the cap DOES proactively drain the queue now (`drainQueue`) -
   * a queued job never held a slot to release in the first place, so
   * nothing calls `releaseSlot` on its behalf; only a DIFFERENT job's own
   * release, or this reconfiguration itself, ever re-evaluates a queued
   * entry. Without draining here, a cap lowered to (or started at) zero
   * and then raised back up would leave every queued job waiting
   * indefinitely for some unrelated job's release to notice the new
   * room, rather than being admitted the moment room actually exists.
   * Draining admits every now-eligible queued job immediately, in FIFO
   * order, in one call.
   *
   * Exists so a long-lived server (or this store's own test suite) can
   * retune without a restart - see `loadConcurrencyConfigFromEnv` for how
   * the real, production singleton is normally configured once, at
   * startup.
   */
  setConcurrencyConfig(config: ConcurrencyConfig): void {
    this.concurrencyConfig = normalizeConcurrencyConfig(config);
    this.drainQueue();
  }

  /**
   * The whole admission decision for a NEW `run()` call, plus its
   * corresponding state commit, as one step a caller can never split apart
   * into "decide" without "commit" (this codebase is single-threaded end
   * to end, so nothing else can interleave between the decision and the
   * commit below). See `src/scheduler.ts`'s `decideAdmission` for the pure
   * policy this wraps.
   *
   * - `"admit"`: a real slot was free - RESERVED here (this call already
   *   incremented the active count); the caller should spawn the job
   *   right now.
   * - `"queue"`: no slot was free (or something is already ahead of this
   *   job in line), but the queue has room - the caller must follow up
   *   with `enqueueJob(jobId, onDequeued)` once it has a real `jobId` to
   *   enqueue (this method alone can't do that: no job exists yet at
   *   decision time).
   * - `"reject"`: neither a slot nor queue room exists - the caller must
   *   never create a running/queued job for this `run()` call at all.
   */
  requestSlot(): AdmissionDecision {
    const decision = decideAdmission(
      this.activeSlots,
      this.queue.length,
      this.concurrencyConfig,
      this.shuttingDown
    );
    if (decision.kind === "admit") {
      this.activeSlots += 1;
    }
    return decision;
  }

  /**
   * Permanently closes admission - every `requestSlot()` call from this
   * moment on rejects with `"shutting-down"`, regardless of the cap/queue's
   * own state. Called once, as the very FIRST thing `src/server.ts`'s
   * `performShutdown` does, strictly before it drains the queue or starts
   * awaiting the live-job reap: a `run()` call that arrives during that
   * later awaited reap must never be admitted or queued into a queue this
   * shutdown is never going to drain again (`drainQueueOnShutdown` only
   * ever runs once, earlier in the same function). Idempotent - a second
   * call is a no-op.
   *
   * There is no legitimate way to reverse this on a real server: a real
   * process shuts down once and exits. `clearShutdownGate` exists purely
   * because this codebase's own test suite constructs several independent
   * `createServer()` instances against this one process-lifetime singleton
   * - see that method's own docs.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /**
   * Reopens admission - the inverse of `beginShutdown`. Called once, at
   * the START of every `src/server.ts` `createServer()` call, since a
   * freshly constructed server is by definition not itself shutting down,
   * whatever an EARLIER server built against this same shared singleton
   * already did to it. Harmless in real production use (a real process
   * only ever calls `createServer()` once, before its own first and only
   * shutdown), and is what keeps this codebase's own test suite - which
   * constructs many independent servers against the one process-lifetime
   * `jobStore` singleton - from having one test's real shutdown
   * permanently poison every later test's own use of `requestSlot()`.
   */
  clearShutdownGate(): void {
    this.shuttingDown = false;
  }

  /**
   * Enqueues an ALREADY-admitted-to-the-queue job (the caller must have
   * just received `{kind: "queue"}` from `requestSlot()`) onto the FIFO
   * queue, in real insertion order - this array's own push order IS the
   * insertion-sequence tie-break: two `run()` calls can only ever be
   * enqueued one after the other, never simultaneously, since this
   * codebase's handler is synchronous end to end with no `await` between
   * validating one call and returning its result (see `src/tools/run.ts`'s
   * own docs). Writes this job's own 1-based `queue_position` onto its
   * `JobRecord` - appending to the tail never changes any EARLIER queued
   * job's own distance from the front, so only this new entry's position
   * needs setting here (contrast `dequeueNext`, which removes from the
   * FRONT and therefore does renumber every remaining entry).
   *
   * `onDequeued` is called EXACTLY ONCE, later, whenever this entry
   * reaches the front of the queue AND a slot has just been reserved for
   * it (see `releaseSlot`/`dequeueNext`) - never before, and never more
   * than once. The caller (`src/tools/run.ts`) supplies a closure that
   * performs the actual deferred `spawnManaged` call for this exact job at
   * that moment; this store has no opinion on what "actually running the
   * job" means, only on WHEN it becomes this job's turn.
   *
   * ALSO removes `jobId` from `slotReserved` - `createJob` marks every job
   * reserved optimistically, on the assumption it is being admitted right
   * now, and this call is the caller telling this store that assumption
   * was wrong for THIS job (the caller only reaches here after its own
   * `requestSlot()` returned `"queue"`, never `"admit"`). This is the
   * ONE place that correction happens, and it happens immediately: nothing
   * can observe `jobId` as reserved in the gap between `createJob` and
   * this call, since production and every test call them back to back
   * with no `await` in between (see `src/tools/run.ts`'s own docs on why
   * `run()`'s handler is synchronous end to end). `dequeueNext` re-adds
   * this exact id the moment it actually promotes this job, at the exact
   * point it increments `activeSlots` for it - so a queued job is in
   * `slotReserved` only for as long as it is actually true that this job
   * holds, or is about to hold, a slot; never while it is merely waiting.
   * `removeFromQueue`/`drainQueueOnShutdown` need no matching cleanup of
   * their own as a result: whichever of them a still-queued job's
   * cancellation reaches, the entry was already gone from here.
   */
  enqueueJob(jobId: string, onDequeued: () => void): void {
    this.queue.push({ jobId, onDequeued });
    const record = this.jobs.get(jobId);
    if (record) record.queue_position = this.queue.length;
    this.slotReserved.delete(jobId);
  }

  /**
   * Removes `jobId` from the FIFO queue if it is still sitting there -
   * `src/tools/kill.ts`'s own path for cancelling a job that has not yet
   * spawned, distinct from `drainQueueOnShutdown`'s bulk drain of the
   * WHOLE queue at once. Clears the removed entry's own `queue_position`,
   * then renumbers every STILL-queued job's position via
   * `renumberQueuePositions` - removing from the MIDDLE of the queue (not
   * just the front, which is all `dequeueNext` ever does) still moves
   * every LATER entry one position closer to the front. Never touches
   * `activeSlots`: a queued job never held a concurrency slot to begin
   * with, so there is nothing to release. Never calls the removed entry's
   * own `onDequeued` closure either - that closure performs the deferred
   * spawn `enqueueJob`'s caller supplied, and cancelling a queued job is
   * the opposite of ever giving it that spawn.
   *
   * Never touches `slotReserved` either, and needs no such cleanup: a
   * still-queued job's `slotReserved` entry was already removed by
   * `enqueueJob` the moment it was queued (see that method's own docs), so
   * this call - like every other cancellation of a queued job - has
   * nothing left to revoke there. That is what makes a later, mistaken
   * second `kill`/`tasks.cancel` against the now-terminal record
   * correctly refused by `releaseSlot`'s own ownership guard, without this
   * method having to know that guard exists.
   *
   * Returns `false`, a pure no-op, when `jobId` is not currently in the
   * queue (never queued, already dequeued, or already removed by an
   * earlier call).
   */
  removeFromQueue(jobId: string): boolean {
    const index = this.queue.findIndex((entry) => entry.jobId === jobId);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    const record = this.jobs.get(jobId);
    if (record) record.queue_position = undefined;
    this.renumberQueuePositions();
    return true;
  }

  /**
   * Releases exactly one concurrency slot - called once a job that
   * previously held one (admitted immediately, or dequeued and actually
   * spawned) reaches its real end: either a genuine exit/kill (after its
   * reap decision has been awaited to completion - see `reapPromise`
   * below) or a spawn failure (no reap needed at all, since no real child
   * was ever attached for one). A slot is released exactly once, and only
   * after the finishing job's own reap decision has been awaited to
   * completion AND that decision is `"confirmed"` - see the fail-closed
   * paragraph below for what happens otherwise.
   *
   * @param jobId - the finishing job this release belongs to. Every real
   *   caller (`src/tools/run.ts`'s `beginSpawn`, this file's own
   *   `retryStrandedSlot`, `src/tools/kill.ts`'s manual late-recovery
   *   branch) already knows which job just finished, so this identity
   *   costs nothing to supply and is what makes a DUPLICATE release for
   *   the SAME job detectable at all: a second call for a jobId already
   *   recorded in `slotReleased` is a no-op - it never decrements
   *   `activeSlots` again and never advances the queue a second time.
   *   Without this, two release calls for one finishing job (a bug
   *   elsewhere, a retry, a race) each independently free "a" slot and
   *   each independently dequeue the next waiting job - two jobs admitted
   *   for one job's single freed slot, silently pushing real concurrency
   *   above the configured cap while `activeSlots` itself under-reports
   *   it (the net of two decrements against one real reservation). Logged
   *   loudly to stderr rather than thrown: this codebase's own convention
   *   (see every other `console.error` in `src/tools/run.ts`'s spawn-
   *   callback wiring) is to surface an internal anomaly as a diagnostic
   *   and keep the server alive, never to crash a long-running process
   *   over a bug in its own bookkeeping. The guard is checked TWICE - once
   *   synchronously up front (the common case: no `reapPromise`, or one
   *   that resolves without ever truly yielding), and once again
   *   immediately before the actual commit below, AFTER any real
   *   `await` - a concurrent second caller for the same job (e.g. this
   *   file's own automatic retry racing a manual `kill()` late-recovery
   *   call) can only ever pass the first check while this call is
   *   suspended at the `await`, and the second check is what stops BOTH
   *   from reaching the commit once one of them already has.
   * @param reapPromise - resolves to the release decision the finishing
   *   job's reap actually produced - `"confirmed"` (safe to free the
   *   slot), or `"unconfirmed"`/`"errored"` (NOT safe - see the fail-
   *   closed paragraph below). Every real caller derives this via
   *   `reapOutcomeToReleaseDecision`, never by inventing its own mapping.
   *   Omit (or pass `undefined`) for a job that never had a real child
   *   attached at all (a spawn failure, or a caller that already
   *   confirmed the reap itself out of band, e.g. `kill.ts`'s late-
   *   recovery branch) - there is nothing to await, so the decision is
   *   treated as `"confirmed"` immediately and synchronously (this path
   *   never actually suspends this async function at all).
   *
   * FAIL-CLOSED: a decision other than `"confirmed"` does NOT free the
   * slot - `activeSlots` is left exactly as it was (still counting this
   * job as active) and the job is handed to `markSlotStranded` instead,
   * which schedules a bounded automatic retry (see that method's own
   * docs). This is deliberate: a reap that could not confirm zero
   * survivors means real child processes may still exist, and admitting
   * a NEW job into a slot that a live process may still be occupying
   * would let real concurrency exceed the configured cap - the exact
   * hazard this store's whole cap-enforcement design exists to prevent.
   * The slot stays held, disclosed via `getStrandedSlotCount`, until
   * either the automatic retry confirms it, a manual `kill()` late-
   * recovery call confirms it, or the retry budget runs out and it
   * becomes a permanent, disclosed residual.
   *
   * On a CONFIRMED release: frees the slot, clears any `strandedSlots`
   * entry for this job (a job can only reach a confirmed release here
   * once - either directly, or via `markSlotStranded`'s own retry path -
   * so any stale stranded-tracking is stale by construction) - including
   * cancelling that entry's own pending `retryTimer` first, exactly as
   * `deleteJob` does, so a confirmed release reached ahead of a scheduled
   * automatic retry (the manual `kill()` late-recovery path can win this
   * race) doesn't leave that retry's timer running for
   * `STRANDED_SLOT_RETRY_DELAY_MS` past the point its own entry is gone -
   * then drains
   * the queue (`drainQueue`) - handing the freed capacity to every
   * currently-eligible queued job in FIFO order, not just the first one
   * (a single release can free room for more than one queued job at once
   * now that a release is not guaranteed to happen exactly once per
   * finishing job's first attempt - see `drainQueue`'s own docs). Never
   * lets the active count go negative (a defensive floor - this method is
   * the only writer that ever decrements it, and it is only ever meant to
   * be called once per slot that `requestSlot`/`dequeueNext` reserved,
   * but the floor costs nothing and removes any possibility of it
   * drifting negative under a future bug).
   */
  async releaseSlot(jobId: string, reapPromise?: Promise<ReapReleaseDecision>): Promise<void> {
    if (!this.slotReserved.has(jobId)) {
      // Ownership guard: `jobId` never reserved a slot in the first place
      // (a preflight failure in `src/tools/run.ts` - invalid cwd, missing
      // executable, or a policy denial - creates a terminal failed record
      // via `createFailedJob`, never `createJob`, before admission control
      // ever runs). Every real caller of this method (a spawn
      // failure or a confirmed exit in `beginSpawn`, the automatic
      // stranded-slot retry, `src/tools/kill.ts`'s manual late-recovery
      // branch) can still be called against a job in this state - a
      // terminal record's own state gives no signal about whether it ever
      // held a slot - so this guard, not caller discipline, is what keeps
      // `activeSlots` honest: decrementing it here would free a DIFFERENT
      // job's reservation. A no-op, not an error: from this job's own
      // point of view there was never a slot to release, so this logs at
      // `warn`, not `error` (both reach the same stderr diagnostic channel
      // every log call in this codebase uses, since stdout is reserved for
      // the MCP stdio protocol stream - this is the one call site in the
      // codebase that isn't actually reporting a failure).
      console.warn(
        `[ghantika] releaseSlot called for job "${jobId}", which never reserved a concurrency slot - ignoring, since decrementing activeSlots here would free a different job's reservation`
      );
      return;
    }
    if (this.slotReleased.has(jobId)) {
      console.error(
        `[ghantika] releaseSlot called more than once for job "${jobId}" - ignoring the duplicate release, since this job's slot was already freed`
      );
      return;
    }
    let decision: ReapReleaseDecision;
    if (reapPromise === undefined) {
      decision = "confirmed";
    } else {
      // Marked BEFORE the await starts, cleared once it settles either
      // way - this is the retention-exclusion window `sweepRetention`
      // needs (see `reapPending`'s own docs): terminal but cleanup-
      // outcome-unknown, which `isJobSlotStranded` alone cannot express
      // since it only becomes true once a reap has ALREADY resolved
      // unconfirmed/errored. The `finally` covers the reap promise
      // rejecting instead of resolving (never expected in practice - a
      // real reap failure is mapped to the explicit "errored" decision
      // value, never left as a rejection - but this keeps a violation of
      // that invariant from leaving a job wrongly output-protected
      // forever instead of merely losing this one call's fail-closed
      // stranding).
      this.reapPending.add(jobId);
      try {
        decision = await reapPromise;
      } finally {
        this.reapPending.delete(jobId);
      }
    }
    if (this.slotReleased.has(jobId)) {
      // A concurrent release for this same job already committed while
      // this call was suspended awaiting its own decision above - see
      // this method's own "guard is checked TWICE" docs.
      return;
    }
    if (decision !== "confirmed") {
      this.markSlotStranded(jobId);
      return;
    }
    this.slotReleased.add(jobId);
    const stranded = this.strandedSlots.get(jobId);
    if (stranded?.retryTimer !== undefined) clearTimeout(stranded.retryTimer);
    this.strandedSlots.delete(jobId);
    this.activeSlots = Math.max(0, this.activeSlots - 1);
    this.drainQueue();
  }

  /**
   * Records that `jobId`'s concurrency slot could NOT be freed because the
   * reap that would have justified freeing it did not confirm zero
   * survivors, or errored outright (`releaseSlot`'s own fail-closed
   * paragraph) - and, unless this job has already exhausted its bounded
   * automatic-retry budget (`MAX_STRANDED_SLOT_ATTEMPTS`), schedules
   * exactly one retry attempt after `STRANDED_SLOT_RETRY_DELAY_MS`
   * (`retryStrandedSlot`). Never touches `activeSlots` or the queue - a
   * stranded slot stays held (still counted active) until either a retry
   * confirms it, a manual `kill()` late-recovery call confirms it
   * (`src/tools/kill.ts`), or the retry budget runs out and it becomes a
   * permanent, disclosed residual (`getStrandedSlotCount`) - the same
   * honesty pattern `kill_confirmed: false` already establishes elsewhere
   * in this codebase, rather than inventing a new disclosure channel for
   * this one case.
   *
   * Idempotent against being called more than once for a job already
   * tracked here: a second mark for a job with an entry already present
   * is a no-op (does not reschedule, does not touch `attempts`) - the
   * legitimate way this can happen is the same concurrent-caller race
   * `releaseSlot`'s own docs describe, where two callers both reach a
   * non-confirmed decision for the same job before either commits.
   *
   * DISCLOSED OPERATIONAL HAZARD: this fail-closed design trades a
   * different failure mode for the real-cap-overrun one it closes - in an
   * environment where the underlying process-existence oracle
   * (`killProcessGroupPosix`'s own `pgrep`-based confirmation, see
   * `src/process.ts`) is itself broken or permanently unavailable, EVERY
   * job would exhaust its retry budget without ever confirming, and
   * server capacity would monotonically strand toward zero with no
   * automatic recovery - including the manual `kill()` late-recovery
   * path, which relies on the SAME oracle. This is a real, accepted
   * precondition rather than a hazard this design closes: a broken
   * process-existence oracle is a more fundamental failure than this
   * store can repair from underneath it, and `getStrandedSlotCount`
   * exists precisely so this condition is observable (a monotonically
   * growing count with no drops) rather than silent.
   */
  private markSlotStranded(jobId: string): void {
    if (this.strandedSlots.has(jobId)) return;
    const entry: { attempts: number; retryTimer: NodeJS.Timeout | undefined } = {
      attempts: 1,
      retryTimer: undefined,
    };
    this.strandedSlots.set(jobId, entry);
    if (entry.attempts < JobStore.MAX_STRANDED_SLOT_ATTEMPTS) {
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = undefined;
        void this.retryStrandedSlot(jobId);
      }, JobStore.STRANDED_SLOT_RETRY_DELAY_MS);
    }
  }

  /**
   * The bounded automatic retry `markSlotStranded` schedules - runs a
   * fresh `reapProcessGroupOnce` cycle for `jobId` (a genuine second
   * chance: an unconfirmed first attempt leaves `hasReapBeenAttempted`
   * `false`, so this really does re-consult the reaper rather than
   * hitting the already-attempted short-circuit - see that method's own
   * docs) and, if the decision this produces (via the SAME shared
   * `reapOutcomeToReleaseDecision` every other caller uses) is now
   * `"confirmed"`, commits the release through `releaseSlot` exactly as
   * the original eager reap would have. A no-op if `jobId` is no longer
   * tracked in `strandedSlots` at all (the job was deleted, or a manual
   * `kill()` late-recovery call already won the race and committed the
   * release first - `releaseSlot`'s own docs cover that race).
   *
   * Advances `attempts` before running the retry, regardless of the
   * outcome (a real reap cycle happened either way), then schedules
   * exactly one further retry if the budget still allows it - so no job
   * ever gets more than `MAX_STRANDED_SLOT_ATTEMPTS` real reap cycles in
   * total (the initial attempt plus this method's own retries). A
   * `reapProcessGroupOnce` rejection is treated as `"errored"` (fails
   * closed, same as `releaseSlot`'s own `reapPromise` contract) rather
   * than propagating - this runs off a `setTimeout` with no caller to
   * hand a rejection back to.
   */
  private async retryStrandedSlot(jobId: string): Promise<void> {
    const entry = this.strandedSlots.get(jobId);
    if (entry === undefined) return;
    entry.attempts += 1;
    let decision: ReapReleaseDecision;
    try {
      decision = reapOutcomeToReleaseDecision(await this.reapProcessGroupOnce(jobId));
    } catch {
      decision = "errored";
    }
    if (decision === "confirmed") {
      await this.releaseSlot(jobId, Promise.resolve(decision));
      return;
    }
    if (entry.attempts < JobStore.MAX_STRANDED_SLOT_ATTEMPTS) {
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = undefined;
        void this.retryStrandedSlot(jobId);
      }, JobStore.STRANDED_SLOT_RETRY_DELAY_MS);
    }
  }

  /**
   * How many jobs currently have a stranded (held, unreleased, unconfirmed)
   * concurrency slot - exposed for the same observability/testing reason
   * as `getSlotReleasedCount`. A non-zero count that does not shrink on
   * its own (no further retry pending, no manual `kill()` late-recovery
   * call made) is the honest, disclosed residual `markSlotStranded`'s own
   * docs describe: a job whose retry budget ran out with its reap still
   * unconfirmed, which this store deliberately does not pretend was
   * safely reaped.
   */
  getStrandedSlotCount(): number {
    return this.strandedSlots.size;
  }

  /**
   * Whether `jobId` currently holds a stranded (unconfirmed, still-held)
   * concurrency slot - the per-job predicate behind the aggregate
   * `getStrandedSlotCount` above. Exists so a caller with a reclamation
   * policy of its own (`src/tasksAdapter.ts`'s TTL purge is the one real
   * caller today) can refuse to reclaim a job's record WHILE it is the
   * only durable, attributable trace of a held slot - see `deleteJob`'s
   * own docs for why deleting a stranded job's record would otherwise
   * silently and permanently lose both the observability and the manual
   * `kill()` recovery target for that held slot, with `activeSlots` itself
   * never decremented to compensate.
   */
  isJobSlotStranded(jobId: string): boolean {
    return this.strandedSlots.has(jobId);
  }

  /**
   * How many jobs currently have an entry in `reapEntered` - exposed for
   * the same observability/testing reason as `getSlotReleasedCount` and
   * `getStrandedSlotCount` above. `reapEntered` only ever grows (via
   * `reapProcessGroupOnce`'s own signal-capable branch) and is reclaimed
   * only by `deleteJob`, so this count returning to (or staying at) its
   * pre-purge-cycle value across repeated create/reap/delete cycles is
   * the real oracle proving it does not grow without bound on a
   * long-running server, exactly the same shape `getSlotReleasedCount`'s
   * own docs describe for `slotReleased`.
   */
  getReapEnteredCount(): number {
    return this.reapEntered.size;
  }

  /**
   * Gives a just-freed slot to the NEXT queued job (FIFO - the queue
   * array's own order IS insertion order), if any are waiting AND the
   * CURRENTLY configured cap actually has room for one more active job.
   * That second condition is what enforces `setConcurrencyConfig`'s own
   * documented contract for a lowered cap: if an operator drops
   * `maxConcurrentJobs` below the count that is presently active, a slot
   * freeing up here must NOT be handed to the next queued job until
   * enough OTHER jobs have also finished to bring `activeSlots` back
   * under the new, lower cap - so this checks `activeSlots` against the
   * cap AFTER `releaseSlot` has already decremented it for the finishing
   * job, and, when the cap does not yet allow it, leaves the queue
   * entirely untouched (nothing is shifted off, `activeSlots` is not
   * incremented) rather than draining it one release at a time regardless
   * of the new cap. When the cap does allow it: reserves the slot for the
   * dequeued job immediately (increments the active count again right
   * here - `releaseSlot`/`dequeueNext` are the only writers of that count,
   * and this codebase is single-threaded, so there is no real concurrency
   * to race between "freed" and "reserved again" regardless), clears the
   * dequeued job's own `queue_position` (it is no longer queued - it is
   * about to actually start), renumbers every STILL-queued job's position
   * (each one just moved one closer to the front), then calls the
   * dequeued job's own `onDequeued` closure, which performs the actual
   * deferred spawn for it (see `enqueueJob`'s own docs). A no-op when the
   * queue is empty OR the cap does not currently allow another active job.
   *
   * Also re-adds this job's id to `slotReserved`, right alongside the
   * `activeSlots` increment - `enqueueJob` removed it the moment this job
   * was queued (see that method's own docs), and THIS is the moment it
   * becomes true again: the job now genuinely holds a slot. Skipping this
   * would leave a promoted job permanently unmarked, so its own eventual
   * `releaseSlot` call would be wrongly refused by the ownership guard and
   * `activeSlots` would never come back down for it.
   */
  private dequeueNext(): void {
    if (this.queue.length === 0) return;
    if (this.activeSlots >= this.concurrencyConfig.maxConcurrentJobs) return;
    const next = this.queue.shift()!;
    const record = this.jobs.get(next.jobId);
    if (record) record.queue_position = undefined;
    this.renumberQueuePositions();
    this.activeSlots += 1;
    this.slotReserved.add(next.jobId);
    next.onDequeued();
  }

  /**
   * Repeatedly calls `dequeueNext` until a call actually leaves the queue
   * unchanged - the caller-facing entry point for "admit every queued job
   * the cap currently allows," not just the single next one. Needed
   * because freeing (or raising) capacity can now make room for MORE than
   * one queued job at once: `releaseSlot`'s fail-closed handling means a
   * release does not happen exactly once per finishing job's first
   * attempt, and `setConcurrencyConfig` raising the cap can jump it past
   * several queued jobs at a time - a single `dequeueNext` call only ever
   * admits ONE.
   *
   * Terminates because the queue only ever SHRINKS across this loop's own
   * iterations (nothing inside it enqueues a new job - `dequeueNext`
   * itself is already a safe, side-effect-free no-op once the queue is
   * empty or the cap does not currently allow another active job) - a
   * queue bounded to `maxQueueDepth` entries drains in at most that many
   * iterations, and reaching a cap or empty-queue no-op leaves the length
   * unchanged, which is exactly this loop's own stopping condition.
   */
  private drainQueue(): void {
    let previousLength = this.queue.length;
    for (;;) {
      this.dequeueNext();
      if (this.queue.length === previousLength) return;
      previousLength = this.queue.length;
    }
  }

  /** Rewrites every currently-queued job's own `queue_position` from its (1-based) index in the queue array - called after a dequeue, since removing the FRONT entry moves every remaining one a position closer to the front (an enqueue, by contrast, only ever needs to set the ONE new entry's own position - see `enqueueJob`). */
  private renumberQueuePositions(): void {
    this.queue.forEach((entry, index) => {
      const record = this.jobs.get(entry.jobId);
      if (record) record.queue_position = index + 1;
    });
  }

  /**
   * Called once, at server shutdown (`src/server.ts`'s `performShutdown`):
   * kills every job still sitting in the FIFO queue (it never got a
   * chance to actually spawn) and empties the queue, so nothing is left
   * waiting in limbo once the process exits. Drains front-to-back (this
   * queue's own FIFO order), one entry at a time; idempotent (a second
   * call finds an already-empty queue and is a pure no-op).
   *
   * A queued job never had a real child attached (`attachChild` is only
   * ever called once a job actually spawns - see `enqueueJob`'s own
   * docs), so there is nothing to reap here: `markKilled` alone is the
   * complete termination for this class of job. `"queue-drained-at-
   * shutdown"` is a descriptive synthetic `signal` value, not a real POSIX
   * signal - the same pattern `src/tools/kill.ts`'s own Windows path
   * already uses (`"SIGKILL-equiv"`) for a termination that never
   * involved sending an actual signal to a real process.
   *
   * Never touches `slotReserved`, and needs no such cleanup: every job
   * still in the queue at this point had its `slotReserved` entry removed
   * already, by `enqueueJob`, the moment it was queued (see that method's
   * own docs) - so, like `removeFromQueue`, there is nothing here left to
   * revoke.
   */
  drainQueueOnShutdown(): void {
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      const record = this.jobs.get(entry.jobId);
      if (record) record.queue_position = undefined;
      this.markKilled(entry.jobId, "queue-drained-at-shutdown");
    }
  }

  /**
   * Stores the live `ChildProcess` handle for a job, plus its pid, the
   * (approximate) real spawn time recorded at THIS moment - `Date.now()`
   * here, not the async `spawn` event that fires slightly later, since
   * `run.ts` calls this synchronously, immediately after
   * `process.spawnManaged` returns (itself synchronous - see that
   * function's own docs), so the gap to the real OS-level process creation
   * is at most low single-digit milliseconds - and an ALREADY-SETTLED
   * birth identity, if the caller happens to have one on hand already
   * (nullable). Internal bookkeeping only, never exposed publicly except
   * through `getChildHandle`'s narrow view (never the raw `ChildProcess`
   * itself) - used by `kill`/the shutdown reaper.
   *
   * `run()`'s own real production handler always passes `undefined` here
   * and separately calls `attachPendingIdentityCapture` right afterward to
   * track its own async, still-in-flight capture (see that method's own
   * docs) - this `birthIdentity` parameter exists for callers (chiefly this
   * codebase's own test suite) that already have a real, synchronously-
   * captured identity in hand and want to attach it directly, with no
   * pending-capture bookkeeping involved at all.
   *
   * @param birthIdentity - omit (or pass `undefined`) when no capture was
   *   attempted or it failed (or hasn't settled yet) - every real caller
   *   must then take the honest DEGRADED path at kill time (see
   *   `process.evaluatePreSignalIdentityGate`'s own docs), never silently
   *   treat a missing identity as confirmed.
   */
  attachChild(jobId: string, child: ChildProcess, birthIdentity?: ProcessBirthIdentity): void {
    const pid = child.pid;
    if (pid === undefined) return; // defensive: spawnManaged only ever returns a child when it has a real pid - see its own docs
    this.children.set(jobId, {
      child,
      pid,
      spawnedAtMs: Date.now(),
      birthIdentity,
      identityCapture: undefined,
      deadlineTimer: undefined,
    });
  }

  /**
   * The tracked child's pid, the (approximate) OS-confirmed spawn time
   * recorded when it was attached (see `attachChild`), its real captured
   * birth identity (nullable), and any still-in-flight async capture (see
   * `TrackedChild`'s own docs for both of the latter two). `kill`/the
   * shutdown reaper never read `birthIdentity` directly off this handle to
   * decide anything - they call `resolveBirthIdentityForKill` instead,
   * which awaits a still-pending `identityCapture` first (see that
   * method's own docs). `undefined` when no child was ever attached (a job
   * that started already-failed never gets one - see `createFailedJob`) or
   * the job id is unknown.
   */
  getChildHandle(jobId: string):
    | {
        readonly pid: number;
        readonly spawnedAtMs: number;
        readonly birthIdentity: ProcessBirthIdentity | undefined;
        readonly identityCapture: Promise<ProcessBirthIdentity | undefined> | undefined;
      }
    | undefined {
    const tracked = this.children.get(jobId);
    if (!tracked) return undefined;
    return {
      pid: tracked.pid,
      spawnedAtMs: tracked.spawnedAtMs,
      birthIdentity: tracked.birthIdentity,
      identityCapture: tracked.identityCapture,
    };
  }

  /**
   * Updates an ALREADY-tracked child's captured birth identity in place -
   * used by `attachPendingIdentityCapture`'s own resolution handler below
   * once the async, fire-and-forget capture kicked off at spawn time
   * actually resolves with a real identity, strictly AFTER `run()` itself
   * has already returned. Everything else about the tracked child (`pid`,
   * `spawnedAtMs`, `identityCapture`) is left untouched.
   *
   * A safe no-op when the job's tracked child is no longer present -
   * defensive: nothing in this codebase today ever removes an entry from
   * the tracked-children map once `attachChild` adds one, so this is not a
   * reachable path in practice, but a late-resolving capture must never be
   * allowed to fabricate or resurrect a tracked-child record for a job id
   * that isn't (or is no longer) tracked.
   */
  setBirthIdentity(jobId: string, birthIdentity: ProcessBirthIdentity): void {
    const tracked = this.children.get(jobId);
    if (!tracked) return;
    this.children.set(jobId, { ...tracked, birthIdentity });
  }

  /**
   * Wires an in-flight, async birth-identity capture (see
   * `process.captureBirthIdentityPosixAsync`) onto an ALREADY-attached
   * child - `run.ts`'s handler calls this immediately after `attachChild`
   * itself, WITHOUT ever awaiting the capture (that's the whole point:
   * `run()` returns before this settles). Records the honest `"pending"`
   * state on the job record right away (see `JobRecord.identity_capture`'s
   * own docs), and, once the capture actually settles, records the final
   * `"captured"`/`"unavailable"` state and - on success - writes the
   * result onto the tracked child via `setBirthIdentity`.
   *
   * The promise itself is ALSO stored on the tracked child
   * (`getChildHandle`'s own `identityCapture` field) so a `kill()`/reap
   * call that finds identity still pending at the exact moment it needs it
   * can await this SAME promise via `resolveBirthIdentityForKill` - bounded
   * because `readProcessElapsedSecondsAsync` (what
   * `captureBirthIdentityPosixAsync` awaits) settles on ITS OWN independent
   * timer regardless of the underlying `ps` process's cooperation, not
   * merely because `execFile`'s own `timeout` option sends it a signal
   * (that option only requests SIGTERM; a child that ignores it leaves
   * `execFile`'s callback genuinely unfired, which is exactly why a second,
   * caller-side timer exists - see that function's own docs) - rather than
   * either re-deriving a fresh capture of its own or giving up on identity
   * confirmation the instant it finds a still-in-flight one (see
   * `src/tools/kill.ts`'s own docs for exactly why that distinction
   * matters: it's the difference between a real, confirmed-identity reap
   * and an unnecessarily degraded one for a kill that simply happened to
   * race ahead of a capture that was about to succeed).
   *
   * A safe no-op if the job's tracked child is no longer present - see
   * `setBirthIdentity`'s own docs for why that's currently only a
   * defensive guard, not a reachable path.
   */
  attachPendingIdentityCapture(
    jobId: string,
    capture: Promise<ProcessBirthIdentity | undefined>
  ): void {
    const tracked = this.children.get(jobId);
    if (!tracked) return;
    this.children.set(jobId, { ...tracked, identityCapture: capture });
    const record = this.jobs.get(jobId);
    if (record) record.identity_capture = "pending";
    capture.then((identity) => {
      if (identity !== undefined) {
        this.setBirthIdentity(jobId, identity);
      }
      const settledRecord = this.jobs.get(jobId);
      if (settledRecord) {
        settledRecord.identity_capture = identity !== undefined ? "captured" : "unavailable";
      }
    });
  }

  /**
   * The single real entry point every kill/reap caller (`kill.ts`'s
   * handler, `server.ts`'s shutdown reaper) uses to obtain a job's birth
   * identity for comparison - NEVER read `getChildHandle(...).birthIdentity`
   * directly for this purpose, since a snapshot read at the wrong instant
   * can catch a real, about-to-succeed capture mid-flight and wrongly
   * treat it the same as a definitively failed one.
   *
   * Returns the already-SETTLED `birthIdentity` immediately when there is
   * one, or when no capture is currently pending at all (never attempted,
   * or already settled to "unavailable"). When a capture IS still
   * genuinely pending at this exact moment, awaits that SAME in-flight
   * promise (see `attachPendingIdentityCapture`) before returning - this
   * settles within `process.ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS` plus
   * a small fixed grace, on the promise's OWN independent timer, regardless
   * of whether the underlying `ps` process actually exits: that process is
   * force-reaped (SIGKILL) if it is still alive once that timer fires, so
   * a `ps` that ignores `execFile`'s own SIGTERM request cannot keep this
   * pending indefinitely, and cannot outlive the capture as a leaked
   * process either. This is what preserves a real, confirmed identity
   * comparison for the common, real race of a kill arriving moments after `run()`
   * returns, before the async capture has had time to answer - rather than
   * immediately falling back to the honest but strictly weaker degraded
   * path the instant identity isn't ALREADY settled.
   *
   * `undefined` when the job's child is no longer tracked at all.
   */
  async resolveBirthIdentityForKill(jobId: string): Promise<ProcessBirthIdentity | undefined> {
    const tracked = this.children.get(jobId);
    if (!tracked) return undefined;
    if (tracked.birthIdentity !== undefined) return tracked.birthIdentity;
    if (tracked.identityCapture === undefined) return undefined;
    return tracked.identityCapture;
  }

  /**
   * Wires an already-scheduled `setTimeout` handle onto an ALREADY-attached
   * child, so a later terminal transition (`markExited`/`markKilled`/
   * `markSpawnFailed`/`markDeadlineExceeded`) can cancel it via
   * `clearDeadlineTimer` - see that method's own docs for why a job that
   * finishes before its own deadline must not leave a stray timer pending.
   * `src/tools/run.ts` calls this immediately after scheduling the timer,
   * only when the caller actually supplied a deadline. A safe no-op if the
   * job's tracked child is no longer present, matching this file's other
   * `attach*` setters.
   */
  attachDeadlineTimer(jobId: string, timer: NodeJS.Timeout): void {
    const tracked = this.children.get(jobId);
    if (!tracked) return;
    this.children.set(jobId, { ...tracked, deadlineTimer: timer });
  }

  /**
   * Cancels this job's own pending deadline timer, if it has one - called
   * from every terminal-state transition below (`markExited`, `markKilled`,
   * `markSpawnFailed`, `markDeadlineExceeded`) so a job that reaches a
   * terminal state before its own deadline elapses (the ordinary case: most
   * jobs finish long before any deadline a caller happens to set) does not
   * leave a real Node timer sitting scheduled for no reason. Safe and cheap
   * even when called on a job that never had a deadline at all, or whose
   * timer already fired - a no-op in both cases, never an error.
   */
  clearDeadlineTimer(jobId: string): void {
    const tracked = this.children.get(jobId);
    if (!tracked || tracked.deadlineTimer === undefined) return;
    clearTimeout(tracked.deadlineTimer);
    this.children.set(jobId, { ...tracked, deadlineTimer: undefined });
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
    const now = new Date().toISOString();
    record.ended_at = now;
    // Same instant as ended_at - a terminal transition IS a real,
    // observable state change. See JobRecord.last_updated_at's own docs.
    record.last_updated_at = now;
    this.clearDeadlineTimer(jobId);
    this.fireJobTerminal(jobId);
  }

  /**
   * `starting`/`running` -> `failed`, when a job's own optional run
   * deadline (see `src/tools/run.ts`'s `deadline_ms`) elapsed before the
   * job reached a terminal state on its own. Same shape as
   * `markSpawnFailed` above - a diagnostic-carrying `failed` transition,
   * never a new state - but with the `"watcher/runtime-error"` reason
   * (see `JobDiagnosticReason`'s own docs) rather than `"spawn-error"`: the
   * command genuinely started and ran, it just outlived the time this
   * codebase itself was told to allow it. Same terminal-state guard as
   * every other `mark*` transition (first write wins), so a job that
   * already finished - naturally, or via an explicit `kill()` - a moment
   * before its deadline fired is left exactly as it was; this call and
   * that finish are simply racing to be the one that ISN'T a no-op.
   * `src/tools/run.ts`'s deadline-enforcement path is the only real caller,
   * and only invokes this once it has already used this codebase's own
   * real process-group kill machinery (`process.killProcessGroupPosix` on
   * POSIX, `process.killProcessTreeWindows` on Windows) to actually
   * terminate the job - this method only ever records the OUTCOME, it
   * performs no killing itself. Fires the same terminal wake notification
   * every other `mark*` transition does (see `fireJobTerminal`) - a
   * deadline-killed job is exactly as terminal as any other, and a
   * listener waiting on it should not have to special-case this cause.
   */
  markDeadlineExceeded(jobId: string, message: string): void {
    const record = this.jobs.get(jobId);
    if (!record || isTerminalJobState(record.state)) return;
    record.state = "failed";
    record.diagnostic = { reason: "watcher/runtime-error", message };
    const now = new Date().toISOString();
    record.ended_at = now;
    // Same instant as ended_at - see JobRecord.last_updated_at's own docs.
    record.last_updated_at = now;
    this.clearDeadlineTimer(jobId);
    this.fireJobTerminal(jobId);
  }

  /**
   * `starting`/`running` -> `exited` OR `killed`, from the OS's own
   * real, unsolicited `child_process` `exit` event (`run.ts`'s `onExit`
   * callback passes this call's two arguments straight through from Node's
   * own event - see `process.spawnManaged`'s docs). SIGNAL-vs-EXIT: a
   * signalled death (`signal !== null`) -> `killed` + the exact signal
   * name, never `exited`; a normal exit (`signal === null`) -> `exited` +
   * `exitCode`. This covers a death this codebase did NOT itself request
   * through `kill` - an external signal (another process, a shell job
   * control, a crash such as SIGSEGV/SIGABRT) still genuinely killed the
   * job, and `killed` is the honest state for that, not `exited`.
   *
   * This never collides with a REQUESTED kill: `kill.ts`'s own handler
   * calls `markKilled` SYNCHRONOUSLY, right when it sends a signal - before
   * this method's own async `onExit` invocation can ever run - so by the
   * time the job's natural `exit` event reaches here the job is already
   * terminal and this call is a no-op (first write wins, the same
   * terminal-state guard every `mark*` transition here uses). So this
   * method only ever gets to CHOOSE killed-vs-exited for a death this
   * codebase did not request through `kill` at all.
   *
   * Windows note (WINDOWS DISPOSITION, "not POSIX-assumed"): Node's
   * `child_process` `exit` event never delivers a real POSIX `signal` value
   * on Windows (Windows has no POSIX signal delivery mechanism) - a
   * Windows child's exit is always reported through the numeric `code`
   * alone, even one this codebase's own `kill.ts`/`server.ts` win32
   * branches forcefully terminated via `taskkill` (those branches record
   * `killed` themselves, synchronously, via `markKilled`, before this
   * method ever runs - see above). So on Windows this method's `signal`
   * branch is simply never reached in practice; every real Windows
   * `onExit` call this method sees naturally falls into the `exited`+code
   * branch, the REAL disposition Windows reports - never a POSIX-style
   * signal this platform doesn't have.
   *
   * No-op once the job is already terminal, so a late/duplicate event can
   * never overwrite a real result.
   */
  markExited(jobId: string, exitCode: number | null, signal: NodeJS.Signals | null): void {
    const record = this.jobs.get(jobId);
    if (!record || isTerminalJobState(record.state)) return;
    if (signal !== null) {
      record.state = "killed";
      record.signal = signal;
    } else {
      record.state = "exited";
      record.exit_code = exitCode ?? undefined;
    }
    const now = new Date().toISOString();
    record.ended_at = now;
    // Same instant as ended_at - see JobRecord.last_updated_at's own docs.
    record.last_updated_at = now;
    this.clearDeadlineTimer(jobId);
    this.fireJobTerminal(jobId);
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
    const now = new Date().toISOString();
    record.ended_at = now;
    // Same instant as ended_at - see JobRecord.last_updated_at's own docs.
    record.last_updated_at = now;
    this.clearDeadlineTimer(jobId);
    this.fireJobTerminal(jobId);
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

  /**
   * Records a POSIX kill's bounded, external `pgrep`-based process-group
   * confirmation result - see `JobRecord.kill_confirmed`'s own docs for
   * exactly what `true`/`false` mean. A no-op unless the job is ALREADY
   * terminal (broadened from "already `killed`" - see below). On the
   * default path and the terminal-record reap, that means this write
   * never fires before, and never re-triggers, whatever state transition
   * already settled the job - it only ever refines the already-settled
   * result's honesty there. A caller-supplied signal other than `SIGTERM`
   * is different: `src/tools/kill.ts`'s explicit-signal branch calls
   * `markKilled` and this setter back-to-back, in that order, ONLY once
   * its own process-group check result comes back confirmed - so from this
   * setter's own narrow point of view the record is indeed already
   * terminal by the time it runs, but the SAME check this setter's value
   * records is what decided, a line earlier, whether that transition
   * happened at all. This setter is never called for that path while the
   * result is unconfirmed.
   *
   * Broadened from "only a `killed` job" to "any terminal job" so a
   * TERMINAL record whose leader `exited` (or `failed`) on its own can
   * still record an honest reap-confirmation outcome: a real process
   * GROUP where the leader forks descendants and then exits naturally
   * (root-exits-first) can leave those descendants alive under the SAME
   * pgid, and `kill`/the shutdown reaper now attempt a real group-level
   * reap for exactly that case even though the job record itself is
   * already `exited`, not `killed` - see `src/tools/kill.ts`'s own
   * "terminal-record" reap docs. The reap's honest confirmed/unconfirmed
   * outcome deserves the identical disclosure a `killed` job's own reap
   * gets, regardless of which specific terminal disposition the LEADER's
   * own record carries - `kill_confirmed`'s real meaning ("did an
   * external check confirm the job's process group holds zero members")
   * never depended on the record's own `state` in the first place, and
   * never depended on a signal having actually been sent either: the
   * eager reap-at-exit can set this `true` for a job whose group
   * had nothing left to signal at all, so the field is a STATE claim
   * (the group was observed empty), never an ACTION claim (a kill was
   * performed) - see `src/jobStore.ts`'s `reapProcessGroupOnce` docs.
   */
  setKillConfirmation(jobId: string, confirmed: boolean): void {
    const record = this.jobs.get(jobId);
    if (!record || !isTerminalJobState(record.state)) return;
    record.kill_confirmed = confirmed;
  }

  /**
   * Records whether the PRE-signal identity check that ran before `kill`/
   * the shutdown reaper actually signaled this job's process group came
   * back genuinely confirmed, or had to proceed via the honest DEGRADED
   * path - see `JobRecord.identity_confirmed`'s own docs. Same
   * terminal-state guard as `setKillConfirmation` above, for the same
   * reason (never fires before, or re-triggers, the state transition that
   * already settled the job).
   */
  setIdentityConfirmation(jobId: string, confirmed: boolean): void {
    const record = this.jobs.get(jobId);
    if (!record || !isTerminalJobState(record.state)) return;
    record.identity_confirmed = confirmed;
  }

  /**
   * Records the escalation identity gate's own refusal reason - see
   * `JobRecord.escalation_refused_reason`'s own docs for exactly what this
   * discloses and why it is never present when escalation proceeded or
   * was never reached. Same terminal-state guard as `setKillConfirmation`/
   * `setIdentityConfirmation` above: by the time the default terminating
   * path's `killProcessGroupPosix` call resolves, the job's `killed`
   * transition has already happened synchronously (see
   * `src/tools/kill.ts`'s own docs on the kill/exit race), so this always
   * writes onto an already-terminal record - it never gates or precedes
   * that transition, it only ever adds an honest disclosure alongside it.
   */
  setEscalationRefusedReason(jobId: string, reason: string): void {
    const record = this.jobs.get(jobId);
    if (!record || !isTerminalJobState(record.state)) return;
    record.escalation_refused_reason = reason;
  }

  /**
   * True once a real CLEANUP-REAP has already been attempted for this
   * job's terminal record - see `reapAttempted`'s own docs for exactly
   * which paths set this and which of them check it first. Only
   * `reapProcessGroupOnce` checks this before signaling; a live `kill()`
   * signal is never suppressed by a `true` result here, since a caller-
   * requested live signal is not a retry of the cleanup reap.
   */
  hasReapBeenAttempted(jobId: string): boolean {
    return this.reapAttempted.has(jobId);
  }

  /**
   * Records that this job's process group has had a signal delivered to
   * it that this codebase treats as covering the cleanup-reap concern -
   * see `reapAttempted`'s own docs for exactly which signals qualify.
   * Idempotent: setting it again for the same job id is a harmless no-op.
   *
   * `reapProcessGroupOnce` marks this only AFTER awaiting its own reaper
   * call, so an unconfirmed outcome correctly leaves it unset - see that
   * method's own docs. The concurrent-double-signal window this
   * previously reopened (two direct calls for the same job both passing
   * a pre-await guard keyed off this set, or off `kill_confirmed`) is now
   * closed by `reapEntered`, a separate marker written synchronously
   * BEFORE that same `await` - see that field's own docs for why one
   * marker cannot answer both "entered" and "confirmed".
   */
  markReapAttempted(jobId: string): void {
    this.reapAttempted.add(jobId);
  }

  /** See `reapEntered`'s own class-level docs. */
  private hasReapEntered(jobId: string): boolean {
    return this.reapEntered.has(jobId);
  }

  // TEMPORARY diagnostic - exposes hasReapEntered to the test file's own
  // breadcrumb, so an intermittent CI hang on a naturally-exited job can
  // name which branch of reapProcessGroupOnce it's actually taking on a
  // given poll iteration, rather than only that kill_confirmed is still
  // undefined. Remove before any fix ships - see
  // pollUntilKillConfirmed's own matching removal in test/tasks.test.ts.
  hasReapEnteredDiagnostic(jobId: string): boolean {
    return this.hasReapEntered(jobId);
  }

  /** See `reapEntered`'s own class-level docs. */
  private markReapEntered(jobId: string): void {
    this.reapEntered.add(jobId);
  }

  /**
   * Reaps whatever real process-GROUP members might still be alive under a
   * job's own former leader pid - the root-exits-first case: a leader that
   * forks descendants and then exits on its own (never `wait`-ing on them)
   * leaves those descendants alive, orphaned, under the SAME pgid, since
   * the leader's own natural exit does not kill them.
   *
   * Guarded by `hasReapBeenAttempted`/`markReapAttempted`: if a reap has
   * already been attempted for this job - by the eager call `src/tools/
   * run.ts`'s `onExit` wiring makes right at leader-exit, or by a LIVE
   * explicit `kill()` that already signaled this same group directly
   * (`src/tools/kill.ts`) - this is a pure no-op. That is deliberate, not
   * merely an optimization: once the moment of guaranteed continuity (the
   * group has been non-empty, under this exact pgid, since this
   * codebase's own spawn call) has passed, a LATER attempt has no way to
   * tell "these are still our own orphaned descendants" from "an
   * unrelated process later took this recycled number" - see
   * `src/tools/kill.ts`'s own "PID-reuse defense" header section for the
   * disclosed residual this narrows to bounded rather than leaving
   * unbounded.
   *
   * Called from `src/tools/run.ts`'s `onExit` callback (fired off WITHOUT
   * being awaited there) as the PRIMARY path, the instant a job's leader
   * is observed to have exited on its own: at that exact moment ownership
   * continuity is real, since a POSIX pgid cannot be recycled while the
   * group still has a member, and this codebase's own hierarchy has held
   * it continuously since spawn. Also called from `src/tools/kill.ts`'s
   * terminal-record branch, which now serves TWO real cases rather than
   * one: the rare timing window where the eager call above hasn't run yet
   * (a harmless no-op otherwise), and the RETRY path for a job whose
   * earlier `kill()` call left it terminal but genuinely UNCONFIRMED -
   * see `src/tools/kill.ts`'s own `markReapAttempted` call-site docs for
   * why an unconfirmed outcome leaves `hasReapBeenAttempted` `false`
   * rather than permanently spent. In that second case the leader can be
   * very much still alive (a real, SIGTERM-resistant group whose earlier
   * SIGKILL escalation was correctly refused), unlike the root-exits-
   * first case this function was originally written for.
   *
   * RETRY SAFETY - a RETRY call (this function invoked again for a job
   * whose first attempt left `hasReapBeenAttempted` `false`, i.e. an
   * unconfirmed outcome) NEVER signals. Ownership continuity over
   * `handle.pid`'s numeric value is real ONLY at the moment of the FIRST
   * real attempt for a job: the eager root-exits-first call happens
   * essentially synchronously with the leader's own exit, when a POSIX
   * pgid cannot yet have been recycled, since the group (or its
   * descendants) has held it continuously since this codebase's own spawn
   * call. By the time a RETRY runs - `STRANDED_SLOT_RETRY_DELAY_MS` later
   * for the automatic path, or arbitrarily later for a manual `kill()`
   * late-recovery call - that guarantee no longer holds: if the group DID
   * fully empty out between the first attempt and now, its numeric pgid
   * is free for the OS to hand to an unrelated later process group, and a
   * naive re-signal has no way to tell that recycled group from this
   * job's own. `killProcessGroupPosix`'s own escalation identity gate
   * (`evaluateEscalationIdentityGate`) does NOT close this: it compares an
   * identity snapshot taken just before ITS OWN first SIGTERM against one
   * re-read just before ITS OWN follow-up SIGKILL - both within the SAME
   * call, moments apart - and has nothing to say about whether the group
   * that call's FIRST SIGTERM targets is still this job's own, when that
   * call is itself a delayed retry. So a retry here calls
   * `existenceOnlyReaper` (the real default is `confirmProcessGroupReapedPosix`,
   * the same pure, non-signaling `pgrep`-based oracle `killProcessGroupPosix`
   * already uses for its own post-signal confirmation) instead of the
   * signal-capable `reaper`: confirmed-gone is safe to trust and release
   * on (no signal was ever sent, so there is nothing to have mis-targeted),
   * but "still reads alive" can never be signaled again - it stays a
   * permanently disclosed unconfirmed residual instead (`getStrandedSlotCount`).
   * This trades away the ability to eventually force-terminate a
   * genuinely-still-alive, SIGTERM-resistant orphaned descendant group via
   * a delayed automatic retry - accepted, since the alternative is a real
   * possibility of signaling an unrelated process this server never spawned.
   *
   * A no-op when no child was ever attached to this job at all (e.g. a
   * job that started already-`failed` and never reached a real spawn).
   *
   * `graceMs` defaults to the real live-kill grace period
   * (`POSIX_KILL_GRACE_PERIOD_MS`) - callers reaping during shutdown
   * (`src/server.ts`) pass its own, shorter shutdown grace period instead,
   * since this is the same real signal-and-wait sequence either way, just
   * bounded differently for the two real callers' different tolerances.
   *
   * `reaper` defaults to the real `killProcessGroupPosix` and production
   * code never overrides it - the parameter exists solely so a test can
   * substitute a spy, following the same injectable-oracle pattern
   * `src/process.ts`'s own `waitForProcessDeath` already uses for
   * `isAlive`. This is what makes the reap-once guard's own safety
   * claim directly testable without needing the kernel to hand back a
   * chosen pid: a job whose reap has already CONFIRMED empty never
   * signals again, however its numeric pgid may since have been reused -
   * a test calling this twice for the same job with a `reaper` spy that
   * reports confirmed after the first call and would report a live group
   * if it were ever invoked again confirms the spy runs on the first
   * call but never on the second. An UNCONFIRMED first attempt is
   * different and deliberately so: `hasReapBeenAttempted` stays `false`
   * for it (see `reapAttempted`'s own docs), so a SECOND direct call for
   * the same job genuinely re-consults the reaper - this is what makes a
   * bounded automatic retry (`releaseSlot`'s stranded-slot handling) or a
   * manual `kill()` retry a real second chance rather than a guaranteed
   * no-op.
   *
   * Returns a `ReapOutcome` rather than `void` - see that type's own
   * docs, and `reapOutcomeToReleaseDecision`, the one function every
   * caller must use to turn this into a release decision. The
   * `"already-attempted"` case reports the job's actual CURRENT
   * `kill_confirmed` state rather than assuming `true`: `reapAttempted`
   * has writers other than this function's own confirmed path (see that
   * set's class-level docs) that mark it UNCONDITIONALLY, before any
   * confirmation ever lands, so treating every already-attempted hit as
   * "safe" would silently reopen the exact fail-open gap this return
   * type exists to close.
   */
  async reapProcessGroupOnce(
    jobId: string,
    graceMs: number = POSIX_KILL_GRACE_PERIOD_MS,
    reaper: (pid: number, graceMs: number) => Promise<{ readonly confirmed: boolean }> = (
      pid,
      ms
    ) => killProcessGroupPosix(pid, ms),
    existenceOnlyReaper: (pid: number) => Promise<boolean> = confirmProcessGroupReapedPosix
  ): Promise<ReapOutcome> {
    if (this.hasReapBeenAttempted(jobId)) {
      return {
        kind: "already-attempted",
        confirmed: this.jobs.get(jobId)?.kill_confirmed === true,
      };
    }
    const handle = this.getChildHandle(jobId);
    if (handle === undefined) return { kind: "no-child" };

    // TWO conditions, ORed, because they close two DIFFERENT gaps and
    // neither alone covers both: `hasReapEntered` is set SYNCHRONOUSLY
    // below, before the `await reaper(...)` a few lines down, so two
    // calls reaching THIS method for the same job at once (two
    // independently-dispatched public `kill` requests, per the installed
    // MCP SDK's own dispatch - see `reapEntered`'s own class-level docs)
    // cannot both read it as `false`: whichever call's synchronous
    // prologue runs first marks it before yielding, so the second always
    // takes the existence-only retry branch instead of also signaling.
    // But this method is NOT the only signal-capable caller in this
    // codebase - `src/tools/kill.ts`'s own default SIGTERM/escalation
    // path and its custom-signal branch, `src/tools/run.ts`'s
    // `deadline_ms` enforcement, and `src/server.ts`'s shutdown reap each
    // call `killProcessGroupPosix` DIRECTLY, never through this method,
    // and each records its own outcome via `setKillConfirmation` - so
    // `reapEntered` alone is blind to an attempt that already happened
    // through one of THOSE call sites before this call ever ran (the
    // combined-degraded-retry scenario: a live job's first `kill()` call
    // signals via kill.ts's own direct path and settles unconfirmed, the
    // job goes terminal, and a SECOND `kill()` call reaches this method
    // for the first time - `reapEntered` is empty for this job, but a
    // genuine signal-capable attempt already happened). `kill_confirmed
    // !== undefined` is what catches that: every one of those direct
    // callers sets it, confirmed or not, the moment their own attempt
    // resolves.
    const isRetry =
      this.hasReapEntered(jobId) || this.jobs.get(jobId)?.kill_confirmed !== undefined;
    if (isRetry) {
      const confirmed = await existenceOnlyReaper(handle.pid);
      this.setKillConfirmation(jobId, confirmed);
      if (confirmed) {
        this.markReapAttempted(jobId);
        return { kind: "confirmed" };
      }
      return { kind: "unconfirmed" };
    }

    // Marked HERE - synchronously, before the `await` below, in the same
    // tick as the `hasReapEntered` read above - so a concurrent second
    // call sees this immediately rather than only after this call's own
    // reaper settles. This is what actually closes the double-signal
    // window; moving `setKillConfirmation` earlier would not, since
    // `kill_confirmed` also has to keep meaning "confirmed", not
    // "entered" (see `reapEntered`'s own docs for why one field cannot
    // answer both).
    this.markReapEntered(jobId);

    let result: { readonly confirmed: boolean };
    try {
      result = await reaper(handle.pid, graceMs);
    } catch (err) {
      // A thrown first signal-capable attempt already marked `reapEntered`
      // above, so a concurrent or later call still correctly takes the
      // retry branch. It still gets `kill_confirmed: false` here too,
      // exactly like an ordinary `confirmed: false` return, so
      // `getStrandedSlotCount` and everything else that reads
      // `kill_confirmed` sees the same "attempted, unconfirmed" shape
      // either way.
      this.setKillConfirmation(jobId, false);
      throw err;
    }
    this.setKillConfirmation(jobId, result.confirmed);
    if (result.confirmed) {
      this.markReapAttempted(jobId);
      return { kind: "confirmed" };
    }
    return { kind: "unconfirmed" };
  }

  /**
   * Appends one raw data chunk from a job's stdout or stderr to that
   * stream's independent buffer, firing any registered `onOutputArrival`
   * listeners for `jobId` once per line materialized (see that method's
   * own docs). Once `jobId` is in `retentionEvicted` - see that field's
   * own docs for why: a child's `exit` (which can make a job
   * retention-eligible) and its stdout/stderr `end` are independent,
   * unordered events, so a chunk can legitimately still be in flight for a
   * stream whose job `sweepRetention` has already reclaimed - the chunk is
   * never materialized into a line or added to `pending` (this store has
   * told every caller the stream is empty, and honoring that is the whole
   * point of reclaiming it), but its raw byte count is STILL added to
   * `bytesEverReceived`: that counter's own doc promises "total raw bytes
   * EVER received," full stop, and silently exempting post-reclamation
   * bytes from it would make the promise false the moment retention drops
   * anything. Counting bytes costs nothing extra a caller can observe
   * (`bytesEverReceived` is a plain running total, decoupled from line
   * materialization by design - see its own docs) and keeps this store's
   * one truly unconditional counter unconditional.
   *
   * This arrival is ALSO its own loss event, registered the same way
   * `evictAllLines`'s pending-fragment branch registers one (see that
   * function's own docs): `truncated = true`, `droppedCount += 1`, every
   * time this branch runs, so a stream that was genuinely empty at the
   * moment its job was reclaimed - and would otherwise stay silently
   * indistinguishable from one that never received output at all, the
   * instant this specific arrival is the first thing to break that - gets
   * the same honest, in-band `output`/`tail` signal a reclaimed line or a
   * reclaimed pending fragment already gets. `headSeq` is untouched here
   * too, for the identical reason: this chunk never receives a `seq`.
   */
  appendOutput(jobId: string, stream: ManagedStream, chunk: Buffer): void {
    const buffers = this.buffers.get(jobId);
    if (!buffers) return;
    if (this.retentionEvicted.has(jobId)) {
      const buf = buffers[stream];
      buf.bytesEverReceived += chunk.length;
      buf.truncated = true;
      buf.droppedCount += 1;
      return;
    }
    appendChunkToBuffer(buffers[stream], chunk, this.lineMaterializedNotifier(jobId, stream));
  }

  /**
   * Call when a job's stdout or stderr stream has ended, to flush any
   * pending partial final line - this too fires `onOutputArrival`
   * listeners if that flush materializes a line (see
   * `finalizeStreamBuffer`'s own docs on the `stream-end` case). Skipped
   * entirely once `jobId` is in `retentionEvicted` - DEFENSE-IN-DEPTH,
   * not independently necessary today (measured): `evictAllLines` (see
   * its own docs) always empties `pending` on reclaim, and `appendOutput`
   * above's own guard is what prevents `pending` ever becoming non-empty
   * again for a reclaimed job, so `finalizeStreamBuffer`'s own internal
   * `pending.length > 0` check already blocks this call from
   * materializing anything by the time it would ever run here. Kept
   * anyway as a second, independent check against the same invariant.
   */
  finalizeStream(jobId: string, stream: ManagedStream): void {
    if (this.retentionEvicted.has(jobId)) return;
    const buffers = this.buffers.get(jobId);
    if (!buffers) return;
    finalizeStreamBuffer(buffers[stream], this.lineMaterializedNotifier(jobId, stream));
  }

  /** Built fresh per call rather than cached - cheap (a closure over two primitives plus one live Map read), and it always reflects whoever is subscribed AT THE MOMENT a line actually materializes, never a stale membership snapshot taken earlier. `undefined` when nobody is subscribed, so `appendChunkToBuffer`/`finalizeStreamBuffer` skip the per-line `onOutputArrival` FORWARDING entirely for the (overwhelmingly common) case of no subscriber - but see `lineMaterializedNotifier` below, which is what `appendOutput`/`finalizeStream` actually pass in: the `last_updated_at` touch is NOT gated on this, since it must happen regardless of whether anyone is watching (a `tasks/get` on a job nobody ever subscribed a watch to must still report an accurate value). */
  private arrivalNotifier(
    jobId: string,
    stream: ManagedStream
  ): ((line: StreamLineEntry) => void) | undefined {
    const listeners = this.outputArrivalListeners.get(jobId);
    if (!listeners || listeners.size === 0) return undefined;
    return (line: StreamLineEntry) => {
      for (const listener of listeners) listener({ stream, line });
    };
  }

  /**
   * The real callback `appendOutput`/`finalizeStream` pass into
   * `appendChunkToBuffer`/`finalizeStreamBuffer` for every materialized
   * line - UNCONDITIONALLY (never `undefined`, unlike `arrivalNotifier`
   * alone), because it has two jobs, only one of which is optional:
   * touching `JobRecord.last_updated_at` (see that field's own docs) runs
   * on EVERY materialized line regardless of whether any `onOutputArrival`
   * consumer is subscribed - a task record's `lastUpdatedAt` must be
   * accurate for a plain poll (`tasks/get`) even on a connection that never
   * started a watch at all (see `src/tasksAdapter.ts`'s own docs on why
   * `tasks/get` needs no capability check) - while forwarding to real
   * `onOutputArrival` listeners stays exactly as optional as before, via
   * `arrivalNotifier`'s own `undefined`-when-nobody's-subscribed shape.
   * `arrivalNotifier` is looked up ONCE per call (not once per line), the
   * same cost shape it always had.
   */
  private lineMaterializedNotifier(
    jobId: string,
    stream: ManagedStream
  ): (line: StreamLineEntry) => void {
    const forwardToListeners = this.arrivalNotifier(jobId, stream);
    return (line: StreamLineEntry) => {
      this.touchLastUpdatedAt(jobId);
      forwardToListeners?.(line);
    };
  }

  /** Stamps `JobRecord.last_updated_at` to the current instant - see that field's own docs for every real writer. A safe no-op for an unknown job id (the same "unknown ids are safely ignored" convention `appendOutput`/`finalizeStream`/`getStreamSnapshot` already use), which is reachable here only defensively (a line can only ever materialize for a job whose buffers - and therefore whose record - already exist). */
  private touchLastUpdatedAt(jobId: string): void {
    const record = this.jobs.get(jobId);
    if (record) record.last_updated_at = new Date().toISOString();
  }

  /**
   * Subscribes `listener` to fire, synchronously and in materialization
   * order, for EVERY stdout/stderr line `jobId` ever materializes from
   * this call onward - a real-time observation seam over the SAME
   * `appendChunkToBuffer`/`finalizeStreamBuffer` machinery every stream
   * read already goes through, never a second/derived buffer. Generic:
   * carries no meaning about WHICH stream matters, WHY a line matters, or
   * what a subscriber does with it - `src/tasksAdapter.ts` is the one real
   * consumer today (its output-driven wake), but nothing here is Tasks-
   * shaped. Returns an unsubscribe function; calling it stops further
   * delivery to `listener` but never affects the underlying buffer or any
   * OTHER subscriber on the same job.
   */
  onOutputArrival(jobId: string, listener: OutputArrivalListener): () => void {
    let listeners = this.outputArrivalListeners.get(jobId);
    if (!listeners) {
      listeners = new Set();
      this.outputArrivalListeners.set(jobId, listeners);
    }
    const registered = listeners;
    registered.add(listener);
    return () => {
      registered.delete(listener);
    };
  }

  /**
   * Subscribes `listener` to fire EXACTLY ONCE, the moment `jobId`'s state
   * transitions into a terminal one (`markExited`/`markKilled`/
   * `markSpawnFailed`/`markDeadlineExceeded` - see each of their own docs;
   * all four call `fireJobTerminal` as their last step, only when they
   * themselves actually performed the transition, never on a no-op call
   * against an already-terminal job). A job that is ALREADY terminal at subscribe
   * time never fires this listener at all - it already had its one
   * transition before anyone was listening; a caller that cares should
   * check `get`/`has` itself first, matching this store's other reads.
   * Generic - carries no Tasks-specific meaning, just "this job's state
   * just became terminal"; the caller decides what that means. Returns an
   * unsubscribe function.
   */
  onJobTerminal(jobId: string, listener: JobTerminalListener): () => void {
    let listeners = this.jobTerminalListeners.get(jobId);
    if (!listeners) {
      listeners = new Set();
      this.jobTerminalListeners.set(jobId, listeners);
    }
    const registered = listeners;
    registered.add(listener);
    return () => {
      registered.delete(listener);
    };
  }

  private fireJobTerminal(jobId: string): void {
    const listeners = this.jobTerminalListeners.get(jobId);
    if (!listeners || listeners.size === 0) return;
    // Copy before iterating: a listener is free to call its own
    // unsubscribe function (or another listener's) from inside itself,
    // which would otherwise mutate this Set mid-iteration.
    for (const listener of [...listeners]) listener(jobId);
  }

  /** Records why a consumer of `onOutputArrival` stopped watching `jobId` - see `OutputWatchStopInfo`'s own docs for why this store never interprets `reason`. Overwrites any prior recording for the same job (there is only ever one "why did the watch stop" fact worth keeping). */
  recordOutputWatchStopped(jobId: string, reason: string, stoppedAt: string): void {
    this.outputWatchStops.set(jobId, { reason, stoppedAt });
  }

  /** The watch-stop annotation previously recorded for `jobId` via `recordOutputWatchStopped`, or `undefined` if none was ever recorded (the overwhelmingly common case - most jobs' output watches, if any existed at all, simply run to the job's own terminal without ever needing to stop early). */
  getOutputWatchStopInfo(jobId: string): OutputWatchStopInfo | undefined {
    return this.outputWatchStops.get(jobId);
  }

  /** The number of listeners currently registered via `onJobTerminal` for `jobId` - 0 if none, or if `jobId` is unknown. A real oracle for a subscriber's own cleanup: a consumer that unsubscribes correctly leaves this at 0 once it is done with the job, regardless of which code path triggered that cleanup. */
  getJobTerminalListenerCount(jobId: string): number {
    return this.jobTerminalListeners.get(jobId)?.size ?? 0;
  }

  /** The number of listeners currently registered via `onOutputArrival` for `jobId` - 0 if none, or if `jobId` is unknown. The same real-oracle role `getJobTerminalListenerCount` plays for its own subscriber count, applied to the other listener map this store owns. */
  getOutputArrivalListenerCount(jobId: string): number {
    return this.outputArrivalListeners.get(jobId)?.size ?? 0;
  }

  /**
   * Admits ONE more `follow` call against this store's process-wide budget
   * (`MAX_OUTSTANDING_FOLLOWS`), or refuses it outright - the caller's own
   * signal to reject the call rather than let it subscribe anything at
   * all. Returns `true` and increments `outstandingFollowCount`, in the
   * SAME synchronous call, when there is room; returns `false` and leaves
   * the counter untouched otherwise. `src/tools/follow.ts`'s handler calls
   * this exactly once per call, AFTER its own already-aborted-signal early
   * return and BEFORE subscribing any output/terminal listener - a refused
   * admission must never leave anything behind to clean up. See
   * `releaseFollowAdmission`'s own docs for the matching release contract
   * every successful admission owes.
   */
  tryAdmitFollow(): boolean {
    if (this.outstandingFollowCount >= MAX_OUTSTANDING_FOLLOWS) return false;
    this.outstandingFollowCount += 1;
    return true;
  }

  /**
   * Releases ONE admission slot previously granted by `tryAdmitFollow`.
   * MUST be called EXACTLY ONCE per successful `tryAdmitFollow()` call, on
   * EVERY path that call's own `follow` invocation can end on - natural
   * settlement (output/terminal/timeout), an abort, or the handler
   * throwing/crashing before it ever settles. A caller that admits and
   * never releases leaks one unit of budget forever, permanently shrinking
   * how many `follow` calls this process can ever serve at once again; a
   * caller that releases WITHOUT a matching prior admission corrupts this
   * counter into the negative, silently granting extra budget nobody
   * actually freed. Because of that second failure mode, this method has
   * no way to detect a mismatched call and does not try to - `follow.ts`'s
   * own handler tracks LOCALLY (a boolean, set only on a genuine
   * `tryAdmitFollow() === true`) whether it actually holds a slot before
   * ever calling this.
   */
  releaseFollowAdmission(): void {
    this.outstandingFollowCount -= 1;
  }

  /**
   * How many `follow` calls currently hold an admission slot - a test
   * oracle, matching `getJobTerminalListenerCount`'s own real-oracle role:
   * a caller that admits and releases correctly leaves this at 0 once
   * every one of its `follow` calls has ended, regardless of which path
   * (settlement, abort, rejection) each one took.
   */
  getOutstandingFollowCount(): number {
    return this.outstandingFollowCount;
  }

  /**
   * Permanently removes EVERY piece of state this store holds for `jobId`
   * - the job record itself, its tracked child handle (if any), both
   * stream buffers, every registered output-arrival/job-terminal
   * listener, any recorded output-watch-stop annotation, its
   * `slotReserved`/`slotReleased` dedupe entries, its `strandedSlots`
   * entry INCLUDING clearing any pending automatic-retry timer, its
   * `reapEntered` entry, and its `retentionEvicted` entry (if any of
   * these was ever set for `jobId` at all - a preflight-failed job
   * (`createFailedJob`) or one that was rejected outright never gets a
   * `slotReserved` entry in the first place, and `Set.delete`/`Map.delete`
   * on a missing entry is already a harmless no-op; a job admitted into
   * the queue but cancelled before ever being dequeued does NOT carry a
   * `slotReserved` entry by the time it reaches here either - `enqueueJob`
   * already removed it, the moment the job was queued, for exactly this
   * reason (see its own docs) - and it never carries a `slotReleased`,
   * `strandedSlots`, or `reapEntered` entry, since a later `releaseSlot`
   * call against it is refused by the now-absent `slotReserved` entry).
   * All five matter on a long-running server: `slotReleased` is add-only
   * everywhere but here, `slotReserved` moves between
   * `createJob`/`enqueueJob`/`dequeueNext` (see their own docs) besides
   * this method, `strandedSlots` likewise only grows via
   * `markSlotStranded`, `reapEntered` only ever grows via
   * `reapProcessGroupOnce`'s own signal-capable branch, and
   * `retentionEvicted` only ever grows via `sweepRetention` - none of
   * them ever cleared by anything else this store does - so
   * this is the ONE place anything is ever removed from any of them
   * (`reapPending` is the one exception - `releaseSlot`'s own `finally`
   * clears it in the ordinary case, so this call is a defensive backstop
   * for the case where a job's record is force-deleted while a reap
   * decision is still outstanding, not the structure's primary clear
   * path) - without it,
   * every job that ever ran and was later purged would leave a permanent
   * entry behind (unbounded linear growth in exactly the store whose
   * whole purpose is bounding resource use), and an uncleared retry timer
   * would fire later against a job no longer in the store at all
   * (`retryStrandedSlot`'s own no-op guard makes that harmless, but
   * leaving a live timer running past its job's own lifetime is still
   * real, needless work this store can just as easily cancel here). A
   * one-way reclamation primitive: after this call,
   * `has`/`get`/`getStreamSnapshot`/`getOutputCounts`/`getSlotReleasedCount`/
   * `getStrandedSlotCount`/`getReapEnteredCount`/`getRetentionEvictedCount`
   * all behave EXACTLY as if
   * `jobId` had never existed. Generic - this store has no opinion on WHY a caller reclaims
   * a job (a task-layer TTL purge is the one real caller today, see
   * `src/tasksAdapter.ts`'s `getTask`, but nothing here is Tasks-
   * specific). Returns whether a job actually existed to remove.
   *
   * DELETING A STRANDED JOB IS THE CALLER'S OWN CHOICE, NEVER THIS
   * METHOD'S: this store still holds `activeSlots` as a store-wide
   * counter entirely separate from any one job's own record, so removing
   * a stranded job's record here does NOT and cannot decrement it -
   * `activeSlots` stays held, permanently, with every piece of state that
   * could ever have recovered or even observed that held slot now gone
   * (`isJobSlotStranded` would report `false` afterward not because the
   * slot was freed, but because there is nothing left to ask). This
   * method does not refuse that call - a caller with a genuine reason to
   * force-delete even a stranded job's record (an explicit operator
   * action, say) can still do so - but it does not happen implicitly via
   * this generic primitive either: `src/tasksAdapter.ts`'s lazy TTL purge,
   * the one real caller today, checks `isJobSlotStranded` itself before
   * ever reaching this call (see that file's own `isExpiredTerminalRecord`
   * docs) precisely so an unattended, time-based purge can never be the
   * thing that silently strands a slot forever.
   */
  deleteJob(jobId: string): boolean {
    const existed = this.jobs.delete(jobId);
    this.children.delete(jobId);
    this.buffers.delete(jobId);
    this.outputArrivalListeners.delete(jobId);
    this.jobTerminalListeners.delete(jobId);
    this.outputWatchStops.delete(jobId);
    this.slotReleased.delete(jobId);
    this.slotReserved.delete(jobId);
    const stranded = this.strandedSlots.get(jobId);
    if (stranded?.retryTimer !== undefined) clearTimeout(stranded.retryTimer);
    this.strandedSlots.delete(jobId);
    this.reapEntered.delete(jobId);
    this.retentionEvicted.delete(jobId);
    this.reapPending.delete(jobId);
    return existed;
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
      stdout_lines: buffers.stdout.linesEverMaterialized,
      stdout_bytes: buffers.stdout.bytesEverReceived,
      stderr_lines: buffers.stderr.linesEverMaterialized,
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
