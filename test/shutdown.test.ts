import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// See test/e2e-server.test.ts's import comment for why this is ".ts", not ".js".
import { type SpawnedServer, completeHandshake, spawnServer } from "./helpers/spawnServer.ts";
// The shared marker-file poll and its pgid predicate - one implementation
// for every suite that observes a job's real filesystem side effects.
import { parsesAsPgid, waitForFile } from "./harness.ts";

// Real client, real IN-PROCESS transport, real server - only the one test
// below (the identity-mismatch fail-closed proof) needs this, rather than a
// genuinely spawned child process: it has to reach into the shared
// `jobStore` singleton's own bookkeeping directly to simulate a stale
// identity record (see that test's own docs), which is only possible when
// the server and the test share the same Node module registry - exactly the
// pattern test/jobStore.test.ts's own EPERM-race regression test already
// establishes for the identical reason.
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { isProcessAlive } from "../dist/process.js";
import { createServer } from "../dist/server.js";
import { jobStore } from "../dist/jobStore.js";

/**
 * A catchable shutdown signal (SIGTERM, SIGINT) or stdin EOF must reach a
 * real cleanup path - proven here against the REAL spawned process, not a
 * mocked signal handler. "Cleanup ran" is observed two ways: the
 * `[ghantika] shutting down (...)` diagnostic line on stderr (proof the
 * handler function itself executed), and the process exiting with code 0
 * and no signal (proof OUR handler intercepted the signal and called
 * `process.exit(0)` itself, rather than the process being torn down by
 * Node's own default signal behavior, which reports a `signal` on the exit
 * event instead of a clean `code`).
 *
 * Further down this file: cleanup REAPS every live job's own process
 * group before the process exits, proven with a real external `pgrep`
 * oracle across all three triggers independently.
 */

// The three process-group-reap tests below confirm their result via a real
// external `pgrep -g <pgid>` call, which has no Windows equivalent path -
// a test-harness gap, not a product scope decision. Windows is a
// supported platform; whether cleanup actually reaps a live job's
// process group there is a separate question this test doesn't answer by
// skipping.
const PGREP_ORACLE_SKIP =
  process.platform === "win32"
    ? "confirms the result via a real external `pgrep -g`, POSIX-only"
    : false;

// Each test waits for a REAL completed initialize handshake (not a fixed
// sleep) before sending its signal/EOF - a blind `setTimeout` was flaky
// under full-suite load (many test files spawn real child processes
// concurrently, and a fixed wait is not always long enough for THIS
// child's transport to finish connecting before the signal arrives).
// Waiting on the actual initialize RESPONSE is a real readiness signal
// regardless of system load, and is also more representative of a real
// client's lifecycle (connect, then eventually disconnect).

test("SIGTERM reaches the real cleanup path: stderr shows the shutdown diagnostic, process exits 0", async () => {
  const server = spawnServer();
  await completeHandshake(server);
  server.child.kill("SIGTERM");
  const { code, signal } = await server.waitForExit();
  assert.equal(
    code,
    0,
    "the server's own SIGTERM handler must call process.exit(0), not be torn down by the default signal behavior"
  );
  assert.equal(signal, null);
  assert.match(server.stderrText(), /\[ghantika\] shutting down \(SIGTERM\)/);
});

test("SIGINT reaches the real cleanup path too", async () => {
  const server = spawnServer();
  await completeHandshake(server);
  server.child.kill("SIGINT");
  const { code, signal } = await server.waitForExit();
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.match(server.stderrText(), /\[ghantika\] shutting down \(SIGINT\)/);
});

test("stdin EOF (the client closing its side of the pipe) reaches the real cleanup path", async () => {
  const server = spawnServer();
  await completeHandshake(server);
  server.child.stdin.end(); // closes stdin -> the child process observes EOF
  const { code, signal } = await server.waitForExit();
  assert.equal(code, 0, "stdin EOF must reach the same real cleanup path and exit cleanly");
  assert.equal(signal, null);
  assert.match(server.stderrText(), /\[ghantika\] shutting down \(stdin EOF\)/);
});

