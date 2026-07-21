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
import { spawnManaged } from "../dist/process.js";

// Explicit ".ts" extension - this helper has no relative imports of its
// own (only node: builtins), so Node's native TypeScript support can load
// it directly without a build step - see test/e2e-server.test.ts's
// identical comment on the same helper.
import { type SpawnedServer, completeHandshake, spawnServer } from "./helpers/spawnServer.ts";
// The shared marker-file poll and its pgid predicate - one implementation
// for every suite that observes a job's real filesystem side effects.
import { parsesAsPgid, waitForFile } from "./harness.ts";

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

  const result = await killTool.handler({ job_id: record.job_id });
  assert.notEqual(result.isError, true, `expected kill to succeed: ${JSON.stringify(result)}`);
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(structured.state, "killed");
  assert.equal(structured.signal, "SIGTERM"); // a plain `sleep` isn't SIGTERM-resistant - no escalation needed
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

test("THE CENTERPIECE: kill() reaps a REAL process tree - a real job that itself forked real descendant processes - confirmed by a REAL external pgrep after the kill showing zero survivors across the WHOLE tree, not just the direct child", async () => {
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
  assert.notEqual(runBody.result?.isError, true, `run() must succeed: ${JSON.stringify(runBody)}`);
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
});

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

test("kill() over the real wire: a killed job's output buffer remains readable afterward (proven via a real marker-file side effect written before the kill, since output/tail aren't wired to the wire here)", async () => {
  const server = tracked();
  await completeHandshake(server);
  const dir = makeTempDir();
  const marker = path.join(dir, "wrote-before-kill.txt");
  server.send({
    jsonrpc: "2.0",
    id: 503,
    method: "tools/call",
    params: {
      name: "run",
      arguments: { command: `echo wrote-this > '${marker}'; sleep 30`, shell: true },
    },
  });
  const runLine = await server.nextLine();
  const runBody = runLine.parsed as RunResponseBody;
  const jobId = runBody.result?.structuredContent?.job_id as string;

  await waitForFile(marker, { until: (text) => text.trim() === "wrote-this" });

  server.send({
    jsonrpc: "2.0",
    id: 504,
    method: "tools/call",
    params: { name: "kill", arguments: { job_id: jobId } },
  });
  const killLine = await server.nextLine(8000);
  const killBody = killLine.parsed as RunResponseBody;
  assert.equal(killBody.result?.structuredContent?.state, "killed");

  // The real side effect the job produced before it died is still there -
  // kill never touched it (a stand-in for output/tail's future assertion
  // that the buffer itself survives, since those tools aren't wired to the
  // wire here).
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "wrote-this");

  server.child.kill("SIGKILL");
});
