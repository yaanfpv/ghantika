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
 * Further down this file: cleanup REAPS every live job's whole process tree
 * before the process exits, proven with a real external `pgrep` oracle
 * across all three triggers independently.
 *
 * Windows only proves this for stdin EOF. `.kill('SIGTERM')`/`.kill('SIGINT')`
 * from a separate process (this test file's own parent process included)
 * is delivered on Windows via Win32's `TerminateProcess`, an unconditional,
 * non-cooperative kill with no notification mechanism any handler in the
 * target process can intercept - confirmed against Node's own documented
 * `subprocess.kill()` behavior, and against a real windows-latest CI
 * failure, not assumed. So the SIGTERM/SIGINT variants of the test below,
 * and the SIGTERM-driven green control further down, are Windows-skipped
 * rather than weakened - see `WINDOWS_KILL_UNINTERCEPTABLE_SKIP` below for
 * the full citation, and the Windows-only orphan-proof test near the end of
 * this file for what that actually costs a real job.
 */

// The three whole-tree-reap tests below confirm their result via a real
// external `pgrep -g <pgid>` call, which has no Windows equivalent path -
// a test-harness gap, not a product scope decision. Windows is a
// supported platform; whether cleanup actually reaps a live job's
// process tree there is a separate question this test doesn't answer by
// skipping.
const PGREP_ORACLE_SKIP =
  process.platform === "win32"
    ? "confirms the result via a real external `pgrep -g`, POSIX-only"
    : false;

// UNLIKE the tooling gap above, this next skip is a real, confirmed
// PRODUCT/PLATFORM fact, not a missing test oracle - do not merge the two.
// `child.kill('SIGTERM')`/`child.kill('SIGINT')`, called by a separate
// process against a running Windows process, is delivered by Node's own
// `subprocess.kill()` via Win32's `TerminateProcess()`. Node's own docs
// (process.html, "Signal Events"): "Sending SIGINT, SIGTERM, and SIGKILL
// will cause the unconditional termination of the target process, and
// afterwards, subprocess will report that the process was terminated by
// signal" - and separately (child_process.html, "subprocess.kill()"): "the
// signal argument will be ignored except for 'SIGKILL', 'SIGTERM',
// 'SIGINT' and 'SIGQUIT', and the process will always be killed forcefully
// and abruptly (similar to 'SIGKILL')." `TerminateProcess` is a hard
// OS-level kill with no notification any handler in the target process can
// intercept, on any platform, by design - `process.once("SIGTERM", ...)`
// in src/server.ts genuinely never runs. This isn't theoretical: a real
// windows-latest CI run (29866396802) showed exactly this - "SIGTERM
// reaches the real cleanup path", "SIGINT reaches the real cleanup path
// too", and the SIGTERM-driven green control further down this file all
// failed with the SAME shape (`code: null`, never `0`), regardless of what
// src/server.ts's handler does, because that handler is never reached at
// all.
//
// So this is honestly documented as an open Windows platform limitation
// (README's "Windows shutdown behavior" section; src/server.ts's own
// `attachProcessShutdownHandlers` doc comment), never silently accepted -
// see the Windows-only orphan-proof test near the end of this file, which
// measures what this actually costs a real running job.
const WINDOWS_KILL_UNINTERCEPTABLE_SKIP =
  process.platform === "win32"
    ? "Windows delivers an external kill via TerminateProcess(), which no handler in the target process can intercept (confirmed against Node's own documented subprocess.kill() behavior and a real windows-latest CI failure) - this is a real, open platform limitation, not a test-harness gap; see README's Windows shutdown behavior section and this file's Windows-only orphan-proof test"
    : false;

// Each test waits for a REAL completed initialize handshake (not a fixed
// sleep) before sending its signal/EOF - a blind `setTimeout` was flaky
// under full-suite load (many test files spawn real child processes
// concurrently, and a fixed wait is not always long enough for THIS
// child's transport to finish connecting before the signal arrives).
// Waiting on the actual initialize RESPONSE is a real readiness signal
// regardless of system load, and is also more representative of a real
// client's lifecycle (connect, then eventually disconnect).

test(
  "SIGTERM reaches the real cleanup path: stderr shows the shutdown diagnostic, process exits 0",
  { skip: WINDOWS_KILL_UNINTERCEPTABLE_SKIP },
  async () => {
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
  }
);

test(
  "SIGINT reaches the real cleanup path too",
  { skip: WINDOWS_KILL_UNINTERCEPTABLE_SKIP },
  async () => {
    const server = spawnServer();
    await completeHandshake(server);
    server.child.kill("SIGINT");
    const { code, signal } = await server.waitForExit();
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.match(server.stderrText(), /\[ghantika\] shutting down \(SIGINT\)/);
  }
);

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
// every live job's whole process tree. Without the reap, a real spawned
// server, a real MCP handshake, a real `run` call starting a long-lived
// child, then closing the server's stdin (EOF) would exit the server itself
// cleanly (`{code:0, signal:null}`) while the child it spawned stayed alive
// and orphaned.
//
// Implemented in src/server.ts's `reapLiveJobsOnShutdown` (reuses the same
// real kill machinery `kill` itself uses - see that function's own docs).
// This section proves "zero surviving children" with a REAL external `pgrep`
// oracle (the SAME pattern test/kill.test.ts's own centerpiece test
// established), across each of the THREE shutdown triggers INDEPENDENTLY
// (stdin EOF, SIGTERM, SIGINT - three separate test cases, not one
// combined) - and, matching the same tree-reap standard `kill` itself holds
// to, against a job that itself forks real DESCENDANT processes, so this
// proves the WHOLE tree is reaped, not merely the one direct tracked child.
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
 * forks two real `sleep` descendants (so the whole tree, not just the one
 * direct child, must be reaped), confirms the tree is genuinely alive via a
 * real external `pgrep` BEFORE ever triggering shutdown, then hands back
 * the server and the tree's pgid for the caller to trigger its own
 * shutdown path against and verify.
 */
async function spawnServerWithLiveTree(): Promise<{ server: SpawnedServer; pgid: number }> {
  const server = spawnServer();
  await completeHandshake(server);

  const dir = makeTempDir();
  const marker = path.join(dir, "pgid.txt");
  // Mirrors test/kill.test.ts's own centerpiece fixture exactly: a real
  // shell child (the job's own tracked process, and the process-group
  // LEADER, since spawnManaged spawns it detached) that forks two real
  // `sleep` descendants, writes its own pid (== the group's pgid) to a
  // marker file, then blocks on `wait` so the whole tree stays genuinely
  // alive until shutdown reaps it.
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
  "stdin EOF reaps a REAL live job's WHOLE process tree - zero survivors confirmed by a real external pgrep",
  { skip: PGREP_ORACLE_SKIP },
  async () => {
    const { server, pgid } = await spawnServerWithLiveTree();

    server.child.stdin.end(); // closes stdin -> the server observes EOF and runs its real shutdown path
    const { code, signal } = await server.waitForExit();
    assert.equal(code, 0, "the server's own shutdown handler must exit cleanly");
    assert.equal(signal, null);

    // THE proof: a REAL, independent `pgrep -g <pgid>` call AFTER shutdown -
    // never trusting this codebase's own bookkeeping - must show ZERO
    // survivors across the WHOLE tree (the shell AND both sleep
    // descendants), not merely the one direct tracked child.
    const afterMembers = await waitForPgrepGroupMembers(
      pgid,
      (members) => members.length === 0,
      3000
    );
    assert.deepEqual(
      afterMembers,
      [],
      `expected zero surviving process-group members after stdin-EOF shutdown, pgrep still saw: ${JSON.stringify(afterMembers)}`
    );
  }
);

test(
  "SIGTERM reaps a REAL live job's WHOLE process tree - zero survivors confirmed by a real external pgrep",
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
      `expected zero surviving process-group members after SIGTERM shutdown, pgrep still saw: ${JSON.stringify(afterMembers)}`
    );
  }
);

