import assert from "node:assert/strict";
import { test } from "node:test";

// Real client, real in-process transport, real server - the end-to-end
// jobStore-singleton-sharing regression coverage below drives an actual
// `tools/call` through the SDK's own `Client`/`Server` classes rather than calling
// `dispatchToolCall` directly, so the assertion is about the REAL request-
// handling path a real MCP client exercises, not a bypass of it. Only
// possible IN-PROCESS (same Node module registry as this test file) - the
// genuinely spawned child process test/helpers/spawnServer.ts otherwise
// uses runs in a SEPARATE OS process with its own memory, so a directly-
// imported `jobStore` in the test process could never observe a spawned
// child's jobs regardless of whether the singleton design is correct.
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import {
  ALL_JOB_STATES,
  JobStore,
  MAX_BUFFER_BYTES,
  MAX_BUFFER_LINES,
  MAX_LINE_BYTES,
  appendChunkToBuffer,
  createStreamBufferState,
  finalizeStreamBuffer,
  findUtf8SafeCutPoint,
  isJobState,
  isTerminalJobState,
  jobStore,
  snapshotStreamBuffer,
  toPublicProjection,
} from "../dist/jobStore.js";
import { spawnManaged } from "../dist/process.js";
import { createServer } from "../dist/server.js";
import * as runTool from "../dist/tools/run.js";

// ---------------------------------------------------------------------------
// JobStore: basic registration
// ---------------------------------------------------------------------------

test("a fresh JobStore tracks no jobs", () => {
  const store = new JobStore();
  assert.equal(store.size(), 0);
  assert.deepEqual(store.list(), []);
  assert.equal(store.has("anything"), false);
  assert.equal(store.get("anything"), undefined);
});

test("createJob registers a job in starting state with the given argv/cwd/env/label", () => {
  const store = new JobStore();
  const record = store.createJob({
    argv: ["echo", "hi"],
    cwd: "/tmp",
    env: { PATH: "/bin" },
    label: "my-label",
    isShell: false,
  });

  assert.equal(store.size(), 1);
  assert.equal(store.has(record.job_id), true);
  assert.equal(record.state, "starting");
  assert.deepEqual(record.argv, ["echo", "hi"]);
  assert.equal(record.cwd, "/tmp");
  assert.deepEqual(record.env, { PATH: "/bin" });
  assert.equal(record.label, "my-label");
  assert.equal(record.is_shell, false);
  assert.equal(typeof record.started_at, "string");
  assert.equal(record.ended_at, undefined);
  assert.equal(record.exit_code, undefined);
  assert.equal(record.signal, undefined);
  assert.equal(record.diagnostic, undefined);
  assert.equal(typeof record.seq, "number");
});

test("createJob assigns strictly increasing seq numbers across jobs", () => {
  const store = new JobStore();
  const a = store.createJob({ argv: ["a"], cwd: "/tmp", env: {}, isShell: false });
  const b = store.createJob({ argv: ["b"], cwd: "/tmp", env: {}, isShell: false });
  const c = store.createJob({ argv: ["c"], cwd: "/tmp", env: {}, isShell: false });
  assert.ok(a.seq < b.seq);
  assert.ok(b.seq < c.seq);
});

test("createFailedJob registers an already-terminal failed job with a spawn-error diagnostic", () => {
  const store = new JobStore();
  const record = store.createFailedJob({
    argv: ["/no/such/binary"],
    cwd: "/tmp",
    env: {},
    isShell: false,
    diagnosticMessage: "command not found or not executable",
  });

  assert.equal(record.state, "failed");
  assert.deepEqual(record.diagnostic, {
    reason: "spawn-error",
    message: "command not found or not executable",
  });
  assert.equal(typeof record.started_at, "string");
  assert.equal(record.ended_at, record.started_at);
});

test("multiple distinct jobs are all tracked independently", () => {
  const store = new JobStore();
  const a = store.createJob({ argv: ["echo", "a"], cwd: "/tmp", env: {}, isShell: false });
  const b = store.createFailedJob({
    argv: ["bad"],
    cwd: "/tmp",
    env: {},
    isShell: false,
    diagnosticMessage: "x",
  });
  assert.equal(store.size(), 2);
  assert.equal(store.get(a.job_id)?.state, "starting");
  assert.equal(store.get(b.job_id)?.state, "failed");
  assert.deepEqual(
    store.list().map((r) => r.job_id),
    [a.job_id, b.job_id]
  );
});

// ---------------------------------------------------------------------------
// JobStore: state transitions
// ---------------------------------------------------------------------------

test("markRunning transitions starting -> running", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  store.markRunning(record.job_id);
  assert.equal(store.get(record.job_id)?.state, "running");
});

test("markRunning is a no-op once the job is already terminal (does not resurrect a failed job)", () => {
  const store = new JobStore();
  const record = store.createFailedJob({
    argv: ["bad"],
    cwd: "/tmp",
    env: {},
    isShell: false,
    diagnosticMessage: "x",
  });
  store.markRunning(record.job_id);
  assert.equal(store.get(record.job_id)?.state, "failed");
});

test("markExited transitions to exited and records exit_code/ended_at, never signal for a code exit", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  store.markRunning(record.job_id);
  store.markExited(record.job_id, 0, null);
  const after = store.get(record.job_id)!;
  assert.equal(after.state, "exited");
  assert.equal(after.exit_code, 0);
  assert.equal(after.signal, undefined);
  assert.equal(typeof after.ended_at, "string");
});

test("markExited records signal (not exit_code) for a signal death, and NEVER produces state killed (reserved for a future kill tool)", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  store.markExited(record.job_id, null, "SIGSEGV");
  const after = store.get(record.job_id)!;
  assert.equal(after.state, "exited");
  assert.notEqual(after.state, "killed");
  assert.equal(after.exit_code, undefined);
  assert.equal(after.signal, "SIGSEGV");
});

