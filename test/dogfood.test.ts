/**
 * Dogfood proof: a real, spawned ghantika server's own `run` + Tasks wake
 * can stand in for an external process's file-watcher-based liveness
 * check - not a synthetic unit test of the wake mechanism (that's already
 * covered end to end, in-process, by test/tasks-lifecycle.test.ts), but a
 * real fswatch process, started the same way an external doorbell watcher
 * would start one, run entirely under ghantika's own management, over
 * real stdio, against a scratch mailbox this file fully owns.
 *
 * Three things this file proves, all against the SAME real job in one
 * continuous lifecycle so the correlation between them can't be an
 * artifact of separately-run fixtures:
 *
 *   1. Real wake delivery: `run()` starts a real `fswatch <path>`
 *      process (the same bare, unfiltered command shape a real external
 *      doorbell watcher uses), and the Tasks-capable client genuinely
 *      gets pushed a `notifications/tasks/status` wake the moment that
 *      process reports the scratch mailbox file changed - never a poll
 *      loop standing in for that. A freshly-generated nonce, written into
 *      the watched file, correlates this specific write to the observed
 *      wake: the wake's own seq is independently re-confirmed via
 *      `output()`, and the file's live content is re-read right after the
 *      wake to confirm it still holds the exact nonce this run wrote -
 *      establishing that this write's content is still current at the
 *      moment of the wake, not that this write caused the wake event
 *      itself (fswatch's own event carries only the changed path, never a
 *      content hash or generation count that could establish causation).
 *   2. Absence oracle: while that wake proof is in flight, a real
 *      `pgrep`-based check (anchored on this file's own unique scratch
 *      path, never a bare "fswatch" substring - see the comment on
 *      `escapeRegexPathLiteral` below for why) confirms the ONLY process
 *      whose own command line references that path anywhere is the one
 *      job this test itself started, so the observed wake can't be
 *      explained by some other watcher whose invocation names this same
 *      path. This is a command-line-reference oracle, not a universal
 *      no-other-watcher proof: a process that reached the same file
 *      without that path appearing in its own argv - one that learned it
 *      via stdin, an environment variable, a config file, or one watching
 *      a parent directory - is outside what a `pgrep -f` check can see.
 *   3. Clean rollback: the job is killed through ghantika's own `kill`
 *      tool, and its real backing process's death is confirmed the same
 *      way this repo's other kill-focused suites already do - an
 *      independent, external process-table check, never trust in `kill`'s
 *      own return value alone.
 *
 * What this file deliberately does NOT do: touch any process's real
 * external mailbox or notification path (this scratch mailbox lives
 * entirely under this repo's own gitignored `local/dogfood/test-mailbox/`,
 * owned by whatever local OS account runs this test, structurally
 * isolated from any real external watcher's actual target), or exercise
 * anything about a stale nonce being rejected or a second/duplicate
 * detector being caught after the fact - both are explicitly out of scope
 * for this proof.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// own import comment for why (this codebase's internal ".js" specifiers
// only resolve against a real build, which `npm test` always runs first).
import {
  DEFAULT_POLL_INTERVAL_MS,
  TASKS_EXTENSION_URI,
  TASKS_STATUS_NOTIFICATION_METHOD,
} from "../dist/tasksAdapter.js";
// The SAME identity-gated pre-signal primitives `kill()`'s own production
// path uses (see src/process.ts's own `evaluatePreSignalIdentityGate`
// docs) - reused here so this file's teardown never signals a pid this
// test didn't positively capture and identity-confirm, rather than
// re-implementing a parallel identity check in test code. See Story 0022
// round-six Finding 7 on why the prior owner-blind broad-pattern kill was
// unsafe.
import {
  captureBirthIdentityPosix,
  evaluatePreSignalIdentityGate,
  type ProcessBirthIdentity,
} from "../dist/process.js";

// Explicit ".ts" extension - see test/e2e-server.test.ts's own import
// comment for why spawnServer.ts (no relative imports of its own) is
// loaded this way, unlike the dist/ imports above.
import { type SpawnedServer, spawnServer } from "./helpers/spawnServer.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_MAILBOX_ROOT = path.join(REPO_ROOT, "local", "dogfood", "test-mailbox");

// ---------------------------------------------------------------------------
// Platform/tool gating - matches test/integration.test.ts's own
// PGREP_ORACLE_SKIP: pgrep/fswatch are POSIX tools with no Windows
// equivalent path exercised anywhere in this codebase's own suite, and
// fswatch specifically may simply not be installed on a given POSIX host
// (it's not part of this project's own dependency tree - it's the real
// external tool a real doorbell watcher runs). Both skip reasons are
// registered in test/skip-baseline.json under the platforms where they're
// expected, per this repo's own skip-discipline guard.
// ---------------------------------------------------------------------------

function fswatchIsInstalled(): boolean {
  const result = spawnSync("fswatch", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

const DOGFOOD_SKIP =
  process.platform === "win32"
    ? "POSIX-only: this proof drives a real fswatch process and confirms it via pgrep, neither of which has a Windows equivalent exercised anywhere in this codebase (see test/integration.test.ts's own PGREP_ORACLE_SKIP for the identical rationale)"
    : !fswatchIsInstalled()
      ? "fswatch is not installed on this host - it's the real external tool a doorbell watcher runs, not a dependency of this project; install it (e.g. brew install fswatch / apt-get install fswatch) to run this dogfood proof for real"
      : false;

// ---------------------------------------------------------------------------
// The absence oracle - a real, external process-table check, anchored on
// THIS RUN's own unique scratch path so it can never self-match: never a
// bare "fswatch" substring in the diagnostic's own command line, since a
// diagnostic whose own invocation contains the plain word "fswatch" would
// otherwise self-match. A `pgrep -f` invocation with the pattern passed as its
// own argv element, never interpolated into a shell string, so this
// process's own command line never contains anything that could
// self-match; confirmed empirically before writing this file: a real
// `pgrep -f <path>` call does not match its own invocation even though
// that invocation's argv literally contains <path> as one of its
// elements - pgrep excludes its own pid from its results by design).
// ---------------------------------------------------------------------------

/** Escapes every basic-regex metacharacter `pgrep -f`'s pattern argument could interpret, so a literal path (which always contains at least one `.`) is matched byte-for-byte. */
function escapeRegexPathLiteral(value: string): string {
  return value.replace(/[.[\]\\*^$()+?{|]/g, "\\$&");
}

/** Every real pid whose full command line is EXACTLY `fswatch <triggerPath>` - the same anchored shape a real doorbell watcher's own check uses, so a duplicate/second watcher on this path would show up as a second element, never silently merged into "one match". */
function fswatchPidsOnPath(triggerPath: string): number[] {
  return pgrepPids(`^fswatch ${escapeRegexPathLiteral(triggerPath)}$`);
}

/** Every real pid whose command line references `triggerPath` ANYWHERE, regardless of what's running it - the broader net that catches something other than fswatch also observing this path (a stray `tail -f`, a second poller, anything). */
function anyPidsReferencingPath(triggerPath: string): number[] {
  return pgrepPids(escapeRegexPathLiteral(triggerPath));
}

function pgrepPids(pattern: string): number[] {
  try {
    const stdout = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(Number);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number };
    if (err.status === 1) return []; // pgrep's own "nothing matched" exit code
    throw error;
  }
}

