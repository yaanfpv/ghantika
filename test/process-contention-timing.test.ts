/**
 * The subset of test/process.test.ts's own cases whose verdict depends on
 * a real spawned process (`ps`, `pgrep`, or a fixture child) settling
 * within a real wall-clock bound: captureBirthIdentityPosixAsync,
 * readLinuxStartTimeTicksAsync, readPidStartTimesBatchPosix,
 * captureEscalationIdentitySnapshot, and evaluateEscalationIdentityGate.
 * Moved into their own file so a concurrency change to the test runner can
 * be scoped to the files that actually need it, without touching
 * process.test.ts's much larger set of tests that are not timing-sensitive -
 * no assertion, fixture, or behavior changed by the move itself. See
 * process.test.ts's own header for the full suite's scope.
 *
 * The five local helpers below (Recorder/recorder/callbacksFor/waitFor/
 * waitForGroupMemberCount/fastForwardRetryClock) are duplicated from
 * process.test.ts rather than shared via import, matching the same
 * self-contained-file convention test/process-slow-paths.test.ts already
 * uses for its own split of this parent file.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import { buildChildEnv, spawnManaged } from "../dist/process.js";
import {
  ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS,
  ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS,
  type ProcStatAsyncReader,
  captureBirthIdentityPosix,
  captureBirthIdentityPosixAsync,
  captureEscalationIdentitySnapshot,
  evaluateEscalationIdentityGate,
  isProcessAlive,
  readLinuxStartTimeTicksAsync,
  readPidStartTimesBatchPosix,
} from "../dist/process.js";

// Explicit ".ts" extension - this helper has no relative imports of its
// own, so Node's native TypeScript support can load it directly without a
// build step - see test/process.test.ts's identical comment on the same
// pattern.
import { retryBirthIdentityCapture } from "./helpers/birthIdentityRetry.ts";

// Duplicated from process.test.ts - see that file's identical guards for
// the full reasoning (a POSIX-only real ps/pgrep/negative-pid-kill
// primitive with no win32 equivalent path here; a TEST-HARNESS gap, not a
// product scope decision).
const POSIX_PROCESS_GROUP_SKIP =
  process.platform === "win32"
    ? "exercises a real POSIX process-group primitive (ps/pgrep/negative-pid kill) with no win32 equivalent path here"
    : false;
const SHADOWS_PS_LINUX_SKIP =
  process.platform === "win32"
    ? "shadows ps on PATH to test the etime observer's own retry/timeout logic, POSIX-only"
    : process.platform === "linux"
      ? "captureBirthIdentityPosixAsync never shells out to ps on Linux (it reads /proc/<pid>/stat directly) - this fixture cannot exercise anything there"
      : false;
const POSIX_ONLY_SKIP =
  process.platform === "win32" ? "POSIX-only primitive, no win32 equivalent" : false;
const LINUX_ONLY_SKIP = process.platform !== "linux" ? "Linux-only /proc read path" : false;

// ---------------------------------------------------------------------------
// Duplicated helpers (see this file's own header for why duplication, not
// import, matches the sibling process-slow-paths.test.ts convention).
// ---------------------------------------------------------------------------

interface Recorder {
  spawned: number;
  errors: string[];
  exits: Array<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout: Buffer[];
  stderr: Buffer[];
  stdoutEnded: boolean;
  stderrEnded: boolean;
}

function recorder(): Recorder {
  return {
    spawned: 0,
    errors: [],
    exits: [],
    stdout: [],
    stderr: [],
    stdoutEnded: false,
    stderrEnded: false,
  };
}

function callbacksFor(rec: Recorder) {
  return {
    onSpawn: () => {
      rec.spawned += 1;
    },
    onError: (message: string) => {
      rec.errors.push(message);
    },
    onExit: (code: number | null, signal: NodeJS.Signals | null) => {
      rec.exits.push({ code, signal });
    },
    onStdoutChunk: (chunk: Buffer) => {
      rec.stdout.push(chunk);
    },
    onStderrChunk: (chunk: Buffer) => {
      rec.stderr.push(chunk);
    },
    onStdoutEnd: () => {
      rec.stdoutEnded = true;
    },
    onStderrEnd: () => {
      rec.stderrEnded = true;
    },
  };
}

function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor: timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/**
 * Polls a real `pgrep -g <pgid>` count until the process GROUP has at
 * least `minMembers` live members, rather than guessing a fixed delay for
 * real forked descendants to actually land.
 */
async function waitForGroupMemberCount(
  pgid: number,
  minMembers: number,
  timeoutMs = 3000
): Promise<number> {
  const start = Date.now();
  for (;;) {
    let count = 0;
    try {
      const output = execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" });
      count = output.split("\n").filter((line) => line.trim().length > 0).length;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { status?: number };
      if (err.status !== 1) throw error; // pgrep's own "nothing matched" exit code - a real, expected zero-members result
    }
    if (count >= minMembers) return count;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForGroupMemberCount: timed out after ${timeoutMs}ms waiting for pgid ${pgid} to reach >= ${minMembers} members, last saw ${count}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * A virtual retry clock for `readPidStartTimesBatchPosix`'s own not-found
 * retry: `now()` only advances by exactly what `sleep()` was asked to wait,
 * with no real wall-clock component, so a case where the retry budget
 * genuinely exhausts runs through the same number of iterations production
 * would without spending that time for real.
 */
function fastForwardRetryClock() {
  let virtualNow = 0;
  return {
    now: () => virtualNow,
    sleep: async (ms: number) => {
      virtualNow += ms;
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
    },
  };
}

// ---------------------------------------------------------------------------
// Extracted tests
// ---------------------------------------------------------------------------

test(
  "captureBirthIdentityPosixAsync: a successful real capture reads a near-zero elapsed age for a freshly spawned process, same as the sync version (or, on Linux, a well-formed raw start-time tick token)",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const child = spawnManaged(
      { argv: ["sleep", "2"], cwd: process.cwd(), env: buildChildEnv("merge", {}) },
      callbacksFor(recorder())
    );
    const identity = await retryBirthIdentityCapture(
      () => captureBirthIdentityPosixAsync(child!.pid!),
      "captureBirthIdentityPosixAsync"
    );
    assert.notEqual(identity, undefined, "expected a real captured identity");
    if (identity!.platform === "linux-starttime-ticks") {
      // Linux: a raw /proc/<pid>/stat field-22 token, never an elapsed
      // duration - see ProcessBirthIdentity's own docs for why.
      assert.equal(typeof identity!.startTimeTicks, "string");
      assert.match(
        identity!.startTimeTicks,
        /^\d+$/,
        `expected a well-formed non-negative integer string, got ${JSON.stringify(identity!.startTimeTicks)}`
      );
    } else {
      assert.equal(typeof identity!.capturedAtMs, "number");
      assert.ok(
        identity!.elapsedSecondsAtCapture >= 0 && identity!.elapsedSecondsAtCapture < 5,
        `expected a near-zero elapsed age, got ${identity!.elapsedSecondsAtCapture}`
      );
    }
    process.kill(-child!.pid!, "SIGKILL"); // cleanup
  }
);

test(
  "captureBirthIdentityPosixAsync: projects forward to the same real elapsed time an independent SYNC captureBirthIdentityPosix reading observes moments later - proving both are the same genuine external observation, not two different mechanisms (on Linux: the two readings must report the EXACT SAME raw start-time token, since there is nothing to project)",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const child = spawnManaged(
      { argv: ["sleep", "2"], cwd: process.cwd(), env: buildChildEnv("merge", {}) },
      callbacksFor(recorder())
    );
    const asyncIdentity = await retryBirthIdentityCapture(
      () => captureBirthIdentityPosixAsync(child!.pid!),
      "captureBirthIdentityPosixAsync"
    );
    assert.notEqual(asyncIdentity, undefined);
    const syncIdentity = await retryBirthIdentityCapture(
      () => captureBirthIdentityPosix(child!.pid!),
      "captureBirthIdentityPosix"
    );
    assert.notEqual(syncIdentity, undefined);

    if (asyncIdentity!.platform === "linux-starttime-ticks") {
      // Linux: no projection needed or possible - the same real process's
      // start-time ticks are a fixed kernel counter, so two independent
      // reads moments apart must report the EXACT SAME token, never merely
      // a close one (see readLinuxStartTimeTicks's own docs: stable across
      // repeated reads of the same live process).
      assert.equal(
        syncIdentity!.platform,
        "linux-starttime-ticks",
        "both readings of the same real pid must agree on which platform branch captured them"
      );
      if (syncIdentity!.platform === "linux-starttime-ticks") {
        assert.equal(
          syncIdentity!.startTimeTicks,
          asyncIdentity!.startTimeTicks,
          `expected the same real process's start-time ticks to read identically on both an async and a sync capture moments apart - async: ${JSON.stringify(asyncIdentity)}, sync: ${JSON.stringify(syncIdentity)}`
        );
      }
    } else {
      const projected =
        asyncIdentity!.elapsedSecondsAtCapture +
        (syncIdentity!.capturedAtMs - asyncIdentity!.capturedAtMs) / 1000;
      assert.ok(
        Math.abs(projected - syncIdentity!.elapsedSecondsAtCapture) <= 5,
        `expected the async capture to project forward to the same real elapsed time the sync capture just observed - async: ${JSON.stringify(asyncIdentity)}, sync: ${JSON.stringify(syncIdentity)}`
      );
    }
    process.kill(-child!.pid!, "SIGKILL"); // cleanup
  }
);

