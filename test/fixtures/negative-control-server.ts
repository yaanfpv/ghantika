/**
 * Standalone comparison servers for three negative controls covering the
 * modern-handshake support in `src/server.ts` - NOT ghantika's own
 * `dist/index.js`, and NOT a mutation of `src/server.ts`'s own text. Each
 * variant below is a genuinely minimal, independent `serveStdio`-based
 * server that removes exactly ONE of the three guarantees `src/server.ts`
 * preserves under `serveStdio` (the initialize-gate, the `-32700`
 * parse-error reply, and job-reap-on-shutdown) while keeping the other two
 * genuinely intact:
 *
 *   - `no-gate`       no gate, but a wrapped transport (parse recovery
 *                      intact) and reaps its own spawned orphan on SIGTERM
 *                      (reap intact).
 *   - `no-parse-wrap` the SDK's own stock, unwrapped StdioServerTransport
 *                      (no parse recovery), but the same real gate as
 *                      `no-reap` below, and reaps its own spawned orphan on
 *                      SIGTERM (reap intact).
 *   - `no-reap`       the same real gate and the same wrapped transport as
 *                      the other two's respective intact guarantees, but
 *                      deliberately never reaps its spawned orphan.
 *
 * so the test file that spawns each variant can observe what the ABSENCE
 * of each guarantee actually looks like on the real wire, with each red
 * result attributable to the one removed guarantee and the other two
 * guarantees independently checkable as still intact - showing the real
 * ghantika assertions elsewhere in this suite (which all pass against the
 * real server) each observe a real failure mode rather than one that would
 * pass regardless.
 *
 * Not a `*.test.ts` file, so `node --test`'s auto-discovery never tries to
 * run it as a suite - matches `test/helpers/hostileGroupKillProbe.ts`'s
 * own convention for a spawned comparison/probe process.
 *
 * Selected via `process.argv[2]`, one of: `no-gate`, `no-parse-wrap`,
 * `no-reap` (see the header list above for what each keeps and removes).
 */
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { Readable } from "node:stream";

import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  deserializeMessage,
} from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";

const variant = process.argv[2];

/** The last child spawned via the `spawn-orphan` tool call, tracked so each variant's own SIGTERM handler can decide whether to reap it. */
let spawnedChild: ChildProcess | undefined;

/**
 * Registers the tools/list and tools/call handlers this fixture's tests
 * exercise onto `server`, identically across every variant - the ONLY
 * difference between `buildBareServer()` and `buildGatedServer()` below is
 * `requireHandshake`, so no variant's tool behavior differs from another's
 * except by the ONE guarantee it is built to omit. `spawn-orphan` is
 * reachable from every variant (not only `no-reap`), so any variant's own
 * reap behavior is independently checkable regardless of which guarantee
 * it removes.
 *
 * `requireHandshake` is `undefined` for the "no-gate" variant (no check at
 * all - `tools/call` dispatches unconditionally) and a real predicate for
 * "no-parse-wrap"/"no-reap" (rejects `tools/call` with -32600 until it
 * returns true) - see `buildGatedServer()`'s own doc comment for why this
 * predicate now genuinely requires a completed initialize negotiation.
 */
