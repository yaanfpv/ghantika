/**
 * The job-lifecycle POLICY module: admission (the concurrency-cap +
 * FIFO-queue policy that sits in front of `run()`'s real spawn) and
 * retention (which TERMINAL jobs a busy, long-running server reclaims,
 * and when - see "Retention" below). Two different questions about the
 * same jobs at two different ends of their life, sharing this file
 * because both are pure decisions over config the caller already holds,
 * not because they are the same policy.
 *
 * This module deliberately holds NO state of its own - not a counter, not a
 * queue array, nothing. `src/jobStore.ts` is this codebase's designated sole
 * owner of persistent state (see that file's own header, and
 * `scripts/check-module-boundaries.mjs`'s persistent-state scan, which
 * enforces the same rule mechanically across every other root module,
 * this one included). So every function here is a PURE computation over
 * plain numbers/config the CALLER already holds: `src/jobStore.ts` owns the
 * real `activeSlots` count, the real FIFO queue array, and the real job
 * map, and calls into this module to DECIDE what to do with them. This
 * module decides, jobStore.ts remembers.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ConcurrencyConfig {
  /**
   * How many jobs may be LIVE (spawned and not yet reaped - see
   * `src/jobStore.ts`'s own `releaseSlot` docs for exactly what "reaped"
   * means here) at once. Frozen legal range: any non-negative integer.
   * `0` is a real, deliberate boundary - "no concurrency capacity at all" -
   * not a disallowed value: see `decideAdmission`'s own docs for why it is
   * handled as its own branch rather than falling out of the general
   * cap/queue arithmetic.
   */
  readonly maxConcurrentJobs: number;
  /**
   * How many NOT-YET-SPAWNED jobs may wait in the FIFO queue at once, once
   * the concurrency cap above is full. Frozen legal range: any
   * non-negative integer. `0` means no queue at all - anything arriving
   * once the cap is full is rejected immediately rather than queued.
   */
  readonly maxQueueDepth: number;
}

/**
 * Sensible defaults, used whenever a configured value is absent or fails
 * `normalizeNonNegativeInteger`'s own validation. Deliberately >= 1 (a
 * server that comes up with no explicit configuration should be able to
 * run real jobs out of the box, never silently start at "no capacity at
 * all") and a generous, non-restrictive queue depth.
 */
export const DEFAULT_MAX_CONCURRENT_JOBS = 8;
export const DEFAULT_MAX_QUEUE_DEPTH = 32;

/**
 * Validates/coerces a single configured value against this module's frozen
 * range (any non-negative integer) - used for BOTH an environment-variable
 * string (`loadConcurrencyConfigFromEnv`) and a caller-supplied config
 * object (`normalizeConcurrencyConfig`), so the same rule governs a value
 * regardless of where it came from. A value that is missing, blank, not a
 * finite number once coerced, not a SAFE integer, or negative falls back to
 * `fallback` rather than being clamped to some nearby legal value or
 * thrown on - an out-of-range config is treated the same as an absent one
 * (a known-good default), never silently rounded/floored into a different
 * number the caller never actually asked for.
 *
 * Two deliberate guards before the numeric coercion/range checks below:
 *
 * - A present-but-BLANK-or-whitespace-only string is treated exactly like
 *   an absent value, never like an explicit `"0"`. `Number("")` and
 *   `Number(" ")` both coerce to `0` in JavaScript, so without this an
 *   operator who left `GHANTIKA_MAX_CONCURRENT_JOBS` set-but-empty (or
 *   whitespace) would silently get "no concurrency capacity at all"
 *   instead of the documented default - indistinguishable from having
 *   deliberately typed `"0"`. Only a `string` value can be blank this way;
 *   a genuinely absent (`undefined`) value already falls back via the
 *   `typeof numeric !== "number"` check below, unaffected by this guard.
 * - `Number.isSafeInteger` (not `Number.isInteger`) governs the range
 *   check, because `Number.isInteger` alone accepts an integer so large it
 *   already lost precision in the `Number()` coercion above - e.g.
 *   `Number("9007199254740993") === 9007199254740992`, which still passes
 *   `Number.isInteger` even though it silently is not the exact value that
 *   was configured. `Number.isSafeInteger` rejects anything outside
 *   +/-(2^53 - 1), the largest integer a double can represent exactly, so
 *   a value that large falls back to the documented default rather than
 *   being silently accepted as if it were precise.
 */
export function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value === "string" && value.trim() === "") return fallback;
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return fallback;
  if (!Number.isSafeInteger(numeric) || numeric < 0) return fallback;
  return numeric;
}

