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
 * ## pid + birth identity - STATUS-ONLY, additive to `toPublicProjection`
 *
 * This handler ALSO reports, for a job that ever got a live child
 * attached (see `jobStore.getChildHandle`'s own docs - that tracking
 * outlives the job's own terminal transition, so a terminal job reports
 * the pid it HAD, never omits it), the tracked OS `pid` alongside the
 * SAME real birth identity `kill`'s own pre-signal identity gate compares
 * against (`process.ProcessBirthIdentity` - see that type's own docs).
 * Deliberately never the pid alone: a pid is reusable the instant its
 * process exits, so a consumer correlating on it alone would inherit the
 * exact race `kill`'s own identity gate exists to close (`src/process.ts`'s
 * own docs on `IDENTITY_TOLERANCE_SECONDS`/`checkProcessIdentity`).
 *
 * This is deliberately built HERE, on top of `toPublicProjection`'s own
 * unmodified return value, rather than inside `toPublicProjection` itself
 * or on `PublicJobProjection`'s own interface: `toPublicProjection` is
 * shared by `run`/`kill`/`list` too (see those files' own `toolSuccess`
 * call sites), and `test/jobStore.test.ts`'s own
 * "PublicJobProjection's field set is EXACTLY the frozen set" regression
 * locks that shared function's return shape - a plain object literal
 * always creates a key it assigns, even when the assigned value is
 * `undefined`, so adding `pid`/`birth_identity` keys INSIDE
 * `toPublicProjection`'s own literal would appear on every one of those
 * other tools' responses too (in-process, at the `Object.keys` level, not
 * merely on the wire), not just `status`'s. `StatusProjection` below
 * extends `PublicJobProjection` and is built by spreading
 * `toPublicProjection`'s own untouched result plus these two new fields,
 * entirely local to this file - `jobStore.ts` is not touched at all by
 * this addition, so nothing about `run`/`kill`/`list`'s existing response
 * shape changes, provably (the existing exact-field-set test keeps
 * passing unmodified).
 *
 * `birth_identity` is a three-state TAGGED UNION, never a nullable field:
 * `"pending"` (the async capture is still in flight), `"captured"` (a real
 * identity exists - the only variant that carries an `identity` payload
 * at all), or `"unavailable"` (the capture settled with nothing, or none
 * was ever attempted - e.g. Windows, or a job that never got a live
 * child). Structurally, a client narrowing on `state` gets the right
 * shape or none - there is no shared nullable field a "pending" and an
 * "unavailable" answer could ever collapse into by omission. Derived from
 * the tracked child's OWN data (`jobStore.getChildHandle`'s
 * `birthIdentity`/`identityCapture`), checking `birthIdentity` FIRST: if a
 * real identity is already on the tracked child, this reports `"captured"`
 * regardless of what `JobRecord.identity_capture`'s own bookkeeping string
 * says, so this can never claim "captured" without an actual payload to
 * back it, and never disagrees with a real settled identity even in an
 * edge case where a caller attached one directly (`JobStore.attachChild`'s
 * own `birthIdentity` parameter, documented there as chiefly a test-suite
 * affordance) without ever kicking off the tracked async capture that
 * normally drives `identity_capture`.
 *
 * `spawnedAtMs` (this server's own wall-clock spawn timestamp) is
 * deliberately NEVER surfaced or used as a fallback here: this codebase's
 * own kill path stopped treating it as identity precisely because it is a
 * weaker, reusable-adjacent signal (`TrackedChild.birthIdentity`'s own
 * docs in `src/jobStore.ts`), so this handler holds the same line rather
 * than quietly reintroducing it as a "close enough" substitute when a
 * real birth identity isn't available.
 *
 * A real birth identity - either variant of `ProcessBirthIdentity` - only
 * proves which process THIS SERVER launched for this job. It does not
 * prove that a process a caller separately observes (via `ps`, a process
 * supervisor, or any other means) IS that one; confirming that is the
 * caller's own job, the same way `kill`'s own pre-signal gate does it
 * before ever signaling (`src/process.ts`'s own docs). On non-Linux POSIX
 * platforms the `"posix-elapsed"` variant is PROBABILISTIC CORRELATION
 * EVIDENCE (a real-but-tolerance-bounded elapsed-time comparison), never
 * presented as certainty - only Linux's `"linux-starttime-ticks"` variant
 * is an exact kernel-provided token with no tolerance concept at all (see
 * `ProcessBirthIdentity`'s own docs in `src/process.ts` for the full
 * platform story, and this file's own `description` export below for the
 * caller-facing disclosure of the same distinction).
 *
 * ## Non-blocking
 *
 * `jobStore.get` is a synchronous `Map` read - there is no I/O, no await,
 * nothing that could ever block on another job's execution. Structurally
 * obvious, but proven under a real concurrently-running job in
 * `test/e2e-server.test.ts`. Reading `jobStore.getChildHandle` alongside
 * it is the same shape: a synchronous read of already-tracked state, never
 * an await on the identity capture itself even if it's still pending -
 * a still-in-flight capture is exactly what the `"pending"` state reports,
 * never awaited to settle first.
 *
 * ## Unknown job_id
 *
 * A `job_id` the store has never seen returns a typed, `isError: true`
 * tool result - never a thrown error, never a JSON-RPC protocol error -
 * consistent with `run.ts`'s own `toolError` path for schema-invalid
 * input (the same failure CLASS, a normal successful RPC whose result
 * says "this didn't work", just for a different reason). The message
 * itself is `jobStore.ts`'s shared `describeUnknownJobId` - see that
 * function's own docs for why it discloses per-process job scoping
 * rather than a bare "not found".
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

import {
  type JobRecord,
  type PublicJobProjection,
  describeUnknownJobId,
  jobStore,
  toPublicProjection,
} from "../jobStore.js";
import type { ProcessBirthIdentity } from "../process.js";

export const name = "status";

export const description =
  "Get the current lifecycle status of a background job started by run: state (starting/running/exited/killed/failed), timestamps, exit_code/signal/diagnostic as applicable. For a job that got a real OS process, also reports its pid together with birth_identity, the SAME identity this server's own kill checks before ever signaling - never the pid alone, since a pid is reusable the instant its process exits. birth_identity.state is one of pending (capture still in flight), captured (a real identity is present, under identity), or unavailable (capture failed, or none was ever attempted). identity itself is platform-tagged: linux-starttime-ticks is an exact kernel start-time counter with no tolerance concept; posix-elapsed (macOS and every other non-Linux POSIX platform) is a real but PROBABILISTIC ps-observed elapsed-time correlation, never a certainty. Either way this only proves which process THIS SERVER launched for the job - it does not prove a process you separately observe by other means is that one; confirming that remains your own job. Never blocks on the job's own execution.";

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
 * The three-state, TAG-DISCRIMINATED view of a job's async birth-identity
 * capture, carrying the real captured payload alongside the state itself -
 * see this file's own header docs ("pid + birth identity") for the full
 * design rationale, and `JobRecord.identity_capture` in `src/jobStore.ts`
 * for the bare three-value string this codebase already tracks internally
 * for the same settlement (which this type is layered on top of, never a
 * replacement for). Only the `"captured"` variant carries an `identity`
 * field at all - deliberately not a `{state, identity?}` shape with a
 * nullable field, since JSON has no way to enforce "identity is present
 * iff state is captured" on a shape like that: a client would have to
 * cross-check a second field by convention to tell "still capturing"
 * apart from "capture failed." Here, narrowing on `state` alone gets the
 * right shape or none.
 */
export type PublicBirthIdentityProjection =
  | { readonly state: "pending" }
  | { readonly state: "captured"; readonly identity: ProcessBirthIdentity }
  | { readonly state: "unavailable" };

/**
 * `status`'s own response shape: `PublicJobProjection` (the shared shape
 * `run`/`kill`/`list` also return) plus two STATUS-ONLY additive fields.
 * See this file's own header docs for why these live here, layered on top
 * of `toPublicProjection`'s untouched result, rather than inside
 * `PublicJobProjection`/`toPublicProjection` themselves.
 */
export interface StatusProjection extends PublicJobProjection {
  /**
   * The tracked OS pid of the real child process this server launched for
   * this job. Present for as long as a live child was EVER attached (see
   * `jobStore.getChildHandle`'s own docs - that tracking outlives the
   * job's own terminal transition, so a terminal job reports the pid it
   * HAD, not a claim it still exists - see `state` alongside it, and
   * `birth_identity` below, for what's actually safe to conclude from
   * that). `undefined` only for a job that never got a live child at all
   * (a pre-flight `spawn-error`/`policy-denied` rejection - see
   * `JobRecord`'s own docs in `src/jobStore.ts` - never spawned a real OS
   * process to begin with).
   */
  readonly pid?: number;
  /**
   * The real birth identity for `pid` above - present under the exact
   * same condition `pid` is (a live child was ever attached), `undefined`
   * otherwise. See `PublicBirthIdentityProjection`'s own docs for the
   * three-state shape, and this file's header docs for why this is never
   * presented alongside a bare pid without it, and never falls back to
   * `spawnedAtMs`.
   */
  readonly birth_identity?: PublicBirthIdentityProjection;
}

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
    return toolError(describeUnknownJobId("status", args.job_id));
  }
  return toolSuccess(buildStatusProjection(record));
}

