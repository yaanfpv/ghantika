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
 * controls - a comparison server (`test/fixtures/negative-control-server.ts`)
 * built in three variants, each of which removes exactly one of the
 * three guarantees `src/server.ts` preserves under `serveStdio` while
 * keeping the other two intact (see that file's own doc comment for how),
 * so this file can observe by real execution what the ABSENCE of each
 * guarantee looks like on the wire, with each red result attributable to
 * the one removed guarantee and not to some other missing piece.
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
import { TASKS_CAPABILITY_DESCRIPTOR, TASKS_EXTENSION_URI } from "../dist/tasksAdapter.js";

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
    capabilities?: { tools?: unknown; extensions?: Record<string, unknown> };
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
  assert.deepStrictEqual(
    body.result?.capabilities?.extensions?.[TASKS_EXTENSION_URI],
    TASKS_CAPABILITY_DESCRIPTOR,
    `server/discover's real wire response must advertise the Tasks extension descriptor exactly as tasksAdapter constructs it, not merely a truthy or locally-imported stand-in - got: ${JSON.stringify(body.result?.capabilities?.extensions)}`
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
// The 2026-07-28 revision's OWN capability
// model - a client declares `io.modelcontextprotocol/tasks` in THIS
// request's own `_meta` envelope (never at a connection-level `initialize`,
// which this era has none of), and that declaration governs ONLY the
// request that carried it - see src/server.ts's own header doc ("Reading a
// request's own declared client capabilities") for why this is the correct
// per-era model, not a weaker guarantee than the legacy connection-level
// one. Both halves are proven on the SAME live connection, back to back,
// so neither result could be explained by connection-level caching: a
// capable request mints, and an immediately-following incapable request on
// the identical connection does not.
// ---------------------------------------------------------------------------

test("modern handshake: a tools/call whose OWN request envelope declares io.modelcontextprotocol/tasks mints a real Task result, matching the released spec's advertised shape", async () => {
  const server = tracked();
  server.send(discoverRequest(1));
  const discoverLine = await server.nextLine();
  const discoverBody = discoverLine.parsed as DiscoverResultBody;
  assert.ok(discoverBody.result, "server/discover must succeed first");

  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: withModernEnvelope(
      { name: "run", arguments: { command: ["true"] } },
      { extensions: { [TASKS_EXTENSION_URI]: {} } }
    ),
  });
  const line = await server.nextLine();
  const body = line.parsed as {
    error?: unknown;
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
  };
  assert.equal(
    body.error,
    undefined,
    `a modern tools/call declaring Tasks support must succeed, got: ${JSON.stringify(body)}`
  );
  assert.notEqual(body.result?.isError, true);
  const structured = body.result?.structuredContent;
  assert.equal(
    structured?.extension,
    TASKS_EXTENSION_URI,
    `expected a minted Task result carrying "extension": "${TASKS_EXTENSION_URI}", got: ${JSON.stringify(structured)}`
  );
  assert.equal(typeof structured?.taskId, "string", "a minted Task result must carry a taskId");
  assert.equal(typeof structured?.status, "string", "a minted Task result must carry a status");
  // "matching the released spec's advertised shape" - checked against what
  // THIS connection's own server/discover actually returned above, not a
  // locally-imported constant's truthiness: the descriptor this mint is
  // negotiated under must be the identical descriptor server/discover
  // advertised for this connection.
  assert.deepStrictEqual(
    discoverBody.result?.capabilities?.extensions?.[TASKS_EXTENSION_URI],
    TASKS_CAPABILITY_DESCRIPTOR,
    `the descriptor server/discover advertised on this connection must match the one this mint is negotiated under - got: ${JSON.stringify(discoverBody.result?.capabilities?.extensions)}`
  );
  server.child.kill("SIGKILL");
});

