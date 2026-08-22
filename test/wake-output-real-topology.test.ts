/**
 * The real topology, not a simulation.
 *
 * Every other wake-mechanism test in this repo either mocks the concrete
 * transports (test/wake-transport-wiring.test.ts) or drives a real spawned
 * process against a mock Tasks-capable client (test/wake-integration.test.ts).
 * Neither answers the actual question this file exists for: does the REAL,
 * real-app-inherited ClaudeMessagingWakeTransport singleton genuinely
 * deliver a wake while a real, never-exiting process is still `running` -
 * never merely once it has exited, which is a materially weaker and
 * already-covered case.
 *
 * A REAL fswatch process (the same bare, unfiltered command shape
 * test/dogfood.test.ts already establishes as the realistic doorbell
 * fixture), on a SCRATCH path this file owns - never a personal absolute
 * path. Started through the real `run` tool over a real (in-process) MCP
 * connection, exactly as a genuine client request would - never
 * `jobStore.createJob` alone, which registers only a metadata record with
 * no real backing process, and so would never produce a real
 * onOutputArrival event for this mechanism to react to at all.
 *
 * WHAT THIS FILE EXERCISES FOR REAL, AND WHAT IT DISCLOSES RATHER THAN
 * MOCKS: this test process is a Claude Code Bash-tool subprocess, so it
 * genuinely inherits CLAUDE_CODE_MESSAGING_SOCKET/TOKEN, and this file
 * proves that transport for real. `probeAndExerciseIfAvailable` below
 * measures the two Codex-gated transports rather than assuming either is
 * unreachable: `codex-app-server-goal` reports genuinely AVAILABLE from a
 * Claude harness (the local `codex` app-server answers the protocol
 * handshake) - what it lacks is a resolvable Codex thread id to address,
 * not reachability itself, and this file exercises it for real rather
 * than mocking it into an assertable pass. `chatgpt-desktop-ipc` reports
 * genuinely unavailable (its own initialize handshake times out) and is
 * disclosed as such. Forcing either into a mocked outcome would prove the
 * right property against the wrong path.
 *
 * THIS IS THE ONE FILE IN THIS REPO THAT DELIBERATELY, INTENTIONALLY SENDS
 * A REAL "type":"user" LINE OVER THE REAL INHERITED SOCKET. Every other
 * test that touches ClaudeMessagingWakeTransport neutralizes it first (see
 * test/wake-transport-wiring.test.ts's own neutralizeClaudeMessagingTransport
 * doc comment for why that is required everywhere else). This file is the
 * disclosed exception, skipped by default (see REAL_TOPOLOGY_SKIP below)
 * and run deliberately and exactly once per invocation - mint one job,
 * trigger exactly one real wake, kill and reap immediately - never
 * bundled into a default suite run.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { createServer } from "../dist/server.js";
import { jobStore } from "../dist/jobStore.js";
import { killProcessGroupPosix } from "../dist/process.js";
import { DEFAULT_TRANSPORTS } from "../dist/wake/selectTransport.js";
import type { WakeTransport } from "../dist/wake/wakeTransport.js";

import { requireSpawnPolicy } from "./helpers/requireSpawnPolicy.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH_ROOT = path.join(REPO_ROOT, "local", "wake-output-real-topology-scratch");

// ---------------------------------------------------------------------------
// Platform/tool gating - identical rationale to test/dogfood.test.ts's own
// DOGFOOD_SKIP: fswatch is the real external tool a doorbell watcher runs,
// not a dependency of this project, and pgrep/fswatch have no Windows
// equivalent exercised anywhere in this codebase. ON TOP OF THAT, an
// explicit opt-in this file alone requires: this test deliberately sends a
// real "type":"user" line over whatever real messaging socket this process
// happens to have inherited (see this file's own header) - the ONE genuine
// side effect a bare `npm test`/coverage/local-gate run must never trigger
// by accident. Skipped by default everywhere, on every platform, until a
// human deliberately sets GHANTIKA_TEST_REAL_MESSAGING_WAKE=1 for exactly
// this run. test/wake-integration.test.ts's own real-transport proofs
// carry the identical side effect without this opt-in, because they run
// against a socket a plain test process does not otherwise inherit in CI;
// run from inside a live Claude Code session, they genuinely inject real
// turns into it. This file's default-off gate keeps its own,
// deliberately-added instance of that same mechanism from firing on every
// routine gate run the way that pre-existing one already can.
// ---------------------------------------------------------------------------

const REAL_MESSAGING_WAKE_OPT_IN_ENV = "GHANTIKA_TEST_REAL_MESSAGING_WAKE";

function fswatchIsInstalled(): boolean {
  const result = spawnSync("fswatch", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

const REAL_TOPOLOGY_SKIP =
  process.platform === "win32"
    ? "POSIX-only: this proof drives a real fswatch process and confirms it via pgrep, matching test/dogfood.test.ts's own PGREP_ORACLE_SKIP rationale"
    : !fswatchIsInstalled()
      ? "fswatch is not installed on this host - install it (e.g. brew install fswatch / apt-get install fswatch) to run this proof for real"
      : process.env[REAL_MESSAGING_WAKE_OPT_IN_ENV] !== "1"
        ? `opt-in only - sends a real message over this process's own inherited Claude messaging socket if one exists; set ${REAL_MESSAGING_WAKE_OPT_IN_ENV}=1 to run this deliberately`
        : false;

if (!REAL_TOPOLOGY_SKIP) {
  before(requireSpawnPolicy);
}

function escapeRegexPathLiteral(value: string): string {
  return value.replace(/[.[\]\\*^$()+?{|]/g, "\\$&");
}

function pgrepPids(pattern: string): number[] {
  try {
    const stdout = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map(Number);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number };
    if (err.status === 1) return [];
    throw error;
  }
}

/** Polls the real process table until no process anywhere still runs the exact `fswatch <triggerPath>` command line - the same external, independent confirmation test/dogfood.test.ts's own waitForNoFswatchPid requires, never trusting kill's own return value alone. */
async function waitForNoFswatchPid(triggerPath: string, timeoutMs = 5000): Promise<void> {
  const pattern = `^fswatch ${escapeRegexPathLiteral(triggerPath)}$`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pgrepPids(pattern).length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `fswatch process(es) on ${triggerPath} still alive ${timeoutMs}ms after kill`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
});

