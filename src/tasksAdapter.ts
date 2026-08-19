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
 * The installed `@modelcontextprotocol/server@2.0.0` package's own
 * Task-shaped exports (`Task`, `TaskStatus`, `CreateTaskResult`,
 * `GetTaskRequest`, `ListTasksRequest`, `CancelTaskRequest`, ...) are ALL
 * individually marked `@deprecated 2025-11-25 wire vocabulary with no SDK
 * runtime; kept importable for interoperability only` in the package's own
 * `.d.mts` - confirmed by reading the installed declaration file directly,
 * not inferred (re-confirmed here: `type Task = ...`, `type
 * CreateTaskResult = ...`, `type GetTaskResult = ...`, `type CancelTaskResult
 * = ...` all still carry that exact tag in the currently-installed SDK).
 * Concretely: `RequestMethod` (the type `setRequestHandler`'s typed overload
 * accepts) is defined as `Exclude<ClientRequest['method'] |
 * ServerRequest['method'], TaskRequestMethod>` - the SDK deliberately
 * EXCLUDES `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel` from
 * its own typed request-handler surface, and offers no `tasks/update`
 * method at all (the old vocabulary's fourth method is `tasks/result`, not
 * `tasks/update`). So there is no SDK-provided task-registration mechanism
 * this adapter could delegate to even if it wanted one: this adapter's own
 * method set (`tasks/get` / `tasks/update` / `tasks/cancel`, never
 * `tasks/list` or `tasks/result`) matches the FINALIZED extension's own
 * method-set change (see below), pinned here as a vendored, digest-verified
 * schema (`schema/tasks-extension.schema.json`, `config/tasks-schema-digest.json`)
 * rather than borrowed from the SDK's own deprecated shape.
 *
 * **The Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663)
 * finalized on 2026-07-28, and this adapter is now built directly against
 * that released contract** - not against a pre-finalization
 * guess. `schema/tasks-extension.schema.json` pins the spec's own generated
 * schema, measured directly (not summarized) against
 * `modelcontextprotocol/ext-tasks`; the result shapes and status vocabulary
 * below are checked against it in `test/tasks.test.ts`, most of them
 * (`createTaskResult`, `emittedAckResult`) against real emitted output -
 * `tasks/get`'s response is currently checked only against a hand-written
 * literal, not genuine adapter output. The three request methods
 * (`tasks/get`/`tasks/update`/`tasks/cancel`) are exercised by these same
 * behavior tests but never schema-validated: this schema vendors only the
 * response/result shapes the adapter emits, not the spec's request shapes
 * (see `config/tasks-schema-provenance.json` for the full accounting of
 * what this schema does and does not vendor). The one
 * thing this adapter still deliberately
 * narrows from the full spec: `TASK_STATUSES` emits four of the spec's five
 * `taskStatus` values (never `input_required` - see that constant's own
 * docs for why), and `tasks/list`/`tasks/result` stay unregistered (the
 * spec eliminates the former and replaces the latter - see the method-set
 * section of this header for the full reasoning, unchanged by this change).
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
 * `isConnectionTasksCapable` reads `extensions` ONLY, on both the
 * advertisement side and the CLIENT-declaration side it checks - matching
 * the finalized extension's own contract exactly, which designates
 * `extensions` as the sole correct bag. A client that declares Tasks
 * support only under the older, free-form `experimental` bag is not
 * recognized as capable.
 *
 * ## The seven-tool mint rule and the universal poll floor
 *
 * `run()` is the only tool `src/server.ts` ever asks this adapter to
 * augment - `status`/`output`/`tail`/`kill`/`list`/`follow` are never
 * touched by this file at all (seven tools total: `run` mints, the other
 * six - including `follow`, the newest - stay plain), so the plain poll
 * floor (status/output/tail on a job_id) is reachable on every
 * connection, capable or not, exactly as it was before this capability
 * existed. `maybeAugmentRunResult`'s RESPONSE SHAPE is a pure
 * pass-through unless the connection is capable AND a real job_id can be
 * read back out of the plain result it was just handed - never
 * inventing a handle from nothing. It does register a real jobStore side
 * effect regardless of capability: a terminal-transition listener for
 * the transport-layer wake (see `startTransportWakeOnTerminal`'s own
 * docs), whose callback is a no-op unless `GHANTIKA_WAKE_TRANSPORT_ENABLED`
 * is set.
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
 * ## tasks/get is a pure read; tasks/update is a pure existence/TTL check
 * plus a fixed ack; tasks/cancel is real
 *
 * `tasks/get` is the one place this file constructs the full, discriminated
 * `GetTaskResult` snapshot - a PURE read with no write path anywhere in
 * this module (aside from the lazy TTL purge - see `getTask`'s own docs).
 *
 * `tasks/update`, per the RELEASED spec, is a real client->server request
 * (`{taskId, inputResponses}`) whose response is an empty acknowledgement,
 * eventually consistent with the task's own observable state - never a
 * snapshot read. ghantika's own job-backed tasks have no client-updatable
 * state at all (no `input_required` step ever occurs - see `TASK_STATUSES`'s
 * own docs), so `updateTask`'s COMPLETE behavior is: validate the taskId
 * exists and has not expired (by delegating to `getTask` and discarding its
 * result - the same existence/TTL check every other method here shares),
 * then return the fixed `ACK_RESULT`. `inputResponses` is accepted at the
 * request-validation boundary (`taskUpdateParamsSchema`, below) because the
 * spec's own request shape requires it be a legal param, but it is
 * structurally never read or interpreted here - there is nothing for it to
 * mean when no `input_required` step can ever occur.
 *
 * `tasks/cancel` is different: it is the one place this file has a REAL
 * side effect. `cancelTask` (below) resolves `taskId` the same way every
 * other function here does (a `jobStore` `job_id` read via `getTask`,
 * never a second table - and, per the same existence/TTL check, never
 * attempts a kill for a taskId with nothing left to terminate), then
 * delegates the actual termination to `src/tools/kill.ts`'s own exported
 * `handler` - the SAME POSIX-process-group kill/reap containment the
 * `kill` tool already provides (grace-period SIGTERM, SIGKILL escalation,
 * the pre-signal and escalation identity gates, the external
 * `pgrep`-based reap confirmation) - rather than reimplementing any of it
 * here. This file still never gains persistent state of its own:
 * `killTool.handler` performs the one real write (through `jobStore`), and
 * `cancelTask` returns the SAME fixed `ACK_RESULT` `updateTask` does,
 * matching the spec's own "eventually consistent - the ack may arrive
 * before the task's observable status reflects the requested change"
 * contract for `CancelTaskResult`, rather than reading a fresh snapshot
 * back the way this adapter did before this change.
 *
 * BOUNDARY, unwidened from `kill`'s own already-disclosed scope (see
 * `src/tools/kill.ts`'s extensive docs on this): cancelling means
 * signalling the job's ORIGINAL POSIX process group. A descendant that
 * calls `setsid()` or otherwise moves itself into a DIFFERENT process
 * group is neither signalled by `tasks/cancel` nor observed by its
 * confirmation check - reaching the same containment through a new entry
 * point does not claim a stronger guarantee than the one `kill` already
 * discloses.
 *
 * `cancelTask` never treats `killTool.handler`'s own `isError` outcomes (an
 * unreachable defensive branch, or a rare pre-signal identity-gate
 * refusal) as a reason to fail this call itself - a kill attempt that
 * could not proceed simply leaves the job exactly as a fresh `getTask`
 * read would find it, the same honest, retry-friendly shape `kill` itself
 * already provides for a caller that calls it again; since the ack is now
 * a FIXED value regardless of outcome (matching the spec's own
 * eventually-consistent contract), this file no longer needs to inspect
 * `killTool.handler`'s return value at all to decide what to send back.
 */
import type {
  CallToolResult,
  ClientCapabilities,
  JSONObject,
  StandardSchemaV1,
} from "@modelcontextprotocol/server";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

import {
  type JobRecord,
  type JobState,
  type StreamLineEntry,
  type StreamLineTerminator,
  isTerminalJobState,
  jobStore,
} from "./jobStore.js";
// The SAME import shape `src/registry.ts` already uses to reach `kill`'s
// handler for `tools/call` dispatch - `cancelTask` (below) reuses that
// identical POSIX-process-group kill/reap containment for `tasks/cancel`
// rather than reimplementing it here. `tasksAdapter.ts` sits outside
// `src/tools/`, so this import is a normal adapter-reads-a-tool dependency,
// never a sibling-tools-importing-tools reference (the ONLY shape
// `scripts/check-module-boundaries.mjs`'s sibling-import guard forbids -
// see that script's own header for the exact, narrower scope of that rule).
import * as killTool from "./tools/kill.js";
// `resolveWakeTarget.ts` and `selectTransport.ts` are two of
// `scripts/check-wake-transport-boundaries.mjs`'s own admitted public doors
// into `src/wake/` (the third and second respectively - see that script's
// own header for the full boundary design). This file never reaches into a
// concrete transport (`appServerTransport.ts`/`desktopIpcTransport.ts`)
// directly - `selectAndWake` and `DEFAULT_TRANSPORTS` are the only surface
// this adapter needs, exactly as `src/server.ts` never needs anything
// Tasks-shaped from this file beyond what it explicitly exports.
import type { WakeTargetResolution } from "./wake/resolveWakeTarget.js";
import {
  CLAUDE_MESSAGING_WAKE_TRANSPORT,
  CODEX_GATED_TRANSPORTS,
  selectAndWake,
} from "./wake/selectTransport.js";
import type { WakeTransport } from "./wake/wakeTransport.js";

// ---------------------------------------------------------------------------
// The extension identity and the vendored, digest-verified schema
// ---------------------------------------------------------------------------

/** The protocol-level extension URI this adapter advertises and stamps as every response's discriminator - see this file's header for why `extensions`, not the SDK's deprecated `tasks` capability field. */
export const TASKS_EXTENSION_URI = "io.modelcontextprotocol/tasks";

