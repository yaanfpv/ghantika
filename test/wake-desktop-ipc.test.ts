import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DesktopIpcWakeTransport,
  IpcFrameDecoder,
  INITIALIZE_METHOD,
  NO_CLIENT_FOUND_SENTINEL,
  THREAD_FOLLOWER_START_TURN_METHOD,
  THREAD_OWNER_DISCOVERY_METHOD,
  buildStartTurnParams,
  encodeIpcFrame,
  evaluateSocketOwnership,
  interpretOwnerDiscoveryResult,
  isNoClientFoundMessage,
} from "../dist/wake/desktopIpcTransport.js";

// ---------------------------------------------------------------------------
// Wire framing - pure, no socket involved. Exercises the SAME
// encode/decode this transport's own IpcConnection uses, directly against
// synthetic buffers so a chunking or a length-prefix bug is caught without
// any real IPC round trip.
// ---------------------------------------------------------------------------

test("encodeIpcFrame + IpcFrameDecoder round-trip a message delivered as ONE chunk", () => {
  const decoder = new IpcFrameDecoder();
  const frame = encodeIpcFrame({ id: "1", method: "initialize", params: { clientType: "x" } });
  const messages = decoder.push(frame);
  assert.deepEqual(messages, [{ id: "1", method: "initialize", params: { clientType: "x" } }]);
});

test("IpcFrameDecoder reassembles a single frame delivered as several small chunks - the length prefix split across two pushes, then the body split across three more", () => {
  const decoder = new IpcFrameDecoder();
  const frame = encodeIpcFrame({ hello: "world", n: 12345 });
  // Split at byte 2 (inside the 4-byte length prefix itself), then feed the
  // rest in small pieces - a real socket delivers bytes with no regard for
  // message boundaries, so this decoder must never assume a chunk starts
  // or ends on a frame boundary.
  const pieces = [
    frame.subarray(0, 2),
    frame.subarray(2, 6),
    frame.subarray(6, 9),
    frame.subarray(9),
  ];
  const collected: unknown[] = [];
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    collected.push(...decoder.push(piece));
  }
  assert.deepEqual(collected, [{ hello: "world", n: 12345 }]);
});

test("IpcFrameDecoder parses two complete frames delivered together in ONE chunk, in arrival order", () => {
  const decoder = new IpcFrameDecoder();
  const combined = Buffer.concat([encodeIpcFrame({ id: "a" }), encodeIpcFrame({ id: "b" })]);
  const messages = decoder.push(combined);
  assert.deepEqual(messages, [{ id: "a" }, { id: "b" }]);
});

test("IpcFrameDecoder holds a partial frame across calls and only emits it once the rest arrives, mixed with a second complete frame", () => {
  const decoder = new IpcFrameDecoder();
  const first = encodeIpcFrame({ id: "first" });
  const second = encodeIpcFrame({ id: "second" });
  // First push: all of `first`, plus only the length-prefix of `second`.
  const firstPush = decoder.push(Buffer.concat([first, second.subarray(0, 4)]));
  assert.deepEqual(firstPush, [{ id: "first" }]);
  // Second push: the rest of `second`'s body.
  const secondPush = decoder.push(second.subarray(4));
  assert.deepEqual(secondPush, [{ id: "second" }]);
});

test("IpcFrameDecoder throws on a declared frame length exceeding the defensive MAX_IPC_FRAME_BYTES bound, before ever trying to buffer that many bytes", () => {
  const decoder = new IpcFrameDecoder();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(0xffffffff, 0); // ~4 GiB - nowhere near actually sent, this only needs to be past the bound
  assert.throws(() => decoder.push(header), /exceeding the .* defensive bound/);
});

test("IpcFrameDecoder throws when a complete frame's body is not valid JSON", () => {
  const decoder = new IpcFrameDecoder();
  const body = Buffer.from("not json {{{", "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  assert.throws(() => decoder.push(Buffer.concat([header, body])), /failed to parse as JSON/);
});

// ---------------------------------------------------------------------------
// evaluateSocketOwnership - pure, no real filesystem entity involved.
// Covers the uid-mismatch branch this file's own header discloses cannot
// be reached end-to-end in a normal test run (chowning a real socket to a
// different uid needs root).
// ---------------------------------------------------------------------------

test("evaluateSocketOwnership: ok when the stat describes a real socket owned by the current uid", () => {
  const result = evaluateSocketOwnership({ isSocket: () => true, uid: 501 }, 501);
  assert.deepEqual(result, { ok: true });
});

test("evaluateSocketOwnership: rejects a non-socket, naming that specifically rather than a generic failure", () => {
  const result = evaluateSocketOwnership({ isSocket: () => false, uid: 501 }, 501);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /not a unix domain socket/);
});