function registerTools(server: Server, requireHandshake?: () => boolean): void {
  server.setRequestHandler("tools/list", async () => ({
    tools: [{ name: "ping", description: "always succeeds", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler("tools/call", async (request) => {
    if (requireHandshake !== undefined && !requireHandshake()) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        "tools/call rejected: the client has not completed the initialize/initialized handshake yet"
      );
    }
    if (request.params.name === "spawn-orphan") {
      // A real detached child, tracked at module scope so this variant's
      // own SIGTERM handler can decide whether to reap it. Mirrors the
      // shape of a real long-lived job (a `sleep` in its own session)
      // without any of ghantika's own jobStore/kill machinery.
      const child: ChildProcess = spawnChild("sleep", ["60"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      spawnedChild = child;
      return {
        content: [{ type: "text", text: String(child.pid) }],
        structuredContent: { pid: child.pid },
      };
    }
    return { content: [{ type: "text", text: "pong" }] };
  });
}

/**
 * The "no-gate" variant's server: NO initialize-gate wiring at all -
 * `tools/call` is dispatched unconditionally, regardless of whether any
 * handshake has happened - the exact absence `buildGatedServer()`'s own
 * gate below exists to prevent.
 */
function buildBareServer(): Server {
  const server = new Server(
    { name: "negative-control", version: "0.0.0" },
    { capabilities: { tools: {} } }
  );
  registerTools(server);
  return server;
}

/**
 * The "no-parse-wrap" and "no-reap" variants' shared server: a real
 * initialize-gate that requires BOTH a completed `initialize` negotiation
 * (a genuine request - `method === "initialize"` with a real `id` - whose
 * own outgoing response carries a `result`, never an `error`) AND the
 * `notifications/initialized` notification, so removing either variant's
 * OWN named guarantee (the parse-wrap, the reap wiring) never also removes
 * this one, keeping each variant's failure attributable to exactly one
 * cause.
 *
 * A bare `oninitialized` callback alone is NOT this gate: it fires purely
 * off RECEIVING the `notifications/initialized` notification and never
 * checks that a real `initialize` request/response preceded it, so a
 * client sending only that one notification - no `initialize` request at
 * all - would flip a bare `oninitialized` flag with no real negotiation
 * behind it. `attachGenuineInitializeGate()` below closes that by
 * observing the actual transport traffic for a genuine request id and its
 * own successful response, independently of `src/server.ts`'s own,
 * differently-scoped version of the same idea (that file additionally
 * handles a pre-negotiated modern connection and a stale-id clear on
 * failure, neither of which this fixture's own tests ever exercise).
 */
function buildGatedServer(): Server {
  const server = new Server(
    { name: "negative-control", version: "0.0.0" },
    { capabilities: { tools: {} } }
  );
  const isInitializedForToolCalls = attachGenuineInitializeGate(server);
  registerTools(server, isInitializedForToolCalls);
  return server;
}

/**
 * Wires `server` so its returned predicate is true only once a genuine
 * `initialize` request/response has succeeded AND
 * `notifications/initialized` has arrived - never off the notification
 * alone. Overrides `server.connect` (the same connect-time observer
 * pattern `src/server.ts`'s `buildGhantikaServerCore()` uses, written
 * fresh here rather than imported from it) so the observers attach to
 * whatever transport `serveStdio` actually calls `.connect()` with.
 */
function attachGenuineInitializeGate(server: Server): () => boolean {
  let pendingInitializeRequestId: string | number | undefined;
  let initializeNegotiationSucceeded = false;
  let receivedInitializedNotification = false;

  server.oninitialized = () => {
    receivedInitializedNotification = true;
  };

  const realConnect = server.connect.bind(server);
  server.connect = async (transport: Transport): Promise<void> => {
    const priorOnMessage = transport.onmessage;
    transport.onmessage = (message: JSONRPCMessage) => {
      const id = genuineInitializeRequestId(message);
      if (id !== undefined) pendingInitializeRequestId = id;
      priorOnMessage?.(message);
    };
    const originalSend = transport.send.bind(transport);
    transport.send = (message, options) => {
      if (
        pendingInitializeRequestId !== undefined &&
        initializeResponseSucceeded(message, pendingInitializeRequestId)
      ) {
        initializeNegotiationSucceeded = true;
      }
      return originalSend(message, options);
    };
    return realConnect(transport);
  };

  return () => initializeNegotiationSucceeded && receivedInitializedNotification;
}

/** Returns the `id` of `message` when it's a genuine `initialize` REQUEST (has `method === "initialize"` AND a real, present `id`), `undefined` otherwise - a same-named notification has no `id` and does not count. */
function genuineInitializeRequestId(message: JSONRPCMessage): string | number | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const candidate = message as { method?: unknown; id?: unknown };
  if (candidate.method !== "initialize") return undefined;
  if (typeof candidate.id !== "string" && typeof candidate.id !== "number") return undefined;
  return candidate.id;
}

/** True only when `message` is the outgoing SUCCESS response (carries `result`, never `error`) for the pending initialize request id - a matching id alone is not enough, since the SDK's own negotiation can itself reject an invalid initialize and reply with a real JSON-RPC error for that same id. */
function initializeResponseSucceeded(message: JSONRPCMessage, pendingId: string | number): boolean {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { id?: unknown; result?: unknown; error?: unknown };
  if (candidate.id !== pendingId) return false;
  return "result" in candidate && !("error" in candidate);
}

/**
 * A minimal, independent reimplementation of `src/server.ts`'s own
 * `createStdioTransport()` - written fresh here rather than imported from
 * it, per this file's own header. Classifies each raw stdin line via the
 * SDK's own exported `deserializeMessage` before it ever reaches the real
 * transport: a `SyntaxError` (unparseable JSON) gets `-32700`, any other
 * failure (valid JSON, invalid JSON-RPC envelope) gets `-32600`, and a
 * genuinely valid line is forwarded through unchanged. Confirmed directly
 * against the installed SDK: `serveStdio()` defaults an omitted
 * `transport` option to a stock, unwrapped `new StdioServerTransport()`
 * (`@modelcontextprotocol/server/dist/stdio.mjs:260-262`), which has no
 * such classification - passing this wrapped transport instead is what
 * gives `no-gate` and `no-reap` their own intact parse-recovery guarantee.
 */
function buildWrappedTransport(): StdioServerTransport {
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
        sendWrapErrorResponse(transport, -32700, "Parse error");
        continue;
      }
      if (classification === "invalid-envelope") {
        sendWrapErrorResponse(transport, -32600, "Invalid Request");
        continue;
      }
      virtualStdin.push(rawLine);
      virtualStdin.push("\n");
    }
  });
  process.stdin.on("end", () => virtualStdin.push(null));
  process.stdin.on("error", (error) => virtualStdin.destroy(error));

  return transport;
}