// --- mutation control: prove a process with NO handler installed behaves
// differently (reported via a signal, not a clean exit code) - this is
// what a regression that removed the SIGTERM handler would look like,
// making the assertions above non-vacuous. ---

test("mutation control: without any handler, SIGTERM tears a process down via the signal, not a clean exit code (proves the assertion above is discriminating)", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.kill("SIGTERM");
  const { code, signal } = await exitPromise;
  assert.equal(
    signal,
    "SIGTERM",
    "a process with no SIGTERM handler is torn down BY the signal, not exited with a code"
  );
  assert.notEqual(code, 0);
});

// =============================================================================
// Orphan-proof teardown: `performShutdown` closes the transport AND reaps
// every live job's own process group. Without the reap, a real spawned
// server, a real MCP handshake, a real `run` call starting a long-lived
// child, then closing the server's stdin (EOF) would exit the server itself
// cleanly (`{code:0, signal:null}`) while the child it spawned stayed alive
// and orphaned.
//
// Implemented in src/server.ts's `reapLiveJobsOnShutdown` (reuses the same
// real kill machinery `kill` itself uses - see that function's own docs).
// This section proves "zero surviving children" with a REAL external `pgrep`
// oracle (the SAME pattern test/kill.test.ts's own real-wire tests
// established), across each of the THREE shutdown triggers INDEPENDENTLY
// (stdin EOF, SIGTERM, SIGINT - three separate test cases, not one
// combined) - and, matching the same process-group-reap standard `kill`
// itself holds to, against a job that itself forks real DESCENDANT
// processes, so this proves every member of the job's process group is
// reaped, not merely the one direct tracked child.
// =============================================================================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-shutdown-reap-"));
}

/** A real `pgrep -g <pgid>` call - see test/kill.test.ts's identical helper for the full rationale. Returns the real pids found, `[]` when pgrep finds none. */
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
  readonly result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
}

/**
 * Spawns a real server, hands it a real `run` job whose shell child itself
 * forks two real `sleep` descendants (so every member of the process
 * group, not just the one direct child, must be reaped), confirms the
 * group is genuinely alive via a real external `pgrep` BEFORE ever
 * triggering shutdown, then hands back the server and the group's pgid
 * for the caller to trigger its own shutdown path against and verify.
 */
async function spawnServerWithLiveTree(): Promise<{ server: SpawnedServer; pgid: number }> {
  const server = spawnServer();
  await completeHandshake(server);

  const dir = makeTempDir();
  const marker = path.join(dir, "pgid.txt");
  // Mirrors test/kill.test.ts's own real-wire fixture exactly: a real
  // shell child (the job's own tracked process, and the process-group
  // LEADER, since spawnManaged spawns it detached) that forks two real
  // `sleep` descendants, writes its own pid (== the group's pgid) to a
  // marker file, then blocks on `wait` so the whole process group stays
  // genuinely alive until shutdown reaps it.
  const shellCommand = `echo $$ > '${marker}'; sleep 60 & sleep 60 & wait`;

  server.send({
    jsonrpc: "2.0",
    id: 700,
    method: "tools/call",
    params: { name: "run", arguments: { command: shellCommand, shell: true } },
  });
  const runLine = await server.nextLine();
  const runBody = runLine.parsed as RunResponseBody;
  assert.equal(runBody.error, undefined);
  assert.notEqual(runBody.result?.isError, true, `run() must succeed: ${JSON.stringify(runBody)}`);

  // Wait for a COMPLETE pgid, not merely for the marker to exist: the
  // shell creates it on redirect, and a truncated read parses as a valid
  // integer naming some other process, which would send this test's whole
  // reap oracle after the wrong process group.
  const pgidText = await waitForFile(marker, { until: parsesAsPgid });
  const pgid = Number(pgidText.trim());
  assert.ok(
    Number.isInteger(pgid) && pgid > 0,
    `expected a real numeric pgid from the marker file, got: ${JSON.stringify(pgidText)}`
  );

  const beforeMembers = await waitForPgrepGroupMembers(
    pgid,
    (members) => members.length >= 3,
    3000
  );
  assert.ok(
    beforeMembers.length >= 3,
    `expected >= 3 real process-group members (the shell + 2 sleeps) alive BEFORE shutdown, pgrep saw: ${JSON.stringify(beforeMembers)}`
  );

  return { server, pgid };
}

