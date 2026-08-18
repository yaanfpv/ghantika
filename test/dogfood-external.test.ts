/**
 * Dogfood proof: ghantika waking a seat over something it never had a
 * signal for before - an external state that finishes entirely outside
 * ghantika's own process tree, with no job this server itself started to
 * hang a terminal-state listener off. Every wake this codebase ships
 * today fires on a job `run()` started and jobStore is tracking; this
 * file proves a detector for something ghantika had no hand in starting
 * (a GitHub Actions run of this repository reaching a terminal state),
 * feeding that same real wake-transport selector - `selectAndWake`,
 * imported directly from src/wake/selectTransport.js, exactly the door
 * src/tasksAdapter.ts's own job-finishes wake already calls through - no
 * second wake mechanism, no new transport, no `.trigger` file anywhere in
 * this path.
 *
 * Four things this file establishes, each its own test rather than one
 * do-everything proof, because they are different claims with different
 * failure modes:
 *
 *   1. The chosen external state genuinely has no prior signal in this
 *      repository's own tracked source - mechanically swept, not merely
 *      asserted in a comment.
 *   2. A real firing calls the real `selectAndWake`, with the resulting
 *      wake correlated back to the exact invocation that fired it, and
 *      the poll-loop's own real, detached process GROUP is confirmed
 *      gone afterward by an external `pgrep` - never trusting this
 *      file's own bookkeeping that a kill was attempted.
 *   3. That same firing, with no transports override at all, drives the
 *      REAL `DEFAULT_TRANSPORTS` singletons `selectAndWake` uses in
 *      production - proving this reuses the shipped selector rather
 *      than a parallel one built for this proof alone.
 *   4. A detection failure and an explicit early stop are BOTH reaped
 *      exactly like a real fire, and a detection failure is never
 *      representable as "nothing happened" - only as its own distinct,
 *      loud outcome.
 *
 * What this deliberately does NOT do: hit a real GitHub Actions run
 * (network, `gh` CLI, and a live run all vary run to run and would make
 * this suite flaky by construction) - a deterministic fixture checker
 * (test/fixtures/dogfood-external-checker-fixture.js) stands in, driven
 * through a small on-disk "plan" so every scenario below is exact and
 * repeatable. scripts/dogfood-gh-run-checker.mjs is the real checker for
 * a genuine manual run; local/dogfood/RUNBOOK.md is how to point one at
 * it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// scripts/*.mjs is plain, uncompiled ESM - imported directly, never
// through dist/, the same way test/doorbell-cutover.test.ts already
// imports scripts/lib/doorbell-cutover.mjs's own siblings.
import { runCheckerOnce, startExternalWakeDetector } from "../scripts/dogfood-external-wake.mjs";
// The real, compiled wake-transport door - the same ../dist/<module>.js
// convention every other test in this repo already uses to reach real
// ghantika code (see test/registry.test.ts's own import comment).
import { DEFAULT_TRANSPORTS } from "../dist/wake/selectTransport.js";
import type { Capability, WakeResult, WakeTransport } from "../dist/wake/wakeTransport.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE_CHECKER = fileURLToPath(
  new URL("./fixtures/dogfood-external-checker-fixture.js", import.meta.url)
);
const SCRATCH_ROOT = path.join(REPO_ROOT, "local", "dogfood", "test-external-wake");

// ---------------------------------------------------------------------------
// Platform gating - matches test/dogfood.test.ts's own DOGFOOD_SKIP and
// test/integration.test.ts's own PGREP_ORACLE_SKIP: this file confirms a
// real, detached process GROUP is gone via `process.kill(-pid, ...)` and
// an external `pgrep -f` call, neither of which has a Windows equivalent
// path exercised anywhere in this codebase - a test-harness gap, not a
// product scope decision (Windows is a supported platform for the
// detector itself; whether its process-group semantics differ there is a
// separate question this suite doesn't answer by skipping).
// ---------------------------------------------------------------------------

const REAP_PROOF_SKIP =
  process.platform === "win32"
    ? "confirms a real detached process group via process.kill(-pid, ...) and pgrep -f, POSIX-only (see test/integration.test.ts's own PGREP_ORACLE_SKIP for the identical rationale)"
    : false;

// ---------------------------------------------------------------------------
// The absence oracle - a real, external process-table check anchored on
// THIS run's own unique scratch path, mirroring test/dogfood.test.ts's
// own escapeRegexPathLiteral/pgrepPids exactly (see that file's own
// comments for why a `pgrep -f` call with the pattern as its own argv
// element never self-matches).
// ---------------------------------------------------------------------------

function escapeRegexPathLiteral(value: string): string {
  return value.replace(/[.[\]\\*^$()+?{|]/g, "\\$&");
}

function pgrepPids(pattern: string): number[] {
  try {
    const stdout = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(Number);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number };
    if (err.status === 1) return []; // pgrep's own "nothing matched" exit code
    throw error;
  }
}

/** Polls the real process table until nothing references `marker` anywhere in its command line - never trusting this file's own kill/reap bookkeeping alone (matches test/dogfood.test.ts's own waitForNoFswatchPid). */
async function waitForNoPidReferencing(marker: string, timeoutMs = 5000): Promise<void> {
  const pattern = escapeRegexPathLiteral(marker);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = pgrepPids(pattern);
    if (pids.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `process(es) still referencing ${marker} ${timeoutMs}ms after reap: ${JSON.stringify(pids)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// Scratch plan/counter files - one fresh, uniquely-named directory per
// test, so `planPath` itself doubles as this run's own unmistakable pgrep
// anchor (the same "a real, naturally unique path IS the marker" idea
// test/dogfood.test.ts's own triggerPath already uses, rather than
// inventing a second, redundant marker argument).
// ---------------------------------------------------------------------------

function freshScratchDir(): string {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH_ROOT, `${randomUUID()}-`));
}

function writePlan(
  dir: string,
  steps: readonly string[]
): { planPath: string; counterPath: string } {
  const planPath = path.join(dir, "plan.json");
  const counterPath = path.join(dir, "counter");
  fs.writeFileSync(planPath, JSON.stringify({ steps }), "utf8");
  return { planPath, counterPath };
}

const scratchDirs: string[] = [];

after(async () => {
  // Belt-and-braces: every test below already awaits its own detector to
  // a fully reaped outcome (or calls stop()), but if an assertion threw
  // before that happened, nothing here should leave a real process
  // behind. Best-effort only - the per-test reap paths are the real
  // proof, this is cleanup.
  for (const dir of scratchDirs) {
    const stragglers = pgrepPids(escapeRegexPathLiteral(dir));
    for (const pid of stragglers) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake transports for the deterministic-delivery tests - mirroring
// test/wake-select-transport.test.ts's and test/wake-transport-wiring.
// test.ts's own naming convention (available/unavailable/delivers/...).
// ---------------------------------------------------------------------------

function available(): Promise<Capability> {
  return Promise.resolve({ available: true, probedAt: new Date().toISOString() });
}

class RecordingTransport implements WakeTransport {
  readonly name: string;
  readonly calls: Array<{ target: string; payload: string }> = [];
  #wakeImpl: (target: string, payload: string) => Promise<WakeResult>;

  constructor(name: string, wakeImpl: (target: string, payload: string) => Promise<WakeResult>) {
    this.name = name;
    this.#wakeImpl = wakeImpl;
  }

  probe(): Promise<Capability> {
    return available();
  }

  wake(target: string, payload: string): Promise<WakeResult> {
    this.calls.push({ target, payload });
    return this.#wakeImpl(target, payload);
  }
}

function deliveringTransport(name: string): RecordingTransport {
  return new RecordingTransport(name, () =>
    Promise.resolve({ outcome: "delivered", transportName: name, detail: "test-fixture-delivered" })
  );
}

// =============================================================================
// 1. a2 - the chosen external state has no prior signal, mechanically swept
// =============================================================================

test("a2: no existing tracked source in this repo already signals a GitHub Actions run of this repo reaching a terminal state", () => {
  // Scoped to production surfaces a real fleet signal would live in - code,
  // scripts, docs, the README, and the workflow definitions themselves
  // (a workflow could in principle notify on its own completion via a
  // workflow_run trigger, a notify/webhook step, or similar). Deliberately
  // excludes test/: test code asserting on behavior is not itself a
  // production signal to a seat.
  const trackedFiles = execFileSync(
    "git",
    ["ls-files", "--", "src", "scripts", "docs", "README.md", ".github"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // This story's own new files are the FIRST and ONLY producers of this
  // signal - excluded here so their own presence can never trivially fail
  // the absence this test exists to establish.
  const NEW_FILES = new Set([
    "scripts/dogfood-external-wake.mjs",
    "scripts/dogfood-gh-run-checker.mjs",
  ]);

  // Narrowly scoped to ACTUAL signaling machinery - a cross-workflow
  // trigger key, a webhook event name, or a real check/watch invocation -
  // never a bare substring like "run_id" or "actions/runs", both of which
  // this repo's own main-verify.yml uses harmlessly to BUILD A URL STRING
  // for a human to read (`.../actions/runs/${{ github.run_id }}`), and
  // never a generic English/code word like "notify" (this codebase's own
  // EXISTING job-finishes wake already says "notifier"/"notify" all over
  // src/tasksAdapter.ts and docs/wake-support-matrix.md, describing a
  // different mechanism entirely - a job ghantika itself started, never an
  // external GitHub Actions run). A pattern that fires on prose describing
  // an unrelated, already-known mechanism proves nothing about THIS one.
  const SIGNAL_PATTERNS: readonly RegExp[] = [
    /workflow_run/i,
    /check_suite/i,
    /\bgh\s+run\s+(view|watch|list)\b/i,
    /\bgh\s+api\s+[^\n]*\bactions\/runs\b/i,
    // This story's own checker-contract marker: a hit anywhere OUTSIDE the
    // new files above would mean something else in this repo already
    // speaks the exact protocol this file introduces.
    /EXTERNAL_STATE_TERMINAL/,
  ];

  const offenders: string[] = [];
  for (const relPath of trackedFiles) {
    if (NEW_FILES.has(relPath)) continue;
    const abs = path.join(REPO_ROOT, relPath);
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue; // an unreadable/binary tracked file - nothing to scan textually
    }
    for (const pattern of SIGNAL_PATTERNS) {
      if (pattern.test(text)) {
        offenders.push(`${relPath} matches ${pattern}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "expected zero pre-existing references to GitHub-Actions-run-completion " +
      `signaling anywhere in this repo's tracked production source; found: ${JSON.stringify(offenders, null, 2)}`
  );
});

