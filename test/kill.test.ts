import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/server";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import * as killTool from "../dist/tools/kill.js";
import { jobStore } from "../dist/jobStore.js";
import { isProcessAlive, spawnManaged } from "../dist/process.js";

// Explicit ".ts" extension - this helper has no relative imports of its
// own (only node: builtins), so Node's native TypeScript support can load
// it directly without a build step - see test/e2e-server.test.ts's
// identical comment on the same helper.
import { type SpawnedServer, completeHandshake, spawnServer } from "./helpers/spawnServer.ts";
// The shared marker-file poll and its pgid predicate - one implementation
// for every suite that observes a job's real filesystem side effects. The
// rest are this file's own Windows-native counterparts to the POSIX-only
// pgrep/shell-tree fixtures below - see test/harness.ts's own docs for what
// each does and why.
import {
  buildWindowsChildTreeArgv,
  forceKillPidBestEffort,
  longRunningNodeArgv,
  parsesAsPgid,
  waitForFile,
  waitForWindowsTaskState,
} from "./harness.ts";

// ---------------------------------------------------------------------------
// kill: unit-level handler tests (against the real dist/tools/kill.js, but
// calling the JobStore singleton directly rather than over the wire - the
// real end-to-end wire proof, including the lineage/pgrep centerpiece,
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