test("modern handshake: on the SAME connection, a tools/call whose OWN request envelope declares NO capabilities gets the plain poll floor, never a minted Task - proving the negotiation above is genuinely per-request, not cached at the connection level", async () => {
  const server = tracked();
  server.send(discoverRequest(1));
  const discoverLine = await server.nextLine();
  assert.ok(
    (discoverLine.parsed as DiscoverResultBody).result,
    "server/discover must succeed first"
  );

  // First request on this connection: capable.
  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: withModernEnvelope(
      { name: "run", arguments: { command: ["true"] } },
      { extensions: { [TASKS_EXTENSION_URI]: {} } }
    ),
  });
  const capableLine = await server.nextLine();
  const capableBody = capableLine.parsed as {
    result?: { structuredContent?: Record<string, unknown> };
  };
  assert.equal(
    capableBody.result?.structuredContent?.extension,
    TASKS_EXTENSION_URI,
    "setup: the first request must genuinely mint, or this test proves nothing about the second"
  );

  // Second request, same connection, no capability declared at all
  // (withModernEnvelope's own default: a present-but-empty declaration).
  server.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: withModernEnvelope({ name: "run", arguments: { command: ["true"] } }),
  });
  const incapableLine = await server.nextLine();
  const incapableBody = incapableLine.parsed as {
    error?: unknown;
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
  };
  assert.equal(incapableBody.error, undefined);
  assert.notEqual(incapableBody.result?.isError, true);
  const structured = incapableBody.result?.structuredContent;
  assert.equal(
    structured?.extension,
    undefined,
    `a request declaring no capabilities must never mint, even on a connection where an EARLIER request just did, got: ${JSON.stringify(structured)}`
  );
  assert.equal(typeof structured?.job_id, "string", "the plain poll floor must still be returned");
  server.child.kill("SIGKILL");
});

// ---------------------------------------------------------------------------
// The SDK-deprecated `capabilities.tasks` shape, on the MODERN era's OWN
// per-request envelope - `isConnectionTasksCapable` has never read that
// field on EITHER era, but the legacy proof (test/tasks.test.ts) only
// exercises the connection-level `getClientCapabilities()` read path;
// the modern era reads its capabilities from a different source entirely
// (this request's own `_meta` envelope, off the real wire, over
// `serveStdio` - see src/server.ts's own header doc on why the two eras
// use genuinely different accessors). A real-wire modern proof is needed
// because a shared boolean function proves nothing about a source it was
// never fed from.
// ---------------------------------------------------------------------------

test("modern handshake: a tools/call whose own request envelope declares ONLY the SDK-deprecated capabilities.tasks shape (never extensions/experimental) still gets the plain poll floor, not the extension - the modern era's own per-request envelope read, not the legacy connection-level one", async () => {
  const server = tracked();
  server.send(discoverRequest(1));
  const discoverLine = await server.nextLine();
  assert.ok(
    (discoverLine.parsed as DiscoverResultBody).result,
    "server/discover must succeed first"
  );

  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    // The SDK-deprecated shape, declared in THIS request's own modern
    // envelope: a bare `tasks` key, never `extensions` or `experimental`
    // - the two bags `isConnectionTasksCapable` actually reads.
    params: withModernEnvelope({ name: "run", arguments: { command: ["true"] } }, { tasks: {} }),
  });
  const line = await server.nextLine();
  const body = line.parsed as {
    error?: unknown;
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
  };
  assert.equal(
    body.error,
    undefined,
    `a modern tools/call declaring only the deprecated tasks shape must still succeed, got: ${JSON.stringify(body)}`
  );
  assert.notEqual(body.result?.isError, true);
  const structured = body.result?.structuredContent;
  assert.equal(
    structured?.extension,
    undefined,
    `a capabilities.tasks-only declaration must never mint a Task result on the modern era either, got: ${JSON.stringify(structured)}`
  );
  assert.equal(
    typeof structured?.job_id,
    "string",
    "the plain poll floor (a bare job_id) must still be returned"
  );
  server.child.kill("SIGKILL");
});

