/**
 * Real end-to-end coverage for ghantika serving the 2026-07-28 revision's
 * `server/discover` opening exchange over stdio, via
 * `@modelcontextprotocol/server/stdio`'s `serveStdio`, without regressing
 * the legacy `initialize` handshake, the initialize-gate security
 * control, the `-32700` parse-error reply, or shutdown's real job-reap -
 * all four of which `test/e2e-server.test.ts` and
 * `test/shutdown.test.ts` already re-prove unmodified against the real
 * `dist/index.js` process (now built on `serveStdio` - see
 * `src/server.ts`'s `runServer()`), since neither file's own tests were
 * touched by this change and every one of them still passes against the
 * real spawned server.
 *
 * This file covers what those two files structurally cannot: the modern
 * opening exchange itself (`server/discover` succeeding, the
 * probe-then-fallback per-instance-state proof), and three negative
 * controls - a genuinely independent, minimal comparison server
 * (`test/fixtures/negative-control-server.ts`) that OMITS exactly one of
 * the three guarantees `src/server.ts` preserves under `serveStdio`, so
 * this file can observe by real execution what the ABSENCE of each
 * guarantee looks like on the wire, proving the real assertions
 * elsewhere in this suite are discriminating rather than vacuous.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  type SpawnedServer,
  MODERN_PROTOCOL_VERSION,
  completeHandshake,
  discoverRequest,
  initializeRequest,
  initializedNotification,
  spawnServer,
  withModernEnvelope,
} from "./helpers/spawnServer.ts";
import { isProcessAlive } from "../dist/process.js";

const NEGATIVE_CONTROL_FIXTURE = fileURLToPath(
  new URL("./fixtures/negative-control-server.ts", import.meta.url)
);

const spawned: SpawnedServer[] = [];
function tracked(entry?: readonly string[]): SpawnedServer {
  const server = entry === undefined ? spawnServer() : spawnServer(entry);
  spawned.push(server);
  return server;
}

process.on("exit", () => {
  // Belt-and-braces cleanup, matching test/e2e-server.test.ts's own
  // `after()` hook - never leave a spawned server process behind after
  // this file's tests finish, whether it's the real ghantika binary or
  // one of the negative-control fixtures.
  for (const server of spawned) {
    if (!server.child.killed) server.child.kill("SIGKILL");
  }
});

interface DiscoverResultBody {
  readonly jsonrpc: string;
  readonly id: number;
  readonly result?: {
    supportedVersions?: string[];
    capabilities?: { tools?: unknown };
    resultType?: string;
  };
  readonly error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// server/discover succeeds and advertises the modern revision
// ---------------------------------------------------------------------------

test("server/discover over the real wire returns a successful result advertising the 2026-07-28 revision and the tools capability", async () => {
  const server = tracked();
  server.send(discoverRequest(1));
  const line = await server.nextLine();
  assert.equal(line.parseError, undefined, `expected valid JSON, got: ${line.parseError}`);
  const body = line.parsed as DiscoverResultBody;
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 1);
  assert.ok(
    body.error === undefined,
    `server/discover must succeed, got error: ${JSON.stringify(body.error)}`
  );
  assert.ok(body.result, "server/discover must return a result, not an error");
  assert.ok(
    body.result?.supportedVersions?.includes(MODERN_PROTOCOL_VERSION),
    `expected supportedVersions to include ${MODERN_PROTOCOL_VERSION}, got: ${JSON.stringify(body.result?.supportedVersions)}`
  );
  assert.ok(
    body.result?.capabilities?.tools,
    "server/discover must advertise the tools capability"
  );
  server.child.kill("SIGKILL");
});

test("regression check, modern side: the legacy initialize handshake is completely unaffected by a connection that never sends server/discover at all - reruns the exact legacy assertion e2e-server.test.ts already covers, here for direct side-by-side proof both eras are served by the SAME real binary", async () => {
  const server = tracked();
  const response = await completeHandshake(server);
  const body = response.parsed as {
    result?: { protocolVersion?: string; capabilities?: { tools?: unknown } };
  };
  assert.ok(body.result, "initialize must still return a result");
  assert.ok(body.result?.capabilities?.tools, "legacy initialize must still advertise tools");
  server.child.kill("SIGKILL");
});

// ---------------------------------------------------------------------------
// The initialize-gate survives under serveStdio - proven by real
// execution against the StdioConnectionChannel proxy, both for a legacy
// connection (the exact three-flag gate, re-targeted at the channel via
// this file's own `.connect` override) and for a modern one (the
// pre-connect trust-anchor shortcut).
// ---------------------------------------------------------------------------

test("legacy handshake, under serveStdio: tools/call sent before the initialize/initialized handshake completes is STILL rejected, proving the gate observers correctly chained onto serveStdio's own StdioConnectionChannel proxy rather than the raw wire transport", async () => {
  const server = tracked();
  server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["echo", "should-never-run"] } },
  });
  const line = await server.nextLine();
  const body = line.parsed as { error?: { code: number }; result?: unknown };
  assert.ok(body.error, "a pre-handshake tools/call must still be rejected under serveStdio");
  assert.equal(body.error?.code, -32600);
  assert.equal(
    body.result,
    undefined,
    "must not have been dispatched - no job may have been created"
  );
  server.child.kill("SIGKILL");
});

test("legacy handshake, under serveStdio: a real initialize + notifications/initialized still opens the gate normally - the observer chaining does not break the legitimate handshake either", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["true"] } },
  });
  const line = await server.nextLine();
  const body = line.parsed as { error?: unknown; result?: { isError?: boolean } };
  assert.equal(
    body.error,
    undefined,
    "a real completed legacy handshake must still let tools/call through under serveStdio"
  );
  assert.notEqual(body.result?.isError, true);
  server.child.kill("SIGKILL");
});

test("modern handshake: tools/call immediately after a successful server/discover succeeds - the modern era's own trust anchor (serveStdio's pre-connect setNegotiatedProtocolVersion) opens the gate with no initialize/initialized exchange, which this era has none of", async () => {
  const server = tracked();
  server.send(discoverRequest(1));
  const discoverLine = await server.nextLine();
  const discoverBody = discoverLine.parsed as DiscoverResultBody;
  assert.ok(discoverBody.result, "server/discover must succeed first");

  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: withModernEnvelope({ name: "run", arguments: { command: ["true"] } }),
  });
  const line = await server.nextLine();
  const body = line.parsed as {
    error?: unknown;
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
  };
  assert.equal(
    body.error,
    undefined,
    `modern tools/call right after discover must succeed, got: ${JSON.stringify(body)}`
  );
  assert.notEqual(body.result?.isError, true);
  assert.equal(typeof body.result?.structuredContent?.job_id, "string");
  server.child.kill("SIGKILL");
});

// ---------------------------------------------------------------------------
// PER-INSTANCE STATE across a probe-then-fallback discard. A client
// that opens with server/discover (pinning a "probe" instance) and then
// falls back to a plain legacy initialize causes serveStdio to discard
// the probe and build a brand-new instance from the SAME factory. The
// fallback instance's own gate closure state must be genuinely fresh -
// requiring its OWN full legacy handshake - never inheriting anything
// from the discarded probe's own (successful) discover exchange.
// ---------------------------------------------------------------------------

test("probe (server/discover) then fallback (initialize): the fallback instance's gate is genuinely fresh, requiring its OWN complete handshake, with no state leaking across the discard", async () => {
  const server = tracked();

  // 1) Probe: open with server/discover, get a real successful result -
  // this pins a "probe" instance (serveStdio's own terminology) from the
  // SAME ghantikaServerFactory() this file's src/server.ts hands it.
  server.send(discoverRequest(1));
  const discoverLine = await server.nextLine();
  const discoverBody = discoverLine.parsed as DiscoverResultBody;
  assert.ok(
    discoverBody.result?.supportedVersions?.includes(MODERN_PROTOCOL_VERSION),
    "the probe's own server/discover must succeed before the fallback below even begins"
  );

  // 2) Fall back: a plain legacy initialize (no modern envelope claim) -
  // serveStdio discards the probe instance and builds a genuinely NEW one
  // from the factory (buildGhantikaServerCore() runs again, producing
  // fresh closures).
  server.send(initializeRequest(2));
  const initLine = await server.nextLine();
  const initBody = initLine.parsed as {
    id: number;
    result?: { protocolVersion?: string };
    error?: unknown;
  };
  assert.equal(
    initBody.id,
    2,
    "the fallback initialize's own response must correlate to id 2, never a stray reply from the discarded probe"
  );
  assert.ok(
    initBody.result,
    `the fallback legacy negotiation must succeed on its own merits: ${JSON.stringify(initBody)}`
  );
  assert.equal(initBody.error, undefined);

  // 3) THE PER-INSTANCE PROOF: tools/call sent between the initialize
  // RESPONSE and notifications/initialized must still be REJECTED on this
  // fallback instance - exactly as a genuinely fresh connection's gate
  // would behave. If the discarded probe's own successful negotiation had
  // somehow leaked into this instance's closure state, this would
  // incorrectly succeed.
  server.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list", arguments: {} },
  });
  const preInitializedLine = await server.nextLine();
  const preInitializedBody = preInitializedLine.parsed as {
    id: number;
    error?: { code: number };
    result?: unknown;
  };
  assert.equal(preInitializedBody.id, 3);
  assert.ok(
    preInitializedBody.error,
    "the fallback instance's OWN gate must still require its OWN notifications/initialized - a leaked probe flag would let this through"
  );
  assert.equal(preInitializedBody.error?.code, -32600);
  assert.equal(preInitializedBody.result, undefined);

  // 4) Complete the fallback's own handshake, and confirm tools/call now
  // succeeds normally - the fallback instance is a fully functional,
  // independent connection, not a broken half-state left over from the
  // discard.
  server.send(initializedNotification());
  server.send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "list", arguments: {} },
  });
  const line = await server.nextLine();
  const body = line.parsed as { id: number; error?: unknown; result?: { isError?: boolean } };
  assert.equal(body.id, 4);
  assert.equal(
    body.error,
    undefined,
    "once the fallback's OWN handshake completes, tools/call must succeed normally"
  );
  assert.notEqual(body.result?.isError, true);

  server.child.kill("SIGKILL");
});

// ---------------------------------------------------------------------------
// Modern-context addition: the -32700 parse-error reply also survives
// when it arrives mid a MODERN connection - the plain legacy case
// (before/after a legacy handshake) is already fully covered, unmodified,
// by test/e2e-server.test.ts's own suite (now running against the real
// serveStdio-based binary and still green).
// ---------------------------------------------------------------------------

test("modern context: a malformed line arriving AFTER a successful server/discover still gets -32700, and the modern connection survives to serve the next request correctly", async () => {
  const server = tracked();
  server.send(discoverRequest(1));
  const discoverLine = await server.nextLine();
  assert.ok((discoverLine.parsed as DiscoverResultBody).result, "discover must succeed first");

  server.sendRaw("not json at all in the middle of a modern connection {{{\n");
  const parseErrorLine = await server.nextLine();
  const parseErrorBody = parseErrorLine.parsed as { id: unknown; error: { code: number } };
  assert.equal(parseErrorBody.id, null);
  assert.equal(parseErrorBody.error.code, -32700);

  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: withModernEnvelope({ name: "list", arguments: {} }),
  });
  const line = await server.nextLine();
  const body = line.parsed as { id: number; error?: unknown; result?: { isError?: boolean } };
  assert.equal(
    body.id,
    2,
    "the next real request after the malformed line must still be served correctly on the modern connection"
  );
  assert.equal(body.error, undefined);
  server.child.kill("SIGKILL");
});

// ---------------------------------------------------------------------------
// Three negative controls, each spawning a genuinely independent,
// minimal serveStdio-based comparison server
// (test/fixtures/negative-control-server.ts) that OMITS exactly one
// guarantee, proving by real execution that the real assertions above
// (and in test/e2e-server.test.ts / test/shutdown.test.ts) are
// discriminating - not vacuous passes that would stay green even if the
// real wiring were removed.
// ---------------------------------------------------------------------------

test("negative control (initialize-gate): a serveStdio server built with NO gate wiring at all lets tools/call succeed with ZERO handshake - proving the real pre-handshake-rejection assertions above are discriminating", async () => {
  const server = tracked([NEGATIVE_CONTROL_FIXTURE, "no-gate"]);
  server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "ping", arguments: {} },
  });
  const line = await server.nextLine();
  const body = line.parsed as { error?: unknown; result?: { content?: Array<{ text?: string }> } };
  assert.equal(
    body.error,
    undefined,
    "WITHOUT the gate, a pre-handshake tools/call succeeds outright - this IS the exact bypass the real gate exists to close"
  );
  assert.equal(body.result?.content?.[0]?.text, "pong");
  server.child.kill("SIGKILL");
});

test("negative control (parse-error reply): a serveStdio server using the SDK's stock, UNWRAPPED StdioServerTransport produces NO reply at all to an unparseable line - proving createStdioTransport's own wrapping is what produces the real -32700 the e2e tests observe", async () => {
  const server = tracked([NEGATIVE_CONTROL_FIXTURE, "no-parse-wrap"]);
  server.sendRaw("this is not valid json {{{\n");
  // The next thing written to stdout, if anything is ever written for the
  // malformed line at all, would be that -32700 reply. Send a real,
  // well-formed request right after and confirm the FIRST line observed
  // is ITS response - proving no reply for the malformed line ever
  // arrived, not merely that it arrived late.
  server.send({ jsonrpc: "2.0", id: 501, method: "totally/unknown/method" });
  const line = await server.nextLine();
  const body = line.parsed as { id: unknown; error?: { code: number } };
  assert.equal(
    body.id,
    501,
    "WITHOUT createStdioTransport's own wrapping, no -32700 reply is ever produced - the first (and only) line seen is the next real request's own response"
  );
  assert.equal(body.error?.code, -32601);
  server.child.kill("SIGKILL");
});

test(
  "negative control (shutdown job-reap): a serveStdio server with NO reap wiring at all leaves a real spawned child ALIVE after SIGTERM - proving ghantika's real reap logic (test/shutdown.test.ts) is what prevents that orphan",
  {
    skip:
      process.platform === "win32"
        ? "confirms via a real process.kill(pid, 0) existence probe; matches every other reap test's own skip"
        : false,
  },
  async () => {
    const server = tracked([NEGATIVE_CONTROL_FIXTURE, "no-reap"]);
    server.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "spawn-orphan", arguments: {} },
    });
    const line = await server.nextLine();
    const body = line.parsed as { result?: { structuredContent?: { pid?: number } } };
    const pid = body.result?.structuredContent?.pid;
    assert.equal(
      typeof pid,
      "number",
      `expected a real spawned child pid, got: ${JSON.stringify(body)}`
    );

    assert.equal(
      isProcessAlive(pid!),
      true,
      "the spawned child must be genuinely alive before shutdown"
    );

    server.child.kill("SIGTERM");
    await server.waitForExit();

    try {
      assert.equal(
        isProcessAlive(pid!),
        true,
        "WITHOUT reap wiring, the spawned child survives its own server's shutdown, orphaned - proving the real reap logic elsewhere is what prevents this"
      );
    } finally {
      // Real cleanup - this fixture never reaps it (that's the whole
      // point), so the test does it directly. Best-effort: an already-gone
      // pid throws ESRCH, never left uncaught here.
      try {
        process.kill(pid!, "SIGKILL");
      } catch {
        // already gone - nothing to do
      }
    }
  }
);
