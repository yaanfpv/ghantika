import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Explicit ".ts" extension (not the NodeNext-style ".js" src/ uses): this
// helper has no relative imports of its own (only node: builtins), so
// Node's native TypeScript support can load it directly without a build
// step - unlike src/*.ts, which cross-references compiled ".js" siblings
// and must be imported from dist/ (see test/registry.test.ts's comment).
import { type SpawnedServer, completeHandshake, spawnServer } from "./helpers/spawnServer.ts";
// The shared marker-file poll, one implementation for every suite that
// observes a job's real filesystem side effects (see its own docs for why
// it waits on content rather than on the file existing).
import { parsesAsJsonObject, waitForFile } from "./harness.ts";

/**
 * The real end-to-end proof: a real spawned `dist/index.js` process, real
 * JSON-RPC over its real stdin/stdout, no internal function calls. This is
 * the single most important verification this project has - every
 * assertion here is about OBSERVABLE WIRE BEHAVIOR, not implementation
 * detail.
 */

const spawned: SpawnedServer[] = [];
function tracked(): SpawnedServer {
  const server = spawnServer();
  spawned.push(server);
  return server;
}

after(() => {
  // Belt-and-braces cleanup in case any individual test's own kill/exit
  // path didn't run (e.g. a test failed before reaching it) - never leave
  // a spawned server process behind after this file's tests finish.
  for (const server of spawned) {
    if (!server.child.killed) server.child.kill("SIGKILL");
  }
});

test("initialize negotiates successfully and advertises tools capability", async () => {
  const server = tracked();
  const response = await completeHandshake(server);
  assert.equal(
    response.parseError,
    undefined,
    `expected valid JSON, got parse error: ${response.parseError}`
  );
  const body = response.parsed as { jsonrpc: string; id: number; result?: Record<string, unknown> };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 1);
  assert.ok(body.result, "initialize must return a result, not an error");
  const result = body.result as {
    protocolVersion: string;
    capabilities: { tools?: unknown };
    serverInfo: { name: string };
  };
  assert.equal(typeof result.protocolVersion, "string");
  assert.ok(result.capabilities.tools, "server must advertise the tools capability");
  assert.equal(result.serverInfo.name, "ghantika");
  server.child.kill("SIGKILL");
});

test("tools/list, after initialization, advertises exactly the six frozen tools with explicit input JSON Schemas", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const response = await server.nextLine();
  const body = response.parsed as {
    result: { tools: Array<{ name: string; inputSchema: { type: string } }> };
  };
  const names = body.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["kill", "list", "output", "run", "status", "tail"]);
  for (const tool of body.result.tools) {
    assert.equal(
      tool.inputSchema.type,
      "object",
      `${tool.name}'s inputSchema must be an explicit JSON Schema object`
    );
  }
  server.child.kill("SIGKILL");
});

// --- exact error-class behavior, driven over the real wire ---

test("a malformed (unparseable) JSON-RPC line gets a real -32700 Parse error response, id: null, AND the connection survives to serve the next request correctly", async () => {
  const server = tracked();
  server.sendRaw("this is not valid json {{{\n");
  const line = await server.nextLine();
  const body = line.parsed as {
    jsonrpc: string;
    id: unknown;
    error: { code: number; message: string };
  };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, null);
  assert.equal(body.error.code, -32700, "unparseable JSON must be reported as ParseError (-32700)");

  // The robustness property, not just the restored code: the SAME
  // connection must still work afterward - a real request sent right
  // after the malformed line must be served correctly, proving the
  // malformed line was cleanly discarded rather than corrupting the
  // buffer or wedging the connection. This is what would go red if a
  // future SDK bump changed how cleanly it recovers.
  server.send({ jsonrpc: "2.0", id: 501, method: "totally/unknown/method" });
  const nextLine = await server.nextLine();
  const nextBody = nextLine.parsed as { id: unknown; error: { code: number } };
  assert.equal(
    nextBody.id,
    501,
    "the next request's own response must arrive, correctly correlated by id"
  );
  assert.equal(
    nextBody.error.code,
    -32601,
    "the next request must be handled on its own real merits, not the parse error's leftovers"
  );
  server.child.kill("SIGKILL");
});

// --- the malformed-line interception composes correctly with the init-gate:
// both mechanisms wrap the same transport (transport.onmessage/send for the
// gate, a synthetic stdin for the parse-error reply), and neither may break
// the other. ---