test("markExited is idempotent: a second call never overwrites the first terminal result", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  store.markExited(record.job_id, 0, null);
  store.markExited(record.job_id, 1, "SIGTERM"); // late/duplicate event
  const after = store.get(record.job_id)!;
  assert.equal(after.exit_code, 0);
  assert.equal(after.signal, undefined);
});

test("markSpawnFailed transitions a starting/running job to failed with a spawn-error diagnostic", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  store.markSpawnFailed(record.job_id, "EACCES");
  const after = store.get(record.job_id)!;
  assert.equal(after.state, "failed");
  assert.deepEqual(after.diagnostic, { reason: "spawn-error", message: "EACCES" });
  assert.equal(typeof after.ended_at, "string");
});

test("markSpawnFailed is a no-op once the job is already terminal", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  store.markExited(record.job_id, 0, null);
  store.markSpawnFailed(record.job_id, "should be ignored");
  const after = store.get(record.job_id)!;
  assert.equal(after.state, "exited");
  assert.equal(after.diagnostic, undefined);
});

test("unknown job ids are safely ignored by every mark*/appendOutput/finalizeStream method", () => {
  const store = new JobStore();
  assert.doesNotThrow(() => store.markRunning("nope"));
  assert.doesNotThrow(() => store.markExited("nope", 0, null));
  assert.doesNotThrow(() => store.markSpawnFailed("nope", "x"));
  assert.doesNotThrow(() => store.markKilled("nope", "SIGTERM"));
  assert.doesNotThrow(() => store.appendOutput("nope", "stdout", Buffer.from("x")));
  assert.doesNotThrow(() => store.finalizeStream("nope", "stdout"));
  assert.equal(store.getStreamSnapshot("nope", "stdout"), undefined);
  assert.equal(store.getChildHandle("nope"), undefined);
});

// ---------------------------------------------------------------------------
// JobStore: markKilled / getChildHandle / attachChild
// ---------------------------------------------------------------------------

test("markKilled transitions starting/running -> killed and records the signal + ended_at", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  store.markRunning(record.job_id);
  store.markKilled(record.job_id, "SIGTERM");
  const after = store.get(record.job_id)!;
  assert.equal(after.state, "killed");
  assert.equal(after.signal, "SIGTERM");
  assert.equal(typeof after.ended_at, "string");
});

test("(green control) markKilled on an already-terminal job (exited) is a no-op, never resurrects/overwrites it - kill's own idempotent no-op relies on this", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  store.markExited(record.job_id, 0, null);
  store.markKilled(record.job_id, "SIGKILL");
  const after = store.get(record.job_id)!;
  assert.equal(after.state, "exited");
  assert.equal(after.exit_code, 0);
  assert.notEqual(after.state, "killed");
});

test("markExited after markKilled is ALSO a no-op (the reverse race) - first write wins in both directions", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  store.markKilled(record.job_id, "SIGTERM");
  store.markExited(record.job_id, 0, null); // late/duplicate natural-exit event
  const after = store.get(record.job_id)!;
  assert.equal(after.state, "killed");
  assert.equal(after.signal, "SIGTERM");
});

test("a killed job's output buffer remains readable afterward - markKilled never touches stream buffers", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("before the kill\n"));
  store.markKilled(record.job_id, "SIGKILL");
  const snapshot = store.getStreamSnapshot(record.job_id, "stdout")!;
  assert.deepEqual(
    snapshot.lines.map((l) => l.text),
    ["before the kill"]
  );
});

test("isTerminalJobState is true for exited/killed/failed and false for starting/running", () => {
  assert.equal(isTerminalJobState("exited"), true);
  assert.equal(isTerminalJobState("killed"), true);
  assert.equal(isTerminalJobState("failed"), true);
  assert.equal(isTerminalJobState("starting"), false);
  assert.equal(isTerminalJobState("running"), false);
});

test(
  "attachChild/getChildHandle: a real attached child's pid and an approximate spawnedAtMs are retrievable, never the raw ChildProcess itself",
  {
    // Spawns the bare `sleep` binary and cleans up via a negative-pid
    // process-group kill, neither of which has a Windows equivalent here -
    // a test-harness gap tracked separately (OD-5: Windows is a supported
    // platform; only this harness's real POSIX process-group primitives
    // are not).
    skip:
      process.platform === "win32"
        ? "spawns bare `sleep` and cleans up via a negative-pid process-group kill, both POSIX-only"
        : false,
  },
  async () => {
    const store = new JobStore();
    const record = store.createJob({ argv: ["sleep", "1"], cwd: "/tmp", env: {}, isShell: false });
    const beforeAttach = Date.now();
    const child = spawnManaged(
      {
        argv: ["sleep", "1"],
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
    store.attachChild(record.job_id, child!);
    const afterAttach = Date.now();

    const handle = store.getChildHandle(record.job_id)!;
    assert.equal(handle.pid, child!.pid);
    assert.ok(handle.spawnedAtMs >= beforeAttach && handle.spawnedAtMs <= afterAttach);
    assert.equal(
      "child" in (handle as unknown as Record<string, unknown>),
      false,
      "getChildHandle must never expose the raw ChildProcess, only {pid, spawnedAtMs}"
    );

    process.kill(-child!.pid!, "SIGKILL"); // cleanup
  }
);

test("getChildHandle returns undefined for a job that never had a child attached (e.g. a job that started already-failed)", () => {
  const store = new JobStore();
  const record = store.createFailedJob({
    argv: ["bad"],
    cwd: "/tmp",
    env: {},
    isShell: false,
    diagnosticMessage: "x",
  });
  assert.equal(store.getChildHandle(record.job_id), undefined);
});

// ---------------------------------------------------------------------------
// JobStore: output buffering integration (per-job, per-stream)
// ---------------------------------------------------------------------------

test("appendOutput/getStreamSnapshot: stdout and stderr are independent buffers for the same job", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("out line\n"));
  store.appendOutput(record.job_id, "stderr", Buffer.from("err line\n"));

  const stdout = store.getStreamSnapshot(record.job_id, "stdout")!;
  const stderr = store.getStreamSnapshot(record.job_id, "stderr")!;
  assert.deepEqual(
    stdout.lines.map((l) => l.text),
    ["out line"]
  );
  assert.deepEqual(
    stderr.lines.map((l) => l.text),
    ["err line"]
  );
});

