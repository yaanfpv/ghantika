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
 * `tasks/result`) was chosen as a forward-looking design against a spec
 * revision that had not yet finalized at the time, pinned here as a
 * vendored, digest-verified schema (`schema/tasks-extension.schema.json`,
 * `config/tasks-schema-digest.json`) rather than borrowed from the SDK's
 * own deprecated shape.
 *
 * **The Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663)
 * finalized on 2026-07-28.** This adapter's METHOD SET independently
 * matches the finalized extension's own method-set change on all four of
 * its points: `tasks/get` retained, `tasks/update` added (we have it),
 * `tasks/list` removed (we omit it), `tasks/result` replaced (we omit it).
 * That is a narrower claim than full wire compatibility, and it is
 * deliberately stated that narrowly: this adapter's capability
 * negotiation, result shapes, status vocabulary, and notification/
 * subscription protocol were designed before finalization and have not
 * been reconciled against the finalized extension's own shapes yet. The
 * decision on what to do about that is already made, not open: bring this
 * adapter into official wire conformance with the released extension. This
 * file has not yet been rewritten to match; that rewrite is separate,
 * tracked work this comment does not resolve.
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
 * recognized as capable; that affordance is a scope decision for planning,
 * not something this adapter widens on its own.
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
 * ## tasks/get and tasks/update stay pure reads; tasks/cancel is real
 *
 * `tasks/get` and `tasks/update` are two separately REGISTERED JSON-RPC
 * methods that both route through this file's one `getTask` snapshot
 * function - a PURE read with no write path anywhere in this module. That
 * is not a shortcut: a job-backed task has no client-updatable state at
 * all, so `tasks/update`'s complete behavior IS this read-only snapshot,
 * and always will be.
 *
 * `tasks/cancel` is different: it is the one place this file has a REAL
 * side effect. `cancelTask` (below) resolves `taskId` the same way every
 * other function here does (a `jobStore` `job_id` read, never a second
 * table), then delegates the actual termination to `src/tools/kill.ts`'s
 * own exported `handler` - the SAME POSIX-process-group kill/reap
 * containment the `kill` tool already provides (grace-period SIGTERM,
 * SIGKILL escalation, the pre-signal and escalation identity gates, the
 * external `pgrep`-based reap confirmation) - rather than reimplementing
 * any of it here. This file still never gains persistent state of its
 * own: `killTool.handler` performs the one real write (through
 * `jobStore`), and `cancelTask` only reads the result back through the
 * SAME `buildTaskResult` projection `getTask` already uses.
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
 * already provides for a caller that calls it again.
 */
import type {
  CallToolResult,
  ClientCapabilities,
  JSONObject,
  StandardSchemaV1,
} from "@modelcontextprotocol/server";

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
// Capability negotiation - the SOURCE this file is handed varies by era
// (see below), but the CHECK itself does not
// ---------------------------------------------------------------------------

