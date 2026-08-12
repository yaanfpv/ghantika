/**
 * Proves `status`'s own additive `pid`/`birth_identity` fields
 * (`src/tools/status.ts`'s `StatusProjection`), end to end, against the
 * following properties:
 *
 *   a1/a3 - pid is present for a job that ever got a live child, for both
 *     a live and a terminal job (the SAME pid, retained past exit).
 *   a2    - pid is never reported alone; birth_identity travels with it.
 *   a4/a6 - additive-only, STATUS-ONLY: run/kill/list carry neither field.
 *   a7    - the three-state (pending/captured/unavailable) contract is
 *     STRUCTURALLY exhaustive and non-collapsing - proven both as pure
 *     unit tests against `buildBirthIdentityProjection` directly (every
 *     input combination, including the defensive/inconsistent ones) and
 *     as a real, deterministic race against the live async capture.
 *   a8    - a captured identity is platform-tagged, matching this host's
 *     own `process.platform`.
 *
 * `buildBirthIdentityProjection` is exercised directly for the
 * pure-mapping half (see its own docs in src/tools/status.ts for why it's
 * exported) - no timing, no spawn, runs identically on every platform.
 * The end-to-end half spawns REAL children (never a mock ChildProcess),
 * matching this repo's own established preference
 * (test/jobStore.test.ts's own "attachRealChild" helper comment) - and
 * cleans each one up via a negative-pid process-group SIGKILL, which has
 * no Windows equivalent, so those specific tests are POSIX-only (see each
 * test's own skip reason). The pure unit tests above are NOT
 * platform-gated at all.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import { jobStore } from "../dist/jobStore.js";
import * as killTool from "../dist/tools/kill.js";
import * as listTool from "../dist/tools/list.js";
import * as runTool from "../dist/tools/run.js";
import * as statusTool from "../dist/tools/status.js";

import { requireSpawnPolicy } from "./helpers/requireSpawnPolicy.ts";

// Only SOME of the tests in this file actually dispatch a real command
// through the real `run` tool's handler with a target that resolves to a
// real executable, which is what's required to reach
// src/policy.ts's decideRunPolicy - see test/helpers/requireSpawnPolicy.ts
// for what this checks and why, and its own header for why the guard must
// be scoped to the narrowest before() that covers only those tests rather
// than registered file-level. This file mixes several different shapes,
// so each gets its own local comment at its own site below rather than
// one blanket rule here:
//
//   - The pure unit tests against buildBirthIdentityProjection never call
//     runTool.handler at all - no spawn, no gate, nothing to guard.
//   - The a1/a2/a7, a2/a7/a8, and a3 tests DO call runTool.handler with a
//     real, resolvable command (process.execPath) - decideRunPolicy runs
//     for each of them, and their own assertions depend on the job
//     actually being admitted, so these are the ones that need the guard.
//     They're grouped in their own describe() block below, scoped to just
//     that block.
//   - The "a1 negative case" test also calls runTool.handler, but with a
//     command that never resolves to a real executable at all -
//     resolveExecutable fails and run.ts's handler returns a
//     "command not found" failed job BEFORE ever calling decideRunPolicy
//     (see src/tools/run.ts's own handler), so that call reaches the
//     policy gate no more than the pure unit tests above do.
//   - The a4/a6 tests further down also call runTool.handler with a real,
//     resolvable command, so decideRunPolicy genuinely does run for each
//     of them - but what each one actually asserts is a structural
//     property of run()'s/kill()'s/list()'s own response shape (no
//     pid/birth_identity key on THAT tool's response), which holds
//     identically whether the underlying job is admitted or denied by
//     policy. An absent/empty policy file can never turn any of those
//     three assertions into a failure, so there's no confusing
//     policy-denied failure for the guard to preempt there.

const POSIX_ONLY_SKIP =
  process.platform === "win32"
    ? "spawns a real child and cleans it up via a negative-pid process-group SIGKILL, POSIX-only (matches test/jobStore.test.ts's own convention)"
    : false;

function structuredOf(result: {
  structuredContent?: Record<string, unknown>;
}): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function jobIdOf(result: ReturnType<typeof runTool.handler>): string {
  const structured = structuredOf(result);
  assert.equal(
    typeof structured.job_id,
    "string",
    `expected a real job_id, got: ${JSON.stringify(result)}`
  );
  return structured.job_id as string;
}

/** Best-effort cleanup for a job this file spawned directly via runTool - mirrors test/job-metadata-redaction.test.ts's own cleanup pattern exactly. */
function killJobGroup(jobId: string): void {
  const handle = jobStore.getChildHandle(jobId);
  if (handle === undefined) return;
  try {
    process.kill(-handle.pid, "SIGKILL");
  } catch {
    // already gone - fine, this is best-effort cleanup only.
  }
}

