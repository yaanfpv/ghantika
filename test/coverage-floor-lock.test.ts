/**
 * Tests for scripts/lib/coverage-floor-lock.mjs - the crash-safe mutual-
 * exclusion lock scripts/coverage-lock-worker-wrapper.mjs (`npm run
 * coverage`) and scripts/coverage-lock-floor-wrapper.mjs (`npm run
 * check:coverage-floor`) hand off across their two separate OS-process
 * invocations. See that module's own header for the state machine and the
 * deadlock this closes.
 *
 * Everything here runs IN-PROCESS, against `acquireAsWorker`/
 * `acquireAsFloorJob` directly, with every real observation
 * (spawn, identity capture, the wall clock) injectable - this is what
 * makes the required deadlock-fix and stale-snapshot controls below
 * DETERMINISTIC rather than timing-dependent. The real, end-to-end,
 * child-process-spawning handoff (mirroring what `.github/workflows/
 * ci.yml`'s "coverage" job actually does across two separate steps) is
 * test/coverage-lock-wrappers.test.ts's job instead.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FLOOR_JOB_DEGRADED_WINDOW_MS,
  RELEASED_SUFFIX,
  acquireAsFloorJob,
  acquireAsWorker,
  checkFloorJobLiveness,
  checkPidLiveness,
  classifyFloorAcquisition,
  defaultComposeIdentityWrite,
  defaultSpawnTracked,
  describeError,
  isLockCurrentlyHeld,
  killBestEffort,
  livenessBlocksAcquisition,
  readLockFile,
  readLockState,
  release,
  releasedSidecarPath,
  writeIdentityAtomic,
} from "../scripts/lib/coverage-floor-lock.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOCK_LIB_PATH = fileURLToPath(
  new URL("../scripts/lib/coverage-floor-lock.mjs", import.meta.url)
);
const WORKER_WRAPPER_PATH = fileURLToPath(
  new URL("../scripts/coverage-lock-worker-wrapper.mjs", import.meta.url)
);
const FLOOR_WRAPPER_PATH = fileURLToPath(
  new URL("../scripts/coverage-lock-floor-wrapper.mjs", import.meta.url)
);

/**
 * Runs `fn(dir)` against a fresh scratch directory, removing it afterward.
 * Handles BOTH a synchronous `fn` and an async one correctly: a naive
 * `try { return fn(dir); } finally { rmSync(...) }` is wrong for an async
 * `fn` - `fn(dir)` returns a PENDING promise the instant it hits its own
 * first `await` (even one awaiting an already-resolved value, a real JS
 * semantic: `await x` always yields at least one microtask turn), so the
 * `finally` block would run - deleting the directory - while the async
 * callback's own body is still mid-flight, well before its real work is
 * done. Detecting a thenable return value and chaining cleanup onto it via
 * `.finally()` instead defers the removal until the callback's own promise
 * genuinely settles.
 */
function withScratchDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result: T;
  try {
    result = fn(dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(cleanup) as T;
  }
  cleanup();
  return result;
}

// A trivial, always-succeeding fixture command - matches this repo's own
// existing convention of using `process.execPath -e "..."` as a real,
// short-lived child rather than a shell built-in, e.g.
// test/status-process-identity.test.ts's own run() fixtures.
function successFixture(): string[] {
  return [process.execPath, "-e", "process.exit(0)"];
}

function longRunningFixture(): string[] {
  return [process.execPath, "-e", "setTimeout(() => {}, 30000)"];
}

// ===========================================================================
// writeIdentityAtomic / readLockFile / readLockState
// ===========================================================================

test("writeIdentityAtomic: writes exactly the given payload, read back verbatim", () => {
  withScratchDir("ghantika-cfl-write-", (dir) => {
    const lockPath = path.join(dir, "sub", "lock.json");
    writeIdentityAtomic(lockPath, { phase: "working", ownerPid: 123, headSha: "abc" });
    assert.deepEqual(readLockFile(lockPath), { phase: "working", ownerPid: 123, headSha: "abc" });
  });
});

test("writeIdentityAtomic: creates the parent directory if it does not exist yet", () => {
  withScratchDir("ghantika-cfl-mkdir-", (dir) => {
    const lockPath = path.join(dir, "does", "not", "exist", "lock.json");
    assert.equal(existsSync(path.dirname(lockPath)), false);
    writeIdentityAtomic(lockPath, { phase: "working" });
    assert.equal(existsSync(lockPath), true);
  });
});

test("writeIdentityAtomic: leaves no stray temp file behind - exactly one file in the directory afterward", () => {
  withScratchDir("ghantika-cfl-notemp-", (dir) => {
    const lockPath = path.join(dir, "lock.json");
    writeIdentityAtomic(lockPath, { phase: "working" });
    const entries = readdirSync(dir);
    assert.deepEqual(
      entries,
      ["lock.json"],
      `expected only the real lock file, got: ${JSON.stringify(entries)}`
    );
  });
});

test("writeIdentityAtomic: a second write fully replaces the first, never merges", () => {
  withScratchDir("ghantika-cfl-replace-", (dir) => {
    const lockPath = path.join(dir, "lock.json");
    writeIdentityAtomic(lockPath, { phase: "working", ownerPid: 1 });
    writeIdentityAtomic(lockPath, { phase: "publishing" });
    assert.deepEqual(readLockFile(lockPath), { phase: "publishing" });
  });
});

test("readLockFile: returns null (not a throw) for a genuinely absent file", () => {
  withScratchDir("ghantika-cfl-absent-", (dir) => {
    assert.equal(readLockFile(path.join(dir, "does-not-exist.json")), null);
  });
});

test("readLockFile: rethrows a genuine parse failure rather than reading it as absent", () => {
  withScratchDir("ghantika-cfl-corrupt-", (dir) => {
    const lockPath = path.join(dir, "lock.json");
    // Not writeIdentityAtomic - deliberately corrupt, malformed content.
    writeFileSync(lockPath, "{ not valid json");
    assert.throws(() => readLockFile(lockPath), SyntaxError);
  });
});

test("readLockState: primary file present -> location 'primary', payload verbatim", () => {
  withScratchDir("ghantika-cfl-state-primary-", (dir) => {
    const lockPath = path.join(dir, "lock.json");
    writeIdentityAtomic(lockPath, { phase: "publishing" });
    assert.deepEqual(readLockState(lockPath), {
      location: "primary",
      payload: { phase: "publishing" },
    });
  });
});

test("readLockState: only the released sidecar present -> location 'sidecar'", () => {
  withScratchDir("ghantika-cfl-state-sidecar-", (dir) => {
    const lockPath = path.join(dir, "lock.json");
    writeIdentityAtomic(releasedSidecarPath(lockPath), { phase: "released" });
    assert.deepEqual(readLockState(lockPath), {
      location: "sidecar",
      payload: { phase: "released" },
    });
  });
});