/**
 * The `extensions` bag's own capability descriptor for this URI - the
 * spec's real, generated `TasksExtensionCapability` schema (measured
 * against `modelcontextprotocol/ext-tasks`, see
 * `schema/tasks-extension.schema.json`) is an EMPTY object with
 * `additionalProperties: false`: it forbids any key at all, not merely
 * "does not require one." This constant used to carry
 * `{methods: [...]}`, an honest but non-conformant addition this adapter
 * invented before the extension finalized - the released contract does not
 * tolerate it, so it is gone, not merely unused.
 */
export const TASKS_CAPABILITY_DESCRIPTOR: JSONObject = Object.freeze({}) as unknown as JSONObject;

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
// Capability negotiation - the SOURCE this file is handed varies by era
// (see below), but the CHECK itself does not
// ---------------------------------------------------------------------------

/**
 * True when `clientCapabilities` advertised Tasks support under
 * `extensions`, the sole bag the finalized extension recognizes (see this
 * file's header on why `experimental` is not read). This is the ONLY
 * signal `maybeAugmentRunResult` consults - never
 * anything in `run()`'s own tool arguments, which is what keeps the
 * run-only mint rule free of a per-call opt-in field: a bare tool call with
 * no such field of any kind still mints on a capable connection/request,
 * and nothing about `run()`'s own arguments can turn minting on or off.
 *
 * WHERE `clientCapabilities` itself comes from is `src/server.ts`'s job,
 * not this function's - and it genuinely differs by era, matching each
 * era's own capability model, rather than being read the same way
 * regardless. On the legacy (pre-2026-07-28) era a client declares
 * capabilities ONCE, at `initialize` time, and `Server.getClientCapabilities()`
 * returns that SAME value for every request on the connection - honestly
 * connection-level, matching the legacy handshake itself. The 2026-07-28
 * revision has no `initialize` exchange to declare anything in at all - it
 * REQUIRES every request to carry its own
 * `io.modelcontextprotocol/clientCapabilities` `_meta` envelope key (see
 * the installed SDK's own `REQUIRED_ENVELOPE_KEYS`), so on that era
 * `clientCapabilities` here is THIS request's own declaration, read fresh
 * by `server.ts` off `ctx.mcpReq.envelope` - never the deprecated,
 * connection-scoped `getClientCapabilities()` accessor, which a
 * `serveStdio`-pinned modern instance never gets backfilled on at all
 * (confirmed by reading the installed SDK's own `serveStdio`/
 * `createMcpHandler` sources: only the HTTP entry point calls the SDK's
 * internal per-request backfill, and only because it builds a brand-new
 * `Server` instance per HTTP request to seed - stdio pins ONE instance for
 * a connection's whole lifetime and has no equivalent step). So
 * "per-request" on the modern era is that era's OWN correct capability
 * model, not a weaker guarantee than the legacy connection-level one - see
 * `src/server.ts`'s own header doc ("Reading a request's own declared
 * client capabilities") for the full mechanics of the split.
 */
export function isConnectionTasksCapable(
  clientCapabilities: ClientCapabilities | undefined
): boolean {
  if (clientCapabilities === undefined) return false;
  return hasTasksExtensionKey(clientCapabilities.extensions);
}

function hasTasksExtensionKey(bag: Record<string, unknown> | undefined): boolean {
  return bag !== undefined && Object.hasOwn(bag, TASKS_EXTENSION_URI);
}

// ---------------------------------------------------------------------------
// Task status - a closed, four-value set this adapter EMITS, a strict
// SUBSET of the spec's own closed, five-value `taskStatus` enum
// (`working | input_required | completed | cancelled | failed` - see the
// vendored `schema/tasks-extension.schema.json`'s `taskStatus` $def).
// 'expired' is never a member of either: a task past its TTL is REMOVED
// (see getTask's own docs on the frozen TTL-vs-timeout separation), not
// transitioned into some sixth status - a task that no longer resolves to
// a job (whether it never existed, or a TTL purge just reclaimed it)
// simply throws task_not_found rather than surfacing its own terminal
// status.
// ---------------------------------------------------------------------------

/**
 * The closed status set this adapter ever produces, as a real runtime
 * array (the same "type union alone is compile-time-only" reasoning
 * `src/jobStore.ts`'s own `ALL_JOB_STATES` already documents).
 *
 * This is a SUBSET of the released spec's own `taskStatus` enum, never an
 * equal set: `test/tasks.test.ts` asserts this array is a subset of the
 * vendored schema's `taskStatus.enum` (reading the real schema file, not a
 * hand-copied description of it), never a deep-equals - deep-equals was
 * correct only while this adapter's own schema documented OUR shape;
 * the schema above now pins the SPEC's shape instead, and the spec's
 * enum genuinely has a fifth value this adapter cannot produce.
 *
 * `input_required` is the excluded member, and it is excluded because it
 * is STRUCTURALLY UNREACHABLE for this adapter, never merely unobserved so
 * far: `input_required` exists in the spec for a task that needs the
 * CLIENT to supply more information mid-run (an elicitation, a tool
 * confirmation) before the server can continue - but every ghantika task
 * is backed by a `jobStore` job (a spawned OS process), and a spawned
 * process has no protocol-level step where it pauses to ask the calling
 * MCP client for input. `mapJobStateToTaskStatus` (below) has no branch
 * that could ever produce it: `JobState`'s own closed five-value enum
 * (`starting`/`running`/`exited`/`killed`/`failed`) contains nothing an
 * `input_required` task's own lifecycle would require. So this is a design
 * fact about what a job-backed task CAN be, not a claim that no client
 * would ever recognize the value - a conformant Tasks-capable client must
 * still handle `input_required` from OTHER MCP servers in general.
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
 * `exitCode` travels separately in the result, nested under
 * `CompletedTaskResult.result` per the spec's own free-form `result`
 * container - see `GhantikaResultExtras`, never folded into the status
 * itself); `failed` is the task-level `failed` - see `src/jobStore.ts`'s
 * `JobDiagnosticReason` docs for the full reason set. Most `failed` jobs
 * never spawned at all (a cwd/executable preflight rejection, a genuine
 * async spawn failure, or a command the policy gate denied), but
 * `watcher/runtime-error` is a legal producer of `failed` too for a
 * command that DID genuinely spawn and run - e.g. one terminated by its
 * own execution deadline before finishing naturally (see `run.ts`'s
 * deadline handling). `failed` at the task level therefore means "the task
 * did not run to natural completion", not "the task never ran"; `killed`
 * is `cancelled` (an explicit kill, whether via the `kill` tool today or a
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
// $defs exactly (validated in test/tasks.test.ts against the real,
// digest-verified schema file, never a hand-copied description of it).
// Every variant below restates its own fields in full rather than composing
// a shared base type, mirroring the schema's own header note on why it does
// the same (this repo's hand-rolled test validator does not implement
// `allOf`).
// ---------------------------------------------------------------------------

export interface TaskOutputCounts {
  readonly stdout_lines: number;
  readonly stdout_bytes: number;
  readonly stderr_lines: number;
  readonly stderr_bytes: number;
}

/** Present once this adapter's own output-driven notification WATCH auto-stopped early (currently only ever for a sustained firehose rate - see `WATCH_STOP_REASON_FIREHOSE`) - never means the backing job stopped. The job stays alive/pollable regardless; only the wake accelerator itself stopped. Absent for the ordinary lifetime of a task that never firehosed. Matches the vendored schema's `watchStoppedInfo` $def. */
export interface WatchStoppedInfo {
  readonly reason: string;
  readonly stoppedAt: string;
}

/**
 * ghantika's own additions inside the spec's free-form `CompletedTask.result`
 * / `FailedTask.error` JSONObject - matches the vendored schema's
 * `ghantikaResultExtras` $def exactly. Never top-level `Task` fields: the
 * spec's base `Task`/`WorkingTask`/`CancelledTask` interfaces carry no such
 * container, and every top-level field this adapter emits must be one the
 * spec itself defines.
 */
export interface GhantikaResultExtras {
  readonly exitCode?: number;
  readonly output?: TaskOutputCounts;
  readonly watchStopped?: WatchStoppedInfo;
}

/** The spec's `WorkingTask`, restated in full - see this file's header on why never composed via a shared base. The index signature (here and on every sibling variant below) is required so this shape satisfies the SDK's own generic `Result` return type at `server.setRequestHandler`'s call sites in `src/server.ts` - the installed SDK's typed request-handler surface has no notion of a Task-shaped result (see this file's header), so it types every untyped-method handler's return against a plain string-indexed record. */
export interface WorkingTaskResult {
  readonly [key: string]: unknown;
  readonly taskId: string;
  readonly status: "working";
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttlMs: number | null;
  readonly pollIntervalMs?: number;
}

/** The spec's `CompletedTask`, restated in full. See `WorkingTaskResult`'s own docs for why the index signature is required. */
export interface CompletedTaskResult {
  readonly [key: string]: unknown;
  readonly taskId: string;
  readonly status: "completed";
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttlMs: number | null;
  readonly pollIntervalMs?: number;
  readonly result: GhantikaResultExtras;
}

/** The spec's `FailedTask`, restated in full. See `WorkingTaskResult`'s own docs for why the index signature is required. */
export interface FailedTaskResult {
  readonly [key: string]: unknown;
  readonly taskId: string;
  readonly status: "failed";
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttlMs: number | null;
  readonly pollIntervalMs?: number;
  readonly error: GhantikaResultExtras;
}

/** The spec's `CancelledTask`, restated in full. See `WorkingTaskResult`'s own docs for why the index signature is required. */
export interface CancelledTaskResult {
  readonly [key: string]: unknown;
  readonly taskId: string;
  readonly status: "cancelled";
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttlMs: number | null;
  readonly pollIntervalMs?: number;
}

/**
 * The spec's `DetailedTask` discriminated union, narrowed to the four
 * variants ghantika's job model can ever actually produce (never
 * `InputRequiredTask` - see `TASK_STATUSES`'s own docs on why that variant
 * is structurally unreachable here).
 */
