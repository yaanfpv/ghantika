#!/usr/bin/env node
/**
 * scripts/dogfood-external-wake.mjs - a detector for an external state class
 * ghantika has never had a signal for before: something that finishes
 * OUTSIDE ghantika's own process tree, with no job ghantika itself started
 * to attach a terminal-state listener to (a pull request going green, a
 * long external build finishing, a render job completing). Every wake this
 * codebase already ships fires on a job THIS server ran (`run()`'s own
 * terminal-transition listeners in src/tasksAdapter.ts). This is the first
 * one that watches something ghantika had no hand in starting.
 *
 * The mechanism is two pieces glued together, both already real:
 *
 *   1. A generic poll-loop, new in this file: repeatedly runs a caller-
 *      supplied CHECKER command (any external command, real or a test
 *      fixture) as a real, separate OS process until it reports the
 *      watched state has reached a terminal condition.
 *   2. src/wake/selectTransport.ts's `selectAndWake` - ghantika's own,
 *      already-shipped wake-transport selector, imported and called
 *      directly here, exactly the same public door src/tasksAdapter.ts
 *      calls through for a job-finishes wake. No new transport, no new
 *      selection logic - this file supplies the one piece ghantika
 *      genuinely lacked (a detector for a state class with no existing
 *      terminal-transition listener to hook), and hands the actual wake
 *      to the exact same code every other wake in this codebase already
 *      goes through.
 *
 * What this deliberately does NOT do: touch any `.trigger` file, or hand
 * off to a harness-level watcher/monitor process to deliver the wake on
 * this detector's behalf. The wake is `selectAndWake`'s own, real,
 * ghantika-authored delivery - an app-server transport call on a harness
 * that supports one - not a doorbell ring for something else to notice
 * later. See local/dogfood/RUNBOOK.md for how the SAME poller, run
 * through ghantika's own `run` tool and awaited with `follow`, also
 * reaches a Claude Code session - through that client's own background-
 * and-resume behavior (docs/wake-support-matrix.md's Claude Code section),
 * which is a client mechanism, not code this file or any other in this
 * repository owns. This file's own, directly-testable claim is narrower
 * and real: the poll-loop below, on firing, calls `selectAndWake` itself.
 *
 * The checker contract (what any checkCommand must speak on its stdout,
 * one line per invocation, real exit code 0 for a completed check):
 *
 *   "EXTERNAL_STATE_TERMINAL:<free-form detail>"   the watched state has
 *                                                   reached a terminal
 *                                                   condition - detail is
 *                                                   carried into the wake
 *                                                   payload uninterpreted
 *   "EXTERNAL_STATE_PENDING"                       not yet - poll again
 *                                                   after the configured
 *                                                   interval
 *
 * A nonzero exit, a thrown spawn error, or stdout matching neither line is
 * a DETECTION FAILURE - never silently folded into "pending". See
 * `runCheckerOnce` below for the exact classification, and
 * `startExternalWakeDetector`'s own doc comment for how a caller observes
 * the distinction.
 */
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";
// The two admitted public doors into src/wake/ this file needs - see
// scripts/check-wake-transport-boundaries.mjs's own header for the full
// three-door boundary design (the third, resolveWakeTarget.ts, belongs to
// src/server.ts's own request-metadata path and has no role here: this
// detector's target is supplied directly by its own caller, never
// extracted from an incoming tools/call request). Imported from the built
// output, the same ../dist/<module>.js convention every test file in this
// repo already uses to reach real, compiled ghantika code - see
// test/registry.test.ts's own import comment for why (this codebase's
// internal ".js" specifiers only resolve against a real build).
import { DEFAULT_TRANSPORTS, selectAndWake } from "../dist/wake/selectTransport.js";

// ---------------------------------------------------------------------------
// The checker <-> poll-loop line protocol
// ---------------------------------------------------------------------------

export const CHECKER_TERMINAL_PREFIX = "EXTERNAL_STATE_TERMINAL:";
export const CHECKER_PENDING_LINE = "EXTERNAL_STATE_PENDING";

