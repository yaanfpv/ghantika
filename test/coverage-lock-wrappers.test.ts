/**
 * End-to-end tests of scripts/coverage-lock-worker-wrapper.mjs and
 * scripts/coverage-lock-floor-wrapper.mjs, run as REAL, separate child
 * processes - mirroring exactly what .github/workflows/ci.yml's
 * "coverage" job does across its own two separate steps ("npm run
 * coverage" then "npm run check:coverage-floor"). Each test here spawns
 * real `node` processes wrapping small, real, throwaway fixture commands
 * (never the actual, heavy c8/full-test-suite invocation - that real,
 * unwrapped-fixture confirmation is done manually, once, as this story's
 * own "before you finish" verification pass, since running the real
 * coverage command from inside the automated suite it is itself part of
 * would be both slow and recursive).
 *
 * The lock module's own unit tests, its two required deadlock/stale-
 * snapshot controls, and its exhaustiveness assertion all live in
 * test/coverage-floor-lock.test.ts instead, driven in-process against
 * `acquireAsWorker`/`acquireAsFloorJob` directly with injected
 * dependencies - see that file's own header for why.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readGitHeadSha } from "../scripts/check-sha-parity.mjs";
import {
  readLockFile,
  releasedSidecarPath,
  writeIdentityAtomic,
} from "../scripts/lib/coverage-floor-lock.mjs";
// Imports the BUILT output, not src/ directly - see
// test/status-process-identity.test.ts's own identical import comment.
import { captureBirthIdentityPosix } from "../dist/process.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKER_WRAPPER_PATH = fileURLToPath(
  new URL("../scripts/coverage-lock-worker-wrapper.mjs", import.meta.url)
);
const FLOOR_WRAPPER_PATH = fileURLToPath(
  new URL("../scripts/coverage-lock-floor-wrapper.mjs", import.meta.url)
);

/**
 * Runs `fn(dir)` against a fresh scratch directory, removing it afterward.
 * Handles both a synchronous `fn` and an async one correctly - see
 * test/coverage-floor-lock.test.ts's own identical helper for why a naive
 * `try { return fn(dir); } finally { rmSync(...) }` is wrong for an async
 * `fn` (it deletes the directory the instant `fn` hits its own first
 * `await`, not once `fn`'s real work is done).
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

/**
 * Runs one of the two real wrapper CLIs as a real child process, wrapping
 * `wrappedCommand` (everything after its own `--`). Never lets a non-zero
 * exit throw past this helper - mirrors test/check-coverage-floor.test.js's
 * own runCliAgainstFixture helper.
 */
function runWrapper(
  wrapperPath: string,
  wrappedCommand: string[],
  { lockPath, extraEnv = {} }: { lockPath: string; extraEnv?: Record<string, string> }
): { status: number; output: string } {
  const env = { ...process.env, GHANTIKA_COVERAGE_FLOOR_LOCK_PATH: lockPath, ...extraEnv };
  try {
    const output = execFileSync(process.execPath, [wrapperPath, "--", ...wrappedCommand], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      output: (e.stdout ?? "") + (e.stderr ?? ""),
    };
  }
}

function successFixture(): string[] {
  return [process.execPath, "-e", "process.exit(0)"];
}

function fixtureWithSentinel(sentinelPath: string, exitCode = 0): string[] {
  return [
    process.execPath,
    "-e",
    `require("fs").writeFileSync(${JSON.stringify(sentinelPath)}, "ran"); process.exit(${exitCode});`,
  ];
}

// ===========================================================================
// Argv wiring - the CLI entrypoints themselves, in isolation.
// ===========================================================================

test("coverage-lock-worker-wrapper: refuses with a clear message and exit 1 when invoked with no `--`", () => {
  const { status, output } = (() => {
    try {
      const out = execFileSync(process.execPath, [WORKER_WRAPPER_PATH], { encoding: "utf8" });
      return { status: 0, output: out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: (e.stdout ?? "") + (e.stderr ?? "") };
    }
  })();
  assert.notEqual(status, 0);
  assert.ok(output.includes("--"), output);
});

test("coverage-lock-floor-wrapper: refuses with a clear message and exit 1 when invoked with no `--`", () => {
  const { status, output } = (() => {
    try {
      const out = execFileSync(process.execPath, [FLOOR_WRAPPER_PATH], { encoding: "utf8" });
      return { status: 0, output: out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: (e.stdout ?? "") + (e.stderr ?? "") };
    }
  })();
  assert.notEqual(status, 0);
  assert.ok(output.includes("--"), output);
});

