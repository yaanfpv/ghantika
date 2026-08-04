/**
 * The stdio transport and protocol wiring: creates the
 * SDK's `Server`, registers the `tools/list`/`tools/call` handlers,
 * connects the stdio transport, and attaches shutdown handling. This is
 * the only file that touches the SDK's `Server`/`StdioServerTransport`
 * classes directly - `src/registry.ts` owns what the six tools ARE,
 * this file owns wiring them onto the wire.
 *
 * This file also wires in the `io.modelcontextprotocol/tasks` capability
 * (advertisement at construction, the three registered `tasks/*` methods,
 * and augmenting `run()`'s result on a capable connection) - but only ever
 * by CALLING into `./tasksAdapter.js`, never by referencing anything
 * Tasks-shaped itself. `src/tasksAdapter.ts` is the single file permitted
 * to reference the extension's shape at all, whether via import or
 * hand-rolled definition (enforced by `scripts/check-no-tasks-import.mjs`);
 * this file stays exactly as unaware of the extension's real shape as
 * `registry.ts` and every `tools/*.ts` handler already are.
 *
 * ## Why stdout purity matters
 *
 * MCP over stdio uses the server's own stdout as the ENTIRE protocol
 * channel: every JSON-RPC message, request or response, is one line of
 * JSON written to stdout. A single stray byte of unrelated output on
 * stdout - a stray `console.log`, a child process's output wired with
 * `"inherit"` - corrupts every message after it, because the client's
 * line-based JSON-RPC reader tries to `JSON.parse` a line that is no
 * longer valid JSON. So this file (and everything under `src/`) logs
 * diagnostics to stderr only, via `console.error`, and the ONLY code
 * anywhere in this codebase that writes to `process.stdout` is the SDK's
 * own `StdioServerTransport` - enforced by `scripts/check-stdio-purity.mjs`
 * (see `test/stdio-purity.test.ts`) and proven under real, rapid traffic
 * by the end-to-end test in `test/e2e-server.test.ts`.
 *
 * ## Error-class behavior
 *
 * - An unrecognized JSON-RPC METHOD gets -32601 automatically: the SDK's
 *   base `Protocol` class replies `MethodNotFound` for any method with no
 *   registered handler, so registering handlers only for the methods this
 *   server actually supports is sufficient - nothing extra to write here.
 * - A genuinely unparseable line (fails `JSON.parse` itself) gets -32700:
 *   the stock transport now silently skips a line like this rather than
 *   reporting it at all (confirmed against the installed
 *   @modelcontextprotocol/server package's own source), so
 *   `createStdioTransport` intercepts ahead of the transport to restore
 *   the reply - see its own doc comment for the full picture (why this
 *   codebase intercepts ahead of the transport, why its own `ReadBuffer`
 *   can't be reused here, and how single-reader/single-writer safety is
 *   proven, not assumed).
 * - A line that parses as JSON but isn't a valid JSON-RPC envelope still
 *   gets -32600 automatically via the transport's own `onerror` callback,
 *   unchanged; `attachParseErrorReporting` below closes THAT gap (the
 *   stock transport still doesn't reply on its own, it only fires the
 *   callback).
 * - An unknown TOOL NAME (`tools/call` naming something other than one of
 *   the six registered tools) is -32602, thrown by `registry.dispatchToolCall`
 *   - a valid method (`tools/call`) with an invalid parameter (the tool
 *   name).
 * - A known tool whose ARGUMENTS fail its own schema is never a JSON-RPC
 *   error at all: each tool handler in `src/tools/` returns a normal,
 *   successful `CallToolResult` with `isError: true` - see each handler's
 *   own `toolError` helper.
 */
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  deserializeMessage,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import { Readable } from "node:stream";

import type { JobState } from "./jobStore.js";
import { isTerminalJobState, jobStore } from "./jobStore.js";
import {
  evaluatePreSignalIdentityGate,
  killProcessGroupPosix,
  killProcessTreeWindows,
} from "./process.js";
import { dispatchToolCall, listToolDefinitions } from "./registry.js";
import * as tasksAdapter from "./tasksAdapter.js";

const SERVER_NAME = "ghantika";
// Kept as a literal here (rather than reading package.json at runtime) so
// the compiled dist/index.js never depends on package.json's on-disk
// location relative to it. Update alongside package.json's own version.
const SERVER_VERSION = "0.1.0";