test("green control: kill on an already-terminal job is an idempotent no-op, never an error", async () => {
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

test("kill: a real running job is actually terminated - state transitions to killed, signal recorded", async () => {
  // Real, cross-platform long-lived argv - POSIX `sleep` isn't a real
  // executable on Windows at all (see test/harness.ts's own docs on
  // `longRunningNodeArgv`).
  const argv = longRunningNodeArgv(10);
  const record = jobStore.createJob({
    argv,
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    isShell: false,
  });
  const child = spawnManaged(
    {
      argv,
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

  const result = await killTool.handler({ job_id: record.job_id });
  assert.notEqual(result.isError, true, `expected kill to succeed: ${JSON.stringify(result)}`);
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(structured.state, "killed");
  // POSIX: a plain long-lived child isn't SIGTERM-resistant, so no
  // escalation is needed and the recorded signal is the real SIGTERM sent.
  // Windows: src/tools/kill.ts's own win32 branch has no graceful phase at
  // all (see its docs) and always reports the honest "SIGKILL-equiv" label,
  // regardless of what actually terminated the process.
  assert.equal(structured.signal, process.platform === "win32" ? "SIGKILL-equiv" : "SIGTERM");
});

test('kill: an explicit non-default "signal" argument is sent once, with no automatic grace/escalation', async () => {
  const argv = longRunningNodeArgv(10);
  const record = jobStore.createJob({
    argv,
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    isShell: false,
  });
  const child = spawnManaged(
    {
      argv,
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
  // POSIX: the caller's explicit SIGKILL is sent and recorded exactly.
  // Windows: src/tools/kill.ts's win32 branch ignores any caller-supplied
  // signal entirely (no graceful phase exists to skip) and always reports
  // "SIGKILL-equiv" - see this file's other kill test for the same note.
  assert.equal(structured.signal, process.platform === "win32" ? "SIGKILL-equiv" : "SIGKILL");
  assert.ok(
    elapsed < 1000,
    `an explicit signal must never wait through the default grace period, took ${elapsed}ms`
  );
});

// ---------------------------------------------------------------------------
// kill: the REAL end-to-end wire proof, including the centerpiece external-
// lineage verification (the single most important check).
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

/** A real `pgrep -g <pgid>` call - the external, independent-of-our-own-bookkeeping system-level check a whole-tree kill requires. Returns the real pids it found, `[]` when pgrep finds none (its own documented exit code 1). */
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

test(
  "THE CENTERPIECE: kill() reaps a REAL process tree - a real job that itself forked real descendant processes - confirmed by a REAL external pgrep after the kill showing zero survivors across the WHOLE tree, not just the direct child",
  {
    // Missing primitive, named explicitly: this test's whole tree (the
    // shell process-group LEADER plus its forked descendants) exists only
    // because of two real POSIX primitives Windows has neither of - a
    // process GROUP (`spawnManaged`'s `detached: true` makes the job's
    // leader its own group leader; there is no such concept on win32) and
    // `pgrep -g`, the external oracle that counts a group's live members
    // in one call. Windows has nothing to build either half from, so this
    // test-harness gap (not a product scope decision - Windows is a
    // supported platform, and kill.ts's own win32 branch does reap a real
    // process tree via taskkill, proven below) skips here. The Windows
    // counterpart immediately below proves the SAME underlying behavior
    // (kill reaps the WHOLE tree, not just the direct child) using what
    // Windows actually has instead: a real multi-process tree built from
    // plain child_process spawns, and a per-pid `tasklist` lookup as the
    // external oracle in place of `pgrep -g`.
    skip:
      process.platform === "win32"
        ? "POSIX-only: needs a real process GROUP (spawnManaged's detached:true group-leader semantics) and `pgrep -g` as the verification oracle, neither of which exists on Windows - see the WINDOWS COUNTERPART test directly below for the win32-native proof of the same behavior"
        : false,
  },
  async () => {
    const server = tracked();
    await completeHandshake(server);

    const dir = makeTempDir();
    const marker = path.join(dir, "pgid.txt");
    // A real shell child (the job's own tracked process, and the process-
    // group LEADER) that itself forks two real `sleep` descendants, writes
    // its own pid (== the group's pgid, since spawnManaged spawns it
    // detached) to a marker file, then blocks on `wait` so the whole tree
    // stays genuinely alive until we kill it.
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
    // never trusting our own bookkeeping - must show ZERO survivors across
    // the WHOLE tree (the shell AND both sleep descendants), not merely the
    // one direct child.
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

    server.child.kill("SIGKILL");
  }
);

test(
  "WINDOWS COUNTERPART: kill() reaps a REAL process tree via taskkill /t - a real job built from real child_process spawns (no shell process-group, no pgrep - see THE CENTERPIECE above) - confirmed by a REAL external tasklist lookup per pid after the kill showing zero survivors across the WHOLE tree, not just the direct child",
  {
    skip:
      process.platform === "win32"
        ? false
        : "Windows-only - exercises taskkill /t against a real Windows process tree; THE CENTERPIECE test above is the POSIX proof of the identical underlying behavior (pgrep -g)",
  },
  async () => {
    const server = tracked();
    await completeHandshake(server);

    const dir = makeTempDir();
    const leaderMarker = path.join(dir, "leader-pid.txt");
    const descendantCount = 2; // matches THE CENTERPIECE's own "shell + 2 sleeps" shape

    server.send({
      jsonrpc: "2.0",
      id: 510,
      method: "tools/call",
      params: {
        name: "run",
        // Non-shell argv path (never `shell: true`): the tree here is a
        // real multi-process tree built from Node's own child_process API
        // (see windowsChildTree.mjs's docs), not a shell one-liner - there
        // is no `&`/`wait` to shell out to on Windows in the first place.
        arguments: { command: buildWindowsChildTreeArgv(leaderMarker, descendantCount, dir) },
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
    const jobId = runBody.result?.structuredContent?.job_id as string;
    assert.equal(typeof jobId, "string");

    // Every real pid captured so far, added the instant each one becomes
    // known - never assembled only at the end - so the `finally` block
    // below can force-reap whatever real processes actually exist even if
    // a LATER step (a still-missing descendant marker, a parser failure,
    // the kill call itself, or an assertion) throws first.
    const capturedPids: number[] = [];
    try {
      // Wait for every REAL marker (the leader's own pid, plus each real
      // descendant's own pid) - never for mere file existence, the same
      // "wait for parseable content" discipline THE CENTERPIECE's own pgid
      // wait uses (see waitForFile's docs). Each marker's raw (untrimmed)
      // text is additionally required to match the EXACT expected shape -
      // one or more decimal digits followed by exactly one trailing
      // newline, nothing else - as its own explicit, test-owned assertion:
      // relying solely on `parsesAsPgid`'s own internal gate would leave
      // this requirement invisible to anything that mutates that gate away,
      // since these fixtures write their marker synchronously and in one
      // shot, so a torn read essentially never occurs in practice either
      // way - this assertion is what makes the exact-format requirement
      // itself load-bearing and independently verifiable.
      const leaderPidText = await waitForFile(leaderMarker, { until: parsesAsPgid });
      assert.match(
        leaderPidText,
        /^\d+\n$/,
        `expected the leader marker to hold exactly a decimal pid followed by one newline, got: ${JSON.stringify(leaderPidText)}`
      );
      const leaderPid = Number(leaderPidText.trim());
      assert.ok(
        Number.isInteger(leaderPid) && leaderPid > 0,
        `expected a real numeric pid from the leader marker file, got: ${JSON.stringify(leaderPidText)}`
      );
      capturedPids.push(leaderPid);

      const descendantPids = await Promise.all(
        Array.from({ length: descendantCount }, async (_unused, i) => {
          const text = await waitForFile(path.join(dir, `child-${i}-pid.txt`), {
            until: parsesAsPgid,
          });
          assert.match(
            text,
            /^\d+\n$/,
            `expected descendant ${i}'s marker to hold exactly a decimal pid followed by one newline, got: ${JSON.stringify(text)}`
          );
          const pid = Number(text.trim());
          assert.ok(
            Number.isInteger(pid) && pid > 0,
            `expected a real numeric pid from descendant ${i}'s marker file, got: ${JSON.stringify(text)}`
          );
          capturedPids.push(pid);
          return pid;
        })
      );
      const allPids = [leaderPid, ...descendantPids];

      // The tree must have DISTINCT, non-duplicate real pids for the
      // leader and every descendant, confirmed BEFORE doing anything else
      // with them: a mutant that writes the SAME (leader) pid into every
      // marker - paired with a leader-only termination - would otherwise
      // defeat every check below undetected, since this test would never
      // actually learn the real, distinct descendant pids at all, and
      // would end up re-checking the leader's own pid three times over
      // instead.
      const uniquePids = new Set(allPids);
      assert.equal(
        uniquePids.size,
        allPids.length,
        `expected ${allPids.length} distinct real pids (the leader plus each descendant) - got duplicates: ${JSON.stringify(allPids)}`
      );

      // Confirm the REAL tree is actually up (the leader + 2 descendants)
      // BEFORE we ever touch kill - a real external `tasklist` lookup per
      // pid, never our own internal bookkeeping.
      for (const pid of allPids) {
        const alive = await waitForWindowsTaskState(pid, true, 3000);
        assert.ok(alive, `expected pid ${pid} (leader or descendant) to be alive before kill`);
      }

      server.send({
        jsonrpc: "2.0",
        id: 511,
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

      // THE proof: a REAL, independent `tasklist` lookup per pid AFTER the
      // kill - never trusting our own bookkeeping - must show every pid in
      // the tree gone, not merely the one direct tracked child. This is
      // what proves src/tools/kill.ts's win32 branch
      // (`taskkill /pid <pid> /t /f`) actually reaps the WHOLE tree, not
      // just the leader.
      for (const pid of allPids) {
        const alive = await waitForWindowsTaskState(pid, false, 5000);
        assert.equal(
          alive,
          false,
          `expected pid ${pid} (leader or descendant) to be gone after kill, tasklist still saw it`
        );
      }
    } finally {
      // Guaranteed reap, independent of everything above: a setup
      // failure, an assertion failure, a `tasklist`-parsing failure, a
      // timeout, or kill() itself failing must never leave a real process
      // tree running - force-terminate every pid this test actually
      // captured, directly, never through the `kill` tool under test.
      // Also inside `finally`, never after it: if any step above throws,
      // the server itself must still be terminated here, or it would be
      // left running with an open stdio pipe that keeps this whole test
      // process from ever reaching a natural exit - `tracked()`'s
      // file-level exit handler only fires once the LAST test in this
      // file finishes, which a hung server would prevent from ever
      // happening cleanly.
      for (const pid of capturedPids) forceKillPidBestEffort(pid);
      if (!server.child.killed) server.child.kill("SIGKILL");
    }
  }
);

test("kill() over the real wire: unknown job_id is a real tool-execution error, never a JSON-RPC protocol error", async () => {
  const server = tracked();
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

interface OutputResponseBody {
  readonly error?: unknown;
  readonly result?: {
    isError?: boolean;
    structuredContent?: { events?: Array<{ text: string }> };
  };
}

/**
 * Polls the REAL `output()` tool over the wire, starting request ids at
 * `startId`, until `token` genuinely appears among `stream`'s events -
 * never a marker-file stand-in. This is what makes the output-buffer
 * claim below an actual proof through the surface callers use: a
 * mutant that cleared a job's buffer on kill would make the AFTER-kill
 * call site of this function time out and throw, while a mutant that
 * never wrote real output at all would make the BEFORE-kill call site do
 * the same.
 */
async function waitForTokenInOutput(
  server: SpawnedServer,
  jobId: string,
  stream: "stdout" | "stderr",
  token: string,
  startId: number,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let id = startId;
  for (;;) {
    server.send({
      jsonrpc: "2.0",
      id: id++,
      method: "tools/call",
      params: { name: "output", arguments: { job_id: jobId, stream } },
    });
    const line = await server.nextLine(2000);
    const body = line.parsed as OutputResponseBody;
    assert.equal(body.error, undefined);
    assert.notEqual(body.result?.isError, true, `output() must succeed: ${JSON.stringify(body)}`);
    const events = body.result?.structuredContent?.events ?? [];
    if (events.some((event) => event.text.includes(token))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for token ${JSON.stringify(token)} in ${stream} via output(), last saw: ${JSON.stringify(events)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("kill() over the real wire: a killed job's output buffer remains readable afterward, proven through the real output() tool surface", async () => {
  const server = tracked();
  await completeHandshake(server);
  const dir = makeTempDir();
  const pidMarker = path.join(dir, "pid.txt");
  const stdoutToken = `GHANTIKA-OUTPUT-SURVIVES-KILL-STDOUT-${Math.random().toString(36).slice(2)}`;
  const stderrToken = `GHANTIKA-OUTPUT-SURVIVES-KILL-STDERR-${Math.random().toString(36).slice(2)}`;

  // A real, long-lived, NEVER-self-terminating child (mirrors
  // test/helpers/windowsChildTree.mjs's own "no natural exit" shape via a
  // no-op interval, rather than a bounded setTimeout a prior version of
  // this test used): writes its own pid to a marker (so this test can
  // confirm it is genuinely alive via a real external liveness check
  // before ever touching kill), writes one unique token to REAL stdout and
  // a different one to REAL stderr, then blocks forever. A fixture that
  // CAN exit naturally cannot prove kill caused a termination: a mutant
  // that makes the fixture die on its own while making kill() itself a
  // successful no-op would still read as "the tree eventually became
  // not-alive" either way - a fixture with no natural exit at all, plus
  // confirming it alive immediately before kill, closes that gap.
  const scriptBody = [
    `require("fs").writeFileSync(${JSON.stringify(pidMarker)}, process.pid + "\\n");`,
    `process.stdout.write(${JSON.stringify(stdoutToken)} + "\\n");`,
    `process.stderr.write(${JSON.stringify(stderrToken)} + "\\n");`,
    `setInterval(() => {}, 1 << 30);`,
  ].join(" ");

  server.send({
    jsonrpc: "2.0",
    id: 503,
    method: "tools/call",
    params: {
      name: "run",
      arguments: { command: [process.execPath, "-e", scriptBody] },
    },
  });
  const runLine = await server.nextLine();
  const runBody = runLine.parsed as RunResponseBody;
  assert.equal(runBody.error, undefined);
  assert.notEqual(runBody.result?.isError, true, `run() must succeed: ${JSON.stringify(runBody)}`);
  const jobId = runBody.result?.structuredContent?.job_id as string;
  assert.equal(typeof jobId, "string");

  let capturedPid: number | undefined;
  try {
    // Wait for the COMPLETE pid, not merely for the marker to exist - and
    // require the EXACT expected shape (decimal digits, one trailing
    // newline, nothing else) as this test's own explicit assertion, not
    // merely `parsesAsPgid`'s internal gate.
    const pidText = await waitForFile(pidMarker, { until: parsesAsPgid });
    assert.match(
      pidText,
      /^\d+\n$/,
      `expected the pid marker to hold exactly a decimal pid followed by one newline, got: ${JSON.stringify(pidText)}`
    );
    const pid = Number(pidText.trim());
    assert.ok(
      Number.isInteger(pid) && pid > 0,
      `expected a real numeric pid from the marker file, got: ${JSON.stringify(pidText)}`
    );
    capturedPid = pid;

    // Confirm the real OS process is genuinely alive BEFORE kill - a real,
    // zero-side-effect `kill -0` probe (the same production-exported
    // primitive src/tools/kill.ts's own POSIX identity check is built
    // from), never this codebase's own bookkeeping.
    assert.ok(isProcessAlive(pid), `expected pid ${pid} to be alive before kill`);

    // Confirm the real output is genuinely visible through output() BEFORE
    // kill too - both streams.
    await waitForTokenInOutput(server, jobId, "stdout", stdoutToken, 520);
    await waitForTokenInOutput(server, jobId, "stderr", stderrToken, 620);

    server.send({
      jsonrpc: "2.0",
      id: 504,
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

    // THE proof: read BOTH streams back through the REAL output() tool
    // AFTER the kill - never a marker-file stand-in - and confirm both
    // tokens are STILL there. kill never touches a job's output buffers
    // (src/tools/kill.ts's own docs); this is what actually proves that
    // claim through the surface callers use, rather than a side-effect
    // file this test's own fixture happened to leave behind.
    await waitForTokenInOutput(server, jobId, "stdout", stdoutToken, 720);
    await waitForTokenInOutput(server, jobId, "stderr", stderrToken, 820);
  } finally {
    // Guaranteed reap, independent of everything above: a setup failure,
    // an assertion failure, a timeout, or kill() itself failing must never
    // leave this real process running - force-terminate it directly,
    // never through the `kill` tool under test. Also inside `finally`,
    // never after it: if any step above throws, the server itself must
    // still be terminated here, or it would be left running with an open
    // stdio pipe that keeps this whole test process from ever reaching a
    // natural exit - `tracked()`'s file-level exit handler only fires once
    // the LAST test in this file finishes, which a hung server would
    // prevent from ever happening cleanly.
    if (capturedPid !== undefined) forceKillPidBestEffort(capturedPid);
    if (!server.child.killed) server.child.kill("SIGKILL");
  }
});
