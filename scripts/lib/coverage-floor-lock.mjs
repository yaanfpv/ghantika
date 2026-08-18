#!/usr/bin/env node
/**
 * A crash-safe lock, APPROXIMATING mutual exclusion (see the KNOWN
 * RESIDUAL paragraph below for the one disclosed gap this does NOT close),
 * handed off across the boundary between two SEPARATE, separately-invoked
 * OS processes: `npm run coverage` (scripts/coverage-lock-worker-wrapper.mjs)
 * and `npm run check:coverage-floor` (scripts/coverage-lock-floor-wrapper.mjs).
 * CI's `coverage` job runs these as two distinct workflow steps - see
 * .github/workflows/ci.yml - so the lock cannot live in memory or in a
 * single process's own state; it lives entirely in one JSON file on disk
 * plus a terminal sidecar, and every transition is bound to a real,
 * externally-observable OS process identity rather than to this
 * codebase's own in-memory bookkeeping.
 *
 * WHAT THIS PROTECTS: two concurrent invocations of `npm run coverage`
 * racing to write coverage/coverage-summary.json, coverage/run-truncated.json
 * (+ its fallback), coverage/run-completed.json, and .run-token.json -
 * every one of them a shared, unlocked file today (see
 * scripts/run-tests.mjs's and scripts/check-coverage-floor.mjs's own
 * header comments for what each already defends against ON TOP OF this
 * lock: a truncated run, a stale same-commit completion marker, ...). None
 * of those existing mechanisms defends against two invocations running AT
 * THE SAME TIME - this file is the first (and only) layer that does.
 *
 * THE STATE MACHINE (five phases, on one JSON lock file):
 *
 *   acquired -> working -> publishing -> floor-running -> done -> released
 *
 * `working`/`publishing` are written only by the WORKER wrapper (owning
 * `npm run coverage`'s real command); `floor-running`/`done` are written
 * only by the FLOOR wrapper (owning `npm run check:coverage-floor`'s real
 * command). `released` is not a phase written to the PRIMARY lock path at
 * all - it is the terminal SIDECAR file (see RELEASED_SUFFIX below) that
 * every path out of this state machine (a clean finish, or any of the
 * failure paths below) is INTENDED to end at, with the primary lock path
 * no longer existing once it does. That is the normal, designed-for
 * outcome, not an absolute guarantee: `release()`'s own sidecar-write and
 * primary-unlink are each independently best-effort (see that function's
 * own docs), so a non-ENOENT failure on the unlink half could in principle
 * leave both the sidecar AND the primary file present at once.
 *
 * IDENTITY, NOT BOOKKEEPING: "is this lock currently held" is answered by
 * asking the real OS whether the pid recorded in the lock file is still
 * alive AND is still the same process that wrote it (src/process.ts's
 * `checkProcessIdentity`, comparing a captured birth identity - never a
 * bare pid, which can be silently reused by an unrelated later process).
 * That is what makes a crashed prior invocation's lock RECLAIMABLE rather
 * than a permanent deadlock: once the OS confirms the recorded owner is
 * genuinely gone, a later invocation is free to take over, no matter how
 * the prior one died (a clean exit, a SIGKILL, an OOM, a machine crash -
 * every one of these leaves the SAME externally-observable fact behind:
 * the pid is gone).
 *
 * THE DEADLOCK THIS CLOSES (found by adversarial review of an earlier,
 * pure-paper version of this design, before it exercised anything through
 * a wrapper's own failure path): an owner that hits a write failure mid-
 * sequence, kills whatever it had already spawned, but otherwise just
 * logs and carries on WITHOUT releasing the lock leaves a live-but-doomed
 * record behind - a future liveness check on that still-running owner
 * keeps succeeding for as long as the owner process itself happens to
 * survive, and nothing can reclaim in that window even though the actual
 * WORK already failed. `acquireAsWorker`/`acquireAsFloorJob` below both
 * close this the same way: on ANY failure past the point a spawn was
 * attempted, they kill whatever child they had already spawned (so a
 * reclaim can never race a still-running, unrecorded coverage/floor-check
 * process) and then RELEASE the lock - both BEFORE doing anything else
 * (logging, re-throwing, exiting) - so the window in which a live owner
 * blocks a genuine reclaim is closed at the moment the failure is
 * detected, never left open for however long the doomed process happens
 * to keep running afterward.
 *
 * KNOWN RESIDUAL - THIS IS NOT A TRUE MUTUAL-EXCLUSION LOCK: a
 * check-then-act race exists between the async liveness check
 * (`checkPidLiveness`/`checkFloorJobLiveness`, both real OS observations
 * that take real, non-zero time) and the write/spawn that follows it, in
 * BOTH `acquireAsWorker`'s and `acquireAsFloorJob`'s own reclaim paths -
 * and, even more narrowly, `acquireAsFloorJob`'s own
 * `proceed-normal-handoff` branch performs NO liveness check at all before
 * spawning (a matching headSha on a "publishing"-phase lock is treated as
 * sufficient on its own). TWO invocations started within the width of that
 * window, against the same abandoned/stale lock, could both observe "safe
 * to proceed" and both spawn real, genuinely concurrent children - this is
 * a real, disclosed gap, NOT fixed in this pass. What actually keeps this
 * safe TODAY is a fact about this repo's own CI, not this module's own
 * mechanics alone: `.github/workflows/ci.yml`'s `coverage` job runs the two
 * wrapped npm scripts as two STRICTLY SEQUENTIAL steps within one job,
 * never in parallel and never retried without the prior step having fully
 * exited first - so this window is never actually raced against in the one
 * real workflow this lock protects. A real fix, should this module ever be
 * used outside that sequential-single-job assumption, would need one of two
 * shapes: (1) an OS-level atomic exclusive-create (`O_EXCL`) as the ACTUAL
 * claim primitive, paired with a short-lived separate claim marker to
 * serialize the check-then-reclaim critical section itself (a bare
 * exclusive-create cannot, on its own, distinguish "genuinely new" from
 * "stale, needs replacing" - it only tells you whether the file already
 * existed, not whether its recorded owner is dead); or (2) a
 * read-after-write verification step that re-reads the lock immediately
 * after claiming it and backs off if the on-disk owner does not match what
 * was just written. Neither is implemented here.
 *
 * THIS MODULE IMPORTS THE BUILT dist/process.js, NOT src/process.ts
 * DIRECTLY: there is no other runtime-importable form of
 * checkProcessIdentity/captureBirthIdentityPosix(Async)/isProcessAlive - a
 * plain .mjs script cannot import a .ts file, and every test file in this
 * repo already reaches these same functions the identical way (see e.g.
 * test/status-process-identity.test.ts's own "imports the BUILT output,
 * not src/ directly" comment). This is why package.json's "coverage"
 * script runs `npm run build` as its OWN, separate, un-wrapped shell
 * command BEFORE ever invoking coverage-lock-worker-wrapper.mjs: dist/
 * must already exist by the time this module is first imported. `npm run
 * check:coverage-floor` runs strictly after `npm run coverage` in both CI
 * and the ordinary local workflow, so dist/ is fresh there too. Running
 * either wrapper in true isolation, on a checkout that has never been
 * built at all, surfaces Node's own module-resolution error rather than a
 * custom diagnostic - an acceptable, disclosed limitation shared with
 * every test file that already depends on a built dist/.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS,
  captureBirthIdentityPosix,
  captureBirthIdentityPosixAsync,
  checkProcessIdentity,
  isProcessAlive,
  resolveExecutable,
} from "../../dist/process.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Overridable via env var so a test can point an isolated fixture lock at
// its own scratch path, matching the existing GHANTIKA_* override pattern
// scripts/check-coverage-floor.mjs and scripts/run-tests.mjs already use
// for their own marker/token paths. Production CI never sets this, so the
// default (a single, well-known top-level file, the same convention
// .run-token.json already establishes) is what actually runs there.
export const LOCK_PATH =
  process.env.GHANTIKA_COVERAGE_FLOOR_LOCK_PATH ??
  path.join(REPO_ROOT, ".coverage-floor.lock.json");

/**
 * The one naming convention every "vacate this lock" path in this file
 * uses - a clean finish (acquireAsFloorJob's own `done` -> release), and
 * every deadlock-fix failure path in both `acquireAsWorker` and
 * `acquireAsFloorJob` - so a reader (and check-coverage-floor's own
 * three-way dispatch) never has to reason about two differently-named
 * terminal sidecars.
 */
