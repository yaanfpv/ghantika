#!/usr/bin/env node
/**
 * scripts/doorbell-cutover-harness.mjs - the SYNTHETIC N=20-cycle proof
 * of the cutover mechanism, run against a scratch trigger file this
 * script creates itself under `node:os`'s own tmpdir. Never touches,
 * arms, disarms, or even resolves the path of any real fleet seat's
 * real mail doorbell - see doorbell-cutover.mjs's own header for the
 * boundary this stays inside. A live cutover against a real seat's real
 * doorbell is explicitly out of scope for anything this repository's
 * own automation may attempt unsupervised.
 *
 * What this proves, over N=20 fixed cycles once ghantika owns the
 * trigger (i.e. after the initial Monitor->ghantika cutover this script
 * performs first): each simulated mail arrival produces EXACTLY one
 * nonce-correlated resumption - counted separately from the six classes
 * of internal "command" event (c1-arm through c6-reap) the controller
 * also emits - with zero missed and zero spurious wakes anywhere in the
 * run. It then performs one deliberate ghantika->monitor cutover (a
 * fallback to the baseline mechanism) to prove the reverse direction
 * too, before reaping both detectors unconditionally.
 *
 * Usage: `node scripts/doorbell-cutover-harness.mjs` - prints a summary
 * report to stdout and exits 0 on success, exits 1 (with the failing
 * assertion's message on stderr) on any deviation from the above. Also
 * importable: `runHarness()` is what test/doorbell-cutover.test.ts calls
 * to assert on the SAME real run's structured result, rather than
 * re-deriving a second copy of this proof.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import { CutoverController, encodeMailArrival, generateNonce } from "./lib/doorbell-cutover.mjs";
import { GhantikaDetector, MonitorDetector } from "./lib/doorbell-cutover-detectors.mjs";
import { isMainModule } from "./lib/is-main.mjs";

export const CYCLE_COUNT = 20;

/**
 * Polls `predicate` until it is true or `timeoutMs` elapses - the same
 * real-observation-over-fixed-sleep discipline test/harness.ts's own
 * `barrier` uses (see this repo's test suite), reused here in a plain
 * script with no test-runner dependency of its own.
 *
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 * @param {string} label
 */
async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil "${label}" timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Builds one fresh scratch harness: a temp dir + trigger path (created
 * empty), a monitor/ghantika detector pair wired to it, and a
 * CutoverController starting with "monitor" as owner - the existing
 * baseline mechanism, per doorbell-cutover.mjs's own role docs.
 * Every event the controller emits is collected into `events`/`counts`
 * so a caller (this file's own `main`, or a test) can assert on the real
 * observed record of what happened, not a description of what should.
 *
 * Does NOT arm anything itself - CutoverController's own contract is
 * that `initialOwner`'s detector is the caller's responsibility to have
 * armed already (see its class doc). `runHarness()` below is what does
 * that, immediately after calling this.
 */
export function buildHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-doorbell-cutover-"));
  const triggerPath = path.join(dir, "scratch.trigger");
  writeFileSync(triggerPath, "");

  const detectors = {
    monitor: new MonitorDetector({ triggerPath, intervalMs: 20 }),
    ghantika: new GhantikaDetector({ triggerPath }),
  };

  const events = {
    resumptions:
      /** @type {Array<{ nonce: { id: string, seq: number }, role: string, observedAtMs: number }>} */ ([]),
    deduped: /** @type {Array<unknown>} */ ([]),
    spurious: /** @type {Array<unknown>} */ ([]),
    lateDuplicates: /** @type {Array<unknown>} */ ([]),
    commands:
      /** @type {Array<{ kind: string, role: string, atMs: number, attempt?: number }>} */ ([]),
  };
  const counts = { resumption: 0, deduped: 0, spurious: 0, lateDuplicate: 0 };
  for (const kind of ["c1-arm", "c2-disarm", "c3-probe", "c4-retry", "c5-rollback", "c6-reap"]) {
    counts[kind] = 0;
  }

  const controller = new CutoverController({
    detectors,
    initialOwner: "monitor",
    onResumption: (e) => {
      events.resumptions.push(e);
      counts.resumption += 1;
    },
    onDeduped: (e) => {
      events.deduped.push(e);
      counts.deduped += 1;
    },
    onSpurious: (e) => {
      events.spurious.push(e);
      counts.spurious += 1;
    },
    onLateDuplicate: (e) => {
      events.lateDuplicates.push(e);
      counts.lateDuplicate += 1;
    },
    onCommand: (e) => {
      events.commands.push(e);
      counts[e.kind] += 1;
    },
  });

  return { dir, triggerPath, detectors, controller, events, counts };
}

