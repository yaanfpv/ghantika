/**
 * Standalone comparison servers for three negative controls covering the
 * modern-handshake support in `src/server.ts` - NOT ghantika's own
 * `dist/index.js`, and NOT a mutation of `src/server.ts`'s own text. Each
 * variant below is a genuinely minimal, independent `serveStdio`-based
 * server that deliberately OMITS exactly one of the three guarantees
 * `src/server.ts` preserves under `serveStdio` (the initialize-gate, the
 * `-32700` parse-error reply, and job-reap-on-shutdown), so the test file
 * that spawns it can observe what the ABSENCE of each guarantee actually
 * looks like on the real wire - proving the real ghantika assertions
 * elsewhere in this suite (which all pass against the real server) are
 * discriminating, not vacuous.
 *
 * Not a `*.test.ts` file, so `node --test`'s auto-discovery never tries to
 * run it as a suite - matches `test/helpers/hostileGroupKillProbe.ts`'s
 * own convention for a spawned comparison/probe process.
 *
 * Selected via `process.argv[2]`, one of:
 *   - "no-gate"       tools/call succeeds unconditionally, no handshake check at all
 *   - "no-parse-wrap" the SDK's own default StdioServerTransport, no raw-line wrapping
 *   - "no-reap"       spawns a real detached child on "spawn-orphan", SIGTERM never reaps it
 */
import { type ChildProcess, spawn as spawnChild } from "node:child_process";

import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";

const variant = process.argv[2];

function buildBareServer(): Server {
  // No initialize-gate: tools/call is registered with NO guard on whether
  // any handshake has happened at all - the exact absence
  // buildGhantikaServerCore()'s own gate exists to prevent.
  const server = new Server(
    { name: "negative-control", version: "0.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [{ name: "ping", description: "always succeeds", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler("tools/call", async (request) => {
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
  // `createStdioTransport()` in src/server.ts.
  const handle = serveStdio(() => buildBareServer(), {
    transport: new StdioServerTransport(),
    legacy: "serve",
  });
  process.once("SIGTERM", () => {
    handle.close().finally(() => process.exit(0));
  });
} else if (variant === "no-reap") {
  const handle = serveStdio(() => buildBareServer(), { legacy: "serve" });
  // Deliberately NO job tracking, NO reap - closes the connection and
  // exits, exactly what a shutdown path with zero orphan-proofing looks
  // like.
  process.once("SIGTERM", () => {
    handle.close().finally(() => process.exit(0));
  });
} else {
  process.stderr.write(`negative-control-server.ts: unknown variant "${String(variant)}"\n`);
  process.exit(1);
}