test("readLockState: neither the primary nor the sidecar exists -> location 'absent', payload null", () => {
  withScratchDir("ghantika-cfl-state-absent-", (dir) => {
    assert.deepEqual(readLockState(path.join(dir, "lock.json")), {
      location: "absent",
      payload: null,
    });
  });
});

test("readLockState: the primary takes priority when BOTH exist (should never happen in production, but the read must be deterministic)", () => {
  withScratchDir("ghantika-cfl-state-both-", (dir) => {
    const lockPath = path.join(dir, "lock.json");
    writeIdentityAtomic(lockPath, { phase: "working" });
    writeIdentityAtomic(releasedSidecarPath(lockPath), { phase: "released" });
    assert.deepEqual(readLockState(lockPath), {
      location: "primary",
      payload: { phase: "working" },
    });
  });
});

// ===========================================================================
// release()
// ===========================================================================

test("release: moves the primary lock into the released sidecar with the given payload; primary no longer exists", () => {
  withScratchDir("ghantika-cfl-release-", (dir) => {
    const lockPath = path.join(dir, "lock.json");
    writeIdentityAtomic(lockPath, { phase: "done", floorJobExitCode: 0 });
    release(lockPath, { phase: "released", releaseReason: "normal-done" });
    assert.equal(existsSync(lockPath), false, "the primary lock file must be gone after release");
    assert.deepEqual(readLockFile(releasedSidecarPath(lockPath)), {
      phase: "released",
      releaseReason: "normal-done",
    });
  });
});

test("release: never throws when the primary file never existed to begin with (a no-op unlink)", () => {
  withScratchDir("ghantika-cfl-release-noop-", (dir) => {
    const lockPath = path.join(dir, "lock.json");
    assert.doesNotThrow(() => release(lockPath, { phase: "released" }));
    assert.deepEqual(readLockFile(releasedSidecarPath(lockPath)), { phase: "released" });
  });
});

test("release: NEVER THROWS even when both the sidecar write and the primary unlink fail (an unwritable directory)", () => {
  // POSIX only - matches test/check-coverage-floor.test.js's own chmod
  // convention for exercising a genuine, unwritable-directory failure.
  if (process.platform === "win32") return;
  withScratchDir("ghantika-cfl-release-unwritable-", (dir) => {
    const lockedDir = path.join(dir, "locked");
    mkdirSync(lockedDir, { recursive: true });
    const lockPath = path.join(lockedDir, "lock.json");
    writeIdentityAtomic(lockPath, { phase: "done" });
    chmodSync(lockedDir, 0o500); // read + traverse, not write
    try {
      assert.doesNotThrow(() => release(lockPath, { phase: "released" }));
      // The best-effort attempt genuinely failed - the primary file is
      // still there (the directory refused the unlink), proving this
      // control actually exercised the failure path rather than the
      // directory turning out writable after all.
      assert.equal(
        existsSync(lockPath),
        true,
        "setup check: the unlink must have genuinely failed"
      );
    } finally {
      chmodSync(lockedDir, 0o700);
    }
  });
});

test("describeError: an Error instance reports its .message; any other thrown value is stringified", () => {
  assert.equal(describeError(new Error("boom")), "boom");
  assert.equal(describeError("plain string"), "plain string");
  assert.equal(describeError(42), "42");
});

// ===========================================================================
// checkPidLiveness / livenessBlocksAcquisition
// ===========================================================================

test("checkPidLiveness: no birthIdentity + plainCheck reports alive -> alive-unconfirmed", async () => {
  const result = await checkPidLiveness(123, undefined, { plainCheck: () => true });
  assert.equal(result.verdict, "alive-unconfirmed");
  assert.ok(result.reason?.includes("123"));
});

test("checkPidLiveness: no birthIdentity + plainCheck reports gone -> not-found", async () => {
  const result = await checkPidLiveness(123, undefined, { plainCheck: () => false });
  assert.deepEqual(result, { verdict: "not-found" });
});

test("checkPidLiveness: a birthIdentity present delegates to identityCheck, mapping every real status", async () => {
  const identity = {
    platform: "posix-elapsed" as const,
    capturedAtMs: 0,
    elapsedSecondsAtCapture: 0,
  };
  const cases: Array<[unknown, string]> = [
    [{ status: "alive-confirmed" }, "alive-confirmed"],
    [{ status: "not-found" }, "not-found"],
    [{ status: "identity-mismatch", reason: "mismatch reason" }, "identity-mismatch"],
    [{ status: "observer-failure", reason: "observer reason" }, "observer-failure"],
  ];
  for (const [identityCheckResult, expectedVerdict] of cases) {
    const result = await checkPidLiveness(123, identity, {
      identityCheck: async () => identityCheckResult as never,
    });
    assert.equal(result.verdict, expectedVerdict, `input ${JSON.stringify(identityCheckResult)}`);
  }
});

test("checkPidLiveness: passes now() through to identityCheck as its own third argument", async () => {
  let observedNow: number | undefined;
  await checkPidLiveness(
    123,
    { platform: "posix-elapsed", capturedAtMs: 0, elapsedSecondsAtCapture: 0 },
    {
      now: () => 999,
      identityCheck: async (_pid: number, _identity: unknown, now: number) => {
        observedNow = now;
        return { status: "not-found" } as never;
      },
    }
  );
  assert.equal(observedNow, 999);
});

test("livenessBlocksAcquisition: alive-confirmed/alive-unconfirmed/observer-failure block; not-found/identity-mismatch do not", () => {
  assert.equal(livenessBlocksAcquisition("alive-confirmed"), true);
  assert.equal(livenessBlocksAcquisition("alive-unconfirmed"), true);
  assert.equal(livenessBlocksAcquisition("observer-failure"), true);
  assert.equal(livenessBlocksAcquisition("not-found"), false);
  assert.equal(livenessBlocksAcquisition("identity-mismatch"), false);
});

// ===========================================================================
// checkFloorJobLiveness - the reclaim sub-case
// ===========================================================================

test("checkFloorJobLiveness: a malformed record (no numeric floorJobPid) fails closed as observer-failure, never as not-found", async () => {
  const result = await checkFloorJobLiveness({ phase: "floor-running" });
  assert.equal(result.verdict, "observer-failure");
  assert.ok(result.reason?.includes("floor-running"));
});

test("checkFloorJobLiveness: a present floorJobBirthIdentity delegates to checkPidLiveness (identityCheck is consulted)", async () => {
  const payload = {
    phase: "floor-running",
    floorJobPid: 555,
    floorJobBirthIdentity: {
      platform: "posix-elapsed",
      capturedAtMs: 0,
      elapsedSecondsAtCapture: 0,
    },
  };
  let calledWithPid: number | undefined;
  const result = await checkFloorJobLiveness(payload, {
    identityCheck: async (pid: number) => {
      calledWithPid = pid;
      return { status: "alive-confirmed" } as never;
    },
  });
  assert.equal(calledWithPid, 555);
  assert.equal(result.verdict, "alive-confirmed");
});

