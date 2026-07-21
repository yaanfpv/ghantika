/**
 * `status` - reports a tracked job's current lifecycle state.
 * This file owns only `status`'s registration/schema/validation/dispatch
 * logic; it imports nothing from any sibling under `src/tools/` and holds
 * no state of its own - every read of "what state is this job in" routes
 * through the `jobStore` singleton (`src/jobStore.ts`).
 *
 * ## Pass-through, not re-derivation
 *
 * The closed five-value `JobState` enum and its terminal-linearization
 * guarantee (a job's terminal state is assigned exactly once, by
 * `JobStore.markSpawnFailed`/`markExited`, both already no-ops once a job
 * is terminal) are entirely `jobStore.ts`'s responsibility - this handler
 * never re-implements or second-guesses that logic. It reads the record
 * FRESH from the store on every call (never caches a snapshot across
 * calls) and hands it straight to `toPublicProjection`, the one function
 * any tool handler may use to shape a `JobRecord` for an MCP client. That
 * makes the nullability contract (`exit_code` iff `exited`, `signal` iff
 * `killed`, `diagnostic` iff `failed`, `ended_at` iff terminal) something
 * `toPublicProjection` guarantees and this handler simply forwards -
 * proven end-to-end by tests observing `status()`'s own output, not by
 * calling `jobStore` directly.
 *
 * ## Non-blocking
 *
 * `jobStore.get` is a synchronous `Map` read - there is no I/O, no await,
 * nothing that could ever block on another job's execution. Structurally
 * obvious, but proven under a real concurrently-running job in
 * `test/e2e-server.test.ts`.
 *
 * ## Unknown job_id
 *
 * A `job_id` the store has never seen returns a typed, `isError: true`
 * tool result - never a thrown error, never a JSON-RPC protocol error -
 * consistent with `run.ts`'s own `toolError` path for schema-invalid
 * input (the same failure CLASS, a normal successful RPC whose result
 * says "this didn't work", just for a different reason).
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

import { type PublicJobProjection, jobStore, toPublicProjection } from "../jobStore.js";

export const name = "status";

export const description =
  "Get the current lifecycle status of a background job started by run: state (starting/running/exited/killed/failed), timestamps, exit_code/signal/diagnostic as applicable. Never blocks on the job's own execution.";

export const inputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {
    job_id: {
      type: "string",
      minLength: 1,
      description: "The job id returned by a prior run call.",
    },
  },
  required: ["job_id"],
};

/**
 * @param args - the raw `tools/call` arguments, exactly as the client sent
 *   them (unvalidated - validating against `inputSchema` is this handler's
 *   own job, per the server's error-class distinction).
 */
export function handler(args: Record<string, unknown> | undefined): CallToolResult {
  if (typeof args?.job_id !== "string" || args.job_id.length === 0) {
    return toolError('status requires a non-empty string "job_id" argument');
  }
  // Fresh read on every call, never a cached/stale snapshot (verified by
  // a mutation control in test/tools.test.ts).
  const record = jobStore.get(args.job_id);
  if (!record) {
    return toolError(`status: no job found with job_id "${args.job_id}"`);
  }
  return toolSuccess(toPublicProjection(record, jobStore.getOutputCounts(args.job_id)));
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolSuccess(projection: PublicJobProjection): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(projection, null, 2) }],
    structuredContent: { ...projection },
  };
}
