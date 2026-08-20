import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, test } from "node:test";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import {
  appendChunkToBuffer,
  createStreamBufferState,
  jobStore,
  snapshotStreamBuffer,
} from "../dist/jobStore.js";
import { DEFAULT_MAX_RETAINED_JOBS, DEFAULT_RETENTION_MS } from "../dist/scheduler.js";
import * as outputTool from "../dist/tools/output.js";
import * as tailTool from "../dist/tools/tail.js";
import * as runTool from "../dist/tools/run.js";

// Explicit ".ts" extension - see test/e2e-server.test.ts's import comment
// for why spawnServer.ts is imported this way.
import { type SpawnedServer, completeHandshake, spawnServer } from "./helpers/spawnServer.ts";
import { requireSpawnPolicy } from "./helpers/requireSpawnPolicy.ts";

// Only the "non-blocking snapshot consistency, HARDENED" test (Tier 2.5)
// and the `run`-driven end-to-end tests in Tier 3 below dispatch `run`
// through the real spawn-policy gate - see test/helpers/requireSpawnPolicy.ts
// for what this checks and why. Most other tests in this file build a
// synthetic job directly via makeJobWithRawOutput() or a hand-built
// snapshot and never touch policy at all; two tests near the end of the
// file (the "tools/list advertises output/tail" e2e test and the unknown-
// job_id e2e test) DO start a real spawned server, but only call
// `tools/list`/`output`/`tail` over it, never `run` - `spawnServer()` itself
// bypasses `run`'s policy gate, so those two need the guard exactly as
// little as the synthetic-job tests do. The guard is scoped locally to just
// the two genuinely `run`-dispatching sections' own describe() blocks
// below, instead of running once file-wide: node:test scopes a
// describe()-level before() hook to only the tests nested inside that
// describe(), so a missing or invalid policy fails ONLY the tests that
// genuinely spawn a real job through `run`, leaving every other test in
// this file unaffected.

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/**
 * A hand-built StreamBufferSnapshot - the exact shape jobStore.getStreamSnapshot
 * returns: real per-line `seq` (a per-JOB GLOBAL value - see jobStore.ts's
 * `JobSeqCounter` docs), `headSeq` (the highest seq ever assigned to a line
 * on THIS stream, persisting through eviction), and `droppedCount` (how
 * many discrete loss events THIS stream has ever suffered - an evicted
 * line, a discarded pending fragment, or a chunk arriving after the
 * job's output was already reclaimed, per job-output retention; see
 * `StreamBufferSnapshot.droppedCount`'s own docs in jobStore.ts for why
 * v1 discloses a bounded COUNT and a cursor boundary, never an exact
 * per-seq range - this file's own fixtures below construct only the
 * evicted-line case, since that is the shape ordinary byte/line-cap
 * eviction produces). Each line's `seq` defaults to its 1-based array position
 * (correct for a SINGLE-stream, UNTRUNCATED fixture, where nothing has
 * ever been evicted and no sibling stream shares the counter), but can be
 * overridden per-line to simulate a REALISTIC post-eviction scenario
 * (surviving lines' seq values starting well above 1) or a REALISTIC
 * interleaved "both"-mode scenario (non-colliding seq values shared with a
 * sibling stream's own snapshot - see the "both" fixtures below, which
 * always pass explicit `seq` values for exactly this reason). `headSeq`
 * similarly defaults to the last line's own seq (again, correct only when
 * nothing has been evicted and this stream owns the trailing edge of the
 * counter) and can be overridden to simulate "seq N was the highest this
 * stream ever produced, only the newest few lines survived". `droppedCount`
 * defaults to 0 (nothing ever dropped) and can be overridden explicitly to
 * simulate a stream that has genuinely evicted some of its own lines.
 */
function snapshot(
  lines: Array<{
    text: string;
    terminator?: "newline" | "oversized-split" | "stream-end";
    seq?: number;
  }>,
  truncated = false,
  headSeq?: number,
  droppedCount = 0
) {
  const withSeq = lines.map((l, i) => ({
    text: l.text,
    terminator: l.terminator ?? ("newline" as const),
    seq: l.seq ?? i + 1,
  }));
  const resolvedHead = headSeq ?? (withSeq.length > 0 ? withSeq[withSeq.length - 1]!.seq : 0);
  return { lines: withSeq, truncated, headSeq: resolvedHead, droppedCount };
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

/** Builds a genuine ~600KB single-line chunk (well under MAX_LINE_BYTES, but two together exceed MAX_BUFFER_BYTES) - real bytes, not a synthetic fixture. */
function bigStreamLine(tag: string): Buffer {
  return Buffer.from(tag.repeat(600_001) + "\n");
}

/** A real `pgrep -g <pgid>` call - see test/kill.test.ts's/test/jobStore.test.ts's identical helper for the full rationale. Returns the real pids found, `[]` when pgrep finds none (its own documented exit code 1). */
function pgrepGroupMembers(pgid: number): number[] {
  try {
    const output = execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(Number);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number };
    if (err.status === 1) return []; // pgrep's own "nothing matched" exit code - a real, expected zero-survivors result
    throw error;
  }
}

// =============================================================================
// Tier 1: pure event-view construction (output.ts's buildSingleStreamEvents /
// buildBothStreamsEvents) - fast, deterministic, exercises every cursor/drop-
// disclosure/merge computation precisely against hand-built and byte-
// accounting-layer-built snapshots. tail.ts re-implements the identical
// scheme (no sibling import permitted between tools/*.ts files - see both
// files' headers), so each test in this tier is run against BOTH modules to
// keep them in lockstep, except where tail's fixed n-from-floor makes the
// case N/A.
// =============================================================================

// --- untruncated (nothing ever dropped) mode ---