test(
  "stdin EOF reaps a REAL live job's WHOLE process group - zero survivors confirmed by a real external pgrep",
  { skip: PGREP_ORACLE_SKIP },
  async () => {
    const { server, pgid } = await spawnServerWithLiveTree();

    server.child.stdin.end(); // closes stdin -> the server observes EOF and runs its real shutdown path
    const { code, signal } = await server.waitForExit();
    assert.equal(code, 0, "the server's own shutdown handler must exit cleanly");
    assert.equal(signal, null);

    // THE proof: a REAL, independent `pgrep -g <pgid>` call AFTER shutdown -
    // never trusting this codebase's own bookkeeping - must show ZERO
    // survivors across the WHOLE process group (the shell AND both sleep
    // descendants), not merely the one direct tracked child.
    const afterMembers = await waitForPgrepGroupMembers(
      pgid,
      (members) => members.length === 0,
      3000
    );
    assert.deepEqual(
      afterMembers,
      [],
      `expected zero surviving process-group members after stdin-EOF shutdown, pgrep still saw: ${JSON.stringify(afterMembers)} (server stderr: ${server.stderrText()})`
    );
  }
);

test(
  "SIGTERM reaps a REAL live job's WHOLE process group - zero survivors confirmed by a real external pgrep",
  { skip: PGREP_ORACLE_SKIP },
  async () => {
    const { server, pgid } = await spawnServerWithLiveTree();

    server.child.kill("SIGTERM");
    const { code, signal } = await server.waitForExit();
    assert.equal(code, 0, "the server's own SIGTERM shutdown handler must exit cleanly");
    assert.equal(signal, null);

    const afterMembers = await waitForPgrepGroupMembers(
      pgid,
      (members) => members.length === 0,
      3000
    );
    assert.deepEqual(
      afterMembers,
      [],
      `expected zero surviving process-group members after SIGTERM shutdown, pgrep still saw: ${JSON.stringify(afterMembers)} (server stderr: ${server.stderrText()})`
    );
  }
);

test(
  "SIGINT reaps a REAL live job's WHOLE process group - zero survivors confirmed by a real external pgrep",
  { skip: PGREP_ORACLE_SKIP },
  async () => {
    const { server, pgid } = await spawnServerWithLiveTree();

    server.child.kill("SIGINT");
    const { code, signal } = await server.waitForExit();
    assert.equal(code, 0, "the server's own SIGINT shutdown handler must exit cleanly");
    assert.equal(signal, null);

    const afterMembers = await waitForPgrepGroupMembers(
      pgid,
      (members) => members.length === 0,
      3000
    );
    assert.deepEqual(
      afterMembers,
      [],
      `expected zero surviving process-group members after SIGINT shutdown, pgrep still saw: ${JSON.stringify(afterMembers)} (server stderr: ${server.stderrText()})`
    );
  }
);

test("green control: a job that has already exited BEFORE shutdown is simply left alone - shutdown never errors or hangs on an already-terminal job", async () => {
  const server = spawnServer();
  await completeHandshake(server);
  server.send({
    jsonrpc: "2.0",
    id: 701,
    method: "tools/call",
    params: { name: "run", arguments: { command: ["true"] } },
  });
  const runLine = await server.nextLine();
  const runBody = runLine.parsed as RunResponseBody;
  assert.notEqual(runBody.result?.isError, true);

  // Give the (near-instant) `true` child a real moment to actually exit
  // before shutdown ever runs, so this exercises the "nothing left to
  // reap" path, not a race against a still-live job.
  await new Promise((resolve) => setTimeout(resolve, 200));

  server.child.kill("SIGTERM");
  const { code, signal } = await server.waitForExit();
  assert.equal(code, 0, "shutdown must still exit cleanly when there is nothing live left to reap");
  assert.equal(signal, null);
});

