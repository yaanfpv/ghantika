/**
 * The stdio transport and protocol wiring: creates the SDK's `Server`,
 * registers the `tools/list`/`tools/call` handlers, connects it to a
 * stdio transport, and attaches shutdown handling. This is the only file
 * that touches the SDK's `Server`/`StdioServerTransport`/`serveStdio`
 * classes directly - `src/registry.ts` owns what the seven tools ARE, this
 * file owns wiring them onto the wire.
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
 * ## Two eras, one factory, one shared construction path
 *
 * The installed `@modelcontextprotocol/server@2.0.0` SDK speaks two wire
 * eras: the 2025 handshake (`initialize` / `notifications/initialized`,
 * negotiated per-connection) this codebase always spoke, and the
 * 2026-07-28 revision's `server/discover` opening exchange (a per-request
 * `_meta` envelope, no `initialize` at all). `serveStdio` (from
 * `@modelcontextprotocol/server/stdio`) owns the era decision for a real
 * stdio connection: it classifies the FIRST message, pins ONE instance
 * from a caller-supplied FACTORY for the connection's lifetime, and - for
 * a client that opens with `server/discover` and then falls back to
 * `initialize` - discards a first, optimistic "probe" instance and builds
 * a second one from the SAME factory. `runServer()` below is what wires
 * ghantika onto `serveStdio`; `createServer()` stays a lower-level,
 * transport-agnostic entry point (a direct in-process test - most of
 * `test/jobStore.test.ts`, `test/concurrency.test.ts`, part of
 * `test/shutdown.test.ts`, and others - connects a `createServer()`
 * instance directly to an `InMemoryTransport`, with no `serveStdio`
 * involved at all; a spawned real-child test - `test/e2e-server.test.ts`,
 * the rest of `test/shutdown.test.ts`, and `test/modern-handshake.test.ts`
 * - spawns the real `dist/index.js` binary, which runs through
 * `serveStdio` exactly as a production connection does - see its own
 * doc comment). Both share ONE construction function,
 * `buildGhantikaServerCore()`, so a real production connection and every
 * in-process test build the exact same `Server` the exact same way.
 *
 * ## The initialize-gate is a SECURITY CONTROL, and it moves to connect()
 *
 * The gate below (`isInitializedForToolCalls`) exists so `tools/call`
 * never runs before a client has completed a REAL, SUCCESSFUL handshake -
 * see `buildGhantikaServerCore()`'s own doc comment for the full
 * three-condition rationale (unchanged from before this file grew
 * `serveStdio` support). What DID change: the old code attached its two
 * observers (`attachInitializeRequestObserver`/
 * `attachInitializeResponseObserver`) directly onto a known `transport`
 * object BEFORE calling `server.connect(transport)` externally, relying
 * on `Protocol.connect()`'s own behavior of reading whatever
 * `transport.onmessage`/`.send` was already set at connect-time and
 * chaining it ahead of its own dispatch. Under `serveStdio`, a pinned
 * instance is never connected to the real wire transport at all - it is
 * connected to a `StdioConnectionChannel` proxy that `serveStdio`
 * constructs and connects INTERNALLY, inside its own `connectInstance()`,
 * entirely after this file's factory function has already returned. There
 * is no external hook that hands this file a reference to that channel
 * before `.connect()` runs on it.
 *
 * The fix: override `.connect` on the `Server` instance ITSELF, so
 * whatever object `.connect(x)` is eventually called with - the real
 * `Transport` this file's own `createServer()` callers pass directly, or
 * the channel `serveStdio` passes internally - gets the SAME two
 * observers wired onto it FIRST, before delegating to the real
 * `Protocol.prototype.connect`. This preserves the exact chaining
 * mechanism the old code relied on (confirmed directly against the
 * installed SDK's own `Protocol.connect()` source, not assumed - it
 * still reads `transport.onmessage`/`.onclose`/`.onerror` at the moment
 * `connect()` runs and chains them), just triggered from inside this
 * file's own OWN `.connect` rather than from an external caller - so both
 * calling conventions (direct `.connect(transport)`, and `serveStdio`'s
 * own `product.connect(channel)`) share one wiring mechanism instead of
 * two. Proven against the real `StdioConnectionChannel` proxy by real
 * execution in `test/modern-handshake.test.ts`'s serveStdio gate-observer
 * tests, not assumed from reading the SDK's source alone.
 *
 * ## Modern era's own trust anchor: `serveStdio`'s construction sequence
 *
 * The 2026-07-28 revision has no `initialize`/`notifications/initialized`
 * exchange for the gate to observe at all. Confirmed directly against the
 * installed SDK's own `serveStdio` source: for a modern-era instance,
 * `connectInstance()` calls `setNegotiatedProtocolVersion(server,
 * revision)` BEFORE `product.connect(channel)` - so by the time this
 * file's own `.connect` override runs, `server.getNegotiatedProtocolVersion()`
 * already reports the negotiated modern revision, for every modern
 * instance and ONLY for a modern instance (a legacy instance's negotiated
 * version stays `undefined` until its own real `initialize` request is
 * processed, which happens strictly after `.connect()` resolves). That
 * ordering is itself a stronger guarantee than the legacy gate's own
 * three-flag proof: nothing can reach this instance's `channel.deliver()`
 * - not even the `server/discover` request that opened the connection -
 * until `connectInstance()`'s full sequence, including this file's own
 * `.connect` override, has already resolved. So a modern instance treats
 * that ordering itself as proof of a completed handshake, rather than
 * hand-rolling an equivalent for a handshake shape that does not exist on
 * this era.
 *
 * ## Reading a request's own declared client capabilities: two genuinely
 * different sources, one per era, never the same accessor for both
 *
 * `tools/call`'s `run` branch (below) needs to know whether the CALLER
 * declared `io.modelcontextprotocol/tasks` support before deciding whether
 * to hand the result to `tasksAdapter.maybeAugmentRunResult`. On the legacy
 * era this is exactly what it always was: `server.getClientCapabilities()`
 * reads a value the SDK's `_oninitialize` sets ONCE, from the client's own
 * `initialize` request, and that same value answers for every request on
 * the connection - genuinely connection-level, matching the legacy
 * handshake's own one-time-negotiation model.
 *
 * The 2026-07-28 revision has no `initialize` exchange to populate anything
 * from at all - it requires every request to carry its OWN
 * `io.modelcontextprotocol/clientCapabilities` `_meta` envelope key
 * (confirmed against the installed SDK's own wire codec:
 * `REQUIRED_ENVELOPE_KEYS` names it alongside the protocol-version key, and
 * `checkInboundEnvelope` rejects any modern-era request missing it, before
 * this file's own handler ever runs). So on the modern era,
 * `getClientCapabilities()` is the WRONG accessor - and, under this
 * codebase's real stdio wiring, silently returns `undefined` forever, not
 * merely "the wrong value for this one request." Confirmed by reading the
 * installed SDK's own source rather than assumed: the SDK's per-request
 * backfill for that deprecated accessor (`seedClientIdentityFromEnvelope`,
 * which copies each request's envelope-declared capabilities onto the
 * `Server` instance so the deprecated accessor keeps answering) is called
 * from exactly one place - the SDK's HTTP `createMcpHandler` entry point,
 * which builds a brand-new `Server` instance PER HTTP REQUEST and seeds
 * each one individually. `serveStdio` (what this file actually uses) pins
 * ONE `Server` instance for a connection's entire lifetime and never calls
 * that backfill function at all (grepped the installed
 * `@modelcontextprotocol/server/dist/stdio.mjs` for every name it could
 * plausibly be imported or referenced under - zero matches). So a
 * `serveStdio`-served modern connection's `getClientCapabilities()` never
 * gets populated by ANY code path, for the connection's entire life -
 * meaning a client that declares Tasks support exactly the way the
 * released spec requires (its own request's per-request envelope) could
 * never be recognized, and the Tasks-extension mint path could never fire
 * on the modern era, regardless of what any client actually declared. This
 * is precisely the gap the installed SDK's own doc comment on
 * `getClientCapabilities()` steers callers away from: "Read client
 * identity from the per-request handler context instead."
 *
 * `resolveRunClientCapabilities` (below) is that per-era split, made
 * explicit rather than left to an accessor whose correctness silently
 * depends on which entry point happens to be serving the connection: the
 * legacy era keeps using `getClientCapabilities()` (unchanged, still
 * correct there), and the modern era reads
 * `ctx.mcpReq.envelope[CLIENT_CAPABILITIES_META_KEY]` directly - the SAME
 * per-request value the SDK's own internal capability checks use, publicly
 * exposed on the request handler's own `ctx` for exactly this purpose. The
 * distinction between the two eras is captured once, in the `servedModernEra`
 * flag set inside this file's own `.connect` override (the same place that
 * already knows, from `server.getNegotiatedProtocolVersion()`, which era a
 * given instance serves - see "Modern era's own trust anchor" above).
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
 * - A genuinely unparseable line (fails `JSON.parse` itself) gets -32700,
 *   and a line that parses as JSON but fails the base JSON-RPC envelope
 *   schema gets -32600: `createStdioTransport` below classifies every raw
 *   line BEFORE it ever reaches the real transport (see its own doc
 *   comment for the full rationale, including why this moved off the
 *   transport's own `onerror` callback - `serveStdio` owns that callback
 *   now and never writes a reply through it).
 * - A line that parses as valid JSON-RPC but carries a malformed
 *   2026-07-28 `_meta` envelope (a present-but-invalid modern claim) is a
 *   SEPARATE, higher-level concern `serveStdio` itself owns (-32602
 *   `Invalid _meta envelope: ...`), not this file's classification above.
 * - An unknown TOOL NAME (`tools/call` naming something other than one of
 *   the seven registered tools) is -32602, thrown by `registry.dispatchToolCall`
 *   - a valid method (`tools/call`) with an invalid parameter (the tool
 *   name).
 * - A known tool whose ARGUMENTS fail its own schema is never a JSON-RPC
 *   error at all: each tool handler in `src/tools/` returns a normal,
 *   successful `CallToolResult` with `isError: true` - see each handler's
 *   own `toolError` helper.
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  deserializeMessage,
} from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type {
  ClientCapabilities,
  JSONRPCMessage,
  ServerContext,
  Transport,
} from "@modelcontextprotocol/server";
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
   * True once this connection has completed a real handshake for its own
   * era - see `buildGhantikaServerCore()`'s doc comment for exactly what
   * that means on each era (the legacy three-condition proof, or the
   * modern pre-connect trust anchor).
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
 * Caps how many entries `earlyCancellations` (inside
 * `buildGhantikaServerCore()`) may hold at once - see that map's own doc
 * comment for what it guards against and why the exact number here has
 * no measured basis.
 */
