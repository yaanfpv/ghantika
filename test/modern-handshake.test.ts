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
 * probe-then-fallback per-instance-state proof), the three registered task
 * methods (`tasks/get`/`tasks/update`/`tasks/cancel`) exercised over real
 * JSON-RPC on both eras rather than only ever minting a handle -
 * previously untested, so the extension had only ever been proven to MINT,
 * never to RESOLVE. Driving that resolution over the real modern wire
 * surfaced a genuine, measured installed-SDK fact rather than confirming
 * the naive expectation: `tasks/get` and `tasks/cancel` are UNROUTABLE on
 * the 2026-07-28 era, full stop, because the installed SDK's own base
 * dispatch recognizes both as belonging to the deprecated 2025-11-25
 * vocabulary and refuses them before this codebase's own handler is ever
 * reached; `tasks/update`, which that vocabulary never defined, is
 * unaffected and reaches this codebase's own handler normally on both
 * eras. See the task-method tests below, and `src/server.ts`'s own doc
 * comment at its three `tasks/*` registrations, for the full grounding.
 * Also three negative controls - a comparison server
 * (`test/fixtures/negative-control-server.ts`) built in three variants,
 * each of which removes exactly one of the three guarantees `src/server.ts`
 * preserves under `serveStdio` while keeping the other two intact (see that
 * file's own doc comment for how), so this file can observe by real
 * execution what the ABSENCE of each guarantee looks like on the wire, with
 * each red result attributable to the one removed guarantee and not to some
 * other missing piece.
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

/**
 * Reads stdout lines via `server.nextLine()` until a genuine JSON-RPC
 * RESPONSE arrives - a real object carrying its own `id` field, per
 * JSON-RPC 2.0 - skipping over any NOTIFICATION (a `method` with no `id`
 * at all) seen along the way.
 *
 * Needed because this change adds `notifications/tasks` (see
 * `src/tasksAdapter.ts`'s own `startTaskStatusNotifier` docs): a
 * genuinely UNCONDITIONAL per-transition notification that now fires on
 * every Tasks-capable-minted task's own terminal transition, regardless
 * of whether the job ever produced any output at all. The pre-existing
 * output-delta wake could never interleave with a `["true"]`-style mint in
 * this file's own tests, since a job with zero output never fires it - but
 * `notifications/tasks` fires on ANY terminal transition, so a fast-exiting
 * command's own terminal notification can now land on the real wire in
 * between two otherwise-sequential request/response pairs a raw harness
 * reads one at a time. A test that mints a Tasks-capable task and then
 * chains several further requests against the SAME connection reads
 * through this helper rather than `server.nextLine()` directly; a test
 * that never mints on a capable connection, or reads only the mint's own
 * immediate response with nothing chained after, has no need for it.
 */
async function nextResponse(
  server: SpawnedServer
): Promise<{ id: unknown; result?: unknown; error?: unknown }> {
  for (;;) {
    const line = await server.nextLine();
    const parsed = line.parsed as { id?: unknown; method?: unknown } | undefined;
    if (parsed !== undefined && parsed !== null && "id" in parsed) {
      return parsed as { id: unknown; result?: unknown; error?: unknown };
    }
    // A notification (method present, no id at all) - not what this is
    // waiting for; keep reading.
  }
}

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

test("server/discover over the real wire returns a successful result advertising the 2026-07-28 revision and the tools capability", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
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

test("regression check, modern side: the legacy initialize handshake is completely unaffected by a connection that never sends server/discover at all - reruns the exact legacy assertion e2e-server.test.ts already covers, here for direct side-by-side proof both eras are served by the SAME real binary", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
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

test("legacy handshake, under serveStdio: tools/call sent before the initialize/initialized handshake completes is STILL rejected, proving the gate observers correctly chained onto serveStdio's own StdioConnectionChannel proxy rather than the raw wire transport", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
  server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["echo", "should-never-run"] } },
  });
  // A bare nextLine() is safe here under this file's own nextResponse doc
  // (see its header comment) - the call is rejected before ever reaching
  // run(), so no job is created and nothing can ever mint or terminate.
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

test("legacy handshake, under serveStdio: a real initialize + notifications/initialized still opens the gate normally - the observer chaining does not break the legitimate handshake either", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["true"] } },
  });
  // A bare nextLine() is safe here - completeHandshake() above declares no
  // capabilities at all (see initializeRequest's own fixed empty
  // capabilities:{}), so this legacy connection never achieves Tasks
  // capability, run() never mints, and startTaskStatusNotifier is never
  // registered for this job regardless of how it later terminates.
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

