// AC5 for story-0264: the token is a credential and never appears anywhere
// this transport can produce - not in a `Capability`, not in a
// `WakeResult`, not in any `detail`/`reason` string. This is a public
// repo with public CI logs, so a token surfacing in any of those is a
// real leak, not a cosmetic one.
//
// The assertion helper below is itself proven non-vacuous by a NEGATIVE
// CONTROL (see "the leak-detector itself..." below): a fixture that
// DELIBERATELY embeds the token is run through the exact same helper
// first, and the helper is asserted to catch it, before the helper is
// trusted against the real transport's real outputs.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { ClaudeMessagingWakeTransport } from "../dist/wake/claudeMessagingTransport.js";

const FAKE_TOKEN = "SECRET-TOKEN-MUST-NEVER-LEAK-88f3ac21";

/**
 * Fails loudly if `haystack`'s own JSON serialization contains `needle`
 * anywhere - the shape of check AC5 asks for ("a check that would RED if
 * it ever leaks"). Serializing first (rather than scanning object values
 * field-by-field) means a future field added to `Capability`/`WakeResult`
 * is covered automatically, with no matching update required here.
 */
function assertNeverContains(haystack: unknown, needle: string, label: string): void {
  const serialized = JSON.stringify(haystack);
  assert.ok(
    !serialized.includes(needle),
    `${label} must never contain the token, but it does: ${serialized}`
  );
}

let tmpDir: string;
let acceptingServer: Server;
let acceptingSocketPath: string;
let droppingServer: Server;
let droppingSocketPath: string;

before(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "ghantika-token-leak-"));

  acceptingSocketPath = path.join(tmpDir, "accepting.sock");
  acceptingServer = createServer((socket) => {
    // Accepts and holds the connection open - the "delivered" shape.
    socket.on("data", () => {
      /* intentionally ignore payload content */
    });
  });
  await new Promise<void>((resolve) => acceptingServer.listen(acceptingSocketPath, resolve));

  droppingSocketPath = path.join(tmpDir, "dropping.sock");
  droppingServer = createServer((socket) => {
    // Destroys on a macrotask delay, never synchronously in the
    // "connection" handler - a synchronous destroy can race the client's
    // own "connect" event and surface as a connect failure instead of the
    // intended post-connect drop, which is the shape this fixture exists
    // to reproduce (a real auth-rejecting server accepts the connection
    // before it inspects and rejects the auth line).
    setTimeout(() => socket.destroy(), 10);
  });
  await new Promise<void>((resolve) => droppingServer.listen(droppingSocketPath, resolve));
});

after(() => {
  acceptingServer.close();
  droppingServer.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("the leak-detector itself catches a planted leak (negative control, run first)", () => {
  const plantedLeak = {
    outcome: "delivered",
    detail: `wake accepted using token ${FAKE_TOKEN}`,
  };
  assert.throws(
    () => assertNeverContains(plantedLeak, FAKE_TOKEN, "planted-leak fixture"),
    /must never contain the token/,
    "assertNeverContains must RED on a fixture that actually embeds the token - " +
      "a helper that cannot fail on a real leak proves nothing about the real transport"
  );
});

test("probe(): available (accepted) never surfaces the token", async () => {
  const transport = new ClaudeMessagingWakeTransport({
    env: {
      CLAUDE_CODE_MESSAGING_SOCKET: acceptingSocketPath,
      CLAUDE_CODE_MESSAGING_TOKEN: FAKE_TOKEN,
    },
  });
  const capability = await transport.probe();
  assert.equal(capability.available, true);
  assertNeverContains(capability, FAKE_TOKEN, "probe() available capability");
});

test("probe(): dropped (auth rejected) never surfaces the token", async () => {
  const transport = new ClaudeMessagingWakeTransport({
    env: {
      CLAUDE_CODE_MESSAGING_SOCKET: droppingSocketPath,
      CLAUDE_CODE_MESSAGING_TOKEN: FAKE_TOKEN,
    },
  });
  const capability = await transport.probe();
  assert.equal(capability.available, false);
  assertNeverContains(capability, FAKE_TOKEN, "probe() dropped capability");
});

test("probe(): connect-failed (no such socket) never surfaces the token", async () => {
  const transport = new ClaudeMessagingWakeTransport({
    env: {
      CLAUDE_CODE_MESSAGING_SOCKET: path.join(tmpDir, "does-not-exist.sock"),
      CLAUDE_CODE_MESSAGING_TOKEN: FAKE_TOKEN,
    },
  });
  const capability = await transport.probe();
  assert.equal(capability.available, false);
  assertNeverContains(capability, FAKE_TOKEN, "probe() connect-failed capability");
});

test("probe(): unavailable (no inherited env) never surfaces the token - the token was never set, so this also proves the negative case has nothing to leak", async () => {
  const transport = new ClaudeMessagingWakeTransport({ env: {} });
  const capability = await transport.probe();
  assert.equal(capability.available, false);
  assertNeverContains(capability, FAKE_TOKEN, "probe() unavailable capability");
});

test("wake(): delivered never surfaces the token", async () => {
  const transport = new ClaudeMessagingWakeTransport({
    env: {
      CLAUDE_CODE_MESSAGING_SOCKET: acceptingSocketPath,
      CLAUDE_CODE_MESSAGING_TOKEN: FAKE_TOKEN,
    },
  });
  const result = await transport.wake({ hint: "AC5-test" }, "AC5 test payload");
  assert.equal(result.outcome, "delivered");
  assertNeverContains(result, FAKE_TOKEN, "wake() delivered result");
});

test("wake(): refused (dropped) never surfaces the token", async () => {
  const transport = new ClaudeMessagingWakeTransport({
    env: {
      CLAUDE_CODE_MESSAGING_SOCKET: droppingSocketPath,
      CLAUDE_CODE_MESSAGING_TOKEN: FAKE_TOKEN,
    },
  });
  const result = await transport.wake({ hint: "AC5-test" }, "AC5 test payload");
  assert.equal(result.outcome, "refused");
  assertNeverContains(result, FAKE_TOKEN, "wake() refused result");
});

test("wake(): unavailable (no inherited env) never surfaces the token", async () => {
  const transport = new ClaudeMessagingWakeTransport({ env: {} });
  const result = await transport.wake({ hint: "AC5-test" }, "AC5 test payload");
  assert.equal(result.outcome, "unavailable");
  assertNeverContains(result, FAKE_TOKEN, "wake() unavailable result");
});