const MAX_PENDING_EARLY_CANCELLATIONS = 256;

/**
 * Builds a fresh `Server` (a brand-new instance, with brand-new
 * initialize-gate closure state - never anything module-level or shared)
 * and registers every request handler this codebase's own protocol
 * surface needs, but does NOT connect it to anything. Shared by
 * `createServer()` (this file's transport-agnostic, test-facing entry
 * point) and `ghantikaServerFactory()` (the `McpServerFactory`
 * `runServer()` hands to `serveStdio`) - a real production connection and
 * every in-process test build the Server the exact same way, and a
 * probe-then-fallback connection (see this file's header doc) gets a
 * genuinely FRESH instance, with fresh closure state, on every call: two
 * separate `buildGhantikaServerCore()` invocations never share so much as
 * a variable binding, which is what keeps a discarded probe's gate state
 * from ever leaking into the fallback instance that replaces it (proven
 * by real execution in `test/modern-handshake.test.ts`'s probe-then-
 * fallback test).
 */
function buildGhantikaServerCore(): { server: Server; isInitialized(): boolean } {
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
  // requires both that success flag AND the `initialized` notification -
  // on a LEGACY connection. On a MODERN connection there is no
  // `initialize`/`initialized` exchange to observe at all, so this
  // file's own `.connect` override below (see its own doc comment) marks
  // both flags true directly, from a strictly stronger trust anchor:
  // `serveStdio`'s own pre-connect construction sequence.
  let pendingInitializeRequestId: string | number | undefined;
  let initializeNegotiationSucceeded = false;
  let receivedInitializedNotification = false;
  // Set exactly once, inside `.connect` below, from the SAME
  // `getNegotiatedProtocolVersion()` pre-connect check the legacy-vs-modern
  // gate logic already uses - never re-derived elsewhere, so there is only
  // one place that decides which era this instance serves. Read by
  // `resolveRunClientCapabilities` (module scope, below) to pick the right
  // capability source for the `run` branch of `tools/call` - see this
  // file's header doc ("Reading a request's own declared client
  // capabilities") for why the two eras need genuinely different sources.
  let servedModernEra = false;

  // A SEPARATE, independent record of one in-flight `tools/call`'s own
  // AbortController, keyed by its JSON-RPC request id - NOT the SDK's own
  // internal `_requestHandlerAbortControllers` map, and never read from or
  // written to it. Exists because the installed, pinned SDK's own
  // cancellation dispatch (`Protocol._oncancel`) drops a legal request id
  // of `0` or `""` (empty string): its guard is `if
  // (!notification.params.requestId) return;`, and both `0` and `""` are
  // falsy in JavaScript, so a client whose request happens to carry either
  // id (both entirely legal JSON-RPC - ids are `string | number`, with no
  // reservation on either value) can never have that request's
  // cancellation delivered through the SDK's own path, no matter how
  // correctly this file forwards `ctx.mcpReq.signal`. See
  // `attachCancelledNotificationObserver`'s own doc comment below for how
  // this map is populated independently of that broken guard, and the
  // `tools/call` handler below for where a controller is registered here
  // and combined with the SDK's own (still-correct-for-every-other-id)
  // signal via `AbortSignal.any`.
  //
  // A PLAIN OBJECT, not a `Map`. The reason is the rule's INTENT, not the
  // checker's blind spot: this holds one `AbortController` per in-flight
  // request, registered in the `tools/call` handler below and deleted in
  // that handler's own `finally` on every path out - success, error, or a
  // cancellation-shortened return alike - the exact same bounded,
  // per-request lifetime the SDK's own `_requestHandlerAbortControllers`
  // map already has for the same request. That is not the persistent,
  // connection-spanning state scripts/check-module-boundaries.mjs's guard
  // exists to keep out of this file (see that script's own header for the
  // full rationale - the same reason `wake/appServerTransport.ts`'s and
  // `wake/desktopIpcTransport.ts`'s own per-connection bookkeeping lives
  // on private class instance fields rather than a module-level
  // container: real state, real bounded lifetime, just never spelled as a
  // `Map`/`Set`/`Array()`/`Object()` construction, which is what that
  // guard's AST scan actually looks for). `cancellationKey` exists
  // because a plain object's keys are always coerced to strings, which
  // would otherwise silently collide a numeric id `0` with a string id
  // `"0"` - something a real `Map` (SameValueZero keyed) never would - so
  // every key is tagged with its original JSON-RPC id TYPE before
  // insertion, preserving the same distinction a `Map` would give for
  // free.
  const requestCancellationControllers: Record<string, AbortController> = {};

  /**
   * Tags `id` with its own JSON-RPC type (`"n:"` for `number`, `"s:"` for
   * `string`) before use as a plain-object key, so a numeric `0` and a
   * string `"0"` - both legal, distinct JSON-RPC request ids - can never
   * collide once coerced to an object property key. See
   * `requestCancellationControllers`'s own doc comment above for why this
   * is a plain object rather than a `Map` (which would need no such
   * tagging) in the first place.
   */
  function cancellationKey(id: string | number): string {
    return `${typeof id === "number" ? "n" : "s"}:${id}`;
  }

  // A raw `notifications/cancelled` can reach the observer below BEFORE
  // the `tools/call` handler for the SAME request id has run far enough
  // to register its controller in `requestCancellationControllers` above:
  // the installed SDK starts that handler on a microtask
  // (`Promise.resolve().then(() => handler(request, ctx))`, confirmed by
  // reading the installed SDK's own dispatch source) after it has already
  // synchronously registered ITS OWN internal controller, but the raw
  // observer below runs synchronously, in the SAME turn a message
  // arrives. So a request immediately followed by its own cancellation,
  // with no `await` between them on the sending side, can have the
  // cancellation fully processed and discarded before there is anything
  // here to abort. Measured directly: an immediate raw-wire request+
  // cancel pair for id `0`, and separately for `""`, left `follow.ts`'s
  // output listener, terminal listener, and admission-budget slot all
  // still live 50ms later, because nothing was registered yet when the
  // cancellation notification's observer fired.
  //
  // This map is the fix for that gap: when the observer below finds no
  // controller registered for an id, it records the cancellation here
  // instead of discarding it, and the `tools/call` handler checks this
  // map immediately after registering its own controller, applying the
  // cancellation right there if an entry is found - closing the race
  // regardless of which side happens to run first. `MAX_PENDING_EARLY_
  // CANCELLATIONS` bounds it: a client naming a request id that never
  // actually arrives leaves its entry here for the rest of the
  // connection's life, since nothing would ever consume it, so an
  // unbounded stream of such cancellations is an unbounded stream of
  // small leaked entries. The exact cap has no measured basis - it is
  // sized generously above any plausible legitimate race count and
  // disclosed as a defensive round number, not derived from real traffic
  // the way `follow.ts`'s own `MAX_OUTSTANDING_FOLLOWS` is.
  const earlyCancellations: Record<string, { reason: string | undefined }> = {};

  /**
   * The one place a raw `notifications/cancelled` observation (from
   * `attachCancelledNotificationObserver`, wired at both `.connect` call
   * sites below) actually gets applied - factored out rather than
   * duplicated at each call site, since the two-branch logic below is no
   * longer the one-line `?.abort(reason)` it used to be. If a controller
   * is already registered for this id, abort it directly (the common
   * case). Otherwise this observation arrived before the `tools/call`
   * handler for the same id could register one - see
   * `earlyCancellations`'s own doc comment - so it's persisted there
   * instead of discarded, bounded by `MAX_PENDING_EARLY_CANCELLATIONS`.
   */
  function applyCancellation(requestId: string | number, reason: string | undefined): void {
    const key = cancellationKey(requestId);
    const controller = requestCancellationControllers[key];
    if (controller !== undefined) {
      controller.abort(reason);
      return;
    }
    if (Object.keys(earlyCancellations).length < MAX_PENDING_EARLY_CANCELLATIONS) {
      earlyCancellations[key] = { reason };
    }
  }

  const isInitializedForToolCalls = (): boolean =>
    initializeNegotiationSucceeded && receivedInitializedNotification;

  server.oninitialized = () => {
    receivedInitializedNotification = true;
  };

  // The one thing tasksAdapter.ts's two notification mechanisms (the
  // pre-existing output-driven wake AND the released spec's own
  // per-transition `notifications/tasks` status notification - see
  // tasksAdapter.ts's own header on the two, and maybeAugmentRunResult's
  // own docs for why the adapter itself never imports `Server`) need from
  // THIS connection's real `Server` instance. A thin, fire-and-forget
  // wrapper that relays whichever `method` the adapter hands it - this
  // file stays unaware of which notification is which, exactly as it
  // stays unaware of every other Tasks-shaped detail (see this file's own
  // header). Both notifications are best-effort accelerators on top of the
  // poll floor, which stays authoritative regardless (see tasksAdapter.ts's
  // own header), so a failed send is logged to stderr and never allowed to
  // propagate into the tool-call response path that triggered it.
  const sendTaskNotification = (method: string, params: Record<string, unknown>): void => {
    server.notification({ method, params }).catch((error: unknown) => {
      console.error("[ghantika] error sending", method, error);
    });
  };

  server.setRequestHandler("tools/list", async () => ({
    tools: listToolDefinitions(),
  }));

  server.setRequestHandler("tools/call", async (request, ctx) => {
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
    // `ctx.mcpReq.signal` is the real per-request `AbortSignal` the
    // installed SDK fires when the client sends `notifications/cancelled`
    // for this exact request id (see the SDK's own `_oncancel`, which maps
    // `notification.params.requestId` straight to the `AbortController` it
    // keeps per in-flight request) - correct for every request id EXCEPT
    // `0` and `""` (see `requestCancellationControllers`'s own doc comment
    // above). `ourController` is this file's own, entirely independent
    // tracking of the SAME request, registered here and aborted by
    // `attachCancelledNotificationObserver`'s raw-wire observer - which
    // sees every `notifications/cancelled` message regardless of what the
    // SDK's own dispatch does with it, so it fires correctly for `0` and
    // `""` too. That observer is installed BEFORE `Protocol.connect()`
    // runs (see the `.connect` override below), and `Protocol.connect()`
    // itself chains its own dispatch AFTER whatever handler was already
    // present at connect time - so on every incoming message, including a
    // cancellation for a NONZERO id, this observer's own check actually
    // runs BEFORE the SDK's own `_oncancel`, not after it as this file
    // previously (incorrectly) claimed. `AbortSignal.any` combines both
    // signals regardless of which one fires first: once either aborts,
    // the combined signal stays aborted for good, so that ordering never
    // changes whether `combinedSignal` ends up aborted - only, harmlessly,
    // which underlying signal happened to trip it first. Forwarded
    // through unconditionally, for every tool - `dispatchToolCall`/
    // `registry.ts` decide what, if anything, a given tool does with it;
    // today only `follow.ts` reads it at all, every other handler's
    // signature simply ignores the extra argument, same as before this
    // signal ever existed.
    //
    // What this file's own signal does NOT change: the SDK's own dispatch
    // discards whatever this handler eventually returns once ITS OWN
    // `abortController.signal.aborted` is true by the time the result
    // settles (see its own dispatch code, `if
    // (abortController.signal.aborted) return;` on both the success and
    // error branches) - that check reads the SDK's own controller, never
    // `ourController`, and this file never touches it. For every id other
    // than `0`/`""`, the SDK's own `_oncancel` DOES abort that controller
    // on a real cancellation, so that suppression still applies exactly
    // as before this fix - a cancelled call gets no response at all. For
    // `0` and `""` specifically, the SDK's own controller is NEVER
    // aborted (its `_oncancel` guard drops the notification before ever
    // reaching it), so that suppression never triggers there:
    // `follow.ts`'s own cancellation result (see
    // `cancelledWhileWaitingResult`/`alreadyCancelledBeforeStartResult`)
    // IS what gets sent back as a normal response, for those two ids
    // only. Closing that asymmetry would mean writing into the SDK's own
    // private internal state from outside it, which this file
    // deliberately does not do anywhere - the whole point of the
    // independent-observer design above is never reaching into the SDK's
    // private fields. Disclosed here rather than left for a caller to
    // discover: a `0`/`""`-id caller that cancels a `follow` call gets
    // its resources torn down immediately, same as any other id, but
    // should still expect ONE final response for that call - carrying
    // `follow.ts`'s own cancellation text - rather than the silence every
    // other id's cancellation produces.
    const ourController = new AbortController();
    const requestKey = cancellationKey(ctx.mcpReq.id);
    requestCancellationControllers[requestKey] = ourController;
    // A cancellation for this exact id may already have arrived and been
    // recorded in `earlyCancellations` before this line ran - see that
    // map's own doc comment for the race it closes. Consuming it here,
    // before `combinedSignal` is even constructed, means `AbortSignal.any`
    // below observes an ALREADY-aborted `ourController.signal` when that
    // has happened, so `combinedSignal` itself starts aborted too (per
    // `AbortSignal.any`'s own spec: it returns an already-aborted signal
    // when any input signal is already aborted at call time) - which is
    // exactly what lets `follow.ts`'s own `signal?.aborted === true` check,
    // at the very first line of its handler, take the "already cancelled,
    // never subscribed" path rather than subscribing anything that would
    // then have to be torn down again.
    const pendingEarlyCancellation = earlyCancellations[requestKey];
    if (pendingEarlyCancellation !== undefined) {
      delete earlyCancellations[requestKey];
      ourController.abort(pendingEarlyCancellation.reason);
    }
    try {
      const combinedSignal = AbortSignal.any([ctx.mcpReq.signal, ourController.signal]);
      const result = await dispatchToolCall(
        request.params.name,
        request.params.arguments,
        combinedSignal
      );
      // ONLY run() is ever handed to the adapter - status/output/tail/kill/
      // list pass straight through unchanged, so the plain poll floor stays
      // reachable on every connection regardless of Tasks capability.
      // Capability comes from resolveRunClientCapabilities (below) - the
      // connection's initialize-declared value on the legacy era, or THIS
      // request's own per-request `_meta` envelope declaration on the
      // 2026-07-28 era (see that function's own docs, and this file's header
      // doc "Reading a request's own declared client capabilities," for why
      // the two eras need genuinely different sources) - never off anything
      // in `run()`'s own tool arguments, which is what keeps minting free of
      // a per-call opt-in field on either era.
      if (request.params.name === "run") {
        const capable = tasksAdapter.isConnectionTasksCapable(
          resolveRunClientCapabilities(server, ctx, servedModernEra)
        );
        return tasksAdapter.maybeAugmentRunResult(result, capable, sendTaskNotification);
      }
      return result;
    } finally {
      // Runs on every path out of the `try` above - the two `return`s and
      // any thrown error alike - so `requestCancellationControllers` never
      // retains an entry for a request that has already settled, matching
      // the SDK's own `_requestHandlerAbortControllers` cleanup at the
      // corresponding point in its dispatch (see this constant's own doc
      // comment for why this is a SEPARATE map rather than that one).
      delete requestCancellationControllers[requestKey];
    }
  });

  // The three registered task methods - see tasksAdapter.ts's header for
  // why tasks/get is the one pure-read snapshot, why tasks/update is a
  // pure existence/TTL check plus a fixed ack (its own params schema
  // additionally accepts, but never reads, inputResponses - the released
  // spec's own request shape, see taskUpdateParamsSchema's docs), why
  // tasks/cancel is the one place that adapter has a real side effect (it
  // delegates to tools/kill.ts's own process-group kill/reap containment
  // via tasksAdapter.cancelTask) while ALSO returning the same fixed ack
  // tasks/update does, and why no tasks/list or tasks/result method is
  // registered at all (the legacy result/list surface is deliberately not
  // implemented). A thrown tasksAdapter.getTask (task_not_found, -32602)
  // propagates unchanged out of tasks/get, and out of tasks/update and
  // tasks/cancel too (both call it internally to validate the taskId
  // before doing anything else) - the SDK's own request dispatch turns
  // that thrown ProtocolError into a real JSON-RPC error response, the
  // same mechanism the tools/call gate above already relies on.
  //
  // NONE of the three is gated by Tasks capability at this registration -
  // each takes only its own params schema, never a capability read, unlike
  // the `run` branch of tools/call above. This is deliberate: a taskId is
  // an opaque, unguessable jobStore job_id, so the meaningful boundary is
  // "does this taskId resolve to something real", which tasksAdapter.getTask
  // already enforces on every one of these three, not "did this connection
  // declare the extension."
  //
  // A REAL, MEASURED WIRE FACT about the installed SDK, disclosed here
  // rather than left to surprise a future reader: on the 2026-07-28 era
  // specifically, `tasks/get` and `tasks/cancel` are UNROUTABLE regardless
  // of what this file registers. Confirmed by reading the installed
  // `@modelcontextprotocol/server` package's own dispatch source directly,
  // then reproduced end to end against the real built server: `tasks/get`
  // and `tasks/cancel` (but not `tasks/update`, which the legacy vocabulary
  // never defined) are members of the SDK's own 2025-11-25-era
  // `requestMethodKeys` registry - the deprecated get/result/list/cancel
  // vocabulary this codebase's own adapter deliberately never imports (see
  // tasksAdapter.ts's own header) - but ABSENT from the 2026-07-28 era's
  // own registry, which lists only core methods
  // (`tools/*`/`prompts/*`/`resources/*`/`completion/complete`/
  // `server/discover`/`subscriptions/listen`). The base `Protocol` class's
  // own request dispatch checks `isSpecRequestMethod(method) &&
  // !codec.hasRequestMethod(method)` BEFORE ever consulting this file's own
  // `_requestHandlers` map, and replies -32601 "Method not found" the
  // instant that holds - so a modern-era `tasks/get`/`tasks/cancel` request
  // never reaches `tasksAdapter.getTask`/`cancelTask` at all, with or
  // without Tasks capability declared (the block fires on the METHOD NAME
  // alone, before any capability is even read). `tasks/update` has no
  // legacy-era precedent at all, so it is recognized as a spec method by
  // NEITHER codec, falls through that guard entirely, and reaches this
  // file's own handler normally on both eras - reproduced directly: a real
  // modern-wire `tasks/update` call against a real minted task returns the
  // genuine `{resultType: "complete"}` ack, while `tasks/get`/`tasks/cancel`
  // against that SAME task on that SAME connection both return -32601. See
  // `test/modern-handshake.test.ts`'s own task-method tests for the
  // reproduction. This is an installed-SDK routing fact about the era, not
  // a defect in this file's own registration or a capability gate this
  // codebase applies - a legacy-era connection, or any in-process
  // `InMemoryTransport` test, reaches all three normally, and that is
  // where `tasks/get`/`tasks/cancel` are actually exercised end to end
  // today.
  server.setRequestHandler(
    "tasks/get",
    { params: tasksAdapter.taskIdParamsSchema() },
    async (params) => tasksAdapter.getTask(params.taskId)
  );
  server.setRequestHandler(
    "tasks/update",
    { params: tasksAdapter.taskUpdateParamsSchema() },
    async (params) => tasksAdapter.updateTask(params.taskId)
  );
  server.setRequestHandler(
    "tasks/cancel",
    { params: tasksAdapter.taskIdParamsSchema() },
    async (params) => tasksAdapter.cancelTask(params.taskId)
  );

  // See this file's header doc ("The initialize-gate is a SECURITY
  // CONTROL, and it moves to connect()") for the full rationale. This
  // override is what lets ONE wiring mechanism serve both calling
  // conventions: a direct in-process test calling `.connect(transport)`
  // itself against a known `Transport`, and `serveStdio` (used by
  // `runServer()` and by every spawned-real-child test) calling
  // `product.connect(channel)` internally against a
  // `StdioConnectionChannel` proxy this file never otherwise sees.
  const realConnect = server.connect.bind(server);
  server.connect = async (transport: Transport): Promise<void> => {
    // `attachCancelledNotificationObserver` is wired on BOTH branches
    // below, always AFTER `attachInitializeRequestObserver` has already
    // run wherever that also applies (the legacy branch) - see
    // `attachCancelledNotificationObserver`'s own doc comment for why it
    // CHAINS onto whatever `transport.onmessage` is already set to rather
    // than replacing it: `attachInitializeRequestObserver`'s own raw
    // assignment (not a chain) would silently discard this observer if
    // this one ran first. `requestCancellationControllers`'s own doc
    // comment above explains why this exists at all (the installed SDK's
    // own cancellation dispatch drops a legal request id of `0`).
    if (server.getNegotiatedProtocolVersion() !== undefined) {
      // A pre-negotiated MODERN connection - see this file's header doc
      // ("Modern era's own trust anchor") for why `serveStdio` setting
      // this BEFORE calling `.connect()` is itself the proof a legacy
      // connection has no equivalent for and does not need one. Nothing
      // else claims `transport.onmessage` on this branch, so this is a
      // plain (first) assignment, not actually a chain - see this
      // function's own doc comment.
      servedModernEra = true;
      initializeNegotiationSucceeded = true;
      receivedInitializedNotification = true;
      attachCancelledNotificationObserver(transport, applyCancellation);
      return realConnect(transport);
    }
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
    // Runs AFTER `attachInitializeRequestObserver` above, so it CHAINS onto
    // that observer's own `transport.onmessage` assignment rather than
    // silently discarding it - see this function's own doc comment.
    attachCancelledNotificationObserver(transport, applyCancellation);
    return realConnect(transport);
  };

  return { server, isInitialized: isInitializedForToolCalls };
}