test("a malformed line arriving BEFORE initialize still gets -32700, and the real initialize handshake afterward still succeeds normally", async () => {
  const server = tracked();
  server.sendRaw("not json at all {{{\n");
  const parseErrorLine = await server.nextLine();
  const parseErrorBody = parseErrorLine.parsed as { id: unknown; error: { code: number } };
  assert.equal(parseErrorBody.id, null);
  assert.equal(parseErrorBody.error.code, -32700);

  // The init-gate machinery (attachInitializeRequestObserver/
  // attachInitializeResponseObserver, wrapping transport.onmessage/send)
  // must still see and correctly negotiate the REAL initialize request
  // that follows - proving the parse-error interception ahead of the
  // transport does not shadow or corrupt what the gate observes.
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 502,
    method: "tools/call",
    params: { name: "this-tool-does-not-exist", arguments: {} },
  });
  const toolCallLine = await server.nextLine();
  const toolCallBody = toolCallLine.parsed as { error?: { code: number } };
  assert.equal(
    toolCallBody.error?.code,
    -32602,
    "post-handshake tools/call must be dispatched normally - the gate opened correctly despite the earlier malformed line"
  );
  server.child.kill("SIGKILL");
});

test("a malformed line arriving mid-connection, AFTER a successful handshake, does not reopen or break the already-satisfied init-gate", async () => {
  const server = tracked();
  await completeHandshake(server);

  server.sendRaw("{{{ still not json\n");
  const parseErrorLine = await server.nextLine();
  const parseErrorBody = parseErrorLine.parsed as { id: unknown; error: { code: number } };
  assert.equal(parseErrorBody.id, null);
  assert.equal(parseErrorBody.error.code, -32700);

  server.send({
    jsonrpc: "2.0",
    id: 503,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["true"] } },
  });
  const runLine = await server.nextLine();
  const runBody = runLine.parsed as { result?: { isError?: boolean } };
  assert.notEqual(
    runBody.result?.isError,
    true,
    "a real tools/call after the malformed line must still succeed - the gate stayed open, unaffected"
  );
  server.child.kill("SIGKILL");
});

// --- single-writer-of-stdout proof: the -32700 reply and a genuinely
// LARGE real response must never interleave on the wire, even when one is
// still mid-write (real backpressure) when the other fires. Both go
// through the SAME transport.send() call path (see createStdioTransport's
// own doc comment in src/server.ts) - this proves that holds under real
// load, not just for two small messages that would look atomic regardless. ---

test("a malformed line racing a genuinely large real response (several MB, forced backpressure) never interleaves bytes on stdout", async () => {
  const server = tracked();
  await completeHandshake(server);

  // A real job whose stdout is 4MB - well past `jobStore`'s own
  // MAX_BUFFER_BYTES retention cap (1 MiB), so `output`'s response embeds
  // the full retained buffer (not the whole 4MB, which is evicted by
  // design) plus a real gap marker for the rest. What matters here is that
  // the RETAINED portion alone is still comfortably past any OS pipe
  // buffer, forcing a real multi-write, backpressure-driven send() on the
  // transport rather than a single synchronous flush.
  const BIG_BYTES = 4 * 1024 * 1024;
  const EXPECTED_MIN_RESPONSE_BYTES = 500_000; // well under the 1 MiB retention cap, well past any pipe buffer
  server.send({
    jsonrpc: "2.0",
    id: 601,
    method: "tools/call",
    params: {
      name: "run",
      arguments: {
        command: `yes 'ghantika-interleave-probe-0123456789ABCDEF' | head -c ${BIG_BYTES}`,
        shell: true,
      },
    },
  });
  const runLine = await server.nextLine();
  const runBody = runLine.parsed as { result?: { structuredContent?: { job_id?: string } } };
  const jobId = runBody.result?.structuredContent?.job_id;
  assert.ok(jobId, "the run call must produce a real job_id");

  // Poll status until the job has genuinely finished producing its output.
  const deadline = Date.now() + 10_000;
  let finished = false;
  while (Date.now() < deadline && !finished) {
    server.send({
      jsonrpc: "2.0",
      id: 602,
      method: "tools/call",
      params: { name: "status", arguments: { job_id: jobId } },
    });
    const statusLine = await server.nextLine();
    const statusBody = statusLine.parsed as { result?: { structuredContent?: { state?: string } } };
    if (statusBody.result?.structuredContent?.state === "exited") finished = true;
    else await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(finished, "the noise-generating job must actually finish within the deadline");

  // Fire the large `output` request (a multi-MB response is coming back
  // over the wire), then IMMEDIATELY - same tick, before that response can
  // possibly have finished writing - send a malformed line too. Both
  // replies now race for the same transport.send() call.
  server.send({
    jsonrpc: "2.0",
    id: 603,
    method: "tools/call",
    params: { name: "output", arguments: { job_id: jobId, stream: "stdout" } },
  });
  server.sendRaw("this line is deliberately not valid json {{{\n");

  const first = await server.nextLine(10_000);
  const second = await server.nextLine(10_000);
  const lines = [first, second];

  const outputResponse = lines.find((l) => (l.parsed as { id?: unknown })?.id === 603);
  const parseErrorResponse = lines.find((l) => {
    const body = l.parsed as { id?: unknown; error?: { code?: number } } | undefined;
    return body?.id === null && body?.error?.code === -32700;
  });

  assert.ok(
    outputResponse?.parseError === undefined,
    `the large output response must be complete, uncorrupted JSON - got a parse error: ${outputResponse?.parseError}`
  );
  assert.ok(
    parseErrorResponse,
    "the -32700 reply must still arrive, intact, despite racing the large write"
  );
  assert.ok(
    (outputResponse!.raw as string).length > EXPECTED_MIN_RESPONSE_BYTES,
    `the output response's raw wire text must be genuinely large (the full retained buffer), not a truncated/corrupted fragment - got ${(outputResponse!.raw as string).length} bytes`
  );
  server.child.kill("SIGKILL");
});

test("an unrecognized JSON-RPC method gets -32601 MethodNotFound", async () => {
  const server = tracked();
  server.send({ jsonrpc: "2.0", id: 9, method: "totally/unknown/method" });
  const line = await server.nextLine();
  const body = line.parsed as { error: { code: number } };
  assert.equal(body.error.code, -32601);
  server.child.kill("SIGKILL");
});

test("e2e: tools/call naming an unknown tool gets -32602 InvalidParams, never -32601", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "this-tool-does-not-exist", arguments: {} },
  });
  const line = await server.nextLine();
  const body = line.parsed as { error?: { code: number }; result?: unknown };
  assert.ok(body.error, "an unknown tool name must be a JSON-RPC error, not a successful result");
  assert.equal(body.error?.code, -32602);
  assert.notEqual(
    body.error?.code,
    -32601,
    "must never be reported as MethodNotFound - tools/call itself is a valid, recognized method"
  );
  server.child.kill("SIGKILL");
});