test("finalizeStream flushes a pending partial final line for that job/stream", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("no newline yet"));
  assert.deepEqual(store.getStreamSnapshot(record.job_id, "stdout")!.lines, []);
  store.finalizeStream(record.job_id, "stdout");
  const snapshot = store.getStreamSnapshot(record.job_id, "stdout")!;
  assert.deepEqual(snapshot.lines, [{ text: "no newline yet", terminator: "stream-end", seq: 1 }]);
});

// ---------------------------------------------------------------------------
// toPublicProjection
// ---------------------------------------------------------------------------

test("toPublicProjection never includes env or the raw argv array in any form", () => {
  const store = new JobStore();
  const record = store.createJob({
    argv: ["/opt/secret-install-path/mybinary", "--token", "abc123"],
    cwd: "/tmp",
    env: { SECRET_TOKEN: "abc123" },
    isShell: false,
  });
  const projection = toPublicProjection(
    record,
    store.getOutputCounts(record.job_id)
  ) as unknown as Record<string, unknown>;
  assert.equal("env" in projection, false);
  assert.equal("argv" in projection, false);
  const serialized = JSON.stringify(projection);
  assert.equal(
    serialized.includes("abc123"),
    false,
    "must not leak an argument or env value anywhere in the projection"
  );
  assert.equal(
    serialized.includes("secret-install-path"),
    false,
    "must not leak the full argv[0] path, only its basename via command_summary"
  );
  assert.equal(
    projection.command_summary,
    "mybinary",
    "the basename itself is legitimately visible - only the path/args around it are redacted"
  );
});

test("toPublicProjection's command_summary is ONLY argv[0]'s basename, never arguments", () => {
  const store = new JobStore();
  const record = store.createJob({
    argv: ["/usr/bin/node", "--version", "--flag-with-secret"],
    cwd: "/tmp",
    env: {},
    isShell: false,
  });
  const projection = toPublicProjection(record, store.getOutputCounts(record.job_id));
  assert.equal(projection.command_summary, "node");
});

test("toPublicProjection's command_summary for a shell job is the safe first token's basename, never the full shell string", () => {
  const store = new JobStore();
  const record = store.createJob({
    argv: ["/bin/ls -la | grep secret-pattern"],
    cwd: "/tmp",
    env: {},
    isShell: true,
  });
  const projection = toPublicProjection(record, store.getOutputCounts(record.job_id));
  assert.equal(projection.command_summary, "ls");
  assert.equal(JSON.stringify(projection).includes("secret-pattern"), false);
});

test("toPublicProjection falls back label to 'job <job_id>' when no label was provided", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  const projection = toPublicProjection(record, store.getOutputCounts(record.job_id));
  assert.equal(projection.label, `job ${record.job_id}`);
});

test("toPublicProjection uses the caller's label verbatim when provided (green control)", () => {
  const store = new JobStore();
  const record = store.createJob({
    argv: ["echo"],
    cwd: "/tmp",
    env: {},
    isShell: false,
    label: "nightly-build",
  });
  const projection = toPublicProjection(record, store.getOutputCounts(record.job_id));
  assert.equal(projection.label, "nightly-build");
  assert.equal(projection.state, "starting");
  assert.equal(projection.diagnostic, undefined);
});

test("toPublicProjection carries state/timestamps/exit_code/signal/diagnostic through for a terminal job", () => {
  const store = new JobStore();
  const record = store.createFailedJob({
    argv: ["bad"],
    cwd: "/tmp",
    env: {},
    isShell: false,
    diagnosticMessage: "boom",
  });
  const projection = toPublicProjection(record, store.getOutputCounts(record.job_id));
  assert.equal(projection.state, "failed");
  assert.equal(projection.started_at, record.started_at);
  assert.equal(projection.ended_at, record.ended_at);
  assert.deepEqual(projection.diagnostic, { reason: "spawn-error", message: "boom" });
});

// ---------------------------------------------------------------------------
// command_summary leading-assignment redaction, and the `counts` field.
// ---------------------------------------------------------------------------

// An EXTERNAL zero-leak oracle - several distinct shell commands with a
// secret in different leading positions, asserted PROGRAMMATICALLY (by
// string search over the entire serialized projection), not just one
// spot-checked case.
test("command_summary NEVER leaks a leading shell env-assignment's value, across a plain prefix, a quoted prefix, and multiple chained assignments", () => {
  const store = new JobStore();
  const cases: Array<{ argv: string; secret: string; expectedSummary: string }> = [
    { argv: "SUPERSECRET=abc123 /bin/echo hello", secret: "abc123", expectedSummary: "echo" },
    { argv: "'SUPERSECRET=abc123' /bin/echo hi", secret: "abc123", expectedSummary: "echo" },
    {
      argv: "A=1 B=topsecretvalue /bin/echo hi",
      secret: "topsecretvalue",
      expectedSummary: "echo",
    },
    { argv: "TOKEN=leak-me-not", secret: "leak-me-not", expectedSummary: "(shell)" }, // ALL assignments, no real command at all
  ];
  for (const { argv, secret, expectedSummary } of cases) {
    const record = store.createJob({ argv: [argv], cwd: "/tmp", env: {}, isShell: true });
    const projection = toPublicProjection(record, store.getOutputCounts(record.job_id));
    const serialized = JSON.stringify(projection);
    assert.equal(
      serialized.includes(secret),
      false,
      `command_summary must never leak "${secret}" from shell command "${argv}", got: ${serialized}`
    );
    assert.equal(
      projection.command_summary,
      expectedSummary,
      `unexpected command_summary for "${argv}"`
    );
  }
});

