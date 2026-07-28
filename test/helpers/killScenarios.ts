/**
 * Shared by test/kill.test.ts (its own "CONTROL" test) and
 * test/kill-slow-paths.test.ts (the STRANDED RETRY test itself) - moved out
 * of kill.test.ts so both files can drive the identical scenario without
 * one test file importing from another test file. Importing a `*.test.ts`
 * module re-executes and re-registers every `test()` call inside it as a
 * side effect of module evaluation - node:test's registration is global and
 * triggered by module load, not by "being the entry file" - so a shared
 * dependency two test files both need has to live outside any `*.test.ts`
 * file. Not itself a `*.test.ts` file, so it is never discovered as a suite
 * of its own - mirrors test/helpers/spawnServer.ts's identical pattern.
 */
import assert from "node:assert/strict";

import * as killTool from "../../dist/tools/kill.js";
import { jobStore } from "../../dist/jobStore.js";
import { isProcessAlive, isProcessGroupAlive, spawnManaged } from "../../dist/process.js";

/** Waits for `child`'s stdout to contain `marker` - a small local helper matching the pattern already used inline throughout test/kill.test.ts's own resistant-process tests. */
export async function waitForStdout(
  child: ReturnType<typeof spawnManaged>,
  marker: string
): Promise<void> {
  let buffer = "";
  child!.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
  });
  const deadline = Date.now() + 5000;
  while (!buffer.includes(marker)) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for stdout to include "${marker}"`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Polls a REAL process-table lookup - never an assumption - until neither
 * the leader pid nor its whole process GROUP is alive, or `timeoutMs`
 * elapses. Shared by the scenario below's own `finally`-block cleanup and
 * by its failure-safety control's independent re-check.
 */
async function waitForProcessGroupGone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid) && !isProcessGroupAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isProcessAlive(pid) && !isProcessGroupAlive(pid);
}

/**
 * The shared body of the stranded-combined-degraded-kill-is-retryable
 * scenario, factored out so the real regression test below and its own
 * failure-safety control can drive the IDENTICAL setup - proving the
 * SAME `finally`-block cleanup actually runs on both a passing and a
 * deliberately-failing path, rather than only ever being exercised by the
 * success case. `pidOut` is populated with the resistant leader's real
 * pid the moment it is spawned, BEFORE any assertion below can throw, so
 * a caller can verify real cleanup even when this function itself
 * rejects.
 *
 * `forceFailureAfterSpawn`, when set, throws immediately after the
 * resistant process is confirmed alive and attached, before either
 * kill() call ever runs - simulating a partial-setup/assertion failure
 * at the earliest realistic point one could occur, and proving the
 * leader and its group are still torn down even though nothing below
 * that point ever executed.
 */
export async function runStrandedRetryScenario(
  pidOut: { pid?: number },
  options: { readonly forceFailureAfterSpawn?: boolean } = {}
): Promise<void> {
  const realPath = process.env.PATH;
  const record = jobStore.createJob({
    argv: ["sleep", "10"],
    cwd: process.cwd(),
    env: { PATH: realPath ?? "/usr/bin:/bin" },
    isShell: false,
  });
  // The identical SIGTERM-resistant real-process fixture the combined-
  // degraded-cell test above builds - ignores SIGTERM entirely, so a
  // phased kill() genuinely reaches the escalation gate rather than the
  // group dying from SIGTERM alone.
  const child = spawnManaged(
    {
      argv: [
        "node",
        "-e",
        "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
      ],
      cwd: process.cwd(),
      env: { PATH: realPath ?? "/usr/bin:/bin" },
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
  // Tracked from the moment the real process exists - BEFORE any
  // assertion below has a chance to throw - so this scenario's own
  // `finally` block (and, for the control, an external re-check) can
  // always find and clean it up, on every exit path.
  pidOut.pid = child!.pid!;

  try {
    // Same pre-signal-identity degraded cell the combined-degraded-cell
    // test above uses: attach with NO birth identity at all, so the
    // pre-signal gate can never confirm anything either.
    jobStore.attachChild(record.job_id, child!);
    await waitForStdout(child!, "ready");

    assert.equal(
      isProcessAlive(child!.pid!),
      true,
      "expected the real resistant process to be alive before the first kill()"
    );

    if (options.forceFailureAfterSpawn) {
      throw new Error(
        "STRANDED-RETRY CONTROL - deliberate mid-scenario failure, forced right after the resistant process was confirmed alive and attached, before either kill() call ever ran"
      );
    }

    // FIRST call: ps/pgrep unavailable for the WHOLE call - the exact
    // combined-degraded scenario proven above ends unconfirmed. PATH is
    // restored again immediately after (BEFORE the second call below),
    // so the second call's own identity gate can genuinely observe the
    // real process table this time.
    process.env.PATH = "/tmp/does-not-exist-ghantika-empty-path-dir-stranded-retry";
    let firstResult: Awaited<ReturnType<typeof killTool.handler>>;
    try {
      firstResult = await killTool.handler({ job_id: record.job_id });
    } finally {
      process.env.PATH = realPath;
    }

    assert.notEqual(
      firstResult.isError,
      true,
      `expected the first kill() to succeed: ${JSON.stringify(firstResult)}`
    );
    const firstStructured = firstResult.structuredContent as Record<string, unknown>;
    assert.equal(firstStructured.state, "killed");
    assert.equal(
      firstStructured.kill_confirmed,
      false,
      "expected the first call to leave kill_confirmed false - the group was never actually confirmed reaped"
    );
    assert.equal(firstStructured.identity_confirmed, false);
    assert.equal(
      typeof firstStructured.escalation_refused_reason,
      "string",
      "expected the first call to disclose an escalation refusal, exactly like the combined-degraded scenario above"
    );
    assert.equal(
      isProcessAlive(child!.pid!),
      true,
      "expected the real resistant process to have SURVIVED the first call - this is the stranding the combined-degraded scenario documents"
    );

    // SECOND call, same job_id, real ps/pgrep available this time (PATH
    // is already restored). THE ACTUAL REGRESSION PROOF: with the old
    // code, the first call's `markReapAttempted` ran unconditionally
    // BEFORE `killProcessGroupPosix` ever ran, so `hasReapBeenAttempted`
    // was already permanently `true` by the time this second call's
    // terminal-job branch reaches `reapProcessGroupOnce` - which would
    // then be a pure no-op regardless of whether the group is genuinely
    // still alive, leaving this real process stranded forever. With the
    // fix, the first call's UNCONFIRMED outcome left that flag unset, so
    // this second call's `reapProcessGroupOnce` finds `hasReapBeenAttempted`
    // still false, runs a FRESH escalation identity gate, and can
    // genuinely signal/reap the group for real this time.
    const secondResult = await killTool.handler({ job_id: record.job_id });
    assert.notEqual(
      secondResult.isError,
      true,
      `expected the second kill() to succeed: ${JSON.stringify(secondResult)}`
    );
    const secondStructured = secondResult.structuredContent as Record<string, unknown>;

    // THE OBSERVABLE DIFFERENCE FROM THE FIRST CALL: this call's own
    // external confirmation now reads true - a real, additional signal
    // reached this genuinely-still-alive group and actually finished it
    // off, rather than the flag having simply been inspected and left
    // alone.
    assert.equal(
      secondStructured.kill_confirmed,
      true,
      `expected the second call to actually confirm the group reaped this time (a fresh identity gate genuinely ran and signaled it) - got: ${JSON.stringify(secondStructured)}`
    );

    // The real, resistant process must actually be dead now - polled,
    // since SIGKILL delivery and OS-level reaping are asynchronous
    // relative to the call that sent it (the same real gap this
    // codebase's own SIGKILL_CONFIRMATION_TIMEOUT_MS closes elsewhere).
    const gone = await waitForProcessGroupGone(child!.pid!);
    assert.equal(
      gone,
      true,
      "expected the real resistant process to have actually been killed by the SECOND call - the first call left it stranded, and only a genuine retry (not merely re-checking an already-tripped flag) can end it"
    );
  } finally {
    // Every partially-created resource this scenario sets up is torn
    // down here regardless of how the try block above exits - the
    // success path (where the second kill() call already finished the
    // real process off), an assertion failure anywhere above, or the
    // deliberate CONTROL failure. A bare best-effort signal alone is not
    // enough (see this function's own docs): both the leader AND the
    // whole process GROUP are confirmed ABSENT via a REAL process-table
    // lookup (`isProcessAlive`/`isProcessGroupAlive`), never merely
    // inferred from "a signal was sent".
    try {
      process.kill(-child!.pid!, "SIGKILL");
    } catch {
      // Already gone (ESRCH) - nothing left to signal, not a failure.
    }
    const reallyGone = await waitForProcessGroupGone(child!.pid!);
    assert.equal(
      reallyGone,
      true,
      `expected the resistant leader and its whole process group to be genuinely ABSENT after this scenario's own cleanup (pid ${child!.pid}), verified via a real process-table lookup - not merely assumed from a signal having been sent`
    );
  }
}