export type DetailedTaskResult =
  WorkingTaskResult | CompletedTaskResult | FailedTaskResult | CancelledTaskResult;

/**
 * `CreateTaskResult = Result & Task` per the spec: the FLAT base-`Task`
 * shape - `taskId`/`status`/`createdAt`/`lastUpdatedAt`/`ttlMs`, never a
 * `DetailedTaskResult` variant - plus `resultType: "task"`. A freshly
 * minted task carries no `result`/`error` at all, even if the backing job
 * happened to already be terminal at mint time (a job that started
 * already-failed, e.g. a bad cwd caught before ever spawning): the spec's
 * own `CreateTaskResult` shape has no `result`/`error` member for ANY
 * status, unlike `DetailedTaskResult`'s terminal variants - see
 * `buildCreateTaskResult`'s own docs.
 *
 * This name deliberately matches (and shadows, within this file only) the
 * SDK's own `@deprecated` `CreateTaskResult` export - this file never
 * imports that symbol (see this file's header), so there is no runtime or
 * compile-time collision; the shared name simply makes cross-referencing
 * the vendored schema's own `createTaskResult` $def easy for a reader.
 */
export interface CreateTaskResult {
  readonly taskId: string;
  readonly status: TaskStatusValue;
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttlMs: number | null;
  readonly pollIntervalMs?: number;
  readonly resultType: "task";
}

/** `GetTaskResult`'s `working` branch: `WorkingTaskResult` plus `resultType: "complete"`. */
export interface GetTaskResultWorking extends WorkingTaskResult {
  readonly resultType: "complete";
}

/** `GetTaskResult`'s `completed` branch. */
export interface GetTaskResultCompleted extends CompletedTaskResult {
  readonly resultType: "complete";
}

/** `GetTaskResult`'s `failed` branch. */
export interface GetTaskResultFailed extends FailedTaskResult {
  readonly resultType: "complete";
}

/** `GetTaskResult`'s `cancelled` branch. */
export interface GetTaskResultCancelled extends CancelledTaskResult {
  readonly resultType: "complete";
}

/**
 * `GetTaskResult = Result & DetailedTask` per the spec: `resultType:
 * "complete"` flattened alongside whichever `DetailedTaskResult` variant
 * matches the task's current status. Returned by `tasks/get` - the ONLY
 * one of the three registered methods that still returns a full snapshot
 * (see this file's header for why `tasks/update`/`tasks/cancel` return the
 * fixed `AckResult` instead).
 */
export type GetTaskResult =
  GetTaskResultWorking | GetTaskResultCompleted | GetTaskResultFailed | GetTaskResultCancelled;

/**
 * `UpdateTaskResult` / `CancelTaskResult` per the spec: an empty
 * acknowledgement carrying `resultType: "complete"`. Both are
 * eventually-consistent per the spec - the ack may arrive before the
 * task's observable status reflects the requested change. This is the
 * EMISSION-level shape - what this adapter's `updateTask`/`cancelTask`
 * actually produce, `additionalProperties: false` and nothing else, ever
 * (matching the vendored schema's `emittedAckResult` $def, the narrower
 * sibling of `ackResult`, which pins the more permissive CONTRACT the spec
 * itself tolerates).
 */
export interface AckResult {
  // See `WorkingTaskResult`'s own docs for why this index signature is
  // required - it is a TypeScript-only widening for `setRequestHandler`'s
  // generic Result typing and changes nothing about the real object
  // `ACK_RESULT` (below) actually carries at runtime.
  readonly [key: string]: unknown;
  readonly resultType: "complete";
}

/** The one, frozen `AckResult` value every real `updateTask`/`cancelTask` call returns - a single shared constant rather than a fresh object literal per call, since it is never mutated and always identical. */
const ACK_RESULT: AckResult = Object.freeze({ resultType: "complete" });

/** The poll-interval hint minted results and live snapshots both carry - a plain constant, never derived from anything Tasks-specific. */
export const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * How long a TERMINAL task's record is retained before a task-layer TTL
 * purge REMOVES it from `jobStore` entirely - a completely SEPARATE
 * concept from a job's own execution timeout (`run()`'s optional
 * `deadline_ms`, see `run.ts`): that timeout kills a still-running JOB,
 * transitioning it to `failed`, which is an entirely different effect than
 * this purge's "remove the now-stale, already-terminal completed record".
 * NEVER an 'expired' task status: a still-`working` task is NEVER purged
 * regardless of age (see `isExpiredTerminalRecord`'s own terminal-only
 * guard, which is what makes that true) - only a genuinely
 * completed/terminal record is reclaimed, and only once it is actually
 * READ again past this age (a lazy, read-time purge - see `getTask`'s own
 * docs for why this needs no separate scheduled sweep).
 *
 * This is also the value genuinely EXPOSED to a client, via `ttlMs`
 * on every terminal task-shaped response (`ttlMsFor`, below) -
 * previously it was a private constant this adapter consulted but
 * never surfaced. It is deliberately NOT exposed on a still-`working`
 * task: `ttlMs`'s meaning per this adapter's own purge design is "time
 * remaining before this TERMINAL record is reclaimed," and that clock has
 * not started for a task with no terminal instant to measure from yet - a
 * still-working task genuinely has no TTL in force, so its `ttlMs` is
 * `null` (a legal spec value, not an omission - see `ttlMsFor`).
 */
export const TASK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The `ttlMs` value for a task currently at `status` - `null` for
 * `working` (this adapter's TTL purge only ever counts down on a
 * TERMINAL record, from its own `ended_at` - see `TASK_TTL_MS`'s own
 * docs - so a still-working task has no real countdown to report, and
 * `null` is the schema-legal way to say so, never a fabricated number),
 * `TASK_TTL_MS` for every terminal status (`completed`/`failed`/
 * `cancelled`), since the purge clock genuinely starts running the instant
 * a job's `ended_at` is written.
 */
function ttlMsFor(status: TaskStatusValue): number | null {
  return status === "working" ? null : TASK_TTL_MS;
}

/**
 * Renders `info` (this adapter's own firehose watch-stop annotation - see
 * `WatchStoppedInfo`'s own docs) as human-readable text for a still-working
 * task's `statusMessage` field - the spec-legal, otherwise-unused free-text
 * field `WorkingTaskResult` carries (see that interface's own docs and the
 * vendored schema's matching comment on `workingTask.statusMessage`), used
 * here because `WorkingTaskResult` has no structured `result`/`error`
 * container the way a terminal variant does. A TERMINAL task carries the
 * SAME fact structurally instead, nested under `result.watchStopped` /
 * `error.watchStopped` (see `buildGhantikaResultExtras`) - this function is
 * for the pre-terminal case alone.
 */
function renderWatchStoppedStatusMessage(info: WatchStoppedInfo): string {
  return `output watch auto-stopped (${info.reason}) at ${info.stoppedAt}`;
}

/**
 * Builds the `GhantikaResultExtras` container for a TERMINAL record - the
 * spec's free-form `CompletedTask.result` / `FailedTask.error` JSONObject.
 * `exitCode` is included only when the record actually carries one
 * (mirroring `PublicJobProjection`'s own optional-field pattern - a
 * `killed`/spawn-failed job never has one), `output` is always included on
 * a terminal record (the real, live per-stream counts - always meaningful
 * once terminal, never a placeholder), and `watchStopped` is included only
 * when this adapter's own output watch actually auto-stopped early for
 * this job.
 */
function buildGhantikaResultExtras(record: JobRecord): GhantikaResultExtras {
  const watchStop = jobStore.getOutputWatchStopInfo(record.job_id);
  const counts = jobStore.getOutputCounts(record.job_id);
  return {
    ...(record.exit_code !== undefined ? { exitCode: record.exit_code } : {}),
    output: counts,
    ...(watchStop !== undefined ? { watchStopped: watchStop } : {}),
  };
}

/**
 * Projects a real `JobRecord` into the discriminated `DetailedTaskResult`
 * union - the shape `tasks/get` (via `buildGetTaskResult`) actually
 * returns, and, as of this change, ALSO the exact shape the real
 * `notifications/tasks` notification's own `params` carries (see
 * `startTaskStatusNotifier`, below): the spec's own
 * `TaskStatusNotificationParams = NotificationParams & Task` is a bare
 * `DetailedTask` with no further wrapping, identical to what `tasks/get`
 * would have returned for that same task at that same moment - so this
 * function is reused rather than duplicated for the notification path,
 * exported for exactly that reuse (previously module-local, since nothing
 * outside `getTask` needed it before this change). Pure: reads `jobStore`'s
 * own already-existing, real state (`getOutputWatchStopInfo`/
 * `getOutputCounts`) and the record's own fields, writes nothing.
 *
 * A still-`working` task carries the pre-terminal watch-stop signal (if
 * any) rendered as text into `statusMessage` (see
 * `renderWatchStoppedStatusMessage`) - the ONLY use this adapter makes of
 * that field. A terminal task carries the SAME underlying fact
 * structurally instead, nested inside `result`/`error` via
 * `buildGhantikaResultExtras` - never both at once for the same task,
 * since a task is either working or terminal, never both.
 */
export function buildDetailedTaskResult(record: JobRecord): DetailedTaskResult {
  const status = mapJobStateToTaskStatus(record.state);
  const base = {
    taskId: record.job_id,
    createdAt: record.started_at,
    lastUpdatedAt: record.last_updated_at,
    ttlMs: ttlMsFor(status),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };

  if (status === "working") {
    const watchStop = jobStore.getOutputWatchStopInfo(record.job_id);
    return {
      ...base,
      status: "working",
      ...(watchStop !== undefined
        ? { statusMessage: renderWatchStoppedStatusMessage(watchStop) }
        : {}),
    };
  }

  if (status === "completed") {
    return { ...base, status: "completed", result: buildGhantikaResultExtras(record) };
  }

  if (status === "failed") {
    return { ...base, status: "failed", error: buildGhantikaResultExtras(record) };
  }

  // status === "cancelled" - CancelledTaskResult carries no result/error at
  // all, per the spec's own CancelledTask shape.
  return { ...base, status: "cancelled" };
}