type StdinLineClassification = "ok" | "parse-error" | "invalid-envelope";

function classifyStdinLine(line: string): StdinLineClassification {
  try {
    deserializeMessage(line.replace(/\r$/, ""));
    return "ok";
  } catch (error) {
    return error instanceof SyntaxError ? "parse-error" : "invalid-envelope";
  }
}

function sendWrapErrorResponse(transport: Transport, code: number, message: string): void {
  const response = {
    jsonrpc: "2.0" as const,
    id: null,
    error: { code, message },
  } as unknown as JSONRPCMessage;
  transport.send(response).catch((sendError: unknown) => {
    process.stderr.write(
      `negative-control-server.ts: failed to send wrap error reply: ${String(sendError)}\n`
    );
  });
}

/** Kills `spawnedChild` if this variant tracked one - shared by the two variants (`no-gate`, `no-parse-wrap`) whose own reap guarantee stays intact; `no-reap` deliberately never calls this. */
function reapSpawnedChildIfAny(): void {
  if (spawnedChild !== undefined && !spawnedChild.killed) {
    try {
      spawnedChild.kill("SIGKILL");
    } catch {
      // already gone - nothing to do
    }
  }
}

if (variant === "no-gate") {
  const handle = serveStdio(() => buildBareServer(), {
    transport: buildWrappedTransport(),
    legacy: "serve",
  });
  process.once("SIGTERM", () => {
    reapSpawnedChildIfAny();
    handle.close().finally(() => process.exit(0));
  });
} else if (variant === "no-parse-wrap") {
  // The SDK's OWN default transport, completely unwrapped - no
  // raw-stdin-layer classification ahead of it at all, unlike
  // `buildWrappedTransport()` above. Everything else (the same real
  // initialize gate, the same reap-on-SIGTERM) is unchanged from
  // "no-reap" below, so this variant removes ONLY the parse-wrap.
  const handle = serveStdio(() => buildGatedServer(), {
    transport: new StdioServerTransport(),
    legacy: "serve",
  });
  process.once("SIGTERM", () => {
    reapSpawnedChildIfAny();
    handle.close().finally(() => process.exit(0));
  });
} else if (variant === "no-reap") {
  const handle = serveStdio(() => buildGatedServer(), {
    transport: buildWrappedTransport(),
    legacy: "serve",
  });
  // Deliberately NO reap call here - closes the connection and exits,
  // exactly what a shutdown path with zero orphan-proofing looks like.
  // The same real gate and the same wrapped transport as "no-parse-wrap"
  // above are unchanged, so this variant removes ONLY the reap wiring.
  process.once("SIGTERM", () => {
    handle.close().finally(() => process.exit(0));
  });
} else {
  process.stderr.write(`negative-control-server.ts: unknown variant "${String(variant)}"\n`);
  process.exit(1);
}