test(
  "SIGINT reaps a REAL live job's WHOLE process tree - zero survivors confirmed by a real external pgrep",
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
      `expected zero surviving process-group members after SIGINT shutdown, pgrep still saw: ${JSON.stringify(afterMembers)}`
    );
  }
);

test(
  "green control: a job that has already exited BEFORE shutdown is simply left alone - shutdown never errors or hangs on an already-terminal job",
  { skip: WINDOWS_KILL_UNINTERCEPTABLE_SKIP },
  async () => {
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
    assert.equal(
      code,
      0,
      "shutdown must still exit cleanly when there is nothing live left to reap"
    );
    assert.equal(signal, null);
  }
);

// =============================================================================
// Windows: the real, open gap - measured, not assumed.
//
// The tests above establish WHY a Windows `.kill()` can't reach
// src/server.ts's cleanup path at all (TerminateProcess, unconditional, no
// notification any handler can intercept). That explains a bad EXIT CODE,
// but doesn't by itself prove a job is actually left running - "no clean
// exit code" and "an orphaned process" are different bugs, and only one of
// them matters to a real user. This test measures the real one directly:
// a real job's real OS process, checked with a real external `tasklist`
// query AFTER a non-stdin kill - never this codebase's own `jobStore`
// bookkeeping, which is inside the process that just got torn down and so
// can't witness its own outcome either way.
// =============================================================================