// =============================================================================
// 2. runCheckerOnce - the checker-contract classifier, in isolation
// =============================================================================

test("runCheckerOnce classifies terminal, pending, and error checker output exactly per the checker contract", () => {
  // One fresh scratch directory per scenario - writePlan assumes its own
  // `dir` argument already exists (freshScratchDir's mkdtempSync
  // guarantees that), which keeps this straightforward rather than
  // hand-building nested directories for each case.
  const terminalDir = freshScratchDir();
  scratchDirs.push(terminalDir);
  const terminalPlan = writePlan(terminalDir, ["terminal"]);
  const terminalResult = runCheckerOnce([
    "node",
    FIXTURE_CHECKER,
    terminalPlan.planPath,
    terminalPlan.counterPath,
  ]);
  assert.equal(terminalResult.kind, "terminal");

  const pendingDir = freshScratchDir();
  scratchDirs.push(pendingDir);
  const pendingPlan = writePlan(pendingDir, ["pending"]);
  const pendingResult = runCheckerOnce([
    "node",
    FIXTURE_CHECKER,
    pendingPlan.planPath,
    pendingPlan.counterPath,
  ]);
  assert.equal(pendingResult.kind, "pending");

  const errorDir = freshScratchDir();
  scratchDirs.push(errorDir);
  const errorPlan = writePlan(errorDir, ["error"]);
  const errorResult = runCheckerOnce([
    "node",
    FIXTURE_CHECKER,
    errorPlan.planPath,
    errorPlan.counterPath,
  ]);
  assert.equal(errorResult.kind, "error");
  if (errorResult.kind === "error") {
    assert.match(errorResult.reason, /simulated detection failure/);
  }

  // A command that cannot even be spawned is its own, equally real error -
  // never mistaken for "pending".
  const unspawnableResult = runCheckerOnce(["definitely-not-a-real-command-on-this-host"]);
  assert.equal(unspawnableResult.kind, "error");
});