// ---------------------------------------------------------------------------
// Capability negotiation matches the finalized extension contract exactly,
// which designates `extensions` as the sole bag - on the REAL modern wire,
// not just the legacy InMemoryTransport/SDK Client path test/tasks.test.ts
// exercises (a shared boolean function proves nothing about a source it was
// never fed from - see this file's own header note on the deprecated-tasks-
// shape test above, same reasoning). A real modern stdio request declaring
// Tasks support only under `experimental` never mints a Task result.
// ---------------------------------------------------------------------------

test("modern handshake: a tools/call whose own request envelope declares Tasks support ONLY under the older experimental bag (never extensions) still gets the plain poll floor, not the extension", async () => {
  const server = tracked();
  server.send(discoverRequest(1));
  const discoverLine = await server.nextLine();
  assert.ok(
    (discoverLine.parsed as DiscoverResultBody).result,
    "server/discover must succeed first"
  );

  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: withModernEnvelope(
      { name: "run", arguments: { command: ["true"] } },
      { experimental: { [TASKS_EXTENSION_URI]: {} } }
    ),
  });
  const line = await server.nextLine();
  const body = line.parsed as {
    error?: unknown;
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
  };
  assert.equal(
    body.error,
    undefined,
    `a modern tools/call declaring Tasks support only under experimental must still succeed, got: ${JSON.stringify(body)}`
  );
  assert.notEqual(body.result?.isError, true);
  const structured = body.result?.structuredContent;
  assert.equal(
    structured?.extension,
    undefined,
    `an experimental-bag-only declaration must never mint a Task result on the real modern wire, got: ${JSON.stringify(structured)}`
  );
  assert.equal(
    typeof structured?.job_id,
    "string",
    "the plain poll floor (a bare job_id) must still be returned"
  );
  server.child.kill("SIGKILL");
});

// ---------------------------------------------------------------------------
// The six-tool mint rule, on the MODERN wire: run() mints, and
// status/output/tail/kill/list each stay plain - regardless of Tasks
// capability being declared on THEIR OWN request too. src/server.ts's
// own tools/call handler branches on `request.params.name === "run"`
// before any capability read even happens, so this is a structural
// guarantee independent of era - but test/tasks.test.ts's own six-tool
// mint rule proof exercises only the legacy (InMemoryTransport/SDK
// Client) wire. This is the real-stdio modern-wire counterpart, on the
// SAME connection where run() has just genuinely minted, so a capable
// connection is not itself sufficient to make any OTHER tool mint.
// ---------------------------------------------------------------------------

