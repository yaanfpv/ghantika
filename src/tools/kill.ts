/**
 * `kill` - terminates a running background job and its WHOLE process tree.
 * This file owns `kill`'s registration/schema/validation/
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
 * (`detached: true`, assigned atomically at spawn time - no window where a
 * descendant could escape). Killing therefore means signaling the whole
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
 * ## PID-reuse defense
 *
 * Before ever signaling a tracked pid on POSIX, this handler calls
 * `process.checkProcessIdentity` - a REAL external `ps` lookup confirming
 * the pid is both alive and was started at approximately the time this
 * codebase recorded, never trusting internal bookkeeping alone. A mismatch
 * refuses to signal at all (see this file's own docs on that function for
 * its honest, stated limitations).
 *
 * ## Honest phase split
 *
 * POSIX: SIGTERM to the group, a REAL 5-second grace period
 * (`process.POSIX_KILL_GRACE_PERIOD_MS`), then SIGKILL to the group only
 * if it's still alive - this is the DEFAULT path (no `signal` argument, or
 * an explicit `"SIGTERM"`). A caller-supplied signal OTHER than `SIGTERM`
 * is instead sent exactly once, with no automatic escalation - the phased
 * grace-then-escalate behavior is specifically what the default path does.
 *
 * Windows: there is NO graceful phase at all - `TerminateJobObject`
 * (approximated here by `taskkill /f`) is immediate and forceful, full
 * stop, regardless of any `signal` argument the caller supplies. This file
 * never implements or claims a "graceful Windows shutdown."
 *
 * ## Idempotency and races
 *
 * An already-terminal job (whichever way it got there) is a no-op, never
 * an error - checked BEFORE ever touching the tracked child, so a job that
 * exited naturally in a race just before `kill` reached it is left exactly
 * as it was. Deterministic linearization comes for free from
 * `JobStore.markKilled` following the identical terminal-state guard every
 * other `mark*` transition already uses (first write wins). Unknown
 * `job_id` is a distinct, clearly-worded not-found error, never confused
 * with a validation error. Nothing here ever mutates a job's output
 * buffers - a killed job's buffered output remains readable afterward,
 * exactly as `run`/`status`/`output`/`tail` left it.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

import { isTerminalJobState, jobStore, toPublicProjection } from "../jobStore.js";
import {
  POSIX_KILL_GRACE_PERIOD_MS,
  checkProcessIdentity,
  killProcessGroupPosix,
  killProcessTreeWindows,
  signalProcessGroupPosix,
} from "../process.js";

export const name = "kill";

export const description =
  'Terminate a running background job and its whole process tree. POSIX: SIGTERM to the process group, a real 5-second grace period, then SIGKILL if it\'s still alive - this is also what happens if "signal" is explicitly set to "SIGTERM", since that IS the default; pass a DIFFERENT "signal" to skip the grace period and send exactly that one signal instead, once. The process-group signal is atomic. Windows: an immediate, forceful whole-tree kill via taskkill /t /f, with no graceful phase - real and recursive, but not atomic (a narrow race window exists); a real Windows Job Object for atomic containment is a tracked future enhancement. Idempotent: killing an already-terminal job is a no-op, not an error.';

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
    // An already-terminal job is a no-op, never an error -
    // nothing left to signal, and the job's own output buffers are
    // untouched (kill never writes to them).
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

  // Never signal a tracked pid without first confirming,
  // via a REAL external OS lookup, that it's still genuinely the process
  // this codebase spawned.
  const identity = checkProcessIdentity(handle.pid, handle.spawnedAtMs);
  if (identity.status === "not-found") {
    // Already gone - most likely a natural-exit race (see this file's
    // docs): re-read the freshest record rather than trusting the one
    // fetched above, since the real onExit callback may already have
    // marked it exited by the time we get here.
    return toolSuccess(currentProjection(jobId));
  }
  if (identity.status === "identity-mismatch") {
    return toolError(`kill refused for job "${jobId}": ${identity.reason}`);
  }

  if (signal !== undefined && signal !== "SIGTERM") {
    // The caller asked for a SPECIFIC signal, not the default graceful
    // shutdown - honor exactly that, once, with no automatic escalation
    // (escalation is specifically what the DEFAULT SIGTERM path does,
    // below).
    const result = signalProcessGroupPosix(handle.pid, signal);
    if (!result.ok) return toolError(`kill: failed to signal job "${jobId}": ${result.message}`);
    jobStore.markKilled(jobId, signal);
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
  // deliberately killed as merely `exited`.
  await killProcessGroupPosix(handle.pid, POSIX_KILL_GRACE_PERIOD_MS, {
    onSignaled: (sentSignal) => {
      if (sentSignal === "SIGTERM") {
        jobStore.markKilled(jobId, "SIGTERM");
      } else {
        jobStore.updateKillSignal(jobId, "SIGKILL");
      }
    },
  });
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