/** Applies `normalizeNonNegativeInteger` to both fields of a caller-supplied config - the single place both fields' validation is applied together, so a fresh `JobStore` and a runtime reconfiguration (`JobStore.setConcurrencyConfig`) can never drift on what "a valid config" means. */
export function normalizeConcurrencyConfig(config: ConcurrencyConfig): ConcurrencyConfig {
  return {
    maxConcurrentJobs: normalizeNonNegativeInteger(
      config.maxConcurrentJobs,
      DEFAULT_MAX_CONCURRENT_JOBS
    ),
    maxQueueDepth: normalizeNonNegativeInteger(config.maxQueueDepth, DEFAULT_MAX_QUEUE_DEPTH),
  };
}

const MAX_CONCURRENT_JOBS_ENV_VAR = "GHANTIKA_MAX_CONCURRENT_JOBS";
const MAX_QUEUE_DEPTH_ENV_VAR = "GHANTIKA_MAX_QUEUE_DEPTH";

/**
 * The real, production way a fresh `JobStore` is configured: read once,
 * from the server process's own environment, at construction time. An
 * absent or invalid variable falls back to the sensible defaults above -
 * see `normalizeNonNegativeInteger`'s own docs for exactly what counts as
 * invalid.
 */
export function loadConcurrencyConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): ConcurrencyConfig {
  return normalizeConcurrencyConfig({
    maxConcurrentJobs: normalizeNonNegativeInteger(
      env[MAX_CONCURRENT_JOBS_ENV_VAR],
      DEFAULT_MAX_CONCURRENT_JOBS
    ),
    maxQueueDepth: normalizeNonNegativeInteger(
      env[MAX_QUEUE_DEPTH_ENV_VAR],
      DEFAULT_MAX_QUEUE_DEPTH
    ),
  });
}

// ---------------------------------------------------------------------------
// Admission decision
// ---------------------------------------------------------------------------

export type AdmissionRejectionReason = "no-capacity" | "queue-full" | "shutting-down";

export type AdmissionDecision =
  | { readonly kind: "admit" }
  | { readonly kind: "queue" }
  | {
      readonly kind: "reject";
      readonly reason: AdmissionRejectionReason;
      readonly message: string;
    };

/**
 * The whole concurrency-cap + queue-depth + shutdown admission policy, as
 * one pure function of the caller's own current counts and shutdown state:
 *
 * - `activeCount`: how many jobs currently hold a slot (spawned and not
 *   yet reaped) - `src/jobStore.ts`'s own count, never re-derived here.
 * - `queueLength`: how many jobs are currently waiting in the FIFO queue.
 * - `shuttingDown`: whether the server has begun shutting down - see
 *   `src/jobStore.ts`'s `beginShutdown` docs for exactly when this flips
 *   and why it has to gate admission from that instant on, not just at
 *   the moment the queue happens to get drained.
 *
 * Outcomes, in this exact priority order:
 *
 * 1. `shuttingDown` - the server is on its way down. Every job is
 *    rejected outright, regardless of the cap/queue's own state. Shutdown
 *    drains whatever is already in the queue exactly ONCE
 *    (`drainQueueOnShutdown`) and never revisits it, so admitting or
 *    queueing anything after that point would strand it - there is no
 *    later moment this policy gets asked again on the way down.
 * 2. `maxConcurrentJobs === 0` - NO capacity exists, ever (a permanent
 *    zero, never a transient "full"). Every job is rejected outright,
 *    regardless of `queueLength`/`maxQueueDepth`. This has to be its own
 *    branch, checked next: without it, a configured `maxQueueDepth > 0`
 *    would happily queue a job that can NEVER be admitted (since
 *    `activeCount` can never fall below a cap that is already `0`),
 *    stranding it in `starting` forever - a real boundary case this
 *    function has to handle explicitly rather than let fall out of the
 *    general cap/queue arithmetic.
 * 3. `queueLength === 0 && activeCount < maxConcurrentJobs` - a real slot
 *    is free right now, AND nothing is already ahead of this job in line -
 *    admit immediately. The `queueLength === 0` half matters: if anything
 *    is already queued, a newly arriving job must go BEHIND it (see
 *    `queue` below), never jump ahead just because a transiently-freed
 *    slot happens to exist at this exact instant (e.g. right after an
 *    operator raises the cap while jobs are already waiting) - this keeps
 *    FIFO ordering an invariant rather than a usual case.
 * 4. `queueLength < maxQueueDepth` - no free slot (or something is already
 *    queued ahead of this job), but the queue has room - queue it.
 *    `maxQueueDepth === 0` makes this branch unreachable by construction,
 *    which is exactly "no queue at all."
 * 5. Otherwise - no free slot and no queue room - reject.
 */