test("modern handshake: tools/call immediately after a successful server/discover succeeds - the modern era's own trust anchor (serveStdio's pre-connect setNegotiatedProtocolVersion) opens the gate with no initialize/initialized exchange, which this era has none of", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
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
  // A bare nextLine() is safe here - withModernEnvelope's own default
  // clientCapabilities is empty, so this request declares no Tasks
  // capability, never mints, and this is the only tools/call on the
  // connection - nothing to interleave with.
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

test("modern handshake: a tools/call whose OWN request envelope declares io.modelcontextprotocol/tasks mints a real Task result whose taskId is a real, present string, on the RAW wire shape - no structuredContent at all, resultType:'task' genuinely present (this raw stdio harness reads bytes directly, with no @modelcontextprotocol/client decode/strip involved, unlike test/tasks.test.ts's own InMemoryTransport-based proof, which has to build its own wire tap precisely because the SDK Client strips resultType before a caller ever sees it)", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
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
  // A bare nextLine() is safe here per this file's own nextResponse doc -
  // this reads the mint's OWN immediate response (the first and only
  // tools/call on this connection), and a request's response is always
  // written synchronously in its own handler, strictly before the async
  // process-exit that could ever trigger this job's own terminal
  // notification - there is no earlier job on this connection either.
  const line = await server.nextLine();
  const body = line.parsed as {
    error?: unknown;
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      taskId?: unknown;
      status?: unknown;
      createdAt?: unknown;
      lastUpdatedAt?: unknown;
      ttlMs?: unknown;
      resultType?: unknown;
      content?: unknown;
    };
  };
  assert.equal(
    body.error,
    undefined,
    `a modern tools/call declaring Tasks support must succeed, got: ${JSON.stringify(body)}`
  );
  assert.notEqual(body.result?.isError, true);
  // The released contract's own flat CreateTaskResult shape (Result & Task,
  // per SEP-2663) REPLACES the CallToolResult entirely rather than nesting
  // under structuredContent - see src/tasksAdapter.ts's own
  // maybeAugmentRunResult docs for the full grounding.
  assert.equal(
    body.result?.structuredContent,
    undefined,
    `a minted result must never carry structuredContent, got: ${JSON.stringify(body.result)}`
  );
  assert.equal(typeof body.result?.taskId, "string", "a minted Task result must carry a taskId");
  assert.equal(typeof body.result?.status, "string", "a minted Task result must carry a status");
  assert.equal(typeof body.result?.createdAt, "string");
  assert.equal(typeof body.result?.lastUpdatedAt, "string");
  assert.equal(
    body.result?.resultType,
    "task",
    `expected the wire-level resultType discriminator to be "task" (genuinely observable on this raw-bytes harness), got: ${JSON.stringify(body.result)}`
  );
  // The ONE disclosed SDK wire artifact this installed
  // @modelcontextprotocol/server@2.0.0 version injects onto any
  // content-less tools/call result (see src/tasksAdapter.ts's own docs) -
  // bounded exactly, never silently tolerated as "content might be there."
  assert.deepEqual(
    body.result?.content,
    [],
    `expected the disclosed content:[] SDK artifact and nothing else beyond it, got: ${JSON.stringify(body.result?.content)}`
  );
  // Capability negotiation is still confirmed self-consistent: the same
  // TASKS_CAPABILITY_DESCRIPTOR constant this adapter advertised at
  // server/discover is what governs this connection's own mint decision.
  assert.deepStrictEqual(
    discoverBody.result?.capabilities?.extensions?.[TASKS_EXTENSION_URI],
    TASKS_CAPABILITY_DESCRIPTOR,
    `the descriptor server/discover advertised on this connection must match the one this mint is negotiated under - got: ${JSON.stringify(discoverBody.result?.capabilities?.extensions)}`
  );
  server.child.kill("SIGKILL");
});

