import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why (same reason test/process.test.ts and
// test/kill.test.ts already import straight from dist/ alongside their own
// real-spawn assertions). This is the sourced, named list of variable NAMES
// libuv itself force-injects into a Windows child regardless of env.mode -
// see its own doc comment in src/process.ts for the full citation.
import { WINDOWS_LIBUV_REQUIRED_ENV_VAR_NAMES } from "../dist/process.js";

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

test("tools/call for run with valid argv arguments succeeds at the RPC level and returns a real starting/running job", async () => {
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
  // list() is a real implementation: a completed handshake must reach a
  // real success result, never isError.
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

// ---------------------------------------------------------------------------
// env.mode "replace": real, per-platform truth, not an assumption copied
// from POSIX. See WINDOWS_LIBUV_REQUIRED_ENV_VAR_NAMES's own doc comment in
// src/process.ts for the full, sourced explanation of WHY Windows needs its
// own separate, exact assertion here rather than sharing POSIX's.
// ---------------------------------------------------------------------------

/**
 * Runs a real child (`process.execPath`, invoked directly - not a bare
 * "node" - sidesteps a PATH-search dependency entirely, since this whole
 * section's point is env CONTENT, not executable resolution) that dumps
 * its own real `process.env` to `marker` as JSON, waits for the complete
 * write, and returns it parsed - stripped of the two known artifacts this
 * suite already has to account for whenever it inspects a real child's
 * real env, neither of which `env.mode` itself adds: macOS's own
 * `__CF_USER_TEXT_ENCODING` (a CoreFoundation/dyld-level default, verified
 * empirically - not something `child_process`'s `env` option can
 * suppress) and c8's own `NODE_V8_COVERAGE` (a real coverage-
 * instrumentation artifact, subtracted only when the parent actually has
 * it set, so an uninstrumented run still asserts on the whole object and a
 * genuine leak of this var outside coverage instrumentation still reds).
 */
async function runAndCaptureRealChildEnv(
  server: SpawnedServer,
  id: number,
  marker: string,
  env: { mode: "merge" | "replace"; vars: Record<string, string> }
): Promise<Record<string, string>> {
  server.send({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "run",
      arguments: {
        command: [
          process.execPath,
          "-e",
          "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.env))",
          marker,
        ],
        env,
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
  delete childEnv.__CF_USER_TEXT_ENCODING;
  if (process.env.NODE_V8_COVERAGE !== undefined) {
    delete childEnv.NODE_V8_COVERAGE;
  }
  return childEnv;
}

/**
 * Builds a case-insensitive lookup over `env`'s own keys, upper-cased. A
 * plain JS object is case-SENSITIVE by construction, but Windows env keys
 * are not (see WINDOWS_LIBUV_REQUIRED_ENV_VAR_NAMES's own docs, and
 * `resolveCaseInsensitivePathKey` in src/process.ts for the same fact
 * applied to production code): a key THIS codebase contributes (e.g.
 * `computeMinimalBaseEnv`'s `SystemRoot`, mixed case) and a key libuv
 * force-injects (its own `required_vars` table spells the same variable
 * `SYSTEMROOT`, all caps) name the identical variable as far as Windows
 * itself is concerned, even though they are different strings to a raw JS
 * `in`/`[]` lookup. Every assertion below that needs to ask "does the
 * child have variable X" goes through this, not a raw object index,
 * specifically so a real difference in case-spelling between this
 * codebase's own vars and libuv's own spelling can never produce a false
 * pass or a false fail here.
 */
function caseInsensitiveEnvLookup(env: Readonly<Record<string, string>>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    map.set(key.toUpperCase(), value);
  }
  return map;
}

/**
 * Plants `count` random, unique, high-entropy env vars directly onto the
 * TEST's own `process.env` and returns them. `spawnServer()` spawns the
 * real ghantika server with no explicit `env` option of its own (see its
 * own source), so it inherits THIS process's `process.env` exactly the way
 * any real caller of ghantika inherits whatever launched it - planting a
 * canary here really does put it on the SERVER's own live environment, not
 * a simulation of one. Values that must never reach a `replace`-mode
 * child, however this codebase's env handling is implemented - proves the
 * child's env is exactly and only what's necessary, never an open-ended
 * "well, something extra sometimes leaks."
 *
 * MUST be called BEFORE the server is spawned (before `tracked()`), never
 * after. `spawn()` reads `process.env` synchronously at call time, so a
 * canary planted after the server is already spawned never reaches the
 * server's own environment at all - the assertion that it "never leaks"
 * would then pass whether or not the underlying bug exists.
 */
function plantServerEnvCanaries(count: number, label: string): Record<string, string> {
  const canaries: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const key = `GHANTIKA_E2E_CANARY_${label}_${i}_${randomUUID().replace(/-/g, "").toUpperCase()}`;
    canaries[key] = `must-never-leak-${randomUUID()}`;
  }
  for (const [key, value] of Object.entries(canaries)) process.env[key] = value;
  return canaries;
}

function clearServerEnvCanaries(canaries: Record<string, string>): void {
  for (const key of Object.keys(canaries)) delete process.env[key];
}

test(
  "env.mode 'replace' on POSIX gives the child ONLY the caller's vars, no base at all, and none of the SERVER's own random canary vars leak in either (real spawn, real echo of the child's own process.env)",
  {
    skip:
      process.platform === "win32"
        ? "POSIX-only assertion - see the Windows-only test below for that platform's own real, empirically-checked behavior (they are deliberately NOT the same assertion - the two platforms genuinely differ here)"
        : false,
  },
  async () => {
    const canaries = plantServerEnvCanaries(3, "POSIX");
    const server = tracked();
    try {
      await completeHandshake(server);
      const dir = makeTempDir();
      const marker = path.join(dir, "child-env-posix-replace.json");
      const childEnv = await runAndCaptureRealChildEnv(server, 27, marker, {
        mode: "replace",
        vars: { ONLY_VAR: "only-value" },
      });
      assert.deepEqual(
        childEnv,
        { ONLY_VAR: "only-value" },
        "POSIX replace mode's real, observed child env must be EXACTLY the caller's vars - nothing else, ever"
      );
      // Deliberately redundant with the deepEqual above, on its own: a
      // single assertion carrying an entire property's safety net is a
      // single point of failure - if that assertion is ever weakened (e.g.
      // to checking only that ONLY_VAR is present, without checking that
      // NOTHING else is), a real leak would still pass unnoticed unless
      // something else independently checks for stray keys. This does.
      const strayKeys = Object.keys(childEnv).filter((key) => key !== "ONLY_VAR");
      assert.deepEqual(
        strayKeys,
        [],
        `POSIX replace-mode child had unexpected key(s) beyond the caller's own vars: ${strayKeys.join(", ")}`
      );
      for (const key of Object.keys(canaries)) {
        assert.equal(
          key in childEnv,
          false,
          `canary "${key}" (planted directly on the SERVER's own live env) must never reach a replace-mode child`
        );
      }
    } finally {
      clearServerEnvCanaries(canaries);
    }
    server.child.kill("SIGKILL");
  }
);

/**
 * This test file's OWN independently-authored copy of libuv's required-vars
 * list, deliberately NOT derived from the imported
 * `WINDOWS_LIBUV_REQUIRED_ENV_VAR_NAMES` (production's constant, under test
 * below). The duplication is not a smell - it IS the oracle: if the
 * Windows test below derived its own expected/allowed sets from the same
 * production constant it's supposed to be checking, a bogus name added to
 * that constant would silently widen this test's own allow-list right
 * along with it, and the test would stay green regardless of whether
 * production's claim is still accurate. This independent copy, plus the
 * parity test right after it, is what actually catches that: if the two
 * ever diverge, the parity test reds, and only a real, matching update on
 * both sides makes it pass again.
 */
const INDEPENDENTLY_AUTHORED_WINDOWS_REQUIRED_ENV_VAR_NAMES: readonly string[] = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];

// A divergence here means one side changed without the other, and every
// Windows assertion below that trusts the production constant is no
// longer verifying what it claims to.
test("production's WINDOWS_LIBUV_REQUIRED_ENV_VAR_NAMES matches this test file's own independently-authored copy", () => {
  assert.deepEqual(
    [...WINDOWS_LIBUV_REQUIRED_ENV_VAR_NAMES].sort(),
    [...INDEPENDENTLY_AUTHORED_WINDOWS_REQUIRED_ENV_VAR_NAMES].sort(),
    "production's list and this test's own independent copy have diverged - update whichever one is now wrong, never just make this assertion match"
  );
});

/**
 * Runs on every platform, unlike the two platform-gated e2e tests above and
 * below it - it checks a structural relationship between the two contracts
 * themselves, not a real spawned child, so it needs no Windows host to run
 * for real anywhere.
 *
 * The POSIX contract for a replace-mode child is "the caller's vars, and
 * nothing else" - an allowed set of exactly `{ONLY_VAR}` in these tests.
 * The Windows contract is strictly looser: "the caller's vars, plus
 * whichever of libuv's documented required names the server had set" - an
 * allowed set of `{ONLY_VAR}` union the eleven required names. If either
 * platform's real e2e assertion were ever collapsed onto the other's claim
 * - the POSIX test widened to also tolerate libuv's names, or the Windows
 * test narrowed to reject them - the two would stop being genuinely
 * different contracts, and this specific regression could survive on
 * whichever platform the person making the change happens to be able to
 * run at all (this project's own development machine is macOS, so a
 * silent Windows-side narrowing is exactly the kind of change that would
 * never show up as a local red).
 */
test("the Windows replace-mode allowance is a strict superset of the POSIX one, not the same claim by two names", () => {
  const posixAllowedUpper = new Set(["ONLY_VAR"]);
  const windowsAllowedUpper = new Set([
    "ONLY_VAR",
    ...WINDOWS_LIBUV_REQUIRED_ENV_VAR_NAMES.map((name) => name.toUpperCase()),
  ]);

  assert.ok(
    WINDOWS_LIBUV_REQUIRED_ENV_VAR_NAMES.length > 0,
    "libuv's required-names list must be non-empty, or there is no real difference between the two platforms' contracts to assert here"
  );
  for (const name of posixAllowedUpper) {
    assert.ok(
      windowsAllowedUpper.has(name),
      `everything POSIX allows ("${name}") must still be allowed on Windows too - Windows only adds to the allowance, it never removes from it`
    );
  }
  assert.ok(
    windowsAllowedUpper.size > posixAllowedUpper.size,
    "Windows's allowed set must be strictly larger than POSIX's - if the two ever became equal in size, either Windows narrowed to match POSIX or POSIX widened to match Windows, and the platform-specific e2e tests above would no longer be checking genuinely different contracts"
  );
});

type ObservedWindowsRequiredEnvEntry = {
  name: string;
  serverHadItSet: boolean;
  childReceivedIt: boolean;
};

type ObservedWindowsRequiredEnvPayload = {
  platform: string;
  observedRequiredNames: ObservedWindowsRequiredEnvEntry[];
};

/**
 * Builds AND emits the observed Windows required-env map through an
 * injectable sink (defaulting to `console.log` for real use), and RETURNS
 * the exact same payload it emits - so a caller reads its own downstream
 * assertions from this function's return value rather than a separately
 * built variable. Deleting the call to this function therefore breaks the
 * caller by reference (the variable goes out of scope), not merely a
 * silent side effect nothing depends on.
 *
 * `requiredNames` is an INJECTED argument, not read from a module-level
 * import inside this function - deliberately, so which list actually
 * drives the output is a property of the call, testable by injecting a
 * value that could not have come from anywhere else. The real Windows
 * caller passes this test file's own independent list; the unconditional
 * unit test below injects a distinctive sentinel list matching neither
 * that list nor production's constant, and asserts the sentinel names
 * come back unchanged - if this function ever read a hardcoded or
 * globally-imported list instead of its argument, the sentinel would
 * never appear and that assertion reds.
 *
 * The injectable sink is what makes the emission itself testable without a
 * real Windows spawn or a real CI log to grep afterward: the same
 * unconditional unit test calls this with a mock sink and proves, in-
 * process and on every platform, that the sink is called exactly once,
 * with this test file's OWN independently-hardcoded copy of the marker
 * (not one shared with this function - sharing the literal would let a
 * rename move both sides at once and the test would never notice, the
 * same reasoning as `INDEPENDENTLY_AUTHORED_WINDOWS_REQUIRED_ENV_VAR_NAMES`
 * above), carrying a single-line JSON payload that round-trips back to
 * this exact object.
 *
 * What this map does NOT do: discover the required-name set on its own.
 * It only ever reports presence/absence for the eleven names it is handed
 * - it can never notice a twelfth name libuv might also force-inject that
 * isn't already on this list (the Windows e2e test's own separate
 * stray-keys check bounds THAT direction, by rejecting anything on the
 * real child outside {the caller's vars} union {this list} - so an
 * unlisted twelfth name would still be caught there, just not by this map
 * itself). A genuinely independent check - capturing the real child's
 * entire environment first, with no pre-selected list at all, then asking
 * what's actually in it - needs a real Windows host to run against, which
 * this project doesn't have (see WINDOWS_LIBUV_REQUIRED_ENV_VAR_NAMES's own
 * docs on where its eleven names come from instead). Recorded here as a
 * known, disclosed gap rather than left implicit.
 */
function buildAndEmitObservedWindowsRequiredEnvMap(
  requiredNames: readonly string[],
  serverByUpper: Map<string, string>,
  childByUpper: Map<string, string>,
  sink: (line: string) => void = console.log
): ObservedWindowsRequiredEnvPayload {
  const observedRequiredNames: ObservedWindowsRequiredEnvEntry[] = requiredNames.map((name) => ({
    name,
    serverHadItSet: serverByUpper.has(name.toUpperCase()),
    childReceivedIt: childByUpper.has(name.toUpperCase()),
  }));
  const payload: ObservedWindowsRequiredEnvPayload = {
    platform: process.platform,
    observedRequiredNames,
  };
  sink(`GHANTIKA_OBSERVED_WINDOWS_REQUIRED_ENV_MAP ${JSON.stringify(payload)}`);
  return payload;
}

test("buildAndEmitObservedWindowsRequiredEnvMap emits exactly one line, through its own marker, carrying a payload that round-trips - proven with a mock sink, on every platform, so this never needs a real Windows spawn or a real CI log to verify", () => {
  // This test's OWN hardcoded copy of the marker - deliberately NOT
  // imported or referenced from inside the function under test, so a
  // rename inside the function shows up here as a mismatch instead of
  // moving invisibly with both sides.
  const EXPECTED_MARKER = "GHANTIKA_OBSERVED_WINDOWS_REQUIRED_ENV_MAP";

  const capturedLines: string[] = [];
  const mockSink = (line: string) => {
    capturedLines.push(line);
  };

  // Deliberately mixed input - some required names present on the
  // "server", one of those NOT received by the "child", most entirely
  // absent - proves the two boolean fields are independently derived from
  // their own inputs, not the same check reported under two names, and
  // that the real Windows CI run's own all-true/true result is a property
  // of that one machine, not of this logic.
  const serverByUpper = new Map<string, string>([
    ["PATH", "C:\\server-path"],
    ["SYSTEMROOT", "C:\\Windows"],
    ["TEMP", "C:\\Temp"],
  ]);
  const childByUpper = new Map<string, string>([
    ["PATH", "C:\\server-path"],
    ["SYSTEMROOT", "C:\\Windows"],
    // TEMP deliberately omitted from the child.
  ]);

  const returned = buildAndEmitObservedWindowsRequiredEnvMap(
    INDEPENDENTLY_AUTHORED_WINDOWS_REQUIRED_ENV_VAR_NAMES,
    serverByUpper,
    childByUpper,
    mockSink
  );

  assert.equal(
    capturedLines.length,
    1,
    "the sink must be called exactly once - deleting the call inside the function, or calling it conditionally, changes this count"
  );

  const [line] = capturedLines;
  assert.ok(
    line !== undefined && line.startsWith(`${EXPECTED_MARKER} `),
    `the emitted line must start with this test's own independently-hardcoded marker "${EXPECTED_MARKER}" - it did not, meaning the marker inside the function has drifted from what a reader greps for`
  );

  // The single-physical-line property is the entire reason this exists
  // (see the function's own doc comment on why a multi-line emission is
  // not safe under a concurrent test runner) - and it is not otherwise
  // verified anywhere else. A trailing (or embedded) newline appended to
  // an otherwise-correct line would still pass every check above
  // (capturedLines.length is still 1, the marker prefix still matches,
  // and JSON.parse tolerates trailing whitespace including a newline) -
  // so this checks the property directly, not by inference from the
  // other assertions.
  assert.ok(
    !line!.includes("\n") && !line!.includes("\r"),
    "the emitted line must not contain any newline or carriage-return character anywhere in it - an embedded or trailing newline defeats the single-physical-line guarantee this function exists to provide, since a concurrent test file's own output could then land inside it exactly as it did before this was fixed"
  );

  const jsonText = line!.slice(EXPECTED_MARKER.length + 1);
  const parsed = JSON.parse(jsonText) as ObservedWindowsRequiredEnvPayload;

  assert.deepEqual(
    parsed,
    returned,
    "the parsed emitted line must deep-equal the function's own return value - if they diverge, the emission and the payload a caller's downstream assertions read are no longer the same data"
  );

  // A payload-level mutant that adds an unrelated key to the object BEFORE
  // it is either emitted or returned (rather than only to the emitted
  // serialization) would pass the deepEqual above unchanged - both sides
  // would carry the same extra key and still equal each other. These two
  // checks are what actually catch that: an exhaustive top-level key set,
  // and an exhaustive per-row key set for every one of the eleven entries,
  // not a sample of three.
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ["observedRequiredNames", "platform"].sort(),
    "the payload must have exactly these two top-level keys, no more - an extra key present on both the emitted and returned copies would not otherwise be caught, since they would still deep-equal each other"
  );

  assert.equal(parsed.platform, process.platform);
  assert.deepEqual(
    parsed.observedRequiredNames.map((entry) => entry.name),
    [...INDEPENDENTLY_AUTHORED_WINDOWS_REQUIRED_ENV_VAR_NAMES],
    "the emitted map must cover exactly this test file's own independent eleven-name list, in order - no omission, no extra, and not silently rebuilt from production's constant"
  );

  const byName = new Map(parsed.observedRequiredNames.map((entry) => [entry.name, entry]));
  assert.deepEqual(byName.get("PATH"), {
    name: "PATH",
    serverHadItSet: true,
    childReceivedIt: true,
  });
  assert.deepEqual(byName.get("TEMP"), {
    name: "TEMP",
    serverHadItSet: true,
    childReceivedIt: false,
  });
  assert.deepEqual(byName.get("HOMEDRIVE"), {
    name: "HOMEDRIVE",
    serverHadItSet: false,
    childReceivedIt: false,
  });

  for (const entry of parsed.observedRequiredNames) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["childReceivedIt", "name", "serverHadItSet"].sort(),
      `"${entry.name}" entry must have exactly these three keys, no more, checked on every row - not just the three sampled above`
    );
    assert.equal(
      typeof entry.serverHadItSet,
      "boolean",
      `"${entry.name}" serverHadItSet must be boolean`
    );
    assert.equal(
      typeof entry.childReceivedIt,
      "boolean",
      `"${entry.name}" childReceivedIt must be boolean`
    );
  }
});