test(
  "captureBirthIdentityPosixAsync: a genuinely HUNG ps observer is forcibly killed once the bound elapses and resolves to undefined - never left unsettled indefinitely",
  { skip: SHADOWS_PS_LINUX_SKIP },
  async () => {
    const realPath = process.env.PATH;
    // A ps that sleeps far longer (5s) than the short custom timeout this
    // test passes (300ms) - if execFile's own `timeout` option didn't
    // actually SIGTERM this child at the bound, this promise would never
    // settle within any reasonable window and the test would time out
    // instead of completing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-hung-ps-"));
    const psPath = path.join(dir, "ps");
    fs.writeFileSync(psPath, "#!/bin/sh\nsleep 5\necho '00:00'\n");
    fs.chmodSync(psPath, 0o755);

    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    let elapsedMs: number;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      const before = Date.now();
      identity = await captureBirthIdentityPosixAsync(process.pid, 300);
      elapsedMs = Date.now() - before;
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(
      identity,
      undefined,
      "a ps that never answers within the bound must resolve to undefined (unavailable), never fabricate a value"
    );
    assert.ok(
      elapsedMs < 2000,
      `expected the bounded timeout to actually fire well before the ps's own 5s sleep - took ${elapsedMs}ms`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: on Windows, never even attempted - always resolves to undefined there",
  { skip: process.platform !== "win32" ? "Windows-only assertion" : false },
  async () => {
    assert.equal(await captureBirthIdentityPosixAsync(process.pid), undefined);
  }
);

test(
  "captureBirthIdentityPosixAsync: an initial not-found observation retries and succeeds once ps starts answering",
  { skip: SHADOWS_PS_LINUX_SKIP },
  async () => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-notfound-then-found-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    const psPath = path.join(dir, "ps");
    // First invocation reports not-found (exit 1, ps's own documented "no
    // such pid" code); every invocation after that reports found with a
    // real-shaped etime.
    fs.writeFileSync(
      psPath,
      `#!/bin/sh\ncount=$(wc -l < '${invocationMarker}' 2>/dev/null || echo 0)\necho x >> '${invocationMarker}'\nif [ "$count" -eq 0 ]; then\n  exit 1\nfi\necho '00:01'\n`
    );
    fs.chmodSync(psPath, 0o755);

    // A wider bound than the shipped default absorbs real shell fork/exec
    // latency under host contention without flaking; the shipped default
    // itself is exercised separately below.
    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      identity = await captureBirthIdentityPosixAsync(
        process.pid,
        ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS,
        3000,
        20
      );
    } finally {
      process.env.PATH = realPath;
    }

    const invocationCount = fs
      .readFileSync(invocationMarker, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;

    assert.notEqual(
      identity,
      undefined,
      "a not-found observation that later succeeds must retry through to a real captured identity, never give up on the first attempt"
    );
    assert.ok(
      invocationCount >= 2,
      `expected at least 2 real ps invocations (the initial not-found plus the retry that found it), saw ${invocationCount}`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: the SHIPPED DEFAULT not-found retry bound - called with no bound arguments at all - still retries through to a real captured identity",
  { skip: SHADOWS_PS_LINUX_SKIP },
  async () => {
    // Takes NO bound argument at all, so the shipped
    // BIRTH_IDENTITY_NOT_FOUND_RETRY_BOUND_MS default has to be generous
    // enough for this not-found-then-found scenario to succeed.
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-default-bound-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    const psPath = path.join(dir, "ps");
    fs.writeFileSync(
      psPath,
      `#!/bin/sh\ncount=$(wc -l < '${invocationMarker}' 2>/dev/null || echo 0)\necho x >> '${invocationMarker}'\nif [ "$count" -eq 0 ]; then\n  exit 1\nfi\necho '00:01'\n`
    );
    fs.chmodSync(psPath, 0o755);

    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      identity = await captureBirthIdentityPosixAsync(process.pid);
    } finally {
      process.env.PATH = realPath;
    }

    const invocationCount = fs
      .readFileSync(invocationMarker, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;

    assert.notEqual(
      identity,
      undefined,
      "using the real shipped default bound, a not-found observation that later succeeds must still retry through to a real captured identity"
    );
    assert.ok(
      invocationCount >= 2,
      `expected at least 2 real ps invocations (the initial not-found plus the retry that found it), saw ${invocationCount}`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: OWNER 1 - a zero retry budget still performs exactly the initial observation, never a retry",
  { skip: SHADOWS_PS_LINUX_SKIP },
  async () => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-zero-budget-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    const psPath = path.join(dir, "ps");
    fs.writeFileSync(psPath, `#!/bin/sh\necho x >> '${invocationMarker}'\nexit 1\n`);
    fs.chmodSync(psPath, 0o755);

    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      identity = await captureBirthIdentityPosixAsync(
        process.pid,
        ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS,
        0,
        20
      );
    } finally {
      process.env.PATH = realPath;
    }

    const invocationCount = fs
      .readFileSync(invocationMarker, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;

    assert.equal(
      identity,
      undefined,
      "a zero retry budget with a persistent not-found must resolve to undefined"
    );
    assert.equal(
      invocationCount,
      1,
      `a zero retry budget must still perform the initial observation exactly once, never a retry - saw ${invocationCount} invocations`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: OWNER 2 - a retry started before its retry deadline may settle found after that deadline, and is accepted",
  { skip: SHADOWS_PS_LINUX_SKIP },
  async () => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-late-found-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    const psPath = path.join(dir, "ps");
    // First invocation: fast not-found (starts the retry deadline). Second
    // invocation (the retry): starts well before that deadline expires,
    // but only reports found after sleeping past it - a real observer call
    // that resolves late, not a synthetic clock manipulation.
    fs.writeFileSync(
      psPath,
      `#!/bin/sh\ncount=$(wc -l < '${invocationMarker}' 2>/dev/null || echo 0)\necho x >> '${invocationMarker}'\nif [ "$count" -eq 0 ]; then\n  exit 1\nfi\nsleep 0.5\necho '00:01'\n`
    );
    fs.chmodSync(psPath, 0o755);

    const notFoundRetryBoundMs = 200;
    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      identity = await captureBirthIdentityPosixAsync(
        process.pid,
        ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS,
        notFoundRetryBoundMs,
        20
      );
    } finally {
      process.env.PATH = realPath;
    }

    assert.notEqual(
      identity,
      undefined,
      "a retry that started while retry budget remained must have its late-but-valid found result accepted, not discarded for settling after the retry deadline - the aggregate cap, not the retry budget, is what still bounds how late is acceptable"
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: OWNER 3 - a retry whose earliest permitted start is at or after the retry deadline never starts",
  { skip: SHADOWS_PS_LINUX_SKIP },
  async (t) => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-retry-never-starts-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    const psPath = path.join(dir, "ps");
    fs.writeFileSync(psPath, `#!/bin/sh\necho x >> '${invocationMarker}'\nexit 1\n`);
    fs.chmodSync(psPath, 0o755);

    // See the observer-failure test above for why this spies rather than
    // silences. This test's own clock is deliberately built to keep the
    // aggregate check from firing first (see its comment below), which is
    // exactly what makes it the clean site to prove the failure diagnostic
    // names THIS branch specifically, not a coincidental neighbor.
    const errorSpy = t.mock.method(console, "error");

    // A fully synthetic clock (no real Date.now() component, so no wall-clock
    // jitter) whose sleep() advances `now()` to land EXACTLY on the retry
    // deadline (200ms) after the first sleep - the precise ">= retryDeadline"
    // boundary this owner targets, not merely somewhere past it. Landing
    // exactly on the boundary is deliberate: an overshoot would trip the
    // check regardless of whether it uses ">=" or ">", masking an off-by-one
    // weakening of the comparison. Staying at 200 (not near the 3250ms
    // aggregate cap) also keeps the unrelated aggregate check from firing
    // first and masking this owner's own check.
    const retryBoundMs = 200;
    let jumped = false;
    const clock = {
      now: () => (jumped ? retryBoundMs : 0),
      sleep: async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
        jumped = true;
      },
    };

    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      identity = await captureBirthIdentityPosixAsync(
        process.pid,
        ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS,
        retryBoundMs,
        20,
        clock
      );
    } finally {
      process.env.PATH = realPath;
    }

    const invocationCount = fs
      .readFileSync(invocationMarker, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;

    assert.equal(
      identity,
      undefined,
      "a retry deadline already past at the earliest permitted start must resolve to undefined"
    );
    assert.equal(
      invocationCount,
      1,
      `a retry whose start is at/after the retry deadline must never actually start - expected exactly 1 (the initial) invocation, saw ${invocationCount}`
    );
    const branchCalls = errorSpy.mock.calls.filter((call) =>
      String(call.arguments[0]).includes("branch: not-found-retry-closed-on-resume")
    );
    assert.equal(
      branchCalls.length,
      1,
      `expected exactly one diagnostic naming the not-found-retry-closed-on-resume branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: an observer-failure makes exactly ONE attempt and is never retried",
  { skip: SHADOWS_PS_LINUX_SKIP },
  async (t) => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-observer-failure-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    const psPath = path.join(dir, "ps");
    // Exit code 2 (never ps's documented not-found code 1) is a genuine
    // observer failure on every single invocation.
    fs.writeFileSync(psPath, `#!/bin/sh\necho x >> '${invocationMarker}'\nexit 2\n`);
    fs.chmodSync(psPath, 0o755);

    // Spies on the real console.error (calls through by default) rather
    // than silencing it - the failure diagnostic must name this exact
    // branch so a future occurrence is self-diagnosing in a CI log,
    // proving the wiring here rather than merely asserting the doc claims
    // it works.
    const errorSpy = t.mock.method(console, "error");

    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      identity = await captureBirthIdentityPosixAsync(process.pid);
    } finally {
      process.env.PATH = realPath;
    }

    const invocationCount = fs
      .readFileSync(invocationMarker, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;

    assert.equal(identity, undefined, "a genuine observer failure must resolve to undefined");
    assert.equal(
      invocationCount,
      1,
      `an observer-failure must never be retried. Expected exactly 1 invocation, saw ${invocationCount}`
    );
    const branchCalls = errorSpy.mock.calls.filter((call) =>
      String(call.arguments[0]).includes("branch: observer-genuine-failure")
    );
    assert.equal(
      branchCalls.length,
      1,
      `expected exactly one diagnostic naming the observer-genuine-failure branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: repeated not-found outcomes stop at the bounded deadline, never retrying forever",
  { skip: SHADOWS_PS_LINUX_SKIP },
  async () => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-always-notfound-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    const psPath = path.join(dir, "ps");
    // Always reports not-found (exit 1) - never once succeeds. A bound
    // wider than the shipped default absorbs real host contention without
    // flaking.
    fs.writeFileSync(psPath, `#!/bin/sh\necho x >> '${invocationMarker}'\nexit 1\n`);
    fs.chmodSync(psPath, 0o755);

    const boundMs = 3000;
    const pollIntervalMs = 20;
    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    let elapsedMs: number;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      const before = Date.now();
      identity = await captureBirthIdentityPosixAsync(
        process.pid,
        ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS,
        boundMs,
        pollIntervalMs
      );
      elapsedMs = Date.now() - before;
    } finally {
      process.env.PATH = realPath;
    }

    const invocationCount = fs
      .readFileSync(invocationMarker, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;

    assert.equal(
      identity,
      undefined,
      "a capture that never once observes 'found' before the bound elapses must resolve to undefined, never hang or fabricate a value"
    );
    assert.ok(
      invocationCount >= 2,
      `expected multiple real retry attempts within the bound (not a single try), saw ${invocationCount}`
    );
    // At most one more real ps invocation can run past the deadline check
    // (see captureBirthIdentityPosixAsync's own doc comment), so the
    // surplus above boundMs is bounded by one invocation's own latency,
    // not an open-ended margin.
    const perInvocationHostSlownessMarginMs = 1200;
    assert.ok(
      elapsedMs < boundMs + perInvocationHostSlownessMarginMs,
      `expected termination within ~${perInvocationHostSlownessMarginMs}ms of the bound (${boundMs}ms) - took ${elapsedMs}ms`
    );
    // Pacing guard: without this, a busy-spin loop that ignores
    // pollIntervalMs entirely would still satisfy "terminates near the
    // bound" above, just via many more unpaced attempts.
    const maxPlausibleInvocations = Math.ceil(boundMs / pollIntervalMs) * 2;
    assert.ok(
      invocationCount <= maxPlausibleInvocations,
      `expected roughly ${Math.ceil(boundMs / pollIntervalMs)} paced attempts (generously doubled to ${maxPlausibleInvocations} to absorb host slowness), saw ${invocationCount} - a count this high means the ${pollIntervalMs}ms poll interval was not actually honored between attempts`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: OWNER 5 - the aggregate cap force-reaps an observer that is still active when it expires",
  { skip: SHADOWS_PS_LINUX_SKIP },
  async (t) => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-aggregate-active-observer-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    const psPath = path.join(dir, "ps");
    // See the observer-failure test above for why this spies rather than
    // silences. This scenario's own force-reaped observer resolves through
    // readProcessElapsedSecondsAsync's own timeout - the SAME mechanism a
    // genuine hung/broken ps uses - so the diagnostic must actively
    // distinguish "the aggregate budget ran out" from "ps itself failed"
    // rather than reporting whichever branch happens to be mechanically
    // nearest; a real regression here reported this scenario as a bare
    // observer-failure instead.
    const errorSpy = t.mock.method(console, "error");
    // First invocation: writes the marker, then fast not-found. Second
    // invocation (the retry): a real, SIGTERM-resistant ps that sleeps far
    // longer than any bound this test grants it - the aggregate cap, not
    // the observer's own nominal timeout, must be what actually reaps it.
    fs.writeFileSync(
      psPath,
      `#!/bin/sh\ntrap '' TERM\ncount=$(wc -l < '${invocationMarker}' 2>/dev/null || echo 0)\necho x >> '${invocationMarker}'\nif [ "$count" -eq 0 ]; then\n  exit 1\nfi\nsleep 5\necho '00:01'\n`
    );
    fs.chmodSync(psPath, 0o755);

    // A generous real timeoutMs (matching production's own default) gives
    // attempt 1's real fork/exec all the headroom this suite's other tests
    // rely on. The injected clock, not a tiny real bound, is what makes the
    // aggregate window nearly exhausted by the time the retry starts.
    //
    // The clock advances on a CALL COUNT, never on an observation of the
    // marker file: captureBirthIdentityPosixAsync calls `now()` exactly
    // twice before attempt 1's result is known (once at entry to compute
    // `aggregateDeadline`, once at the top of the first loop iteration to
    // compute `remainingAggregate`) - both must read "no time has passed"
    // (0). Every call after that point runs once attempt 1 has already
    // resolved, so from the third call on the clock jumps forward, leaving
    // ~100ms of aggregate budget - enough for the retry to be legitimately
    // started, but too little for the resistant observer's own 5s sleep to
    // ever complete voluntarily. A prior version of this clock inferred
    // "attempt 1 has resolved" from `fs.existsSync` on the fixture's own
    // marker file - reading the outcome of an async subprocess write is
    // itself a race, and calling `now()` is not.
    const timeoutMs = ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS;
    const aggregateDeadline = timeoutMs + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS;
    let nowCalls = 0;
    const clock = {
      now: () => (nowCalls++ < 2 ? 0 : aggregateDeadline - 350),
      sleep: async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20)));
      },
    };

    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    let elapsedMs: number;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      const before = Date.now();
      identity = await captureBirthIdentityPosixAsync(process.pid, timeoutMs, 3000, 20, clock);
      elapsedMs = Date.now() - before;
    } finally {
      process.env.PATH = realPath;
    }

    const invocationCount = fs
      .readFileSync(invocationMarker, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;

    assert.equal(
      invocationCount,
      2,
      `expected the retry to genuinely start (both attempts observed) before the aggregate cap force-reaps it - saw ${invocationCount} invocations`
    );
    assert.equal(
      identity,
      undefined,
      "an observer still active when the aggregate cap expires must be force-reaped and the capture must settle unavailable, never hang or fabricate a value"
    );
    assert.ok(
      elapsedMs < 3000,
      `expected the aggregate cap to force settlement well before the resistant observer's own 5s sleep - took ${elapsedMs}ms`
    );
    const branchCalls = errorSpy.mock.calls.filter((call) =>
      String(call.arguments[0]).includes("branch: aggregate-exhausted-mid-observation")
    );
    assert.equal(
      branchCalls.length,
      1,
      `this scenario resolves through the observer's own timeout mechanism, but the real cause is the aggregate budget running out, not the observer failing on its own merits - expected exactly one diagnostic naming the aggregate-exhausted-mid-observation branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: a genuine observer error under the SAME tight remaining-aggregate-budget shape as the aggregate-cap-force-reap scenario still reports observer-failure, never misclassified as aggregate-exhausted just because the effective timeout happened to be short",
  { skip: SHADOWS_PS_LINUX_SKIP },
  async (t) => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-aggregate-genuine-error-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    const psPath = path.join(dir, "ps");
    // Same two-attempt shape as the aggregate-cap-force-reap scenario
    // above (fast not-found, then a real retry under a tight remaining
    // budget) - but the retry FAILS IMMEDIATELY with a genuine,
    // unexpected exit code rather than hanging. This never reaches
    // readProcessElapsedSecondsAsync's own timeout at all, so that
    // scenario's reclassification must NOT fire here even though the
    // effective timeout was equally short.
    fs.writeFileSync(
      psPath,
      `#!/bin/sh\ncount=$(wc -l < '${invocationMarker}' 2>/dev/null || echo 0)\necho x >> '${invocationMarker}'\nif [ "$count" -eq 0 ]; then\n  exit 1\nfi\nexit 2\n`
    );
    fs.chmodSync(psPath, 0o755);

    const errorSpy = t.mock.method(console, "error");

    // The clock advances on a CALL COUNT, never on an observation of the
    // marker file - see the identical fix and its rationale on the
    // SIGTERM-resistant force-reap scenario above: reading the outcome of
    // an async subprocess write via fs.existsSync is itself a race, and
    // calling now() is not.
    const timeoutMs = ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS;
    const aggregateDeadline = timeoutMs + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS;
    let nowCalls = 0;
    const clock = {
      now: () => (nowCalls++ < 2 ? 0 : aggregateDeadline - 350),
      sleep: async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20)));
      },
    };

    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      await captureBirthIdentityPosixAsync(process.pid, timeoutMs, 3000, 20, clock);
    } finally {
      process.env.PATH = realPath;
    }

    const observerFailureCalls = errorSpy.mock.calls.filter((call) =>
      String(call.arguments[0]).includes("branch: observer-genuine-failure")
    );
    assert.equal(
      observerFailureCalls.length,
      1,
      `a genuine, immediate observer error must stay observer-genuine-failure even under a short effective timeout - got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
    assert.ok(
      !errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("branch: aggregate-exhausted-mid-observation")
      ),
      "a genuine observer error must never be misclassified as aggregate-exhausted-mid-observation merely because the effective timeout happened to be short"
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: an observer cut short mid-observation by the aggregate budget (execFile's OWN cooperative timeout on POSIX; the /proc reader's own external bound on Linux) is still classified as aggregate-exhausted-mid-observation, not observer-genuine-failure - REGRESSION for the platform-neutral timedOut classifier (a prior version matched a POSIX-only string prefix, silently misclassifying every Linux occurrence of this exact scenario)",
  { skip: POSIX_ONLY_SKIP },
  async (t) => {
    const realPath = process.env.PATH;
    const realDegradeMode = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
    const realDegradeMarker = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER;
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ghantika-aggregate-cooperative-timeout-ps-")
    );
    const invocationMarker = path.join(dir, "invocations.txt");
    const errorSpy = t.mock.method(console, "error");

    // Same two-attempt shape on both platforms: attempt 1 reports a real,
    // fast not-found; attempt 2 is set up to never finish on its own, so
    // whichever platform-specific bound fires first (execFile's own
    // cooperative SIGTERM on POSIX, the /proc reader's own external
    // AbortController bound on Linux) is what actually ends it - never a
    // genuine observer error. A regression here once reported this exact
    // scenario as observer-genuine-failure on Linux specifically (see this
    // test's own title), pointing a future fix at the wrong thing when the
    // real cause is the aggregate budget's own arithmetic shortening this
    // attempt's allowance.
    if (process.platform === "linux") {
      process.env.GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER = invocationMarker;
      process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = "not-found-then-hang";
    } else {
      const psPath = path.join(dir, "ps");
      // This fake ps installs NO trap - the ordinary, ungoverned default
      // for a real observer, so execFile's own `timeout` option ends it
      // cooperatively via SIGTERM well before the external force-reap
      // timer ever gets a chance to fire.
      fs.writeFileSync(
        psPath,
        `#!/bin/sh\ncount=$(wc -l < '${invocationMarker}' 2>/dev/null || echo 0)\necho x >> '${invocationMarker}'\nif [ "$count" -eq 0 ]; then\n  exit 1\nfi\nsleep 5\necho '00:01'\n`
      );
      fs.chmodSync(psPath, 0o755);
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
    }

    // Identical clock shape on both platforms: attempt 1 is fast (real
    // not-found), then `now()` jumps forward so only ~100ms of aggregate
    // budget remains for the retry - enough to legitimately start, too
    // little for the resistant second attempt to ever finish on its own,
    // and short enough that whichever platform's own cooperative bound
    // fires does so well before any much-later external/force-reap
    // deadline. The clock advances on a CALL COUNT, never on an
    // observation of the marker file - see the identical fix and its
    // rationale on the SIGTERM-resistant force-reap scenario above:
    // reading the outcome of an async subprocess write via fs.existsSync
    // is itself a race, and calling now() is not.
    const timeoutMs = ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS;
    const aggregateDeadline = timeoutMs + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS;
    let nowCalls = 0;
    const clock = {
      now: () => (nowCalls++ < 2 ? 0 : aggregateDeadline - 350),
      sleep: async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20)));
      },
    };

    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    try {
      identity = await captureBirthIdentityPosixAsync(process.pid, timeoutMs, 3000, 20, clock);
    } finally {
      process.env.PATH = realPath;
      if (realDegradeMode === undefined) delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
      else process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = realDegradeMode;
      if (realDegradeMarker === undefined)
        delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER;
      else process.env.GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER = realDegradeMarker;
    }

    assert.equal(
      identity,
      undefined,
      "an observer cut short mid-observation by the aggregate budget must still settle unavailable, never hang or fabricate a value"
    );
    const misclassified = errorSpy.mock.calls.filter((call) =>
      String(call.arguments[0]).includes("branch: observer-genuine-failure")
    );
    assert.equal(
      misclassified.length,
      0,
      `an observer cut short mid-observation by the aggregate budget must never be misclassified as observer-genuine-failure - that points a future fix at the observer itself when the real cause is the aggregate budget's own arithmetic, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
    const correctlyClassified = errorSpy.mock.calls.filter((call) =>
      String(call.arguments[0]).includes("branch: aggregate-exhausted-mid-observation")
    );
    assert.equal(
      correctlyClassified.length,
      1,
      `expected exactly one diagnostic naming the aggregate-exhausted-mid-observation branch for the cooperative-timeout path, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: a not-found retry budget that is already exhausted the instant it is established (a zero or already-elapsed notFoundRetryBoundMs) settles via not-found-retry-exhausted-first-pass, never attempting a retry",
  { skip: POSIX_ONLY_SKIP },
  async (t) => {
    const realPath = process.env.PATH;
    const realDegradeMode = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
    const realDegradeMarker = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-retry-exhausted-first-pass-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    // A fast, real not-found on the very first attempt - the retry budget
    // is established at exactly that moment, so a zero notFoundRetryBoundMs
    // means it is already spent the instant it exists, before any second
    // attempt could even be considered.
    if (process.platform === "linux") {
      process.env.GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER = invocationMarker;
      process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = "not-found";
    } else {
      const psPath = path.join(dir, "ps");
      fs.writeFileSync(psPath, `#!/bin/sh\necho x >> '${invocationMarker}'\nexit 1\n`);
      fs.chmodSync(psPath, 0o755);
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
    }

    const errorSpy = t.mock.method(console, "error");
    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    try {
      identity = await captureBirthIdentityPosixAsync(
        process.pid,
        ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS,
        0
      );
    } finally {
      process.env.PATH = realPath;
      if (realDegradeMode === undefined) delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
      else process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = realDegradeMode;
      if (realDegradeMarker === undefined)
        delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER;
      else process.env.GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER = realDegradeMarker;
    }

    assert.equal(identity, undefined);
    const invocationCount = fs
      .readFileSync(invocationMarker, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    assert.equal(
      invocationCount,
      1,
      `a retry budget already exhausted the instant it is established must never let a second attempt start - saw ${invocationCount} invocations`
    );
    assert.ok(
      errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("branch: not-found-retry-exhausted-first-pass")
      ),
      `expected a diagnostic naming the not-found-retry-exhausted-first-pass branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: the aggregate budget running out AFTER a not-found result establishes real retry room, but BEFORE the retry's own sleep can begin, settles via aggregate-exhausted-before-sleep - distinct from the retry budget itself ever running out",
  { skip: POSIX_ONLY_SKIP },
  async (t) => {
    const realPath = process.env.PATH;
    const realDegradeMode = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-aggregate-before-sleep-ps-"));
    if (process.platform === "linux") {
      process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = "not-found";
    } else {
      const psPath = path.join(dir, "ps");
      fs.writeFileSync(psPath, "#!/bin/sh\nexit 1\n");
      fs.chmodSync(psPath, 0o755);
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
    }

    // An injected clock, call-count based rather than time-based, since
    // this scenario needs the aggregate deadline to have already passed by
    // the time the post-observation sleep-budget check runs, while the
    // SAME real not-found attempt that just completed still reads as
    // legitimately having started before it. The first two `now()` reads
    // (the aggregate-deadline computation, then the top-of-loop budget
    // check) return 0 so this attempt is allowed to start at all; every
    // read from the third call onward - after the real not-found `ps` call
    // has already returned - jumps past the aggregate deadline, so the
    // retry-budget check (comfortably positive, thanks to a generous
    // notFoundRetryBoundMs) is satisfied but the very next
    // aggregate-budget-for-sleep check is not.
    const timeoutMs = ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS;
    const aggregateDeadline = timeoutMs + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS;
    let calls = 0;
    const clock = {
      now: () => {
        calls += 1;
        return calls <= 2 ? 0 : aggregateDeadline + 50;
      },
      sleep: async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20)));
      },
    };

    const errorSpy = t.mock.method(console, "error");
    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    try {
      identity = await captureBirthIdentityPosixAsync(process.pid, timeoutMs, 3000, 20, clock);
    } finally {
      process.env.PATH = realPath;
      if (realDegradeMode === undefined) delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
      else process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = realDegradeMode;
    }

    assert.equal(identity, undefined);
    assert.ok(
      errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("branch: aggregate-exhausted-before-sleep")
      ),
      `expected a diagnostic naming the aggregate-exhausted-before-sleep branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
    assert.ok(
      !errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("branch: not-found-retry-exhausted-first-pass")
      ),
      "a generous retry budget that was never actually the exhausted resource must not be misreported as the retry budget running out"
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: OWNER 6 - the aggregate cap expiring between attempts (no observer active) settles immediately, with no new observer started",
  { skip: SHADOWS_PS_LINUX_SKIP },
  async (t) => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-aggregate-scheduler-wait-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    const psPath = path.join(dir, "ps");
    fs.writeFileSync(psPath, `#!/bin/sh\necho x >> '${invocationMarker}'\nexit 1\n`);
    fs.chmodSync(psPath, 0o755);

    // See the observer-failure test above for why this spies rather than
    // silences: proves the failure diagnostic names THIS branch
    // (aggregate-exhausted), not just that some undefined settled.
    const errorSpy = t.mock.method(console, "error");

    // A generous real timeoutMs gives attempt 1's real fork/exec the same
    // headroom production uses. The injected clock - not a tiny real bound
    // - is what makes the aggregate window nearly exhausted the moment
    // attempt 1's not-found registers.
    //
    // The clock advances on a CALL COUNT, never on an observation of the
    // marker file (see the sibling "OWNER 5" test above for the full
    // reasoning): captureBirthIdentityPosixAsync calls `now()` exactly
    // twice before attempt 1's result is known, both of which must read
    // "no time has passed" (0); every call after that runs once attempt 1
    // has already resolved, so from the third call on the clock jumps
    // forward to leave only 10ms of aggregate budget. The declared
    // retry-poll delay (500ms) is deliberately far longer than that
    // remaining budget, so the sleep must be capped short of the aggregate
    // deadline - and the very next loop iteration must then settle
    // without ever starting a second observer.
    const timeoutMs = ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS;
    const aggregateDeadline = timeoutMs + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS;
    const declaredRetryDelayMs = 500;
    let nowCalls = 0;
    const clock = {
      now: () => (nowCalls++ < 2 ? 0 : aggregateDeadline - 10),
      sleep: async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20)));
      },
    };

    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      identity = await captureBirthIdentityPosixAsync(
        process.pid,
        timeoutMs,
        3000,
        declaredRetryDelayMs,
        clock
      );
    } finally {
      process.env.PATH = realPath;
    }

    const invocationCount = fs
      .readFileSync(invocationMarker, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;

    assert.equal(
      identity,
      undefined,
      "the aggregate cap expiring while the scheduler is asleep between attempts (no observer active) must settle unavailable"
    );
    assert.equal(
      invocationCount,
      1,
      `no new observer may start once the aggregate cap has expired between attempts - expected exactly 1 (the initial) invocation, saw ${invocationCount}`
    );
    const branchCalls = errorSpy.mock.calls.filter((call) =>
      String(call.arguments[0]).includes("branch: aggregate-exhausted-before-attempt")
    );
    assert.equal(
      branchCalls.length,
      1,
      `expected exactly one diagnostic naming the aggregate-exhausted-before-attempt branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: an injected concurrency-context hook is called and its result reaches the diagnostic, so a failure can reveal what else was running, without this module owning any state of its own (only jobStore.ts may - see logCaptureUndefined's own docs)",
  { skip: POSIX_ONLY_SKIP },
  async (t) => {
    const realPath = process.env.PATH;
    const realDegradeMode = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-concurrency-context-ps-"));
    if (process.platform === "linux") {
      process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = "observer-failure";
    } else {
      const psPath = path.join(dir, "ps");
      fs.writeFileSync(psPath, `#!/bin/sh\nexit 2\n`);
      fs.chmodSync(psPath, 0o755);
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
    }

    const errorSpy = t.mock.method(console, "error");
    let hookCallCount = 0;
    const getConcurrencyContext = () => {
      hookCallCount += 1;
      return "3 job(s) currently tracked in this process";
    };

    try {
      await captureBirthIdentityPosixAsync(
        process.pid,
        undefined,
        undefined,
        undefined,
        undefined,
        getConcurrencyContext
      );
    } finally {
      process.env.PATH = realPath;
      if (realDegradeMode === undefined) delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
      else process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = realDegradeMode;
    }

    assert.equal(
      hookCallCount,
      1,
      "the concurrency-context hook must be called exactly once, at the moment of failure - never on the success path, never more than once"
    );
    const contextCalls = errorSpy.mock.calls.filter((call) =>
      String(call.arguments[0]).includes("3 job(s) currently tracked in this process")
    );
    assert.equal(
      contextCalls.length,
      1,
      `expected the diagnostic to include the injected context verbatim, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: a THROWING concurrency-context hook cannot escape or change the outcome - the capture still settles undefined (never rejects), and the hook's own failure is disclosed in the diagnostic rather than silently swallowed",
  { skip: POSIX_ONLY_SKIP },
  async (t) => {
    const realPath = process.env.PATH;
    const realDegradeMode = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-throwing-concurrency-context-ps-"));
    if (process.platform === "linux") {
      process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = "observer-failure";
    } else {
      const psPath = path.join(dir, "ps");
      fs.writeFileSync(psPath, `#!/bin/sh\nexit 2\n`);
      fs.chmodSync(psPath, 0o755);
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
    }

    const errorSpy = t.mock.method(console, "error");
    const getConcurrencyContext = (): string => {
      throw new Error("context hook failed");
    };

    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    let rejected: unknown;
    try {
      identity = await captureBirthIdentityPosixAsync(
        process.pid,
        undefined,
        undefined,
        undefined,
        undefined,
        getConcurrencyContext
      );
    } catch (error) {
      rejected = error;
    } finally {
      process.env.PATH = realPath;
      if (realDegradeMode === undefined) delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
      else process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = realDegradeMode;
    }

    assert.equal(
      rejected,
      undefined,
      `a throwing optional diagnostic hook must never turn this into a rejection - captureBirthIdentityPosixAsync's whole contract is that it settles undefined on a labelled failure, and a diagnostic callback can never change that; got a rejection: ${String(rejected)}`
    );
    assert.equal(
      identity,
      undefined,
      "the bounded undefined settlement must still happen exactly as it would with no hook at all"
    );
    const branchCalls = errorSpy.mock.calls.filter((call) =>
      String(call.arguments[0]).includes("branch: observer-genuine-failure")
    );
    assert.equal(
      branchCalls.length,
      1,
      `the diagnostic itself must still fire even though its own hook threw, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
    assert.match(
      String(errorSpy.mock.calls[0].arguments[0]),
      /concurrency-context hook threw/,
      "a throwing hook's own failure must be disclosed inline in the diagnostic, not silently dropped"
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: OWNS THE CLASS, not the instance - a hook that throws a value whose OWN Symbol.toPrimitive itself throws still settles undefined, never rejects, because the catch handler performs no coercion of the thrown value at all",
  { skip: POSIX_ONLY_SKIP },
  async (t) => {
    const realPath = process.env.PATH;
    const realDegradeMode = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ghantika-throwing-hook-noncoercible-primitive-ps-")
    );
    if (process.platform === "linux") {
      process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = "observer-failure";
    } else {
      const psPath = path.join(dir, "ps");
      fs.writeFileSync(psPath, `#!/bin/sh\nexit 2\n`);
      fs.chmodSync(psPath, 0o755);
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
    }

    const errorSpy = t.mock.method(console, "error");
    // A legal JS thrown value that is not an Error and cannot be coerced to
    // a string at all - accessing it as a primitive (which is exactly what
    // template-literal interpolation or String() does) throws a SECOND,
    // independent error. Any containment that tries to describe this value
    // - even via `instanceof Error` followed by a fallback `String(...)` -
    // fails here, which is exactly this regression: the fix must perform
    // NO operation on the thrown value, not a smarter one.
    const getConcurrencyContext = (): string => {
      throw {
        [Symbol.toPrimitive]() {
          throw new Error("secondary coercion escaped");
        },
      };
    };

    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    let rejected: unknown;
    try {
      identity = await captureBirthIdentityPosixAsync(
        process.pid,
        undefined,
        undefined,
        undefined,
        undefined,
        getConcurrencyContext
      );
    } catch (error) {
      rejected = error;
    } finally {
      process.env.PATH = realPath;
      if (realDegradeMode === undefined) delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
      else process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = realDegradeMode;
    }

    assert.equal(
      rejected,
      undefined,
      `a hook throwing a non-coercible value must never turn this into a rejection - the whole point of owning the CLASS is that no thrown value, however exotic, can escape; got a rejection: ${String(rejected)}`
    );
    assert.equal(identity, undefined);
    assert.ok(
      errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("concurrency-context hook threw")
      ),
      `expected the diagnostic to still fire and disclose the hook failure even though the thrown value itself cannot be safely described, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: OWNS THE CLASS, not the instance - a hook that throws a value whose OWN toString itself throws still settles undefined, never rejects",
  { skip: POSIX_ONLY_SKIP },
  async (t) => {
    const realPath = process.env.PATH;
    const realDegradeMode = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ghantika-throwing-hook-noncoercible-tostring-ps-")
    );
    if (process.platform === "linux") {
      process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = "observer-failure";
    } else {
      const psPath = path.join(dir, "ps");
      fs.writeFileSync(psPath, `#!/bin/sh\nexit 2\n`);
      fs.chmodSync(psPath, 0o755);
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
    }

    const errorSpy = t.mock.method(console, "error");
    // The sibling shape to the Symbol.toPrimitive case above: a thrown
    // value whose `toString` (rather than `Symbol.toPrimitive`) is what
    // throws on any attempt to stringify it. Both are legal, genuinely
    // different JS coercion paths a `String(...)` call or template-literal
    // interpolation can hit, and owning only one would leave the other
    // exactly as unowned as `throw new Error` alone left this one.
    const getConcurrencyContext = (): string => {
      throw {
        toString() {
          throw new Error("toString coercion escaped");
        },
      };
    };

    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    let rejected: unknown;
    try {
      identity = await captureBirthIdentityPosixAsync(
        process.pid,
        undefined,
        undefined,
        undefined,
        undefined,
        getConcurrencyContext
      );
    } catch (error) {
      rejected = error;
    } finally {
      process.env.PATH = realPath;
      if (realDegradeMode === undefined) delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
      else process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = realDegradeMode;
    }

    assert.equal(
      rejected,
      undefined,
      `a hook throwing a value whose toString itself throws must never turn this into a rejection; got a rejection: ${String(rejected)}`
    );
    assert.equal(identity, undefined);
    assert.ok(
      errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("concurrency-context hook threw")
      ),
      `expected the diagnostic to still fire and disclose the hook failure even though the thrown value's own toString cannot run safely, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
  }
);

test(
  "captureBirthIdentityPosixAsync: omitting the concurrency-context hook is fully supported - the diagnostic still names the branch, just without a context clause",
  { skip: POSIX_ONLY_SKIP },
  async (t) => {
    const realPath = process.env.PATH;
    const realDegradeMode = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-no-concurrency-context-ps-"));
    if (process.platform === "linux") {
      process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = "observer-failure";
    } else {
      const psPath = path.join(dir, "ps");
      fs.writeFileSync(psPath, `#!/bin/sh\nexit 2\n`);
      fs.chmodSync(psPath, 0o755);
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
    }

    const errorSpy = t.mock.method(console, "error");

    try {
      await captureBirthIdentityPosixAsync(process.pid);
    } finally {
      process.env.PATH = realPath;
      if (realDegradeMode === undefined) delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
      else process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = realDegradeMode;
    }

    assert.equal(errorSpy.mock.calls.length, 1);
    assert.match(String(errorSpy.mock.calls[0].arguments[0]), /branch: observer-genuine-failure/);
  }
);