const NOT_WINDOWS_SKIP =
  process.platform !== "win32"
    ? "proves a Windows-only orphan gap via a real external `tasklist` oracle; this file's POSIX pgrep-oracle tests above already cover the equivalent POSIX case"
    : false;

/**
 * True when a real, external `tasklist` query finds a live process with
 * exactly this pid - the Windows-side counterpart to this file's own
 * `pgrepGroupMembers`. Matched as a quoted CSV field (`"<pid>"`), not a bare
 * substring search, so pid 12 can never accidentally match a real row for
 * pid 123. Absence is "no such row in the CSV output," never inferred from
 * `tasklist`'s own (possibly localized) "nothing found" info line.
 */
function windowsTaskAlive(pid: number): boolean {
  let output: string;
  try {
    output = execFileSync("tasklist", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], {
      encoding: "utf8",
    });
  } catch {
    // A non-zero tasklist exit is itself "found nothing" on some Windows
    // builds - treated the same as an output with no matching row.
    return false;
  }
  return output.includes(`"${pid}"`);
}

async function waitForWindowsTaskState(
  pid: number,
  expectAlive: boolean,
  timeoutMs: number
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    const alive = windowsTaskAlive(pid);
    if (alive === expectAlive) return alive;
    if (Date.now() - start > timeoutMs) return alive;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test(
  "Windows: a non-stdin kill (SIGTERM, the only path an external MCP host actually has) leaves a live job's REAL process running - proven by a real external `tasklist` query, never this codebase's own bookkeeping. Predeclared: the child survives, because src/server.ts's shutdown handler never runs at all here (see WINDOWS_KILL_UNINTERCEPTABLE_SKIP above). This documents the real, currently open Windows gap - see README's Windows shutdown behavior section.",
  { skip: NOT_WINDOWS_SKIP },
  async () => {
    const server = spawnServer();
    await completeHandshake(server);

    const dir = makeTempDir();
    const marker = path.join(dir, "pid.txt");
    // A plain node child (never a shell, so no cmd.exe quoting to worry
    // about) that writes its OWN pid - read from inside that process
    // itself, never from this test's or the server's own bookkeeping - to
    // a marker file, then blocks indefinitely so it's still alive whenever
    // this test gets around to checking it.
    const markerScript =
      "require('fs').writeFileSync(process.argv[1], String(process.pid) + '\\n'); setInterval(() => {}, 1000);";

    server.send({
      jsonrpc: "2.0",
      id: 800,
      method: "tools/call",
      params: {
        name: "run",
        arguments: { command: [process.execPath, "-e", markerScript, marker] },
      },
    });
    const runLine = await server.nextLine();
    const runBody = runLine.parsed as RunResponseBody;
    assert.equal(runBody.error, undefined);
    assert.notEqual(
      runBody.result?.isError,
      true,
      `run() must succeed: ${JSON.stringify(runBody)}`
    );

    const pidText = await waitForFile(marker, { until: parsesAsPgid });
    const pid = Number(pidText.trim());
    assert.ok(
      Number.isInteger(pid) && pid > 0,
      `expected a real numeric pid from the marker file, got: ${JSON.stringify(pidText)}`
    );

    const aliveBefore = await waitForWindowsTaskState(pid, true, 3000);
    assert.equal(
      aliveBefore,
      true,
      `expected the job's real process (pid ${pid}) to be alive BEFORE shutdown, tasklist disagreed`
    );

    // The non-stdin path - exactly the mechanism the (Windows-skipped)
    // SIGTERM test above uses, and exactly what any real MCP host's own
    // process-management code does to end a subprocess it no longer wants.
    server.child.kill("SIGTERM");
    await server.waitForExit();

    // THE measurement: a real, independent `tasklist` query AFTER shutdown.
    // Predeclared red: still alive, because TerminateProcess killed the
    // server before reapLiveJobsOnShutdown ever got a chance to run.
    const aliveAfter = await waitForWindowsTaskState(pid, false, 2000);
    assert.equal(
      aliveAfter,
      true,
      `expected the orphaned job's real process (pid ${pid}) to still be running after a non-stdin SIGTERM kill - tasklist reported it gone instead, which would mean this known Windows gap has actually closed (if so, update this test, WINDOWS_KILL_UNINTERCEPTABLE_SKIP, src/server.ts's shutdown-handler doc comment, and the README accordingly)`
    );

    // This test's own cleanup, not the server's (which is dead): kill the
    // now-orphaned process directly so it doesn't outlive this test run.
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    } catch {
      // already gone - fine
    }
  }
);