test("modern handshake: on the SAME connection, a tools/call whose OWN request envelope declares NO capabilities gets the plain poll floor, never a minted Task - proving the negotiation above is genuinely per-request, not cached at the connection level", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
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
    result?: { taskId?: unknown; resultType?: unknown; structuredContent?: unknown };
  };
  // A mint carries no structuredContent at all on the released contract -
  // see this file's own "mints a real Task result" test above for the full
  // grounding - so the setup proof reads the TOP-LEVEL taskId/resultType.
  assert.equal(
    typeof capableBody.result?.taskId,
    "string",
    "setup: the first request must genuinely mint a real taskId, or this test proves nothing about the second"
  );
  assert.equal(
    capableBody.result?.resultType,
    "task",
    "setup: the first request's raw wire result must carry resultType:'task'"
  );

  // Second request, same connection, no capability declared at all
  // (withModernEnvelope's own default: a present-but-empty declaration).
  server.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: withModernEnvelope({ name: "run", arguments: { command: ["true"] } }),
  });
  // Reads through nextResponse (never server.nextLine() directly) - the
  // mint above used `command: ["true"]`, a real backing process that exits
  // almost immediately, so its own `notifications/tasks` terminal
  // notification (see startTaskStatusNotifier's own docs) can land on this
  // wire in between the mint's response and this second request's own
  // response; nextResponse skips exactly that, and only that - the same
  // hazard this file's "run-only mint rule" test documents and guards
  // against on its own chained reads.
  const incapableBody = (await nextResponse(server)) as {
    error?: unknown;
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
  };
  assert.equal(incapableBody.error, undefined);
  assert.notEqual(incapableBody.result?.isError, true);
  // A NON-minted response still nests under structuredContent (unchanged -
  // only a genuine mint replaces the CallToolResult shape entirely). Every
  // tools/call result, minted or not, carries SOME resultType on the raw
  // wire (the SDK's own encode contract stamps "complete" when a handler
  // supplies none - see src/tasksAdapter.ts's own maybeAugmentRunResult
  // docs) - so the discriminating fact is that it is never "task", not
  // that the field is absent.
  assert.notEqual(
    (incapableBody.result as { resultType?: unknown } | undefined)?.resultType,
    "task",
    "a plain (non-minted) result must never carry the wire-level resultType:'task' discriminator"
  );
  const structured = incapableBody.result?.structuredContent;
  assert.equal(
    structured?.taskId,
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

test("modern handshake: a tools/call whose own request envelope declares ONLY the SDK-deprecated capabilities.tasks shape (never extensions/experimental) still gets the plain poll floor, not the extension - the modern era's own per-request envelope read, not the legacy connection-level one", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
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
  // A bare nextLine() is safe here - the deprecated `tasks` bag is never
  // read as a capability signal (see the comment above), so this request
  // never mints and no notifications/tasks push is ever registered for it.
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
    structured?.taskId,
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

test("modern handshake: a tools/call whose own request envelope declares Tasks support ONLY under the older experimental bag (never extensions) still gets the plain poll floor, not the extension", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
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
  // A bare nextLine() is safe here - the `experimental` bag is never read
  // as a capability signal either (only `extensions` is), so this request
  // never mints and no notifications/tasks push is ever registered for it.
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
    structured?.taskId,
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
// The seven-tool mint rule, on the MODERN wire: run() mints, and
// status/output/tail/kill/list/follow each stay plain - regardless of
// Tasks capability being declared on THEIR OWN request too. src/server.ts's
// own tools/call handler branches on `request.params.name === "run"`
// before any capability read even happens, so this is a structural
// guarantee independent of era - but test/tasks.test.ts's own seven-tool
// mint rule proof exercises only the legacy (InMemoryTransport/SDK
// Client) wire. This is the real-stdio modern-wire counterpart, on the
// SAME connection where run() has just genuinely minted, so a capable
// connection is not itself sufficient to make any OTHER tool mint.
// ---------------------------------------------------------------------------

test("modern handshake: seven-tool mint rule on the real wire - run() mints while status/output/tail/kill/list/follow each stay plain, even with Tasks capability declared on their OWN request too, on the SAME connection where run() just minted", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
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
  // A bare nextLine() is safe here (see this file's own nextResponse doc)
  // - this is the mint's OWN immediate response, the first tools/call on
  // this connection, so nothing could have interleaved before it.
  const runLine = await server.nextLine();
  const runBody = runLine.parsed as {
    result?: { taskId?: unknown; resultType?: unknown; structuredContent?: unknown };
  };
  // A mint carries no structuredContent at all on the released contract -
  // see this file's own "mints a real Task result" test for the full
  // grounding - so the setup proof reads the TOP-LEVEL taskId/resultType.
  assert.equal(
    runBody.result?.resultType,
    "task",
    `setup: run() must genuinely mint on this connection, or the rest of this test proves nothing - got: ${JSON.stringify(runBody.result)}`
  );
  // The minted TaskResult carries the handle under `taskId`, never a
  // separate `job_id` field - see this file's own server/discover test,
  // which already proves the returned capabilities descriptor is minted
  // by tasksAdapter itself rather than a local stand-in, and
  // src/tasksAdapter.ts's "taskId == job_id, one handle namespace" doc:
  // `taskId` IS the jobStore job_id, exposed under the Task-shape's own
  // field name.
  const jobId = runBody.result?.taskId;
  assert.equal(typeof jobId, "string", "setup: run() must return a real taskId to target below");

  const otherToolCalls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }> = [
    { name: "status", arguments: { job_id: jobId } },
    { name: "output", arguments: { job_id: jobId } },
    { name: "tail", arguments: { job_id: jobId } },
    { name: "kill", arguments: { job_id: jobId } },
    { name: "list", arguments: {} },
    // By this point the job (a bare `true`, exiting near-instantly) has
    // long since gone terminal - the earlier status/output/tail/kill/list
    // round trips already guarantee that - so this resolves through
    // follow's own immediate-return path. The bounded timeout_ms is a
    // safety margin only, never something this test relies on hitting.
    { name: "follow", arguments: { job_id: jobId, timeout_ms: 2000 } },
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
        // seven-tool mint rule is a per-tool-name guarantee, not merely
        // "the earlier request in this test happened not to declare it."
        { extensions: { [TASKS_EXTENSION_URI]: {} } }
      ),
    });
    // Reads through nextResponse (never server.nextLine() directly) - the
    // mint above used `command: ["true"]`, a real backing process that
    // exits almost immediately, so its own `notifications/tasks` terminal
    // notification (see startTaskStatusNotifier's own docs) can land on
    // this wire in between two of these sequential requests at any point
    // from here on; nextResponse skips exactly that, and only that.
    const body = (await nextResponse(server)) as {
      id: number;
      error?: unknown;
      result?: {
        isError?: boolean;
        resultType?: unknown;
        structuredContent?: Record<string, unknown>;
      };
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
    assert.notEqual(
      body.result?.resultType,
      "task",
      `"${call.name}" must NEVER carry the wire-level resultType:'task' discriminator, even with capability declared on its own request, got: ${JSON.stringify(body.result)}`
    );
    const structured = body.result?.structuredContent;
    assert.equal(
      structured?.taskId,
      undefined,
      `"${call.name}" must never carry a taskId field either, got: ${JSON.stringify(structured)}`
    );
  }
  server.child.kill("SIGKILL");
});