export const RELEASED_SUFFIX = ".released";

/** @param {string} lockPath @returns {string} */
export function releasedSidecarPath(lockPath) {
  return `${lockPath}${RELEASED_SUFFIX}`;
}

/**
 * Writes `payload` to `lockPath` as a single, atomic filesystem operation:
 * write to a fresh temp file in the SAME DIRECTORY (so the later rename
 * stays on one filesystem, which is what makes it atomic at all), then
 * `renameSync` it over the real target. A reader can therefore only ever
 * observe the lock file as either its old, fully-formed content or its
 * new, fully-formed content - never a half-written JSON document a
 * concurrent reader raced against mid-write. The temp filename embeds a
 * fresh UUID so two overlapping writers (this codebase's own
 * mutual-exclusion design means that should never happen in practice, but
 * this function does not assume its own callers are bug-free) can never
 * collide on the same temp path.
 *
 * @param {string} lockPath
 * @param {unknown} payload - JSON-serializable
 */
export function writeIdentityAtomic(lockPath, payload) {
  const dir = path.dirname(lockPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(lockPath)}.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  renameSync(tmpPath, lockPath);
}

/**
 * @param {string} lockPath
 * @returns {Record<string, unknown> | null} `null` only for a genuinely
 *   absent file (ENOENT) - any other read/parse failure (a permission
 *   error, corrupted JSON) is rethrown rather than silently read as
 *   "absent", the same fail-loud posture check-coverage-floor.mjs's own
 *   loadTruncationMarker/loadCompletionMarker/loadRunToken already use.
 */