/**
 * Sends one simulated mail arrival: mints a fresh nonce, registers it as
 * expected on `controller`, writes the corresponding bytes to
 * `triggerPath`, then waits (bounded) for exactly one resumption
 * correlated with that nonce id to appear in `resumptions`. Returns the
 * nonce and how long the resumption took to be observed.
 *
 * @param {import("./lib/doorbell-cutover.mjs").CutoverController} controller
 * @param {string} triggerPath
 * @param {number} seq
 * @param {Array<{ nonce: { id: string } }>} resumptions
 */
async function sendMailAndAwaitResumption(controller, triggerPath, seq, resumptions) {
  const nonce = generateNonce(seq);
  controller.expectNonce(nonce);
  const sentAtMs = Date.now();
  writeFileSync(triggerPath, encodeMailArrival(nonce, sentAtMs));
  // A liveness guard against hanging forever if something is genuinely
  // broken, not a latency promise ghantika's own doorbell mechanism makes
  // anywhere (checked: no such claim in lib/doorbell-cutover.mjs). Every
  // outcome this proof cares about - missed, spurious, deduped, or
  // late-duplicate - is caught by the content assertions in runHarness()
  // regardless of how long a real resumption takes to arrive, so widening
  // this bound gives real OS scheduling under host contention more room
  // without weakening what's proven.
  await waitUntil(
    () => resumptions.some((r) => r.nonce.id === nonce.id),
    10_000,
    `resumption for nonce ${nonce.id} (seq ${seq})`
  );
  const observed = resumptions.find((r) => r.nonce.id === nonce.id);
  return { nonce, elapsedMs: (observed?.observedAtMs ?? Date.now()) - sentAtMs };
}

/**
 * Runs the whole proof: initial Monitor->ghantika cutover, N=20
 * steady-state mail-arrival cycles, one ghantika->Monitor fallback
 * cutover, then an unconditional reap - all against one fresh scratch
 * harness. Every assertion below is a real, executed check against a
 * real filesystem and real timers, never a description of expected
 * behavior.
 *
 * @returns {Promise<{
 *   dir: string,
 *   initialCutover: unknown,
 *   fallbackCutover: unknown,
 *   cycles: Array<{ nonce: { id: string, seq: number }, elapsedMs: number }>,
 *   counts: Record<string, number>,
 *   events: ReturnType<typeof buildHarness>["events"],
 * }>}
 */
export async function runHarness() {
  const harness = buildHarness();
  const { dir, triggerPath, controller, events, counts } = harness;
  /** @type {unknown} */
  let initialCutover;
  /** @type {unknown} */
  let fallbackCutover;
  /** @type {Array<{ nonce: { id: string, seq: number }, elapsedMs: number }>} */
  let cycles;

  try {
    // The baseline mechanism (Monitor) is arms-length from the cutover
    // machinery itself - CutoverController assumes it, never arms it (see
    // its own class doc). This is the equivalent of an existing heartbeat
    // already running before any cutover proof begins.
    await harness.detectors.monitor.arm();
    assert.equal(
      harness.detectors.monitor.isArmed(),
      true,
      "baseline (monitor) detector must be armed before the proof begins"
    );

    // "wake": the initial forward cutover, Monitor -> ghantika.
    initialCutover = await controller.cutover("ghantika");
    assert.equal(
      initialCutover.status,
      "SUCCESS",
      `initial cutover must succeed: ${JSON.stringify(initialCutover)}`
    );
    assert.equal(controller.getOwner().owner, "ghantika");

    // Steady state: N=20 fixed cycles, ghantika sole owner throughout.
    // Each cycle is a full send-and-await round trip, never overlapped
    // with the next, so "exactly one resumption per mail" is checked
    // cycle-by-cycle rather than as an aggregate count that could hide a
    // missing one against a spurious extra one.
    cycles = [];
    for (let i = 1; i <= CYCLE_COUNT; i++) {
      const before = counts.resumption;
      const { nonce, elapsedMs } = await sendMailAndAwaitResumption(
        controller,
        triggerPath,
        i,
        events.resumptions
      );
      assert.equal(
        counts.resumption,
        before + 1,
        `cycle ${i}: expected exactly one new resumption, resumption count moved from ${before} to ${counts.resumption}`
      );
      cycles.push({ nonce, elapsedMs });
    }

    assert.equal(
      counts.resumption,
      CYCLE_COUNT,
      `expected exactly ${CYCLE_COUNT} resumptions total`
    );
    assert.equal(
      counts.spurious,
      0,
      `expected zero spurious wakes during the steady-state proof, got ${counts.spurious}: ${JSON.stringify(events.spurious)}`
    );
    assert.equal(
      counts.deduped,
      0,
      `steady-state cycles are sent one at a time with no overlap - zero dedupe events expected, got ${counts.deduped}`
    );
    assert.equal(
      counts.lateDuplicate,
      0,
      `expected zero late-duplicate anomalies, got ${counts.lateDuplicate}`
    );

    // "fall back": the reverse cutover, ghantika -> Monitor.
    fallbackCutover = await controller.cutover("monitor");
    assert.equal(
      fallbackCutover.status,
      "SUCCESS",
      `fallback cutover must succeed: ${JSON.stringify(fallbackCutover)}`
    );
    assert.equal(controller.getOwner().owner, "monitor");

    // Prove the fallback is genuinely live: one more mail arrival must
    // still produce exactly one resumption, now observed via monitor's
    // own (polling) detector rather than ghantika's.
    const before = counts.resumption;
    await sendMailAndAwaitResumption(controller, triggerPath, CYCLE_COUNT + 1, events.resumptions);
    assert.equal(
      counts.resumption,
      before + 1,
      "fallback owner (monitor) must still deliver a real resumption"
    );
  } finally {
    // Every detector must be reaped on every path, success or failure -
    // this `finally` covers every early-return/throw above. Deliberately
    // BEFORE the `counts` snapshot below is built: reapAll() itself
    // emits a c6-reap command event, and a snapshot taken before this
    // finally block runs would silently exclude it - measured directly:
    // a `try { return { counts: {...counts} } } finally { await
    // reapAll() }` evaluates the return expression BEFORE the finally
    // block runs, so the very reap this function guarantees happened
    // would never show up in its own reported counts.
    await controller.reapAll();
    assert.equal(
      harness.detectors.monitor.isArmed(),
      false,
      "monitor detector must be disarmed after reapAll()"
    );
    assert.equal(
      harness.detectors.ghantika.isArmed(),
      false,
      "ghantika detector must be disarmed after reapAll()"
    );
  }

  return { dir, initialCutover, fallbackCutover, cycles, counts: { ...counts }, events };
}