test("e2e: tools/call for run with schema-invalid arguments is a normal successful RPC with isError: true, NOT a JSON-RPC error", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "run", arguments: {} },
  });
  const line = await server.nextLine();
  const body = line.parsed as {
    error?: unknown;
    result?: { isError?: boolean; content: unknown[] };
  };
  assert.equal(
    body.error,
    undefined,
    "schema-invalid tool arguments must NEVER produce a JSON-RPC protocol error"
  );
  assert.ok(body.result, "must be a normal successful RPC response");
  assert.equal(body.result?.isError, true);
  assert.ok(Array.isArray(body.result?.content) && (body.result?.content?.length ?? 0) > 0);
  server.child.kill("SIGKILL");
});

test("tools/call for run with valid argv arguments succeeds at the RPC level and returns a real starting/running job, never the old stub message", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["true"] } },
  });
  const line = await server.nextLine();
  const body = line.parsed as {
    error?: unknown;
    result?: {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
    };
  };
  assert.equal(body.error, undefined);
  assert.notEqual(body.result?.isError, true);
  assert.equal((body.result?.content[0]?.text ?? "").includes("not implemented yet"), false);
  assert.equal(typeof body.result?.structuredContent?.job_id, "string");
  assert.ok(
    ["starting", "running", "exited"].includes(body.result?.structuredContent?.state as string)
  );
  server.child.kill("SIGKILL");
});

// --- tools/call before initialize is rejected ---

test("e2e: a tools/call sent before the initialize/initialized handshake completes is rejected, not silently processed", async () => {
  const server = tracked();
  // Deliberately skip initialize entirely and go straight to tools/call.
  server.send({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["echo", "hi"] } },
  });
  const line = await server.nextLine();
  const body = line.parsed as { error?: { code: number }; result?: unknown };
  assert.ok(
    body.error,
    "a pre-initialize tools/call must be rejected as an error, not processed as a normal call"
  );
  assert.equal(
    body.result,
    undefined,
    "must not have been silently dispatched to the run handler at all"
  );
  server.child.kill("SIGKILL");
});

test("e2e: tools/call sent after initialize's RESPONSE but before notifications/initialized is still rejected", async () => {
  const server = tracked();
  server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    },
  });
  await server.nextLine(); // the initialize response - deliberately NOT sending notifications/initialized yet
  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list", arguments: {} },
  });
  const line = await server.nextLine();
  const body = line.parsed as { error?: { code: number } };
  assert.ok(body.error, "tools/call before notifications/initialized must still be rejected");
  server.child.kill("SIGKILL");
});

test("e2e: notifications/initialized sent FIRST, with NO prior initialize request at all, does not bypass the init-gate - tools/call is still rejected with -32600 InvalidRequest, never dispatched", async () => {
  // The SDK's own `oninitialized` callback fires purely off RECEIVING
  // notifications/initialized - it never checks that a real initialize
  // REQUEST preceded it. A single `initialized` boolean flipped only
  // inside `oninitialized` is therefore bypassable by a client (malicious
  // or buggy) that sends notifications/initialized as its very first
  // message. The gate (see src/server.ts's createServer()) requires a
  // confirmed SUCCESSFUL initialize negotiation AND the initialized
  // notification before tools/call is accepted.
  const server = tracked();
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" }); // no prior initialize request at all
  server.send({
    jsonrpc: "2.0",
    id: 30,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["echo", "should-never-run"] } },
  });
  const line = await server.nextLine();
  const body = line.parsed as { error?: { code: number; message: string }; result?: unknown };
  assert.ok(
    body.error,
    "tools/call must be rejected when notifications/initialized arrived with no prior initialize request - the bypass must be closed"
  );
  assert.equal(
    body.error?.code,
    -32600,
    "a pre-real-handshake tools/call must be InvalidRequest (-32600)"
  );
  assert.equal(
    body.result,
    undefined,
    "must not have been silently dispatched to the run handler - no job may have been created"
  );
  server.child.kill("SIGKILL");
});

