/**
 * `list` - enumerates every job the server currently knows about.
 * This file owns only `list`'s registration/schema/
 * ordering/dispatch logic; it imports nothing from any sibling under
 * `src/tools/` and holds no state of its own - see `src/jobStore.ts`.
 *
 * `list` takes no required arguments - listing "all jobs" needs nothing
 * from the caller - so unlike its siblings there is no schema-validation-
 * failure case; every invocation reaches a real result.
 *
 * ## Ordering
 *
 * Deterministic MOST-RECENT-FIRST. `jobStore.list()` returns jobs in
 * insertion order (oldest first, by contract) - this
 * handler reverses that ordering itself via an EXPLICIT comparator
 * (`compareMostRecentFirst`), never by relying on "insertion order
 * happens to equal seq order today" as an implicit assumption.
 *
 * The comparator's primary key is `started_at` descending; its tie-break
 * is `JobRecord.seq` descending. `seq` is a real, necessary tie-break, not
 * a belt-and-braces extra: `started_at` is an ISO timestamp with
 * millisecond resolution, and two jobs `run()` back-to-back in the same
 * agent turn commonly land in the same millisecond - without the `seq`
 * tie-break, two such jobs would sort in an ARBITRARY (or accidentally-
 * stable-by-luck) order depending only on `Array.prototype.sort`'s
 * behavior on equal keys, which this codebase must never depend on.
 * `compareMostRecentFirst` is exported so it can be tested in isolation
 * against hand-constructed fixture records that share a literal
 * `started_at`, independent of whatever real timestamp granularity a
 * given test run happens to observe.
 *
 * ## Non-blocking
 *
 * `jobStore.list()` is a synchronous array copy of an in-memory `Map`'s
 * values - no I/O, no await, nothing that could ever block on another
 * job's execution. Structurally obvious, but proven under a real
 * concurrently-running job in `test/e2e-server.test.ts`.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

import { type JobRecord, type JobState, jobStore, toPublicProjection } from "../jobStore.js";

export const name = "list";

export const description =
  "List every background job the server currently knows about - queued, running, or finished - most-recently-started first. A queued job (admitted into the concurrency queue but not yet spawned - see run's own description) carries its queue_position; the current concurrency cap is included too. Never blocks on any job's own execution.";

export const inputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {},
};

export interface ListedJob {
  readonly job_id: string;
  readonly label: string;
  readonly state: JobState;
  readonly started_at: string;
  /** See `JobRecord.queue_position`'s own docs - the same value, passed through verbatim (present only while this job is actually queued, waiting for a concurrency slot). */
  readonly queue_position?: number;
}

/**
 * Most-recent-first: `started_at` descending, tie-broken by `seq`
 * descending (a strictly higher `seq` was always created later, even when
 * two jobs share an identical `started_at` millisecond). Exported so this
 * exact comparator - not just "the list looks right after a reversal" -
 * can be exercised directly against hand-constructed fixtures (see the
 * mutation control in `test/tools.test.ts`).
 */
export function compareMostRecentFirst(a: JobRecord, b: JobRecord): number {
  if (a.started_at !== b.started_at) {
    return a.started_at > b.started_at ? -1 : 1;
  }
  return b.seq - a.seq;
}

export function handler(): CallToolResult {
  const jobs = [...jobStore.list()].sort(compareMostRecentFirst);
  const listed: ListedJob[] = jobs.map((record) => {
    const projection = toPublicProjection(record, jobStore.getOutputCounts(record.job_id));
    return {
      job_id: projection.job_id,
      label: projection.label,
      state: projection.state,
      started_at: projection.started_at,
      queue_position: projection.queue_position,
    };
  });
  return {
    content: [{ type: "text", text: JSON.stringify(listed, null, 2) }],
    // `concurrency_cap` is the server-wide currently configured
    // concurrency cap (see `JobStore.getConcurrencyCap`) - not a
    // per-job field, so it sits alongside `jobs` rather than on each
    // entry.
    structuredContent: { jobs: listed, concurrency_cap: jobStore.getConcurrencyCap() },
  };
}
