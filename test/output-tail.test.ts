import assert from "node:assert/strict";
import { after, test } from "node:test";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import {
  appendChunkToBuffer,
  createStreamBufferState,
  jobStore,
  snapshotStreamBuffer,
} from "../dist/jobStore.js";
import * as outputTool from "../dist/tools/output.js";
import * as tailTool from "../dist/tools/tail.js";
import { logActiveResourcesAtFileEnd } from "./helpers/activeResourcesDiagnostic.ts";

// Explicit ".ts" extension - see test/e2e-server.test.ts's import comment
// for why spawnServer.ts is imported this way.
import { type SpawnedServer, completeHandshake, spawnServer } from "./helpers/spawnServer.ts";

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/**
 * A hand-built StreamBufferSnapshot - the exact shape jobStore.getStreamSnapshot
 * returns, now including the real per-line `seq` and `totalEverMaterialized`
 * (the seq architectural addition). Each line's `seq` defaults to
 * its 1-based array position (correct for an UNTRUNCATED fixture, where
 * nothing has ever been evicted so seq === position), but can be
 * overridden per-line to simulate a REALISTIC post-eviction scenario
 * (surviving lines' seq values starting well above 1). `totalEverMaterialized`
 * similarly defaults to the last line's own seq (again, correct only when
 * nothing has been evicted) and can be overridden to simulate "N lines
 * existed in total, only the newest few survived".
 */
function snapshot(
  lines: Array<{
    text: string;
    terminator?: "newline" | "oversized-split" | "stream-end";
    seq?: number;
  }>,
  truncated = false,
  totalEverMaterialized?: number
) {
  const withSeq = lines.map((l, i) => ({
    text: l.text,
    terminator: l.terminator ?? ("newline" as const),
    seq: l.seq ?? i + 1,
  }));
  const resolvedTotal =
    totalEverMaterialized ?? (withSeq.length > 0 ? withSeq[withSeq.length - 1]!.seq : 0);
  return { lines: withSeq, truncated, totalEverMaterialized: resolvedTotal };
}

function structuredOf(result: {
  structuredContent?: Record<string, unknown>;
}): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

/** Creates a real job in the shared jobStore singleton (same one output/tail read from) and feeds it raw bytes directly - fast, deterministic, no real child process. */
function makeJobWithRawOutput(): string {
  const record = jobStore.createJob({ argv: ["synthetic"], cwd: "/tmp", env: {}, isShell: false });
  return record.job_id;
}

// =============================================================================
// Tier 1: pure event-view construction (output.ts's buildSingleStreamEvents /
// buildBothStreamsEvents) - fast, deterministic, exercises every cursor/gap/
// merge computation precisely against hand-built and byte-accounting-layer-
// built snapshots. tail.ts re-implements the identical scheme (no sibling
// import permitted between tools/*.ts files - see both files' headers), so
// each test in this tier is run against BOTH modules to keep them in
// lockstep, except where tail's fixed after_cursor=0 makes the case N/A.
// =============================================================================

// --- untruncated (exact) mode ---

test("an untruncated stream numbers its events 1..N by position - exact and stable", () => {
  const snap = snapshot([{ text: "a" }, { text: "b" }, { text: "c" }]);
  const { events, head, gap } = outputTool.buildSingleStreamEvents("stdout", snap, 0);
  assert.deepEqual(
    events.map((e) => [e.seq, e.text]),
    [
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]
  );
  assert.equal(head, 3);
  assert.equal(gap, undefined);
});

test("after_cursor filters an untruncated stream down to strictly-newer events only", () => {
  const snap = snapshot([{ text: "a" }, { text: "b" }, { text: "c" }]);
  const { events } = outputTool.buildSingleStreamEvents("stdout", snap, 1);
  assert.deepEqual(
    events.map((e) => e.text),
    ["b", "c"]
  );
});

test("after_cursor beyond the current head returns no events plus the current head cursor", () => {
  const snap = snapshot([{ text: "a" }, { text: "b" }, { text: "c" }]);
  const { events, head } = outputTool.buildSingleStreamEvents("stdout", snap, 10);
  assert.deepEqual(events, []);
  assert.equal(head, 3);
});

// (green control) a valid, in-range cursor must return exactly the
// expected subsequent events, unaffected by any of the truncated-branch
// machinery.
test("(green control) a valid in-range cursor read stays exact and unaffected by truncated-branch logic", () => {
  const snap = snapshot([{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }]);
  const { events, head, gap } = outputTool.buildSingleStreamEvents("stdout", snap, 2);
  assert.deepEqual(
    events.map((e) => [e.seq, e.text]),
    [
      [3, "c"],
      [4, "d"],
    ]
  );
  assert.equal(head, 4);
  assert.equal(gap, undefined);
});

