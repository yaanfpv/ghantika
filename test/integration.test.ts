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
import { after, test } from "node:test";

import {
  DESCENDANTS_PER_JOB,
  JOBS,
  NOISE_BYTES,
  type SpawnedServer,
  callTool,
  callToolsConcurrently,
  completeHandshake,
  makeTempDir,
  noiseToken,
  pgrepGroupMembers,
  requireStructuredContent,
  spawnServer,
  startNoisyJobs,
  waitForFile,
  waitForPgrepGroupMembers,
} from "./harness.ts";

// The three tests below build real, multi-descendant process trees via
// startNoisyJobs and confirm them with a real external `pgrep -g <pgid>`
// call, neither of which has a Windows equivalent path exercised anywhere
// in this codebase - a test-harness gap, not a product scope decision
// (OD-5: Windows is a supported platform; the real question of whether a
// live job's whole process tree is actually reaped on Windows is
// separate, tracked work).
const PGREP_ORACLE_SKIP =
  process.platform === "win32"
    ? "builds/confirms a real process-group tree via startNoisyJobs + pgrep -g, POSIX-only - see the Windows process-tree kill verification story"
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

// =============================================================================
// THE CENTERPIECE - real stdio client, JOBS=4 concurrent
// noisy multi-descendant jobs, non-blocking status/output on a live job
// plus a 5th job started mid-session, JSON-RPC framing integrity under
// noise.
// =============================================================================

test(
  "THE CENTERPIECE: real stdio client drives JOBS=4 concurrent live jobs (DESCENDANTS-per-job=3, NOISE-bytes=64KiB each); while one stays live the SAME session reads its status/output AND starts a 5th job, non-blocking; framing stays clean under the noise",
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
    // the whole-tree-reap requirement (the OWNING test for that is
    // the dedicated one further down this file, at the full 4x3 scale with
    // its own explicit external-pgrep before/after transcript - this is
    // just this test's own belt-and-braces cleanup, kept lightweight).
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
  "whole-tree reap under the FULL 4x3 concurrent load - a real external pgrep confirms ZERO survivors across ALL 4 jobs' full descendant trees after killing them",
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
        `job ${i} (pgid ${pgids[i]}) must be alive with >= ${1 + DESCENDANTS_PER_JOB} real process-group members immediately before the whole-tree kill, pgrep saw: ${JSON.stringify(members)}`
      );
    });

    // Kill all 4 jobs CONCURRENTLY (not the single-job
    // centerpiece pattern, and not the simpler sequential-friendly
    // cleanup above) - the FULL 4x3 load this test specifically targets.
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
    // codebase's own bookkeeping - must show ZERO survivors across the
    // WHOLE tree for EVERY one of the 4 jobs (12 real descendant processes
    // plus their 4 leaders, 16 processes total), not merely one job's tree.
    const afterMembersByJob = await Promise.all(
      pgids.map((pgid) => waitForPgrepGroupMembers(pgid, (members) => members.length === 0, 5000))
    );
    afterMembersByJob.forEach((members, i) => {
      assert.deepEqual(
        members,
        [],
        `job ${i} (pgid ${pgids[i]}) must have ZERO surviving process-group members after the whole-tree kill, pgrep still saw: ${JSON.stringify(members)}`
      );
    });

    server.child.kill("SIGKILL");
  }
);

test(
  "orphan-proof teardown on a catchable shutdown signal under the FULL 4x3 concurrent load (multiple live jobs at once, not the single-job case)",
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
          `[${trigger}] job ${i} must have ZERO surviving process-group members after shutdown under full concurrent load, pgrep still saw: ${JSON.stringify(members)}`
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
// The win32 code path in src/tools/kill.ts (and src/server.ts's shutdown
// reap) runs only on the suite's Windows legs. This file's own assertions
// have to hold on every leg, so they are written to prove what the code
// does without depending on a real Windows kill happening underneath them.
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
  // "Ignored on Windows, which has no graceful phase"). Checked as "no
  // `(...signal...)` call-argument shape", not a bare substring search for
  // "signal" - this branch's own real comment legitimately DISCUSSES the
  // caller-supplied signal in prose ("regardless of any caller-supplied
  // `signal`"), and a bare substring check would wrongly flag that
  // comment as if it were a code reference.
  assert.equal(
    /\bsignal\b(?!`)/.test(win32Branch.replace(/\/\/.*$/gm, "")),
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