test(
  "root-exits-first, shutdown side: the eager reap already collects a job's real, live descendants automatically at leader-exit - well before shutdown ever runs - and shutdown still exits cleanly against that already-reaped, terminal record",
  { skip: PGREP_ORACLE_SKIP },
  async () => {
    const server = spawnServer();
    await completeHandshake(server);

    const dir = makeTempDir();
    const marker = path.join(dir, "pgid.txt");
    const child1Marker = path.join(dir, "child1-pid.txt");
    const child2Marker = path.join(dir, "child2-pid.txt");
    const releaseMarker = path.join(dir, "release.txt");
    // The leader writes its own pid (== pgid), forks two real `sleep`
    // descendants, busy-waits on a release marker the test controls, then
    // reaches the end of its own script WITHOUT ever `wait`-ing on them -
    // it exits naturally while the descendants stay alive, orphaned, in
    // the SAME pgid (the opposite of `spawnServerWithLiveTree`'s own
    // fixture above, which trails a `wait` to keep the leader alive). The
    // leader captures each descendant's own real pid via `$!` itself, the
    // instant it backgrounds it - still useful for knowing which pids to
    // look for, but the liveness proof itself is witnessed by the TEST via
    // a real external pgrep call while the leader is held, not trusted
    // from the fixture (see test/kill.test.ts's own matching fixture docs
    // for why a marker the fixture writes about itself cannot survive a
    // mutation that fakes it, and why a bare pgrep count is not enough
    // either - the busy-wait loop's own polling spawns a real, transient
    // process of its own).
    const shellCommand = `echo $$ > '${marker}'; sleep 60 & echo $! > '${child1Marker}'; sleep 60 & echo $! > '${child2Marker}'; while [ ! -f '${releaseMarker}' ]; do sleep 0.05; done`;

    server.send({
      jsonrpc: "2.0",
      id: 720,
      method: "tools/call",
      params: { name: "run", arguments: { command: shellCommand, shell: true } },
    });
    const runLine = await server.nextLine();
    const runBody = runLine.parsed as RunResponseBody;
    assert.notEqual(
      runBody.result?.isError,
      true,
      `run() must succeed: ${JSON.stringify(runBody)}`
    );

    const pgidText = await waitForFile(marker, { until: parsesAsPgid });
    const pgid = Number(pgidText.trim());
    assert.ok(Number.isInteger(pgid) && pgid > 0);

    const child1PidText = await waitForFile(child1Marker, { until: parsesAsPgid });
    const child1Pid = Number(child1PidText.trim());
    const child2PidText = await waitForFile(child2Marker, { until: parsesAsPgid });
    const child2Pid = Number(child2PidText.trim());
    assert.notEqual(
      child1Pid,
      child2Pid,
      "expected the two descendants to be genuinely distinct real processes"
    );

    // THE FIXTURE-VALIDITY PROOF, witnessed by the TEST: a real, external
    // pgrep call while the leader is still held confirms BOTH specific
    // witnessed pids are alive.
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

    // THE proof that actually changed: the eager reap already collects
    // the just-witnessed descendants automatically at leader-exit - well
    // BEFORE shutdown is ever triggered below, with no kill() call and no
    // shutdown reap having run yet.
    const beforeShutdown = await waitForPgrepGroupMembers(
      pgid,
      (members) => members.length === 0,
      3000
    );
    assert.deepEqual(
      beforeShutdown,
      [],
      `expected the eager reap to have already collected both descendants before shutdown ever ran, pgrep still saw: ${JSON.stringify(beforeShutdown)}`
    );

    server.child.stdin.end(); // trigger the real shutdown path
    const { code, signal } = await server.waitForExit();
    assert.equal(code, 0, "shutdown must exit cleanly against an already-reaped terminal record");
    assert.equal(signal, null);

    // THE independent proof: a REAL pgrep -g <pgid> call AFTER shutdown
    // still shows ZERO survivors - shutdown's own reap path is a safe
    // no-op here, not a second attempt that could re-signal a recycled id.
    const afterMembers = await waitForPgrepGroupMembers(
      pgid,
      (members) => members.length === 0,
      3000
    );
    assert.deepEqual(
      afterMembers,
      [],
      `expected zero surviving orphaned descendants after shutdown, pgrep still saw: ${JSON.stringify(afterMembers)}`
    );
  }
);