/**
 * Builds this file's own `StatusProjection` on top of
 * `toPublicProjection`'s unmodified result - see this file's header docs
 * ("pid + birth identity") for why the extra fields are added HERE,
 * post-hoc, rather than inside `toPublicProjection` itself.
 */
function buildStatusProjection(record: JobRecord): StatusProjection {
  const base = toPublicProjection(record, jobStore.getOutputCounts(record.job_id));
  const handle = jobStore.getChildHandle(record.job_id);
  if (handle === undefined) {
    // No live child was ever attached to this job (e.g. a pre-flight
    // spawn-error/policy-denied rejection, per JobRecord's own docs) -
    // there is no real OS process, and therefore no birth identity, to
    // report at all. `base` is returned untouched rather than spreading
    // in `pid`/`birth_identity` keys set to `undefined`: an object
    // literal always creates a key it assigns, even when the assigned
    // value is `undefined`, so doing that would make `pid`/`birth_identity`
    // own-keys of the in-process `StatusProjection` for a job that never
    // had a real process at all - visible to any caller inspecting
    // `Object.keys`/`Object.hasOwn` directly, even though `JSON.stringify`
    // drops them from the wire. Omitting the keys entirely keeps the
    // in-process shape and the wire shape identical for this case.
    return base as StatusProjection;
  }
  return {
    ...base,
    pid: handle.pid,
    birth_identity: buildBirthIdentityProjection(handle.birthIdentity, record.identity_capture),
  };
}