test("checkFloorJobLiveness: no floorJobBirthIdentity, still within the capture window, pid alive (plain check) -> DEGRADED alive-unconfirmed naming the window", async () => {
  const now = () => 1000;
  const payload = {
    phase: "floor-running",
    floorJobPid: 555,
    floorRunningAt: new Date(1000 - 100).toISOString(),
  };
  const result = await checkFloorJobLiveness(payload, { now, plainCheck: () => true });
  assert.equal(result.verdict, "alive-unconfirmed");
  assert.ok(result.reason?.includes("has not landed yet"), result.reason);
});

test("checkFloorJobLiveness: no floorJobBirthIdentity, PAST the capture window, pid alive (plain check) -> still DEGRADED alive-unconfirmed, different wording", async () => {
  const recordedAt = 1000;
  const now = () => recordedAt + FLOOR_JOB_DEGRADED_WINDOW_MS + 1;
  const payload = {
    phase: "floor-running",
    floorJobPid: 555,
    floorRunningAt: new Date(recordedAt).toISOString(),
  };
  const result = await checkFloorJobLiveness(payload, { now, plainCheck: () => true });
  assert.equal(result.verdict, "alive-unconfirmed");
  assert.ok(result.reason?.includes("never landed"), result.reason);
});

test("checkFloorJobLiveness: no floorJobBirthIdentity, pid confirmed gone (plain check false) -> not-found, regardless of window", async () => {
  const payload = {
    phase: "floor-running",
    floorJobPid: 555,
    floorRunningAt: new Date().toISOString(),
  };
  const result = await checkFloorJobLiveness(payload, { plainCheck: () => false });
  assert.deepEqual(result, { verdict: "not-found" });
});

test("checkFloorJobLiveness: a missing/malformed floorRunningAt is treated as far past the window (never crashes)", async () => {
  const payload = { phase: "floor-running", floorJobPid: 555 };
  const result = await checkFloorJobLiveness(payload, { plainCheck: () => true });
  assert.equal(result.verdict, "alive-unconfirmed");
  assert.ok(result.reason?.includes("never landed"));
});

// ===========================================================================
// isLockCurrentlyHeld
// ===========================================================================

test("isLockCurrentlyHeld: a null payload is not held", async () => {
  assert.deepEqual(await isLockCurrentlyHeld(null), {
    held: false,
    reason: "no lock file is present",
  });
});

test("isLockCurrentlyHeld: phase 'done' is NEVER held, even when ownerPid would report alive-confirmed - the terminal state short-circuits liveness entirely", async () => {
  const result = await isLockCurrentlyHeld(
    { phase: "done", ownerPid: 1 },
    { identityCheck: async () => ({ status: "alive-confirmed" }) as never }
  );
  assert.equal(result.held, false);
});

test("isLockCurrentlyHeld: ownerPid confirmed alive -> held, names the owner pid and phase", async () => {
  const result = await isLockCurrentlyHeld(
    {
      phase: "working",
      ownerPid: 42,
      ownerBirthIdentity: {
        platform: "posix-elapsed",
        capturedAtMs: 0,
        elapsedSecondsAtCapture: 0,
      },
    },
    { identityCheck: async () => ({ status: "alive-confirmed" }) as never }
  );
  assert.equal(result.held, true);
  assert.equal(result.blockingPid, 42);
  assert.equal(result.blockingPhase, "working");
});

test("isLockCurrentlyHeld: ownerPid not-found, phase 'working' -> not held (nothing else to check for that phase)", async () => {
  const result = await isLockCurrentlyHeld(
    { phase: "working", ownerPid: 42 },
    { identityCheck: async () => ({ status: "not-found" }) as never }
  );
  assert.equal(result.held, false);
});

test("isLockCurrentlyHeld: the STRENGTHENING beyond literal ownerPid-only text - ownerPid gone, phase 'floor-running', floorJobPid confirmed alive -> STILL held, naming floorJobPid", async () => {
  const identity = {
    platform: "posix-elapsed" as const,
    capturedAtMs: 0,
    elapsedSecondsAtCapture: 0,
  };
  const result = await isLockCurrentlyHeld(
    {
      phase: "floor-running",
      ownerPid: 42,
      ownerBirthIdentity: identity,
      floorJobPid: 99,
      floorJobBirthIdentity: identity,
    },
    {
      identityCheck: async (pid: number) =>
        (pid === 42 ? { status: "not-found" } : { status: "alive-confirmed" }) as never,
    }
  );
  assert.equal(
    result.held,
    true,
    "a live floor job must block a new worker acquisition even once the original worker is confirmed dead"
  );
  assert.equal(result.blockingPid, 99);
  assert.equal(result.blockingPhase, "floor-running");
});

test("isLockCurrentlyHeld: both ownerPid and floorJobPid confirmed gone, phase 'floor-running' -> not held (safe to reclaim)", async () => {
  const result = await isLockCurrentlyHeld(
    { phase: "floor-running", ownerPid: 42, floorJobPid: 99 },
    { identityCheck: async () => ({ status: "not-found" }) as never, plainCheck: () => false }
  );
  assert.equal(result.held, false);
});

// ===========================================================================
// classifyFloorAcquisition - the floor wrapper's own pure dispatch
// ===========================================================================

test("classifyFloorAcquisition: no lock at all -> refuse [no-active-lock]", () => {
  const result = classifyFloorAcquisition({ location: "absent", payload: null }, "sha1");
  assert.equal(result.outcome, "refuse");
  assert.equal((result as { reason: string }).reason, "no-active-lock");
});

test("classifyFloorAcquisition: only a released sidecar exists -> refuse [no-active-lock], names the sidecar", () => {
  const result = classifyFloorAcquisition(
    { location: "sidecar", payload: { phase: "released" } },
    "sha1"
  );
  assert.equal(result.outcome, "refuse");
  assert.equal((result as { reason: string }).reason, "no-active-lock");
  assert.ok((result as { detail: string }).detail.includes(RELEASED_SUFFIX));
});

test("classifyFloorAcquisition: primary, phase publishing, matching headSha -> proceed-normal-handoff", () => {
  const payload = { phase: "publishing", headSha: "sha1" };
  const result = classifyFloorAcquisition({ location: "primary", payload }, "sha1");
  assert.deepEqual(result, { outcome: "proceed-normal-handoff", payload });
});

test("classifyFloorAcquisition: primary, phase publishing, headSha mismatch -> refuse [head-sha-mismatch]", () => {
  const result = classifyFloorAcquisition(
    { location: "primary", payload: { phase: "publishing", headSha: "OLD" } },
    "NEW"
  );
  assert.equal(result.outcome, "refuse");
  assert.equal((result as { reason: string }).reason, "head-sha-mismatch");
});

test("classifyFloorAcquisition: primary, phase working -> refuse [worker-never-finished], regardless of headSha", () => {
  for (const headSha of ["sha1", "sha2"]) {
    const result = classifyFloorAcquisition(
      { location: "primary", payload: { phase: "working", headSha: "sha1" } },
      headSha
    );
    assert.equal(result.outcome, "refuse");
    assert.equal((result as { reason: string }).reason, "worker-never-finished");
  }
});

