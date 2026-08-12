/**
 * Regression coverage for the concurrency-cap + FIFO queue policy sitting
 * in front of `run()`'s real spawn (`src/scheduler.ts` + the state/wiring
 * it drives in `src/jobStore.ts`/`src/tools/run.ts`/`src/tools/list.ts`/
 * `src/server.ts`).
 *
 * Mixes two testing styles, matching this repo's own established
 * conventions (see `test/jobStore.test.ts`):
 *
 * - A fresh `new JobStore(config)` instance, driven directly through
 *   `requestSlot`/`enqueueJob`/`releaseSlot`, for the pure admission/queue
 *   CONTRACT - deterministic, no real process spawning needed, and able to
 *   simulate a slow reap or a post-dequeue spawn failure precisely, rather
 *   than racing a real OS timing window.
 * - The shared `jobStore` singleton reconfigured via `setConcurrencyConfig`,
 *   driving the REAL `run`/`status`/`list`/`kill` tool handlers directly
 *   (the same pattern `test/tools.test.ts` already uses) or a real
 *   in-process `createServer()` + `Client` pair (the same pattern
 *   `test/shutdown.test.ts`'s own in-process tests already use), for the
 *   genuine tool-level wiring: `run()`'s own admit/queue/reject response,
 *   `queue_position`'s observability via `status`/`list`, and the cap's
 *   observability via `list`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import {
  ALL_JOB_STATES,
  JobStore,
  type ReapReleaseDecision,
  isTerminalJobState,
  jobStore,
} from "../dist/jobStore.js";
import { CWD_ROOTS_ENV_VAR } from "../dist/process.js";
import { loadConcurrencyConfigFromEnv, normalizeNonNegativeInteger } from "../dist/scheduler.js";
import { createServer } from "../dist/server.js";
import * as tasksAdapter from "../dist/tasksAdapter.js";
import * as killTool from "../dist/tools/kill.js";
import * as listTool from "../dist/tools/list.js";
import * as outputTool from "../dist/tools/output.js";
import * as runTool from "../dist/tools/run.js";
import * as statusTool from "../dist/tools/status.js";

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

/** Polls `predicate` until it's true (or times out) - a real synchronization point, never a blind fixed sleep, mirroring `test/harness.ts`'s own `barrier` helper. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 20
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Cleans up every job this file's tool-level tests might have left on the
 * shared `jobStore` singleton: drains any still-queued job (the same real
 * `drainQueueOnShutdown` the server's own shutdown path uses - a queued
 * job never had a real child attached, so this is the correct way to
 * cancel one, not `kill()`), then kills any still-active real job and waits for
 * its concurrency slot to actually be released before returning - `kill()`
 * resolving is not itself proof that this store's own async
 * onExit-triggered slot release has already completed.
 */
async function cleanUpSharedJobs(activeJobIds: readonly string[]): Promise<void> {
  jobStore.drainQueueOnShutdown();
  for (const jobId of activeJobIds) {
    await killTool.handler({ job_id: jobId });
  }
  await waitUntil(() => jobStore.getActiveSlotCount() === 0 && jobStore.getQueueLength() === 0);
}

// ---------------------------------------------------------------------------
// normalizeNonNegativeInteger: absent/blank vs an explicit "0", and unsafe
// integers
// ---------------------------------------------------------------------------

test('normalizeNonNegativeInteger falls back to the default for an absent, blank, or whitespace-only value - never silently treating a blank env var as an explicit 0 - while an explicit "0" still works, and an unsafe-integer value also falls back rather than being accepted imprecisely', () => {
  const fallback = 8;

  // Absent (undefined) - the ordinary "no env var set at all" case. Must
  // already have worked before this fix; confirming it here pins the
  // baseline the blank-string guard must not disturb.
  assert.equal(normalizeNonNegativeInteger(undefined, fallback), fallback);

  // Blank/whitespace-only STRING - the actual bug: `Number("")` and
  // `Number(" ")` both coerce to `0` in JS, so without the dedicated
  // blank check these would silently become "0" (no concurrency
  // capacity) rather than falling back to the default like an absent
  // variable does.
  assert.equal(normalizeNonNegativeInteger("", fallback), fallback, "empty string must fall back");
  assert.equal(
    normalizeNonNegativeInteger(" ", fallback),
    fallback,
    "single-space string must fall back"
  );
  assert.equal(
    normalizeNonNegativeInteger("   \t  ", fallback),
    fallback,
    "whitespace-only string (spaces + tab) must fall back"
  );

  // An EXPLICIT "0" is a real, deliberate, legal value per this type's own
  // doc comment ("no concurrency capacity at all" is intentional when
  // explicitly requested) - the blank check must never swallow this.
  assert.equal(normalizeNonNegativeInteger("0", fallback), 0, 'explicit "0" must still work');

  // A normal positive value, unaffected by either guard.
  assert.equal(normalizeNonNegativeInteger("5", fallback), 5);

  // Already-correctly-rejected shapes - confirm these still fall back
  // after this fix, i.e. no regression.
  assert.equal(
    normalizeNonNegativeInteger("1.5", fallback),
    fallback,
    "non-integer must fall back"
  );
  assert.equal(normalizeNonNegativeInteger("-1", fallback), fallback, "negative must fall back");
  assert.equal(
    normalizeNonNegativeInteger("Infinity", fallback),
    fallback,
    "non-finite must fall back"
  );

  // Unsafe integer: one more than Number.MAX_SAFE_INTEGER. `Number()`
  // coercion loses precision here (rounds to 9007199254740992, which
  // still passes the OLD `Number.isInteger` check even though it is not
  // the value actually configured) - `Number.isSafeInteger` must reject
  // it and fall back to the default rather than silently accepting the
  // imprecise value.
  assert.equal(
    normalizeNonNegativeInteger(String(Number.MAX_SAFE_INTEGER + 2), fallback),
    fallback,
    "a value above Number.MAX_SAFE_INTEGER must fall back, never be accepted imprecisely"
  );
  // The largest value that IS exactly representable must still work.
  assert.equal(
    normalizeNonNegativeInteger(String(Number.MAX_SAFE_INTEGER), fallback),
    Number.MAX_SAFE_INTEGER,
    "Number.MAX_SAFE_INTEGER itself is a legal, exactly-representable value"
  );
});

test('loadConcurrencyConfigFromEnv falls back to the documented defaults when the env vars are present but blank, distinguishing that from an explicit "0"', () => {
  const blankEnv = { GHANTIKA_MAX_CONCURRENT_JOBS: "", GHANTIKA_MAX_QUEUE_DEPTH: " " };
  const config = loadConcurrencyConfigFromEnv(blankEnv);
  assert.equal(
    config.maxConcurrentJobs,
    8,
    "blank max-concurrent-jobs must fall back to the default 8"
  );
  assert.equal(config.maxQueueDepth, 32, "blank max-queue-depth must fall back to the default 32");

  const explicitZeroEnv = { GHANTIKA_MAX_CONCURRENT_JOBS: "0", GHANTIKA_MAX_QUEUE_DEPTH: "0" };
  const zeroConfig = loadConcurrencyConfigFromEnv(explicitZeroEnv);
  assert.equal(
    zeroConfig.maxConcurrentJobs,
    0,
    'an EXPLICIT "0" env var must be honored, never conflated with blank'
  );
  assert.equal(zeroConfig.maxQueueDepth, 0);
});

// ---------------------------------------------------------------------------
// Overflow: fail-fast rejection, including the cap=0 and max-queue-depth=0
// boundaries
// ---------------------------------------------------------------------------

