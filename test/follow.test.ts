import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import * as followTool from "../dist/tools/follow.js";
import { jobStore, MAX_OUTSTANDING_FOLLOWS } from "../dist/jobStore.js";
import { createServer } from "../dist/server.js";
import * as statusTool from "../dist/tools/status.js";

// ---------------------------------------------------------------------------
// Small local helpers - each test file in this repo defines its own (see
// test/output-tail.test.ts's/test/kill.test.ts's identical local
// makeJobWithRawOutput/assertToolError helpers), never shared across
// files, since no `tools/*.ts` file - and by extension its test - imports
// a sibling.
// ---------------------------------------------------------------------------

/** Creates a real job in the shared jobStore singleton (the same one follow.ts reads from) - no real child process, matching test/output-tail.test.ts's/test/kill.test.ts's identical convention. */
function makeJob(): string {
  const record = jobStore.createJob({ argv: ["synthetic"], cwd: "/tmp", env: {}, isShell: false });
  return record.job_id;
}

function structuredOf(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function assertToolError(result: CallToolResult, expectedSubstring: string): void {
  assert.equal(
    result.isError,
    true,
    `expected a tool-execution error, got: ${JSON.stringify(result)}`
  );
  const [first] = result.content;
  assert.ok(
    first?.type === "text" && first.text.includes(expectedSubstring),
    `expected content text to include "${expectedSubstring}", got: ${JSON.stringify(result.content)}`
  );
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test("follow: schema requires a non-empty string job_id, and declares cursor/stream/timeout_ms as optional", () => {
  assert.deepEqual(followTool.inputSchema.required, ["job_id"]);
  assert.equal(followTool.inputSchema.properties?.job_id?.type, "string");
  assert.equal(followTool.inputSchema.properties?.cursor?.type, "number");
  assert.equal(followTool.inputSchema.properties?.stream?.type, "string");
  assert.deepEqual(followTool.inputSchema.properties?.stream?.enum, ["stdout", "stderr", "both"]);
  assert.equal(followTool.inputSchema.properties?.timeout_ms?.type, "number");
});

// ---------------------------------------------------------------------------
// Validation - every error mirrors output.ts's ValidationResult<T> style,
// asserted here the same way test/output-tail.test.ts and test/kill.test.ts
// assert their own tools' validation errors, against the real handler.
// ---------------------------------------------------------------------------

test("follow: missing/wrong-typed job_id returns isError: true, not a thrown error", async () => {
  assertToolError(await followTool.handler(undefined), "job_id");
  assertToolError(await followTool.handler({}), "job_id");
  assertToolError(await followTool.handler({ job_id: 7 }), "job_id");
  assertToolError(await followTool.handler({ job_id: "" }), "job_id");
});

test("follow: an invalid stream value is a typed validation error", async () => {
  const jobId = makeJob();
  assertToolError(await followTool.handler({ job_id: jobId, stream: "bogus" }), "stream");
});

test("follow: cursor must be a non-negative integer - negative and non-integer values are typed validation errors", async () => {
  const jobId = makeJob();
  for (const bad of [-1, 1.5]) {
    assertToolError(await followTool.handler({ job_id: jobId, cursor: bad }), "cursor");
  }
});

test("follow: timeout_ms must be a positive integer - zero, negative, and non-integer values are typed validation errors", async () => {
  const jobId = makeJob();
  for (const bad of [0, -5, 1.5]) {
    assertToolError(await followTool.handler({ job_id: jobId, timeout_ms: bad }), "timeout_ms");
  }
});

test("follow: unknown job_id is a distinct, typed not-found error - never confused with a validation error", async () => {
  const result = await followTool.handler({
    job_id: "definitely-not-a-real-job-id-ghantika-follow-test",
  });
  assertToolError(result, "unknown job_id");
});

// ---------------------------------------------------------------------------
// validateTimeoutMs - exported for exactly this reason (matching
// output.ts's own pattern of exporting buildSingleStreamEvents/
// buildBothStreamsEvents for direct unit testing): so the default and the
// clamp ceiling can both be proven without a real 45-second or a real
// one-hour wait.
// ---------------------------------------------------------------------------

test("validateTimeoutMs: omitted resolves to the documented 45000ms default, and DEFAULT_TIMEOUT_MS is that same value", () => {
  assert.equal(followTool.DEFAULT_TIMEOUT_MS, 45_000);
  assert.deepEqual(followTool.validateTimeoutMs(undefined), {
    ok: true,
    value: followTool.DEFAULT_TIMEOUT_MS,
  });
});

test("validateTimeoutMs: an explicit value above the hard 3600000ms (one hour) ceiling is silently clamped down to it, never rejected - and MAX_TIMEOUT_MS is that same ceiling", () => {
  assert.equal(followTool.MAX_TIMEOUT_MS, 3_600_000);
  assert.deepEqual(followTool.validateTimeoutMs(5_000_000), {
    ok: true,
    value: followTool.MAX_TIMEOUT_MS,
  });
  // Comfortably above the ceiling too - not just barely over it.
  assert.deepEqual(followTool.validateTimeoutMs(1_000_000_000), {
    ok: true,
    value: followTool.MAX_TIMEOUT_MS,
  });
});

test("validateTimeoutMs: exactly at the ceiling passes through unchanged, never clamped further", () => {
  assert.deepEqual(followTool.validateTimeoutMs(followTool.MAX_TIMEOUT_MS), {
    ok: true,
    value: followTool.MAX_TIMEOUT_MS,
  });
});

test("validateTimeoutMs: zero, negative, and non-integer values are all rejected", () => {
  for (const bad of [0, -1, 1.5]) {
    const result = followTool.validateTimeoutMs(bad);
    assert.equal(result.ok, false, `timeout_ms=${bad} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// Immediate-return paths - subscribe-then-check's own "already true"
// branch (see follow.ts's own header): no timer is ever started, proven
// here by a huge timeout_ms the test would otherwise be forced to wait
// out for real.
// ---------------------------------------------------------------------------

const NEVER_HIT_TIMEOUT_MS = 999_000; // ~16.65 minutes - if this call ever actually waited it out, this test would time out long before node:test's own default per-test bound did, making a real timer start unmistakably visible as a failure rather than a silent pass.

test('follow: output already past cursor at call time returns immediately with reason "output", provably without ever starting a timer', async () => {
  const jobId = makeJob();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("already-here\n"));
  const start = Date.now();
  const result = structuredOf(
    await followTool.handler({ job_id: jobId, cursor: 0, timeout_ms: NEVER_HIT_TIMEOUT_MS })
  );
  const elapsed = Date.now() - start;
  assert.equal(result.reason, "output");
  assert.ok(
    elapsed < 1000,
    `expected near-instant resolution (no timer ever started), took ${elapsed}ms`
  );
  const events = result.events as Array<Record<string, unknown>>;
  assert.equal(events.length, 1);
  assert.equal(events[0]!.text, "already-here");
  assert.equal(events[0]!.stream, "stdout");
  assert.equal(events[0]!.seq, 1);
  assert.equal(result.next_cursor, 1);
});

test('follow: a job already terminal at call time returns immediately with reason "terminal", provably without ever starting a timer', async () => {
  const jobId = makeJob();
  jobStore.markExited(jobId, 0, null);
  const start = Date.now();
  const result = structuredOf(
    await followTool.handler({ job_id: jobId, timeout_ms: NEVER_HIT_TIMEOUT_MS })
  );
  const elapsed = Date.now() - start;
  assert.equal(result.reason, "terminal");
  assert.equal(result.state, "exited");
  assert.ok(
    elapsed < 1000,
    `expected near-instant resolution (no timer ever started), took ${elapsed}ms`
  );
});

test('follow: when BOTH output and terminal are already true at call time, "terminal" (the more complete signal) wins', async () => {
  const jobId = makeJob();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("last-line\n"));
  jobStore.markExited(jobId, 0, null);
  const result = structuredOf(
    await followTool.handler({ job_id: jobId, cursor: 0, timeout_ms: NEVER_HIT_TIMEOUT_MS })
  );
  assert.equal(result.reason, "terminal");
});

// ---------------------------------------------------------------------------
// Genuine wake DURING the call - the subscribe happens synchronously
// before this async handler ever awaits anything, so mutating jobStore
// right after calling (and not yet awaiting) the handler is what actually
// exercises the listener path rather than the immediate-return path
// above.
// ---------------------------------------------------------------------------

test('follow: a genuine output arrival DURING the wait resolves promptly with reason "output", well before timeout_ms elapses', async () => {
  const jobId = makeJob();
  const start = Date.now();
  const promise = followTool.handler({ job_id: jobId, timeout_ms: 30_000 });
  jobStore.appendOutput(jobId, "stdout", Buffer.from("new-line\n"));
  const result = structuredOf(await promise);
  const elapsed = Date.now() - start;
  assert.equal(result.reason, "output");
  assert.ok(
    elapsed < 1000,
    `expected a prompt resolution, well before the 30s bound, took ${elapsed}ms`
  );
  const events = result.events as Array<Record<string, unknown>>;
  assert.equal(events.length, 1);
  assert.equal(events[0]!.text, "new-line");
});

test('follow: a genuine terminal transition DURING the wait resolves promptly with reason "terminal", well before timeout_ms elapses', async () => {
  const jobId = makeJob();
  const start = Date.now();
  const promise = followTool.handler({ job_id: jobId, timeout_ms: 30_000 });
  jobStore.markKilled(jobId, "SIGTERM");
  const result = structuredOf(await promise);
  const elapsed = Date.now() - start;
  assert.equal(result.reason, "terminal");
  assert.equal(result.state, "killed");
  assert.ok(
    elapsed < 1000,
    `expected a prompt resolution, well before the 30s bound, took ${elapsed}ms`
  );
});

// ---------------------------------------------------------------------------
// Timeout path - a SHORT explicit timeout_ms (never near the real 45s
// default), matching this repo's own timer-test tolerance idiom (see
// test/process.test.ts's confirmProcessGroupReapedPosix/waitForProcessDeath
// timeout tests: `elapsed >= boundMs && elapsed < boundMs + generous-margin`).
// The lower bound itself carries a small `- 5` margin rather than an exact
// `>=` check, to absorb ordinary setTimeout/Date.now() measurement jitter
// (coverage instrumentation adds overhead of its own) without weakening
// what the assertion actually catches: a broken filter/guard resolves
// near-instantly (single-digit ms), which this margin still catches with
// room to spare - it only forgives genuine scheduler slop at the bound
// itself, never an early wake on the wrong signal.
// ---------------------------------------------------------------------------

test('follow: nothing happens within a short explicit timeout_ms - resolves with reason "timeout" and a non-empty note, at approximately the bound', async () => {
  const jobId = makeJob();
  const boundMs = 150;
  const start = Date.now();
  const result = structuredOf(await followTool.handler({ job_id: jobId, timeout_ms: boundMs }));
  const elapsed = Date.now() - start;
  assert.equal(result.reason, "timeout");
  assert.equal(typeof result.note, "string");
  assert.ok((result.note as string).length > 0, "expected a non-empty note on timeout");
  assert.ok(
    elapsed >= boundMs - 5 && elapsed < boundMs + 900,
    `expected to resolve close to the ${boundMs}ms bound, took ${elapsed}ms`
  );
  assert.deepEqual(result.events, []);
});

test('follow: a reason other than "timeout" never carries a note field at all', async () => {
  const jobId = makeJob();
  jobStore.markExited(jobId, 0, null);
  const result = structuredOf(await followTool.handler({ job_id: jobId, timeout_ms: 5000 }));
  assert.equal(result.reason, "terminal");
  assert.equal(
    "note" in result,
    false,
    `expected no "note" field on a non-timeout reason, got: ${JSON.stringify(result)}`
  );
});

// ---------------------------------------------------------------------------
// THE CONTRACT: output arrival means a newly materialized line, never raw
// byte arrival - see follow.ts's own header ("Deliberately narrower than
// output/tail") and README.md's follow section for the exact wording this
// proves. A buffered fragment with no terminator must NOT wake the call on
// its own; only finalizing the selected stream (the same `stream-end`
// partial mechanism test/output-tail.test.ts's own partial-final-line test
// exercises via jobStore.appendOutput + jobStore.finalizeStream) turns it
// into a partial event.
// ---------------------------------------------------------------------------

test("follow: an unterminated fragment does not wake the call on its own - only finalizing the stream does, surfacing a partial: true event", async () => {
  const jobId = makeJob();
  jobStore.appendOutput(jobId, "stdout", Buffer.from("no newline yet"));

  const boundMs = 150;
  const start = Date.now();
  const timeoutResult = structuredOf(
    await followTool.handler({ job_id: jobId, cursor: 0, stream: "stdout", timeout_ms: boundMs })
  );
  const elapsed = Date.now() - start;
  assert.equal(
    timeoutResult.reason,
    "timeout",
    "a buffered fragment with no terminator must never wake the call on its own"
  );
  assert.deepEqual(timeoutResult.events, []);
  assert.ok(
    elapsed >= boundMs - 5 && elapsed < boundMs + 900,
    `expected to resolve close to the ${boundMs}ms bound (never early, on the unterminated write), took ${elapsed}ms`
  );

  jobStore.finalizeStream(jobId, "stdout");

  const wakeResult = structuredOf(
    await followTool.handler({
      job_id: jobId,
      cursor: 0,
      stream: "stdout",
      timeout_ms: NEVER_HIT_TIMEOUT_MS,
    })
  );
  assert.equal(
    wakeResult.reason,
    "output",
    "finalizing the stream must materialize the pending fragment and wake the call"
  );
  const events = wakeResult.events as Array<Record<string, unknown>>;
  assert.equal(events.length, 1);
  assert.equal(events[0]!.text, "no newline yet");
  assert.equal(events[0]!.partial, true);
});

// ---------------------------------------------------------------------------
// THE STREAM-FILTER FIX - the single most important new test (see
// follow.ts's own header, "The stream filter is on the SUBSCRIPTION, not
// just the response"). With stream:"stdout" set, an arrival on stderr
// alone must NEVER cause a wake with reason:"output" and zero matching
// lines - it must keep waiting, here proven by the call running all the
// way out to its own timeout rather than resolving early on the
// stderr-only arrival.
// ---------------------------------------------------------------------------

test('follow: stream:"stdout" ignores a stderr-only arrival - the call does NOT resolve with reason "output" and zero matching lines, it keeps waiting until its own bound elapses', async () => {
  const jobId = makeJob();
  const boundMs = 150;
  const start = Date.now();
  const promise = followTool.handler({ job_id: jobId, stream: "stdout", timeout_ms: boundMs });
  jobStore.appendOutput(jobId, "stderr", Buffer.from("stderr-only\n"));
  const result = structuredOf(await promise);
  const elapsed = Date.now() - start;
  assert.equal(
    result.reason,
    "timeout",
    'a stderr-only arrival must never wake a stream:"stdout" call with reason "output"'
  );
  assert.deepEqual(result.events, []);
  assert.ok(
    elapsed >= boundMs - 5 && elapsed < boundMs + 900,
    `expected to resolve close to the ${boundMs}ms bound (never early, on the stderr arrival), took ${elapsed}ms`
  );
});

// --- negative/positive stream-selector matrix ---

test('follow: stream:"stderr" correctly ignores a stdout-only arrival too', async () => {
  const jobId = makeJob();
  const boundMs = 150;
  const promise = followTool.handler({ job_id: jobId, stream: "stderr", timeout_ms: boundMs });
  jobStore.appendOutput(jobId, "stdout", Buffer.from("stdout-only\n"));
  const result = structuredOf(await promise);
  assert.equal(
    result.reason,
    "timeout",
    'a stdout-only arrival must never wake a stream:"stderr" call with reason "output"'
  );
});

test('follow: stream:"both" (the default) wakes on a stdout-only arrival', async () => {
  const jobId = makeJob();
  const promise = followTool.handler({ job_id: jobId, timeout_ms: 5000 }); // stream omitted -> "both"
  jobStore.appendOutput(jobId, "stdout", Buffer.from("either-stream\n"));
  const result = structuredOf(await promise);
  assert.equal(result.reason, "output");
});

test('follow: stream:"both" (explicit) wakes on a stderr-only arrival too', async () => {
  const jobId = makeJob();
  const promise = followTool.handler({ job_id: jobId, stream: "both", timeout_ms: 5000 });
  jobStore.appendOutput(jobId, "stderr", Buffer.from("either-stream\n"));
  const result = structuredOf(await promise);
  assert.equal(result.reason, "output");
});

// ---------------------------------------------------------------------------
// follow never mints a Tasks handle on a capable connection - the live
// negotiated-connection proof lives in test/tasks.test.ts's own
// "seven-tool mint rule" test and test/modern-handshake.test.ts's own
// modern-wire counterpart (both widened to include follow, alongside the
// pre-existing five). Not duplicated here: this file exercises the
// handler directly, with no capability-negotiation harness of its own to
// mint against in the first place.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cancellation (direct-handler half) - a follow() call that never settles
// naturally because the calling MCP request was cancelled first. See
// follow.ts's own header ("Cancellation tears down every subscription...")
// for the full design. The real-transport half of this proof - a genuine
// `notifications/cancelled` wire message, not an injected AbortSignal -
// lives in its own section below; these two tests establish the direct-
// handler baseline the real-transport test then confirms actually reaches
// the handler through src/server.ts's dispatch.
// ---------------------------------------------------------------------------

test("follow: an already-aborted signal returns promptly, subscribes nothing, and consumes no admission-budget slot", async () => {
  const jobId = makeJob();
  const controller = new AbortController();
  controller.abort();

  const budgetBefore = jobStore.getOutstandingFollowCount();
  const start = Date.now();
  const result = await followTool.handler(
    { job_id: jobId, timeout_ms: NEVER_HIT_TIMEOUT_MS },
    controller.signal
  );
  const elapsed = Date.now() - start;

  assert.notEqual(
    result.isError,
    true,
    `an already-cancelled call is a normal outcome, never an error - got: ${JSON.stringify(result)}`
  );
  assert.ok(elapsed < 200, `expected near-instant resolution, took ${elapsed}ms`);
  assert.equal(
    jobStore.getJobTerminalListenerCount(jobId),
    0,
    "no terminal listener should ever have been registered"
  );
  assert.equal(
    jobStore.getOutputArrivalListenerCount(jobId),
    0,
    "no output listener should ever have been registered"
  );
  assert.equal(
    jobStore.getOutstandingFollowCount(),
    budgetBefore,
    "an already-cancelled call must never consume a budget slot"
  );
});

/** How many `Timeout` resources are currently keeping the event loop alive - a real, public Node diagnostic (`process.getActiveResourcesInfo()`, stable since Node 16.14/17.3, well within this repo's `>=22` floor), used below to prove a timer this file started was actually CLEARED rather than merely left to fire into a void. Safe to read as a plain before/after delta within this one file: `node:test`'s default per-file process isolation (see scripts/run-tests.mjs's own header) means no OTHER test file's timers can ever be counted here. */
function countActiveTimeouts(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

test("follow: aborting mid-wait unsubscribes both listeners, clears the pending timer, and releases the admission slot", async () => {
  const jobId = makeJob();
  const controller = new AbortController();

  const timeoutsBefore = countActiveTimeouts();
  const promise = followTool.handler(
    { job_id: jobId, timeout_ms: NEVER_HIT_TIMEOUT_MS },
    controller.signal
  );

  // The handler subscribes, starts its timer, and registers the abort
  // listener synchronously, before its own first `await` - flushing one
  // microtask turn is enough for that whole prologue to have run.
  await Promise.resolve();

  assert.equal(
    jobStore.getJobTerminalListenerCount(jobId),
    1,
    "the handler should have subscribed by now"
  );
  assert.equal(jobStore.getOutputArrivalListenerCount(jobId), 1);
  assert.equal(jobStore.getOutstandingFollowCount(), 1);
  assert.equal(countActiveTimeouts(), timeoutsBefore + 1, "a real timer should now be outstanding");

  controller.abort();
  const result = await promise;

  assert.notEqual(result.isError, true, `got: ${JSON.stringify(result)}`);
  assert.equal(
    jobStore.getJobTerminalListenerCount(jobId),
    0,
    "the terminal listener must unsubscribe on abort"
  );
  assert.equal(
    jobStore.getOutputArrivalListenerCount(jobId),
    0,
    "the output listener must unsubscribe on abort"
  );
  assert.equal(
    jobStore.getOutstandingFollowCount(),
    0,
    "the admission slot must be released on abort"
  );
  assert.equal(
    countActiveTimeouts(),
    timeoutsBefore,
    "the pending timer must actually be cleared, not merely orphaned - a leaked Timeout resource here would otherwise sit alive for the full NEVER_HIT_TIMEOUT_MS bound"
  );

  // A later, genuinely independent settlement on the same job - a fresh
  // follow() call subscribing its own fresh listeners - resolves cleanly:
  // nothing left over from the aborted call above interferes with it or
  // double-fires against it.
  const followAgain = followTool.handler({ job_id: jobId, timeout_ms: 5000 });
  jobStore.markExited(jobId, 0, null);
  const secondResult = structuredOf(await followAgain);
  assert.equal(secondResult.reason, "terminal");
});

// ---------------------------------------------------------------------------
// Cancellation (real-transport half) - a genuine `notifications/cancelled`
// message sent over a real MCP client/server pair (InMemoryTransport), not
// merely an injected AbortSignal. This is the exact boundary the
// underlying bug lived at: src/server.ts discarded `ctx.mcpReq.signal`
// before it ever reached a tool handler, so a test that only ever calls
// followTool.handler() directly with a hand-built AbortSignal would never
// have caught that gap. Same real-client/real-server/InMemoryTransport
// pattern test/wake-integration.test.ts's/test/tasks-lifecycle.test.ts's
// own startPair helpers already establish (see src/server.ts's own
// createServer doc comment on why this has to run in-process: this file's
// own directly-imported jobStore singleton has to be the SAME jobStore
// instance the spawned server reads from, only possible in-process, never
// across a real spawned-child-process boundary the way
// test/helpers/spawnServer.ts's suites work).
// ---------------------------------------------------------------------------

interface Pair {
  readonly client: Client;
  readonly close: () => Promise<void>;
}

let pairCounter = 0;

async function startPair(): Promise<Pair> {
  pairCounter += 1;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const instance = createServer(serverTransport);
  await instance.server.connect(instance.transport);

  const client = new Client({
    name: `ghantika-follow-cancellation-test-client-${pairCounter}`,
    version: "0.0.0",
  });
  await client.connect(clientTransport);

  return {
    client,
    close: () => instance.shutdown("follow.test.ts cancellation test complete"),
  };
}

/** Polls `predicate` until it's true (or times out) - mirrors test/concurrency.test.ts's own `waitUntil`; each test file in this repo keeps its own copy rather than sharing one across files (see this file's own header note on local helpers). */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 10
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

test("follow: a REAL notifications/cancelled sent over the wire (not an injected AbortSignal) tears down server-side listeners, the timer, and the admission slot within a bounded window", async () => {
  const pair = await startPair();
  try {
    const jobId = makeJob();
    const controller = new AbortController();

    const callPromise = pair.client.callTool(
      { name: "follow", arguments: { job_id: jobId, timeout_ms: 30_000 } },
      { signal: controller.signal }
    );

    // The call has to actually reach the server and subscribe before there
    // is anything to cancel - a real wire round trip, unlike a direct
    // handler call, is genuinely async.
    await waitUntil(() => jobStore.getJobTerminalListenerCount(jobId) === 1);
    assert.equal(jobStore.getOutputArrivalListenerCount(jobId), 1);
    assert.equal(jobStore.getOutstandingFollowCount(), 1);

    // Aborting the client's own AbortSignal is what makes the installed
    // SDK's Client actually SEND a real `notifications/cancelled` message
    // over `clientTransport`, addressed to this exact request id
    // (confirmed by reading the installed SDK's own
    // `_requestWithSchemaViaCodec`: on a legacy-era connection - the one
    // this file's own `startPair` builds, no `server/discover` involved -
    // aborting the caller-supplied `signal` sends `{method:
    // "notifications/cancelled", params: {requestId, reason}}` over the
    // real transport rather than merely rejecting locally).
    controller.abort();
    await assert.rejects(callPromise);

    // Server-side cleanup happens on RECEIPT of that notification, which
    // travels over the wire (in-memory, but still asynchronous) - poll
    // with a real bound rather than assuming it has already landed by the
    // time the client-side rejection above resolves.
    await waitUntil(() => jobStore.getJobTerminalListenerCount(jobId) === 0);
    assert.equal(jobStore.getOutputArrivalListenerCount(jobId), 0);
    assert.equal(jobStore.getOutstandingFollowCount(), 0);
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// Admission budget - src/jobStore.ts's own MAX_OUTSTANDING_FOLLOWS. Direct
// handler calls exercise jobStore.tryAdmitFollow/releaseFollowAdmission
// exactly as genuinely as a real transport call would (follow.ts's handler
// calls them the same way regardless of how it was invoked), so this test
// stays direct-handler rather than spinning up MAX_OUTSTANDING_FOLLOWS real
// wire connections for no added coverage.
// ---------------------------------------------------------------------------

test(`follow: admitting all ${MAX_OUTSTANDING_FOLLOWS} outstanding-follow budget slots rejects the next call immediately, leaves an unrelated ordinary call responsive, and releasing every admitted call returns the budget to 0`, async () => {
  const jobId = makeJob();

  assert.equal(
    jobStore.getOutstandingFollowCount(),
    0,
    "precondition: this test needs to start from an empty budget"
  );

  // Admit exactly the budget's own ceiling, all against one quiet job with
  // a bound long enough that none of these settle naturally during this
  // test.
  const outstanding: Promise<CallToolResult>[] = [];
  for (let i = 0; i < MAX_OUTSTANDING_FOLLOWS; i++) {
    outstanding.push(followTool.handler({ job_id: jobId, timeout_ms: NEVER_HIT_TIMEOUT_MS }));
  }

  // Every one of those calls has already run its own synchronous
  // admit-then-subscribe prologue by the time the loop above returns:
  // `handler()` is an async function invoked synchronously per call, and
  // it does not suspend at its own first `await` until AFTER admission and
  // subscription - see follow.ts's own handler body.
  assert.equal(jobStore.getOutstandingFollowCount(), MAX_OUTSTANDING_FOLLOWS);
  assert.equal(jobStore.getJobTerminalListenerCount(jobId), MAX_OUTSTANDING_FOLLOWS);

  // The next call, over budget, is REJECTED outright - never queued, never
  // hung waiting for a slot to free up.
  const start = Date.now();
  const rejected = await followTool.handler({ job_id: jobId, timeout_ms: NEVER_HIT_TIMEOUT_MS });
  const elapsed = Date.now() - start;
  assertToolError(rejected, "budget");
  assert.ok(elapsed < 500, `expected an immediate rejection, took ${elapsed}ms`);
  assert.equal(
    jobStore.getOutstandingFollowCount(),
    MAX_OUTSTANDING_FOLLOWS,
    "a rejected call must never touch the budget"
  );
  assert.equal(
    jobStore.getJobTerminalListenerCount(jobId),
    MAX_OUTSTANDING_FOLLOWS,
    "a rejected call must never subscribe anything either"
  );

  // While the budget is fully exhausted, an ordinary, unrelated call - the
  // real status tool, against the same job - stays responsive: the budget
  // gates only follow, never the rest of this server.
  const statusStart = Date.now();
  const statusResult = statusTool.handler({ job_id: jobId });
  const statusElapsed = Date.now() - statusStart;
  assert.notEqual(
    statusResult.isError,
    true,
    `status should succeed while follow's budget is exhausted, got: ${JSON.stringify(statusResult)}`
  );
  assert.ok(
    statusElapsed < 200,
    `expected status to stay responsive while follow's budget is exhausted, took ${statusElapsed}ms`
  );

  // Settle every outstanding follow() by making the job terminal - all
  // MAX_OUTSTANDING_FOLLOWS of them share the same terminal-listener
  // subscription target, so one transition resolves every one of them at
  // once.
  jobStore.markExited(jobId, 0, null);
  const results = await Promise.all(outstanding);
  for (const result of results) {
    assert.notEqual(result.isError, true, `got: ${JSON.stringify(result)}`);
  }

  assert.equal(
    jobStore.getOutstandingFollowCount(),
    0,
    "releasing every admitted call must return the budget to exactly 0"
  );
  assert.equal(jobStore.getJobTerminalListenerCount(jobId), 0);

  // And a fresh follow() call is admitted again, immediately - the budget
  // genuinely recovered rather than staying permanently exhausted.
  const fresh = structuredOf(
    await followTool.handler({ job_id: jobId, cursor: 0, timeout_ms: NEVER_HIT_TIMEOUT_MS })
  );
  assert.equal(fresh.reason, "terminal");
  assert.equal(jobStore.getOutstandingFollowCount(), 0);
});
