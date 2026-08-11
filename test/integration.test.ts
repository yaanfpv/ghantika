/**
 * Proves the whole server works together as a real MCP client would use
 * it - not another unit-level pass over one tool in isolation (every tool
 * already has its own real-wire e2e coverage for its own tool), but the
 * INTEGRATION properties that only show up once multiple real jobs,
 * multiple real process trees, and real load are all live in the SAME
 * session at once: non-blocking under real concurrent load, JSON-RPC
 * framing integrity under real noisy child output, and the cross-tool
 * lifecycle assertions no single tool's own suite could fully prove on
 * its own.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  DESCENDANTS_PER_JOB,
  JOBS,
  NOISE_BYTES,
  type SpawnedServer,
  buildNoisyLiveJobShellCommand,
  callTool,
  callToolsConcurrently,
  callToolsConcurrentlyTimed,
  completeHandshake,
  makeTempDir,
  noiseToken,
  parsesAsPgid,
  parsesAsPidList,
  pgrepGroupMembers,
  requireStructuredContent,
  spawnServer,
  startNoisyJobs,
  waitForAllNoiseMaterialized,
  waitForFile,
  waitForPgrepGroupMembers,
} from "./harness.ts";
import { requireSpawnPolicy } from "./helpers/requireSpawnPolicy.ts";

// Every test in this file spawns real jobs through real server subprocesses
// - see test/helpers/requireSpawnPolicy.ts for what this checks and why.
before(requireSpawnPolicy);

// The three tests below build real, multi-descendant process trees via
// startNoisyJobs and confirm them with a real external `pgrep -g <pgid>`
// call, neither of which has a Windows equivalent path exercised anywhere
// in this codebase - a test-harness gap, not a product scope decision.
// Windows is a supported platform; whether a live job's whole process
// tree is actually reaped there is a separate question this test doesn't
// answer by skipping.
const PGREP_ORACLE_SKIP =
  process.platform === "win32"
    ? "builds/confirms a real process-group tree via startNoisyJobs + pgrep -g, POSIX-only"
    : false;

const spawned: SpawnedServer[] = [];
function tracked(): SpawnedServer {
  const server = spawnServer();
  spawned.push(server);
  return server;
}

after(() => {
  // Belt-and-braces cleanup, matching every other e2e suite in this repo
  // (test/e2e-server.test.ts, test/kill.test.ts, test/output-tail.test.ts)
  // - never leave a spawned server process behind after this file's tests
  // finish, even if an individual test failed before reaching its own
  // kill/exit path.
  for (const server of spawned) {
    if (!server.child.killed) server.child.kill("SIGKILL");
  }
});

// A single monotonic JSON-RPC id source shared by every test in this file,
// so two tests can never accidentally collide on the same id even though
// each test spawns its OWN server (ids only need to be unique WITHIN one
// server's session, but a single shared counter is simpler than resetting
// per test and costs nothing).
let idCounter = 10_000;
function nextId(): number {
  idCounter += 1;
  return idCounter;
}

/**
 * Runs `body`, and regardless of whether it resolves normally or throws,
 * reaps every one of `pgids` via a real, direct
 * `process.kill(-pgid, "SIGKILL")` (the SAME mechanism src/process.ts's own
 * `killProcessGroupPosix` uses internally to signal a whole POSIX process
 * group) before returning or rethrowing. `ESRCH` ("no such process") is
 * swallowed - the group is already gone, the expected outcome on a passing
 * run - but any OTHER signal-send failure is logged (never thrown): this
 * cleanup must never itself mask a real failure already propagating out of
 * `body`.
 *
 * Exists because a test that builds real, managed process-group trees (via
 * `startNoisyJobs`/`buildNoisyLiveJobShellCommand`) can throw partway
 * through its own assertions - well before it ever gets to killing those
 * jobs itself - and this file's shared `after()` hook only ever kills the
 * MCP server's OWN top-level child process, never the real job process
 * groups the server spawned on that test's behalf. Without this, a mid-
 * test assertion failure orphans real, live processes on the host. Used by
 * both the resistant-leader-escalation test below and its own guard test
 * (further down this file), which deliberately drives `body` into throwing
 * to prove this reap still runs.
 */
async function withProcessGroupReap<T>(
  pgids: readonly number[],
  body: () => Promise<T>
): Promise<T> {
  try {
    return await body();
  } finally {
    for (const pgid of pgids) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ESRCH") {
          console.error(`[test cleanup] failed to reap process group ${pgid}: ${err.message}`);
        }
      }
    }
  }
}

// =============================================================================
// Real stdio client, JOBS=4 concurrent noisy multi-descendant jobs,
// non-blocking status/output on a live job plus a 5th job started
// mid-session, JSON-RPC framing integrity under noise.
// =============================================================================

