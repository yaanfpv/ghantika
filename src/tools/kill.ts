/**
 * `kill` - terminates a running background job by signaling every process
 * still in its own process GROUP. This file owns `kill`'s registration/schema/validation/
 * orchestration logic; it imports nothing from any sibling under
 * `src/tools/` and holds no state of its own - real job/output state and
 * the tracked child handle live in `src/jobStore.ts`'s `jobStore`
 * singleton, real OS-level kill mechanics (process-group signaling,
 * identity verification, the Windows fallback) live in `src/process.ts`.
 *
 * ## Containment
 *
 * POSIX: `process.spawnManaged` (see its own docs) always spawns a
 * managed child as the LEADER of its own, freshly created process group
 * (`detached: true`, group membership assigned atomically at spawn time -
 * no window where the leader is briefly outside its own group). That
 * atomicity is about the LEADER's own assignment at the moment of spawn,
 * never a guarantee that a descendant cannot later leave the group on its
 * own - see the "Escape boundary" section below for exactly which real
 * escape is disclosed and why atomic spawn-time assignment does not
 * prevent it. Killing therefore means signaling the whole
 * GROUP (`process.kill(-pgid, signal)`), never just the one tracked
 * `ChildProcess` - see `process.signalProcessGroupPosix`.
 *
 * Windows: there is no POSIX process-group equivalent, and this codebase
 * does NOT implement a real Job Object (no native/FFI dependency exists in
 * this zero-runtime-dependency project to do that correctly) - see
 * `process.killProcessTreeWindows`'s own extensive docs for the honest
 * statement of what the `taskkill /t /f` fallback actually does and does
 * not guarantee. This file never claims Job Object behavior it hasn't
 * actually implemented.
 *
 * ## Escape boundary
 *
 * POSIX process-group containment holds for every descendant that REMAINS
 * in the job's own group - which includes a descendant that gets
 * reparented, since reparenting changes a process's PPID, never its
 * process group. It does NOT hold for a descendant that calls `setsid()`
 * or otherwise moves itself into a DIFFERENT process group: such a
 * process is neither signaled by `process.kill(-pgid, signal)` nor
 * observed by `pgrep -g <pgid>` - both act on the group id, and a process
 * that left the group no longer carries it. This is an accepted, disclosed
 * boundary of portable POSIX containment (`setsid()` leaves the group by
 * design, and portable POSIX offers no mechanism to hold a process in a
 * group it has chosen to leave), not a defect quietly carried - see the
 * escape-boundary sentence in `description` below, and README.md's
 * Platform notes, for the user-facing disclosure this file and README
 * both owe the same fact.
 *
 * ## PID-reuse defense
 *
 * PRIMARY: every signal this file ever sends targets the process GROUP
 * (`process.signalProcessGroupPosix`'s negative-pid form), never a bare
 * tracked pid alone - a recycled pid that isn't a member of our own group is
 * never reachable this way. SECONDARY, defense-in-depth: before ever
 * signaling on POSIX, this handler calls `process.evaluatePreSignalIdentityGate`
 * - a REAL external `ps` lookup comparing the tracked leader's actual elapsed
 * lifetime against a birth identity captured at spawn time. This is a
 * best-effort, probabilistic check, NOT a cryptographic guarantee: it
 * compares real elapsed time within a several-second tolerance, so a
 * pid+pgid reused by an unrelated process within that same narrow window
 * cannot always be told apart from the original - an accepted, extremely
 * unlikely residual, never claimed "exact." A clear mismatch refuses to
 * signal at all (a PRE-SIGNAL fail-closed gate). When identity cannot be
 * verified at all - no birth identity was ever captured, or the kill-time
 * `ps` observation itself fails - this handler does NOT silently treat
 * that as either "confirmed" or "nothing to signal": it proceeds via an
 * honest DEGRADED path (pgid-only signaling, no identity confirmation),
 * disclosed via the job's `identity_confirmed: false` field - see
 * `process.evaluatePreSignalIdentityGate`'s own docs for the full rationale.
 *
 * The birth identity itself is now captured ASYNCHRONOUSLY by `run()`,
 * fired off without ever being awaited on `run()`'s own response path (see
 * `run.ts`'s own docs) - so a `kill()` call can genuinely arrive while that
 * capture is still in flight, before it has had a chance to settle. This
 * handler does NOT treat "still pending" the same as "definitively
 * unavailable": it reads the birth identity via
 * `jobStore.resolveBirthIdentityForKill`, which awaits the SAME in-flight
 * capture promise `run()` kicked off, bounded by that capture's own hard
 * timeout (`process.ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS`), before this
 * handler ever evaluates the identity gate above. That preserves a real,
 * confirmed identity comparison for the common case of a
 * kill racing ahead of a capture that's about to succeed, rather than
 * needlessly falling back to the (still safe, but strictly weaker)
 * degraded path the instant identity isn't ALREADY settled.
 *
 * ## Process-group confirmation, honestly disclosed
 *
 * After signaling completes (whichever phase actually finished the job),
 * this handler runs a bounded, best-effort EXTERNAL process-group check
 * (`process.confirmProcessGroupReapedPosix`, a real `pgrep -g` read of the
 * process table) and records the honest result as the job's
 * `kill_confirmed` field: `true` once zero surviving process-group members
 * were actually observed within the bound, `false` if the bound elapsed
 * without confirming - NEVER silently claimed `true` when it wasn't, and
 * NEVER present at all until the job actually reaches a terminal state.
 * On the DEFAULT path (no `signal` argument, or an explicit `SIGTERM`)
 * this runs strictly AFTER, and never gates, the job's own synchronous
 * `killed` state transition (see the "Idempotency and races" section
 * below) - it only ever refines the result's honesty there, never the
 * state machine. A caller-supplied signal OTHER than `SIGTERM` gates this
 * handler's OWN write of the terminal state the same way: it never calls
 * `jobStore.markKilled` on the strength of the signal alone, only once
 * this check actually confirms zero survivors (see the "Honest phase
 * split" section below). That is the whole story for a signal with no
 * termination guarantee (`SIGSTOP` is the worked case): the job cannot
 * reach `killed` any other way, so confirmation genuinely IS what decides
 * whether it becomes terminal at all. A signal that cannot be caught or
 * ignored (an explicit `SIGKILL`) is different - though that is not the
 * same as a death guarantee (a process wedged in uninterruptible sleep
 * survives receipt of it): the real
 * child can also exit ON ITS OWN the moment the signal lands, independent
 * of this handler, and `jobStore.markExited` treats any signal-caused
 * exit as `killed` too (see its own docs) - the SAME kind of race the
 * default path's `onSignaled` callback exists to win deterministically,
 * just unmediated by this handler for a custom signal. So the job's
 * STATE can legitimately reach `killed` via that independent race before
 * this check ever resolves; what this check exclusively decides, for
 * every custom signal without exception, is `kill_confirmed` and
 * `identity_confirmed`, which stay genuinely ABSENT - never `false` -
 * until it actually confirms zero survivors, regardless of how or when
 * the state itself became terminal. POSIX only: Windows leaves this
 * field unset (no confirmation is even attempted there today - see
 * `process.killProcessTreeWindows`'s own docs).
 *
 * ## Honest phase split
 *
 * POSIX: SIGTERM to the group, a REAL 5-second grace period
 * (`process.POSIX_KILL_GRACE_PERIOD_MS`), then SIGKILL to the group only
 * if it's still alive - this is the DEFAULT path (no `signal` argument, or
 * an explicit `"SIGTERM"`). A caller-supplied signal OTHER than `SIGTERM`
 * is instead sent exactly once, with no automatic escalation - the phased
 * grace-then-escalate behavior is specifically what the default path does.
 * That grace period is itself where a disclosed, unclosed residual lives:
 * the group can fully empty during the wait and have its numeric pgid
 * recycled by an unrelated later group before `killProcessGroupPosix`'s
 * own pre-SIGKILL existence check runs - see that function's own docs
 * (`src/process.ts`) and `description` above for the full disclosure. This
 * is distinct from the eager-reap gap a few paragraphs up, and the
 * once-per-job reap guard does not help here: it only prevents a LATER
 * `kill` call from re-signaling, never a reused id hit within this same
 * escalation.
 * A caller-supplied signal with NO documented termination guarantee
 * (`SIGSTOP`, e.g., only pauses a process - it never ends it) leaves this
 * handler unable to mark the job `killed` merely because that signal was
 * SENT: it confirms, via the same real external process-group check the
 * default path uses, that the group is actually gone before claiming
 * `killed` - when it isn't (or can't be confirmed within the bound), the
 * job is left in its current, non-terminal state, reachable for a
 * follow-up `kill()` or shutdown reap, rather than falsely stranded as
 * terminal forever. A caller-supplied signal that cannot be caught or
 * ignored (an explicit `SIGKILL`) is different - ordinarily this handler's OWN
 * write of `killed` still waits on that same confirmation, but the real
 * process can exit on its own first, independent of this handler (see
 * the "Process-group confirmation, honestly disclosed" section above) -
 * so the job's state can legitimately turn terminal before this
 * handler's own write ever runs, while `kill_confirmed`/`identity_confirmed`
 * remain exactly as confirmation-gated as they are for a non-terminating
 * signal.
 *
 * Windows: there is NO graceful phase at all - `TerminateJobObject`
 * (approximated here by `taskkill /f`) is immediate and forceful, full
 * stop, regardless of any `signal` argument the caller supplies. This file
 * never implements or claims a "graceful Windows shutdown."
 *
 * ## Idempotency and races
 *
 * An already-terminal JOB RECORD is NOT the same thing as "nothing left
 * to reap": a real process GROUP where the leader forks descendants and
 * then exits on its own (root-exits-first - e.g. a shell script that
 * backgrounds children and never `wait`s on them) leaves those
 * descendants alive and orphaned under the SAME pgid, since the leader's
 * own natural exit does not kill them. So a terminal record still gets a
 * real, external, group-level reap attempt (see
 * `reapTerminalJobProcessGroup` below) before this handler ever returns -
 * this NEVER re-checks the leader's own identity (the leader is already
 * gone by construction whenever this runs, so that check would always
 * read "not-found" and abort before ever reaching a still-populated
 * group); it relies purely on the real, external process-group
 * containment `killProcessGroupPosix` already provides (an already-fully-
 * gone group is a cheap no-op there - see that function's own docs).
 * POSIX only: Windows has no equivalent root-exits-first fix today (no
 * pgid concept to reap against post-hoc - see
 * `process.killProcessTreeWindows`'s own docs on why a Windows tree walk
 * can't reach an already-reparented descendant either way).
 *
 * Otherwise, deterministic linearization for a genuinely LIVE job comes
 * for free from `JobStore.markKilled` following the identical
 * terminal-state guard every other `mark*` transition already uses (first
 * write wins). Unknown `job_id` is a distinct, clearly-worded not-found
 * error, never confused with a validation error. Nothing here ever
 * mutates a job's output buffers - a killed job's buffered output remains
 * readable afterward, exactly as `run`/`status`/`output`/`tail` left it.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

import { isTerminalJobState, jobStore, toPublicProjection } from "../jobStore.js";
import {
  POSIX_KILL_GRACE_PERIOD_MS,
  confirmProcessGroupReapedPosix,
  evaluatePreSignalIdentityGate,
  killProcessGroupPosix,
  killProcessTreeWindows,
  signalProcessGroupPosix,
} from "../process.js";

export const name = "kill";

export const description =
  'Terminate a running background job by signaling its whole POSIX process group. Default: SIGTERM, a 5-second grace period, then SIGKILL if still alive - this is also what an explicit "SIGTERM" does, since that IS the default. Pass a different "signal" (including "SIGKILL") to skip the grace period and send exactly that one signal once. The grace period carries a disclosed residual: the group can fully empty during that wait - its ordinary, intended outcome - and have its numeric id recycled by an unrelated later group before the pre-SIGKILL existence check that follows the wait actually runs; that check narrows the window between "still alive" and "about to send SIGKILL" as far as an existence check can, but cannot close it, since existence alone cannot tell a survived original group apart from a coincidentally-reused one. This is distinct from the eager-reap gap described below, which is a single scheduling tick rather than up to a whole grace period, and is not addressed by the once-per-job reap guard, which only ever prevents a later kill call from re-signaling, not a reused id encountered within this same escalation. Before signaling, a real external check confirms the tracked leader is still genuinely the process this server spawned, comparing real vs. expected elapsed lifetime within a several-second tolerance - best-effort, not a cryptographic guarantee; a clear mismatch refuses to signal at all. That birth identity is captured asynchronously right after the job started; a kill sent moments later may briefly await that in-flight capture rather than giving up on it. When identity can\'t be verified at all, the group is still signaled, honestly disclosed via "identity_confirmed": false once the job reaches a terminal state. A job whose leader already exited on its own gets a real external reap for any process-group members it left behind - attempted automatically the instant that exit is observed, at most once per job, with a later kill call only attempting it if it has not already run; that reap only ever sets "kill_confirmed", never "identity_confirmed", since the leader is already gone and its identity is never re-checked there. While the group still holds a member the OS cannot recycle its id, so continuity proves ownership up to the moment the last member leaves - but where the leader has no surviving descendants, it IS the last member, and the group empties at exactly that exit, so no continuity reaches this server\'s own callback. The residual this leaves is the gap between the group emptying and that callback\'s existence check actually running: normally very short, but with no fixed upper bound, since it is event-loop scheduling latency a busy event loop can stretch well past - unlike the several-second birth-identity tolerance above, this is deliberately never stated as a wall-clock bound. "kill_confirmed" true means an external process-table check found no processes still assigned to the job\'s ORIGINAL PROCESS GROUP - never a whole-tree or zero-surviving-descendants guarantee; false if that couldn\'t be confirmed within the bound. On the DEFAULT path (no "signal", or explicit "SIGTERM"), both fields are set once the job is actually terminated, and the job\'s "killed" state itself is reported synchronously. A caller-supplied signal OTHER than "SIGTERM" is different: for a non-terminating one (SIGSTOP), confirmation is what makes the job terminal at all, so both fields stay simply absent while it remains non-terminal. For a terminating one, including an explicit "SIGKILL", the state can independently reach "killed" via the process\'s own real exit, while both fields still stay simply absent - never false - until confirmation actually lands. Windows: an immediate, forceful whole-tree kill via taskkill /t /f, with no graceful phase - real and recursive, but not atomic; no identity check or process-group confirmation is performed on Windows today. A descendant that calls setsid() or otherwise moves itself into a different process group is neither signaled by this containment nor observed by its confirmation check; reparenting alone is not such an escape, since reparenting changes a process\'s parent, never its process group. If your command spawns a process that detaches into its own group or session, you are responsible for tracking and terminating it yourself - this tool will not, and does not claim to. Idempotent: killing an already-terminal job is a no-op with respect to the job\'s own recorded state, though it may still attempt a real cleanup reap.';

export const inputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {
    job_id: {
      type: "string",
      minLength: 1,
      description: "The job id returned by a prior run call.",
    },
    signal: {
      type: "string",
      description:
        'POSIX signal name to send, e.g. "SIGTERM" or "SIGKILL". Omitted, or explicitly "SIGTERM" (the default either way): SIGTERM to the process group, a real 5-second grace period, then SIGKILL if still alive. Any OTHER signal: that exact signal is sent once, with no automatic escalation. Ignored on Windows, which has no graceful phase.',
    },
  },
  required: ["job_id"],
};

interface ValidatedKillInput {
  readonly jobId: string;
  readonly signal?: string;
}

type ValidationResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function validateKillInput(
  args: Record<string, unknown> | undefined
): ValidationResult<ValidatedKillInput> {
  if (typeof args?.job_id !== "string" || args.job_id.length === 0) {
    return { ok: false, message: 'kill requires a non-empty string "job_id" argument' };
  }
  if (args.signal !== undefined && (typeof args.signal !== "string" || args.signal.length === 0)) {
    return {
      ok: false,
      message: 'kill\'s "signal" argument, if provided, must be a non-empty string',
    };
  }
  return { ok: true, value: { jobId: args.job_id, signal: args.signal as string | undefined } };
}

/**
 * @param args - the raw `tools/call` arguments, exactly as the client sent
 *   them (unvalidated - validating against `inputSchema` is this handler's
 *   own job, matching `run`'s established pattern).
 */