/** Polls the real process table until exactly one real fswatch process is watching `triggerPath` - a genuine barrier on an external OS fact, never a fixed sleep standing in for one (matches test/e2e-server.test.ts's own waitForPgid and test/harness.ts's own barrier). Throws immediately if more than one ever shows up, since that itself is a duplicate-detector finding this test must not silently tolerate. */
async function waitForExactlyOneFswatchPid(triggerPath: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = fswatchPidsOnPath(triggerPath);
    if (pids.length === 1) return pids[0]!;
    if (pids.length > 1) {
      throw new Error(
        `expected exactly one real fswatch process watching ${triggerPath}, found ${pids.length}: ${JSON.stringify(pids)}`
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`no real fswatch process appeared on ${triggerPath} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Polls the real process table until no process anywhere still runs the exact `fswatch <triggerPath>` command line - the external, independent confirmation this cleanup step requires: never trusting kill's own return value alone, matching test/tasks-lifecycle.test.ts's own waitForRealDeath and test/kill.test.ts's real pgrep-based confirmation. */
async function waitForNoFswatchPid(triggerPath: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = fswatchPidsOnPath(triggerPath);
    if (pids.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `fswatch process(es) on ${triggerPath} still alive ${timeoutMs}ms after kill: ${JSON.stringify(pids)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------
// Raw JSON-RPC helpers over the real spawned server's real stdio - the
// same wire tools/call shape test/harness.ts's own callTool uses,
// inlined here because this file also needs to interleave raw
// notification lines (a plain tools/call round trip can't do that) and a
// custom, Tasks-capable initialize (test/helpers/spawnServer.ts's own
// initializeRequest always sends empty capabilities).
// ---------------------------------------------------------------------------

let idCounter = 0;
function nextId(): number {
  idCounter += 1;
  return idCounter;
}

/** The same initialize shape test/helpers/spawnServer.ts's own initializeRequest sends, except declaring the Tasks extension - the one capability a plain client never advertises, and the ONLY signal maybeAugmentRunResult ever consults (see src/tasksAdapter.ts's own isConnectionTasksCapable docs). */
function tasksCapableInitializeRequest(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: { extensions: { [TASKS_EXTENSION_URI]: {} } },
      clientInfo: { name: "ghantika-dogfood-test", version: "0.0.0" },
    },
  };
}

function initializedNotification() {
  return { jsonrpc: "2.0", method: "notifications/initialized" };
}

interface JsonRpcToolResponse {
  readonly jsonrpc: string;
  readonly id: number;
  readonly result?: {
    readonly isError?: boolean;
    readonly content: unknown;
    readonly structuredContent?: Record<string, unknown>;
  };
  readonly error?: { readonly code: number; readonly message: string };
}

async function callTool(
  server: SpawnedServer,
  toolName: string,
  args: Record<string, unknown>
): Promise<JsonRpcToolResponse> {
  const id = nextId();
  server.send({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  const line = await server.nextLine();
  const body = line.parsed as JsonRpcToolResponse;
  assert.equal(
    body.id,
    id,
    `expected the response for request id ${id}, got ${JSON.stringify(body)}`
  );
  return body;
}

function structuredContentOf(response: JsonRpcToolResponse): Record<string, unknown> {
  assert.notEqual(
    response.result?.isError,
    true,
    `expected a successful tool result, got an error result: ${JSON.stringify(response)}`
  );
  assert.ok(response.result, `expected a tool result, got: ${JSON.stringify(response)}`);
  const structured = response.result.structuredContent;
  assert.ok(structured, `expected structuredContent, got: ${JSON.stringify(response.result)}`);
  return structured;
}

interface WakeNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** Reads real stdout lines until one is the exact `notifications/tasks/status` wake (never a substring/prefix match - see src/tasksAdapter.ts's own TASKS_STATUS_NOTIFICATION_METHOD docs on why the wire identity must be exact), bounded by one overall deadline. Any other line seen along the way is not what this is waiting for and is simply skipped - there shouldn't be any, since nothing else is in flight while this is called, but skipping rather than failing on an unexpected line keeps this helper honest about what it actually asserts. */
async function waitForWakeNotification(
  server: SpawnedServer,
  timeoutMs = 8000
): Promise<WakeNotification> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for a real "${TASKS_STATUS_NOTIFICATION_METHOD}" wake notification`
      );
    }
    const line = await server.nextLine(remaining);
    const parsed = line.parsed as { method?: unknown; params?: unknown } | undefined;
    if (
      parsed !== undefined &&
      parsed !== null &&
      parsed.method === TASKS_STATUS_NOTIFICATION_METHOD
    ) {
      return { method: parsed.method, params: (parsed.params ?? {}) as Record<string, unknown> };
    }
  }
}

async function pollStatusUntilTerminal(
  server: SpawnedServer,
  jobId: string,
  maxAttempts = 250
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await callTool(server, "status", { job_id: jobId });
    const structured = structuredContentOf(response);
    if (
      structured.state === "killed" ||
      structured.state === "exited" ||
      structured.state === "failed"
    ) {
      return structured;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${jobId} never reached a terminal state within ${maxAttempts} status polls`);
}

// ---------------------------------------------------------------------------
// Teardown bookkeeping
//
// A scratch record tracks ONLY what this run itself positively launched
// and identified - never a broad "anything referencing this path" set.
// `jobId`/`pid`/`birthIdentity` start undefined and are filled in as the
// test body actually learns them; teardown never signals a pid it has no
// positive record of, and never trusts a bare pid number without an
// identity gate (a pid can be reused by an unrelated process between
// capture and teardown - see src/process.ts's own
// `evaluatePreSignalIdentityGate` docs for why that gate exists at all).
// ---------------------------------------------------------------------------

interface ScratchRecord {
  readonly dir: string;
  jobId?: string;
  pid?: number;
  birthIdentity?: ProcessBirthIdentity;
}

const spawnedServers: SpawnedServer[] = [];
const scratchRecords: ScratchRecord[] = [];

after(async () => {
  // 1. Best-effort, in-band reap via ghantika's own `kill` tool while the
  //    server can still respond - this exercises the exact identity-gated
  //    production kill path the test itself is proving, rather than
  //    re-deriving a parallel one here.
  for (const record of scratchRecords) {
    if (record.jobId === undefined) continue;
    const server = spawnedServers.find((candidate) => !candidate.child.killed);
    if (server === undefined) continue;
    try {
      await callTool(server, "kill", { job_id: record.jobId, signal: "SIGKILL" });
    } catch {
      // Server already unresponsive/torn down, or the job was already
      // terminal - fall through to the direct-pid fallback below.
    }
  }

  // 2. Belt-and-braces, matching every other e2e suite in this repo
  //    (test/integration.test.ts, test/e2e-server.test.ts): never leave a
  //    spawned server process behind, even if an assertion failed before
  //    reaching this test's own kill/close path.
  for (const server of spawnedServers) {
    if (!server.child.killed) server.child.kill("SIGKILL");
  }

  // 3. Direct-pid fallback, gated through the SAME pre-signal identity
  //    check every production kill/shutdown caller uses (see
  //    src/process.ts's own `evaluatePreSignalIdentityGate` docs): only
  //    the pid THIS run positively captured is ever a candidate, and even
  //    that pid is signalled only when its captured birth identity still
  //    matches (or was never capturable at all - the same honestly-
  //    disclosed degraded path production callers take). A pid whose
  //    identity has since diverged (reused by an unrelated process) is
  //    left alone rather than blindly signalled.
  for (const record of scratchRecords) {
    if (record.pid === undefined) continue;
    const gate = await evaluatePreSignalIdentityGate(record.pid, record.birthIdentity);
    if (gate.action !== "proceed") continue; // "skip": confidently gone; "refuse": identity mismatch
    try {
      process.kill(record.pid, "SIGKILL");
    } catch {
      // Already gone - nothing to do.
    }
  }

  // 4. Report-only: the broad "anything whose command line references this
  //    path" oracle is a DIAGNOSTIC surface here, never a kill target set
  //    (Story 0022 round-six Finding 7 - an owner-blind pid list is not
  //    safe destructive authority, however unlikely the random scratch
  //    path makes an accidental collision). Anything still showing up here
  //    after steps 1-3 is something this test never positively identified
  //    as its own, so it is surfaced, not silently destroyed.
  for (const record of scratchRecords) {
    const stragglers = anyPidsReferencingPath(record.dir);
    if (stragglers.length > 0) {
      console.error(
        `[dogfood teardown] ${stragglers.length} unidentified process(es) still reference ${record.dir} after positive-identity cleanup: ${JSON.stringify(stragglers)} - left alone, not killed (see Story 0022 round-six Finding 7)`
      );
    }
    try {
      fs.rmSync(record.dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
});

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

test(
  "dogfood: a real ghantika run() job running fswatch on a scratch mailbox proves the Tasks wake genuinely fires on a real file change, correlated to a fresh nonce via output(), with no other process's command line referencing the trigger path, and a confirmed kill+reap rollback",
  { skip: DOGFOOD_SKIP },
  async () => {
    fs.mkdirSync(TEST_MAILBOX_ROOT, { recursive: true });
    const scratchDir = fs.mkdtempSync(path.join(TEST_MAILBOX_ROOT, `${randomUUID()}-`));
    const scratchRecord: ScratchRecord = { dir: scratchDir };
    scratchRecords.push(scratchRecord);
    const triggerPath = path.join(scratchDir, ".trigger");
    // Pre-create a stable, empty inode before watching starts - the same
    // precondition a real external watcher should establish before
    // starting fswatch, so this test's fixture matches a realistic armed
    // shape rather than watching a path that doesn't exist yet.
    fs.writeFileSync(triggerPath, "", "utf8");
    const resolvedTriggerPath = fs.realpathSync(triggerPath);

    const server = spawnServer();
    spawnedServers.push(server);

    // --- Handshake: a Tasks-capable client, over real stdio ---------------
    server.send(tasksCapableInitializeRequest(nextId()));
    const initLine = await server.nextLine();
    const initBody = initLine.parsed as {
      result?: { capabilities?: { extensions?: Record<string, unknown> } };
    };
    assert.ok(
      initBody.result?.capabilities?.extensions !== undefined &&
        Object.hasOwn(initBody.result.capabilities.extensions, TASKS_EXTENSION_URI),
      `expected the server's real initialize response to advertise ${TASKS_EXTENSION_URI} under capabilities.extensions, got: ${JSON.stringify(initBody)}`
    );
    server.send(initializedNotification());

    // --- command-line-reference baseline: no process line matches this brand-new path yet ---
    assert.deepEqual(
      fswatchPidsOnPath(triggerPath),
      [],
      "expected no real fswatch process on this fresh scratch path before run() ever starts one"
    );

    // --- run() mints a real task and starts a REAL fswatch job --------
    // The argv form (never shell: true) is a bare, unfiltered
    // `fswatch <path>`, deliberately with no -x and no --event filter:
    // an --event filter would drop the AttributeModified class a plain
    // file write like this test's own produces, which would silently
    // defeat the whole proof.
    const runResponse = await callTool(server, "run", {
      command: ["fswatch", triggerPath],
      label: "dogfood-fswatch",
    });
    const minted = structuredContentOf(runResponse);
    assert.equal(
      minted.extension,
      TASKS_EXTENSION_URI,
      "on a Tasks-capable connection, run() must mint a real TaskResult, not the plain {job_id} shape - this is the six-tool mint rule from src/tasksAdapter.ts"
    );
    assert.equal(typeof minted.taskId, "string");
    const jobId = minted.taskId as string;
    // Recorded the instant it is known, so a teardown triggered by an
    // assertion throwing anywhere below this line still has a real job_id
    // to attempt an in-band kill against - never left to the LAST line of
    // a passing run to populate it.
    scratchRecord.jobId = jobId;
    assert.equal(minted.status, "working");
    assert.equal(minted.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);

    // --- the exact-argv backing-process barrier: the real process genuinely exists ---
    const ghantikaFswatchPid = await waitForExactlyOneFswatchPid(triggerPath);
    // Same reasoning as jobId above: captured as soon as the real pid is
    // known, with its birth identity, so the after() hook's direct-pid
    // fallback is never signalling a pid it never positively identified.
    scratchRecord.pid = ghantikaFswatchPid;
    scratchRecord.birthIdentity = await captureBirthIdentityPosix(ghantikaFswatchPid);
    assert.deepEqual(
      anyPidsReferencingPath(triggerPath).sort((a, b) => a - b),
      [ghantikaFswatchPid],
      `expected the ONLY process referencing ${triggerPath} anywhere in its command line to be ghantika's own spawned job (pid ${ghantikaFswatchPid})`
    );

    // --- ring the doorbell with a fresh, correlatable nonce ------------
    // The wake listener is registered BEFORE the write (server.nextLine's
    // waiter is pushed synchronously - see test/helpers/spawnServer.ts's
    // own unconsumed-queue docs), so no notification the write triggers
    // can ever be missed to an ordering race.
    const nonce = randomBytes(16).toString("hex");
    const wakePromise = waitForWakeNotification(server);
    fs.writeFileSync(triggerPath, nonce, "utf8");

    // --- the in-flight command-line-reference oracle, run while the wake proof is pending -----
    // (immediately after the ring, before the wake has even resolved)
    assert.deepEqual(fswatchPidsOnPath(triggerPath), [ghantikaFswatchPid]);
    assert.deepEqual(
      anyPidsReferencingPath(triggerPath).sort((a, b) => a - b),
      [ghantikaFswatchPid]
    );

    const wake = await wakePromise;

    // --- the repeated post-wake command-line-reference oracle: same invariant immediately after the wake resolved ------
    // (still mid-proof - the correlation checks below haven't run yet)
    assert.deepEqual(fswatchPidsOnPath(triggerPath), [ghantikaFswatchPid]);
    assert.deepEqual(
      anyPidsReferencingPath(triggerPath).sort((a, b) => a - b),
      [ghantikaFswatchPid]
    );

    // --- the wake's own payload names this exact job and this exact change ---
    assert.equal(wake.params.extension, TASKS_EXTENSION_URI);
    assert.equal(wake.params.taskId, jobId);
    // This establishes at least one matching wake line, never exactly one -
    // it does not rule out duplicate delivery.
    const wakeLines = wake.params.stdout as Array<{ seq: number; text: string; partial?: true }>;
    assert.ok(
      Array.isArray(wakeLines) && wakeLines.length >= 1,
      `expected at least one stdout line in the wake payload, got: ${JSON.stringify(wake.params)}`
    );
    const changedPathLine = wakeLines.find((entry) => entry.text.trim() === resolvedTriggerPath);
    assert.ok(
      changedPathLine,
      `expected the wake's stdout batch to include the changed path fswatch itself reports (${resolvedTriggerPath}); got: ${JSON.stringify(wakeLines)}`
    );

    // --- independently re-confirm the SAME seq via output(), never trusting the wake payload alone ---
    const outputResponse = await callTool(server, "output", { job_id: jobId, stream: "stdout" });
    const outputBody = structuredContentOf(outputResponse);
    const outputEvents = outputBody.events as Array<{ seq: number; stream: string; text: string }>;
    const matchingEvent = outputEvents.find((event) => event.seq === changedPathLine!.seq);
    assert.ok(
      matchingEvent,
      `expected output() to independently confirm the exact seq ${changedPathLine!.seq} the wake carried; got events: ${JSON.stringify(outputEvents)}`
    );
    assert.equal(matchingEvent.stream, "stdout");
    assert.equal(matchingEvent.text.trim(), resolvedTriggerPath);

    // --- the correlation between this wake and THIS nonce, through live file content ---
    // fswatch's own output is just the changed PATH, never file content -
    // so the nonce correlation checked here is temporal and state-based,
    // not causal: re-reading the scratch file's real, live, on-disk
    // content right after the wake and confirming it is still exactly the
    // nonce this run generated and wrote moments ago establishes that
    // this write's content is what the file currently holds at the
    // moment of the wake - it does not establish that this write is what
    // triggered the wake event itself.
    const liveContent = fs.readFileSync(triggerPath, "utf8");
    assert.equal(
      liveContent,
      nonce,
      "the scratch mailbox's live content must still be exactly the nonce this run wrote - confirming this write's content is still current at the moment of the wake, not that this write caused the wake event"
    );

    // --- kill through ghantika's own tool, confirm terminal state, then confirm the real process is gone via the process table ---
    const killResponse = await callTool(server, "kill", { job_id: jobId, signal: "SIGKILL" });
    structuredContentOf(killResponse); // asserts success; the projection itself isn't otherwise needed here

    const finalStatus = await pollStatusUntilTerminal(server, jobId);
    assert.equal(finalStatus.state, "killed");

    // Never trust kill's own return value alone - an independent, external
    // process-table check, the same convention test/tasks-lifecycle.test.ts's
    // own waitForRealDeath and test/kill.test.ts's pgrep-based confirmation
    // already use.
    await waitForNoFswatchPid(triggerPath);

    // The broad net too - every other absence-oracle checkpoint in this file
    // (right after run() starts, and twice more around the wake) pairs the
    // fswatch-anchored check above with this broader "anything at all"
    // check; this is the one point in the file's own lifecycle where only
    // the narrow form ran. Confirms a clean rollback means no process whose
    // command line references the scratch path anywhere once kill+reap has
    // settled - not merely that nothing fswatch-shaped does, which would
    // miss some other process type (a stray tail -f, a second poller) left
    // referencing the path in its own command line.
    assert.deepEqual(
      anyPidsReferencingPath(triggerPath),
      [],
      `expected no process whose command line references ${triggerPath} anywhere after kill+reap - not merely that no fswatch-shaped one remains`
    );

    server.child.kill("SIGKILL");
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
);