test("an untruncated stream numbers its events 1..N by position - exact and stable, and dropped stays 0", () => {
  const snap = snapshot([{ text: "a" }, { text: "b" }, { text: "c" }]);
  const { events, head, drop } = outputTool.buildSingleStreamEvents("stdout", snap, 0);
  assert.deepEqual(
    events.map((e) => [e.seq, e.text]),
    [
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]
  );
  assert.equal(head, 3);
  assert.deepEqual(drop, { dropped: 0, droppedBeforeCursor: 1 });
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
// expected subsequent events, unaffected by anything drop-related.
test("(green control) a valid in-range cursor read stays exact, with dropped staying 0", () => {
  const snap = snapshot([{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }]);
  const { events, head, drop } = outputTool.buildSingleStreamEvents("stdout", snap, 2);
  assert.deepEqual(
    events.map((e) => [e.seq, e.text]),
    [
      [3, "c"],
      [4, "d"],
    ]
  );
  assert.equal(head, 4);
  assert.equal(drop.dropped, 0);
});

// --- truncated mode - bounded drop disclosure ---
//
// v1 deliberately never claims WHICH seq values were dropped (see
// jobStore.ts's own `StreamBufferSnapshot.droppedCount` docs for why the
// earlier exact-per-seq-range design was scrapped): a response only ever
// carries a bounded COUNT (`dropped`) and a cursor boundary
// (`droppedBeforeCursor`, this stream's own current retained floor). Both
// are facts about the STREAM's whole life, never scoped or filtered by the
// caller's own `after_cursor` - a deliberate simplification over the old
// exact-range design, which suppressed a gap marker once the cursor moved
// past it.

test("a truncated stream discloses dropped count and droppedBeforeCursor, independent of the caller's own cursor", () => {
  // Realistic post-eviction shape: 6 lines were dropped, the newest 3
  // (seq 7, 8, 9) are still retained.
  const snap = snapshot(
    [
      { text: "x", seq: 7 },
      { text: "y", seq: 8 },
      { text: "z", seq: 9 },
    ],
    true,
    9,
    6
  );
  const fresh = outputTool.buildSingleStreamEvents("stdout", snap, 0);
  assert.deepEqual(fresh.drop, { dropped: 6, droppedBeforeCursor: 7 });
  assert.deepEqual(
    fresh.events.map((e) => [e.seq, e.text]),
    [
      [7, "x"],
      [8, "y"],
      [9, "z"],
    ]
  );
  assert.equal(fresh.head, 9);

  // A caller reading from far past the drop still sees the IDENTICAL drop
  // disclosure - a fact about the stream, never filtered by cursor (unlike
  // the earlier exact-range design, which stopped disclosing a gap once
  // the caller's own cursor was already past it).
  const pastCursor = outputTool.buildSingleStreamEvents("stdout", snap, 100);
  assert.deepEqual(pastCursor.drop, { dropped: 6, droppedBeforeCursor: 7 });
});

test("a truncated stream with NO currently-retained lines reports droppedBeforeCursor through headSeq", () => {
  // evictToFitBudget (jobStore.ts) can legitimately evict every
  // materialized line - 12 lines ever existed, none survive.
  const snap = snapshot([], true, 12, 12);
  const { events, drop, head } = outputTool.buildSingleStreamEvents("stdout", snap, 3);
  assert.deepEqual(events, []);
  assert.deepEqual(drop, { dropped: 12, droppedBeforeCursor: 12 });
  assert.equal(head, 12);
});

// --- no fabrication (structural) ---
//
// The proven real bug the earlier exact-range design kept reintroducing:
// a single-stream disclosure that names a seq value belonging to a
// still-retained SIBLING stream. Under the v1 bounded-count design this is
// now impossible BY CONSTRUCTION - a count and a boundary never name a
// seq at all - so these tests confirm each stream's own disclosure only
// ever reflects its own droppedCount, never a sibling's activity.

test("(no fabrication, structural) a stream's own drop disclosure reflects only its own droppedCount, never a sibling snapshot's", () => {
  const stdoutSnap = snapshot([{ text: "o-3", seq: 3 }], true, 3, 1); // stdout's own 1 eviction
  const stderrSnap = snapshot([{ text: "e-2", seq: 2 }], false, undefined, 0); // stderr never evicted
  const stdoutView = outputTool.buildSingleStreamEvents("stdout", stdoutSnap, 0);
  const stderrView = outputTool.buildSingleStreamEvents("stderr", stderrSnap, 0);
  assert.deepEqual(stdoutView.drop, { dropped: 1, droppedBeforeCursor: 3 });
  assert.deepEqual(stderrView.drop, { dropped: 0, droppedBeforeCursor: 2 });
});

test("tail.ts: a stream's own drop disclosure reflects only its own droppedCount, never a sibling snapshot's - same fix, tail's own reimplementation", () => {
  const snap = snapshot([{ text: "o-3", seq: 3 }], true, 3, 1);
  const { events, drop, head } = tailTool.buildSingleStreamEvents("stdout", snap, 100);
  assert.deepEqual(drop, { dropped: 1, droppedBeforeCursor: 3 });
  assert.deepEqual(
    events.map((e) => e.seq),
    [3]
  );
  assert.equal(head, 3);
});

// --- the DEEPER no-fabrication proof: real production eviction machinery,
// never a hand-built snapshot, since the fabrication risk the earlier
// per-seq-range design had lived in whether jobStore.ts's own tracking
// produced the right SHAPE, not merely in how output.ts/tail.ts consumed
// it. Every fixture below drives real ~600KB chunks so the SAME
// single-stream byte cap (MAX_BUFFER_BYTES, 1 MiB) genuinely evicts a
// stream's own oldest line each time a second ~600KB line lands.

test("REGRESSION: drop-count accuracy under a REAL multi-eviction, cross-stream-interleaved scenario - built through real JobStore eviction, never a hand-authored synthetic snapshot", () => {
  const jobId = makeJobWithRawOutput();
  // seq 1 (stdout, alone, no eviction yet)
  jobStore.appendOutput(jobId, "stdout", bigStreamLine("a"));
  // seq 2 (stderr, retained forever - never touched again)
  jobStore.appendOutput(jobId, "stderr", Buffer.from("e2\n"));
  // seq 3 (stdout) - stdout's own two lines together now exceed the 1 MiB
  // cap, so stdout's OWN real eviction loop evicts its OWN oldest line
  // (seq 1), retaining only seq 3. stdout's own droppedCount is now 1.
  jobStore.appendOutput(jobId, "stdout", bigStreamLine("c"));
  // seq 4 (stderr, also retained)
  jobStore.appendOutput(jobId, "stderr", Buffer.from("e4\n"));
  // seq 5 (stdout) - evicts stdout's own seq-3 line the same way, retaining
  // only seq 5. stdout's own droppedCount is now 2 - never conflated with
  // stderr's own untouched activity.
  jobStore.appendOutput(jobId, "stdout", bigStreamLine("e"));

  const stdoutSnapshot = jobStore.getStreamSnapshot(jobId, "stdout")!;
  assert.equal(stdoutSnapshot.lines.length, 1, "only the newest stdout line (seq 5) survives");
  assert.equal(stdoutSnapshot.lines[0]!.seq, 5);
  assert.equal(stdoutSnapshot.truncated, true);
  assert.equal(
    stdoutSnapshot.droppedCount,
    2,
    "stdout must have evicted exactly its own two oldest lines (seq 1 and 3), never counting stderr's own untouched activity"
  );
  const stderrSnapshot = jobStore.getStreamSnapshot(jobId, "stderr")!;
  assert.deepEqual(
    stderrSnapshot.lines.map((l) => l.seq),
    [2, 4],
    "stderr's own seq 2 and 4 must both still be alive - never evicted by anything"
  );
  assert.equal(stderrSnapshot.droppedCount, 0, "stderr never had a line evicted");

  const result = structuredOf(outputTool.handler({ job_id: jobId, stream: "stdout" }));
  assert.equal(result.dropped, 2);
  assert.equal(
    result.droppedBeforeCursor,
    5,
    "the current retained floor is stdout's only surviving line, seq 5"
  );
  const events = result.events as Array<{ seq: number }>;
  assert.deepEqual(
    events.map((e) => e.seq),
    [5]
  );

  // No fabrication, end to end: reading "both" over the same span must
  // still return stderr's genuinely-alive seq 2 and 4 - stdout's own drop
  // disclosure cannot even NAME a seq, so this is impossible by
  // construction, verified anyway as a real regression - and stderr must
  // be OMITTED from the "dropped" object entirely, since it never lost
  // anything.
  const both = structuredOf(outputTool.handler({ job_id: jobId, stream: "both" }));
  const bothEvents = both.events as Array<{ seq: number; stream: string }>;
  assert.deepEqual(
    bothEvents.map((e) => [e.seq, e.stream]),
    [
      [2, "stderr"],
      [4, "stderr"],
      [5, "stdout"],
    ]
  );
  assert.deepEqual(
    both.dropped,
    { stdout: { dropped: 2, droppedBeforeCursor: 5 } },
    "stderr must be omitted entirely from the dropped object - it never lost anything"
  );
});

test("no-fabrication regression: a fresh 'both' read from the floor never omits a sibling's still-retained event, even when the other stream separately evicted data spanning the same seq range", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", bigStreamLine("a")); // seq 1
  jobStore.appendOutput(jobId, "stderr", Buffer.from("e2\n")); // seq 2, retained forever
  jobStore.appendOutput(jobId, "stdout", bigStreamLine("c")); // seq 3, evicts seq 1
  jobStore.appendOutput(jobId, "stderr", Buffer.from("e4\n")); // seq 4, retained forever

  const stdoutRead = structuredOf(outputTool.handler({ job_id: jobId, stream: "stdout" }));
  assert.equal(
    stdoutRead.next_cursor,
    3,
    "stdout's own true head is its only surviving event's seq"
  );

  // A FRESH "both" read starting from the floor (after_cursor:0, NOT a
  // reused stdout cursor - a single-stream cursor is scoped to that stream's
  // own selection and is not safe to replay against "both", see this
  // file's/output.ts's own docs on cursor scope) must still surface
  // stderr's seq 2 and seq 4 - they sit numerically inside the span stdout
  // itself lost data in (seq 1..3), yet were never stdout's own to drop.
  const bothReplay = structuredOf(
    outputTool.handler({ job_id: jobId, stream: "both", after_cursor: 0 })
  );
  const events = bothReplay.events as Array<{ seq: number; stream: string }>;
  assert.ok(
    events.some((e) => e.seq === 2 && e.stream === "stderr"),
    "stderr's still-retained seq 2 must be returned, never swallowed by stdout's own drop"
  );
  assert.ok(
    events.some((e) => e.seq === 4 && e.stream === "stderr"),
    "stderr's still-retained seq 4 must be returned"
  );
});

test("cursor scope regression: reusing a single-stream cursor with a DIFFERENT stream selection can skip a still-retained sibling event - the documented reason cross-selector reuse is unsupported", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("o1\n")); // seq 1
  jobStore.appendOutput(jobId, "stderr", Buffer.from("e2\n")); // seq 2, retained
  jobStore.appendOutput(jobId, "stdout", Buffer.from("o3\n")); // seq 3

  const stdoutRead = structuredOf(outputTool.handler({ job_id: jobId, stream: "stdout" }));
  assert.equal(stdoutRead.next_cursor, 3, "stdout's own next_cursor is its own last seq");

  // Reusing STDOUT's own next_cursor (3) with a DIFFERENT selector ("both")
  // silently skips stderr's still-retained seq 2, since a single-stream
  // cursor carries no information about what a sibling stream has or
  // hasn't disclosed - this is exactly why cursor reuse is scoped to the
  // SAME stream selection that produced it (see output.ts's own docs).
  const crossSelectorReplay = structuredOf(
    outputTool.handler({
      job_id: jobId,
      stream: "both",
      after_cursor: stdoutRead.next_cursor as number,
    })
  );
  const events = crossSelectorReplay.events as Array<{ seq: number; stream: string }>;
  assert.equal(
    events.length,
    0,
    "reusing a stdout-only cursor with 'both' skips stderr's still-retained seq 2 entirely - documented, unsupported behavior, not a bug"
  );

  // The honest, supported way to switch selections: start fresh.
  const freshBothRead = structuredOf(
    outputTool.handler({ job_id: jobId, stream: "both", after_cursor: 0 })
  );
  const freshEvents = freshBothRead.events as Array<{ seq: number; stream: string }>;
  assert.ok(
    freshEvents.some((e) => e.seq === 2 && e.stream === "stderr"),
    "starting fresh (after_cursor:0) when switching selections correctly surfaces stderr's seq 2"
  );
});