test("modern handshake: six-tool mint rule on the real wire - run() mints while status/output/tail/kill/list each stay plain, even with Tasks capability declared on their OWN request too, on the SAME connection where run() just minted", async () => {
  const server = tracked();
  server.send(discoverRequest(1));
  const discoverLine = await server.nextLine();
  assert.ok(
    (discoverLine.parsed as DiscoverResultBody).result,
    "server/discover must succeed first"
  );

  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: withModernEnvelope(
      { name: "run", arguments: { command: ["true"] } },
      { extensions: { [TASKS_EXTENSION_URI]: {} } }
    ),
  });
  const runLine = await server.nextLine();
  const runBody = runLine.parsed as {
    result?: { structuredContent?: Record<string, unknown> };
  };
  const runStructured = runBody.result?.structuredContent;
  assert.equal(
    runStructured?.extension,
    TASKS_EXTENSION_URI,
    `setup: run() must genuinely mint on this connection, or the rest of this test proves nothing - got: ${JSON.stringify(runStructured)}`
  );
  // The minted TaskResult carries the handle under `taskId`, never a
  // separate `job_id` field - see this file's own server/discover test,
  // which already proves the returned capabilities descriptor is minted
  // by tasksAdapter itself rather than a local stand-in, and
  // src/tasksAdapter.ts's "taskId == job_id, one handle namespace" doc:
  // `taskId` IS the jobStore job_id, exposed under the Task-shape's own
  // field name.
  const jobId = runStructured?.taskId;
  assert.equal(typeof jobId, "string", "setup: run() must return a real taskId to target below");

  const otherToolCalls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }> = [
    { name: "status", arguments: { job_id: jobId } },
    { name: "output", arguments: { job_id: jobId } },
    { name: "tail", arguments: { job_id: jobId } },
    { name: "kill", arguments: { job_id: jobId } },
    { name: "list", arguments: {} },
  ];

  let nextId = 3;
  for (const call of otherToolCalls) {
    const id = nextId;
    nextId += 1;
    server.send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: withModernEnvelope(
        { name: call.name, arguments: call.arguments },
        // Tasks capability declared on THIS request too - proving the
        // six-tool mint rule is a per-tool-name guarantee, not merely
        // "the earlier request in this test happened not to declare it."
        { extensions: { [TASKS_EXTENSION_URI]: {} } }
      ),
    });
    const line = await server.nextLine();
    const body = line.parsed as {
      id: number;
      error?: unknown;
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    assert.equal(body.id, id, `response id must match the request for "${call.name}"`);
    assert.equal(
      body.error,
      undefined,
      `"${call.name}" must succeed even declaring Tasks capability, got: ${JSON.stringify(body)}`
    );
    assert.notEqual(
      body.result?.isError,
      true,
      `"${call.name}" must not report a tool-level error`
    );
    const structured = body.result?.structuredContent;
    assert.equal(
      structured?.extension,
      undefined,
      `"${call.name}" must NEVER mint a Task result on the modern era, even with capability declared on its own request, got: ${JSON.stringify(structured)}`
    );
    assert.equal(
      structured?.taskId,
      undefined,
      `"${call.name}" must never carry a taskId field either, got: ${JSON.stringify(structured)}`
    );
  }
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
// Three negative controls, each spawning a serveStdio-based comparison
// server (test/fixtures/negative-control-server.ts) built to remove
// exactly one guarantee while keeping the other two intact (see that
// file's own doc comment) - proving by real execution that the real
// assertions above (and in test/e2e-server.test.ts / test/shutdown.test.ts)
// each observe a real failure mode, not a check that would stay green
// even if the real wiring were removed.
// ---------------------------------------------------------------------------

test(
  "negative control (initialize-gate): a serveStdio server built with NO gate wiring at all lets tools/call succeed with ZERO handshake - proving the real pre-handshake-rejection assertions above observe a real failure mode, not one that would pass regardless - and its own unrelated parse-recovery and reap guarantees stay intact",
  {
    skip:
      process.platform === "win32"
        ? "confirms reap via a real process.kill(pid, 0) existence probe; matches every other reap test's own skip"
        : false,
  },
  async () => {
    const server = tracked([NEGATIVE_CONTROL_FIXTURE, "no-gate"]);
    server.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    });
    const line = await server.nextLine();
    const body = line.parsed as {
      error?: unknown;
      result?: { content?: Array<{ text?: string }> };
    };
    assert.equal(
      body.error,
      undefined,
      "WITHOUT the gate, a pre-handshake tools/call succeeds outright - this IS the exact bypass the real gate exists to close"
    );
    assert.equal(body.result?.content?.[0]?.text, "pong");

    // Unrelated guarantee: this variant's own parse-recovery guarantee
    // (buildWrappedTransport) must stay intact even with the gate
    // removed, so the removal is attributable to the gate alone and not
    // to a side effect that also silences parse recovery.
    server.sendRaw("this is not valid json {{{\n");
    const parseErrorLine = await server.nextLine();
    const parseErrorBody = parseErrorLine.parsed as {
      id: unknown;
      error?: { code: number };
    };
    assert.equal(parseErrorBody.id, null);
    assert.equal(parseErrorBody.error?.code, -32700);

    server.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    });
    const afterParseErrorLine = await server.nextLine();
    const afterParseErrorBody = afterParseErrorLine.parsed as {
      id: number;
      error?: unknown;
      result?: { content?: Array<{ text?: string }> };
    };
    assert.equal(
      afterParseErrorBody.id,
      3,
      "the connection must still serve a real request after the malformed line"
    );
    assert.equal(afterParseErrorBody.error, undefined);
    assert.equal(afterParseErrorBody.result?.content?.[0]?.text, "pong");

    // Unrelated guarantee: this variant's own reap wiring must stay
    // intact even with the gate removed, so the removal is attributable
    // to the gate alone and not to a side effect that also silences reap.
    server.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "spawn-orphan", arguments: {} },
    });
    const spawnLine = await server.nextLine();
    const spawnBody = spawnLine.parsed as {
      result?: { structuredContent?: { pid?: number } };
    };
    const pid = spawnBody.result?.structuredContent?.pid;
    assert.equal(
      typeof pid,
      "number",
      `expected a real spawned child pid, got: ${JSON.stringify(spawnBody)}`
    );
    assert.equal(
      isProcessAlive(pid!),
      true,
      "the spawned child must be genuinely alive before shutdown"
    );

    server.child.kill("SIGTERM");
    await server.waitForExit();
    assert.equal(
      isProcessAlive(pid!),
      false,
      "this variant's own reap guarantee must still hold with the gate removed"
    );
  }
);

