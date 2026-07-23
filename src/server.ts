/**
 * The stdio transport and protocol wiring: creates the
 * SDK's `Server`, registers the `tools/list`/`tools/call` handlers,
 * connects the stdio transport, and attaches shutdown handling. This is
 * the only file that touches the SDK's `Server`/`StdioServerTransport`
 * classes directly - `src/registry.ts` owns what the six tools ARE,
 * this file owns wiring them onto the wire.
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

import { isTerminalJobState, jobStore } from "./jobStore.js";
import { checkProcessIdentity, killProcessGroupPosix, killProcessTreeWindows } from "./process.js";
import { dispatchToolCall, listToolDefinitions } from "./registry.js";

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
   * process exits cleanly. This REAPS every still-live (`starting`/
   * `running`) job's whole process tree before the transport closes - see
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
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
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
    return dispatchToolCall(request.params.name, request.params.arguments);
  });

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
  console.error(`[ghantika] shutting down (${reason})`);
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
 * Reaps every currently non-terminal (`starting`/`running`) job's WHOLE
 * process tree, on every shutdown path -
 * stdin EOF, SIGTERM, SIGINT all funnel through the single `shutdown()`
 * function above (see `attachProcessShutdownHandlers` below), so this runs
 * identically for all three. Deliberately REUSES the real
 * containment machinery (`process.ts`'s `checkProcessIdentity`/
 * `killProcessGroupPosix`/`killProcessTreeWindows`, the exact functions
 * `src/tools/kill.ts` itself calls) rather than inventing a second kill
 * mechanism - the identity check (never blindly signal a possibly-reused
 * pid) and the POSIX whole-process-GROUP signaling (reaching every
 * descendant, not just the one tracked child) both matter just as much at
 * shutdown as they do for an explicit `kill()` call.
 *
 * Every live job is reaped CONCURRENTLY (`Promise.all`), not one after
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
  const liveJobs = jobStore.list().filter((record) => !isTerminalJobState(record.state));
  await Promise.all(liveJobs.map((record) => reapOneJobOnShutdown(record.job_id)));
}

async function reapOneJobOnShutdown(jobId: string): Promise<void> {
  const handle = jobStore.getChildHandle(jobId);
  if (handle === undefined) return; // no child was ever attached (e.g. a job that started already-failed) - nothing to reap

  if (process.platform === "win32") {
    try {
      killProcessTreeWindows(handle.pid);
    } catch (error) {
      // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- jobId is this codebase's own randomUUID(), never attacker-supplied, and this is a diagnostic console.error to stderr, not a format-string sink.
      console.error(`[ghantika] error killing job ${jobId}'s process tree during shutdown:`, error);
    }
    jobStore.markKilled(jobId, "SIGKILL-equiv");
    return;
  }

  // The identity check's own safety property, reused here verbatim: never
  // signal a tracked pid without first confirming, via a real external OS
  // lookup, that it's still genuinely the process this codebase spawned -
  // a job that already exited naturally in a race just before shutdown
  // reached it (identity "not-found") or whose pid has since been reused
  // by an unrelated process (identity "identity-mismatch") is left
  // untouched either way, exactly matching `src/tools/kill.ts`'s own
  // handling of both cases.
  const identity = checkProcessIdentity(handle.pid, handle.spawnedAtMs);
  if (identity.status !== "alive-confirmed") return;

  try {
    await killProcessGroupPosix(handle.pid, SHUTDOWN_KILL_GRACE_PERIOD_MS, {
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
 * consume the test runner's own stdin.
 */
export async function runServer(): Promise<GhantikaServer> {
  const instance = createServer();
  await instance.server.connect(instance.transport);
  attachProcessShutdownHandlers(instance);
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