/**
 * Resolves the client capabilities that govern ONE `tools/call` request's
 * own Tasks-capability check - see this file's header doc ("Reading a
 * request's own declared client capabilities") for the full rationale on
 * why the two eras need genuinely different sources rather than one
 * accessor that happens to work for both.
 *
 * Legacy era (`servedModernEra` false): `server.getClientCapabilities()`,
 * unchanged - the connection's own `initialize`-declared value, correct
 * and connection-level exactly as it always was.
 *
 * Modern era (`servedModernEra` true): `ctx.mcpReq.envelope`'s own
 * reserved `CLIENT_CAPABILITIES_META_KEY` entry - THIS request's own
 * per-request declaration, required and schema-validated by the SDK's own
 * `checkInboundEnvelope` before this handler ever runs (confirmed against
 * the installed SDK's `REQUIRED_ENVELOPE_KEYS`/`RequestMetaEnvelopeSchema`
 * source), so a present-but-empty object (a client that legitimately
 * declares no capabilities at all) is the only falsy-looking value ever
 * reachable here - never `undefined` the way an absent legacy declaration
 * would read. The cast below mirrors this same file's own
 * `extractJobId`-style narrowing already established in
 * `tasksAdapter.ts` - `RequestMetaEnvelope` is deliberately an opaque `{}`
 * shape in the installed SDK's own public types (its own doc comment: "a
 * neutral hand-written shape keyed by the public meta-key constants"), so
 * reading a member off it by the exported key constant is the SDK's own
 * intended usage, not a workaround.
 */
