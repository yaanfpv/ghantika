/**
 * The subset of test/process.test.ts's own cases that are slow by design,
 * not by accident: each proves a real caller-side settlement bound holds
 * against a genuinely resistant or hung `ps`/`pgrep` observer, or that two
 * sequential budgeted phases each get their own fresh allowance. Moved into
 * their own file purely so the file-level timeout this test runner enforces
 * has room for both this file's genuinely slow cases and process.test.ts's
 * much larger set of fast ones - no assertion, fixture, or behavior changed
 * by the move itself. See process.test.ts's own header for the full suite's
 * scope; this file is not a separate concern, just a separate timing budget.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { waitForFile } from "./harness.ts";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import { buildChildEnv, spawnManaged } from "../dist/process.js";
import {
  captureBirthIdentityPosixAsync,
  captureEscalationIdentitySnapshot,
  confirmProcessGroupReapedPosix,
  evaluateEscalationIdentityGate,
  readPidStartTimesBatchPosix,
} from "../dist/process.js";

/**
 * The caller-side settlement bound this file's own SIGTERM-resistant
 * observer tests (a fake `ps`/`pgrep` on PATH that traps SIGTERM, writes a
 * marker, then sleeps) pass to the function under test - shared by all
 * four of them so a future retune changes one number, not four.
 *
 * ROOT-CAUSE HISTORY: this used to be a much tighter 1000ms, chosen only
 * to keep a single test fast in isolation. That was tight enough to lose
 * a REAL scheduling race under genuine concurrent load: the caller-side
 * force-reap timer that ends this bound (`bound + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS`
 * - see `src/process.ts`'s own docs on that constant) fires strictly on
 * WALL-CLOCK time from the moment the call starts, completely independent
 * of whether the freshly forked resistant script has actually been
 * SCHEDULED to run its own first instruction yet. Reproduced directly (not
 * merely inferred): running six concurrent copies of this whole file
 * under `node --test` reliably starved every one of these four fixtures
 * of CPU time long enough that the old 1000ms bound elapsed, and the
 * caller-side timer SIGKILLed the fake observer, BEFORE it had ever been
 * scheduled to execute even its own `trap` line - the marker file the
 * test later waits for was consequently never written at all (confirmed
 * by inspecting the fixture's own scratch directory afterward: the `ps`/
 * `pgrep` script was present, `observer-pid.txt` was not), so the
 * subsequent `waitForFile` call could only ever time out. Widening this
 * bound (and the resistant script's own sleep duration alongside it, so
 * the script doesn't just finish naturally before the wider bound
 * elapses) leaves comfortably more real wall-clock room for the fork/exec
 * itself to actually happen before this codebase's own force-reap timer
 * fires - verified stable by re-running that same six-way concurrent
 * reproduction repeatedly at this widened value with zero failures, where
 * the old value failed on every single attempt.
 */
const RESISTANT_OBSERVER_BOUND_MS = 4000;
/** Must comfortably outlast `RESISTANT_OBSERVER_BOUND_MS + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS` so the fixture is still genuinely running (and thus still resistant) when this codebase's own force-reap timer fires, rather than having already exited naturally on its own schedule. */
const RESISTANT_OBSERVER_SLEEP_SECONDS = 12;
/** The generous upper bound this file's own resistant-observer tests assert the call settles within - comfortably above `RESISTANT_OBSERVER_BOUND_MS` plus its own settlement grace, comfortably below `RESISTANT_OBSERVER_SLEEP_SECONDS * 1000`. */
const RESISTANT_OBSERVER_ELAPSED_ASSERTION_MS = 6000;

// Not shared via import from test/process.test.ts (importing a *.test.ts
// module re-runs and re-registers all of its own test() calls as a side
// effect of module evaluation - see test/helpers/killScenarios.ts's header
// for the full explanation of the same issue on the kill.test.ts split) -
// duplicated here verbatim rather than moved, since process.test.ts's own
// copies of these are staying in place, used by many other tests there.

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