/** `tasks/get`'s complete real return shape: `buildDetailedTaskResult`'s snapshot with `resultType: "complete"` flattened alongside it. */
function buildGetTaskResult(record: JobRecord): GetTaskResult {
  return { ...buildDetailedTaskResult(record), resultType: "complete" } as GetTaskResult;
}

/**
 * Builds the flat `CreateTaskResult` (mint) shape for a freshly-started job
 * - see that interface's own docs for why it is never a `DetailedTaskResult`
 * variant, even when the backing job is already terminal at mint time.
 */
function buildCreateTaskResult(record: JobRecord): CreateTaskResult {
  const status = mapJobStateToTaskStatus(record.state);
  return {
    taskId: record.job_id,
    status,
    createdAt: record.started_at,
    lastUpdatedAt: record.last_updated_at,
    ttlMs: ttlMsFor(status),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    resultType: "task",
  };
}

/**
 * The JSON-RPC error this adapter throws for an unknown OR
 * expired-and-purged `taskId`. The released spec answers both cases with
 * the SAME error code, `-32602` (Invalid params) - "the specification does
 * not differentiate between the two scenarios at the protocol level" - so
 * this adapter's own former unknown-vs-TTL-purged distinction (a
 * `TaskNotFound` tagged value with one fixed `error: "task_not_found"`
 * string, covering both) collapses to one JSON-RPC error code here too,
 * with only the message text ever differing between the two call sites
 * (see `getTask`, below) - both are informational only, never part of the
 * wire contract a client parses.
 *
 * `ProtocolError`/`ProtocolErrorCode` are the SAME mechanism
 * `src/server.ts` already uses to reject a `tools/call` arriving before a
 * completed handshake (`ProtocolErrorCode.InvalidRequest`) - confirmed
 * directly against the installed SDK's own declaration file
 * (`declare enum ProtocolErrorCode { ... InvalidParams =
 * -32602 ... }`), not guessed: throwing this class from inside a
 * `setRequestHandler` callback is what the SDK's own request dispatch
 * turns into a real JSON-RPC error response for that request's id, the
 * exact mechanism `server.ts`'s `tools/call` gate already relies on.
 */
function taskNotFoundError(taskId: string): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `task not found: "${taskId}" is unknown or has expired`
  );
}

/**
 * True when `record` is BOTH terminal AND has been terminal for at least
 * `TASK_TTL_MS`, as observed from `now` - the one, load-bearing guard that
 * keeps TTL purge and job-execution-timeout frozen apart (see
 * `TASK_TTL_MS`'s own docs): a non-terminal record (still `working`,
 * however old `record.started_at` is) NEVER qualifies, unconditionally,
 * before age is even considered.
 *
 * A job whose concurrency slot is currently STRANDED (`jobStore.
 * isJobSlotStranded`) never qualifies either, for the same reason and at
 * the same unconditional priority: `jobStore.deleteJob` cannot touch
 * `activeSlots` (a store-wide counter, not part of any one job's own
 * record - see that method's own docs), so purging a stranded job's
 * record here would silently erase the only durable, attributable trace
 * of a held slot - both the observability `getStrandedSlotCount` provides
 * and the manual `kill()` late-recovery target - while the slot itself
 * stays held forever with no path back. This check runs BEFORE the age
 * check specifically so a record that is old enough to purge, but still
 * stranded, is refused rather than treated as merely "not yet".
 */
function isExpiredTerminalRecord(record: JobRecord, now: number): boolean {
  if (!isTerminalJobState(record.state)) return false;
  if (jobStore.isJobSlotStranded(record.job_id)) return false;
  if (record.ended_at === undefined) return false; // defensive only - every real terminal record sets this
  const endedAtMs = Date.parse(record.ended_at);
  if (Number.isNaN(endedAtMs)) return false; // defensive only - ended_at is always a real toISOString() value
  return now - endedAtMs >= TASK_TTL_MS;
}

/**
 * `tasks/get`'s complete implementation, and the shared existence/TTL
 * check `updateTask`/`cancelTask` (below) both delegate to first - THROWS
 * (never returns a tagged not-found value) on an unknown or just-TTL-purged
 * `taskId`, via `taskNotFoundError` (`-32602`, see that function's own
 * docs). This used to return `TaskResult | TaskNotFound`, a
 * tagged success value a client had to branch on; the released spec answers
 * a missing task with a real JSON-RPC error, so this now matches that
 * contract at the SDK boundary instead of inventing its own success-shaped
 * "not found."
 *
 * A PURE read with one deliberate side effect: the lazy TTL purge (see
 * `TASK_TTL_MS`'s own docs) - once a terminal record is read PAST its TTL,
 * this call both THROWS `task_not_found` AND reclaims the record via
 * `jobStore.deleteJob`, so the SAME expired record is never "found, but
 * reported not-found" more than once; a caller that never reads it again
 * simply leaves it in `jobStore` until the next read (or never, which is
 * an accepted, honest trade-off of a lazy-on-read design over a scheduled
 * sweep - no separate timer is needed per terminal task).
 *
 * `now` defaults to the real `Date.now()`; a caller never overrides it in
 * production - it exists as a parameter (mirroring
 * `src/process.ts`'s own `checkProcessIdentity`) purely so a test can
 * drive TTL expiry deterministically by mocking the GLOBAL `Date` (via
 * `node:test`'s `mock.timers`) rather than waiting out `TASK_TTL_MS` in
 * real wall-clock time.
 */
export function getTask(taskId: string, now: number = Date.now()): GetTaskResult {
  const record = jobStore.get(taskId);
  if (record === undefined) throw taskNotFoundError(taskId);
  if (isExpiredTerminalRecord(record, now)) {
    jobStore.deleteJob(taskId);
    throw taskNotFoundError(taskId);
  }
  return buildGetTaskResult(record);
}

/**
 * `tasks/update`'s complete implementation - see this file's header
 * ("`tasks/get` is a pure read; `tasks/update` is a pure existence/TTL
 * check plus a fixed ack") for the full design. Delegates existence/TTL
 * validation to `getTask` (discarding its snapshot - `getTask` itself
 * throws `task_not_found` for an unknown or expired `taskId`, which
 * propagates unchanged from here), then returns the fixed `ACK_RESULT`.
 * `inputResponses` is accepted at the request-validation boundary
 * (`taskUpdateParamsSchema`) but never read here - see this file's header
 * for why there is structurally nothing for it to mean on a job-backed
 * task.
 */
export function updateTask(taskId: string, now: number = Date.now()): AckResult {
  getTask(taskId, now);
  return ACK_RESULT;
}

/**
 * The real `tasks/cancel` implementation - see this file's header ("tasks/get
 * is a pure read...tasks/cancel is real") for the full design. Resolves
 * `taskId` -> `job_id` the SAME way `getTask` does (an unknown or
 * just-TTL-purged taskId throws `task_not_found` WITHOUT ever attempting a
 * kill - there is nothing left to terminate), then delegates the actual
 * termination to `src/tools/kill.ts`'s own exported `handler`, reusing its
 * existing process-group kill/reap containment rather than reimplementing
 * it here.
 *
 * Returns the SAME fixed `ACK_RESULT` `updateTask` returns, matching the
 * spec's own `CancelTaskResult` contract (an empty ack, eventually
 * consistent - the task's observable status may not have caught up to
 * `cancelled` the instant this call returns, even though this codebase's
 * own `kill.ts` claims the terminal state SYNCHRONOUSLY, the instant it
 * actually signals - see that file's "Idempotency and races" docs). This
 * used to return a FRESH `getTask` snapshot instead; the released
 * spec's own `UpdateTaskResult`/`CancelTaskResult` shape is a plain ack
 * with no task fields at all, so this no longer reads one back.
 *
 * `now` is captured ONCE by the caller (or defaults to one real
 * `Date.now()` here) for the existence/TTL check, exactly mirroring
 * `getTask`'s own `now` parameter.
 */
export async function cancelTask(taskId: string, now: number = Date.now()): Promise<AckResult> {
  getTask(taskId, now); // throws task_not_found - nothing to kill otherwise
  await killTool.handler({ job_id: taskId });
  return ACK_RESULT;
}

// ---------------------------------------------------------------------------
// Registration - a hand-rolled Standard Schema (https://standardschema.dev)
// for the tiny params shapes tasks/* methods take. Deliberately NOT zod:
// zod is a real dependency of the installed @modelcontextprotocol/server
// package, but never a DIRECT dependency of this repo's own package.json -
// importing it here would be an undeclared phantom dependency (works only
// because the SDK happens to hoist it today), exactly the class of drift
// check-sdk-exact-pin.mjs exists to rule out for the packages it DOES pin.
// The Standard Schema interface itself is a handful of fields (see the
// installed SDK's own `StandardSchemaV1` type, confirmed by reading its
// .d.mts directly), so implementing it by hand for these two- and
// three-field shapes is the honest choice.
// ---------------------------------------------------------------------------

export interface TaskIdParams {
  readonly taskId: string;
}

/**
 * Validates `{taskId: string}` - the params shape `tasks/get` and
 * `tasks/cancel` (registered in `src/server.ts`) take. A fresh object per
 * call (never shared/mutated state), matching this module's
 * zero-persistent-state design. `taskId` must be a NON-EMPTY string - the
 * vendored, digest-verified extension schema (`schema/tasks-extension.schema.json`)
 * pins `minLength: 1` on every `taskId` field it describes, so an empty
 * string would flow through `getTask`/`taskNotFoundError` and produce a
 * response that violates the very schema this adapter's results are
 * pinned against; this is where that constraint is actually enforced, at
 * the request boundary, before an empty taskId ever reaches a live
 * lookup.
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

/** `tasks/update`'s own params shape per the released spec: `{taskId, inputResponses}` - `taskId` validated exactly like `taskIdParamsSchema`, `inputResponses` accepted-but-unvalidated (see `updateTask`'s own docs for why it is never read: no `input_required` step can ever occur for a job-backed task, so there is nothing to validate its shape against). Present in the parsed params only when the caller actually supplied it, so a caller that omits it entirely (the overwhelmingly common real case, since ghantika never solicits one) never carries a stray `undefined`-valued key through. */
export interface TaskUpdateParams extends TaskIdParams {
  readonly inputResponses?: unknown;
}