test("classifyFloorAcquisition: primary, phase floor-running -> reclaim-check-needed", () => {
  const payload = { phase: "floor-running", floorJobPid: 1 };
  const result = classifyFloorAcquisition({ location: "primary", payload }, "sha1");
  assert.deepEqual(result, { outcome: "reclaim-check-needed", payload });
});

test("classifyFloorAcquisition: primary, phase done -> reclaim-check-needed", () => {
  const payload = { phase: "done", floorJobPid: 1 };
  const result = classifyFloorAcquisition({ location: "primary", payload }, "sha1");
  assert.deepEqual(result, { outcome: "reclaim-check-needed", payload });
});

test("classifyFloorAcquisition: primary, an unrecognized phase -> refuse [unrecognized-phase]", () => {
  const result = classifyFloorAcquisition(
    { location: "primary", payload: { phase: "bogus" } },
    "sha1"
  );
  assert.equal(result.outcome, "refuse");
  assert.equal((result as { reason: string }).reason, "unrecognized-phase");
});

// ===========================================================================
// defaultComposeIdentityWrite
// ===========================================================================

test("defaultComposeIdentityWrite: spreads baseSnapshot and adds floorJobBirthIdentity, mutating neither input", () => {
  const base = { phase: "floor-running", floorJobPid: 1 };
  const identity = {
    platform: "posix-elapsed" as const,
    capturedAtMs: 0,
    elapsedSecondsAtCapture: 0,
  };
  const result = defaultComposeIdentityWrite(base, identity);
  assert.deepEqual(result, {
    phase: "floor-running",
    floorJobPid: 1,
    floorJobBirthIdentity: identity,
  });
  assert.deepEqual(
    base,
    { phase: "floor-running", floorJobPid: 1 },
    "must not mutate the base snapshot"
  );
});

// ===========================================================================
// killBestEffort / defaultSpawnTracked
// ===========================================================================

test("killBestEffort: undefined child, or a child with no pid, is a safe no-op", async () => {
  await assert.doesNotReject(killBestEffort(undefined));
  await assert.doesNotReject(killBestEffort({ pid: undefined } as never));
});

test("killBestEffort: a child that has already exited is left alone (no signal sent)", async () => {
  const child = {
    pid: 123,
    exitCode: 0,
    signalCode: null,
    kill: () => assert.fail("must not signal an already-exited child"),
  };
  await assert.doesNotReject(killBestEffort(child as never));
});

test("killBestEffort: a real, still-running child is actually terminated within its grace period", async () => {
  const { child, done } = defaultSpawnTracked(longRunningFixture());
  assert.ok(child, "expected a real spawned child");
  await killBestEffort(child, { gracePeriodMs: 2000, pollIntervalMs: 10 });
  const result = await done;
  // A signal-terminated child reports code: null, signal: "SIGTERM" (or
  // SIGKILL) - that IS the expected shape of a killed child, never a
  // regular exit code. Terminated-by-EITHER-means is the real assertion.
  assert.ok(
    result.code !== null || result.signal !== null,
    `expected the child to have genuinely exited or been signalled by the time killBestEffort resolves, got: ${JSON.stringify(result)}`
  );
});

test("defaultSpawnTracked: a real trivial command resolves `done` with its true exit code", async () => {
  const { child, done } = defaultSpawnTracked(successFixture());
  assert.ok(child?.pid);
  const result = await done;
  assert.equal(result.code, 0);
  assert.equal(result.error, undefined);
});

test("defaultSpawnTracked: a nonexistent command surfaces via done's own error field, never an uncaught exception", async () => {
  const { done } = defaultSpawnTracked(["this-command-definitely-does-not-exist-ghantika-cfl"]);
  const result = await done;
  assert.ok(result.error, "expected a real spawn error to be reported");
  assert.equal(result.code, null);
});

// ===========================================================================
// acquireAsWorker / acquireAsFloorJob - the happy path handoff, in-process
// ===========================================================================

test("acquireAsWorker: rejects an empty argv / a missing headSha before ever touching the lock file", async () => {
  await withScratchDir("ghantika-cfl-validate-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    await assert.rejects(() => acquireAsWorker({ argv: [], headSha: "sha1", lockPath } as never));
    await assert.rejects(() =>
      acquireAsWorker({ argv: successFixture(), headSha: "", lockPath } as never)
    );
    assert.equal(existsSync(lockPath), false, "must never write anything when validation fails");
  });
});

test("acquireAsWorker -> acquireAsFloorJob: the full normal handoff, in-process, ends released with phase done and a faithful exit code", async () => {
  await withScratchDir("ghantika-cfl-happy-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const headSha = "deadbeef";

    const workerResult = await acquireAsWorker({ argv: successFixture(), headSha, lockPath });
    assert.equal(workerResult.exitCode, 0);
    const midway = readLockFile(lockPath) as Record<string, unknown>;
    assert.equal(midway.phase, "publishing");
    assert.equal(midway.headSha, headSha);
    assert.equal(midway.workerExitCode, 0);
    assert.equal(typeof midway.ownerPid, "number");

    const floorResult = await acquireAsFloorJob({ argv: successFixture(), headSha, lockPath });
    assert.equal(floorResult.exitCode, 0);
    assert.equal(readLockFile(lockPath), null, "the primary lock must be gone once released");
    const finalRecord = readLockFile(releasedSidecarPath(lockPath)) as Record<string, unknown>;
    assert.equal(finalRecord.phase, "done");
    assert.equal(finalRecord.floorJobExitCode, 0);
    assert.equal(finalRecord.releaseReason, "normal-done");
    assert.equal(
      typeof finalRecord.floorJobBirthIdentity,
      "object",
      "on POSIX, identity capture should ordinarily land within the real command's own lifetime"
    );
  });
});

test("acquireAsWorker -> acquireAsFloorJob: the floor-check command's own non-zero exit code is faithfully preserved, never swallowed", async () => {
  await withScratchDir("ghantika-cfl-nonzero-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const headSha = "deadbeef";
    await acquireAsWorker({ argv: successFixture(), headSha, lockPath });
    const floorResult = await acquireAsFloorJob({
      argv: [process.execPath, "-e", "process.exit(7)"],
      headSha,
      lockPath,
    });
    assert.equal(
      floorResult.exitCode,
      7,
      "must faithfully propagate the wrapped floor-check command's own exit code (e.g. VOID_EXIT_CODE=2), never remap it"
    );
  });
});

test("acquireAsWorker: refuses concurrently with itself - the second (in-process) invocation sees its own pid confirmed alive and refuses", async () => {
  await withScratchDir("ghantika-cfl-selfconcurrent-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const headSha = "deadbeef";
    // Write a "working" record naming THIS test process's own pid as
    // owner - genuinely, confirmably alive for the whole test.
    writeIdentityAtomic(lockPath, {
      phase: "working",
      ownerPid: process.pid,
      headSha,
      startedAt: new Date().toISOString(),
    });
    const result = await acquireAsWorker({ argv: successFixture(), headSha, lockPath });
    assert.equal(result.exitCode, 1);
    assert.equal(
      (readLockFile(lockPath) as Record<string, unknown>).phase,
      "working",
      "a refused acquisition must never touch the existing lock"
    );
  });
});