test("e2e: a real initialize request followed by notifications/initialized still accepts tools/call normally (green control - the gate does not break the legitimate handshake)", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 31,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["true"] } },
  });
  const line = await server.nextLine();
  const body = line.parsed as {
    error?: unknown;
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
  };
  assert.equal(
    body.error,
    undefined,
    "a real, complete handshake must still let tools/call through normally"
  );
  assert.notEqual(body.result?.isError, true);
  assert.equal(typeof body.result?.structuredContent?.job_id, "string");
  server.child.kill("SIGKILL");
});

// --- the init-gate observes the SDK's own negotiation
// OUTCOME, not merely an incoming message's method name - a message named
// "initialize" that is either not a real REQUEST (no id) or whose params
// the SDK's own validation rejects must never open the gate. ---

test('e2e: a notification-shaped "initialize" message (no id) does not open the init-gate - JSON-RPC distinguishes a request from a notification solely by the presence of id, and only a genuine REQUEST can negotiate', async () => {
  const server = tracked();
  // Exactly a real initialize request's shape, MINUS the id - which makes
  // it a notification per JSON-RPC 2.0, never routed to the SDK's own
  // _oninitialize the way a real request is.
  server.send({
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ghantika-e2e-test", version: "0.0.0" },
    },
  });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  server.send({
    jsonrpc: "2.0",
    id: 40,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["echo", "should-never-run"] } },
  });
  const line = await server.nextLine();
  const body = line.parsed as { error?: { code: number }; result?: unknown };
  assert.ok(
    body.error,
    'tools/call must be rejected - the notification-shaped "initialize" never negotiated anything'
  );
  assert.equal(body.error?.code, -32600);
  assert.equal(
    body.result,
    undefined,
    "must not have been silently dispatched - no job may have been created"
  );
  server.child.kill("SIGKILL");
});

test("e2e: a real initialize REQUEST whose params the SDK's own validation rejects does not open the init-gate, even after notifications/initialized", async () => {
  const server = tracked();
  // A real request (has an id) but missing the required clientInfo field
  // entirely - the SDK's own InitializeRequestParamsSchema requires it,
  // and rejects this with a real JSON-RPC error for this exact id.
  server.send({
    jsonrpc: "2.0",
    id: 41,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {} },
  });
  const initLine = await server.nextLine();
  const initBody = initLine.parsed as { error?: { code: number }; result?: unknown };
  assert.ok(
    initBody.error,
    "the SDK's own validation must reject params missing the required clientInfo field"
  );
  assert.equal(initBody.result, undefined);

  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  server.send({
    jsonrpc: "2.0",
    id: 42,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["echo", "should-never-run"] } },
  });
  const toolLine = await server.nextLine();
  const toolBody = toolLine.parsed as { error?: { code: number }; result?: unknown };
  assert.ok(
    toolBody.error,
    "tools/call must be rejected - a client told its initialize failed must not still get the gate opened"
  );
  assert.equal(toolBody.error?.code, -32600);
  assert.equal(
    toolBody.result,
    undefined,
    "must not have been silently dispatched - no job may have been created"
  );
  server.child.kill("SIGKILL");
});

test("tools/call succeeds normally once the full handshake (initialize + notifications/initialized) has completed", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "list", arguments: {} },
  });
  const line = await server.nextLine();
  const body = line.parsed as { error?: unknown; result?: { isError?: boolean } };
  assert.equal(
    body.error,
    undefined,
    "after a completed handshake, tools/call must be processed normally"
  );
  // list() is a real implementation: a completed handshake
  // must reach a real success result, never isError (the old not-implemented
  // stub always errored here - that was the prior test's marker for "not a
  // rejection"; a real success result now proves the same thing).
  assert.notEqual(body.result?.isError, true);
  server.child.kill("SIGKILL");
});

// --- dynamic half: stdio purity under real, rapid traffic ---