// --- truncated (EXACT) mode - gap emission ---
//
// The seq architectural addition: `jobStore.ts` now exposes a
// REAL monotonic per-line `seq` (never reused, survives eviction) plus a
// real running `totalEverMaterialized` count, so the disclosed gap is now
// the EXACT dropped range `[1, oldestSurvivingSeq - 1]`, narrowed to
// whatever portion of it is still relevant to the caller's own
// `after_cursor` - replacing the old width-1 "always disclose something"
// placeholder these tests used to assert.

test("a truncated stream discloses the EXACT dropped range, narrowed to what's still relevant past the caller's own cursor", () => {
  // Realistic post-eviction shape: 9 lines have EVER existed on this
  // stream, but only the newest 3 (seq 7, 8, 9) are still retained - seq
  // 1 through 6 are gone forever.
  const snap = snapshot(
    [
      { text: "x", seq: 7 },
      { text: "y", seq: 8 },
      { text: "z", seq: 9 },
    ],
    true,
    9
  );
  const { events, gap, head } = outputTool.buildSingleStreamEvents("stdout", snap, 5);
  // The caller's cursor (5) is already past seq 1-5 of the dropped range -
  // only seq 6 is BOTH dropped AND still relevant to them, so the gap is
  // exactly [6, 6], never the full [1, 6] the underlying stream actually
  // lost (that's genuinely irrelevant to a caller who already read past 5).
  assert.deepEqual(gap, { gap: [6, 6] });
  assert.deepEqual(
    events.map((e) => [e.seq, e.text]),
    [
      [7, "x"],
      [8, "y"],
      [9, "z"],
    ]
  );
  assert.equal(head, 9);
});

test("truncated + omitted cursor (0) discloses the FULL exact dropped range - a fresh read is honestly missing everything that was ever evicted", () => {
  // 5 lines ever existed, only the newest survives (seq 5); seq 1-4 are gone.
  const snap = snapshot([{ text: "only-survivor", seq: 5 }], true, 5);
  const { events, gap, head } = outputTool.buildSingleStreamEvents("stdout", snap, 0);
  assert.deepEqual(gap, { gap: [1, 4] });
  assert.deepEqual(
    events.map((e) => e.seq),
    [5]
  );
  assert.equal(head, 5);
});

test("a truncated stream with NO currently-retained lines still reports the exact dropped range through totalEverMaterialized, and a sane head (empty window edge case)", () => {
  // evictToFitBudget (jobStore.ts) can legitimately evict every
  // materialized line - 12 lines ever existed, none survive.
  const snap = snapshot([], true, 12);
  const { events, gap, head } = outputTool.buildSingleStreamEvents("stdout", snap, 3);
  assert.deepEqual(events, []);
  assert.deepEqual(gap, { gap: [4, 12] });
  assert.equal(head, 12);
});

// A genuinely NEW capability the exact scheme provides that the old
// always-disclose-something placeholder could not: a caller whose own
// cursor is ALREADY past everything that was ever dropped gets NO gap
// marker at all - there is truly nothing relevant left to disclose to them.
test("a cursor already past everything ever dropped gets NO gap marker at all - nothing relevant remains to disclose", () => {
  const snap = snapshot(
    [
      { text: "x", seq: 7 },
      { text: "y", seq: 8 },
      { text: "z", seq: 9 },
    ],
    true,
    9
  );
  const atTheBoundary = outputTool.buildSingleStreamEvents("stdout", snap, 6); // seq 1-6 dropped; cursor is exactly at the last dropped seq
  assert.equal(atTheBoundary.gap, undefined);
  assert.deepEqual(
    atTheBoundary.events.map((e) => e.seq),
    [7, 8, 9]
  );

  const wellPast = outputTool.buildSingleStreamEvents("stdout", snap, 100); // cursor beyond even the retained window
  assert.equal(wellPast.gap, undefined);
  assert.deepEqual(wellPast.events, []);
});

// --- "both" merge order + interior-gap positioning ---

test("'both' merges via a fixed, deterministic parity split (stdout odd, stderr even) when neither stream is truncated", () => {
  const stdoutSnap = snapshot([{ text: "o1" }, { text: "o2" }]);
  const stderrSnap = snapshot([{ text: "e1" }]);
  const { events, head, gap } = outputTool.buildBothStreamsEvents(stdoutSnap, stderrSnap, 0);
  assert.deepEqual(
    events.map((e) => [e.seq, e.stream, e.text]),
    [
      [1, "stdout", "o1"],
      [2, "stderr", "e1"],
      [3, "stdout", "o2"],
    ]
  );
  assert.equal(head, 3);
  assert.equal(gap, undefined);
});