function resolveRunClientCapabilities(
  server: Server,
  ctx: ServerContext,
  servedModernEra: boolean
): ClientCapabilities | undefined {
  if (!servedModernEra) return server.getClientCapabilities();
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY];
  return typeof declared === "object" && declared !== null
    ? (declared as ClientCapabilities)
    : undefined;
}

/**
 * Builds a `GhantikaServer` and registers its request handlers, but does
 * NOT connect it to a transport or touch any process-level signal
 * handler. Kept separate from `runServer` so tests can construct and
 * exercise a server instance in-process without it taking over the test
 * runner's own stdin/stdout or `SIGTERM`/`SIGINT` - and entirely without
 * `serveStdio`'s own era-selection machinery, which a direct in-process
 * test using this function has no need for (it drives exactly one known
 * era over one known transport, decided by what IT sends, never by a real
 * client's own opening choice). Era-selection itself - a probe that opens
 * with `server/discover` and then falls back to `initialize` - IS
 * exercised, but only by a spawned real-child test going through
 * `serveStdio` (`test/modern-handshake.test.ts`'s own probe-then-fallback
 * test), never by a test built on this function.
 *
 * @param transport - defaults to a real stdio transport, wrapped to restore
 *   `-32700`/`-32600` replies for input the stock transport no longer
 *   reports on its own (see `createStdioTransport`'s own doc comment). A
 *   test may inject any other `Transport` implementation instead - e.g.
 *   the SDK's own `InMemoryTransport`, to drive a real `Client`/`Server`
 *   round trip in-process (see the jobStore-singleton-sharing regression
 *   coverage in `test/jobStore.test.ts`, which needs the running server
 *   and the test's own directly-imported `jobStore` to share one Node
 *   module registry - only possible in-process, never across the real
 *   spawned-child-process boundary `test/helpers/spawnServer.ts`
 *   otherwise uses).
 */