test("e2e, dynamic: under a rapid burst of real traffic, every single stdout line is clean, valid JSON-RPC - never a stray byte", async () => {
  const server = tracked();
  await completeHandshake(server);

  const REQUEST_COUNT = 60;
  for (let i = 0; i < REQUEST_COUNT; i++) {
    if (i % 2 === 0) {
      server.send({ jsonrpc: "2.0", id: 100 + i, method: "tools/list" });
    } else {
      server.send({
        jsonrpc: "2.0",
        id: 100 + i,
        method: "tools/call",
        params: { name: "run", arguments: i % 3 === 0 ? {} : { command: ["echo", `${i}`] } },
      });
    }
  }

  // Drain exactly REQUEST_COUNT responses (each request gets exactly one
  // response line - no notifications are sent by this server for these
  // methods).
  const responses = [];
  for (let i = 0; i < REQUEST_COUNT; i++) {
    responses.push(await server.nextLine(5000));
  }

  assert.equal(responses.length, REQUEST_COUNT);
  for (const line of responses) {
    assert.equal(
      line.parseError,
      undefined,
      `stdout produced a non-JSON line under load: ${JSON.stringify(line.raw)}`
    );
    const body = line.parsed as { jsonrpc?: string };
    assert.equal(
      body.jsonrpc,
      "2.0",
      `every stdout line must be a clean JSON-RPC 2.0 message, got: ${line.raw}`
    );
  }

  server.child.kill("SIGKILL");
});

test("nothing unexpected was ever written to stderr as a protocol-breaking side effect (diagnostics only)", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({ jsonrpc: "2.0", id: 8, method: "tools/list" });
  await server.nextLine();
  server.child.kill("SIGKILL");
  await server.waitForExit();
  // stderr is allowed to contain OUR OWN [ghantika]-prefixed diagnostics;
  // it must never be empty-vs-anything assertion here (that's not the
  // point - stdout purity is), just a sanity check that whatever's there
  // isn't a Node crash stack trace from an uncaught exception.
  assert.equal(server.stderrText().includes("Uncaught"), false);
});

// ---------------------------------------------------------------------------
// run's REAL spawn-and-track behavior, proven over the real wire
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-e2e-"));
}

interface RunResponseBody {
  readonly error?: { code: number; message: string };
  readonly result?: {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  };
}

test("run() returns job_id well BEFORE a real sleeping child's terminal event (explicit relative-deadline, non-blocking proof)", async () => {
  const server = tracked();
  await completeHandshake(server);

  const SLEEP_MS = 2000;
  const MAX_RESPONSE_MS = 400; // generous relative deadline, still an order of magnitude under SLEEP_MS

  const requestSentAt = Date.now();
  server.send({
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: {
      name: "run",
      arguments: { command: ["node", "-e", `setTimeout(() => {}, ${SLEEP_MS})`] },
    },
  });
  const line = await server.nextLine(MAX_RESPONSE_MS + 1000);
  const elapsed = Date.now() - requestSentAt;

  const body = line.parsed as RunResponseBody;
  assert.equal(body.error, undefined, "run() must succeed at the RPC level");
  assert.notEqual(body.result?.isError, true);
  assert.ok(
    elapsed < MAX_RESPONSE_MS,
    `run() response took ${elapsed}ms - must arrive well under the child's own ${SLEEP_MS}ms sleep (non-blocking)`
  );
  assert.ok(
    elapsed < SLEEP_MS / 2,
    "response must arrive in well under half the child's sleep duration"
  );
  assert.ok(
    ["starting", "running"].includes(body.result?.structuredContent?.state as string),
    "a job racing a 2s sleep must still be starting/running at response time, never exited"
  );

  server.child.kill("SIGKILL");
});

test("a real invalid-binary attempt over the wire returns a normal (non-error) result with a real job_id, state failed, diagnostic.reason spawn-error", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 21,
    method: "tools/call",
    params: {
      name: "run",
      arguments: { command: ["this-command-definitely-does-not-exist-ghantika-e2e"] },
    },
  });
  const line = await server.nextLine();
  const body = line.parsed as RunResponseBody;
  assert.equal(body.error, undefined, "a bad binary must never be a JSON-RPC protocol error");
  assert.notEqual(
    body.result?.isError,
    true,
    "a bad binary must never be a tool-execution error either - it's a real, queryable job"
  );
  const structured = body.result?.structuredContent;
  assert.equal(typeof structured?.job_id, "string");
  assert.equal(structured?.state, "failed");
  assert.deepEqual(structured?.diagnostic, {
    reason: "spawn-error",
    message: "command not found or not executable",
  });
  server.child.kill("SIGKILL");
});

test("a real invalid-cwd attempt over the wire returns state failed, diagnostic.reason spawn-error - never silently defaulted to the server's own cwd", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 22,
    method: "tools/call",
    params: {
      name: "run",
      arguments: { command: ["true"], cwd: "/no/such/directory/ghantika-e2e-test" },
    },
  });
  const line = await server.nextLine();
  const body = line.parsed as RunResponseBody;
  assert.equal(body.error, undefined);
  assert.notEqual(body.result?.isError, true);
  const structured = body.result?.structuredContent;
  assert.equal(structured?.state, "failed");
  assert.deepEqual(structured?.diagnostic, {
    reason: "spawn-error",
    message: "cwd does not exist",
  });
  server.child.kill("SIGKILL");
});

