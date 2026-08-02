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
 * The shared body of the stranded-combined-degraded-kill scenario,
 * factored out so the real regression test below and its own
 * failure-safety control can drive the IDENTICAL setup - proving the
 * SAME `finally`-block cleanup actually runs on both a passing and a
 * deliberately-failing path, rather than only ever being exercised by the
 * success case. `pidOut` is populated with the resistant leader's real
 * pid the moment it is spawned, BEFORE any assertion below can throw, so
 * a caller can verify real cleanup even when this function itself
 * rejects.
 *
 * PROVES THE RETRY-SAFETY CONTRACT (`jobStore.reapProcessGroupOnce`'s own
 * "RETRY SAFETY" docs), end to end, through the real `kill()` handler and
 * a real, genuinely SIGTERM-resistant OS process - never an injected
 * spy: a SECOND `kill()` call against the same already-terminal,
 * combined-degraded job NEVER sends a further signal, however available
 * ps/pgrep have since become, because ownership continuity over the
 * tracked numeric pid is no longer guaranteed by then. So a group that is
 * STILL genuinely alive at that point stays unconfirmed (the negative
 * control below), while a group that has since genuinely emptied - by
 * some means entirely OUTSIDE this codebase's own retry, simulated here
 * with a raw external `process.kill` the test itself sends - IS correctly
 * recognized and confirmed by a THIRD call's existence-only re-check
 * (the legitimate-recovery control), still without this codebase ever
 * having sent that group a second signal.
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
    // is already restored). NEGATIVE CONTROL FOR THE RETRY-SAFETY
    // CONTRACT: `hasReapBeenAttempted` is still false (the first call's
    // outcome was UNCONFIRMED, never marked), so `reapProcessGroupOnce`
    // genuinely re-consults - but by the fail-closed retry-safety
    // contract, ownership continuity over the tracked numeric pid is no
    // longer guaranteed at this point, so it re-checks EXISTENCE ONLY and
    // never signals again. The real process is STILL genuinely alive
    // (this fixture ignores SIGTERM and neither call above ever reached
    // it), so that existence check correctly reports "still alive" -
    // proving this codebase never sent it a further signal, whether or
    // not it could have.
    const secondResult = await killTool.handler({ job_id: record.job_id });
    assert.notEqual(
      secondResult.isError,
      true,
      `expected the second kill() to succeed: ${JSON.stringify(secondResult)}`
    );
    const secondStructured = secondResult.structuredContent as Record<string, unknown>;
    assert.equal(
      secondStructured.kill_confirmed,
      false,
      `expected the second call to STAY unconfirmed - the retry must never signal again, so a genuinely-still-alive group correctly reads as still unconfirmed rather than being finished off by a second signal - got: ${JSON.stringify(secondStructured)}`
    );
    assert.equal(
      isProcessAlive(child!.pid!),
      true,
      "expected the real resistant process to have SURVIVED the second call too - proving no second signal ever reached it, even though ps/pgrep were genuinely available this time"
    );

    // Now make the group ACTUALLY empty, by a means entirely OUTSIDE this
    // codebase's own retry (a raw external SIGKILL the test itself
    // sends) - simulating whatever eventually ends a real stranded
    // group in production (an operator's own out-of-band kill, the host
    // reclaiming the process, etc.), never this codebase's own kill()
    // tool signaling it again.
    process.kill(-child!.pid!, "SIGKILL");
    const externallyGone = await waitForProcessGroupGone(child!.pid!);
    assert.equal(
      externallyGone,
      true,
      "expected the external SIGKILL (sent by this test, not by kill()) to have actually ended the real process group"
    );

    // THIRD call, same job_id: LEGITIMATE RECOVERY CONTROL, the
    // counterpart to the negative control above. The retry's own
    // existence-only re-check now correctly observes the group is
    // genuinely gone and confirms it - real recovery, through the real
    // `kill()` handler, still without this codebase ever having sent
    // that group a second signal of its own.
    const thirdResult = await killTool.handler({ job_id: record.job_id });
    assert.notEqual(
      thirdResult.isError,
      true,
      `expected the third kill() to succeed: ${JSON.stringify(thirdResult)}`
    );
    const thirdStructured = thirdResult.structuredContent as Record<string, unknown>;
    assert.equal(
      thirdStructured.kill_confirmed,
      true,
      `expected the third call to confirm the now-genuinely-empty group via its existence-only re-check - got: ${JSON.stringify(thirdStructured)}`
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