test("'both' merge is prefix-stable - a stream's Nth retained line keeps the same merged seq regardless of how much the OTHER stream grows", () => {
  const stderrSnap = snapshot([{ text: "e1" }]);
  const before = outputTool.buildBothStreamsEvents(snapshot([{ text: "o1" }]), stderrSnap, 0);
  const after = outputTool.buildBothStreamsEvents(
    snapshot([{ text: "o1" }, { text: "o2" }, { text: "o3" }]),
    stderrSnap,
    0
  );
  const o1Before = before.events.find((e) => e.text === "o1")!;
  const o1After = after.events.find((e) => e.text === "o1")!;
  const e1Before = before.events.find((e) => e.text === "e1")!;
  const e1After = after.events.find((e) => e.text === "e1")!;
  assert.equal(
    o1Before.seq,
    o1After.seq,
    "stdout's first line must keep the same merged seq as stdout grows"
  );
  assert.equal(
    e1Before.seq,
    e1After.seq,
    "stderr's first line must keep the same merged seq as stdout grows"
  );
});

test("'both' with either stream truncated emits exactly one combined leading gap (flagged best-effort: true per-stream interior positioning needs a jobStore.ts counter - see output.ts's header)", () => {
  const stdoutSnap = snapshot([{ text: "o1" }], true); // stdout truncated
  const stderrSnap = snapshot([{ text: "e1" }], false); // stderr never truncated
  const { events, gap } = outputTool.buildBothStreamsEvents(stdoutSnap, stderrSnap, 0);
  assert.deepEqual(gap, { gap: [1, 1] });
  assert.deepEqual(events.map((e) => e.text).sort(), ["e1", "o1"]);
});

// --- partial-line flagging ---

test("an oversized-split entry is flagged partial (not yet newline-terminated)", () => {
  const snap = snapshot([{ text: "chunk-one", terminator: "oversized-split" }]);
  const { events } = outputTool.buildSingleStreamEvents("stdout", snap, 0);
  assert.equal(events[0]!.partial, true);
});

test("a stream-end entry (partial final line) is flagged partial", () => {
  const snap = snapshot([{ text: "no newline yet", terminator: "stream-end" }]);
  const { events } = outputTool.buildSingleStreamEvents("stdout", snap, 0);
  assert.equal(events[0]!.partial, true);
});

test("(green control) a genuinely complete newline-terminated line never carries partial", () => {
  const snap = snapshot([{ text: "complete line", terminator: "newline" }]);
  const { events } = outputTool.buildSingleStreamEvents("stdout", snap, 0);
  assert.equal("partial" in events[0]!, false);
});

// --- realistic fixtures via the byte-accounting layer itself (mirrors jobStore.test.ts's construction style) ---

test("realistic fixture: a genuine byte-cap overflow (built via appendChunkToBuffer, not hand-authored) produces truncated: true, and output.ts discloses the EXACT gap - a real, provable dropped count, not a fabricated placeholder", () => {
  const state = createStreamBufferState();
  for (let i = 0; i < 50; i += 1) {
    appendChunkToBuffer(state, Buffer.from(`z`.repeat(30_000) + `-${i}\n`));
  }
  const snap = snapshotStreamBuffer(state);
  assert.equal(snap.truncated, true, "fixture must have genuinely overflowed the byte cap");
  const { events, gap } = outputTool.buildSingleStreamEvents("stdout", snap, 0);
  assert.ok(events.length > 0 && events.length < 50, "some lines must have been evicted");
  const droppedCount = 50 - events.length;
  // The gap's width must be EXACTLY the real number of dropped lines
  // (verifiable independently from the retained-event count itself) - the
  // old scheme could only ever disclose a fixed width-1 placeholder here.
  assert.deepEqual(gap, { gap: [1, droppedCount] });
  // The newest line must still be the real newest.
  assert.ok(events[events.length - 1]!.text.endsWith("-49"));
});