// =============================================================================
// 3. The real proof: firing calls selectAndWake, correlated, reaped
// =============================================================================

test(
  "dogfood: an external state with no prior signal firing calls selectAndWake with a payload correlated to the exact invocation that fired, and the poll-loop's whole process group is confirmed gone by an external pgrep - never touching .trigger",
  { skip: REAP_PROOF_SKIP },
  async () => {
    const dir = freshScratchDir();
    scratchDirs.push(dir);
    const { planPath, counterPath } = writePlan(dir, ["pending", "pending", "terminal"]);
    const checkCommand = ["node", FIXTURE_CHECKER, planPath, counterPath];

    const fakeTransport = deliveringTransport("fake-delivering-transport");
    const target = "test-target-thread-id";

    const handle = startExternalWakeDetector({
      target,
      checkCommand,
      buildPayload: (detail) => `dogfood external state reached a terminal condition - ${detail}`,
      pollIntervalMs: 25,
      transports: [fakeTransport],
    });

    // --- baseline: the real poll-loop process exists while still checking ---
    assert.ok(
      pgrepPids(escapeRegexPathLiteral(planPath)).length >= 1,
      "expected the real poll-loop process to exist while checking is in flight"
    );
    assert.equal(typeof handle.pid, "number");

    const outcome = await handle.outcome;
    assert.equal(outcome.type, "fired");
    if (outcome.type !== "fired") throw new Error("unreachable - narrowed by the assertion above");

    // --- ghantika's own real selectAndWake actually ran, and delivered ---
    assert.equal(outcome.wakeResult.outcome, "delivered");
    assert.equal(outcome.wakeResult.transportName, "fake-delivering-transport");

    // --- correlation: the wake carries THIS exact firing's own detail, not a generic message ---
    assert.equal(fakeTransport.calls.length, 1);
    assert.equal(fakeTransport.calls[0]!.target, target);
    assert.match(fakeTransport.calls[0]!.payload, /"fixtureInvocation":2/); // the 3rd invocation (0-indexed 2) is the "terminal" step
    assert.match(outcome.detail, /"fixtureInvocation":2/);

    // --- this mechanism never touches .trigger, anywhere it could have reached ---
    assert.deepEqual(
      fs.readdirSync(dir).filter((entry) => entry === ".trigger"),
      []
    );

    // --- reap proof: a real, EXTERNAL pgrep confirms the whole process group is gone ---
    await waitForNoPidReferencing(planPath);
  }
);