export function readLockFile(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The diagnostic-grade read `classifyFloorAcquisition` below is built on:
 * distinguishes an ACTIVE lock (the primary path exists) from one that was
 * already RELEASED (only the sidecar exists) from one that never existed
 * at all (neither), so a refusal can name which of those three it is
 * rather than a single undifferentiated "no lock".
 *
 * @param {string} lockPath
 * @returns {{ location: "primary" | "sidecar" | "absent", payload: Record<string, unknown> | null }}
 */
export function readLockState(lockPath) {
  const primary = readLockFile(lockPath);
  if (primary !== null) return { location: "primary", payload: primary };
  const sidecar = readLockFile(releasedSidecarPath(lockPath));
  if (sidecar !== null) return { location: "sidecar", payload: sidecar };
  return { location: "absent", payload: null };
}

/** @param {unknown} err @returns {string} */
export function describeError(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Vacates `lockPath`: best-effort writes `finalPayload` to the terminal
 * `.released` sidecar, then best-effort removes the primary lock file.
 * NEVER THROWS - this is the last-resort cleanup path both
 * `acquireAsWorker` and `acquireAsFloorJob` call on their own failure
 * paths, and a failure INSIDE the cleanup path must never mask (or
 * replace, via an uncaught throw) the real failure that triggered it. Both
 * halves are independently best-effort and independently logged: a sidecar
 * write failure does not stop the primary-file removal attempt, and vice
 * versa.
 *
 * @param {string} lockPath
 * @param {Record<string, unknown>} finalPayload
 */
export function release(lockPath, finalPayload) {
  try {
    writeIdentityAtomic(releasedSidecarPath(lockPath), finalPayload);
  } catch (err) {
    console.error(
      `coverage-floor-lock: failed to write the released sidecar for ${lockPath}: ${describeError(err)}`
    );
  }
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(
        `coverage-floor-lock: failed to remove the primary lock file ${lockPath} after release: ${describeError(err)}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Liveness - "is the process that wrote this lock still the one holding it"
// ---------------------------------------------------------------------------

/**
 * @typedef {"alive-confirmed" | "alive-unconfirmed" | "not-found" | "identity-mismatch" | "observer-failure"} LivenessVerdict
 */

/**
 * `pid`/`birthIdentity` -> a liveness verdict, using the real, external
 * observation `src/process.ts`'s `checkProcessIdentity` makes (never this
 * codebase's own bookkeeping alone). When `birthIdentity` is absent (the
 * capture at spawn time can fail or never be attempted - see
 * `captureBirthIdentityPosix`'s own docs), there is nothing to compare
 * against, so this falls back to the plain, zero-side-effect existence
 * check (`isProcessAlive`, `kill(pid, 0)`) and reports `alive-unconfirmed`
 * rather than a false `alive-confirmed` - a caller that treats
 * `alive-unconfirmed` as blocking (see `livenessBlocksAcquisition` below)
 * is failing CLOSED on exactly the same "cannot verify identity" case
 * `evaluatePreSignalIdentityGate` in src/process.ts fails OPEN on for a
 * KILL: the two are not the same decision. A kill that proceeds without
 * confirmed identity risks signalling the wrong (recycled-pid) process,
 * which this codebase already judges an acceptable, disclosed risk for
 * that operation; a lock ACQUISITION that proceeds without confirmed
 * identity risks running two coverage generations concurrently and
 * corrupting shared state, which is exactly what this whole file exists to
 * prevent - so here the same ambiguity is judged the other way.
 *
 * @param {number} pid
 * @param {import("../../dist/process.js").ProcessBirthIdentity | undefined} birthIdentity
 * @param {{
 *   now?: () => number,
 *   identityCheck?: typeof checkProcessIdentity,
 *   plainCheck?: typeof isProcessAlive,
 * }} [opts]
 * @returns {Promise<{ verdict: LivenessVerdict, reason?: string }>}
 */
export async function checkPidLiveness(
  pid,
  birthIdentity,
  { now = Date.now, identityCheck = checkProcessIdentity, plainCheck = isProcessAlive } = {}
) {
  if (birthIdentity === undefined) {
    return plainCheck(pid)
      ? {
          verdict: "alive-unconfirmed",
          reason: `pid ${pid} exists (plain check) - no captured birth identity is on record to confirm it is genuinely the same process`,
        }
      : { verdict: "not-found" };
  }
  const result = await identityCheck(pid, birthIdentity, now());
  if (result.status === "alive-confirmed") return { verdict: "alive-confirmed" };
  if (result.status === "not-found") return { verdict: "not-found" };
  if (result.status === "identity-mismatch") {
    return { verdict: "identity-mismatch", reason: result.reason };
  }
  return { verdict: "observer-failure", reason: result.reason };
}

/**
 * Fail-CLOSED predicate: every verdict except a confident "gone"
 * (`not-found` or `identity-mismatch`, both of which mean the recorded pid
 * is definitively NOT the process that wrote the lock anymore) blocks a
 * new acquisition/reclaim. `observer-failure` is included deliberately -
 * "the observer itself is broken right now" is not evidence the owner is
 * gone, so it must never read as a green light to proceed.
 *
 * @param {LivenessVerdict} verdict
 * @returns {boolean}
 */
export function livenessBlocksAcquisition(verdict) {
  return (
    verdict === "alive-confirmed" ||
    verdict === "alive-unconfirmed" ||
    verdict === "observer-failure"
  );
}

/**
 * How long a `floor-running` record is given, from the moment it was
 * written, for its own `floorJobBirthIdentity` to land before a caller
 * treats the ABSENCE of that field as "the async capture may still be in
 * flight" (DEGRADED: fall back to a plain existence check) rather than
 * "the capture is long done and simply never produced an identity"
 * (equally DEGRADED, same fallback - the two are handled identically here;
 * this window only changes the REASON text, never the verdict). Sized to
 * the real capture's own worst-case budget
 * (ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS, 3000ms) plus a fixed margin for
 * this file's own write-B rename latency (writeIdentityAtomic's
 * write-then-rename is fast, but not instantaneous) - see
 * `acquireAsFloorJob`'s own write-B comment for exactly when that write is
 * attempted relative to this window.
 */
export const FLOOR_JOB_IDENTITY_CAPTURE_MARGIN_MS = 500;
export const FLOOR_JOB_DEGRADED_WINDOW_MS =
  ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS + FLOOR_JOB_IDENTITY_CAPTURE_MARGIN_MS;

/**
 * The RECLAIM-LIVENESS SUB-CASE: whether the `floorJobPid` a `floor-running`
 * (or `done`) lock record names is still genuinely running the floor
 * check. This is a SEPARATE question from `ownerPid`'s own liveness
 * (checked by `isLockCurrentlyHeld` below): by the time a `floor-running`
 * record exists, the WORKER process that wrote `ownerPid` has - in the
 * real, two-CI-step flow this lock is built for - already exited (that is
 * what "the next CI step" means), so `ownerPid`'s own liveness is expected
 * to read `not-found` regardless of whether a floor check is genuinely
 * still in progress. `floorJobPid` is the identity that actually protects
 * against a genuinely concurrent SECOND floor-wrapper invocation.
 *
 * @param {Record<string, unknown>} payload
 * @param {{
 *   now?: () => number,
 *   identityCheck?: typeof checkProcessIdentity,
 *   plainCheck?: typeof isProcessAlive,
 * }} [opts]
 * @returns {Promise<{ verdict: LivenessVerdict, reason?: string }>}
 */
export async function checkFloorJobLiveness(
  payload,
  { now = Date.now, identityCheck = checkProcessIdentity, plainCheck = isProcessAlive } = {}
) {
  if (typeof payload?.floorJobPid !== "number") {
    return {
      verdict: "observer-failure",
      reason: `the lock's phase is "${payload?.phase}" but it carries no numeric floorJobPid at all - a malformed record this check cannot safely reason about`,
    };
  }
  if (payload.floorJobBirthIdentity !== undefined) {
    return checkPidLiveness(payload.floorJobPid, payload.floorJobBirthIdentity, {
      now,
      identityCheck,
      plainCheck,
    });
  }
  const recordedAtMs =
    typeof payload.floorRunningAt === "string" ? Date.parse(payload.floorRunningAt) : NaN;
  const elapsedMs = Number.isFinite(recordedAtMs) ? now() - recordedAtMs : Number.POSITIVE_INFINITY;
  const stillInCaptureWindow = elapsedMs < FLOOR_JOB_DEGRADED_WINDOW_MS;
  if (plainCheck(payload.floorJobPid)) {
    return {
      verdict: "alive-unconfirmed",
      reason: stillInCaptureWindow
        ? `floorJobPid ${payload.floorJobPid} exists (plain check) - its birth identity has not landed yet, ${elapsedMs.toFixed(0)}ms into the ${FLOOR_JOB_DEGRADED_WINDOW_MS}ms capture window, so this is a DEGRADED (unconfirmed) liveness read`
        : `floorJobPid ${payload.floorJobPid} exists (plain check) - its birth identity never landed within the ${FLOOR_JOB_DEGRADED_WINDOW_MS}ms capture window, so this remains a DEGRADED (unconfirmed) liveness read`,
    };
  }
  return { verdict: "not-found" };
}

/**
 * Whether `payload` (already read from the PRIMARY lock path - a `null`
 * payload here means the caller already knows no lock file exists and has
 * nothing to check) represents a lock some live process is genuinely
 * still holding. Used by `acquireAsWorker`'s own "on start" check.
 *
 * A `phase: "done"` record is a TERMINAL, safe-to-supersede state - the
 * floor check for whatever run it describes already ran to completion and
 * reported its own exit code to CI before this record could even be read,
 * so a worker finding one is free to proceed unconditionally, matching the
 * acquireAsWorker step-1 spec's own explicit "...or is in a terminal
 * done/released state, proceed" wording.
 *
 * `phase: "floor-running"` is checked TWO ways: `ownerPid` (the worker
 * that originally wrote this lock - see `checkFloorJobLiveness`'s own docs
 * for why that pid is expected long-dead by this phase in the real flow),
 * PLUS `floorJobPid` (the actually-relevant identity for this phase). This
 * is a DELIBERATE STRENGTHENING beyond the acquireAsWorker step-1 text as
 * literally written (which names only `ownerPid`): checking `ownerPid`
 * alone would let a brand-new `npm run coverage` invocation start WHILE a
 * genuinely still-running floor check for a PRIOR commit's coverage run is
 * actively reading/comparing coverage-summary.json, since `ownerPid` is
 * essentially guaranteed dead by then regardless of whether the floor
 * check is still live. See this module's own header for why this closes a
 * real gap rather than being read as excess caution.
 *
 * @param {Record<string, unknown> | null} payload
 * @param {{
 *   now?: () => number,
 *   identityCheck?: typeof checkProcessIdentity,
 *   plainCheck?: typeof isProcessAlive,
 * }} [opts]
 * @returns {Promise<{ held: boolean, reason: string, blockingPid?: number, blockingPhase?: unknown }>}
 */
export async function isLockCurrentlyHeld(payload, opts = {}) {
  if (payload === null || payload === undefined) {
    return { held: false, reason: "no lock file is present" };
  }
  if (payload.phase === "done") {
    return {
      held: false,
      reason:
        'the lock is in the terminal "done" phase - the floor check for its recorded run already completed',
    };
  }
  const ownerVerdict = await checkPidLiveness(payload.ownerPid, payload.ownerBirthIdentity, opts);
  if (livenessBlocksAcquisition(ownerVerdict.verdict)) {
    return {
      held: true,
      reason: `owner pid ${payload.ownerPid} (phase "${payload.phase}") is ${ownerVerdict.verdict}${
        ownerVerdict.reason ? ` - ${ownerVerdict.reason}` : ""
      }`,
      blockingPid: payload.ownerPid,
      blockingPhase: payload.phase,
    };
  }
  if (payload.phase === "floor-running") {
    const floorVerdict = await checkFloorJobLiveness(payload, opts);
    if (livenessBlocksAcquisition(floorVerdict.verdict)) {
      return {
        held: true,
        reason: `floor job pid ${payload.floorJobPid} (phase "${payload.phase}") is ${floorVerdict.verdict}${
          floorVerdict.reason ? ` - ${floorVerdict.reason}` : ""
        }`,
        blockingPid: payload.floorJobPid,
        blockingPhase: payload.phase,
      };
    }
  }
  return {
    held: false,
    reason: `owner pid ${payload.ownerPid} is ${ownerVerdict.verdict} and no live floor job is recorded for phase "${payload.phase}"`,
  };
}

// ---------------------------------------------------------------------------
// The floor wrapper's own three-way (plus reclaim) dispatch
// ---------------------------------------------------------------------------

/**
 * The floor wrapper's "on start" classification - PURE, given an
 * already-read lock state and the current commit's real head SHA. THREE
 * named cases, plus a fourth ("reclaim-check-needed") this function
 * defers to a liveness check its caller performs (see
 * `checkFloorJobLiveness` above) rather than deciding on its own, since
 * that decision needs an async OS observation this function deliberately
 * stays free of:
 *
 *   - `proceed-normal-handoff`: phase "publishing" with a matching headSha
 *     - the expected, common case.
 *   - `refuse` [head-sha-mismatch / worker-never-finished / no-active-lock
 *     / unrecognized-phase]: every case this state machine can positively
 *     rule unsafe without needing a liveness check at all.
 *   - `reclaim-check-needed`: phase "floor-running" or "done" - possibly a
 *     genuinely concurrent second floor-wrapper invocation, possibly an
 *     abandoned record left by a prior crash; the caller resolves which via
 *     `checkFloorJobLiveness`.
 *
 * @param {{ location: "primary" | "sidecar" | "absent", payload: Record<string, unknown> | null }} lockState
 * @param {string} currentHeadSha
 * @returns {{ outcome: "proceed-normal-handoff" | "reclaim-check-needed", payload: Record<string, unknown> } | { outcome: "refuse", reason: string, detail: string, payload?: Record<string, unknown> }}
 */
export function classifyFloorAcquisition(lockState, currentHeadSha) {
  if (lockState.location !== "primary") {
    return {
      outcome: "refuse",
      reason: "no-active-lock",
      detail:
        lockState.location === "sidecar"
          ? `no coverage-floor lock is currently active for this commit - the most recent one was already released (a "${RELEASED_SUFFIX}" sidecar exists, phase "${lockState.payload?.phase}") with no live "publishing" handoff pending`
          : `no coverage-floor lock file exists at all - "npm run coverage" must complete before "npm run check:coverage-floor" runs`,
    };
  }
  const payload = lockState.payload;
  if (payload.phase === "publishing") {
    if (payload.headSha === currentHeadSha) {
      return { outcome: "proceed-normal-handoff", payload };
    }
    return {
      outcome: "refuse",
      reason: "head-sha-mismatch",
      detail: `the lock's recorded headSha ("${payload.headSha}") does not match the current checkout ("${currentHeadSha}") - this is a stale "publishing"-phase lock left over from a different commit`,
      payload,
    };
  }
  if (payload.phase === "working") {
    return {
      outcome: "refuse",
      reason: "worker-never-finished",
      detail: `the lock is still in phase "working" - the "npm run coverage" step never reached its own publishing handoff for this run (headSha "${payload.headSha}")`,
      payload,
    };
  }
  if (payload.phase === "floor-running" || payload.phase === "done") {
    return { outcome: "reclaim-check-needed", payload };
  }
  return {
    outcome: "refuse",
    reason: "unrecognized-phase",
    detail: `the lock file's phase ("${payload.phase}") is not one this check recognizes`,
    payload,
  };
}

// ---------------------------------------------------------------------------
// Spawning + killing the real, wrapped command
// ---------------------------------------------------------------------------

/**
 * The default `spawnFn` both `acquireAsWorker` and `acquireAsFloorJob`
 * use: spawns `argv` as a real child, `stdio: "inherit"` so the wrapped
 * command's own output (build errors, c8's coverage table, run-tests.mjs's
 * own diagnostics, check-coverage-floor.mjs's own VOID/FAIL/PASS message)
 * reaches the real terminal/CI log exactly as it would unwrapped - this
 * lock must never become a second place output goes to die. `env:
 * process.env` inherits PATH as-is (including npm's own
 * node_modules/.bin prepend, already in effect since this wrapper is
 * itself an npm script), so a bare bin name like `c8` resolves the same
 * way it always has.
 *
 * NEVER `shell: true`, on either platform: this codebase's own established
 * pattern for exactly this problem (see `src/policy.ts`'s
 * `decideShellPolicy`/`resolveManagedShellBinaryPath` and `src/process.ts`'s
 * own `spawnManaged` doc comments) is that `shell: true` lets Node
 * re-resolve a bare name on its own, at spawn time, from this process's
 * ambient environment - a second, independent resolution the caller never
 * sees or controls. `program` here is resolved EXPLICITLY first, via this
 * codebase's own already-shipped, already-tested `resolveExecutable`
 * (mirrors execvp-style PATH+PATHEXT resolution, trying every Windows
 * executable extension in turn - see that function's own doc comment) -
 * the literal resolved path (already carrying its own `.cmd`/`.exe`
 * extension on Windows where one exists) is what actually gets spawned,
 * with no `shell` option at all. This is what removes the Windows-only
 * npm-bin-shim problem `shell: true` used to paper over, rather than
 * disclosing it as an accepted risk: an npm-installed package's Windows
 * shim resolves the identical way `node` itself already does, through one
 * explicit resolution step instead of a second, ambient one.
 *
 * Never throws for an ordinary spawn-level failure (a missing binary, a
 * doomed cwd): those are reported back to the caller as `spawnError`
 * (unresolvable `program`, or a synchronous `spawn()` throw) or via
 * `done`'s own `error` field (the async `error` event) instead, mirroring
 * `src/process.ts`'s own `spawnManaged` convention of never letting a real
 * OS spawn failure become an uncaught exception.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string }} [opts]
 * @returns {{
 *   child: import("node:child_process").ChildProcess | undefined,
 *   spawnError: unknown,
 *   done: Promise<{ code: number | null, signal: NodeJS.Signals | null, error: unknown }>,
 * }}
 */
export function defaultSpawnTracked(argv, { cwd = REPO_ROOT } = {}) {
  const [program, ...args] = argv;
  let child;
  try {
    const resolvedProgram = resolveExecutable(program, cwd, process.env);
    if (resolvedProgram === undefined) {
      throw new Error(
        `defaultSpawnTracked: could not resolve "${program}" to a real, executable file on PATH (searched relative to ${cwd})`
      );
    }
    child = spawn(resolvedProgram, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
  } catch (err) {
    return {
      child: undefined,
      spawnError: err,
      done: Promise.resolve({ code: null, signal: null, error: err }),
    };
  }
  const done = new Promise((resolve) => {
    let settled = false;
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      resolve({ code: null, signal: null, error: err });
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, error: undefined });
    });
  });
  return { child, spawnError: undefined, done };
}