// ---------------------------------------------------------------------------
// The three registered task methods (tasks/get, tasks/update, tasks/cancel)
// on the real modern wire - previously exercised only by MINTING a handle
// (the test above, and every legacy-era test in test/tasks.test.ts /
// test/tasks-lifecycle.test.ts), never by RESOLVING one over this era's own
// raw JSON-RPC. Also settles the second of the two capability paths this
// codebase has, on the real wire rather than by reading source alone -
// `tools/call`'s own `run` branch reads a per-request Tasks-capability
// declaration before minting (the run-only-mint-rule test above, and
// test/tasks.test.ts's legacy-era proof); src/server.ts registers
// tasks/get, tasks/update, and tasks/cancel with NO such check at all
// (confirmed directly by reading server.ts's own `server.setRequestHandler`
// calls for the three, which take only a params schema, never a capability
// read) - BUT driving that claim over the real modern wire surfaces a
// SEPARATE, more fundamental fact this AC's own premise did not anticipate:
// `tasks/get` and `tasks/cancel` are UNROUTABLE on the 2026-07-28 era
// through this connection's own request dispatch, regardless of
// capability, because the installed SDK's own base `Protocol` class
// recognizes both as belonging to the deprecated 2025-11-25 vocabulary and
// refuses them with -32601 "Method not found" BEFORE this codebase's own
// registered handler is ever consulted (see server.ts's own doc comment at
// its three `tasks/*` registrations for the full grounding, including the
// exact installed-SDK mechanism). `tasks/update` has no legacy-era
// precedent at all, so it is recognized as a spec method by NEITHER era's
// codec, is never caught by that guard, and reaches this codebase's own
// handler normally on both eras - which is what actually lets this test
// demonstrate capability-independence in execution, on the real modern
// wire, for the one method the wire itself does not block. `tasks/get`'s
// and `tasks/cancel`'s own capability-independence is demonstrated on the
// legacy era instead (below), and by the in-process suites this AC's own
// premise cited (test/tasks.test.ts, test/tasks-lifecycle.test.ts), which
// exercise both fully.
// ---------------------------------------------------------------------------