// --- "both" merge order + independent per-stream drop disclosure ---
//
// jobStore.ts assigns `seq` from ONE counter shared across a job's stdout
// AND stderr (see JobSeqCounter's own docs), so a "both" fixture below
// always hand-authors REALISTIC, non-colliding, interleaved `seq` values
// across its stdout/stderr snapshot pair - exactly what a real job would
// produce, never each stream independently defaulting to 1, 2, 3... (which
// would fabricate an impossible collision under the real shared counter).

test("'both' merges by REAL seq (never a synthetic parity split) - real interleaved arrival order, stable and exact", () => {
  // Realistic interleave: stdout produced seq 1 and 3, stderr produced
  // seq 2 and 4 - exactly the shape a shared per-job counter yields.
  const stdoutSnap = snapshot([
    { text: "o1", seq: 1 },
    { text: "o2", seq: 3 },
  ]);
  const stderrSnap = snapshot([
    { text: "e1", seq: 2 },
    { text: "e2", seq: 4 },
  ]);
  const { events, head, stdoutDrop, stderrDrop } = outputTool.buildBothStreamsEvents(
    stdoutSnap,
    stderrSnap,
    0
  );
  assert.deepEqual(
    events.map((e) => [e.seq, e.stream, e.text]),
    [
      [1, "stdout", "o1"],
      [2, "stderr", "e1"],
      [3, "stdout", "o2"],
      [4, "stderr", "e2"],
    ]
  );
  assert.equal(head, 4);
  assert.equal(stdoutDrop.dropped, 0);
  assert.equal(stderrDrop.dropped, 0);
});