test("acquireAsWorker: reclaims a stale lock once the recorded owner is confirmed gone (via an injected identityCheck)", async () => {
  await withScratchDir("ghantika-cfl-reclaim-worker-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const headSha = "deadbeef";
    writeIdentityAtomic(lockPath, {
      phase: "working",
      ownerPid: 999999,
      ownerBirthIdentity: {
        platform: "posix-elapsed",
        capturedAtMs: 0,
        elapsedSecondsAtCapture: 0,
      },
      headSha: "STALE",
      startedAt: new Date(0).toISOString(),
    });
    const result = await acquireAsWorker({
      argv: successFixture(),
      headSha,
      lockPath,
      identityCheck: async () => ({ status: "not-found" }) as never,
    });
    assert.equal(result.exitCode, 0);
    assert.equal((readLockFile(lockPath) as Record<string, unknown>).headSha, headSha);
  });
});

test("acquireAsWorker: a corrupted lock file refuses with a clear diagnostic rather than crashing", async () => {
  await withScratchDir("ghantika-cfl-corrupted-worker-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    writeFileSync(lockPath, "{ not json");
    const result = await acquireAsWorker({ argv: successFixture(), headSha: "sha1", lockPath });
    assert.equal(result.exitCode, 1);
  });
});

test("acquireAsFloorJob: a corrupted primary lock file refuses with a clear diagnostic rather than crashing", async () => {
  await withScratchDir("ghantika-cfl-corrupted-floor-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    writeFileSync(lockPath, "{ not json");
    const result = await acquireAsFloorJob({ argv: successFixture(), headSha: "sha1", lockPath });
    assert.equal(result.exitCode, 1);
  });
});

// ===========================================================================
// The release-on-failure guard: RED then GREEN.
//
// A write inside the worker's own sequence is forced to throw AFTER a
// real, long-running child has already been spawned. `releaseFn` is the
// injected seam standing in for "the deadlock fix is/isn't wired up":
// disabled (a no-op) reproduces the pre-fix bug and must deadlock a
// SECOND, real invocation against a live-but-non-releasing owner (RED);
// the real, default releaseFn must let that same second invocation
// reclaim cleanly (GREEN). Both runs also confirm the spawned child is
// actually killed, independent of releaseFn - killBestEffort is called
// unconditionally on this path.
// ===========================================================================

function writeThatFailsOnCall(callNumberToFail: number) {
  let count = 0;
  return (lockPath: string, payload: unknown) => {
    count += 1;
    if (count === callNumberToFail) {
      throw new Error(`injected failure on write #${callNumberToFail}`);
    }
    writeIdentityAtomic(lockPath, payload);
  };
}

async function confirmPidGone(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH - confirmed gone
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`pid ${pid} was still alive ${2000}ms after the deadlock-fix's own kill attempt`);
}

test("release-on-failure guard [RED]: with releaseFn disabled, a write failure still kills the spawned child, but a second invocation deadlocks against the live-but-non-releasing owner", async () => {
  await withScratchDir("ghantika-cfl-deadlock-red-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const headSha = "deadbeef";
    let capturedChildPid: number | undefined;
    const spawnFn = (argv: string[], opts: unknown) => {
      const result = defaultSpawnTracked(argv, opts as never);
      capturedChildPid = result.child?.pid;
      return result;
    };

    const failingResult = await acquireAsWorker({
      argv: longRunningFixture(),
      headSha,
      lockPath,
      spawnFn,
      writeFn: writeThatFailsOnCall(2), // fails the workerPid write, after spawn
      releaseFn: () => {
        // Simulates the pre-fix design: cleanup never actually vacates
        // the lock.
      },
    });
    assert.equal(failingResult.exitCode, 1);

    // The child must be dead regardless of releaseFn - killing it is
    // unconditional, independent of the release step.
    await confirmPidGone(capturedChildPid);

    // The lock still shows THIS test process (the in-process "owner") as
    // alive, because releaseFn never ran - reproducing the deadlock a
    // pure-paper version of this design was found to have.
    const stillOnDisk = readLockFile(lockPath) as Record<string, unknown>;
    assert.equal(stillOnDisk.ownerPid, process.pid);

    const secondInvocation = await acquireAsWorker({ argv: successFixture(), headSha, lockPath });
    assert.equal(
      secondInvocation.exitCode,
      1,
      "RED: a second invocation must refuse against a live-but-non-releasing owner when the deadlock fix is disabled"
    );
  });
});

test("release-on-failure guard [GREEN]: with the real releaseFn, the same write failure kills the spawned child AND leaves the lock genuinely reclaimable by a subsequent invocation", async () => {
  await withScratchDir("ghantika-cfl-deadlock-green-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const headSha = "deadbeef";
    let capturedChildPid: number | undefined;
    const spawnFn = (argv: string[], opts: unknown) => {
      const result = defaultSpawnTracked(argv, opts as never);
      capturedChildPid = result.child?.pid;
      return result;
    };

    const failingResult = await acquireAsWorker({
      argv: longRunningFixture(),
      headSha,
      lockPath,
      spawnFn,
      writeFn: writeThatFailsOnCall(2), // the real releaseFn default is used here
    });
    assert.equal(failingResult.exitCode, 1);

    await confirmPidGone(capturedChildPid);

    assert.equal(
      readLockFile(lockPath),
      null,
      "the primary lock must be vacated by the real deadlock fix"
    );
    const sidecar = readLockFile(releasedSidecarPath(lockPath)) as Record<string, unknown>;
    assert.equal(sidecar.releaseReason, "worker-write-or-exit-failure");
    assert.ok(
      sidecar.failureDetail,
      "the released record should carry the reason it was abandoned"
    );

    const secondInvocation = await acquireAsWorker({ argv: successFixture(), headSha, lockPath });
    assert.equal(
      secondInvocation.exitCode,
      0,
      "GREEN: with the real fix, a second invocation must reclaim cleanly rather than deadlocking"
    );
    assert.equal((readLockFile(lockPath) as Record<string, unknown>).phase, "publishing");
  });
});

test("release-on-failure guard, floor-side variant [GREEN]: the same release-on-failure guarantee holds for acquireAsFloorJob's own write-A/write-4 failures", async () => {
  await withScratchDir("ghantika-cfl-deadlock-floor-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const headSha = "deadbeef";
    await acquireAsWorker({ argv: successFixture(), headSha, lockPath });

    let capturedChildPid: number | undefined;
    const spawnFn = (argv: string[], opts: unknown) => {
      const result = defaultSpawnTracked(argv, opts as never);
      capturedChildPid = result.child?.pid;
      return result;
    };

    const failingResult = await acquireAsFloorJob({
      argv: longRunningFixture(),
      headSha,
      lockPath,
      spawnFn,
      writeFn: writeThatFailsOnCall(1), // fails write A itself
    });
    assert.equal(failingResult.exitCode, 1);
    await confirmPidGone(capturedChildPid);
    assert.equal(readLockFile(lockPath), null);

    const secondInvocation = await acquireAsFloorJob({ argv: successFixture(), headSha, lockPath });
    assert.equal(
      secondInvocation.exitCode,
      1,
      "write A itself failed before floorJobPid ever persisted, so nothing new was recorded for the floor phase to hand off from - the correct refuse here is 'no-active-lock', not a hang"
    );
  });
});