test(
  "real stdio client drives JOBS=4 concurrent live jobs (DESCENDANTS-per-job=3, NOISE-bytes=64KiB each); while one stays live the SAME session reads its status/output AND starts a 5th job, non-blocking; framing stays clean under the noise",
  { skip: PGREP_ORACLE_SKIP },
  async () => {
    const server = tracked();
    await completeHandshake(server);

    // Setup phase + both barriers (all inside startNoisyJobs, see its own docs):
    // JOBS=4 noisy jobs started CONCURRENTLY (pipelined `run` calls - the
    // session never serializes even the starts), each confirmed alive with
    // its full DESCENDANTS_PER_JOB=3 real descendant tree via external
    // pgrep, each confirmed to have genuinely materialized its NOISE_BYTES
    // of real stdout via a real status().counts read.
    const { jobIds, pgids } = await startNoisyJobs(server, JOBS, nextId);
    assert.equal(jobIds.length, JOBS);
    assert.equal(pgids.length, JOBS);

    // ---------------------------------------------------------------------
    // THE core proof: while job 0 stays LIVE (never killed yet - its
    // process group is still confirmed alive below), the SAME MCP client
    // session calls status()/output() on it AND starts a FIFTH job, all
    // pipelined together as one concurrent batch - proving the server never
    // blocks the whole session on one live child, jobs/streams stay
    // correctly isolated from each other, and this ALL happens while the
    // other three jobs' 64KiB-each noise sits in their buffers too.
    // ---------------------------------------------------------------------
    const liveJobIndex = 0;
    const liveJobId = jobIds[liveJobIndex]!;
    const livePgid = pgids[liveJobIndex]!;

    // Confirm job 0's tree really is still alive right before the proof
    // (never trust "it should still be alive" - a real external check).
    const stillAliveMembers = pgrepGroupMembers(livePgid);
    assert.ok(
      stillAliveMembers.length >= 1 + DESCENDANTS_PER_JOB,
      `job ${liveJobIndex} must still be genuinely alive with its full tree right before the interleaved proof, pgrep saw: ${JSON.stringify(stillAliveMembers)}`
    );

    const statusCallId = nextId();
    const outputCallId = nextId();
    const fifthJobCallId = nextId();
    const batchStart = Date.now();
    const batchResponses = await callToolsConcurrently(server, [
      { id: statusCallId, toolName: "status", args: { job_id: liveJobId } },
      { id: outputCallId, toolName: "output", args: { job_id: liveJobId, stream: "stdout" } },
      {
        id: fifthJobCallId,
        toolName: "run",
        args: { command: ["true"], label: "fifth-job-mid-session" },
      },
    ]);
    const batchElapsedMs = Date.now() - batchStart;

    // Non-blocking: all three calls - two reads of a still-live noisy job AND
    // starting a brand new job - resolve promptly. A server that serialized
    // the session on the live child (awaited its completion, or awaited any
    // of the other three still-noisy jobs) would take drastically longer
    // than this, since job 0's own shell only exits when its `sleep 60`
    // descendants do.
    const MAX_BATCH_MS = 800;
    assert.ok(
      batchElapsedMs < MAX_BATCH_MS,
      `status()/output() on a live noisy job plus starting a 5th job took ${batchElapsedMs}ms while 4 jobs (16KiB-64KiB+ noise each, live descendant trees) were still running - must never approach the child's own lifetime (non-blocking proof)`
    );

    const statusBody = batchResponses.get(statusCallId)!;
    const statusStructured = requireStructuredContent(statusBody, "status(live job) mid-session");
    assert.equal(statusStructured.job_id, liveJobId);
    assert.equal(
      statusStructured.state,
      "running",
      "job 0 must still genuinely be running - the interleaved proof is meaningless against an already-exited job"
    );

    const outputBody = batchResponses.get(outputCallId)!;
    const outputStructured = requireStructuredContent(outputBody, "output(live job) mid-session");
    const outputEvents = outputStructured.events as Array<{ text: string; stream: string }>;
    assert.ok(
      outputEvents.length > 0,
      "output() on a job that has already produced 64KiB+ of stdout must return real events"
    );

    // Stream/job isolation: job 0's own output must contain
    // ONLY job 0's own noise token, and NEVER any other job's - a real,
    // concrete proof that jobs stay correctly isolated from each other, not
    // merely "each job has its own record" at the type level.
    const ownToken = noiseToken(liveJobIndex);
    for (const event of outputEvents) {
      assert.ok(
        event.text.includes(ownToken) || event.text.length === 0,
        `job ${liveJobIndex}'s own output must consist only of its own noise token "${ownToken}", got: ${JSON.stringify(event.text).slice(0, 120)}`
      );
    }
    for (let otherIndex = 0; otherIndex < JOBS; otherIndex += 1) {
      if (otherIndex === liveJobIndex) continue;
      const otherToken = noiseToken(otherIndex);
      for (const event of outputEvents) {
        assert.equal(
          event.text.includes(otherToken),
          false,
          `job ${liveJobIndex}'s output must NEVER contain job ${otherIndex}'s noise token "${otherToken}" - streams/jobs must stay isolated`
        );
      }
    }

    const fifthJobBody = batchResponses.get(fifthJobCallId)!;
    const fifthJobStructured = requireStructuredContent(
      fifthJobBody,
      "run() for the 5th job mid-session"
    );
    assert.equal(typeof fifthJobStructured.job_id, "string");
    assert.notEqual(fifthJobStructured.job_id, liveJobId);
    assert.ok(
      !jobIds.includes(fifthJobStructured.job_id as string),
      "the 5th job must be a genuinely NEW job, not one of the original 4"
    );
    assert.ok(["starting", "running", "exited"].includes(fifthJobStructured.state as string));

    // ---------------------------------------------------------------------
    // Framing integrity under noise:
    // across this WHOLE test - JOBS=4 jobs each producing NOISE_BYTES of
    // real child stdout/stderr, plus every JSON-RPC request/response
    // exchanged above - every single line this server ever wrote to its own
    // real stdout must be clean, valid, parseable JSON-RPC. A single
    // corrupted byte (e.g. child output leaking onto the server's own
    // stdout channel) would show up here as a parseError.
    // ---------------------------------------------------------------------
    const allLines = server.allLines();
    assert.ok(allLines.length > 0);
    for (const line of allLines) {
      assert.equal(
        line.parseError,
        undefined,
        `every stdout line must be clean JSON-RPC even under ${JOBS}x${NOISE_BYTES}-byte real child noise - got a parse error on: ${JSON.stringify(line.raw).slice(0, 200)}`
      );
      const body = line.parsed as { jsonrpc?: string };
      assert.equal(
        body.jsonrpc,
        "2.0",
        `every stdout line must be a clean JSON-RPC 2.0 message even under real noise, got: ${JSON.stringify(line.raw).slice(0, 200)}`
      );
    }

    // ---------------------------------------------------------------------
    // Cleanup: kill all 4 original noisy jobs (concurrently) - this doubles
    // as this test's own teardown AND is independent evidence toward
    // the process-group-reap requirement, which the dedicated test further
    // down this file checks at the full 4x3 scale with its own explicit
    // external-pgrep before/after transcript - this is just this test's
    // own belt-and-braces cleanup, kept lightweight.
    // ---------------------------------------------------------------------
    const killCalls = jobIds.map((jobId) => ({
      id: nextId(),
      toolName: "kill",
      args: { job_id: jobId },
    }));
    const killResponses = await callToolsConcurrently(server, killCalls, 10_000);
    for (const call of killCalls) {
      const structured = requireStructuredContent(
        killResponses.get(call.id)!,
        `kill(${call.args.job_id})`
      );
      assert.equal(structured.state, "killed");
    }
    server.child.kill("SIGKILL");
  }
);

// =============================================================================
// cross-tool lifecycle assertions this file owns - what
// each tool's own suite could only partially prove on
// its own single-job/simple-pair tests.
// =============================================================================

test("status() immediately after a real kill() reflects the killed state correctly, over the real wire", async () => {
  const server = tracked();
  await completeHandshake(server);

  const runBody = await callTool(server, nextId(), "run", {
    command: ["sleep", "10"],
    label: "status-after-kill",
  });
  const jobId = requireStructuredContent(runBody, "run()").job_id as string;

  // A real moment for the spawn event to actually land before we kill it -
  // matching test/kill.test.ts's own established pattern.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const killBody = await callTool(server, nextId(), "kill", { job_id: jobId }, 8000);
  const killStructured = requireStructuredContent(killBody, "kill()");
  assert.equal(killStructured.state, "killed");
  assert.equal(killStructured.signal, "SIGTERM"); // a plain `sleep` isn't SIGTERM-resistant - matches test/kill.test.ts's own equivalent unit-level assertion, now proven over the real wire

  // status() called IMMEDIATELY after, in the same session - the actual
  // cross-tool assertion this test owns: status()'s own contract for a
  // killed job and kill()'s own contract are each proven independently
  // elsewhere in this suite; this is the proof that calling status() right
  // after a real kill() reflects that same killed state consistently, over the wire.
  const statusBody = await callTool(server, nextId(), "status", { job_id: jobId });
  const statusStructured = requireStructuredContent(
    statusBody,
    "status() immediately after kill()"
  );
  assert.equal(statusStructured.job_id, jobId);
  assert.equal(statusStructured.state, "killed");
  assert.equal(statusStructured.signal, "SIGTERM");
  assert.equal(typeof statusStructured.ended_at, "string");
  assert.equal(
    "exit_code" in statusStructured,
    false,
    "a killed job must never carry exit_code (the nullability contract, reflected faithfully by status() after a real kill())"
  );

  server.child.kill("SIGKILL");
});

test("output()/tail() buffers remain readable after a real kill() (not just after a natural exit)", async () => {
  const server = tracked();
  await completeHandshake(server);

  const dir = makeTempDir();
  const marker = path.join(dir, "wrote-before-kill.txt");
  const runBody = await callTool(server, nextId(), "run", {
    command: `echo before-kill-line-one; echo before-kill-line-two 1>&2; echo wrote > '${marker}'; sleep 30`,
    shell: true,
    label: "post-kill-readable",
  });
  const jobId = requireStructuredContent(runBody, "run()").job_id as string;
  // The job is only genuinely past its write once the echoed word is on
  // disk; the shell creates the redirect target before that.
  await waitForFile(marker, { until: (text) => text.trim() === "wrote" });

  const killBody = await callTool(server, nextId(), "kill", { job_id: jobId }, 8000);
  assert.equal(requireStructuredContent(killBody, "kill()").state, "killed");

  // output() after the kill: both streams' buffered content is exactly
  // what the job wrote before it died - kill() never mutates buffers
  // (src/tools/kill.ts's own documented invariant), now proven over the
  // real wire for real output/tail() calls (test/kill.test.ts's own unit
  // coverage could only prove this indirectly, via a filesystem side effect,
  // because output/tail aren't exercised over the real wire there).
  const outputBody = await callTool(server, nextId(), "output", { job_id: jobId, stream: "both" });
  const outputStructured = requireStructuredContent(outputBody, "output() after kill()");
  const outputEvents = outputStructured.events as Array<{ text: string; stream: string }>;
  assert.ok(
    outputEvents.some((event) => event.stream === "stdout" && event.text === "before-kill-line-one")
  );
  assert.ok(
    outputEvents.some((event) => event.stream === "stderr" && event.text === "before-kill-line-two")
  );

  const tailBody = await callTool(server, nextId(), "tail", {
    job_id: jobId,
    stream: "both",
    lines: 10,
  });
  const tailStructured = requireStructuredContent(tailBody, "tail() after kill()");
  const tailEvents = tailStructured.events as Array<{ text: string; stream: string }>;
  assert.ok(
    tailEvents.some((event) => event.stream === "stdout" && event.text === "before-kill-line-one")
  );
  assert.ok(
    tailEvents.some((event) => event.stream === "stderr" && event.text === "before-kill-line-two")
  );

  server.child.kill("SIGKILL");
});

