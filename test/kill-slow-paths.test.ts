/**
 * The subset of test/kill.test.ts's own cases that are slow by design, not
 * by accident: each proves a real timeout/grace-period/escalation bound
 * actually holds by waiting out a real resistant or hung observer, a real
 * multi-second combined-degraded scenario, or a real stranded-retry
 * sequence. Moved into their own file purely so the file-level timeout
 * this test runner enforces has room for both this file's genuinely slow
 * cases and kill.test.ts's much larger set of fast ones - no assertion,
 * fixture, or behavior changed by the move itself. See kill.test.ts's own
 * header for the full suite's scope; this file is not a separate concern,
 * just a separate timing budget.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import * as killTool from "../dist/tools/kill.js";
import { jobStore } from "../dist/jobStore.js";
import { captureBirthIdentityPosix, isProcessAlive, spawnManaged } from "../dist/process.js";

// Explicit ".ts" extension - this helper has no relative imports of its
// own (only node: builtins), so Node's native TypeScript support can load
// it directly without a build step - see test/e2e-server.test.ts's
// identical comment on the same helper.
import { type SpawnedServer, completeHandshake, spawnServer } from "./helpers/spawnServer.ts";
import { makeTempDir, parsesAsPgid, waitForFile, waitForPgrepGroupMembers } from "./harness.ts";
// Shared with test/kill.test.ts (its own "CONTROL" test uses the same
// scenario) - can't live in either *.test.ts file, since importing a
// *.test.ts module re-runs and re-registers all of its own test() calls.
// See that helper's own header for the full explanation.
import { runStrandedRetryScenario, waitForStdout } from "./helpers/killScenarios.ts";
// Bounded retry absorbing the real fork-visibility race a test's own
// immediate capture-then-assert can hit - see this helper's own header.
import { retryBirthIdentityCapture } from "./helpers/birthIdentityRetry.ts";

// Not shared via import from test/kill.test.ts (see the header comment
// above for why) - duplicated here verbatim rather than moved, since
// kill.test.ts's own copies of these are staying in place unchanged.

const spawned: SpawnedServer[] = [];
function tracked(): SpawnedServer {
  const server = spawnServer();
  spawned.push(server);
  return server;
}

process.on("exit", () => {
  for (const server of spawned) {
    if (!server.child.killed) server.child.kill("SIGKILL");
  }
});

interface RunResponseBody {
  readonly error?: unknown;
  readonly result?: {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: ReadonlyArray<{ type: string; text?: string }>;
  };
}

/**
 * Parses a real wire response's `content[0].text` (the tool's own
 * `JSON.stringify(projection, null, 2)` block - see `toolSuccess` in
 * `src/tools/kill.ts`) back into an object, so a claim about field
 * ABSENCE can be checked against this surface too, not just
 * `structuredContent`. This is a SEPARATE serialization from
 * `structuredContent`: both start from the same `toPublicProjection`
 * object, but `content`'s text is built by this codebase's own
 * `JSON.stringify` inside `toolSuccess`, while `structuredContent` only
 * loses an `undefined`-valued key once the SDK's stdio transport
 * serializes the whole JSON-RPC envelope with its own `JSON.stringify`
 * (`serializeMessage`) on the way out - a real wire round trip is what
 * makes checking BOTH surfaces meaningful here, not redundant.
 */
function parseContentProjection(body: RunResponseBody): Record<string, unknown> {
  const [first] = body.result?.content ?? [];
  assert.ok(
    first?.type === "text" && typeof first.text === "string",
    `expected a text content block, got: ${JSON.stringify(body.result?.content)}`
  );
  return JSON.parse(first!.text!) as Record<string, unknown>;
}

/**
 * Asserts none of `fields` is present as an OWN KEY on `obj` - proving
 * genuine ABSENCE (the key itself is gone, exactly what a real
 * `JSON.stringify` does to an `undefined`-valued property), never merely
 * a falsy or `undefined` VALUE sitting behind a key that's still there.
 */