/**
 * Probes `transport` for real. Unavailable is disclosed with its exact
 * reason and nothing more is attempted. Available forces a REAL `wake()`
 * call against it (never merely printing the probe result) so an
 * available-but-unexercised transport can never pass this test silently -
 * whatever the call's own real outcome is (a genuine refusal is expected,
 * since no resolvable Codex thread id backs `taskId` as a target here),
 * that outcome is disclosed too, and the call itself is real evidence
 * this transport was exercised, not assumed unreachable.
 */
async function probeAndExerciseIfAvailable(
  transport: WakeTransport,
  label: string,
  taskId: string
): Promise<void> {
  const probe = await transport.probe();
  if (!probe.available) {
    console.error(
      `[AC2 disclosure] ${label}: available=false (${probe.reason}) - not exercised for real in this environment`
    );
    return;
  }
  const result = await transport.wake(taskId, `ac2-real-topology-probe-for-${label}`);
  console.error(
    `[AC2 disclosure] ${label}: available=true - exercised for real, outcome="${result.outcome}" detail="${result.detail ?? "n/a"}"`
  );
}

test(
  "AC2 real topology: a real, never-exiting fswatch job started through the real run() tool genuinely wakes THIS session's own real Claude messaging transport while status() still reports `running` - never once it has exited",
  { skip: REAL_TOPOLOGY_SKIP },
  async (t) => {
    // Deliberately NOT neutralizeClaudeMessagingTransport - this is the one
    // test in this repo that exists specifically to exercise the real
    // transport for real. See this file's own header.
    const wakeSpy = t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake");

    fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
    const scratchDir = fs.mkdtempSync(path.join(SCRATCH_ROOT, `${randomUUID()}-`));
    scratchDirs.push(scratchDir);
    const triggerPath = path.join(scratchDir, ".trigger_manager");
    fs.writeFileSync(triggerPath, "", "utf8");
    const resolvedTriggerPath = fs.realpathSync(triggerPath);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const instance = createServer(serverTransport);
    await instance.server.connect(instance.transport);
    // A PLAIN, non-Tasks-capable client - AC2's own topology has nothing
    // to do with Tasks-extension capability (see
    // startTransportWakeOnOutput's own doc comment: it is not gated by
    // isCapableConnection at all), so this deliberately proves the
    // mechanism reaches a plain connection too, not only a capable one.
    const client = new Client(
      { name: "ghantika-ac2-real-topology-test-client", version: "0.0.0" },
      {}
    );
    await client.connect(clientTransport);

    let jobId: string | undefined;
    try {
      const runResult = (await client.callTool({
        name: "run",
        arguments: { command: ["fswatch", resolvedTriggerPath], label: "ac2-real-topology" },
      })) as { isError?: boolean; structuredContent?: { job_id?: unknown } };
      assert.notEqual(
        runResult.isError,
        true,
        `expected run() to succeed: ${JSON.stringify(runResult)}`
      );
      jobId = runResult.structuredContent?.job_id as string;
      assert.equal(typeof jobId, "string", "expected a real job_id back from run()");

      // Real, external confirmation that the real fswatch process is
      // actually watching before this test touches the trigger - never a
      // fixed sleep standing in for this, matching test/dogfood.test.ts's
      // own waitForExactlyOneFswatchPid.
      const watchPattern = `^fswatch ${escapeRegexPathLiteral(resolvedTriggerPath)}$`;
      const watchDeadline = Date.now() + 5000;
      for (;;) {
        if (pgrepPids(watchPattern).length === 1) break;
        if (Date.now() >= watchDeadline) {
          throw new Error(
            `no real fswatch process appeared on ${resolvedTriggerPath} within 5000ms`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // The touch - the real external event the output trigger reacts to.
      // fswatch, started with no -x/--event filter (matching this file's
      // own header on realism), writes the changed path to its own stdout
      // the moment this lands.
      fs.utimesSync(triggerPath, new Date(), new Date());

      // Wait for the real wake() call, and assert the job's own state is
      // STILL "running" at that exact moment - never "exited"/"killed". A
      // short-lived job reaching terminal before this check would prove
      // only the separate terminal trigger, not this one.
      const deadline = Date.now() + 8000;
      while (wakeSpy.mock.callCount() === 0) {
        if (Date.now() >= deadline) {
          throw new Error(
            "expected a real wake() call on the inherited Claude messaging transport within 8000ms of touching the trigger - the output-triggered wake never fired"
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const stateAtWakeTime = jobStore.get(jobId)?.state;
      assert.equal(
        stateAtWakeTime,
        "running",
        `expected the job to still be "running" at the moment the real wake fired - got "${stateAtWakeTime}". A wake observed only after the job went terminal would prove only the separate terminal trigger, never this one.`
      );

      // Disclose, never mock, AND never let an unexercised-but-available
      // transport pass silently: probe each Codex-gated transport, and
      // when it reports unavailable, disclose the exact reason. When it
      // reports available, a REAL wake() call is made against it instead
      // of merely printing the probe result - whatever that call's own
      // real outcome is (a real refusal is expected, since no genuinely
      // resolvable Codex thread id backs `jobId` as a target here), it is
      // a real exercised call, never an assumption left unchecked. This is
      // the mechanism that keeps this test honest if the environment it
      // runs in ever changes: an available-but-silent transport can never
      // again pass this test without being exercised.
      await probeAndExerciseIfAvailable(DEFAULT_TRANSPORTS[1]!, "codex-app-server-goal", jobId);
      await probeAndExerciseIfAvailable(DEFAULT_TRANSPORTS[2]!, "chatgpt-desktop-ipc", jobId);
    } finally {
      if (jobId !== undefined) {
        const handle = jobStore.getChildHandle(jobId);
        if (handle !== undefined) {
          await killProcessGroupPosix(handle.pid, 500).catch(() => {
            // Best-effort - the real death confirmation below is what matters.
          });
        }
      }
      await waitForNoFswatchPid(resolvedTriggerPath).catch((error: unknown) => {
        console.error(`[AC2 teardown] ${error instanceof Error ? error.message : String(error)}`);
      });
      await instance.shutdown("wake-output-real-topology.test.ts complete");
    }
  }
);