test(
  "cross-tool: a SIGTERM-resistant job's WHOLE process group is escalated to real SIGKILL after the real ~5s grace period (confirmed genuinely leader-only mid-escalation: its own descendants, forked before the trap, are already gone from the plain SIGTERM while the leader and its keep-alive job are still alive), and status() independently reflects exactly that signal - proven over the real wire, with real status/output reads and real kill() calls on 3 ordinary jobs provably landing while the escalation is still in flight, and a real external pgrep process-group check",
  { skip: PGREP_ORACLE_SKIP },
  async () => {
    const server = tracked();
    await completeHandshake(server);

    // One resistant leader among JOBS=4 concurrent noisy jobs - the SAME
    // load shape startNoisyJobs builds elsewhere in this file, but this
    // test needs one job's own LEADER to trap SIGTERM, a shape
    // startNoisyJobs's own "every job is identical" contract doesn't cover,
    // so the setup is built directly here from the same underlying
    // primitives (buildNoisyLiveJobShellCommand, waitForFile/parsesAsPgid,
    // waitForPgrepGroupMembers, waitForAllNoiseMaterialized) rather than
    // through that wrapper.
    const resistantIndex = 0;
    const normalIndexes = [1, 2, 3];
    const dir = makeTempDir();
    const pgidMarkers = Array.from({ length: JOBS }, (_unused, i) =>
      path.join(dir, `job-${i}-pgid.txt`)
    );
    const noiseDoneMarkers = Array.from({ length: JOBS }, (_unused, i) =>
      path.join(dir, `job-${i}-noise-done.txt`)
    );
    // The resistant leader's own descendants' pids, and its keep-alive
    // anchor's own pid - distinct from `pgidMarkers` above (which only
    // ever names each job's LEADER/pgid) - so the mid-escalation proof
    // below can assert something concrete about these SPECIFIC pids,
    // rather than merely a surviving-member count. See
    // `NoisyLiveJobOptions.descendantPidsMarkerPath`/`anchorPidMarkerPath`
    // in test/harness.ts for the capture mechanism itself.
    const resistantDescendantPidsMarker = path.join(dir, "resistant-descendant-pids.txt");
    const resistantAnchorPidMarker = path.join(dir, "resistant-anchor-pid.txt");

    const runCalls = Array.from({ length: JOBS }, (_unused, i) => ({
      id: nextId(),
      toolName: "run",
      args: {
        command: buildNoisyLiveJobShellCommand(i, pgidMarkers[i]!, noiseDoneMarkers[i]!, {
          sigtermResistant: i === resistantIndex,
          ...(i === resistantIndex
            ? {
                descendantPidsMarkerPath: resistantDescendantPidsMarker,
                anchorPidMarkerPath: resistantAnchorPidMarker,
              }
            : {}),
        }),
        shell: true,
        label: i === resistantIndex ? "sigterm-resistant-leader" : `noisy-job-${i}`,
      },
    }));
    const runResponses = await callToolsConcurrently(server, runCalls);
    const jobIds = runCalls.map(
      (call) =>
        requireStructuredContent(runResponses.get(call.id)!, `run() for job ${call.args.label}`)
          .job_id as string
    );

    // Barrier 1: all 4 real process groups alive with their full descendant
    // trees. For the resistant leader specifically, its `DESCENDANTS_PER_JOB`
    // descendants are forked and its own pgid marker is written BEFORE
    // `trap '' TERM` ever runs (see buildNoisyLiveJobShellCommand's own
    // docs for why that order is what makes the resistance genuinely
    // leader-only) - a parsed pgid here confirms the tree exists, not that
    // the trap is live yet. That's confirmed instead by Barrier 2 below -
    // specifically its own noise-done marker wait: the marker is written
    // well after the trap statement runs, so by the time this test ever
    // calls kill(), the trap is unconditionally already live.
    const pgidTexts = await Promise.all(
      pgidMarkers.map((markerPath) =>
        waitForFile(markerPath, { timeoutMs: 15_000, until: parsesAsPgid })
      )
    );
    const pgids = pgidTexts.map((pgidText, i) => {
      const pgid = Number(pgidText.trim());
      assert.ok(
        Number.isInteger(pgid) && pgid > 0,
        `expected a real numeric pgid from ${pgidMarkers[i]}`
      );
      return pgid;
    });
    await withProcessGroupReap(pgids, async () => {
      await Promise.all(
        pgids.map(async (pgid, i) => {
          const members = await waitForPgrepGroupMembers(
            pgid,
            (m) => m.length >= 1 + DESCENDANTS_PER_JOB,
            5000
          );
          assert.ok(
            members.length >= 1 + DESCENDANTS_PER_JOB,
            `job ${i} (pgid ${pgid}): expected >= ${1 + DESCENDANTS_PER_JOB} real process-group members before the proof, pgrep saw: ${JSON.stringify(members)}`
          );
        })
      );

      // Barrier 1b: the resistant leader's own descendant pids and anchor pid
      // are readable. Both markers are written strictly BEFORE the noise-done
      // marker Barrier 2's own marker wait waits on below (descendants+pgid
      // first, then the trap, then the anchor fork, then noise - see
      // buildNoisyLiveJobShellCommand's own statement order), so by the time
      // Barrier 2 completes these are unconditionally already on disk too;
      // waited on explicitly here anyway, with the same "never trust mere
      // existence, wait for the WHOLE value" discipline every other marker in
      // this file uses (see `parsesAsPidList`'s own docs).
      const resistantDescendantPidsText = await waitForFile(resistantDescendantPidsMarker, {
        timeoutMs: 15_000,
        until: (content) => parsesAsPidList(content, DESCENDANTS_PER_JOB),
      });
      const resistantDescendantPids = resistantDescendantPidsText
        .trim()
        .split("\n")
        .map((line) => Number(line.trim()));
      const resistantAnchorPidText = await waitForFile(resistantAnchorPidMarker, {
        timeoutMs: 15_000,
        until: (content) => parsesAsPidList(content, 1),
      });
      const resistantAnchorPid = Number(resistantAnchorPidText.trim());

      // Barrier 2: all 4 have genuinely produced their NOISE_BYTES of real
      // stdout AND every one of the noise-done marker files actually holds
      // "done" on disk - the resistant leader included, since its trap
      // changes nothing about how it writes its own noise. These are two
      // real, distinct checks, both load-bearing: the stdout-byte poll
      // (via a live status() read) proves the byte-accounted buffer layer
      // genuinely materialized NOISE_BYTES of real output; the marker wait
      // (via a real filesystem read - never mere existence, see
      // `waitForFile`'s own docs) proves the shell script actually reached
      // its own done-marker statement. For the resistant leader
      // specifically, that statement is written strictly AFTER
      // `trap '' TERM` runs (see buildNoisyLiveJobShellCommand's own
      // statement order), so the marker wait is what actually confirms the
      // trap is live before this test ever calls kill() below - the
      // stdout-byte poll alone proves nothing about the trap, since the
      // trap changes nothing about how the leader writes its own noise.
      await waitForAllNoiseMaterialized(server, jobIds, nextId);
      await Promise.all(
        noiseDoneMarkers.map((markerPath) =>
          waitForFile(markerPath, {
            timeoutMs: 15_000,
            until: (content) => content.trim() === "done",
          })
        )
      );

      const resistantJobId = jobIds[resistantIndex]!;
      const resistantPgid = pgids[resistantIndex]!;

      // ---------------------------------------------------------------------
      // THE CORE PROOF: kill() the SIGTERM-resistant leader with NO explicit
      // "signal" argument - src/tools/kill.ts's real DEFAULT path - which
      // sends SIGTERM to the whole process group, then genuinely waits the
      // real POSIX_KILL_GRACE_PERIOD_MS (5000ms, this codebase's own real
      // production constant - never shortened here, unlike this file's other,
      // process.ts-layer unit tests, which inject a short graceMs; this is
      // the real value a real client actually waits through), then escalates
      // to SIGKILL only because the group is still alive - the leader's own
      // `trap '' TERM` makes it survive plain SIGTERM on its own, exactly the
      // regression test/process.test.ts's own "a SIGTERM-resistant process is
      // escalated to SIGKILL" test already proves at the process.ts layer,
      // now proven through the REAL kill TOOL, over the REAL MCP wire.
      //
      // "Under real concurrent load" is proven here as a CONCRETE, timestamped
      // fact, not an ordering assumption: the resistant leader's kill() and
      // real, live activity against the 3 ordinary jobs (a status()/output()
      // read apiece, then their own kill() call) are all dispatched as ONE
      // pipelined batch - every request written to the wire before the
      // client's own first READ of any response in this batch - via
      // `callToolsConcurrentlyTimed`, which records, for each response, the
      // elapsed time from that shared dispatch instant until the client's
      // own read loop dequeues that specific line. The resistant kill's
      // response is asserted to land only after the real ~5s grace period
      // (below); every ordinary job's own kill() response is asserted to
      // have landed well BEFORE that
      // (a real margin, well inside the grace period - see the elapsedMs <
      // 4000 assertion further below), and every ordinary job's status/output
      // read is asserted to have landed BEFORE it too, with no equivalent
      // margin - i.e., the server genuinely answered real status/output reads
      // AND real kill() calls on the other jobs WHILE the resistant leader's
      // own escalation was still unresolved, not merely "requested in the
      // same tick." (This
      // does NOT claim a kill-then-read round-trip on those jobs - one
      // representative ordinary job's (`normalIndexes[0]`) own post-kill
      // state is confirmed separately, see `statusAfterNormalKillBody`
      // further below, as its own distinct, later round-trip.)
      // ---------------------------------------------------------------------
      const resistantKillId = nextId();
      const ordinaryReadCalls = normalIndexes.flatMap((i) => [
        { id: nextId(), toolName: "status", args: { job_id: jobIds[i]! } },
        { id: nextId(), toolName: "output", args: { job_id: jobIds[i]!, stream: "stdout" } },
      ]);
      const ordinaryKillCalls = normalIndexes.map((i) => ({
        id: nextId(),
        toolName: "kill",
        args: { job_id: jobIds[i]! },
      }));
      // Send order matters here (not just batch membership): the resistant
      // kill is listed first so it's dispatched immediately, and each
      // ordinary job's own read calls are listed before that SAME job's kill
      // call, so the server sees (and can answer) the read before it ever
      // sees the request that would change that job's state.
      const overlapCalls = [
        { id: resistantKillId, toolName: "kill", args: { job_id: resistantJobId } },
        ...ordinaryReadCalls,
        ...ordinaryKillCalls,
      ];
      // Dispatched as a PROMISE, not yet awaited: `callToolsConcurrentlyTimed`
      // writes every request in `overlapCalls` to the wire synchronously,
      // before its own first `await` (see its own docs), so by the time this
      // line returns, the resistant kill() has already been sent - the
      // mid-escalation sample below can safely time itself from right here.
      const overlapResponsesPromise = callToolsConcurrentlyTimed(
        server,
        overlapCalls,
        12_000,
        "resistant-escalation-under-concurrent-load"
      );
      // Attached immediately, not just at the `await` further below: if a
      // mid-escalation assertion throws before this test ever reaches
      // `await overlapResponsesPromise`, the promise above is still
      // in-flight and its underlying `nextLine()` calls will eventually
      // settle (resolve or reject) with nothing else listening, which Node
      // reports as an unhandled rejection AFTER this test has already
      // ended - a second, unrelated failure layered on top of the real one.
      // A no-op `.catch` here is a SEPARATE listener from the `await`
      // further below (attaching one doesn't detach or replace the other -
      // both observe the same eventual settlement), so it only ever
      // silences that specific delayed, ownerless rejection; the primary
      // `await overlapResponsesPromise` path further down still throws
      // normally and still fails the test the normal way when it rejects.
      overlapResponsesPromise.catch(() => {});

      // -----------------------------------------------------------------------
      // LEADER-ONLY RESISTANCE PROOF: by this point the client has written
      // every request in the batch above to the wire (see
      // callToolsConcurrentlyTimed's own docs), but nothing here is assumed
      // about how quickly the SEPARATE server process actually reads its
      // stdin, parses the JSON-RPC request, dispatches to the kill handler,
      // and sends the real group SIGTERM - that is genuinely async, subject
      // to OS/event-loop scheduling in a different process, and this test
      // never treats it as instantaneous or synchronous with the dispatch
      // above. Instead of assuming a causal timeline, this polls the REAL
      // external process group repeatedly (never this codebase's own
      // bookkeeping, via `waitForPgrepGroupMembers`) until it directly
      // observes the one discriminating fact this proof needs - every one of
      // the resistant leader's original descendants gone - or a deadline
      // elapses. The deadline is chosen to stay well clear of the real ~5s
      // SIGKILL boundary the resistant kill's own response is asserted to
      // wait past (>= 4900ms, below), so a genuine, non-mutant run has ample
      // room to resolve the poll well before the deadline, while a
      // still-in-flight (or genuinely broken) escalation never gets mistaken
      // for a completed one.
      //
      // Confirmed empirically (see this file's git history/PR for the
      // transcript) against BOTH the real fixture and a deliberately
      // reintroduced version of the original bug (the trap moved back to
      // BEFORE the descendant forks):
      //
      // - Correct code: the poll resolves quickly (well under 1s observed) -
      //   the DESCENDANTS_PER_JOB descendants, forked before the trap ever
      //   ran, die from the plain group SIGTERM within milliseconds, and at
      //   that point the group holds EXACTLY the leader and its keep-alive
      //   anchor.
      // - The original bug (trap set before the forks): every descendant
      //   inherits the SAME ignored disposition as the leader, so the poll's
      //   condition is never satisfied and it runs out the full deadline
      //   with descendants still present - the assertions below then fail
      //   immediately with the same diagnostics they always produced, which
      //   is what makes this a real, discriminating check of "leader-only,"
      //   not merely "the group eventually reaches SIGKILL" (the
      //   escalation-timing assertions further below hold in both cases and
      //   cannot tell them apart on their own).
      // -----------------------------------------------------------------------
      const midEscalationDeadlineMs = 4000;
      const midEscalationPollStart = Date.now();
      const midEscalationMembers = await waitForPgrepGroupMembers(
        resistantPgid,
        (members) => resistantDescendantPids.every((pid) => !members.includes(pid)),
        midEscalationDeadlineMs
      );
      const midEscalationElapsedMs = Date.now() - midEscalationPollStart;
      assert.ok(
        midEscalationMembers.includes(resistantPgid),
        `leader-only resistance proof: the resistant leader's own pid (${resistantPgid}) must still be alive ${midEscalationElapsedMs}ms into its escalation (well before the real ~5s grace period elapses), pgrep saw: ${JSON.stringify(midEscalationMembers)}`
      );
      assert.ok(
        midEscalationMembers.includes(resistantAnchorPid),
        `leader-only resistance proof: the keep-alive anchor job's own pid (${resistantAnchorPid}) must still be alive ${midEscalationElapsedMs}ms into the escalation (it inherited the leader's OWN ignored disposition, forked after the trap), pgrep saw: ${JSON.stringify(midEscalationMembers)}`
      );
      for (const descendantPid of resistantDescendantPids) {
        assert.equal(
          midEscalationMembers.includes(descendantPid),
          false,
          `leader-only resistance proof: descendant pid ${descendantPid} (forked BEFORE the trap ran, so it never inherited the leader's ignored disposition) must already be dead from the plain group SIGTERM (polled for up to ${midEscalationDeadlineMs}ms, observed after ${midEscalationElapsedMs}ms). Surviving here would mean resistance leaked to the whole group, not just the leader - the exact regression this assertion exists to catch. pgrep saw: ${JSON.stringify(midEscalationMembers)}`
        );
      }
      assert.deepEqual(
        [...midEscalationMembers].sort((a, b) => a - b),
        [resistantPgid, resistantAnchorPid].sort((a, b) => a - b),
        `leader-only resistance proof: ${midEscalationElapsedMs}ms into the escalation (polled for up to ${midEscalationDeadlineMs}ms) the resistant leader's process group must contain EXACTLY the leader plus its keep-alive anchor job (2 members) - no surviving descendants, nothing else. pgrep saw: ${JSON.stringify(midEscalationMembers)}`
      );

      const overlapResponses = await overlapResponsesPromise;

      const resistantKillResult = overlapResponses.get(resistantKillId)!;
      const resistantKillStructured = requireStructuredContent(
        resistantKillResult.body,
        "kill(resistant leader)"
      );
      assert.equal(resistantKillStructured.state, "killed");
      assert.equal(
        resistantKillStructured.signal,
        "SIGKILL",
        'a SIGTERM-resistant leader must be recorded as "SIGKILL" once real escalation actually happens, never "SIGTERM" (the signal that was merely SENT first, not the one that actually finished the job - see jobStore.ts\'s own updateKillSignal docs)'
      );
      const killElapsedMs = resistantKillResult.elapsedMs;
      assert.ok(
        killElapsedMs >= 4900,
        `escalation must genuinely wait out the real ~5s grace period before sending SIGKILL, kill() only took ${killElapsedMs}ms`
      );

      // The ordinary jobs' reads: each must show a job that's still
      // genuinely alive and readable, AND the client must have read its
      // response (dequeued it off the wire) before the resistant kill's
      // own response - a real, timestamped ordering, though not a padded
      // margin (unlike the ordinary kills' own elapsedMs < 4000 bound
      // further below, a read here is only ever asserted to land before
      // killElapsedMs, with no independent floor of its own) - not an
      // assumption about send order.
      for (const call of ordinaryReadCalls) {
        const result = overlapResponses.get(call.id)!;
        assert.ok(
          result.elapsedMs < killElapsedMs,
          `ordinary job's ${call.toolName}(${call.args.job_id}) must complete while the resistant leader's escalation is still in flight - it took ${result.elapsedMs}ms, the resistant kill took ${killElapsedMs}ms`
        );
        if (call.toolName === "status") {
          const structured = requireStructuredContent(
            result.body,
            `status(${call.args.job_id}) during the resistant leader's in-flight escalation`
          );
          assert.equal(structured.job_id, call.args.job_id);
          assert.equal(
            structured.state,
            "running",
            "an ordinary job read while the resistant leader's escalation is genuinely in flight must still be genuinely running - real concurrent load, not an already-dead job"
          );
        } else {
          const structured = requireStructuredContent(
            result.body,
            `output(${call.args.job_id}) during the resistant leader's in-flight escalation`
          );
          const events = structured.events as Array<{ text: string }>;
          assert.ok(
            events.length > 0,
            "output() on a still-live ordinary job, read while the resistant leader's escalation is in flight, must return real events"
          );
        }
      }

      // The ordinary jobs' own kill()s: each dies from the default SIGTERM
      // alone, well inside the grace period, no escalation needed (matching
      // every other process-group kill in this file) - AND, per the same
      // timestamped proof, the client genuinely read each one's own
      // response before the resistant leader's, i.e. this real state
      // change on other jobs happened while the resistant escalation was
      // still unresolved.
      for (const call of ordinaryKillCalls) {
        const result = overlapResponses.get(call.id)!;
        const structured = requireStructuredContent(result.body, `kill(${call.args.job_id})`);
        assert.equal(structured.state, "killed");
        assert.equal(
          structured.signal,
          "SIGTERM",
          "a plain (non-resistant) job must die from SIGTERM alone, with no escalation"
        );
        assert.ok(
          result.elapsedMs < 4000,
          `plain jobs must die well within the 5s grace period, took ${result.elapsedMs}ms`
        );
        assert.ok(
          result.elapsedMs < killElapsedMs,
          `an ordinary job's own kill() must complete while the resistant leader's escalation is still in flight - it took ${result.elapsedMs}ms, the resistant kill took ${killElapsedMs}ms`
        );
      }

      // Cross-tool DURABILITY proof (this test's own "and status() afterward
      // reports... for one representative ordinary job and the resistant
      // leader") - distinct from, and NOT part of, the concurrent-overlap
      // proof above: status(), a SEPARATE tool call sent only after the
      // whole overlap batch has already resolved, independently confirms
      // the SAME states/signals that batch's own kill() calls reported for
      // these two jobs, proving each of those two disposition changes is
      // durably recorded in JobStore - readable again on a totally
      // separate, later round trip - not merely reflected in a kill()
      // call's own one-off return value. (The other two ordinary jobs'
      // post-kill states rest on their own in-batch kill() results and the
      // external pgrep zero-survivor check further below, not a later
      // status() round-trip - this durability check does not claim to
      // cover them.)
      const statusAfterNormalKillBody = await callTool(server, nextId(), "status", {
        job_id: jobIds[normalIndexes[0]!]!,
      });
      const statusAfterNormalKillStructured = requireStructuredContent(
        statusAfterNormalKillBody,
        "status() after a plain kill(), a separate round trip"
      );
      assert.equal(statusAfterNormalKillStructured.state, "killed");
      assert.equal(statusAfterNormalKillStructured.signal, "SIGTERM");
      const statusAfterEscalationBody = await callTool(server, nextId(), "status", {
        job_id: resistantJobId,
      });
      const statusAfterEscalationStructured = requireStructuredContent(
        statusAfterEscalationBody,
        "status() after the real escalated kill()"
      );
      assert.equal(statusAfterEscalationStructured.job_id, resistantJobId);
      assert.equal(statusAfterEscalationStructured.state, "killed");
      assert.equal(statusAfterEscalationStructured.signal, "SIGKILL");
      assert.equal(typeof statusAfterEscalationStructured.ended_at, "string");
      assert.equal(
        "exit_code" in statusAfterEscalationStructured,
        false,
        "a killed job must never carry exit_code, even after real SIGKILL escalation"
      );

      // Bullet 3: the resistant leader's output buffer stays readable after
      // termination - output()/tail() must still return its real 64KiB-class
      // noise, never error, even though the job that produced it is now dead
      // (and was killed by escalation, not a plain single signal).
      const outputAfterKillBody = await callTool(server, nextId(), "output", {
        job_id: resistantJobId,
        stream: "stdout",
      });
      const outputAfterKillStructured = requireStructuredContent(
        outputAfterKillBody,
        "output() after the real escalated kill()"
      );
      const outputEvents = outputAfterKillStructured.events as Array<{ text: string }>;
      assert.ok(
        outputEvents.length > 0,
        "output() must still return the resistant leader's real noise after it was killed"
      );
      assert.ok(outputEvents.some((event) => event.text.includes(noiseToken(resistantIndex))));

      const tailAfterKillBody = await callTool(server, nextId(), "tail", {
        job_id: resistantJobId,
        stream: "stdout",
        lines: 20,
      });
      const tailAfterKillStructured = requireStructuredContent(
        tailAfterKillBody,
        "tail() after the real escalated kill()"
      );
      const tailEvents = tailAfterKillStructured.events as Array<{ text: string }>;
      assert.ok(
        tailEvents.length > 0,
        "tail() must still return the resistant leader's real noise after it was killed"
      );

      // Bullet 4: the WHOLE process group - the resistant leader itself
      // PLUS its DESCENDANTS_PER_JOB descendants - is genuinely gone, confirmed by a
      // real, external `pgrep -g <pgid>` call, never this codebase's own
      // bookkeeping. This is the escalation case specifically: the leader
      // survived plain SIGTERM on its own, so this is what proves SIGKILL
      // really did reach and terminate every group member (leader included),
      // not merely the descendants that would have died from SIGTERM anyway.
      const afterResistantMembers = await waitForPgrepGroupMembers(
        resistantPgid,
        (m) => m.length === 0,
        5000
      );
      assert.deepEqual(
        afterResistantMembers,
        [],
        `the SIGTERM-resistant leader's whole process group must be zero-survivor after real SIGKILL escalation, pgrep still saw: ${JSON.stringify(afterResistantMembers)}`
      );

      // And the 3 ordinary jobs' trees too, the same real external check.
      const afterNormalMembers = await Promise.all(
        normalIndexes.map((i) => waitForPgrepGroupMembers(pgids[i]!, (m) => m.length === 0, 5000))
      );
      afterNormalMembers.forEach((members, idx) => {
        assert.deepEqual(
          members,
          [],
          `job ${normalIndexes[idx]}'s tree must be zero-survivor too, pgrep saw: ${JSON.stringify(members)}`
        );
      });

      server.child.kill("SIGKILL");
    });
    // `withProcessGroupReap` (see its own docs above `nextId`) unconditionally
    // reaps all 4 of this test's own real process-group pgids (the resistant
    // leader's own group plus the 3 ordinary jobs' groups) whether the
    // callback above completed normally or threw - this test is the one
    // place in this file where an assertion can throw BEFORE the mid-batch
    // kill() calls are ever awaited (every mid-escalation assertion runs
    // before `overlapResponsesPromise` is awaited), and this file's shared
    // `after()` hook only ever kills the MCP server's OWN top-level child
    // process, never the real job process GROUPS the server itself spawned.
    // This reap is additional to, and does not replace, the assertions
    // above that every tree is ALREADY a zero-survivor by the time a
    // passing run reaches that point; it only does real work when
    // something above threw first (proven directly by this file's own
    // guard test further down, which deliberately reintroduces the
    // original leader-only-resistance bug to drive exactly that path).
  }
);

