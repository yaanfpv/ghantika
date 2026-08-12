import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/server";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import * as killTool from "../dist/tools/kill.js";
import { jobStore } from "../dist/jobStore.js";
import {
  captureBirthIdentityPosix,
  isProcessAlive,
  isProcessGroupAlive,
  spawnManaged,
} from "../dist/process.js";
import type { ProcessBirthIdentity } from "../dist/process.js";

// Explicit ".ts" extension - this helper has no relative imports of its
// own (only node: builtins), so Node's native TypeScript support can load
// it directly without a build step - see test/e2e-server.test.ts's
// identical comment on the same helper.
import { type SpawnedServer, completeHandshake, spawnServer } from "./helpers/spawnServer.ts";
// The shared marker-file poll and its pgid predicate - one implementation
// for every suite that observes a job's real filesystem side effects.
import { parsesAsPgid, waitForFile } from "./harness.ts";
// Shared with test/kill-slow-paths.test.ts - see that helper's own header
// for why this can't just live in either *.test.ts file.
import { runStrandedRetryScenario } from "./helpers/killScenarios.ts";
// Bounded retry absorbing the real fork-visibility race a test's own
// immediate capture-then-assert can hit - see this helper's own header.
import { retryBirthIdentityCapture } from "./helpers/birthIdentityRetry.ts";
import { requireSpawnPolicy } from "./helpers/requireSpawnPolicy.ts";

// The tests in this file that spawn a real job are grouped inside
// their own local describe() blocks below. Only the blocks whose
// tests dispatch through the real `run` tool's policy gate (over the
// real wire) carry a before(requireSpawnPolicy) call scoped to just
// that block - see test/helpers/requireSpawnPolicy.ts for what this
// checks and why. A block whose tests spawn a real job directly via
// spawnManaged (never through the real `run` tool) is grouped the
// same way for organization, but carries NO guard: spawnManaged
// bypasses the policy gate entirely, so those tests need no policy
// file and would gain nothing from the check. The
// schema/validation/not-found/already-terminal tests right below, and
// the escape-boundary/prose/commit-history guard suite further down
// (plus its own pure unit tests against local extraction helpers),
// stay outside every describe block and spawn nothing at all.

// ---------------------------------------------------------------------------
// kill: unit-level handler tests (against the real dist/tools/kill.js, but
// calling the JobStore singleton directly rather than over the wire - the
// real end-to-end wire proof, including the process-group/pgrep verification,
// lives further down in this same file).
// ---------------------------------------------------------------------------

function assertToolError(result: CallToolResult, expectedSubstring: string): void {
  assert.equal(
    result.isError,
    true,
    `expected a tool-execution error, got: ${JSON.stringify(result)}`
  );
  const [first] = result.content;
  assert.ok(
    first?.type === "text" && first.text.includes(expectedSubstring),
    `expected content text to include "${expectedSubstring}", got: ${JSON.stringify(result.content)}`
  );
}

test("kill: schema requires a non-empty string job_id", () => {
  assert.deepEqual(killTool.inputSchema.required, ["job_id"]);
  assert.equal(killTool.inputSchema.properties?.job_id?.type, "string");
});

test("kill: missing/wrong-typed job_id returns isError: true, not a thrown error", async () => {
  assert.doesNotThrow(() => killTool.handler(undefined));
  assertToolError(await killTool.handler(undefined), "job_id");
  assertToolError(await killTool.handler({}), "job_id");
  assertToolError(await killTool.handler({ job_id: 7 }), "job_id");
  assertToolError(await killTool.handler({ job_id: "" }), "job_id");
});

test('kill: a wrong-typed/empty "signal" argument is a schema validation error', async () => {
  assertToolError(await killTool.handler({ job_id: "x", signal: 42 }), "signal");
  assertToolError(await killTool.handler({ job_id: "x", signal: "" }), "signal");
});

test("kill: unknown job_id is a distinct, typed not-found error - never confused with a validation error", async () => {
  const result = await killTool.handler({
    job_id: "this-job-id-does-not-exist-ghantika-kill-test",
  });
  assertToolError(result, "no such job_id");
});

test("kill on an already-terminal job is an idempotent no-op, never an error", async () => {
  const record = jobStore.createFailedJob({
    argv: ["bad"],
    cwd: "/tmp",
    env: {},
    isShell: false,
    diagnosticMessage: "x",
  });
  const result = await killTool.handler({ job_id: record.job_id });
  assert.notEqual(result.isError, true, `expected a success no-op, got: ${JSON.stringify(result)}`);
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(structured.state, "failed"); // unchanged - never resurrected/overwritten to "killed"
});