/** A running ghantika MCP server instance. */
export interface GhantikaServer {
  readonly server: Server;
  readonly transport: Transport;
  /**
   * True once the client has completed a REAL, SUCCESSFUL initialize/
   * initialized handshake: a genuine `initialize` REQUEST (never a
   * same-named notification - see `createServer()`'s doc comment) was
   * observed on the wire, the SDK's own negotiation for that exact request
   * actually SUCCEEDED (the outgoing response carried a `result`, not an
   * `error`), and the `notifications/initialized` notification arrived
   * afterward. All three conditions are independent and every one is
   * required: a same-named notification (no `id`) is not a request at all;
   * an `initialize` request the SDK's own validation rejects never
   * produces a successful negotiation even though a message named
   * "initialize" was seen; and the notification alone, with no preceding
   * request, is exactly the bypass a malicious/buggy client can exploit by
   * skipping `initialize` entirely.
   */
  isInitialized(): boolean;
  /**
   * Runs cleanup exactly once, however many times or from however many
   * signal handlers it's called. Guarantees orphan-proof
   * teardown for real: a real running job leaves a real live child
   * process behind, so closing the transport alone is not enough - it
   * never touches `jobStore` or any live child, and a job started before
   * shutdown would otherwise stay alive and orphaned after this server
   * process exits cleanly. This REAPS every tracked job's whole process
   * tree before the transport closes - `starting`/`running` jobs via the
   * full identity-gated kill path, AND already-terminal jobs via a
   * real group-level reap for any orphaned descendants their own leader
   * left behind by exiting first (root-exits-first) - see
   * `reapLiveJobsOnShutdown`'s own docs for exactly how, and why it reuses
   * process.ts's real kill machinery rather than a second one.
   */
  shutdown(reason: string): Promise<void>;
}

/**
 * Builds a `GhantikaServer` and registers its request handlers, but does
 * NOT connect it to a transport or touch any process-level signal
 * handler. Kept separate from `runServer` so tests can construct and
 * exercise a server instance in-process without it taking over the test
 * runner's own stdin/stdout or `SIGTERM`/`SIGINT`.
 *
 * @param transport - defaults to a real stdio transport, wrapped to restore
 *   a `-32700` reply for genuinely unparseable input (see
 *   `createStdioTransport`'s own doc comment for why the stock transport
 *   needs that wrapper now). A test may inject any other `Transport`
 *   implementation instead - e.g. the SDK's own `InMemoryTransport`, to
 *   drive a real `Client`/`Server` round trip in-process (see the
 *   jobStore-singleton-sharing regression coverage in
 *   `test/jobStore.test.ts`, which needs the running server and the test's
 *   own directly-imported `jobStore` to share one Node module registry -
 *   only possible in-process, never across the real spawned-child-process
 *   boundary `test/helpers/spawnServer.ts` otherwise uses).
 */