test("(redaction green control) a shell command with NO leading assignment is unaffected - the real command's basename still surfaces normally", () => {
  const store = new JobStore();
  const record = store.createJob({
    argv: ["/usr/bin/env node script.js"],
    cwd: "/tmp",
    env: {},
    isShell: true,
  });
  const projection = toPublicProjection(record, store.getOutputCounts(record.job_id));
  assert.equal(projection.command_summary, "env");
});

test("an empty/blank shell command summary falls back to the safe marker, never an empty or unparseable string", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["   "], cwd: "/tmp", env: {}, isShell: true });
  const projection = toPublicProjection(record, store.getOutputCounts(record.job_id));
  assert.equal(projection.command_summary, "(shell)");
});

// Exact-field-set regression - catches a future accidental field
// addition/removal structurally, not just by chance test coverage.
test("PublicJobProjection's field set is EXACTLY the frozen set, including counts", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  const projection = toPublicProjection(record, store.getOutputCounts(record.job_id));
  assert.deepEqual(
    Object.keys(projection).sort(),
    [
      "command_summary",
      "counts",
      "diagnostic",
      "ended_at",
      "exit_code",
      "job_id",
      "label",
      "queue_position",
      "signal",
      "started_at",
      "state",
    ].sort()
  );
});

test("counts starts at all zeros for a fresh job with no output yet", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  const projection = toPublicProjection(record, store.getOutputCounts(record.job_id));
  assert.deepEqual(projection.counts, {
    stdout_lines: 0,
    stdout_bytes: 0,
    stderr_lines: 0,
    stderr_bytes: 0,
  });
});

test("counts reflects real appended stdout/stderr - lines materialized and raw bytes received, independently per stream", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("a\nb\nc\n"));
  store.appendOutput(record.job_id, "stderr", Buffer.from("x\n"));
  const counts = store.getOutputCounts(record.job_id);
  assert.equal(counts.stdout_lines, 3);
  assert.equal(counts.stdout_bytes, Buffer.byteLength("a\nb\nc\n", "utf8"));
  assert.equal(counts.stderr_lines, 1);
  assert.equal(counts.stderr_bytes, Buffer.byteLength("x\n", "utf8"));
});

test("counts.*_lines survives eviction (a monotonic EVER-total, never the shrinking currently-retained count)", () => {
  const store = new JobStore();
  const record = store.createJob({ argv: ["echo"], cwd: "/tmp", env: {}, isShell: false });
  const totalLines = MAX_BUFFER_LINES + 25;
  for (let i = 0; i < totalLines; i += 1) {
    store.appendOutput(record.job_id, "stdout", Buffer.from(`line-${i}\n`));
  }
  const snapshot = store.getStreamSnapshot(record.job_id, "stdout")!;
  assert.ok(
    snapshot.lines.length < totalLines,
    "the RETAINED count must have shrunk due to eviction"
  );
  const counts = store.getOutputCounts(record.job_id);
  assert.equal(
    counts.stdout_lines,
    totalLines,
    "counts.stdout_lines must be the EVER-total, unaffected by eviction"
  );
});

test("getOutputCounts returns all-zero counts for an unknown job id, matching this store's established unknown-id convention", () => {
  const store = new JobStore();
  assert.deepEqual(store.getOutputCounts("no-such-job"), {
    stdout_lines: 0,
    stdout_bytes: 0,
    stderr_lines: 0,
    stderr_bytes: 0,
  });
});

// ---------------------------------------------------------------------------
// Closed JobState enum
// ---------------------------------------------------------------------------

test("the JobState enum is closed at exactly five values", () => {
  assert.deepEqual([...ALL_JOB_STATES].sort(), [
    "exited",
    "failed",
    "killed",
    "running",
    "starting",
  ]);
  assert.equal(ALL_JOB_STATES.length, 5);
});

test("isJobState accepts exactly the five real states and rejects anything else", () => {
  for (const state of ALL_JOB_STATES) {
    assert.equal(isJobState(state), true);
  }
  assert.equal(isJobState("paused"), false);
  assert.equal(isJobState("queued"), false);
  assert.equal(isJobState(""), false);
  assert.equal(isJobState(42), false);
  assert.equal(isJobState(undefined), false);
});

// ---------------------------------------------------------------------------
// Stream buffer byte accounting
// ---------------------------------------------------------------------------

test("a single newline-terminated chunk produces one complete 'newline' line", () => {
  const state = createStreamBufferState();
  appendChunkToBuffer(state, Buffer.from("hello world\n"));
  const snapshot = snapshotStreamBuffer(state);
  assert.deepEqual(snapshot.lines, [{ text: "hello world", terminator: "newline", seq: 1 }]);
  assert.equal(snapshot.truncated, false);
});

test("multiple lines in one chunk are all split out correctly", () => {
  const state = createStreamBufferState();
  appendChunkToBuffer(state, Buffer.from("a\nb\nc\n"));
  assert.deepEqual(
    snapshotStreamBuffer(state).lines.map((l) => l.text),
    ["a", "b", "c"]
  );
});

test("a line split across two chunks (no newline in the first) is joined correctly", () => {
  const state = createStreamBufferState();
  appendChunkToBuffer(state, Buffer.from("hel"));
  assert.deepEqual(snapshotStreamBuffer(state).lines, []); // nothing materialized yet - still pending
  appendChunkToBuffer(state, Buffer.from("lo\n"));
  assert.deepEqual(snapshotStreamBuffer(state).lines, [
    { text: "hello", terminator: "newline", seq: 1 },
  ]);
});

// --- CRLF handling ---