test("cwd that exists but is a FILE (not a directory) also fails the job, never silently defaulted", async () => {
  const server = tracked();
  await completeHandshake(server);
  const dir = makeTempDir();
  const filePath = path.join(dir, "im-a-file-not-a-directory");
  fs.writeFileSync(filePath, "x");
  server.send({
    jsonrpc: "2.0",
    id: 23,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["true"], cwd: filePath } },
  });
  const line = await server.nextLine();
  const body = line.parsed as RunResponseBody;
  const structured = body.result?.structuredContent;
  assert.equal(structured?.state, "failed");
  assert.deepEqual(structured?.diagnostic, {
    reason: "spawn-error",
    message: "cwd exists but is not a directory",
  });
  server.child.kill("SIGKILL");
});

test("a real command that writes known output actually runs in the background (proven via a real filesystem side effect, an oracle outside the server's own reporting)", async () => {
  const server = tracked();
  await completeHandshake(server);
  const dir = makeTempDir();
  const marker = path.join(dir, "known-output.txt");
  server.send({
    jsonrpc: "2.0",
    id: 24,
    method: "tools/call",
    params: {
      name: "run",
      arguments: {
        command: [
          "node",
          "-e",
          "require('fs').writeFileSync(process.argv[1], 'ghantika-known-output-marker')",
          marker,
        ],
      },
    },
  });
  const line = await server.nextLine();
  const body = line.parsed as RunResponseBody;
  assert.equal(body.error, undefined);
  assert.notEqual(body.result?.isError, true);
  assert.ok(
    ["starting", "running"].includes(body.result?.structuredContent?.state as string),
    "must respond before the (fast) child has necessarily finished"
  );

  // writeFileSync truncates on open, so the file can be read back empty
  // between the open and the write: wait for the exact bytes the child was
  // told to write.
  const content = await waitForFile(marker, {
    until: (text) => text === "ghantika-known-output-marker",
  });
  assert.equal(content, "ghantika-known-output-marker");
  server.child.kill("SIGKILL");
});

test("a real command that exits nonzero actually runs to that point in the background (proven via a real filesystem side effect written just before the nonzero exit)", async () => {
  const server = tracked();
  await completeHandshake(server);
  const dir = makeTempDir();
  const marker = path.join(dir, "about-to-exit-nonzero.txt");
  server.send({
    jsonrpc: "2.0",
    id: 25,
    method: "tools/call",
    params: {
      name: "run",
      arguments: {
        command: [
          "node",
          "-e",
          "require('fs').writeFileSync(process.argv[1], 'ran'); process.exit(3)",
          marker,
        ],
      },
    },
  });
  const line = await server.nextLine();
  const body = line.parsed as RunResponseBody;
  assert.equal(body.error, undefined);
  assert.notEqual(body.result?.isError, true);

  const content = await waitForFile(marker, { until: (text) => text === "ran" });
  assert.equal(content, "ran");
  server.child.kill("SIGKILL");
});

test("shell: true actually runs a real shell command line, pipes and all", async () => {
  const server = tracked();
  await completeHandshake(server);
  const dir = makeTempDir();
  const marker = path.join(dir, "shell-pipe-output.txt");
  server.send({
    jsonrpc: "2.0",
    id: 26,
    method: "tools/call",
    params: {
      name: "run",
      arguments: { command: `echo hello-shell-world | tr 'a-z' 'A-Z' > ${marker}`, shell: true },
    },
  });
  const line = await server.nextLine();
  const body = line.parsed as RunResponseBody;
  assert.equal(body.error, undefined);
  assert.notEqual(body.result?.isError, true);

  // The shell creates the redirect target before `echo | tr` has written a
  // byte, so this waits for the piped output itself, not for the file.
  const content = await waitForFile(marker, {
    until: (text) => text.trim() === "HELLO-SHELL-WORLD",
  });
  assert.equal(content.trim(), "HELLO-SHELL-WORLD");
  server.child.kill("SIGKILL");
});