test("modern wire: tasks/get and tasks/cancel are UNROUTABLE on the 2026-07-28 era - a real, measured installed-SDK dispatch fact (the base Protocol class's own era-registry check), never a Tasks-capability gate this codebase applies, proven by the SAME outcome with and without capability declared", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
  server.send(discoverRequest(1));
  const discoverLine = await server.nextLine();
  assert.ok((discoverLine.parsed as DiscoverResultBody).result, "discover must succeed first");

  // Mint a real task first - WITH capability declared, since minting
  // itself IS gated (see the run-only-mint-rule test above). A real taskId
  // must exist for the calls below to target, even though - as this test
  // itself proves - that target is never reached for two of the three
  // methods on this era.
  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: withModernEnvelope(
      { name: "run", arguments: { command: ["true"], label: "modernwire-unroutable-methods" } },
      { extensions: { [TASKS_EXTENSION_URI]: {} } }
    ),
  });
  // A bare nextLine() is safe here - the mint's OWN immediate response,
  // the first tools/call on this connection; the loop below reads through
  // nextResponse() precisely because it is exposed and this read is not.
  const runLine = await server.nextLine();
  const runBody = runLine.parsed as { result?: { taskId?: unknown; resultType?: unknown } };
  assert.equal(
    runBody.result?.resultType,
    "task",
    `setup: run() must genuinely mint on this connection, or this test proves nothing - got: ${JSON.stringify(runBody.result)}`
  );
  const taskId = runBody.result?.taskId;
  assert.equal(typeof taskId, "string", "setup: run() must return a real taskId to target below");

  // Both WITH and WITHOUT Tasks capability declared on the request itself -
  // the identical -32601 outcome either way is exactly what proves this is
  // a method-routing fact of the installed SDK's own dispatch, never a
  // capability gate this codebase applies.
  const capabilityVariants: ReadonlyArray<Record<string, unknown>> = [
    { extensions: { [TASKS_EXTENSION_URI]: {} } },
    {},
  ];
  let nextId = 3;
  for (const method of ["tasks/get", "tasks/cancel"]) {
    for (const clientCapabilities of capabilityVariants) {
      const id = nextId;
      nextId += 1;
      server.send({
        jsonrpc: "2.0",
        id,
        method,
        params: withModernEnvelope({ taskId }, clientCapabilities),
      });
      // nextResponse, not server.nextLine() directly - see that helper's
      // own docs: the mint above (`command: ["true"]`) exits almost
      // immediately, so its own notifications/tasks terminal notification
      // can land on this wire at any point from here on.
      const body = (await nextResponse(server)) as {
        id: number;
        error?: { code?: number; message?: string };
        result?: unknown;
      };
      assert.equal(body.id, id);
      assert.equal(
        body.error?.code,
        -32601,
        `expected "${method}" on the modern era to fail with -32601 Method Not Found (capability=${JSON.stringify(clientCapabilities)}), got: ${JSON.stringify(body)}`
      );
      assert.equal(body.error?.message, "Method not found");
      assert.equal(body.result, undefined);
    }
  }

  server.child.kill("SIGKILL");
});

test("modern wire: tasks/update - the one task method the legacy vocabulary never defined - reaches this codebase's own handler normally on the modern era, and succeeds with NO Tasks capability declared on its own request, proving the second capability path is genuinely gate-free for the one method the wire itself does not block", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
  server.send(discoverRequest(1));
  const discoverLine = await server.nextLine();
  assert.ok((discoverLine.parsed as DiscoverResultBody).result, "discover must succeed first");

  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: withModernEnvelope(
      { name: "run", arguments: { command: ["true"], label: "modernwire-tasks-update" } },
      { extensions: { [TASKS_EXTENSION_URI]: {} } }
    ),
  });
  // A bare nextLine() is safe here - the mint's OWN immediate response,
  // the first tools/call on this connection; the tasks/update read below
  // goes through nextResponse() precisely because it is exposed and this
  // read is not.
  const runLine = await server.nextLine();
  const runBody = runLine.parsed as { result?: { taskId?: unknown; resultType?: unknown } };
  assert.equal(
    runBody.result?.resultType,
    "task",
    `setup: run() must genuinely mint on this connection, or this test proves nothing - got: ${JSON.stringify(runBody.result)}`
  );
  const taskId = runBody.result?.taskId;
  assert.equal(typeof taskId, "string", "setup: run() must return a real taskId to target below");

  // NO Tasks capability declared on THIS request (withModernEnvelope's own
  // default: a present-but-empty clientCapabilities declaration).
  // `inputResponses` omitted entirely too - the overwhelmingly common real
  // case, per taskUpdateParamsSchema's own docs, since no ghantika task
  // ever reaches `input_required`.
  server.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tasks/update",
    params: withModernEnvelope({ taskId }),
  });
  // nextResponse, not server.nextLine() directly - see that helper's own
  // docs: the mint above (`command: ["true"]`) exits almost immediately,
  // so its own notifications/tasks terminal notification could land on
  // this wire before this response does.
  const updateBody = (await nextResponse(server)) as {
    error?: unknown;
    result?: Record<string, unknown>;
  };
  assert.equal(
    updateBody.error,
    undefined,
    `tasks/update must succeed with no Tasks capability declared on its own request, got: ${JSON.stringify(updateBody)}`
  );
  // The real, RAW modern-era wire response - unlike test/tasks.test.ts's
  // InMemoryTransport-based proofs, this harness reads bytes directly with
  // no @modelcontextprotocol/client decode/strip involved (see this file's
  // own mint test's docs for the same distinction) - carries one field
  // this codebase's own adapter never constructs: the modern era's own
  // `_meta.io.modelcontextprotocol/serverInfo` envelope decoration, added
  // by the installed SDK's own outbound encode step to every response on
  // this era, unconditionally. `tasksAdapter.ACK_RESULT` itself is still
  // exactly `{resultType: "complete"}` (see that constant's own docs) -
  // asserted directly below - so this is checked as a disclosed, bounded
  // SDK-era wire artifact, never folded silently into a looser comparison.
  assert.equal(updateBody.result?.resultType, "complete");
  assert.deepEqual(
    Object.keys(updateBody.result ?? {}).sort(),
    ["_meta", "resultType"],
    `expected tasks/update's real modern-era wire result to carry only resultType plus the SDK's own injected _meta, got: ${JSON.stringify(updateBody.result)}`
  );
  assert.deepEqual(
    updateBody.result?._meta,
    { "io.modelcontextprotocol/serverInfo": { name: "ghantika", version: "0.1.0" } },
    `expected the SDK's own injected _meta to carry exactly the server's own identity, got: ${JSON.stringify(updateBody.result?._meta)}`
  );

  server.child.kill("SIGKILL");
});