test("CRLF line endings do not produce a spurious empty line, and strip only the trailing \\r", () => {
  const state = createStreamBufferState();
  appendChunkToBuffer(state, Buffer.from("line one\r\nline two\r\n"));
  assert.deepEqual(
    snapshotStreamBuffer(state).lines.map((l) => l.text),
    ["line one", "line two"]
  );
});

test("a bare \\r not immediately followed by \\n is preserved as ordinary content (only a real CRLF pair is special-cased)", () => {
  const state = createStreamBufferState();
  appendChunkToBuffer(state, Buffer.from("weird\rline\n"));
  assert.deepEqual(snapshotStreamBuffer(state).lines, [
    { text: "weird\rline", terminator: "newline", seq: 1 },
  ]);
});

test("a CRLF pair split exactly across a chunk boundary (\\r in one chunk, \\n in the next) is still handled as one CRLF, not a spurious empty line", () => {
  const state = createStreamBufferState();
  appendChunkToBuffer(state, Buffer.from("line one\r"));
  appendChunkToBuffer(state, Buffer.from("\nline two\n"));
  assert.deepEqual(
    snapshotStreamBuffer(state).lines.map((l) => l.text),
    ["line one", "line two"]
  );
});

// --- Partial final line ---

test("a stream that ends without a trailing newline still surfaces its last line, flagged stream-end, text preserved exactly", () => {
  const state = createStreamBufferState();
  appendChunkToBuffer(state, Buffer.from("complete\nworking..."));
  finalizeStreamBuffer(state);
  const lines = snapshotStreamBuffer(state).lines;
  assert.deepEqual(lines, [
    { text: "complete", terminator: "newline", seq: 1 },
    { text: "working...", terminator: "stream-end", seq: 2 },
  ]);
});

test("finalizeStreamBuffer on a stream with NO pending data adds nothing (never fabricates an empty trailing line)", () => {
  const state = createStreamBufferState();
  appendChunkToBuffer(state, Buffer.from("clean\n"));
  finalizeStreamBuffer(state);
  assert.deepEqual(snapshotStreamBuffer(state).lines, [
    { text: "clean", terminator: "newline", seq: 1 },
  ]);
});

test("finalizeStreamBuffer is idempotent - a second call never re-adds the partial line", () => {
  const state = createStreamBufferState();
  appendChunkToBuffer(state, Buffer.from("partial"));
  finalizeStreamBuffer(state);
  finalizeStreamBuffer(state);
  assert.deepEqual(snapshotStreamBuffer(state).lines, [
    { text: "partial", terminator: "stream-end", seq: 1 },
  ]);
});

// --- Oversized single line ---

// NOTE on these tests' shape: `MAX_LINE_BYTES` and `MAX_BUFFER_BYTES` are
// the SAME 1 MiB constant by design (see jobStore.ts's docs), and a forced
// `oversized-split` entry's on-disk size is that cut PLUS the continuation
// marker's own bytes - so any single such entry, by construction, already
// consumes the ENTIRE per-buffer byte budget on its own. Two of them can
// therefore never coexist in a final snapshot (the second always evicts
// the first, per "retain the newest, drop the oldest" - proven separately
// by the eviction tests below). So "never silently dropped" is proven by
// checking the split entry's presence/marker RIGHT AFTER it is forced
// (before any later entry could evict it), not by expecting two oversized
// pieces to survive together at the end.

test("a single line longer than the 1 MiB cap is force-split mid-line (before any real newline) with an explicit continuation marker - retained, not silently dropped", () => {
  const state = createStreamBufferState();
  const overflow = 500;
  const cappedPrefix = "x".repeat(MAX_LINE_BYTES);
  const remainder = "y".repeat(overflow);
  // No trailing newline yet - still one logical, still-open line.
  appendChunkToBuffer(state, Buffer.from(cappedPrefix + remainder));

  const afterForcedSplit = snapshotStreamBuffer(state);
  assert.equal(
    afterForcedSplit.lines.length,
    1,
    "the forced split must be retained immediately, not dropped"
  );
  assert.equal(afterForcedSplit.lines[0]!.terminator, "oversized-split");
  assert.ok(afterForcedSplit.lines[0]!.text.startsWith(cappedPrefix));
  assert.ok(
    afterForcedSplit.lines[0]!.text.includes("line exceeds 1 MiB, continues"),
    "the split entry must carry an explicit continuation marker"
  );

  // Now genuinely terminate the line - the small remainder becomes the
  // newest, real 'newline' entry; the SAME "retain newest, drop oldest"
  // byte-cap rule that governs the whole buffer (never unique to oversized
  // lines) evicts the earlier ~1 MiB piece to make room, signaled by
  // truncated: true - never a SILENT drop.
  appendChunkToBuffer(state, Buffer.from("\n"));
  const final = snapshotStreamBuffer(state);
  assert.equal(final.truncated, true);
  assert.equal(final.lines.length, 1);
  assert.equal(final.lines[0]!.terminator, "newline");
  assert.equal(final.lines[0]!.text, remainder);
});

test("an oversized line forces MULTIPLE splits within a single appendChunkToBuffer call when one chunk carries more than one cap's worth of data, retaining only the newest segment (never corrupting it)", () => {
  const state = createStreamBufferState();
  // Two distinguishable fill bytes so the SURVIVING segment's origin is verifiable, not just its length.
  const first = Buffer.alloc(MAX_LINE_BYTES, "a".charCodeAt(0));
  const second = Buffer.alloc(MAX_LINE_BYTES + 50, "b".charCodeAt(0)); // itself still over the cap on its own
  appendChunkToBuffer(state, Buffer.concat([first, second])); // no newline anywhere - one giant unterminated line

  const snapshot = snapshotStreamBuffer(state);
  assert.equal(
    snapshot.truncated,
    true,
    "the FIRST forced-split segment (all 'a's) must have been evicted to retain the newest"
  );
  assert.equal(snapshot.lines.length, 1);
  assert.equal(snapshot.lines[0]!.terminator, "oversized-split");
  const marker = "…[line exceeds 1 MiB, continues]";
  const coreText = snapshot.lines[0]!.text.slice(0, snapshot.lines[0]!.text.length - marker.length);
  assert.equal(coreText.length, MAX_LINE_BYTES);
  assert.ok(
    /^b+$/.test(coreText),
    "the retained segment must be entirely the SECOND (newer) fill - never the first, and never corrupted/mixed"
  );
});