test("env.mode replace gives the child ONLY the caller's vars (proven via the child echoing its own real process.env to a file)", async () => {
  const server = tracked();
  await completeHandshake(server);
  const dir = makeTempDir();
  const marker = path.join(dir, "child-env.json");
  server.send({
    jsonrpc: "2.0",
    id: 27,
    method: "tools/call",
    params: {
      name: "run",
      // Absolute path to node, not a bare "node" - replace mode gives NO
      // base env at all (by design), so there is no PATH to
      // search unless the caller supplies one; using process.execPath
      // sidesteps that PATH-search dependency entirely (the point of THIS
      // test is env content, not executable resolution).
      arguments: {
        command: [
          process.execPath,
          "-e",
          "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.env))",
          marker,
        ],
        env: { mode: "replace", vars: { ONLY_VAR: "only-value" } },
      },
    },
  });
  const line = await server.nextLine();
  const body = line.parsed as RunResponseBody;
  assert.equal(body.error, undefined);
  assert.notEqual(body.result?.isError, true);

  // Waiting for a complete JSON object, so a half-written one is never
  // handed to JSON.parse as a confusing syntax error.
  const content = await waitForFile(marker, { until: parsesAsJsonObject });
  const childEnv = JSON.parse(content) as Record<string, string>;
  // macOS injects __CF_USER_TEXT_ENCODING into every process at launch
  // (a CoreFoundation/dyld-level default, verified empirically) - stripped
  // before comparing, since this test's point is that OUR base/inherited
  // vars are absent, not that the OS injects nothing of its own.
  delete childEnv.__CF_USER_TEXT_ENCODING;
  // c8 injects NODE_V8_COVERAGE into every child it instruments - a real
  // measurement artifact of running under coverage, not something replace
  // mode itself adds. Subtracted only when the parent actually has it set,
  // so an uninstrumented run still asserts on the whole object, and a real
  // leak of this var outside coverage instrumentation still reds.
  if (process.env.NODE_V8_COVERAGE !== undefined) {
    delete childEnv.NODE_V8_COVERAGE;
  }
  assert.deepEqual(childEnv, { ONLY_VAR: "only-value" });
  server.child.kill("SIGKILL");
});

test("e2e: the public run() result never includes env or the raw argv array in any form, over the real wire", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 28,
    method: "tools/call",
    params: {
      name: "run",
      arguments: {
        command: ["true", "--do-not-leak-this-argument"],
        env: { mode: "merge", vars: { SECRET_TOKEN: "do-not-leak-this-value" } },
      },
    },
  });
  const line = await server.nextLine();
  assert.equal(
    line.raw.includes("do-not-leak-this-value"),
    false,
    "the raw stdout line must never contain a leaked env value"
  );
  assert.equal(
    line.raw.includes("--do-not-leak-this-argument"),
    false,
    "the raw stdout line must never contain a leaked argv element"
  );
  const body = line.parsed as RunResponseBody;
  assert.equal("env" in (body.result?.structuredContent ?? {}), false);
  assert.equal("argv" in (body.result?.structuredContent ?? {}), false);
  assert.equal(body.result?.structuredContent?.command_summary, "true");
  server.child.kill("SIGKILL");
});

test("e2e, green control: a valid run with a caller label round-trips cleanly, never trips any validation path", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 29,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["true"], label: "nightly-smoke-test" } },
  });
  const line = await server.nextLine();
  const body = line.parsed as RunResponseBody;
  assert.equal(body.error, undefined);
  assert.notEqual(body.result?.isError, true);
  assert.equal(body.result?.structuredContent?.label, "nightly-smoke-test");
  server.child.kill("SIGKILL");
});

// ---------------------------------------------------------------------------
// status()/list(), proven over the real wire against real spawned jobs
// ---------------------------------------------------------------------------

test("status() over the real wire reports a real job's state, and an unknown job_id is a typed not-found isError, never a thrown/protocol error", async () => {
  const server = tracked();
  await completeHandshake(server);

  server.send({
    jsonrpc: "2.0",
    id: 30,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["true"], label: "e2e-status-test" } },
  });
  const runLine = await server.nextLine();
  const runBody = runLine.parsed as RunResponseBody;
  const jobId = runBody.result?.structuredContent?.job_id as string;
  assert.equal(typeof jobId, "string");

  server.send({
    jsonrpc: "2.0",
    id: 31,
    method: "tools/call",
    params: { name: "status", arguments: { job_id: jobId } },
  });
  const statusLine = await server.nextLine();
  const statusBody = statusLine.parsed as RunResponseBody;
  assert.equal(statusBody.error, undefined, "status() must never be a JSON-RPC protocol error");
  assert.notEqual(statusBody.result?.isError, true);
  assert.equal(statusBody.result?.structuredContent?.job_id, jobId);
  assert.equal(statusBody.result?.structuredContent?.label, "e2e-status-test");
  assert.ok(
    ["starting", "running", "exited"].includes(
      statusBody.result?.structuredContent?.state as string
    )
  );
  assert.equal(typeof statusBody.result?.structuredContent?.started_at, "string");

  server.send({
    jsonrpc: "2.0",
    id: 32,
    method: "tools/call",
    params: { name: "status", arguments: { job_id: "no-such-job-e2e-ghantika" } },
  });
  const notFoundLine = await server.nextLine();
  const notFoundBody = notFoundLine.parsed as RunResponseBody;
  assert.equal(
    notFoundBody.error,
    undefined,
    "an unknown job_id must never be a JSON-RPC protocol error"
  );
  assert.equal(notFoundBody.result?.isError, true);
  assert.ok((notFoundBody.result?.content[0]?.text ?? "").includes("no job found"));

  server.child.kill("SIGKILL");
});