export function decideAdmission(
  activeCount: number,
  queueLength: number,
  config: ConcurrencyConfig,
  shuttingDown = false
): AdmissionDecision {
  const { maxConcurrentJobs, maxQueueDepth } = config;

  if (shuttingDown) {
    return {
      kind: "reject",
      reason: "shutting-down",
      message: "the server is shutting down and is no longer admitting or queueing new jobs",
    };
  }

  if (maxConcurrentJobs === 0) {
    return {
      kind: "reject",
      reason: "no-capacity",
      message: "no concurrency capacity is configured (max_concurrent_jobs is 0)",
    };
  }

  if (queueLength === 0 && activeCount < maxConcurrentJobs) {
    return { kind: "admit" };
  }

  if (queueLength < maxQueueDepth) {
    return { kind: "queue" };
  }

  return {
    kind: "reject",
    reason: "queue-full",
    message:
      `the concurrency cap (${maxConcurrentJobs}) is full and the queue ` +
      `(max ${maxQueueDepth}) has no room (currently ${queueLength} queued)`,
  };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Retention config for a TERMINAL job's buffered OUTPUT, held in `jobStore`
 * (the job's own record - state, exit code, timestamps - is never deleted
 * by this; see `jobStore.ts`'s `sweepRetention`). Deliberately separate
 * from the task-record TTL (`src/tasksAdapter.ts`'s `TASK_TTL_MS`, a
 * different lifecycle gating the `tasks/*` API) and from concurrency-slot
 * release (`ConcurrencyConfig` above). The three lifecycles stay distinct,
 * and two guards defer their own reclamation while a job's concurrency
 * slot is STRANDED - the task-record TTL purge
 * (`src/tasksAdapter.ts`'s `isExpiredTerminalRecord`) and this output-
 * retention sweep (`jobStore.ts`'s `sweepRetention`) - because purging
 * that state would destroy the only recoverable trace of a slot still
 * held. The two guards are NOT symmetric beyond that: this output-
 * retention sweep ALSO defers while a reap decision is still pending
 * (`jobStore.ts`'s `reapPending`, awaited-but-not-yet-settled - a
 * narrower and earlier window than confirmed-stranded), while the
 * task-record TTL purge checks confirmed-stranded only and has no
 * equivalent reap-pending check. Any future lifecycle that reclaims
 * job-tied state is expected to defer for a stranded slot at minimum,
 * never exempt by default; every other cross-gate interaction remains
 * forbidden.
 */
export interface RetentionConfig {
  /** How long a terminal job's output is kept, from `ended_at`, before it becomes eligible for reclamation. */
  readonly retentionMs: number;
  /** How many terminal jobs' output `jobStore` retains at once. Once exceeded, the OLDEST-`ended_at` terminal jobs' output is reclaimed first, down to this count. */
  readonly maxRetainedJobs: number;
}

/** 1 hour - job output is normally read shortly after a job ends; a much longer default just delays discovering an unbounded-growth misconfiguration. Independent of `TASK_TTL_MS` (24h) by design (see `RetentionConfig`'s own docs). */
export const DEFAULT_RETENTION_MS = 60 * 60 * 1000;
/** Generous, non-restrictive - matches this file's own `DEFAULT_MAX_QUEUE_DEPTH` tone. */
export const DEFAULT_MAX_RETAINED_JOBS = 200;

export function normalizeRetentionConfig(config: RetentionConfig): RetentionConfig {
  return {
    retentionMs: normalizeNonNegativeInteger(config.retentionMs, DEFAULT_RETENTION_MS),
    maxRetainedJobs: normalizeNonNegativeInteger(config.maxRetainedJobs, DEFAULT_MAX_RETAINED_JOBS),
  };
}

const RETENTION_MS_ENV_VAR = "GHANTIKA_JOB_RETENTION_MS";
const MAX_RETAINED_JOBS_ENV_VAR = "GHANTIKA_MAX_RETAINED_JOBS";

export function loadRetentionConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): RetentionConfig {
  return normalizeRetentionConfig({
    retentionMs: normalizeNonNegativeInteger(env[RETENTION_MS_ENV_VAR], DEFAULT_RETENTION_MS),
    maxRetainedJobs: normalizeNonNegativeInteger(
      env[MAX_RETAINED_JOBS_ENV_VAR],
      DEFAULT_MAX_RETAINED_JOBS
    ),
  });
}

/** One terminal job as this decision needs to see it - never the real `JobRecord` (that stays `jobStore.ts`'s own type, this module only ever sees plain numbers/strings). */
export interface RetainedJobSummary {
  readonly jobId: string;
  readonly endedAtMs: number;
}

/**
 * ONE retention predicate: a terminal job's output is eligible for
 * reclamation once `retentionMs` ELAPSES since `ended_at`, OR once the
 * `maxRetainedJobs` cap is exceeded (oldest-`ended_at` first), WHICHEVER
 * FIRST - purely time + cap, never gated on whether/how a caller has read
 * the job (no ack operation, no 7th tool; see `src/jobStore.ts`'s own docs
 * on why reading via `output`/`tail` never resets this clock).
 *
 * This function is a pure decision, evaluated against whatever `now` its
 * caller supplies - it does not itself run on any schedule. How promptly
 * a caller actually reaches this function depends on how often it is
 * invoked: `jobStore.ts`'s `sweepRetention` calls it both opportunistically
 * (on every `createJob`/`createFailedJob`, for immediacy) and from a
 * periodic timer (`startRetentionSweeper`, scheduled every
 * `RETENTION_SWEEP_INTERVAL_MS` so an otherwise-idle server still gets
 * checked) - see that file's own docs for why the timer's cadence is a
 * schedule, not a guaranteed wall-clock ceiling on when a check actually
 * runs.
 *
 * `jobs` must already exclude anything this predicate must never touch.
 * The real caller (`jobStore.ts`'s `sweepRetention`) applies six checks
 * before a job ever reaches this function, and this function trusts every
 * one of them rather than re-deriving any: (1) a non-terminal
 * (still-running) job is never terminal in the first place; (2) a job
 * that has never received a single byte on either stream (cumulative
 * `bytesEverReceived === 0`, checked once per stream, never
 * decremented - see that field's own docs) has nothing to reclaim and
 * must not occupy a `maxRetainedJobs` slot it would only ever displace
 * real output from - this is a check on bytes EVER received, not on
 * current content, so it says nothing about whether a job still holds
 * anything retrievable right now; (3) a job whose concurrency slot is currently
 * STRANDED (mirrors `src/tasksAdapter.ts`'s `isExpiredTerminalRecord`
 * guard) keeps its output, since reclaiming it would erase the only
 * durable trace of a held slot; (4) a job whose process-group reap
 * decision is still being awaited (`jobStore.ts`'s `reapPending` - a
 * narrower, earlier window than confirmed-stranded) is excluded for the
 * identical reason; (5) a job already in `jobStore.ts`'s own
 * `retentionEvicted` bookkeeping is skipped, INDEPENDENTLY of check 2:
 * check 2 tests cumulative bytes-ever-received, which reclaiming a job's
 * output never resets (see that field's own docs), so a reclaimed job
 * keeps passing check 2 forever and this is the only check that actually
 * excludes it; (6) two purely defensive checks (`ended_at` present,
 * `Date.parse` succeeds) that every real terminal record satisfies by
 * construction.
 * This function only ever ranks and picks from the survivors of all six.
 *
 * Two passes: every job whose age already exceeds `retentionMs` is
 * returned unconditionally (the time half of "whichever first"); THEN, if
 * the remaining survivors still outnumber `maxRetainedJobs`, the
 * oldest-`endedAtMs` surplus among them is returned too (the cap half). A
 * job can appear only once in the result, and eviction order within each
 * pass is oldest-`endedAtMs` first (ties broken by `jobId` for a
 * deterministic result over an unordered input).
 */
export function decideRetentionEvictions(
  jobs: readonly RetainedJobSummary[],
  now: number,
  config: RetentionConfig
): string[] {
  const byAge = [...jobs].sort(
    (a, b) => a.endedAtMs - b.endedAtMs || a.jobId.localeCompare(b.jobId)
  );

  // No Map/Set here (`scripts/check-module-boundaries.mjs` reserves those
  // for `jobStore.ts` alone) - plain arrays suffice, since membership is
  // never queried, only accumulated and returned.
  const evicted: string[] = [];
  const survivors: RetainedJobSummary[] = [];
  for (const job of byAge) {
    if (now - job.endedAtMs >= config.retentionMs) {
      evicted.push(job.jobId);
    } else {
      survivors.push(job);
    }
  }

  const overflow = survivors.length - config.maxRetainedJobs;
  if (overflow > 0) {
    for (const job of survivors.slice(0, overflow)) evicted.push(job.jobId);
  }
  return evicted;
}
