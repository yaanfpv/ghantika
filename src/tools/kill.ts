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
 * - a REAL external observation comparing the tracked leader's actual birth
 * identity against the one captured at spawn time. This comparison is
 * PLATFORM-SPECIFIC (see `process.checkProcessIdentity`'s own docs for the
 * full rationale, and `process.ProcessBirthIdentity`'s own docs for why the
 * two platforms need genuinely different captured shapes): on Linux it
 * re-reads `/proc/<pid>/stat`'s own `starttime` field (a raw kernel
 * counter, clock ticks since boot) directly and compares it against the
 * captured value for EXACT STRING equality - no tolerance window, no
 * elapsed-time derivation at all, so it is immune to the class of bug
 * where `ps -o etime=`'s own boot-time/uptime conversion can go wrong
 * inside a virtualized guest (see this repository's CHANGELOG for the
 * real defect class this closes). On macOS, which has no `/proc` filesystem, it
 * shells out to `ps` and compares real elapsed time within a
 * several-second tolerance instead - a best-effort, probabilistic check,
 * NOT a cryptographic guarantee: a pid+pgid reused by an unrelated process
 * within that same narrow window cannot always be told apart from the
 * original - an accepted, extremely unlikely residual, never claimed
 * "exact." The Linux comparison's exact-match rule has no such tolerance
 * window to exploit, but it is not a cryptographic guarantee either - pid
 * recycling itself remains possible in principle; it only removes the "our
 * own derived elapsed time drifted" class of false confirmation the
 * tolerance-based comparison is exposed to. A clear mismatch refuses to
 * signal at all (a PRE-SIGNAL fail-closed gate), on either platform. When
 * identity cannot be verified at all - no birth identity was ever
 * captured, or the kill-time observation itself fails - this handler does
 * NOT silently treat that as either "confirmed" or "nothing to signal": it
 * proceeds via an honest DEGRADED path (pgid-only signaling, no identity
 * confirmation), disclosed via the job's `identity_confirmed: false` field
 * - see `process.evaluatePreSignalIdentityGate`'s own docs for the full
 * rationale.
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
 * ## Escalation identity gate
 *
 * The PID-reuse defense above governs the FIRST signal only. A SEPARATE,
 * later gate governs the SIGKILL escalation on the default terminating
 * path: before `process.killProcessGroupPosix` ever escalates, it
 * snapshots the group's ORIGINAL membership - the leader plus every
 * currently-live descendant, each one's pid and real OS-read start time -
 * BEFORE the SIGTERM above is sent, waits the grace period, then
 * boundedly re-reads ONLY those same recorded members. If any ONE of them
 * still reports an EXACTLY matching start time, the group is still ours
 * and the SIGKILL proceeds; if none matches, escalation is REFUSED and no
 * SIGKILL is ever sent. The leader is not a special case here - it is
 * compared through the identical exact-match rule as every descendant, no
 * tolerance window (that tolerance belongs to the pre-signal gate above,
 * a wholly separate mechanism). Every observation this gate makes is
 * bounded and force-reaped (`process.PROCESS_IDENTITY_OBSERVATION_TIMEOUT_MS`,
 * strictly less than the grace period), and a degraded or failed
 * observation at any point NEVER defaults to a permissive outcome - it
 * refuses, per `process.evaluateEscalationIdentityGate`'s own full
 * enumeration of fail-closed cells.
 *
 * THE RESIDUAL is disclosed as MATERIALLY NARROWED, never as closed or
 * eliminated: this gate does not make identity-and-signal atomic. After
 * it establishes an original member is still alive, and before the
 * SIGKILL syscall actually runs, that member can exit and the numeric
 * pgid can become reusable - the check and the signal are two separate
 * syscalls, and
 * portable POSIX offers no atomic check-and-signal for a process group.
 * This narrows the exposure from the multi-second grace window down to
 * one syscall-to-syscall interval plus this gate's own whole-second
 * `lstart` resolution - it does not eliminate it.
 *
 * THE COMBINED-DEGRADED CELL: when the pre-signal gate above ALSO never
 * confirmed this job's identity (`identity_confirmed: false`) and this
 * escalation gate's own pre-SIGTERM snapshot ALSO failed to capture a
 * usable member, the earlier SIGTERM is honestly described as an
 * UNCONFIRMED BEST-EFFORT send - never "confirmed" or "guarded" - because
 * neither layer positively confirmed anything before it went out
 * (refusing to send it at all would make an already-hard-to-observe job
 * unkillable exactly when observation is failing, which the pre-signal
 * gate already rejects on purpose). Where the pre-signal gate DID confirm
 * a positive match and only this escalation snapshot failed, the first
 * signal genuinely WAS guarded, and the disclosed `escalation_refused_reason`
 * says so distinctly rather than collapsing the two cases into one
 * wording - see this handler's own composition of that field, below.
 *
 * ## Process-group confirmation, honestly disclosed
 *
 * After signaling completes (whichever phase actually finished the job),
 * this handler runs a bounded, best-effort EXTERNAL process-group check
 * (`process.confirmProcessGroupReapedPosix`, a real `pgrep -g` read of the
 * process table) and records the honest result as the job's
 * `kill_confirmed` field: `true` once zero surviving process-group members
 * were actually observed within the bound, `false` if the bound elapsed
 * without confirming - NEVER silently claimed `true` when it wasn't. The
 * write is NOT gated on, and never waits for, the record's own terminal
 * transition - it can land before, after, or interleaved with it, since
 * the two are independent (see jobStore.ts's own `kill_confirmed` field
 * doc for the full contract, including the separate never-spawned case
 * this handler's own external check never runs for at all).
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
 * to reap." Two genuinely different real situations both reach this
 * handler's terminal-job branch with something still alive to reap: the
 * ROOT-EXITS-FIRST case (a real process GROUP where the leader forks
 * descendants and then exits on its own - e.g. a shell script that
 * backgrounds children and never `wait`s on them - leaves those
 * descendants alive and orphaned under the SAME pgid, since the leader's
 * own natural exit does not kill them), and the COMBINED-DEGRADED RETRY
 * case (a job whose earlier `kill()` call left it terminal - `killed`,
 * set synchronously by `onSignaled` - but whose group was never actually
 * confirmed reaped, because neither identity layer could confirm
 * anything and the SIGKILL escalation was correctly refused; see the
 * "escalation identity gate" section above and `jobStore.markReapAttempted`'s
 * own call-site docs below). The first case's leader is always already
 * gone; the second case's leader can be very much still alive. So a
 * terminal record still gets a real, external, group-level reap attempt
 * (see `jobStore.reapProcessGroupOnce`) before this handler ever
 * returns - but that attempt NEVER signals when this call is itself the
 * combined-degraded RETRY case: by the time a follow-up `kill()` reaches
 * an already-terminal record, ownership continuity over the tracked
 * numeric pid is no longer guaranteed (see `jobStore.reapProcessGroupOnce`'s
 * own "RETRY SAFETY" docs for the full reasoning), so this codebase only
 * ever re-checks EXISTENCE on that retry, never re-signals - a genuinely
 * still-alive, SIGTERM-resistant group left in exactly that state stays a
 * permanently disclosed unconfirmed residual rather than receiving a
 * further signal this codebase can no longer confirm targets its own
 * process group. The root-exits-first case is unaffected: it is always
 * this job's FIRST real reap attempt (guaranteed continuity, since the
 * group has held its pgid continuously since spawn), so it signals
 * normally. POSIX only: Windows has no equivalent root-exits-first fix
 * today (no pgid concept to reap against post-hoc - see
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

import {
  isTerminalJobState,
  jobStore,
  reapOutcomeToReleaseDecision,
  toPublicProjection,
} from "../jobStore.js";
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
  'Terminate a running background job by signaling its whole POSIX process group. Default: SIGTERM, a 5-second grace period, then SIGKILL if still alive - this is also what an explicit "SIGTERM" does, since that IS the default. Pass a different "signal" (including "SIGKILL") to skip the grace period and send exactly that one signal once. An unconfirmed kill can leave the real process group still alive even though the job now shows a terminal state; when that happens, calling "kill" again with the SAME "job_id" re-checks whether that group has since become empty and completes the recovery if so, but it never sends another signal - by then this server can no longer confirm the tracked numeric id still names the same group it originally spawned rather than an unrelated one that has since reused it, so a group that still reads alive at that point stays a disclosed, unconfirmed residual instead of being signaled again. The grace period carries a disclosed residual: the group can fully empty during that wait - its ordinary, intended outcome - and have its numeric id recycled by an unrelated later group before the pre-SIGKILL existence check that follows the wait actually runs; that check narrows the window between "still alive" and "about to send SIGKILL" as far as an existence check can, but cannot close it, since existence alone cannot tell a survived original group apart from a coincidentally-reused one. This is distinct from the eager-reap gap described below, which is a single scheduling tick rather than up to a whole grace period, and is not addressed by the once-per-job reap guard, which only ever prevents a later kill call from re-signaling, not a reused id encountered within this same escalation. A further identity gate applies specifically to that SIGKILL escalation: right before the SIGTERM above is sent, this server snapshots the group\'s original membership - the leader plus every currently-live descendant, each one\'s pid and real OS-read start time - then, once the grace period has elapsed and the group is still alive, boundedly re-reads only those same recorded members. If any one of them still reports an exactly matching start time, the group is still the one this server spawned and the SIGKILL proceeds; if none matches, escalation is refused and no SIGKILL is ever sent, disclosed via an "escalation_refused_reason" field once the job reaches a terminal state. This narrows the residual described above materially, not completely: the check and the signal remain two separate syscalls, so a member proven alive an instant before the SIGKILL runs can still exit, and an unrelated group receiving the exact same recycled id within the same whole second could still read as a match. Any failure while making this observation - a timeout, an unreadable start time, malformed output, or capturing zero usable members at all - refuses escalation rather than defaulting to it. When identity could not be confirmed at either this layer or the pre-signal check below, the earlier SIGTERM is honestly disclosed as an unconfirmed best-effort send, never as confirmed or guarded. Before signaling, a real external check confirms the tracked leader is still genuinely the process this server spawned, against the birth identity captured at spawn time - platform-specific: on Linux it compares a raw kernel start-time counter for EXACT equality (immune to the virtualized-guest boot-time/uptime-conversion bug class an elapsed-time reading can hit), on macOS it compares real vs. expected elapsed lifetime within a several-second tolerance instead. Either way this is best-effort, not a cryptographic guarantee; a clear mismatch refuses to signal at all. That birth identity is captured asynchronously right after the job started; a kill sent moments later may briefly await that in-flight capture rather than giving up on it. When identity can\'t be verified at all, the group is still signaled, honestly disclosed via "identity_confirmed": false once the job reaches a terminal state. A job whose leader already exited on its own gets a real external reap for any process-group members it left behind - attempted automatically the instant that exit is observed. At most one signal-capable attempt is made per job; if that attempt does not confirm the group is empty, a later "kill" call against the same "job_id" can still re-check existence without sending any further signal, exactly like the unconfirmed-kill recovery described above. That reap only ever sets "kill_confirmed", never "identity_confirmed", since the leader is already gone and its identity is never re-checked there. While the group still holds a member the OS cannot recycle its id, so continuity proves ownership up to the moment the last member leaves - but where the leader has no surviving descendants, it IS the last member, and the group empties at exactly that exit, so no continuity reaches this server\'s own callback. The residual this leaves is the gap between the group emptying and that callback\'s existence check actually running: normally very short, but with no fixed upper bound, since it is event-loop scheduling latency a busy event loop can stretch well past - unlike the birth-identity comparison above (a stated several-second tolerance on macOS, or an exact kernel-counter match with no tolerance concept at all on Linux), this is deliberately never stated as a wall-clock bound. "kill_confirmed" true means EITHER an external process-table check found no processes still assigned to the job\'s ORIGINAL PROCESS GROUP - never a whole-tree or zero-surviving-descendants guarantee - OR the job never actually spawned a process group at all (an invalid cwd, an unresolvable executable, a policy denial, or a genuine async spawn failure), settled true as part of the job\'s own creation or terminal transition since there is nothing to check; false only ever means an external check was needed and could not be confirmed within the bound - a never-spawned job never reads false. On the DEFAULT path (no "signal", or explicit "SIGTERM"), both fields are set once the job is actually terminated, and the job\'s "killed" state itself is reported synchronously. A caller-supplied signal OTHER than "SIGTERM" is different: for a non-terminating one (SIGSTOP), confirmation is what makes the job terminal at all, so both fields stay simply absent while it remains non-terminal. For a terminating one, including an explicit "SIGKILL", the state can independently reach "killed" via the process\'s own real exit, while both fields still stay simply absent - never false - until confirmation actually lands. Windows: an immediate, forceful whole-tree kill via taskkill /t /f, with no graceful phase - real and recursive, but not atomic; no identity check or process-group confirmation is performed on Windows today. A descendant that calls setsid() or otherwise moves itself into a different process group is neither signaled by this containment nor observed by its confirmation check; reparenting alone is not such an escape, since reparenting changes a process\'s parent, never its process group. If your command spawns a process that detaches into its own group or session, you are responsible for tracking and terminating it yourself - this tool will not, and does not claim to. Idempotent: killing an already-terminal job is a no-op with respect to the job\'s own recorded state, though it may still attempt a real cleanup reap. A job still waiting in the concurrency queue (it has not spawned yet) is removed from the queue and settles to "killed" immediately - there is no process to signal, so none of the identity/confirmation machinery above applies to it.';

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
    //
    // MANUAL LATE-RECOVERY: this call also doubles as the manual
    // counterpart to `jobStore`'s own bounded AUTOMATIC stranded-slot
    // retry (`releaseSlot`'s fail-closed handling) - if the eager reap at
    // leader-exit came back unconfirmed and this job's concurrency slot
    // is still stranded, a caller retrying `kill()` against an already-
    // terminal job now gets a real second (or Nth - this path is
    // unbounded, unlike the automatic retry's own budget) chance to
    // recover it. Only calls `releaseSlot` when THIS call's own fresh
    // reap actually confirms - via the SAME shared
    // `reapOutcomeToReleaseDecision` every other caller must use, never
    // an ad hoc re-derivation - so an unconfirmed retry here correctly
    // changes nothing (the slot stays stranded, still counted active,
    // still eligible for the next automatic retry or a future manual
    // one). `releaseSlot(jobId)` with no second argument, since this
    // call has already confirmed the decision itself out of band -
    // there is nothing left to await.
    if (process.platform !== "win32") {
      const outcome = await jobStore.reapProcessGroupOnce(jobId);
      if (reapOutcomeToReleaseDecision(outcome) === "confirmed") {
        await jobStore.releaseSlot(jobId);
      }
    }
    return toolSuccess(currentProjection(jobId));
  }

  if (record.queue_position !== undefined) {
    // Still waiting in the FIFO concurrency queue - it never spawned a
    // real child at all (JobStore.attachChild only ever runs once a job
    // actually starts - see JobStore.enqueueJob's own docs), so there is
    // nothing to signal. Dequeue it directly and settle it to killed:
    // this is the legitimate non-terminal-with-no-child case the
    // "internal inconsistency" branch below must never see.
    jobStore.removeFromQueue(jobId);
    jobStore.markKilled(jobId, "queue-cancelled");
    return toolSuccess(currentProjection(jobId));
  }

  const handle = jobStore.getChildHandle(jobId);
  if (handle === undefined) {
    // Defensive only - see this file's own docs: every non-terminal,
    // non-queued job has a live attached child by construction (run.ts's
    // handler is fully synchronous between createJob/spawnManaged/
    // attachChild, with no `await` in between where an external kill()
    // could observe a partial state, and a still-queued job - the one
    // legitimate non-terminal case with no attached child - is already
    // handled above), so this should be unreachable in practice.
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
  // actually resolves. CLAIMING THE TERMINAL SLOT stays exactly this
  // synchronous, unconditional shape - it is what wins the race above,
  // and nothing below changes it.
  //
  // CONSUMING THE ONE REAP ATTEMPT is a separate decision from claiming
  // the terminal slot, and it is deliberately NOT made up front alongside
  // it - see the mark below, once this call's own outcome is known.
  // Marking it here, before this call even ran, used to mean a group
  // that survived this whole call UNCONFIRMED (the combined-degraded
  // cell: neither the pre-signal identity gate above nor the escalation
  // gate's own pre-SIGTERM snapshot could confirm anything, escalation
  // was correctly refused, and no SIGKILL was ever sent - see this file's
  // own "escalation identity gate" header section) still had its ONE
  // cleanup-reap attempt permanently spent by a call that never actually
  // reaped anything. A real, still-alive, SIGTERM-resistant group left in
  // exactly that state was then unreachable forever: a follow-up `kill()`
  // call against the same (now-terminal) job record routes through this
  // handler's own terminal-job branch above, which calls
  // `jobStore.reapProcessGroupOnce` - and that call is a pure no-op
  // whenever `hasReapBeenAttempted` already reads `true`, regardless of
  // whether the group is genuinely still alive. Fixing this needs no new
  // API or flag: `reapProcessGroupOnce`'s existing guard just needs the
  // SAME flag to actually mean "a reap was attempted AND CONFIRMED," never
  // merely "a reap was attempted, confirmed or not."
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
  // identity gate's own outcome is recorded alongside it. Captures whether
  // the write actually landed - see `setKillConfirmation`'s own docs for
  // why it can now return `false` (the record no longer exists) even
  // though it no longer gates on the record's `state`.
  const wrote = jobStore.setKillConfirmation(jobId, result.confirmed);
  if (result.confirmed && wrote) {
    // Consume the one cleanup-reap attempt now, and ONLY now that this
    // call's own external check actually confirmed zero survivors AND the
    // confirmation actually landed on the record - see this block's own
    // header comment above for why marking moved off the front of the
    // call instead of running unconditionally beforehand, and see
    // `setKillConfirmation`'s own docs for why the write can fail to land
    // even on a confirmed outcome. This flag stays UNSET for two distinct
    // reasons with two distinct consequences - not one, and only the
    // first is a retry:
    //
    // An UNCONFIRMED outcome (including the combined-degraded
    // refused-escalation cell) leaves the record itself untouched and
    // reachable, so a follow-up `kill()` call finds `hasReapBeenAttempted`
    // still `false` and genuinely re-consults `reapProcessGroupOnce` -
    // rather than finding its one attempt already spent on a call that
    // never actually recorded a reap outcome. That re-consultation NEVER
    // signals again, though - see `reapProcessGroupOnce`'s own "RETRY
    // SAFETY" docs: it can confirm the group is now gone, but a group
    // that still reads alive stays a permanently disclosed unconfirmed
    // residual instead of receiving a second signal this codebase can no
    // longer confirm targets the same process group it originally
    // spawned.
    //
    // A CONFIRMED outcome whose write did not land means the record
    // itself is gone (`setKillConfirmation` only ever refuses for that
    // reason - the only production path today is the lazy TTL purge
    // racing this same await). There is no retry to protect in this
    // branch, but the guard is not a no-op either: `markReapAttempted`
    // has no existence check of its own, so calling it here anyway would
    // add this job id to the reap-attempted set with no record left
    // behind it - `hasReapBeenAttempted` reading `true` for an id `get`
    // can no longer find. This is STALE-BOOKKEEPING CLEANUP, a real
    // invariant, not a retry protection.
    jobStore.markReapAttempted(jobId);
  }
  jobStore.setIdentityConfirmation(jobId, gate.identityConfirmed);
  if (result.escalationRefusedReason !== undefined) {
    // THE COMBINED-DEGRADED CELL, composed here rather than inside
    // evaluateEscalationIdentityGate itself, since only this call site
    // holds BOTH layers' own outcomes at once: the PRE-signal identity
    // gate above (`gate.identityConfirmed`) and the escalation identity
    // gate's own pre-SIGTERM snapshot (`result.escalationRefusedReason`).
    // When the pre-signal gate ALSO never confirmed this job's identity,
    // the SIGTERM actually sent was a best-effort send under that gate's
    // own accepted residual - it must never be described as "confirmed"
    // or "guarded" here, since neither layer positively confirmed
    // anything before it went out. When the pre-signal gate DID confirm a
    // positive match and only this escalation snapshot failed, that first
    // signal genuinely WAS guarded, and the result says so distinctly
    // rather than collapsing the two cases into one wording.
    const reason = gate.identityConfirmed
      ? `${result.escalationRefusedReason} - the earlier SIGTERM was guarded: the pre-signal identity check confirmed this job's identity before it was sent.`
      : `${result.escalationRefusedReason} - identity was never confirmed at either the pre-signal or the pre-SIGTERM-snapshot layer; the earlier SIGTERM was sent best-effort, not confirmed.`;
    jobStore.setEscalationRefusedReason(jobId, reason);
  }
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