test(
  "captureBirthIdentityPosixAsync: a SIGTERM-RESISTANT ps observer (installs a handler and ignores it) still settles within this codebase's own bound, does not block the event loop while doing so, and is genuinely gone afterward - not merely a slow-but-cooperative child",
  {
    skip:
      process.platform === "win32"
        ? "shadows a resistant ps on PATH and traps SIGTERM in a real shell, POSIX-only"
        : false,
  },
  async () => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-resistant-ps-"));
    const psPath = path.join(dir, "ps");
    const markerPath = path.join(dir, "observer-pid.txt");
    // Traps SIGTERM to a no-op FIRST, as literally this shell's first
    // instruction (the resistance execFile's own `timeout` option cannot
    // overcome - see this file's own docs for why a request-only signal is
    // not a settlement bound) - installing the trap before anything else
    // closes a real race: under real scheduling load, a freshly exec'd
    // shell can take longer than a short bound to even reach its second
    // line, and a script that wrote its marker or echoed anything before
    // trapping was observed (empirically, via repeated timing trials, not
    // assumed) to sometimes still be terminated by the ordinary SIGTERM
    // instead of ever exercising the resistant path this test means to
    // prove. THEN writes its own real pid (so this test can prove it is
    // actually gone afterward), THEN sleeps far longer than the bound this
    // test passes - if this codebase's own force-reap didn't SIGKILL it
    // directly, this process would still be alive and this promise would
    // still be unsettled by the time this test's own assertions run. See
    // `RESISTANT_OBSERVER_BOUND_MS`'s own docs above for why this sleep
    // duration and the bound below are what they are, not the tighter
    // values this file used to use.
    fs.writeFileSync(
      psPath,
      `#!/bin/sh\ntrap '' TERM\necho $$ > '${markerPath}'\nsleep ${RESISTANT_OBSERVER_SLEEP_SECONDS}\necho '00:00'\n`
    );
    fs.chmodSync(psPath, 0o755);

    let eventLoopTicks = 0;
    const ticker = setInterval(() => {
      eventLoopTicks += 1;
    }, 5);

    let identity: Awaited<ReturnType<typeof captureBirthIdentityPosixAsync>>;
    let elapsedMs: number;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      const before = Date.now();
      identity = await captureBirthIdentityPosixAsync(process.pid, RESISTANT_OBSERVER_BOUND_MS);
      elapsedMs = Date.now() - before;
    } finally {
      process.env.PATH = realPath;
      clearInterval(ticker);
    }

    assert.equal(
      identity,
      undefined,
      "a resistant ps must still resolve to undefined (unavailable) via this codebase's own settlement bound, never fabricate a value"
    );
    assert.ok(
      elapsedMs < RESISTANT_OBSERVER_ELAPSED_ASSERTION_MS,
      `expected this codebase's OWN caller-side timer to force settlement well before the resistant ps's own long sleep - took ${elapsedMs}ms`
    );
    // THE assertion that actually tests the product's non-blocking promise,
    // not merely this call's own latency: an independent timer scheduled
    // on the SAME event loop must have kept firing WHILE this call was
    // still pending. A synchronous, blocking implementation would have
    // starved this timer for the whole span instead.
    assert.ok(
      eventLoopTicks >= 10,
      `expected an independent event-loop timer to keep firing while the resistant observer was pending (proves the single Node event loop was never blocked) - only saw ${eventLoopTicks} ticks in ${elapsedMs}ms`
    );

    const observerPidText = await waitForFile(markerPath, {
      until: (content) => /^\d+\s*$/.test(content.trim()),
    });
    const observerPid = Number(observerPidText.trim());
    assert.ok(
      Number.isInteger(observerPid) && observerPid > 0,
      `expected the resistant observer to have self-reported a real pid, got: ${JSON.stringify(observerPidText)}`
    );
    // SIGKILL delivery and OS-level reaping are asynchronous relative to
    // the `kill()` call that sent it (the same real async gap this
    // codebase's own `SIGKILL_CONFIRMATION_TIMEOUT_MS` closes elsewhere) -
    // polls rather than checking once immediately, so this assertion
    // reflects the real outcome and not a race against that gap.
    const goneDeadline = Date.now() + 2000;
    let stillAlive = true;
    while (Date.now() < goneDeadline) {
      try {
        process.kill(observerPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        stillAlive = false;
        break;
      }
    }
    assert.equal(
      stillAlive,
      false,
      "expected the resistant observer to have actually been force-reaped (SIGKILLed), not merely abandoned as a leaked process while this codebase moved on"
    );
  }
);