test("retryBirthIdentityCapture: an ASYNC-shaped capture (a real Promise that resolves after a real delay on each attempt) that fails for its first attempts and succeeds on the Nth still resolves - a genuinely separate code path from the sync-shaped case above (a real await, not a no-op one)", async () => {
  const successOnAttempt = 3;
  const fakeIdentity = { capturedAtMs: Date.now(), elapsedSecondsAtCapture: 0 };
  let calls = 0;
  const result = await retryBirthIdentityCapture(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return calls >= successOnAttempt ? fakeIdentity : undefined;
  }, "captureBirthIdentityPosixAsync (fake, async)");
  assert.equal(result, fakeIdentity);
  assert.notEqual(result, undefined);
  assert.equal(calls, successOnAttempt);
});

test("retryBirthIdentityCapture: an ASYNC-shaped capture that ALWAYS resolves undefined still FAILS at the bound, with a diagnostic naming the capture function", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryBirthIdentityCapture(async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return undefined;
      }, "captureBirthIdentityPosixAsync (fake, async, always-undefined)"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /captureBirthIdentityPosixAsync \(fake, async, always-undefined\)/
      );
      return true;
    }
  );
  assert.ok(calls > 1, `expected more than one attempt before giving up - got ${calls}`);
});

test("retryBirthIdentityCapture: an async capture that eventually resolves to a REAL value, but only after its own configured bound has already elapsed, must NOT have that late success accepted - a value arriving after its own deadline is exactly what this retry exists to reject, not a free pass for eventually succeeding", async () => {
  const boundMs = 30;
  const lateResolveDelayMs = 200;
  const fakeIdentity = { capturedAtMs: Date.now(), elapsedSecondsAtCapture: 0 };
  const before = Date.now();
  await assert.rejects(
    () =>
      retryBirthIdentityCapture(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, lateResolveDelayMs));
          return fakeIdentity;
        },
        "captureBirthIdentityPosixAsync (fake, async, late-success)",
        boundMs
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /captureBirthIdentityPosixAsync \(fake, async, late-success\)/,
        "the thrown diagnostic must still name the capture function even when the reason is a per-attempt race timeout, not merely an undefined answer"
      );
      return true;
    }
  );
  const elapsedMs = Date.now() - before;
  assert.ok(
    elapsedMs < lateResolveDelayMs,
    `expected the retry to give up around its own ${boundMs}ms bound rather than wait out the attempt's full ${lateResolveDelayMs}ms settlement time before deciding - got ${elapsedMs}ms, which would mean the late success was allowed to race to completion instead of being cut off`
  );
});