test(
  "shutdown: a PRE-SIGNAL identity mismatch refuses to signal at all during the shutdown reap too - the fail-closed gate applies at BOTH real callers - the real tracked process survives shutdown, never falsely reaped",
  {
    // Real POSIX identity check + real process-group cleanup - no Windows
    // equivalent path here, matching every other identity-check test in
    // this codebase. Windows has no identity check or process-group verification
    // at all today - a test-harness gap this skip closes, not a product
    // scope decision.
    skip: process.platform === "win32" ? "POSIX-only identity check" : false,
  },
  async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const instance = createServer(serverTransport);
    await instance.server.connect(instance.transport);

    const client = new Client({
      name: "ghantika-shutdown-identity-mismatch-test",
      version: "0.0.0",
    });
    await client.connect(clientTransport);

    let realPid: number | undefined;
    try {
      const callResult = (await client.callTool({
        name: "run",
        arguments: { command: ["sleep", "30"], label: "shutdown-identity-mismatch-check" },
      })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
      assert.notEqual(
        callResult.isError,
        true,
        `run() must succeed: ${JSON.stringify(callResult)}`
      );
      const jobId = callResult.structuredContent?.job_id as string;
      assert.equal(typeof jobId, "string");

      // Awaits the same real settlement `resolveBirthIdentityForKill`'s own
      // production callers already await, rather than racing a fixed
      // wall-clock delay against the async capture - see test/run.test.ts's
      // waitForIdentityCaptureSettled for the full rationale.
      await jobStore.resolveBirthIdentityForKill(jobId);

      const handle = jobStore.getChildHandle(jobId);
      assert.notEqual(handle, undefined, "expected a real attached child for this job");
      realPid = handle!.pid;
      assert.notEqual(
        handle!.birthIdentity,
        undefined,
        "expected a real captured birth identity - this job was created via the real run() handler, which captures one at spawn time"
      );

      // Directly overwrite the internal bookkeeping's captured birth
      // identity to simulate the exact scenario a real pid-reuse would
      // produce - see test/kill.test.ts's identical simulation for the
      // OTHER real identity-check caller (the explicit kill() handler),
      // and test/process.test.ts's own pure-function version of the same
      // simulation, for the full rationale. There is no public API to
      // override an already-attached child's recorded birth identity, so
      // this reaches into JobStore's own private `children` map directly -
      // the only way to test THIS caller's wiring (does server.ts's
      // shutdown reaper actually consult and honor a mismatch), which the
      // pure-function coverage in test/process.test.ts does not exercise
      // on its own.
      const internals = jobStore as unknown as {
        children: Map<
          string,
          {
            child: unknown;
            pid: number;
            spawnedAtMs: number;
            birthIdentity: { capturedAtMs: number; elapsedSecondsAtCapture: number } | undefined;
          }
        >;
      };
      const tracked = internals.children.get(jobId)!;
      assert.notEqual(tracked, undefined);
      internals.children.set(jobId, {
        ...tracked,
        birthIdentity: {
          ...tracked.birthIdentity!,
          capturedAtMs: tracked.birthIdentity!.capturedAtMs - 10 * 60 * 1000, // 10 minutes "ago" - impossible for a process that just started
        },
      });

      await client.close();
      await instance.shutdown("test cleanup - identity mismatch");

      // THE proof: the shutdown reaper's identity check must have refused
      // to signal a mismatched pid, so the real process is STILL ALIVE
      // after "shutdown" - proven via a real, external,
      // independent-of-this-codebase's-own-bookkeeping `ps`-based check
      // (isProcessAlive), never our own internal state.
      assert.equal(
        isProcessAlive(realPid),
        true,
        "the real tracked process must have survived shutdown's identity-mismatch refusal"
      );

      // Real cleanup - the server's shutdown reaper never got the chance
      // to reap this for real (that's the whole point of this test), so it
      // does it directly now.
      process.kill(-realPid, "SIGKILL");
      realPid = undefined; // already reaped - the finally block below must not double-signal it
    } finally {
      // Belt-and-braces: if an assertion above threw before the explicit
      // cleanup ran, still make sure nothing from this test leaks onto the
      // shared host - process.kill on an already-dead group throws ESRCH,
      // never left uncaught here.
      if (realPid !== undefined) {
        try {
          process.kill(-realPid, "SIGKILL");
        } catch {
          // already gone - nothing to do
        }
      }
    }
  }
);