export function createServer(transport: Transport = createStdioTransport()): GhantikaServer {
  // A freshly constructed server is not itself shutting down - reopens
  // whatever an earlier server built against this same shared `jobStore`
  // singleton already closed. Harmless, and a genuine no-op, in real
  // production use (a real process calls createServer() exactly once,
  // before its own single shutdown); it only does real work once more
  // than one createServer() call shares this one process-lifetime
  // singleton, which is exactly what this codebase's own test suite does.
  // See JobStore.clearShutdownGate's own docs.
  jobStore.clearShutdownGate();

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        // Advertises io.modelcontextprotocol/tasks at the CONNECTION layer
        // (the initialize/capability handshake) - see tasksAdapter.ts's own
        // header for why this is the `extensions` bag, never the SDK's
        // deprecated `capabilities.tasks` field. This is the only place
        // server.ts reaches into tasksAdapter.ts for capability shape; the
        // adapter owns the descriptor's contents.
        ...tasksAdapter.tasksServerCapabilitiesFragment(),
      },
    }
  );

  // The tools/call gate below must open only after the client has
  // completed a REAL, SUCCESSFUL initialize/initialized handshake - not
  // merely "some message that happens to look like initialize" arrived,
  // and not merely "the SDK's `oninitialized` callback fired." Both of
  // those weaker signals are independently bypassable:
  //
  //  1. `oninitialized` (wired below) fires purely off RECEIVING the
  //     `notifications/initialized` JSON-RPC notification. It never checks
  //     that a real `initialize` REQUEST preceded that notification, so a
  //     client (malicious or buggy) that sends `notifications/initialized`
  //     as its very first message - no `initialize` request at all - flips
  //     this flag anyway.
  //
  //  2. Merely observing an INCOMING message named "initialize" is also
  //     not enough, for two further reasons: (a) JSON-RPC 2.0 distinguishes
  //     a REQUEST from a NOTIFICATION solely by the presence of an `id` -
  //     a message shaped like `{ method: "initialize", params }` with no
  //     `id` is a notification, which the SDK's own dispatch never routes
  //     to its initialize handling the way it does a real request, so
  //     treating that message as a real initialize attempt is wrong on its
  //     own terms; (b) even a genuine request (has a real `id`) can still
  //     fail the SDK's own negotiation - a malformed/missing required
  //     param throws, and the SDK replies with a real JSON-RPC error for
  //     that id. A client that was just told its handshake failed must not
  //     still get the gate opened for it. Only the SDK's own OUTGOING
  //     response for that exact request - carrying a `result`, not an
  //     `error` - proves the negotiation actually succeeded.
  //
  // The fix therefore tracks the ACTUAL OUTCOME, not the incoming
  // message's method name: `pendingInitializeRequestId` records the `id`
  // of the most recent genuine initialize REQUEST (method === "initialize"
  // AND a real `id`, which rules out a same-named notification), and
  // `initializeNegotiationSucceeded` is set only when the SDK's own
  // outgoing response for that exact id carries a `result`. The gate
  // requires both that success flag AND the `initialized` notification.
  //
  // There's no public hook to observe the `initialize` REQUEST (or its
  // response) directly: the base `Server` constructor already claims the
  // `initialize` method's request handler internally to do real protocol-
  // version/capability negotiation, and `setRequestHandler` silently
  // REPLACES any existing handler for a method, so re-registering it here
  // would silently break the SDK's own initialize handling instead of
  // adding a check alongside it.
  //
  // Instead: intercept at the transport message layer, one level below the
  // `Server`/`Protocol` dispatch, on BOTH directions of traffic. Verified
  // directly against the real installed @modelcontextprotocol/server
  // package (a live Server/Transport pair, not just reading source): a
  // handler set on `transport.onmessage` BEFORE `server.connect(transport)`
  // is chained ahead of the SDK's own dispatch and observes every raw
  // JSON-RPC message, including the `initialize` request itself; and
  // `transport.send` wrapped BEFORE `server.connect(transport)` is what the
  // SDK genuinely invokes to deliver the real initialize response, since
  // `connect()` never reassigns `.send` on its own. Both directions are
  // therefore a transparent pass-through-plus-observation, mirroring each
  // other and the same chaining pattern `attachParseErrorReporting` below
  // already relies on for `transport.onerror`.
  let pendingInitializeRequestId: string | number | undefined;
  let initializeNegotiationSucceeded = false;
  let receivedInitializedNotification = false;

  attachInitializeRequestObserver(transport, (id) => {
    pendingInitializeRequestId = id;
  });
  attachInitializeResponseObserver(
    transport,
    (id) => pendingInitializeRequestId !== undefined && id === pendingInitializeRequestId,
    {
      onSucceeded: () => {
        initializeNegotiationSucceeded = true;
      },
      onFailed: () => {
        // A client is unlikely to retry a failed initialize with the same
        // id, but clearing the pending id means a later, unrelated
        // response can never be mismatched against a stale one either.
        pendingInitializeRequestId = undefined;
      },
    }
  );
  attachParseErrorReporting(transport);

  server.oninitialized = () => {
    receivedInitializedNotification = true;
  };

  const isInitializedForToolCalls = (): boolean =>
    initializeNegotiationSucceeded && receivedInitializedNotification;

  // The one thing tasksAdapter.ts's output-driven wake needs from THIS
  // connection's real `Server` instance - see maybeAugmentRunResult's own
  // docs for why the adapter itself never imports `Server`. A thin,
  // fire-and-forget wrapper: a wake is a best-effort accelerator (the poll
  // floor stays authoritative regardless - see tasksAdapter.ts's own
  // header on the notification being optional), so a failed send is
  // logged to stderr and never allowed to propagate into the tool-call
  // response path that triggered it.
  const sendTaskWakeNotification = (params: Record<string, unknown>): void => {
    server
      .notification({ method: tasksAdapter.TASKS_STATUS_NOTIFICATION_METHOD, params })
      .catch((error: unknown) => {
        console.error(
          "[ghantika] error sending",
          tasksAdapter.TASKS_STATUS_NOTIFICATION_METHOD,
          error
        );
      });
  };

  server.setRequestHandler("tools/list", async () => ({
    tools: listToolDefinitions(),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    // The server must advertise its tools via
    // initialize/tools/list BEFORE accepting any tools/call - a call sent
    // before the client has completed the initialize/initialized
    // handshake is rejected, not silently processed. -32600 (Invalid
    // Request) is the JSON-RPC code for "this request is invalid given
    // the connection's current state," distinct from -32602 (this
    // specific tool name is invalid) and -32601 (this method doesn't
    // exist at all - tools/call very much exists, it's just too early).
    if (!isInitializedForToolCalls()) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        "tools/call rejected: the client has not completed the initialize/initialized handshake yet"
      );
    }
    const result = await dispatchToolCall(request.params.name, request.params.arguments);
    // ONLY run() is ever handed to the adapter - status/output/tail/kill/
    // list pass straight through unchanged, so the plain poll floor stays
    // reachable on every connection regardless of Tasks capability.
    // Capability is read fresh off the CONNECTION
    // (server.getClientCapabilities(), populated once at initialize) -
    // never off anything in `request` itself, which is what keeps minting
    // connection-level rather than per-request.
    if (request.params.name === "run") {
      const capable = tasksAdapter.isConnectionTasksCapable(server.getClientCapabilities());
      return tasksAdapter.maybeAugmentRunResult(result, capable, sendTaskWakeNotification);
    }
    return result;
  });

  // The three registered task methods - see tasksAdapter.ts's header for
  // why tasks/get and tasks/update share getTask's one read-only snapshot
  // as their complete behavior, why tasks/cancel is the one place that
  // adapter has a real side effect (it delegates to tools/kill.ts's own
  // process-group kill/reap containment via tasksAdapter.cancelTask), and
  // why no tasks/list or tasks/result method is registered at all (the
  // legacy result/list surface is deliberately not implemented).
  server.setRequestHandler(
    "tasks/get",
    { params: tasksAdapter.taskIdParamsSchema() },
    async (params) => tasksAdapter.getTask(params.taskId)
  );
  server.setRequestHandler(
    "tasks/update",
    { params: tasksAdapter.taskIdParamsSchema() },
    async (params) => tasksAdapter.getTask(params.taskId)
  );
  server.setRequestHandler(
    "tasks/cancel",
    { params: tasksAdapter.taskIdParamsSchema() },
    async (params) => tasksAdapter.cancelTask(params.taskId)
  );

  let shuttingDown: Promise<void> | undefined;
  const shutdown = (reason: string): Promise<void> => {
    if (!shuttingDown) {
      shuttingDown = performShutdown(transport, reason);
    }
    return shuttingDown;
  };

  return {
    server,
    transport,
    isInitialized: isInitializedForToolCalls,
    shutdown,
  };
}