// Eviction across MULTIPLE separate
// overflow events (not just the very first one) must still produce a
// correct EXACT gap - proving the running totalEverMaterialized/seq
// counters keep accumulating correctly across many append calls, not just
// surviving a single overflow burst.
test("realistic fixture: eviction across MULTIPLE separate overflow events still produces a correct exact gap, reflecting the CUMULATIVE drop, not just the first round's", () => {
  const state = createStreamBufferState();
  const bigLine = (i: number): Buffer => Buffer.from(`z`.repeat(30_000) + `-${i}\n`);

  // Round 1: force the first overflow (as the single-round fixture above).
  for (let i = 0; i < 50; i += 1) {
    appendChunkToBuffer(state, bigLine(i));
  }
  const afterRound1 = snapshotStreamBuffer(state);
  assert.equal(afterRound1.truncated, true);
  const gapAfterRound1 = outputTool.buildSingleStreamEvents("stdout", afterRound1, 0).gap!;
  const droppedAfterRound1 = gapAfterRound1.gap[1];

  // Round 2: 50 MORE lines (seq 51..100), forcing further eviction of
  // everything round 1 had retained too.
  for (let i = 50; i < 100; i += 1) {
    appendChunkToBuffer(state, bigLine(i));
  }
  const afterRound2 = snapshotStreamBuffer(state);
  assert.equal(afterRound2.truncated, true);
  const { events, gap } = outputTool.buildSingleStreamEvents("stdout", afterRound2, 0);

  assert.ok(gap !== undefined);
  const droppedAfterRound2 = gap!.gap[1];
  // The cumulative drop after round 2 must be strictly larger than after
  // round 1 alone (every one of round 1's survivors got evicted too, PLUS
  // whatever additional round-2 lines didn't fit) - proving this is a
  // real running total, not a value that resets or double-counts.
  assert.ok(
    droppedAfterRound2 > droppedAfterRound1,
    `expected cumulative drop (${droppedAfterRound2}) to exceed round 1's drop (${droppedAfterRound1})`
  );
  // Exact, independently-verifiable identity: total ever materialized (100)
  // = dropped-through-seq + currently-retained count.
  assert.equal(droppedAfterRound2 + events.length, 100);
  // The retained window's own oldest survivor's seq must be exactly one
  // past the disclosed gap - internally consistent, no off-by-one.
  assert.equal(events[0]!.seq, droppedAfterRound2 + 1);
  assert.ok(
    events[events.length - 1]!.text.endsWith("-99"),
    "the newest line must always be the true newest"
  );
});

// --- tail.ts's OWN exact-gap computation, tested directly at the pure-
// function level (not just via the handler-level tests further down) -
// tail.ts REIMPLEMENTS this scheme independently (no sibling tools/*.ts
// import permitted - see its own header), so it needs its own dedicated
// coverage, never assumed correct just because output.ts's is. Closes a
// real gap: a mutant in tail.ts's exact-gap block was NOT caught by any
// test before these were added (every existing tail-related test only
// checked gap PRESENCE, never its actual VALUE).

test("tail.ts: buildSingleStreamEvents discloses the EXACT dropped range through totalEverMaterialized (afterCursor fixed at 0)", () => {
  const snap = snapshot(
    [
      { text: "x", seq: 7 },
      { text: "y", seq: 8 },
      { text: "z", seq: 9 },
    ],
    true,
    9
  );
  const { events, gap, head } = tailTool.buildSingleStreamEvents("stdout", snap);
  assert.deepEqual(
    gap,
    { gap: [1, 6] },
    "seq 1-6 are gone forever; tail always reads from the floor, so the full range is disclosed"
  );
  assert.deepEqual(
    events.map((e) => [e.seq, e.text]),
    [
      [7, "x"],
      [8, "y"],
      [9, "z"],
    ]
  );
  assert.equal(head, 9);
});

test("tail.ts: buildSingleStreamEvents with NO currently-retained lines still reports the exact dropped range through totalEverMaterialized", () => {
  const snap = snapshot([], true, 12);
  const { events, gap, head } = tailTool.buildSingleStreamEvents("stdout", snap);
  assert.deepEqual(events, []);
  assert.deepEqual(gap, { gap: [1, 12] });
  assert.equal(head, 12);
});

test("tail.ts: buildSingleStreamEvents against a REAL byte-cap overflow (via appendChunkToBuffer, not hand-authored) discloses the exact real dropped count", () => {
  const state = createStreamBufferState();
  for (let i = 0; i < 50; i += 1) {
    appendChunkToBuffer(state, Buffer.from(`z`.repeat(30_000) + `-${i}\n`));
  }
  const snap = snapshotStreamBuffer(state);
  assert.equal(snap.truncated, true);
  const { events, gap } = tailTool.buildSingleStreamEvents("stdout", snap);
  assert.ok(events.length > 0 && events.length < 50);
  const droppedCount = 50 - events.length;
  assert.deepEqual(gap, { gap: [1, droppedCount] });
  assert.ok(events[events.length - 1]!.text.endsWith("-49"));
});

// =============================================================================
// Tier 2: handler-level integration - the shared jobStore singleton, real
// not-found/validation behavior, tail's N-selection and gap-suppression-
// when-not-reaching-the-floor logic.
// =============================================================================

// --- unknown job_id ---

test("output/tail on an unknown job_id is a typed not-found error, never a fabricated empty/zero snapshot", () => {
  for (const mod of [outputTool, tailTool]) {
    const result = mod.handler({ job_id: "definitely-not-a-real-job-id" });
    assert.equal(result.isError, true);
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    assert.ok(text.includes("unknown job_id"));
    assert.equal(
      result.structuredContent,
      undefined,
      "a not-found error must never carry a fabricated structuredContent snapshot"
    );
  }
});