test(
  "confirmProcessGroupReapedPosix: a SIGTERM-RESISTANT pgrep observer (installs a handler and ignores it) still settles within this codebase's own bound, does not block the event loop while doing so, and is genuinely gone afterward - not merely a slow-but-cooperative child",
  {
    skip:
      process.platform === "win32"
        ? "shadows a resistant pgrep on PATH and traps SIGTERM in a real shell, POSIX-only"
        : false,
  },
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-resistant-pgrep-"));
    const pgrepPath = path.join(dir, "pgrep");
    const markerPath = path.join(dir, "observer-pid.txt");
    // Traps SIGTERM to a no-op as literally this shell's first instruction,
    // before writing its marker or sleeping - see the sibling
    // captureBirthIdentityPosixAsync resistant-observer test above for why
    // installing the trap first (rather than after an initial marker
    // write) closes a real scheduling race instead of merely reordering
    // for style.
    fs.writeFileSync(
      pgrepPath,
      `#!/bin/sh\ntrap '' TERM\necho $$ > '${markerPath}'\nsleep ${RESISTANT_OBSERVER_SLEEP_SECONDS}\necho '${pid}'\n`
    );
    fs.chmodSync(pgrepPath, 0o755);

    let eventLoopTicks = 0;
    const ticker = setInterval(() => {
      eventLoopTicks += 1;
    }, 5);

    let confirmed: boolean | undefined;
    let elapsedMs: number;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      const before = Date.now();
      confirmed = await confirmProcessGroupReapedPosix(pid, RESISTANT_OBSERVER_BOUND_MS);
      elapsedMs = Date.now() - before;
    } finally {
      process.env.PATH = realPath;
      clearInterval(ticker);
      process.kill(-pid, "SIGKILL"); // cleanup the real sleep this test spawned
    }

    assert.equal(
      confirmed,
      false,
      "a resistant pgrep must still resolve to false (unconfirmed) via this codebase's own settlement bound, never fabricate a confirmed result"
    );
    assert.ok(
      elapsedMs < RESISTANT_OBSERVER_ELAPSED_ASSERTION_MS,
      `expected this codebase's OWN caller-side timer to force settlement well before the resistant pgrep's own long sleep - took ${elapsedMs}ms`
    );
    // THE assertion that actually tests the product's non-blocking promise:
    // an independent timer on the SAME event loop must have kept firing
    // WHILE this call was pending - a blocking implementation would have
    // starved it for the whole span instead.
    assert.ok(
      eventLoopTicks >= 10,
      `expected an independent event-loop timer to keep firing while the resistant observer was pending (proves the single Node event loop was never blocked) - only saw ${eventLoopTicks} ticks in ${elapsedMs}ms`
    );

    const observerPidText = await waitForFile(markerPath, {
      until: (content) => /^\d+\s*$/.test(content.trim()),
    });
    const observerPid = Number(observerPidText.trim());
    assert.ok(
      Number.isInteger(observerPid) && observerPid > 0,
      `expected the resistant observer to have self-reported a real pid, got: ${JSON.stringify(observerPidText)}`
    );
    // SIGKILL delivery and OS-level reaping are asynchronous relative to
    // the `kill()` call that sent it (the same real async gap this
    // codebase's own `SIGKILL_CONFIRMATION_TIMEOUT_MS` closes elsewhere) -
    // polls rather than checking once immediately, so this assertion
    // reflects the real outcome and not a race against that gap.
    const goneDeadline = Date.now() + 2000;
    let stillAlive = true;
    while (Date.now() < goneDeadline) {
      try {
        process.kill(observerPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        stillAlive = false;
        break;
      }
    }
    assert.equal(
      stillAlive,
      false,
      "expected the resistant observer to have actually been force-reaped (SIGKILLed), not merely abandoned as a leaked process while this codebase moved on"
    );
  }
);