/** The current public projection for `jobId`, INCLUDING its live output counts - a small local helper so every return path below doesn't repeat the `toPublicProjection(record, jobStore.getOutputCounts(jobId))` pair. */
function currentProjection(jobId: string): ReturnType<typeof toPublicProjection> {
  return toPublicProjection(jobStore.get(jobId)!, jobStore.getOutputCounts(jobId));
}

export async function handler(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const validated = validateKillInput(args);
  if (!validated.ok) return toolError(validated.message);
  const { jobId, signal } = validated.value;

  if (!jobStore.has(jobId)) {
    // Typed, distinctly-worded not-found - never confused
    // with a validation error or a generic internal exception.
    return toolError(`kill: no such job_id "${jobId}"`);
  }

  const record = jobStore.get(jobId)!;
  if (isTerminalJobState(record.state)) {
    // A terminal RECORD is not the same thing as "nothing left to reap" -
    // see jobStore.reapProcessGroupOnce's own docs for the root-exits-
    // first case this covers, and for the reap-once guard that makes this
    // a no-op once a group has already been swept (by the eager reap at
    // leader-exit, which has usually already run by the time a kill()
    // call reaches an already-terminal record, or by an earlier call
    // here). POSIX only: Windows has no equivalent fix today (no pgid
    // concept to reap against post-hoc).
    if (process.platform !== "win32") {
      await jobStore.reapProcessGroupOnce(jobId);
    }
    return toolSuccess(currentProjection(jobId));
  }

  const handle = jobStore.getChildHandle(jobId);
  if (handle === undefined) {
    // Defensive only - see this file's own docs: every non-terminal job
    // has a live attached child by construction (run.ts's handler is
    // fully synchronous between createJob/spawnManaged/attachChild, with
    // no `await` in between where an external kill() could observe a
    // partial state), so this should be unreachable in practice.
    return toolError(
      `kill: job "${jobId}" is not terminal but has no tracked child process - internal inconsistency`
    );
  }

  if (process.platform === "win32") {
    // Windows has NO graceful phase - immediate and
    // forceful, full stop, regardless of any caller-supplied `signal`.
    killProcessTreeWindows(handle.pid);
    jobStore.markKilled(jobId, "SIGKILL-equiv");
    return toolSuccess(currentProjection(jobId));
  }

  // Never signal a tracked pid without first evaluating, via a REAL
  // external OS lookup, whether it's still genuinely the process this
  // codebase spawned - see evaluatePreSignalIdentityGate's own docs for
  // every outcome this can produce, including the honest DEGRADED path
  // (identity could never be verified at all) that this file's own header
  // documents.
  //
  // `resolveBirthIdentityForKill`, not a direct `handle.birthIdentity`
  // read: run()'s own birth-identity capture is async and fire-and-forget
  // (see run.ts's own docs), so a kill() that arrives moments after run()
  // returns can genuinely race ahead of a still-in-flight capture. Reading
  // `handle.birthIdentity` directly at that instant would see `undefined`
  // and immediately fall back to the degraded path - technically honest,
  // but needlessly weaker than necessary, since the capture may well be
  // about to succeed. Awaiting the SAME in-flight capture instead (bounded
  // by its own hard timeout - see jobStore.ts's own docs) gives this call
  // a real chance at the confirmed identity comparison that is
  // the whole point of this containment mechanism, while a capture that
  // has already settled (or never started) resolves this immediately, at
  // no extra cost.
  const birthIdentity = await jobStore.resolveBirthIdentityForKill(jobId);
  const gate = await evaluatePreSignalIdentityGate(handle.pid, birthIdentity);
  if (gate.action === "skip") {
    // Already gone - most likely a natural-exit race (see this file's
    // docs): re-read the freshest record rather than trusting the one
    // fetched above, since the real onExit callback may already have
    // marked it exited by the time we get here.
    return toolSuccess(currentProjection(jobId));
  }
  if (gate.action === "refuse") {
    return toolError(`kill refused for job "${jobId}": ${gate.reason}`);
  }
  // gate.action === "proceed" from here on - gate.identityConfirmed
  // distinguishes a verified match from the honest, disclosed degraded
  // path (no captured identity, or the kill-time observer itself failed).

  if (signal !== undefined && signal !== "SIGTERM") {
    // The caller asked for a SPECIFIC signal, not the default graceful
    // shutdown - honor exactly that, once, with no automatic escalation
    // (escalation is specifically what the DEFAULT SIGTERM path does,
    // below). Marked as a reap attempt BEFORE signaling ONLY for SIGKILL -
    // the one signal this codebase treats as unable to be caught or
    // ignored, so this is deliberately the one and only cleanup attempt
    // this codebase will ever make against this exact pgid, regardless of
    // whether every member actually dies from receiving it (a process
    // wedged in uninterruptible sleep can survive SIGKILL receipt - see
    // this file's own docs further down for that same caveat stated in
    // full). Marking it now, before the send, is what makes the reap-once
    // guard hold even for that surviving case: no LATER signal against
    // this job will ever be attempted either, so it can never land on a
    // pgid this server no longer owns - the same continuity argument
    // `reapProcessGroupOnce`'s own docs make for the eager reap, applied
    // here to a caller-requested signal instead of a natural exit. ANY
    // OTHER custom signal (SIGSTOP and SIGCONT are the worked cases) sends
    // exactly what was asked without terminating anything, so it must
    // NEVER consume the one cleanup-reap opportunity: marking it
    // unconditionally here previously poisoned the reap-once guard for a
    // job that goes on to exit naturally much later, permanently
    // disabling the real safety net for whatever real, live descendants
    // its leader eventually leaves behind - a genuine leak, not a
    // theoretical one.
    if (signal === "SIGKILL") {
      jobStore.markReapAttempted(jobId);
    }
    const result = signalProcessGroupPosix(handle.pid, signal);
    if (!result.ok) return toolError(`kill: failed to signal job "${jobId}": ${result.message}`);
    // `result.ok` alone conflates a genuine send with an already-gone group
    // (ESRCH is reported as `ok: true, delivered: false` - see
    // `signalProcessGroupPosix`'s own docs). Only a genuine delivery may
    // ever claim `killed` with this requested signal below - an
    // already-gone outcome is confirmed success (the group really is
    // empty) but must never be recorded as though THIS call ended it.
    // Unlike the default SIGTERM path (whose eventual SIGKILL escalation
    // cannot be caught or ignored by an ordinary process, which is why
    // this codebase's own state machine treats it as decisive and marks
    // `killed` synchronously there, before confirmation - not because
    // physical death is itself guaranteed, since a process wedged in
    // uninterruptible sleep survives SIGKILL receipt; see the phased-path
    // comment below), THIS write never claims the job is
    // `killed` merely because a signal was SENT - it confirms the real,
    // external outcome FIRST via the same bounded process-group check
    // every other kill path already runs, and only writes the terminal
    // `killed` state once that actually confirms zero survivors. For a
    // signal with no termination guarantee (SIGSTOP, e.g., only pauses a
    // process, it never ends it) that is the ONLY way this job can ever
    // become terminal: when confirmation doesn't land (the group is
    // genuinely still alive - stopped, not killed - or the bound elapsed
    // without a definitive answer), the job stays in its current,
    // non-terminal state, reachable for a follow-up `kill()` or shutdown
    // reap, rather than falsely stranded as "killed" forever. For a
    // signal that cannot be caught or ignored (an explicit SIGKILL), this
    // write can be a no-op by the time it runs - `jobStore.markKilled`'s
    // own terminal-state guard - because the real process's own exit may
    // have already reached the job store first, independent of this
    // await; `kill_confirmed`/`identity_confirmed` are what this specific
    // write is actually for in that case.
    const confirmed = await confirmProcessGroupReapedPosix(handle.pid);
    if (confirmed) {
      if (result.delivered) {
        jobStore.markKilled(jobId, signal);
      }
      jobStore.setKillConfirmation(jobId, true);
      jobStore.setIdentityConfirmation(jobId, gate.identityConfirmed);
    }
    return toolSuccess(currentProjection(jobId));
  }

  // The real default - SIGTERM to the group, a real 5s
  // grace period, then SIGKILL to the group only if it's still alive.
  //
  // The kill/exit race: `onSignaled` fires SYNCHRONOUSLY,
  // immediately after each real signal actually sends - claiming the
  // terminal slot right then (via `markKilled` for the first SIGTERM,
  // `updateKillSignal` if escalation to SIGKILL later happens) is what
  // deterministically wins the race against this SAME job's own natural
  // `exit` event. Awaiting the whole phase-split-plus-wait sequence
  // FIRST and only then calling `markKilled` would lose that race almost
  // every time: the real
  // async wait inside `killProcessGroupPosix` gives the job's own `exit`
  // event - triggered by the very same signal - a real window to fire and
  // claim the terminal slot first, misreporting a job THIS CODE
  // deliberately killed as merely `exited`. This is safe to do
  // synchronously, unlike the explicit-signal branch above, because
  // SIGKILL cannot be caught or ignored by an ordinary process (this
  // codebase's own state machine treats it as decisive on that basis, not
  // on a claim that physical death is itself guaranteed - a process
  // wedged in uninterruptible sleep survives receipt of it, and a zombie
  // is already un-killable because it is already dead), so this state
  // decision does not depend on when the external confirmation below
  // actually resolves.
  //
  // Marked as a reap attempt BEFORE signaling, same reasoning as the
  // explicit-signal branch above: this is the moment of guaranteed
  // continuity, and `killProcessGroupPosix` itself now checks group
  // existence before it ever sends a signal (see that function's own
  // docs).
  jobStore.markReapAttempted(jobId);
  const result = await killProcessGroupPosix(handle.pid, POSIX_KILL_GRACE_PERIOD_MS, {
    onSignaled: (sentSignal) => {
      if (sentSignal === "SIGTERM") {
        jobStore.markKilled(jobId, "SIGTERM");
      } else {
        jobStore.updateKillSignal(jobId, "SIGKILL");
      }
    },
  });
  // The FINAL, external `pgrep`-based process-group confirmation -
  // `killProcessGroupPosix` already ran it after signaling settled; this
  // just records the honest confirmed/attempted-but-unconfirmed result
  // onto the job, never touching the state machine itself. The PRE-signal
  // identity gate's own outcome is recorded alongside it.
  jobStore.setKillConfirmation(jobId, result.confirmed);
  jobStore.setIdentityConfirmation(jobId, gate.identityConfirmed);
  return toolSuccess(currentProjection(jobId));
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolSuccess(projection: ReturnType<typeof toPublicProjection>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(projection, null, 2) }],
    structuredContent: { ...projection },
  };
}
