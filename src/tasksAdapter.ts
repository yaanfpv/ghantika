/**
 * The single Tasks adapter/seam - the only file in this codebase permitted
 * to reference the MCP `io.modelcontextprotocol/tasks` extension's shape at
 * all, whether via an import or a hand-rolled definition - enforced
 * mechanically by `scripts/check-no-tasks-import.mjs`'s adapter carveout
 * (see that file's header for the guard, and `test/no-tasks-import.test.ts`
 * for the proof every OTHER `src/` module still reds on a Tasks reference).
 * As it happens, this file's own imports (below) are all generic SDK types
 * plus local `jobStore` types - nothing Tasks-shaped is actually imported
 * from anywhere. The installed SDK DOES still export Task-shaped symbols,
 * but they're deprecated and back no working registration mechanism this
 * adapter could use (see "Why this is a hand-rolled adapter" below), so
 * this file HAND-ROLLS the extension's own constants and types instead of
 * importing them. Every other module (`jobStore.ts`, `process.ts`, `registry.ts`,
 * `server.ts`'s core wiring, every `tools/*.ts` handler) stays completely
 * unaware that Tasks exists: this file is a THIN adapter over the frozen
 * job/output seam (`src/jobStore.ts`'s `jobStore` singleton), never the
 * reverse - it reads job state, it never gains its own persistent state of
 * its own (see `scripts/check-module-boundaries.mjs`, which scans every
 * root-level module including this one for exactly that).
 *
 * ## Why this is a hand-rolled adapter, not a thin re-export of the SDK's
 * own Task machinery
 *
 * The installed `@modelcontextprotocol/server@2.0.0-beta.5` package's own
 * Task-shaped exports (`Task`, `TaskStatus`, `CreateTaskResult`,
 * `GetTaskRequest`, `ListTasksRequest`, `CancelTaskRequest`, ...) are ALL
 * individually marked `@deprecated 2025-11-25 wire vocabulary with no SDK
 * runtime; kept importable for interoperability only` in the package's own
 * `.d.mts` - confirmed by reading the installed declaration file directly,
 * not inferred. Concretely: `RequestMethod` (the type
 * `setRequestHandler`'s typed overload accepts) is defined as
 * `Exclude<ClientRequest['method'] | ServerRequest['method'],
 * TaskRequestMethod>` - the SDK deliberately EXCLUDES `tasks/get`,
 * `tasks/result`, `tasks/list`, `tasks/cancel` from its own typed request-
 * handler surface, and offers no `tasks/update` method at all (the old
 * vocabulary's fourth method is `tasks/result`, not `tasks/update`). So
 * there is no SDK-provided task-registration mechanism this adapter could
 * delegate to even if it wanted one: this adapter's own method set
 * (`tasks/get` / `tasks/update` / `tasks/cancel`, never `tasks/list` or
 * `tasks/result`) is this repo's OWN forward-looking design against the
 * not-yet-finalized upcoming spec revision, pinned here as a vendored,
 * digest-verified schema (`schema/tasks-extension.schema.json`,
 * `config/tasks-schema-digest.json`) rather than borrowed from the SDK's
 * own deprecated shape. This is a disclosed, deliberate design choice,
 * re-verified against the real spec once it finalizes.
 *
 * ## Capability advertisement: `capabilities.extensions`, not the SDK's
 * deprecated `capabilities.tasks`
 *
 * The installed core package's `ServerCapabilitiesSchema` /
 * `ClientCapabilitiesSchema` carry THREE relevant bags: `experimental`
 * (the old free-form extension point), the deprecated `tasks` field (the
 * SAME 2025-11-25 get/list/cancel/result vocabulary above, with a
 * completely different shape - `{list, cancel, requests}` - than this
 * extension), and `extensions` (a newer `Record<string, JSONObject>` bag).
 * `io.modelcontextprotocol/tasks` is a protocol-level extension URI,
 * structurally like the `io.modelcontextprotocol/model-immediate-response`
 * `_meta` key the MCP spec already uses elsewhere - a namespaced-URI-keyed
 * bag is exactly what `extensions` is, and using it
 * (rather than the deprecated `tasks` field, whose shape this adapter does
 * not implement at all) keeps this adapter honestly forward-compatible
 * instead of borrowing a field name whose real shape means something else.
 * `isConnectionTasksCapable` reads BOTH `extensions` and the older
 * `experimental` bag when checking what a CLIENT declared, since the
 * not-yet-finalized spec leaves genuinely open which bag a real Tasks-
 * capable host will use - advertising is narrow (this server always
 * advertises under `extensions` only), detection is lenient.
 *
 * ## The six-tool mint rule and the universal poll floor
 *
 * `run()` is the only tool `src/server.ts` ever asks this adapter to
 * augment - `status`/`output`/`tail`/`kill`/`list` are never touched by
 * this file at all, so the plain poll floor (status/output/tail on a
 * job_id) is reachable on every connection, capable or not, exactly as it
 * was before this capability existed. `maybeAugmentRunResult` is a pure
 * pass-through unless the connection is capable AND a real job_id can be
 * read back out of the plain result it was just handed - never inventing
 * a handle from nothing, never mutating jobStore itself.
 *
 * ## taskId == job_id, one handle namespace
 *
 * Every function below resolves a task purely by treating `taskId` as a
 * `jobStore` `job_id` (a real `randomUUID()` value - see
 * `src/jobStore.ts`) and reading `jobStore.get(taskId)` fresh, every call.
 * There is no separate task table anywhere in this file - `getTask` is a
 * pure projection of the SAME `JobRecord` `status()`/`output()` read, so
 * `tasks/get(taskId)` and `status(job_id)` can never observe two different
 * truths about the same job.
 *
 * ## tasks/update and tasks/cancel: interim contract, by construction
 *
 * `tasks/get`, `tasks/update`, and `tasks/cancel` are three separately
 * REGISTERED JSON-RPC methods, but all three route through this file's one
 * `getTask` snapshot function - a PURE read with no write path anywhere in
 * this module. That is not a shortcut: a job-backed task has no client-
 * updatable state at all, so `tasks/update`'s complete behavior IS this
 * read-only snapshot; this registration does not implement real
 * cooperative cancellation for `tasks/cancel` - `tasks/cancel` shares the
 * SAME read-only snapshot, same as `tasks/update`. Sharing one read-only
 * snapshot function is what makes the state-preservation
 * invariant (neither method may alter the backing job or the
 * tasks/get-observable state) true by construction rather than by a
 * runtime check: there is no mutating call in this file for either method
 * to reach.
 */