test("legacy wire: tasks/get, tasks/update, and tasks/cancel all succeed with NO Tasks capability declared on their own connection - the legacy era's own capability model is connection-level (see resolveRunClientCapabilities's own docs), and the three task methods are unaffected by it either way since none of them reads capability at all; also confirms the real kill-and-reap effect on a still-running task, and closes the AC's own dual-capability-path premise for tasks/get and tasks/cancel where the modern wire itself cannot", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
  await completeHandshake(server); // a plain legacy handshake, declaring no capabilities at all

  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "run",
      arguments: {
        command: [process.execPath, "-e", "setTimeout(() => {}, 600000);"],
        label: "legacywire-task-methods",
      },
    },
  });
  // Every bare nextLine() in this test - this one and the tasks/get,
  // tasks/update, tasks/cancel, and polling-loop reads below - is safe:
  // this connection never declares Tasks capability (see
  // completeHandshake's own fixed empty capabilities:{}), so run() never
  // mints and startTaskStatusNotifier is never registered for this job,
  // however long it runs or however it is later cancelled.
  const runLine = await server.nextLine();
  const runBody = runLine.parsed as { result?: { structuredContent?: { job_id?: unknown } } };
  const taskId = runBody.result?.structuredContent?.job_id;
  assert.equal(
    typeof taskId,
    "string",
    `setup: a legacy-era, no-capability run() must still mint a real job_id to target below - got: ${JSON.stringify(runBody.result)}`
  );

  server.send({ jsonrpc: "2.0", id: 3, method: "tasks/get", params: { taskId } });
  const getLine = await server.nextLine();
  const getBody = getLine.parsed as {
    error?: unknown;
    result?: { taskId?: unknown; status?: unknown; resultType?: unknown };
  };
  assert.equal(
    getBody.error,
    undefined,
    `tasks/get must succeed on the legacy era with no Tasks capability ever declared on this connection, got: ${JSON.stringify(getBody)}`
  );
  assert.equal(getBody.result?.taskId, taskId);
  assert.equal(
    getBody.result?.status,
    "working",
    "expected the idle backing job to still be working"
  );
  assert.equal(getBody.result?.resultType, "complete");

  server.send({ jsonrpc: "2.0", id: 4, method: "tasks/update", params: { taskId } });
  const updateLine = await server.nextLine();
  const updateBody = updateLine.parsed as { error?: unknown; result?: Record<string, unknown> };
  assert.equal(updateBody.error, undefined);
  assert.deepEqual(updateBody.result, { resultType: "complete" });

  server.send({ jsonrpc: "2.0", id: 5, method: "tasks/cancel", params: { taskId } });
  const cancelLine = await server.nextLine();
  const cancelBody = cancelLine.parsed as { error?: unknown; result?: Record<string, unknown> };
  assert.equal(
    cancelBody.error,
    undefined,
    `tasks/cancel must succeed on the legacy era with no Tasks capability ever declared, got: ${JSON.stringify(cancelBody)}`
  );
  assert.deepEqual(
    cancelBody.result,
    { resultType: "complete" },
    "tasks/cancel must return exactly the fixed empty acknowledgement, matching tasks/update's own ack"
  );

  let finalStatus: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    server.send({ jsonrpc: "2.0", id: 6 + attempt, method: "tasks/get", params: { taskId } });
    const pollLine = await server.nextLine();
    const pollBody = pollLine.parsed as { result?: { status?: unknown } };
    finalStatus = pollBody.result?.status;
    if (finalStatus !== "working") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    finalStatus,
    "cancelled",
    `expected tasks/cancel to actually terminate the job, got final status ${JSON.stringify(finalStatus)}`
  );

  server.child.kill("SIGKILL");
});