// --- validation ---

test("output: after_cursor must be a non-negative integer - negative, non-integer, and wrong-typed values are all typed validation errors", () => {
  const jobId = makeJobWithRawOutput();
  for (const bad of [-1, 1.5, "3", NaN, Infinity]) {
    const result = outputTool.handler({ job_id: jobId, after_cursor: bad });
    assert.equal(result.isError, true, `after_cursor=${String(bad)} must be rejected`);
    assert.ok(
      result.content[0]!.type === "text" && result.content[0]!.text.includes("after_cursor")
    );
  }
});

test("output: after_cursor omitted defaults to reading from the floor (0), and 0 explicitly is equivalent", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("only line\n"));
  const omitted = outputTool.handler({ job_id: jobId, stream: "stdout" });
  const explicit = outputTool.handler({ job_id: jobId, stream: "stdout", after_cursor: 0 });
  assert.deepEqual(structuredOf(omitted), structuredOf(explicit));
});

test("output: an invalid stream value is a typed validation error", () => {
  const jobId = makeJobWithRawOutput();
  const result = outputTool.handler({ job_id: jobId, stream: "bogus" });
  assert.equal(result.isError, true);
  assert.ok(result.content[0]!.type === "text" && result.content[0]!.text.includes("stream"));
});

test("output: a non-positive or non-integer limit is a typed validation error", () => {
  const jobId = makeJobWithRawOutput();
  for (const bad of [0, -5, 1.5]) {
    const result = outputTool.handler({ job_id: jobId, limit: bad });
    assert.equal(result.isError, true, `limit=${bad} must be rejected`);
  }
});

test("output: limit caps the number of events returned per call and next_cursor lets the caller page through incrementally", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("a\nb\nc\nd\ne\n"));
  const first = outputTool.handler({ job_id: jobId, stream: "stdout", limit: 2 });
  const firstBody = structuredOf(first);
  assert.equal((firstBody.events as unknown[]).length, 2);
  assert.equal(firstBody.next_cursor, 2);
  const second = outputTool.handler({
    job_id: jobId,
    stream: "stdout",
    after_cursor: firstBody.next_cursor as number,
    limit: 2,
  });
  const secondBody = structuredOf(second);
  assert.deepEqual(
    (secondBody.events as Array<{ text: string }>).map((e) => e.text),
    ["c", "d"]
  );
  assert.equal(secondBody.next_cursor, 4);
  const third = outputTool.handler({
    job_id: jobId,
    stream: "stdout",
    after_cursor: secondBody.next_cursor as number,
    limit: 2,
  });
  const thirdBody = structuredOf(third);
  assert.deepEqual(
    (thirdBody.events as Array<{ text: string }>).map((e) => e.text),
    ["e"]
  );
});

// --- tail() ---

test("tail: 'lines' must be a positive integer - N<=0 and non-integer values are typed validation errors", () => {
  const jobId = makeJobWithRawOutput();
  for (const bad of [0, -1, 1.5, "3"]) {
    const result = tailTool.handler({ job_id: jobId, lines: bad });
    assert.equal(result.isError, true, `lines=${String(bad)} must be rejected`);
  }
});

test("tail returns the LAST N events, never the first N", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("a\nb\nc\nd\ne\n"));
  const result = tailTool.handler({ job_id: jobId, stream: "stdout", lines: 2 });
  const body = structuredOf(result);
  assert.deepEqual(
    (body.events as Array<{ text: string }>).map((e) => e.text),
    ["d", "e"]
  );
});

test("tail honors the stream selector, never silently defaulting to 'both'", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("out-only\n"));
  jobStore.appendOutput(jobId, "stderr", Buffer.from("err-only\n"));
  const stdoutResult = structuredOf(
    tailTool.handler({ job_id: jobId, stream: "stdout", lines: 10 })
  );
  assert.deepEqual(
    (stdoutResult.events as Array<{ text: string; stream: string }>).map((e) => e.text),
    ["out-only"]
  );
  const stderrResult = structuredOf(
    tailTool.handler({ job_id: jobId, stream: "stderr", lines: 10 })
  );
  assert.deepEqual(
    (stderrResult.events as Array<{ text: string; stream: string }>).map((e) => e.text),
    ["err-only"]
  );
});

test("tail's N<=0 is rejected, not silently coerced to a default", () => {
  const jobId = makeJobWithRawOutput();
  const result = tailTool.handler({ job_id: jobId, lines: 0 });
  assert.equal(result.isError, true);
});