/**
 * Maps a tracked child's real, in-store data onto the public three-state
 * `PublicBirthIdentityProjection` - see that type's own docs for the
 * exhaustiveness/no-collapse contract this must uphold, and this file's
 * header docs for why `birthIdentity` is checked FIRST (never trusting
 * `captureState`'s bookkeeping string alone). Exported (matching this
 * repo's own established pattern for a small pure mapping function - see
 * e.g. `process.ts`'s `identityElapsedTimesMatch`) so the three-state
 * contract can be exercised directly against synthetic inputs, without
 * needing to race a real async capture to observe `"pending"`.
 *
 * @param birthIdentity - `jobStore.getChildHandle(...).birthIdentity`: the
 *   tracked child's own already-settled identity, if any.
 * @param captureState - `JobRecord.identity_capture`: the synchronous,
 *   in-store settlement signal for the async capture (`"pending"` while
 *   it's in flight; `"captured"`/`"unavailable"` once it settles;
 *   `undefined` if no capture was ever kicked off for this job at all -
 *   collapsed into `"unavailable"` below, since from a caller's point of
 *   view "never attempted" and "attempted and failed" both mean the same
 *   thing: there is no birth identity coming for this pid).
 */
export function buildBirthIdentityProjection(
  birthIdentity: ProcessBirthIdentity | undefined,
  captureState: "pending" | "captured" | "unavailable" | undefined
): PublicBirthIdentityProjection {
  if (birthIdentity !== undefined) {
    return { state: "captured", identity: birthIdentity };
  }
  if (captureState === "pending") {
    return { state: "pending" };
  }
  return { state: "unavailable" };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolSuccess(projection: StatusProjection): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(projection, null, 2) }],
    structuredContent: { ...projection },
  };
}