import type {
  CallToolResult,
  ClientCapabilities,
  JSONObject,
  StandardSchemaV1,
} from "@modelcontextprotocol/server";

import { type JobRecord, type JobState, isTerminalJobState, jobStore } from "./jobStore.js";

// ---------------------------------------------------------------------------
// The extension identity and the vendored, digest-verified schema
// ---------------------------------------------------------------------------

/** The protocol-level extension URI this adapter advertises and stamps as every response's discriminator - see this file's header for why `extensions`, not the SDK's deprecated `tasks` capability field. */
export const TASKS_EXTENSION_URI = "io.modelcontextprotocol/tasks";

/**
 * Minimal, honest capability descriptor for the `extensions` bag: the
 * three method names this server actually registers, so a Tasks-capable
 * host can discover the exact surface without guessing. Never the SDK's
 * deprecated `{list, cancel, requests}` shape - this is this adapter's own
 * vocabulary.
 */
export const TASKS_CAPABILITY_DESCRIPTOR: JSONObject = Object.freeze({
  methods: Object.freeze(["tasks/get", "tasks/update", "tasks/cancel"]),
}) as unknown as JSONObject;

/**
 * The `ServerOptions.capabilities` fragment `src/server.ts` spreads into
 * its own `new Server(...)` call - the ONLY thing server.ts needs from this
 * module to advertise the capability, so server.ts never has to know the
 * extension URI or descriptor shape itself.
 */
export function tasksServerCapabilitiesFragment(): { extensions: Record<string, JSONObject> } {
  return { extensions: { [TASKS_EXTENSION_URI]: TASKS_CAPABILITY_DESCRIPTOR } };
}

// ---------------------------------------------------------------------------
// Connection-level capability negotiation
// ---------------------------------------------------------------------------

/**
 * True when `clientCapabilities` (the CONNECTION's initialize-declared
 * capabilities, read from `Server.getClientCapabilities()` - populated
 * once, at initialize time, never per-request) advertised Tasks support,
 * under either bag it might legitimately appear in (see this file's header
 * on why detection is lenient across `extensions`/`experimental` while
 * advertisement stays narrow). This is the ONLY signal
 * `maybeAugmentRunResult` consults - no request-level field is ever read,
 * which is what keeps the six-tool mint rule connection-level, not
 * per-request: a bare tool call with no opt-in field of any kind still
 * mints on a capable connection, and nothing about an individual request
 * can turn minting on or off.
 */
export function isConnectionTasksCapable(
  clientCapabilities: ClientCapabilities | undefined
): boolean {
  if (clientCapabilities === undefined) return false;
  return (
    hasTasksExtensionKey(clientCapabilities.extensions) ||
    hasTasksExtensionKey(clientCapabilities.experimental)
  );
}

function hasTasksExtensionKey(bag: Record<string, unknown> | undefined): boolean {
  return bag !== undefined && Object.hasOwn(bag, TASKS_EXTENSION_URI);
}