async function performShutdown(transport: Transport, reason: string): Promise<void> {
  // Closes admission before anything else below - including the queue
  // drain two lines down - so a run() call arriving anywhere in this
  // function's own async tail (particularly the awaited live-job reap,
  // which can take a while against many jobs) is rejected outright rather
  // than admitted or queued into a queue this function is never going to
  // drain again. See JobStore.beginShutdown's own docs.
  jobStore.beginShutdown();
  jobStore.stopRetentionSweeper();
  console.error(`[ghantika] shutting down (${reason})`);
  try {
    // Any job still sitting in the concurrency queue never got a real
    // child attached at all (see `JobStore.drainQueueOnShutdown`'s own
    // docs), so it is killed and cleared here, BEFORE the live-job reap
    // below - which only ever has real process-group work to do for a job
    // that actually spawned. Deterministic: this always fully empties the
    // queue before shutdown proceeds.
    jobStore.drainQueueOnShutdown();
  } catch (error) {
    console.error("[ghantika] error while draining the concurrency queue during shutdown:", error);
  }
  try {
    await reapLiveJobsOnShutdown();
  } catch (error) {
    console.error("[ghantika] error while reaping live jobs during shutdown:", error);
  }
  try {
    await transport.close();
  } catch (error) {
    console.error("[ghantika] error while closing transport during shutdown:", error);
  }
}

/**
 * Reaps every currently tracked job's own process GROUP, on every
 * shutdown path - stdin EOF, SIGTERM, SIGINT all funnel through the single
 * `shutdown()` function above (see `attachProcessShutdownHandlers` below),
 * so this runs identically for all three. Deliberately REUSES the real
 * containment machinery (`process.ts`'s `evaluatePreSignalIdentityGate`/
 * `killProcessGroupPosix`/`killProcessTreeWindows`, the exact functions
 * `src/tools/kill.ts` itself calls) rather than inventing a second kill
 * mechanism - the identity check (never blindly signal a possibly-reused
 * pid), the POSIX whole-process-GROUP signaling (reaching every
 * descendant that remains in the group, not just the one tracked child -
 * see `src/tools/kill.ts`'s own "Escape boundary" docs for the one class
 * this deliberately does not reach), and the FINAL external process-group
 * confirmation (`killProcessGroupPosix`'s own `confirmed` result,
 * recorded via `jobStore.setKillConfirmation` below) all matter just as
 * much at shutdown as they do for an explicit `kill()` call.
 *
 * Covers EVERY tracked job, terminal or not - not just the
 * `starting`/`running` ones (broadened from the original filter, which
 * excluded terminal jobs entirely). A terminal job record (its own LEADER
 * `exited` or was `killed`) can still have a real process GROUP with live
 * DESCENDANTS the leader forked and never `wait`-ed on before exiting on
 * its own (root-exits-first) - see `src/tools/kill.ts`'s own
 * `reapTerminalJobProcessGroup` docs for the identical fix applied there.
 * Excluding terminal jobs left exactly that class of orphan alive across
 * a server shutdown, regardless of the `kill()` fix, since shutdown is a
 * SEPARATE code path that never calls `kill()`'s own handler.
 *
 * Every job is reaped CONCURRENTLY (`Promise.all`), not one after
 * another - reaping N jobs serially would multiply whatever grace period is
 * used by N, which is exactly the "meaningfully delay server shutdown"
 * outcome to avoid.
 *
 * Grace period choice (explicit judgment call): a SHORT, BOUNDED grace period
 * (`SHUTDOWN_KILL_GRACE_PERIOD_MS`), never the full 5-second
 * `POSIX_KILL_GRACE_PERIOD_MS` an explicit, single, user-invoked `kill()`
 * call uses. The two calls have different priorities: `kill()` is a
 * deliberate one-job request where a caller can afford to wait for a
 * graceful exit; shutdown potentially has to reap MANY jobs before this
 * whole PROCESS can exit, and an MCP server's client is actively waiting on
 * that. Bounded-but-real still gives an ordinary, cooperative child a real
 * (if short) chance to react to SIGTERM before SIGKILL escalates - this
 * codebase's own stated bar is "zero surviving children," never "always
 * graceful" (see `src/tools/kill.ts`'s own docs on the Windows path stating
 * the identical principle).
 */