// ---------------------------------------------------------------------------
// The poll-loop <-> controller line protocol - a real, separate OS process
// (the poll-loop, spawned by startExternalWakeDetector below) prints
// exactly ONE of these two prefixed lines to its own stdout before it
// exits, and never anything else shaped like an outcome: `fired` (the
// checker itself reported a terminal state) or `detectionFailed` (the
// checker errored, produced an unrecognized line, or this loop's own code
// hit an unexpected exception - any of which must be as loud and as
// distinguishable from "still polling" as a real fire, never silently
// swallowed into another pending cycle).
// ---------------------------------------------------------------------------

export const POLL_LOOP_FIRED_PREFIX = "POLL_LOOP_FIRED:";
export const POLL_LOOP_DETECTION_FAILED_PREFIX = "POLL_LOOP_DETECTION_FAILED:";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_KILL_GRACE_MS = 3_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `checkCommand` ONCE, synchronously, as a real child process, and
 * classifies the result per the checker contract in this file's header.
 * Never throws for an ordinary checker failure (a nonzero exit, a spawn
 * error, an unrecognized line) - all three come back as `{ kind: "error" }`
 * with a human-readable `reason`, so the poll-loop below has exactly one
 * thing to do with a bad result: report it and stop, never guess.
 *
 * @param {readonly string[]} checkCommand
 * @returns {{ kind: "terminal", detail: string } | { kind: "pending" } | { kind: "error", reason: string }}
 */