// ---------------------------------------------------------------------------
// Task status - a closed, four-value set matching the vendored schema's own
// status enum EXACTLY, by set-equality. 'expired' is never a member: this
// adapter has no mechanism today that removes a completed/terminal task
// record on its own schedule, and a task that no longer resolves to a job
// simply reads as task_not_found rather than surfacing its own terminal
// status.
// ---------------------------------------------------------------------------

/**
 * The closed status set this adapter ever produces, as a real runtime
 * array (the same "type union alone is compile-time-only" reasoning
 * `src/jobStore.ts`'s own `ALL_JOB_STATES` already documents) - so
 * `test/tasks.test.ts` can assert this SET deep-equals the vendored
 * schema's own `taskStatus` enum by reading the schema file, not by
 * hand-copying the four strings a second time.
 */
export const TASK_STATUSES = Object.freeze([
  "working",
  "completed",
  "failed",
  "cancelled",
]) as readonly TaskStatusValue[];

export type TaskStatusValue = "working" | "completed" | "failed" | "cancelled";

export function isTaskStatusValue(value: unknown): value is TaskStatusValue {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * The one place `JobState` (jobStore.ts's own closed five-value enum) maps
 * onto this adapter's four-value task status. `starting`/`running` are
 * both `working` (a task in progress reports one uniform in-progress
 * status); `exited` is `completed` REGARDLESS of the job's real exit code
 * (a task that ran to completion is a completed task - the actual
 * `exitCode` travels separately in the result, see `buildTaskResult`,
 * never folded into the status itself); `failed` (this codebase's own
 * spawn-error class - a cwd/executable preflight rejection or a genuine
 * async spawn failure, see `src/jobStore.ts`'s `JobDiagnosticReason` docs)
 * is the task-level `failed` (the task itself never ran, distinct from a
 * completed task whose command happened to exit non-zero); `killed` is
 * `cancelled` (an explicit kill, whether via the `kill` tool today or a
 * real cooperative cancel layered on top of `tasks/cancel` later, is a
 * cancellation at the task level).
 */
function mapJobStateToTaskStatus(state: JobState): TaskStatusValue {
  switch (state) {
    case "starting":
    case "running":
      return "working";
    case "exited":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
      return "cancelled";
    default: {
      // JobState is closed (jobStore.ts's own ALL_JOB_STATES-backed
      // guarantee) - this branch exists only so a future sixth state
      // fails loudly here instead of silently falling through to an
      // incorrect status.
      const exhaustiveCheck: never = state;
      throw new Error(`tasksAdapter: unmapped JobState "${String(exhaustiveCheck)}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Result shapes - structurally match schema/tasks-extension.schema.json's
// taskResult/taskNotFound $defs exactly (validated in test/tasks.test.ts
// against the real, digest-verified schema file, never a hand-copied
// description of it)
// ---------------------------------------------------------------------------

export interface TaskOutputCounts {
  readonly stdout_lines: number;
  readonly stdout_bytes: number;
  readonly stderr_lines: number;
  readonly stderr_bytes: number;
}

export interface TaskResult {
  readonly [key: string]: unknown;
  readonly extension: typeof TASKS_EXTENSION_URI;
  readonly taskId: string;
  readonly status: TaskStatusValue;
  readonly createdAt: string;
  readonly pollIntervalMs?: number;
  readonly exitCode?: number;
  readonly output?: TaskOutputCounts;
}

export interface TaskNotFound {
  readonly [key: string]: unknown;
  readonly extension: typeof TASKS_EXTENSION_URI;
  readonly error: "task_not_found";
  readonly taskId: string;
}

/** The poll-interval hint minted results and live snapshots both carry - a plain constant, never derived from anything Tasks-specific. */
export const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * Projects a real `JobRecord` into this adapter's `TaskResult` shape. Pure:
 * reads `jobStore.getOutputCounts` (already-existing, real, ever-
 * cumulative counts - see `src/jobStore.ts`'s own docs on why those
 * survive retention eviction) and the record's own fields, writes nothing.
 * `exitCode`/`output` are included only once the task is terminal
 * (mirroring `PublicJobProjection`'s own optional-field pattern for
 * `exit_code`), so a still-working task never carries a stale/zeroed
 * placeholder for either.
 */
function buildTaskResult(record: JobRecord): TaskResult {
  const terminal = isTerminalJobState(record.state);
  const base: TaskResult = {
    extension: TASKS_EXTENSION_URI,
    taskId: record.job_id,
    status: mapJobStateToTaskStatus(record.state),
    createdAt: record.started_at,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
  if (!terminal) return base;

  const counts = jobStore.getOutputCounts(record.job_id);
  return {
    ...base,
    ...(record.exit_code !== undefined ? { exitCode: record.exit_code } : {}),
    output: counts,
  };
}

function taskNotFound(taskId: string): TaskNotFound {
  return { extension: TASKS_EXTENSION_URI, error: "task_not_found", taskId };
}

/**
 * The one live-read entry point every tasks/* handler in `src/server.ts`
 * calls, directly or (for tasks/update and tasks/cancel) as their WHOLE
 * interim implementation - see this file's header on why that sharing is
 * what makes the state-preservation invariant true by construction. Never
 * writes to `jobStore`.
 */
export function getTask(taskId: string): TaskResult | TaskNotFound {
  const record = jobStore.get(taskId);
  if (record === undefined) return taskNotFound(taskId);
  return buildTaskResult(record);
}

// ---------------------------------------------------------------------------
// Registration - a hand-rolled Standard Schema (https://standardschema.dev)
// for the tiny {taskId: string} params shape every tasks/* method takes.
// Deliberately NOT zod: zod is a real dependency of the installed
// @modelcontextprotocol/server package, but never a DIRECT dependency of
// this repo's own package.json - importing it here would be an undeclared
// phantom dependency (works only because the SDK happens to hoist it
// today), exactly the class of drift check-sdk-exact-pin.mjs exists to
// rule out for the packages it DOES pin. The Standard Schema interface
// itself is a handful of fields (see the installed SDK's own
// `StandardSchemaV1` type, confirmed by reading its .d.mts directly), so
// implementing it by hand for one two-line shape is the honest choice.
// ---------------------------------------------------------------------------

export interface TaskIdParams {
  readonly taskId: string;
}

/**
 * Validates `{taskId: string}` - the only params shape every tasks/* method
 * registered in `src/server.ts` takes. A fresh object per call (never
 * shared/mutated state), matching this module's zero-persistent-state
 * design. `taskId` must be a NON-EMPTY string - the vendored, digest-
 * verified extension schema (`schema/tasks-extension.schema.json`) pins
 * `minLength: 1` on every `taskId` field it describes, so an empty string
 * would flow through `getTask`/`taskNotFound` and produce a response that
 * violates the very schema this adapter's results are pinned against; this
 * is where that constraint is actually enforced, at the request boundary,
 * before an empty taskId ever reaches a live lookup.
 */
export function taskIdParamsSchema(): StandardSchemaV1<unknown, TaskIdParams> {
  return {
    "~standard": {
      version: 1,
      vendor: "ghantika-tasks-adapter",
      validate(value: unknown) {
        if (typeof value === "object" && value !== null) {
          const taskId = (value as Record<string, unknown>).taskId;
          if (typeof taskId === "string" && taskId.length > 0) {
            return { value: { taskId } };
          }
        }
        return { issues: [{ message: '"taskId" must be a non-empty string' }] };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Minting - the six-tool mint rule: ONLY run(), ONLY on a capable
// connection, and ONLY by wrapping a job_id this call itself just produced
// (never inventing a handle for a job this call didn't create)
// ---------------------------------------------------------------------------

/**
 * Reads the `job_id` `src/tools/run.ts`'s own `toolSuccess` already placed
 * on `result.structuredContent` (the `PublicJobProjection` shape) - the
 * ONLY thing this function inspects about `result`'s internals, so a
 * change to any OTHER field of that projection can never affect minting.
 */
function extractJobId(result: CallToolResult): string | undefined {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (typeof structured !== "object" || structured === null) return undefined;
  const jobId = (structured as Record<string, unknown>).job_id;
  return typeof jobId === "string" ? jobId : undefined;
}

/**
 * `src/server.ts`'s `tools/call` handler calls this, and ONLY for a call
 * named `"run"` - see that file's own wiring. `result` is `run`'s own
 * already-built plain `CallToolResult`; this function either returns it
 * completely UNCHANGED (a non-capable connection, or - defensively - a
 * shape this adapter cannot read a job_id out of, which should never
 * happen for a call that just went through `run`'s own handler but is
 * never trusted blindly) or replaces its `content`/`structuredContent`
 * with the minted `TaskResult` for the SAME job the plain result already
 * named. Never mints for any job other than the one `result` itself is
 * about, and never touches `jobStore` beyond the SAME kind of read
 * `getTask` performs.
 */
export function maybeAugmentRunResult(
  result: CallToolResult,
  isCapableConnection: boolean
): CallToolResult {
  if (!isCapableConnection) return result;
  const jobId = extractJobId(result);
  if (jobId === undefined) return result;
  const record = jobStore.get(jobId);
  if (record === undefined) return result; // defensive only - run() always creates the record before returning

  const task = buildTaskResult(record);
  return {
    content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
    structuredContent: { ...task },
  };
}
