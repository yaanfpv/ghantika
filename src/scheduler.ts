/**
 * The concurrency-cap + FIFO-queue admission POLICY that sits in front of
 * `run()`'s real spawn - a bound on how many jobs can be live (spawned and
 * not yet reaped) at once, plus a bounded FIFO queue for a job that arrives
 * while the cap is full.
 *
 * This module deliberately holds NO state of its own - not a counter, not a
 * queue array, nothing. `src/jobStore.ts` is this codebase's designated sole
 * owner of persistent state (see that file's own header, and
 * `scripts/check-module-boundaries.mjs`'s persistent-state scan, which
 * enforces the same rule mechanically across every other root module,
 * this one included). So every function here is a PURE computation over
 * plain numbers/config the CALLER already holds: `src/jobStore.ts` owns the
 * real `activeSlots` count and the real FIFO queue array, and calls into
 * this module to DECIDE what to do with them. This module decides,
 * jobStore.ts remembers.
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
 * regardless of where it came from. A value that is missing, not a finite
 * number once coerced, not an integer, or negative falls back to
 * `fallback` rather than being clamped to some nearby legal value or
 * thrown on - an out-of-range config is treated the same as an absent one
 * (a known-good default), never silently rounded/floored into a different
 * number the caller never actually asked for.
 */
export function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return fallback;
  if (!Number.isInteger(numeric) || numeric < 0) return fallback;
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
    maxQueueDepth: normalizeNonNegativeInteger(env[MAX_QUEUE_DEPTH_ENV_VAR], DEFAULT_MAX_QUEUE_DEPTH),
  });
}

// ---------------------------------------------------------------------------
// Admission decision
// ---------------------------------------------------------------------------

export type AdmissionRejectionReason = "no-capacity" | "queue-full";

export type AdmissionDecision =
  | { readonly kind: "admit" }
  | { readonly kind: "queue" }
  | {
      readonly kind: "reject";
      readonly reason: AdmissionRejectionReason;
      readonly message: string;
    };

/**
 * The whole concurrency-cap + queue-depth admission policy, as one pure
 * function of the caller's own current counts:
 *
 * - `activeCount`: how many jobs currently hold a slot (spawned and not
 *   yet reaped) - `src/jobStore.ts`'s own count, never re-derived here.
 * - `queueLength`: how many jobs are currently waiting in the FIFO queue.
 *
 * Three outcomes, in this exact priority order:
 *
 * 1. `maxConcurrentJobs === 0` - NO capacity exists, ever (a permanent
 *    zero, never a transient "full"). Every job is rejected outright,
 *    regardless of `queueLength`/`maxQueueDepth`. This has to be its own
 *    branch, checked FIRST: without it, a configured `maxQueueDepth > 0`
 *    would happily queue a job that can NEVER be admitted (since
 *    `activeCount` can never fall below a cap that is already `0`),
 *    stranding it in `starting` forever - a real boundary case this
 *    function has to handle explicitly rather than let fall out of the
 *    general cap/queue arithmetic.
 * 2. `queueLength === 0 && activeCount < maxConcurrentJobs` - a real slot
 *    is free right now, AND nothing is already ahead of this job in line -
 *    admit immediately. The `queueLength === 0` half matters: if anything
 *    is already queued, a newly arriving job must go BEHIND it (see
 *    `queue` below), never jump ahead just because a transiently-freed
 *    slot happens to exist at this exact instant (e.g. right after an
 *    operator raises the cap while jobs are already waiting) - this keeps
 *    FIFO ordering an invariant rather than a usual case.
 * 3. `queueLength < maxQueueDepth` - no free slot (or something is already
 *    queued ahead of this job), but the queue has room - queue it.
 *    `maxQueueDepth === 0` makes this branch unreachable by construction,
 *    which is exactly "no queue at all."
 * 4. Otherwise - no free slot and no queue room - reject.
 */
export function decideAdmission(
  activeCount: number,
  queueLength: number,
  config: ConcurrencyConfig
): AdmissionDecision {
  const { maxConcurrentJobs, maxQueueDepth } = config;

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