test("'both': each stream's own dropped/droppedBeforeCursor stays fully independent, never a merged/shared boundary", () => {
  const stdoutSnap = snapshot([{ text: "o-3", seq: 3 }], true, 3, 1);
  const stderrSnap = snapshot([{ text: "e-4", seq: 4 }], true, 4, 2); // a DIFFERENT dropped count
  const { events, head, stdoutDrop, stderrDrop } = outputTool.buildBothStreamsEvents(
    stdoutSnap,
    stderrSnap,
    0
  );
  assert.deepEqual(stdoutDrop, { dropped: 1, droppedBeforeCursor: 3 });
  assert.deepEqual(stderrDrop, { dropped: 2, droppedBeforeCursor: 4 });
  assert.deepEqual(
    events.map((e) => [e.seq, e.stream, e.text]),
    [
      [3, "stdout", "o-3"],
      [4, "stderr", "e-4"],
    ]
  );
  assert.equal(head, 4);
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

test("realistic fixture: a genuine byte-cap overflow (built via appendChunkToBuffer, not hand-authored) produces truncated: true, and output.ts discloses the EXACT drop count - a real, provable dropped count, not a fabricated placeholder", () => {
  const state = createStreamBufferState();
  for (let i = 0; i < 50; i += 1) {
    appendChunkToBuffer(state, Buffer.from(`z`.repeat(30_000) + `-${i}\n`));
  }
  const snap = snapshotStreamBuffer(state);
  assert.equal(snap.truncated, true, "fixture must have genuinely overflowed the byte cap");
  const { events, drop } = outputTool.buildSingleStreamEvents("stdout", snap, 0);
  assert.ok(events.length > 0 && events.length < 50, "some lines must have been evicted");
  const droppedCount = 50 - events.length;
  // A solo stream (no sibling sharing the counter) always evicts its own
  // strictly contiguous prefix - the disclosed count must be EXACTLY the
  // real number of dropped lines (verifiable independently from the
  // retained-event count itself).
  assert.equal(drop.dropped, droppedCount);
  assert.equal(drop.droppedBeforeCursor, events[0]!.seq);
  // The newest line must still be the real newest.
  assert.ok(events[events.length - 1]!.text.endsWith("-49"));
});

// Eviction across MULTIPLE separate overflow events (not just the very
// first one) must still produce a correct CUMULATIVE drop count, proving
// the running headSeq/linesEverMaterialized/droppedCount counters keep
// accumulating correctly across many append calls, not just surviving a
// single overflow burst.
test("realistic fixture: eviction across MULTIPLE separate overflow events still produces a correct CUMULATIVE drop count, not just the first round's", () => {
  const state = createStreamBufferState();
  const bigLine = (i: number): Buffer => Buffer.from(`z`.repeat(30_000) + `-${i}\n`);

  // Round 1: force the first overflow (as the single-round fixture above).
  for (let i = 0; i < 50; i += 1) {
    appendChunkToBuffer(state, bigLine(i));
  }
  const afterRound1 = snapshotStreamBuffer(state);
  assert.equal(afterRound1.truncated, true);
  const dropAfterRound1 = outputTool.buildSingleStreamEvents("stdout", afterRound1, 0).drop;

  // Round 2: 50 MORE lines (seq 51..100), forcing further eviction of
  // everything round 1 had retained too.
  for (let i = 50; i < 100; i += 1) {
    appendChunkToBuffer(state, bigLine(i));
  }
  const afterRound2 = snapshotStreamBuffer(state);
  assert.equal(afterRound2.truncated, true);
  const { events, drop } = outputTool.buildSingleStreamEvents("stdout", afterRound2, 0);

  // The cumulative drop after round 2 must be strictly larger than after
  // round 1 alone (every one of round 1's survivors got evicted too, PLUS
  // whatever additional round-2 lines didn't fit) - proving this is a real
  // running total, not a value that resets or double-counts.
  assert.ok(
    drop.dropped > dropAfterRound1.dropped,
    `expected cumulative drop (${drop.dropped}) to exceed round 1's drop (${dropAfterRound1.dropped})`
  );
  // Exact, independently-verifiable identity: total ever materialized (100)
  // = dropped + currently-retained.
  assert.equal(drop.dropped + events.length, 100);
  // The retained window's own oldest survivor's seq must be exactly one
  // past the disclosed drop count - internally consistent, no off-by-one.
  assert.equal(events[0]!.seq, drop.dropped + 1);
  assert.equal(drop.droppedBeforeCursor, events[0]!.seq);
  assert.ok(
    events[events.length - 1]!.text.endsWith("-99"),
    "the newest line must always be the true newest"
  );
});

// --- tail.ts's OWN drop-disclosure computation, tested directly at the
// pure-function level (not just via the handler-level tests further down)
// - tail.ts REIMPLEMENTS this scheme independently (no sibling tools/*.ts
// import permitted - see its own header), so it needs its own dedicated
// coverage, never assumed correct just because output.ts's is.

test("tail.ts: buildSingleStreamEvents discloses dropped/droppedBeforeCursor through headSeq when the window (n) reaches the retained floor", () => {
  const snap = snapshot(
    [
      { text: "x", seq: 7 },
      { text: "y", seq: 8 },
      { text: "z", seq: 9 },
    ],
    true,
    9,
    6
  );
  const { events, drop, head } = tailTool.buildSingleStreamEvents("stdout", snap, 100);
  assert.deepEqual(
    drop,
    { dropped: 6, droppedBeforeCursor: 7 },
    "seq 1-6 are gone forever; the current retained floor is seq 7"
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

test("tail.ts: dropped/droppedBeforeCursor are disclosed even when the requested window does NOT reach the retained floor - a stream-level fact, never gated on this call's own window size (a deliberate difference from the old gap-suppression design)", () => {
  const snap = snapshot(
    [
      { text: "x", seq: 7 },
      { text: "y", seq: 8 },
      { text: "z", seq: 9 },
    ],
    true,
    9,
    6
  );
  const { events, drop, head, reachesFloor } = tailTool.buildSingleStreamEvents("stdout", snap, 2);
  assert.equal(reachesFloor, false, "n=2 requests fewer events than are currently retained (3)");
  assert.deepEqual(drop, { dropped: 6, droppedBeforeCursor: 7 });
  assert.deepEqual(
    events.map((e) => e.text),
    ["y", "z"]
  );
  assert.equal(head, 9);
});

test("tail.ts: buildSingleStreamEvents with NO currently-retained lines still reports droppedBeforeCursor through headSeq", () => {
  const snap = snapshot([], true, 12, 12);
  const { events, drop, head } = tailTool.buildSingleStreamEvents("stdout", snap, 100);
  assert.deepEqual(events, []);
  assert.deepEqual(drop, { dropped: 12, droppedBeforeCursor: 12 });
  assert.equal(head, 12);
});

test("tail.ts: buildSingleStreamEvents against a REAL byte-cap overflow (via appendChunkToBuffer, not hand-authored) discloses the exact real dropped count", () => {
  const state = createStreamBufferState();
  for (let i = 0; i < 50; i += 1) {
    appendChunkToBuffer(state, Buffer.from(`z`.repeat(30_000) + `-${i}\n`));
  }
  const snap = snapshotStreamBuffer(state);
  assert.equal(snap.truncated, true);
  const { events, drop } = tailTool.buildSingleStreamEvents("stdout", snap, 100_000);
  assert.ok(events.length > 0 && events.length < 50);
  const droppedCount = 50 - events.length;
  assert.equal(drop.dropped, droppedCount);
  assert.ok(events[events.length - 1]!.text.endsWith("-49"));
});

// --- tail.ts's OWN "both" real-seq merge + independent per-stream drop
// disclosure, at the pure-function level - mirrors output.ts's own
// coverage above, since tail.ts reimplements the scheme independently (no
// sibling import permitted - see its own header).

test("tail.ts: buildBothStreamsEvents returns the last N events in REAL global seq order across both streams, never a synthetic parity split", () => {
  const stdoutSnap = snapshot([
    { text: "o1", seq: 1 },
    { text: "o2", seq: 3 },
  ]);
  const stderrSnap = snapshot([
    { text: "e1", seq: 2 },
    { text: "e2", seq: 4 },
  ]);
  const { events, head, reachesFloor, stdoutDrop, stderrDrop } = tailTool.buildBothStreamsEvents(
    stdoutSnap,
    stderrSnap,
    2
  );
  assert.deepEqual(
    events.map((e) => [e.seq, e.stream, e.text]),
    [
      [3, "stdout", "o2"],
      [4, "stderr", "e2"],
    ]
  );
  assert.equal(reachesFloor, false, "n=2 of 4 total events does not reach the floor");
  assert.equal(stdoutDrop.dropped, 0);
  assert.equal(stderrDrop.dropped, 0);
  assert.equal(head, 4);
});

test("tail.ts: buildBothStreamsEvents discloses each stream's own drop info independently, regardless of window size", () => {
  const stdoutSnap = snapshot([{ text: "o-3", seq: 3 }], true, 3, 1);
  const stderrSnap = snapshot([{ text: "e-4", seq: 4 }], true, 4, 5);
  const { stdoutDrop, stderrDrop, reachesFloor } = tailTool.buildBothStreamsEvents(
    stdoutSnap,
    stderrSnap,
    1 // does not reach the floor (2 total events)
  );
  assert.equal(reachesFloor, false);
  assert.deepEqual(stdoutDrop, { dropped: 1, droppedBeforeCursor: 3 });
  assert.deepEqual(stderrDrop, { dropped: 5, droppedBeforeCursor: 4 });
});

// =============================================================================
// Tier 2: handler-level integration - the shared jobStore singleton, real
// not-found/validation behavior, drop-disclosure field shaping (zero-drop
// omission, single-stream vs "both" shape), and truncated's two distinct
// causes (retention eviction and limit/lines clamping).
// =============================================================================

// --- unknown job_id ---

test("output/tail on an unknown job_id is a typed not-found error, never a fabricated empty/zero snapshot", () => {
  for (const mod of [outputTool, tailTool]) {
    const result = mod.handler({ job_id: "definitely-not-a-real-job-id" });
    assert.equal(result.isError, true);
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    assert.ok(text.includes('no job with job_id "definitely-not-a-real-job-id"'));
    assert.ok(
      text.includes("scoped to the server process"),
      `${mod.name} not-found error must disclose per-server-process job scoping`
    );
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

// --- zero-drop field omission ---

test("(green control) output: dropped/droppedBeforeCursor/truncated are all omitted entirely when nothing was ever evicted and no limit clamped this call", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("a\nb\nc\n"));
  const result = structuredOf(outputTool.handler({ job_id: jobId, stream: "stdout" }));
  assert.equal("truncated" in result, false);
  assert.equal("dropped" in result, false);
  assert.equal("droppedBeforeCursor" in result, false);
});

test("(green control) 'both': dropped is omitted entirely when neither stream has ever evicted anything", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("o\n"));
  jobStore.appendOutput(jobId, "stderr", Buffer.from("e\n"));
  const result = structuredOf(outputTool.handler({ job_id: jobId, stream: "both" }));
  assert.equal("dropped" in result, false);
});

// --- truncated's two distinct causes (retention eviction vs limit/lines clamping) ---

test("output: truncated stays true from the retention-eviction cause even once the caller's own cursor has fully caught up (no items pending this call)", () => {
  const jobId = makeJobWithRawOutput();
  for (let i = 0; i < 10_050; i += 1) {
    jobStore.appendOutput(jobId, "stdout", Buffer.from(`line-${i}\n`));
  }
  const first = structuredOf(outputTool.handler({ job_id: jobId, stream: "stdout" }));
  assert.equal(first.truncated, true, "fixture must have genuinely overflowed MAX_BUFFER_LINES");
  const caughtUp = structuredOf(
    outputTool.handler({
      job_id: jobId,
      stream: "stdout",
      after_cursor: first.next_cursor as number,
    })
  );
  assert.deepEqual(caughtUp.events, []);
  assert.equal(
    caughtUp.truncated,
    true,
    "truncated must stay true - this stream genuinely lost history forever, regardless of whether THIS call has anything new to disclose"
  );
});

test("output: `limit` alone sets truncated:true even on a stream that has never evicted anything - the limit-clamping cause, distinct from retention eviction", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("a\nb\nc\n"));
  const result = structuredOf(outputTool.handler({ job_id: jobId, stream: "stdout", limit: 2 }));
  assert.equal((result.events as unknown[]).length, 2);
  assert.equal(
    result.truncated,
    true,
    "2 of 3 available events were returned - one remains, so truncated must be true even though nothing was ever evicted"
  );
  assert.equal(
    result.dropped,
    undefined,
    "no retention eviction ever happened - dropped/droppedBeforeCursor must stay absent"
  );
});

test("output: dropped/droppedBeforeCursor stay identical across every paginated page of the same truncated stream - never affected by `limit`", () => {
  const jobId = makeJobWithRawOutput();
  for (let i = 0; i < 10_050; i += 1) {
    jobStore.appendOutput(jobId, "stdout", Buffer.from(`line-${i}\n`));
  }
  const unlimited = structuredOf(outputTool.handler({ job_id: jobId, stream: "stdout" }));
  assert.equal(typeof unlimited.dropped, "number");
  let cursor = 0;
  for (let step = 0; step < 5; step += 1) {
    const page = structuredOf(
      outputTool.handler({ job_id: jobId, stream: "stdout", after_cursor: cursor, limit: 1 })
    );
    assert.equal(
      page.dropped,
      unlimited.dropped,
      `step ${step}: dropped must be identical regardless of pagination`
    );
    assert.equal(
      page.droppedBeforeCursor,
      unlimited.droppedBeforeCursor,
      `step ${step}: droppedBeforeCursor must be identical regardless of pagination`
    );
    cursor = page.next_cursor as number;
  }
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

test("tail's returned events are always exactly min(N, available) real events - nothing but real OutputEvent objects ever appears in the array", () => {
  const jobId = makeJobWithRawOutput();
  for (let i = 0; i < 10_050; i += 1) {
    jobStore.appendOutput(jobId, "stdout", Buffer.from(`line-${i}\n`));
  }
  const result = structuredOf(tailTool.handler({ job_id: jobId, stream: "stdout", lines: 5 }));
  const events = result.events as Array<Record<string, unknown>>;
  assert.equal(events.length, 5, "exactly N=5 real events, no non-event items of any kind");
  for (const event of events) {
    assert.equal(typeof event.seq, "number");
    assert.equal(typeof event.stream, "string");
    assert.equal(typeof event.text, "string");
  }
});

test("tail: `lines` alone sets truncated:true when the requested window is smaller than what's currently retained - distinct from retention eviction", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("a\nb\nc\n"));
  const result = structuredOf(tailTool.handler({ job_id: jobId, stream: "stdout", lines: 2 }));
  assert.deepEqual(
    (result.events as Array<{ text: string }>).map((e) => e.text),
    ["b", "c"]
  );
  assert.equal(result.truncated, true);
  assert.equal(result.dropped, undefined, "nothing was ever evicted - only the window was smaller");
});

test("tail: truncated stays true from the retention-eviction cause even when the window reaches the retained floor and returns everything currently available", () => {
  const jobId = makeJobWithRawOutput();
  for (let i = 0; i < 10_050; i += 1) {
    jobStore.appendOutput(jobId, "stdout", Buffer.from(`line-${i}\n`));
  }
  const result = structuredOf(
    tailTool.handler({ job_id: jobId, stream: "stdout", lines: 100_000 })
  );
  assert.equal(result.truncated, true);
});

test("tail: dropped/droppedBeforeCursor are disclosed even when the requested window does NOT reach the retained floor - a stream-level fact, not gated on this call's own window size", () => {
  const jobId = makeJobWithRawOutput();
  for (let i = 0; i < 10_050; i += 1) {
    jobStore.appendOutput(jobId, "stdout", Buffer.from(`line-${i}\n`));
  }
  const small = structuredOf(tailTool.handler({ job_id: jobId, stream: "stdout", lines: 3 }));
  assert.equal(typeof small.dropped, "number");
  assert.ok((small.dropped as number) > 0);
  assert.equal(typeof small.droppedBeforeCursor, "number");
});

test("(green control) tail: truncated/dropped are all omitted when nothing was ever evicted and the window reaches/exceeds what's available", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("a\nb\n"));
  const result = structuredOf(tailTool.handler({ job_id: jobId, stream: "stdout", lines: 10 }));
  assert.equal("truncated" in result, false);
  assert.equal("dropped" in result, false);
});