test(
  "guard: withProcessGroupReap's teardown reaps a resistant leader's real process group even when the mid-escalation assertion throws, and leaves no unhandled rejection behind",
  { skip: PGREP_ORACLE_SKIP },
  async () => {
    const server = tracked();
    await completeHandshake(server);

    const dir = makeTempDir();
    const pgidMarker = path.join(dir, "guard-buggy-pgid.txt");
    const noiseDoneMarker = path.join(dir, "guard-buggy-noise-done.txt");
    const descendantPidsMarker = path.join(dir, "guard-buggy-descendant-pids.txt");
    const token = "GHANTIKA-GUARD-BUGGY-RESISTANT";

    // Deliberately REINTRODUCES the original leader-only-resistance bug
    // `NoisyLiveJobOptions.sigtermResistant`'s own docs (test/harness.ts)
    // describe: the trap is set BEFORE any descendant is forked, so every
    // descendant inherits the leader's own ignored disposition instead of
    // staying plainly killable by a plain group SIGTERM. Inlined here
    // (rather than via buildNoisyLiveJobShellCommand, which only ever
    // produces the CORRECT ordering) specifically so this guard test can
    // drive the exact mid-escalation-assertion-throws failure path
    // `withProcessGroupReap`'s own teardown exists for, without depending
    // on that teardown to prove anything about itself. No keep-alive
    // anchor job is needed here (unlike the real resistant fixture above):
    // with the trap set first, EVERY descendant also inherits the ignored
    // disposition, so the leader's own `wait` (blocking on those same
    // descendants) stays genuinely blocked on its own - the anchor's job
    // in the correctly-ordered fixture is only needed there because the
    // descendants stay killable and would otherwise let `wait` return.
    const descendantForkStatements = Array.from(
      { length: DESCENDANTS_PER_JOB },
      () => `sleep 60 & echo $! >> '${descendantPidsMarker}'`
    ).join("; ");
    const buggyResistantCommand = [
      `echo $$ > '${pgidMarker}'`,
      `trap '' TERM`,
      descendantForkStatements,
      `yes '${token}' | head -c 4096`,
      `echo done > '${noiseDoneMarker}'`,
      "wait",
    ].join("; ");

    const runBody = await callTool(server, nextId(), "run", {
      command: buggyResistantCommand,
      shell: true,
      label: "guard-buggy-resistant-leader",
    });
    const jobId = requireStructuredContent(runBody, "run() for the guard's buggy resistant leader")
      .job_id as string;

    const pgidText = await waitForFile(pgidMarker, { timeoutMs: 15_000, until: parsesAsPgid });
    const pgid = Number(pgidText.trim());
    assert.ok(
      Number.isInteger(pgid) && pgid > 0,
      `guard: expected a real numeric pgid from ${pgidMarker}`
    );

    const descendantPidsText = await waitForFile(descendantPidsMarker, {
      timeoutMs: 15_000,
      until: (content) => parsesAsPidList(content, DESCENDANTS_PER_JOB),
    });
    const descendantPids = descendantPidsText
      .trim()
      .split("\n")
      .map((line) => Number(line.trim()));

    // Both barriers the real escalation test above uses: the real process
    // group alive with its full descendant tree, and the shell has
    // genuinely reached its own done-marker statement (which, per the
    // reintroduced bug's own ordering, runs after the trap too - so this
    // also confirms the trap is live before this guard ever calls kill()).
    await waitForPgrepGroupMembers(pgid, (m) => m.length >= 1 + DESCENDANTS_PER_JOB, 15_000);
    await waitForFile(noiseDoneMarker, {
      timeoutMs: 15_000,
      until: (content) => content.trim() === "done",
    });

    // Dispatched as a promise, deliberately not awaited before the
    // mid-escalation check below - the exact shape the real escalation
    // test's own `overlapResponsesPromise` uses. The immediate no-op
    // `.catch` mirrors that same fix: if the mid-escalation assertion
    // below throws before this test ever reads this promise's result, a
    // delayed settlement here must never surface as a separate unhandled
    // rejection.
    const guardKillId = nextId();
    const killPromise = callToolsConcurrentlyTimed(
      server,
      [{ id: guardKillId, toolName: "kill", args: { job_id: jobId } }],
      12_000,
      "guard-buggy-kill"
    );
    killPromise.catch(() => {});

    // THE ACTUAL PROOF: run the exact mid-escalation shape the real
    // escalation test uses, wrapped in the same `withProcessGroupReap`
    // teardown, against the deliberately reintroduced bug - this
    // assertion is EXPECTED to throw, since every descendant inherited the
    // leader's own ignored disposition and none of them die from the
    // plain group SIGTERM within any real window. 1500ms is ample: the
    // real (correctly-ordered) fixture's own docs report this same
    // condition resolving in well under 1s when the code is correct, so a
    // bug that never resolves it at all is unambiguous well before this
    // deadline elapses.
    let caughtError: unknown;
    try {
      await withProcessGroupReap([pgid], async () => {
        const members = await waitForPgrepGroupMembers(
          pgid,
          (m) => descendantPids.every((pid) => !m.includes(pid)),
          1500
        );
        assert.ok(
          descendantPids.every((pid) => !members.includes(pid)),
          `guard: with the deliberately reintroduced leader-only-resistance bug, every descendant pid should ALREADY be dead from the plain group SIGTERM - if this assertion doesn't fail, the guard fixture itself failed to reproduce the original bug and this guard test proves nothing about the teardown. pgrep saw: ${JSON.stringify(members)}`
        );
      });
    } catch (error) {
      caughtError = error;
    }
    assert.ok(
      caughtError,
      "guard: expected the mid-escalation assertion above to throw against the deliberately reintroduced bug - see that assertion's own message if this fails"
    );

    // (a) THE REAL EXTERNAL PROOF: despite the assertion above throwing,
    // `withProcessGroupReap`'s own `finally` must already have reaped this
    // pgid via a real `process.kill(-pgid, "SIGKILL")` by the time we get
    // here - a real, external `pgrep -g <pgid>` call, never this
    // codebase's own bookkeeping.
    const afterMembers = await waitForPgrepGroupMembers(pgid, (m) => m.length === 0, 3000);
    assert.deepEqual(
      afterMembers,
      [],
      `guard: expected ZERO surviving members of the resistant leader's process group after the mid-escalation assertion threw and withProcessGroupReap's own finally ran, pgrep still saw: ${JSON.stringify(afterMembers)}`
    );

    // (b) no unhandled rejection escapes: give the event loop a real,
    // bounded grace window and watch for one directly. `killPromise`
    // above was never awaited by this test (mirroring the real failure
    // shape), so without its own `.catch` guard, a late settlement here
    // would otherwise surface as a process-level unhandledRejection after
    // this test has already made its assertions - node:test's own run
    // would report that as a failure in its own right (see
    // scripts/run-tests.mjs's own docs on why this project treats an
    // unhandled rejection as a named failure, never something to force
    // past). Reaching the end of this bounded window with nothing
    // observed here, on top of this whole suite run reporting clean, is
    // the concrete evidence.
    let unhandled: unknown;
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandledRejection);
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.off("unhandledRejection", onUnhandledRejection);
    assert.equal(
      unhandled,
      undefined,
      `guard: expected no unhandled rejection to surface after the mid-escalation failure path, got: ${String(unhandled)}`
    );

    server.child.kill("SIGKILL");
  }
);