function printReport(result) {
  // Total local_seat (resumption) events = the CYCLE_COUNT steady-state
  // cycles below, PLUS exactly one further resumption from the post-
  // fallback "monitor still delivers" check runHarness() performs after
  // the reverse cutover (see runHarness's own comment on this) - reported
  // as two explicit numbers rather than one combined figure, so this
  // report never states a total that could be misread as the N=20 count
  // itself.
  const steadyStateResumptions = result.cycles.length;
  const totalResumptions = result.counts.resumption;
  const postFallbackResumptions = totalResumptions - steadyStateResumptions;
  const commandTotal =
    result.counts["c1-arm"] +
    result.counts["c2-disarm"] +
    result.counts["c3-probe"] +
    result.counts["c4-retry"] +
    result.counts["c5-rollback"] +
    result.counts["c6-reap"];
  console.log("doorbell-cutover synthetic harness - N=%d cycle proof", CYCLE_COUNT);
  console.log("scratch dir: %s", result.dir);
  console.log("initial cutover (Monitor->ghantika): %s", JSON.stringify(result.initialCutover));
  console.log("fallback cutover (ghantika->Monitor): %s", JSON.stringify(result.fallbackCutover));
  console.log("");
  console.log(
    "local_seat (resumption) events: %d total (%d steady-state cycles + %d post-fallback verification)",
    totalResumptions,
    steadyStateResumptions,
    postFallbackResumptions
  );
  console.log("c1-c6 (command) events, by class:");
  for (const kind of ["c1-arm", "c2-disarm", "c3-probe", "c4-retry", "c5-rollback", "c6-reap"]) {
    console.log("  %s: %d", kind, result.counts[kind]);
  }
  console.log("  total command events: %d", commandTotal);
  console.log("");
  console.log(
    "deduped: %d, spurious: %d, lateDuplicate: %d",
    result.counts.deduped,
    result.counts.spurious,
    result.counts.lateDuplicate
  );
  console.log("");
  console.log("per-cycle resumption latency (ms), send-to-observe:");
  console.log("  %s", result.cycles.map((c) => c.elapsedMs).join(", "));
  console.log("");
  console.log(
    "PASS: %d/%d steady-state cycles each produced exactly one nonce-correlated resumption, zero missed, zero spurious",
    steadyStateResumptions,
    CYCLE_COUNT
  );
}

async function main() {
  let result;
  try {
    result = await runHarness();
  } catch (err) {
    console.error(
      "doorbell-cutover harness FAILED: %s",
      err instanceof Error ? err.stack : String(err)
    );
    process.exitCode = 1;
    return;
  }
  printReport(result);
  rmSync(result.dir, { recursive: true, force: true });
}

if (isMainModule(import.meta.url)) {
  await main();
}