// REGRESSION (handler-level, real jobStore byte-accounting, not
// hand-authored): next_cursor must still correctly cover the "most-recent-
// line-evicted-by-pending-growth" edge case even with no gap markers left
// to reason about - it must equal the stream's own true head so a
// resubmitted after_cursor via output() never tries to re-fetch a line
// that is genuinely gone.
test("REGRESSION: tail's next_cursor equals the stream's true head when a stream has been evicted down to zero retained lines (pending-growth eviction)", () => {
  const jobId = makeJobWithRawOutput();
  // stderr materializes ONE line first - this job's own seq counter is
  // fresh, so it becomes seq 1 - and is never touched again, surviving
  // untouched.
  jobStore.appendOutput(jobId, "stderr", Buffer.from("e1\n"));
  // stdout materializes ONE genuine, complete ~600KB line - seq 2 - well
  // under the 1 MiB cap alone, so nothing evicts yet.
  jobStore.appendOutput(jobId, "stdout", Buffer.from("x".repeat(600_001) + "\n"));
  // A further ~600KB chunk with NO trailing newline stays pending -
  // jobStore.ts's own documented "pending growth can evict even the
  // newest completed line" edge case (evictToFitBudget) now kicks in:
  // totalBytes + pending exceeds the 1 MiB cap, so stdout's only
  // materialized line (seq 2) is evicted to make room, even though it is
  // stdout's own newest (and only) line - stdout ends with ZERO retained
  // lines, headSeq 2.
  jobStore.appendOutput(jobId, "stdout", Buffer.from("y".repeat(600_000)));

  const stdoutSnap = jobStore.getStreamSnapshot(jobId, "stdout")!;
  assert.equal(
    stdoutSnap.lines.length,
    0,
    "fixture must have genuinely evicted stdout's only materialized line"
  );
  assert.equal(stdoutSnap.truncated, true);
  assert.equal(stdoutSnap.headSeq, 2);
  assert.equal(stdoutSnap.droppedCount, 1);

  const result = structuredOf(tailTool.handler({ job_id: jobId, stream: "both", lines: 100 }));
  const events = result.events as Array<{ seq: number; text: string }>;
  // stderr's seq 1 is the only real, retained event.
  assert.deepEqual(
    events.map((e) => [e.seq, e.text]),
    [[1, "e1"]]
  );
  // next_cursor must cover the true head (2), never just the last real
  // event's own seq (1) - a client resubmitting after_cursor:1 must never
  // be told to re-fetch a line that is genuinely gone.
  assert.equal(
    result.next_cursor,
    2,
    "next_cursor must equal the stream's true head, not just the last retained event's seq"
  );
});