test(
  "process-group reap under concurrent load - a real external pgrep confirms zero surviving process-group members across every one of several concurrently-killed jobs, each with its own real descendant tree",
  { skip: PGREP_ORACLE_SKIP },
  async () => {
    const server = tracked();
    await completeHandshake(server);

    const { jobIds, pgids } = await startNoisyJobs(server, JOBS, nextId);

    // BEFORE: every one of the 4 jobs' real process groups is confirmed
    // alive with its full DESCENDANTS_PER_JOB tree (startNoisyJobs' own
    // barrier already proved this at setup time - re-confirmed here,
    // immediately before the kill, as the actual "before" half of this
    // test's own before/after transcript).
    const beforeMembersByJob = pgids.map((pgid) => pgrepGroupMembers(pgid));
    beforeMembersByJob.forEach((members, i) => {
      assert.ok(
        members.length >= 1 + DESCENDANTS_PER_JOB,
        `job ${i} (pgid ${pgids[i]}) must be alive with >= ${1 + DESCENDANTS_PER_JOB} real process-group members immediately before the kill, pgrep saw: ${JSON.stringify(members)}`
      );
    });

    // Kill all of the jobs CONCURRENTLY (not the earlier single-job
    // pattern, and not the simpler sequential-friendly cleanup above) -
    // the multi-job load this test specifically targets.
    const killCalls = jobIds.map((jobId) => ({
      id: nextId(),
      toolName: "kill",
      args: { job_id: jobId },
    }));
    const killResponses = await callToolsConcurrently(server, killCalls, 10_000);
    for (const call of killCalls) {
      assert.equal(
        requireStructuredContent(killResponses.get(call.id)!, `kill(${call.args.job_id})`).state,
        "killed"
      );
    }

    // AFTER: a real, independent `pgrep -g <pgid>` call per job - never this
    // codebase's own bookkeeping - must show ZERO surviving process-group
    // members for every one of the jobs (each job's own leader plus its
    // full descendant tree), not merely one job's group.
    const afterMembersByJob = await Promise.all(
      pgids.map((pgid) => waitForPgrepGroupMembers(pgid, (members) => members.length === 0, 5000))
    );
    afterMembersByJob.forEach((members, i) => {
      assert.deepEqual(
        members,
        [],
        `job ${i} (pgid ${pgids[i]}) must have ZERO surviving process-group members after the kill, pgrep still saw: ${JSON.stringify(members)}`
      );
    });

    server.child.kill("SIGKILL");
  }
);

