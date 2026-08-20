/**
 * `ClaudeMessagingWakeTransport`'s own `Capability.permanent`/
 * `WakeResult.permanent` reporting - see `src/wake/wakeTransport.ts`'s own
 * docs on the bar those fields have to clear. This transport's only
 * genuinely PERMANENT-for-this-process failure mode is one of its two
 * inherited env vars being absent or empty.
 *
 * Reuses `test/wake-claude-messaging-token-leak.test.ts`'s own real socket
 * fixture shape (a dedicated Unix socket accepting or dropping the
 * connection), scoped to which outcomes are PERMANENT and which are
 * SITUATIONAL.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { ClaudeMessagingWakeTransport } from "../dist/wake/claudeMessagingTransport.js";

let tmpDir: string;
let acceptingServer: Server;
let acceptingSocketPath: string;
let droppingServer: Server;
let droppingSocketPath: string;

before(async () => {
  // Kept SHORT deliberately - a Unix domain socket path is bound by
  // sockaddr_un.sun_path (104 bytes on macOS/BSD, including the null
  // terminator), and os.tmpdir() itself is already long on macOS
  // (/var/folders/<hash>/<hash>/T/), so a verbose prefix here plus
  // mkdtemp's own random suffix plus "/accepting.sock" can silently
  // exceed that bound and leave listen() neither resolving nor rejecting
  // the awaited promise below, rather than failing loud.
  tmpDir = mkdtempSync(path.join(tmpdir(), "ghantika-cm-perm-"));

  acceptingSocketPath = path.join(tmpDir, "accepting.sock");
  acceptingServer = createServer((socket) => {
    socket.on("data", () => {
      /* intentionally ignore payload content - see this file's own header */
    });
  });
  await new Promise<void>((resolve) => acceptingServer.listen(acceptingSocketPath, resolve));

  // Same "destroy on a macrotask delay" shape as the token-leak file's own
  // fixture, and for the identical reason - a synchronous destroy can race
  // the client's own "connect" event and surface as connect-failed instead
  // of the intended post-connect drop.
  droppingSocketPath = path.join(tmpDir, "dropping.sock");
  droppingServer = createServer((socket) => {
    setTimeout(() => socket.destroy(), 10);
  });
  await new Promise<void>((resolve) => droppingServer.listen(droppingSocketPath, resolve));
});

after(() => {
  acceptingServer.close();
  droppingServer.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// PERMANENT - the two inherited-env-var-missing branches, on both probe()
// and wake()'s own defensive duplicate check.
// ---------------------------------------------------------------------------

test("probe(): permanent:true when CLAUDE_CODE_MESSAGING_SOCKET is not set - fixed at this process's spawn time, can never resolve later in this same process", async () => {
  const transport = new ClaudeMessagingWakeTransport({
    env: { CLAUDE_CODE_MESSAGING_TOKEN: "irrelevant" },
  });
  const capability = await transport.probe();
  assert.equal(capability.available, false);
  assert.equal(capability.permanent, true);
});

test("probe(): permanent:true when CLAUDE_CODE_MESSAGING_TOKEN is not set - same structural reason as the socket-path case above", async () => {
  const transport = new ClaudeMessagingWakeTransport({
    env: { CLAUDE_CODE_MESSAGING_SOCKET: acceptingSocketPath },
  });
  const capability = await transport.probe();
  assert.equal(capability.available, false);
  assert.equal(capability.permanent, true);
});

test("probe(): permanent:true when neither env var is set at all", async () => {
  const transport = new ClaudeMessagingWakeTransport({ env: {} });
  const capability = await transport.probe();
  assert.equal(capability.available, false);
  assert.equal(capability.permanent, true);
});

test("wake(): permanent:true on the same missing-env branch, matching probe()'s own claim for the identical reason (this branch is defensive/normally unreachable per the WakeTransport contract - see this transport's own comment on it - but if reached, the reason is genuinely structural)", async () => {
  const transport = new ClaudeMessagingWakeTransport({ env: {} });
  const result = await transport.wake({ hint: "permanence-test" }, "payload");
  assert.equal(result.outcome, "unavailable");
  assert.equal(result.permanent, true);
});

// ---------------------------------------------------------------------------
// SITUATIONAL - a real connection attempt that failed. None of these ever
// claims permanence: a caller retrying later (once a daemon starts, once
// the socket comes back) could plausibly get a different answer.
// ---------------------------------------------------------------------------

test("probe(): permanent is NOT true when the socket path does not exist (connect-failed) - situational, something could start listening there later", async () => {
  const transport = new ClaudeMessagingWakeTransport({
    env: {
      CLAUDE_CODE_MESSAGING_SOCKET: path.join(tmpDir, "does-not-exist.sock"),
      CLAUDE_CODE_MESSAGING_TOKEN: "irrelevant",
    },
  });
  const capability = await transport.probe();
  assert.equal(capability.available, false);
  assert.notEqual(capability.permanent, true);
});

test("probe(): permanent is NOT true when the inherited token is not accepted (dropped) - a live auth rejection this run, never a structural fact about this process", async () => {
  const transport = new ClaudeMessagingWakeTransport({
    env: {
      CLAUDE_CODE_MESSAGING_SOCKET: droppingSocketPath,
      CLAUDE_CODE_MESSAGING_TOKEN: "irrelevant",
    },
  });
  const capability = await transport.probe();
  assert.equal(capability.available, false);
  assert.notEqual(capability.permanent, true);
});

test("wake(): permanent is NOT true on a refused (dropped) outcome", async () => {
  const transport = new ClaudeMessagingWakeTransport({
    env: {
      CLAUDE_CODE_MESSAGING_SOCKET: droppingSocketPath,
      CLAUDE_CODE_MESSAGING_TOKEN: "irrelevant",
    },
  });
  const result = await transport.wake({ hint: "permanence-test" }, "payload");
  assert.equal(result.outcome, "refused");
  assert.notEqual(result.permanent, true);
});

test("wake(): permanent is NOT true on a connect-failed (unavailable) outcome", async () => {
  const transport = new ClaudeMessagingWakeTransport({
    env: {
      CLAUDE_CODE_MESSAGING_SOCKET: path.join(tmpDir, "does-not-exist.sock"),
      CLAUDE_CODE_MESSAGING_TOKEN: "irrelevant",
    },
  });
  const result = await transport.wake({ hint: "permanence-test" }, "payload");
  assert.equal(result.outcome, "unavailable");
  assert.notEqual(result.permanent, true);
});

// ---------------------------------------------------------------------------
// DELIVERED - permanence is not a meaningful claim about a wake that
// succeeded; this transport never sets it there.
// ---------------------------------------------------------------------------

test("wake(): delivered never carries a permanent claim", async () => {
  const transport = new ClaudeMessagingWakeTransport({
    env: {
      CLAUDE_CODE_MESSAGING_SOCKET: acceptingSocketPath,
      CLAUDE_CODE_MESSAGING_TOKEN: "irrelevant",
    },
  });
  const result = await transport.wake({ hint: "permanence-test" }, "payload");
  assert.equal(result.outcome, "delivered");
  assert.equal(result.permanent, undefined);
});