test("evaluateSocketOwnership: rejects a uid mismatch, naming both the socket's uid and this process's own uid - never a bare denial with no numbers", () => {
  const result = evaluateSocketOwnership({ isSocket: () => true, uid: 999 }, 501);
  assert.equal(result.ok, false);
  const reason = (result as { reason: string }).reason;
  assert.match(reason, /999/);
  assert.match(reason, /501/);
});

// ---------------------------------------------------------------------------
// interpretOwnerDiscoveryResult / isNoClientFoundMessage - pure, covering
// every "no owner" shape this transport's own header discloses it accepts
// without having measured the real app's exact wire spelling.
// ---------------------------------------------------------------------------

test("interpretOwnerDiscoveryResult: a real ownerId string is 'found'", () => {
  assert.deepEqual(interpretOwnerDiscoveryResult({ ownerId: "client-42" }), {
    kind: "found",
    ownerId: "client-42",
  });
});

test("interpretOwnerDiscoveryResult: a null ownerId is 'no-owner'", () => {
  assert.deepEqual(interpretOwnerDiscoveryResult({ ownerId: null }), { kind: "no-owner" });
});

test("interpretOwnerDiscoveryResult: an ownerId literally equal to the measured sentinel string is 'no-owner'", () => {
  assert.deepEqual(interpretOwnerDiscoveryResult({ ownerId: NO_CLIENT_FOUND_SENTINEL }), {
    kind: "no-owner",
  });
});

test("interpretOwnerDiscoveryResult: a reply missing ownerId entirely is 'malformed', never silently treated as either found or no-owner", () => {
  const outcome = interpretOwnerDiscoveryResult({ somethingElse: true });
  assert.equal(outcome.kind, "malformed");
});

test("interpretOwnerDiscoveryResult: a non-string, non-null ownerId (e.g. a number) is 'malformed'", () => {
  const outcome = interpretOwnerDiscoveryResult({ ownerId: 12345 });
  assert.equal(outcome.kind, "malformed");
});

test("isNoClientFoundMessage: true only when the sentinel text is actually present", () => {
  assert.equal(isNoClientFoundMessage(`owner lookup failed: ${NO_CLIENT_FOUND_SENTINEL}`), true);
  assert.equal(isNoClientFoundMessage("some unrelated failure"), false);
});

// ---------------------------------------------------------------------------
// buildStartTurnParams - the one params shape given as MEASURED ground
// truth verbatim in this story. Asserted as an exact deep-equal, not a
// partial/loose shape check, so any future drift from the measured facts
// is caught immediately.
// ---------------------------------------------------------------------------

test("buildStartTurnParams produces the exact measured turnStartParams shape", () => {
  assert.deepEqual(buildStartTurnParams("conv-1", "please continue"), {
    conversationId: "conv-1",
    turnStartParams: {
      input: [{ type: "text", text: "please continue", text_elements: [] }],
      model: null,
      effort: null,
      serviceTier: null,
      collaborationMode: null,
    },
  });
});

// ---------------------------------------------------------------------------
// A fake local Unix domain socket server implementing just enough of the
// length-prefixed protocol to exercise DesktopIpcWakeTransport realistically
// end to end - deliberately NOT built on top of this transport's own
// IpcFrameDecoder/encodeIpcFrame (only the pure framing tests above reuse
// those directly), so a bug shared between the transport's framing and a
// test-side reuse of the same code could not silently cancel out.
// ---------------------------------------------------------------------------

const FRAME_LEN = 4;

/** A minimal, independent length-prefixed frame reader for the fake server's own socket handling - see this section's header for why it does not reuse the transport's own IpcFrameDecoder. */
class ServerFrameReader {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: unknown[] = [];
    for (;;) {
      if (this.buffer.length < FRAME_LEN) break;
      const n = this.buffer.readUInt32LE(0);
      if (this.buffer.length < FRAME_LEN + n) break;
      const body = this.buffer.subarray(FRAME_LEN, FRAME_LEN + n);
      this.buffer = this.buffer.subarray(FRAME_LEN + n);
      out.push(JSON.parse(body.toString("utf8")));
    }
    return out;
  }
}

function encodeServerFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(FRAME_LEN);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
  readonly targetClientId: unknown;
}

/** `undefined` from a handler means "never reply" - used to exercise this transport's own request-timeout path. */
type FakeReplyHandler = (
  params: unknown,
  targetClientId: unknown
) => { readonly result?: unknown; readonly error?: unknown } | undefined;