export function createServer(transport: Transport = createStdioTransport()): GhantikaServer {
  // A freshly constructed server is not itself shutting down - reopens
  // whatever an earlier server built against this same shared `jobStore`
  // singleton already closed. Harmless, and a genuine no-op, in real
  // production use (a real process serves at most two Server instances
  // over its own single connection's lifetime - see this file's header
  // doc on probe-then-fallback - before its own single shutdown); it only
  // does real work once more than one construction shares this one
  // process-lifetime singleton, which is exactly what this codebase's own
  // test suite does. See JobStore.clearShutdownGate's own docs.
  jobStore.clearShutdownGate();

  const { server, isInitialized } = buildGhantikaServerCore();

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
    isInitialized,
    shutdown,
  };
}

/**
 * The `McpServerFactory` `runServer()` hands to `serveStdio`: builds a
 * fresh, unconnected `Server` for one era-connection attempt.
 * `serveStdio` calls this once per real connection, and once more for a
 * `server/discover` probe instance that gets discarded again if the
 * client falls back to `initialize` (see this file's header doc) - every
 * call gets its own fresh `Server` and fresh initialize-gate closure
 * state via `buildGhantikaServerCore()`, never anything shared across
 * calls. Deliberately a ZERO-ARGUMENT factory, never declaring the
 * `McpRequestContext` (`{ era }`) parameter `McpServerFactory` offers -
 * the SDK's own docs state a zero-argument factory stays assignable
 * unchanged, and this file's tools/tasks capabilities never vary by era:
 * only what `serveStdio` does AROUND the connection (which handshake
 * shape it accepts, whether it advertises `server/discover` at all)
 * varies, and that lives entirely in `serveStdio`'s own options below,
 * never in this factory.
 */