// =============================================================================
// 4. Genuine reuse: with no transports override, this drives the REAL
//    DEFAULT_TRANSPORTS singletons, the same ones src/tasksAdapter.ts
//    itself calls into for the job-finishes wake - never a second,
//    parallel selection mechanism built for this proof alone.
// =============================================================================

test(
  "dogfood: with no transports override, firing routes through the real DEFAULT_TRANSPORTS singletons selectAndWake uses in production",
  { skip: REAP_PROOF_SKIP },
  async (t) => {
    const wakeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "wake", () =>
      Promise.resolve({
        outcome: "delivered" as const,
        transportName: DEFAULT_TRANSPORTS[0]!.name,
        detail: "real-singleton-delivered",
      })
    );
    const probeA = t.mock.method(DEFAULT_TRANSPORTS[0]!, "probe", () => available());

    const dir = freshScratchDir();
    scratchDirs.push(dir);
    const { planPath, counterPath } = writePlan(dir, ["terminal"]);

    const handle = startExternalWakeDetector({
      target: "real-singleton-target",
      checkCommand: ["node", FIXTURE_CHECKER, planPath, counterPath],
      buildPayload: (detail) => `real singleton path - ${detail}`,
      pollIntervalMs: 25,
      // transports intentionally OMITTED - this is the point of the test:
      // startExternalWakeDetector's own default is the real DEFAULT_TRANSPORTS.
    });

    const outcome = await handle.outcome;
    assert.equal(outcome.type, "fired");
    if (outcome.type !== "fired") throw new Error("unreachable");
    assert.equal(outcome.wakeResult.outcome, "delivered");
    assert.equal(outcome.wakeResult.transportName, DEFAULT_TRANSPORTS[0]!.name);
    assert.equal(probeA.mock.callCount(), 1);
    assert.equal(wakeA.mock.callCount(), 1);

    await waitForNoPidReferencing(planPath);
  }
);

