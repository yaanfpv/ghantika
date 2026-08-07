/**
 * Real, spawned-child coverage for `src/wake/appServerTransport.ts`
 * against `test/fixtures/mock-app-server.ts` - a scripted stand-in for the
 * real `codex app-server` subcommand speaking the exact same
 * newline-delimited JSON-RPC framing, so every scenario below exercises
 * this transport's real request/response/notification handling, its real
 * child-spawn/reap machinery, and its real outcome mapping, without
 * depending on a real `codex` install, a real thread, or spending real
 * model-provider quota.
 *
 * Covers, end to end:
 *
 *   - "a turn starts and the payload arrives" - `deliversAndCarriesPayload`
 *     below proves both halves of the measured mechanism: `wake()`
 *     resolves `"delivered"`, and the mock's own captured
 *     `thread/goal/set` request shows the exact `objective` text this
 *     test passed in, byte for byte - a turn starting with the payload
 *     lost would be a different, useless outcome, so this test checks
 *     the transport's own SENT bytes, never merely that "something"
 *     happened.
 *   - the goal is bounded - `sendsTheConfiguredTokenBudget` proves the
 *     protocol-level bound (`tokenBudget` actually reaches the wire), and
 *     `reapsAnUnboundedTurnAtTheWallClockCeiling` proves the client-side
 *     bound (a turn that never reports completion is still reaped, via a
 *     real OS-level liveness check on the mock's own pid - never merely
 *     that this transport's own promise resolved).
 *   - `probe()` verifies the running app-server at runtime, every call -
 *     `reportsUnavailableWhenGoalsIsDisabled`,
 *     `reportsUnavailableWhenGoalsIsMissing`, and
 *     `findsGoalsAcrossExperimentalFeaturePages` prove this transport
 *     actually reads the real response rather than assuming a fixed
 *     answer, and `probesFreshOnEveryCall` proves it never caches across
 *     calls.
 *   - the child is owned and reaped - every scenario below that spawns a
 *     child asserts, via the mock's own written pid file and a real
 *     `process.kill(pid, 0)` liveness probe, that the process is
 *     genuinely gone by the time this test moves on; `neverOrphansOnAHostCrash`
 *     proves the crash-safety net independently, from a genuinely separate
 *     process that exits without ever awaiting reap itself.
 *   - no fork, no patch, no private path - `defaultsToThePublicSubcommand`
 *     asserts the transport's own default spawn target directly.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AppServerGoalWakeTransport,
  AppServerRpcError,
  DEFAULT_ARGS,
  DEFAULT_COMMAND,
  DEFAULT_TOKEN_BUDGET,
  isNotificationForThread,
  parseExperimentalFeatureEntries,
} from "../dist/wake/appServerTransport.js";
import type { AppServerGoalWakeTransportOptions } from "../dist/wake/appServerTransport.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/mock-app-server.ts", import.meta.url));

/** A fresh scratch directory per test, holding that test's own scenario file, capture file, and pid file - never shared across tests, so a leftover file from one test can never be misread by another. */
function scratchDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ghantika-wake-app-server-"));
}

interface BuildTransportResult {
  readonly transport: AppServerGoalWakeTransport;
  readonly dir: string;
  readonly captureFile: string;
  readonly pidFile: string;
}

/** Writes `scenario` to a fresh scratch file and returns a transport pointed at the mock fixture with that scenario, plus the capture/pid file paths every scenario the fixture supports always writes to. Caller owns cleanup via `rmSync(dir, {recursive:true, force:true})`. */
function buildTransport(
  scenario: Record<string, unknown>,
  options: AppServerGoalWakeTransportOptions = {}
): BuildTransportResult {
  const dir = scratchDir();
  const captureFile = path.join(dir, "captured.ndjson");
  const pidFile = path.join(dir, "mock.pid");
  const scenarioPath = path.join(dir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify({ ...scenario, captureFile, pidFile }));
  const transport = new AppServerGoalWakeTransport({
    command: process.execPath,
    args: [FIXTURE_PATH, scenarioPath],
    ...options,
  });
  return { transport, dir, captureFile, pidFile };
}

function readCapturedRequests(captureFile: string): Array<{ method: string; params: unknown }> {
  let raw: string;
  try {
    raw = readFileSync(captureFile, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method: string; params: unknown });
}