const SHUTDOWN_KILL_GRACE_PERIOD_MS = 300;

async function reapLiveJobsOnShutdown(): Promise<void> {
  const allJobs = jobStore.list();
  await Promise.all(allJobs.map((record) => reapOneJobOnShutdown(record.job_id, record.state)));
}

async function reapOneJobOnShutdown(jobId: string, state: JobState): Promise<void> {
  const handle = jobStore.getChildHandle(jobId);
  if (handle === undefined) return; // no child was ever attached (e.g. a job that started already-failed) - nothing to reap

  if (process.platform === "win32") {
    // No equivalent root-exits-first fix on Windows today (no pgid
    // concept to reap against post-hoc - see kill.ts's own identical
    // scope note), so a terminal job is left exactly as it was here.
    if (isTerminalJobState(state)) return;
    try {
      killProcessTreeWindows(handle.pid);
    } catch (error) {
      // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- jobId is this codebase's own randomUUID(), never attacker-supplied, and this is a diagnostic console.error to stderr, not a format-string sink.
      console.error(`[ghantika] error killing job ${jobId}'s process tree during shutdown:`, error);
    }
    jobStore.markKilled(jobId, "SIGKILL-equiv");
    return;
  }

  if (isTerminalJobState(state)) {
    // Root-exits-first: the job record is already terminal (its leader
    // exited/was killed/failed to spawn), but the real process GROUP can
    // still hold live descendants the leader forked and never
    // `wait`-ed on. Routed through the SAME reap-once-guarded path
    // `kill()` itself uses (`jobStore.reapProcessGroupOnce`) rather than
    // signaling directly here: the eager reap at leader-exit has usually
    // already run by the time shutdown reaches this record, and a second,
    // unguarded signal here would be exactly the already-reaped-record
    // re-signal the reap-once guard exists to prevent (see that method's
    // own docs for why a later attempt can no longer tell a surviving
    // group from an unrelated one that has since reused the same pgid).
    // This never runs the leader-pid identity check below, for the same
    // reason `reapProcessGroupOnce` itself never does: the leader is
    // already gone by construction whenever this branch runs, so that
    // check would always read "not-found" before ever reaching a group
    // that can still hold real, live descendants.
    const alreadyReaped = jobStore.hasReapBeenAttempted(jobId);
    try {
      await jobStore.reapProcessGroupOnce(jobId, SHUTDOWN_KILL_GRACE_PERIOD_MS);
      if (!alreadyReaped && jobStore.get(jobId)?.kill_confirmed === false) {
        // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- jobId is this codebase's own randomUUID(), never attacker-supplied, and this is a diagnostic console.error to stderr, not a format-string sink.
        console.error(
          `[ghantika] job ${jobId}'s TERMINAL-record process-group reap could not be externally confirmed within the bound during shutdown - signal(s) were sent, but zero surviving members was not observed in time`
        );
      }
    } catch (error) {
      // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- jobId is this codebase's own randomUUID(), never attacker-supplied, and this is a diagnostic console.error to stderr, not a format-string sink.
      console.error(`[ghantika] error reaping job ${jobId}'s terminal group:`, error);
    }
    return;
  }

  // The identity gate's own safety property, reused here verbatim: never
  // signal a tracked pid without first evaluating, via a real external OS
  // lookup, whether it's still genuinely the process this codebase
  // spawned - a job that already exited naturally in a race just before
  // shutdown reached it ("skip") or whose pid has since been reused by an
  // unrelated process ("refuse") is left untouched either way, exactly
  // matching `src/tools/kill.ts`'s own handling of both cases. When
  // identity can't be verified at all (no captured identity, or the
  // observer itself fails), this still proceeds via the same honest,
  // disclosed DEGRADED path `kill()` uses, rather than a false success.
  //
  // `resolveBirthIdentityForKill`, not a direct `handle.birthIdentity`
  // read - mirrors `kill.ts`'s own identical reasoning: `run()`'s birth-
  // identity capture is async and fire-and-forget, so a shutdown reaching
  // a very recently started job can race ahead of a still-in-flight
  // capture; awaiting that SAME promise here (bounded by its own hard
  // timeout) gives this reap a real chance at a confirmed identity
  // comparison instead of needlessly degrading.
  const birthIdentity = await jobStore.resolveBirthIdentityForKill(jobId);
  const gate = await evaluatePreSignalIdentityGate(handle.pid, birthIdentity);
  if (gate.action === "skip" || gate.action === "refuse") return;

  // Marked as a reap attempt BEFORE signaling, same reasoning as
  // kill.ts's own live-job branches: the identity gate above just
  // confirmed this group is genuinely ours, so this is the moment of
  // guaranteed continuity a later reap attempt on the resulting terminal
  // record (the branch above, or a subsequent kill() call) can no longer
  // rely on - marking it here is what makes that later attempt a safe,
  // signal-free no-op instead of a second real signal against this same
  // job.
  jobStore.markReapAttempted(jobId);
  try {
    const result = await killProcessGroupPosix(handle.pid, SHUTDOWN_KILL_GRACE_PERIOD_MS, {
      onSignaled: (sentSignal) => {
        // Mirrors kill.ts's own kill/exit race handling:
        // claim the terminal slot synchronously, right when each real
        // signal sends, so this deterministically wins against the same
        // job's own natural `exit` event.
        if (sentSignal === "SIGTERM") {
          jobStore.markKilled(jobId, "SIGTERM");
        } else {
          jobStore.updateKillSignal(jobId, "SIGKILL");
        }
      },
    });
    // The same process-group-confirmation model kill.ts's own handler
    // uses - honestly records whether the bounded external pgrep check
    // actually confirmed zero surviving process-group members, never
    // gating the state transition above.
    // There's no MCP client left to read this back once the process exits,
    // so an unconfirmed result is also logged here rather than only
    // silently recorded.
    jobStore.setKillConfirmation(jobId, result.confirmed);
    jobStore.setIdentityConfirmation(jobId, gate.identityConfirmed);
    if (!result.confirmed) {
      // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- jobId is this codebase's own randomUUID(), never attacker-supplied, and this is a diagnostic console.error to stderr, not a format-string sink.
      console.error(
        `[ghantika] job ${jobId}'s process-group reap could not be externally confirmed within the bound during shutdown - signal(s) were sent, but zero surviving members was not observed in time`
      );
      if (result.escalationRefusedReason !== undefined) {
        // Distinguishes "SIGKILL was sent but the external confirmation
        // read itself failed/timed out" from "escalation was refused, so
        // no SIGKILL was ever sent at all" - the generic message above
        // reads identically in both cases, and only this field (set by
        // evaluateEscalationIdentityGate) tells them apart. There is no
        // MCP client left to read this back once the process exits, so
        // this is the only place it can surface.
        // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- jobId is this codebase's own randomUUID(), never attacker-supplied, and this is a diagnostic console.error to stderr, not a format-string sink.
        console.error(
          `[ghantika] job ${jobId}'s SIGKILL escalation was refused during shutdown: ${result.escalationRefusedReason}`
        );
      }
    }
  } catch (error) {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- jobId is this codebase's own randomUUID(), never attacker-supplied, and this is a diagnostic console.error to stderr, not a format-string sink.
    console.error(`[ghantika] error killing job ${jobId}'s process group during shutdown:`, error);
  }
}