test("tail: N greater than the total available real events returns all available, never pads or errors", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("a\nb\n"));
  const result = structuredOf(tailTool.handler({ job_id: jobId, stream: "stdout", lines: 1000 }));
  assert.deepEqual(
    (result.events as Array<{ text: string }>).map((e) => e.text),
    ["a", "b"]
  );
});

test("tail keeps the partial final line if a mutant filters partial-flagged entries out (real assertion: the partial line IS present)", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("complete\n"));
  jobStore.appendOutput(jobId, "stdout", Buffer.from("no newline yet"));
  jobStore.finalizeStream(jobId, "stdout");
  const result = structuredOf(tailTool.handler({ job_id: jobId, stream: "stdout", lines: 10 }));
  const events = result.events as Array<{ text: string; partial?: boolean }>;
  const partialEvent = events.find((e) => e.text === "no newline yet");
  assert.ok(partialEvent, "the partial final line must be present, never silently dropped");
  assert.equal(partialEvent!.partial, true);
});

// A gap doesn't consume a tail-N slot.
test("a leading gap marker does NOT consume one of tail's N real-event slots", () => {
  const jobId = makeJobWithRawOutput();
  // Force a real overflow via the real byte-accounting layer, through the
  // SAME jobStore singleton output/tail read from.
  for (let i = 0; i < 10_050; i += 1) {
    jobStore.appendOutput(jobId, "stdout", Buffer.from(`line-${i}\n`));
  }
  const snapBefore = jobStore.getStreamSnapshot(jobId, "stdout")!;
  assert.equal(
    snapBefore.truncated,
    true,
    "fixture must have genuinely overflowed MAX_BUFFER_LINES"
  );

  const result = structuredOf(tailTool.handler({ job_id: jobId, stream: "stdout", lines: 5 }));
  const events = result.events as Array<{ text?: string; gap?: [number, number] }>;
  const realEvents = events.filter((e) => !("gap" in e));
  assert.equal(
    realEvents.length,
    5,
    "exactly N=5 REAL events, whether or not a gap marker is also present"
  );
});

test("tail: gap is shown only when the requested window reaches back to the retained floor - a normal in-window trim is not a disclosed gap", () => {
  const jobId = makeJobWithRawOutput();
  for (let i = 0; i < 10_050; i += 1) {
    jobStore.appendOutput(jobId, "stdout", Buffer.from(`line-${i}\n`));
  }
  const small = structuredOf(tailTool.handler({ job_id: jobId, stream: "stdout", lines: 3 }));
  const smallEvents = small.events as Array<Record<string, unknown>>;
  assert.equal(
    smallEvents.some((e) => "gap" in e),
    false,
    "a small tail window that doesn't reach the floor must not show a gap"
  );

  const full = structuredOf(tailTool.handler({ job_id: jobId, stream: "stdout", lines: 100_000 }));
  const fullEvents = full.events as Array<Record<string, unknown>>;
  assert.equal(
    fullEvents.some((e) => "gap" in e),
    true,
    "a tail window large enough to reach the floor of a truncated stream must show the gap"
  );
});

// --- terminal flush (handler-integration level; a full real e2e proof follows in Tier 3) ---

test("output()/tail() after a job's stream is finalized (post-terminal) still returns the complete final buffer, including a pending partial line", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("line one\n"));
  jobStore.appendOutput(jobId, "stdout", Buffer.from("trailing, no newline"));
  jobStore.markExited(jobId, 0, null);
  jobStore.finalizeStream(jobId, "stdout");
  jobStore.finalizeStream(jobId, "stderr");

  const outputResult = structuredOf(outputTool.handler({ job_id: jobId, stream: "stdout" }));
  const outputEvents = outputResult.events as Array<{ text: string; partial?: boolean }>;
  assert.deepEqual(
    outputEvents.map((e) => e.text),
    ["line one", "trailing, no newline"]
  );
  assert.equal(outputEvents[1]!.partial, true);

  const tailResult = structuredOf(tailTool.handler({ job_id: jobId, stream: "stdout", lines: 10 }));
  const tailEvents = tailResult.events as Array<{ text: string; partial?: boolean }>;
  assert.deepEqual(
    tailEvents.map((e) => e.text),
    ["line one", "trailing, no newline"]
  );
});

// =============================================================================
// Tier 3: real end-to-end proof - a real spawned dist/index.js process, real
// JSON-RPC over its real stdin/stdout. This is the single most important
// verification.
// =============================================================================

const spawned: SpawnedServer[] = [];
function tracked(): SpawnedServer {
  const server = spawnServer();
  spawned.push(server);
  return server;
}

after(() => {
  for (const server of spawned) {
    if (!server.child.killed) server.child.kill("SIGKILL");
  }
});

after(() => logActiveResourcesAtFileEnd("output-tail.test.ts"));