/**
 * True when `clientCapabilities` advertised Tasks support under
 * `extensions`, the sole bag the finalized extension recognizes (see this
 * file's header on why `experimental` is not read). This is the ONLY
 * signal `maybeAugmentRunResult` consults - never
 * anything in `run()`'s own tool arguments, which is what keeps the
 * six-tool mint rule free of a per-call opt-in field: a bare tool call with
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
// Task status - a closed, four-value set matching the vendored schema's own
// status enum EXACTLY, by set-equality. 'expired' is never a member: a task
// past its TTL is REMOVED (see getTask's own docs on the frozen
// TTL-vs-timeout separation), not transitioned into some fifth status - a
// task that no longer resolves to a job (whether it never existed, or a TTL
// purge just reclaimed it) simply reads as task_not_found rather than
// surfacing its own terminal status.
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
 * never folded into the status itself); `failed` is the task-level
 * `failed` - see `src/jobStore.ts`'s `JobDiagnosticReason` docs for the
 * full reason set. Most `failed` jobs never spawned at all (a cwd/executable
 * preflight rejection, a genuine async spawn failure, or a command the
 * policy gate denied), but `watcher/runtime-error` is a legal producer of
 * `failed` too for a command that DID genuinely spawn and run - e.g. one
 * terminated by its own execution deadline before finishing naturally (see
 * `run.ts`'s deadline handling). `failed` at the task level therefore means
 * "the task did not run to natural completion", not "the task never ran";
 * `killed` is `cancelled` (an explicit kill, whether via the `kill` tool
 * today or a real cooperative cancel layered on top of `tasks/cancel`
 * later, is a cancellation at the task level).
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

/** Present once this adapter's own output-driven notification WATCH auto-stopped early (currently only ever for a sustained firehose rate - see `WATCH_STOP_REASON_FIREHOSE`) - never means the backing job stopped. The job stays alive/pollable regardless; only the wake accelerator itself stopped. Absent for the ordinary lifetime of a task that never firehosed. */
export interface WatchStoppedInfo {
  readonly reason: string;
  readonly stoppedAt: string;
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
  readonly watchStopped?: WatchStoppedInfo;
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
 * reads `jobStore.getOutputCounts`/`jobStore.getOutputWatchStopInfo`
 * (already-existing, real state this adapter drives elsewhere in this
 * file - never invented here) and the record's own fields, writes nothing.
 * `exitCode`/`output` are included only once the task is terminal
 * (mirroring `PublicJobProjection`'s own optional-field pattern for
 * `exit_code`), so a still-working task never carries a stale/zeroed
 * placeholder for either. `watchStopped`, by contrast, is checked
 * REGARDLESS of terminal state: a firehose can auto-stop the watch while
 * the task is still genuinely `working` - the auto-stop only silences
 * the notification wake, it never changes `task.status` itself.
 */
function buildTaskResult(record: JobRecord): TaskResult {
  const terminal = isTerminalJobState(record.state);
  const watchStop = jobStore.getOutputWatchStopInfo(record.job_id);
  const base: TaskResult = {
    extension: TASKS_EXTENSION_URI,
    taskId: record.job_id,
    status: mapJobStateToTaskStatus(record.state),
    createdAt: record.started_at,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    ...(watchStop !== undefined ? { watchStopped: watchStop } : {}),
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
 * How long a TERMINAL task's record is retained before a task-layer TTL
 * purge REMOVES it from `jobStore` entirely - a completely SEPARATE
 * concept from a job's own execution timeout (`run()`'s optional
 * `deadline_ms`, see `run.ts`): that timeout kills a still-running JOB,
 * transitioning it to `failed`, which is an entirely different effect than
 * this purge's "remove the now-stale, already-terminal completed record".
 * NEVER an 'expired' task
 * status: a still-`working` task is NEVER purged regardless of age (see
 * `isExpiredTerminalRecord`'s own terminal-only guard, which is what makes
 * that true) - only a genuinely completed/terminal record is reclaimed,
 * and only once it is actually READ again past this age (a lazy, read-time
 * purge - see `getTask`'s own docs for why this needs no separate
 * scheduled sweep).
 */
export const TASK_TTL_MS = 24 * 60 * 60 * 1000;

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
 * The one live-read entry point every tasks/* handler in `src/server.ts`
 * calls: directly for `tasks/get`/`tasks/update` (their WHOLE
 * implementation - see this file's header on why sharing this read is what
 * makes `tasks/update`'s state-preservation invariant true by
 * construction), and as `cancelTask`'s own before-and-after read for
 * `tasks/cancel` (below). A PURE read with one deliberate side effect: the
 * lazy TTL purge (see `TASK_TTL_MS`'s own docs) - once a terminal record is
 * read PAST its TTL, this call both reports `task_not_found` AND reclaims
 * the record via `jobStore.deleteJob`, so the SAME expired record is never
 * "found, but reported not-found" more than once; a caller that never
 * reads it again simply leaves it in `jobStore` until the next read (or
 * never, which is an accepted, honest trade-off of a lazy-on-read design
 * over a scheduled sweep - no separate timer is needed per terminal task).
 *
 * `now` defaults to the real `Date.now()`; a caller never overrides it in
 * production - it exists as a parameter (mirroring
 * `src/process.ts`'s own `checkProcessIdentity`) purely so a test can
 * drive TTL expiry deterministically by mocking the GLOBAL `Date` (via
 * `node:test`'s `mock.timers`) rather than waiting out `TASK_TTL_MS` in
 * real wall-clock time.
 */
export function getTask(taskId: string, now: number = Date.now()): TaskResult | TaskNotFound {
  const record = jobStore.get(taskId);
  if (record === undefined) return taskNotFound(taskId);
  if (isExpiredTerminalRecord(record, now)) {
    jobStore.deleteJob(taskId);
    return taskNotFound(taskId);
  }
  return buildTaskResult(record);
}

/**
 * The real `tasks/cancel` implementation - see this file's header ("tasks/get
 * and tasks/update stay pure reads; tasks/cancel is real") for the full
 * design. Resolves `taskId` -> `job_id` the SAME way `getTask` does (an
 * unknown or just-TTL-purged taskId returns `task_not_found` WITHOUT ever
 * attempting a kill - there is nothing left to terminate), then delegates
 * the actual termination to `src/tools/kill.ts`'s own exported `handler`,
 * reusing its existing process-group kill/reap containment rather than
 * reimplementing it here.
 *
 * The value returned is a FRESH `getTask` read taken AFTER that call
 * settles - already the job's real terminal `cancelled` status for an
 * ordinary live job (this codebase's own `kill.ts` claims the terminal
 * state SYNCHRONOUSLY, the instant it actually signals, well before its
 * own external reap-confirmation wait resolves - see that file's
 * "Idempotency and races" docs), or the SAME state a fresh `getTask` call
 * would already report for a job the kill attempt could not (or, for an
 * already-terminal job, did not need to) touch. `killTool.handler`'s own
 * `isError` outcomes are never surfaced as a failure of THIS call (see
 * this file's header) - `cancelTask` simply reads back whatever is
 * actually true of the job afterward.
 *
 * `now` is captured ONCE by the caller (or defaults to one real
 * `Date.now()` here) and reused for BOTH the pre-kill existence/TTL check
 * and the post-kill read, so a real-time kill attempt that happens to
 * straddle a TTL boundary is judged consistently against one instant,
 * never two different ones.
 */
export async function cancelTask(
  taskId: string,
  now: number = Date.now()
): Promise<TaskResult | TaskNotFound> {
  const current = getTask(taskId, now);
  if ("error" in current) return current; // unknown, or just TTL-purged - nothing to kill

  await killTool.handler({ job_id: taskId });

  return getTask(taskId, now);
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
// The output-driven wake - a coalesced, rate-bounded, firehose-guarded,
// terminal-flush-ordered accelerator built entirely on jobStore.ts's two
// generic hooks (`onOutputArrival`/`onJobTerminal`) plus its generic
// watch-stop annotation. Every named constant below is EXPORTED so a test
// can assert against it directly, never a magic literal.
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
// for that job may never run again.
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

/** The extension's real notification method name - exact-string wire identity, never a substring/prefix a client should match against. Optional: a client MUST NOT rely on receiving it and continues to poll `tasks/get`/`output`/`tail` regardless (see this section's own docs on the poll floor). */
export const TASKS_STATUS_NOTIFICATION_METHOD = "notifications/tasks/status";

/** One output line (stdout or stderr) as carried in a wake notification's payload - the SAME shape (seq/text/partial) `src/tools/output.ts`'s own `OutputEvent` uses for either stream, so the wake never carries state the poll floor can't independently surface. */
export interface TaskWakeLine {
  readonly seq: number;
  readonly text: string;
  readonly partial?: true;
}

/**
 * The one thing `maybeAugmentRunResult` needs from `src/server.ts` to
 * actually deliver a wake: a thin function wrapping the real connected
 * `Server`'s own `notification()` call. Keeping this a plain function type
 * (rather than importing the `Server` class itself) is what lets this file
 * stay unaware of the SDK's server wiring beyond the generic types it
 * already imports.
 */
export type TaskWakeNotifier = (params: Record<string, unknown>) => void;

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
 * batch carries at least one line for that stream - mirroring `TaskResult`'s
 * own optional-field house style (`exitCode`/`output`/`watchStopped` above)
 * rather than always emitting an empty array a client would have to filter
 * out. A window that saw only stdout carries `stdout` alone, exactly as
 * before this adapter also woke on stderr; a mixed window carries both.
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
    notifier(buildWakeParams(taskId, stdoutLines, stderrLines));
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
    // No wake fires for the terminal transition itself - the terminal
    // status is observable via tasks/get / the poll floor; this
    // watch's whole job is the output-delta accelerator (stdout and
    // stderr both), not a status announcement of its own.
  });
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
 *
 * Also starts the output-driven wake watch (see `startTaskWatch`'s own
 * docs) for that SAME job, through `notifier` - but only when the backing
 * job is not ALREADY terminal at mint time (a job that started already-
 * failed, e.g. a bad cwd caught before ever spawning, has no "life" left
 * to wake about; see `src/jobStore.ts`'s `createFailedJob`). `notifier` is
 * always passed by `server.ts` regardless of capability - it is simply
 * never invoked when this function returns early above, so passing it
 * unconditionally costs nothing.
 */
export function maybeAugmentRunResult(
  result: CallToolResult,
  isCapableConnection: boolean,
  notifier: TaskWakeNotifier
): CallToolResult {
  if (!isCapableConnection) return result;
  const jobId = extractJobId(result);
  if (jobId === undefined) return result;
  const record = jobStore.get(jobId);
  if (record === undefined) return result; // defensive only - run() always creates the record before returning

  if (!isTerminalJobState(record.state)) {
    startTaskWatch(jobId, notifier);
  }

  const task = buildTaskResult(record);
  return {
    content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
    structuredContent: { ...task },
  };
}