// ===========================================================================
// REQUIRED CONTROL 4: the end-to-end handoff, across two real, separate
// child processes, pointed at the same lock path and the same real head
// SHA - exactly mirroring the CI shape.
// ===========================================================================

test("REQUIRED CONTROL 4: worker wrapper (real child) -> floor wrapper (real, SEPARATE child) - the full handoff, ending done + released", () => {
  withScratchDir("ghantika-clw-e2e-", (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const realHeadSha = readGitHeadSha();

    const workerRun = runWrapper(WORKER_WRAPPER_PATH, successFixture(), { lockPath });
    assert.equal(workerRun.status, 0, workerRun.output);
    const midway = readLockFile(lockPath) as Record<string, unknown>;
    assert.equal(midway.phase, "publishing");
    assert.equal(midway.headSha, realHeadSha);
    assert.equal(midway.workerExitCode, 0);

    // A genuinely SEPARATE process (execFileSync, not an in-process call)
    // reading its OWN, independently-computed real head SHA - proving the
    // handoff works with no shared in-memory state between the two steps
    // whatsoever, exactly as CI's own two workflow steps have none.
    const floorRun = runWrapper(FLOOR_WRAPPER_PATH, successFixture(), { lockPath });
    assert.equal(floorRun.status, 0, floorRun.output);
    assert.equal(existsSync(lockPath), false, "the primary lock must be gone once released");
    const finalRecord = readLockFile(releasedSidecarPath(lockPath)) as Record<string, unknown>;
    assert.equal(finalRecord.phase, "done");
    assert.equal(finalRecord.floorJobExitCode, 0);
    assert.equal(finalRecord.headSha, realHeadSha);
  });
});

test("REQUIRED CONTROL 4: the floor-check command's own real exit code is faithfully propagated by the real floor wrapper process", () => {
  withScratchDir("ghantika-clw-e2e-exitcode-", (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const workerRun = runWrapper(WORKER_WRAPPER_PATH, successFixture(), { lockPath });
    assert.equal(workerRun.status, 0, workerRun.output);

    const floorRun = runWrapper(FLOOR_WRAPPER_PATH, [process.execPath, "-e", "process.exit(2)"], {
      lockPath,
    });
    assert.equal(
      floorRun.status,
      2,
      "must faithfully propagate the wrapped command's own exit code, e.g. check-coverage-floor.mjs's VOID_EXIT_CODE"
    );
  });
});

test("REQUIRED CONTROL 4 [REFUSE]: a headSha mismatch refuses with a non-zero exit and never runs the wrapped floor-check command at all", () => {
  withScratchDir("ghantika-clw-e2e-shamismatch-", (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const sentinelPath = path.join(dir, "ran.sentinel");
    writeIdentityAtomic(lockPath, {
      phase: "publishing",
      ownerPid: 999999,
      headSha: "0000000000000000000000000000000000000000",
      startedAt: new Date().toISOString(),
      workerExitCode: 0,
    });

    const floorRun = runWrapper(FLOOR_WRAPPER_PATH, fixtureWithSentinel(sentinelPath), {
      lockPath,
    });
    assert.notEqual(floorRun.status, 0);
    assert.ok(floorRun.output.includes("head-sha-mismatch"), floorRun.output);
    assert.equal(
      existsSync(sentinelPath),
      false,
      "the wrapped floor-check command must never have been spawned at all"
    );
  });
});

test('REQUIRED CONTROL 4 [REFUSE]: phase "working" (the worker step never finished) refuses with a non-zero exit and never runs the wrapped floor-check command', () => {
  withScratchDir("ghantika-clw-e2e-neverfinished-", (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const sentinelPath = path.join(dir, "ran.sentinel");
    const realHeadSha = readGitHeadSha();
    writeIdentityAtomic(lockPath, {
      phase: "working",
      ownerPid: 999999,
      headSha: realHeadSha,
      startedAt: new Date().toISOString(),
    });

    const floorRun = runWrapper(FLOOR_WRAPPER_PATH, fixtureWithSentinel(sentinelPath), {
      lockPath,
    });
    assert.notEqual(floorRun.status, 0);
    assert.ok(floorRun.output.includes("worker-never-finished"), floorRun.output);
    assert.equal(
      existsSync(sentinelPath),
      false,
      "the wrapped floor-check command must never have been spawned at all"
    );
    assert.equal(
      (readLockFile(lockPath) as Record<string, unknown>).phase,
      "working",
      "a refused acquisition must never touch the existing lock"
    );
  });
});