test("retryBirthIdentityCapture: an async capture that resolves to undefined, but only after its own configured bound has already elapsed, makes the retry throw PROMPTLY at that bound - it must never wait out the slow attempt's own settlement time before giving up", async () => {
  const boundMs = 30;
  const lateUndefinedDelayMs = 200;
  const before = Date.now();
  await assert.rejects(
    () =>
      retryBirthIdentityCapture(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, lateUndefinedDelayMs));
          return undefined;
        },
        "captureBirthIdentityPosixAsync (fake, async, slow-undefined)",
        boundMs
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /captureBirthIdentityPosixAsync \(fake, async, slow-undefined\)/);
      return true;
    }
  );
  const elapsedMs = Date.now() - before;
  assert.ok(
    elapsedMs < lateUndefinedDelayMs,
    `expected the retry to give up around its own ${boundMs}ms bound instead of waiting for this attempt's own ${lateUndefinedDelayMs}ms settlement - got ${elapsedMs}ms`
  );
  assert.ok(
    elapsedMs < boundMs + 250,
    `expected the bound to actually be enforced close to its configured value, not merely eventually - got ${elapsedMs}ms for a ${boundMs}ms bound`
  );
});

test("retryBirthIdentityCapture: an async capture whose promise NEVER settles at all (never resolves, never rejects) still fails at, or very near, the configured bound rather than hanging forever - the exact hang this fix exists to close, since the original `await attemptCapture()` at the top of the loop would never return and the deadline check below it would never run", async () => {
  const boundMs = 30;
  let calls = 0;
  const before = Date.now();
  await assert.rejects(
    () =>
      retryBirthIdentityCapture(
        () => {
          calls += 1;
          return new Promise<undefined>(() => {
            // Deliberately never resolves or rejects - models a
            // genuinely hung observer, not merely a slow one.
          });
        },
        "captureBirthIdentityPosixAsync (fake, async, never-settles)",
        boundMs
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /captureBirthIdentityPosixAsync \(fake, async, never-settles\)/);
      return true;
    }
  );
  const elapsedMs = Date.now() - before;
  assert.ok(
    elapsedMs < boundMs + 250,
    `expected the retry to give up close to its own ${boundMs}ms bound rather than hang indefinitely on an attempt that will never settle - got ${elapsedMs}ms`
  );
  assert.ok(calls >= 1, "expected at least one real attempt to have been made before giving up");
});