// =============================================================================
// 5. a3 - a detection failure is its own distinct, loud outcome, never
//    confusable with "nothing happened", and still fully reaped.
// =============================================================================

test(
  "dogfood: a checker reporting a detection failure resolves as detectionFailed - distinguishable from a still-pending detector - and the poll-loop is still killed and reaped",
  { skip: REAP_PROOF_SKIP },
  async () => {
    const dir = freshScratchDir();
    scratchDirs.push(dir);
    // Two "pending" steps first, and a generous interval between polls, so
    // the still-pending race below has real headroom: it only needs to
    // land before the SECOND checker invocation even starts, not shave
    // milliseconds off a single spawn.
    const { planPath, counterPath } = writePlan(dir, ["pending", "pending", "error"]);

    const handle = startExternalWakeDetector({
      target: "unused-target",
      checkCommand: ["node", FIXTURE_CHECKER, planPath, counterPath],
      buildPayload: () => "unused - selectAndWake must never be called on this path",
      pollIntervalMs: 150,
      transports: [
        new RecordingTransport("must-never-be-called", () => {
          throw new Error("selectAndWake must never be invoked for a detection failure");
        }),
      ],
    });

    // While the first "pending" step is still outstanding, outcome must
    // NOT have settled - "no event yet" is represented only by the
    // promise remaining unresolved, never by a value. Race it against a
    // short timer to observe that, without waiting for the real failure.
    const stillPending = await Promise.race([
      handle.outcome.then(() => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve("still-pending" as const), 40)),
    ]);
    assert.equal(
      stillPending,
      "still-pending",
      "outcome must not settle while the detector is merely pending"
    );

    const outcome = await handle.outcome;
    assert.equal(outcome.type, "detectionFailed");
    if (outcome.type !== "detectionFailed") throw new Error("unreachable");
    assert.match(outcome.reason, /simulated detection failure/);
    // A detection failure is never the string "fired", never undefined,
    // and never absent an actionable reason - it is its own shape.
    assert.notEqual(outcome.reason.length, 0);

    await waitForNoPidReferencing(planPath);
  }
);

// =============================================================================
// 6. a3 - an explicit early exit reaps just as completely, and never wakes
// =============================================================================

test(
  "dogfood: stop() on a still-pending detector reaps the poll-loop process without ever calling selectAndWake",
  { skip: REAP_PROOF_SKIP },
  async () => {
    const dir = freshScratchDir();
    scratchDirs.push(dir);
    // A long plan of pure "pending" steps - this detector is stopped well
    // before it could ever legitimately fire on its own.
    const { planPath, counterPath } = writePlan(
      dir,
      Array.from({ length: 200 }, () => "pending")
    );

    const neverCalledTransport = new RecordingTransport("must-never-be-called", () => {
      throw new Error("selectAndWake must never be invoked after an explicit stop()");
    });

    const handle = startExternalWakeDetector({
      target: "unused-target",
      checkCommand: ["node", FIXTURE_CHECKER, planPath, counterPath],
      buildPayload: () => "unused",
      pollIntervalMs: 50,
      transports: [neverCalledTransport],
    });

    assert.ok(
      pgrepPids(escapeRegexPathLiteral(planPath)).length >= 1,
      "expected the real poll-loop process to exist before stop() is called"
    );

    await handle.stop();

    const outcome = await handle.outcome;
    assert.equal(outcome.type, "stopped");
    assert.equal(neverCalledTransport.calls.length, 0);

    await waitForNoPidReferencing(planPath);
  }
);