// REGRESSION (handler-level, real jobStore overflow): the same defect the
// pure-function tests above prove directly, now proven through the real
// handler + real byte-accounting eviction, exactly the path an agent
// polling output() actually drives.
test("REGRESSION: output(stream: both) against a real overflowed job reaches an EMPTY page on re-submitted next_cursor, never replays the same lines", () => {
  const jobId = makeJobWithRawOutput();
  for (let i = 0; i < 10_050; i += 1) {
    jobStore.appendOutput(jobId, "stdout", Buffer.from(`line-${i}\n`));
  }
  const first = structuredOf(outputTool.handler({ job_id: jobId, stream: "both" }));
  assert.equal(first.truncated, true, "fixture must have genuinely overflowed MAX_BUFFER_LINES");
  const firstEvents = first.events as Array<Record<string, unknown>>;
  assert.ok(firstEvents.length > 0, "a fresh read must return the currently-retained window");

  const second = structuredOf(
    outputTool.handler({
      job_id: jobId,
      stream: "both",
      after_cursor: first.next_cursor as number,
    })
  );
  assert.deepEqual(
    second.events,
    [],
    "re-submitting the previous call's own next_cursor, with nothing new produced since, must return an EMPTY page - the exact defect this fix closes"
  );
  assert.equal(
    second.next_cursor,
    first.next_cursor,
    "next_cursor must not keep climbing when nothing new has arrived"
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

// --- job-output retention: real output()/tail() handler bodies (not the
// internal event-builder called directly, not the store-level snapshot -
// the actual MCP-visible response, single-stream AND "both", for every
// shape src/jobStore.ts's own retention docs enumerate) ---

/**
 * Forces the shared singleton's next `sweepRetention()` call to reclaim
 * ANY terminal job regardless of age (retentionMs: 0), while leaving
 * maxRetainedJobs generous (DEFAULT_MAX_RETAINED_JOBS) so a cap-driven
 * eviction never touches an unrelated job this file's OTHER tests created
 * earlier - only the time-based path fires. Restores the singleton's
 * defaults immediately after the forced sweep, so no later test in this
 * file observes an altered retention policy.
 */
function forceImmediateRetentionSweep(now?: number): string[] {
  jobStore.setRetentionConfig({ retentionMs: 0, maxRetainedJobs: DEFAULT_MAX_RETAINED_JOBS });
  const evicted = jobStore.sweepRetention(now);
  jobStore.setRetentionConfig({
    retentionMs: DEFAULT_RETENTION_MS,
    maxRetainedJobs: DEFAULT_MAX_RETAINED_JOBS,
  });
  return evicted;
}

test("output()/tail() real handler bodies: a job reclaimed while its only content on EITHER stream is a pending fragment (no line ever formed) discloses dropped:1 per stream, never a fabricated line - single-stream and both", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("abc")); // 3 bytes, no newline - pending only
  jobStore.appendOutput(jobId, "stderr", Buffer.from("xyz")); // same, other stream
  jobStore.markExited(jobId, 0, null);
  assert.equal(
    jobStore.getStreamSnapshot(jobId, "stdout")!.lines.length,
    0,
    "setup check: stdout never materialized a line"
  );
  assert.equal(
    jobStore.getStreamSnapshot(jobId, "stderr")!.lines.length,
    0,
    "setup check: stderr never materialized a line"
  );

  const evicted = forceImmediateRetentionSweep(Date.now() + 1_000_000_000);
  assert.ok(
    evicted.includes(jobId),
    "setup check: the real sweep must have genuinely reclaimed this job"
  );

  for (const stream of ["stdout", "stderr"] as const) {
    const outputResult = structuredOf(outputTool.handler({ job_id: jobId, stream }));
    assert.deepEqual(
      outputResult.events,
      [],
      `output(${stream}): the pending fragment never became a line, so events must be empty`
    );
    assert.equal(
      outputResult.truncated,
      true,
      `output(${stream}): a real byte was genuinely lost, even though it never formed a line`
    );
    assert.equal(
      outputResult.dropped,
      1,
      `output(${stream}): exactly one loss event - the discarded pending fragment`
    );
    assert.equal(
      outputResult.droppedBeforeCursor,
      0,
      `output(${stream}): no line was ever assigned a seq`
    );

    const tailResult = structuredOf(tailTool.handler({ job_id: jobId, stream, lines: 10 }));
    assert.deepEqual(tailResult.events, [], `tail(${stream}): same real body, same empty events`);
    assert.equal(
      tailResult.truncated,
      true,
      `tail(${stream}): reimplements the identical drop-disclosure scheme`
    );
    assert.equal(tailResult.dropped, 1, `tail(${stream}): same dropped:1`);
  }

  const bothOutput = structuredOf(outputTool.handler({ job_id: jobId, stream: "both" }));
  assert.deepEqual(
    bothOutput.events,
    [],
    "output(both): still nothing to disclose - neither stream ever formed a line"
  );
  assert.deepEqual(
    bothOutput.dropped,
    {
      stdout: { dropped: 1, droppedBeforeCursor: 0 },
      stderr: { dropped: 1, droppedBeforeCursor: 0 },
    },
    "output(both): both streams disclosed, neither omitted, since both genuinely lost their one pending fragment"
  );

  const bothTail = structuredOf(tailTool.handler({ job_id: jobId, stream: "both", lines: 10 }));
  assert.deepEqual(bothTail.events, [], "tail(both): same real body");
  assert.deepEqual(
    bothTail.dropped,
    {
      stdout: { dropped: 1, droppedBeforeCursor: 0 },
      stderr: { dropped: 1, droppedBeforeCursor: 0 },
    },
    "tail(both): matches output(both) exactly"
  );
});

test("output()/tail() real handler bodies: a stream reclaimed with BOTH a real line AND a pending fragment discloses dropped:2 (two separate loss events, not one), while its untouched sibling discloses nothing - single-stream and both", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("a real line\n"));
  jobStore.appendOutput(jobId, "stdout", Buffer.from("xyz")); // 3 bytes, no newline - stays pending
  // stderr: appendOutput is never called at all - genuinely untouched.
  jobStore.markExited(jobId, 0, null);
  assert.equal(
    jobStore.getStreamSnapshot(jobId, "stdout")!.lines.length,
    1,
    "setup check: exactly one materialized line before reclamation"
  );

  const evicted = forceImmediateRetentionSweep(Date.now() + 1_000_000_000);
  assert.ok(
    evicted.includes(jobId),
    "setup check: the real sweep must have genuinely reclaimed this job"
  );

  const stdoutOutput = structuredOf(outputTool.handler({ job_id: jobId, stream: "stdout" }));
  assert.deepEqual(
    stdoutOutput.events,
    [],
    "output(stdout): both the line and the fragment are genuinely gone"
  );
  assert.equal(
    stdoutOutput.dropped,
    2,
    "output(stdout): the materialized line PLUS the separately-discarded fragment"
  );

  const stdoutTail = structuredOf(tailTool.handler({ job_id: jobId, stream: "stdout", lines: 10 }));
  assert.deepEqual(stdoutTail.events, []);
  assert.equal(stdoutTail.dropped, 2, "tail(stdout): matches output(stdout)'s real body");

  const stderrOutput = structuredOf(outputTool.handler({ job_id: jobId, stream: "stderr" }));
  assert.equal(
    "dropped" in stderrOutput,
    false,
    "output(stderr): must be entirely omitted from disclosure - it never lost anything, even though its sibling stream and the whole job were reclaimed"
  );
  assert.equal(
    stderrOutput.truncated,
    undefined,
    "output(stderr): never touched, so truncated stays absent, not falsely true"
  );

  const bothOutput = structuredOf(outputTool.handler({ job_id: jobId, stream: "both" }));
  assert.deepEqual(
    bothOutput.dropped,
    { stdout: { dropped: 2, droppedBeforeCursor: 1 } },
    "output(both): stderr must be omitted from the nested dropped object entirely - it never lost anything"
  );

  const bothTail = structuredOf(tailTool.handler({ job_id: jobId, stream: "both", lines: 10 }));
  assert.deepEqual(
    bothTail.dropped,
    { stdout: { dropped: 2, droppedBeforeCursor: 1 } },
    "tail(both): matches output(both) exactly"
  );
});