test("buildAndEmitObservedWindowsRequiredEnvMap genuinely uses the requiredNames it's given, not a hardcoded or globally-imported list - proven by injecting a distinctive sentinel list matching neither the test-owned independent list nor production's constant", () => {
  // If this function ever stopped reading its own `requiredNames`
  // argument and read a module-level list instead (either this test
  // file's independent copy or production's constant), the output below
  // would come back as one of THOSE elevn real names, never these three
  // sentinels - because neither list contains them. Injecting the
  // argument, rather than relying on the two real lists happening to
  // differ (they don't, currently - see the parity test above), is what
  // makes this observable regardless of whether the two real lists ever
  // diverge.
  const sentinelNames = [
    "GHANTIKA_SENTINEL_ALPHA",
    "GHANTIKA_SENTINEL_BETA",
    "GHANTIKA_SENTINEL_GAMMA",
  ];
  const returned = buildAndEmitObservedWindowsRequiredEnvMap(
    sentinelNames,
    new Map(),
    new Map(),
    () => {}
  );
  assert.deepEqual(
    returned.observedRequiredNames.map((entry) => entry.name),
    sentinelNames,
    "the function must use exactly the injected requiredNames argument, in order - these sentinel names match neither the test-owned independent list nor production's constant, so their presence proves the argument (not some other list) drove the output"
  );
});