test("retryBirthIdentityCapture: a losing attempt that times out and THEN, some time after the retry has already thrown its own failure, rejects with a real error - that later rejection must never surface as a process-level unhandledRejection", async () => {
  const boundMs = 30;
  const lateRejectDelayMs = 150;
  let unhandled: unknown;
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled = reason;
  };
  // Same pattern this project already uses for the identical concern in
  // test/integration.test.ts (search that file for "unhandledRejection"):
  // listen for the real process-level event directly around the
  // scenario, rather than trusting "the test didn't crash" as proof.
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await assert.rejects(() =>
      retryBirthIdentityCapture(
        () =>
          new Promise<undefined>((_resolve, reject) => {
            setTimeout(
              () => reject(new Error("late rejection from a losing, already-abandoned attempt")),
              lateRejectDelayMs
            );
          }),
        "captureBirthIdentityPosixAsync (fake, async, loses-then-rejects)",
        boundMs
      )
    );
    // Give the event loop a real, bounded grace window past when the
    // losing attempt's own rejection actually fires.
    await new Promise((resolve) => setTimeout(resolve, lateRejectDelayMs + 200));
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
  assert.equal(
    unhandled,
    undefined,
    `expected no unhandled rejection to surface once the losing attempt's promise eventually rejects, got: ${String(unhandled)}`
  );
});

test("readLinuxStartTimeTicksAsync: a /proc read that never settles is still forced to resolve as an observer-failure within the caller's own bound, never left pending", async () => {
  const neverSettles: ProcStatAsyncReader = () => new Promise(() => {});
  const timeoutMs = 100;
  const before = Date.now();
  const result = await readLinuxStartTimeTicksAsync(process.pid, timeoutMs, neverSettles);
  const elapsedMs = Date.now() - before;

  assert.equal(
    result.status,
    "observer-failure",
    "a /proc/<pid>/stat read that never settles must resolve as an observer-failure once the bound expires, never hang indefinitely - reverting the caller-side race this test guards leaves this promise pending forever"
  );
  if (result.status === "observer-failure") {
    assert.match(
      result.reason,
      /did not settle within 100ms/,
      "the diagnostic must attribute the failure to this exact bound, not a generic/unrelated message"
    );
  }
  assert.ok(
    elapsedMs < 1000,
    `expected the caller-side bound to force settlement close to the ${timeoutMs}ms timeout, not hang - took ${elapsedMs}ms`
  );
});

test("GHANTIKA_TEST_DEGRADE_PROC_READ: every degrade mode degrades a REAL, currently-alive pid's read - none can ever produce found", async () => {
  const realPath = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
  const realMarker = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER;
  try {
    delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER;

    process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = "not-found";
    const notFound = await readLinuxStartTimeTicksAsync(process.pid, 200);
    assert.equal(
      notFound.status,
      "not-found",
      `"not-found" mode must classify a real, alive pid's read as not-found, never found - got ${JSON.stringify(notFound)}`
    );

    process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = "observer-failure";
    const observerFailure = await readLinuxStartTimeTicksAsync(process.pid, 200);
    assert.equal(
      observerFailure.status,
      "observer-failure",
      `"observer-failure" mode must never produce found - got ${JSON.stringify(observerFailure)}`
    );

    process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = "hang";
    const before = Date.now();
    const hung = await readLinuxStartTimeTicksAsync(process.pid, 100);
    const elapsedMs = Date.now() - before;
    assert.equal(
      hung.status,
      "observer-failure",
      `"hang" mode must settle to observer-failure via the caller's own bound, never found - got ${JSON.stringify(hung)}`
    );
    assert.ok(
      elapsedMs < 1000,
      `expected "hang" to settle near its 100ms bound, took ${elapsedMs}ms`
    );

    // "not-found-then-hang" tells its first invocation from a later one by
    // reading this marker file's own line count (no in-memory counter - see
    // countPriorProcStatDegradeInvocations's own docs for why), so this
    // sub-case is the one mode that REQUIRES a real marker to exercise
    // correctly - without one every invocation looks like the first.
    const degradeMarkerDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-degrade-marker-"));
    const degradeMarkerPath = path.join(degradeMarkerDir, "invocations.txt");
    process.env.GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER = degradeMarkerPath;
    process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = "not-found-then-hang";
    const firstAttempt = await readLinuxStartTimeTicksAsync(process.pid, 100);
    assert.equal(
      firstAttempt.status,
      "not-found",
      `"not-found-then-hang" mode's first invocation must be not-found - got ${JSON.stringify(firstAttempt)}`
    );
    const secondAttempt = await readLinuxStartTimeTicksAsync(process.pid, 100);
    assert.equal(
      secondAttempt.status,
      "observer-failure",
      `"not-found-then-hang" mode's second invocation must hang-then-degrade to observer-failure, never found - got ${JSON.stringify(secondAttempt)}`
    );
  } finally {
    if (realPath === undefined) delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
    else process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = realPath;
    if (realMarker === undefined) delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER;
    else process.env.GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER = realMarker;
  }
});

test(
  "GHANTIKA_TEST_DEGRADE_PROC_READ: an unrecognized value is ignored - the real read still runs, still finds a real alive pid",
  { skip: LINUX_ONLY_SKIP },
  async () => {
    const realPath = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
    try {
      process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = "success"; // not a real mode - must not be accepted as one
      const result = await readLinuxStartTimeTicksAsync(process.pid, 200);
      assert.equal(
        result.status,
        "found",
        `an unrecognized value must fall through to the real read (which finds this real, alive pid), not be treated as a degrade mode - got ${JSON.stringify(result)}`
      );
    } finally {
      if (realPath === undefined) delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
      else process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = realPath;
    }
  }
);