test("run() rejects fail-fast, without blocking, once the concurrency cap and queue are both full - including the cap=0 and max-queue-depth=0 boundaries", async () => {
  // A store with no explicit config uses the environment-sourced
  // default, which must itself be >= 1 (never 0) - a freshly-started
  // server can run something out of the box.
  {
    const store = new JobStore();
    assert.deepEqual(store.requestSlot(), { kind: "admit" });
  }

  // The general overflow case with a normal (>= 1) cap and some real
  // queue depth: admits up to the cap, queues up to the depth, rejects
  // beyond that. `requestSlot()` alone only ever DECIDES - the queue's
  // own length (what the NEXT decision actually sees) only changes once
  // the caller follows up with `enqueueJob`, exactly as the real
  // `run()` handler does - see `JobStore.requestSlot`'s own docs.
  {
    const store = new JobStore({ maxConcurrentJobs: 1, maxQueueDepth: 1 });
    assert.deepEqual(store.requestSlot(), { kind: "admit" });
    const queuedJob = store.createJob({ argv: ["b"], cwd: "/tmp", env: {}, isShell: false });
    assert.deepEqual(store.requestSlot(), { kind: "queue" });
    store.enqueueJob(queuedJob.job_id, () => {});
    const rejected = store.requestSlot();
    assert.equal(rejected.kind, "reject");
    assert.equal((rejected as { reason: string }).reason, "queue-full");
  }

  // Boundary: cap = 0 rejects EVERY job outright, even with a real
  // queue depth configured - "no capacity at all" is permanent, never a
  // transient "queue it and wait forever."
  {
    const store = new JobStore({ maxConcurrentJobs: 0, maxQueueDepth: 5 });
    const rejected = store.requestSlot();
    assert.equal(rejected.kind, "reject");
    assert.equal((rejected as { reason: string }).reason, "no-capacity");
    assert.equal(store.getQueueLength(), 0, "cap=0 must never queue anything, ever");
  }

  // Boundary: max-queue-depth = 0 means no queue at all - a second
  // concurrent arrival, while the cap's one slot is held, is rejected
  // immediately, never queued.
  {
    const store = new JobStore({ maxConcurrentJobs: 1, maxQueueDepth: 0 });
    assert.deepEqual(store.requestSlot(), { kind: "admit" });
    const rejected = store.requestSlot();
    assert.equal(rejected.kind, "reject");
    assert.equal((rejected as { reason: string }).reason, "queue-full");
    assert.equal(store.getQueueLength(), 0);
  }

  // The real run() tool, wired to the shared singleton: cap=1,
  // max-queue-depth=0.
  jobStore.setConcurrencyConfig({ maxConcurrentJobs: 1, maxQueueDepth: 0 });
  let firstJobId: string | undefined;
  try {
    const beforeFirst = Date.now();
    const first = runTool.handler({
      command: ["sleep", "30"],
      label: "concurrency-overflow-first-job",
    });
    const firstElapsed = Date.now() - beforeFirst;
    assert.notEqual(first.isError, true);
    const firstStructured = structured(first);
    firstJobId = firstStructured.job_id as string;
    assert.ok(["starting", "running"].includes(firstStructured.state as string));
    assert.ok(firstElapsed < 1000, `run() must return instantly, took ${firstElapsed}ms`);

    const beforeSecond = Date.now();
    const second = runTool.handler({
      command: ["sleep", "30"],
      label: "concurrency-overflow-second-job",
    });
    const secondElapsed = Date.now() - beforeSecond;
    assert.equal(
      second.isError,
      true,
      "cap full + max-queue-depth 0 must reject fail-fast, never queue or block"
    );
    assert.equal(structured(second).reason, "queue-full");
    assert.equal(structured(second).job_id, undefined, "a rejected run() must never create a job");
    assert.ok(
      secondElapsed < 1000,
      `a rejected run() must also return instantly, took ${secondElapsed}ms`
    );

    const jobs = structured(listTool.handler()).jobs as Array<Record<string, unknown>>;
    assert.equal(
      jobs.some((j) => j.label === "concurrency-overflow-second-job"),
      false,
      "a rejected run() must never appear in list()'s output"
    );
  } finally {
    await cleanUpSharedJobs(firstJobId ? [firstJobId] : []);
  }
});

// ---------------------------------------------------------------------------
// FIFO admission order, and a post-dequeue spawn failure
// ---------------------------------------------------------------------------

test("FIFO admission with insertion-sequence tie-break; a dequeue spawn failure settles the dequeued job to failed and frees its slot without leaking", async () => {
  const store = new JobStore({ maxConcurrentJobs: 1, maxQueueDepth: 3 });
  const dequeueOrder: string[] = [];

  const a = store.createJob({ argv: ["a"], cwd: "/tmp", env: {}, isShell: false, label: "a" });
  assert.deepEqual(store.requestSlot(), { kind: "admit" });
  dequeueOrder.push("a"); // admitted immediately

  const b = store.createJob({ argv: ["b"], cwd: "/tmp", env: {}, isShell: false, label: "b" });
  assert.deepEqual(store.requestSlot(), { kind: "queue" });
  store.enqueueJob(b.job_id, () => dequeueOrder.push("b"));
  assert.equal(store.get(b.job_id)!.queue_position, 1);

  const c = store.createJob({ argv: ["c"], cwd: "/tmp", env: {}, isShell: false, label: "c" });
  assert.deepEqual(store.requestSlot(), { kind: "queue" });
  store.enqueueJob(c.job_id, () => dequeueOrder.push("c"));
  assert.equal(store.get(c.job_id)!.queue_position, 2);

  const d = store.createJob({ argv: ["d"], cwd: "/tmp", env: {}, isShell: false, label: "d" });
  assert.deepEqual(store.requestSlot(), { kind: "queue" });
  store.enqueueJob(d.job_id, () => dequeueOrder.push("d"));
  assert.equal(store.get(d.job_id)!.queue_position, 3);

  // The queue is full now (depth 3) - a fifth arrival is rejected.
  const rejectedFifth = store.requestSlot();
  assert.equal(rejectedFifth.kind, "reject");
  assert.equal((rejectedFifth as { reason: string }).reason, "queue-full");

  // a releases its slot - FIFO says b (the FIRST job enqueued) must be
  // the one admitted next, never c or d despite all three sharing the
  // identical "queued" outcome at enqueue time.
  await store.releaseSlot(a.job_id);
  assert.deepEqual(dequeueOrder, ["a", "b"]);
  assert.equal(store.get(b.job_id)!.queue_position, undefined, "b is no longer queued");
  assert.equal(store.get(c.job_id)!.queue_position, 1, "c moved up to position 1");
  assert.equal(store.get(d.job_id)!.queue_position, 2, "d moved up to position 2");
  assert.equal(store.getActiveSlotCount(), 1);

  // b now fails to actually spawn (a genuine post-dequeue spawn
  // failure, never a policy rejection) - it must settle to failed, and
  // its slot must free WITHOUT leaking: c (next in FIFO order) must be
  // the one admitted, never left stranded behind a slot b never
  // actually released.
  store.markSpawnFailed(b.job_id, "synthetic dequeue spawn failure");
  assert.equal(store.get(b.job_id)!.state, "failed");
  assert.deepEqual(store.get(b.job_id)!.diagnostic, {
    reason: "spawn-error",
    message: "synthetic dequeue spawn failure",
  });
  await store.releaseSlot(b.job_id); // no reap promise - a spawn failure never attaches a real child
  assert.deepEqual(dequeueOrder, ["a", "b", "c"]);
  assert.equal(store.get(c.job_id)!.queue_position, undefined);
  assert.equal(store.get(d.job_id)!.queue_position, 1);
  assert.equal(store.getActiveSlotCount(), 1, "the slot did not leak - c now holds it");

  // Drain the rest for a clean finish: releasing c's slot hands the
  // last spot to d, exactly as FIFO order predicts.
  await store.releaseSlot(c.job_id);
  assert.deepEqual(dequeueOrder, ["a", "b", "c", "d"]);
  assert.equal(store.getQueueLength(), 0);
  assert.equal(store.getActiveSlotCount(), 1);
});

// ---------------------------------------------------------------------------
// Exactly-once slot release tied to the awaited reap, and shutdown drain
// ---------------------------------------------------------------------------