test(
  "env.mode 'replace' on Windows: the child receives EXACTLY the caller's vars plus whichever of libuv's own documented forced set the SERVER itself has set - nothing else, matched case-insensitively - and none of the SERVER's own random canary vars leak in (real spawn, real echo of the child's own process.env, checked against WINDOWS_LIBUV_REQUIRED_ENV_VAR_NAMES)",
  {
    skip:
      process.platform !== "win32"
        ? "Windows-only assertion - libuv's required-vars force-injection (see WINDOWS_LIBUV_REQUIRED_ENV_VAR_NAMES's docs in src/process.ts) is a win32-only libuv code path with no POSIX equivalent (verified against libuv's own POSIX spawn source, which adds nothing of its own)"
        : false,
  },
  async () => {
    const canaries = plantServerEnvCanaries(3, "WIN");
    const server = tracked();
    try {
      await completeHandshake(server);
      const dir = makeTempDir();
      const marker = path.join(dir, "child-env-windows-replace.json");
      // Deliberately omits PATH/SystemRoot/USERPROFILE, and every other
      // libuv-required name, from the caller's own vars - the entire point
      // of this test is observing exactly what Windows adds on its own
      // when the caller supplies none of it.
      const childEnv = await runAndCaptureRealChildEnv(server, 27, marker, {
        mode: "replace",
        vars: { ONLY_VAR: "only-value" },
      });

      const childByUpper = caseInsensitiveEnvLookup(childEnv);
      const serverByUpper = caseInsensitiveEnvLookup(process.env as Record<string, string>);

      // buildAndEmitObservedWindowsRequiredEnvMap's OWN doc comment covers
      // why this exists and how it's proven non-vacuous (own unconditional
      // unit test below, exercised with a mock sink on every platform).
      // Its RETURN VALUE, not a separately-built local, is what the
      // assertions right below read - deleting this call doesn't leave a
      // silent gap, it breaks `observedPayload` going out of scope and the
      // file fails to compile.
      const observedPayload = buildAndEmitObservedWindowsRequiredEnvMap(
        INDEPENDENTLY_AUTHORED_WINDOWS_REQUIRED_ENV_VAR_NAMES,
        serverByUpper,
        childByUpper
      );

      assert.deepEqual(
        observedPayload.observedRequiredNames.map((entry) => entry.name),
        [...INDEPENDENTLY_AUTHORED_WINDOWS_REQUIRED_ENV_VAR_NAMES],
        "the persisted map must cover exactly the eleven names on this test's own independent list, in order - no omission, no extra, and not silently rebuilt from production's constant"
      );
      for (const entry of observedPayload.observedRequiredNames) {
        assert.equal(
          typeof entry.serverHadItSet,
          "boolean",
          `"${entry.name}" entry's serverHadItSet must be a real boolean, not missing or the wrong type`
        );
        assert.equal(
          typeof entry.childReceivedIt,
          "boolean",
          `"${entry.name}" entry's childReceivedIt must be a real boolean, not missing or the wrong type`
        );
      }

      assert.equal(
        childEnv.ONLY_VAR,
        "only-value",
        "the caller's own var must be present, byte-for-byte"
      );

      // For every libuv-required name the SERVER itself actually has set,
      // the child must ALSO have it (case-insensitively), with the SAME
      // value - libuv sources an injected value via GetEnvironmentVariableW
      // on the spawning process (this ghantika server), never a fixed
      // OS-wide default (see the constant's own docs). Read off the
      // PERSISTED map above, not recomputed independently from
      // `serverByUpper` - so a bug in how that map decides `serverHadItSet`
      // (a hardcoded guess standing in for the real, live check) surfaces
      // here too, instead of this assertion quietly using its own separate,
      // correct computation while the persisted record is wrong.
      const expectedInjectedNames = observedPayload.observedRequiredNames
        .filter((entry) => entry.serverHadItSet)
        .map((entry) => entry.name);
      for (const name of expectedInjectedNames) {
        const upper = name.toUpperCase();
        assert.ok(
          childByUpper.has(upper),
          `the server itself has "${name}" set, so libuv must force-inject it into the child too - it did not`
        );
        assert.equal(
          childByUpper.get(upper),
          serverByUpper.get(upper),
          `injected "${name}"'s value must match the SERVER's own real value - it did not`
        );
      }

      // Nothing else: every key the child actually has must be either the
      // caller's own ONLY_VAR or one of libuv's documented required names -
      // never a stray, unexplained extra. This is what makes the claim
      // "exactly this documented set" rather than "approximately the right
      // vars" - a NAMED, FINITE, checked list, not an open-ended "Windows
      // does whatever it wants" excuse. Derived from this test's OWN
      // independent list (see above), so a bogus addition to production's
      // constant can never silently widen this allow-list.
      const allowedUpperNames = new Set([
        "ONLY_VAR",
        ...INDEPENDENTLY_AUTHORED_WINDOWS_REQUIRED_ENV_VAR_NAMES.map((name) => name.toUpperCase()),
      ]);
      const strayKeys = Object.keys(childEnv).filter(
        (key) => !allowedUpperNames.has(key.toUpperCase())
      );
      assert.deepEqual(
        strayKeys,
        [],
        `a replace-mode Windows child had key(s) outside {the caller's vars} union {libuv's documented required set}: ${strayKeys.join(", ")}`
      );

      // The canary check, explicit and direct - also already implied by
      // the stray-keys check above (a random canary's name can never
      // collide with the fixed required-vars list), kept as its own
      // assertion so the intent reads unambiguously.
      for (const key of Object.keys(canaries)) {
        assert.equal(
          childByUpper.has(key.toUpperCase()),
          false,
          `canary "${key}" (planted directly on the SERVER's own live env) must never reach a replace-mode child`
        );
      }
    } finally {
      clearServerEnvCanaries(canaries);
    }
    server.child.kill("SIGKILL");
  }
);