test(
  "orphan-proof teardown on a catchable shutdown signal under concurrent load (multiple live jobs at once, not the single-job case)",
  { skip: PGREP_ORACLE_SKIP },
  async () => {
    async function assertShutdownReapsAllUnderLoad(
      trigger: "stdin EOF" | "SIGTERM" | "SIGINT"
    ): Promise<void> {
      const server = tracked();
      await completeHandshake(server);
      const { pgids } = await startNoisyJobs(server, JOBS, nextId);

      const beforeMembersByJob = pgids.map((pgid) => pgrepGroupMembers(pgid));
      beforeMembersByJob.forEach((members, i) => {
        assert.ok(
          members.length >= 1 + DESCENDANTS_PER_JOB,
          `[${trigger}] job ${i} must be alive with its full tree before shutdown, pgrep saw: ${JSON.stringify(members)}`
        );
      });

      if (trigger === "stdin EOF") {
        server.child.stdin.end();
      } else {
        server.child.kill(trigger);
      }
      const { code, signal } = await server.waitForExit();
      assert.equal(
        code,
        0,
        `[${trigger}] the server's own shutdown handler must exit cleanly even while reaping ${JOBS} concurrent live job trees`
      );
      assert.equal(signal, null);

      const afterMembersByJob = await Promise.all(
        pgids.map((pgid) => waitForPgrepGroupMembers(pgid, (members) => members.length === 0, 5000))
      );
      afterMembersByJob.forEach((members, i) => {
        assert.deepEqual(
          members,
          [],
          `[${trigger}] job ${i} must have ZERO surviving process-group members after shutdown under full concurrent load, pgrep still saw: ${JSON.stringify(members)} (server stderr: ${server.stderrText()})`
        );
      });
    }

    await assertShutdownReapsAllUnderLoad("stdin EOF");
    await assertShutdownReapsAllUnderLoad("SIGTERM");
    await assertShutdownReapsAllUnderLoad("SIGINT");
  }
);