/**
 * Wires a raw-message observer onto `transport.onmessage`, BEFORE
 * `server.connect(transport)` is ever called, purely to detect whether a
 * genuine `initialize` REQUEST (never a same-named notification) was
 * received, and to hand back its `id` - independent of the SDK's own
 * routing/dispatch, and without touching `InitializeRequestSchema`. See
 * `createServer()`'s own doc comment above for the full rationale (why
 * `oninitialized` alone is bypassable, why a bare method-name match is
 * bypassable too, and why re-registering `InitializeRequestSchema` isn't a
 * safe option).
 *
 * `Protocol.connect()` reads whatever `transport.onmessage` was already
 * set at connect-time and chains it ahead of its own dispatch (see this
 * file's docs on `attachParseErrorReporting`, which relies on the exact
 * same chaining behavior for `transport.onerror`) - so this handler sees
 * every message the SDK sees, including ones that never end up dispatched
 * anywhere (e.g. a `notifications/initialized` sent with no prior
 * `initialize` - exactly the bypass this closes).
 *
 * A JSON-RPC message is a discriminated union (request / notification /
 * response / error) with no shared `method` field on every branch, so the
 * check below narrows structurally at runtime rather than trusting a
 * static type - a raw transport message hasn't necessarily been schema-
 * validated as any particular branch yet by the time this observer sees
 * it. The `id` check is what distinguishes a real request from a
 * notification: JSON-RPC 2.0 gives every request an `id` and every
 * notification none at all, so a message with `method === "initialize"`
 * but no `id` is a notification the SDK's own dispatch would never route
 * to `_oninitialize` in the first place.
 */
function attachInitializeRequestObserver(
  transport: Transport,
  onInitializeRequest: (id: string | number) => void
): void {
  transport.onmessage = (message) => {
    const id = initializeRequestId(message);
    if (id !== undefined) {
      onInitializeRequest(id);
    }
  };
}

/** Returns the `id` of `message` when it's a genuine `initialize` REQUEST (has `method === "initialize"` AND a real, present `id`), `undefined` otherwise (including for a same-named notification, which has no `id`). */
function initializeRequestId(message: JSONRPCMessage): string | number | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const candidate = message as { method?: unknown; id?: unknown };
  if (candidate.method !== "initialize") return undefined;
  if (typeof candidate.id !== "string" && typeof candidate.id !== "number") return undefined;
  return candidate.id;
}

