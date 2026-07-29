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
 *   and `status`/`list`'s observability of `queue_position`/the cap.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import { ALL_JOB_STATES, JobStore, jobStore } from "../dist/jobStore.js";
import { createServer } from "../dist/server.js";
import * as killTool from "../dist/tools/kill.js";
import * as listTool from "../dist/tools/list.js";
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
// Overflow: fail-fast rejection, including the cap=0 and max-queue-depth=0
// boundaries
// ---------------------------------------------------------------------------

test(
  "run() rejects fail-fast, without blocking, once the concurrency cap and queue are both full - including the cap=0 and max-queue-depth=0 boundaries",
  async () => {
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
      const first = runTool.handler({ command: ["sleep", "30"], label: "concurrency-overflow-first-job" });
      const firstElapsed = Date.now() - beforeFirst;
      assert.notEqual(first.isError, true);
      const firstStructured = structured(first);
      firstJobId = firstStructured.job_id as string;
      assert.ok(["starting", "running"].includes(firstStructured.state as string));
      assert.ok(firstElapsed < 1000, `run() must return instantly, took ${firstElapsed}ms`);

      const beforeSecond = Date.now();
      const second = runTool.handler({ command: ["sleep", "30"], label: "concurrency-overflow-second-job" });
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
  }
);

// ---------------------------------------------------------------------------
// FIFO admission order, and a post-dequeue spawn failure
// ---------------------------------------------------------------------------

test(
  "FIFO admission with insertion-sequence tie-break; a dequeue spawn failure settles the dequeued job to failed and frees its slot without leaking",
  async () => {
    const store = new JobStore({ maxConcurrentJobs: 1, maxQueueDepth: 3 });
    const dequeueOrder: string[] = [];

    store.createJob({ argv: ["a"], cwd: "/tmp", env: {}, isShell: false, label: "a" });
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
    await store.releaseSlot();
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
    await store.releaseSlot(); // no reap promise - a spawn failure never attaches a real child
    assert.deepEqual(dequeueOrder, ["a", "b", "c"]);
    assert.equal(store.get(c.job_id)!.queue_position, undefined);
    assert.equal(store.get(d.job_id)!.queue_position, 1);
    assert.equal(store.getActiveSlotCount(), 1, "the slot did not leak - c now holds it");

    // Drain the rest for a clean finish: releasing c's slot hands the
    // last spot to d, exactly as FIFO order predicts.
    await store.releaseSlot();
    assert.deepEqual(dequeueOrder, ["a", "b", "c", "d"]);
    assert.equal(store.getQueueLength(), 0);
    assert.equal(store.getActiveSlotCount(), 1);
  }
);

// ---------------------------------------------------------------------------
// Exactly-once slot release tied to the awaited reap, and shutdown drain
// ---------------------------------------------------------------------------

test(
  "a slot releases only after the finishing job's reap has been awaited to completion (a slow reap never releases early); shutdown kills queued jobs and drains the queue deterministically",
  async () => {
    // --- Exactly-once release, tied to the awaited reap ---
    {
      const store = new JobStore({ maxConcurrentJobs: 1, maxQueueDepth: 1 });
      store.createJob({ argv: ["a"], cwd: "/tmp", env: {}, isShell: false });
      assert.deepEqual(store.requestSlot(), { kind: "admit" });
      const b = store.createJob({ argv: ["b"], cwd: "/tmp", env: {}, isShell: false });
      assert.deepEqual(store.requestSlot(), { kind: "queue" });
      let dequeued = false;
      store.enqueueJob(b.job_id, () => {
        dequeued = true;
      });

      let resolveReap: () => void = () => {};
      const slowReap = new Promise<void>((resolve) => {
        resolveReap = resolve;
      });

      // Fire-and-forget, exactly like run.ts's own onExit wiring - never
      // awaited by its own caller.
      const releasePromise = store.releaseSlot(slowReap);

      // Give the event loop several real turns - a slow reap that has NOT
      // resolved yet must NOT have released the slot early, however many
      // turns pass.
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(dequeued, false, "the slot must not release before its reap resolves");
      assert.equal(store.getActiveSlotCount(), 1, "a's slot must still read as held");
      assert.equal(store.get(b.job_id)!.queue_position, 1, "b must still be queued");

      // Now let the reap actually finish - the release must complete
      // exactly then.
      resolveReap();
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
    try {
      const running = (await client.callTool({
        name: "run",
        arguments: { command: ["sleep", "30"], label: "concurrency-shutdown-running-job" },
      })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
      assert.notEqual(running.isError, true);
      const runningJobId = running.structuredContent?.job_id as string;
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
      assert.notEqual(jobStore.get(runningJobId), undefined, "the running job's own record is untouched by the queue drain");

      // A second drain is a genuine no-op - deterministic, idempotent.
      jobStore.drainQueueOnShutdown();
      assert.equal(jobStore.getQueueLength(), 0);
    } finally {
      jobStore.drainQueueOnShutdown();
    }
  }
);

// ---------------------------------------------------------------------------
// queue_position stays a field on a closed job-state enum; non-blocking in
// all three outcomes; observable via status and list
// ---------------------------------------------------------------------------

test(
  "queue_position is a field on the existing starting state (never a new enum state) on a job-state enum that stays closed at five values; run() returns instantly whether it admits immediately, queues, or rejects; the cap and queue_position are observable via status and list",
  async () => {
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
      const first = runTool.handler({ command: ["sleep", "30"], label: "concurrency-cases-first-job" });
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
      assert.ok(firstElapsed < 1000, `immediate admission must return instantly, took ${firstElapsed}ms`);

      // Case 2: queues (cap is full, queue depth allows it).
      const beforeQueued = Date.now();
      const queued = runTool.handler({ command: ["sleep", "30"], label: "concurrency-cases-queued-job" });
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
      const rejected = runTool.handler({ command: ["true"], label: "concurrency-cases-rejected-job" });
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
  }
);