export function runCheckerOnce(checkCommand) {
  const [cmd, ...args] = checkCommand;
  const result = spawnSync(cmd, args, { encoding: "utf8" });

  if (result.error) {
    return { kind: "error", reason: `failed to spawn checker "${cmd}": ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderrText = (result.stderr ?? "").trim();
    return {
      kind: "error",
      reason:
        `checker exited ${result.status}` +
        (result.signal ? ` (signal ${result.signal})` : "") +
        ` - stderr: ${stderrText || "(empty)"}`,
    };
  }

  const stdout = (result.stdout ?? "").trim();
  if (stdout.startsWith(CHECKER_TERMINAL_PREFIX)) {
    return { kind: "terminal", detail: stdout.slice(CHECKER_TERMINAL_PREFIX.length) };
  }
  if (stdout === CHECKER_PENDING_LINE) {
    return { kind: "pending" };
  }
  return {
    kind: "error",
    reason:
      `checker produced an unrecognized line - expected a line starting with ` +
      `"${CHECKER_TERMINAL_PREFIX}" or exactly "${CHECKER_PENDING_LINE}", got: ${JSON.stringify(stdout)}`,
  };
}

/**
 * The poll-loop's own body: checks once, and either reports a terminal
 * result and exits 0, reports a detection failure and exits 1, or sleeps
 * `pollIntervalMs` and checks again - forever, until one of the first two
 * happens or this whole process is signalled from outside (SIGTERM's
 * default disposition - no handler is ever installed here - terminates
 * this process immediately regardless of what it is doing, including
 * mid-`spawnSync`, so an external kill needs no cooperation from this
 * loop's own code to take effect).
 *
 * Any exception this loop's own code throws (as opposed to an ordinary
 * checker-reported failure, already handled inside `runCheckerOnce`) is
 * caught here and reported exactly like a checker error - a bug in this
 * detector must never look like "the watched state simply hasn't
 * happened yet" either.
 *
 * @param {{ checkCommand: readonly string[], pollIntervalMs: number }} options
 * @returns {Promise<never>} never resolves - always ends the process via `process.exit`
 */
async function runPollLoopForever({ checkCommand, pollIntervalMs }) {
  for (;;) {
    let result;
    try {
      result = runCheckerOnce(checkCommand);
    } catch (error) {
      result = {
        kind: "error",
        reason: `poll-loop threw evaluating the checker: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (result.kind === "terminal") {
      process.stdout.write(`${POLL_LOOP_FIRED_PREFIX}${result.detail}\n`);
      process.exit(0);
    }
    if (result.kind === "error") {
      process.stdout.write(`${POLL_LOOP_DETECTION_FAILED_PREFIX}${result.reason}\n`);
      process.exit(1);
    }
    await sleep(pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// The controller - runs in the SAME process as whatever called
// startExternalWakeDetector (production code, or this file's own test),
// never inside the poll-loop's separate process. Only the controller ever
// calls selectAndWake - the poll-loop's one job is deciding WHETHER the
// watched state fired, never touching the wake layer itself.
// ---------------------------------------------------------------------------

/**
 * Spawns the poll-loop as a real, separate OS process, detached into its
 * OWN process group (`detached: true`) rather than sharing this process's
 * group. This is what makes a single, group-targeted signal
 * (`process.kill(-pid, signal)`, in `killAndReapGroup` below) reach both
 * the poll-loop AND whatever checker child it currently has in flight via
 * `spawnSync` - a plain child, spawned with no `detached` option of its
 * own, joins its parent's CURRENT process group by default (ordinary POSIX
 * fork semantics), which is this poll-loop's own new group, not this
 * controller's. Never sent a signal on this process's own group instead -
 * that would reach this controller (and, transitively, whatever spawned
 * it) rather than the poll-loop.
 *
 * @param {{ checkCommand: readonly string[], pollIntervalMs: number, nodePath?: string, scriptPath?: string }} options
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnPoller({
  checkCommand,
  pollIntervalMs,
  nodePath = process.execPath,
  scriptPath = fileURLToPath(import.meta.url),
}) {
  return spawn(nodePath, [scriptPath, "--poll-loop", JSON.stringify(checkCommand), String(pollIntervalMs)], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * True once `child` has already reported its own exit to this process
 * (Node's own child_process bookkeeping, populated by a real `waitpid`
 * under the hood - not a guess).
 *
 * @param {import("node:child_process").ChildProcess} child
 */
function hasAlreadyExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true if `child` reported exit within `timeoutMs`
 */
function waitForExit(child, timeoutMs) {
  if (hasAlreadyExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * @param {number} pid
 * @param {NodeJS.Signals} signal
 */
function trySignalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = error && /** @type {NodeJS.ErrnoException} */ (error).code;
    // ESRCH: the group is already gone - nothing left to signal. EPERM:
    // measured directly (not theorized) against this codebase's own real
    // spawn/exit path on a busy, multi-process host - a child that has
    // already exited and been reaped can have its pid RECYCLED to an
    // unrelated process before this function ever runs (Node's own `exit`
    // event for OUR child is not guaranteed to have been delivered yet at
    // the moment this runs - see killAndReapGroup's own natural-exit wait
    // below for why that race exists at all), and signaling that recycled
    // pid's group returns EPERM rather than ESRCH. This is the exact pid-
    // reuse hazard src/process.ts's own birth-identity-gated kill exists
    // to defend against for jobStore's heavier subject; here the cheaper
    // answer is simply: never treat a permission refusal as license to
    // keep trying to signal something that might not be ours anymore -
    // the signal was refused, nothing was sent, nothing was harmed, and
    // `killAndReapGroup`'s own waitForExit still settles this on its own
    // timeout regardless. Any OTHER error is unexpected and must surface.
    if (code === "ESRCH" || code === "EPERM") return;
    throw error;
  }
}

/**
 * How long a natural exit is given to report itself BEFORE this function
 * ever signals anything - see `killAndReapGroup`'s own doc comment for why
 * this exists at all. Short: this is a real race window, not a genuine
 * wait for slow work - a healthy poll-loop that already called its own
 * `process.exit()` reports it to this process well under this bound.
 */
const NATURAL_EXIT_GRACE_MS = 500;

/**
 * Kills and reaps the poll-loop's WHOLE process group (see `spawnPoller`'s
 * own doc comment for why a group signal, not a bare pid signal) on every
 * path this file's controller can end on: the poll-loop fired, it reported
 * a detection failure and already exited on its own, or the caller asked
 * to stop early while it was still pending. Idempotent and safe to call on
 * an already-exited child - `hasAlreadyExited` short-circuits the first
 * signal in that case, since there is nothing left alive to terminate.
 *
 * A SHORT NATURAL-EXIT WAIT RUNS FIRST, before any signal is ever sent -
 * measured necessary, not a defensive guess: on the `fired`/
 * `detectionFailed` paths the poll-loop has ALREADY called `process.exit()`
 * on itself, on its own, by the time this function is reached (see
 * `runPollLoopForever`'s own body) - but stdio data delivery (the line this
 * controller just read) and this process's own `exit` notification for that
 * same child arrive over different, independently-scheduled channels with
 * no guaranteed relative order, so `hasAlreadyExited(child)` can genuinely
 * read false for an instant even though the real OS process is already
 * gone. Signaling a pid at exactly that instant risks the pid-reuse hazard
 * `trySignalGroup`'s own doc comment describes. Waiting this short bound
 * first turns that race into a clean, ordinary "it already exited, done"
 * in the common case, and costs nothing when the child genuinely is still
 * alive (this wait resolves via its own timeout, no slower than the
 * signal-first path would have been).
 *
 * SIGTERM next, with a grace period; SIGKILL only if the group is still
 * alive after that - matching this repo's own established graceful-then-
 * forceful shutdown shape (src/process.ts's POSIX_KILL_GRACE_PERIOD_MS),
 * scaled down for this file's own, much lighter subject (a poll-loop and,
 * at most, one in-flight checker invocation - never a job's own arbitrary
 * descendant tree).
 *
 * This function's own confirmation that the group is gone comes from
 * Node's `exit` event - real bookkeeping, not "we called kill() and
 * assumed". A caller (this file's own test included) that wants a SECOND,
 * fully external confirmation - independent of this process's own
 * child_process state - is expected to check the real process table
 * itself (e.g. `pgrep`), exactly as test/dogfood.test.ts already does for
 * its own kill+reap proof; that is deliberately not duplicated inside this
 * library function; see this file's own test for how.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {{ graceMs?: number }} [options]
 */
export async function killAndReapGroup(child, { graceMs = DEFAULT_KILL_GRACE_MS } = {}) {
  if (typeof child.pid !== "number") return; // never actually spawned - nothing to reap
  if (hasAlreadyExited(child)) return;

  const exitedOnItsOwn = await waitForExit(child, NATURAL_EXIT_GRACE_MS);
  if (exitedOnItsOwn) return;

  trySignalGroup(child.pid, "SIGTERM");
  const exitedAfterTerm = await waitForExit(child, graceMs);
  if (exitedAfterTerm) return;

  trySignalGroup(child.pid, "SIGKILL");
  await waitForExit(child, graceMs);
}

/**
 * @typedef {{ readonly type: "fired", readonly detail: string, readonly wakeResult: import("../dist/wake/wakeTransport.js").WakeResult }} FiredOutcome
 * @typedef {{ readonly type: "detectionFailed", readonly reason: string }} DetectionFailedOutcome
 * @typedef {{ readonly type: "stopped" }} StoppedOutcome
 * @typedef {FiredOutcome | DetectionFailedOutcome | StoppedOutcome} ExternalWakeDetectorOutcome
 */

/**
 * @typedef {object} ExternalWakeDetectorHandle
 * @property {number} pid - the poll-loop's own real pid, captured the
 *   instant it is spawned (present even before the outcome settles, so a
 *   caller - or this file's own test - can independently confirm the
 *   process is really running, or really gone after `outcome` settles,
 *   without waiting on anything else).
 * @property {Promise<ExternalWakeDetectorOutcome>} outcome - resolves
 *   EXACTLY ONCE, to exactly one of the three outcome shapes above, only
 *   after the poll-loop's whole process group has been killed and
 *   reaped (see `killAndReapGroup`) - never before. A caller reading
 *   `outcome` as still-pending has learned nothing has fired, failed, or
 *   been stopped yet; there is no fourth "still checking" resolution -
 *   that state is represented by the promise not having settled at all,
 *   never by a value that could be confused with a real outcome.
 * @property {() => Promise<void>} stop - the explicit early-exit path:
 *   kills and reaps the poll-loop immediately regardless of its current
 *   state, and settles `outcome` to `{ type: "stopped" }` if nothing else
 *   settled it first. Resolves once the reap has completed. Safe to call
 *   after `outcome` has already settled on its own (a no-op then, since
 *   the poll-loop is already reaped).
 */

/**
 * Starts a real, separate poll-loop process for `checkCommand`, and wires
 * it so that the FIRST line it prints matching the poll-loop protocol
 * above decides what happens next:
 *
 *   - a fired line calls `selectAndWake(transports, target,
 *     buildPayload(detail))` - ghantika's own real wake-transport
 *     selector, imported directly from src/wake/selectTransport.js, no
 *     wrapper or reimplementation - then reaps the poll-loop and settles
 *     `outcome` to `{ type: "fired", detail, wakeResult }`, where
 *     `wakeResult` is `selectAndWake`'s own, real, un-modified return
 *     value (never re-synthesized "delivered" here - see that function's
 *     own doc comment for why only it is ever allowed to produce that
 *     outcome).
 *   - a detection-failed line, or the poll-loop process exiting with no
 *     recognized outcome line at all (a genuinely unexpected death - a
 *     crash, an unhandled rejection, an out-of-band kill this controller
 *     didn't itself request), reaps the poll-loop and settles `outcome`
 *     to `{ type: "detectionFailed", reason }` - NEVER silently treated as
 *     though nothing had happened. This is the one property this
 *     function exists to guarantee for a caller degrading to its own
 *     ordinary poll cadence on failure: a detection failure is always
 *     observable as its own distinct outcome, never indistinguishable
 *     from "still waiting" (which has no settled value at all - see the
 *     handle's own `outcome` doc comment) and never indistinguishable
 *     from a genuine fire.
 *   - calling the returned handle's `stop()` reaps the poll-loop
 *     immediately and settles `outcome` to `{ type: "stopped" }` -
 *     `selectAndWake` is never called for a stop.
 *
 * Never touches any `.trigger` file, anywhere, on any path - the only
 * delivery this function ever performs is the direct `selectAndWake` call
 * above.
 *
 * @param {{
 *   target: import("../dist/wake/wakeTransport.js").WakeTarget,
 *   checkCommand: readonly string[],
 *   buildPayload: (detail: string) => string,
 *   pollIntervalMs?: number,
 *   transports?: readonly import("../dist/wake/wakeTransport.js").WakeTransport[],
 *   killGraceMs?: number,
 * }} options
 * @returns {ExternalWakeDetectorHandle}
 */
export function startExternalWakeDetector({
  target,
  checkCommand,
  buildPayload,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  transports = DEFAULT_TRANSPORTS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
}) {
  const child = spawnPoller({ checkCommand, pollIntervalMs });

  let settled = false;
  /** @type {(outcome: ExternalWakeDetectorOutcome) => void} */
  let resolveOutcome = () => {};
  /** @type {Promise<ExternalWakeDetectorOutcome>} */
  const outcome = new Promise((resolve) => {
    resolveOutcome = resolve;
  });

  const rl = readline.createInterface({ input: /** @type {NodeJS.ReadableStream} */ (child.stdout) });
  /** @type {Buffer[]} */
  const stderrChunks = [];
  if (child.stderr) {
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  }

  /**
   * `resolveOutcome(result)` runs UNCONDITIONALLY once `settled` flips true
   * - even if `killAndReapGroup` itself throws for some reason its own
   * error handling didn't anticipate. `outcome` settling is this whole
   * function's one real contract with a caller; a reap failure is a
   * genuinely bad, loud condition (logged here, never swallowed), but it
   * must never be able to leave `outcome` permanently unresolved - the one
   * thing worse than a failed reap is a caller that can no longer tell
   * whether anything happened at all.
   *
   * @param {ExternalWakeDetectorOutcome} result
   */
  async function finish(result) {
    if (settled) return;
    settled = true;
    rl.close();
    try {
      await killAndReapGroup(child, { graceMs: killGraceMs });
    } catch (error) {
      console.error(
        "[dogfood-external-wake] killAndReapGroup threw during reap - the outcome below still settles:",
        error
      );
    }
    resolveOutcome(result);
  }

  // True the INSTANT a recognized outcome line is seen - synchronously,
  // before selectAndWake's own promise is ever awaited - never only once
  // finish() itself later flips `settled`. This closes a real race: the
  // poll-loop's own stdout data (this line) and this process's own `exit`
  // notification for that same child are delivered over independently-
  // scheduled channels with no guaranteed relative order (the same fact
  // killAndReapGroup's own natural-exit wait exists for), so the child's
  // `exit` event can fire WHILE `selectAndWake` is still in flight below -
  // still well before `settled` would otherwise be set inside `finish()`.
  // Without this flag, that exit event's own handler would see `settled
  // === false` and race ahead with a `detectionFailed` finish() call,
  // permanently locking out the real, in-flight `fired` outcome the very
  // instant it was about to resolve - the wrong outcome winning a race
  // against the real one, not merely a slow one.
  let outcomeDeciding = false;

  rl.on("line", (line) => {
    if (settled || outcomeDeciding) return;

    if (line.startsWith(POLL_LOOP_FIRED_PREFIX)) {
      outcomeDeciding = true;
      const detail = line.slice(POLL_LOOP_FIRED_PREFIX.length);
      // settled is flipped inside finish(), but selectAndWake is invoked
      // here, BEFORE the poll-loop is reaped - the wake attempt itself
      // never depends on the poll-loop process still existing (its job
      // was only ever to decide whether to fire, never to participate in
      // delivery), so ordering it before the reap costs nothing and keeps
      // "detected" and "reaped" as two visibly separate steps.
      selectAndWake(transports, target, buildPayload(detail))
        .then((wakeResult) => finish({ type: "fired", detail, wakeResult }))
        .catch((error) => {
          finish({
            type: "detectionFailed",
            reason: `selectAndWake threw rather than resolving: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
      return;
    }

    if (line.startsWith(POLL_LOOP_DETECTION_FAILED_PREFIX)) {
      outcomeDeciding = true;
      finish({ type: "detectionFailed", reason: line.slice(POLL_LOOP_DETECTION_FAILED_PREFIX.length) });
    }
  });

  child.on("exit", (code, signal) => {
    if (settled || outcomeDeciding) return;
    // The poll-loop's own process ended without this controller ever
    // seeing a recognized outcome line on its stdout - an unexpected
    // death (a crash, an out-of-band kill this controller did not itself
    // request via stop()/killAndReapGroup). Reported exactly like any
    // other detection failure, never silently treated as "nothing
    // happened" - see this function's own doc comment.
    outcomeDeciding = true;
    const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
    finish({
      type: "detectionFailed",
      reason:
        `poll-loop process exited unexpectedly (code=${code}, signal=${signal}) with no recognized ` +
        `outcome line on its stdout - stderr: ${stderrText || "(empty)"}`,
    });
  });

  return {
    pid: /** @type {number} */ (child.pid),
    outcome,
    stop: () => finish({ type: "stopped" }),
  };
}

// ---------------------------------------------------------------------------
// CLI dispatch - the ONLY way this file's poll-loop body actually runs is
// as its own separate `node scripts/dogfood-external-wake.mjs --poll-loop
// <checkCommandJson> <pollIntervalMs>` invocation, spawned by
// `spawnPoller` above. Importing this file's named exports (as
// startExternalWakeDetector's own caller, or this file's own test, both
// do) never triggers this branch - see scripts/lib/is-main.mjs's own doc
// comment for why a plain import can never be mistaken for direct
// invocation.
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--poll-loop") {
    const checkCommand = JSON.parse(args[1]);
    const pollIntervalMs = Number(args[2]);
    // Never resolves on its own - runPollLoopForever always ends this
    // process itself via process.exit(), on either the fired or the
    // detection-failed path, or is torn down from outside by a signal.
    void runPollLoopForever({ checkCommand, pollIntervalMs });
    return;
  }
  console.error(
    "dogfood-external-wake.mjs: no CLI entrypoint beyond --poll-loop (spawned internally by " +
      "startExternalWakeDetector) - import startExternalWakeDetector to use this as a library"
  );
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main();
}