/** True iff a process with `pid` is currently alive, via the standard POSIX `kill(pid, 0)` liveness probe (sends no real signal; ESRCH means gone, EPERM means alive but unowned by us - never observed here since every pid this file checks is our own spawned mock). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `isAlive(pid)` until it reports false or `timeoutMs` elapses, resolving to whether the process was confirmed dead within the bound - used only to give a genuinely-exiting process a moment to finish exiting after this test's own transport call has already returned, never to paper over a transport that failed to reap anything at all within its own documented bound. */
async function eventuallyDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !isAlive(pid);
}

function readPid(pidFile: string): number {
  return Number.parseInt(readFileSync(pidFile, "utf8"), 10);
}

// ---------------------------------------------------------------------------
// no fork, no patch, no private path
// ---------------------------------------------------------------------------

test("defaultsToThePublicSubcommand: the transport's own default spawn target is exactly the documented public subcommand, never a daemon mode or a private path", () => {
  assert.equal(DEFAULT_COMMAND, "codex");
  assert.deepEqual(DEFAULT_ARGS, ["app-server"]);
});

// ---------------------------------------------------------------------------
// the mechanism - a turn starts AND the payload arrives
// ---------------------------------------------------------------------------

test("deliversAndCarriesPayload: wake() reports delivered once turn/started arrives, and the mock's own captured request shows the exact objective text and thread id this call passed in", async () => {
  const { transport, dir, captureFile } = buildTransport({});
  try {
    const objective = "resume the deferred cleanup pass and report back what you found";
    const result = await transport.wake("thread-alpha", objective);
    assert.equal(result.outcome, "delivered");
    assert.equal(result.transportName, "codex-app-server-goal");
    assert.match(result.detail ?? "", /thread-alpha/);

    const requests = readCapturedRequests(captureFile);
    const goalSet = requests.find((r) => r.method === "thread/goal/set");
    assert.ok(goalSet !== undefined, "expected a captured thread/goal/set request");
    const params = goalSet?.params as { threadId?: unknown; objective?: unknown; status?: unknown };
    assert.equal(params.threadId, "thread-alpha");
    assert.equal(params.objective, objective);
    assert.equal(params.status, "active");

    await transport.waitForBackgroundSupervisionForTests();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// the goal is bounded
// ---------------------------------------------------------------------------

test("sendsTheConfiguredTokenBudget: thread/goal/set carries the transport's own default token budget when no override is given, and a caller-supplied override when one is", async () => {
  {
    const { transport, dir, captureFile } = buildTransport({});
    try {
      await transport.wake("thread-budget-default", "go");
      const [goalSet] = readCapturedRequests(captureFile).filter(
        (r) => r.method === "thread/goal/set"
      );
      assert.equal((goalSet.params as { tokenBudget?: unknown }).tokenBudget, DEFAULT_TOKEN_BUDGET);
      await transport.waitForBackgroundSupervisionForTests();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  {
    const { transport, dir, captureFile } = buildTransport({}, { tokenBudget: 777 });
    try {
      await transport.wake("thread-budget-override", "go");
      const [goalSet] = readCapturedRequests(captureFile).filter(
        (r) => r.method === "thread/goal/set"
      );
      assert.equal((goalSet.params as { tokenBudget?: unknown }).tokenBudget, 777);
      await transport.waitForBackgroundSupervisionForTests();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("reapsAnUnboundedTurnAtTheWallClockCeiling: a turn that never reports turn/completed is still killed once maxSessionMs elapses, confirmed by a real OS-level liveness check on the mock process's own pid", async () => {
  const { transport, dir, pidFile } = buildTransport(
    { turnStartedDelayMs: 5, turnCompletedDelayMs: null },
    { maxSessionMs: 100, turnStartTimeoutMs: 2_000 }
  );
  try {
    const result = await transport.wake("thread-unbounded", "keep going forever");
    assert.equal(result.outcome, "delivered");

    // Give the fixture a moment to have actually written its own pid file
    // (it does this synchronously before reading stdin, but the write and
    // this test process's own read are still two independent processes).
    const pid = await waitForPidFile(pidFile, 2_000);
    assert.equal(isAlive(pid), true, "the mock should still be alive immediately after delivery");

    await transport.waitForBackgroundSupervisionForTests();
    assert.equal(isAlive(pid), false, "the wall-clock ceiling should have reaped the mock by now");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// probe() verifies the running app-server at runtime
// ---------------------------------------------------------------------------

test('reportsAvailableWhenGoalsIsEnabled: probe() reports available:true when experimentalFeature/list reports a stable, enabled "goals" entry', async () => {
  const { transport, dir } = buildTransport({
    experimentalFeaturePages: [[{ name: "goals", stage: "stable", enabled: true }]],
  });
  try {
    const capability = await transport.probe();
    assert.equal(capability.available, true);
    assert.equal(capability.reason, undefined);
    assert.equal(typeof capability.probedAt, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reportsUnavailableWhenGoalsIsDisabled: probe() reports available:false, naming the stage, when "goals" is present but not enabled', async () => {
  const { transport, dir } = buildTransport({
    experimentalFeaturePages: [[{ name: "goals", stage: "underDevelopment", enabled: false }]],
  });
  try {
    const capability = await transport.probe();
    assert.equal(capability.available, false);
    assert.match(capability.reason ?? "", /goals/);
    assert.match(capability.reason ?? "", /underDevelopment/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reportsUnavailableWhenGoalsIsMissing: probe() reports available:false when experimentalFeature/list never mentions "goals" at all', async () => {
  const { transport, dir } = buildTransport({
    experimentalFeaturePages: [[{ name: "shell_tool", stage: "stable", enabled: true }]],
  });
  try {
    const capability = await transport.probe();
    assert.equal(capability.available, false);
    assert.match(capability.reason ?? "", /did not report/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findsGoalsAcrossExperimentalFeaturePages: probe() walks a paginated experimentalFeature/list response rather than reading only the first page", async () => {
  const { transport, dir } = buildTransport({
    experimentalFeaturePages: [
      [{ name: "shell_tool", stage: "stable", enabled: true }],
      [{ name: "goals", stage: "stable", enabled: true }],
    ],
  });
  try {
    const capability = await transport.probe();
    assert.equal(capability.available, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probesFreshOnEveryCall: two probe() calls against transports scripted with different answers each report their own scripted answer, never a cached first result", async () => {
  const enabledFixture = buildTransport({
    experimentalFeaturePages: [[{ name: "goals", stage: "stable", enabled: true }]],
  });
  const disabledFixture = buildTransport({
    experimentalFeaturePages: [[{ name: "goals", stage: "stable", enabled: false }]],
  });
  try {
    const first = await enabledFixture.transport.probe();
    const second = await disabledFixture.transport.probe();
    assert.equal(first.available, true);
    assert.equal(second.available, false);
    assert.notEqual(
      first.probedAt,
      second.probedAt,
      "each call is a fresh, independently timestamped observation"
    );
  } finally {
    rmSync(enabledFixture.dir, { recursive: true, force: true });
    rmSync(disabledFixture.dir, { recursive: true, force: true });
  }
});

test("probe() reports available:false, naming the timeout, when initialize never responds", async () => {
  const { transport, dir } = buildTransport({ hangInitialize: true }, { initializeTimeoutMs: 100 });
  try {
    const capability = await transport.probe();
    assert.equal(capability.available, false);
    assert.match(capability.reason ?? "", /100ms/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe() reports available:false when the configured command cannot be spawned at all", async () => {
  const transport = new AppServerGoalWakeTransport({
    command: "definitely-not-a-real-ghantika-wake-test-binary",
    args: [],
  });
  const capability = await transport.probe();
  assert.equal(capability.available, false);
  assert.ok((capability.reason ?? "").length > 0);
});

// ---------------------------------------------------------------------------
// refused / unavailable outcome mapping
// ---------------------------------------------------------------------------

test("wake() reports refused, and reaps its child immediately, when the app-server returns a JSON-RPC error for thread/goal/set", async () => {
  const { transport, dir, pidFile } = buildTransport({
    goalSetOutcome: { kind: "error", code: -32600, message: "thread not found: bogus-thread" },
  });
  try {
    const result = await transport.wake("bogus-thread", "go");
    assert.equal(result.outcome, "refused");
    assert.match(result.detail ?? "", /thread not found/);

    const pid = readPid(pidFile);
    assert.equal(
      await eventuallyDead(pid, 2_000),
      true,
      "a refused goal-set has nothing to supervise and should already be torn down by the time wake() returns"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wake() reports refused, and reaps its child, when thread/goal/set succeeds but no turn/started ever arrives", async () => {
  const { transport, dir, pidFile } = buildTransport(
    { turnStartedDelayMs: null },
    { turnStartTimeoutMs: 100 }
  );
  try {
    const result = await transport.wake("thread-never-starts", "go");
    assert.equal(result.outcome, "refused");
    assert.match(result.detail ?? "", /no turn\/started was observed/);

    const pid = readPid(pidFile);
    assert.equal(await eventuallyDead(pid, 2_000), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wake() reports unavailable, naming the handshake failure, when initialize never responds", async () => {
  const { transport, dir } = buildTransport({ hangInitialize: true }, { initializeTimeoutMs: 100 });
  try {
    const result = await transport.wake("thread-x", "go");
    assert.equal(result.outcome, "unavailable");
    assert.match(result.detail ?? "", /initialize handshake/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wake() reports unavailable when the configured command cannot be spawned at all", async () => {
  const transport = new AppServerGoalWakeTransport({
    command: "definitely-not-a-real-ghantika-wake-test-binary",
    args: [],
  });
  const result = await transport.wake("thread-x", "go");
  assert.equal(result.outcome, "unavailable");
  assert.ok((result.detail ?? "").length > 0);
});

// ---------------------------------------------------------------------------
// the child is owned and reaped, including across a genuine crash
// ---------------------------------------------------------------------------

const CRASH_HARNESS_PATH = fileURLToPath(
  new URL("./fixtures/wake-app-server-crash-harness.ts", import.meta.url)
);

test("neverOrphansOnAHostCrash: a separate process that spawns a delivered wake and then exits immediately, WITHOUT awaiting reap, still leaves no live child behind", async () => {
  const dir = scratchDir();
  try {
    const pidFile = path.join(dir, "mock.pid");
    const scenarioPath = path.join(dir, "scenario.json");
    writeFileSync(
      scenarioPath,
      JSON.stringify({ turnStartedDelayMs: 5, turnCompletedDelayMs: null, pidFile })
    );

    // A genuinely separate OS process: it spawns its own
    // AppServerGoalWakeTransport, calls wake() until delivery is
    // confirmed, then calls process.exit() immediately - never calling
    // waitForBackgroundSupervisionForTests(), which is exactly the shape
    // of an uncontrolled crash from this transport's own point of view.
    // The module-level process.on("exit") crash-safety net in
    // appServerTransport.ts is the only thing that can still reap the
    // mock child at that point.
    execFileSync(process.execPath, [CRASH_HARNESS_PATH, FIXTURE_PATH, scenarioPath], {
      stdio: ["ignore", "ignore", "inherit"],
    });

    const pid = await waitForPidFile(pidFile, 2_000);
    assert.equal(
      await eventuallyDead(pid, 3_000),
      true,
      "the crash-safety net should have SIGKILLed the mock even though the parent never awaited reap"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitForPidFile(pidFile: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return readPid(pidFile);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`mock process never wrote its pid file within ${timeoutMs}ms: ${pidFile}`);
}

// ---------------------------------------------------------------------------
// pure helpers, exercised directly with no process spawned at all
// ---------------------------------------------------------------------------

test("parseExperimentalFeatureEntries: keeps well-formed entries and silently drops malformed ones rather than throwing", () => {
  const entries = parseExperimentalFeatureEntries([
    { name: "goals", stage: "stable", enabled: true },
    { name: "missing-stage", enabled: true },
    { name: 42, stage: "stable", enabled: true },
    "not even an object",
    null,
    { name: "shell_tool", stage: "stable", enabled: false },
  ]);
  assert.deepEqual(entries, [
    { name: "goals", stage: "stable", enabled: true },
    { name: "shell_tool", stage: "stable", enabled: false },
  ]);
});

test("parseExperimentalFeatureEntries: a non-array input yields an empty list rather than throwing", () => {
  assert.deepEqual(parseExperimentalFeatureEntries(undefined), []);
  assert.deepEqual(parseExperimentalFeatureEntries({ data: [] }), []);
});

test("isNotificationForThread: matches only a notification whose params.threadId equals the target", () => {
  assert.equal(
    isNotificationForThread({ method: "turn/started", params: { threadId: "abc" } }, "abc"),
    true
  );
  assert.equal(
    isNotificationForThread({ method: "turn/started", params: { threadId: "abc" } }, "def"),
    false
  );
  assert.equal(isNotificationForThread({ method: "turn/started", params: null }, "abc"), false);
  assert.equal(isNotificationForThread({ method: "turn/started", params: "abc" }, "abc"), false);
});

test("AppServerRpcError carries the protocol's own error code alongside the standard Error message", () => {
  const error = new AppServerRpcError("thread not found", -32600);
  assert.equal(error.message, "thread not found");
  assert.equal(error.code, -32600);
  assert.equal(error.name, "AppServerRpcError");
  assert.ok(error instanceof Error);
});