/**
 * Wires an observer onto `transport.send`, BEFORE `server.connect(transport)`
 * is ever called, purely to detect whether the SDK's own negotiation for a
 * specific pending initialize request `id` actually SUCCEEDED - a
 * transparent pass-through-plus-observation wrapper, never altering what's
 * actually sent or introducing any delay. See `createServer()`'s own doc
 * comment above for the full rationale (why observing only the incoming
 * request is insufficient, and the verified load-bearing claim that
 * `Protocol._onrequest`'s `capturedTransport.send(...)` genuinely invokes
 * this wrapper for the real initialize response).
 *
 * `isPendingId` is a callback rather than a captured value so the caller
 * can always compare against its OWN current `pendingInitializeRequestId`
 * (which may be reassigned between when this wrapper is installed and when
 * it fires) instead of a value frozen at wiring time.
 */
function attachInitializeResponseObserver(
  transport: Transport,
  isPendingId: (id: string | number) => boolean,
  callbacks: { onSucceeded: () => void; onFailed: () => void }
): void {
  const originalSend = transport.send.bind(transport);
  transport.send = (message, options) => {
    const outcome = initializeResponseOutcome(message, isPendingId);
    if (outcome === "success") callbacks.onSucceeded();
    else if (outcome === "failure") callbacks.onFailed();
    return originalSend(message, options);
  };
}

/**
 * Classifies an OUTGOING message as the success or failure response to the
 * pending initialize request, or neither. Only a response whose `id`
 * matches the pending id AND carries a `result` (never an `error`) counts
 * as success - matching `id` alone is not enough, since the SDK's own
 * `_oninitialize` can itself reject an initialize request (e.g. schema-
 * invalid params) and reply with a real JSON-RPC error for that same id.
 */
function initializeResponseOutcome(
  message: JSONRPCMessage,
  isPendingId: (id: string | number) => boolean
): "success" | "failure" | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const candidate = message as { id?: unknown; result?: unknown; error?: unknown };
  if (typeof candidate.id !== "string" && typeof candidate.id !== "number") return undefined;
  if (!isPendingId(candidate.id)) return undefined;
  if ("result" in candidate) return "success";
  if ("error" in candidate) return "failure";
  return undefined;
}

/**
 * Wraps a real stdio transport so a genuinely unparseable line still gets a
 * `-32700` Parse error reply, restoring the behavior the stock SDK
 * transport no longer provides.
 *
 * Confirmed directly against the installed @modelcontextprotocol/server
 * package's own source (not inferred from types): `StdioServerTransport`'s
 * internal `ReadBuffer.readMessage()` catches a `SyntaxError` from
 * `JSON.parse` and silently moves on to the next line -
 * `if (error instanceof SyntaxError) continue;` - so `transport.onerror`
 * never fires for that case at all; only a `ZodError` (valid JSON that
 * isn't a valid JSON-RPC envelope, still handled by
 * `attachParseErrorReporting` below) propagates out. The MCP 2026-07-28
 * draft's stdio transport page obligates the CLIENT not to send anything
 * that isn't a valid MCP message, but says nothing about what a server
 * does when a client violates that - genuinely silent, not permissive. So
 * restoring
 * the conventional JSON-RPC reply is the safer default for an unknown
 * population of client authors, not a requirement the spec forces either
 * way.
 *
 * The SDK's own exported `ReadBuffer` cannot be reused for this
 * specifically - confirmed empirically, not assumed: calling its
 * `readMessage()` on a buffer containing a bad line followed by a good one
 * returns the GOOD message directly, with no way for a caller to observe
 * that a line was swallowed along the way. That is precisely the behavior
 * being worked around here, not a tool for working around it. What IS
 * reused is the SDK's own exported `deserializeMessage` for the actual
 * parse-and-validate step (the part with real complexity); the only
 * hand-rolled piece left is finding a newline and slicing a buffer.
 *
 * Single-reader-of-stdin by construction: `StdioServerTransport`'s
 * constructor takes `_stdin` as a documented, injectable parameter (not an
 * internals hack), so a synthetic `Readable` sits between real
 * `process.stdin` and the transport - real stdin has exactly one listener
 * (this function's own), and the transport reads only from the synthetic
 * stream, never from the real one directly.
 *
 * Single-writer-of-stdout by construction too, the mirror-image hazard:
 * the `-32700` reply goes out through `transport.send(...)` itself -
 * exactly the same call `attachParseErrorReporting` below already uses for
 * its own `-32600` reply, and the same one the SDK's own request handling
 * uses for every ordinary response - never a second, independent write to
 * `process.stdout`. That keeps this codebase's real invariant intact: the
 * ONLY code that ever touches `process.stdout` directly is the transport's
 * own `send()`, exactly what `scripts/check-stdio-purity.mjs` enforces
 * structurally (see this file's header). Verified empirically under real
 * backpressure, not reasoned: an 8MB transport response and a small direct
 * write fired back-to-back on the transport's own underlying stream object
 * landed as two complete, uncorrected lines, never interleaved - Node's
 * `Writable` implementation serializes writes to one stream instance
 * internally, so routing both replies through the one transport is what
 * makes that guarantee apply here at all.
 */