test("readPidStartTimesBatchPosix: an empty pids array is a defensive no-op, never shelling out at all", async () => {
  const result = await readPidStartTimesBatchPosix([]);
  assert.deepEqual(result, { status: "ok", rows: [] });
});

test(
  "readPidStartTimesBatchPosix: reads a real, single, freshly-spawned process's own pid+lstart correctly",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;
    const before = Date.now();
    const result = await readPidStartTimesBatchPosix([pid]);
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0]!.pid, pid);
      // A freshly-spawned process's real start time must land within a
      // generous window around "now" - never a stale/fabricated value.
      assert.ok(
        Math.abs(result.rows[0]!.startTimeMs - before) < 15_000,
        `expected a near-now start time, got ${result.rows[0]!.startTimeMs} vs before=${before}`
      );
    }
    process.kill(-pid, "SIGKILL");
  }
);

test(
  "readPidStartTimesBatchPosix: reads MULTIPLE real pids in ONE batched call (a fake ps counts its own invocations to prove this), returning every one's own correct row",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec1 = recorder();
    const rec2 = recorder();
    const env = buildChildEnv("merge", {});
    const child1 = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec1)
    );
    const child2 = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec2)
    );
    await waitFor(() => rec1.spawned > 0 && rec2.spawned > 0);
    const pid1 = child1!.pid!;
    const pid2 = child2!.pid!;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-batch-count-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    const realPsPath = execFileSync("which", ["ps"], { encoding: "utf8" }).trim();
    const wrapperPath = path.join(dir, "ps");
    fs.writeFileSync(
      wrapperPath,
      `#!/bin/sh\necho x >> '${invocationMarker}'\nexec '${realPsPath}' "$@"\n`
    );
    fs.chmodSync(wrapperPath, 0o755);

    const realPath = process.env.PATH;
    let result: Awaited<ReturnType<typeof readPidStartTimesBatchPosix>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      result = await readPidStartTimesBatchPosix([pid1, pid2]);
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      const foundPids = result.rows.map((row) => row.pid).sort((a, b) => a - b);
      assert.deepEqual(
        foundPids,
        [pid1, pid2].sort((a, b) => a - b)
      );
    }
    const invocationCount = fs
      .readFileSync(invocationMarker, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    assert.equal(
      invocationCount,
      1,
      `expected exactly ONE real ps invocation for both pids (call count must stay independent of group size), saw ${invocationCount}`
    );

    process.kill(-pid1, "SIGKILL");
    process.kill(-pid2, "SIGKILL");
  }
);

test(
  "readPidStartTimesBatchPosix: a mix of one alive and one already-gone pid returns ONLY the alive one's row, ok - never an error for the merely-absent one",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;

    // A genuinely dead-but-plausible pid: spawn and let it actually exit and
    // be reaped, so its pid is a real, in-range, but no-longer-live value -
    // never an out-of-range synthetic pid `ps` itself would reject outright.
    const shortRec = recorder();
    const shortChild = spawnManaged(
      { argv: ["true"], cwd: process.cwd(), env },
      callbacksFor(shortRec)
    );
    await waitFor(() => shortRec.exits.length > 0);
    const deadPid = shortChild!.pid!;

    // The dead pid is genuinely, permanently absent, so it exhausts the
    // full not-found retry window on every real attempt - a virtual clock
    // keeps this deterministic-but-fast rather than adding a real ~1s wait
    // for a result that was never going to change.
    const result = await readPidStartTimesBatchPosix(
      [pid, deadPid],
      undefined,
      fastForwardRetryClock()
    );
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0]!.pid, pid);
    }
    process.kill(-pid, "SIGKILL");
  }
);

test("readPidStartTimesBatchPosix: when NONE of the requested pids exist, resolves ok with genuinely empty rows (ps's own exit-1 'nothing matched' code), never an observer failure", async () => {
  // Neither pid will ever be found, so this exhausts the full retry window -
  // a virtual clock avoids a real ~1s wait for that.
  const result = await readPidStartTimesBatchPosix(
    [88_888_881, 88_888_882],
    undefined,
    fastForwardRetryClock()
  );
  assert.deepEqual(result, { status: "ok", rows: [] });
});

test("readPidStartTimesBatchPosix: a real execution failure (missing ps binary) reports observer-failure, never a false 'ok', and logs it under the exec-failure branch specifically", (t) => {
  const errorSpy = t.mock.method(console, "error");
  const realPath = process.env.PATH;
  process.env.PATH = "/tmp/does-not-exist-ghantika-empty-path-dir-3";
  return readPidStartTimesBatchPosix([12345]).then((result) => {
    process.env.PATH = realPath;
    assert.equal(result.status, "observer-failure");
    assert.ok(
      errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("branch: exec-failure")
      ),
      `expected a diagnostic naming the exec-failure branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
  });
});

test(
  "readPidStartTimesBatchPosix: an observer that never settles is force-reaped once its bound elapses, resolving observer-failure under the timeout branch specifically - distinct from exec-failure",
  { skip: process.platform === "win32" ? "shadows ps on PATH, POSIX-only" : false },
  async (t) => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-batch-read-timeout-ps-"));
    const psPath = path.join(dir, "ps");
    // SIGTERM-resistant, so this genuinely reaches the external force-reap
    // bound rather than settling cooperatively - the reliable, established
    // pattern this file already uses for the equivalent distinction in
    // readProcessElapsedSecondsAsync above.
    fs.writeFileSync(psPath, "#!/bin/sh\ntrap '' TERM\nsleep 5\n");
    fs.chmodSync(psPath, 0o755);

    const errorSpy = t.mock.method(console, "error");
    let result: Awaited<ReturnType<typeof readPidStartTimesBatchPosix>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      result = await readPidStartTimesBatchPosix([process.pid], 100);
    } finally {
      process.env.PATH = realPath;
    }
    assert.equal(result.status, "observer-failure");
    assert.ok(
      errorSpy.mock.calls.some((call) => String(call.arguments[0]).includes("branch: timeout")),
      `expected a diagnostic naming the timeout branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
    assert.ok(
      !errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("branch: exec-failure")
      ),
      "a force-reaped, unresponsive observer must never be misreported under the exec-failure branch"
    );
  }
);

test(
  "readPidStartTimesBatchPosix: a mix of one well-formed row and one malformed row keeps the well-formed one - a malformed row is discarded, never poisoning the others",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-malformed-ps-"));
    const fakePsPath = path.join(dir, "ps");
    // Emits one genuinely well-formed row for the real pid, plus one
    // deliberately malformed row (missing the year token) for a synthetic
    // second pid - a real ps would never produce this shape; this
    // simulates it directly to prove malformed-row handling.
    fs.writeFileSync(
      fakePsPath,
      `#!/bin/sh\necho '${pid} Sat Jul 25 13:39:12 2026'\necho '999999 Sat Jul 25 13:39:12'\n`
    );
    fs.chmodSync(fakePsPath, 0o755);

    const realPath = process.env.PATH;
    let result: Awaited<ReturnType<typeof readPidStartTimesBatchPosix>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      // A real, finite, generous 30_000ms observer timeout. This test's own
      // subject is the full spawn -> observe -> parse PIPELINE: that a real
      // readPidStartTimesBatchPosix call correctly wires a malformed row
      // through to being discarded, not just that the parser itself works
      // in isolation. The fake `ps` here does nothing but echo two lines,
      // so its real cost is the host's fork/exec scheduling latency, not
      // any work of substance.
      //
      // This bound does NOT make the row-parsing assertion itself
      // timing-independent - it is still a real execFile timeout racing
      // real host latency, and a sufficiently slow host CAN in principle
      // still resolve to `observer-failure` before parsing ever runs, just
      // far less often than under the previous 2000ms default. The
      // row-parsing assertion in THIS test remains timing-dependent on
      // that bound. What makes the parsing assertion timing-independent is
      // the pure `parseLstartBatchOutput` test immediately above, which
      // calls the row-parsing-and-discard logic directly on a hand-crafted
      // string with zero spawn, zero real `ps`, and zero timeout of any
      // kind. This integration test's real-pipeline behavior is layered ON
      // TOP of that pure logic, not a substitute for it.
      //
      // 999_999's row is malformed and therefore discarded by
      // parseLstartBatchOutput on EVERY attempt - it never resolves, so
      // this exhausts the not-found retry window same as the alive/
      // already-gone and all-nonexistent-pids tests above; a virtual clock
      // avoids the real ~1s wait for a result that was never going to
      // change.
      result = await readPidStartTimesBatchPosix([pid, 999_999], 30_000, fastForwardRetryClock());
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.rows.length, 1, "expected only the well-formed row to survive");
      assert.equal(result.rows[0]!.pid, pid);
    }
    process.kill(-pid, "SIGKILL");
  }
);

test(
  "readPidStartTimesBatchPosix: a transient not-found observation for the whole batch retries and recovers once ps starts answering",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;

    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-batch-notfound-then-found-ps-"));
    const invocationMarker = path.join(dir, "invocations.txt");
    const psPath = path.join(dir, "ps");
    // Mirrors the SAME first-not-found-then-found idiom the single-pid
    // retry's own tests above use, adapted to the batch invocation shape.
    fs.writeFileSync(
      psPath,
      `#!/bin/sh\ncount=$(wc -l < '${invocationMarker}' 2>/dev/null || echo 0)\necho x >> '${invocationMarker}'\nif [ "$count" -eq 0 ]; then\n  exit 1\nfi\necho '${pid} Sat Jul 25 13:39:12 2026'\n`
    );
    fs.chmodSync(psPath, 0o755);

    let result: Awaited<ReturnType<typeof readPidStartTimesBatchPosix>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      result = await readPidStartTimesBatchPosix([pid], undefined, fastForwardRetryClock());
    } finally {
      process.env.PATH = realPath;
    }

    const invocationCount = fs
      .readFileSync(invocationMarker, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;

    assert.equal(result.status, "ok", "a transient miss must never settle as observer-failure");
    if (result.status === "ok") {
      assert.equal(result.rows.length, 1, "the retry must recover the requested pid's row");
      assert.equal(result.rows[0]!.pid, pid);
    }
    assert.ok(
      invocationCount >= 2,
      `expected at least 2 real ps invocations (the initial not-found plus the retry that found it), saw ${invocationCount}`
    );

    process.kill(-pid, "SIGKILL");
  }
);