test(
  "env.mode 'replace' on Windows: when the caller explicitly supplies one of libuv's own required names (PATH), the caller's value wins - libuv's make_program_env() only fills in a required name that's MISSING from the input block, it never overrides one the caller already gave (real spawn, real echo of the child's own process.env)",
  {
    skip:
      process.platform !== "win32"
        ? "Windows-only assertion - this specific caller-supplied-vs-libuv-filled precedence only exists on the win32 code path; on POSIX, replace mode never adds or overrides anything of its own regardless of what the caller supplies"
        : false,
  },
  async () => {
    const server = tracked();
    await completeHandshake(server);
    const dir = makeTempDir();
    const marker = path.join(dir, "child-env-windows-replace-caller-supplied-path.json");
    const callerSuppliedPath = `C:\\ghantika-test-caller-supplied-path-${randomUUID()}`;
    const childEnv = await runAndCaptureRealChildEnv(server, 27, marker, {
      mode: "replace",
      vars: { PATH: callerSuppliedPath, ONLY_VAR: "only-value" },
    });
    const childByUpper = caseInsensitiveEnvLookup(childEnv);
    assert.equal(
      childByUpper.get("PATH"),
      callerSuppliedPath,
      "libuv must preserve the caller's own PATH value, not override it with the spawning process's own PATH - it only fills in a required name that's MISSING from the input block, per make_program_env()'s own logic"
    );
    server.child.kill("SIGKILL");
  }
);