export function taskUpdateParamsSchema(): StandardSchemaV1<unknown, TaskUpdateParams> {
  return {
    "~standard": {
      version: 1,
      vendor: "ghantika-tasks-adapter",
      validate(value: unknown) {
        if (typeof value === "object" && value !== null) {
          const record = value as Record<string, unknown>;
          const taskId = record.taskId;
          if (typeof taskId === "string" && taskId.length > 0) {
            return "inputResponses" in record
              ? { value: { taskId, inputResponses: record.inputResponses } }
              : { value: { taskId } };
          }
        }
        return { issues: [{ message: '"taskId" must be a non-empty string' }] };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Two genuinely distinct notifications, on two genuinely distinct wire
// method names, reconciled against the released spec here.
//
// (1) The output-driven wake - a coalesced, rate-bounded, firehose-guarded
// accelerator built entirely on jobStore.ts's two generic hooks
// (`onOutputArrival`/`onJobTerminal`) plus its generic watch-stop
// annotation, carrying a per-batch stdout/stderr DELTA. This existed
// before the extension finalized and used to travel under
// `notifications/tasks/status` - a name that reads as spec vocabulary but
// was never IN the spec (the real, released method is `notifications/tasks`,
// singular, no `/status` suffix - see `TASKS_NOTIFICATION_METHOD` below).
// Renamed to `GHANTIKA_OUTPUT_WAKE_METHOD`, a name that cannot be mistaken
// for extension wire vocabulary. The firehose guard and its coalescing
// behavior are preserved UNCHANGED here, under the new name, and this
// rename is the only change this section makes to that mechanism.
//
// (2) `notifications/tasks` (below, `TASKS_NOTIFICATION_METHOD`) - the
// REAL, spec-defined status notification, added by this change. Carries a
// complete `DetailedTask` snapshot (via `buildDetailedTaskResult`, reused
// from `getTask`'s own path) per status TRANSITION, including the
// terminal one - see `startTaskStatusNotifier`, below, for the full
// design and the field-by-field comparison against the released contract.
//
// Every named constant below is EXPORTED so a test can assert against it
// directly, never a magic literal.
//
// `startTaskWatch` is deliberately the ONLY place in this file that holds
// any per-task MUTABLE state, and even there it is pure closure state (a
// handful of local `let`s/plain arrays, never a `new Map`/`new Set`/
// `new WeakMap`/`new WeakSet`/`Array(...)`/`new Array(...)`/`Object(...)`/
// `new Object(...)` construction) - this file is scanned by
// `scripts/check-module-boundaries.mjs`'s persistent-state check exactly
// like every other frozen module (see this file's own header), so it may
// never grow a Map/Set of its own. Anything that needs to persist ACROSS
// separate calls into this file (not just across lines within one job's
// watch) lives in `jobStore.ts` instead - the watch-stop annotation is
// exactly that: `getTask` (elsewhere in this file) reads it back on a
// totally separate invocation, long after `startTaskWatch`'s own closure
// for that job may never run again. `startTaskStatusNotifier` (below)
// holds no mutable state of its own at all - it is a single
// `onJobTerminal` subscription with no closure variables to track.
// ---------------------------------------------------------------------------

/** Output lines - stdout or stderr, on the SAME shared window - arriving within this many ms of each other collapse into ONE wake, carrying both streams together when both produced lines in that window - the sole batching mechanism (never lifecycle-based: a long-running command gets one wake per closed window, for its whole life, not a single end-of-run wake). */
export const WAKE_COALESCE_WINDOW_MS = 200;

/** The wake-emission rate this adapter never exceeds - implied by construction (1000 / WAKE_COALESCE_WINDOW_MS = 5): at most one wake fires per coalescing window, so at most one every 200ms. Named separately because it is independently pinned and asserted against. */
export const WAKE_MAX_RATE_PER_SEC = 5;

/** A sustained line-arrival rate above this many lines/sec, combined across stdout and stderr, is a "firehose". */
export const FIREHOSE_LINES_PER_SEC = 5000;

/** How long a firehose-rate stream must sustain before the notification WATCH (never the job) auto-stops. */
export const FIREHOSE_SUSTAINED_MS = 2000;

/** The exact `watchStopped.reason` literal this adapter ever produces. */
export const WATCH_STOP_REASON_FIREHOSE = "firehose";

/**
 * ghantika's own pre-existing, non-spec output-delta wake's method name -
 * deliberately namespaced under `ghantika`, never under `tasks`, so it can
 * never be mistaken for the extension's own wire vocabulary by a
 * conformant client reading the method name alone. Was
 * `notifications/tasks/status` before this change (see this section's own
 * header for why that name was retired, not merely relocated). Optional:
 * a client MUST NOT rely on receiving it and continues to poll
 * `tasks/get`/`output`/`tail` regardless (see this section's own docs on
 * the poll floor) - unchanged by the rename.
 */
export const GHANTIKA_OUTPUT_WAKE_METHOD = "notifications/ghantika/outputWake";

/**
 * The released extension's REAL notification method name - exact-string
 * wire identity, matching `specification/draft/tasks.md`'s own
 * `TaskStatusNotification.method` const precisely (`method:
 * "notifications/tasks";`, confirmed by reading the spec text directly,
 * not inferred): singular `tasks`, no `/status` suffix. See
 * `startTaskStatusNotifier`, below, for what actually sends it and the
 * full field-by-field comparison against the released contract.
 */
export const TASKS_NOTIFICATION_METHOD = "notifications/tasks";

/** One output line (stdout or stderr) as carried in a wake notification's payload - the SAME shape (seq/text/partial) `src/tools/output.ts`'s own `OutputEvent` uses for either stream, so the wake never carries state the poll floor can't independently surface. */
export interface TaskWakeLine {
  readonly seq: number;
  readonly text: string;
  readonly partial?: true;
}

/**
 * The one thing `maybeAugmentRunResult` needs from `src/server.ts` to
 * actually deliver a notification of either kind this file sends: a thin
 * function wrapping the real connected `Server`'s own `notification()`
 * call. Keeping this a plain function type (rather than importing the
 * `Server` class itself) is what lets this file stay unaware of the SDK's
 * server wiring beyond the generic types it already imports.
 *
 * Takes `method` as its own explicit argument, rather than being one
 * notifier per method, because this file now sends TWO genuinely distinct
 * notifications on two genuinely distinct method names
 * (`GHANTIKA_OUTPUT_WAKE_METHOD` from `startTaskWatch`'s own `flush`,
 * `TASKS_NOTIFICATION_METHOD` from `startTaskStatusNotifier`) through the
 * SAME underlying `server.notification(...)` call - `src/server.ts` never
 * needs to know which method is being sent for any given call, only how
 * to relay whatever this file hands it.
 */
export type TaskWakeNotifier = (method: string, params: Record<string, unknown>) => void;

function isPartialTerminator(terminator: StreamLineTerminator): boolean {
  return terminator === "stream-end" || terminator === "oversized-split";
}

function toWakeLine(line: StreamLineEntry): TaskWakeLine {
  return isPartialTerminator(line.terminator)
    ? { seq: line.seq, text: line.text, partial: true }
    : { seq: line.seq, text: line.text };
}

/**
 * Builds one wake notification's params from whatever this closed window
 * actually produced. `stdout`/`stderr` are each included only when THIS
 * batch carries at least one line for that stream - mirroring this
 * adapter's own house style of only ever including an optional field when
 * it carries a genuine, present value rather than always emitting an
 * empty array a client would have to filter out. A window that saw only
 * stdout carries `stdout` alone, exactly as before this adapter also woke
 * on stderr; a mixed window carries both.
 */
function buildWakeParams(
  taskId: string,
  stdoutLines: readonly StreamLineEntry[],
  stderrLines: readonly StreamLineEntry[]
): Record<string, unknown> {
  return {
    extension: TASKS_EXTENSION_URI,
    taskId,
    ...(stdoutLines.length > 0 ? { stdout: stdoutLines.map(toWakeLine) } : {}),
    ...(stderrLines.length > 0 ? { stderr: stderrLines.map(toWakeLine) } : {}),
  };
}

/**
 * Starts the output-driven wake watch for a freshly-minted task - called
 * only from `maybeAugmentRunResult`, and only when the backing job is not
 * ALREADY terminal (a job that's already done has no "life" left to wake
 * about - see that function's own call site). Subscribes to jobStore's two
 * generic hooks and drives, for the life of the watch:
 *
 * - stdout AND stderr, time-window batching on ONE shared window per
 *   stream pair. Every line from either stream pushes onto that stream's
 *   own CURRENT open-window pending batch and (re-)arms a single
 *   `WAKE_COALESCE_WINDOW_MS` timer if one isn't already armed; the timer
 *   firing is what flushes both batches together as one wake (see
 *   `buildWakeParams` for how a window that only ever saw one stream still
 *   carries just that stream's key).
 * - firehose detection - `checkFirehose` (below) tracks a rolling
 *   "since when has the sustained rate held at/above FIREHOSE_LINES_PER_SEC"
 *   window, COMBINED across both streams (a firehose on either stream, or
 *   split across both, trips the same guard); once that span reaches
 *   FIREHOSE_SUSTAINED_MS, the watch auto-stops (unsubscribes, records the
 *   stop reason) - the job itself is NEVER touched.
 * - terminal flush ordering - `onJobTerminal` flushes any
 *   pending open-window lines (either stream) as one final wake BEFORE
 *   marking the watch stopped, so no line is lost to the window merely
 *   closing, and nothing wakes after (the watch is unsubscribed
 *   synchronously, in the SAME terminal callback, before returning).
 *
 * TTL scheduling is NOT handled here - it's read-time, in `getTask`,
 * entirely independent of whether a watch was ever started for a job (a
 * non-capable connection's job never gets a watch at all, but its
 * terminal record is still subject to the same TTL purge on read).
 */
function startTaskWatch(taskId: string, notifier: TaskWakeNotifier): void {
  let pendingStdoutLines: StreamLineEntry[] = [];
  let pendingStderrLines: StreamLineEntry[] = [];
  let windowTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let totalLinesSeen = 0;
  let firehoseWindowStartMs: number | undefined;
  let firehoseWindowStartCount = 0;

  const clearWindowTimer = (): void => {
    if (windowTimer !== undefined) {
      clearTimeout(windowTimer);
      windowTimer = undefined;
    }
  };

  const flush = (): void => {
    clearWindowTimer();
    if (pendingStdoutLines.length === 0 && pendingStderrLines.length === 0) return;
    const stdoutLines = pendingStdoutLines;
    const stderrLines = pendingStderrLines;
    pendingStdoutLines = [];
    pendingStderrLines = [];
    notifier(GHANTIKA_OUTPUT_WAKE_METHOD, buildWakeParams(taskId, stdoutLines, stderrLines));
  };

  const scheduleWindow = (): void => {
    if (windowTimer !== undefined) return; // a window is already open - this line joins it
    windowTimer = setTimeout(flush, WAKE_COALESCE_WINDOW_MS);
  };

  // `stopWatch` references `unsubscribeOutput`/`unsubscribeTerminal` before
  // their own `const` declarations appear textually below - safe, because
  // `stopWatch` is only ever CALLED from inside a listener, and a listener
  // can only run AFTER `jobStore.onOutputArrival`/`onJobTerminal` (both
  // synchronous calls) have already returned and assigned them. No
  // temporal-dead-zone hazard: the references are resolved at CALL time,
  // not definition time.
  //
  // Tears down BOTH subscriptions, not just the output one: a firehose
  // auto-stop previously left the terminal listener registered forever
  // (its own `if (stopped) return` guard made it inert, but never removed
  // it from JobStore), which leaked one listener per firehose-stopped job
  // for the job's whole remaining life. Calling `unsubscribeTerminal` here
  // too closes that regardless of which path stops the watch first.
  const stopWatch = (): void => {
    if (stopped) return;
    stopped = true;
    clearWindowTimer();
    unsubscribeOutput();
    unsubscribeTerminal();
  };

  /**
   * True once the CURRENT sustained-high-rate streak (tracked by
   * `firehoseWindowStartMs`/`firehoseWindowStartCount`) has held at/above
   * `FIREHOSE_LINES_PER_SEC` for at least `FIREHOSE_SUSTAINED_MS`. A
   * streak starts the moment a computed rate first reaches the threshold
   * and resets (restarts fresh at the CURRENT line) the moment it drops
   * below - so a genuinely bursty-then-quiet stream never accumulates
   * elapsed time across separate bursts, only a truly CONTINUOUS
   * high-rate span counts.
   */
  const checkFirehose = (now: number): boolean => {
    if (firehoseWindowStartMs === undefined) {
      firehoseWindowStartMs = now;
      firehoseWindowStartCount = totalLinesSeen;
      return false;
    }
    const elapsedMs = now - firehoseWindowStartMs;
    const linesInWindow = totalLinesSeen - firehoseWindowStartCount;
    const rate = elapsedMs > 0 ? (linesInWindow * 1000) / elapsedMs : Infinity;
    if (rate < FIREHOSE_LINES_PER_SEC) {
      firehoseWindowStartMs = now;
      firehoseWindowStartCount = totalLinesSeen;
      return false;
    }
    return elapsedMs >= FIREHOSE_SUSTAINED_MS;
  };

  const unsubscribeOutput = jobStore.onOutputArrival(taskId, (event) => {
    if (stopped) return;
    totalLinesSeen += 1;
    if (checkFirehose(Date.now())) {
      // The WATCH auto-stops; the job is never killed by this - it
      // stays alive/pollable via output/tail, and the pending batch is
      // simply dropped (a firehose has already produced far more than any
      // wake could usefully carry - the poll floor remains the honest way
      // to read it all back).
      pendingStdoutLines = [];
      pendingStderrLines = [];
      stopWatch();
      jobStore.recordOutputWatchStopped(
        taskId,
        WATCH_STOP_REASON_FIREHOSE,
        new Date().toISOString()
      );
      return;
    }
    if (event.stream === "stdout") pendingStdoutLines.push(event.line);
    else pendingStderrLines.push(event.line);
    scheduleWindow();
  });

  const unsubscribeTerminal = jobStore.onJobTerminal(taskId, () => {
    if (stopped) return;
    flush(); // any pending open-window lines flush BEFORE the terminal close
    stopWatch(); // also unsubscribes this same terminal listener - see its own docs
    // No GHANTIKA_OUTPUT_WAKE_METHOD wake fires for the terminal transition
    // itself - this watch's whole job is the output-delta accelerator
    // (stdout and stderr both), never a status announcement of its own, and
    // that stays true after this change. A SEPARATE notification genuinely
    // DOES fire on the terminal transition now - see `startTaskStatusNotifier`,
    // below, which subscribes independently (never through this watch's own
    // listener) specifically so a firehose-triggered stop of THIS watch can
    // never also silence that one - and the terminal status is, either way,
    // always observable via tasks/get / the poll floor regardless of
    // whether anything is watching for either notification.
  });
}

/**
 * Starts the RELEASED spec's own `notifications/tasks` per-transition
 * status notification for a freshly-minted task - called only from
 * `maybeAugmentRunResult`, alongside (never instead of) `startTaskWatch`,
 * and under the identical guard: only when the backing job is not ALREADY
 * terminal at mint time (a job with no further transition ahead of it has
 * nothing left to notify about).
 *
 * Deliberately a SEPARATE `jobStore.onJobTerminal` subscription from
 * `startTaskWatch`'s own, rather than piggy-backing on that watch's
 * existing terminal listener - this is what keeps the firehose guard from
 * ever silencing it: `startTaskWatch`'s firehose guard can auto-stop and
 * unsubscribe ITS OWN output-delta watch
 * (including its own terminal listener, torn down together via
 * `stopWatch()`) without that ever reaching this subscription, which keeps
 * running independently and still fires when the job's real terminal
 * transition eventually happens. The firehose guard governs the
 * output-delta wake ONLY - it has no bearing here, since this notification
 * fires AT MOST ONCE per task regardless of how much output the job ever
 * produced, so there is nothing for a rate guard to protect against.
 *
 * Fires exactly once per task, on the SAME state transition `getTask`
 * would observe if it were read at that exact instant - `buildDetailedTaskResult`
 * (this file's own, reused unchanged) is what makes that guarantee real:
 * the notification's `params` and a `tasks/get` response captured at the
 * same moment are never two different projections of the same record, they
 * are the SAME projection, called twice.
 *
 * ## Field-by-field comparison against the released contract
 *
 * Method name: `TASKS_NOTIFICATION_METHOD` ("notifications/tasks") is the
 * EXACT string `specification/draft/tasks.md`'s own
 * `TaskStatusNotification.method` const carries - no divergence.
 *
 * Payload shape: the spec defines `TaskStatusNotificationParams =
 * NotificationParams & Task` - a bare `DetailedTask` (the spec's own
 * worked example shows a `completed`-status notification body with no
 * wrapper beyond the task fields themselves: `taskId`/`status`/
 * `createdAt`/`lastUpdatedAt`/`ttlMs`/`pollIntervalMs`/`result`). This
 * adapter's `params` (below) is `buildDetailedTaskResult(record)` passed
 * through UNCHANGED - the exact same object `tasks/get` builds for the
 * same task, narrowed to this adapter's own four reachable statuses (see
 * `TASK_STATUSES`'s own docs on why `input_required` never appears) - no
 * divergence on any field the spec defines. `NotificationParams`'s own
 * generic base (an optional `_meta` bag every JSON-RPC notification may
 * carry) is never populated here, matching this adapter's house style of
 * omitting an optional field this adapter has nothing genuine to put in
 * it, rather than emitting an empty placeholder.
 *
 * Subscription/unsubscription protocol: THIS is where this adapter
 * genuinely diverges, and the divergence is disclosed rather than hidden.
 * The released spec ties delivery to an explicit `subscriptions/listen`
 * request naming task IDs, acknowledged via
 * `notifications/subscriptions/acknowledged` with the honored subset
 * echoed back. ghantika delivers `notifications/tasks` to every
 * Tasks-capable connection for tasks that connection minted,
 * UNCONDITIONALLY - the same unconditional delivery model this file's own
 * pre-existing `GHANTIKA_OUTPUT_WAKE_METHOD` wake already used, extended
 * to this notification rather than reinvented. This is not an oversight:
 * `subscriptions/listen` is ALREADY live-wired on ghantika's stdio
 * connection today, automatically, by the installed SDK's own
 * `serveStdio` entry (`stdio.mjs`'s `tryServeListen`, intercepted before
 * any of this codebase's own request handlers ever see it) - but that
 * SDK-level routing has ZERO knowledge of task notifications at all,
 * confirmed by reading the installed SDK's own source directly: its
 * `CHANGE_NOTIFICATION_METHODS`/`honoredSubset()` machinery covers exactly
 * four unrelated core methods (the `tools`/`prompts`/`resources`
 * list-changed family plus `resources/updated`), and grepping the WHOLE
 * installed SDK's `dist/` for `taskIds` (the spec's own filter field name)
 * returns zero occurrences anywhere. So a client that sends
 * `subscriptions/listen` naming this connection's task IDs gets a real
 * SDK-generated acknowledgement back, but that acknowledgement's own
 * honored set can never list those task IDs - no code path that exists
 * anywhere in the installed SDK could ever populate it. Building
 * ghantika-side `taskIds`-filtering machinery to gate this notification
 * against a listen mechanism the installed SDK cannot honor for tasks was
 * considered and explicitly rejected: it would couple this adapter to the
 * SDK's own undocumented internals to work around a gap that is the SDK's
 * to close, for a filtering behavior a client could never actually confirm
 * via the acknowledgement it would receive either way. ghantika delivers
 * task notifications to every Tasks-capable connection for tasks that
 * connection minted, unconditionally. A client that sends
 * `subscriptions/listen` naming specific task IDs will receive an
 * acknowledgement that does not list them among the honored set, and
 * should not rely on that acknowledgement to determine whether it receives
 * notifications.
 */
function startTaskStatusNotifier(taskId: string, notifier: TaskWakeNotifier): void {
  jobStore.onJobTerminal(taskId, () => {
    const record = jobStore.get(taskId);
    // Defensive only - the record that just transitioned into a terminal
    // state must still exist at this exact synchronous instant (this
    // listener runs as part of the SAME `fireJobTerminal` dispatch that
    // just wrote the terminal state); a genuinely undefined read here would
    // mean the record was deleted between the transition and this
    // synchronous callback, which no code path in this codebase does.
    if (record === undefined) return;
    notifier(TASKS_NOTIFICATION_METHOD, buildDetailedTaskResult(record));
  });
}

// ---------------------------------------------------------------------------
// The transport-layer wake - a mechanism for eventually resuming an idle
// AGENT SESSION on the host machine (a Codex thread, a Claude Code session)
// via `src/wake/selectTransport.ts`'s `selectAndWake`, rather than pushing
// an MCP notification down THIS connection the way both mechanisms above
// do (see `src/wake/wakeTransport.ts`'s own header for that same
// distinction, stated from the transport side).
//
// TWO GATES, DELIBERATELY NOT ONE, because they answer different
// questions and must never be entangled - a future change to what either
// one means must not silently change what the other governs.
//
// `GHANTIKA_WAKE_TRANSPORT_ENABLED` governs `CODEX_GATED_TRANSPORTS` only
// (the app-server and desktop-IPC routes). Both address a runtime-resolved
// Codex thread id over a channel whose reach is genuinely uncertain - a
// shared app-server, an IPC bus with ambiguous session ownership - which is
// exactly the case an operator opt-in exists for. Defaults to OFF. Real
// server-side configuration, documented for a human operator in README.md's
// "The app-server wake (Codex)" section and docs/wake-support-matrix.md's
// per-client matrix - never a tool-schema field, a capability, or anything
// an MCP client can discover or set through the wire protocol itself.
//
// `GHANTIKA_DISABLE_CLAUDE_MESSAGING_WAKE` governs `CLAUDE_MESSAGING_WAKE_
// TRANSPORT` only, and it is an OPT-OUT, not an opt-in: that transport's
// reach is fixed by AC2's own env-only chokepoint (this session's own
// inherited socket, never constructed or guessed), so the uncertainty the
// other gate exists for does not arise here, and the transport is attempted
// by default. A user who does not want ghantika injecting a turn into
// their session sets this variable to say so, in one place, documented in
// README.md's "The inherited-messaging-channel wake (Claude Code)" section.
// Defaults to OFF (the transport runs).
//
// A client's own request can resolve a wake TARGET (see
// `resolveWakeTarget.ts`) but never arms either gate; only the server
// process's own environment can.
// ---------------------------------------------------------------------------

const WAKE_TRANSPORT_ENABLED_ENV = "GHANTIKA_WAKE_TRANSPORT_ENABLED";
const CLAUDE_MESSAGING_WAKE_DISABLE_ENV = "GHANTIKA_DISABLE_CLAUDE_MESSAGING_WAKE";

/** True only when the Codex-transports enablement toggle is set to the exact string `"1"` - never a truthy/falsy env-var check, matching this file's own `isRunningUnderClaudeCode`-style (in `selectTransport.ts`) exact-match convention. Read fresh on every call rather than cached at module load, so a test can flip it between calls within one process. Governs `CODEX_GATED_TRANSPORTS` only - see this section's own header. */
function isTransportWakeEnabled(): boolean {
  return process.env[WAKE_TRANSPORT_ENABLED_ENV] === "1";
}

/** True only when the opt-out is set to the exact string `"1"` - same exact-match convention as its sibling gate above. Governs `CLAUDE_MESSAGING_WAKE_TRANSPORT` only, and only that one: this is an opt-OUT, so the transport runs by default and this function returning `true` is what suppresses it. */
function isClaudeMessagingWakeDisabled(): boolean {
  return process.env[CLAUDE_MESSAGING_WAKE_DISABLE_ENV] === "1";
}

/**
 * A short, factual string for a transport's `wake()` payload - never a
 * "creative" wake message, matching this file's own house register for
 * `buildDetailedTaskResult`/`buildWakeParams`: names the fact (the task id,
 * the exact terminal `JobState` it reached) and the concrete next step (the
 * poll floor), nothing about what happens next beyond what is literally
 * true.
 *
 * Names only `status`/`output`/`tail`, deliberately never `tasks/get` -
 * those three are the ordinary `tools/call` surface every MCP client
 * already knows how to invoke, while `tasks/get` is a raw Tasks-extension
 * wire method a recipient's own client has to understand on its own terms
 * to call at all. `tasks/get` now dispatches on both protocol eras (see
 * server.ts's own `attachExtensionTaskMethodInterceptor`), so era-routing
 * is no longer a reason to exclude it here - but this payload still has no
 * way to know whether the RECIPIENT session's client software is
 * Tasks-extension-aware in the first place, and `status`/`output`/`tail`
 * are the one instruction this payload can make without depending on that.
 */
function buildTransportWakePayload(taskId: string, record: JobRecord): string {
  return `ghantika job ${taskId} reached ${record.state} - use status/output/tail to read the result`;
}

/**
 * Starts the transport-layer wake for a still-live job - called only from
 * `maybeAugmentRunResult`, alongside (never instead of)
 * `startTaskWatch`/`startTaskStatusNotifier`, and sharing exactly ONE guard
 * with them: only when the backing job is not ALREADY terminal at mint time
 * (a job with no further transition ahead of it has nothing left to wake
 * about). It does NOT share their other guard: `startTaskWatch` and
 * `startTaskStatusNotifier` run only on a Tasks-capable connection, because
 * both push an MCP notification down THAT connection. This function never
 * does - it subscribes on `jobId`, a real job `run()` already created
 * whether or not this connection is Tasks-capable, and its own delivery
 * (`selectAndWake`, below) is out-of-band, addressed by `wakeTargetResolution`
 * rather than by anything this connection negotiated. So `isCapableConnection`
 * is simply not an input to this function - a non-capable connection's job
 * is exactly as valid a subject as a capable one's. A SEPARATE
 * `jobStore.onJobTerminal` subscription from both siblings' own - the same
 * independence reasoning `startTaskStatusNotifier`'s own docs give for why
 * it is separate from `startTaskWatch`: a firehose auto-stop of the
 * output-delta watch, or any future change to either sibling, must never
 * also silence this one, and vice versa. Fires AT MOST ONCE per task,
 * exactly like `startTaskStatusNotifier` - `jobStore.onJobTerminal` itself
 * guarantees the single-fire property (see that method's own docs), this
 * function does not need to track its own "already fired" state.
 *
 * TWO INDEPENDENT GATES, never one - see this section's own header comment
 * for the full reasoning. `resolution.state` on its own no longer decides
 * whether ANYTHING is attempted: it decides only whether `CODEX_GATED_
 * TRANSPORTS` participate, because those two need a real Codex thread id
 * to address anything at all. `CLAUDE_MESSAGING_WAKE_TRANSPORT` needs no
 * target - AC2's whole point - so it is attempted regardless of
 * `resolution.state`, gated only by its own opt-out. A plain Claude Code
 * client's request never carries the Codex-specific `_meta.threadId` this
 * file's `resolveWakeTarget` reads, so `resolution.state` is `"absent"`
 * for the exact zero-config audience this transport exists to serve - a
 * gate keyed on `resolution.state === "resolved"` alone would silently
 * never try it for that audience, which is the wiring bug this function's
 * two-list construction below exists to avoid.
 *
 * `"malformed"` is still logged (a wrong target must be loud, never
 * silently swallowed - matching `sendTaskNotification`'s own
 * `console.error` catch-pattern style), but logging it no longer skips
 * the rest of this callback - a malformed Codex-specific field must never
 * suppress the DIFFERENT mechanism that has nothing to do with it.
 * `CODEX_GATED_TRANSPORTS` are excluded from the attempted list either
 * way, exactly as before: a malformed `threadId` never reaches them.
 *
 * The `target` argument `selectAndWake` receives is the real resolved
 * target when one exists, and `taskId` otherwise (a placeholder,
 * informational only - see `claudeMessagingTransport.ts`'s own header on
 * why `target` plays no addressing role for that transport). Safe only
 * because `CODEX_GATED_TRANSPORTS` are never included in the same call
 * when `target` is a placeholder; passing that placeholder to a transport
 * that DOES address by it would misaddress it.
 *
 * The whole path is fire-and-forget, exactly like `sendTaskNotification`
 * already is: `selectAndWake`'s own promise is `.then`/`.catch`-handled
 * inline, never `await`ed - this callback itself is synchronous and
 * returns without waiting on any transport call - and nothing here can
 * ever affect `maybeAugmentRunResult`'s own return value or throw into the
 * `tools/call` response path that triggered it. A wake failure (a
 * non-`"delivered"` outcome, or a thrown/rejected `selectAndWake` call
 * itself) is a `console.error` line, nothing more - the poll floor
 * (`tasks/get`/`status`/`output`/`tail`) stays authoritative regardless of
 * whether this ever fires or what it finds when it does.
 */
function startTransportWakeOnTerminal(taskId: string, resolution: WakeTargetResolution): void {
  const unsubscribeTerminal = jobStore.onJobTerminal(taskId, () => {
    // Called first, unconditionally, before any of this callback's own
    // early returns - `onJobTerminal` fires this at most once per task,
    // but `fireJobTerminal` never removes a fired listener from its own
    // Set on its own (see that method's own docs), so this closure - and,
    // for a resolved target, the target-resolution data it captured -
    // must unsubscribe itself to avoid staying registered for the job's
    // whole remaining life. Matches `stopWatch`'s own `unsubscribeTerminal`
    // call above, which does the same for its sibling subscription.
    unsubscribeTerminal();

    if (resolution.state === "malformed") {
      // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- taskId is this codebase's own randomUUID(), never attacker-supplied, and this is a diagnostic console.error to stderr, not a format-string sink.
      console.error(
        `[ghantika] transport wake target malformed for task ${taskId}: wake target ${resolution.reason}`
      );
      // Fall through, deliberately - see this function's own doc comment.
      // CODEX_GATED_TRANSPORTS are still excluded below (resolution.state
      // is not "resolved"); CLAUDE_MESSAGING_WAKE_TRANSPORT is unaffected.
    }

    const record = jobStore.get(taskId);
    // Defensive only - see startTaskStatusNotifier's own identical comment:
    // this listener runs as part of the SAME synchronous fireJobTerminal
    // dispatch that just wrote the terminal state, so a genuinely undefined
    // read here would mean the record was deleted in between, which no
    // code path in this codebase does.
    if (record === undefined) return;

    const transports: WakeTransport[] = [];
    if (!isClaudeMessagingWakeDisabled()) transports.push(CLAUDE_MESSAGING_WAKE_TRANSPORT);
    if (resolution.state === "resolved" && isTransportWakeEnabled()) {
      transports.push(...CODEX_GATED_TRANSPORTS);
    }
    if (transports.length === 0) return; // nothing eligible - both gates say no

    const target = resolution.state === "resolved" ? resolution.target : taskId;

    selectAndWake(transports, target, buildTransportWakePayload(taskId, record))
      .then((wakeResult) => {
        if (wakeResult.outcome !== "delivered") {
          console.error(
            // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- wakeResult.outcome is this codebase's own WakeResult union ("refused" | "unavailable"), never attacker-supplied, and this is a diagnostic console.error to stderr, not a format-string sink.
            `[ghantika] transport wake ${wakeResult.outcome} for task`,
            taskId,
            "-",
            wakeResult.detail
          );
        }
      })
      .catch((error: unknown) => {
        console.error("[ghantika] transport wake threw for task", taskId, error);
      });
  });
}

// ---------------------------------------------------------------------------
// Minting - the run-only mint rule: ONLY run(), ONLY on a capable
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
 * never trusted blindly) or replaces it ENTIRELY with the minted
 * `CreateTaskResult` for the SAME job the plain result already named.
 * Never mints for any job other than the one `result` itself is about,
 * and the RETURNED RESULT itself never touches `jobStore` beyond the
 * SAME kind of read `getTask` performs. This function's own side
 * effect - a terminal-transition listener registered via
 * `startTransportWakeOnTerminal` (see its own docs) - is a real
 * `jobStore` write made unconditionally, independent of what gets
 * returned.
 *
 * REPLACES, never augments alongside, `content`/`structuredContent` - this
 * was an explicitly flagged open question before this adapter was built
 * against it (the spec's own `CreateTaskResult = Result & Task` example JSON
 * carries no `content`/`structuredContent` members, and the vendored
 * schema's `createTaskResult` $def locks `additionalProperties: false`
 * against a property set that does not include either). GROUNDED against
 * the installed SDK's own runtime for this adapter, not merely inferred
 * from the spec text: `stampResultType` (the SDK's own encode-contract
 * step, confirmed by reading `@modelcontextprotocol/server`'s bundled
 * source directly) treats `tools/call` as one of
 * `EXTENDED_RESULT_TYPE_METHODS` - a handler-provided `resultType` other
 * than `"complete"` passes through UNCHANGED, added onto whatever object
 * shape the handler itself returned via a plain object spread
 * (`{...result, resultType: "complete"}` when the handler supplied
 * none). The SDK does not itself validate that a `resultType: "task"`
 * result also carries `content`/`structuredContent` - it is purely
 * additive at the top level, and the SDK never enforces that shape either
 * way. So whether the two coexist is entirely this adapter's own design
 * choice, not something the SDK forces - and the schema's own
 * `additionalProperties: false` is what settles it: this adapter must
 * emit the flat `CreateTaskResult` shape and nothing else, or it violates
 * its own pinned contract. The cast below (`as unknown as CallToolResult`)
 * exists ONLY to satisfy the installed SDK's own typed `tools/call`
 * handler surface, which has no notion of a Task-shaped result at all
 * (the SDK's own `Task`-family types are marked `@deprecated`, unrelated
 * to this real, runtime-correct shape - see this file's header) - the
 * object that actually reaches the wire is the genuine `CreateTaskResult`
 * this function builds, never a real `CallToolResult`.
 *
 * ONE DISCLOSED WIRE ARTIFACT, MEASURED (not inferred) directly against a
 * real `Client`/`Server` round trip over `InMemoryTransport`:
 * the installed `@modelcontextprotocol/server@2.0.0`'s own
 * `tools/call` result encoding runs every handler-returned object missing
 * `content` through a shared `normalizeContentlessToolResult` step, which
 * injects a synthetic `content: []` UNLESS the object already carries one
 * of `["task", "inputRequests", "requestState"]` - the OLDER `input_required`
 * result family's own escape hatch (SEP-2322 predates this extension and
 * the SDK has not been taught the Tasks extension's own `resultType:
 * "task"` as an equivalent second family to protect). This adapter's own
 * `buildCreateTaskResult` output has neither `content` nor any of those
 * three keys, so the REAL bytes this codebase sends for a mint carry one
 * extra key beyond what `buildCreateTaskResult` constructs:
 * `content: []`. Verified directly (not assumed) by wrapping a real
 * `InMemoryTransport` pair's outbound `send` and inspecting the raw
 * pre-decode JSON-RPC message. `test/tasks.test.ts` asserts this precisely
 * (the schema-conformance check strips exactly that one, bounded,
 * documented key before validating against `createTaskResult`, and
 * separately asserts the artifact is bounded to exactly that key with
 * exactly that value - never a silent broader escape). This is an
 * SDK-version fact about the installed `@modelcontextprotocol/server`
 * package's own `tools/call` encode path, not a defect in this adapter's
 * own construction, and not something touching the vendored schema (which
 * pins the RELEASED extension's real contract, where `createTaskResult`
 * legitimately carries no `content` at all) could fix or should paper
 * over - deliberately never worked around here by stuffing a bogus
 * `task`/`inputRequests`/`requestState` key into the result purely to
 * suppress the injection, which would fabricate spec-foreign data to dodge
 * a benign default and make the real problem (an SDK gap) harder to see,
 * not easier.
 *
 * Also starts ALL THREE of this file's own notification/wake mechanisms for
 * that SAME job, but only when the backing job is not ALREADY terminal at
 * mint time (a job that started already-failed, e.g. a bad cwd caught
 * before ever spawning, has no "life" left to notify about; see
 * `src/jobStore.ts`'s `createFailedJob`): the pre-existing output-driven
 * wake watch (`startTaskWatch`, ghantika's own `GHANTIKA_OUTPUT_WAKE_METHOD`,
 * unconditional, non-spec, an accelerator on top of the poll floor, through
 * `notifier`), the released spec's own per-transition `notifications/tasks`
 * status notification (`startTaskStatusNotifier`, see that function's own
 * docs for the full field-by-field grounding against the released
 * contract, also through `notifier`), and the transport-layer wake
 * (`startTransportWakeOnTerminal`, see that function's own docs - through
 * `wakeTargetResolution`, never `notifier`, since it never sends an MCP
 * notification down this connection at all). All three are deliberately
 * INDEPENDENT subscriptions - see `startTaskStatusNotifier`'s own docs for
 * why a firehose-triggered stop of the first can never silence the second,
 * and `startTransportWakeOnTerminal`'s own docs for the identical reasoning
 * applied to the third.
 *
 * The three do NOT all share the same capability gate. `startTaskWatch` and
 * `startTaskStatusNotifier` run only when `isCapableConnection` - both push
 * an MCP notification down this connection, which only makes sense for a
 * connection that negotiated the extension. `startTransportWakeOnTerminal`
 * runs regardless: it subscribes on `jobId`, a real job this call's own
 * `run()` already created whether or not this connection is Tasks-capable,
 * and its delivery is out-of-band (see that function's own docs) - this
 * connection's negotiated capability is simply not an input to it.
 * `notifier` is always passed by `server.ts` regardless of capability - it
 * is simply never invoked on a non-capable connection, so passing it
 * unconditionally costs nothing; `wakeTargetResolution` is likewise always
 * passed (`server.ts` resolves it unconditionally on the `run` branch, in
 * every era - see that file's own wiring), and
 * `startTransportWakeOnTerminal`'s own internal gate
 * (`isTransportWakeEnabled`) is what keeps it a real no-op everywhere this
 * story does not explicitly enable it - on every connection, capable or
 * not.
 */
export function maybeAugmentRunResult(
  result: CallToolResult,
  isCapableConnection: boolean,
  notifier: TaskWakeNotifier,
  wakeTargetResolution: WakeTargetResolution
): CallToolResult {
  const jobId = extractJobId(result);
  if (jobId === undefined) return result;
  const record = jobStore.get(jobId);
  if (record === undefined) return result; // defensive only - run() always creates the record before returning

  if (!isTerminalJobState(record.state)) {
    // startTransportWakeOnTerminal runs regardless of isCapableConnection - it
    // subscribes on the real JOB this run() call already created, never on the
    // minted TASK shape below, so a non-capable connection's job is exactly as
    // valid a subject as a capable one's. Its own preconditions
    // (isTransportWakeEnabled, wakeTargetResolution.state === "resolved") are
    // the only gates that legitimately apply; Tasks-extension capability is a
    // fact about this connection's MCP notifications, and this mechanism never
    // sends one - see its own doc comment.
    startTransportWakeOnTerminal(jobId, wakeTargetResolution);
    if (isCapableConnection) {
      startTaskWatch(jobId, notifier);
      startTaskStatusNotifier(jobId, notifier);
    }
  }

  if (!isCapableConnection) return result;
  const minted = buildCreateTaskResult(record);
  return minted as unknown as CallToolResult;
}