test("status() faithfully reports exit_code for a real exited job, over the real wire (waits for the real terminal event)", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 39,
    method: "tools/call",
    params: { name: "run", arguments: { command: [process.execPath, "-e", "process.exit(7)"] } },
  });
  const runLine = await server.nextLine();
  const jobId = (runLine.parsed as RunResponseBody).result?.structuredContent?.job_id as string;

  const deadline = Date.now() + 5000;
  let state: string | undefined;
  let structured: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    server.send({
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: { name: "status", arguments: { job_id: jobId } },
    });
    const line = await server.nextLine();
    structured = (line.parsed as RunResponseBody).result?.structuredContent;
    state = structured?.state as string | undefined;
    if (state === "exited") break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(
    state,
    "exited",
    "status() must eventually observe the job's real exit over the wire"
  );
  assert.equal(structured?.exit_code, 7);
  assert.equal("signal" in (structured ?? {}), false);
  assert.equal(typeof structured?.ended_at, "string");

  server.child.kill("SIGKILL");
});

test("list() over the real wire enumerates real jobs most-recent-first", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 33,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["true"], label: "e2e-list-a" } },
  });
  const firstLine = await server.nextLine();
  const firstJobId = (firstLine.parsed as RunResponseBody).result?.structuredContent
    ?.job_id as string;

  server.send({
    jsonrpc: "2.0",
    id: 34,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["true"], label: "e2e-list-b" } },
  });
  const secondLine = await server.nextLine();
  const secondJobId = (secondLine.parsed as RunResponseBody).result?.structuredContent
    ?.job_id as string;

  server.send({
    jsonrpc: "2.0",
    id: 35,
    method: "tools/call",
    params: { name: "list", arguments: {} },
  });
  const listLine = await server.nextLine();
  const listBody = listLine.parsed as {
    error?: unknown;
    result?: { isError?: boolean; structuredContent?: { jobs?: Array<Record<string, unknown>> } };
  };
  assert.equal(listBody.error, undefined);
  assert.notEqual(listBody.result?.isError, true);
  const jobs = listBody.result?.structuredContent?.jobs ?? [];
  const firstIndex = jobs.findIndex((j) => j.job_id === firstJobId);
  const secondIndex = jobs.findIndex((j) => j.job_id === secondJobId);
  assert.ok(
    firstIndex !== -1 && secondIndex !== -1,
    "both real jobs must appear in list()'s output"
  );
  assert.ok(
    secondIndex < firstIndex,
    "the job created SECOND (more recently) must sort BEFORE the job created first"
  );

  server.child.kill("SIGKILL");
});

test("status()/list() are non-blocking - both return promptly over the wire while a real, actively-running slow job is in flight", async () => {
  const server = tracked();
  await completeHandshake(server);

  const SLEEP_MS = 2000;
  const MAX_RESPONSE_MS = 400;

  server.send({
    jsonrpc: "2.0",
    id: 36,
    method: "tools/call",
    params: {
      name: "run",
      arguments: {
        command: ["node", "-e", `setTimeout(() => {}, ${SLEEP_MS})`],
        label: "e2e-nonblocking-slow-job",
      },
    },
  });
  const slowRunLine = await server.nextLine();
  const slowRunBody = slowRunLine.parsed as RunResponseBody;
  const slowJobId = slowRunBody.result?.structuredContent?.job_id as string;
  assert.ok(
    ["starting", "running"].includes(slowRunBody.result?.structuredContent?.state as string)
  );

  const statusStart = Date.now();
  server.send({
    jsonrpc: "2.0",
    id: 37,
    method: "tools/call",
    params: { name: "status", arguments: { job_id: slowJobId } },
  });
  const statusLine = await server.nextLine(MAX_RESPONSE_MS + 1000);
  const statusElapsed = Date.now() - statusStart;
  const statusBody = statusLine.parsed as RunResponseBody;
  assert.ok(
    statusElapsed < MAX_RESPONSE_MS,
    `status() took ${statusElapsed}ms while a job was actively running - must not wait on it (non-blocking)`
  );
  assert.ok(
    ["starting", "running"].includes(statusBody.result?.structuredContent?.state as string),
    "the slow job must still be in flight"
  );

  const listStart = Date.now();
  server.send({
    jsonrpc: "2.0",
    id: 38,
    method: "tools/call",
    params: { name: "list", arguments: {} },
  });
  const listLine = await server.nextLine(MAX_RESPONSE_MS + 1000);
  const listElapsed = Date.now() - listStart;
  const listBody = listLine.parsed as {
    result?: { structuredContent?: { jobs?: Array<Record<string, unknown>> } };
  };
  assert.ok(
    listElapsed < MAX_RESPONSE_MS,
    `list() took ${listElapsed}ms while a job was actively running - must not wait on it (non-blocking)`
  );
  assert.ok((listBody.result?.structuredContent?.jobs ?? []).some((j) => j.job_id === slowJobId));

  server.child.kill("SIGKILL");
});