test("output()/tail() real handler bodies: a stream genuinely empty at reclaim time, which THEN receives late bytes via appendOutput, discloses that arrival honestly as dropped:1 - not silently indistinguishable from a stream that never received anything - single-stream and both", () => {
  const jobId = makeJobWithRawOutput();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("the only output at reclaim time\n"));
  // stderr: zero footprint at reclaim time - correctly truncated:false/dropped absent, nothing lost YET.
  jobStore.markExited(jobId, 0, null);

  const evicted = forceImmediateRetentionSweep(Date.now() + 1_000_000_000);
  assert.ok(
    evicted.includes(jobId),
    "setup check: the real sweep must have genuinely reclaimed this job"
  );

  const beforeLateArrival = structuredOf(outputTool.handler({ job_id: jobId, stream: "stderr" }));
  assert.equal(
    "dropped" in beforeLateArrival,
    false,
    "output(stderr) before the late arrival: no drop disclosure yet, matching a stream that never received anything"
  );

  // A late chunk now arrives for stderr on this already-reclaimed job - the
  // exact shape that must flip truncated and increment droppedCount,
  // rather than silently vanishing into bytesEverReceived alone.
  jobStore.appendOutput(jobId, "stderr", Buffer.from("late bytes that arrive too late"));

  const afterOutput = structuredOf(outputTool.handler({ job_id: jobId, stream: "stderr" }));
  assert.deepEqual(
    afterOutput.events,
    [],
    "output(stderr): the late bytes never materialize into a visible line"
  );
  assert.equal(
    afterOutput.truncated,
    true,
    "output(stderr): the late arrival is a real loss event now"
  );
  assert.equal(
    afterOutput.dropped,
    1,
    "output(stderr): one loss event for the late arrival, distinct from the earlier reclaim which lost nothing on this stream"
  );

  const afterTail = structuredOf(tailTool.handler({ job_id: jobId, stream: "stderr", lines: 10 }));
  assert.deepEqual(afterTail.events, []);
  assert.equal(afterTail.dropped, 1, "tail(stderr): matches output(stderr)'s real body");

  const bothOutput = structuredOf(outputTool.handler({ job_id: jobId, stream: "both" }));
  assert.deepEqual(
    bothOutput.dropped,
    {
      stdout: { dropped: 1, droppedBeforeCursor: 1 },
      stderr: { dropped: 1, droppedBeforeCursor: 0 },
    },
    "output(both): both streams now disclosed - stdout's own real line reclaimed, stderr's late-arrival loss - neither omitted"
  );

  const bothTail = structuredOf(tailTool.handler({ job_id: jobId, stream: "both", lines: 10 }));
  assert.deepEqual(
    bothTail.dropped,
    {
      stdout: { dropped: 1, droppedBeforeCursor: 1 },
      stderr: { dropped: 1, droppedBeforeCursor: 0 },
    },
    "tail(both): matches output(both) exactly"
  );
});

// =============================================================================
// Tier 2.5: real concurrent-write stress, IN-PROCESS - a real spawned child
// process, real jobStore singleton, direct handler calls (no wire needed
// for this specific proof, which is about output()/tail()'s own
// non-blocking-snapshot correctness under real concurrent writes, not
// about the wire protocol - that is covered separately in Tier 3). This
// REBUILDS the earlier "non-blocking snapshot consistency" stress test,
// which only ever asserted response SHAPE (never a torn/corrupted event)
// without ever proving the reads genuinely raced a LIVE process, and
// without any per-call SLA or seq-integrity check within a response.
// =============================================================================