describe("kill: unit-level tests against a real spawned job", () => {
  // Each test below spawns a real job directly via spawnManaged, never
  // through the real `run` tool - spawnManaged bypasses the policy
  // gate entirely, so this block carries no before(requireSpawnPolicy)
  // - see this file's own top-of-file comment.

  // DEFAULT TERMINATING path, the no-signal-argument half - the OTHER half
  // of the default path, an explicitly-supplied "SIGTERM", shares this same
  // code branch and is separately exercised right below by its own test, so
  // neither half of the default path goes unexercised. Explicit SIGKILL is
  // NOT this path: it is a CUSTOM signal on the stricter
  // confirm-before-terminal branch, exercised separately further down in
  // this file (the test that sends signal: "SIGKILL" over the real wire).
  test("kill: the DEFAULT terminating path (no caller-supplied signal) - the job reaches terminal 'killed' synchronously, SIGTERM recorded", async () => {
    const record = jobStore.createJob({
      argv: ["sleep", "10"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      isShell: false,
    });
    const child = spawnManaged(
      {
        argv: ["sleep", "10"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      {
        onSpawn: () => jobStore.markRunning(record.job_id),
        onError: (message) => jobStore.markSpawnFailed(record.job_id, message),
        onExit: (code, signal) => jobStore.markExited(record.job_id, code, signal),
        onStdoutChunk: () => {},
        onStderrChunk: () => {},
        onStdoutEnd: () => {},
        onStderrEnd: () => {},
      }
    );
    jobStore.attachChild(record.job_id, child!);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the spawn event actually land

    // No `signal` argument at all - the true default path.
    const result = await killTool.handler({ job_id: record.job_id });
    assert.notEqual(result.isError, true, `expected kill to succeed: ${JSON.stringify(result)}`);
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.state, "killed");
    assert.equal(structured.signal, "SIGTERM"); // a plain `sleep` isn't SIGTERM-resistant - no escalation needed
    assert.equal(
      structured.kill_confirmed,
      true,
      "the final external pgrep-based process-group check must confirm a real, fully dead group"
    );
  });

  // Same ordering regression, for the EXPLICIT-SIGNAL branch (kill.ts's
  // custom-signal path) rather than the default phased path above - a
  // second, separate call site carrying the identical bug (an
  // undifferentiated "ok" success result reaching the terminal-state write
  // regardless of whether anything was actually delivered).
  test("kill: ORDERING REGRESSION (explicit-signal branch) - a group that exits naturally right as a caller-supplied signal reaches it ends up 'exited', never carrying that signal as a requested kill", async (t) => {
    const record = jobStore.createJob({
      argv: ["sleep", "10"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      isShell: false,
    });
    const child = spawnManaged(
      {
        argv: ["sleep", "10"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      {
        onSpawn: () => jobStore.markRunning(record.job_id),
        onError: (message) => jobStore.markSpawnFailed(record.job_id, message),
        onExit: () => {}, // driven manually below, same reasoning as the default-path regression above
        onStdoutChunk: () => {},
        onStderrChunk: () => {},
        onStdoutEnd: () => {},
        onStderrEnd: () => {},
      }
    );
    jobStore.attachChild(record.job_id, child!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pid = child!.pid!;

    const realKill = process.kill.bind(process);
    t.mock.method(process, "kill", (target: number, signal?: string | number) => {
      if (target !== -pid || signal !== "SIGUSR1") return realKill(target, signal);
      // Simulates the group emptying in the exact instant this custom
      // signal tries to reach it - genuinely ending the real process right
      // here (rather than merely swallowing the send) so the REAL,
      // unmocked pgrep-based confirmation this handler runs right after
      // correctly finds zero survivors, exactly as it honestly would in
      // the real race this reproduces.
      realKill(-pid, "SIGKILL");
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    const result = await killTool.handler({ job_id: record.job_id, signal: "SIGUSR1" });
    assert.notEqual(result.isError, true, `expected kill to succeed: ${JSON.stringify(result)}`);

    // The real natural exit, deliberately delayed until after kill() has
    // already returned - see the default-path regression above for why
    // this ordering is the one that actually exercises the old bug.
    jobStore.markExited(record.job_id, 0, null);

    const finalRecord = jobStore.get(record.job_id);
    assert.equal(
      finalRecord?.state,
      "exited",
      `expected the job to end up 'exited' rather than 'killed' with the caller-supplied signal it was never actually sent - got: ${JSON.stringify(finalRecord)}`
    );
    assert.equal(finalRecord?.exit_code, 0);
    assert.equal(
      finalRecord?.signal,
      undefined,
      "a naturally-exited job must never carry the caller-supplied signal it was never actually delivered"
    );
    // kill_confirmed stays UNSET here, not true - `setKillConfirmation`
    // only ever writes onto an ALREADY-terminal record, and at the moment
    // this handler ran it, the job was still genuinely `running` (the
    // natural exit is deliberately delayed until after kill() returns, see
    // above). This is the same honest "never silently upgraded" behavior
    // the codebase already applies elsewhere - confirmation racing ahead
    // of terminality writes nothing rather than fabricating a value.
    assert.equal(finalRecord?.kill_confirmed, undefined);
  });

  // DEFAULT TERMINATING path, the explicitly-supplied "SIGTERM" half - an
  // explicit "SIGTERM" argument simply invokes the standard SIGTERM -> grace
  // -> SIGKILL escalation, i.e. shares the IDENTICAL code branch the
  // no-signal-argument test above exercises (src/tools/kill.ts's handler treats
  // `signal === undefined` and `signal === "SIGTERM"` identically: both skip
  // the custom-signal branch and fall through to the same phased
  // `killProcessGroupPosix` call). This test proves that explicit form is
  // genuinely exercised, not merely asserted by comment - the SAME
  // synchronous-killed-plus-confirmed assertions as the no-signal test
  // above, but with `signal: "SIGTERM"` actually sent on the wire.
  test("kill: the DEFAULT terminating path, EXPLICITLY supplied as \"SIGTERM\" - the job reaches terminal 'killed' synchronously, both fields present, identical to the no-signal-argument default", async () => {
    const record = jobStore.createJob({
      argv: ["sleep", "10"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      isShell: false,
    });
    const child = spawnManaged(
      {
        argv: ["sleep", "10"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      {
        onSpawn: () => jobStore.markRunning(record.job_id),
        onError: (message) => jobStore.markSpawnFailed(record.job_id, message),
        onExit: (code, signal) => jobStore.markExited(record.job_id, code, signal),
        onStdoutChunk: () => {},
        onStderrChunk: () => {},
        onStdoutEnd: () => {},
        onStderrEnd: () => {},
      }
    );
    jobStore.attachChild(record.job_id, child!);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the spawn event actually land

    // The explicit "SIGTERM" form of the SAME default path.
    const result = await killTool.handler({ job_id: record.job_id, signal: "SIGTERM" });
    assert.notEqual(
      result.isError,
      true,
      `expected an explicit SIGTERM kill to succeed: ${JSON.stringify(result)}`
    );
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(
      structured.state,
      "killed",
      "an explicit SIGTERM must reach terminal killed synchronously, exactly like the no-signal-argument default"
    );
    assert.equal(structured.signal, "SIGTERM");
    assert.equal(
      structured.kill_confirmed,
      true,
      "the explicit-SIGTERM default path also runs the FINAL external pgrep-based confirmation and reports it truthfully"
    );
    assert.equal(
      typeof structured.identity_confirmed,
      "boolean",
      'both disclosure fields are PRESENT once terminal on the default path, whether the signal argument was omitted or explicitly "SIGTERM"'
    );
  });

  test('kill: an explicit non-default "signal" argument is sent once, with no automatic grace/escalation', async () => {
    const record = jobStore.createJob({
      argv: ["sleep", "10"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      isShell: false,
    });
    const child = spawnManaged(
      {
        argv: ["sleep", "10"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      {
        onSpawn: () => jobStore.markRunning(record.job_id),
        onError: (message) => jobStore.markSpawnFailed(record.job_id, message),
        onExit: (code, signal) => jobStore.markExited(record.job_id, code, signal),
        onStdoutChunk: () => {},
        onStderrChunk: () => {},
        onStdoutEnd: () => {},
        onStderrEnd: () => {},
      }
    );
    jobStore.attachChild(record.job_id, child!);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const start = Date.now();
    const result = await killTool.handler({ job_id: record.job_id, signal: "SIGKILL" });
    const elapsed = Date.now() - start;
    assert.notEqual(result.isError, true);
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.state, "killed");
    assert.equal(structured.signal, "SIGKILL");
    assert.ok(
      // Widened from 1000ms - this is the same "response bound sensitive to
      // genuine concurrent load" class documented at
      // test/run.test.ts's RUN_RESPONSE_TIME_BOUND_MS: this operation
      // includes a real signal send plus a bounded pgrep-based confirmation,
      // so its own real overhead can grow under contention. 2500ms stays
      // comfortably clear of the 5000ms default grace period this test
      // exists to prove was never waited through.
      elapsed < 2500,
      `an explicit signal must never wait through the default grace period, took ${elapsed}ms`
    );
    assert.equal(
      structured.kill_confirmed,
      true,
      "the explicit-signal path also runs the FINAL external process-group confirmation, not just the default phased path"
    );
  });

  test(
    "kill: a PRE-SIGNAL identity mismatch refuses to signal at all - the real tracked process survives, and the job never gets falsely marked killed",
    {
      // Exercises process.checkProcessIdentity's real `ps` lookup and a
      // real POSIX process-group cleanup - no Windows equivalent path here,
      // matching every other identity-check test in this codebase (see
      // test/process.test.ts's own POSIX_PROCESS_GROUP_SKIP for the
      // identical rationale). Windows has no identity check at all today -
      // a test-harness gap this skip closes, not a product scope decision.
      skip: process.platform === "win32" ? "POSIX-only identity check" : false,
    },
    async () => {
      const record = jobStore.createJob({
        argv: ["sleep", "30"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        isShell: false,
      });
      const child = spawnManaged(
        {
          argv: ["sleep", "30"],
          cwd: process.cwd(),
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        },
        {
          onSpawn: () => jobStore.markRunning(record.job_id),
          onError: (message) => jobStore.markSpawnFailed(record.job_id, message),
          onExit: (code, signal) => jobStore.markExited(record.job_id, code, signal),
          onStdoutChunk: () => {},
          onStderrChunk: () => {},
          onStdoutEnd: () => {},
          onStderrEnd: () => {},
        }
      );
      const birthIdentity = await retryBirthIdentityCapture(
        () => captureBirthIdentityPosix(child!.pid!),
        "captureBirthIdentityPosix"
      );
      assert.notEqual(birthIdentity, undefined, "expected a real, successful capture to poke");
      jobStore.attachChild(record.job_id, child!, birthIdentity);
      // Awaits the same real settlement resolveBirthIdentityForKill's own
      // production callers already await, rather than a fixed wall-clock
      // delay - see test/run.test.ts's waitForIdentityCaptureSettled.
      await jobStore.resolveBirthIdentityForKill(record.job_id);

      // Real pid recycling can't be forced deterministically from a test (see
      // test/process.test.ts's identical simulation on checkProcessIdentity
      // directly) - this constructs the ESSENCE of the scenario instead: our
      // own bookkeeping still points at this pid, but the captured birth
      // identity now claims something that could never be true of the REAL,
      // currently-alive process the observer reports. There is no public API
      // to override an already-attached child's recorded birth identity, so
      // this reaches into JobStore's own private `children` map directly -
      // the only way to test the CALLER's wiring (does kill.ts's handler
      // actually consult and honor a mismatch) rather than only the pure
      // `checkProcessIdentity` function in isolation, which
      // test/process.test.ts already covers exhaustively.
      const internals = jobStore as unknown as {
        children: Map<
          string,
          {
            child: unknown;
            pid: number;
            spawnedAtMs: number;
            birthIdentity: ProcessBirthIdentity | undefined;
          }
        >;
      };
      const tracked = internals.children.get(record.job_id)!;
      assert.notEqual(tracked, undefined);
      assert.notEqual(tracked.birthIdentity, undefined);
      // The corruption technique is PLATFORM-SPECIFIC, because the two
      // ProcessBirthIdentity variants are compared completely differently
      // (see checkProcessIdentity's own docs): on macOS, push the captured
      // wall-clock moment 10 minutes into the past so the etime comparison
      // reads as impossible drift; on Linux, there is no wall-clock/tolerance
      // math to skew at all - the comparison is EXACT STRING equality against
      // a raw kernel counter, so corrupting it means producing a DIFFERENT
      // well-formed digit string (appending a digit always changes the value
      // while staying a valid token, exactly the shape a genuine pid-reuse
      // scenario would produce).
      const corruptedIdentity: ProcessBirthIdentity =
        tracked.birthIdentity!.platform === "linux-starttime-ticks"
          ? {
              platform: "linux-starttime-ticks",
              startTimeTicks: `${tracked.birthIdentity!.startTimeTicks}0`,
            }
          : {
              platform: "posix-elapsed",
              capturedAtMs: tracked.birthIdentity!.capturedAtMs - 10 * 60 * 1000, // 10 minutes "ago" - impossible for a process that just started
              elapsedSecondsAtCapture: tracked.birthIdentity!.elapsedSecondsAtCapture,
            };
      internals.children.set(record.job_id, {
        ...tracked,
        birthIdentity: corruptedIdentity,
      });

      const result = await killTool.handler({ job_id: record.job_id });
      assert.equal(result.isError, true, `expected kill to REFUSE, got: ${JSON.stringify(result)}`);
      const [first] = result.content;
      assert.ok(
        first?.type === "text" && first.text.includes("refused"),
        `expected an honest refusal message, got: ${JSON.stringify(result.content)}`
      );

      // THE proof: the job must stay NON-TERMINAL (never falsely marked
      // killed by a mismatched-identity signal), and the REAL process must
      // still be genuinely alive - a mismatched pid was never signalled.
      const after = jobStore.get(record.job_id)!;
      assert.notEqual(after.state, "killed");
      assert.equal(
        isProcessAlive(child!.pid!),
        true,
        "the real tracked process must have survived - the mismatch must have refused to signal it at all"
      );

      // Real cleanup - this test's own fake bookkeeping means the REAL
      // process was deliberately never reaped by kill() itself.
      process.kill(-child!.pid!, "SIGKILL");
    }
  );
});

// ---------------------------------------------------------------------------
// kill: the REAL end-to-end wire proof, including the external
// process-group verification.
// ---------------------------------------------------------------------------

const spawned: SpawnedServer[] = [];
function tracked(): SpawnedServer {
  const server = spawnServer();
  spawned.push(server);
  return server;
}

process.on("exit", () => {
  for (const server of spawned) {
    if (!server.child.killed) server.child.kill("SIGKILL");
  }
});

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-kill-e2e-"));
}

/** A real `pgrep -g <pgid>` call - the external, independent-of-our-own-bookkeeping system-level check a process-group kill requires. Returns the real pids it found, `[]` when pgrep finds none (its own documented exit code 1). */
function pgrepGroupMembers(pgid: number): number[] {
  try {
    const output = execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(Number);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number };
    if (err.status === 1) return []; // pgrep's own "nothing matched" exit code - a real, expected zero-survivors result
    throw error;
  }
}

async function waitForPgrepGroupMembers(
  pgid: number,
  condition: (members: number[]) => boolean,
  timeoutMs: number
): Promise<number[]> {
  const start = Date.now();
  for (;;) {
    const members = pgrepGroupMembers(pgid);
    if (condition(members)) return members;
    if (Date.now() - start > timeoutMs) return members;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface RunResponseBody {
  readonly error?: unknown;
  readonly result?: {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: ReadonlyArray<{ type: string; text?: string }>;
  };
}

/**
 * Parses a real wire response's `content[0].text` (the tool's own
 * `JSON.stringify(projection, null, 2)` block - see `toolSuccess` in
 * `src/tools/kill.ts`) back into an object, so a claim about field
 * ABSENCE can be checked against this surface too, not just
 * `structuredContent`. This is a SEPARATE serialization from
 * `structuredContent`: both start from the same `toPublicProjection`
 * object, but `content`'s text is built by this codebase's own
 * `JSON.stringify` inside `toolSuccess`, while `structuredContent` only
 * loses an `undefined`-valued key once the SDK's stdio transport
 * serializes the whole JSON-RPC envelope with its own `JSON.stringify`
 * (`serializeMessage`) on the way out - a real wire round trip is what
 * makes checking BOTH surfaces meaningful here, not redundant.
 */
function parseContentProjection(body: RunResponseBody): Record<string, unknown> {
  const [first] = body.result?.content ?? [];
  assert.ok(
    first?.type === "text" && typeof first.text === "string",
    `expected a text content block, got: ${JSON.stringify(body.result?.content)}`
  );
  return JSON.parse(first!.text!) as Record<string, unknown>;
}

describe("kill: the real end-to-end wire proof (against a real spawned job)", () => {
  // Each test below dispatches the real `run` tool over the real
  // wire - scoped here per this file's own top-of-file comment.
  before(requireSpawnPolicy);

  test(
    "kill() reaps a REAL process group - a real job that itself forked real descendant processes - confirmed by a REAL external pgrep after the kill showing zero surviving process-group members, not just the direct child",
    {
      // A real shell-forked process tree, tracked via a real external
      // `pgrep -g`, has no Windows equivalent path exercised anywhere in
      // this codebase's own source or this harness - a test-harness gap,
      // not a product scope decision. Windows is a supported platform;
      // whether src/tools/kill.ts's win32 branch actually reaps a Windows
      // process tree is a separate question this test doesn't answer by
      // skipping.
      skip:
        process.platform === "win32"
          ? "real shell-forked process tree tracked via `pgrep -g`, POSIX-only"
          : false,
    },
    async (t) => {
      const server = tracked();
      // Guaranteed cleanup for any path that never reaches this test's own
      // explicit server.child.kill() below - see the guaranteed-cleanup fix
      // in test/modern-handshake.test.ts for the
      // full rationale. A backstop only:
      // server.child.killed is already true by the time this runs on every
      // normal green pass.
      t.after(() => {
        if (!server.child.killed) server.child.kill("SIGKILL");
      });
      await completeHandshake(server);

      const dir = makeTempDir();
      const marker = path.join(dir, "pgid.txt");
      // A real shell child (the job's own tracked process, and the process-
      // group LEADER) that itself forks two real `sleep` descendants, writes
      // its own pid (== the group's pgid, since spawnManaged spawns it
      // detached) to a marker file, then blocks on `wait` so the whole
      // process group stays genuinely alive until we kill it.
      const shellCommand = `echo $$ > '${marker}'; sleep 60 & sleep 60 & wait`;

      server.send({
        jsonrpc: "2.0",
        id: 500,
        method: "tools/call",
        params: { name: "run", arguments: { command: shellCommand, shell: true } },
      });
      const runLine = await server.nextLine();
      const runBody = runLine.parsed as RunResponseBody;
      assert.equal(runBody.error, undefined);
      assert.notEqual(
        runBody.result?.isError,
        true,
        `run() must succeed: ${JSON.stringify(runBody)}`
      );
      const jobId = runBody.result?.structuredContent?.job_id as string;
      assert.equal(typeof jobId, "string");

      // Wait for a COMPLETE pgid, not merely for the marker to exist: the
      // shell creates it on redirect, and the leading digits of a longer pid
      // parse as a perfectly valid integer that names some other process.
      const pgidText = await waitForFile(marker, { until: parsesAsPgid });
      const pgid = Number(pgidText.trim());
      assert.ok(
        Number.isInteger(pgid) && pgid > 0,
        `expected a real numeric pgid from the marker file, got: ${JSON.stringify(pgidText)}`
      );

      // Confirm the REAL tree is actually up (the shell + 2 sleeps = at least
      // 3 group members) BEFORE we ever touch kill - a real external `pgrep`,
      // never our own internal bookkeeping.
      const beforeMembers = await waitForPgrepGroupMembers(
        pgid,
        (members) => members.length >= 3,
        3000
      );
      assert.ok(
        beforeMembers.length >= 3,
        `expected >= 3 real process-group members (the shell + 2 sleeps) before kill, pgrep saw: ${JSON.stringify(beforeMembers)}`
      );

      server.send({
        jsonrpc: "2.0",
        id: 501,
        method: "tools/call",
        params: { name: "kill", arguments: { job_id: jobId } },
      });
      const killLine = await server.nextLine(8000);
      const killBody = killLine.parsed as RunResponseBody;
      assert.equal(killBody.error, undefined);
      assert.notEqual(
        killBody.result?.isError,
        true,
        `kill() must succeed: ${JSON.stringify(killBody)}`
      );
      assert.equal(killBody.result?.structuredContent?.state, "killed");

      // THE proof: a REAL, independent `pgrep -g <pgid>` call AFTER the kill -
      // never trusting our own bookkeeping - must show ZERO surviving
      // process-group members (the shell AND both sleep descendants), not
      // merely the one direct child.
      const afterMembers = await waitForPgrepGroupMembers(
        pgid,
        (members) => members.length === 0,
        3000
      );
      assert.deepEqual(
        afterMembers,
        [],
        `expected zero surviving process-group members after kill, pgrep still saw: ${JSON.stringify(afterMembers)}`
      );

      // The tool's OWN result must honestly agree with what pgrep just
      // independently proved - the "killed-confirmed" disclosure. But
      // `killBody` above was captured BEFORE the pgrep wait just ran, and
      // `waitForPgrepGroupMembers` only ever reads the process table - it
      // never re-reads this job's own record, so that wait gives the
      // `kill_confirmed` field zero protection even though it sits right
      // above this assertion. `kill_confirmed` is written by an async
      // confirmation callback inside kill's own implementation, and
      // `src/tools/kill.ts`'s own doc comment on the field is explicit that
      // the gap between the group actually emptying and that confirmation
      // write landing is real event-loop scheduling latency -
      // "deliberately never stated as a wall-clock bound." Poll a fresh
      // `status()` call instead, exactly like the eager-reap tests further
      // down this file (e.g. the "root-exits-first" test's own poll loop),
      // until `kill_confirmed` has actually settled - never re-assert on
      // the stale `killBody` snapshot above.
      //
      // No fixed deadline: this explicit kill() sends a real signal, and the
      // process's own OS-level exit (whether from that signal or otherwise)
      // independently triggers `run.ts`'s `onExit` fire-and-forget eager
      // reap - the SAME unbounded-latency path a natural exit takes. Which
      // of that path or `kill.ts`'s own in-call confirmation actually lands
      // first is a real race with no ordering guarantee, so this poll is
      // exposed to the identical hazard as a natural exit, not a lesser one.
      // A one-line breadcrumb to stderr on a fixed cadence (never a
      // threshold) keeps a runner-level timeout legible if it ever fires.
      const confirmBreadcrumbIntervalMs = 5000;
      let confirmLastBreadcrumbAt = Date.now();
      let confirmedBody: RunResponseBody | undefined;
      for (;;) {
        server.send({
          jsonrpc: "2.0",
          id: 502,
          method: "tools/call",
          params: { name: "status", arguments: { job_id: jobId } },
        });
        const statusLine = await server.nextLine();
        confirmedBody = statusLine.parsed as RunResponseBody;
        if (confirmedBody.result?.structuredContent?.kill_confirmed !== undefined) break;
        if (Date.now() - confirmLastBreadcrumbAt >= confirmBreadcrumbIntervalMs) {
          console.error(
            `still waiting for kill_confirmed to settle for job ${jobId}, last saw: ${JSON.stringify(confirmedBody?.result?.structuredContent)}`
          );
          confirmLastBreadcrumbAt = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(
        confirmedBody.result?.structuredContent?.kill_confirmed,
        true,
        `expected kill_confirmed: true given pgrep independently confirmed zero survivors, got: ${JSON.stringify(confirmedBody.result?.structuredContent)}`
      );

      server.child.kill("SIGKILL");
    }
  );

  test(
    "root-exits-first: the eager reap collects real, live descendants automatically at leader-exit, with NO kill() call at all - a later kill() against the already-reaped record stays a clean, idempotent no-op",
    {
      skip:
        process.platform === "win32"
          ? "real shell-forked process tree tracked via `pgrep -g`, POSIX-only - no equivalent root-exits-first fix on Windows today (no pgid concept to reap against post-hoc)"
          : false,
    },
    async (t) => {
      const server = tracked();
      // Guaranteed cleanup for any path that never reaches this test's own
      // explicit server.child.kill() below - see the guaranteed-cleanup fix
      // in test/modern-handshake.test.ts for the
      // full rationale. A backstop only:
      // server.child.killed is already true by the time this runs on every
      // normal green pass.
      t.after(() => {
        if (!server.child.killed) server.child.kill("SIGKILL");
      });
      await completeHandshake(server);

      const dir = makeTempDir();
      const marker = path.join(dir, "pgid.txt");
      const child1Marker = path.join(dir, "child1-pid.txt");
      const child2Marker = path.join(dir, "child2-pid.txt");
      const releaseMarker = path.join(dir, "release.txt");
      // The LEADER captures each descendant's own real, kernel-assigned pid
      // via `$!` the instant it backgrounds it - a plain shell built-in, not
      // a second process that itself has to start up. This is still the
      // cheapest way to know WHICH pids to look for, but it is NOT the
      // liveness proof: a marker written by the fixture about itself cannot
      // survive a mutation that replaces the whole launch line with a
      // hardcoded value (verified directly - a fixture rewritten to `echo
      // 111 > marker` instead of a real spawn still produces a marker every
      // assertion here accepts). The liveness proof below lives in the TEST,
      // via a real external `pgrep`, which the fixture cannot fake by lying
      // about itself.
      //
      // The leader writes its own pid (== the group's pgid, since
      // spawnManaged spawns it detached), forks two real `sleep` descendants,
      // then busy-waits on a release marker the TEST controls before ever
      // reaching the end of its own script - so the test can observe the
      // descendants alive from OUTSIDE the fixture before the leader is
      // allowed to exit without ever `wait`-ing on them. This is the exact
      // opposite of the process-group reap fixture above (which trails a
      // real `wait` to keep the leader alive throughout).
      const shellCommand = `echo $$ > '${marker}'; sleep 60 & echo $! > '${child1Marker}'; sleep 60 & echo $! > '${child2Marker}'; while [ ! -f '${releaseMarker}' ]; do sleep 0.05; done`;

      server.send({
        jsonrpc: "2.0",
        id: 520,
        method: "tools/call",
        params: { name: "run", arguments: { command: shellCommand, shell: true } },
      });
      const runLine = await server.nextLine();
      const runBody = runLine.parsed as RunResponseBody;
      assert.equal(runBody.error, undefined);
      assert.notEqual(
        runBody.result?.isError,
        true,
        `run() must succeed: ${JSON.stringify(runBody)}`
      );
      const jobId = runBody.result?.structuredContent?.job_id as string;
      assert.equal(typeof jobId, "string");

      const pgidText = await waitForFile(marker, { until: parsesAsPgid });
      const pgid = Number(pgidText.trim());
      assert.ok(
        Number.isInteger(pgid) && pgid > 0,
        `expected a real numeric pgid from the marker file, got: ${JSON.stringify(pgidText)}`
      );

      // These markers say which pids the leader believes it forked - useful
      // for the diagnostic below, but not themselves proof of liveness (see
      // the fixture's own comment above).
      const child1PidText = await waitForFile(child1Marker, { until: parsesAsPgid });
      const child1Pid = Number(child1PidText.trim());
      const child2PidText = await waitForFile(child2Marker, { until: parsesAsPgid });
      const child2Pid = Number(child2PidText.trim());
      assert.notEqual(
        child1Pid,
        child2Pid,
        "expected the two descendants to be genuinely distinct real processes"
      );

      // THE FIXTURE-VALIDITY PROOF, witnessed by the TEST itself rather than
      // trusted from the fixture: a real, external `pgrep -g <pgid>` call,
      // made WHILE the leader is still held on the release barrier (so the
      // leader cannot have exited yet, and the eager reap cannot have run
      // yet either), confirms BOTH of the SPECIFIC pids named above are
      // alive - not merely that pgrep counted two members. A bare count
      // would still be satisfied by the leader itself plus the release
      // barrier's own `sleep 0.05` polling child (a real, transient process
      // this fixture's busy-wait loop spawns every iteration), so a fixture
      // rewritten to fake its own markers with unrelated numbers could still
      // pass a count check; it cannot fake pgrep observing THOSE EXACT pids.
      const beforeRelease = await waitForPgrepGroupMembers(
        pgid,
        (members) => members.includes(child1Pid) && members.includes(child2Pid),
        3000
      );
      assert.ok(
        beforeRelease.includes(child1Pid) && beforeRelease.includes(child2Pid),
        `expected both witnessed descendant pids alive while the leader is held, pgrep saw: ${JSON.stringify(beforeRelease)}, expected to include ${child1Pid} and ${child2Pid}`
      );

      // Release the barrier: the leader's busy-wait notices the marker and
      // proceeds to the end of its own script, exiting naturally WITHOUT
      // ever `wait`-ing on the two descendants just witnessed alive above.
      fs.writeFileSync(releaseMarker, "go\n");

      // Poll status() until the JOB RECORD is genuinely terminal AND the
      // eager reap's own async confirmation has actually landed -
      // `markExited` sets state synchronously, but `reapProcessGroupOnce` is
      // fired off without being awaited there (see run.ts's `onExit`), so
      // `kill_confirmed` settles a real (short) tick or two later; polling
      // only on state would read that natural gap as a failure. Nothing here
      // is assumed from a fixed sleep, and NO kill() call has been made at
      // any point before this.
      //
      // No fixed deadline: `reapProcessGroupOnce`'s confirmation write is
      // real event-loop scheduling latency with no stated upper bound (see
      // src/tools/kill.ts's own doc comment) - a fixed number here asserts a
      // bound the contract declines to give. A breadcrumb on a fixed cadence
      // (never a threshold) keeps a runner-level timeout legible if it fires.
      const statusBreadcrumbIntervalMs = 5000;
      let statusLastBreadcrumbAt = Date.now();
      let statusBody: RunResponseBody | undefined;
      for (;;) {
        server.send({
          jsonrpc: "2.0",
          id: 521,
          method: "tools/call",
          params: { name: "status", arguments: { job_id: jobId } },
        });
        const statusLine = await server.nextLine();
        statusBody = statusLine.parsed as RunResponseBody;
        const state = statusBody.result?.structuredContent?.state as string | undefined;
        const killConfirmed = statusBody.result?.structuredContent?.kill_confirmed;
        const isTerminal = state !== undefined && state !== "starting" && state !== "running";
        if (isTerminal && killConfirmed !== undefined) break;
        if (Date.now() - statusLastBreadcrumbAt >= statusBreadcrumbIntervalMs) {
          console.error(
            `still waiting for the leader's own job record to go terminal AND the eager reap's confirmation to land for job ${jobId}, last saw: ${JSON.stringify(statusBody?.result?.structuredContent)}`
          );
          statusLastBreadcrumbAt = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(
        statusBody?.result?.structuredContent?.state,
        "exited",
        `expected the leader's own record to be "exited" (a normal, unsignalled exit), got: ${JSON.stringify(statusBody?.result?.structuredContent)}`
      );

      // THE proof that actually changed: the eager reap already collected
      // the two descendants the test itself witnessed alive above (via a
      // real external `pgrep`, before ever releasing the leader) - now
      // automatically, at leader-exit, with NO kill() call made anywhere.
      // `kill_confirmed` is already `true`, and a real, external
      // `pgrep -g <pgid>` already shows zero survivors.
      //
      // EVIDENCED SKIP (reviewed for the kill_confirmed-staleness class
      // fixed above at this file's own "process-group reap" test): this
      // read is safe, unlike that one. `statusBody` here comes from the
      // poll loop just above, whose OWN break condition already requires
      // `killConfirmed !== undefined` before it ever exits (see the loop's
      // own doc comment) - there is no capture-then-later-wait-then-stale-
      // read gap the way there was in the fixed test, because nothing runs
      // between the loop breaking and this assertion.
      assert.equal(
        statusBody?.result?.structuredContent?.kill_confirmed,
        true,
        `expected kill_confirmed: true from the eager reap alone, before any kill() call, got: ${JSON.stringify(statusBody?.result?.structuredContent)}`
      );
      const afterEagerReap = await waitForPgrepGroupMembers(
        pgid,
        (members) => members.length === 0,
        3000
      );
      assert.deepEqual(
        afterEagerReap,
        [],
        `expected the eager reap to have already collected both descendants with no kill() call, pgrep still saw: ${JSON.stringify(afterEagerReap)}`
      );

      // A later, explicit kill() against this now-already-reaped terminal
      // record must stay a clean, idempotent no-op: it must succeed, must
      // never rewrite the honestly-recorded "exited" state, and must never
      // regress the confirmation the eager reap already established.
      server.send({
        jsonrpc: "2.0",
        id: 522,
        method: "tools/call",
        params: { name: "kill", arguments: { job_id: jobId } },
      });
      const killLine = await server.nextLine(8000);
      const killBody = killLine.parsed as RunResponseBody;
      assert.equal(killBody.error, undefined);
      assert.notEqual(
        killBody.result?.isError,
        true,
        `kill() on an already-reaped terminal record must still succeed as a no-op: ${JSON.stringify(killBody)}`
      );
      assert.equal(killBody.result?.structuredContent?.state, "exited");
      // EVIDENCED SKIP: `kill_confirmed` was already proven `true` on this
      // job's record above, BEFORE this second kill() call was ever sent -
      // and per src/jobStore.ts's `reapProcessGroupOnce`, a job whose reap
      // has already been attempted takes its "already-attempted" branch,
      // which is a plain synchronous in-memory read
      // (`this.jobs.get(jobId)?.kill_confirmed === true`) with no further
      // await, no signal, and no fresh confirmation wait. So this second
      // call's own response can only ever echo the value already settled
      // above - there is nothing async left for this read to race.
      assert.equal(
        killBody.result?.structuredContent?.kill_confirmed,
        true,
        `expected kill_confirmed to remain true, unchanged by the later no-op kill(), got: ${JSON.stringify(killBody.result?.structuredContent)}`
      );

      server.child.kill("SIGKILL");
    }
  );

  // Confirms the confirmed-terminating outcome shape of an explicit
  // SIGKILL: once the group is genuinely reaped, the record reads
  // state=killed with kill_confirmed and identity_confirmed both PRESENT.
  // This is NOT an ordering test - a real exit-race (the process can exit
  // on its own the instant SIGKILL lands, independent of confirmation)
  // means this cell cannot distinguish "confirmed-then-terminal" from
  // "terminal-then-confirmed"; that ordering guarantee is owned by the
  // SIGSTOP-based test above, which has no competing exit-race. `kill(-pgid,
  // SIGKILL)` alone still does not guarantee the group has zero survivors
  // (it never reaches a descendant that has called setsid() or otherwise
  // moved into a different process group - reparenting alone is NOT such an
  // escape, since reparenting changes a process's parent, never its process
  // group), which is why `kill_confirmed`/`identity_confirmed` still wait
  // on real confirmation regardless of when the state itself turns
  // terminal.
  test(
    "an explicit SIGKILL reaches the confirmed-terminating outcome shape - state=killed with both kill_confirmed and identity_confirmed PRESENT once the group is genuinely reaped (not an ordering test - see the SIGSTOP test above for the ordering guarantee)",
    {
      skip:
        process.platform === "win32"
          ? "sends a real non-default signal and reads real pgrep output, POSIX-only"
          : false,
    },
    async (t) => {
      const server = tracked();
      // Guaranteed cleanup for any path that never reaches this test's own
      // explicit server.child.kill() below - see the guaranteed-cleanup fix
      // in test/modern-handshake.test.ts for the
      // full rationale. A backstop only:
      // server.child.killed is already true by the time this runs on every
      // normal green pass.
      t.after(() => {
        if (!server.child.killed) server.child.kill("SIGKILL");
      });
      await completeHandshake(server);

      const dir = makeTempDir();
      const marker = path.join(dir, "pgid.txt");
      const shellCommand = `echo $$ > '${marker}'; exec sleep 30`;

      server.send({
        jsonrpc: "2.0",
        id: 545,
        method: "tools/call",
        params: { name: "run", arguments: { command: shellCommand, shell: true } },
      });
      const runLine = await server.nextLine();
      const runBody = runLine.parsed as RunResponseBody;
      assert.equal(runBody.error, undefined);
      assert.notEqual(
        runBody.result?.isError,
        true,
        `run() must succeed: ${JSON.stringify(runBody)}`
      );
      const jobId = runBody.result?.structuredContent?.job_id as string;
      assert.equal(typeof jobId, "string");

      const pgidText = await waitForFile(marker, { until: parsesAsPgid });
      const pgid = Number(pgidText.trim());
      assert.ok(
        Number.isInteger(pgid) && pgid > 0,
        `expected a real numeric pgid from the marker file, got: ${JSON.stringify(pgidText)}`
      );

      const beforeMembers = await waitForPgrepGroupMembers(
        pgid,
        (members) => members.length >= 1,
        3000
      );
      assert.ok(
        beforeMembers.length >= 1,
        `expected the real process alive before kill, pgrep saw: ${JSON.stringify(beforeMembers)}`
      );

      server.send({
        jsonrpc: "2.0",
        id: 546,
        method: "tools/call",
        params: { name: "kill", arguments: { job_id: jobId, signal: "SIGKILL" } },
      });
      const killLine = await server.nextLine(8000);
      const killBody = killLine.parsed as RunResponseBody;
      assert.equal(killBody.error, undefined);
      assert.notEqual(
        killBody.result?.isError,
        true,
        `kill(SIGKILL) must succeed: ${JSON.stringify(killBody)}`
      );

      // THE proof: a real, guaranteed-terminating non-default signal
      // reaches "killed" (via its own real exit, confirmation, or both -
      // this test does not distinguish which), and once genuinely
      // terminal, BOTH fields are eventually PRESENT (real booleans), never
      // left absent, on both real wire surfaces.
      //
      // EVIDENCED SKIP (reviewed for the kill_confirmed-staleness class):
      // this `killBody` read is safe, unlike the fixed "process-group reap"
      // test above - and for a DIFFERENT reason than the "already-attempted"
      // no-op reads elsewhere in this file. An explicit non-SIGTERM signal
      // (src/tools/kill.ts's own custom-signal branch) `await`s
      // `confirmProcessGroupReapedPosix` DIRECTLY, in-line, inside the same
      // handler call that produces this response - `setKillConfirmation` is
      // only ever called (gated behind that same await's result) BEFORE
      // `return toolSuccess(...)` runs, never as a separate fire-and-forget
      // callback the way the eager reap at natural leader-exit is. So there
      // is no async gap between this response being generated and
      // kill_confirmed's value being decided: whatever this call returns IS
      // the settled value, with no later write that could still be
      // in-flight. (A SIGKILL that failed to confirm within kill's own
      // internal bound would read `undefined`, not stale-`true`-then-
      // overwritten - a different, genuine failure this assertion would
      // still correctly catch, not the capture-then-later-wait class this
      // sweep is scoped to.)
      assert.equal(
        killBody.result?.structuredContent?.state,
        "killed",
        `expected a real terminating signal to actually reach killed, got: ${JSON.stringify(killBody.result?.structuredContent)}`
      );
      assert.equal(
        killBody.result?.structuredContent?.kill_confirmed,
        true,
        `expected kill_confirmed: true once terminal, got: ${JSON.stringify(killBody.result?.structuredContent)}`
      );
      assert.equal(
        typeof killBody.result?.structuredContent?.identity_confirmed,
        "boolean",
        `expected identity_confirmed to be genuinely PRESENT (a real boolean) once terminal, got: ${JSON.stringify(killBody.result?.structuredContent)}`
      );

      const contentProjection = parseContentProjection(killBody);
      assert.equal(
        Object.prototype.hasOwnProperty.call(contentProjection, "kill_confirmed"),
        true,
        `expected "kill_confirmed" to be genuinely PRESENT in content[0].text, got: ${JSON.stringify(contentProjection)}`
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(contentProjection, "identity_confirmed"),
        true,
        `expected "identity_confirmed" to be genuinely PRESENT in content[0].text, got: ${JSON.stringify(contentProjection)}`
      );

      const afterMembers = await waitForPgrepGroupMembers(
        pgid,
        (members) => members.length === 0,
        3000
      );
      assert.deepEqual(
        afterMembers,
        [],
        `expected zero survivors after a real SIGKILL, pgrep still saw: ${JSON.stringify(afterMembers)}`
      );

      server.child.kill("SIGKILL");
    }
  );

  test(
    "a terminal job record whose process group had live descendants gets them reaped automatically at leader-exit, with NO kill() call at all - and a later kill() against that already-reaped record preserves its terminal disposition (no re-transition, no double state-change emission)",
    {
      skip:
        process.platform === "win32"
          ? "real shell-forked process tree tracked via pgrep -g, POSIX-only - no equivalent root-exits-first fix on Windows today"
          : false,
    },
    async (t) => {
      const server = tracked();
      // Guaranteed cleanup for any path that never reaches this test's own
      // explicit server.child.kill() below - see the guaranteed-cleanup fix
      // in test/modern-handshake.test.ts for the
      // full rationale. A backstop only:
      // server.child.killed is already true by the time this runs on every
      // normal green pass.
      t.after(() => {
        if (!server.child.killed) server.child.kill("SIGKILL");
      });
      await completeHandshake(server);

      const dir = makeTempDir();
      const marker = path.join(dir, "pgid.txt");
      const child1Marker = path.join(dir, "child1-pid.txt");
      const child2Marker = path.join(dir, "child2-pid.txt");
      const releaseMarker = path.join(dir, "release.txt");
      // Same root-exits-first fixture as the test above (see its own docs
      // for why the leader captures each descendant's real pid via `$!`
      // itself, and why liveness is witnessed by the TEST via pgrep rather
      // than trusted from the fixture): the leader forks two real
      // descendants, busy-waits on a release marker the test controls, then
      // exits on its own without ever `wait`-ing on them, leaving the job
      // record terminal while real orphans stay alive under the same pgid.
      const shellCommand = `echo $$ > '${marker}'; sleep 60 & echo $! > '${child1Marker}'; sleep 60 & echo $! > '${child2Marker}'; while [ ! -f '${releaseMarker}' ]; do sleep 0.05; done`;

      server.send({
        jsonrpc: "2.0",
        id: 550,
        method: "tools/call",
        params: { name: "run", arguments: { command: shellCommand, shell: true } },
      });
      const runLine = await server.nextLine();
      const runBody = runLine.parsed as RunResponseBody;
      assert.equal(runBody.error, undefined);
      assert.notEqual(
        runBody.result?.isError,
        true,
        `run() must succeed: ${JSON.stringify(runBody)}`
      );
      const jobId = runBody.result?.structuredContent?.job_id as string;
      assert.equal(typeof jobId, "string");

      const pgidText = await waitForFile(marker, { until: parsesAsPgid });
      const pgid = Number(pgidText.trim());
      assert.ok(
        Number.isInteger(pgid) && pgid > 0,
        `expected a real numeric pgid from the marker file, got: ${JSON.stringify(pgidText)}`
      );

      const child1PidText = await waitForFile(child1Marker, { until: parsesAsPgid });
      const child1Pid = Number(child1PidText.trim());
      const child2PidText = await waitForFile(child2Marker, { until: parsesAsPgid });
      const child2Pid = Number(child2PidText.trim());
      assert.notEqual(
        child1Pid,
        child2Pid,
        "expected the two descendants to be genuinely distinct real processes"
      );

      // THE FIXTURE-VALIDITY PROOF, witnessed by the TEST itself (see the
      // test above's own docs for why a bare pgrep count is not enough - the
      // release barrier's own polling spawns a real, transient process of
      // its own): a real, external pgrep call while the leader is still held
      // confirms BOTH specific witnessed pids are alive.
      const beforeRelease = await waitForPgrepGroupMembers(
        pgid,
        (members) => members.includes(child1Pid) && members.includes(child2Pid),
        3000
      );
      assert.ok(
        beforeRelease.includes(child1Pid) && beforeRelease.includes(child2Pid),
        `expected both witnessed descendant pids alive while the leader is held, pgrep saw: ${JSON.stringify(beforeRelease)}, expected to include ${child1Pid} and ${child2Pid}`
      );

      // Release the barrier: the leader exits naturally without ever
      // `wait`-ing on the two descendants just witnessed alive above.
      fs.writeFileSync(releaseMarker, "go\n");

      // Poll status() until the job RECORD is genuinely terminal AND the
      // eager reap's own async confirmation has landed (see the test
      // above's own docs for why both conditions are needed) - never
      // assumed from a fixed sleep, and NO kill() call has been made yet.
      //
      // No fixed deadline: same unbounded reap-confirmation latency as the
      // test above (see its own note); a breadcrumb on a fixed cadence
      // (never a threshold) keeps a runner-level timeout legible if it fires.
      const statusBreadcrumbIntervalMs = 5000;
      let statusLastBreadcrumbAt = Date.now();
      let statusBody: RunResponseBody | undefined;
      for (;;) {
        server.send({
          jsonrpc: "2.0",
          id: 551,
          method: "tools/call",
          params: { name: "status", arguments: { job_id: jobId } },
        });
        const statusLine = await server.nextLine();
        statusBody = statusLine.parsed as RunResponseBody;
        const state = statusBody.result?.structuredContent?.state as string | undefined;
        const killConfirmed = statusBody.result?.structuredContent?.kill_confirmed;
        const isTerminal = state !== undefined && state !== "starting" && state !== "running";
        if (isTerminal && killConfirmed !== undefined) break;
        if (Date.now() - statusLastBreadcrumbAt >= statusBreadcrumbIntervalMs) {
          console.error(
            `still waiting for the leader's own job record to go terminal AND the eager reap's confirmation to land for job ${jobId}, last saw: ${JSON.stringify(statusBody?.result?.structuredContent)}`
          );
          statusLastBreadcrumbAt = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(
        statusBody?.result?.structuredContent?.state,
        "exited",
        `expected the leader's own record to be "exited", got: ${JSON.stringify(statusBody?.result?.structuredContent)}`
      );
      const endedAtBeforeKill = statusBody?.result?.structuredContent?.ended_at;
      assert.equal(typeof endedAtBeforeKill, "string");

      // THE proof that actually changed: the eager reap already collected
      // the two proven-to-have-existed descendants automatically at
      // leader-exit - `kill_confirmed` is already `true`, and a real,
      // external pgrep -g <pgid> already shows zero survivors, with NO
      // kill() call having been made anywhere above.
      //
      // EVIDENCED SKIP (reviewed for the kill_confirmed-staleness class):
      // safe for the same reason as the sibling "root-exits-first" test
      // above - the poll loop just above this assertion already requires
      // `killConfirmed !== undefined` before it breaks, so `statusBody` is
      // guaranteed settled by construction, and nothing runs between the
      // loop breaking and this read.
      assert.equal(
        statusBody?.result?.structuredContent?.kill_confirmed,
        true,
        `expected kill_confirmed: true from the eager reap alone, before any kill() call, got: ${JSON.stringify(statusBody?.result?.structuredContent)}`
      );
      const afterEagerReap = await waitForPgrepGroupMembers(
        pgid,
        (members) => members.length === 0,
        3000
      );
      assert.deepEqual(
        afterEagerReap,
        [],
        `expected the eager reap to have already collected both descendants with no kill() call, pgrep still saw: ${JSON.stringify(afterEagerReap)}`
      );

      // A later, explicit kill() against this now-already-reaped terminal
      // record must preserve its terminal disposition exactly: the record's
      // own state stays UNCHANGED ("exited", never rewritten to "killed" or
      // anything else), and its ended_at timestamp - touched only by a real
      // mark* state transition - stays byte-identical to what it already
      // was. A silent re-transition (or a double-emit) would show a
      // DIFFERENT ended_at, or a different state, here.
      server.send({
        jsonrpc: "2.0",
        id: 552,
        method: "tools/call",
        params: { name: "kill", arguments: { job_id: jobId } },
      });
      const killLine = await server.nextLine(8000);
      const killBody = killLine.parsed as RunResponseBody;
      assert.equal(killBody.error, undefined);
      assert.notEqual(
        killBody.result?.isError,
        true,
        `kill() on an already-reaped terminal record must still succeed as a no-op: ${JSON.stringify(killBody)}`
      );
      assert.equal(killBody.result?.structuredContent?.state, "exited");
      assert.equal(
        killBody.result?.structuredContent?.ended_at,
        endedAtBeforeKill,
        `expected the record's ended_at to remain untouched by the later no-op kill() (no re-transition/double-emit), before=${JSON.stringify(endedAtBeforeKill)} after=${JSON.stringify(killBody.result?.structuredContent?.ended_at)}`
      );
      // EVIDENCED SKIP: same reasoning as the sibling "process-group reap"
      // test's own second kill() call above - `kill_confirmed` was already
      // proven `true` before this call was sent, so `reapProcessGroupOnce`'s
      // "already-attempted" branch (a plain synchronous in-memory read, no
      // fresh confirmation wait) is all this second call can ever hit.
      assert.equal(
        killBody.result?.structuredContent?.kill_confirmed,
        true,
        `expected kill_confirmed to remain true, unchanged by the later no-op kill(), got: ${JSON.stringify(killBody.result?.structuredContent)}`
      );

      server.child.kill("SIGKILL");
    }
  );

  test(
    "a terminal record whose attached group has ALREADY GONE (zero live members, confirmed via a real external pgrep before the second kill() call) is an idempotent no-op - no signal reaches anything alive, INCLUDING a real, separately-tracked LIVE BYSTANDER job (an attempted, ESRCH-returning group signal against THIS job's own empty group is the normal, accepted way that absence is discovered), and the record's terminal state is UNCHANGED - distinct from the live-descendants reap above, where a real reap IS required",
    {
      skip:
        process.platform === "win32"
          ? "real process tracked via pgrep -g, POSIX-only - no equivalent root-exits-first fix on Windows today"
          : false,
    },
    async (t) => {
      const server = tracked();
      // Guaranteed cleanup for any path that never reaches this test's own
      // explicit server.child.kill() below - see the guaranteed-cleanup fix
      // in test/modern-handshake.test.ts for the
      // full rationale. A backstop only:
      // server.child.killed is already true by the time this runs on every
      // normal green pass.
      t.after(() => {
        if (!server.child.killed) server.child.kill("SIGKILL");
      });
      await completeHandshake(server);

      const dir = makeTempDir();
      const marker = path.join(dir, "pgid.txt");
      // A genuinely short-lived real command: the shell writes its own pid
      // (== the pgid, since spawnManaged always makes the child its own
      // detached group leader) to the marker, then runs `true` and exits
      // ON ITS OWN - no `exec`, no backgrounded descendants, nothing left
      // alive under this pgid once the job reaches a terminal record.
      const shellCommand = `echo $$ > '${marker}'; true`;

      // A SEPARATE, real, LIVE bystander job - its own distinct process group,
      // started alongside the terminal job above and left running for the
      // rest of this test, so an implementation that reaps every tracked
      // job's process group (instead of only the one whose kill() was
      // actually called) has something observable to signal: the bystander
      // remaining alive and untouched is what this test checks.
      const bystanderMarker = path.join(dir, "bystander-pgid.txt");
      const bystanderCommand = `echo $$ > '${bystanderMarker}'; exec sleep 30`;

      // Declared here, assigned inside the try - so a guaranteed, finally-owned
      // cleanup can reach it (best-effort) even if a LATER assertion throws
      // before reaching this test's own normal end-of-test cleanup lines,
      // which would otherwise leak the live bystander and its MCP server
      // child on a failing assertion.
      let bystanderPgid: number | undefined;
      try {
        server.send({
          jsonrpc: "2.0",
          id: 559,
          method: "tools/call",
          params: { name: "run", arguments: { command: bystanderCommand, shell: true } },
        });
        const bystanderRunLine = await server.nextLine();
        const bystanderRunBody = bystanderRunLine.parsed as RunResponseBody;
        assert.equal(bystanderRunBody.error, undefined);
        assert.notEqual(
          bystanderRunBody.result?.isError,
          true,
          `bystander run() must succeed: ${JSON.stringify(bystanderRunBody)}`
        );
        const bystanderJobId = bystanderRunBody.result?.structuredContent?.job_id as string;
        assert.equal(typeof bystanderJobId, "string");
        const bystanderPgidText = await waitForFile(bystanderMarker, { until: parsesAsPgid });
        bystanderPgid = Number(bystanderPgidText.trim());
        assert.ok(
          Number.isInteger(bystanderPgid) && bystanderPgid > 0,
          `expected a real numeric bystander pgid, got: ${JSON.stringify(bystanderPgidText)}`
        );
        const bystanderBefore = await waitForPgrepGroupMembers(
          bystanderPgid,
          (members) => members.length >= 1,
          3000
        );
        assert.ok(
          bystanderBefore.length >= 1,
          `expected the real bystander process alive before the empty-group kill() runs, pgrep saw: ${JSON.stringify(bystanderBefore)}`
        );

        server.send({
          jsonrpc: "2.0",
          id: 560,
          method: "tools/call",
          params: { name: "run", arguments: { command: shellCommand, shell: true } },
        });
        const runLine = await server.nextLine();
        const runBody = runLine.parsed as RunResponseBody;
        assert.equal(runBody.error, undefined);
        assert.notEqual(
          runBody.result?.isError,
          true,
          `run() must succeed: ${JSON.stringify(runBody)}`
        );
        const jobId = runBody.result?.structuredContent?.job_id as string;
        assert.equal(typeof jobId, "string");

        const pgidText = await waitForFile(marker, { until: parsesAsPgid });
        const pgid = Number(pgidText.trim());
        assert.ok(
          Number.isInteger(pgid) && pgid > 0,
          `expected a real numeric pgid from the marker file, got: ${JSON.stringify(pgidText)}`
        );

        // Poll status() until the job RECORD is genuinely terminal AND the
        // eager reap's own async confirmation has landed - a bare
        // terminal-state check is NOT enough here, matching the
        // live-descendants test above (see that test's own poll loop docs
        // for why both conditions are needed). This job's leader has no
        // descendants at all ("no exec, no backgrounded descendants" per
        // this test's own shellCommand comment above), so it IS the last
        // member of its own group and the group empties at exactly its own
        // exit - precisely the "no continuity reaches this server's own
        // callback" case src/tools/kill.ts's own doc comment describes,
        // with a real gap, "deliberately never stated as a wall-clock
        // bound", before `kill_confirmed` settles. FIX: this loop
        // previously broke on `state` alone, which left the very next
        // assertion (kill_confirmed === true, below) reading a snapshot
        // that could still be mid-race - now fixed to match its sibling.
        //
        // No fixed deadline: a breadcrumb on a fixed cadence (never a
        // threshold) keeps a runner-level timeout legible if it fires,
        // without asserting a bound the contract declines to give.
        const statusBreadcrumbIntervalMs = 5000;
        let statusLastBreadcrumbAt = Date.now();
        let statusBody: RunResponseBody | undefined;
        for (;;) {
          server.send({
            jsonrpc: "2.0",
            id: 561,
            method: "tools/call",
            params: { name: "status", arguments: { job_id: jobId } },
          });
          const statusLine = await server.nextLine();
          statusBody = statusLine.parsed as RunResponseBody;
          const state = statusBody.result?.structuredContent?.state as string | undefined;
          const killConfirmed = statusBody.result?.structuredContent?.kill_confirmed;
          const isTerminal = state !== undefined && state !== "starting" && state !== "running";
          if (isTerminal && killConfirmed !== undefined) break;
          if (Date.now() - statusLastBreadcrumbAt >= statusBreadcrumbIntervalMs) {
            console.error(
              `still waiting for the job's own record to go terminal AND the eager reap's confirmation to land for job ${jobId}, last saw: ${JSON.stringify(statusBody?.result?.structuredContent)}`
            );
            statusLastBreadcrumbAt = Date.now();
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(
          statusBody?.result?.structuredContent?.state,
          "exited",
          `expected the record to be "exited" before kill() ever ran, got: ${JSON.stringify(statusBody?.result?.structuredContent)}`
        );
        const endedAtBeforeKill = statusBody?.result?.structuredContent?.ended_at;
        assert.equal(typeof endedAtBeforeKill, "string");
        // The eager reap runs at leader-exit for EVERY job, including one
        // with nothing to reap at all: `kill_confirmed` means the process
        // group was OBSERVED EMPTY, a STATE, never that an action ("a kill")
        // was performed - so it is already `true` here, before any kill()
        // call, exactly as honestly as the live-descendants test above. The
        // poll loop just above is what actually guarantees this value has
        // settled by the time this assertion runs.
        assert.equal(
          statusBody?.result?.structuredContent?.kill_confirmed,
          true,
          `expected kill_confirmed: true from the eager reap alone (the group was already observed empty), before any kill() call, got: ${JSON.stringify(statusBody?.result?.structuredContent)}`
        );

        // THE pre-condition this subcell is actually about, confirmed via a
        // REAL, independent external check (never our own bookkeeping): the
        // process group has ZERO live members BEFORE the second kill() call
        // ever runs - so any attempted group signal that call makes can only
        // ever observe ESRCH ("nothing there"), never reach anything alive.
        const beforeSecondKill = await waitForPgrepGroupMembers(
          pgid,
          (members) => members.length === 0,
          3000
        );
        assert.deepEqual(
          beforeSecondKill,
          [],
          `expected the process group to already be fully gone before the second kill() call, pgrep saw: ${JSON.stringify(beforeSecondKill)}`
        );

        // THE proof: kill() on a terminal record whose group is ALREADY gone
        // must succeed as a plain idempotent no-op - the named mutant this
        // test guards against is a change that treats the resulting
        // ESRCH-on-an-already-gone-group as some kind of failure (instead of
        // the expected/accepted outcome an external observer cannot tell
        // apart from "nothing was ever there"), or that re-transitions the
        // record's terminal state.
        server.send({
          jsonrpc: "2.0",
          id: 562,
          method: "tools/call",
          params: { name: "kill", arguments: { job_id: jobId } },
        });
        const killLine = await server.nextLine(8000);
        const killBody = killLine.parsed as RunResponseBody;
        assert.equal(
          killBody.error,
          undefined,
          `kill() on an already-gone terminal group must never surface as a JSON-RPC protocol-level error: ${JSON.stringify(killBody)}`
        );
        assert.notEqual(
          killBody.result?.isError,
          true,
          `kill() on an already-gone terminal group must succeed as a plain no-op: ${JSON.stringify(killBody)}`
        );

        // THE "no re-transition, no double state-change emission" proof: the
        // record's own state is UNCHANGED ("exited", never rewritten to
        // "killed" or anything else), and its ended_at timestamp - touched
        // only by a real mark* state transition - is byte-identical to what
        // it was before this second kill() call.
        assert.equal(killBody.result?.structuredContent?.state, "exited");
        assert.equal(
          killBody.result?.structuredContent?.ended_at,
          endedAtBeforeKill,
          `expected the record's ended_at to be untouched (no re-transition/double-emit), before=${JSON.stringify(endedAtBeforeKill)} after=${JSON.stringify(killBody.result?.structuredContent?.ended_at)}`
        );
        // EVIDENCED SKIP: safe for the same reason as the other second-
        // kill()-call assertions in this file - `kill_confirmed` was
        // already proven `true` (via the now-fixed poll loop above) before
        // this second kill() call was ever sent, so `reapProcessGroupOnce`'s
        // "already-attempted" branch (a plain synchronous in-memory read,
        // no fresh confirmation wait) is all this call can ever hit.
        assert.equal(
          killBody.result?.structuredContent?.kill_confirmed,
          true,
          `expected kill_confirmed to remain true - already set true by the eager reap before this call, unchanged by this no-op kill(), got: ${JSON.stringify(killBody.result?.structuredContent)}`
        );

        // THE independent proof, repeated AFTER kill(): the group is still
        // (and was always) genuinely empty - nothing was ever delivered to a
        // live process, because nothing alive was ever there to receive it.
        const afterSecondKill = pgrepGroupMembers(pgid);
        assert.deepEqual(
          afterSecondKill,
          [],
          `expected the process group to remain empty - no live process was ever signaled, pgrep saw: ${JSON.stringify(afterSecondKill)}`
        );

        // The SEPARATE, live bystander job - a DIFFERENT job's process group
        // entirely - must be completely untouched by this empty-group
        // kill(). This is what an implementation reaping every tracked job
        // (instead of only the one this kill() call named) would violate.
        const bystanderAfter = pgrepGroupMembers(bystanderPgid);
        assert.ok(
          bystanderAfter.length >= 1,
          `expected the separate live bystander job to remain alive and untouched by the empty-group kill(), pgrep saw: ${JSON.stringify(bystanderAfter)}`
        );
      } finally {
        // Bounded, finally-owned cleanup on BOTH success and failure - the
        // bystander is a real live process regardless of which assertion
        // above may have thrown, so real cleanup and a real absence-check
        // both run here unconditionally.
        if (bystanderPgid !== undefined) {
          try {
            process.kill(-bystanderPgid, "SIGKILL");
          } catch {
            // already gone - this is best-effort regardless.
          }
          await waitForPgrepGroupMembers(bystanderPgid, (members) => members.length === 0, 3000);
          const finalBystanderMembers = pgrepGroupMembers(bystanderPgid);
          assert.deepEqual(
            finalBystanderMembers,
            [],
            `the bystander must be genuinely reaped before this test finishes, pgrep still saw: ${JSON.stringify(finalBystanderMembers)}`
          );
        }
        server.child.kill("SIGKILL");
      }
    }
  );

  // ---------------------------------------------------------------------------
  // A permanent, always-green regression for the finally-owned cleanup
  // pattern itself: a real, live process spawned inside a try block that
  // then deliberately throws must still be reaped by that try's own
  // finally, proving the pattern the test above (and the escape-descendant
  // test's own finally) both rely on actually works on the failure path.
  // ---------------------------------------------------------------------------
  test(
    "finally-owned cleanup pattern: a real live process spawned inside a try that then throws is still reaped by that try's own finally",
    {
      skip:
        process.platform === "win32"
          ? "spawns a real detached process and reads real pgrep output, POSIX-only"
          : false,
    },
    async (t) => {
      const server = tracked();
      // Guaranteed cleanup for any path that never reaches this test's own
      // explicit server.child.kill() below - see the guaranteed-cleanup fix
      // in test/modern-handshake.test.ts for the
      // full rationale. A backstop only:
      // server.child.killed is already true by the time this runs on every
      // normal green pass.
      t.after(() => {
        if (!server.child.killed) server.child.kill("SIGKILL");
      });
      await completeHandshake(server);

      const dir = makeTempDir();
      const marker = path.join(dir, "pgid.txt");
      const command = `echo $$ > '${marker}'; exec sleep 30`;

      let livePgid: number | undefined;
      const injectedError = new Error("deliberately injected failure - proves finally still reaps");

      await assert.rejects(async () => {
        try {
          server.send({
            jsonrpc: "2.0",
            id: 563,
            method: "tools/call",
            params: { name: "run", arguments: { command, shell: true } },
          });
          const runLine = await server.nextLine();
          const runBody = runLine.parsed as RunResponseBody;
          assert.equal(runBody.error, undefined);
          assert.notEqual(
            runBody.result?.isError,
            true,
            `run() must succeed: ${JSON.stringify(runBody)}`
          );

          const pgidText = await waitForFile(marker, { until: parsesAsPgid });
          livePgid = Number(pgidText.trim());
          assert.ok(Number.isInteger(livePgid) && livePgid > 0);

          const before = await waitForPgrepGroupMembers(
            livePgid,
            (members) => members.length >= 1,
            3000
          );
          assert.ok(
            before.length >= 1,
            `expected the real process alive before the injected throw, pgrep saw: ${JSON.stringify(before)}`
          );

          // The deliberate failure, thrown AFTER the process is confirmed
          // alive and BEFORE any normal (non-finally) cleanup would run -
          // this is the exact shape an unexpected failing assertion takes
          // in the test above.
          throw injectedError;
        } finally {
          if (livePgid !== undefined) {
            try {
              process.kill(-livePgid, "SIGKILL");
            } catch {
              // already gone - best-effort.
            }
            await waitForPgrepGroupMembers(livePgid, (members) => members.length === 0, 3000);
          }
          server.child.kill("SIGKILL");
        }
      }, injectedError);

      // THE proof this regression exists for: despite the throw above, the
      // real process is genuinely gone - reaped by the finally, not left
      // for this outer scope (which has no access to livePgid's cleanup at
      // all) to somehow clean up after the fact.
      assert.ok(
        livePgid !== undefined,
        "expected the live pgid to have been captured before the throw"
      );
      const afterMembers = pgrepGroupMembers(livePgid!);
      assert.deepEqual(
        afterMembers,
        [],
        `expected the process to be genuinely reaped by the try's own finally despite the injected throw, pgrep still saw: ${JSON.stringify(afterMembers)}`
      );
    }
  );
});

test("kill() over the real wire: unknown job_id is a real tool-execution error, never a JSON-RPC protocol error", async (t) => {
  const server = tracked();
  // Guaranteed cleanup for any path that never reaches this test's own
  // explicit server.child.kill() below - see the guaranteed-cleanup fix
  // in test/modern-handshake.test.ts for the
  // full rationale.
  t.after(() => {
    if (!server.child.killed) server.child.kill("SIGKILL");
  });
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 502,
    method: "tools/call",
    params: { name: "kill", arguments: { job_id: "no-such-job-ghantika" } },
  });
  const line = await server.nextLine();
  const body = line.parsed as RunResponseBody;
  assert.equal(body.error, undefined);
  assert.equal(body.result?.isError, true);
  server.child.kill("SIGKILL");
});

describe("kill() over the real wire: post-kill output/tail (against a real spawned job)", () => {
  // Dispatches the real `run` tool over the real wire - scoped here
  // per this file's own top-of-file comment.
  before(requireSpawnPolicy);

  test("kill() over the real wire: output AND tail can both actually read a killed job's buffered lines afterward - the literal assertion, not just a marker-file proxy", async (t) => {
    const server = tracked();
    // Guaranteed cleanup for any path that never reaches this test's own
    // explicit server.child.kill() below - see the guaranteed-cleanup fix
    // in test/modern-handshake.test.ts for the
    // full rationale.
    t.after(() => {
      if (!server.child.killed) server.child.kill("SIGKILL");
    });
    await completeHandshake(server);
    server.send({
      jsonrpc: "2.0",
      id: 505,
      method: "tools/call",
      params: {
        name: "run",
        arguments: { command: "echo before-the-kill; sleep 30", shell: true },
      },
    });
    const runLine = await server.nextLine();
    const runBody = runLine.parsed as RunResponseBody;
    const jobId = runBody.result?.structuredContent?.job_id as string;
    assert.equal(typeof jobId, "string");

    // Wait for the real stdout line to actually materialize (read back via a
    // real status() poll on the public counts field), not a fixed sleep.
    const deadline = Date.now() + 5000;
    for (;;) {
      server.send({
        jsonrpc: "2.0",
        id: 506,
        method: "tools/call",
        params: { name: "status", arguments: { job_id: jobId } },
      });
      const statusLine = await server.nextLine();
      const statusBody = statusLine.parsed as RunResponseBody;
      const counts = statusBody.result?.structuredContent?.counts as
        { stdout_lines: number } | undefined;
      if ((counts?.stdout_lines ?? 0) >= 1) break;
      if (Date.now() > deadline) throw new Error("timed out waiting for the real stdout line");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    server.send({
      jsonrpc: "2.0",
      id: 507,
      method: "tools/call",
      params: { name: "kill", arguments: { job_id: jobId } },
    });
    const killLine = await server.nextLine(8000);
    const killBody = killLine.parsed as RunResponseBody;
    assert.equal(killBody.result?.structuredContent?.state, "killed");

    // THE literal proof: output() and tail() both still work, over the
    // real wire, against a job that is now killed - never mutated by kill().
    server.send({
      jsonrpc: "2.0",
      id: 508,
      method: "tools/call",
      params: { name: "output", arguments: { job_id: jobId, stream: "stdout" } },
    });
    const outputLine = await server.nextLine();
    const outputBody = outputLine.parsed as RunResponseBody;
    assert.notEqual(
      outputBody.result?.isError,
      true,
      `output() must succeed post-kill: ${JSON.stringify(outputBody)}`
    );
    const outputEvents = outputBody.result?.structuredContent?.events as
      Array<{ text: string }> | undefined;
    assert.ok(
      outputEvents?.some((event) => event.text.includes("before-the-kill")),
      `expected output() to still return the buffered line post-kill, got: ${JSON.stringify(outputEvents)}`
    );

    server.send({
      jsonrpc: "2.0",
      id: 509,
      method: "tools/call",
      params: { name: "tail", arguments: { job_id: jobId, stream: "stdout", lines: 5 } },
    });
    const tailLine = await server.nextLine();
    const tailBody = tailLine.parsed as RunResponseBody;
    assert.notEqual(
      tailBody.result?.isError,
      true,
      `tail() must succeed post-kill: ${JSON.stringify(tailBody)}`
    );
    const tailEvents = tailBody.result?.structuredContent?.events as
      Array<{ text: string }> | undefined;
    assert.ok(
      tailEvents?.some((event) => event.text.includes("before-the-kill")),
      `expected tail() to still return the buffered line post-kill, got: ${JSON.stringify(tailEvents)}`
    );

    server.child.kill("SIGKILL");
  });
});

// Two distinct, independently false claims the guards below reject: "the
// containment reaches the whole tree" (a scope claim) and "zero
// descendants ever survive" (an outcome claim). A guard that only
// rejects one and not the other is only half a guard, so each gets its
// own check everywhere below.
const FORBIDDEN_WHOLE_TREE_CLAIM_SUBSTRING =
  "This tool terminates the entire process tree, no exceptions.";
const FORBIDDEN_ZERO_DESCENDANTS_CLAIM_SUBSTRING = "Zero descendant processes ever survive a kill.";

// ---------------------------------------------------------------------------
// PERMANENT ESCAPED-DESCENDANT REGRESSION TEST: converts a real-wire escape
// proof into an executable, permanent guard. Drives the REAL built server
// over its real stdio JSON-RPC wire: the job's leader spawns a SECOND real
// process with detached:true + unref(), so it becomes its OWN process-group
// leader - a genuine setsid-class escape, distinct from mere reparenting.
// Asserts BOTH halves: (1) the GROUP-SCOPED guarantee holds - every process
// still in the job's ORIGINAL group is gone, and kill_confirmed is truthful
// about what it observed; (2) the ESCAPED descendant SURVIVES and is
// honestly OUT OF SCOPE - the response never claims whole-tree
// termination. Reaps the escapee and verifies its absence, with
// finally-owned cleanup bounded on success AND failure, before finishing -
// this test deliberately creates an orphan under PPID 1 and must never
// leak one.
//
// Also checks, against the description actually served over the wire: the
// required original-PGID-observer sentence is present, and neither of the
// two forbidden claims above (whole-tree-termination,
// zero-surviving-descendants) is present alongside it - proving the guard
// actually rejects forbidden text, not merely confirms the accurate text
// is present somewhere.
//
// SCOPE LIMIT: a stdio response cannot prove README semantics, so this test
// never asserts README content - the prose-guard tests below own that
// separately.
describe("kill: the real setsid-class escaped-descendant regression (against a real spawned job)", () => {
  // Dispatches the real `run` tool over the real wire - scoped here
  // per this file's own top-of-file comment.
  before(requireSpawnPolicy);

  test(
    "kill: a REAL setsid-class escaped descendant (detached:true + unref()) survives kill() and is honestly out of scope - the original process group is confirmed gone, the escapee is not claimed to be",
    {
      skip:
        process.platform === "win32"
          ? "spawns a real detached escapee and reads real pgrep output, POSIX-only"
          : false,
    },
    async (t) => {
      const server = tracked();
      // Guaranteed cleanup for any path that never reaches this test's own
      // explicit server.child.kill() below - see the guaranteed-cleanup fix
      // in test/modern-handshake.test.ts for the
      // full rationale. A backstop only:
      // server.child.killed is already true by the time this runs on every
      // normal green pass.
      t.after(() => {
        if (!server.child.killed) server.child.kill("SIGKILL");
      });
      await completeHandshake(server);

      const dir = makeTempDir();
      const marker = path.join(dir, "pgid.txt");
      const escapeMarker = path.join(dir, "escapee-pid.txt");
      const escapeScript = path.join(dir, "escape.js");
      // A standalone script (never an inline shell one-liner, to avoid any
      // nested-quoting hazard) that spawns a SEPARATE, genuinely detached
      // process - its own session/group, unref()'d so this script's own
      // exit doesn't wait on or affect it - and records that process's real
      // pid before exiting.
      fs.writeFileSync(
        escapeScript,
        [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {",
          "  detached: true,",
          "  stdio: 'ignore',",
          "});",
          "child.unref();",
          "fs.writeFileSync(process.argv[2], String(child.pid) + '\\n');",
        ].join("\n")
      );
      // The job's own leader: writes its own pid (== the group's pgid,
      // since spawnManaged spawns it detached) to the marker, runs the
      // escape script (which exits quickly, having already detached its
      // own grandchild), then execs into a real, long-lived `sleep` so the
      // leader itself stays alive - and stays the ONLY member of its own
      // group - until this test kills it.
      const shellCommand = `echo $$ > '${marker}'; node '${escapeScript}' '${escapeMarker}'; exec sleep 30`;

      let escapeePid: number | undefined;
      try {
        server.send({
          jsonrpc: "2.0",
          id: 570,
          method: "tools/call",
          params: { name: "run", arguments: { command: shellCommand, shell: true } },
        });
        const runLine = await server.nextLine();
        const runBody = runLine.parsed as RunResponseBody;
        assert.equal(runBody.error, undefined);
        assert.notEqual(
          runBody.result?.isError,
          true,
          `run() must succeed: ${JSON.stringify(runBody)}`
        );
        const jobId = runBody.result?.structuredContent?.job_id as string;
        assert.equal(typeof jobId, "string");

        const pgidText = await waitForFile(marker, { until: parsesAsPgid });
        const pgid = Number(pgidText.trim());
        assert.ok(
          Number.isInteger(pgid) && pgid > 0,
          `expected a real numeric pgid from the marker file, got: ${JSON.stringify(pgidText)}`
        );

        const escapeePidText = await waitForFile(escapeMarker, { until: parsesAsPgid });
        escapeePid = Number(escapeePidText.trim());
        assert.ok(
          Number.isInteger(escapeePid) && escapeePid > 0,
          `expected a real numeric escapee pid from its own marker file, got: ${JSON.stringify(escapeePidText)}`
        );
        assert.notEqual(
          escapeePid,
          pgid,
          "the escapee must be a genuinely different process from the job's own leader/group"
        );

        // Confirm BOTH are actually alive, in their own SEPARATE groups,
        // before ever touching kill().
        const beforeGroupMembers = await waitForPgrepGroupMembers(
          pgid,
          (members) => members.length >= 1,
          3000
        );
        assert.ok(
          beforeGroupMembers.length >= 1,
          `expected the job's own group alive before kill, pgrep saw: ${JSON.stringify(beforeGroupMembers)}`
        );
        const beforeEscapeeMembers = await waitForPgrepGroupMembers(
          escapeePid,
          (members) => members.length >= 1,
          3000
        );
        assert.ok(
          beforeEscapeeMembers.length >= 1,
          `expected the real escapee alive in its own group before kill, pgrep saw: ${JSON.stringify(beforeEscapeeMembers)}`
        );

        server.send({
          jsonrpc: "2.0",
          id: 571,
          method: "tools/call",
          params: { name: "kill", arguments: { job_id: jobId, signal: "SIGKILL" } },
        });
        const killLine = await server.nextLine(8000);
        const killBody = killLine.parsed as RunResponseBody;
        assert.equal(killBody.error, undefined);
        assert.notEqual(
          killBody.result?.isError,
          true,
          `kill() must succeed: ${JSON.stringify(killBody)}`
        );

        // HALF 1: the GROUP-SCOPED guarantee holds - the job's OWN group is
        // confirmed gone, and kill_confirmed is truthful about that.
        //
        // EVIDENCED SKIP (reviewed for the kill_confirmed-staleness class):
        // same reasoning as the other explicit-SIGKILL site above (see its
        // own comment) - the custom-signal branch in src/tools/kill.ts
        // `await`s `confirmProcessGroupReapedPosix` in-line before ever
        // returning this response, so `kill_confirmed` is already decided
        // (never a separate fire-and-forget write racing this read) by the
        // time `killBody` is captured, with no wait sitting between capture
        // and this assertion either.
        assert.equal(
          killBody.result?.structuredContent?.state,
          "killed",
          `expected the job's own group to actually be killed, got: ${JSON.stringify(killBody.result?.structuredContent)}`
        );
        assert.equal(
          killBody.result?.structuredContent?.kill_confirmed,
          true,
          `expected kill_confirmed: true - the job's OWN group is genuinely gone, got: ${JSON.stringify(killBody.result?.structuredContent)}`
        );

        const afterGroupMembers = await waitForPgrepGroupMembers(
          pgid,
          (members) => members.length === 0,
          3000
        );
        assert.deepEqual(
          afterGroupMembers,
          [],
          `expected the job's OWN process group to be fully reaped, pgrep still saw: ${JSON.stringify(afterGroupMembers)}`
        );

        // HALF 2: the escaped descendant SURVIVES - it left the job's group
        // before the signal, so kill(-pgid) was never reachable to it.
        const afterEscapeeMembers = pgrepGroupMembers(escapeePid);
        assert.ok(
          afterEscapeeMembers.length >= 1,
          `expected the escaped descendant to SURVIVE this kill() call, pgrep saw: ${JSON.stringify(afterEscapeeMembers)}`
        );

        // Check the tools/list description actually served over the wire -
        // never the in-process import, since this is a real-wire test.
        server.send({ jsonrpc: "2.0", id: 572, method: "tools/list" });
        const listLine = await server.nextLine();
        const listBody = listLine.parsed as {
          result: { tools: Array<{ name: string; description: string }> };
        };
        const killToolDescription = listBody.result.tools.find(
          (t) => t.name === "kill"
        )?.description;
        assert.equal(typeof killToolDescription, "string");
        // This exact sentence is the required original-PGID-observer text;
        // its absence, regardless of whatever replaces it, is what this
        // assertion catches.
        assert.ok(
          killToolDescription!.includes(
            "no processes still assigned to the job's ORIGINAL PROCESS GROUP"
          ),
          `expected the kill tool's SERVED tools/list description to contain the required original-PGID-observer sentence, got: ${JSON.stringify(killToolDescription)}`
        );
        // A whole-tree-termination claim must never be present, even
        // alongside the accurate sentence above staying intact - a
        // positive-only check would pass while this sits right next to it.
        assert.ok(
          !killToolDescription!.includes(FORBIDDEN_WHOLE_TREE_CLAIM_SUBSTRING),
          `expected the kill tool's SERVED tools/list description to NEVER contain a whole-tree-termination claim, even beside the accurate sentence - found it present, got: ${JSON.stringify(killToolDescription)}`
        );
        // A zero-surviving-descendants claim is a different false claim from
        // the whole-tree claim above - both get their own independent check,
        // since a guard that only rejects one would miss the other.
        assert.ok(
          !killToolDescription!.includes(FORBIDDEN_ZERO_DESCENDANTS_CLAIM_SUBSTRING),
          `expected the kill tool's SERVED tools/list description to NEVER contain a zero-surviving-descendants claim, even beside the accurate sentence - found it present, got: ${JSON.stringify(killToolDescription)}`
        );
      } finally {
        // Bounded, finally-owned cleanup on BOTH success and failure: reap
        // the escapee (a real orphan under PPID 1, never reachable by any
        // group-scoped kill()) and verify its absence, then the job's own
        // group/server - regardless of which assertion above may have
        // thrown. FALLBACK: if an earlier assertion threw before
        // `escapeePid` itself could be assigned (e.g. the marker-file wait
        // failed for an unrelated reason), the escape script may still have
        // spawned and written a real pid to disk - read it directly, best
        // effort, so a genuinely orphaned process is never left behind just
        // because this test's own bookkeeping didn't capture its id.
        let cleanupPid = escapeePid;
        if (cleanupPid === undefined) {
          try {
            const raw = fs.readFileSync(escapeMarker, "utf8").trim();
            const parsed = Number(raw);
            if (Number.isInteger(parsed) && parsed > 0) cleanupPid = parsed;
          } catch {
            // marker was never written at all - nothing to reap
          }
        }
        if (cleanupPid !== undefined) {
          try {
            process.kill(cleanupPid, "SIGKILL");
          } catch {
            // already gone - fine, this is a best-effort reap
          }
          await waitForPgrepGroupMembers(cleanupPid, (members) => members.length === 0, 3000);
          const finalEscapeeMembers = pgrepGroupMembers(cleanupPid);
          assert.deepEqual(
            finalEscapeeMembers,
            [],
            `the escapee must be genuinely reaped before this test finishes, pgrep still saw: ${JSON.stringify(finalEscapeeMembers)}`
          );
        }
        server.child.kill("SIGKILL");
      }
    }
  );
});

// ---------------------------------------------------------------------------
// The escape-boundary disclosure's OWN prose guard - BOTH the FACT (a
// descendant that calls setsid() or moves into another process group is
// neither signaled nor observed, and reparenting alone is NOT such an
// escape) AND the CONSEQUENCE (the caller must track/terminate such a
// process itself - this tool will not) - must be present on TWO
// INDEPENDENT surfaces: README.md and the kill tool's own tools/list
// description. Separate from the permanent real-wire escape test
// above, which drives the actual stdio response and cannot prove README
// semantics - this test never touches the wire, and that one never
// asserts README content.
//
// Each surface is checked for the disclosure's FACT half, its CONSEQUENCE
// half, and the absence of two independently false claims that could sit
// beside an otherwise-intact disclosure: a whole-tree-termination claim
// and a zero-surviving-descendants claim. A guard that only rejects one
// false claim and not the other is only half a guard, so each gets its
// own check on both surfaces.
// ---------------------------------------------------------------------------

/**
 * The disclosure's FACT half, common to both surfaces once each surface's
 * own leading article/markdown is stripped - README's own copy reads "a
 * descendant that calls..." (lowercase, mid-sentence after "**Escape
 * boundary:**"), the tools/list description's copy reads "A descendant
 * that calls..." (capitalized, its own sentence) - so this constant starts
 * right after that one differing letter, and is checked as a
 * case-sensitive substring against both.
 */
const ESCAPE_BOUNDARY_FACT_SUBSTRING =
  "descendant that calls setsid() or otherwise moves itself into a different process group is neither signaled by this containment nor observed by its confirmation check; reparenting alone is not such an escape, since reparenting changes a process's parent, never its process group.";

/** The disclosure's CONSEQUENCE half - byte-identical on both surfaces (both are fresh sentences there, so no leading-letter split is needed). */
const ESCAPE_BOUNDARY_CONSEQUENCE_SUBSTRING =
  "If your command spawns a process that detaches into its own group or session, you are responsible for tracking and terminating it yourself - this tool will not, and does not claim to.";

function readReadmeText(): string {
  return fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
}

test("escape-boundary prose guard, (README.md): states the FACT and CONSEQUENCE, and never either forbidden claim", () => {
  const readme = readReadmeText();
  assert.ok(
    readme.includes(ESCAPE_BOUNDARY_FACT_SUBSTRING),
    "expected README.md to state the escape-boundary FACT (setsid()/different-process-group escape, reparenting alone is NOT an escape) - it is missing"
  );
  assert.ok(
    readme.includes(ESCAPE_BOUNDARY_CONSEQUENCE_SUBSTRING),
    "expected README.md to state the escape-boundary's CONSEQUENCE (the caller must track/terminate a detached descendant itself) - a boundary stated without its consequence is half a disclosure"
  );
  assert.ok(
    !readme.includes(FORBIDDEN_WHOLE_TREE_CLAIM_SUBSTRING),
    "expected README.md to NEVER contain a whole-tree-termination claim, even beside the accurate fact and consequence - found it present"
  );
  assert.ok(
    !readme.includes(FORBIDDEN_ZERO_DESCENDANTS_CLAIM_SUBSTRING),
    "expected README.md to NEVER contain a zero-surviving-descendants claim, even beside the accurate fact and consequence - found it present"
  );
});

test("escape-boundary prose guard, (the kill tool's tools/list description): states the FACT and CONSEQUENCE, and never either forbidden claim", () => {
  const description = killTool.description as string;
  assert.ok(
    description.includes(ESCAPE_BOUNDARY_FACT_SUBSTRING),
    "expected the kill tool's tools/list description to state the escape-boundary FACT (setsid()/different-process-group escape, reparenting alone is NOT an escape) - it is missing"
  );
  assert.ok(
    description.includes(ESCAPE_BOUNDARY_CONSEQUENCE_SUBSTRING),
    "expected the kill tool's tools/list description to state the escape-boundary's CONSEQUENCE (the caller must track/terminate a detached descendant itself) - a boundary stated without its consequence is half a disclosure"
  );
  assert.ok(
    !description.includes(FORBIDDEN_WHOLE_TREE_CLAIM_SUBSTRING),
    "expected the kill tool's tools/list description to NEVER contain a whole-tree-termination claim, even beside the accurate fact and consequence - found it present"
  );
  assert.ok(
    !description.includes(FORBIDDEN_ZERO_DESCENDANTS_CLAIM_SUBSTRING),
    "expected the kill tool's tools/list description to NEVER contain a zero-surviving-descendants claim, even beside the accurate fact and consequence - found it present"
  );
});

// ---------------------------------------------------------------------------
// A SEPARATE prose guard, on the SAME two public surfaces, for a DIFFERENT
// claim: the state-vs-fields distinction for a terminating custom signal.
// Asserts each surface states the ACCURATE consequence - for a
// non-terminating custom signal (SIGSTOP) confirmation gates the terminal
// state; for a terminating one (explicit SIGKILL) the state may
// INDEPENDENTLY reach "killed" via the signal-exit race while BOTH
// kill_confirmed AND identity_confirmed remain ABSENT until confirmation
// resolves - and never re-broadens back to the retired universal ("a
// terminating custom signal only becomes terminal after confirmation").
//
// Each surface is checked for the accurate distinction's presence, plus
// the absence of two independently false claims that could sit beside it:
// the retired "a terminating custom signal only becomes terminal after
// confirmation" universal, and a false claim that the confirmation
// fields arrive together with the early terminal state. The disclosure
// carries two separately load-bearing facts (the exit race may terminalize
// the state before confirmation, AND the confirmation fields stay absent
// until confirmation lands), so a guard that only rejects the
// state-ordering claim does not thereby reject the fields claim - each
// gets its own check, on both surfaces.
// ---------------------------------------------------------------------------

/** The accurate state-vs-fields distinction, README's own exact wording. */
const STATE_VS_FIELDS_README_SUBSTRING =
  "the real process can also exit on its own the moment the signal lands, independent of confirmation, so the job's `killed` state can legitimately show up before confirmation ever resolves";

/** The accurate state-vs-fields distinction, tools/list's own exact wording (a fresh sentence there, not a shared substring with README). */
const STATE_VS_FIELDS_TOOLSLIST_SUBSTRING =
  'the state can independently reach "killed" via the process\'s own real exit, while both fields still stay simply absent - never false - until confirmation actually lands';

/** The retired, forbidden universal claim - present in either surface at all is itself the failure, regardless of what else sits beside it. */
const FALSE_UNIVERSAL_SUBSTRING =
  "a terminating custom signal only becomes terminal after confirmation";

/**
 * A second, independently false claim about the same disclosure - not a
 * state-ordering claim but a fields-arrival claim: the guard against
 * `FALSE_UNIVERSAL_SUBSTRING` does not by itself reject this one, so it
 * needs its own forbidden-text constant and its own assertion - the same
 * masking-resistance requirement as the whole-tree vs
 * zero-surviving-descendants split above.
 */
const FALSE_EARLY_CONFIRMATION_FIELDS_SUBSTRING =
  "A terminating custom signal's `killed` state always carries `kill_confirmed` and `identity_confirmed` immediately, even before external confirmation resolves.";

test("state-vs-fields prose guard, (README.md): states the accurate distinction and never either retired false claim", () => {
  const readme = readReadmeText();
  assert.ok(
    readme.includes(STATE_VS_FIELDS_README_SUBSTRING),
    "expected README.md to state the accurate state-vs-fields distinction for a terminating custom signal - it is missing or has been reworded away"
  );
  assert.ok(
    !readme.includes(FALSE_UNIVERSAL_SUBSTRING),
    "expected README.md to NEVER state the retired false universal ('a terminating custom signal only becomes terminal after confirmation') - found it present, even if the accurate distinction sits beside it"
  );
  assert.ok(
    !readme.includes(FALSE_EARLY_CONFIRMATION_FIELDS_SUBSTRING),
    "expected README.md to NEVER claim kill_confirmed/identity_confirmed arrive immediately with the early terminal state - found it present, even if the accurate distinction sits beside it"
  );
});

test("state-vs-fields prose guard, (the kill tool's tools/list description): states the accurate distinction and never either retired false claim", () => {
  const description = killTool.description as string;
  assert.ok(
    description.includes(STATE_VS_FIELDS_TOOLSLIST_SUBSTRING),
    "expected the kill tool's tools/list description to state the accurate state-vs-fields distinction for a terminating custom signal - it is missing or has been reworded away"
  );
  assert.ok(
    !description.includes(FALSE_UNIVERSAL_SUBSTRING),
    "expected the kill tool's tools/list description to NEVER state the retired false universal ('a terminating custom signal only becomes terminal after confirmation') - found it present, even if the accurate distinction sits beside it"
  );
  assert.ok(
    !description.includes(FALSE_EARLY_CONFIRMATION_FIELDS_SUBSTRING),
    "expected the kill tool's tools/list description to NEVER claim kill_confirmed/identity_confirmed arrive immediately with the early terminal state - found it present, even if the accurate distinction sits beside it"
  );
});

// ---------------------------------------------------------------------------
// The escalation identity gate: prose guards for the narrowed-residual
// disclosure (the residual is disclosed as MATERIALLY NARROWED, never
// closed or eliminated) and for the no-unqualified-proof-claim guard (no
// "provably"/unqualified-proof claim beside the identity matcher), the
// latter applied across every applicable public surface - README.md, the
// served kill tool description, CHANGELOG.md, this repo's own source
// comments, AND every commit subject+body in the range - so a claim
// sitting only in a commit message can never slip past this guard
// unexamined the way it once did. Plus the wire-level combined-degraded
// cell.
// ---------------------------------------------------------------------------

/**
 * The narrowed-residual sentence, byte-identical on both surfaces up to
 * the point they diverge (README appends its own explicit "narrowed,
 * never closed or eliminated" clause; the served description does not
 * repeat that exact tail, but never claims the opposite either - checked
 * separately below).
 */
const NARROWED_RESIDUAL_REQUIRED_SUBSTRING =
  "This narrows the residual described above materially, not completely: the check and the signal remain two separate syscalls, so a member proven alive an instant before the SIGKILL runs can still exit, and an unrelated group receiving the exact same recycled id within the same whole second could still read as a match";

/** A planted claim that the escalation gate's residual is fully closed - independently false from "eliminated" below, so each needs its own row. */
const FORBIDDEN_ESCALATION_CLOSED_CLAIM =
  "This closes the residual described above, not merely narrows it";
/** A planted claim that the escalation gate's residual is fully eliminated - independently false from "closed" above. */
const FORBIDDEN_ESCALATION_ELIMINATED_CLAIM =
  "the escalation identity gate eliminates the check-to-signal race entirely";

test("narrowed-residual prose guard, (README.md): states the residual is MATERIALLY NARROWED and never claims it is closed or eliminated", () => {
  const readme = readReadmeText();
  assert.ok(
    readme.includes(NARROWED_RESIDUAL_REQUIRED_SUBSTRING),
    "expected README.md to state the escalation gate's residual is materially narrowed, not completely closed - it is missing or has been reworded away"
  );
  assert.ok(
    !readme.includes(FORBIDDEN_ESCALATION_CLOSED_CLAIM),
    "expected README.md to NEVER claim the escalation gate's residual is fully closed"
  );
  assert.ok(
    !readme.includes(FORBIDDEN_ESCALATION_ELIMINATED_CLAIM),
    "expected README.md to NEVER claim the escalation gate's residual is fully eliminated"
  );
});

test("narrowed-residual prose guard, (the kill tool's tools/list description): states the residual is MATERIALLY NARROWED and never claims it is closed or eliminated", () => {
  const description = killTool.description as string;
  assert.ok(
    description.includes(NARROWED_RESIDUAL_REQUIRED_SUBSTRING),
    "expected the kill tool's tools/list description to state the escalation gate's residual is materially narrowed, not completely closed - it is missing or has been reworded away"
  );
  assert.ok(
    !description.includes(FORBIDDEN_ESCALATION_CLOSED_CLAIM),
    "expected the kill tool's tools/list description to NEVER claim the escalation gate's residual is fully closed"
  );
  assert.ok(
    !description.includes(FORBIDDEN_ESCALATION_ELIMINATED_CLAIM),
    "expected the kill tool's tools/list description to NEVER claim the escalation gate's residual is fully eliminated"
  );
});

/**
 * The no-unqualified-proof-claim guard below is scoped specifically to the
 * escalation-identity-gate paragraph on each surface (delimited by these
 * two anchors, both real substrings the escalation identity gate's own
 * prose introduced), rather than the whole file: a PRE-EXISTING, unrelated
 * "provably" usage already lives elsewhere in both README.md and kill.ts
 * (the reap-once continuity argument for a DIFFERENT mechanism entirely,
 * which is why that usage is out of scope for this rule), so a whole-file
 * ban would false-positive on an already-correct sentence. This function
 * extracts the identity-gate's OWN paragraph and checks only that slice.
 * The commit-message check further down uses the same narrow-scoping
 * idea, adapted for unstructured prose that has no such paragraph to
 * delimit - see `extractEscalationGateSentences`'s own docs.
 */
function extractEscalationGateParagraph(text: string): string {
  const start = text.indexOf("A further identity gate applies");
  assert.ok(start >= 0, "expected to find the escalation identity gate's own paragraph start");
  const end = text.indexOf("Before signaling on POSIX", start);
  const slice = end >= 0 ? text.slice(start, end) : text.slice(start, start + 2000);
  return slice;
}

/**
 * The full class this guard checks for: an unqualified "prove"/"proves"/
 * "provably" claim beside the escalation identity matcher (a known
 * false-match path - same-second pid reuse - is admitted elsewhere in
 * this repository, so an unqualified proof claim beside the matcher is a real
 * overclaim), widened from checking only the bare word "provably" to the
 * whole verb family. Shared across every surface below so a paraphrase
 * using "prove"/"proves" instead of "provably" cannot slip past a
 * narrower check.
 */
function assertNoUnqualifiedProofClaim(paragraph: string, surfaceLabel: string): void {
  assert.ok(
    !/\b(provably|proves|prove)\b/i.test(paragraph),
    `expected ${surfaceLabel}'s own escalation-identity-gate text to never claim its matcher "proves"/"provably" identifies the group - a known false-match path (same-second pid reuse) is admitted elsewhere in this repository, so an unqualified proof claim beside the matcher would be a real overclaim. Text: ${JSON.stringify(paragraph)}`
  );
}

/**
 * The three EXACT pre-fix overclaim sentences an earlier disclosure
 * sweep found and narrowed (CHANGELOG.md and two source-comment sites in
 * `src/process.ts`) - each claimed the escalation matcher's real cost
 * "never scales with group size" with no qualification, when the real
 * implementation still constructs, emits, and parses O(N) data for one
 * batch (only the CALL COUNT is size-independent, not the underlying
 * work). Checked as exact forbidden substrings, matching this file's own
 * established narrowed-residual-guard pattern (`FORBIDDEN_ESCALATION_CLOSED_CLAIM`/
 * `FORBIDDEN_ESCALATION_ELIMINATED_CLAIM`), rather than a generic pattern
 * that would also flag this repository's OWN corrected wording (which still
 * says a batched read's CALL COUNT never scales with group size, but now
 * explicitly alongside the acknowledgment that the read's own data cost
 * does) - a bare "never scales"/"scales with" ban would false-positive on
 * that accurate, already-qualified claim.
 */
const FORBIDDEN_UNQUALIFIED_SCALE_CLAIMS = [
  "Every observation is bounded, force-reaps an unresponsive `ps`/`pgrep`, and never scales with group size.",
  "neither phase's cost scales with how many process-group members it observes",
  "so this observer's cost never scales with how many pids are asked about",
] as const;

function assertNoUnqualifiedScaleClaim(text: string, surfaceLabel: string): void {
  for (const forbidden of FORBIDDEN_UNQUALIFIED_SCALE_CLAIMS) {
    assert.ok(
      !text.includes(forbidden),
      `expected ${surfaceLabel} to never contain the retired, unqualified "cost never scales with group size" claim - the real batched read still constructs/emits/parses O(N) data, only its CALL COUNT is size-independent. Found: ${JSON.stringify(forbidden)}`
    );
  }
}

test("no \"provably\"/unqualified proof claim beside the escalation identity matcher, (README.md) - scoped to that mechanism's own paragraph, not the file's unrelated pre-existing use of the word elsewhere", () => {
  const paragraph = extractEscalationGateParagraph(readReadmeText());
  assertNoUnqualifiedProofClaim(paragraph, "README.md");
});

test("no \"provably\"/unqualified proof claim beside the escalation identity matcher, (the kill tool's tools/list description) - scoped to that mechanism's own paragraph", () => {
  const paragraph = extractEscalationGateParagraph(killTool.description as string);
  assertNoUnqualifiedProofClaim(paragraph, "the kill tool's tools/list description");
});

function readChangelogText(): string {
  return fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
}

/**
 * CHANGELOG.md's own escalation-identity-gate bullet - a single
 * one-line-per-bullet entry in this file's established convention, so the
 * slice runs from this bullet's own opening sentence to the end of its
 * own line, never spilling into an adjacent, unrelated bullet.
 */
function extractChangelogEscalationBullet(text: string): string {
  const start = text.indexOf("Before escalating a `kill()`'s grace-period SIGTERM to SIGKILL");
  assert.ok(start >= 0, "expected to find CHANGELOG.md's own escalation-identity-gate bullet");
  const end = text.indexOf("\n", start);
  return end >= 0 ? text.slice(start, end) : text.slice(start);
}

test('no "provably"/unqualified proof claim beside the escalation identity matcher, (CHANGELOG.md) - scoped to that mechanism\'s own bullet', () => {
  const bullet = extractChangelogEscalationBullet(readChangelogText());
  assertNoUnqualifiedProofClaim(bullet, "CHANGELOG.md");
});

test('no unqualified "never scales with group size" cost claim, (CHANGELOG.md) - the real batched read still constructs/emits/parses O(N) data, only its call count is size-independent', () => {
  const bullet = extractChangelogEscalationBullet(readChangelogText());
  assertNoUnqualifiedScaleClaim(bullet, "CHANGELOG.md's escalation-identity-gate bullet");
});

/**
 * this repo's OWN source comments, in both files whose docs
 * describe the escalation identity gate - `src/tools/kill.ts`'s "##
 * Escalation identity gate" module-header section (bounded by the next
 * "##" header, `## Process-group confirmation, honestly disclosed`), and
 * `src/process.ts`'s own escalation-identity-gate region (bounded by that
 * file's own `// ---` divider pair, from the "The escalation identity
 * gate:" banner through to the next divider pair before "Windows kill:
 * honest best-effort, NOT a real Job Object" - the whole contiguous
 * region this file's own dividers already demarcate as belonging to this
 * mechanism, covering `RecordedGroupMember` through `killProcessGroupPosix`
 * itself). Reads SOURCE (`src/`), not `dist/`, matching this test file's
 * own established pattern (see `test/integration.test.ts`'s identical
 * `src/tools/kill.ts`/`src/server.ts` source-text structural checks) -
 * comments survive this project's build (no `removeComments` in
 * `tsconfig.json`), but checking the source directly is the more direct,
 * least-assumption-laden read.
 */
function readKillSourceText(): string {
  return fs.readFileSync(new URL("../src/tools/kill.ts", import.meta.url), "utf8");
}

function readProcessSourceText(): string {
  return fs.readFileSync(new URL("../src/process.ts", import.meta.url), "utf8");
}

function extractKillSourceEscalationSection(text: string): string {
  const start = text.indexOf("## Escalation identity gate");
  assert.ok(
    start >= 0,
    "expected to find src/tools/kill.ts's own '## Escalation identity gate' header section"
  );
  const end = text.indexOf("## Process-group confirmation, honestly disclosed", start);
  assert.ok(end >= 0, "expected to find the section header immediately following it");
  return text.slice(start, end);
}

function extractProcessSourceEscalationSection(text: string): string {
  const start = text.indexOf("The escalation identity gate: before the SIGKILL escalation");
  assert.ok(
    start >= 0,
    "expected to find src/process.ts's own escalation-identity-gate section banner"
  );
  const end = text.indexOf("Windows kill: honest best-effort, NOT a real Job Object", start);
  assert.ok(end >= 0, "expected to find the next major section banner following it");
  return text.slice(start, end);
}

test("no \"provably\"/unqualified proof claim beside the escalation identity matcher, (this repo's own source comments: src/tools/kill.ts + src/process.ts) - scoped to each file's own escalation-identity-gate section, not unrelated pre-existing uses elsewhere (e.g. process.ts's own Windows-kill-coverage \"proves nothing\" disclaimer, or kill.ts's eager-reap continuity argument)", () => {
  const killSection = extractKillSourceEscalationSection(readKillSourceText());
  assertNoUnqualifiedProofClaim(
    killSection,
    "src/tools/kill.ts's own escalation-identity-gate header section"
  );
  const processSection = extractProcessSourceEscalationSection(readProcessSourceText());
  assertNoUnqualifiedProofClaim(
    processSection,
    "src/process.ts's own escalation-identity-gate section"
  );
});

test('no unqualified "never scales with group size" cost claim, (this repo\'s own source comments: src/tools/kill.ts + src/process.ts)', () => {
  const killSection = extractKillSourceEscalationSection(readKillSourceText());
  assertNoUnqualifiedScaleClaim(
    killSection,
    "src/tools/kill.ts's own escalation-identity-gate header section"
  );
  const processSection = extractProcessSourceEscalationSection(readProcessSourceText());
  assertNoUnqualifiedScaleClaim(
    processSection,
    "src/process.ts's own escalation-identity-gate section"
  );
});

/**
 * The base ref this repo's own commit-range convention already uses
 * elsewhere (see `.github/workflows/ci.yml`'s changelog-presence job):
 * `origin/main` when it resolves (the normal case - CI's own checkout
 * fetches it, and a real clone tracking `origin` has it too), falling
 * back to a local `main` branch for a worktree/environment with no
 * `origin` remote configured at all. `undefined` when NEITHER resolves,
 * in which case the commit-history tests below skip with an explicit
 * reason rather than throwing - this guard exists to catch an overclaim,
 * not to assert this checkout's own git plumbing is configured a
 * particular way.
 */
function resolveCommitRangeBase(): string | undefined {
  for (const candidate of ["origin/main", "main"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", candidate], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return candidate;
    } catch {
      // Not resolvable - try the next candidate.
    }
  }
  return undefined;
}

const COMMIT_RANGE_BASE = resolveCommitRangeBase();
const COMMIT_RANGE_SKIP =
  COMMIT_RANGE_BASE === undefined
    ? "neither origin/main nor a local main branch is resolvable in this checkout"
    : false;

/** One commit's own subject + body, from a real `git log` invocation. */
interface RangeCommit {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
}

const COMMIT_RECORD_END = "---GHANTIKA-COMMIT-RANGE-END---";

/**
 * Every commit's subject AND body in `${COMMIT_RANGE_BASE}..HEAD` - the
 * real public surface a violation could otherwise hide on entirely
 * unseen: a claim that only ever shipped inside a commit message, never
 * in README/CHANGELOG/the served description/source comments, previously
 * passed as if this guard covered it, when it never looked at git
 * history at all. Each record is delimited by this file's own private
 * end-of-record marker (real enough not to collide with ordinary commit
 * prose) so a body containing blank lines is never mistaken for a record
 * boundary.
 */
function readCommitRangeCommits(): RangeCommit[] {
  if (COMMIT_RANGE_BASE === undefined) return [];
  const raw = execFileSync(
    "git",
    ["log", `--format=%H%n%s%n%n%b%n${COMMIT_RECORD_END}`, `${COMMIT_RANGE_BASE}..HEAD`],
    { encoding: "utf8" }
  );
  return raw
    .split(`${COMMIT_RECORD_END}\n`)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const lines = record.split("\n");
      const sha = lines[0] ?? "";
      const subject = lines[1] ?? "";
      const body = lines.slice(2).join("\n").trim();
      return { sha, subject, body };
    });
}

/**
 * This project's own established vocabulary for the escalation identity
 * gate specifically - used to scope the proof-claim check below to text
 * that is actually ABOUT that mechanism, exactly like this file's own
 * `extractEscalationGateParagraph` scopes README.md/kill.ts/process.ts to
 * that mechanism's own paragraph rather than banning the word file-wide.
 * A commit message is unstructured prose with no such paragraph to
 * delimit, so this filters to the sentences that mention the mechanism
 * by name instead of scanning the whole commit at once - a regression
 * test description that merely says it "proves" a bug stays fixed is a
 * completely unrelated, legitimate use of the word this guard must never
 * flag.
 */
const ESCALATION_GATE_SENTENCE_KEYWORDS =
  /escalation identity|identity gate|identity matcher|group is still ours|originally-recorded member/i;

/**
 * Commit bodies are hard-wrapped at ~72 characters, so a single sentence
 * routinely spans several source lines joined only by a lone `\n`. Splitting
 * on `\n+` as if it always meant "end of sentence" made the guard's real
 * unit a wrapped LINE rather than a sentence: a claim could straddle a wrap
 * point and escape entirely, silently, whenever the proof-word landed on a
 * different line than the keyword that scopes the check to it. A blank line
 * (two or more consecutive newlines) is a real paragraph break and stays
 * one; a single newline inside a paragraph is folded to a space first, so
 * sentence-ending punctuation - not line position - is what actually
 * delimits a sentence.
 */
function joinWrappedLines(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.split("\n").join(" "))
    .join("\n\n");
}

/**
 * Filtering to only the sentences that themselves mention the mechanism
 * is blind to a claim carried by a pronoun in the very next sentence: a
 * mechanism-naming sentence followed by an anaphoric one - "It proves
 * ownership before SIGKILL." - never mentions the mechanism by name
 * itself, so a filter that requires each sentence to pass the keyword
 * test on its own drops the claim before the proof-word check ever runs
 * on it. A sentence is in scope here if it mentions the mechanism
 * directly, OR the sentence immediately before it does: a one-sentence
 * forward window opened by a mechanism mention, not a per-sentence
 * filter. This is a bounded window, not general pronoun resolution: a
 * proof claim separated from the last mechanism mention by an
 * intervening, unrelated sentence falls outside it and is not caught,
 * and no fixed window size would make a genuine completeness claim here
 * either - resolving what a pronoun refers to across arbitrary prose is
 * an open problem this file does not attempt to close. A test below
 * names that boundary explicitly rather than leaving it undisclosed.
 */
function extractEscalationGateSentences(text: string): string[] {
  const sentences = joinWrappedLines(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  const inScope: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i]!;
    const mentionsMechanism = ESCALATION_GATE_SENTENCE_KEYWORDS.test(sentence);
    const followsAMechanismSentence =
      i > 0 && ESCALATION_GATE_SENTENCE_KEYWORDS.test(sentences[i - 1]!);
    if (mentionsMechanism || followsAMechanismSentence) {
      inScope.push(sentence);
    }
  }
  return inScope;
}

/**
 * Once quoted spans and parenthetical asides were blanket-stripped before
 * this check ran, a sentence's proof-claim words could sit ENTIRELY inside
 * one of those stripped regions and still describe a real, direct,
 * currently-true claim about the matcher - stripping erased the words
 * before the check ever saw them, regardless of whether the region was
 * historical narration or a live assertion wearing quotes or parentheses.
 * Two sentences that read the same either way expose this: `The escalation
 * identity gate (proves the group is still ours) permits SIGKILL.` and the
 * same claim in double quotes instead of parentheses. Neither is historical
 * narration - both assert, in the present tense, exactly the capability
 * the code disclaims - and both passed cleanly under stripping. A syntax
 * region (quoted or parenthesized) is not a semantic signal for "this is
 * reported speech about the past," so no regex over that shape can
 * distinguish the two cases; this project's own actionlint-recipe checks
 * apply the identical principle to an unrelated surface (an unbounded
 * behavioral property can't be proven by pattern-matching shell text, only
 * by execution). There is no execution equivalent for prose, so the fix
 * is the same one this file's own commit-history check below is built to
 * apply: check the full, unstripped sentence, and handle the rare, real
 * case of legitimate historical quotation through an enumerated, exact-
 * match allowlist instead of a content-shape guess - the allowlist can't
 * be fooled by rephrasing a live claim into looking like a retraction,
 * because it does not look at shape at all. The allowlist below is
 * currently empty, but the mechanism exists to hold future entries of
 * exactly this kind.
 */

/**
 * Exact (sha, sentence) pairs pre-dating this guard, exempted individually
 * rather than by a blanket skip of the whole check - the same pattern
 * test/skip-baseline.json already uses elsewhere in this file for a named
 * skip. This repository's PRs squash-merge, so an individual commit's own
 * message never becomes part of `main`'s history; only the squash commit's
 * subject and body do, and those are checked without any exemption. A
 * DIFFERENT violation in the same commit still reds (only this exact
 * sentence is exempted, not the commit or the check), and this same
 * sentence surviving under a DIFFERENT sha still reds too (the match is on
 * the pair, not either half alone). An entry whose sha no longer appears in
 * the range is dead weight to remove with it, never a standing exemption
 * that outlives the commit it was written for.
 *
 * An entry keyed to a pre-squash branch commit sha cannot survive this
 * repository's squash strategy: the merge strategy replaces every one of a
 * PR's internal commits with a single new commit on `main`, so an
 * exception pinned to one of those internal shas is guaranteed dead the
 * moment that PR lands, not merely at risk of going dead.
 */
const LEGACY_PROOF_CLAIM_EXCEPTIONS: readonly { sha: string; sentence: string }[] = [];

function isLegacyProofClaimException(sha: string, sentence: string): boolean {
  return LEGACY_PROOF_CLAIM_EXCEPTIONS.some(
    (entry) => entry.sha === sha && entry.sentence === sentence.trim()
  );
}

/**
 * The exact (sha, sentence) pair once held in LEGACY_PROOF_CLAIM_EXCEPTIONS,
 * now removed. The empty-list tests below use it as their negative control:
 * an empty allowlist must refuse this pair. The sha names a real, reachable
 * commit; it is simply outside `main`'s live `${COMMIT_RANGE_BASE}..HEAD`
 * guard range.
 */
const REMOVED_LEGACY_EXCEPTION_EXAMPLE = {
  sha: "583c9b695cc8e991c86eb149485524974f27c440",
  sentence:
    "A single surviving, exactly-matching member is enough to prove the group is still ours, since POSIX forbids reusing a live group's numeric id; if none match, escalation is refused and no SIGKILL is sent.",
} as const;

test(
  'no "provably"/unqualified proof claim beside the escalation identity matcher, (every commit subject+body in the range) - scoped to sentences that actually mention the escalation identity gate by name, checked as full, unstripped text so a claim cannot hide inside a quote or a parenthetical, except any enumerated, legacy exceptions',
  { skip: COMMIT_RANGE_SKIP },
  () => {
    for (const commit of readCommitRangeCommits()) {
      const text = `${commit.subject}\n\n${commit.body}`;
      for (const sentence of extractEscalationGateSentences(text)) {
        if (isLegacyProofClaimException(commit.sha, sentence)) continue;
        assertNoUnqualifiedProofClaim(
          sentence,
          `commit ${commit.sha.slice(0, 12)} ("${commit.subject}")`
        );
      }
    }
  }
);

test(
  LEGACY_PROOF_CLAIM_EXCEPTIONS.length === 0
    ? "the legacy proof-claim exception list is empty: the lookup still refuses its own historical (sha, sentence) pair"
    : "the legacy proof-claim exception is live: its sha is actually present in the real commit range, and its sentence is actually produced by the real extraction",
  LEGACY_PROOF_CLAIM_EXCEPTIONS.length === 0
    ? () => {
        assert.equal(
          isLegacyProofClaimException(
            REMOVED_LEGACY_EXCEPTION_EXAMPLE.sha,
            REMOVED_LEGACY_EXCEPTION_EXAMPLE.sentence
          ),
          false,
          "the allowlist is empty, so it must refuse even the exact (sha, sentence) pair that used to be exempted here"
        );
      }
    : () => {
        const shasInRange = new Set(readCommitRangeCommits().map((commit) => commit.sha));
        for (const entry of LEGACY_PROOF_CLAIM_EXCEPTIONS) {
          assert.ok(
            shasInRange.has(entry.sha),
            `legacy exception for ${entry.sha} names a sha that is not in the real commit range - remove the dead entry`
          );
          const commit = readCommitRangeCommits().find((c) => c.sha === entry.sha);
          assert.ok(commit, `test setup: could not re-find commit ${entry.sha}`);
          const text = `${commit!.subject}\n\n${commit!.body}`;
          const sentences = extractEscalationGateSentences(text);
          assert.ok(
            sentences.some((sentence) => sentence.trim() === entry.sentence),
            `legacy exception's sentence was not found among ${commit!.sha.slice(0, 12)}'s own extracted sentences - the exception is stale (the commit's text changed, or the extraction logic changed) and must be re-derived, not assumed`
          );
        }
      }
);

test(
  LEGACY_PROOF_CLAIM_EXCEPTIONS.length === 0
    ? "the legacy proof-claim exception list is empty: no exact, paraphrased, or mismatched-sha variant of its historical pair is wrongly accepted"
    : "the legacy exception is an exact-pair match, not a fuzzy one: a near-identical sentence under the real sha, and the real sentence under a fake sha, are both refused",
  LEGACY_PROOF_CLAIM_EXCEPTIONS.length === 0
    ? () => {
        assert.equal(
          isLegacyProofClaimException(
            REMOVED_LEGACY_EXCEPTION_EXAMPLE.sha,
            REMOVED_LEGACY_EXCEPTION_EXAMPLE.sentence
          ),
          false,
          "the exact historical pair must be refused against an empty list"
        );
        assert.equal(
          isLegacyProofClaimException(
            REMOVED_LEGACY_EXCEPTION_EXAMPLE.sha,
            REMOVED_LEGACY_EXCEPTION_EXAMPLE.sentence.replace("A single surviving", "One surviving")
          ),
          false,
          "a paraphrase of the historical sentence under its historical sha must also be refused against an empty list"
        );
        assert.equal(
          isLegacyProofClaimException("0".repeat(40), REMOVED_LEGACY_EXCEPTION_EXAMPLE.sentence),
          false,
          "the historical sentence under an unrelated sha must also be refused against an empty list"
        );
      }
    : () => {
        const realEntry = LEGACY_PROOF_CLAIM_EXCEPTIONS[0]!;
        assert.equal(
          isLegacyProofClaimException(realEntry.sha, realEntry.sentence),
          true,
          "test setup: the real (sha, sentence) pair must match"
        );
        assert.equal(
          isLegacyProofClaimException(
            realEntry.sha,
            realEntry.sentence.replace("A single surviving", "One surviving")
          ),
          false,
          "a paraphrase of the legacy-exception sentence under its own real sha must NOT match - the allowlist is exact text, not a rewritten claim carrying the same meaning"
        );
        assert.equal(
          isLegacyProofClaimException("0".repeat(40), realEntry.sentence),
          false,
          "the real legacy-exception sentence under an unrelated sha must NOT match - the pair is what's exempted, never the sentence alone"
        );
      }
);

test("negative control: a live proof claim hidden inside a parenthetical aside is still caught now that stripping is gone (the exact evasion this guard used to miss)", () => {
  const text = "The escalation identity gate (proves the group is still ours) permits SIGKILL.";
  const sentences = extractEscalationGateSentences(text);
  assert.equal(sentences.length, 1, "test setup: expected exactly one in-scope sentence");
  assert.equal(
    isLegacyProofClaimException("0".repeat(40), sentences[0]!),
    false,
    "test setup: this sentence must not be the legacy exception"
  );
  assert.throws(
    () => assertNoUnqualifiedProofClaim(sentences[0]!, "negative-control text"),
    /never claim/,
    "a direct proof claim sitting inside a parenthetical must still be caught, not hidden by the parens around it"
  );
});

test("negative control: a live proof claim hidden inside a double-quoted span is still caught now that stripping is gone (the exact evasion this guard used to miss)", () => {
  const text = 'The escalation identity gate "proves the group is still ours" and permits SIGKILL.';
  const sentences = extractEscalationGateSentences(text);
  assert.equal(sentences.length, 1, "test setup: expected exactly one in-scope sentence");
  assert.equal(
    isLegacyProofClaimException("0".repeat(40), sentences[0]!),
    false,
    "test setup: this sentence must not be the legacy exception"
  );
  assert.throws(
    () => assertNoUnqualifiedProofClaim(sentences[0]!, "negative-control text"),
    /never claim/,
    "a direct proof claim sitting inside a quoted span must still be caught, not hidden by the quotes around it"
  );
});

test("green control: an in-scope sentence that narrates an already-fixed overclaim without repeating the banned word verbatim passes cleanly - legitimate historical narration needs no exemption because it never has to use the literal word", () => {
  const text =
    "Narrowed an overclaim: the escalation identity gate was described as an unqualified guarantee that the process group is still the one this server spawned.";
  const sentences = extractEscalationGateSentences(text);
  assert.equal(sentences.length, 1, "test setup: expected exactly one in-scope sentence");
  assert.doesNotThrow(
    () => assertNoUnqualifiedProofClaim(sentences[0]!, "green-control text"),
    "a retraction that paraphrases the retired claim instead of quoting the banned word verbatim must pass without any stripping or exemption"
  );
});

test("the adversarial specimen is caught: a mechanism-naming sentence followed immediately by a bare anaphoric proof sentence is in scope and throws", () => {
  const text =
    "The escalation identity gate records the original member set. It proves ownership before SIGKILL.";
  const sentences = extractEscalationGateSentences(text);
  assert.equal(
    sentences.length,
    2,
    "test setup: both the mechanism-naming sentence and the immediately-following anaphoric sentence must be in scope"
  );
  assert.throws(
    () =>
      sentences.forEach((sentence) =>
        assertNoUnqualifiedProofClaim(sentence, "adversarial-specimen text")
      ),
    /never claim/,
    "the anaphoric second sentence must be caught even though it never mentions the mechanism by name itself - a per-sentence filter drops this exact sentence before the proof-word check ever runs on it, and this test reds against that filter"
  );
});

test("alternate pronoun/subject rows immediately following a mechanism sentence are also caught by the one-sentence window, not only the exact specimen's wording", () => {
  const rows = [
    "The escalation identity gate records the original member set. It proves ownership before SIGKILL.",
    "The escalation identity gate stores the original members. This proves the group hasn't been reused.",
    "The escalation identity gate captured members at a point in time. The check proves this is the same set that started.",
  ];
  for (const text of rows) {
    const sentences = extractEscalationGateSentences(text);
    assert.equal(
      sentences.length,
      2,
      `test setup: expected both sentences in scope for: ${JSON.stringify(text)}`
    );
    assert.throws(
      () =>
        sentences.forEach((sentence) =>
          assertNoUnqualifiedProofClaim(sentence, "mutation-row text")
        ),
      /never claim/,
      `expected the proof claim to be caught regardless of the pronoun or subject introducing it, for: ${JSON.stringify(text)}`
    );
  }
});

test("disclosed residual, NOT closed: a proof claim separated from the last mechanism mention by one intervening, unrelated sentence falls outside the one-sentence window and is not caught - general pronoun resolution across arbitrary distance is out of scope for this guard", () => {
  const text =
    "The escalation identity gate records the original member set. Nothing else happens here. It proves ownership before SIGKILL.";
  const sentences = extractEscalationGateSentences(text);
  assert.equal(
    sentences.length,
    2,
    "test setup: the mechanism-naming sentence and the intervening sentence right after it are in scope (the window opens once, immediately after the mechanism mention) - the proof claim a second sentence later falls entirely outside it and is never even extracted"
  );
  assert.ok(
    !sentences.some((sentence) => /\bproves\b/i.test(sentence)),
    "test setup: the actual proof-claim sentence must not be among the extracted, in-scope sentences at all"
  );
  assert.doesNotThrow(
    () =>
      sentences.forEach((sentence) =>
        assertNoUnqualifiedProofClaim(sentence, "residual-boundary text")
      ),
    "known, disclosed gap: a proof claim separated from the last mechanism mention by an intervening sentence is not caught here - widening the window by a fixed amount would not make this a general anaphora resolver either, so the boundary is named by this test rather than pretended closed"
  );
});

test(
  'no unqualified "never scales with group size" cost claim, (every commit subject+body in the range)',
  { skip: COMMIT_RANGE_SKIP },
  () => {
    for (const commit of readCommitRangeCommits()) {
      const text = `${commit.subject}\n\n${commit.body}`;
      assertNoUnqualifiedScaleClaim(
        text,
        `commit ${commit.sha.slice(0, 12)} ("${commit.subject}")'s own message`
      );
    }
  }
);

// --- the combined-degraded cell's retry-safety contract, at the real handler/wire level: never re-signals, but can still recover via existence-only confirmation ---

describe("kill: the combined-degraded cell's retry-safety contract (against a real spawned job)", () => {
  // Both tests below spawn a real job via spawnManaged - the CONTROL
  // through the shared runStrandedRetryScenario helper, the
  // concurrent-kill test directly - never through the real `run` tool,
  // so this block carries no before(requireSpawnPolicy) - see this
  // file's own top-of-file comment.

  test(
    "kill: CONTROL - a forced mid-scenario failure still leaves no survivor leader or process group behind, verified via a real process-table lookup, never merely assumed",
    {
      skip:
        process.platform === "win32"
          ? "manipulates the server process's own PATH to make ps/pgrep unavailable, POSIX-only"
          : false,
    },
    async () => {
      const pidOut: { pid?: number } = {};
      await assert.rejects(
        () => runStrandedRetryScenario(pidOut, { forceFailureAfterSpawn: true }),
        /STRANDED-RETRY CONTROL - deliberate mid-scenario failure/
      );
      assert.notEqual(
        pidOut.pid,
        undefined,
        "expected the scenario to have recorded the real resistant process's pid before the forced failure - the whole point of this control is checking that PID"
      );
      const pid = pidOut.pid!;
      // The scenario's own `finally` block already tore this down and
      // asserted it internally - this is an INDEPENDENT re-check from
      // outside that function, against the real process table, so this
      // control does not merely trust the function's own internal
      // assertion.
      assert.equal(
        isProcessAlive(pid),
        false,
        "expected the real resistant leader to be genuinely gone after the forced-failure path's own finally-block cleanup"
      );
      assert.equal(
        isProcessGroupAlive(pid),
        false,
        "expected the whole real process GROUP to be genuinely gone after the forced-failure path's own finally-block cleanup - not just the leader pid"
      );
    }
  );

  test(
    "two CONCURRENT public kill() calls against the same already-terminal job produce exactly ONE real signal-capable reap entry, guarding against the race where two independently-dispatched tools/call requests could both observe jobStore's own pre-await guard as not-yet-set and both take the signal-capable branch, each sending a real signal",
    {
      skip:
        process.platform === "win32"
          ? "process-group reap-once tracking is POSIX-only - no pgid concept to double-signal on Windows"
          : false,
    },
    async () => {
      // The record is made terminal WITHOUT ever routing through run()'s own
      // eager-reap-at-exit wiring (createJob/attachChild/markExited called
      // directly against the SAME singleton `jobStore` kill.ts itself
      // imports - exactly like the sibling "genuinely re-consults" test in
      // test/jobStore.test.ts) so hasReapBeenAttempted stays false and BOTH
      // calls below reach reapProcessGroupOnce itself, rather than one being
      // short-circuited by an eager reap that already ran. Which ONE of the
      // two actually takes the signal-capable branch is exactly what this
      // test proves is bounded: the synchronous reapEntered marker this
      // guards against being written twice determines it, so the other call
      // correctly falls back to the existence-only retry path instead.
      const dir = makeTempDir();
      const sigtermLog = path.join(dir, "sigterm-log.txt");
      // GENUINELY SIGTERM-RESISTANT, not merely trapping-and-continuing: an
      // earlier draft of this fixture (`trap ...; sleep 60`) let the
      // group's own `sleep` child die from its own copy of the broadcast
      // SIGTERM, which unblocked the shell's `wait` and let it fall off the
      // end of its script and exit within milliseconds - so by the time a
      // second concurrent call's own reaper ever checked liveness, the
      // group was ALREADY gone, and the test passed for the wrong reason
      // (nothing left to signal) even against the unfixed jobStore.ts,
      // proving nothing about the actual race. This loop re-spawns `sleep 1`
      // forever, so the LEADER survives indefinitely regardless of how many
      // SIGTERMs land - long enough for two concurrent calls to both
      // genuinely reach their own real signal-send point while the group is
      // still alive, which is the only way a duplicate delivery becomes
      // observable at all.
      const child = spawnManaged(
        {
          argv: ["sh", "-c", `trap "echo x >> ${sigtermLog}" TERM; while true; do sleep 1; done`],
          cwd: process.cwd(),
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        },
        {
          onSpawn: () => {},
          onError: () => {},
          onExit: () => {},
          onStdoutChunk: () => {},
          onStderrChunk: () => {},
          onStdoutEnd: () => {},
          onStderrEnd: () => {},
        }
      );
      const record = jobStore.createJob({ argv: ["sh"], cwd: "/tmp", env: {}, isShell: false });
      jobStore.attachChild(record.job_id, child!);
      jobStore.markExited(record.job_id, 0, null);

      const realPid: number | undefined = child!.pid;
      try {
        // Give the shell a moment to actually install its trap before
        // either kill() call fires - a false pass here (the shell dying, or
        // its trap not yet installed) would make a below-one sigterm-log
        // count meaningless. Real elapsed time, not a file-arrival wait:
        // nothing this fixture writes proves "trap installed" any more
        // cheaply than just giving the shell a moment to start.
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(
          isProcessAlive(realPid),
          true,
          "expected the real trapping leader to be alive before either kill() call"
        );

        // Fired back-to-back, NEITHER awaited before the other starts - this
        // is what reproduces the race: both handler() calls run their
        // synchronous prologue (validate -> look up -> confirm terminal ->
        // begin reapProcessGroupOnce) before either yields at its first real
        // await, exactly matching the installed MCP SDK's own independent-
        // dispatch behavior (Promise.resolve().then(handler), no awaiting
        // the previous tools/call).
        const call1 = killTool.handler({ job_id: record.job_id });
        const call2 = killTool.handler({ job_id: record.job_id });
        const [result1, result2] = await Promise.all([call1, call2]);

        assert.notEqual(
          (result1 as CallToolResult).isError,
          true,
          `first concurrent kill() must succeed: ${JSON.stringify(result1)}`
        );
        assert.notEqual(
          (result2 as CallToolResult).isError,
          true,
          `second concurrent kill() must succeed: ${JSON.stringify(result2)}`
        );

        // THE ASSERTION: a real, external log of SIGTERM deliveries - not
        // this codebase's own kill_confirmed/reapAttempted bookkeeping,
        // which the prior design could not be trusted to report honestly
        // (the race this test guards against ran through exactly that
        // bookkeeping). Exactly one line means exactly one real
        // signal-capable reap entry occurred; more than one means the
        // concurrency window this test guards against is still open.
        await new Promise((r) => setTimeout(r, 200)); // let a would-be second signal's log write land
        const deliveries = fs.existsSync(sigtermLog)
          ? fs
              .readFileSync(sigtermLog, "utf8")
              .split("\n")
              .filter((line) => line.trim().length > 0).length
          : 0;
        assert.equal(
          deliveries,
          1,
          `expected exactly one real SIGTERM delivered across both concurrent kill() calls, saw ${deliveries} - a second delivery means the pre-await entry guard did not close the concurrent-double-signal window`
        );
      } finally {
        if (realPid !== undefined && isProcessAlive(realPid)) {
          try {
            process.kill(-realPid, "SIGKILL");
          } catch {
            // already gone - fine
          }
        }
      }
    }
  );
});