test("a slot releases only after the finishing job's reap has been awaited to completion (a slow reap never releases early); shutdown kills queued jobs and drains the queue deterministically", async () => {
  // --- Exactly-once release, tied to the awaited reap ---
  {
    const store = new JobStore({ maxConcurrentJobs: 1, maxQueueDepth: 1 });
    const a = store.createJob({ argv: ["a"], cwd: "/tmp", env: {}, isShell: false });
    assert.deepEqual(store.requestSlot(), { kind: "admit" });
    const b = store.createJob({ argv: ["b"], cwd: "/tmp", env: {}, isShell: false });
    assert.deepEqual(store.requestSlot(), { kind: "queue" });
    let dequeued = false;
    store.enqueueJob(b.job_id, () => {
      dequeued = true;
    });

    let resolveReap: (decision: ReapReleaseDecision) => void = () => {};
    const slowReap = new Promise<ReapReleaseDecision>((resolve) => {
      resolveReap = resolve;
    });

    // Fire-and-forget, exactly like run.ts's own onExit wiring - never
    // awaited by its own caller.
    const releasePromise = store.releaseSlot(a.job_id, slowReap);

    // Give the event loop several real turns - a slow reap that has NOT
    // resolved yet must NOT have released the slot early, however many
    // turns pass.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(dequeued, false, "the slot must not release before its reap resolves");
    assert.equal(store.getActiveSlotCount(), 1, "a's slot must still read as held");
    assert.equal(store.get(b.job_id)!.queue_position, 1, "b must still be queued");

    // Now let the reap actually finish, CONFIRMED - the release must
    // complete exactly then.
    resolveReap("confirmed");
    await releasePromise;
    assert.equal(dequeued, true, "the slot must release once its reap has genuinely resolved");
    assert.equal(store.get(b.job_id)!.queue_position, undefined);
    assert.equal(store.getActiveSlotCount(), 1, "b now holds the one and only slot");
  }

  // --- Shutdown kills queued jobs and drains the queue deterministically ---
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const instance = createServer(serverTransport);
  await instance.server.connect(instance.transport);
  const client = new Client({ name: "ghantika-concurrency-shutdown-test", version: "0.0.0" });
  await client.connect(clientTransport);

  jobStore.setConcurrencyConfig({ maxConcurrentJobs: 1, maxQueueDepth: 2 });
  // Hoisted above the try - the finally block below needs it too, to clean
  // up the concurrency slot shutdown's own live-job reap never releases
  // (see that block's own docs).
  let runningJobId: string | undefined;
  try {
    const running = (await client.callTool({
      name: "run",
      arguments: { command: ["sleep", "30"], label: "concurrency-shutdown-running-job" },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    assert.notEqual(running.isError, true);
    runningJobId = running.structuredContent?.job_id as string;
    assert.ok(["starting", "running"].includes(running.structuredContent?.state as string));

    const queued = (await client.callTool({
      name: "run",
      arguments: { command: ["sleep", "30"], label: "concurrency-shutdown-queued-job" },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    assert.notEqual(queued.isError, true);
    const queuedJobId = queued.structuredContent?.job_id as string;
    assert.equal(queued.structuredContent?.state, "starting");
    assert.equal(queued.structuredContent?.queue_position, 1);
    assert.equal(jobStore.getQueueLength(), 1);

    await client.close();
    await instance.shutdown("test cleanup - concurrency queue drain");

    const queuedAfterShutdown = jobStore.get(queuedJobId)!;
    assert.equal(
      queuedAfterShutdown.state,
      "killed",
      "a still-queued job must be killed on shutdown, never left in starting forever"
    );
    assert.equal(queuedAfterShutdown.queue_position, undefined);
    assert.equal(jobStore.getQueueLength(), 0, "the queue must be fully drained after shutdown");
    // Tool-visible, not just the internal record above: the same public
    // projection a real status() call returns must also show
    // kill_confirmed:true for a job the shutdown drain never spawned - the
    // MCP client transport is already closed at this point, but
    // statusTool.handler is the exact same handler wired to the live
    // "status" tool, called directly rather than over that transport.
    const queuedStatusAfterShutdown = structured(statusTool.handler({ job_id: queuedJobId }));
    assert.equal(
      queuedStatusAfterShutdown.kill_confirmed,
      true,
      "status() on a job drained at shutdown must report kill_confirmed:true, not leave it unset"
    );
    assert.notEqual(
      jobStore.get(runningJobId),
      undefined,
      "the running job's own record is untouched by the queue drain"
    );

    // A second drain is a genuine no-op - deterministic, idempotent.
    jobStore.drainQueueOnShutdown();
    assert.equal(jobStore.getQueueLength(), 0);
  } finally {
    // src/server.ts's real shutdown reap kills a still-LIVE job's real
    // process and marks its record terminal, but - unlike an ordinary
    // kill() call - never releases its concurrency SLOT (a real
    // production server always exits its whole process right after
    // shutdown, so a leaked activeSlots count in a process about to die
    // has no real consequence there; it only matters here, on the
    // shared jobStore singleton every later test in this file reuses).
    // A follow-up kill() call against the now-terminal record is the
    // correct cleanup - src/tools/kill.ts's own late-recovery branch
    // (kill.ts's own docs) sees the shutdown reap's already-attempted,
    // already-confirmed outcome and calls releaseSlot for exactly this
    // case, the same path a caller retrying kill() after a genuine
    // stranding would take. Guarded on runningJobId actually having been
    // assigned - the try block above could in principle throw before
    // reaching that assignment.
    if (runningJobId !== undefined) {
      await killTool.handler({ job_id: runningJobId });
      await waitUntil(() => jobStore.getActiveSlotCount() === 0);
    }

    // The real shutdown() call above closed the shared jobStore
    // singleton's admission gate for good (JobStore.beginShutdown is
    // permanent by design). Reopen it directly so the LATER tests in
    // this file - which never construct a fresh createServer() of their
    // own, the one place that gate is otherwise reset - can still
    // exercise requestSlot() normally.
    jobStore.clearShutdownGate();
    jobStore.drainQueueOnShutdown();
  }
});

// ---------------------------------------------------------------------------
// Honest-cap fail-closed release: an unconfirmed or errored reap decision
// must NOT free the slot or advance the queue - regressions for BOTH paths
// (this repo's own previous bug: releaseSlot decremented and dequeued
// regardless of what the reap actually found, so a survivor-carrying group
// could push real concurrency past the configured cap)
// ---------------------------------------------------------------------------

test("releaseSlot fails CLOSED on an unconfirmed reap decision: the slot stays held, the queue does NOT advance, and the job is tracked as stranded rather than silently forgotten", async () => {
  const store = new JobStore({ maxConcurrentJobs: 1, maxQueueDepth: 1 });
  const a = store.createJob({ argv: ["a"], cwd: "/tmp", env: {}, isShell: false, label: "a" });
  assert.deepEqual(store.requestSlot(), { kind: "admit" });
  const b = store.createJob({ argv: ["b"], cwd: "/tmp", env: {}, isShell: false, label: "b" });
  assert.deepEqual(store.requestSlot(), { kind: "queue" });
  let dequeued = false;
  store.enqueueJob(b.job_id, () => {
    dequeued = true;
  });

  // The exact shape a genuinely-unconfirmed reap produces once mapped
  // through reapOutcomeToReleaseDecision: reapProcessGroupOnce resolves
  // normally with kill_confirmed=false, and a fail-open release path
  // would decrement and dequeue regardless.
  await store.releaseSlot(a.job_id, Promise.resolve("unconfirmed"));

  assert.equal(
    dequeued,
    false,
    "an unconfirmed reap must never hand a's slot to the next queued job - a real survivor may still hold it"
  );
  assert.equal(
    store.getActiveSlotCount(),
    1,
    "activeSlots must still count a's slot as held - this is the whole point of fail-closed"
  );
  assert.equal(store.get(b.job_id)!.queue_position, 1, "b must still be queued, not admitted");
  assert.equal(
    store.getStrandedSlotCount(),
    1,
    "the unconfirmed release must be tracked as a disclosed stranded slot, not silently dropped"
  );
});

test("releaseSlot fails CLOSED on an errored reap decision, identically to an unconfirmed one - a thrown reap must never be silently treated as safe-to-release", async () => {
  const store = new JobStore({ maxConcurrentJobs: 1, maxQueueDepth: 1 });
  const a = store.createJob({ argv: ["a"], cwd: "/tmp", env: {}, isShell: false, label: "a" });
  assert.deepEqual(store.requestSlot(), { kind: "admit" });
  const b = store.createJob({ argv: ["b"], cwd: "/tmp", env: {}, isShell: false, label: "b" });
  assert.deepEqual(store.requestSlot(), { kind: "queue" });
  let dequeued = false;
  store.enqueueJob(b.job_id, () => {
    dequeued = true;
  });

  // The exact shape src/tools/run.ts's own onExit wiring produces for a
  // real signal-send failure: the raw reapProcessGroupOnce rejection is
  // caught and mapped to the explicit "errored" decision, which the OLD
  // code silently treated as safe.
  await store.releaseSlot(a.job_id, Promise.resolve("errored"));

  assert.equal(dequeued, false, "an errored reap must never hand a's slot to the next queued job");
  assert.equal(
    store.getActiveSlotCount(),
    1,
    "activeSlots must still count a's slot as held after an errored reap"
  );
  assert.equal(store.get(b.job_id)!.queue_position, 1, "b must still be queued, not admitted");
  assert.equal(
    store.getStrandedSlotCount(),
    1,
    "an errored release must be tracked as a disclosed stranded slot, exactly like an unconfirmed one"
  );
});

test("a stranded slot recovers once a LATER release for the same job actually confirms - the automatic retry's own commit path, exercised directly", async () => {
  const store = new JobStore({ maxConcurrentJobs: 1, maxQueueDepth: 1 });
  const a = store.createJob({ argv: ["a"], cwd: "/tmp", env: {}, isShell: false, label: "a" });
  assert.deepEqual(store.requestSlot(), { kind: "admit" });
  const b = store.createJob({ argv: ["b"], cwd: "/tmp", env: {}, isShell: false, label: "b" });
  assert.deepEqual(store.requestSlot(), { kind: "queue" });
  let dequeued = false;
  store.enqueueJob(b.job_id, () => {
    dequeued = true;
  });

  await store.releaseSlot(a.job_id, Promise.resolve("unconfirmed"));
  assert.equal(store.getStrandedSlotCount(), 1, "stranded after the first, unconfirmed attempt");
  assert.equal(dequeued, false);

  // A second release for the SAME job, now confirmed - the exact shape
  // both the automatic retry (retryStrandedSlot) and a manual kill()
  // late-recovery call produce once their own fresh reap succeeds.
  await store.releaseSlot(a.job_id, Promise.resolve("confirmed"));

  assert.equal(
    dequeued,
    true,
    "a confirmed second release must actually free the slot and hand it to the next queued job"
  );
  assert.equal(store.getActiveSlotCount(), 1, "b now holds the one and only slot");
  assert.equal(
    store.getStrandedSlotCount(),
    0,
    "recovering the slot must clear its stranded-tracking entry, not leave a stale one behind"
  );
});

// ---------------------------------------------------------------------------
// cap-zero retune: raising the cap back up must proactively drain the
// queue, not leave it waiting on an unrelated job's own release to notice
// (this repo's own previous bug: active=1 + queued=1, lower cap to 0,
// release active, restore cap to 1 - the queued job waited forever)
// ---------------------------------------------------------------------------

test("lowering the cap to zero then raising it back up proactively drains the queue - a queued job is admitted the moment room exists again, without waiting on an unrelated release", async () => {
  const store = new JobStore({ maxConcurrentJobs: 1, maxQueueDepth: 1 });
  const a = store.createJob({ argv: ["a"], cwd: "/tmp", env: {}, isShell: false, label: "a" });
  assert.deepEqual(store.requestSlot(), { kind: "admit" });
  const b = store.createJob({ argv: ["b"], cwd: "/tmp", env: {}, isShell: false, label: "b" });
  assert.deepEqual(store.requestSlot(), { kind: "queue" });
  let dequeued = false;
  store.enqueueJob(b.job_id, () => {
    dequeued = true;
  });
  assert.equal(store.get(b.job_id)!.queue_position, 1);

  // Lower the cap to zero, then release a: with active=1 and queued=1,
  // lowering the cap to zero and releasing the active job must never
  // silently admit the queued one - there is no room for anyone while
  // the cap sits at zero.
  store.setConcurrencyConfig({ maxConcurrentJobs: 0, maxQueueDepth: 1 });
  await store.releaseSlot(a.job_id);
  assert.equal(
    dequeued,
    false,
    "with the cap at zero, releasing a must not admit b - there is no room for anyone"
  );
  assert.equal(store.getActiveSlotCount(), 0);
  assert.equal(
    store.get(b.job_id)!.queue_position,
    1,
    "b must still be queued while the cap sits at zero"
  );

  // Restore the cap - WITHOUT any further release ever happening for any
  // job. Before this fix, nothing would ever re-evaluate the queue again:
  // dequeueNext only ever ran from inside releaseSlot.
  store.setConcurrencyConfig({ maxConcurrentJobs: 1, maxQueueDepth: 1 });

  assert.equal(
    dequeued,
    true,
    "raising the cap back up must itself admit the waiting queued job, with no release involved at all"
  );
  assert.equal(store.getActiveSlotCount(), 1, "b now holds the restored slot");
  assert.equal(store.get(b.job_id)!.queue_position, undefined, "b is no longer queued");
  assert.equal(store.getQueueLength(), 0);
});

test("raising the cap by more than one step admits every now-eligible queued job in FIFO order, not just the first", async () => {
  // maxConcurrentJobs stays NONZERO throughout this test - a zero cap is
  // its own permanent, always-reject case (src/scheduler.ts's own
  // decideAdmission docs: "no capacity exists, ever"), which never
  // reaches the queue at all and would exercise the wrong code path for
  // what this test is actually about (a real reconfiguration draining a
  // queue that built up while the cap was merely FULL, never zero).
  const store = new JobStore({ maxConcurrentJobs: 1, maxQueueDepth: 3 });
  const dequeueOrder: string[] = [];

  store.createJob({ argv: ["a"], cwd: "/tmp", env: {}, isShell: false, label: "a" });
  assert.deepEqual(store.requestSlot(), { kind: "admit" });
  assert.equal(store.getActiveSlotCount(), 1);

  // Three MORE jobs arrive while the cap is already fully held by `a` -
  // each queues in turn, with no release happening in between.
  const queuedJobs = ["b", "c", "d"].map((label) =>
    store.createJob({ argv: [label], cwd: "/tmp", env: {}, isShell: false, label })
  );
  for (const job of queuedJobs) {
    assert.deepEqual(store.requestSlot(), { kind: "queue" });
    store.enqueueJob(job.job_id, () => dequeueOrder.push(job.job_id));
  }
  assert.equal(store.getQueueLength(), 3);
  assert.equal(dequeueOrder.length, 0, "nothing may be admitted while the cap stays at 1");

  // Raise the cap directly from 1 to 4 in ONE step, with `a` still
  // active and NO release ever having happened - room now exists for
  // all three queued jobs at once (4 - 1 = 3). All three must be
  // admitted together, in their original FIFO order, not just the first
  // one a single dequeueNext call would have handled.
  store.setConcurrencyConfig({ maxConcurrentJobs: 4, maxQueueDepth: 3 });

  assert.deepEqual(
    dequeueOrder,
    queuedJobs.map((job) => job.job_id),
    "all three now-eligible queued jobs must drain together, in FIFO order, from one reconfiguration"
  );
  assert.equal(store.getActiveSlotCount(), 4, "a plus all three newly-admitted jobs");
  assert.equal(store.getQueueLength(), 0);
});

// ---------------------------------------------------------------------------
// deleteJob reclaims strandedSlots too, mirroring its existing
// slotReleased-reclamation discipline
// ---------------------------------------------------------------------------

test("deleteJob reclaims a stranded job's strandedSlots entry as part of its own generic one-way reclamation contract - a caller-driven deletion (an explicit operator action, say), NEVER the lazy TTL purge, which now refuses a still-stranded job before ever reaching deleteJob (see tasksAdapter's own isExpiredTerminalRecord/isJobSlotStranded test)", async () => {
  const store = new JobStore({ maxConcurrentJobs: 1, maxQueueDepth: 0 });
  const a = store.createJob({ argv: ["a"], cwd: "/tmp", env: {}, isShell: false, label: "a" });
  assert.deepEqual(store.requestSlot(), { kind: "admit" });

  await store.releaseSlot(a.job_id, Promise.resolve("unconfirmed"));
  assert.equal(store.getStrandedSlotCount(), 1);

  const existed = store.deleteJob(a.job_id);
  assert.equal(existed, true);
  assert.equal(
    store.getStrandedSlotCount(),
    0,
    "deleteJob must reclaim the strandedSlots entry, not just the job record itself"
  );
});

// ---------------------------------------------------------------------------
// queue_position stays a field on a closed job-state enum; non-blocking in
// all three outcomes; observable via status and list
// ---------------------------------------------------------------------------

test("queue_position is a field on the existing starting state (never a new enum state) on a job-state enum that stays closed at five values; run() returns instantly whether it admits immediately, queues, or rejects; queue_position is observable via status and list, the current cap via list", async () => {
  assert.equal(ALL_JOB_STATES.length, 5, "queueing must never introduce a sixth job state");
  assert.deepEqual(
    [...ALL_JOB_STATES].sort(),
    ["exited", "failed", "killed", "running", "starting"].sort()
  );

  jobStore.setConcurrencyConfig({ maxConcurrentJobs: 1, maxQueueDepth: 1 });
  let firstJobId: string | undefined;
  try {
    // Case 1: admits immediately.
    const beforeFirst = Date.now();
    const first = runTool.handler({
      command: ["sleep", "30"],
      label: "concurrency-cases-first-job",
    });
    const firstElapsed = Date.now() - beforeFirst;
    assert.notEqual(first.isError, true);
    const firstStructured = structured(first);
    firstJobId = firstStructured.job_id as string;
    assert.ok(["starting", "running"].includes(firstStructured.state as string));
    assert.equal(
      firstStructured.queue_position,
      undefined,
      "an immediately-admitted job is never queued"
    );
    assert.ok(
      firstElapsed < 1000,
      `immediate admission must return instantly, took ${firstElapsed}ms`
    );

    // Case 2: queues (cap is full, queue depth allows it).
    const beforeQueued = Date.now();
    const queued = runTool.handler({
      command: ["sleep", "30"],
      label: "concurrency-cases-queued-job",
    });
    const queuedElapsed = Date.now() - beforeQueued;
    assert.notEqual(queued.isError, true);
    const queuedStructured = structured(queued);
    const queuedJobId = queuedStructured.job_id as string;
    assert.equal(
      queuedStructured.state,
      "starting",
      "a queued job reports the EXISTING starting state - never a new enum value"
    );
    assert.equal(queuedStructured.queue_position, 1);
    assert.ok(queuedElapsed < 1000, `queueing must return instantly, took ${queuedElapsed}ms`);

    // Case 3: rejects (cap and queue are both now full).
    const beforeRejected = Date.now();
    const rejected = runTool.handler({
      command: ["true"],
      label: "concurrency-cases-rejected-job",
    });
    const rejectedElapsed = Date.now() - beforeRejected;
    assert.equal(rejected.isError, true);
    assert.ok(rejectedElapsed < 1000, `rejection must return instantly, took ${rejectedElapsed}ms`);

    // Observable via status().
    const statusStructured = structured(statusTool.handler({ job_id: queuedJobId }));
    assert.equal(statusStructured.queue_position, 1);
    assert.equal(statusStructured.state, "starting");

    // Observable via list(): both the per-job queue_position and the
    // server-wide concurrency cap.
    const listStructured = structured(listTool.handler());
    assert.equal(listStructured.concurrency_cap, 1);
    const jobs = listStructured.jobs as Array<Record<string, unknown>>;
    const listedQueued = jobs.find((j) => j.job_id === queuedJobId);
    assert.ok(listedQueued, "the queued job must appear in list()'s output");
    assert.equal(listedQueued?.queue_position, 1);
    const listedFirst = jobs.find((j) => j.job_id === firstJobId);
    assert.ok(listedFirst, "the running job must appear in list()'s output");
    assert.equal(listedFirst?.queue_position, undefined);
  } finally {
    await cleanUpSharedJobs(firstJobId ? [firstJobId] : []);
  }
});

// ---------------------------------------------------------------------------
// kill() on a still-queued job
// ---------------------------------------------------------------------------

test("kill() on a still-queued job dequeues it, renumbers the survivors, settles it to killed, and it never actually spawns once its would-be slot frees", async () => {
  jobStore.setConcurrencyConfig({ maxConcurrentJobs: 1, maxQueueDepth: 2 });
  let activeJobId: string | undefined;
  let firstQueuedId: string | undefined;
  let secondQueuedId: string | undefined;
  try {
    const active = runTool.handler({ command: ["sleep", "30"], label: "kill-queued-active" });
    assert.notEqual(active.isError, true);
    activeJobId = structured(active).job_id as string;

    const first = runTool.handler({ command: ["sleep", "30"], label: "kill-queued-first" });
    assert.notEqual(first.isError, true);
    firstQueuedId = structured(first).job_id as string;
    assert.equal(structured(first).queue_position, 1);

    const second = runTool.handler({ command: ["sleep", "30"], label: "kill-queued-second" });
    assert.notEqual(second.isError, true);
    secondQueuedId = structured(second).job_id as string;
    assert.equal(structured(second).queue_position, 2);

    // Kill the FIRST queued job while it is still queued - this used to
    // report "internal inconsistency" and leave it stranded in the
    // queue.
    const killResult = await killTool.handler({ job_id: firstQueuedId });
    assert.notEqual(
      killResult.isError,
      true,
      `kill() on a queued job must succeed, not report an internal inconsistency: ${JSON.stringify(killResult)}`
    );
    // A job cancelled while still queued never spawned a process group, so
    // there is nothing left to confirm - the invariant settles it true on
    // kill()'s own synchronous return, exactly as it does for every other
    // never-spawned case (see jobStore.ts's own `kill_confirmed` field
    // doc). This test's own outcome is the counterexample to reading
    // `kill_confirmed: true` as "a signal reached and terminated the
    // group": no signal was ever sent here, since there was never a
    // process to send one to.
    assert.equal(
      structured(killResult).kill_confirmed,
      true,
      "a job killed while still queued must report kill_confirmed:true on kill()'s own return, not leave it unset"
    );

    // It is removed from the queue, not merely marked terminal in place.
    assert.equal(jobStore.getQueueLength(), 1);
    const statusAfterKill = structured(statusTool.handler({ job_id: firstQueuedId }));
    assert.equal(statusAfterKill.state, "killed");
    assert.equal(statusAfterKill.queue_position, undefined);
    assert.equal(
      statusAfterKill.kill_confirmed,
      true,
      "status() on the same job afterward must keep reporting kill_confirmed:true, not just kill()'s own return"
    );

    // The survivor renumbers up from position 2 to position 1.
    const survivorStatus = structured(statusTool.handler({ job_id: secondQueuedId }));
    assert.equal(
      survivorStatus.queue_position,
      1,
      "the remaining queued job must renumber up after the removal"
    );

    const listedJobs = structured(listTool.handler()).jobs as Array<Record<string, unknown>>;
    const listedKilled = listedJobs.find((j) => j.job_id === firstQueuedId);
    assert.equal(listedKilled?.state, "killed");
    assert.equal(listedKilled?.queue_position, undefined);

    // Free the active slot - the survivor, never the killed job, must
    // be the one that actually gets a turn.
    const killActive = await killTool.handler({ job_id: activeJobId });
    assert.notEqual(killActive.isError, true);
    await waitUntil(() => jobStore.getChildHandle(secondQueuedId!) !== undefined);
    assert.equal(jobStore.get(secondQueuedId!)!.queue_position, undefined);

    // The job killed while queued never got a turn: no child was ever
    // attached for it, and its state never left `killed`.
    assert.equal(
      jobStore.getChildHandle(firstQueuedId),
      undefined,
      "a job killed while queued must never spawn a real process"
    );
    assert.equal(jobStore.get(firstQueuedId)!.state, "killed");
  } finally {
    await cleanUpSharedJobs(
      [activeJobId, firstQueuedId, secondQueuedId].filter((id): id is string => id !== undefined)
    );
  }
});

// ---------------------------------------------------------------------------
// releaseSlot ownership: a preflight-failed record that never reserved a
// slot must never be able to release another job's reservation
// ---------------------------------------------------------------------------

test("kill() on a preflight-failed record that never held a concurrency slot must never release another job's reservation - covers invalid cwd, missing executable, and policy-denied", async () => {
  jobStore.setConcurrencyConfig({ maxConcurrentJobs: 1, maxQueueDepth: 0 });
  let ownerJobId: string | undefined;
  try {
    const owner = runTool.handler({ command: ["sleep", "30"], label: "unslotted-kill-owner" });
    assert.notEqual(owner.isError, true);
    ownerJobId = structured(owner).job_id as string;
    assert.equal(jobStore.getActiveSlotCount(), 1, "the real owner holds the only slot");

    // "cat" resolves to a real executable but is not on the test policy
    // allow-list (test/fixtures/policy-allow.json), so it is denied AFTER
    // resolution - distinct from the missing-executable case below, which
    // never resolves at all.
    const preflightCases: Array<{ readonly name: string; readonly command: string[] }> = [
      { name: "invalid cwd", command: ["sleep", "1"] },
      {
        name: "missing executable",
        command: ["this-command-definitely-does-not-exist-ghantika-unslotted-kill"],
      },
      { name: "policy-denied", command: ["cat"] },
    ];

    for (const { name, command } of preflightCases) {
      const args: Record<string, unknown> = { command, label: `unslotted-kill-${name}` };
      if (name === "invalid cwd") args.cwd = "/this-dir-does-not-exist-ghantika-unslotted-kill";

      const failed = runTool.handler(args);
      assert.notEqual(
        failed.isError,
        true,
        `${name}: run() itself must still succeed with a terminal failed record`
      );
      const failedStructured = structured(failed);
      assert.equal(
        failedStructured.state,
        "failed",
        `${name}: must be a terminal preflight failure`
      );
      const failedJobId = failedStructured.job_id as string;

      const killResult = await killTool.handler({ job_id: failedJobId });
      assert.notEqual(
        killResult.isError,
        true,
        `${name}: kill on an already-terminal record must be a no-op success`
      );

      assert.equal(
        jobStore.getActiveSlotCount(),
        1,
        `${name}: killing an unslotted preflight-failed record must NOT touch the real owner's reservation`
      );

      // Cap=1, depth=0: a subsequent valid run() must still be REJECTED,
      // never admitted - the exact symptom the P1 produces when the
      // counter is wrongly decremented by an unslotted job's kill.
      const shouldReject = runTool.handler({
        command: ["sleep", "1"],
        label: `unslotted-kill-probe-${name}`,
      });
      assert.equal(
        shouldReject.isError,
        true,
        `${name}: cap must still read full - a second real job must not be admitted`
      );
      assert.equal(structured(shouldReject).reason, "queue-full");
    }

    assert.equal(
      jobStore.getActiveSlotCount(),
      1,
      "the real owner's slot is still the only one ever held, after all three preflight-failure classes"
    );
  } finally {
    await cleanUpSharedJobs(ownerJobId ? [ownerJobId] : []);
    assert.equal(
      jobStore.getActiveSlotCount(),
      0,
      "cleanup released the real owner's slot exactly once"
    );
  }
});

test("double-cancelling a QUEUED (never-dequeued) job must never release a different job's reservation, across both real cancellation surfaces", async () => {
  jobStore.setConcurrencyConfig({ maxConcurrentJobs: 1, maxQueueDepth: 1 });
  let ownerJobId: string | undefined;
  try {
    const owner = runTool.handler({
      command: ["sleep", "30"],
      label: "queued-double-cancel-owner",
    });
    assert.notEqual(owner.isError, true);
    ownerJobId = structured(owner).job_id as string;
    assert.equal(jobStore.getActiveSlotCount(), 1, "the real owner holds the only slot");

    // Both real entry points that can ever cancel a still-queued job -
    // `kill.ts`'s own handler, and `tasksAdapter.cancelTask`, which
    // delegates to that same handler internally (see its own docs) but is
    // still a distinct, real caller worth exercising directly rather than
    // trusting by construction.
    const cancelSurfaces: Array<{
      readonly name: string;
      readonly cancel: (jobId: string) => Promise<{ isError?: boolean } | { error: unknown }>;
    }> = [
      { name: "kill", cancel: (jobId) => killTool.handler({ job_id: jobId }) },
      { name: "tasks/cancel", cancel: (jobId) => tasksAdapter.cancelTask(jobId) },
    ];

    for (const { name, cancel } of cancelSurfaces) {
      const queued = runTool.handler({
        command: ["sleep", "1"],
        label: `queued-double-cancel-${name.replace("/", "-")}`,
      });
      assert.notEqual(
        queued.isError,
        true,
        `${name}: run() itself must still succeed with a queued record`
      );
      const queuedStructured = structured(queued);
      assert.equal(
        queuedStructured.queue_position,
        1,
        `${name}: cap is full - this job must queue, not run`
      );
      const queuedJobId = queuedStructured.job_id as string;

      const first = await cancel(queuedJobId);
      assert.notEqual(
        "isError" in first ? first.isError : undefined,
        true,
        `${name}: cancelling a still-queued job must succeed`
      );
      assert.equal(
        jobStore.getActiveSlotCount(),
        1,
        `${name}: cancelling a QUEUED job must never touch the owner's slot`
      );

      // THE regression: a second cancellation of the SAME now-terminal
      // record reaches the terminal late-recovery path, not the queue
      // path - this is exactly where the old bug decremented a slot this
      // job never held.
      const second = await cancel(queuedJobId);
      assert.notEqual(
        "isError" in second ? second.isError : undefined,
        true,
        `${name}: a second cancellation of the now-terminal record must be a no-op success`
      );
      assert.equal(
        jobStore.getActiveSlotCount(),
        1,
        `${name}: a SECOND cancellation of the same queued-then-cancelled job must still never free the owner's slot`
      );

      // The property a user would feel: with the queue now empty again,
      // a probe job must be QUEUED behind the still-running owner, never
      // admitted as a second live child under a cap of one. Checking
      // `getActiveSlotCount()` immediately after creating it is the
      // direct assertion - an admitted (rather than queued) probe would
      // increment it to 2 right here, on the same synchronous call.
      const probe = runTool.handler({
        command: ["sleep", "1"],
        label: `queued-double-cancel-probe-${name.replace("/", "-")}`,
      });
      assert.notEqual(
        probe.isError,
        true,
        `${name}: the probe must still be accepted (queued), not rejected`
      );
      assert.equal(
        structured(probe).queue_position,
        1,
        `${name}: the probe must be QUEUED behind the owner, never admitted directly - a cap-of-one breach reads as an immediate admission here`
      );
      assert.equal(
        jobStore.getActiveSlotCount(),
        1,
        `${name}: creating the probe must not itself increment activeSlots - the owner's slot is still the only one held`
      );

      // Clear the probe out of the queue before the next surface's own
      // pass reuses the one queue slot.
      const probeCancelled = await killTool.handler({ job_id: structured(probe).job_id as string });
      assert.notEqual(probeCancelled.isError, true);
    }

    assert.equal(
      jobStore.getActiveSlotCount(),
      1,
      "the real owner's slot is still the only one ever held, after both cancellation surfaces' double-cancel"
    );
  } finally {
    await cleanUpSharedJobs(ownerJobId ? [ownerJobId] : []);
    assert.equal(
      jobStore.getActiveSlotCount(),
      0,
      "cleanup released the real owner's slot exactly once"
    );
  }
});

// ---------------------------------------------------------------------------
// releaseSlot idempotency
// ---------------------------------------------------------------------------

test("releaseSlot is idempotent per job: a duplicate release for the same finishing job never advances the queue a second time or over-admits", async () => {
  const store = new JobStore({ maxConcurrentJobs: 1, maxQueueDepth: 2 });
  const dequeueOrder: string[] = [];

  const a = store.createJob({ argv: ["a"], cwd: "/tmp", env: {}, isShell: false, label: "a" });
  assert.deepEqual(store.requestSlot(), { kind: "admit" });

  const b = store.createJob({ argv: ["b"], cwd: "/tmp", env: {}, isShell: false, label: "b" });
  assert.deepEqual(store.requestSlot(), { kind: "queue" });
  store.enqueueJob(b.job_id, () => dequeueOrder.push("b"));

  const c = store.createJob({ argv: ["c"], cwd: "/tmp", env: {}, isShell: false, label: "c" });
  assert.deepEqual(store.requestSlot(), { kind: "queue" });
  store.enqueueJob(c.job_id, () => dequeueOrder.push("c"));

  // Release a's slot TWICE for the same job id - a bug elsewhere, a
  // retry, or a genuine race could produce this; the second call must
  // be a pure no-op, never a second real release.
  await store.releaseSlot(a.job_id);
  await store.releaseSlot(a.job_id);

  assert.deepEqual(dequeueOrder, ["b"], "only ONE queued job may be admitted for one freed slot");
  assert.equal(
    store.getActiveSlotCount(),
    1,
    "the active count must reflect exactly one held slot, not two"
  );
  assert.equal(
    store.getQueueLength(),
    1,
    "the queue must advance exactly once, leaving c still queued"
  );
  assert.equal(
    store.get(c.job_id)!.queue_position,
    1,
    "c's own queued position must be unaffected by the duplicate release"
  );
});

// ---------------------------------------------------------------------------
// Lowering the cap while jobs are active/queued must not over-admit
// ---------------------------------------------------------------------------

test("lowering the concurrency cap below the currently-active count means a freed slot does NOT immediately admit the next queued job, until enough active jobs have also finished to bring activeSlots back under the new, lower cap", async () => {
  const store = new JobStore({ maxConcurrentJobs: 2, maxQueueDepth: 2 });
  const dequeueOrder: string[] = [];

  const a = store.createJob({ argv: ["a"], cwd: "/tmp", env: {}, isShell: false, label: "a" });
  assert.deepEqual(store.requestSlot(), { kind: "admit" });

  const b = store.createJob({ argv: ["b"], cwd: "/tmp", env: {}, isShell: false, label: "b" });
  assert.deepEqual(store.requestSlot(), { kind: "admit" });
  assert.equal(store.getActiveSlotCount(), 2, "both a and b hold a slot under the original cap=2");

  const c = store.createJob({ argv: ["c"], cwd: "/tmp", env: {}, isShell: false, label: "c" });
  assert.deepEqual(store.requestSlot(), { kind: "queue" });
  store.enqueueJob(c.job_id, () => dequeueOrder.push("c"));
  assert.equal(store.getQueueLength(), 1);

  // Lower the cap to 1 while a and b are both still active - per
  // setConcurrencyConfig's own documented contract, nothing already
  // running is touched, but no NEW slot may open until enough active
  // jobs finish to bring activeSlots back under 1.
  store.setConcurrencyConfig({ maxConcurrentJobs: 1, maxQueueDepth: 2 });
  assert.equal(store.getConcurrencyCap(), 1);

  // Release a's slot. Post-release, activeSlots is 1 (b is still
  // running) - already AT the new, lower cap of 1 - so c must NOT be
  // admitted: the queue must be left entirely untouched.
  await store.releaseSlot(a.job_id);
  assert.equal(
    store.getActiveSlotCount(),
    1,
    "activeSlots must stay at 1 (b's slot) - releasing a must not hand c a slot the lowered cap does not allow"
  );
  assert.equal(store.getQueueLength(), 1, "c must remain queued, not dequeued");
  assert.deepEqual(dequeueOrder, [], "c's onDequeued must not have fired yet");
  assert.equal(store.get(c.job_id)!.queue_position, 1, "c's queue position must be unaffected");

  // Now release b's slot too. activeSlots drops to 0, which IS under the
  // now-lower cap of 1 - c is finally admitted.
  await store.releaseSlot(b.job_id);
  assert.equal(
    store.getActiveSlotCount(),
    1,
    "c is now admitted, bringing activeSlots back up to (but not over) the cap of 1"
  );
  assert.equal(store.getQueueLength(), 0, "c is no longer queued");
  assert.deepEqual(dequeueOrder, ["c"]);
});

// ---------------------------------------------------------------------------
// deleteJob reclaims the slotReleased dedupe entry (no unbounded growth)
// ---------------------------------------------------------------------------

test("deleteJob reclaims a job's slotReleased dedupe entry, so a long-running server's repeated create/release/delete cycles never leak memory in that set - while a duplicate release BEFORE delete is still correctly a no-op", async () => {
  const store = new JobStore({ maxConcurrentJobs: 1, maxQueueDepth: 1 });

  // --- Duplicate release BEFORE delete must still be idempotent ---
  {
    const job = store.createJob({ argv: ["dup"], cwd: "/tmp", env: {}, isShell: false });
    assert.deepEqual(store.requestSlot(), { kind: "admit" });
    assert.equal(
      store.getSlotReleasedCount(),
      0,
      "no slotReleased entry exists before any release"
    );

    await store.releaseSlot(job.job_id);
    assert.equal(store.getSlotReleasedCount(), 1, "releaseSlot recorded exactly one dedupe entry");
    assert.equal(store.getActiveSlotCount(), 0);

    // A second release for the SAME still-existing job must remain a
    // pure no-op (the existing idempotency guarantee), unaffected by
    // this fix - only deleteJob removes the entry, never a duplicate
    // release.
    await store.releaseSlot(job.job_id);
    assert.equal(
      store.getSlotReleasedCount(),
      1,
      "a duplicate release before delete must not add a second entry or remove the existing one"
    );
    assert.equal(store.getActiveSlotCount(), 0, "duplicate release must not decrement again");

    store.deleteJob(job.job_id);
    assert.equal(store.has(job.job_id), false, "the job record itself is gone");
    assert.equal(
      store.getSlotReleasedCount(),
      0,
      "deleteJob must reclaim the slotReleased entry, leaving none behind"
    );
  }

  // --- Repeated create/admit/release/delete cycles never accumulate a
  // lingering slotReleased entry - the actual leak-proof regression ---
  for (let i = 0; i < 5; i++) {
    const job = store.createJob({
      argv: ["cycle", String(i)],
      cwd: "/tmp",
      env: {},
      isShell: false,
    });
    assert.deepEqual(store.requestSlot(), { kind: "admit" });
    await store.releaseSlot(job.job_id);
    assert.equal(store.getSlotReleasedCount(), 1, `cycle ${i}: exactly one live dedupe entry`);

    store.deleteJob(job.job_id);
    assert.equal(store.has(job.job_id), false, `cycle ${i}: job record purged`);
    assert.equal(
      store.getSlotReleasedCount(),
      0,
      `cycle ${i}: slotReleased must be fully reclaimed after delete, not accumulating across cycles`
    );
  }
});

// ---------------------------------------------------------------------------
// Shutdown admission race
// ---------------------------------------------------------------------------

test("shutdown gates new admissions the instant it begins: a run() call arriving while shutdown is still awaiting its own reap is rejected, never queued or spawned", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const instance = createServer(serverTransport);
  await instance.server.connect(instance.transport);
  const client = new Client({ name: "ghantika-shutdown-admission-race-test", version: "0.0.0" });
  await client.connect(clientTransport);

  jobStore.setConcurrencyConfig({ maxConcurrentJobs: 1, maxQueueDepth: 1 });
  try {
    const holder = (await client.callTool({
      name: "run",
      arguments: { command: ["sleep", "30"], label: "shutdown-race-holder" },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    assert.notEqual(holder.isError, true);

    await client.close();

    // Do not await yet - the point is to land a run() call while
    // shutdown is still in flight (specifically, while it's awaiting the
    // live-job reap started inside performShutdown).
    const shutdownPromise = instance.shutdown("test - admission race");

    const late = runTool.handler({
      command: ["sleep", "30"],
      label: "shutdown-race-late-arrival",
    });
    assert.equal(
      late.isError,
      true,
      "a run() call arriving once shutdown has begun must be rejected, never admitted or queued"
    );
    const lateStructured = structured(late);
    assert.equal(lateStructured.reason, "shutting-down");
    assert.equal(lateStructured.job_id, undefined, "a rejected run() must never create a job");

    await shutdownPromise;

    // A genuinely rejected call never created a job at all - nothing to
    // find, by any id, and nothing ever ran for it.
    const jobs = jobStore.list();
    assert.equal(
      jobs.some((j) => j.label === "shutdown-race-late-arrival"),
      false,
      "a run() rejected for shutting-down must never appear as a tracked job"
    );
  } finally {
    jobStore.clearShutdownGate();
    jobStore.drainQueueOnShutdown();
  }
});

// ---------------------------------------------------------------------------
// GHANTIKA_CWD_ROOTS - the queue-duration TOCTOU residual, disclosed rather
// than closed (see src/process.ts's resolveCwd doc comment): a queued
// job's cwd is validated once, before admission, and never re-validated
// against GHANTIKA_CWD_ROOTS when it actually reaches the front of the
// queue and spawns. This test proves and pins the REAL shape of that gap
// with a genuine queued-job reproduction, rather than leaving it as an
// unverified claim in a doc comment.
// ---------------------------------------------------------------------------

test(
  "DISCLOSED RESIDUAL, pinned by a real reproduction: a queued job's cwd is not re-validated at actual spawn time - swapping the checked directory for a symlink escaping the configured root WHILE the job is queued lets the real spawn land outside every configured root",
  {
    skip:
      process.platform === "win32"
        ? "symlink creation needs elevated privileges on win32 in CI"
        : false,
  },
  async () => {
    // A preceding test in this file may leave activeSlots/queue settling
    // asynchronously (its own cleanup does not always wait for that, e.g.
    // the shutdown-admission-race test just above only clears the
    // shutdown gate) - establish a genuinely clean baseline here rather
    // than assuming one, so this test's own cap=1/queue=1 admission
    // decisions are never computed against leftover state from whatever
    // ran immediately before it.
    await waitUntil(() => jobStore.getActiveSlotCount() === 0 && jobStore.getQueueLength() === 0);
    jobStore.setConcurrencyConfig({ maxConcurrentJobs: 1, maxQueueDepth: 1 });
    const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-cwdroots-toctou-root-"));
    const checkedDir = path.join(allowedRoot, "job");
    fs.mkdirSync(checkedDir);
    const outsideTarget = fs.mkdtempSync(
      path.join(os.tmpdir(), "ghantika-cwdroots-toctou-outside-")
    );
    const originalRoots = process.env[CWD_ROOTS_ENV_VAR];
    let blockerJobId: string | undefined;
    let queuedJobId: string | undefined;
    try {
      process.env[CWD_ROOTS_ENV_VAR] = allowedRoot;

      // Occupies the single slot so the job below is forced to queue. Its
      // own cwd must ALSO pass the now-active root check (equal to the
      // root itself is accepted) - otherwise it fails pre-flight, never
      // reserves a slot at all, and the job below is admitted instantly
      // instead of genuinely queuing.
      const blocker = runTool.handler({
        command: ["sleep", "30"],
        cwd: allowedRoot,
        label: "toctou-blocker",
      });
      assert.notEqual(blocker.isError, true);
      const blockerStructured = structured(blocker);
      blockerJobId = blockerStructured.job_id as string;
      assert.ok(
        ["starting", "running"].includes(blockerStructured.state as string),
        `blocker must genuinely hold the concurrency slot, got: ${JSON.stringify(blockerStructured)}`
      );

      // Validated NOW, while checkedDir is a real directory genuinely
      // inside allowedRoot - exactly the check the fail-open fix above
      // makes correct. It passes.
      const queued = runTool.handler({
        command: ["node", "-e", "process.stdout.write(process.cwd())"],
        cwd: checkedDir,
        label: "toctou-queued",
      });
      assert.notEqual(queued.isError, true);
      const queuedStructured = structured(queued);
      queuedJobId = queuedStructured.job_id as string;
      assert.equal(queuedStructured.state, "starting");
      assert.equal(queuedStructured.queue_position, 1, "must genuinely be queued, not admitted");

      // The swap: remove the checked directory and put a symlink of the
      // SAME name in its place, pointing OUTSIDE every configured root.
      // The queued job's own already-validated string never sees this -
      // it sits closed over, unconfirmed, for the rest of this job's
      // queue residence.
      fs.rmdirSync(checkedDir);
      fs.symlinkSync(outsideTarget, checkedDir, "dir");

      // Release the blocker's slot so the queued job dequeues and its
      // real spawn actually happens - now, against the swapped path.
      await killTool.handler({ job_id: blockerJobId });
      await waitUntil(() => isTerminalJobState(jobStore.get(queuedJobId!)!.state));

      assert.equal(jobStore.get(queuedJobId)!.state, "exited");
      const output = structured(outputTool.handler({ job_id: queuedJobId, stream: "stdout" }));
      const events = output.events as Array<{ text: string }>;
      const printedCwd = events.map((event) => event.text).join("");
      // THE DISCLOSED ESCAPE ITSELF: the process that actually ran printed
      // the OUTSIDE-root real path, not the allowed-root one it was
      // validated against moments earlier - the swap won. This is exactly
      // the residual src/process.ts's resolveCwd doc comment now
      // discloses; if a future change closes this gap (e.g. revalidating
      // at actual dequeue/spawn time), this assertion is the one that
      // must then flip to prove the closure, not be deleted.
      assert.equal(printedCwd, fs.realpathSync(outsideTarget));
    } finally {
      if (originalRoots === undefined) delete process.env[CWD_ROOTS_ENV_VAR];
      else process.env[CWD_ROOTS_ENV_VAR] = originalRoots;
      // Pass BOTH ids through cleanup rather than assuming the happy path
      // already terminated them - an assertion above can throw at any
      // point (including before the blocker is killed, or before the
      // queued job reaches a terminal state), and in that case one or
      // both real process groups are still alive when this block runs.
      // killTool.handler is idempotent against an already-terminal job
      // (a documented no-op with respect to its recorded state, though it
      // may still attempt a real cleanup reap), so calling it on both ids
      // unconditionally is always safe and is what actually guarantees
      // the blocker's group - and the queued job's, if it ever spawned -
      // is signaled and reaped rather than left running past this test.
      // Filtered to only the ids that were actually assigned, since a
      // throw before runTool.handler returns leaves that variable
      // undefined.
      await cleanUpSharedJobs(
        [blockerJobId, queuedJobId].filter((id): id is string => id !== undefined)
      );
    }
  }
);