/**
 * Best-effort SIGTERM, then (only if it has not exited within
 * `gracePeriodMs`) SIGKILL - the deadlock-fix's own "kills its failed
 * child" half. Never throws: a child that has already exited, or one this
 * process no longer has permission to signal, is not this function's
 * problem to escalate - the caller's own subsequent `release()` is what
 * actually matters for correctness, and it must never be skipped because
 * this cleanup step threw.
 *
 * `child.exitCode`/`child.signalCode` are Node's own ChildProcess
 * bookkeeping, updated internally the moment the real 'exit' event fires -
 * polling them here needs no separate listener of this function's own.
 *
 * @param {import("node:child_process").ChildProcess | undefined} child
 * @param {{ gracePeriodMs?: number, pollIntervalMs?: number }} [opts]
 */
export async function killBestEffort(child, { gracePeriodMs = 2000, pollIntervalMs = 25 } = {}) {
  if (child === undefined || child.pid === undefined) return;
  const alreadyExited = () => child.exitCode !== null || child.signalCode !== null;
  if (alreadyExited()) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // best-effort
  }
  const deadline = Date.now() + gracePeriodMs;
  while (!alreadyExited() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  if (!alreadyExited()) {
    try {
      child.kill("SIGKILL");
    } catch {
      // best-effort
    }
  }
}