function ghantikaServerFactory(): Server {
  jobStore.clearShutdownGate();
  return buildGhantikaServerCore().server;
}

/**
 * The shutdown SEQUENCE both entry points below share: close admission
 * before anything else - including the queue drain right after - so a
 * run() call arriving anywhere in this function's own async tail
 * (particularly the awaited live-job reap, which can take a while against
 * many jobs) is rejected outright rather than admitted or queued into a
 * queue nothing is ever going to drain again (see
 * `JobStore.beginShutdown`'s own docs); stop the retention sweeper; drain
 * anything still queued (never spawned a real child at all - see
 * `JobStore.drainQueueOnShutdown`'s own docs); then reap every tracked
 * job's real process group (see `reapLiveJobsOnShutdown`'s own docs).
 * Deliberately the ONLY place this sequence is written: `createServer()`'s
 * direct-transport `shutdown()` and `runServer()`'s real serveStdio-served
 * process both call this, then close whatever wire they each actually
 * own - a real `Transport` for the former, the `StdioServerHandle`
 * `serveStdio` returned for the latter (see `performShutdown`/
 * `performProcessShutdown` below) - so the two entry points can never
 * drift into reaping jobs differently.
 */
async function reapJobsForShutdown(reason: string): Promise<void> {
  jobStore.beginShutdown();
  jobStore.stopRetentionSweeper();
  console.error(`[ghantika] shutting down (${reason})`);
  try {
    jobStore.drainQueueOnShutdown();
  } catch (error) {
    console.error("[ghantika] error while draining the concurrency queue during shutdown:", error);
  }
  try {
    await reapLiveJobsOnShutdown();
  } catch (error) {
    console.error("[ghantika] error while reaping live jobs during shutdown:", error);
  }
}

/** `createServer()`'s own shutdown path: reaps jobs, then closes the exact `Transport` it was built against. */
async function performShutdown(transport: Transport, reason: string): Promise<void> {
  await reapJobsForShutdown(reason);
  try {
    await transport.close();
  } catch (error) {
    console.error("[ghantika] error while closing transport during shutdown:", error);
  }
}