test(
  "readPidStartTimesBatchPosix: a genuinely HUNG ps observer is forcibly killed once the bound elapses and resolves to observer-failure - never left unsettled indefinitely, and the event loop demonstrably progresses meanwhile",
  {
    skip: process.platform === "win32" ? "shadows a slow ps on PATH, POSIX-only" : false,
  },
  async () => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-hung-batch-ps-"));
    const psPath = path.join(dir, "ps");
    const markerPath = path.join(dir, "observer-pid.txt");
    fs.writeFileSync(
      psPath,
      `#!/bin/sh\ntrap '' TERM\necho $$ > '${markerPath}'\nsleep ${RESISTANT_OBSERVER_SLEEP_SECONDS}\necho '12345 Sat Jul 25 13:39:12 2026'\n`
    );
    fs.chmodSync(psPath, 0o755);

    let eventLoopTicks = 0;
    const ticker = setInterval(() => {
      eventLoopTicks += 1;
    }, 5);

    let result: Awaited<ReturnType<typeof readPidStartTimesBatchPosix>>;
    let elapsedMs: number;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      const before = Date.now();
      // `RESISTANT_OBSERVER_BOUND_MS` (not a tighter bound) - matching this
      // file's own established resistant-observer convention elsewhere,
      // since a genuinely fresh process spawn needs real scheduling time
      // before it can even reach its own marker-file write, independent of
      // anything under test - see that constant's own docs for the real
      // concurrent-load scheduling race this width is sized against.
      result = await readPidStartTimesBatchPosix([12345], RESISTANT_OBSERVER_BOUND_MS);
      elapsedMs = Date.now() - before;
    } finally {
      process.env.PATH = realPath;
      clearInterval(ticker);
    }

    assert.equal(result.status, "observer-failure");
    assert.ok(
      elapsedMs < RESISTANT_OBSERVER_ELAPSED_ASSERTION_MS,
      `expected the bounded timeout to fire well before the ps's own long sleep - took ${elapsedMs}ms`
    );
    assert.ok(
      eventLoopTicks >= 5,
      `expected an independent event-loop timer to keep firing while the resistant observer was pending - only saw ${eventLoopTicks} ticks in ${elapsedMs}ms`
    );

    const observerPidText = await waitForFile(markerPath, {
      until: (content) => /^\d+\s*$/.test(content.trim()),
    });
    const observerPid = Number(observerPidText.trim());
    const goneDeadline = Date.now() + 2000;
    let stillAlive = true;
    while (Date.now() < goneDeadline) {
      try {
        process.kill(observerPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        stillAlive = false;
        break;
      }
    }
    assert.equal(
      stillAlive,
      false,
      "expected the resistant ps observer to have actually been force-reaped (SIGKILLed), not merely abandoned"
    );
  }
);

test(
  "evaluateEscalationIdentityGate: a resistant ps observer at ESCALATION TIME does not hang the gate; it completes/refuses within the named budget, force-reaps the resistant child, and the event loop demonstrably progresses meanwhile",
  {
    skip: process.platform === "win32" ? "shadows a slow ps on PATH, POSIX-only" : false,
  },
  async () => {
    const realPath = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-gate-resistant-ps-"));
    const psPath = path.join(dir, "ps");
    const markerPath = path.join(dir, "observer-pid.txt");
    fs.writeFileSync(
      psPath,
      `#!/bin/sh\ntrap '' TERM\necho $$ > '${markerPath}'\nsleep ${RESISTANT_OBSERVER_SLEEP_SECONDS}\necho '424242 Sat Jul 25 13:39:12 2026'\n`
    );
    fs.chmodSync(psPath, 0o755);

    let eventLoopTicks = 0;
    const ticker = setInterval(() => {
      eventLoopTicks += 1;
    }, 5);

    const snapshot = { members: [{ pid: 424_242, startTimeMs: Date.now() }], degraded: false };
    let gate: Awaited<ReturnType<typeof evaluateEscalationIdentityGate>>;
    let elapsedMs: number;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      const before = Date.now();
      // `RESISTANT_OBSERVER_BOUND_MS`, matching this file's established
      // resistant-observer convention (a fresh process spawn needs real
      // scheduling time before it can even reach its own marker-file
      // write - see that constant's own docs for the real concurrent-load
      // scheduling race this width is sized against).
      gate = await evaluateEscalationIdentityGate(snapshot, RESISTANT_OBSERVER_BOUND_MS);
      elapsedMs = Date.now() - before;
    } finally {
      process.env.PATH = realPath;
      clearInterval(ticker);
    }

    assert.equal(
      gate.action,
      "refuse",
      "a timed-out re-read must fail closed, never default to escalation"
    );
    assert.ok(
      elapsedMs < RESISTANT_OBSERVER_ELAPSED_ASSERTION_MS,
      `expected the bound to fire well before the ps's own long sleep, took ${elapsedMs}ms`
    );
    assert.ok(
      eventLoopTicks >= 5,
      `expected the event loop to demonstrably progress while the observer resisted - only saw ${eventLoopTicks} ticks`
    );

    const observerPidText = await waitForFile(markerPath, {
      until: (content) => /^\d+\s*$/.test(content.trim()),
    });
    const observerPid = Number(observerPidText.trim());
    const goneDeadline = Date.now() + 2000;
    let stillAlive = true;
    while (Date.now() < goneDeadline) {
      try {
        process.kill(observerPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        stillAlive = false;
        break;
      }
    }
    assert.equal(stillAlive, false, "expected the resistant ps to have actually been force-reaped");
  }
);