// =============================================================================
// The Windows terminal-mapping nuance.
//
// There is currently no Windows CI signal at all (see this file's
// PGREP_ORACLE_SKIP and CHANGELOG.md's own entry on Windows's removal from
// the test matrix) - the win32 code path in src/tools/kill.ts (and
// src/server.ts's shutdown reap) never actually executes on a real
// Windows host anywhere this suite runs. So the assertions below are
// written to prove what the code does without depending on a real Windows
// kill happening underneath them at all.
//
// The WRONG version of this test would assert something like
// "status()-after-kill always shows state:'killed' with SOME signal
// value, on every platform" - a vacuous, unpinned claim that would pass
// regardless of what Windows actually does, dishonestly implying real
// Windows OS verification this codebase cannot provide.
//
// The RIGHT version, below: assert the EXACT value the
// jobStore code produces - which IS verifiable here, because
// `JobStore.markKilled` is pure, platform-INDEPENDENT bookkeeping (it
// takes whatever signal string its caller passes and records it verbatim
// - see jobStore.ts's own docs), never real OS signal delivery. Separately,
// a structural (source-text) check confirms src/tools/kill.ts's actual
// win32 branch passes exactly that value, unconditionally - a fact about
// this codebase's OWN source, not about Windows itself. Combined, these
// two facts honestly support "on Windows, a killed job's public projection
// will read state:'killed', signal:'SIGKILL-equiv'" as BOOKKEEPING, while
// explicitly declining to claim anything about real Windows OS-level
// signal semantics (which, per process.ts's own docs, `taskkill /f` does
// not really deliver in the POSIX sense at all - "SIGKILL-equiv" here is
// this codebase's own chosen placeholder string, deliberately spelled to
// signal "the Windows equivalent of a kill" rather than a real POSIX
// signal name Windows does not actually have).
// =============================================================================