// --- Marker byte accounting (an EXPLICIT dedicated case) ---
//
// The `materializeLine` comment already documents WHY the "always retain
// the newest entry" guard exists: "an oversized-split entry's on-disk size
// is the raw MAX_LINE_BYTES-bounded cut PLUS the continuation marker's own
// bytes, so it is BY CONSTRUCTION always slightly over MAX_BUFFER_BYTES" -
// this test makes that claim itself the EXPLICIT subject of its own
// assertion (not just an incidental side effect of the other oversized-
// split tests above), by constructing a core that is EXACTLY at the cap
// (not over it) and proving the marker's own bytes are what push the
// entry over, discriminating a mutant that measured only the core length.

test("marker byte accounting: the OVERSIZED_LINE_MARKER continuation marker's own bytes count toward the accounted byte total, not just the core content", () => {
  const state = createStreamBufferState();
  const marker = "…[line exceeds 1 MiB, continues]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  // MAX_LINE_BYTES + 1 total input bytes forces exactly one split at
  // cutPoint === MAX_LINE_BYTES (pure ASCII, no UTF-8 backtrack) - so the
  // retained CORE piece is exactly MAX_LINE_BYTES bytes: precisely AT the
  // cap, not over it, on its own.
  appendChunkToBuffer(state, Buffer.from("x".repeat(MAX_LINE_BYTES + 1))); // no trailing newline
  const snapshot = snapshotStreamBuffer(state);
  assert.equal(snapshot.lines.length, 1);
  assert.equal(snapshot.lines[0]!.terminator, "oversized-split");

  const entryText = snapshot.lines[0]!.text;
  const coreText = entryText.slice(0, entryText.length - marker.length);
  assert.equal(
    coreText.length,
    MAX_LINE_BYTES,
    "sanity: the retained core piece is exactly MAX_LINE_BYTES characters (pure ASCII, so bytes === characters here)"
  );
  assert.equal(
    Buffer.byteLength(coreText, "utf8"),
    MAX_LINE_BYTES,
    "sanity: the core ALONE is exactly AT the cap, not over it"
  );

  const entryBytes = Buffer.byteLength(entryText, "utf8");
  // The entry's REAL, accounted byte length (what materializeLine adds to
  // state.totalBytes) must be core + marker - proving the marker's own
  // bytes are genuinely part of what's measured against the cap, never
  // silently excluded.
  assert.equal(entryBytes, MAX_LINE_BYTES + markerBytes);
  // Discriminating assertion: it is SPECIFICALLY the marker's own bytes
  // that push this entry over MAX_BUFFER_BYTES - the core alone would be
  // exactly AT the cap (not over it, per the sanity check above), so a
  // mutant that measured only the core (ignoring the marker) would find
  // this entry NOT over cap, and the "always retain the single entry that
  // alone exceeds the cap" exception (jobStore.ts's materializeLine and
  // evictToFitBudget) would then behave differently than observed here.
  assert.ok(
    entryBytes > MAX_BUFFER_BYTES,
    "the marker's own bytes must push this entry OVER the cap - the core alone sits exactly AT it"
  );
});

// --- UTF-8 multi-byte characters split across chunk boundaries ---

test("a 2-byte UTF-8 character split exactly between two chunks decodes correctly, not mangled", () => {
  const state = createStreamBufferState();
  const text = "café done\n"; // 'é' is U+00E9, 2 bytes in UTF-8: 0xC3 0xA9
  const bytes = Buffer.from(text, "utf8");
  const eIndex = bytes.indexOf(0xc3); // the lead byte of 'é'
  appendChunkToBuffer(state, bytes.subarray(0, eIndex + 1)); // ends mid-character, right after the lead byte
  appendChunkToBuffer(state, bytes.subarray(eIndex + 1)); // the rest, starting with the continuation byte
  finalizeStreamBuffer(state);
  assert.deepEqual(snapshotStreamBuffer(state).lines, [
    { text: "café done", terminator: "newline", seq: 1 },
  ]);
});

test("a 4-byte UTF-8 character (an emoji) split byte-by-byte across four separate chunks decodes correctly", () => {
  const state = createStreamBufferState();
  const text = "start 😀 end\n"; // U+1F600, 4 bytes in UTF-8
  const bytes = Buffer.from(text, "utf8");
  for (let i = 0; i < bytes.length; i += 1) {
    appendChunkToBuffer(state, bytes.subarray(i, i + 1)); // one byte at a time, worst case
  }
  finalizeStreamBuffer(state);
  assert.deepEqual(snapshotStreamBuffer(state).lines, [
    { text: "start 😀 end", terminator: "newline", seq: 1 },
  ]);
});

test("findUtf8SafeCutPoint backs off a cut point that would fall mid-character to the start of that character's lead byte", () => {
  const bytes = Buffer.from("aéb", "utf8"); // 'a' (1 byte), 'é' (2 bytes: 0xC3 0xA9), 'b' (1 byte) = 4 bytes total
  assert.equal(findUtf8SafeCutPoint(bytes, 4), 4); // full length - not mid-character
  assert.equal(findUtf8SafeCutPoint(bytes, 2), 1); // offset 2 is the continuation byte of 'é' - back off to 1 (right after 'a')
  assert.equal(findUtf8SafeCutPoint(bytes, 3), 3); // offset 3 is 'é's lead byte boundary end - a real boundary
  assert.equal(findUtf8SafeCutPoint(bytes, 1), 1); // a real boundary already
});