/**
 * The default `composeIdentityWrite` `acquireAsFloorJob` uses for its own
 * write B (embedding `floorJobBirthIdentity` once the async capture
 * resolves). Spreads `baseSnapshot` - write A's OWN, just-written payload -
 * never a stale or earlier variable. THE EXACT BUG CLASS THIS GUARDS
 * AGAINST: an earlier round of this design's own review found a version
 * that spread from a DIFFERENT, earlier object at this exact point,
 * silently REGRESSING every field write A had just added (floorJobPid,
 * phase: "floor-running") back to whatever the object it spread from held
 * instead. This function is the ONE place that construction happens in
 * production; `test/coverage-floor-lock.test.ts` injects a deliberately
 * buggy replacement (via `acquireAsFloorJob`'s own `composeIdentityWrite`
 * parameter) to prove that regression is both reproducible and caught.
 *
 * @param {Record<string, unknown>} baseSnapshot
 * @param {import("../../dist/process.js").ProcessBirthIdentity} birthIdentity
 * @returns {Record<string, unknown>}
 */
export function defaultComposeIdentityWrite(baseSnapshot, birthIdentity) {
  return { ...baseSnapshot, floorJobBirthIdentity: birthIdentity };
}

// ---------------------------------------------------------------------------
// The two entrypoints
// ---------------------------------------------------------------------------