/**
 * `runServer()`'s own shutdown path: reaps jobs, then closes via
 * `serveStdio`'s own returned `StdioServerHandle.close()` rather than a
 * transport directly - `serveStdio` owns the wire AND whichever instance
 * (if any) is currently pinned or being probed, and its own `close()`
 * tears down both (see this file's header doc for why this file never
 * gets a direct handle to whatever instance is live at shutdown time).
 * Reaping jobs BEFORE calling this is what keeps the ordering identical
 * to `performShutdown` above: every live job is signaled while the
 * connection (and thus this process's stdout) is still usable, in case a
 * job's own diagnostics needed it, before the connection itself goes
 * away.
 */
async function performProcessShutdown(handle: StdioServerHandle, reason: string): Promise<void> {
  await reapJobsForShutdown(reason);
  try {
    await handle.close();
  } catch (error) {
    console.error("[ghantika] error while closing the stdio connection during shutdown:", error);
  }
}

/**
 * Reaps every currently tracked job's own process GROUP, on every
 * shutdown path - stdin EOF, SIGTERM, SIGINT all funnel through
 * `reapJobsForShutdown` above (see `attachProcessShutdownHandlers`
 * below), so this runs identically for all three. Deliberately REUSES the real
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
 * `buildGhantikaServerCore()`'s own doc comment above for the full
 * rationale (why `oninitialized` alone is bypassable, why a bare
 * method-name match is bypassable too, and why re-registering
 * `InitializeRequestSchema` isn't a safe option).
 *
 * `Protocol.connect()` reads whatever `transport.onmessage` was already
 * set at connect-time and chains it ahead of its own dispatch - so this
 * handler sees every message the SDK sees, including ones that never end
 * up dispatched anywhere (e.g. a `notifications/initialized` sent with no
 * prior `initialize` - exactly the bypass this closes). `transport` here
 * is whatever this file's own `.connect` override (see
 * `buildGhantikaServerCore()`) was called with - a real `Transport` under
 * `createServer()`'s direct-connect callers, or `serveStdio`'s own
 * `StdioConnectionChannel` proxy under `runServer()`; this function
 * itself stays agnostic to which.
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
 * Wires an observer onto `transport.onmessage` that fires for every
 * `notifications/cancelled` message, entirely independent of the SDK's own
 * routing/dispatch of that SAME message - see
 * `requestCancellationControllers`'s own doc comment (above, in
 * `buildGhantikaServerCore`) for why this exists: the installed, pinned
 * SDK's own `Protocol._oncancel` drops a legal numeric request id of `0`
 * (`if (!notification.params.requestId) return;` - `0` is falsy), so a
 * caller relying solely on `ctx.mcpReq.signal` never sees an abort for
 * that one legal id. This observer changes nothing about what the SDK
 * itself does with the message - its own `_oncancel` still runs, via its
 * own separately-registered notification handler, completely unaffected -
 * this is purely a SECOND, independent read of the same wire traffic.
 *
 * CHAINS onto whatever `transport.onmessage` is already set (calls it
 * first, unconditionally, before this observer's own check), rather than
 * replacing it outright - the same defensive pattern
 * `Protocol.connect()` itself uses when it reads whatever `onmessage` was
 * already present at connect-time (see this file's header doc). Without
 * this, wiring this observer AFTER `attachInitializeRequestObserver` (which
 * does a raw, non-chaining assignment) would silently discard that
 * observer instead of adding to it - see the call sites in `.connect`
 * above for why ordering there matters.
 */
function attachCancelledNotificationObserver(
  transport: Transport,
  onCancelled: (requestId: string | number, reason: string | undefined) => void
): void {
  const previousOnMessage = transport.onmessage;
  transport.onmessage = (message) => {
    previousOnMessage?.(message);
    const info = cancelledNotificationInfo(message);
    if (info !== undefined) {
      onCancelled(info.requestId, info.reason);
    }
  };
}

/**
 * Returns `{ requestId, reason }` when `message` is a genuine
 * `notifications/cancelled` NOTIFICATION (has `method ===
 * "notifications/cancelled"` and NO `id` - a notification never carries
 * one, per JSON-RPC 2.0), `undefined` otherwise. `requestId` is checked by
 * TYPE alone (`string` or `number`), deliberately never by truthiness -
 * that is the exact guard the installed SDK's own `_oncancel` gets wrong
 * for a legal `requestId` of `0`, and the whole reason this function
 * exists rather than reusing that one.
 */
function cancelledNotificationInfo(
  message: JSONRPCMessage
): { requestId: string | number; reason: string | undefined } | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const candidate = message as { method?: unknown; id?: unknown; params?: unknown };
  if (candidate.method !== "notifications/cancelled") return undefined;
  if (candidate.id !== undefined) return undefined;
  const params = candidate.params as { requestId?: unknown; reason?: unknown } | undefined;
  if (typeof params?.requestId !== "string" && typeof params?.requestId !== "number") {
    return undefined;
  }
  return {
    requestId: params.requestId,
    reason: typeof params.reason === "string" ? params.reason : undefined,
  };
}