test("an unknown taskId on tasks/get, tasks/update, and tasks/cancel each fail closed with -32602 on the legacy era, matching the released spec's shared error code for both an unknown and an expired-and-purged id (the modern era cannot exercise tasks/get/tasks/cancel at all - see the unroutable-methods test above - so this is legacy-only, deliberately, rather than parameterized across both eras)", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
  await completeHandshake(server);
  const bogusTaskId = "00000000-0000-0000-0000-000000000000";

  const cases: ReadonlyArray<{ method: string; id: number }> = [
    { method: "tasks/get", id: 2 },
    { method: "tasks/update", id: 3 },
    { method: "tasks/cancel", id: 4 },
  ];
  for (const { method, id } of cases) {
    server.send({ jsonrpc: "2.0", id, method, params: { taskId: bogusTaskId } });
    const line = await server.nextLine();
    const body = line.parsed as { id: number; error?: { code?: number }; result?: unknown };
    assert.equal(body.id, id);
    assert.equal(
      body.error?.code,
      -32602,
      `expected ${method} on an unknown taskId to fail with -32602, got: ${JSON.stringify(body)}`
    );
    assert.equal(body.result, undefined);
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

test("probe (server/discover) then fallback (initialize): the fallback instance's gate is genuinely fresh, requiring its OWN complete handshake, with no state leaking across the discard", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });

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

test("modern context: a malformed line arriving AFTER a successful server/discover still gets -32700, and the modern connection survives to serve the next request correctly", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for every path that never reaches this test's own
  // explicit server.child.kill() below (a thrown assertion, in particular -
  // exactly this gap once let one assertion failure
  // present as a 180-second whole-suite idle-watchdog hang instead of a
  // fast, named failure). A backstop only: server.child.killed is already
  // true by the time this runs on every normal green pass, since the
  // explicit kill below fires first in the test's own synchronous flow.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
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
  async (t) => {
    const server = tracked([NEGATIVE_CONTROL_FIXTURE, "no-gate"]);
    // Guaranteed backstop only - this test's own SIGTERM + waitForExit
    // sequence below IS the behaviour under test (the real reap effect),
    // so it keeps its explicit, deliberate kill; this only covers a path
    // that throws before ever reaching it.
    t.after(() => {
      if (!server.child.killed) server.child.kill("SIGKILL");
    });
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
  async (t) => {
    const server = tracked([NEGATIVE_CONTROL_FIXTURE, "no-parse-wrap"]);
    // Guaranteed backstop only - this test's own SIGTERM + waitForExit
    // sequence below IS the behaviour under test (the real reap effect),
    // so it keeps its explicit, deliberate kill; this only covers a path
    // that throws before ever reaching it.
    t.after(() => {
      if (!server.child.killed) server.child.kill("SIGKILL");
    });

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
  async (t) => {
    const server = tracked([NEGATIVE_CONTROL_FIXTURE, "no-reap"]);
    // Guaranteed backstop only - this test's own SIGTERM + waitForExit
    // sequence below IS the behaviour under test (the real reap effect),
    // so it keeps its explicit, deliberate kill; this only covers a path
    // that throws before ever reaching it.
    t.after(() => {
      if (!server.child.killed) server.child.kill("SIGKILL");
    });

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

// ---------------------------------------------------------------------------
// Wake-target metadata hand-off - `threadId` is handler material, never
// envelope material (see `src/server.ts`'s own doc comment at its
// `resolveWakeTarget` call site). `withModernEnvelope` above cannot
// express a request carrying both a reserved envelope key and the
// non-reserved `threadId` together (it replaces `_meta` wholesale with
// just the two reserved keys), so these two tests build the request's
// `_meta` by hand instead. Both drive a short job to a real terminal
// transition and read the resulting diagnostic off the real spawned
// process's own stderr.
// ---------------------------------------------------------------------------

/**
 * Polls `server.stderrText()` for `substring` up to `attempts * 100`ms.
 * The malformed-threadId diagnostic below is written synchronously inside
 * `fireJobTerminal`'s own dispatch (before any `selectAndWake` promise even
 * exists), but the resolved-threadId diagnostic is written from inside an
 * un-awaited `.then()/.catch()` continuation - genuinely asynchronous
 * relative to the terminal transition - so both cases share this one
 * bounded poll rather than assuming synchronous delivery for one and
 * inventing a second synchronization strategy for the other.
 *
 * The 15s ceiling (150 * 100ms) is generous headroom for the resolved case
 * specifically: `AppServerGoalWakeTransport.probe()` spawns a real,
 * throwaway `codex app-server` subprocess and speaks a real handshake to
 * it (see that transport's own doc comment) - genuine subprocess and IPC
 * latency, not a fixed in-process computation, that can exceed 2s under
 * host contention. The malformed case still resolves in its first
 * iteration or two regardless of this ceiling.
 */
async function pollStderrFor(server: SpawnedServer, substring: string): Promise<boolean> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (server.stderrText().includes(substring)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("wake-target hand-off, malformed: a real modern tools/call whose own request _meta carries threadId:'' alongside the required envelope keys logs the malformed-target skip diagnostic once the job reaches terminal", async (t) => {
  const originalGate = process.env.GHANTIKA_WAKE_TRANSPORT_ENABLED;
  process.env.GHANTIKA_WAKE_TRANSPORT_ENABLED = "1";
  const server = tracked();
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
    if (originalGate === undefined) delete process.env.GHANTIKA_WAKE_TRANSPORT_ENABLED;
    else process.env.GHANTIKA_WAKE_TRANSPORT_ENABLED = originalGate;
  });

  server.send(discoverRequest(1));
  const discoverBody = (await server.nextLine()).parsed as DiscoverResultBody;
  assert.ok(discoverBody.result, "server/discover must succeed first");

  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "run",
      arguments: { command: ["true"] },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
        threadId: "",
      },
    },
  });
  const mintLine = await server.nextLine();
  const mintBody = mintLine.parsed as {
    error?: unknown;
    result?: { structuredContent?: { job_id?: unknown } };
  };
  assert.equal(mintBody.error, undefined, `run must succeed, got: ${JSON.stringify(mintBody)}`);
  const jobId = mintBody.result?.structuredContent?.job_id;
  assert.equal(typeof jobId, "string", "expected a real job_id on the run response");

  const found = await pollStderrFor(
    server,
    `transport wake skipped for task ${jobId as string}: wake target threadId present but is an empty string, expected non-empty string`
  );
  assert.ok(
    found,
    `expected the malformed-threadId skip diagnostic on stderr once the job terminalized; got stderr: ${server.stderrText()}`
  );
});