test(
  "OWNER 8 - shutdown's real caller (resolveBirthIdentityForKill) settles a genuinely still-pending capture by the aggregate cap, never hanging past it",
  { skip: process.platform === "win32" ? "shadows ps on PATH, POSIX-only" : false },
  async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const instance = createServer(serverTransport);
    await instance.server.connect(instance.transport);

    const client = new Client({
      name: "ghantika-shutdown-aggregate-cap-test",
      version: "0.0.0",
    });
    await client.connect(clientTransport);

    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-shutdown-aggregate-cap-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    const psPath = path.join(dir, "ps");
    // First invocation: fast not-found. Second invocation (the retry): a
    // real, SIGTERM-resistant ps that sleeps far longer than the real
    // aggregate cap `run()`'s own default-configured capture is given -
    // proving shutdown's own real caller (resolveBirthIdentityForKill) does
    // not hang past that cap, even though shutdown may have MANY jobs to
    // reap.
    fs.writeFileSync(
      psPath,
      `#!/bin/sh\ntrap '' TERM\ncount=$(wc -l < '${invocationMarker}' 2>/dev/null || echo 0)\necho x >> '${invocationMarker}'\nif [ "$count" -eq 0 ]; then\n  exit 1\nfi\nsleep 10\necho '00:01'\n`
    );
    fs.chmodSync(psPath, 0o755);

    let realPid: number | undefined;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;

      // The real `run()` handler fires its own captureBirthIdentityPosixAsync
      // call with the shipped defaults - our fake ps on PATH is what forces
      // that real, unmodified production call toward its own aggregate cap.
      const callResult = (await client.callTool({
        name: "run",
        arguments: { command: ["sleep", "30"], label: "shutdown-aggregate-cap-check" },
      })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
      assert.notEqual(
        callResult.isError,
        true,
        `run() must succeed: ${JSON.stringify(callResult)}`
      );
      const jobId = callResult.structuredContent?.job_id as string;
      assert.equal(typeof jobId, "string");

      const handle = jobStore.getChildHandle(jobId);
      assert.notEqual(handle, undefined, "expected a real attached child for this job");
      realPid = handle!.pid;

      await client.close();
      const before = Date.now();
      await instance.shutdown("test cleanup - aggregate cap");
      const elapsedMs = Date.now() - before;

      // At least 2: the capture's own not-found-then-retry pair. This real
      // end-to-end path may add more (shutdown's own pre-signal identity
      // re-check also shells out to ps against the same shadowed PATH), so
      // this only asserts the retry itself genuinely started - it does not
      // pin the exact incidental total the way the isolated jobStore-level
      // owner does.
      const invocationCount = fs
        .readFileSync(invocationMarker, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0).length;
      assert.ok(
        invocationCount >= 2,
        `expected the retry to genuinely start (at least 2 attempts observed) before the aggregate cap force-reaps it - saw ${invocationCount} invocations`
      );
      assert.ok(
        elapsedMs < 6000,
        `expected shutdown's own reap (which awaits resolveBirthIdentityForKill) to settle well before the resistant observer's own 10s sleep - took ${elapsedMs}ms`
      );
      // The proof that "the job... reaped" (not just that shutdown
      // returned): a real, external isProcessAlive check, never our own
      // internal bookkeeping. A genuinely successful reap already killed
      // this job as part of shutdown, so no explicit cleanup kill follows.
      assert.equal(
        isProcessAlive(realPid),
        false,
        "shutdown's own reap must have actually killed the job's real process, not merely settled the capture and moved on"
      );
      realPid = undefined;
    } finally {
      process.env.PATH = realPath;
      if (realPid !== undefined) {
        try {
          process.kill(-realPid, "SIGKILL");
        } catch {
          // already gone - nothing to do
        }
      }
    }
  }
);