test(
  "negative control (parse-error reply): a serveStdio server using the SDK's stock, UNWRAPPED StdioServerTransport produces NO reply at all to an unparseable line - proving createStdioTransport's own wrapping is what produces the real -32700 the e2e tests observe - and its own unrelated initialize-gate and reap guarantees stay intact",
  {
    skip:
      process.platform === "win32"
        ? "confirms reap via a real process.kill(pid, 0) existence probe; matches every other reap test's own skip"
        : false,
  },
  async () => {
    const server = tracked([NEGATIVE_CONTROL_FIXTURE, "no-parse-wrap"]);

    // Unrelated guarantee, exercised first: this variant keeps the real
    // initialize gate, so a pre-handshake tools/call is still rejected,
    // and a real completed handshake still lets one through. The shipped
    // control's own parse-error assertion below proves nothing about the
    // gate on its own - this is what actually exercises it.
    server.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    });
    const preHandshakeLine = await server.nextLine();
    const preHandshakeBody = preHandshakeLine.parsed as {
      error?: { code: number };
      result?: unknown;
    };
    assert.ok(
      preHandshakeBody.error,
      "this variant's own gate must still reject a pre-handshake tools/call"
    );
    assert.equal(preHandshakeBody.error?.code, -32600);

    await completeHandshake(server);
    server.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    });
    const postHandshakeLine = await server.nextLine();
    const postHandshakeBody = postHandshakeLine.parsed as {
      error?: unknown;
      result?: { content?: Array<{ text?: string }> };
    };
    assert.equal(
      postHandshakeBody.error,
      undefined,
      "this variant's own gate must still open normally after a real completed handshake"
    );
    assert.equal(postHandshakeBody.result?.content?.[0]?.text, "pong");

    // The variant's OWN named removal: no createStdioTransport-style
    // wrapping, so an unparseable line gets no -32700 reply at all. Send
    // a real, well-formed request right after and confirm the FIRST line
    // observed is ITS response - proving no reply for the malformed line
    // ever arrived, not merely that it arrived late.
    server.sendRaw("this is not valid json {{{\n");
    server.send({
      jsonrpc: "2.0",
      id: 501,
      method: "totally/unknown/method",
      params: {},
    });
    const parseLine = await server.nextLine();
    const parseBody = parseLine.parsed as { id: unknown; error?: { code: number } };
    assert.equal(
      parseBody.id,
      501,
      "WITHOUT createStdioTransport's own wrapping, no -32700 reply is ever produced - the first (and only) line seen is the next real request's own response"
    );
    assert.equal(parseBody.error?.code, -32601);

    // Unrelated guarantee, exercised last (it terminates the process):
    // this variant's own reap wiring stays intact even with the
    // parse-wrap removed.
    server.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "spawn-orphan", arguments: {} },
    });
    const spawnLine = await server.nextLine();
    const spawnBody = spawnLine.parsed as {
      result?: { structuredContent?: { pid?: number } };
    };
    const pid = spawnBody.result?.structuredContent?.pid;
    assert.equal(
      typeof pid,
      "number",
      `expected a real spawned child pid, got: ${JSON.stringify(spawnBody)}`
    );
    assert.equal(
      isProcessAlive(pid!),
      true,
      "the spawned child must be genuinely alive before shutdown"
    );
    server.child.kill("SIGTERM");
    await server.waitForExit();
    assert.equal(
      isProcessAlive(pid!),
      false,
      "this variant's own reap guarantee must still hold with the parse-wrap removed"
    );
  }
);

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

    // Unrelated guarantee: this variant's own gate must still reject a
    // pre-handshake tools/call.
    server.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    });
    const preHandshakeLine = await server.nextLine();
    const preHandshakeBody = preHandshakeLine.parsed as {
      error?: { code: number };
      result?: unknown;
    };
    assert.ok(
      preHandshakeBody.error,
      "this variant's own gate must still reject a pre-handshake tools/call"
    );
    assert.equal(preHandshakeBody.error?.code, -32600);

    // Unrelated guarantee: a bare notifications/initialized with no
    // preceding genuine initialize request/response - the exact bypass
    // the gate exists to close - must still be rejected on this variant.
    server.send(initializedNotification());
    server.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    });
    const bareNotificationLine = await server.nextLine();
    const bareNotificationBody = bareNotificationLine.parsed as {
      error?: { code: number };
      result?: unknown;
    };
    assert.ok(
      bareNotificationBody.error,
      "a bare notifications/initialized with no preceding real initialize exchange must still be rejected"
    );
    assert.equal(bareNotificationBody.error?.code, -32600);

    // This variant keeps the initialize gate (see
    // test/fixtures/negative-control-server.ts's own doc comment) - a
    // real handshake now, as a real client would, so the ONLY thing
    // this test observes the absence of is the reap wiring.
    await completeHandshake(server, 3);
    server.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    });
    const postHandshakeLine = await server.nextLine();
    const postHandshakeBody = postHandshakeLine.parsed as {
      error?: unknown;
      result?: { content?: Array<{ text?: string }> };
    };
    assert.equal(
      postHandshakeBody.error,
      undefined,
      "this variant's own gate must still open normally after a real completed handshake"
    );
    assert.equal(postHandshakeBody.result?.content?.[0]?.text, "pong");

    // Unrelated guarantee: this variant's own parse-recovery guarantee
    // (buildWrappedTransport) must stay intact even with the reap
    // wiring removed.
    server.sendRaw("this is not valid json {{{\n");
    const parseErrorLine = await server.nextLine();
    const parseErrorBody = parseErrorLine.parsed as {
      id: unknown;
      error?: { code: number };
    };
    assert.equal(parseErrorBody.id, null);
    assert.equal(parseErrorBody.error?.code, -32700);

    server.send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    });
    const afterParseErrorLine = await server.nextLine();
    const afterParseErrorBody = afterParseErrorLine.parsed as {
      id: number;
      error?: unknown;
      result?: { content?: Array<{ text?: string }> };
    };
    assert.equal(
      afterParseErrorBody.id,
      5,
      "the connection must still serve a real request after the malformed line"
    );
    assert.equal(afterParseErrorBody.error, undefined);
    assert.equal(afterParseErrorBody.result?.content?.[0]?.text, "pong");

    server.send({
      jsonrpc: "2.0",
      id: 6,
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
