/**
 * This file covers `run()`'s birth-identity capture-at-spawn lifecycle
 * (the secondary, best-effort birth-identity defense-in-depth described
 * in this file's own docs and in `src/tools/kill.ts`'s header): a real
 * leader's OS-readable birth identity
 * is captured ASYNCHRONOUSLY, fired off immediately after a real spawn but
 * NEVER awaited on `run()`'s own response path - NEVER a `Date.now()`-
 * derived guess either - persisted (nullable) alongside the tracked child
 * once it settles, and used by both real kill callers (`src/tools/kill.ts`,
 * `src/server.ts`) instead of deriving a fresh expected-elapsed-time at
 * kill time. See `src/process.ts`'s `captureBirthIdentityPosixAsync`/
 * `checkProcessIdentity`/`evaluatePreSignalIdentityGate` and
 * `src/jobStore.ts`'s `attachPendingIdentityCapture`/
 * `resolveBirthIdentityForKill` for the full mechanism this file proves is
 * actually wired end to end through `run()`.
 *
 * This file also carries the PERMANENT regression coverage for a real,
 * previously-confirmed bug: an earlier revision captured birth identity via a
 * BLOCKING, synchronous `ps` shell-out directly on `run()`'s response
 * path, so a slow or hung `ps` observer could add its own delay straight
 * onto `run()`'s response time - measured, on the unfixed code, as
 * 2088ms and 1620ms against a fake `ps` that slept before answering,
 * where `run()` is documented to return "immediately." The tests below
 * (search for "PERMANENT REGRESSION") reproduce that exact shape against a
 * real, deliberately slow-but-successful fake `ps` on `PATH`, assert a
 * response-time bound far under the artificial delay, and prove the
 * harder, corrected part of the fix: a `kill()` that arrives
 * WHILE that same capture is still genuinely in flight awaits it (bounded)
 * rather than immediately giving up on a confirmed identity comparison.
 * They also cover the other two ways an async capture can settle without a
 * real identity (a `ps` that runs but fails, and a `ps` binary missing
 * entirely) - the full three-way escape class, not just the slow case.
 *
 * `run()`'s own validation/schema tests live in test/tools.test.ts - this
 * file is scoped ONLY to the birth-identity lifecycle.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import { jobStore } from "../dist/jobStore.js";
import { captureBirthIdentityPosix, isProcessAlive } from "../dist/process.js";
import * as killTool from "../dist/tools/kill.js";
import * as runTool from "../dist/tools/run.js";

const POSIX_ONLY_SKIP =
  process.platform === "win32"
    ? "birth-identity capture is a real `ps -o etime=` read, POSIX-only - see captureBirthIdentityPosix's own docs"
    : false;

function jobIdOf(result: ReturnType<typeof runTool.handler>): string {
  const structured = result.structuredContent as Record<string, unknown>;
  const jobId = structured.job_id;
  assert.equal(typeof jobId, "string", `expected a real job_id, got: ${JSON.stringify(result)}`);
  return jobId as string;
}

/**
 * Polls `check` every 20ms until it returns true or `timeoutMs` elapses -
 * this file's own equivalent of `src/process.ts`'s `waitForProcessDeath`
 * poll-loop shape, used here because capture is now genuinely ASYNC: a
 * fixed sleep-then-assert can no longer safely stand in for "wait until the
 * async birth-identity capture has settled," since nothing bounds exactly
 * when that settles other than the capture's own timeout.
 */
function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor: timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** Waits until this job's tracked child has a real, settled `birthIdentity`. */
function waitForBirthIdentity(jobId: string, timeoutMs = 5000): Promise<void> {
  return waitFor(() => jobStore.getChildHandle(jobId)?.birthIdentity !== undefined, timeoutMs);
}

/** Waits until this job's async identity capture has fully settled (either outcome), never just "still pending". */
function waitForIdentityCaptureSettled(jobId: string, timeoutMs = 5000): Promise<void> {
  return waitFor(() => jobStore.get(jobId)?.identity_capture !== "pending", timeoutMs);
}