interface FakeServerBehavior {
  readonly initialize?: FakeReplyHandler;
  readonly threadOwnerDiscovery?: FakeReplyHandler;
  readonly threadFollowerStartTurn?: FakeReplyHandler;
}

interface FakeServerHandle {
  readonly calls: RecordedCall[];
  readonly connectionCount: () => number;
  readonly close: () => Promise<void>;
}

const DEFAULT_BEHAVIOR: Required<FakeServerBehavior> = {
  initialize: () => ({ result: { clientId: "fake-client-1" } }),
  threadOwnerDiscovery: () => ({ result: { ownerId: "owner-client-1" } }),
  threadFollowerStartTurn: () => ({ result: { started: true } }),
};

function startFakeDesktopIpcServer(
  socketPath: string,
  behavior: FakeServerBehavior = {}
): Promise<FakeServerHandle> {
  const calls: RecordedCall[] = [];
  let connections = 0;
  const merged: Required<FakeServerBehavior> = { ...DEFAULT_BEHAVIOR, ...behavior };

  const server = net.createServer((socket) => {
    connections += 1;
    const reader = new ServerFrameReader();
    socket.on("data", (chunk: Buffer) => {
      for (const raw of reader.push(chunk)) {
        const message = raw as {
          id: string;
          method: string;
          params: unknown;
          targetClientId?: unknown;
        };
        calls.push({
          method: message.method,
          params: message.params,
          targetClientId: message.targetClientId,
        });

        let reply: { result?: unknown; error?: unknown } | undefined;
        if (message.method === INITIALIZE_METHOD) {
          reply = merged.initialize(message.params, message.targetClientId);
        } else if (message.method === THREAD_OWNER_DISCOVERY_METHOD) {
          reply = merged.threadOwnerDiscovery(message.params, message.targetClientId);
        } else if (message.method === THREAD_FOLLOWER_START_TURN_METHOD) {
          reply = merged.threadFollowerStartTurn(message.params, message.targetClientId);
        } else {
          reply = { error: { message: `fake server: unknown method "${message.method}"` } };
        }

        if (reply === undefined) continue; // simulate no reply at all - exercises this transport's own request timeout
        socket.write(encodeServerFrame({ id: message.id, ...reply }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      resolve({
        calls,
        connectionCount: () => connections,
        close: () =>
          new Promise((closeResolve) => {
            server.close(() => closeResolve());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

function fakeSocketPath(): { dir: string; socketPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-wake-ipc-"));
  return { dir, socketPath: path.join(dir, "s.sock") };
}

// ---------------------------------------------------------------------------
// probe() - the fencing/version-probing behavior described in this
// transport's own header, exercised end to end against a real socket
// (whether that socket is a fake server, a non-socket file, or absent
// entirely).
// ---------------------------------------------------------------------------

test("probe(): socket path does not exist at all - unavailable, naming the path", async () => {
  const { dir, socketPath } = fakeSocketPath(); // deliberately never created
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath });
    const capability = await transport.probe();
    assert.equal(capability.available, false);
    assert.match(
      capability.reason ?? "",
      new RegExp(socketPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
    assert.equal(typeof capability.probedAt, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe(): path exists but is an ordinary file, not a socket - unavailable, naming that specifically", async () => {
  const { dir, socketPath } = fakeSocketPath();
  writeFileSync(socketPath, "not a socket");
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath });
    const capability = await transport.probe();
    assert.equal(capability.available, false);
    assert.match(capability.reason ?? "", /not a unix domain socket/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe(): nothing listening on an otherwise-plausible socket path - unavailable, a connect failure never a crash", async () => {
  // A path that does not exist at all already covers the "does not exist"
  // branch above; this covers the DIFFERENT case of a real socket file
  // left behind with no live listener - net.createConnection must fail
  // to connect, and probe() must turn that into a stated reason rather
  // than a thrown exception reaching the caller.
  const { dir, socketPath } = fakeSocketPath();
  const server = await startFakeDesktopIpcServer(socketPath);
  await server.close(); // the socket FILE can remain on disk after close on some platforms; the listener is gone either way
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath, connectTimeoutMs: 300 });
    const capability = await transport.probe();
    assert.equal(capability.available, false);
    assert.equal(typeof capability.reason, "string");
    assert.ok((capability.reason ?? "").length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe(): a real fake server answering initialize correctly reports available:true, and connects EXACTLY once (no lingering connection kept open past the probe)", async () => {
  const { dir, socketPath } = fakeSocketPath();
  const server = await startFakeDesktopIpcServer(socketPath);
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath });
    const capability = await transport.probe();
    assert.deepEqual(capability.available, true);
    assert.equal(typeof capability.probedAt, "string");
    assert.equal(server.connectionCount(), 1);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe(): initialize is called with a real reply carrying a usable clientId, on every probe call - never cached across calls (probe() never caches its own result; this asserts probe() itself re-observes every time it is called)", async () => {
  const { dir, socketPath } = fakeSocketPath();
  const server = await startFakeDesktopIpcServer(socketPath);
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath });
    await transport.probe();
    await transport.probe();
    const initializeCalls = server.calls.filter((call) => call.method === INITIALIZE_METHOD);
    assert.equal(
      initializeCalls.length,
      2,
      "two probe() calls must each perform a fresh real observation"
    );
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe(): the fake server rejects initialize with a protocol-level error - unavailable, quoting the rejection, never a crash", async () => {
  const { dir, socketPath } = fakeSocketPath();
  const server = await startFakeDesktopIpcServer(socketPath, {
    initialize: () => ({ error: { message: "unsupported clientType" } }),
  });
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath });
    const capability = await transport.probe();
    assert.equal(capability.available, false);
    assert.match(capability.reason ?? "", /unsupported clientType/);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe(): the fake server replies to initialize with a shape carrying no usable clientId - unavailable, naming the missing clientId rather than crashing on the unexpected shape", async () => {
  const { dir, socketPath } = fakeSocketPath();
  const server = await startFakeDesktopIpcServer(socketPath, {
    initialize: () => ({ result: { somethingElseEntirely: true } }),
  });
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath });
    const capability = await transport.probe();
    assert.equal(capability.available, false);
    assert.match(capability.reason ?? "", /usable clientId/);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe(): the fake server never replies to initialize at all - unavailable once the request timeout elapses, and the wait is bounded by the configured timeout rather than hanging", async () => {
  const { dir, socketPath } = fakeSocketPath();
  const server = await startFakeDesktopIpcServer(socketPath, {
    initialize: () => undefined, // never reply
  });
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath, requestTimeoutMs: 200 });
    const startedAt = Date.now();
    const capability = await transport.probe();
    const elapsedMs = Date.now() - startedAt;
    assert.equal(capability.available, false);
    assert.match(capability.reason ?? "", /no reply within/);
    assert.ok(
      elapsedMs < 2000,
      `probe() must not hang well past its own configured timeout; took ${elapsedMs}ms`
    );
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe(): unavailable on a platform with no process.getuid (this transport's POSIX-only ownership check) - mocked, the same technique test/policy.test.ts already uses for its own win32-only branch", async () => {
  const { dir, socketPath } = fakeSocketPath();
  const server = await startFakeDesktopIpcServer(socketPath);
  const originalGetuid = process.getuid;
  try {
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    const transport = new DesktopIpcWakeTransport({ socketPath });
    const capability = await transport.probe();
    assert.equal(capability.available, false);
    assert.match(capability.reason ?? "", /process.getuid is unavailable/);
  } finally {
    Object.defineProperty(process, "getuid", { value: originalGetuid, configurable: true });
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// wake() - the full three-call sequence, the owner gate, and the
// never-retries/never-hangs guarantees described in this transport's own
// header.
// ---------------------------------------------------------------------------

test("wake(): the full sequence delivers - initialize, then thread-owner-discovery carrying the initialize clientId as hostId, then thread-follower-start-turn targeted at the discovered owner with the exact measured turnStartParams shape", async () => {
  const { dir, socketPath } = fakeSocketPath();
  const server = await startFakeDesktopIpcServer(socketPath, {
    initialize: () => ({ result: { clientId: "caller-client-9" } }),
    threadOwnerDiscovery: () => ({ result: { ownerId: "owner-client-7" } }),
  });
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath });
    const result = await transport.wake("conversation-abc", "please resume");

    assert.equal(result.outcome, "delivered");
    assert.equal(result.transportName, "chatgpt-desktop-ipc");
    assert.match(result.detail ?? "", /conversation-abc/);
    assert.match(result.detail ?? "", /owner-client-7/);

    assert.equal(server.calls.length, 3);
    const [init, discovery, startTurn] = server.calls;
    assert.equal(init!.method, INITIALIZE_METHOD);

    assert.equal(discovery!.method, THREAD_OWNER_DISCOVERY_METHOD);
    assert.deepEqual(discovery!.params, {
      hostId: "caller-client-9",
      conversationId: "conversation-abc",
    });

    assert.equal(startTurn!.method, THREAD_FOLLOWER_START_TURN_METHOD);
    assert.equal(startTurn!.targetClientId, "owner-client-7");
    assert.deepEqual(startTurn!.params, buildStartTurnParams("conversation-abc", "please resume"));
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wake(): OWNER GATE - no client has the thread open (ownerId: null) - refused, quoting the measured no-client-found sentinel, and thread-follower-start-turn is NEVER sent (proving this transport never forges or routes around the gate)", async () => {
  const { dir, socketPath } = fakeSocketPath();
  const server = await startFakeDesktopIpcServer(socketPath, {
    threadOwnerDiscovery: () => ({ result: { ownerId: null } }),
  });
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath });
    const result = await transport.wake("conversation-not-open", "hello");

    assert.equal(result.outcome, "refused");
    assert.match(result.detail ?? "", new RegExp(NO_CLIENT_FOUND_SENTINEL));

    const startTurnCalls = server.calls.filter(
      (call) => call.method === THREAD_FOLLOWER_START_TURN_METHOD
    );
    assert.equal(
      startTurnCalls.length,
      0,
      "no owner was ever discovered, so start-turn must never be attempted"
    );
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wake(): OWNER GATE - discovery answers with a protocol-level error mentioning the no-client-found sentinel (the alternate wire shape this transport's header discloses it also accepts) - refused, never treated as a generic failure", async () => {
  const { dir, socketPath } = fakeSocketPath();
  const server = await startFakeDesktopIpcServer(socketPath, {
    threadOwnerDiscovery: () => ({
      error: { message: `lookup failed: ${NO_CLIENT_FOUND_SENTINEL}` },
    }),
  });
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath });
    const result = await transport.wake("conversation-x", "hello");
    assert.equal(result.outcome, "refused");
    const startTurnCalls = server.calls.filter(
      (call) => call.method === THREAD_FOLLOWER_START_TURN_METHOD
    );
    assert.equal(startTurnCalls.length, 0);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wake(): OWNER GATE race - an owner IS discovered, but the app's own internal enforcement still refuses start-turn (the window closed in between) - refused, not unavailable, the same disclosed boundary as the up-front no-owner case", async () => {
  const { dir, socketPath } = fakeSocketPath();
  const server = await startFakeDesktopIpcServer(socketPath, {
    threadOwnerDiscovery: () => ({ result: { ownerId: "owner-client-1" } }),
    threadFollowerStartTurn: () => ({ error: { message: NO_CLIENT_FOUND_SENTINEL } }),
  });
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath });
    const result = await transport.wake("conversation-race", "hello");
    assert.equal(result.outcome, "refused");
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wake(): a genuinely unexpected start-turn rejection (NOT owner-related) is unavailable, never misreported as refused", async () => {
  const { dir, socketPath } = fakeSocketPath();
  const server = await startFakeDesktopIpcServer(socketPath, {
    threadFollowerStartTurn: () => ({ error: { message: "internal app error: renderer crashed" } }),
  });
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath });
    const result = await transport.wake("conversation-y", "hello");
    assert.equal(result.outcome, "unavailable");
    assert.match(result.detail ?? "", /renderer crashed/);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wake(): nothing listening at all - unavailable, never a thrown exception reaching the caller", async () => {
  const { dir, socketPath } = fakeSocketPath(); // never created
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath, connectTimeoutMs: 300 });
    const result = await transport.wake("conversation-z", "hello");
    assert.equal(result.outcome, "unavailable");
    assert.equal(typeof result.detail, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wake(): NEVER RETRIES - exactly one connection is made per wake() call, whether it succeeds or is refused/unavailable, so a failed attempt returns promptly rather than presenting as a hang", async () => {
  const { dir, socketPath } = fakeSocketPath();
  const server = await startFakeDesktopIpcServer(socketPath, {
    threadOwnerDiscovery: () => ({ result: { ownerId: null } }),
  });
  try {
    const transport = new DesktopIpcWakeTransport({ socketPath });
    await transport.wake("conversation-refused", "hello");
    assert.equal(server.connectionCount(), 1);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wake(): a wholly unresponsive server (never replies to initialize) still returns within a bounded ceiling derived from the configured timeouts, never hangs past it", async () => {
  const { dir, socketPath } = fakeSocketPath();
  const server = await startFakeDesktopIpcServer(socketPath, {
    initialize: () => undefined,
  });
  try {
    const requestTimeoutMs = 200;
    const transport = new DesktopIpcWakeTransport({ socketPath, requestTimeoutMs });
    const startedAt = Date.now();
    const result = await transport.wake("conversation-hang", "hello");
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.outcome, "unavailable");
    assert.ok(
      elapsedMs < requestTimeoutMs * 4,
      `wake() must stay bounded; took ${elapsedMs}ms against a ${requestTimeoutMs}ms request timeout`
    );
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