/**
 * Wires an observer onto `transport.send`, BEFORE `server.connect(transport)`
 * is ever called, purely to detect whether the SDK's own negotiation for a
 * specific pending initialize request `id` actually SUCCEEDED - a
 * transparent pass-through-plus-observation wrapper, never altering what's
 * actually sent or introducing any delay. See `buildGhantikaServerCore()`'s
 * own doc comment above for the full rationale (why observing only the
 * incoming request is insufficient, and the verified load-bearing claim
 * that `Protocol._onrequest`'s `capturedTransport.send(...)` genuinely
 * invokes this wrapper for the real initialize response - re-verified
 * against `StdioConnectionChannel.send()` specifically for the
 * `serveStdio` calling convention: it forwards every non-intercepted
 * outbound message straight to the real wire's own `send`, so a wrapper
 * installed here still observes it).
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
 * Wraps a real stdio transport so a line that fails to reach a valid
 * JSON-RPC message still gets a JSON-RPC error reply, restoring behavior
 * the stock SDK transport no longer provides on its own.
 *
 * Confirmed directly against the installed @modelcontextprotocol/server
 * package's own source (not inferred from types): `StdioServerTransport`'s
 * internal `ReadBuffer.readMessage()` catches a `SyntaxError` from
 * `JSON.parse` and silently moves on to the next line -
 * `if (error instanceof SyntaxError) continue;` - so `transport.onerror`
 * never fires for that case at all; a `ZodError` (valid JSON that isn't a
 * valid JSON-RPC envelope) DOES still propagate out of `readMessage()` and
 * reach `transport.onerror` on its own. So far this is unchanged from
 * before this file grew `serveStdio` support.
 *
 * What DID change, and why this now classifies BOTH failure classes at
 * this one raw-stdin layer instead of splitting them across two
 * mechanisms (`-32700` handled here, `-32600` handled by a separate
 * `transport.onerror` hook installed at connect-time): under `serveStdio`,
 * the WIRE transport's `onerror` callback is owned by `serveStdio` itself
 * (installed once, at `serveStdio(...)` call time, unconditionally
 * overwriting whatever was there before) and is reporting-only - it never
 * writes a reply to the wire. A `-32600` reply that depended on
 * `transport.onerror` would therefore silently stop arriving the moment
 * this file's production entry point (`runServer()`) started routing
 * through `serveStdio`, even though nothing about the actual malformed
 * input changed. Classifying both failure classes HERE instead - strictly
 * before any line ever reaches the real transport at all, whether that
 * transport is later connected directly or wrapped by `serveStdio` -
 * removes the dependency on a callback slot `serveStdio` owns, and is a
 * genuine simplification over the split this file used to have (both
 * codes now share one code path and one, not two, real
 * `deserializeMessage` call per line).
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
 * both replies go out through `transport.send(...)` itself - the same
 * call the SDK's own request handling uses for every ordinary response -
 * never a second, independent write to `process.stdout`. That keeps this
 * codebase's real invariant intact: the ONLY code that ever touches
 * `process.stdout` directly is the transport's own `send()`, exactly what
 * `scripts/check-stdio-purity.mjs` enforces structurally (see this file's
 * header). Verified empirically under real backpressure, not reasoned: an
 * 8MB transport response and a small direct write fired back-to-back on
 * the transport's own underlying stream object landed as two complete,
 * uncorrected lines, never interleaved - Node's `Writable` implementation
 * serializes writes to one stream instance internally, so routing both
 * replies through the one transport is what makes that guarantee apply
 * here at all. This holds regardless of whether `serveStdio` later wraps
 * this same transport as its `wire`: `StdioConnectionChannel.send()`
 * forwards every non-intercepted outbound message straight to
 * `wire.send()` too - the exact same underlying call - so there is still
 * only ever one writer.
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
      const classification = classifyStdinLine(rawLine.toString("utf8"));
      if (classification === "parse-error") {
        sendProtocolErrorResponse(transport, ProtocolErrorCode.ParseError, "Parse error");
        continue; // never forwarded - the transport must never see this line at all
      }
      if (classification === "invalid-envelope") {
        sendProtocolErrorResponse(transport, ProtocolErrorCode.InvalidRequest, "Invalid Request");
        continue; // same - a schema-invalid-but-parseable line is never forwarded either
      }
      virtualStdin.push(rawLine);
      virtualStdin.push("\n");
    }
  });
  process.stdin.on("end", () => virtualStdin.push(null));
  process.stdin.on("error", (error) => virtualStdin.destroy(error));

  return transport;
}

/**
 * Classifies one raw stdin line, before it's ever handed to the real
 * transport: `"ok"` for a line that deserializes as a genuine JSON-RPC
 * message; `"parse-error"` for a line that fails `JSON.parse` itself
 * (gets `-32700`); `"invalid-envelope"` for a line that IS valid JSON but
 * fails the base JSON-RPC envelope schema (gets `-32600`) - deliberately
 * the base envelope only (`jsonrpc`/`method`/`id` shape), never the
 * 2026-07-28 per-request `_meta` envelope, which `serveStdio` itself
 * validates at a higher layer once a line reaches it (a malformed modern
 * claim is `serveStdio`'s own `-32602`, a different code for a different,
 * later check - see this file's header doc's "Error-class behavior").
 */
type StdinLineClassification = "ok" | "parse-error" | "invalid-envelope";

function classifyStdinLine(line: string): StdinLineClassification {
  try {
    deserializeMessage(line.replace(/\r$/, ""));
    return "ok";
  } catch (error) {
    return error instanceof SyntaxError ? "parse-error" : "invalid-envelope";
  }
}

/** Sends a JSON-RPC error reply (`id: null`) through the transport's own `send(...)` - see `createStdioTransport`'s own doc comment for why this must go through the transport rather than a second direct write. */
function sendProtocolErrorResponse(
  transport: Transport,
  code: ProtocolErrorCode,
  message: string
): void {
  const response = {
    jsonrpc: "2.0" as const,
    id: null,
    error: { code, message },
  } as unknown as JSONRPCMessage;
  transport.send(response).catch((sendError: unknown) => {
    console.error("[ghantika] failed to send protocol-error response:", sendError);
  });
}

/**
 * Builds ghantika's real production entry point: serves both wire eras
 * over a real stdio connection via `serveStdio`, and attaches
 * process-level shutdown handling. This is what `src/index.ts` calls when
 * actually run as a server process - tests exercise `createServer()`
 * directly (or spawn a real child process for the end-to-end suite) so
 * that in-process unit tests never install `SIGTERM`/`SIGINT` handlers or
 * consume the test runner's own stdin. Also the ONLY place
 * `jobStore.startRetentionSweeper()` is ever called, for the identical
 * reason - see that method's own docs for why starting it from
 * `createServer()`/`ghantikaServerFactory()` (or the `JobStore`
 * constructor) instead would leave every test-constructed instance
 * running its own background timer.
 *
 * `serveStdio`'s own `legacy: 'serve'` (the default, passed explicitly
 * below so a future SDK bump changing that default can never silently
 * change this file's behavior) is what keeps a 2025-era `initialize`
 * opening served exactly as `createServer()`'s own direct-connect path
 * already serves it - see this file's header doc's "Two eras, one
 * factory" section for the full picture, and
 * `test/e2e-server.test.ts`'s legacy-handshake suite (unchanged by this
 * file's `serveStdio` migration) for the real-execution proof that stays
 * true.
 */
export async function runServer(): Promise<StdioServerHandle> {
  const wire = createStdioTransport();
  const handle = serveStdio(ghantikaServerFactory, {
    transport: wire,
    legacy: "serve",
    onerror: (error) => console.error("[ghantika] serveStdio connection error:", error),
  });

  let shuttingDown: Promise<void> | undefined;
  const shutdown = (reason: string): Promise<void> => {
    if (!shuttingDown) {
      shuttingDown = performProcessShutdown(handle, reason);
    }
    return shuttingDown;
  };
  attachProcessShutdownHandlers(shutdown);
  jobStore.startRetentionSweeper();
  return handle;
}

function attachProcessShutdownHandlers(shutdown: (reason: string) => Promise<void>): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    shutdown(signal)
      .catch((error: unknown) => console.error("[ghantika] error during shutdown:", error))
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.stdin.once("end", () => {
    shutdown("stdin EOF")
      .catch((error: unknown) => console.error("[ghantika] error during shutdown:", error))
      .finally(() => process.exit(0));
  });
}