/**
 * The WORKER side: `npm run coverage`'s own real command, lock-guarded.
 * Implements the full "on start" check, the three-write working ->
 * publishing sequence, and the deadlock-fix release-on-any-failure path -
 * see this module's own header for the state machine and the gap this
 * closes.
 *
 * Every dependency past `argv`/`lockPath`/`headSha`/`repoRoot` is
 * injectable, defaulting to the real implementation - this is what makes
 * the whole sequence (including a forced write failure, or a forced
 * identity-check outcome) directly unit-testable in-process, with no real
 * child wrapper process needed for most scenarios (only
 * `test/coverage-lock-wrappers.test.ts`'s own end-to-end tests spawn the
 * real CLI entrypoints).
 *
 * @param {{
 *   argv: string[],
 *   lockPath?: string,
 *   headSha: string,
 *   repoRoot?: string,
 *   now?: () => number,
 *   spawnFn?: typeof defaultSpawnTracked,
 *   writeFn?: typeof writeIdentityAtomic,
 *   releaseFn?: typeof release,
 *   captureSelfIdentity?: () => import("../../dist/process.js").ProcessBirthIdentity | undefined,
 *   identityCheck?: typeof checkProcessIdentity,
 *   plainCheck?: typeof isProcessAlive,
 * }} options `releaseFn` defaults to the real `release` above (the
 *   deadlock-fix's own "vacate the lock" half); it is injectable
 *   specifically so test/coverage-lock-wrappers.test.ts's own deadlock-fix
 *   control can PROVE the fix is load-bearing by disabling just this one
 *   step (a no-op `releaseFn`) and observing the resulting deadlock (a
 *   live-but-non-releasing owner blocks a genuine reclaim) before
 *   re-enabling it and observing the reclaim succeed - production code
 *   never overrides this parameter.
 * @returns {Promise<{ exitCode: number }>}
 */