test(
  "negative control (POSIX): if env.mode 'replace' silently fell back to merge mode's own minimal base, HOME would leak into a replace-mode child that never asked for it - proving the assertion above would actually catch that regression, not pass regardless of it",
  {
    skip:
      process.platform === "win32"
        ? "POSIX-only: this specific merge-vs-replace comparison is not a valid discriminator on Windows - libuv force-injects Windows' own base-overlapping names (PATH, a SystemRoot-equivalent, USERPROFILE) regardless of ghantika's own env.mode, so merge and replace legitimately produce overlapping key sets there; the Windows empirical test above (the exact-match assertion against WINDOWS_LIBUV_REQUIRED_ENV_VAR_NAMES) is that platform's own real proof instead"
        : false,
  },
  async () => {
    const server = tracked();
    await completeHandshake(server);
    const dir = makeTempDir();

    // Same empty vars, both modes, same real spawn mechanism, same real
    // server connection - the ONLY variable between these two calls is
    // env.mode itself.
    const mergeEnv = await runAndCaptureRealChildEnv(
      server,
      43,
      path.join(dir, "child-env-merge-control.json"),
      { mode: "merge", vars: {} }
    );
    const replaceEnv = await runAndCaptureRealChildEnv(
      server,
      44,
      path.join(dir, "child-env-replace-control.json"),
      { mode: "replace", vars: {} }
    );

    assert.ok(
      "HOME" in mergeEnv,
      "sanity check: merge mode's own minimal base really does add HOME when the caller doesn't - if this fails, the comparison below proves nothing"
    );
    assert.equal(
      "HOME" in replaceEnv,
      false,
      "replace mode must NOT have HOME - if replace's implementation silently reused merge mode's own minimal-base code path (the exact regression this test exists to catch), HOME would appear here too, and this assertion would go red"
    );
    server.child.kill("SIGKILL");
  }
);

test("negative control: if env.mode 'replace' silently included the server's FULL parent environment (a far worse bug than merely falling back to merge mode's own minimal base), a random canary planted directly on the server's own env would leak straight into the child - proving that bug class is caught too, on either platform", async () => {
  const canaries = plantServerEnvCanaries(1, "FULLLEAK");
  const server = tracked();
  const canaryKey = Object.keys(canaries)[0]!;
  const canaryValue = canaries[canaryKey]!;
  try {
    await completeHandshake(server);
    const dir = makeTempDir();
    const marker = path.join(dir, "child-env-full-leak-control.json");
    const childEnv = await runAndCaptureRealChildEnv(server, 45, marker, {
      mode: "replace",
      vars: { ONLY_VAR: "only-value" },
    });
    assert.equal(
      canaryKey in childEnv,
      false,
      "a replace-mode child must never receive the server's own arbitrary env var - if replace secretly passed through the server's FULL process.env, this canary would appear here and this assertion would go red"
    );
    assert.equal(
      JSON.stringify(childEnv).includes(canaryValue),
      false,
      "the canary's VALUE must never leak into the child env either, under any key"
    );
  } finally {
    clearServerEnvCanaries(canaries);
  }
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