test("readPidStartTimesBatchPosix: the not-found retry is capped by the caller's OWN aggregate timeoutMs+grace when that is smaller than the shared retry-scheduling bound", async () => {
  const realPath = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-batch-aggregate-cap-ps-"));
  const invocationMarker = path.join(dir, "invocations.txt");
  const psPath = path.join(dir, "ps");
  // Never finds anything - the point is to prove the loop stops on the
  // AGGREGATE cap alone, before the much larger shared not-found
  // retry-scheduling bound (1000ms) would ever end it.
  fs.writeFileSync(psPath, `#!/bin/sh\necho x >> '${invocationMarker}'\nexit 1\n`);
  fs.chmodSync(psPath, 0o755);

  // timeoutMs is the LARGEST value that still keeps the aggregate
  // deadline (timeoutMs + grace) strictly below the shared
  // BIRTH_IDENTITY_NOT_FOUND_RETRY_BOUND_MS (1000ms) - the exact
  // "smaller than the shared retry-scheduling bound" case this test's
  // own title claims - while leaving headroom for the one real `ps`
  // spawn this test performs, since a freshly-written script pays real
  // one-time exec overhead on its first invocation. The injected clock
  // steps through fixed values on each sleep() call rather than
  // advancing in real time, so the aggregate boundary itself is landed
  // on deterministically.
  const timeoutMs = 749;
  const aggregateMs = timeoutMs + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS; // 999ms
  // aggregateMs - 49 trips the aggregate deadline (its own 250ms
  // settlement grace makes 749ms the threshold) while sitting below the
  // shared 1000ms retry-scheduling bound - the one clock value where the
  // two guards can disagree, which is what makes this test discriminate
  // between them rather than merely landing after both have expired.
  const clockValues = [0, aggregateMs - 49, aggregateMs];
  let callCount = 0;
  const steppedClock = {
    now: () => clockValues[Math.min(callCount, clockValues.length - 1)]!,
    sleep: async (ms: number) => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
    },
  };

  let result: Awaited<ReturnType<typeof readPidStartTimesBatchPosix>>;
  try {
    process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
    result = await readPidStartTimesBatchPosix([99_999_991], timeoutMs, steppedClock);
  } finally {
    process.env.PATH = realPath;
  }

  assert.deepEqual(
    result,
    { status: "ok", rows: [] },
    "a persistently-missing pid still settles ok with empty rows, exactly as before this fix - the aggregate cap only bounds HOW LONG retrying continues, never the final answer's shape"
  );

  const invocationCount = fs
    .readFileSync(invocationMarker, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
  // Exactly ONE real `ps` invocation: the first attempt's not-found
  // result starts the retry window (deadline at 1000ms), the injected
  // clock then steps to 950ms - past the 999ms aggregate deadline's own
  // 749ms threshold, but still short of that 1000ms retry-scheduling
  // deadline - and the SECOND iteration's own aggregate check ends the
  // loop before a second real `ps` call is ever attempted. Because the
  // retry-scheduling bound has NOT yet been reached at that same clock
  // value, only the aggregate guard can be responsible for stopping
  // this: without it, the second iteration would fall through to
  // computing its own effective per-call timeout from a negative
  // remaining-aggregate budget, which throws rather than settling `ok`.
  assert.equal(
    invocationCount,
    1,
    `expected exactly ONE real ps invocation - the 999ms aggregate deadline (749ms timeoutMs + 250ms grace, below the shared 1000ms not-found bound) must end retrying before a second real call, saw ${invocationCount}`
  );
});

test(
  "captureEscalationIdentitySnapshot: a real, single-process group (no descendants) captures exactly the leader's own pid+start time",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;
    const snapshot = await captureEscalationIdentitySnapshot(pid);
    assert.equal(snapshot.degraded, false);
    assert.equal(snapshot.members.length, 1);
    assert.equal(snapshot.members[0]!.pid, pid);
    process.kill(-pid, "SIGKILL");
  }
);

test(
  "captureEscalationIdentitySnapshot: a real group with descendants captures the leader PLUS every live descendant",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["bash", "-c", "sleep 30 & sleep 30 & wait"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const leaderPid = child!.pid!;
    // Let the two descendants actually fork before snapshotting.
    await waitForGroupMemberCount(leaderPid, 3);
    const snapshot = await captureEscalationIdentitySnapshot(leaderPid);
    assert.equal(snapshot.degraded, false);
    assert.ok(
      snapshot.members.length >= 3,
      `expected the leader plus 2 descendants (>= 3 members), got ${snapshot.members.length}`
    );
    assert.ok(snapshot.members.some((member) => member.pid === leaderPid));
    process.kill(-leaderPid, "SIGKILL");
  }
);

test(
  "captureEscalationIdentitySnapshot: PRE-SNAPSHOT NEGATIVE - the initial leader read timing out degrades the WHOLE snapshot to zero usable members",
  {
    skip: process.platform === "win32" ? "shadows a slow ps on PATH, POSIX-only" : false,
  },
  async (t) => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-leader-hang-ps-"));
    const psPath = path.join(dir, "ps");
    // Hangs unconditionally regardless of which pid(s) it was asked about -
    // this is specifically "the initial leader read" (the very first
    // observer call the snapshot phase makes).
    fs.writeFileSync(psPath, "#!/bin/sh\ntrap '' TERM\nsleep 5\n");
    fs.chmodSync(psPath, 0o755);

    const errorSpy = t.mock.method(console, "error");
    let snapshot: Awaited<ReturnType<typeof captureEscalationIdentitySnapshot>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      snapshot = await captureEscalationIdentitySnapshot(999_111, 300);
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(snapshot.degraded, true);
    assert.equal(snapshot.members.length, 0);
    assert.match(snapshot.degradedReason ?? "", /leader/i);
    assert.ok(
      errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("branch: leader-read-observer-failure")
      ),
      `expected a diagnostic naming the leader-read-observer-failure branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
  }
);

test(
  "captureEscalationIdentitySnapshot: PRE-SNAPSHOT NEGATIVE - member enumeration (pgrep) timing out degrades the WHOLE snapshot, even though the leader's own read would otherwise have succeeded",
  {
    skip: process.platform === "win32" ? "shadows a slow pgrep on PATH, POSIX-only" : false,
  },
  async (t) => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;

    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-enum-hang-pgrep-"));
    const pgrepPath = path.join(dir, "pgrep");
    fs.writeFileSync(pgrepPath, "#!/bin/sh\ntrap '' TERM\nsleep 5\n");
    fs.chmodSync(pgrepPath, 0o755);

    const errorSpy = t.mock.method(console, "error");
    let snapshot: Awaited<ReturnType<typeof captureEscalationIdentitySnapshot>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      snapshot = await captureEscalationIdentitySnapshot(pid, 300);
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(
      snapshot.degraded,
      true,
      "expected the whole snapshot to degrade, even though the leader's own read alone would have succeeded"
    );
    assert.match(snapshot.degradedReason ?? "", /enumeration/i);
    assert.ok(
      errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("branch: enumeration-observer-failure")
      ),
      `expected a diagnostic naming the enumeration-observer-failure branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
    process.kill(-pid, "SIGKILL");
  }
);

test(
  "captureEscalationIdentitySnapshot: PRE-SNAPSHOT NEGATIVE - malformed pgrep enumeration output degrades the whole snapshot rather than guessing at a partial member list",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;

    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-malformed-pgrep-"));
    const pgrepPath = path.join(dir, "pgrep");
    fs.writeFileSync(pgrepPath, "#!/bin/sh\necho 'not-a-pid'\n");
    fs.chmodSync(pgrepPath, 0o755);

    let snapshot: Awaited<ReturnType<typeof captureEscalationIdentitySnapshot>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      snapshot = await captureEscalationIdentitySnapshot(pid, 300);
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(snapshot.degraded, true);
    process.kill(-pid, "SIGKILL");
  }
);

test(
  "captureEscalationIdentitySnapshot: PRE-SNAPSHOT NEGATIVE - zero usable records when the leader has ALREADY exited by snapshot time (no observer failure at all, just genuinely nothing there)",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async (t) => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged({ argv: ["true"], cwd: process.cwd(), env }, callbacksFor(rec));
    await waitFor(() => rec.exits.length > 0);
    const pid = child!.pid!;
    const errorSpy = t.mock.method(console, "error");
    const snapshot = await captureEscalationIdentitySnapshot(pid);
    assert.equal(snapshot.degraded, true);
    assert.equal(snapshot.members.length, 0);
    assert.match(snapshot.degradedReason ?? "", /zero usable/i);
    assert.ok(
      errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("branch: zero-usable-records")
      ),
      `expected a diagnostic naming the zero-usable-records branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
  }
);

test(
  "captureEscalationIdentitySnapshot: a zero (or already-elapsed) timeoutMs exhausts the budget before the initial leader read can even be attempted",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async (t) => {
    const errorSpy = t.mock.method(console, "error");
    // timeoutMs=0 makes the deadline equal to entry time itself - the real
    // clock can only be equal to or later than that by the time the first
    // budget check runs, so this settles deterministically regardless of
    // host speed, with no injected clock needed. The pid is never actually
    // read, so any real (or nonexistent) pid works.
    const snapshot = await captureEscalationIdentitySnapshot(process.pid, 0);
    assert.equal(snapshot.degraded, true);
    assert.equal(snapshot.members.length, 0);
    assert.ok(
      errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("branch: leader-read-budget-exhausted")
      ),
      `expected a diagnostic naming the leader-read-budget-exhausted branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
  }
);

test(
  "captureEscalationIdentitySnapshot: the shared budget running out AFTER a successful leader read, but BEFORE member enumeration can be attempted, degrades via enumeration-budget-exhausted - never misreported as an enumeration observer failure",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async (t) => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;

    // An injected clock (this function's own testability seam - see its
    // docs) rather than a real sleep race: real elapsed time between the
    // leader read finishing and the next budget check is host-speed
    // dependent and could go either way, exactly the flakiness class this
    // codebase's own injectable-clock pattern exists to rule out. The first
    // two `now()` reads (entry's deadline computation, then the leader
    // step's own budget check) return 0 so the real leader read is allowed
    // to run and genuinely succeed; every read from the third call onward
    // jumps past the deadline, so by the time enumeration's own budget
    // check runs, the shared budget reads as already exhausted.
    const timeoutMs = 2000;
    let calls = 0;
    const now = () => {
      calls += 1;
      return calls <= 2 ? 0 : timeoutMs + 500;
    };

    const errorSpy = t.mock.method(console, "error");
    const snapshot = await captureEscalationIdentitySnapshot(pid, timeoutMs, now);
    assert.equal(snapshot.degraded, true);
    assert.ok(
      snapshot.members.length === 0 || snapshot.members.some((m) => m.pid === pid),
      "the leader read itself genuinely succeeded before the budget ran out - a captured leader record, if any, must be the real leader"
    );
    assert.ok(
      errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("branch: enumeration-budget-exhausted")
      ),
      `expected a diagnostic naming the enumeration-budget-exhausted branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
    assert.ok(
      !errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("branch: enumeration-observer-failure")
      ),
      "a budget that ran out before enumeration could even start must never be reported as if enumeration's own observer had failed"
    );
    process.kill(-pid, "SIGKILL");
  }
);

test(
  "captureEscalationIdentitySnapshot: the shared budget running out AFTER a successful leader read AND enumeration, but BEFORE the descendant start-time batch read can be attempted, degrades via descendant-read-budget-exhausted",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async (t) => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["bash", "-c", "sleep 30 & sleep 30 & wait"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const leaderPid = child!.pid!;
    // Let the two descendants actually fork before snapshotting, exactly
    // as the real-group-with-descendants test above does.
    await waitForGroupMemberCount(leaderPid, 3);

    // Same injected-clock technique as the enumeration-budget test above,
    // one step later: the first THREE `now()` reads (entry, the leader
    // step's budget check, the enumeration step's budget check) return 0
    // so both the real leader read AND real enumeration succeed and
    // discover the two real descendants; every read from the fourth call
    // onward jumps past the deadline, so the descendant batch read's own
    // budget check - reached only because descendantPids.length > 0 - sees
    // the shared budget as already exhausted.
    const timeoutMs = 2000;
    let calls = 0;
    const now = () => {
      calls += 1;
      return calls <= 3 ? 0 : timeoutMs + 500;
    };

    const errorSpy = t.mock.method(console, "error");
    const snapshot = await captureEscalationIdentitySnapshot(leaderPid, timeoutMs, now);
    assert.equal(snapshot.degraded, true);
    assert.ok(
      errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("branch: descendant-read-budget-exhausted")
      ),
      `expected a diagnostic naming the descendant-read-budget-exhausted branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
    process.kill(-leaderPid, "SIGKILL");
  }
);