export async function acquireAsWorker({
  argv,
  lockPath = LOCK_PATH,
  headSha,
  repoRoot = REPO_ROOT,
  now = Date.now,
  spawnFn = defaultSpawnTracked,
  writeFn = writeIdentityAtomic,
  releaseFn = release,
  captureSelfIdentity = () => captureBirthIdentityPosix(process.pid),
  identityCheck = checkProcessIdentity,
  plainCheck = isProcessAlive,
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error(
      "acquireAsWorker: argv must be a non-empty array naming the real coverage command to run"
    );
  }
  if (typeof headSha !== "string" || headSha.length === 0) {
    throw new Error("acquireAsWorker: headSha is required");
  }

  // STEP 1: on-start check.
  let existing;
  try {
    existing = readLockFile(lockPath);
  } catch (err) {
    console.error(
      `coverage-lock-worker: REFUSED - the lock file at ${lockPath} exists but could not be read/parsed (${describeError(
        err
      )}). Refusing to proceed against a lock file in an unknown state; investigate and remove it manually if it is genuinely stale.`
    );
    return { exitCode: 1 };
  }
  if (existing !== null) {
    const held = await isLockCurrentlyHeld(existing, { now, identityCheck, plainCheck });
    if (held.held) {
      console.error(
        `coverage-lock-worker: REFUSED - ${held.reason}. Another "npm run coverage" (or the floor check that follows it) appears to still be in progress; refusing to run the coverage command concurrently.`
      );
      return { exitCode: 1 };
    }
    if (existing.phase === "done") {
      // The ORDINARY, expected terminal case - a clean prior CI run whose
      // floor check already completed and reported its own exit code. This
      // is not a "reclaim" in the crash-recovery sense at all (nothing was
      // abandoned; see isLockCurrentlyHeld's own "done" short-circuit docs)
      // and must not be logged as if every ordinary run involved recovering
      // from a stale lock.
      console.log(
        `coverage-lock-worker: the previous run's lock is in its ordinary terminal "done" phase (${held.reason}) - proceeding with a fresh run.`
      );
    } else {
      // A GENUINE crash-reclaim: the recorded owner (and, for a
      // "floor-running" phase, the floor job too) was confirmed dead by a
      // real liveness check rather than found in an already-terminal state.
      console.log(
        `coverage-lock-worker: reclaiming a lock left over from a previous run that appears to have crashed without releasing (${held.reason}).`
      );
    }
  }

  const ownerPid = process.pid;
  const ownerBirthIdentity = captureSelfIdentity();
  const startedAt = new Date(now()).toISOString();
  /** @type {Record<string, unknown> | undefined} */
  let latestSnapshot = { phase: "working", ownerPid, ownerBirthIdentity, headSha, startedAt };
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let child;

  async function abandonOnFailure(err, stage) {
    if (child !== undefined) await killBestEffort(child);
    let onDisk = null;
    try {
      onDisk = readLockFile(lockPath);
    } catch {
      // best-effort diagnostic fallback only - releaseFn() below still
      // runs regardless of whether this re-read itself succeeds.
    }
    const base = latestSnapshot ??
      onDisk ?? { phase: "working", ownerPid, ownerBirthIdentity, headSha, startedAt };
    // Guards releaseFn's OWN call - not just the shipped default `release`
    // above, which is already internally exception-safe by its own design.
    // `releaseFn` is a deliberately injectable seam (this file's own test
    // suite injects a custom one), and any FUTURE custom releaseFn that
    // throws must never escape abandonOnFailure uncaught: an uncaught throw
    // here would defeat the deadlock-fix guarantee in exactly the scenario
    // it exists to prevent - the child already killed, but the caller never
    // even finishes reporting the failure, let alone anything downstream
    // that might otherwise have a chance to notice and intervene.
    // abandonOnFailure itself must never throw, no matter what releaseFn
    // does.
    try {
      releaseFn(lockPath, {
        ...base,
        phase: "released",
        releaseReason: `worker-${stage}-failure`,
        releasedAt: new Date(now()).toISOString(),
        failureDetail: describeError(err),
      });
    } catch (releaseErr) {
      console.error(
        `coverage-lock-worker: releaseFn itself threw while abandoning a failed run (${describeError(
          releaseErr
        )}) - the lock may still be live-but-non-releasing as a result; this is best-effort cleanup and must never mask the real failure below.`
      );
    }
    console.error(
      `coverage-lock-worker: FAILED at stage "${stage}": ${describeError(
        err
      )} - the lock has been released so a later invocation can reclaim it rather than deadlocking.`
    );
  }

  try {
    // Write 1 (acquired -> working).
    writeFn(lockPath, latestSnapshot);

    const spawned = spawnFn(argv, { cwd: repoRoot });
    child = spawned.child;
    if (child === undefined) {
      throw (
        spawned.spawnError ??
        new Error("failed to spawn the coverage command: no child process was created")
      );
    }

    // Write 2: record workerPid, still phase "working".
    latestSnapshot = { ...latestSnapshot, workerPid: child.pid };
    writeFn(lockPath, latestSnapshot);

    const { code, signal, error } = await spawned.done;
    if (error) throw error;

    // Write 3 (working -> publishing) - the handoff to the floor wrapper.
    latestSnapshot = {
      ...latestSnapshot,
      phase: "publishing",
      workerExitCode: code,
      publishedAt: new Date(now()).toISOString(),
    };
    writeFn(lockPath, latestSnapshot);

    console.log(
      `coverage-lock-worker: the coverage command finished (exit ${code}${
        signal ? `, signal ${signal}` : ""
      }); handed off to "npm run check:coverage-floor".`
    );
    return { exitCode: code ?? 1 };
  } catch (err) {
    await abandonOnFailure(err, child === undefined ? "spawn" : "write-or-exit");
    return { exitCode: 1 };
  }
}

/**
 * The FLOOR side: `npm run check:coverage-floor`'s own real command,
 * lock-guarded. Implements the three-way (plus reclaim) dispatch, the
 * write-A/write-B/write-4 floor-running -> done sequence, and the
 * identical deadlock-fix release-on-any-failure path as `acquireAsWorker`
 * - see this module's own header.
 *
 * @param {{
 *   argv: string[],
 *   lockPath?: string,
 *   headSha: string,
 *   repoRoot?: string,
 *   now?: () => number,
 *   spawnFn?: typeof defaultSpawnTracked,
 *   writeFn?: typeof writeIdentityAtomic,
 *   releaseFn?: typeof release,
 *   composeIdentityWrite?: typeof defaultComposeIdentityWrite,
 *   captureChildIdentity?: typeof captureBirthIdentityPosixAsync,
 *   identityCheck?: typeof checkProcessIdentity,
 *   plainCheck?: typeof isProcessAlive,
 * }} options `releaseFn` defaults to the real `release` above - see
 *   `acquireAsWorker`'s identical parameter for why it is injectable.
 * @returns {Promise<{ exitCode: number }>}
 */