// --- Byte/line cap eviction (retain newest, drop oldest, mark truncated) ---

test("exceeding MAX_BUFFER_LINES evicts the oldest lines first and sets truncated: true", () => {
  const state = createStreamBufferState();
  const totalLines = MAX_BUFFER_LINES + 10;
  for (let i = 0; i < totalLines; i += 1) {
    appendChunkToBuffer(state, Buffer.from(`line-${i}\n`));
  }
  const snapshot = snapshotStreamBuffer(state);
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.lines.length <= MAX_BUFFER_LINES);
  // The newest lines must be retained - the very last line pushed must still be present.
  assert.equal(snapshot.lines[snapshot.lines.length - 1]!.text, `line-${totalLines - 1}`);
  // The oldest lines must have been dropped.
  assert.equal(
    snapshot.lines.some((l) => l.text === "line-0"),
    false
  );
});

test("exceeding MAX_BUFFER_BYTES (even under the line cap) evicts the oldest lines first and sets truncated: true", () => {
  const state = createStreamBufferState();
  const bigLineText = "z".repeat(10_000);
  const linesNeeded = Math.ceil(MAX_BUFFER_BYTES / 10_000) + 5; // comfortably exceeds the byte cap, well under the line cap
  for (let i = 0; i < linesNeeded; i += 1) {
    appendChunkToBuffer(state, Buffer.from(`${bigLineText}-${i}\n`));
  }
  const snapshot = snapshotStreamBuffer(state);
  assert.equal(snapshot.truncated, true);
  assert.ok(
    snapshot.lines.length < linesNeeded,
    "must have evicted at least one line to stay under the byte cap"
  );
  const totalBytes = snapshot.lines.reduce((sum, l) => sum + Buffer.byteLength(l.text, "utf8"), 0);
  assert.ok(totalBytes <= MAX_BUFFER_BYTES);
  assert.equal(
    snapshot.lines[snapshot.lines.length - 1]!.text,
    `${bigLineText}-${linesNeeded - 1}`
  );
});

// ---------------------------------------------------------------------------
// The byte cap accounts for `pending` too - a DEDICATED, INDEPENDENT
// case, never combined with the oversized-line, CRLF, or
// split-UTF-8-chunk tests above, each of which stays its own
// independent case.
// ---------------------------------------------------------------------------

test("a pending (not-yet-terminated) partial counts toward the byte cap alongside a materialized line that alone stayed under cap", () => {
  const state = createStreamBufferState();
  const materializedSize = 600_000;
  const pendingSize = 600_000;

  appendChunkToBuffer(state, Buffer.from("m".repeat(materializedSize) + "\n")); // fully materializes - one real 'newline' line
  const afterMaterialized = snapshotStreamBuffer(state);
  assert.equal(
    afterMaterialized.truncated,
    false,
    "600,000 materialized bytes alone must not trigger eviction"
  );
  assert.equal(afterMaterialized.lines.length, 1);

  appendChunkToBuffer(state, Buffer.from("p".repeat(pendingSize))); // NO trailing newline - stays pending, never materializes
  const afterPending = snapshotStreamBuffer(state);
  // Combined (materialized + pending) is 1,200,000 bytes - genuinely over
  // the 1,048,576 cap. The OLD bug: state.totalBytes ALONE (600,000, from
  // the one materialized line) never reflected pending at all, so eviction
  // never triggered despite 1.2MB genuinely resident for this stream.
  assert.equal(
    afterPending.truncated,
    true,
    "the materialized line must have been evicted to fit pending's growth under the combined cap"
  );
  assert.equal(
    afterPending.lines.length,
    0,
    "the only materialized line (600,000 bytes ALONE, under cap) is fully evictable here - it is NOT the documented 'single entry alone exceeds cap' exception, which only protects a line that is itself over the cap"
  );
  const combinedResidentBytes =
    afterPending.lines.reduce((sum, l) => sum + Buffer.byteLength(l.text, "utf8"), 0) +
    state.pending.length;
  assert.ok(
    combinedResidentBytes <= MAX_BUFFER_BYTES,
    `combined resident bytes (${combinedResidentBytes}) must never exceed MAX_BUFFER_BYTES (${MAX_BUFFER_BYTES})`
  );
  assert.equal(
    state.pending.length,
    pendingSize,
    "pending itself is never evicted or truncated by this mechanism - only materialized lines are ever removed"
  );
});

test("pending growth evicts only as many materialized lines as needed to fit the combined budget - partial, not all-or-nothing", () => {
  const state = createStreamBufferState();
  // Three ~350,004-byte materialized lines (already slightly over cap
  // combined, so materializeLine's own existing eviction trims to the
  // newest 2 - proven below - BEFORE pending ever enters the picture).
  for (let i = 0; i < 3; i += 1) {
    appendChunkToBuffer(state, Buffer.from("x".repeat(350_000) + `-${i}\n`));
  }
  const afterThreeLines = snapshotStreamBuffer(state);
  assert.deepEqual(
    afterThreeLines.lines.map((l) => l.text.slice(-2)),
    ["-1", "-2"],
    "materializeLine's own existing eviction must already have dropped line -0, retaining the newest two"
  );

  // Push pending well past what the currently-retained 2 materialized
  // lines (~700,008 bytes) can coexist with under the cap.
  appendChunkToBuffer(state, Buffer.from("p".repeat(500_000))); // no newline - stays pending
  const final = snapshotStreamBuffer(state);
  assert.equal(final.truncated, true);
  assert.deepEqual(
    final.lines.map((l) => l.text.slice(-2)),
    ["-2"],
    "only the SECOND materialized line (-1) needed evicting - the newest (-2) still fits alongside pending"
  );
  const materializedBytes = final.lines.reduce(
    (sum, l) => sum + Buffer.byteLength(l.text, "utf8"),
    0
  );
  assert.ok(
    materializedBytes + state.pending.length <= MAX_BUFFER_BYTES,
    `combined resident bytes must fit the cap: materialized=${materializedBytes}, pending=${state.pending.length}`
  );
  assert.equal(
    state.pending.length,
    500_000,
    "pending itself is never evicted or truncated by this mechanism"
  );
});