function assertFieldsAbsent(
  obj: Record<string, unknown>,
  fields: readonly string[],
  context: string
): void {
  for (const field of fields) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(obj, field),
      false,
      `expected "${field}" to be genuinely ABSENT (never present-as-false) in ${context}, got: ${JSON.stringify(obj)}`
    );
  }
}

// ORDERING REGRESSION: a group that exits naturally in the narrow window
// between killProcessGroupPosix's own existence precheck and the actual
// signal syscall must end up recorded as
// `exited`, never `killed` - even under the WORST-CASE ordering, where the
// real natural `exit` callback is deliberately made to arrive AFTER kill()'s
// own handler has already returned. Before this fix, `onSignaled` fired
// unconditionally whenever the send resolved as "ok" (which ESRCH also is),
// synchronously claiming the terminal slot via `markKilled` before the
// delayed natural exit ever got a chance to write anything - first-write-wins
// then locked in the wrong answer. `SignalResult.delivered` (see
// src/process.ts's own docs) is what closes this: `onSignaled` only ever
// fires on a genuine send, so this delayed exit is free to be the actual
// first (and only) writer.
test("kill: ORDERING REGRESSION - a group that exits naturally between the precheck and the SIGTERM syscall ends up 'exited', never 'killed', even when the real exit callback is delayed until after kill() has already returned", async (t) => {
  const record = jobStore.createJob({
    argv: ["sleep", "10"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    isShell: false,
  });
  const child = spawnManaged(
    {
      argv: ["sleep", "10"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
    {
      onSpawn: () => jobStore.markRunning(record.job_id),
      onError: (message) => jobStore.markSpawnFailed(record.job_id, message),
      // Deliberately NOT wired to markExited here - this test drives that
      // call itself, on its own schedule, specifically to simulate it
      // arriving LATE (after kill() has already returned) rather than
      // racing however the real OS/event-loop timing happens to land.
      onExit: () => {},
      onStdoutChunk: () => {},
      onStderrChunk: () => {},
      onStdoutEnd: () => {},
      onStderrEnd: () => {},
    }
  );
  jobStore.attachChild(record.job_id, child!);
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the spawn event actually land
  const pid = child!.pid!;

  const realKill = process.kill.bind(process);
  // Stateful once the simulated "already gone" moment happens: every
  // check from that point on (including the grace-period liveness poll
  // `waitForProcessDeath` runs via `isProcessGroupAlive`) must ALSO report
  // gone - a group that emptied stays empty. Without this, a mock that
  // only overrides the ONE SIGTERM call while still reporting "alive" for
  // every signal-0 existence poll would make production code correctly
  // conclude the group never actually died, forcing an unwanted real
  // escalation to SIGKILL instead of exercising the already-gone path
  // this test means to prove.
  let groupGoneSimulated = false;
  t.mock.method(process, "kill", (target: number, signal?: string | number) => {
    if (target !== -pid) return realKill(target, signal);
    if (groupGoneSimulated) {
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }
    // The precheck (`isProcessGroupAlive`, a bare `kill(pid, 0)`) reports
    // alive, so `killProcessGroupPosix` proceeds to the real send below -
    if (signal === 0) return undefined;
    // - which is exactly where this test simulates the group having
    // emptied on its own in the narrow window since that precheck: the
    // real send now reports ESRCH, never actually reaching the (still
    // genuinely alive, real) sleep process this test spawned.
    if (signal === "SIGTERM") {
      groupGoneSimulated = true;
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }
    return realKill(target, signal);
  });

  try {
    const result = await killTool.handler({ job_id: record.job_id });
    assert.notEqual(result.isError, true, `expected kill to succeed: ${JSON.stringify(result)}`);

    // The real natural exit, deliberately delayed until AFTER kill() has
    // already fully returned - the worst case for the old bug, since a
    // synchronous `onSignaled` firing during kill() would have already
    // claimed the terminal slot by this point if it were still buggy.
    jobStore.markExited(record.job_id, 0, null);

    const finalRecord = jobStore.get(record.job_id);
    assert.equal(
      finalRecord?.state,
      "exited",
      `expected the job to end up 'exited' (the real, natural cause) rather than 'killed' (nothing was ever delivered) - got: ${JSON.stringify(finalRecord)}`
    );
    assert.equal(finalRecord?.exit_code, 0);
    assert.equal(
      finalRecord?.signal,
      undefined,
      "a naturally-exited job must never carry a requested signal it was never actually sent"
    );
  } finally {
    // The mock swallowed every real signal attempt this test's own kill()
    // call made, so the real sleep process this test spawned is still
    // genuinely alive - reap it directly, bypassing the mock entirely.
    realKill(-pid, "SIGKILL");
  }
});

// Confirms the confirm-before-terminal branch's `markKilled` write really
// does wait on `confirmProcessGroupReapedPosix`, not just usually agree
// with it. SIGSTOP is what makes this distinguishing: it never terminates
// the process on its own, so unlike an explicit SIGKILL (whose real exit
// can independently reach "killed" via the natural kill/exit race - see
// kill.ts's own "Process-group confirmation" docs), there is no other way
// for this job to reach "killed" except through this handler's own
// confirm-gated write. An immediate SIGKILL against a naturally-fast-dying
// group can't tell the two orderings apart (the group dies and confirms
// almost immediately either way); this can.
test(
  "kill: a non-terminating custom signal (SIGSTOP) never falsely marks the job killed - the real process stays alive (stopped), reachable for a follow-up kill",
  {
    skip:
      process.platform === "win32"
        ? "sends a real SIGSTOP and reads real `ps` STAT output, POSIX-only"
        : false,
  },
  async () => {
    const record = jobStore.createJob({
      argv: ["sleep", "10"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      isShell: false,
    });
    const child = spawnManaged(
      {
        argv: ["sleep", "10"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      {
        onSpawn: () => jobStore.markRunning(record.job_id),
        onError: (message) => jobStore.markSpawnFailed(record.job_id, message),
        onExit: (code, signal) => jobStore.markExited(record.job_id, code, signal),
        onStdoutChunk: () => {},
        onStderrChunk: () => {},
        onStdoutEnd: () => {},
        onStderrEnd: () => {},
      }
    );
    jobStore.attachChild(record.job_id, child!);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the spawn event actually land

    const result = await killTool.handler({ job_id: record.job_id, signal: "SIGSTOP" });
    assert.notEqual(
      result.isError,
      true,
      `expected kill(SIGSTOP) to succeed: ${JSON.stringify(result)}`
    );
    const structured = result.structuredContent as Record<string, unknown>;
    // THE proof: SIGSTOP pauses a process, it never ends it - the job must
    // NOT be falsely marked terminal just because a signal was sent.
    assert.notEqual(
      structured.state,
      "killed",
      `SIGSTOP must never falsely mark the job killed, got: ${JSON.stringify(structured)}`
    );

    // Both confirmation fields must be genuinely ABSENT, never
    // present-as-false, while the job stays non-terminal - checked on
    // BOTH real serialization surfaces this handler produces. On
    // `structuredContent` (the raw in-memory object this unit-level call
    // sees, never round-tripped through the wire's own JSON.stringify) an
    // absent field reads back as `undefined`, so equality-to-`undefined`
    // is the meaningful assertion here; see the real-wire, non-default-
    // signal test further down in this file (in the "signal-class scope
    // split, over the real wire" section) for the stronger, genuine-
    // own-key-absence proof once these values actually cross a real
    // JSON-RPC wire.
    assert.equal(
      structured.kill_confirmed,
      undefined,
      `expected kill_confirmed to be absent (not false) while unconfirmed, got: ${JSON.stringify(structured)}`
    );
    assert.equal(
      structured.identity_confirmed,
      undefined,
      `expected identity_confirmed to be absent (not false) while unconfirmed, got: ${JSON.stringify(structured)}`
    );
    // On `content[0].text`, this handler's OWN `JSON.stringify` (see
    // `toolSuccess` in src/tools/kill.ts) already drops an
    // `undefined`-valued key for real - a genuine own-key-absence proof,
    // not merely an `undefined` value read off a key that's still there.
    const [contentBlock] = result.content;
    assert.ok(contentBlock?.type === "text" && typeof contentBlock.text === "string");
    const parsedContent = JSON.parse(contentBlock.text) as Record<string, unknown>;
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsedContent, "kill_confirmed"),
      false,
      `expected "kill_confirmed" to be genuinely absent from content[0].text, got: ${JSON.stringify(parsedContent)}`
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsedContent, "identity_confirmed"),
      false,
      `expected "identity_confirmed" to be genuinely absent from content[0].text, got: ${JSON.stringify(parsedContent)}`
    );

    // The real process must be genuinely alive and actually STOPPED (a
    // real external `ps` STAT check, "T" - stopped by a signal - never
    // our own bookkeeping).
    assert.equal(
      isProcessAlive(child!.pid!),
      true,
      "the real process must still be alive after SIGSTOP"
    );
    const stat = execFileSync("ps", ["-p", String(child!.pid), "-o", "stat="], {
      encoding: "utf8",
    }).trim();
    assert.match(
      stat,
      /T/,
      `expected the real process to be in a STOPPED state after SIGSTOP, ps reported stat="${stat}"`
    );

    // THE follow-up proof: because the job was correctly left non-terminal,
    // a follow-up kill() (default signal) must still be able to reach and
    // actually reap the previously-stopped process - permanently
    // stranding it (the pre-fix bug) would make this a no-op instead.
    const followUp = await killTool.handler({ job_id: record.job_id });
    assert.notEqual(
      followUp.isError,
      true,
      `expected the follow-up kill to succeed: ${JSON.stringify(followUp)}`
    );
    const followUpStructured = followUp.structuredContent as Record<string, unknown>;
    assert.equal(followUpStructured.state, "killed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      isProcessAlive(child!.pid!),
      false,
      "the previously-stopped process must actually be reaped by the follow-up kill - never permanently stranded"
    );
  }
);

test(
  "kill: a KILL-TIME identity-observer failure (ps unavailable) never produces a false success - it proceeds via the honest, disclosed DEGRADED path and actually signals the group",
  {
    skip:
      process.platform === "win32"
        ? "manipulates the server process's own PATH to make `ps` unavailable, POSIX-only"
        : false,
  },
  async () => {
    const realPath = process.env.PATH;
    const record = jobStore.createJob({
      argv: ["sleep", "10"],
      cwd: process.cwd(),
      env: { PATH: realPath ?? "/usr/bin:/bin" },
      isShell: false,
    });
    const child = spawnManaged(
      { argv: ["sleep", "10"], cwd: process.cwd(), env: { PATH: realPath ?? "/usr/bin:/bin" } },
      {
        onSpawn: () => jobStore.markRunning(record.job_id),
        onError: (message) => jobStore.markSpawnFailed(record.job_id, message),
        onExit: (code, signal) => jobStore.markExited(record.job_id, code, signal),
        onStdoutChunk: () => {},
        onStderrChunk: () => {},
        onStdoutEnd: () => {},
        onStderrEnd: () => {},
      }
    );
    // Capture a REAL birth identity while PATH still works, matching
    // run()'s own real spawn-time capture - this test targets the
    // KILL-TIME observer breaking, not the spawn-time capture (that is
    // test/run.test.ts's own concern).
    const birthIdentity = await retryBirthIdentityCapture(
      () => captureBirthIdentityPosix(child!.pid!),
      "captureBirthIdentityPosix"
    );
    assert.notEqual(birthIdentity, undefined, "expected a real, successful spawn-time capture");
    jobStore.attachChild(record.job_id, child!, birthIdentity);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(
      isProcessAlive(child!.pid!),
      true,
      "expected the real process to be alive before kill"
    );

    // Make `ps` genuinely unavailable to this process for the duration of
    // the kill() call only - a real fault injection (an ENOENT execFileSync
    // failure), not a mock. Also engages the Linux-only degrade hatch
    // (src/process.ts's GHANTIKA_TEST_DEGRADE_PROC_READ) to the same
    // "observer-failure" outcome - checkProcessIdentity's Linux branch
    // re-reads /proc directly at kill time, never consulting PATH, so
    // breaking PATH alone would have zero effect there; on every other
    // platform this var is simply never read, so setting it is inert.
    const realDegrade = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
    process.env.PATH = "/tmp/does-not-exist-ghantika-empty-path-dir";
    process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = "observer-failure";
    let result: Awaited<ReturnType<typeof killTool.handler>>;
    try {
      result = await killTool.handler({ job_id: record.job_id });
    } finally {
      process.env.PATH = realPath;
      if (realDegrade === undefined) delete process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
      else process.env.GHANTIKA_TEST_DEGRADE_PROC_READ = realDegrade;
    }

    assert.notEqual(
      result.isError,
      true,
      `an observer failure must never surface as a thrown/protocol error either: ${JSON.stringify(result)}`
    );
    const structured = result.structuredContent as Record<string, unknown>;
    // THE proof: this must NOT be the pre-fix false success (state left
    // unchanged, "running") - the group must actually have been signalled,
    // honestly disclosed as degraded (identity never verified).
    assert.equal(
      structured.state,
      "killed",
      `expected the group to actually be signalled via the degraded path, not a false success, got: ${JSON.stringify(structured)}`
    );
    assert.equal(
      structured.identity_confirmed,
      false,
      "identity could not be verified (the observer itself failed) - must be honestly disclosed as unconfirmed, never silently confirmed"
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      isProcessAlive(child!.pid!),
      false,
      "the real process must actually have been reaped via the degraded path, not left alive behind a false success"
    );
  }
);

test(
  "kill: losing the POST-signal pgrep observer (missing binary) after a real signal was sent never throws an uncaught exception - it returns the honest killed-but-unconfirmed result",
  {
    skip:
      process.platform === "win32"
        ? "manipulates the server process's own PATH to make `pgrep` (but not `ps`) unavailable, POSIX-only"
        : false,
  },
  async () => {
    const realPath = process.env.PATH;
    // A PATH containing a real `ps` but no `pgrep` at all - the PRE-signal
    // identity check (which only needs `ps`) succeeds normally; only the
    // POST-signal process-group confirmation (which needs `pgrep`) breaks. This
    // isolates the pgrep-specific bug from the ps-specific one
    // test/process.test.ts's `hasLiveProcessGroupMembersPosix` tests and
    // the identity-observer-failure test above already cover.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-ps-only-path-"));
    const realPsPath = execFileSync("which", ["ps"], { encoding: "utf8" }).trim();
    fs.symlinkSync(realPsPath, path.join(dir, "ps"));

    const record = jobStore.createJob({
      argv: ["sleep", "10"],
      cwd: process.cwd(),
      env: { PATH: realPath ?? "/usr/bin:/bin" },
      isShell: false,
    });
    const child = spawnManaged(
      { argv: ["sleep", "10"], cwd: process.cwd(), env: { PATH: realPath ?? "/usr/bin:/bin" } },
      {
        onSpawn: () => jobStore.markRunning(record.job_id),
        onError: (message) => jobStore.markSpawnFailed(record.job_id, message),
        onExit: (code, signal) => jobStore.markExited(record.job_id, code, signal),
        onStdoutChunk: () => {},
        onStderrChunk: () => {},
        onStdoutEnd: () => {},
        onStderrEnd: () => {},
      }
    );
    const birthIdentity = await retryBirthIdentityCapture(
      () => captureBirthIdentityPosix(child!.pid!),
      "captureBirthIdentityPosix"
    );
    assert.notEqual(birthIdentity, undefined);
    jobStore.attachChild(record.job_id, child!, birthIdentity);
    await new Promise((resolve) => setTimeout(resolve, 50));

    process.env.PATH = dir;
    let result: Awaited<ReturnType<typeof killTool.handler>> | undefined;
    let thrown: unknown;
    try {
      result = await killTool.handler({ job_id: record.job_id });
    } catch (error) {
      thrown = error;
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(
      thrown,
      undefined,
      `kill() must never throw an uncaught exception when pgrep is unavailable - got: ${thrown instanceof Error ? thrown.stack : String(thrown)}`
    );
    assert.notEqual(
      result?.isError,
      true,
      `expected a normal tool result, got: ${JSON.stringify(result)}`
    );
    const structured = result!.structuredContent as Record<string, unknown>;
    // The real signal DID send (ps still worked for the pre-signal
    // identity check) - the job IS killed, just honestly unconfirmed
    // because the post-signal pgrep observer itself was broken.
    assert.equal(structured.state, "killed");
    assert.equal(
      structured.kill_confirmed,
      false,
      "pgrep was unavailable for the process-group confirmation - must be honestly reported as unconfirmed, never silently upgraded to true"
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      isProcessAlive(child!.pid!),
      false,
      "the real signal (SIGTERM, sent successfully) must still have actually killed the process, independent of pgrep's own confirmation failure"
    );
  }
);

test(
  "a caller-supplied signal that never gets externally confirmed leaves the job NON-TERMINAL, with kill_confirmed/identity_confirmed genuinely ABSENT on the real wire (both content and structuredContent) - never present as false - and the job stays reachable for a follow-up kill",
  {
    skip:
      process.platform === "win32"
        ? "sends a real SIGSTOP and reads real pgrep output, POSIX-only"
        : false,
  },
  async () => {
    const server = tracked();
    await completeHandshake(server);

    const dir = makeTempDir("ghantika-kill-e2e-");
    const marker = path.join(dir, "pgid.txt");
    // `exec` replaces the shell process image with `sleep` itself, so
    // there is exactly one real, tracked process to reason about (no
    // separate shell process lingering behind it).
    const shellCommand = `echo $$ > '${marker}'; exec sleep 30`;

    server.send({
      jsonrpc: "2.0",
      id: 540,
      method: "tools/call",
      params: { name: "run", arguments: { command: shellCommand, shell: true } },
    });
    const runLine = await server.nextLine();
    const runBody = runLine.parsed as RunResponseBody;
    assert.equal(runBody.error, undefined);
    assert.notEqual(
      runBody.result?.isError,
      true,
      `run() must succeed: ${JSON.stringify(runBody)}`
    );
    const jobId = runBody.result?.structuredContent?.job_id as string;
    assert.equal(typeof jobId, "string");

    const pgidText = await waitForFile(marker, { until: parsesAsPgid });
    const pgid = Number(pgidText.trim());
    assert.ok(
      Number.isInteger(pgid) && pgid > 0,
      `expected a real numeric pgid from the marker file, got: ${JSON.stringify(pgidText)}`
    );

    const beforeMembers = await waitForPgrepGroupMembers(
      pgid,
      (members) => members.length >= 1,
      3000
    );
    assert.ok(
      beforeMembers.length >= 1,
      `expected the real sleep process alive before kill, pgrep saw: ${JSON.stringify(beforeMembers)}`
    );

    server.send({
      jsonrpc: "2.0",
      id: 541,
      method: "tools/call",
      params: { name: "kill", arguments: { job_id: jobId, signal: "SIGSTOP" } },
    });
    const killLine = await server.nextLine(8000);
    const killBody = killLine.parsed as RunResponseBody;
    assert.equal(killBody.error, undefined);
    assert.notEqual(
      killBody.result?.isError,
      true,
      `kill(SIGSTOP) must succeed: ${JSON.stringify(killBody)}`
    );

    // THE proof: SIGSTOP pauses, never ends, the process - the job must
    // stay non-terminal, and BOTH confirmation fields must be genuinely
    // ABSENT (never present-as-false) on both real wire surfaces.
    assert.notEqual(
      killBody.result?.structuredContent?.state,
      "killed",
      `SIGSTOP must never falsely mark the job killed, got: ${JSON.stringify(killBody.result?.structuredContent)}`
    );
    assertFieldsAbsent(
      killBody.result?.structuredContent ?? {},
      ["kill_confirmed", "identity_confirmed"],
      "the real wire's structuredContent for an unconfirmed non-default signal"
    );
    const contentProjection = parseContentProjection(killBody);
    assertFieldsAbsent(
      contentProjection,
      ["kill_confirmed", "identity_confirmed"],
      "the real wire's content[0].text JSON for an unconfirmed non-default signal"
    );

    // The real process-group member must still genuinely be alive
    // (stopped, not reaped) - a real, independent pgrep, never our own
    // bookkeeping.
    const afterStopMembers = await waitForPgrepGroupMembers(
      pgid,
      (members) => members.length >= 1,
      500
    );
    assert.ok(
      afterStopMembers.length >= 1,
      `expected the real process to still be alive (stopped) after SIGSTOP, pgrep saw: ${JSON.stringify(afterStopMembers)}`
    );

    // THE follow-up proof: because the job was correctly left
    // non-terminal, a follow-up kill() (default signal) must still reach
    // and actually reap the previously-stopped process - permanently
    // stranding it (the pre-fix bug) would make this a no-op instead.
    server.send({
      jsonrpc: "2.0",
      id: 542,
      method: "tools/call",
      params: { name: "kill", arguments: { job_id: jobId } },
    });
    const followUpLine = await server.nextLine(8000);
    const followUpBody = followUpLine.parsed as RunResponseBody;
    assert.notEqual(
      followUpBody.result?.isError,
      true,
      `expected the follow-up kill to succeed: ${JSON.stringify(followUpBody)}`
    );
    assert.equal(followUpBody.result?.structuredContent?.state, "killed");

    const afterFollowUp = await waitForPgrepGroupMembers(
      pgid,
      (members) => members.length === 0,
      3000
    );
    assert.deepEqual(
      afterFollowUp,
      [],
      `expected the previously-stopped process to actually be reaped by the follow-up kill, pgrep still saw: ${JSON.stringify(afterFollowUp)}`
    );

    server.child.kill("SIGKILL");
  }
);

// --- THE COMBINED DEGRADED CELL, at the real handler/wire level ---

test(
  "kill: THE COMBINED DEGRADED CELL - the pre-signal identity check's identity was never captured AND the escalation gate's pre-SIGTERM snapshot ALSO fails (ps/pgrep unavailable): SIGTERM is still sent (best-effort), escalation is REFUSED with no SIGKILL, identity_confirmed is false, escalation_refused_reason is present and honestly describes the send as best-effort (never 'confirmed'/'guarded'), and the real process survives (never falsely marked dead by an unsent SIGKILL)",
  {
    skip:
      process.platform === "win32"
        ? "manipulates the server process's own PATH to make ps/pgrep unavailable, POSIX-only"
        : false,
  },
  async () => {
    const realPath = process.env.PATH;
    const record = jobStore.createJob({
      argv: ["sleep", "10"],
      cwd: process.cwd(),
      env: { PATH: realPath ?? "/usr/bin:/bin" },
      isShell: false,
    });
    // A SIGTERM-RESISTANT real process - ignores the initial SIGTERM
    // entirely, so it genuinely survives the grace period and forces
    // escalation to actually be evaluated (rather than the job dying from
    // SIGTERM alone, which would never reach the escalation gate at all).
    const child = spawnManaged(
      {
        argv: [
          "node",
          "-e",
          "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
        ],
        cwd: process.cwd(),
        env: { PATH: realPath ?? "/usr/bin:/bin" },
      },
      {
        onSpawn: () => jobStore.markRunning(record.job_id),
        onError: (message) => jobStore.markSpawnFailed(record.job_id, message),
        onExit: (code, signal) => jobStore.markExited(record.job_id, code, signal),
        onStdoutChunk: () => {},
        onStderrChunk: () => {},
        onStdoutEnd: () => {},
        onStderrEnd: () => {},
      }
    );
    // The pre-signal identity check's OWN degraded cell: attach with NO birth identity at all (the
    // third argument omitted) - matching evaluatePreSignalIdentityGate's
    // own documented "no identity captured at all" degraded path, which
    // never even attempts a ps call for the FIRST signal.
    jobStore.attachChild(record.job_id, child!);
    await waitForStdout(child!, "ready");

    assert.equal(
      isProcessAlive(child!.pid!),
      true,
      "expected the real resistant process to be alive before kill"
    );

    // The escalation gate's OWN degraded cell: ps/pgrep unavailable for the WHOLE duration
    // of the kill() call, so the escalation identity gate's own
    // pre-SIGTERM snapshot also fails to capture anything usable.
    process.env.PATH = "/tmp/does-not-exist-ghantika-empty-path-dir-combined-degraded-cell";
    let result: Awaited<ReturnType<typeof killTool.handler>>;
    try {
      result = await killTool.handler({ job_id: record.job_id });
    } finally {
      process.env.PATH = realPath;
    }

    assert.notEqual(
      result.isError,
      true,
      `kill() must never surface this combined degradation as a thrown/protocol error: ${JSON.stringify(result)}`
    );
    const structured = result.structuredContent as Record<string, unknown>;

    // THE SIGTERM was still sent, best-effort - the job's state is
    // "killed" via the existing, unmodified synchronous mark-on-SIGTERM
    // mechanism (see kill.ts's own "kill/exit race" docs) - this
    // assertion documents that EXISTING, untouched behavior, not a new
    // claim being introduced here.
    assert.equal(structured.state, "killed");
    assert.equal(
      structured.identity_confirmed,
      false,
      "the pre-signal identity check was never captured at all - honestly disclosed as unconfirmed"
    );
    assert.equal(
      typeof structured.escalation_refused_reason,
      "string",
      `expected an honest, disclosed escalation-refusal reason once escalation was evaluated and refused, got: ${JSON.stringify(structured)}`
    );
    const reason = structured.escalation_refused_reason as string;
    // THE HARD CELL: this combined case must NEVER describe the earlier
    // SIGTERM as "confirmed" or "guarded" - it was a best-effort send,
    // since neither the pre-signal layer nor this escalation snapshot
    // ever positively confirmed anything.
    assert.match(
      reason,
      /best-effort/,
      `expected the combined-degraded reason to honestly describe the earlier SIGTERM as best-effort, got: ${JSON.stringify(reason)}`
    );
    // "confirmed" legitimately appears as part of NEGATIONS here ("never
    // confirmed", "not confirmed") - what must never appear is an
    // AFFIRMATIVE claim that the send itself was confirmed or guarded.
    assert.ok(
      !/\bwas confirmed\b/i.test(reason) && !/\bsigterm was guarded\b/i.test(reason),
      `expected the combined-degraded reason to never affirmatively claim the earlier SIGTERM "was confirmed" or "was guarded" - only that identity was NOT confirmed at either layer, got: ${JSON.stringify(reason)}`
    );
    assert.match(
      reason,
      /never confirmed|not confirmed/,
      `expected the combined-degraded reason to explicitly state identity was never/not confirmed, got: ${JSON.stringify(reason)}`
    );
    assert.ok(
      !/\bguarded\b/.test(reason),
      `expected the combined-degraded reason to never describe the earlier SIGTERM as "guarded" - that word is reserved for the pre-signal-confirmed-plus-escalation-snapshot-failed case, which this is not, got: ${JSON.stringify(reason)}`
    );

    // No SIGKILL was ever sent - the real, resistant process must still
    // genuinely be alive (never falsely marked dead by a signal this
    // handler correctly refused to send).
    assert.equal(
      isProcessAlive(child!.pid!),
      true,
      "expected the real resistant process to have SURVIVED - escalation was correctly refused, so no SIGKILL was ever sent"
    );

    // Real cleanup - this test's own broken-PATH window deliberately left
    // the process unreaped by the code under test.
    process.kill(-child!.pid!, "SIGKILL");
  }
);

test(
  "kill: A STRANDED COMBINED-DEGRADED KILL IS RETRYABLE - the exact combined-degraded scenario above, then a SECOND kill() call against the same job once identity observers recover genuinely re-runs the identity gate (not short-circuited by a stale reap-attempt flag) and actually signals/reaps the still-alive group",
  {
    skip:
      process.platform === "win32"
        ? "manipulates the server process's own PATH to make ps/pgrep unavailable, POSIX-only"
        : false,
  },
  async () => {
    const pidOut: { pid?: number } = {};
    await runStrandedRetryScenario(pidOut);
  }
);