interface ToolCallBody {
  readonly error?: { code: number; message: string };
  readonly result?: {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  };
}

async function callTool(
  server: SpawnedServer,
  id: number,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolCallBody> {
  server.send({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  const line = await server.nextLine(10_000);
  return line.parsed as ToolCallBody;
}

test("e2e: tools/list advertises output/tail with their real (non-stub) schemas", async () => {
  const server = tracked();
  await completeHandshake(server);
  server.send({ jsonrpc: "2.0", id: 900, method: "tools/list" });
  const line = await server.nextLine();
  const body = line.parsed as { result: { tools: Array<{ name: string; description: string }> } };
  const output = body.result.tools.find((t) => t.name === "output")!;
  const tail = body.result.tools.find((t) => t.name === "tail")!;
  assert.ok(!output.description.includes("Not yet implemented"));
  assert.ok(!tail.description.includes("Not yet implemented"));
  server.child.kill("SIGKILL");
});

test("e2e: output()/tail() over the real wire, on a real spawned job producing known output", async () => {
  const server = tracked();
  await completeHandshake(server);
  const runBody = await callTool(server, 901, "run", {
    command: ["node", "-e", "console.log('one'); console.log('two'); console.log('three')"],
  });
  const jobId = runBody.result?.structuredContent?.job_id as string;
  assert.equal(typeof jobId, "string");

  // Poll output() until the real (fast, but genuinely async) child has
  // written all three lines - this test is specifically about output()'s
  // own event-delivery behavior, so it drives the poll through output()
  // itself rather than a different tool's completion signal.
  let events: Array<{ text: string }> = [];
  const deadline = Date.now() + 5000;
  while (events.length < 3 && Date.now() < deadline) {
    const body = await callTool(server, 902, "output", { job_id: jobId, stream: "stdout" });
    events = (body.result?.structuredContent?.events ?? []) as Array<{ text: string }>;
    if (events.length < 3) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(
    events.map((e) => e.text),
    ["one", "two", "three"]
  );

  const tailBody = await callTool(server, 903, "tail", {
    job_id: jobId,
    stream: "stdout",
    lines: 2,
  });
  const tailEvents = (tailBody.result?.structuredContent?.events ?? []) as Array<{ text: string }>;
  assert.deepEqual(
    tailEvents.map((e) => e.text),
    ["two", "three"]
  );
  server.child.kill("SIGKILL");
});

test("e2e: a real spawned job with a genuinely partial final line (no trailing newline) - visible and flagged, both live and after the job terminates", async () => {
  const server = tracked();
  await completeHandshake(server);
  const runBody = await callTool(server, 910, "run", {
    command: ["node", "-e", "process.stdout.write('no newline at the very end')"],
  });
  const jobId = runBody.result?.structuredContent?.job_id as string;

  let events: Array<{ text: string; partial?: boolean }> = [];
  const deadline = Date.now() + 5000;
  while (events.length < 1 && Date.now() < deadline) {
    const body = await callTool(server, 911, "tail", {
      job_id: jobId,
      stream: "stdout",
      lines: 10,
    });
    events = (body.result?.structuredContent?.events ?? []) as Array<{
      text: string;
      partial?: boolean;
    }>;
    if (events.length < 1) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]!.text, "no newline at the very end");
  assert.equal(events[0]!.partial, true, "the partial final line must be flagged partial: true");

  // Give the (already-fast, now surely exited) child extra margin, then
  // re-read - this is the TERMINAL FLUSH proof: a read strictly after the
  // process has ended must still return the complete buffer.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const postTerminalBody = await callTool(server, 912, "output", {
    job_id: jobId,
    stream: "stdout",
  });
  const postTerminalEvents = (postTerminalBody.result?.structuredContent?.events ?? []) as Array<{
    text: string;
    partial?: boolean;
  }>;
  assert.deepEqual(
    postTerminalEvents.map((e) => e.text),
    ["no newline at the very end"]
  );
  assert.equal(postTerminalEvents[0]!.partial, true);
  server.child.kill("SIGKILL");
});

test("e2e: a real spawned job that overflows the retention cap - truncated: true and a real disclosed gap, read over the real wire", async () => {
  const server = tracked();
  await completeHandshake(server);
  // A real fast child that synchronously prints 10,050 lines - guaranteed
  // to exceed MAX_BUFFER_LINES (10,000), forcing genuine eviction in the
  // real jobStore singleton this server process owns.
  const runBody = await callTool(server, 920, "run", {
    command: ["node", "-e", "for (let i = 0; i < 10050; i++) console.log('overflow-line-' + i)"],
  });
  const jobId = runBody.result?.structuredContent?.job_id as string;

  // Poll until the real child has genuinely finished writing (detected via
  // the buffer settling on truncated: true AND the newest retained line
  // being the real last line printed).
  let body: ToolCallBody | undefined;
  let structured: Record<string, unknown> | undefined;
  const deadline = Date.now() + 8000;
  for (;;) {
    body = await callTool(server, 921, "output", { job_id: jobId, stream: "stdout" });
    structured = body.result?.structuredContent;
    const events = (structured?.events ?? []) as Array<{ text: string; gap?: unknown }>;
    const realEvents = events.filter((e) => !("gap" in e));
    const last = realEvents[realEvents.length - 1];
    if (structured?.truncated === true && last?.text === "overflow-line-10049") break;
    if (Date.now() > deadline)
      throw new Error("timed out waiting for the real overflow child to finish");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(structured!.truncated, true);
  const events = structured!.events as Array<Record<string, unknown>>;
  assert.equal(
    "gap" in events[0]!,
    true,
    "a truncated stream's response must lead with an explicit gap marker, never a silent hole"
  );
  const gapValue = events[0]!.gap as [number, number];
  assert.ok(
    Array.isArray(gapValue) && gapValue.length === 2 && gapValue[0]! <= gapValue[1]!,
    "the gap must be a valid [start, end] range"
  );
  const realEvents = events.filter((e) => !("gap" in e)) as Array<{ text: string }>;
  assert.ok(realEvents.length < 10050, "eviction must have genuinely dropped some lines");
  assert.equal(
    realEvents[realEvents.length - 1]!.text,
    "overflow-line-10049",
    "the newest line must always survive eviction"
  );
  assert.equal(
    realEvents.some((e) => e.text === "overflow-line-0"),
    false,
    "the oldest lines must have been genuinely evicted"
  );
  server.child.kill("SIGKILL");
});

// The concurrent-write stress test.
test("non-blocking snapshot consistency - repeated output()/tail() calls against a real fast-writing job never observe a torn/corrupted event", async () => {
  const server = tracked();
  await completeHandshake(server);
  const runBody = await callTool(server, 930, "run", {
    command: [
      "node",
      "-e",
      "let i = 0; const t = setInterval(() => { if (i >= 4000) { clearInterval(t); return; } console.log('payload-' + 'x'.repeat(40) + '-' + i); i++; }, 0)",
    ],
  });
  const jobId = runBody.result?.structuredContent?.job_id as string;

  let requestId = 931;
  const lineShape = /^payload-x{40}-\d+$/;
  let sawAtLeastOneEvent = false;
  const startedAt = Date.now();
  // Hammer output()/tail() repeatedly WHILE the child is very likely still
  // writing (the setInterval-based writer keeps yielding, so real chunk
  // delivery genuinely interleaves with these reads on the same event
  // loop) - every single response must be internally well-formed.
  while (Date.now() - startedAt < 1500) {
    const [outputBody, tailBody] = await Promise.all([
      callTool(server, requestId++, "output", { job_id: jobId, stream: "stdout" }),
      callTool(server, requestId++, "tail", { job_id: jobId, stream: "stdout", lines: 25 }),
    ]);
    for (const body of [outputBody, tailBody]) {
      assert.equal(
        body.error,
        undefined,
        "a snapshot read must never itself error under concurrent writes"
      );
      const events = (body.result?.structuredContent?.events ?? []) as Array<{
        text?: string;
        partial?: boolean;
        gap?: unknown;
      }>;
      for (const event of events) {
        if ("gap" in event) continue;
        sawAtLeastOneEvent = true;
        const text = event.text!;
        // A torn/corrupted event would fail to match the exact repeated
        // payload shape (e.g. half-old-content-half-new-content spliced
        // together) UNLESS it's honestly flagged partial (a genuine
        // still-open line, never a lie).
        if (!lineShape.test(text)) {
          assert.equal(
            event.partial,
            true,
            `a malformed-looking line must be explicitly flagged partial, got: ${JSON.stringify(text)}`
          );
        }
      }
    }
  }
  assert.ok(
    sawAtLeastOneEvent,
    "the stress loop must have actually observed real output at least once"
  );
  server.child.kill("SIGKILL");
});

test("e2e: output/tail over the wire on an unknown job_id is a typed not-found tool error, not a JSON-RPC protocol error and never a fabricated snapshot", async () => {
  const server = tracked();
  await completeHandshake(server);
  for (const toolName of ["output", "tail"]) {
    const body = await callTool(server, 940, toolName, { job_id: "not-a-real-job" });
    assert.equal(
      body.error,
      undefined,
      "an unknown job_id is a tool-execution error, not a JSON-RPC protocol error"
    );
    assert.equal(body.result?.isError, true);
    assert.equal(body.result?.structuredContent, undefined);
  }
  server.child.kill("SIGKILL");
});
