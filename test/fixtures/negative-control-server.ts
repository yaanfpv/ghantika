/**
 * Standalone comparison servers for three negative controls covering the
 * modern-handshake support in `src/server.ts` - NOT ghantika's own
 * `dist/index.js`, and NOT a mutation of `src/server.ts`'s own text. Each
 * variant below is a genuinely minimal, independent `serveStdio`-based
 * server that removes exactly ONE of the three guarantees `src/server.ts`
 * preserves under `serveStdio` (the initialize-gate, the `-32700`
 * parse-error reply, and job-reap-on-shutdown) - `no-parse-wrap` and
 * `no-reap` keep the initialize gate fully wired and remove only their
 * own named guarantee, so a failure observed under either variant is
 * attributable to that ONE removal and not to some other absent
 * guarantee - so the test file that spawns each variant can observe what
 * the ABSENCE of each guarantee actually looks like on the real wire -
 * each red result attributable to the one removed guarantee, showing the
 * real ghantika assertions elsewhere in this suite (which all pass
 * against the real server) each observe a real failure mode rather than
 * one that would pass regardless.
 *
 * Not a `*.test.ts` file, so `node --test`'s auto-discovery never tries to
 * run it as a suite - matches `test/helpers/hostileGroupKillProbe.ts`'s
 * own convention for a spawned comparison/probe process.
 *
 * Selected via `process.argv[2]`, one of:
 *   - "no-gate"       tools/call succeeds unconditionally, no handshake check at all
 *   - "no-parse-wrap" the SDK's own default StdioServerTransport (no raw-line
 *                      wrapping), but the SAME initialize gate as "no-reap" below -
 *                      only the parse-wrap guarantee is removed
 *   - "no-reap"       the SAME initialize gate as "no-parse-wrap" above, but
 *                      spawns a real detached child on "spawn-orphan" (after a
 *                      completed handshake, as a real client would) that
 *                      SIGTERM never reaps - only the reap guarantee is removed
 */
import { type ChildProcess, spawn as spawnChild } from "node:child_process";

import { ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";

const variant = process.argv[2];

/**
 * Registers the tools/list and tools/call handlers this fixture's tests
 * exercise onto `server`, identically across every variant - the ONLY
 * difference between `buildBareServer()` and `buildGatedServer()` below is
 * `requireHandshake`, so no variant's tool behavior differs from another's
 * except by the ONE guarantee it is built to omit.
 *
 * `requireHandshake` is `undefined` for the "no-gate" variant (no check at
 * all - `tools/call` dispatches unconditionally) and a real predicate for
 * "no-parse-wrap"/"no-reap" (rejects `tools/call` with -32600 until it
 * returns true) - see `buildGatedServer()`'s own doc comment for why a
 * simple `oninitialized`-backed flag is a sufficient, genuinely
 * functioning gate for what those two tests need.
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
    if (variant === "no-reap" && request.params.name === "spawn-orphan") {
      // A real detached child this fixture NEVER tracks or reaps anywhere
      // - the "no-reap" variant's whole point. Mirrors the shape of a real
      // long-lived job (a `sleep` in its own session) without any of
      // ghantika's own jobStore/kill machinery.
      const child: ChildProcess = spawnChild("sleep", ["60"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
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
 * The "no-parse-wrap" and "no-reap" variants' shared server: a REAL
 * initialize-gate that rejects `tools/call` until the client has
 * completed a genuine `initialize`/`notifications/initialized` exchange -
 * so removing either variant's OWN named guarantee (the parse-wrap, the
 * reap wiring) never also removes this one, keeping each variant's
 * failure attributable to exactly one cause.
 *
 * Deliberately simpler than `src/server.ts`'s own
 * `isInitializedForToolCalls` (which additionally proves the OUTGOING
 * initialize response itself carried a `result`, defending against a
 * client that skips a real `initialize` request and sends only a bare
 * `notifications/initialized`): neither test that spawns this variant
 * ever attempts that bypass, both drive one real, complete legacy
 * handshake before calling `tools/call`, so `oninitialized` alone - fired
 * only once the SDK has actually processed the incoming
 * `notifications/initialized` - is a sufficient, genuinely functioning
 * gate for what these two tests need.
 */
function buildGatedServer(): Server {
  const server = new Server(
    { name: "negative-control", version: "0.0.0" },
    { capabilities: { tools: {} } }
  );
  let handshakeCompleted = false;
  server.oninitialized = () => {
    handshakeCompleted = true;
  };
  registerTools(server, () => handshakeCompleted);
  return server;
}

if (variant === "no-gate") {
  const handle = serveStdio(() => buildBareServer(), { legacy: "serve" });
  process.once("SIGTERM", () => {
    handle.close().finally(() => process.exit(0));
  });
} else if (variant === "no-parse-wrap") {
  // The SDK's OWN default transport, completely unwrapped - no
  // raw-stdin-layer classification ahead of it at all, unlike
  // `createStdioTransport()` in src/server.ts. Everything else
  // (`buildGatedServer()`'s own initialize gate) is unchanged from
  // "no-reap" below, so this variant removes ONLY the parse-wrap.
  const handle = serveStdio(() => buildGatedServer(), {
    transport: new StdioServerTransport(),
    legacy: "serve",
  });
  process.once("SIGTERM", () => {
    handle.close().finally(() => process.exit(0));
  });
} else if (variant === "no-reap") {
  const handle = serveStdio(() => buildGatedServer(), { legacy: "serve" });
  // Deliberately NO job tracking, NO reap - closes the connection and
  // exits, exactly what a shutdown path with zero orphan-proofing looks
  // like. `buildGatedServer()`'s own initialize gate is unchanged from
  // "no-parse-wrap" above, so this variant removes ONLY the reap wiring.
  process.once("SIGTERM", () => {
    handle.close().finally(() => process.exit(0));
  });
} else {
  process.stderr.write(`negative-control-server.ts: unknown variant "${String(variant)}"\n`);
  process.exit(1);
}