function createStdioTransport(): StdioServerTransport {
  let buffered = Buffer.alloc(0);
  const virtualStdin = new Readable({ read() {} });
  const transport = new StdioServerTransport(virtualStdin);

  process.stdin.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    let newlineIndex: number;
    while ((newlineIndex = buffered.indexOf("\n")) !== -1) {
      const rawLine = buffered.subarray(0, newlineIndex);
      buffered = buffered.subarray(newlineIndex + 1);
      if (isUnparseableJsonLine(rawLine.toString("utf8"))) {
        sendParseErrorResponse(transport);
        continue; // never forwarded - the transport must never see this line at all
      }
      virtualStdin.push(rawLine);
      virtualStdin.push("\n");
    }
  });
  process.stdin.on("end", () => virtualStdin.push(null));
  process.stdin.on("error", (error) => virtualStdin.destroy(error));

  return transport;
}

/** True only for a line that fails `JSON.parse` itself - a line that parses but fails the JSON-RPC envelope schema is deliberately passed through, so `attachParseErrorReporting`'s existing `-32600` path (via the transport's own `onerror`) keeps handling that case unchanged. */
function isUnparseableJsonLine(line: string): boolean {
  try {
    deserializeMessage(line.replace(/\r$/, ""));
    return false;
  } catch (error) {
    return error instanceof SyntaxError;
  }
}

/** Sends a `-32700` Parse error reply through the transport's own `send(...)` - see `createStdioTransport`'s own doc comment for why this must go through the transport rather than a second direct write. */
function sendParseErrorResponse(transport: Transport): void {
  const response = {
    jsonrpc: "2.0" as const,
    id: null,
    error: { code: ProtocolErrorCode.ParseError, message: "Parse error" },
  } as unknown as JSONRPCMessage;
  transport.send(response).catch((sendError: unknown) => {
    console.error("[ghantika] failed to send parse-error response:", sendError);
  });
}

/**
 * Wires a JSON-RPC `-32600` Invalid Request reply into the transport's own
 * `onerror` callback, for a line that parses as JSON but fails the SDK's
 * own JSON-RPC envelope validation (a `ZodError`) - the one parse-adjacent
 * failure the stock transport still reports via `onerror` on its own (see
 * `createStdioTransport`'s doc comment for the other, `-32700`, case that
 * no longer reaches `onerror` at all and needs the wrapper above instead).
 * Must be called BEFORE `server.connect` - `Protocol.connect` reads the
 * transport's pre-existing `onerror` and chains it ahead of its own, so
 * setting this first means our reply goes out, then the SDK's own
 * (harmless, no-op-by-default) error bookkeeping still runs too.
 */
function attachParseErrorReporting(transport: Transport): void {
  transport.onerror = (error: Error) => {
    console.error("[ghantika] stdio transport error while reading a message:", error);
    const isUnparseableJson = error?.name === "SyntaxError";
    const code = isUnparseableJson
      ? ProtocolErrorCode.ParseError
      : ProtocolErrorCode.InvalidRequest;
    const message = isUnparseableJson ? "Parse error" : "Invalid Request";
    // JSON-RPC 2.0 requires `id: null` here (the id of the offending
    // request can't be determined from unparseable input), which the
    // SDK's own outgoing-message type doesn't model (it only allows
    // string | number | undefined, since every OTHER response the SDK
    // sends is replying to a request whose id it already parsed
    // successfully) - hence the explicit cast for this one legitimate
    // exception to that type.
    const response = {
      jsonrpc: "2.0" as const,
      id: null,
      error: { code, message, data: String(error?.message ?? error) },
    } as unknown as JSONRPCMessage;
    transport.send(response).catch((sendError: unknown) => {
      console.error("[ghantika] failed to send protocol-error response:", sendError);
    });
  };
}

/**
 * Builds a server, connects it to a real stdio transport, and attaches
 * process-level shutdown handling. This is what `src/index.ts` calls when
 * actually run as a server process - tests exercise `createServer()`
 * directly (or spawn a real child process for the end-to-end suite) so
 * that in-process unit tests never install `SIGTERM`/`SIGINT` handlers or
 * consume the test runner's own stdin. Also the ONLY place
 * `jobStore.startRetentionSweeper()` is ever called, for the identical
 * reason - see that method's own docs for why starting it from
 * `createServer()` (or the `JobStore` constructor) instead would leave
 * every test-constructed instance running its own background timer.
 */
export async function runServer(): Promise<GhantikaServer> {
  const instance = createServer();
  await instance.server.connect(instance.transport);
  attachProcessShutdownHandlers(instance);
  jobStore.startRetentionSweeper();
  return instance;
}

function attachProcessShutdownHandlers(instance: GhantikaServer): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    instance
      .shutdown(signal)
      .catch((error: unknown) => console.error("[ghantika] error during shutdown:", error))
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.stdin.once("end", () => {
    instance
      .shutdown("stdin EOF")
      .catch((error: unknown) => console.error("[ghantika] error during shutdown:", error))
      .finally(() => process.exit(0));
  });
}