test("a buffer that never exceeds either cap is never marked truncated", () => {
  const state = createStreamBufferState();
  appendChunkToBuffer(state, Buffer.from("a\nb\nc\n"));
  assert.equal(snapshotStreamBuffer(state).truncated, false);
});

// ---------------------------------------------------------------------------
// jobStore-singleton-sharing regression
// ---------------------------------------------------------------------------
//
// Prior coverage above this section only ever unit-tested a STANDALONE
// `new JobStore()` - never proved that `src/tools/run.ts` (and every
// other handler that touches job state) actually reads/writes through the
// SAME `jobStore` singleton this file can import directly. jobStore.ts's
// header comment already documents the real design (a module-level
// singleton export, not a `server.ts`-constructed instance threaded
// through the registry - see its own docs above the `JobStore` class) -
// what these tests add is a real regression that goes red if that design
// were ever violated (e.g. a future refactor that accidentally gives
// `run.ts` its own `new JobStore()`, or duplicates the module via a
// build/packaging mistake).

test("jobStore reached via a second import of the same module specifier is the exact same singleton instance (referential identity)", async () => {
  // Two different consumption points for the SAME singleton: this file's
  // own top-level static import (above), and a fresh dynamic `import()`
  // of the identical specifier performed here. Node's ESM module cache
  // guarantees a single module instantiation per resolved specifier, so
  // these must be `===` - if `jobStore.ts` (or the build) ever changed in
  // a way that caused two separate module instantiations (e.g. a
  // packaging bug producing two copies of dist/jobStore.js content, or a
  // future re-export path resolving to a different file), this would be
  // the first thing to go red.
  const dynamicallyImported = await import("../dist/jobStore.js");
  assert.equal(
    dynamicallyImported.jobStore,
    jobStore,
    "a second import of the same jobStore.js specifier must resolve to the identical singleton instance"
  );
});

test("a job created through run.ts's OWN internal jobStore reference is visible via this file's directly-imported jobStore.get() - proving run.ts and this test share one store, not two compatible-looking ones", () => {
  // run.ts never re-exports jobStore (by design - see its own header:
  // "holds no state of its own, real job/output state lives in
  // src/jobStore.ts's jobStore singleton") - the only way to observe
  // "which jobStore instance did run.ts's handler actually write to" is
  // indirectly, through the job it creates. If run.ts held its own
  // separate JobStore (the exact regression class this guards against),
  // the job it creates would be invisible to this test's directly-
  // imported jobStore.get() - the assertion would find `undefined`
  // instead of a matching record.
  const result = runTool.handler({ command: ["true"], label: "singleton-sharing-check" });
  assert.notEqual(result.isError, true);
  const jobId = (result.structuredContent as Record<string, unknown> | undefined)?.job_id as
    string | undefined;
  assert.equal(typeof jobId, "string");

  const record = jobStore.get(jobId!);
  assert.notEqual(
    record,
    undefined,
    "the job run.ts's handler created must be visible through this test's directly-imported jobStore singleton"
  );
  // Cross-check an INTERNAL-only field (argv) that the public projection
  // returned by the tool call redacts (see toPublicProjection's docs) -
  // this can only be read by genuinely reaching the same internal
  // JobRecord through the same JobStore instance, never by re-deriving it
  // from the public result alone.
  assert.deepEqual(record!.argv, ["true"]);
  assert.equal(record!.label, "singleton-sharing-check");
});

test("end-to-end: a real `run` tools/call driven through a real Client/Server round trip produces a job visible via the directly-imported jobStore.get() - proving the running server and this test's store are genuinely the same instance", async () => {
  // A real SDK Client and a real ghantika Server (via createServer(), the
  // exact production wiring - including the init-gate), linked by
  // the SDK's own InMemoryTransport so both ends live in THIS Node
  // process (a genuinely spawned child process, as test/e2e-server.test.ts
  // uses, runs in a separate OS process with its own memory - a directly-
  // imported jobStore in this test could never observe a spawned child's
  // jobs no matter how correct the singleton design is, so proving this
  // specific property requires staying in-process while still driving the
  // real Client/Server/Protocol dispatch machinery, not a bypass straight
  // to dispatchToolCall).
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const instance = createServer(serverTransport);
  await instance.server.connect(instance.transport);

  const client = new Client({ name: "ghantika-jobstore-singleton-e2e-test", version: "0.0.0" });
  await client.connect(clientTransport); // real initialize request + real notifications/initialized, per the SDK's own Client.connect()

  const callResult = (await client.callTool({
    name: "run",
    arguments: { command: ["true"], label: "e2e-singleton-sharing-check" },
  })) as { isError?: boolean; structuredContent?: Record<string, unknown> };

  assert.notEqual(callResult.isError, true);
  const jobId = callResult.structuredContent?.job_id as string | undefined;
  assert.equal(
    typeof jobId,
    "string",
    `expected a real job_id in the tools/call result, got: ${JSON.stringify(callResult)}`
  );

  const record = jobStore.get(jobId!);
  assert.notEqual(
    record,
    undefined,
    "the job created by a real tools/call, driven through a real Client/Server round trip, must be visible through this test's directly-imported jobStore singleton"
  );
  assert.deepEqual(record!.argv, ["true"]);
  assert.equal(record!.label, "e2e-singleton-sharing-check");

  await client.close();
  await instance.shutdown("test cleanup");
});