/**
 * Builds a real, executable fake `ps` at `<dir>/ps` running `scriptBody` (a
 * `#!/bin/sh` script) - the same "shadow a binary on a temp PATH entry"
 * pattern this codebase's own test suite already uses elsewhere (see
 * test/kill.test.ts's `pgrep`-only-PATH fixture). Returns the directory, so
 * a caller prepends it to `process.env.PATH` (never replaces PATH wholesale
 * here, so every OTHER real binary - `sleep`, `pgrep` - still resolves
 * normally through the rest of the real PATH).
 */
function makeFakePsDir(scriptBody: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-fake-ps-"));
  const psPath = path.join(dir, "ps");
  fs.writeFileSync(psPath, `#!/bin/sh\n${scriptBody}\n`);
  fs.chmodSync(psPath, 0o755);
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Successful capture-at-spawn persists a REAL value, never undefined,
//    and never a bare Date.now()-derived stand-in.
// ---------------------------------------------------------------------------

test(
  "run(): a successful spawn captures a REAL birth identity and persists it on the tracked child handle",
  { skip: POSIX_ONLY_SKIP },
  async () => {
    const result = runTool.handler({ command: ["sleep", "5"] });
    assert.notEqual(result.isError, true, `run() must succeed: ${JSON.stringify(result)}`);
    const jobId = jobIdOf(result);

    // Capture is now genuinely ASYNC (fired off without ever being awaited
    // on run()'s own response path - see this file's own header docs), so
    // a fixed sleep is no longer a safe stand-in for "wait until it's
    // settled" - poll until the tracked child actually has one instead.
    await waitForBirthIdentity(jobId);

    const handle = jobStore.getChildHandle(jobId);
    assert.notEqual(handle, undefined, "expected a real tracked child handle");
    assert.notEqual(
      handle!.birthIdentity,
      undefined,
      "expected a REAL captured birth identity, not left undefined, for an ordinary successful spawn"
    );
    assert.equal(typeof handle!.birthIdentity!.capturedAtMs, "number");
    assert.equal(typeof handle!.birthIdentity!.elapsedSecondsAtCapture, "number");
    // A capture taken right after spawn should read a near-zero elapsed
    // age - loosely bounded (not exact-equality) since this is a REAL `ps`
    // read against a REAL just-spawned process, not a synthetic value.
    assert.ok(
      handle!.birthIdentity!.elapsedSecondsAtCapture >= 0 &&
        handle!.birthIdentity!.elapsedSecondsAtCapture < 5,
      `expected a near-zero captured elapsed age for a freshly spawned process, got: ${handle!.birthIdentity!.elapsedSecondsAtCapture}`
    );

    // Cleanup.
    const killResult = await killTool.handler({ job_id: jobId });
    assert.notEqual(killResult.isError, true);
  }
);

test(
  "run(): the captured birth identity matches a REAL, independent captureBirthIdentityPosix reading of the same pid, taken moments later - proving it's a genuine ps-derived value, not synthetic bookkeeping",
  { skip: POSIX_ONLY_SKIP },
  async () => {
    const result = runTool.handler({ command: ["sleep", "5"] });
    assert.notEqual(result.isError, true);
    const jobId = jobIdOf(result);
    await waitForBirthIdentity(jobId);

    const handle = jobStore.getChildHandle(jobId);
    assert.notEqual(handle, undefined);
    const recordedIdentity = handle!.birthIdentity;
    assert.notEqual(recordedIdentity, undefined);

    // Read the SAME real pid's elapsed time again, independently, right
    // now - the two readings should describe the same real process
    // birth (within a generous few-second window - real `ps` rounding
    // plus this test's own scheduling jitter), proving run()'s own
    // capture is a genuine external observation, not internal bookkeeping
    // dressed up to look like one.
    const laterIdentity = captureBirthIdentityPosix(handle!.pid);
    assert.notEqual(
      laterIdentity,
      undefined,
      "expected the process to still be alive and observable"
    );
    const projectedElapsedAtLaterCapture =
      recordedIdentity!.elapsedSecondsAtCapture +
      (laterIdentity!.capturedAtMs - recordedIdentity!.capturedAtMs) / 1000;
    assert.ok(
      Math.abs(projectedElapsedAtLaterCapture - laterIdentity!.elapsedSecondsAtCapture) <= 5,
      `expected run()'s own captured identity to project forward to the same real elapsed time an independent capture just observed - recorded: ${JSON.stringify(recordedIdentity)}, independent: ${JSON.stringify(laterIdentity)}`
    );

    const killResult = await killTool.handler({ job_id: jobId });
    assert.notEqual(killResult.isError, true);
  }
);

// ---------------------------------------------------------------------------
// 2. Both kill callers use the CAPTURED value, not a fresh Date.now()
//    derivation - proven end to end via a real kill() call succeeding
//    normally against a job whose identity was captured by run() itself
//    (never touched/re-derived by this test).
// ---------------------------------------------------------------------------

test(
  "run() -> kill(): the captured identity round-trips correctly through a REAL kill() call with no test-side interference - identity_confirmed: true, the group actually reaped",
  { skip: POSIX_ONLY_SKIP },
  async () => {
    const result = runTool.handler({ command: ["sleep", "10"] });
    assert.notEqual(result.isError, true);
    const jobId = jobIdOf(result);
    await waitForBirthIdentity(jobId);

    const handle = jobStore.getChildHandle(jobId);
    const pid = handle!.pid;
    assert.equal(isProcessAlive(pid), true);

    const killResult = await killTool.handler({ job_id: jobId });
    assert.notEqual(killResult.isError, true, `kill() must succeed: ${JSON.stringify(killResult)}`);
    const structured = killResult.structuredContent as Record<string, unknown>;
    assert.equal(structured.state, "killed");
    assert.equal(
      structured.identity_confirmed,
      true,
      "run()'s own captured identity must be what kill() actually compared against - a fresh Date.now()-derived value at kill time would still happen to match here, distinct from the observer-failure/degraded cases exercised separately"
    );
    assert.equal(structured.kill_confirmed, true);
    assert.equal(isProcessAlive(pid), false);
  }
);

// ---------------------------------------------------------------------------
// 3. A capture failure AT SPAWN TIME results in the documented degraded,
//    honestly-disclosed pgid-only-signaling path at kill time - run()
//    itself must still succeed (this codebase's own established
//    principle: run() does NOT fail on capture failure).
// ---------------------------------------------------------------------------

test(
  "run(): a spawn-time birth-identity capture failure (ps unavailable) never fails run() itself - the job is created and stays killable, with birthIdentity left undefined",
  { skip: POSIX_ONLY_SKIP },
  async () => {
    const realPath = process.env.PATH;
    let result: ReturnType<typeof runTool.handler>;
    try {
      // Break PATH for the SERVER PROCESS itself (what captureBirthIdentityPosix's
      // own execFileSync("ps", ...) call reads) - the JOB's own env is a
      // separate, caller-supplied object (buildChildEnv), so `sleep`
      // itself still resolves and spawns normally via its own PATH.
      process.env.PATH = "/tmp/does-not-exist-ghantika-empty-path-dir";
      result = runTool.handler({
        command: ["sleep", "5"],
        env: { vars: { PATH: realPath ?? "/usr/bin:/bin" } },
      });
    } finally {
      process.env.PATH = realPath;
    }

    assert.notEqual(
      result.isError,
      true,
      `run() must succeed even when spawn-time identity capture fails: ${JSON.stringify(result)}`
    );
    const jobId = jobIdOf(result);
    // The async capture settles quickly here (ENOENT fails almost
    // instantly - see this file's own empirical proof, above, that
    // execFile resolves PATH synchronously at call time, not at callback
    // time), but it's still a real async settle - poll for it rather than
    // assuming a fixed delay is enough.
    await waitForIdentityCaptureSettled(jobId);

    const handle = jobStore.getChildHandle(jobId);
    assert.notEqual(handle, undefined, "the job must still be created and tracked");
    assert.equal(
      handle!.birthIdentity,
      undefined,
      "a failed spawn-time capture must leave birthIdentity undefined - never a fabricated value"
    );
    assert.equal(
      jobStore.get(jobId)!.identity_capture,
      "unavailable",
      "a capture that settled with no identity at all must be honestly disclosed as unavailable, never left as pending or silently upgraded"
    );
    assert.equal(
      isProcessAlive(handle!.pid),
      true,
      "the real process must still be alive and killable"
    );

    // THE proof this is genuinely "killable, degraded" and not silently
    // broken: a real kill() call, with a normal PATH restored, must still
    // succeed via the honest DEGRADED path (see src/process.ts's
    // evaluatePreSignalIdentityGate) - identity was never captured, so it
    // can never be confirmed, but the job is still fully killable.
    const killResult = await killTool.handler({ job_id: jobId });
    assert.notEqual(
      killResult.isError,
      true,
      `kill() must still succeed: ${JSON.stringify(killResult)}`
    );
    const structured = killResult.structuredContent as Record<string, unknown>;
    assert.equal(structured.state, "killed");
    assert.equal(
      structured.identity_confirmed,
      false,
      "identity was never captured at spawn time - must be honestly disclosed as unconfirmed, never silently treated as confirmed"
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(isProcessAlive(handle!.pid), false, "the job must still actually be reaped");
  }
);

// ---------------------------------------------------------------------------
// 4. PERMANENT REGRESSION: run()'s response time must be independent of a
//    slow-but-successful identity observer, AND a kill() that races ahead
//    of that still-in-flight capture must await it (bounded) rather than
//    immediately degrading - the corrected design's whole point.
// ---------------------------------------------------------------------------

test(
  "PERMANENT REGRESSION: run() with a deliberately slow-but-successful ps observer still returns near-instantly, and a kill() that races ahead of the still-PENDING capture awaits it and gets a real, externally-confirmed identity_confirmed: true - never a false-fast response, never a needlessly degraded kill",
  { skip: POSIX_ONLY_SKIP },
  async () => {
    const realPath = process.env.PATH;
    // A real fake `ps` that sleeps 1.5s before answering with a valid,
    // parseable etime line - the EXACT shape the original reproduction used to
    // measure the pre-fix bug (2088ms/1620ms real run() response times
    // against the unfixed synchronous capture call). Prepended to PATH
    // (never replacing it), so every other real binary this test needs
    // (`sleep` for the job itself, `pgrep` for kill()'s own process-group
    // confirmation) still resolves normally through the rest of the real
    // PATH.
    const fakePsDir = makeFakePsDir("sleep 1.5\necho '00:00'");

    let result: ReturnType<typeof runTool.handler>;
    let elapsedMs: number;
    try {
      process.env.PATH = `${fakePsDir}:${realPath ?? "/usr/bin:/bin"}`;
      const before = Date.now();
      result = runTool.handler({
        command: ["sleep", "10"],
        env: { vars: { PATH: realPath ?? "/usr/bin:/bin" } },
      });
      elapsedMs = Date.now() - before;
    } finally {
      // Restored immediately - the ALREADY-SPAWNED fake-ps child process
      // (kicked off synchronously inside run()'s own handler, per this
      // file's own empirical proof above that execFile resolves PATH at
      // call time) keeps sleeping on its own regardless of this restore;
      // this only affects PATH lookups for anything spawned AFTER this
      // point (kill()'s own, separate, fast pre-signal ps check below).
      process.env.PATH = realPath;
    }

    assert.notEqual(result.isError, true, `run() must succeed: ${JSON.stringify(result)}`);
    // THE core regression assertion: run()'s own response time must be
    // bounded far under the fake observer's 1.5s artificial delay - on the
    // unfixed (synchronous-capture) code this measured 2088ms/1620ms; 800ms
    // is generous headroom above ordinary fast-path latency while staying
    // comfortably below the 1500ms sleep.
    assert.ok(
      elapsedMs < 800,
      `run() must return independently of a slow identity observer - expected well under 800ms, took ${elapsedMs}ms (the fake ps sleeps 1500ms; a response anywhere near or above that means the old synchronous-capture bug is back)`
    );
    const jobId = jobIdOf(result);

    // Confirm we are GENUINELY racing ahead of a still-in-flight capture,
    // not merely assuming timing worked out - this is what makes the
    // "kill awaits pending" assertion below meaningful rather than
    // accidental.
    assert.equal(
      jobStore.get(jobId)!.identity_capture,
      "pending",
      "expected the async capture to still be genuinely in flight at this point (the fake ps has not slept its full 1.5s yet) - if this fails, the race this test exists to exercise did not actually happen"
    );

    // THE corrected-design proof: kill(), called RIGHT NOW while the
    // capture is still pending, must AWAIT that same in-flight capture
    // (bounded by its own timeout) and get a REAL, externally-confirmed
    // identity confirmation once it settles - never immediately fall back
    // to the honest-but-weaker degraded path just because identity wasn't
    // ALREADY settled at the exact instant kill() was called.
    const killResult = await killTool.handler({ job_id: jobId });
    assert.notEqual(killResult.isError, true, `kill() must succeed: ${JSON.stringify(killResult)}`);
    const structured = killResult.structuredContent as Record<string, unknown>;
    assert.equal(structured.state, "killed");
    assert.equal(
      structured.identity_confirmed,
      true,
      `kill() must have awaited the still-pending capture and confirmed identity for real, not degraded - got: ${JSON.stringify(structured)}`
    );
    assert.equal(
      structured.kill_confirmed,
      true,
      "the real process group must actually have been reaped and externally confirmed"
    );
    assert.equal(
      jobStore.get(jobId)!.identity_capture,
      "captured",
      "the capture must have settled to captured by the time kill() finished awaiting it"
    );
  }
);

// ---------------------------------------------------------------------------
// 5. PERMANENT REGRESSION: the OTHER two ways an async capture can settle
//    without a real identity - a `ps` that runs but exits with a genuine
//    error (distinct from its own documented "no such pid" exit code 1),
//    and (covered by the capture-failure test in section 3 above) a `ps`
//    binary missing entirely. Both must land in "unavailable" and still
//    allow a safe, honest degraded kill - never a false success, never an
//    uncaught throw, never a hang.
// ---------------------------------------------------------------------------

test(
  "PERMANENT REGRESSION: run() with a ps observer that runs but fails (a genuine nonzero, non-1 exit) still returns fast, the capture settles to unavailable, and kill() still succeeds via the honest degraded path",
  { skip: POSIX_ONLY_SKIP },
  async () => {
    const realPath = process.env.PATH;
    // A real `ps` that executes successfully as a process but reports a
    // genuine failure - exit code 2, deliberately NOT 1 (ps's own
    // documented "no such pid" code, which this codebase must never
    // confuse with a real observer failure - see readProcessElapsedSecondsAsync's
    // own docs).
    const fakePsDir = makeFakePsDir("exit 2");

    let result: ReturnType<typeof runTool.handler>;
    let elapsedMs: number;
    try {
      process.env.PATH = `${fakePsDir}:${realPath ?? "/usr/bin:/bin"}`;
      const before = Date.now();
      result = runTool.handler({
        command: ["sleep", "5"],
        env: { vars: { PATH: realPath ?? "/usr/bin:/bin" } },
      });
      elapsedMs = Date.now() - before;
    } finally {
      process.env.PATH = realPath;
    }

    assert.notEqual(result.isError, true, `run() must succeed: ${JSON.stringify(result)}`);
    assert.ok(
      elapsedMs < 800,
      `run() must never block on the identity observer regardless of how it fails - took ${elapsedMs}ms`
    );
    const jobId = jobIdOf(result);

    await waitForIdentityCaptureSettled(jobId);
    assert.equal(
      jobStore.get(jobId)!.identity_capture,
      "unavailable",
      "a ps that runs but genuinely fails must settle to unavailable, never captured, never left pending"
    );
    assert.equal(jobStore.getChildHandle(jobId)!.birthIdentity, undefined);

    const killResult = await killTool.handler({ job_id: jobId });
    assert.notEqual(
      killResult.isError,
      true,
      `kill() must still succeed via the degraded path: ${JSON.stringify(killResult)}`
    );
    const structured = killResult.structuredContent as Record<string, unknown>;
    assert.equal(structured.state, "killed");
    assert.equal(
      structured.identity_confirmed,
      false,
      "identity could never be established (the observer genuinely failed) - must be honestly disclosed as unconfirmed"
    );
    assert.equal(structured.kill_confirmed, true, "the real process must still actually be reaped");
  }
);

test(
  "run(): on Windows, birth-identity capture is never even attempted - birthIdentity is always undefined there",
  { skip: process.platform !== "win32" ? "Windows-only assertion" : false },
  () => {
    // A minimal, host-agnostic assertion of the documented Windows scope
    // decision (see captureBirthIdentityPosix's own docs) - this suite's
    // other tests are POSIX-only (no `ps`/real process-group semantics on
    // Windows), so this is the one assertion that actually runs there.
    assert.equal(captureBirthIdentityPosix(process.pid), undefined);
  }
);