/** Polls status() until birth_identity settles away from "pending" (or a deadline elapses) - no fixed sleep, since real ps/proc-read timing is never exact. */
async function waitForBirthIdentitySettled(
  jobId: string
): Promise<{ state?: string; identity?: unknown }> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const structured = structuredOf(statusTool.handler({ job_id: jobId }));
    const birthIdentity = structured.birth_identity as { state?: string; identity?: unknown };
    if (birthIdentity.state !== "pending") return birthIdentity;
    if (Date.now() > deadline) {
      throw new Error(
        `job ${jobId}'s birth_identity did not settle away from "pending" within this test's own wait budget`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Polls status() until the job reaches a terminal state - mirrors test/job-metadata-redaction.test.ts's own waitForTerminal helper. */
async function waitForTerminal(jobId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const structured = structuredOf(statusTool.handler({ job_id: jobId }));
    if (["exited", "killed", "failed"].includes(structured.state as string)) return structured;
    if (Date.now() > deadline) {
      throw new Error(
        `job ${jobId} did not reach a terminal state within this test's own wait budget`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// a7 (pure): buildBirthIdentityProjection's three-state contract, against
// synthetic inputs - no spawn, no timing, runs on every platform.
// ---------------------------------------------------------------------------

test("buildBirthIdentityProjection: a real posix-elapsed identity is reported captured, carrying the identity verbatim, regardless of captureState", () => {
  const identity = {
    platform: "posix-elapsed" as const,
    capturedAtMs: 123,
    elapsedSecondsAtCapture: 0,
  };
  for (const captureState of ["pending", "captured", "unavailable", undefined] as const) {
    assert.deepEqual(statusTool.buildBirthIdentityProjection(identity, captureState), {
      state: "captured",
      identity,
    });
  }
});

test("buildBirthIdentityProjection: a real linux-starttime-ticks identity is reported captured, carrying the identity verbatim", () => {
  const identity = { platform: "linux-starttime-ticks" as const, startTimeTicks: "123456" };
  assert.deepEqual(statusTool.buildBirthIdentityProjection(identity, "pending"), {
    state: "captured",
    identity,
  });
});

test('buildBirthIdentityProjection: no identity yet + captureState "pending" -> {state: "pending"} exactly, no identity key at all', () => {
  const result = statusTool.buildBirthIdentityProjection(undefined, "pending");
  assert.deepEqual(result, { state: "pending" });
  assert.equal(
    "identity" in result,
    false,
    "a pending projection must never carry an identity key"
  );
});

test('buildBirthIdentityProjection: no identity + captureState "unavailable" -> {state: "unavailable"} exactly, no identity key at all', () => {
  const result = statusTool.buildBirthIdentityProjection(undefined, "unavailable");
  assert.deepEqual(result, { state: "unavailable" });
  assert.equal(
    "identity" in result,
    false,
    "an unavailable projection must never carry an identity key"
  );
});

test('buildBirthIdentityProjection: no identity + captureState undefined ("never attempted") collapses to unavailable, never a fourth wire value', () => {
  assert.deepEqual(statusTool.buildBirthIdentityProjection(undefined, undefined), {
    state: "unavailable",
  });
});

test('buildBirthIdentityProjection: DEFENSIVE - no identity present but captureState claims "captured" never fabricates an identity payload; falls back to unavailable', () => {
  // This shape should never occur in production (setBirthIdentity always
  // runs before identity_capture flips to "captured" - see
  // JobStore.attachPendingIdentityCapture's own docs), but this function
  // checks the real birthIdentity value FIRST rather than trusting the
  // bookkeeping string, so even an inconsistent input can never produce a
  // "captured" result with no identity to back it.
  assert.deepEqual(statusTool.buildBirthIdentityProjection(undefined, "captured"), {
    state: "unavailable",
  });
});

test("buildBirthIdentityProjection: STRUCTURAL exhaustiveness - every one of the three real outputs carries an identity key if and only if its state is captured, so pending/unavailable can never be confused via a shared nullable field", () => {
  const pending = statusTool.buildBirthIdentityProjection(undefined, "pending");
  const unavailable = statusTool.buildBirthIdentityProjection(undefined, "unavailable");
  const captured = statusTool.buildBirthIdentityProjection(
    { platform: "posix-elapsed", capturedAtMs: 1, elapsedSecondsAtCapture: 0 },
    "pending"
  );
  assert.deepEqual(Object.keys(pending), ["state"]);
  assert.deepEqual(Object.keys(unavailable), ["state"]);
  assert.deepEqual(Object.keys(captured).sort(), ["identity", "state"]);
  assert.notEqual(
    JSON.stringify(pending),
    JSON.stringify(unavailable),
    "pending and unavailable must serialize to genuinely different wire shapes"
  );
});

// ---------------------------------------------------------------------------
// a1/a2/a3/a7 (end-to-end): a real job's pid + birth_identity, live and
// terminal, and the deterministic pending race.
// ---------------------------------------------------------------------------

describe("status: the real end-to-end birth-identity race (against a real spawned job)", () => {
  // Each test below dispatches a real command through the real `run`
  // tool's handler with a resolvable executable (process.execPath), which
  // is what actually reaches decideRunPolicy - see this file's own
  // top-of-file comment for the full breakdown of which tests in this
  // file do and don't, and test/helpers/requireSpawnPolicy.ts for what
  // this guard checks and why. But every one of them is also marked
  // POSIX_ONLY_SKIP below - on win32 that skips all three, so
  // registering this hook unconditionally would still throw there under an
  // unset policy variable with nothing left to run. Register it only
  // where a child can actually reach it.
  if (process.platform !== "win32") {
    before(requireSpawnPolicy);
  }

  test(
    "a1/a2/a7: status() called synchronously right after run() (no await between them) observes birth_identity still pending, with a real pid already present alongside it - never the pid alone",
    { skip: POSIX_ONLY_SKIP },
    () => {
      const runResult = runTool.handler({
        command: [process.execPath, "-e", "setTimeout(() => {}, 2000)"],
      });
      const jobId = jobIdOf(runResult);
      try {
        // No `await` anywhere between run() and status() below - run()'s own
        // handler is synchronous (never awaits anything - see its own
        // docs), and the real async ps/proc-based capture it kicks off
        // cannot settle without at least one real event-loop turn (forking
        // an observer process is inherently asynchronous), so this is a
        // deterministic, non-flaky way to observe "pending" via the real
        // production code path rather than a mock.
        const statusResult = structuredOf(statusTool.handler({ job_id: jobId }));
        assert.equal(typeof statusResult.pid, "number");
        assert.ok((statusResult.pid as number) > 0, "expected a real positive OS pid");
        const handle = jobStore.getChildHandle(jobId);
        assert.equal(
          statusResult.pid,
          handle?.pid,
          "status()'s reported pid must be the SAME pid jobStore itself tracks for this job"
        );
        assert.deepEqual(
          statusResult.birth_identity,
          { state: "pending" },
          "birth_identity must read exactly pending at this exact synchronous instant, never a fabricated captured/unavailable answer"
        );
      } finally {
        killJobGroup(jobId);
      }
    }
  );

  test(
    "a2/a7/a8: once settled, a live job's birth_identity is captured (or, rarely, honestly unavailable) - never fabricated - and a captured identity is platform-tagged matching this host",
    { skip: POSIX_ONLY_SKIP },
    async () => {
      const runResult = runTool.handler({
        command: [process.execPath, "-e", "setTimeout(() => {}, 3000)"],
      });
      const jobId = jobIdOf(runResult);
      try {
        const settled = await waitForBirthIdentitySettled(jobId);
        assert.ok(
          settled.state === "captured" || settled.state === "unavailable",
          `expected birth_identity to settle to captured or unavailable, got: ${JSON.stringify(settled)}`
        );
        if (settled.state === "captured") {
          const identity = settled.identity as { platform?: string };
          if (process.platform === "linux") {
            assert.equal(identity.platform, "linux-starttime-ticks");
            assert.equal(
              typeof (identity as { startTimeTicks?: unknown }).startTimeTicks,
              "string",
              `expected a Linux identity to carry a string startTimeTicks, got: ${JSON.stringify(identity)}`
            );
          } else {
            assert.equal(identity.platform, "posix-elapsed");
            assert.equal(
              typeof (identity as { capturedAtMs?: unknown }).capturedAtMs,
              "number",
              `expected a posix-elapsed identity to carry a numeric capturedAtMs, got: ${JSON.stringify(identity)}`
            );
            assert.equal(
              typeof (identity as { elapsedSecondsAtCapture?: unknown }).elapsedSecondsAtCapture,
              "number",
              `expected a posix-elapsed identity to carry a numeric elapsedSecondsAtCapture, got: ${JSON.stringify(identity)}`
            );
          }
        }
        // pid is stable across the whole settlement race - status() at any
        // point in time reports the SAME tracked pid.
        const finalStatus = structuredOf(statusTool.handler({ job_id: jobId }));
        assert.equal(finalStatus.pid, jobStore.getChildHandle(jobId)?.pid);
      } finally {
        killJobGroup(jobId);
      }
    }
  );

  test(
    "a3: a TERMINAL job retains the pid it HAD and reports whatever birth_identity capture state actually holds, including pending - never omits either just because the process is gone",
    { skip: POSIX_ONLY_SKIP },
    async () => {
      const runResult = runTool.handler({ command: [process.execPath, "-e", "process.exit(0)"] });
      const jobId = jobIdOf(runResult);
      const beforePid = structuredOf(statusTool.handler({ job_id: jobId })).pid;
      const terminalStatus = await waitForTerminal(jobId);
      assert.equal(
        terminalStatus.state,
        "exited",
        "expected this job to reach a real terminal state"
      );
      assert.equal(
        terminalStatus.pid,
        beforePid,
        "the pid on a terminal job must be the exact SAME pid it had while live, never dropped or changed"
      );
      assert.equal(typeof terminalStatus.pid, "number");
      const birthIdentity = terminalStatus.birth_identity as { state?: string };
      assert.ok(
        ["pending", "captured", "unavailable"].includes(birthIdentity.state as string),
        `expected a real birth_identity.state on the terminal projection, got: ${JSON.stringify(terminalStatus.birth_identity)}`
      );
      // killJobGroup is a safe no-op here (the process already exited on its
      // own via process.exit(0)) - called anyway for hygiene, matching this
      // file's other tests.
      killJobGroup(jobId);
    }
  );
});

// The negative case below also calls runTool.handler, but with a command
// that never resolves to a real executable at all: resolveExecutable
// fails and run.ts's own handler returns an already-`failed` job before
// ever calling decideRunPolicy (see src/tools/run.ts's own handler docs
// for this exact ordering) - so it reaches the policy gate no more than
// the pure unit tests above do, and stays outside the describe() block
// above on purpose. See this file's own top-of-file comment for the full
// breakdown.
test("a1 negative case: a job that never got a real OS process at all (spawn-error, before any spawn attempt) carries no pid and no birth_identity", () => {
  const runResult = runTool.handler({
    command: ["this-command-definitely-does-not-exist-ghantika-status-pid-test"],
  });
  const jobId = jobIdOf(runResult);
  const structured = structuredOf(statusTool.handler({ job_id: jobId }));
  assert.equal(structured.state, "failed");
  assert.equal(
    structured.pid,
    undefined,
    "a job that never spawned a real process must never carry a pid"
  );
  assert.equal(
    structured.birth_identity,
    undefined,
    "a job that never spawned a real process must never carry a birth_identity"
  );
  // Value equality to undefined is not enough: `{ ...base, pid: undefined }`
  // would satisfy the two assertions above while still creating `pid` as an
  // OWN KEY of the in-process object, visible to Object.hasOwn/Object.keys
  // even though JSON.stringify drops it on the wire. Assert the keys are
  // genuinely absent, not merely undefined-valued.
  assert.equal(
    Object.hasOwn(structured, "pid"),
    false,
    "a job that never spawned a real process must not even OWN a pid key, not just carry an undefined one"
  );
  assert.equal(
    Object.hasOwn(structured, "birth_identity"),
    false,
    "a job that never spawned a real process must not even OWN a birth_identity key, not just carry an undefined one"
  );
  assert.equal(
    jobStore.getChildHandle(jobId),
    undefined,
    "sanity: this job genuinely never got a live child attached at all"
  );
});

// ---------------------------------------------------------------------------
// a4/a6: STATUS-ONLY - run/kill/list carry neither pid nor birth_identity.
//
// The three tests below each call runTool.handler with a real, resolvable
// command ("true", or process.execPath below), so decideRunPolicy genuinely
// runs for every one of them - but what each one actually asserts is a
// structural property of run()'s/kill()'s/list()'s OWN response shape (no
// pid/birth_identity key on that tool's response), which holds identically
// whether the underlying job is admitted or denied by policy: a
// policy-denied job is created via jobStore.createFailedJob exactly like a
// bad-cwd or command-not-found job, and none of those three response
// shapes ever gains a pid/birth_identity key regardless of why the job
// failed (or didn't). An absent/empty policy file can never turn any of
// these three assertions into a failure, so there's no confusing
// policy-denied failure for the guard to preempt here - these stay
// unguarded on purpose. See this file's own top-of-file comment for the
// full breakdown.
// ---------------------------------------------------------------------------

test("a4/a6: run()'s own immediate response never carries pid or birth_identity - additive to status alone", () => {
  const runResult = structuredOf(runTool.handler({ command: ["true"] }));
  assert.equal("pid" in runResult, false, "run()'s response must never carry a pid key");
  assert.equal(
    "birth_identity" in runResult,
    false,
    "run()'s response must never carry a birth_identity key"
  );
});

test(
  "a4/a6: kill()'s own response never carries pid or birth_identity, even though it shares toPublicProjection with status",
  { skip: POSIX_ONLY_SKIP },
  async () => {
    const runResult = runTool.handler({
      command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
    });
    const jobId = jobIdOf(runResult);
    try {
      const killResult = structuredOf(await killTool.handler({ job_id: jobId }));
      assert.equal("pid" in killResult, false, "kill()'s response must never carry a pid key");
      assert.equal(
        "birth_identity" in killResult,
        false,
        "kill()'s response must never carry a birth_identity key"
      );
    } finally {
      killJobGroup(jobId);
    }
  }
);

test("a4/a6: list()'s own response never carries pid or birth_identity on any entry", () => {
  runTool.handler({ command: ["true"] });
  const listResult = structuredOf(listTool.handler());
  const jobs = listResult.jobs as Array<Record<string, unknown>>;
  assert.ok(jobs.length > 0, "expected at least one listed job (the one just created)");
  for (const job of jobs) {
    assert.equal(
      "pid" in job,
      false,
      `list() entry must never carry a pid key, got: ${JSON.stringify(job)}`
    );
    assert.equal(
      "birth_identity" in job,
      false,
      `list() entry must never carry a birth_identity key, got: ${JSON.stringify(job)}`
    );
  }
});