// The one test in this tier spawns a real job via runTool.handler(), so
// the policy guard is scoped to just this describe() block. That single
// test is itself win32-skipped (no POSIX pgrep-oracle equivalent there),
// so the registration is conditioned on the same predicate - otherwise
// the hook would throw on unset policy on win32 with nothing left to guard.
describe("Tier 2.5: real concurrent-write stress", () => {
  if (process.platform !== "win32") {
    before(requireSpawnPolicy);
  }

  test(
    "non-blocking snapshot consistency, HARDENED: real PGID-alive assertions bracketing both output() and tail(), a per-call deadline, and full seq-integrity checks within every response - never a torn/corrupted/out-of-order event",
    {
      skip:
        process.platform === "win32"
          ? "exercises a real POSIX pgrep oracle, no win32 equivalent path here"
          : false,
    },
    async () => {
      const runResult = runTool.handler({
        command: [
          "node",
          "-e",
          "let i = 0; const t = setInterval(() => { if (i >= 4000) { clearInterval(t); return; } console.log('payload-' + 'x'.repeat(40) + '-' + i); i++; }, 0)",
        ],
      });
      assert.notEqual(runResult.isError, true);
      const jobId = (runResult.structuredContent as Record<string, unknown>).job_id as string;
      const handle = jobStore.getChildHandle(jobId);
      assert.notEqual(handle, undefined, "expected a real attached child for this in-process job");
      const pgid = handle!.pid;

      try {
        // Bracket #1: confirm the writer is a REAL, alive process group
        // before ever trusting that the reads below are genuinely concurrent
        // with it, not silently racing an already-dead job.
        assert.ok(
          pgrepGroupMembers(pgid).length > 0,
          "the writer's process group must be alive before the concurrent-read loop starts"
        );

        const CALL_DEADLINE_MS = 500;
        function timedCall<T>(label: string, fn: () => T): T {
          const startedAt = Date.now();
          const result = fn();
          const elapsed = Date.now() - startedAt;
          assert.ok(
            elapsed < CALL_DEADLINE_MS,
            `${label} must resolve well under ${CALL_DEADLINE_MS}ms on its own (a per-call deadline, not just the aggregate loop budget) - took ${elapsed}ms`
          );
          return result;
        }

        const lineShape = /^payload-x{40}-\d+$/;
        let sawAtLeastOneEvent = false;
        let sawAliveMidLoop = false;
        const startedAt = Date.now();
        // Hammer output()/tail() repeatedly WHILE the child is very likely
        // still writing - every single response must be internally
        // well-formed, and at least one read (bracket #2) must observe the
        // writer's process group still alive, proving genuine concurrency.
        // The handler calls themselves are synchronous, but the real child's
        // stdout `data` events are delivered asynchronously by the event
        // loop - a tight synchronous `while` loop with no `await` inside it
        // never yields, which starves the event loop and means the child's
        // output is NEVER actually read during the loop (proven empirically:
        // without the yield below, this test always observes zero events).
        // Yielding via `setImmediate` each iteration is what makes the reads
        // genuinely concurrent with the writer's real, async I/O.
        while (Date.now() - startedAt < 1500) {
          const outputResult = timedCall("output()", () =>
            outputTool.handler({ job_id: jobId, stream: "stdout" })
          );
          const tailResult = timedCall("tail()", () =>
            tailTool.handler({ job_id: jobId, stream: "stdout", lines: 25 })
          );
          if (pgrepGroupMembers(pgid).length > 0) sawAliveMidLoop = true;

          for (const result of [outputResult, tailResult]) {
            assert.notEqual(
              result.isError,
              true,
              "a snapshot read must never itself error under concurrent writes"
            );
            const events = (result.structuredContent?.events ?? []) as Array<{
              seq?: number;
              stream?: string;
              text?: string;
              partial?: boolean;
            }>;
            let previousSeq = -Infinity;
            for (const event of events) {
              sawAtLeastOneEvent = true;
              assert.equal(typeof event.seq, "number", "every event must carry an integer seq");
              assert.ok(Number.isInteger(event.seq), `seq must be an integer, got ${event.seq}`);
              assert.ok(
                event.seq! > previousSeq,
                `seqs must be strictly ascending and unique within one response - got ${event.seq} after ${previousSeq}`
              );
              previousSeq = event.seq!;
              assert.equal(
                event.stream,
                "stdout",
                "this read only ever selected stdout - no cross-stream leakage"
              );
              const text = event.text!;
              // A torn/corrupted event would fail to match the exact
              // repeated payload shape (e.g. half-old-content-half-new-
              // content spliced together) UNLESS it's honestly flagged
              // partial (a genuine still-open line, never a lie).
              if (!lineShape.test(text)) {
                assert.equal(
                  event.partial,
                  true,
                  `a malformed-looking line must be explicitly flagged partial, got: ${JSON.stringify(text)}`
                );
              }
            }
          }
          // Yield to the event loop so the real child's async stdout `data`
          // events actually get a chance to fire between reads.
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.ok(
          sawAtLeastOneEvent,
          "the stress loop must have actually observed real output at least once"
        );
        assert.ok(
          sawAliveMidLoop,
          "the writer's process group must have been observed alive at least once DURING the read loop - proving genuine concurrency, not reads against an already-finished job"
        );
      } finally {
        try {
          process.kill(-pgid, "SIGKILL"); // cleanup - a no-op (ESRCH) if it already exited naturally
        } catch {
          // already exited naturally - fine
        }
      }
    }
  );
});

// =============================================================================
// Tier 3: real end-to-end proof - a real spawned dist/index.js process, real
// JSON-RPC over its real stdin/stdout.
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

// The three tests below drive a real spawned command through the real
// `run` tool over the wire, so the policy guard is scoped to just this
// describe() block - "tools/list" above and the unknown-job_id test below
// never call `run`, so neither one needs it.
describe("Tier 3: run-driven end-to-end tests", () => {
  before(requireSpawnPolicy);

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
    const tailEvents = (tailBody.result?.structuredContent?.events ?? []) as Array<{
      text: string;
    }>;
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

  test("e2e: a real spawned job that overflows the retention cap - truncated: true and a bounded drop-count disclosure, read over the real wire", async () => {
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
      const events = (structured?.events ?? []) as Array<{ text: string }>;
      const last = events[events.length - 1];
      if (structured?.truncated === true && last?.text === "overflow-line-10049") break;
      if (Date.now() > deadline)
        throw new Error("timed out waiting for the real overflow child to finish");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(structured!.truncated, true);
    assert.equal(typeof structured!.dropped, "number");
    assert.ok((structured!.dropped as number) > 0, "some lines must have been genuinely dropped");
    assert.equal(typeof structured!.droppedBeforeCursor, "number");
    const events = structured!.events as Array<{ text: string }>;
    assert.ok(events.length < 10050, "eviction must have genuinely dropped some lines");
    assert.equal(
      events[events.length - 1]!.text,
      "overflow-line-10049",
      "the newest line must always survive eviction"
    );
    assert.equal(
      events.some((e) => e.text === "overflow-line-0"),
      false,
      "the oldest lines must have been genuinely evicted"
    );
    // Independently-verifiable identity, proven over the real wire: total
    // lines produced (10,050) = dropped + currently-retained.
    assert.equal((structured!.dropped as number) + events.length, 10050);
    server.child.kill("SIGKILL");
  });
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
    const wireText = body.result?.content[0]?.text ?? "";
    assert.ok(
      wireText.includes("scoped to the server process"),
      `${toolName} wire-level not-found error must disclose per-server-process job scoping`
    );
  }
  server.child.kill("SIGKILL");
});
