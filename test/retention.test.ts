/**
 * Regression coverage for job-output retention: the ONE
 * retention predicate in `src/scheduler.ts`'s `decideRetentionEvictions`,
 * and `src/jobStore.ts`'s `sweepRetention` that acts on it.
 *
 * Two layers, matching `test/concurrency.test.ts`'s own established split:
 * - The pure decision function, driven directly with synthetic
 *   `{jobId, endedAtMs}` inputs - deterministic, no real jobs needed.
 * - A fresh `new JobStore(...)` instance, driven through the real
 *   `createJob`/`markExited`/`releaseSlot`/`appendOutput` lifecycle, for
 *   the genuine store-level contract: eviction reclaims a job's BUFFERED
 *   OUTPUT (via `evictAllLines`, the dedicated bulk-clear this sweep uses -
 *   see that function's own docs for why it's a separate primitive from
 *   ordinary byte/line-cap eviction's one-line-at-a-time `evictOldestLine`),
 *   never the job's own record - `has`/`get` keep finding it, exactly as
 *   before. What DOES change on reclaim, beyond `getStreamSnapshot`:
 *   `getRetentionEvictedCount()` grows by one, and `getOutputCounts()`
 *   changes too if a later post-reclaim arrival bumps `bytesEverReceived`
 *   or `droppedCount` (see `appendOutput`'s own docs).
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { JobStore } from "../dist/jobStore.js";
import {
  DEFAULT_MAX_RETAINED_JOBS,
  DEFAULT_RETENTION_MS,
  decideRetentionEvictions,
  loadRetentionConfigFromEnv,
  normalizeRetentionConfig,
} from "../dist/scheduler.js";
import { buildSingleStreamEvents as buildSingleOutputEvents } from "../dist/tools/output.js";

// ---------------------------------------------------------------------------
// decideRetentionEvictions - the pure decision
// ---------------------------------------------------------------------------

test("decideRetentionEvictions: nothing is evicted when under both retentionMs and maxRetainedJobs", () => {
  const jobs = [
    { jobId: "a", endedAtMs: 1000 },
    { jobId: "b", endedAtMs: 2000 },
  ];
  const evicted = decideRetentionEvictions(jobs, 3000, {
    retentionMs: 10_000,
    maxRetainedJobs: 10,
  });
  assert.deepEqual(evicted, []);
});

test("decideRetentionEvictions: a job past retentionMs is evicted regardless of the cap", () => {
  const jobs = [
    { jobId: "old", endedAtMs: 0 },
    { jobId: "fresh", endedAtMs: 9000 },
  ];
  const evicted = decideRetentionEvictions(jobs, 10_000, {
    retentionMs: 5000,
    maxRetainedJobs: 10,
  });
  assert.deepEqual(evicted, ["old"]);
});

test("decideRetentionEvictions: a job exactly AT its retention deadline (now - endedAtMs === retentionMs) is evicted, not merely one past it", () => {
  // Distinct from the test above, which is well past the deadline (10000ms
  // elapsed against a 5000ms retentionMs) and so can't distinguish `>=`
  // from `>` at the boundary itself. Here elapsed time equals retentionMs
  // exactly - `now - endedAtMs` is precisely 5000, not 4999 or 5001 - so
  // this only passes if the real predicate is `>=`; a `>`-based mutant
  // would keep this job as a survivor instead.
  const jobs = [{ jobId: "at-deadline", endedAtMs: 0 }];
  const evicted = decideRetentionEvictions(jobs, 5000, {
    retentionMs: 5000,
    maxRetainedJobs: 10,
  });
  assert.deepEqual(evicted, ["at-deadline"]);
});

test("decideRetentionEvictions: cap eviction takes the OLDEST survivors first, down to maxRetainedJobs", () => {
  const jobs = [
    { jobId: "a", endedAtMs: 100 },
    { jobId: "b", endedAtMs: 200 },
    { jobId: "c", endedAtMs: 300 },
    { jobId: "d", endedAtMs: 400 },
  ];
  // now=500 so none is past retentionMs on its own; the cap alone forces two evictions.
  const evicted = decideRetentionEvictions(jobs, 500, {
    retentionMs: 1_000_000,
    maxRetainedJobs: 2,
  });
  assert.deepEqual(evicted, ["a", "b"]);
});

test("decideRetentionEvictions: whichever-first - time-expired jobs don't count against the cap headroom for survivors", () => {
  const jobs = [
    { jobId: "ancient", endedAtMs: 0 }, // age 1000, past retentionMs
    { jobId: "s1", endedAtMs: 950 }, // age 50, well under retentionMs
    { jobId: "s2", endedAtMs: 980 }, // age 20, well under retentionMs
  ];
  // retentionMs=100 -> only "ancient" is time-evicted.
  // maxRetainedJobs=2 and exactly 2 survivors remain -> no additional cap eviction.
  const evicted = decideRetentionEvictions(jobs, 1000, { retentionMs: 100, maxRetainedJobs: 2 });
  assert.deepEqual(evicted, ["ancient"]);
});

test("decideRetentionEvictions: a maxRetainedJobs of 0 evicts every survivor, oldest first", () => {
  const jobs = [
    { jobId: "a", endedAtMs: 100 },
    { jobId: "b", endedAtMs: 200 },
  ];
  const evicted = decideRetentionEvictions(jobs, 300, {
    retentionMs: 1_000_000,
    maxRetainedJobs: 0,
  });
  assert.deepEqual(evicted, ["a", "b"]);
});

test("decideRetentionEvictions: deterministic tie-break by jobId when endedAtMs is identical", () => {
  const jobs = [
    { jobId: "zzz", endedAtMs: 100 },
    { jobId: "aaa", endedAtMs: 100 },
  ];
  const evicted = decideRetentionEvictions(jobs, 200, {
    retentionMs: 1_000_000,
    maxRetainedJobs: 1,
  });
  assert.deepEqual(evicted, ["aaa"]); // lexicographically first of the tied pair
});

test("normalizeRetentionConfig falls back to the documented defaults on invalid input", () => {
  const normalized = normalizeRetentionConfig({ retentionMs: -1, maxRetainedJobs: Number.NaN });
  assert.equal(normalized.retentionMs, DEFAULT_RETENTION_MS);
  assert.equal(normalized.maxRetainedJobs, DEFAULT_MAX_RETAINED_JOBS);
});

test("loadRetentionConfigFromEnv reads GHANTIKA_JOB_RETENTION_MS / GHANTIKA_MAX_RETAINED_JOBS", () => {
  const config = loadRetentionConfigFromEnv({
    GHANTIKA_JOB_RETENTION_MS: "12345",
    GHANTIKA_MAX_RETAINED_JOBS: "7",
  });
  assert.equal(config.retentionMs, 12345);
  assert.equal(config.maxRetainedJobs, 7);
});

// ---------------------------------------------------------------------------
// JobStore.sweepRetention - the real store-level contract
// ---------------------------------------------------------------------------

function freshStore(retentionMs: number, maxRetainedJobs: number): JobStore {
  return new JobStore(
    { maxConcurrentJobs: 8, maxQueueDepth: 32 },
    { retentionMs, maxRetainedJobs }
  );
}

test("sweepRetention never evicts a non-terminal (still-running) job's output, however old", () => {
  const store = freshStore(0, 0); // most aggressive config possible
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("still running\n"));
  // No markExited - the job is still "starting"/running.
  store.sweepRetention(Date.now() + 1_000_000_000);
  const snapshot = store.getStreamSnapshot(record.job_id, "stdout")!;
  assert.equal(snapshot.lines.length, 1, "output must survive on a live job");
  assert.equal(snapshot.droppedCount, 0);
});

test("sweepRetention never evicts a job's output while its slot is currently stranded, even past retentionMs and over the cap", async () => {
  const store = freshStore(0, 0);
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("diagnostic trace\n"));
  store.markExited(record.job_id, 0, null);
  // Public route to a real stranded slot: an unconfirmed reap decision.
  await store.releaseSlot(record.job_id, Promise.resolve("unconfirmed"));
  assert.equal(
    store.isJobSlotStranded(record.job_id),
    true,
    "setup check: the slot is genuinely stranded"
  );

  store.sweepRetention(Date.now() + 1_000_000_000);
  const snapshot = store.getStreamSnapshot(record.job_id, "stdout")!;
  assert.equal(
    snapshot.lines.length,
    1,
    "a stranded job's output must survive - it may be the only remaining trace of what the still-held process group was doing"
  );
  assert.equal(snapshot.droppedCount, 0);
});

test("sweepRetention never evicts a job's output while its reap decision is still being awaited - not only once it has already come back unconfirmed", async () => {
  // Distinct from the sibling test above, which drives an ALREADY-SETTLED
  // "unconfirmed" decision (a resolved promise) and so only exercises
  // `isJobSlotStranded` becoming true AFTER the fact. This test targets
  // the window where the job is terminal, but the reap decision has not
  // resolved EITHER way yet, so
  // `isJobSlotStranded` is still `false` - only `reapPending` can see this
  // state, which is exactly why `sweepRetention` has to check it too, not
  // just `isJobSlotStranded`.
  const store = freshStore(0, 0);
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("diagnostic trace\n"));
  store.markExited(record.job_id, 0, null);

  let resolveReap: (decision: "confirmed" | "unconfirmed" | "errored") => void;
  const reapPromise = new Promise<"confirmed" | "unconfirmed" | "errored">((resolve) => {
    resolveReap = resolve;
  });
  // Deliberately not awaited yet - `releaseSlot` runs synchronously up to
  // its own `await reapPromise`, so by the time this call returns control
  // here, the job is already marked pending and the promise is still
  // unsettled.
  const releasePromise = store.releaseSlot(record.job_id, reapPromise);

  assert.equal(
    store.isJobSlotStranded(record.job_id),
    false,
    "setup check: the reap has not resolved unconfirmed/errored yet, so isJobSlotStranded alone would see nothing here"
  );

  store.sweepRetention(Date.now() + 1_000_000_000);
  const snapshotWhilePending = store.getStreamSnapshot(record.job_id, "stdout")!;
  assert.equal(
    snapshotWhilePending.lines.length,
    1,
    "output must survive while cleanup is still unconfirmed either way - reclaiming it now could destroy the only trace of a group that turns out to still be held"
  );
  assert.equal(snapshotWhilePending.droppedCount, 0);

  // Now let the reap resolve confirmed (the slot was NOT stranded after
  // all) and let `releaseSlot` finish - `reapPending` must clear, and a
  // later sweep must be free to reclaim this job's output normally, so
  // the exclusion above is a genuine DEFERRAL, not a permanent hold.
  resolveReap!("confirmed");
  await releasePromise;
  store.sweepRetention(Date.now() + 1_000_000_000);
  const snapshotAfterResolved = store.getStreamSnapshot(record.job_id, "stdout")!;
  assert.equal(
    snapshotAfterResolved.lines.length,
    0,
    "once the reap resolves confirmed and reapPending clears, this job is an ordinary eligible candidate again"
  );
  assert.equal(snapshotAfterResolved.droppedCount, 1);
});

test("sweepRetention reclaims a terminal job's output once retentionMs elapses - the record itself still exists", () => {
  const store = freshStore(1000, 100);
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("line one\n"));
  store.appendOutput(record.job_id, "stdout", Buffer.from("line two\n"));
  store.markExited(record.job_id, 0, null);
  const endedAtMs = Date.parse(store.get(record.job_id)!.ended_at!);

  store.sweepRetention(endedAtMs + 500); // still within retentionMs
  assert.equal(store.getStreamSnapshot(record.job_id, "stdout")!.lines.length, 2);

  store.sweepRetention(endedAtMs + 1500); // past retentionMs
  assert.equal(
    store.has(record.job_id),
    true,
    "the job's own record is NOT deleted by output retention"
  );
  assert.equal(store.get(record.job_id)!.state, "exited");
  const snapshot = store.getStreamSnapshot(record.job_id, "stdout")!;
  assert.equal(snapshot.lines.length, 0, "every retained line was dropped");
  assert.equal(
    snapshot.droppedCount,
    2,
    "the two materialized lines this stream held at reclaim time"
  );
});

test("sweepRetention reclaims stderr the same way it reclaims stdout - both streams are drained, not just the one every other test happens to exercise", () => {
  const store = freshStore(1000, 100);
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("stdout line\n"));
  store.appendOutput(record.job_id, "stderr", Buffer.from("stderr line one\n"));
  store.appendOutput(record.job_id, "stderr", Buffer.from("stderr line two\n"));
  store.markExited(record.job_id, 0, null);
  const endedAtMs = Date.parse(store.get(record.job_id)!.ended_at!);

  store.sweepRetention(endedAtMs + 1500); // past retentionMs
  const stdoutSnapshot = store.getStreamSnapshot(record.job_id, "stdout")!;
  const stderrSnapshot = store.getStreamSnapshot(record.job_id, "stderr")!;
  assert.equal(stdoutSnapshot.lines.length, 0);
  assert.equal(stdoutSnapshot.droppedCount, 1);
  assert.equal(stderrSnapshot.lines.length, 0, "stderr is drained too, not left behind");
  assert.equal(stderrSnapshot.droppedCount, 2);
});

test("a pending fragment reclaimed alongside a sibling's real line is discarded AND honestly disclosed as its own loss event, in the exact output-tool response body", () => {
  // The exact cross-stream shape this guards: stdout holds one genuine
  // materialized line (making the JOB eligible for reclamation via the
  // holds-output filter), while stderr holds NOTHING materialized - only
  // a 3-byte fragment still sitting in `pending`, never having formed a
  // complete line. `evictAllLines` clears that fragment (so it is never
  // retained forever, unreachable once the post-reclaim guards permanently
  // block any future flush) AND counts it as one further loss event -
  // `truncated:true`/`droppedCount:1` - rather than the forbidden
  // `truncated:true`/`droppedCount:0` pair a line-only count would
  // otherwise produce. This is asserted against the REAL response shape
  // `output`'s own exported `buildSingleStreamEvents` builds, not just
  // internal buffer state.
  const store = freshStore(0, 0);
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(
    record.job_id,
    "stdout",
    Buffer.from("the line that makes this job eligible\n")
  );
  store.appendOutput(record.job_id, "stderr", Buffer.from("xyz")); // 3 bytes, no newline - stays pending
  assert.equal(
    store.getStreamSnapshot(record.job_id, "stderr")!.lines.length,
    0,
    "setup check: stderr has zero materialized lines - only a pending fragment"
  );
  store.markExited(record.job_id, 0, null);

  const evicted = store.sweepRetention(Date.now() + 1_000_000_000);
  assert.deepEqual(evicted, [record.job_id]);
  const stderrSnapshot = store.getStreamSnapshot(record.job_id, "stderr")!;
  assert.equal(stderrSnapshot.lines.length, 0);
  assert.equal(
    stderrSnapshot.truncated,
    true,
    "a pending fragment IS a real loss event now, exactly like a dropped line - truncated must be true"
  );
  assert.equal(
    stderrSnapshot.droppedCount,
    1,
    "one loss event (the discarded fragment), even though it never became a materialized LINE - droppedCount now counts discrete loss events, not strictly lines"
  );

  const view = buildSingleOutputEvents("stderr", stderrSnapshot, 0);
  assert.deepEqual(
    view.events,
    [],
    "the exact response body's events array is empty for stderr - the fragment is genuinely gone"
  );
  assert.equal(
    view.drop.dropped,
    1,
    "the exact output-tool response body discloses dropped:1 for stderr, not the internal snapshot alone"
  );
  assert.equal(
    stderrSnapshot.truncated,
    true,
    "and the response's own truncated flag (derived from this same snapshot field) is true, never paired with dropped:0"
  );

  // The pending fragment must be genuinely gone, not merely hidden - a
  // late finalizeStream (simulating the stream's real `end` arriving
  // after reclamation) must not flush it into a line.
  store.finalizeStream(record.job_id, "stderr");
  assert.equal(
    store.getStreamSnapshot(record.job_id, "stderr")!.lines.length,
    0,
    "the discarded pending fragment must never surface later, even via finalizeStream's own stream-end flush"
  );
});

test("a SINGLE stream reclaimed with BOTH a real materialized line AND a pending fragment counts them as two SEPARATE loss events, not one - the fragment's own discard is never silently absorbed into the line count", () => {
  // Distinct from the cross-stream case above: here ONE stream (stdout)
  // holds a genuine materialized line AND a separate 3-byte fragment still
  // sitting in `pending` when reclamation happens - both real content this
  // stream itself is losing in the same call. An `evictAllLines` that
  // increments `droppedCount` only for the materialized line, with no
  // separate increment for the discarded fragment, would silently
  // undercount by exactly one whenever both happen together on the same
  // stream.
  const store = freshStore(0, 0);
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("a real line\n"));
  store.appendOutput(record.job_id, "stdout", Buffer.from("xyz")); // 3 bytes, no newline - stays pending
  assert.equal(
    store.getStreamSnapshot(record.job_id, "stdout")!.lines.length,
    1,
    "setup check: exactly one materialized line before reclamation"
  );
  store.markExited(record.job_id, 0, null);

  const evicted = store.sweepRetention(Date.now() + 1_000_000_000);
  assert.deepEqual(evicted, [record.job_id]);
  const stdoutSnapshot = store.getStreamSnapshot(record.job_id, "stdout")!;
  assert.equal(stdoutSnapshot.lines.length, 0);
  assert.equal(stdoutSnapshot.truncated, true);
  assert.equal(
    stdoutSnapshot.droppedCount,
    2,
    "TWO discrete loss events: the one materialized line PLUS the separately-discarded pending fragment - not just the line count"
  );

  const view = buildSingleOutputEvents("stdout", stdoutSnapshot, 0);
  assert.deepEqual(
    view.events,
    [],
    "the exact response body's events array is empty - both are genuinely gone"
  );
  assert.equal(
    view.drop.dropped,
    2,
    "the exact output-tool response body discloses dropped:2, matching the internal snapshot"
  );
});

test("green control: a stream that GENUINELY never received anything stays truncated:false after its sibling stream's reclaim - the honesty fix above must not overclaim loss where none occurred", () => {
  // The other side of the same fix: a job is eligible for reclamation the
  // moment EITHER stream holds output (stdout does, here), but stderr in
  // this job never received a single byte from the child - no lines, no
  // pending fragment, `bytesEverReceived` genuinely zero. Marking THIS
  // stream truncated after reclaim would be a false claim of loss in the
  // opposite direction from the defect this fix closes.
  const store = freshStore(0, 0);
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(
    record.job_id,
    "stdout",
    Buffer.from("the only output this job ever produces\n")
  );
  // stderr: appendOutput is never called at all.
  store.markExited(record.job_id, 0, null);

  const evicted = store.sweepRetention(Date.now() + 1_000_000_000);
  assert.deepEqual(evicted, [record.job_id]);
  const stderrSnapshot = store.getStreamSnapshot(record.job_id, "stderr")!;
  assert.equal(
    stderrSnapshot.truncated,
    false,
    "stderr never held anything at all - truncated must stay false, not be overclaimed just because the sibling stream was reclaimed"
  );
  assert.equal(stderrSnapshot.droppedCount, 0);
  assert.equal(store.getOutputCounts(record.job_id).stderr_bytes, 0);
});

test("a whole job whose ONLY buffered content, on BOTH streams, is pending fragments (zero complete lines anywhere) is still a real retention candidate", () => {
  // A holdsOutput check that inspects only lines.length on each stream
  // would treat a job like this - real bytes received, none of them ever
  // forming a complete line - as never a candidate at all: sweepRetention
  // would silently skip it regardless of age or cap, and its pending
  // fragments would eventually flush via finalizeStream, never bounded by
  // retention at all. Checking bytesEverReceived instead makes this job a
  // genuine candidate.
  const store = freshStore(0, 0);
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("abc")); // no newline - pending only
  store.appendOutput(record.job_id, "stderr", Buffer.from("xyz")); // no newline - pending only
  assert.equal(store.getStreamSnapshot(record.job_id, "stdout")!.lines.length, 0);
  assert.equal(store.getStreamSnapshot(record.job_id, "stderr")!.lines.length, 0);
  store.markExited(record.job_id, 0, null);

  const evicted = store.sweepRetention(Date.now() + 1_000_000_000);
  assert.deepEqual(
    evicted,
    [record.job_id],
    "a job whose only content on both streams is pending fragments must still be swept - a lines.length-only holds-output check would never make it eligible"
  );
  const stdoutSnapshot = store.getStreamSnapshot(record.job_id, "stdout")!;
  const stderrSnapshot = store.getStreamSnapshot(record.job_id, "stderr")!;
  assert.equal(stdoutSnapshot.truncated, true);
  assert.equal(stdoutSnapshot.droppedCount, 1);
  assert.equal(stderrSnapshot.truncated, true);
  assert.equal(stderrSnapshot.droppedCount, 1);
  assert.deepEqual(
    buildSingleOutputEvents("stdout", stdoutSnapshot, 0).events,
    [],
    "the exact response body shows nothing left on stdout"
  );
  assert.deepEqual(
    buildSingleOutputEvents("stderr", stderrSnapshot, 0).events,
    [],
    "the exact response body shows nothing left on stderr"
  );

  // Never flushed later, on either stream.
  store.finalizeStream(record.job_id, "stdout");
  store.finalizeStream(record.job_id, "stderr");
  assert.equal(store.getStreamSnapshot(record.job_id, "stdout")!.lines.length, 0);
  assert.equal(store.getStreamSnapshot(record.job_id, "stderr")!.lines.length, 0);
});

test("a stream genuinely empty at the moment its job is reclaimed, which THEN receives late bytes via appendOutput, discloses that arrival honestly in the exact output-tool body - not silently indistinguishable from a stream that never received anything", () => {
  // The sharper case: at reclaim time stderr has
  // zero footprint (correctly truncated:false/droppedCount:0 - nothing
  // was lost YET). A chunk then arrives for stderr on this
  // already-retentionEvicted job. An appendOutput whose retentionEvicted
  // branch counts the bytes into bytesEverReceived and returns, touching
  // neither truncated nor droppedCount, would leave the output-tool
  // response for stderr byte-identical to a stream that never received
  // output at all, even though real bytes had just been silently
  // dropped.
  const store = freshStore(0, 0);
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(
    record.job_id,
    "stdout",
    Buffer.from("the line that makes this job eligible\n")
  );
  // stderr: nothing yet.
  store.markExited(record.job_id, 0, null);

  const evicted = store.sweepRetention(Date.now() + 1_000_000_000);
  assert.deepEqual(evicted, [record.job_id]);
  const beforeLateArrival = store.getStreamSnapshot(record.job_id, "stderr")!;
  assert.equal(
    beforeLateArrival.truncated,
    false,
    "at the moment of reclaim, stderr genuinely held nothing - truncated correctly stays false here"
  );
  assert.equal(beforeLateArrival.droppedCount, 0);
  const beforeView = buildSingleOutputEvents("stderr", beforeLateArrival, 0);
  assert.equal(
    beforeView.drop.dropped,
    0,
    "the exact response body shows no drop yet, matching a stream that never received anything - correct, since nothing had arrived yet"
  );

  // Now a late chunk arrives for the already-reclaimed job - the exact
  // shape that must flip truncated and increment droppedCount, rather
  // than silently vanishing into bytesEverReceived alone.
  store.appendOutput(record.job_id, "stderr", Buffer.from("late bytes that arrive too late"));

  const afterLateArrival = store.getStreamSnapshot(record.job_id, "stderr")!;
  assert.equal(
    afterLateArrival.truncated,
    true,
    "the late arrival is a real loss event now - truncated must flip to true"
  );
  assert.equal(
    afterLateArrival.droppedCount,
    1,
    "one loss event for the late arrival, distinct from the earlier reclaim which lost nothing on this stream"
  );
  const afterView = buildSingleOutputEvents("stderr", afterLateArrival, 0);
  assert.deepEqual(afterView.events, [], "the late bytes never materialize into a visible line");
  assert.equal(
    afterView.drop.dropped,
    1,
    "the exact response body now discloses dropped:1 for stderr - no longer silently indistinguishable from a stream that never received anything"
  );
});

test("sweepRetention's cap ignores a terminal job holding NO output at all, so a NEWER empty job can never displace an OLDER job that still holds real output", () => {
  const store = freshStore(1_000_000_000, 1); // effectively no time limit, cap of 1
  // `holdsOutput` is deliberately the OLDER of the two, and `empty` the
  // NEWER - the exact hazard shape: without the holds-output filter,
  // `decideRetentionEvictions`'s cap logic evicts the OLDEST survivor
  // among candidates, which would be `holdsOutput` itself once `empty`
  // (never calls appendOutput at all - a job that ran and produced
  // nothing, e.g. `true`) is wrongly admitted as a candidate. Putting the
  // empty job OLDER instead can never exercise this: age-based
  // tie-breaking would then evict the empty job regardless of whether the
  // filter is even present, and the real job's content would survive
  // either way - a mutation that removes the filter entirely would still
  // pass. This ordering is what makes it mutation-strong: removing the
  // filter here evicts the REAL job's content, not the empty one's.
  const holdsOutput = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(holdsOutput.job_id, "stdout", Buffer.from("the only real output here\n"));
  store.markExited(holdsOutput.job_id, 0, null);
  const empty = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.markExited(empty.job_id, 0, null);
  const now = Date.now();
  store.get(holdsOutput.job_id)!.ended_at = new Date(now).toISOString();
  store.get(empty.job_id)!.ended_at = new Date(now + 1000).toISOString();

  const evicted = store.sweepRetention(now + 2000);
  assert.deepEqual(
    evicted,
    [],
    "a job holding no output is never itself a candidate, so nothing is evicted here - the real job's single slot is never contested, even though it is the older of the two"
  );
  assert.equal(
    store.getStreamSnapshot(holdsOutput.job_id, "stdout")!.lines.length,
    1,
    "the only job that ever held output must still hold it - a newer empty terminal record must never displace it"
  );
});

test("sweepRetention reclaims the oldest terminal jobs' output once maxRetainedJobs is exceeded", () => {
  const store = freshStore(1_000_000_000, 1); // effectively no time limit, cap of 1
  const first = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(first.job_id, "stdout", Buffer.from("first job's output\n"));
  store.markExited(first.job_id, 0, null);
  const second = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(second.job_id, "stdout", Buffer.from("second job's output\n"));
  store.markExited(second.job_id, 0, null);
  // Two real `new Date()` calls back-to-back can land in the SAME
  // millisecond, making "oldest" ambiguous - force a genuine, deterministic
  // ordering rather than relying on wall-clock granularity.
  const now = Date.now();
  store.get(first.job_id)!.ended_at = new Date(now).toISOString();
  store.get(second.job_id)!.ended_at = new Date(now + 1000).toISOString();

  store.sweepRetention(now + 2000);
  assert.equal(
    store.getStreamSnapshot(first.job_id, "stdout")!.lines.length,
    0,
    "the older of the two over-cap terminal jobs' output is reclaimed first"
  );
  assert.equal(store.getStreamSnapshot(second.job_id, "stdout")!.lines.length, 1);
});

test("a stream's own end event finalizing AFTER the job was already marked retention-evicted never re-populates it - the exit-before-stream-end race", () => {
  // `src/process.ts` wires a child's `exit` and its stdout/stderr `end` as
  // INDEPENDENT events with no ordering guarantee between them - `exit`
  // can fire, and `run.ts`'s onExit can call `markExited` (making the job
  // terminal, hence retention-eligible), before the stream's own `end`
  // fires and flushes a still-pending, never-newline-terminated fragment.
  // This drives that exact ordering directly through the store's public
  // API: appendOutput leaves a real materialized line PLUS a pending
  // fragment, markExited makes the job terminal, sweepRetention reclaims
  // it (the job DOES hold output at that moment, so the holds-output
  // filter does not exclude it), and only THEN does finalizeStream run -
  // simulating the stream's `end` arriving late.
  const store = freshStore(0, 0); // most aggressive config possible
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("a real line\n"));
  store.appendOutput(
    record.job_id,
    "stdout",
    Buffer.from("a pending fragment with no trailing newline")
  );
  assert.equal(
    store.getStreamSnapshot(record.job_id, "stdout")!.lines.length,
    1,
    "setup check: one real line materialized, the fragment is still pending, unmaterialized"
  );

  store.markExited(record.job_id, 0, null); // the child's `exit` fires

  const firstSweep = store.sweepRetention(Date.now() + 1_000_000_000);
  assert.deepEqual(
    firstSweep,
    [record.job_id],
    "the job genuinely holds output at this moment, so it IS reclaimed here"
  );
  assert.equal(
    store.getStreamSnapshot(record.job_id, "stdout")!.lines.length,
    0,
    "reclaimed - the one real line is gone"
  );

  // The stream's `end` event arrives LATE, after retention already marked
  // this job evicted - finalizeStream must not resurrect it.
  store.finalizeStream(record.job_id, "stdout");
  assert.equal(
    store.getStreamSnapshot(record.job_id, "stdout")!.lines.length,
    0,
    "a late stream-end must never re-populate a buffer this store has already reclaimed and told every caller is empty"
  );

  // And a later sweep must not return this job again - NOT because
  // there is nothing left to reclaim (this job's bytesEverReceived is
  // still > 0, and that check alone never excludes it, now or ever),
  // but because retentionEvicted's own membership check is what keeps
  // it out of candidacy on every subsequent sweep.
  const secondSweep = store.sweepRetention(Date.now() + 1_000_000_000);
  assert.deepEqual(secondSweep, []);
  assert.equal(store.getStreamSnapshot(record.job_id, "stdout")!.lines.length, 0);
});

test("a chunk arriving via appendOutput AFTER the job was already marked retention-evicted never re-populates it either - distinct from the finalizeStream race, since the sibling test above never calls appendOutput post-sweep and so cannot discriminate this guard on its own", () => {
  // The sibling test above does NOT prove `finalizeStream`'s own
  // post-reclaim guard is load-bearing, and cannot: `evictAllLines`
  // already empties `pending` on reclaim, so `finalizeStreamBuffer`'s own
  // internal `pending.length > 0` check already blocks materialization
  // regardless of whether the JobStore-level guard runs first - removing
  // that guard alone leaves the sibling test fully green (measured). This
  // test isolates `appendOutput`'s own guard instead, which IS
  // load-bearing: without it, a post-reclaim chunk would run through
  // `appendChunkToBuffer` and could materialize a fresh line with a real
  // seq, resurrecting content this store has already told every caller
  // is gone.
  const store = freshStore(0, 0);
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("a real line\n"));
  store.markExited(record.job_id, 0, null);

  const evicted = store.sweepRetention(Date.now() + 1_000_000_000);
  assert.deepEqual(
    evicted,
    [record.job_id],
    "genuinely reclaimed - holds real output at sweep time"
  );
  assert.equal(store.getStreamSnapshot(record.job_id, "stdout")!.lines.length, 0);
  const bytesBeforeLateChunk = store.getOutputCounts(record.job_id).stdout_bytes;
  const droppedBeforeLateChunk = store.getStreamSnapshot(record.job_id, "stdout")!.droppedCount;

  // A chunk arrives on this stream AFTER reclamation - e.g. a delayed OS
  // read, or more data the child wrote before its process actually exited
  // but that this store observes only later. appendOutput must not
  // materialize it into a line, even though it forms a complete one.
  const lateChunk = Buffer.from("a complete line arriving after reclaim\n");
  store.appendOutput(record.job_id, "stdout", lateChunk);
  assert.equal(
    store.getStreamSnapshot(record.job_id, "stdout")!.lines.length,
    0,
    "a late chunk delivered via appendOutput must never re-populate a buffer this store has already reclaimed and told every caller is empty"
  );
  assert.equal(
    store.getOutputCounts(record.job_id).stdout_bytes,
    bytesBeforeLateChunk + lateChunk.length,
    "the late chunk's raw byte count is still counted (bytesEverReceived stays honest), even though it is never materialized"
  );
  assert.equal(
    store.getStreamSnapshot(record.job_id, "stdout")!.droppedCount,
    droppedBeforeLateChunk + 1,
    "the late arrival is its own additional loss event, one more than what the initial line eviction already counted"
  );
  assert.equal(store.getStreamSnapshot(record.job_id, "stdout")!.truncated, true);
});

test("sweepRetention's cap count excludes a job whose output was already reclaimed - a genuinely-reclaimed job never re-enters candidacy or double-occupies a maxRetainedJobs slot across a LATER, separate sweep", () => {
  // Phase 1 uses a short retentionMs so `first`'s own reclaim is driven
  // by TIME alone, deterministically, independent of the cap - with only
  // one candidate present, a cap of 1 could never itself trigger eviction
  // (overflow is candidates-over-cap, and one candidate against a cap of
  // one is not over). Phase 2 then reconfigures to a effectively-unbounded
  // retentionMs so the SECOND/THIRD contention below is driven by the cap
  // alone, never by time, isolating exactly the property this test names.
  const store = freshStore(1000, 1);
  const first = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(first.job_id, "stdout", Buffer.from("first's real output\n"));
  store.markExited(first.job_id, 0, null);
  // Assert the setup transition itself, not just the eventual outcome:
  // `first` genuinely HELD output before this sweep - a job the
  // holds-no-output-at-all exclusion would never have touched, so this
  // test isolates the "already reclaimed" case from the "never had
  // anything to reclaim" case the sibling holds-output test covers.
  assert.equal(
    store.getStreamSnapshot(first.job_id, "stdout")!.lines.length,
    1,
    "setup check: first must genuinely hold output before its own reclaim, or this test proves nothing"
  );
  const firstEndedAtMs = Date.parse(store.get(first.job_id)!.ended_at!);
  const firstSweep = store.sweepRetention(firstEndedAtMs + 1500); // past the 1000ms retentionMs
  assert.deepEqual(
    firstSweep,
    [first.job_id],
    "first's real output is actually reclaimed here, not skipped as empty"
  );
  assert.equal(
    store.getStreamSnapshot(first.job_id, "stdout")!.lines.length,
    0,
    "setup check: first genuinely holds zero lines after its own reclaim"
  );

  store.setRetentionConfig({ retentionMs: 1_000_000_000, maxRetainedJobs: 1 });
  const second = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(second.job_id, "stdout", Buffer.from("second\n"));
  store.markExited(second.job_id, 0, null);
  const third = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(third.job_id, "stdout", Buffer.from("third\n"));
  store.markExited(third.job_id, 0, null);
  // Force a genuine, deterministic age ordering rather than relying on
  // wall-clock millisecond resolution (see the sibling test above).
  const now = Date.now();
  store.get(second.job_id)!.ended_at = new Date(now).toISOString();
  store.get(third.job_id)!.ended_at = new Date(now + 1000).toISOString();

  // With retentionMs now effectively unbounded and a cap of 1, `first`
  // is excluded from candidacy SOLELY by `retentionEvicted` - not
  // because it holds no output: its stdout's bytesEverReceived is still
  // 20 from before its own reclaim, and that check alone would keep
  // admitting it forever. `second` and `third` are the only real
  // contenders - `second` (older) is evicted,
  // `third` survives. A regression that let a genuinely-reclaimed job
  // re-enter candidacy - or double-count toward the cap - would instead
  // leave `second` a survivor here, one real job short of what the cap of
  // 1 should actually admit.
  const secondSweep = store.sweepRetention(now + 2000);
  assert.deepEqual(
    secondSweep,
    [second.job_id],
    "first must not reappear in this later sweep's own evicted list"
  );
  assert.equal(store.getStreamSnapshot(second.job_id, "stdout")!.lines.length, 0);
  assert.equal(store.getStreamSnapshot(third.job_id, "stdout")!.lines.length, 1);
  assert.equal(
    store.getRetentionEvictedCount(),
    2,
    "first and second each counted exactly once - never double-counted across the two separate sweeps"
  );
});

test("createJob's opportunistic sweep reclaims eligible output immediately, without waiting for the periodic timer's next tick - proven with the timer never started, so this test isolates that trigger alone", () => {
  const store = freshStore(0, 0);
  const first = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(first.job_id, "stdout", Buffer.from("not yet reclaimed\n"));
  store.markExited(first.job_id, 0, null);
  assert.equal(
    store.getStreamSnapshot(first.job_id, "stdout")!.lines.length,
    1,
    "not yet reclaimed - no new job has arrived to trigger a sweep, and this store's timer was never started"
  );

  // A second createJob call is itself the trigger.
  store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  assert.equal(store.getStreamSnapshot(first.job_id, "stdout")!.lines.length, 0);
});

test("sweepRetention is idempotent - calling it again after eviction is a clean no-op, never an error", () => {
  const store = freshStore(0, 100);
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("output\n"));
  store.markExited(record.job_id, 0, null);

  const firstSweep = store.sweepRetention(Date.now());
  assert.deepEqual(firstSweep, [record.job_id]);
  const secondSweep = store.sweepRetention(Date.now());
  assert.deepEqual(secondSweep, [], "already-evicted job is not re-evicted or re-reported");
  assert.equal(store.getRetentionEvictedCount(), 1);
});

test("setRetentionConfig reconfigures an already-constructed store's policy, taking effect on the very next sweep - including for a job created before the reconfiguration", () => {
  // Starts permissive (never reclaims), so a sweep now evicts nothing.
  const store = freshStore(1_000_000_000, 100);
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(
    record.job_id,
    "stdout",
    Buffer.from("created under the OLD permissive config\n")
  );
  store.markExited(record.job_id, 0, null);
  store.sweepRetention(Date.now());
  assert.equal(
    store.getStreamSnapshot(record.job_id, "stdout")!.lines.length,
    1,
    "not yet eligible under the original, permissive config"
  );

  // Reconfigure to the most aggressive possible policy, with no new job
  // created in between - the SAME already-existing job is re-evaluated.
  store.setRetentionConfig({ retentionMs: 0, maxRetainedJobs: 0 });
  store.sweepRetention(Date.now());
  assert.equal(
    store.getStreamSnapshot(record.job_id, "stdout")!.lines.length,
    0,
    "the new config takes effect on the very next sweep, for a candidate that already existed"
  );
});

test("setRetentionConfig does not un-evict or re-report a job already in retentionEvicted, however the policy changes afterward", () => {
  const store = freshStore(0, 100); // aggressive from construction
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("real output\n")); // must genuinely hold output to be a candidate at all
  store.markExited(record.job_id, 0, null);
  const firstSweep = store.sweepRetention(Date.now());
  assert.deepEqual(firstSweep, [record.job_id]);

  // Reconfigure to maximally permissive - if the exclusion were bypassed,
  // this would be a no-op regardless, so this alone would not prove
  // anything; the getRetentionEvictedCount()/return-value pair below does.
  store.setRetentionConfig({ retentionMs: 1_000_000_000, maxRetainedJobs: 100 });
  const secondSweep = store.sweepRetention(Date.now());
  assert.deepEqual(secondSweep, [], "already-evicted job is excluded regardless of the new policy");
  assert.equal(store.getRetentionEvictedCount(), 1);
});

test("deleteJob still reclaims retentionEvicted, alongside everything else it already clears", () => {
  const store = freshStore(0, 100);
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("real output\n")); // must genuinely hold output to be a candidate at all
  store.markExited(record.job_id, 0, null);
  store.sweepRetention(Date.now());
  assert.equal(store.getRetentionEvictedCount(), 1);

  store.deleteJob(record.job_id);
  assert.equal(store.getRetentionEvictedCount(), 0);
  assert.equal(store.has(record.job_id), false);
});

// Negative control: proves the exclusion filters in `sweepRetention` are
// actually load-bearing, not merely present. With all three guards
// genuinely wired, a job that is non-terminal, stranded, or has a reap
// decision still pending keeps its output intact (proven above). This
// control instead proves the sweep DOES reclaim an ordinary terminal,
// non-stranded, no-pending-reap job's output under the exact same
// aggressive config - so the three "survives" tests above are a real
// discriminating signal, not a config that happens to evict nothing ever.
test("negative control: the aggressive config used above genuinely reclaims an ordinary terminal job's output", () => {
  const store = freshStore(0, 0);
  const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
  store.appendOutput(record.job_id, "stdout", Buffer.from("ordinary output\n"));
  store.markExited(record.job_id, 0, null);
  store.sweepRetention(Date.now());
  const snapshot = store.getStreamSnapshot(record.job_id, "stdout")!;
  assert.equal(
    snapshot.lines.length,
    0,
    "config is genuinely aggressive - the guards above are doing real work, not a no-op config"
  );
  assert.equal(snapshot.droppedCount, 1);
});

// ---------------------------------------------------------------------------
// startRetentionSweeper / stopRetentionSweeper - the scheduled sweep timer (a1)
// ---------------------------------------------------------------------------

test("startRetentionSweeper is idempotent - a second call while one is already running does not create a second timer", () => {
  const store = freshStore(0, 0);
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    // Spy directly on the (mocked) global `setInterval` itself, rather than
    // inferring "no second timer" from a sweep's OUTCOME - a duplicate
    // timer that both fire the same idempotent `sweepRetention` produces
    // an identical outcome to a single one, so an outcome-based assertion
    // could never actually catch a removed early-return guard. Counting
    // the real call is what makes this mutation-strong.
    const originalSetInterval = globalThis.setInterval;
    let setIntervalCallCount = 0;
    globalThis.setInterval = (...args) => {
      setIntervalCallCount += 1;
      return originalSetInterval(...args);
    };
    try {
      store.startRetentionSweeper();
      store.startRetentionSweeper();
      assert.equal(
        setIntervalCallCount,
        1,
        "a second startRetentionSweeper call must not schedule a second timer"
      );
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
    store.stopRetentionSweeper();
  } finally {
    mock.timers.reset();
  }
});

test("startRetentionSweeper's real timer reclaims a terminal job's output on an otherwise-idle store - no new job ever arrives to trigger it", () => {
  const store = freshStore(1000, 100);
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    store.startRetentionSweeper();
    const record = store.createJob({ argv: ["true"], cwd: "/", env: {}, isShell: false });
    store.appendOutput(record.job_id, "stdout", Buffer.from("idle-server output\n"));
    store.markExited(record.job_id, 0, null);
    assert.equal(store.getStreamSnapshot(record.job_id, "stdout")!.lines.length, 1);

    // Advance past both retentionMs AND at least one full
    // RETENTION_SWEEP_INTERVAL_MS (30s) - the interval callback only
    // fires once a whole period has elapsed, not merely once retentionMs
    // itself has - with no createJob call in between, only the timer can
    // be responsible for what happens next.
    mock.timers.tick(31_000);

    const snapshot = store.getStreamSnapshot(record.job_id, "stdout")!;
    assert.equal(
      snapshot.lines.length,
      0,
      "the periodic timer, not activity, is what reclaimed this - genuinely time-based"
    );
    assert.equal(snapshot.droppedCount, 1);
  } finally {
    store.stopRetentionSweeper();
    mock.timers.reset();
  }
});

test("stopRetentionSweeper is a safe no-op on a store that never started one", () => {
  const store = freshStore(0, 0);
  store.stopRetentionSweeper(); // must not throw
});