test("Windows mapping: the killed+signal VALUE Windows will report is exactly what jobStore's platform-independent bookkeeping produces - never a universal/unpinned claim", async () => {
  // jobStore.markKilled/toPublicProjection are imported from the BUILT
  // output (matching test/kill.test.ts's/test/jobStore.test.ts's own
  // established import convention for exactly the same reason - see
  // test/registry.test.ts's comment).
  const { jobStore, toPublicProjection } = await import("../dist/jobStore.js");

  const record = jobStore.createJob({
    argv: ["sleep", "10"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    isShell: false,
  });
  jobStore.markRunning(record.job_id);

  // This call site is deliberately the ONLY thing under test here: real,
  // pure, platform-independent bookkeeping, callable and verifiable on
  // every platform the suite runs on - never a real OS
  // signal delivery. The literal argument "SIGKILL-equiv" is exactly what
  // src/tools/kill.ts's own win32 branch passes (see the structural check
  // below) - so this proves what the DATA will look like on Windows,
  // without claiming anything about Windows OS behavior itself.
  jobStore.markKilled(record.job_id, "SIGKILL-equiv");

  const projection = toPublicProjection(record, jobStore.getOutputCounts(record.job_id));
  // Pinned to the EXACT value - not `typeof projection.signal === "string"`
  // (which is exactly the vacuous "universal" shape this test exists to
  // rule out).
  assert.equal(projection.state, "killed");
  assert.equal(projection.signal, "SIGKILL-equiv");
  // `toPublicProjection` always creates the `exit_code` KEY (assigned from
  // `record.exit_code`, which is `undefined` here) - the `in` operator
  // would see it regardless, so the real nullability contract
  // (the nullability contract: "exit_code present iff exited") is checked against the
  // VALUE, matching what actually reaches the wire: `JSON.stringify` (both
  // `content[0].text` and the real MCP transport's own serialization of
  // `structuredContent`) drops an `undefined`-valued key entirely, so a
  // real client never sees `exit_code` at all for a killed job.
  assert.equal(projection.exit_code, undefined);
  assert.equal(
    JSON.stringify(projection).includes("exit_code"),
    false,
    "a killed job's SERIALIZED projection (what a real client actually receives) must never contain exit_code at all"
  );
});

test('Windows mapping, structural: src/tools/kill.ts\'s real win32 branch passes exactly "SIGKILL-equiv" to jobStore.markKilled, unconditionally - independent of any caller-supplied signal argument', async () => {
  // A source-TEXT structural check, not a live execution - it proves a
  // fact about THIS codebase's own source, which holds on every leg,
  // rather than depending on the branch actually running (it does only on
  // Windows). Same shape as the "guard"-style checks scripts/check-*.mjs
  // already use elsewhere in this repo.
  const killSource = fs.readFileSync(new URL("../src/tools/kill.ts", import.meta.url), "utf8");
  const win32BranchMatch = killSource.match(
    /if \(process\.platform === "win32"\) \{([\s\S]*?)\n {2}\}/
  );
  assert.ok(
    win32BranchMatch,
    'expected to find an `if (process.platform === "win32")` branch in src/tools/kill.ts'
  );
  const win32Branch = win32BranchMatch![1]!;

  assert.match(
    win32Branch,
    /killProcessTreeWindows\(handle\.pid\)/,
    "the win32 branch must call killProcessTreeWindows"
  );
  assert.match(
    win32Branch,
    /jobStore\.markKilled\(jobId, "SIGKILL-equiv"\)/,
    'the win32 branch must record exactly the LITERAL string "SIGKILL-equiv" - the honest placeholder this codebase documents (src/process.ts\'s killProcessTreeWindows docs), deliberately distinct from the real POSIX "SIGKILL" signal name (which Windows does not actually have), and never an expression derived from the caller\'s own "signal" argument (e.g. never `jobStore.markKilled(jobId, signal ?? "SIGKILL-equiv")` or similar - the match above requires the bare literal as markKilled\'s second argument)'
  );
  // The caller's own `signal` VARIABLE must never be passed as an
  // ARGUMENT anywhere in this branch (a real code reference, e.g.
  // `killProcessTreeWindows(handle.pid, signal)` or
  // `markKilled(jobId, signal)`) - Windows has no graceful phase, so it is
  // ignored entirely (src/tools/kill.ts's own inputSchema description:
  // "Ignored on Windows, which has no graceful phase"). Checked by
  // stripping this branch's own `//` line comments first, then doing a
  // bare word-boundary search for the identifier `signal` in what
  // remains: the win32 branch's code, with `//` comments stripped, must
  // not contain the word `signal` at all. This branch's own real comment
  // legitimately DISCUSSES the caller-supplied signal in prose
  // ("regardless of any caller-supplied `signal`"), and without
  // stripping comments first, a substring check would wrongly flag that
  // prose as if it were a code reference.
  assert.equal(
    /\bsignal\b/.test(win32Branch.replace(/\/\/.*$/gm, "")),
    false,
    'the win32 branch\'s CODE (comments stripped) must never reference the caller-supplied "signal" identifier at all - it is unconditionally ignored on Windows'
  );
});

test("Windows mapping, structural: src/server.ts's real win32 shutdown-reap branch (reapOneJobOnShutdown) also passes exactly \"SIGKILL-equiv\" to jobStore.markKilled - the SAME honest placeholder as kill.ts's own win32 branch above, so the two production call sites can never silently drift apart again", async () => {
  // Mirrors the kill.ts structural check above exactly - src/server.ts's
  // shutdown reap has its own separate `if (process.platform === "win32")`
  // branch (reapOneJobOnShutdown), which had the IDENTICAL bug (the wrong
  // literal "SIGKILL") and no dedicated test of its own before this - it
  // was covered only by this file's block-comment prose ("src/server.ts's
  // shutdown reap") never by an actual assertion. This closes that gap.
  const serverSource = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const win32BranchMatch = serverSource.match(
    /if \(process\.platform === "win32"\) \{([\s\S]*?)\n {2}\}/
  );
  assert.ok(
    win32BranchMatch,
    'expected to find an `if (process.platform === "win32")` branch in src/server.ts'
  );
  const win32Branch = win32BranchMatch![1]!;

  assert.match(
    win32Branch,
    /killProcessTreeWindows\(handle\.pid\)/,
    "the win32 shutdown-reap branch must call killProcessTreeWindows"
  );
  assert.match(
    win32Branch,
    /jobStore\.markKilled\(jobId, "SIGKILL-equiv"\)/,
    'the win32 shutdown-reap branch must record exactly the LITERAL string "SIGKILL-equiv" - matching src/tools/kill.ts\'s own win32 branch, never the real POSIX "SIGKILL" signal name (which Windows does not actually have) and never an expression derived from any variable'
  );
});