export async function acquireAsFloorJob({
  argv,
  lockPath = LOCK_PATH,
  headSha,
  repoRoot = REPO_ROOT,
  now = Date.now,
  spawnFn = defaultSpawnTracked,
  writeFn = writeIdentityAtomic,
  releaseFn = release,
  composeIdentityWrite = defaultComposeIdentityWrite,
  captureChildIdentity = captureBirthIdentityPosixAsync,
  identityCheck = checkProcessIdentity,
  plainCheck = isProcessAlive,
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error(
      "acquireAsFloorJob: argv must be a non-empty array naming the real floor-check command to run"
    );
  }
  if (typeof headSha !== "string" || headSha.length === 0) {
    throw new Error("acquireAsFloorJob: headSha is required");
  }

  let state;
  try {
    state = readLockState(lockPath);
  } catch (err) {
    console.error(
      `coverage-lock-floor: REFUSED - the lock file at ${lockPath} exists but could not be read/parsed (${describeError(
        err
      )}). Refusing to proceed against a lock file in an unknown state; investigate and remove it manually if it is genuinely stale.`
    );
    return { exitCode: 1 };
  }
  const classification = classifyFloorAcquisition(state, headSha);

  if (classification.outcome === "refuse") {
    console.error(
      `coverage-lock-floor: REFUSED [${classification.reason}] - ${classification.detail}`
    );
    return { exitCode: 1 };
  }

  /** @type {Record<string, unknown>} */
  let carriedForward;
  if (classification.outcome === "proceed-normal-handoff") {
    carriedForward = classification.payload;
  } else {
    // reclaim-check-needed: phase "floor-running" or "done" - see this
    // module's own header + isLockCurrentlyHeld's own docs for why this is
    // resolved by floorJobPid's OWN liveness, not ownerPid's.
    const payload = classification.payload;
    const floorVerdict = await checkFloorJobLiveness(payload, { now, identityCheck, plainCheck });
    if (livenessBlocksAcquisition(floorVerdict.verdict)) {
      console.error(
        `coverage-lock-floor: REFUSED - a floor check appears to already be in progress for this lock (floorJobPid ${
          payload.floorJobPid
        }, phase "${payload.phase}", ${floorVerdict.verdict}${
          floorVerdict.reason ? `: ${floorVerdict.reason}` : ""
        }). Not reclaiming while it may still be live.`
      );
      return { exitCode: 1 };
    }
    console.log(
      `coverage-lock-floor: reclaiming an abandoned "${payload.phase}" lock record (floorJobPid ${payload.floorJobPid} is ${floorVerdict.verdict}) - a prior floor-check invocation appears to have crashed without releasing.`
    );
    // STALE-IDENTITY FIX: `payload` may still carry `floorJobBirthIdentity`
    // (written by the PRIOR, now-dead attempt's own write B) and/or
    // `floorJobExitCode` (present if the prior record had already reached
    // phase "done"). Neither describes the NEW floor job this invocation is
    // about to spawn - write A below overwrites `phase`/`floorJobPid`/
    // `floorRunningAt` with the new attempt's own values but, being a plain
    // spread, cannot REMOVE a key it does not itself set. Left uncleared,
    // the on-disk record would pair the new, live `floorJobPid` with the
    // old, unrelated process's `floorJobBirthIdentity` for as long as write
    // A stands alone (up to FLOOR_JOB_DEGRADED_WINDOW_MS, or indefinitely if
    // write B's own async capture never lands) - and `checkFloorJobLiveness`
    // would then almost certainly report `identity-mismatch` for that
    // window (the real new pid does not match the stale old identity),
    // which `livenessBlocksAcquisition` does NOT treat as blocking. A THIRD
    // invocation landing in that window would read "not blocking, safe to
    // reclaim" and could spawn a second, genuinely concurrent floor-check
    // process racing the one that just legitimately reclaimed - exactly the
    // failure this whole module exists to prevent. Explicit `undefined`
    // (never a plain omission) is what makes this a real deletion rather
    // than "did not think to set it": `JSON.stringify` drops an `undefined`
    // -valued key entirely, so the write below - and every write after it
    // that continues to spread this object forward - carries no trace of
    // either field on disk.
    carriedForward = { ...payload, floorJobBirthIdentity: undefined, floorJobExitCode: undefined };
  }

  let latestSnapshot = carriedForward;
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let child;

  async function abandonOnFailure(err, stage) {
    if (child !== undefined) await killBestEffort(child);
    let onDisk = null;
    try {
      onDisk = readLockFile(lockPath);
    } catch {
      // best-effort diagnostic fallback only.
    }
    const base = latestSnapshot ?? onDisk ?? carriedForward;
    // Guards releaseFn's OWN call - see acquireAsWorker's identical guard
    // above for why: abandonOnFailure itself must never throw, no matter
    // what a future custom releaseFn does.
    try {
      releaseFn(lockPath, {
        ...base,
        phase: "released",
        releaseReason: `floor-${stage}-failure`,
        releasedAt: new Date(now()).toISOString(),
        failureDetail: describeError(err),
      });
    } catch (releaseErr) {
      console.error(
        `coverage-lock-floor: releaseFn itself threw while abandoning a failed run (${describeError(
          releaseErr
        )}) - the lock may still be live-but-non-releasing as a result; this is best-effort cleanup and must never mask the real failure below.`
      );
    }
    console.error(
      `coverage-lock-floor: FAILED at stage "${stage}": ${describeError(
        err
      )} - the lock has been released so a later invocation can reclaim it rather than deadlocking.`
    );
  }

  try {
    const spawned = spawnFn(argv, { cwd: repoRoot });
    child = spawned.child;
    if (child === undefined) {
      throw (
        spawned.spawnError ??
        new Error("failed to spawn the floor-check command: no child process was created")
      );
    }

    // Write A (publishing -> floor-running): everything carried forward
    // from write A/B/3 of the worker's own sequence, plus floorJobPid.
    const writeASnapshot = {
      ...carriedForward,
      phase: "floor-running",
      floorJobPid: child.pid,
      floorRunningAt: new Date(now()).toISOString(),
    };
    writeFn(lockPath, writeASnapshot);
    latestSnapshot = writeASnapshot;

    const identity = await captureChildIdentity(child.pid, ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS);
    if (identity !== undefined) {
      // Write B - wrapped in its OWN try/catch, deliberately separate from
      // the outer one: a failed write B must never trigger the deadlock-
      // fix abandon path, and must never block write 4. Falls through
      // exactly as if the capture itself had not landed within its
      // timeout.
      try {
        const writeBSnapshot = composeIdentityWrite(writeASnapshot, identity);
        writeFn(lockPath, writeBSnapshot);
        latestSnapshot = writeBSnapshot;
      } catch (writeBErr) {
        console.error(
          `coverage-lock-floor: write B (embedding the floor job's birth identity) failed - continuing without it, exactly as if the capture itself had not landed in time: ${describeError(
            writeBErr
          )}`
        );
        // latestSnapshot intentionally stays at writeASnapshot.
      }
    }

    const { code, signal, error } = await spawned.done;
    if (error) throw error;

    // Write 4 (floor-running -> done), then release.
    const doneSnapshot = { ...latestSnapshot, phase: "done", floorJobExitCode: code };
    writeFn(lockPath, doneSnapshot);
    latestSnapshot = doneSnapshot;

    releaseFn(lockPath, {
      ...doneSnapshot,
      releaseReason: "normal-done",
      releasedAt: new Date(now()).toISOString(),
    });

    console.log(
      `coverage-lock-floor: the floor check finished (exit ${code}${
        signal ? `, signal ${signal}` : ""
      }); lock released.`
    );
    // Faithfully preserves PASS (0) / FAIL (1) / VOID (2, see
    // scripts/check-coverage-floor.mjs's VOID_EXIT_CODE) exactly as the
    // real floor-check command reported it.
    return { exitCode: code ?? 1 };
  } catch (err) {
    await abandonOnFailure(err, child === undefined ? "spawn" : "write-or-exit");
    return { exitCode: 1 };
  }
}