test("release-on-failure guard, floor-side variant [RED]: with releaseFn disabled, acquireAsFloorJob's own write-A failure still kills the spawned child, but a subsequent acquireAsWorker deadlocks against the live-but-non-releasing owner", async () => {
  await withScratchDir("ghantika-cfl-deadlock-floor-red-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const headSha = "deadbeef";
    // Write 1 of this earlier, real acquireAsWorker call records ownerPid
    // as THIS TEST PROCESS itself - genuinely alive for the whole test,
    // exactly mirroring the release-on-failure guard [RED]'s own approach above.
    // ownerPid is the identity that matters for THIS scenario: unlike
    // floorJobPid (the failing floor job's own spawned child, killed
    // unconditionally below, independent of releaseFn), ownerPid is
    // carried forward UNTOUCHED by every write acquireAsFloorJob makes -
    // it is the one identity that stays alive throughout, and the one a
    // subsequent acquireAsWorker call actually consults first (see
    // isLockCurrentlyHeld's own docs).
    await acquireAsWorker({ argv: successFixture(), headSha, lockPath });

    let capturedChildPid: number | undefined;
    const spawnFn = (argv: string[], opts: unknown) => {
      const result = defaultSpawnTracked(argv, opts as never);
      capturedChildPid = result.child?.pid;
      return result;
    };

    const failingResult = await acquireAsFloorJob({
      argv: longRunningFixture(),
      headSha,
      lockPath,
      spawnFn,
      writeFn: writeThatFailsOnCall(1), // fails write A itself, after spawn
      releaseFn: () => {
        // Simulates the pre-fix design: cleanup never actually vacates the
        // lock - the same no-op the release-on-failure guard [RED] injects above.
      },
    });
    assert.equal(failingResult.exitCode, 1);

    // The floor job's own spawned child must be dead regardless of
    // releaseFn - killing it is unconditional, independent of the release
    // step, exactly as on the worker side.
    await confirmPidGone(capturedChildPid);

    // The lock still shows the ORIGINAL worker's own "publishing" record,
    // completely untouched: write A never landed (it was the failing
    // write) and releaseFn never ran to vacate anything either. ownerPid
    // still names this test process, genuinely alive.
    const stillOnDisk = readLockFile(lockPath) as Record<string, unknown>;
    assert.equal(stillOnDisk.phase, "publishing");
    assert.equal(stillOnDisk.ownerPid, process.pid);

    // THE CORRECT BLOCKING CHECK FOR THIS LOCK STATE: a second
    // acquireAsFloorJob would find phase "publishing" with a matching
    // headSha and simply proceed (classifyFloorAcquisition's own
    // "proceed-normal-handoff" case never inspects ownerPid's liveness at
    // all) - it is acquireAsWorker's own isLockCurrentlyHeld check that
    // consults ownerPid FIRST, unconditional on phase, and that is the one
    // that must refuse here: a brand-new coverage run cannot start while
    // this abandoned "publishing" record sits unreleased, reproducing the
    // deadlock a pure-paper version of this design was found to have - on
    // the floor side's own failure path this time, rather than the
    // worker's.
    const secondInvocation = await acquireAsWorker({ argv: successFixture(), headSha, lockPath });
    assert.equal(
      secondInvocation.exitCode,
      1,
      "RED: a second invocation must refuse against a live-but-non-releasing owner when the deadlock fix is disabled"
    );
  });
});

// ===========================================================================
// DEFENSE-IN-DEPTH: abandonOnFailure itself must never throw, no matter what
// a (deliberately injectable, future) custom releaseFn does - see this
// file's own module-level comment on the guard for the full reasoning.
// Never exercised by production code today (the shipped release() is
// already internally exception-safe), but the seam exists precisely so a
// future custom releaseFn cannot silently defeat the deadlock-fix guarantee.
// ===========================================================================

test("abandonOnFailure guard: acquireAsWorker never throws even when BOTH a write fails AND the injected releaseFn itself throws", async () => {
  await withScratchDir("ghantika-cfl-abandon-guard-worker-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const result = await acquireAsWorker({
      argv: successFixture(),
      headSha: "deadbeef",
      lockPath,
      writeFn: writeThatFailsOnCall(2), // fails the workerPid write, after spawn
      releaseFn: () => {
        throw new Error("injected releaseFn failure - must not escape abandonOnFailure");
      },
    });
    assert.equal(result.exitCode, 1, "the underlying failure must still be reported normally");
  });
});

test("abandonOnFailure guard: acquireAsFloorJob never throws even when BOTH a write fails AND the injected releaseFn itself throws", async () => {
  await withScratchDir("ghantika-cfl-abandon-guard-floor-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const headSha = "deadbeef";
    await acquireAsWorker({ argv: successFixture(), headSha, lockPath });
    const result = await acquireAsFloorJob({
      argv: longRunningFixture(),
      headSha,
      lockPath,
      writeFn: writeThatFailsOnCall(1), // fails write A itself, after spawn
      releaseFn: () => {
        throw new Error("injected releaseFn failure - must not escape abandonOnFailure");
      },
    });
    assert.equal(result.exitCode, 1, "the underlying failure must still be reported normally");
  });
});

