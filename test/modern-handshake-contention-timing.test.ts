/**
 * The subset of test/modern-handshake.test.ts's own negative-control cases
 * whose verdict depends on a real spawned orphan child process settling
 * (or failing to settle) within a real wall-clock bound - the same
 * production-evidenced failure class commit da343f0 (#137, reverted)
 * describes: "shutdown's real job-reap" is one of the three guarantees
 * this file's negative-control fixture variants each independently confirm
 * by removing it and observing the real absence on the wire, via a genuine
 * spawned orphan + a real `process.kill(pid, 0)` existence-probe poll
 * (`waitForReaped`).
 *
 * Moved into their own file for the same reason as
 * test/process-contention-timing.test.ts - see that file - so this class
 * does not cost the parent file's much larger set of protocol-negotiation
 * tests their own concurrency. No assertion, fixture, or timing bound
 * changed by the move.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  type SpawnedServer,
  completeHandshake,
  initializedNotification,
  spawnServer,
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

/**
 * Polls a real `process.kill(pid, 0)` existence probe until the pid is
 * reaped or `timeoutMs` elapses. `waitForExit()` resolves on Node's own
 * exit event for the CHILD it spawned directly - it does not guarantee
 * the OS has finished reporting every descendant pid as gone, so a
 * single immediate check right after it is racing real OS bookkeeping
 * under host load. This does not weaken what the check proves: an
 * implementation that never reaps the pid still exhausts the whole
 * bound and fails exactly as before. It only tolerates the OS taking a
 * moment, which was never the property under test.
 */
async function waitForReaped(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isProcessAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// Extracted tests
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
      await waitForReaped(pid!, 3_000),
      true,
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
    // Explicit generous bound, not the bare default: this line's property
    // is proven by the reply's CONTENT (must correlate to id 501, never to
    // the malformed line), not by how fast it arrives, so widening this
    // wait costs nothing - it only gives a real child-process round trip
    // more room under host contention. A mutant that replies to the
    // malformed line is still caught by the correlation assert below at
    // any bound.
    const parseLine = await server.nextLine(10_000);
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
      await waitForReaped(pid!, 3_000),
      true,
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