test(
  "evaluateEscalationIdentityGate: THE HAPPY PATH - a real member with an exactly-matching current start time escalates",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;
    const snapshot = await captureEscalationIdentitySnapshot(pid);
    assert.equal(snapshot.degraded, false);
    const gate = await evaluateEscalationIdentityGate(snapshot);
    assert.deepEqual(gate, { action: "escalate" });
    process.kill(-pid, "SIGKILL");
  }
);

test("evaluateEscalationIdentityGate: a degraded snapshot (zero members) always refuses, regardless of what the escalation-time re-read would find", async () => {
  const gate = await evaluateEscalationIdentityGate({
    members: [],
    degraded: true,
    degradedReason: "test-injected degradation",
  });
  assert.equal(gate.action, "refuse");
});

test(
  "evaluateEscalationIdentityGate: NEGATIVE - every recorded member is gone at re-read - REFUSES, no positive match possible",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;
    const snapshot = await captureEscalationIdentitySnapshot(pid);
    assert.equal(snapshot.degraded, false);
    process.kill(-pid, "SIGKILL");
    await waitFor(() => isProcessAlive(pid) === false);
    const gate = await evaluateEscalationIdentityGate(snapshot);
    assert.equal(gate.action, "refuse");
  }
);

test("evaluateEscalationIdentityGate: NEGATIVE - a recorded pid is still present but its start time DIFFERS from the record (the recycled-pid simulation) - REFUSES", async () => {
  // Uses this process's own real, currently-alive pid, but with a
  // deliberately WRONG recorded start time - simulating exactly what a
  // stale, post-reuse bookkeeping record would look like.
  const snapshot = {
    members: [{ pid: process.pid, startTimeMs: Date.UTC(2000, 0, 1, 0, 0, 0) }],
    degraded: false,
  };
  const gate = await evaluateEscalationIdentityGate(snapshot);
  assert.equal(gate.action, "refuse");
});

test(
  "evaluateEscalationIdentityGate: a legitimately disappeared member is NOT a failure - with one other original still matching exactly, escalation proceeds",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    // The leader backgrounds the child, `wait`s on that ONE specific pid
    // (so the child is genuinely reaped rather than left a <defunct>
    // zombie once killed - a zombie's pid stays "alive" to a plain
    // `kill(pid, 0)` probe until its parent reaps it, which would hang
    // this test's own liveness wait forever), THEN runs its own
    // independent, long-running sleep - so the leader stays genuinely
    // alive and unaffected once the child is killed, rather than exiting
    // the instant a blind `wait` (with no target) would have returned.
    const child = spawnManaged(
      {
        argv: [
          "bash",
          "-c",
          'sleep 30 & CPID=$!; echo "CHILD_PID:$CPID"; wait "$CPID" 2>/dev/null; sleep 30',
        ],
        cwd: process.cwd(),
        env,
      },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    await waitFor(() => Buffer.concat(rec.stdout).toString("utf8").includes("CHILD_PID:"));
    const leaderPid = child!.pid!;
    const childPid = Number(
      Buffer.concat(rec.stdout)
        .toString("utf8")
        .match(/CHILD_PID:(\d+)/)![1]
    );

    const snapshot = await captureEscalationIdentitySnapshot(leaderPid);
    assert.equal(snapshot.degraded, false);
    assert.ok(snapshot.members.some((member) => member.pid === childPid));

    // The descendant legitimately disappears on its own - not a failure,
    // just the normal case a positive match elsewhere must still cover.
    process.kill(childPid, "SIGKILL");
    await waitFor(() => isProcessAlive(childPid) === false);

    const gate = await evaluateEscalationIdentityGate(snapshot);
    assert.deepEqual(
      gate,
      { action: "escalate" },
      "expected the still-alive, still-matching leader to be sufficient proof, despite the descendant's own legitimate disappearance"
    );
    process.kill(-leaderPid, "SIGKILL");
  }
);

test(
  "evaluateEscalationIdentityGate: ANY-ONE sufficiency - a group of many descendants where only a SINGLE one still matches still escalates (never requires full-set survival)",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      {
        argv: [
          "bash",
          "-c",
          'sleep 30 & echo "P1:$!"; sleep 30 & echo "P2:$!"; sleep 30 & echo "P3:$!"; wait',
        ],
        cwd: process.cwd(),
        env,
      },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    await waitFor(() => {
      const out = Buffer.concat(rec.stdout).toString("utf8");
      return out.includes("P1:") && out.includes("P2:") && out.includes("P3:");
    });
    const leaderPid = child!.pid!;
    const out = Buffer.concat(rec.stdout).toString("utf8");
    const p1 = Number(out.match(/P1:(\d+)/)![1]);
    const p2 = Number(out.match(/P2:(\d+)/)![1]);

    const snapshot = await captureEscalationIdentitySnapshot(leaderPid);
    assert.equal(snapshot.degraded, false);
    assert.ok(
      snapshot.members.length >= 4,
      `expected the leader plus 3 descendants recorded, got ${snapshot.members.length}`
    );

    // Kill the LEADER and two of the three descendants - only ONE
    // descendant (p2) survives to prove the group's identity.
    process.kill(leaderPid, "SIGKILL");
    process.kill(p1, "SIGKILL");
    await waitFor(() => isProcessAlive(leaderPid) === false && isProcessAlive(p1) === false);

    const gate = await evaluateEscalationIdentityGate(snapshot);
    assert.deepEqual(
      gate,
      { action: "escalate" },
      "expected the single surviving, still-matching descendant to be sufficient - the gate never requires full-set survival"
    );
    process.kill(p2, "SIGKILL"); // cleanup the sole survivor
  }
);

test(
  "evaluateEscalationIdentityGate: the leader is compared by the SAME exact-match rule as any descendant, no tolerance window - a recorded value off by even a single millisecond REFUSES",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;
    const realSnapshot = await captureEscalationIdentitySnapshot(pid);
    assert.equal(realSnapshot.degraded, false);
    const real = realSnapshot.members.find((member) => member.pid === pid)!;

    // A snapshot claiming the SAME pid but a start time off by exactly one
    // millisecond from the real, current value - this must REFUSE, proving
    // no tolerance window (unlike the pre-signal birth-identity check's
    // several-second etime tolerance, which is a wholly separate,
    // out-of-scope mechanism here).
    const offByOneMs = {
      members: [{ pid, startTimeMs: real.startTimeMs + 1 }],
      degraded: false,
    };
    const gate = await evaluateEscalationIdentityGate(offByOneMs);
    assert.equal(
      gate.action,
      "refuse",
      "expected an off-by-one-millisecond recorded value to REFUSE - the leader gets no tolerance window, exactly like any descendant"
    );
    process.kill(-pid, "SIGKILL");
  }
);

test(
  "evaluateEscalationIdentityGate: NEGATIVE - the bounded re-read TIMES OUT - refuses rather than defaulting to escalation",
  {
    skip: process.platform === "win32" ? "shadows a slow ps on PATH, POSIX-only" : false,
  },
  async () => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-reread-hang-ps-"));
    const psPath = path.join(dir, "ps");
    fs.writeFileSync(psPath, "#!/bin/sh\ntrap '' TERM\nsleep 5\n");
    fs.chmodSync(psPath, 0o755);

    const snapshot = { members: [{ pid: 424_242, startTimeMs: Date.now() }], degraded: false };
    let gate: Awaited<ReturnType<typeof evaluateEscalationIdentityGate>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      gate = await evaluateEscalationIdentityGate(snapshot, 300);
    } finally {
      process.env.PATH = realPath;
    }
    assert.equal(gate.action, "refuse");
  }
);

test("evaluateEscalationIdentityGate: NEGATIVE - a malformed re-read row for the only recorded member REFUSES, never guessed at", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-reread-malformed-ps-"));
  const psPath = path.join(dir, "ps");
  fs.writeFileSync(psPath, "#!/bin/sh\necho '424242 Sat Jul 25 13:39:12'\n"); // missing year token
  fs.chmodSync(psPath, 0o755);

  const realPath = process.env.PATH;
  const snapshot = {
    members: [{ pid: 424_242, startTimeMs: Date.UTC(2026, 6, 25, 13, 39, 12) }],
    degraded: false,
  };
  let gate: Awaited<ReturnType<typeof evaluateEscalationIdentityGate>>;
  try {
    process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
    gate = await evaluateEscalationIdentityGate(snapshot);
  } finally {
    process.env.PATH = realPath;
  }
  assert.equal(gate.action, "refuse");
});

test(
  "evaluateEscalationIdentityGate: NEGATIVE - partial re-read (one recorded member gone, the other unreadable) with no positive proof anywhere - REFUSES",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async () => {
    // pidA is genuinely gone at re-read time; pidB's row is deliberately
    // malformed - between the two of them, NOTHING positively matches.
    const snapshot = {
      members: [
        { pid: 88_888_883, startTimeMs: Date.now() },
        { pid: 88_888_884, startTimeMs: Date.UTC(2026, 6, 25, 13, 39, 12) },
      ],
      degraded: false,
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-partial-reread-ps-"));
    const psPath = path.join(dir, "ps");
    // Only ever emits a malformed row for 88888884 - never anything for
    // 88888883 (simulating it being genuinely gone), and never a
    // well-formed, matching row for either.
    fs.writeFileSync(psPath, "#!/bin/sh\necho '88888884 not-a-valid-lstart-row'\n");
    fs.chmodSync(psPath, 0o755);

    const realPath = process.env.PATH;
    let gate: Awaited<ReturnType<typeof evaluateEscalationIdentityGate>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      gate = await evaluateEscalationIdentityGate(snapshot);
    } finally {
      process.env.PATH = realPath;
    }
    assert.equal(gate.action, "refuse");
  }
);

test(
  "captureEscalationIdentitySnapshot: a real leader read and real enumeration both succeed, but the descendant start-time batch read itself fails - degrades via descendant-read-observer-failure, distinct from every other failure site",
  { skip: POSIX_PROCESS_GROUP_SKIP },
  async (t) => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["bash", "-c", "sleep 30 & sleep 30 & wait"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const leaderPid = child!.pid!;
    await waitForGroupMemberCount(leaderPid, 3);

    // A `ps` wrapper that is a real, correct observer for the single-pid
    // leader call (delegates straight to the real system `ps`, inheriting
    // this call's own LC_ALL=C/TZ=UTC0 env override) but fails outright the
    // moment it is asked about more than one pid at once - which is
    // exactly the shape only the descendant batch read ever uses (the
    // leader read always queries a single pid; pgrep enumeration is a
    // completely separate binary this wrapper never touches at all).
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-descendant-batch-fail-ps-"));
    const psPath = path.join(dir, "ps");
    fs.writeFileSync(
      psPath,
      `#!/bin/sh\ncase "$2" in\n  *,*) exit 2 ;;\n  *) exec /bin/ps "$@" ;;\nesac\n`
    );
    fs.chmodSync(psPath, 0o755);

    const errorSpy = t.mock.method(console, "error");
    let snapshot: Awaited<ReturnType<typeof captureEscalationIdentitySnapshot>>;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      snapshot = await captureEscalationIdentitySnapshot(leaderPid);
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(
      snapshot.degraded,
      true,
      "a failed descendant batch read must degrade the WHOLE snapshot, even though the leader's own read and enumeration both genuinely succeeded"
    );
    assert.ok(
      errorSpy.mock.calls.some((call) =>
        String(call.arguments[0]).includes("branch: descendant-read-observer-failure")
      ),
      `expected a diagnostic naming the descendant-read-observer-failure branch, got: ${JSON.stringify(
        errorSpy.mock.calls.map((c) => c.arguments.map(String))
      )}`
    );
    process.kill(-leaderPid, "SIGKILL");
  }
);