// ===========================================================================
// Same-process stale-write regression: the same-process-writer / stale-snapshot bug.
//
// Constructs the exact interleaving window between write A and write B of
// acquireAsFloorJob's own floor-running transition, by holding
// `spawned.done` open with a manually-controlled deferred promise. With
// the injected buggy `composeIdentityWrite` (spreading from a STALE,
// earlier object instead of write A's own fresh snapshot), the on-disk
// state after write B has genuinely REGRESSED - losing floorJobPid and
// reverting phase - reproducing the historical bug this control exists to
// catch. With the real, default composeIdentityWrite, the same window
// shows no regression and correctly gains floorJobBirthIdentity.
// ===========================================================================

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("stale-write regression [buggy]: composeIdentityWrite spreading from a stale object REGRESSES write A's own fields at write B", async () => {
  await withScratchDir("ghantika-cfl-stale-buggy-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const headSha = "deadbeef";
    await acquireAsWorker({ argv: successFixture(), headSha, lockPath });
    const publishingSnapshot = readLockFile(lockPath) as Record<string, unknown>;

    const exitDeferred = deferred<{ code: number; signal: null; error: undefined }>();
    const spawnFn = () => ({
      child: { pid: 424242 } as never,
      spawnError: undefined,
      done: exitDeferred.promise,
    });
    const identity = {
      platform: "posix-elapsed" as const,
      capturedAtMs: 1,
      elapsedSecondsAtCapture: 0,
    };

    // THE HISTORICAL BUG, reproduced deliberately: spreads from
    // `publishingSnapshot` (write 3's OWN, now-stale snapshot from BEFORE
    // write A ever ran) instead of write A's own fresh snapshot the real
    // default correctly spreads from.
    const buggyCompose = (_writeASnapshot: Record<string, unknown>, birthIdentity: unknown) => ({
      ...publishingSnapshot,
      floorJobBirthIdentity: birthIdentity,
    });

    const acquirePromise = acquireAsFloorJob({
      argv: ["irrelevant"],
      headSha,
      lockPath,
      spawnFn,
      composeIdentityWrite: buggyCompose,
      captureChildIdentity: async () => identity,
    });

    // THE EXACT INTERLEAVING WINDOW: write A has landed, write B (via the
    // buggy compose) has landed, and the flow is now blocked awaiting
    // `spawned.done` - read the on-disk state right here, before write 4
    // or release ever run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterWriteB = readLockFile(lockPath) as Record<string, unknown>;

    assert.equal(
      afterWriteB.phase,
      "publishing",
      "REGRESSION: phase reverted from 'floor-running' back to write A's PREDECESSOR's own 'publishing' phase"
    );
    assert.equal(
      afterWriteB.floorJobPid,
      undefined,
      "REGRESSION: floorJobPid, set by write A, was lost entirely"
    );
    assert.deepEqual(
      afterWriteB.floorJobBirthIdentity,
      identity,
      "the identity itself IS present - the bug is specifically that everything else regressed around it"
    );

    exitDeferred.resolve({ code: 0, signal: null, error: undefined });
    await acquirePromise;
  });
});

test("stale-write regression [fixed]: the real, default composeIdentityWrite does NOT regress write A's own fields, and correctly gains floorJobBirthIdentity", async () => {
  await withScratchDir("ghantika-cfl-stale-fixed-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const headSha = "deadbeef";
    await acquireAsWorker({ argv: successFixture(), headSha, lockPath });
    // Captured directly off disk, BEFORE acquireAsFloorJob (the code path
    // under test) ever runs - the same way the adjacent [buggy] test above
    // captures its own `publishingSnapshot`, so this is a real,
    // independently-obtained record of everything the worker's own write 3
    // produced, never re-derived from acquireAsFloorJob's own internals.
    const publishingSnapshot = readLockFile(lockPath) as Record<string, unknown>;

    const exitDeferred = deferred<{ code: number; signal: null; error: undefined }>();
    const spawnFn = () => ({
      child: { pid: 424242 } as never,
      spawnError: undefined,
      done: exitDeferred.promise,
    });
    const identity = {
      platform: "posix-elapsed" as const,
      capturedAtMs: 1,
      elapsedSecondsAtCapture: 0,
    };
    // A fixed clock, injected so this test can independently PREDICT write
    // A's own floorRunningAt value below, rather than having to read it
    // back off the very record under test.
    const FIXED_NOW = 1_700_000_000_000;

    const acquirePromise = acquireAsFloorJob({
      argv: ["irrelevant"],
      headSha,
      lockPath,
      spawnFn,
      now: () => FIXED_NOW,
      captureChildIdentity: async () => identity,
      // composeIdentityWrite intentionally omitted - exercising the real,
      // production default.
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterWriteB = readLockFile(lockPath) as Record<string, unknown>;

    assert.equal(
      afterWriteB.phase,
      "floor-running",
      "must NOT regress - write A's own phase survives write B"
    );
    assert.equal(
      afterWriteB.floorJobPid,
      424242,
      "must NOT regress - write A's own floorJobPid survives write B"
    );
    assert.deepEqual(
      afterWriteB.floorJobBirthIdentity,
      identity,
      "must correctly GAIN the identity write B is responsible for"
    );
    assert.equal(
      afterWriteB.headSha,
      headSha,
      "everything carried forward from the worker's own publishing record must still be present too"
    );

    // THE STRENGTHENED CONTROL: a full deep-equality against an
    // independently-constructed expected object, never re-derived from
    // acquireAsFloorJob's own code path - this is what the four individual
    // field checks above cannot catch. Write A is documented (see this
    // module's own writeASnapshot comment) to add exactly `phase`,
    // `floorJobPid`, and `floorRunningAt` on top of everything carried
    // forward from the worker's own publishing record; write B is
    // documented to add exactly `floorJobBirthIdentity` on top of write
    // A's own snapshot. A differently-shaped staleness regression that
    // preserves phase/floorJobPid/floorJobBirthIdentity/headSha while
    // silently corrupting an UNCHECKED field (e.g. ownerBirthIdentity,
    // workerExitCode, or floorRunningAt itself) would pass every assertion
    // above and only be caught here.
    const expectedWriteASnapshot = {
      ...publishingSnapshot,
      phase: "floor-running",
      floorJobPid: 424242,
      floorRunningAt: new Date(FIXED_NOW).toISOString(),
    };
    const expectedAfterWriteB = { ...expectedWriteASnapshot, floorJobBirthIdentity: identity };
    assert.deepEqual(
      afterWriteB,
      expectedAfterWriteB,
      "afterWriteB must equal EXACTLY write A's own fields plus floorJobBirthIdentity - no field may be silently dropped, added, or altered by write B"
    );

    exitDeferred.resolve({ code: 0, signal: null, error: undefined });
    const result = await acquirePromise;
    assert.equal(result.exitCode, 0);
  });
});

test("negative control: a write-B failure never blocks write 4 / release, and never triggers the deadlock-fix abandon path", async () => {
  await withScratchDir("ghantika-cfl-stale-writeb-fails-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const headSha = "deadbeef";
    await acquireAsWorker({ argv: successFixture(), headSha, lockPath });

    const result = await acquireAsFloorJob({
      argv: successFixture(),
      headSha,
      lockPath,
      captureChildIdentity: async () => ({
        platform: "posix-elapsed",
        capturedAtMs: 0,
        elapsedSecondsAtCapture: 0,
      }),
      composeIdentityWrite: () => {
        throw new Error("write B compose deliberately throws");
      },
    });
    assert.equal(
      result.exitCode,
      0,
      "a write-B failure must be swallowed, never surfaced as an overall failure"
    );
    const sidecar = readLockFile(releasedSidecarPath(lockPath)) as Record<string, unknown>;
    assert.equal(
      sidecar.phase,
      "done",
      "write 4 must still run and reach done, exactly as if identity capture had simply not landed in time"
    );
    assert.equal(
      sidecar.floorJobBirthIdentity,
      undefined,
      "the identity never got embedded, which is the honest, disclosed consequence - never fabricated"
    );
  });
});