test(
  "the pre-SIGTERM snapshot phase and the escalation-time re-read each get their OWN FRESH budget - a slow snapshot does not consume the re-read's own allowance",
  {
    skip: process.platform === "win32" ? "shadows a slow ps on PATH, POSIX-only" : false,
  },
  async () => {
    const rec = recorder();
    const env = buildChildEnv("merge", {});
    const child = spawnManaged(
      { argv: ["sleep", "5"], cwd: process.cwd(), env },
      callbacksFor(rec)
    );
    await waitFor(() => rec.spawned > 0);
    const pid = child!.pid!;

    // A ps that sleeps a REAL, deliberately generous multiple of the tight
    // budget below (400ms against a 250ms budget) before answering normally
    // - slow, but genuinely cooperative (never hangs past the bound; a
    // plain `sleep` has no SIGTERM trap, so execFile's own internal timeout
    // reaps it right at the budget). This does NOT depend on how many real
    // ps invocations the snapshot phase happens to make: `sleep 5` (this
    // test's spawned child) has no descendants, so the batched descendant
    // read never runs at all, and only the single leader read pays this
    // delay - a fixed-vs-fixed margin that stops relying on "how many steps
    // ran" or "how fast the machine is" to make the phase degrade. Real
    // for BOTH the snapshot AND the re-read, since both phases go through
    // the same real ps binary here.
    const realPsPath = execFileSync("which", ["ps"], { encoding: "utf8" }).trim();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-slow-cooperative-ps-"));
    const wrapperPath = path.join(dir, "ps");
    fs.writeFileSync(wrapperPath, `#!/bin/sh\nsleep 0.4\nexec '${realPsPath}' "$@"\n`);
    fs.chmodSync(wrapperPath, 0o755);

    const realPath = process.env.PATH;
    let snapshot: Awaited<ReturnType<typeof captureEscalationIdentitySnapshot>>;
    let gate: Awaited<ReturnType<typeof evaluateEscalationIdentityGate>>;
    let snapshotElapsedMs: number;
    let gateElapsedMs: number;
    try {
      process.env.PATH = `${dir}:${realPath ?? "/usr/bin:/bin"}`;
      const beforeSnapshot = Date.now();
      // A tight overall phase budget (250ms) the slow-but-cooperative ps
      // (400ms, a single leader read - this spawned child has no
      // descendants, so the batched descendant read never executes) cannot
      // complete within: execFile's own internal timeout SIGTERMs the
      // wrapper at 250ms, deterministically, well before its 400ms sleep
      // would otherwise finish on its own - proving the snapshot phase's
      // own budget is independent and can genuinely degrade on its own,
      // regardless of machine speed.
      snapshot = await captureEscalationIdentitySnapshot(pid, 250);
      snapshotElapsedMs = Date.now() - beforeSnapshot;
      assert.equal(
        snapshot.degraded,
        true,
        "expected the deliberately tight 250ms budget to genuinely degrade this snapshot attempt (proving the bound was real, not accidentally generous enough to still succeed)"
      );

      // Regardless of how the snapshot phase's own budget was spent, the
      // escalation gate below gets a FRESH, FULL budget of its own - large
      // enough that the same 200ms-slow ps comfortably completes within
      // it, proving the two phases' budgets are genuinely independent
      // rather than one shared allowance split across both.
      const realSnapshot = await captureEscalationIdentitySnapshot(pid, 5000);
      const beforeGate = Date.now();
      gate = await evaluateEscalationIdentityGate(realSnapshot, 2000);
      gateElapsedMs = Date.now() - beforeGate;
    } finally {
      process.env.PATH = realPath;
    }

    assert.ok(
      // Widened from 500ms - the same real-scheduling-delay class
      // documented at test/run.test.ts's RUN_RESPONSE_TIME_BOUND_MS: this
      // phase can internally hit its own 250ms budget more than once
      // across its sequential steps, each adding its own settlement
      // grace, so its real total under genuine concurrent load can run
      // well past a bare 2x multiple of the nominal budget. 1500ms stays
      // comfortably below the fresh, full budgets (2000/5000ms) used
      // later in this same test, so it still proves this phase was
      // genuinely bounded by its OWN tight allowance rather than
      // borrowing time from anything else.
      snapshotElapsedMs < 1500,
      `expected the tightly-budgeted snapshot phase to have been bounded by its OWN 250ms budget, took ${snapshotElapsedMs}ms`
    );
    assert.deepEqual(
      gate,
      { action: "escalate" },
      "expected the escalation gate to succeed on its own fresh, full budget, unaffected by the earlier tightly-budgeted snapshot attempt"
    );
    assert.ok(
      gateElapsedMs < 2000,
      `expected the gate to complete comfortably within its own fresh budget, took ${gateElapsedMs}ms`
    );

    process.kill(-pid, "SIGKILL");
  }
);