test("wake-target hand-off, resolved: a real modern tools/call whose own request _meta carries a real non-empty threadId alongside the required envelope keys reaches selectAndWake (an attempted-wake diagnostic, not silence) once the job reaches terminal", async (t) => {
  const originalGate = process.env.GHANTIKA_WAKE_TRANSPORT_ENABLED;
  process.env.GHANTIKA_WAKE_TRANSPORT_ENABLED = "1";
  const server = tracked();
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
    if (originalGate === undefined) delete process.env.GHANTIKA_WAKE_TRANSPORT_ENABLED;
    else process.env.GHANTIKA_WAKE_TRANSPORT_ENABLED = originalGate;
  });

  server.send(discoverRequest(1));
  const discoverBody = (await server.nextLine()).parsed as DiscoverResultBody;
  assert.ok(discoverBody.result, "server/discover must succeed first");

  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "run",
      arguments: { command: ["true"] },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
        threadId: "thread-real-wire-resolved",
      },
    },
  });
  const mintLine = await server.nextLine();
  const mintBody = mintLine.parsed as {
    error?: unknown;
    result?: { structuredContent?: { job_id?: unknown } };
  };
  assert.equal(mintBody.error, undefined, `run must succeed, got: ${JSON.stringify(mintBody)}`);
  const jobId = mintBody.result?.structuredContent?.job_id;
  assert.equal(typeof jobId, "string", "expected a real job_id on the run response");

  // Which of the three non-"delivered" outcomes (refused/unavailable/threw
  // - `startTransportWakeOnTerminal`'s own WakeResult union, see its doc
  // comment) a real environment produces is not fixed: on a runner with
  // neither a real Codex app-server nor a real ChatGPT desktop IPC socket,
  // both DEFAULT_TRANSPORTS probes report unavailable. A host with a real
  // `codex app-server` reachable can instead have the app-server respond
  // and refuse this non-UUID-shaped threadId - a real protocol-level
  // validation error from a real transport, not a probe failure. Both are
  // "an attempt reached selectAndWake"; neither is "delivered" - this test
  // asserts only that request metadata reaches a gated wake attempt, never
  // that a real recipient session is actually resumed. What distinguishes
  // this from the sibling malformed test above is that some attempted-wake
  // diagnostic fires at all: that only happens when resolveWakeTarget
  // answered "resolved", never "absent".
  const found = await pollStderrFor(server, `transport wake `);
  assert.ok(
    found,
    `expected some attempted-wake diagnostic on stderr once the job terminalized; got stderr: ${server.stderrText()}`
  );
  const stderrText = server.stderrText();
  assert.match(
    stderrText,
    new RegExp(`transport wake (refused|unavailable|threw) for task ${jobId as string}`),
    `expected one of the three non-"delivered" outcome diagnostics naming this exact job, got: ${stderrText}`
  );
  assert.ok(
    !stderrText.includes("transport wake skipped for task"),
    "a resolved, non-empty threadId must never produce the malformed-skip diagnostic"
  );
});