// ===========================================================================
// STALE-IDENTITY FIX: a reclaim of a "floor-running"/"done" lock record
// must not carry a PRIOR (now-dead) attempt's own floorJobBirthIdentity /
// floorJobExitCode into the NEW write-A record - see acquireAsFloorJob's
// own "STALE-IDENTITY FIX" comment above its reclaim branch for the full
// reasoning: left uncleared, a THIRD invocation checking the new,
// genuinely-live floorJobPid against the stale, unrelated identity would
// almost certainly observe identity-mismatch, which livenessBlocksAcquisition
// does NOT treat as blocking - letting it race a reclaim that just
// legitimately succeeded.
// ===========================================================================

test("STALE-IDENTITY FIX: reclaiming a 'done'-phase record carrying a real, prior floorJobBirthIdentity/floorJobExitCode does NOT carry either field into the NEW write-A record", async () => {
  await withScratchDir("ghantika-cfl-stale-identity-fix-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const headSha = "deadbeef";

    // A "done"-phase record left over from a PRIOR, now-confirmed-dead
    // floor-check attempt - carrying its OWN real floorJobBirthIdentity
    // (written by that prior attempt's own write B) AND floorJobExitCode
    // (since it reached "done" before this abandoned record was ever
    // cleaned up - e.g. a crash during the wrapped floor-check command's
    // own reporting step, after the real check-coverage-floor.mjs process
    // had already exited).
    const staleIdentity = {
      platform: "posix-elapsed" as const,
      capturedAtMs: 0,
      elapsedSecondsAtCapture: 0,
    };
    writeIdentityAtomic(lockPath, {
      phase: "done",
      ownerPid: 111111,
      headSha,
      floorJobPid: 222222,
      floorJobBirthIdentity: staleIdentity,
      floorJobExitCode: 0,
      floorRunningAt: new Date(0).toISOString(),
    });

    const exitDeferred = deferred<{ code: number | null; signal: null; error: undefined }>();
    const spawnFn = () => ({
      child: { pid: 333333 } as never,
      spawnError: undefined,
      done: exitDeferred.promise,
    });

    const acquirePromise = acquireAsFloorJob({
      argv: ["irrelevant"],
      headSha,
      lockPath,
      spawnFn,
      // The prior floorJobPid (222222) is confirmed genuinely dead - the
      // real trigger for classifyFloorAcquisition's own
      // "reclaim-check-needed" outcome to actually proceed as a reclaim.
      identityCheck: async () => ({ status: "not-found" }) as never,
      plainCheck: () => false,
      // This NEW attempt's own capture never lands within the test's own
      // window - isolates write A's own output from write B entirely, so
      // this test observes exactly (and only) what write A itself wrote.
      captureChildIdentity: async () => undefined,
    });

    // THE EXACT INTERLEAVING WINDOW: write A has landed, write B never ran
    // (identity capture above resolves undefined), and the flow is now
    // blocked awaiting spawned.done - read the on-disk state right here,
    // before write 4 or release ever run. Same technique the stale-write
    // regression control above uses to isolate its own write-A/write-B window.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterWriteA = readLockFile(lockPath) as Record<string, unknown>;

    assert.equal(
      afterWriteA.phase,
      "floor-running",
      "write A must have landed - this is the NEW attempt's own record"
    );
    assert.equal(
      afterWriteA.floorJobPid,
      333333,
      "write A must record the NEW attempt's own spawned child, never the stale one"
    );
    assert.ok(
      !("floorJobBirthIdentity" in afterWriteA),
      `THE FIX: the stale prior attempt's own floorJobBirthIdentity must not survive into write A's record (genuinely ABSENT, not merely falsy) - otherwise a later liveness check on this NEW, live floorJobPid would almost certainly report identity-mismatch, which livenessBlocksAcquisition does not treat as blocking. Got: ${JSON.stringify(afterWriteA.floorJobBirthIdentity)}, keys: ${JSON.stringify(Object.keys(afterWriteA))}`
    );
    assert.ok(
      !("floorJobExitCode" in afterWriteA),
      `THE FIX: the stale prior attempt's own floorJobExitCode must not survive into write A's record either (genuinely ABSENT, not merely falsy). Got: ${JSON.stringify(afterWriteA.floorJobExitCode)}, keys: ${JSON.stringify(Object.keys(afterWriteA))}`
    );

    exitDeferred.resolve({ code: 0, signal: null, error: undefined });
    const result = await acquirePromise;
    assert.equal(result.exitCode, 0);
  });
});

// ===========================================================================
// Exhaustiveness check: none of the three new source files
// registers a periodic write mechanism or a SIGTERM/SIGINT handler. This
// design's whole crash-safety guarantee rests on checking real OS process
// identity on demand, never on a background timer refreshing/faking
// liveness - a periodic-write mechanism would silently reintroduce exactly
// the kind of "trust our own bookkeeping" failure mode this file exists to
// avoid.
// ===========================================================================

/**
 * Extracts the balanced-parenthesis argument text of a call whose opening
 * `(` sits at `openParenIndex` - simple, deliberately non-AST text
 * scanning ("grep-style"), sufficient for this file's own tightly-scoped
 * source (no need to handle parens inside string literals/comments here,
 * since this scanner is only ever pointed at `setTimeout(` call sites in
 * source this test itself controls).
 */
function extractBalancedArgs(sourceText: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < sourceText.length; i++) {
    const ch = sourceText[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return sourceText.slice(openParenIndex + 1, i);
    }
  }
  throw new Error("extractBalancedArgs: unbalanced parentheses");
}

test("exhaustiveness check: none of coverage-floor-lock.mjs / the two wrapper scripts registers setInterval, a SIGTERM/SIGINT handler, or a self-rescheduling setTimeout", () => {
  for (const filePath of [LOCK_LIB_PATH, WORKER_WRAPPER_PATH, FLOOR_WRAPPER_PATH]) {
    const source = readFileSync(filePath, "utf8");
    const label = path.relative(REPO_ROOT, filePath);

    assert.ok(
      !source.includes("setInterval("),
      `${label} must never use setInterval - a periodic-write mechanism has no place in this crash-safe, PID-identity-based lock design`
    );
    assert.ok(
      !/process\.on\(\s*["']SIGTERM["']/.test(source),
      `${label} must never register a SIGTERM handler that could write to the lock path`
    );
    assert.ok(
      !/process\.on\(\s*["']SIGINT["']/.test(source),
      `${label} must never register a SIGINT handler that could write to the lock path`
    );

    // No setTimeout callback may itself schedule another setTimeout/
    // setInterval - the structural signature of a self-perpetuating
    // (periodic) timer, as opposed to this design's own legitimate,
    // one-shot, bounded poll/delay usage (killBestEffort's own grace-
    // period poll).
    for (const match of source.matchAll(/setTimeout\(/g)) {
      const openParenIndex = match.index! + match[0].length - 1;
      const args = extractBalancedArgs(source, openParenIndex);
      assert.ok(
        !/set(Timeout|Interval)\(/.test(args),
        `${label}: a setTimeout call site's own callback contains a nested setTimeout/setInterval - this looks like a self-rescheduling periodic timer, which this design must never have`
      );
    }
  }
});