test("REQUIRED CONTROL 4 [REFUSE]: no lock file at all refuses with a non-zero exit and never runs the wrapped floor-check command", () => {
  withScratchDir("ghantika-clw-e2e-nolock-", (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const sentinelPath = path.join(dir, "ran.sentinel");

    const floorRun = runWrapper(FLOOR_WRAPPER_PATH, fixtureWithSentinel(sentinelPath), {
      lockPath,
    });
    assert.notEqual(floorRun.status, 0);
    assert.ok(floorRun.output.includes("no-active-lock"), floorRun.output);
    assert.equal(existsSync(sentinelPath), false);
  });
});

// ===========================================================================
// A genuinely LIVE concurrent worker (a real, separately-run child process
// still alive) refuses a second, real worker-wrapper invocation.
// ===========================================================================

test("worker wrapper (real child) refuses concurrently with a REAL, still-alive prior worker process", async () => {
  await withScratchDir("ghantika-clw-e2e-liveworker-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const realHeadSha = readGitHeadSha();

    // A real, still-running process this test controls directly (not via
    // either wrapper), standing in for "a worker mid-flight".
    const { spawn } = await import("node:child_process");
    const liveChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      liveChild.once("spawn", () => resolve());
      liveChild.once("error", reject);
    });
    try {
      const identity = captureBirthIdentityPosix(liveChild.pid!);
      writeIdentityAtomic(lockPath, {
        phase: "working",
        ownerPid: liveChild.pid,
        ownerBirthIdentity: identity,
        headSha: realHeadSha,
        startedAt: new Date().toISOString(),
      });

      const workerRun = runWrapper(WORKER_WRAPPER_PATH, successFixture(), { lockPath });
      assert.notEqual(
        workerRun.status,
        0,
        "a real, still-alive owner must block a second worker invocation"
      );
      assert.equal((readLockFile(lockPath) as Record<string, unknown>).phase, "working");
    } finally {
      liveChild.kill("SIGKILL");
    }
  });
});

test("worker wrapper (real child) RECLAIMS once the prior worker's real process is genuinely dead (SIGKILL, confirmed via real OS process identity)", async () => {
  await withScratchDir("ghantika-clw-e2e-crashreclaim-", async (dir) => {
    const lockPath = path.join(dir, "lock.json");
    const realHeadSha = readGitHeadSha();

    const { spawn } = await import("node:child_process");
    const crashedChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      crashedChild.once("spawn", () => resolve());
      crashedChild.once("error", reject);
    });
    const crashedPid = crashedChild.pid!;
    const identity = captureBirthIdentityPosix(crashedPid);
    writeIdentityAtomic(lockPath, {
      phase: "working",
      ownerPid: crashedPid,
      ownerBirthIdentity: identity,
      headSha: realHeadSha,
      startedAt: new Date().toISOString(),
    });

    // Confirm the pre-crash refusal first - otherwise a reclaim succeeding
    // here would prove nothing (it could just as easily have proceeded
    // regardless of liveness).
    const beforeCrash = runWrapper(WORKER_WRAPPER_PATH, successFixture(), { lockPath });
    assert.notEqual(
      beforeCrash.status,
      0,
      "setup check: must genuinely refuse while the owner is alive"
    );

    // Simulate the real crash - an external SIGKILL, exactly the kind of
    // termination that leaves no chance for graceful cleanup.
    crashedChild.kill("SIGKILL");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        process.kill(crashedPid, 0);
      } catch {
        break; // confirmed gone
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    try {
      process.kill(crashedPid, 0);
      assert.fail(`setup check: pid ${crashedPid} was still alive ${3000}ms after SIGKILL`);
    } catch {
      // expected - genuinely gone
    }

    const afterCrash = runWrapper(WORKER_WRAPPER_PATH, successFixture(), { lockPath });
    assert.equal(
      afterCrash.status,
      0,
      `must reclaim once the OS confirms the prior owner is genuinely dead; output:\n${afterCrash.output}`
    );
    assert.equal((readLockFile(lockPath) as Record<string, unknown>).phase, "publishing");
  });
});
