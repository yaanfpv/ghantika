/**
 * test/harness.ts - a reusable real-stdio-client integration
 * harness. Builds directly on `test/helpers/spawnServer.ts`'s established
 * pattern (a real spawned `dist/index.js` process, real JSON-RPC over its
 * real stdin/stdout - the single most important verification tier) and adds
 * a `tools/call` convenience wrapper (mirrors `test/output-tail.test.ts`'s
 * own `callTool` helper, generalized for reuse), real external-process-
 * observer helpers (the identical `pgrep -g <pgid>` pattern `test/kill.test.ts`
 * and `test/shutdown.test.ts` each already duplicate independently - having
 * a reusable harness collects it here once instead), and an explicit
 * BARRIER primitive (a real polled synchronization point proving a specific
 * state was reached, never a blind fixed `setTimeout`) plus fixed numeric
 * parameters for the concurrent-load proof: `JOBS=4`, `DESCENDANTS_PER_JOB=3`,
 * `NOISE_BYTES=64*1024`.
 *
 * Not a `*.test.ts` file itself (mirrors `spawnServer.ts`'s own "not
 * auto-discovered" property - `npm test`'s glob is
 * `'test/**\/*.test.ts' 'test/**\/*.test.js'`), used by
 * `test/integration.test.ts`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Explicit ".ts" extension - see test/e2e-server.test.ts's identical
// comment on this same helper for why (no relative imports of its own, so
// Node's native TypeScript support can load it directly, unlike src/*.ts).
import { type SpawnedServer, completeHandshake, spawnServer } from "./helpers/spawnServer.ts";

export { type SpawnedServer, completeHandshake, spawnServer };

// ---------------------------------------------------------------------------
// Fixed numeric parameters for the concurrent-load proof:
// JOBS=4, DESCENDANTS-per-job=3, NOISE-bytes=64KiB.
// ---------------------------------------------------------------------------

/** How many concurrent background jobs the real-load proof runs. */
export const JOBS = 4;
/** How many real descendant processes EACH of those jobs itself forks. */
export const DESCENDANTS_PER_JOB = 3;
/** How many bytes of real stdout noise EACH job produces (64 KiB). */
export const NOISE_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// tools/call convenience wrapper (generalizes test/output-tail.test.ts's
// own `callTool` helper, byte-for-byte-identical response shape).
// ---------------------------------------------------------------------------

export interface ToolCallBody {
  readonly error?: { code: number; message: string };
  readonly result?: {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  };
}

/** Sends one `tools/call`, awaits its single response line, and parses it - the one round-trip every test in this file (and test/integration.test.ts) is built from. */
export async function callTool(
  server: SpawnedServer,
  id: number,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000
): Promise<ToolCallBody> {
  server.send({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  const line = await server.nextLine(timeoutMs);
  return line.parsed as ToolCallBody;
}

/**
 * Sends MULTIPLE `tools/call` requests back-to-back (pipelined - every
 * request is written to the child's stdin before this function ever awaits
 * a response), then collects every response matched back to its OWN
 * request by JSON-RPC `id` - never by assumed arrival order. Order is
 * NOT safe to assume here: this is precisely how the
 * non-blocking proof works (a fast `status()` call and a slow `kill()`
 * call with a real grace period can genuinely resolve out of send-order),
 * so matching by `id` is the only sound way to verify a batch of
 * concurrent calls whose completion times legitimately differ. Also the
 * primary place framing corruption would surface: any stray byte on the
 * wire would either fail `JSON.parse` (surfaced as a `parseError` in
 * `server.allLines()`) or, worse, silently produce a line with no `id`
 * that this loop would then simply never match - callers additionally
 * assert `server.allLines()` is 100% parse-clean, closing that gap.
 */
export async function callToolsConcurrently(
  server: SpawnedServer,
  calls: ReadonlyArray<{
    readonly id: number;
    readonly toolName: string;
    readonly args: Record<string, unknown>;
  }>,
  timeoutMs = 15_000
): Promise<Map<number, ToolCallBody>> {
  for (const call of calls) {
    server.send({
      jsonrpc: "2.0",
      id: call.id,
      method: "tools/call",
      params: { name: call.toolName, arguments: call.args },
    });
  }
  const expected = new Set(calls.map((call) => call.id));
  const results = new Map<number, ToolCallBody>();
  const start = Date.now();
  while (results.size < expected.size) {
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) {
      throw new Error(
        `callToolsConcurrently: timed out waiting for ${expected.size - results.size} of ${expected.size} responses (got ids: ${[...results.keys()].join(",")})`
      );
    }
    const line = await server.nextLine(remaining);
    assert.equal(
      line.parseError,
      undefined,
      `callToolsConcurrently: a stdout line failed to parse as JSON - framing corruption: ${JSON.stringify(line.raw)}`
    );
    const id = (line.parsed as { id?: unknown })?.id;
    if (typeof id === "number" && expected.has(id)) {
      results.set(id, line.parsed as ToolCallBody);
    }
  }
  return results;
}

/** The real, non-error `structuredContent` of a `ToolCallBody` - throws with the full body for a failed call, so a broken assertion points straight at what actually came back rather than a bare `undefined` property-access crash. */
export function requireStructuredContent(
  body: ToolCallBody,
  context: string
): Record<string, unknown> {
  assert.equal(
    body.error,
    undefined,
    `${context}: expected no JSON-RPC protocol error, got: ${JSON.stringify(body.error)}`
  );
  assert.notEqual(
    body.result?.isError,
    true,
    `${context}: expected a successful tool result, got isError: ${JSON.stringify(body.result)}`
  );
  const structured = body.result?.structuredContent;
  assert.ok(
    structured,
    `${context}: expected structuredContent, got: ${JSON.stringify(body.result)}`
  );
  return structured;
}

// ---------------------------------------------------------------------------
// Real filesystem side-effect helpers - the single implementation, used by
// test/e2e-server.test.ts, test/kill.test.ts, test/shutdown.test.ts and
// test/integration.test.ts.
// ---------------------------------------------------------------------------

export function makeTempDir(prefix = "ghantika-integration-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface WaitForFileOptions {
  /** How long to keep polling before giving up. */
  readonly timeoutMs?: number;
  /** What counts as the write being finished. Defaults to "any non-empty content". */
  readonly until?: (content: string) => boolean;
}

/**
 * Polls the filesystem for a marker file a spawned job writes, so a test
 * can observe a background job's REAL side effects from outside the server.
 *
 * Waits for CONTENT, never for mere existence. A file appears the instant
 * the writer opens it, which is well before any bytes land: a shell
 * redirect creates its target while setting the redirect up, before the
 * command on the left of the pipe has produced anything at all, and
 * writeFileSync truncates on open too. Polling on existsSync therefore
 * reads an empty file every so often and fails a test the code actually
 * passed, or hands back a half-written value that will not parse.
 *
 * Every caller passes an `until` describing what it is genuinely waiting
 * for - a parseable pgid, the exact bytes a command echoes - so the wait
 * ends when the value is usable rather than when the file is merely
 * non-empty. On timeout the last bytes read are reported, which turns "it
 * timed out" into "it kept reading this".
 */
export async function waitForFile(
  filePath: string,
  {
    timeoutMs = 5000,
    until = (content: string) => content.trim().length > 0,
  }: WaitForFileOptions = {}
): Promise<string> {
  const start = Date.now();
  let lastRead: string | null = null;
  for (;;) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      lastRead = content;
      if (until(content)) return content;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        lastRead === null
          ? `timed out waiting for ${filePath} to appear`
          : `timed out waiting for ${filePath} to hold the expected content; last read ${JSON.stringify(lastRead)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * A marker file holding a process-group id is only usable once the WHOLE
 * number is on disk. `echo $$ > marker` can be observed as "", and it can
 * equally be observed as the leading digits of a longer pid - and Number
 * ("1") is a perfectly valid positive integer that names the wrong
 * process, so a digits-only check is not enough on its own. `echo` always
 * terminates its line, so the trailing newline is what says the number is
 * finished. Waiting on this rather than on non-empty bytes is what makes
 * the pgid the test goes on to kill or pgrep the real one.
 */
export function parsesAsPgid(content: string): boolean {
  if (!content.endsWith("\n")) return false;
  const text = content.trim();
  if (!/^\d+$/.test(text)) return false;
  const pgid = Number(text);
  return Number.isInteger(pgid) && pgid > 0;
}

/** True once `content` is a complete JSON object, so a partial write is never parsed. */
export function parsesAsJsonObject(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Real external process-group observer (the SAME `pgrep -g <pgid>` pattern
// test/kill.test.ts's "THE CENTERPIECE" test and test/shutdown.test.ts's
// whole-tree reap tests each already establish independently - never this
// codebase's own bookkeeping, a real external OS-level check).
// ---------------------------------------------------------------------------

export function pgrepGroupMembers(pgid: number): number[] {
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

export async function waitForPgrepGroupMembers(
  pgid: number,
  condition: (members: number[]) => boolean,
  timeoutMs: number
): Promise<number[]> {
  const start = Date.now();
  for (;;) {
    const members = pgrepGroupMembers(pgid);
    if (condition(members)) return members;
    if (Date.now() - start > timeoutMs) return members;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ---------------------------------------------------------------------------
// BARRIER: an explicit, real synchronization point - polls `predicate` until
// it's true (or times out), never a blind fixed sleep. A synchronization
// point in a test that proves a specific ordering or state was reached
// before proceeding - e.g. "all 4 jobs confirmed running before proceeding
// to the next phase" - not just fire-and-hope timing. Named so every
// barrier in
// test/integration.test.ts reads as a barrier at the call site.
// ---------------------------------------------------------------------------

export async function barrier(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 25
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `barrier "${label}" timed out after ${timeoutMs}ms - the expected state was never reached`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// A real noisy, multi-descendant, real-live job fixture - the exact same
// process-group-leader-writes-its-own-pgid-then-forks-descendants-then-waits
// shape test/kill.test.ts's centerpiece and test/shutdown.test.ts's
// spawnServerWithLiveTree already establish (a real shell child that is the
// process-group LEADER, since spawnManaged always spawns detached - see
// src/process.ts's own docs), extended here to DESCENDANTS_PER_JOB
// descendants and NOISE_BYTES of real stdout noise (plus a smaller amount
// of real stderr noise, for stream-isolation proof) before the final
// `wait`, which is what keeps the whole tree genuinely alive until the test
// decides to kill (or shut down under) it.
// ---------------------------------------------------------------------------

/** A short, distinctive, per-job token so a job's own noise text can never be mistaken for a sibling job's (test/integration.test.ts's stream-isolation proof reads this back out of a live job's own `output()`). */
export function noiseToken(jobIndex: number): string {
  return `GHANTIKA-NOISE-JOB-${jobIndex}`;
}

/**
 * Builds the real shell command line for one noisy, multi-descendant live
 * job. `pgidMarkerPath` receives the shell leader's own pid (== the
 * process group's pgid, by construction - see this file's header) the
 * moment the shell starts, letting the test confirm the tree's real
 * liveness via `pgrepGroupMembers` before ever touching it. `noiseDonePath`
 * receives a marker once the (synchronous, real) noise-writing has
 * completed, so a test can barrier on "this job has genuinely produced its
 * NOISE_BYTES" rather than guessing at timing.
 *
 * Shape: write the pgid marker -> fork `DESCENDANTS_PER_JOB` real
 * background `sleep 60` descendants -> write >= NOISE_BYTES of real stdout
 * noise (via `yes | head -c`, a real, fast, deterministically-sized
 * generator) -> write a smaller amount of real stderr noise -> write the
 * noise-done marker -> `wait` on the backgrounded descendants, which is
 * what keeps the whole tree (leader + descendants) alive until the caller
 * kills it or the server shuts down.
 */
export function buildNoisyLiveJobShellCommand(
  jobIndex: number,
  pgidMarkerPath: string,
  noiseDonePath: string
): string {
  const token = noiseToken(jobIndex);
  // Each descendant fork ends in `&` (backgrounds it) - `&` is ALREADY a
  // statement separator, exactly like `;`, so joining `DESCENDANTS_PER_JOB`
  // of them with spaces and then continuing straight into the next
  // statement (no extra `;` between the last `&` and what follows) is the
  // only valid shape: `sleep 60 & sleep 60 & sleep 60 &;` is a real POSIX
  // shell SYNTAX ERROR ("unexpected token `;'" - verified empirically
  // against both `sh` and `bash`), since a trailing `&` immediately
  // followed by `;` has nothing between them for the semicolon to
  // terminate. `descendantForksPrefix` therefore ends in a trailing space,
  // not a trailing `;`.
  const descendantForksPrefix = `${Array.from({ length: DESCENDANTS_PER_JOB }, () => "sleep 60 &").join(" ")} `;
  return [
    `echo $$ > '${pgidMarkerPath}'`,
    // `yes '<token>-<padding>'` repeats a fixed-length line forever; `head -c NOISE_BYTES`
    // cuts it at EXACTLY NOISE_BYTES real bytes (mid-line at the boundary -
    // a real, honest "partial final line", not engineered away). The
    // descendant forks are prepended directly onto this statement (see
    // `descendantForksPrefix`'s own docs above), not joined via `; `.
    `${descendantForksPrefix}yes '${token}-0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF' | head -c ${NOISE_BYTES}`,
    `yes '${token}-STDERR-NOISE-abcdef0123456789' | head -c 16384 1>&2`,
    `echo done > '${noiseDonePath}'`,
    "wait",
  ].join("; ");
}

export interface NoisyJobsResult {
  readonly jobIds: readonly string[];
  readonly pgids: readonly number[];
  readonly dir: string;
}

/**
 * The shared setup phase both the centerpiece test and
 * the whole-tree-reap-under-load test build on: starts `count`
 * noisy, multi-descendant live jobs CONCURRENTLY (pipelined `run` calls,
 * never awaited one at a time - proving the session doesn't serialize even
 * the starts), then two explicit barriers:
 *
 * 1. every job's real process-group is confirmed alive with
 *    `1 + DESCENDANTS_PER_JOB` real members (the shell leader + its real
 *    descendants) via `pgrepGroupMembers` - a real external observer,
 *    never this codebase's own bookkeeping.
 * 2. every job has genuinely materialized at least `NOISE_BYTES` of real
 *    stdout (read back via a real `status()` call's `counts.stdout_bytes`
 *    field - the public `PublicJobProjection.counts` field -
 *    exercising the byte-accounted buffer layer under real volume, not
 *    just trusting a fixed sleep to have been "probably enough").
 *
 * Returns each job's id and its real external pgid, both in start order,
 * plus the temp dir every marker file lives under (so a caller can add its
 * own additional markers inside the same dir if it needs to).
 */
export async function startNoisyJobs(
  server: SpawnedServer,
  count: number,
  nextId: () => number
): Promise<NoisyJobsResult> {
  const dir = makeTempDir();
  const pgidMarkers = Array.from({ length: count }, (_unused, i) =>
    path.join(dir, `job-${i}-pgid.txt`)
  );
  const noiseDoneMarkers = Array.from({ length: count }, (_unused, i) =>
    path.join(dir, `job-${i}-noise-done.txt`)
  );

  const runCalls = Array.from({ length: count }, (_unused, i) => ({
    id: nextId(),
    toolName: "run",
    args: {
      command: buildNoisyLiveJobShellCommand(i, pgidMarkers[i]!, noiseDoneMarkers[i]!),
      shell: true,
      label: `noisy-job-${i}`,
    },
  }));
  const runResponses = await callToolsConcurrently(server, runCalls);
  const jobIds = runCalls.map(
    (call) =>
      requireStructuredContent(runResponses.get(call.id)!, `run() for job ${call.args.label}`)
        .job_id as string
  );
  for (const jobId of jobIds) assert.equal(typeof jobId, "string");

  // Barrier 1: every job's real process group is genuinely alive with its
  // full descendant tree. Each marker is waited on for a COMPLETE pgid, not
  // for the file existing: the shell creates it on redirect and these jobs
  // start under real concurrent load, so a bare existence wait can read a
  // truncated number and pgrep a process nobody here started. Same 15s
  // budget the barrier primitive uses, since this is the same barrier.
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
  await Promise.all(
    pgids.map(async (pgid, i) => {
      const members = await waitForPgrepGroupMembers(
        pgid,
        (m) => m.length >= 1 + DESCENDANTS_PER_JOB,
        5000
      );
      assert.ok(
        members.length >= 1 + DESCENDANTS_PER_JOB,
        `job ${i} (pgid ${pgid}): expected >= ${1 + DESCENDANTS_PER_JOB} real process-group members (the shell leader + ${DESCENDANTS_PER_JOB} descendants), pgrep saw: ${JSON.stringify(members)}`
      );
    })
  );

  // Barrier 2: every job has genuinely produced its NOISE_BYTES, read back
  // through a real status() call - exercising the byte-accounted buffer
  // layer as the barrier condition itself, not a side observation. Batched
  // as ONE round of concurrent, id-matched status() calls per poll tick
  // (via callToolsConcurrently) rather than `count` independent
  // barrier()-wrapped callTool() loops running concurrently: `callTool`
  // matches its response via plain FIFO `nextLine()`, which is only sound
  // for ONE in-flight call at a time - `count` of them polling
  // independently and concurrently could genuinely cross-match (job 2's
  // poll consuming job 0's response line), the exact class of bug
  // `callToolsConcurrently`'s own id-matching exists to rule out.
  await waitForAllNoiseMaterialized(server, jobIds, nextId);

  return { jobIds, pgids, dir };
}

async function waitForAllNoiseMaterialized(
  server: SpawnedServer,
  jobIds: readonly string[],
  nextId: () => number,
  timeoutMs = 15_000
): Promise<void> {
  const pending = new Set(jobIds.map((_unused, i) => i));
  const start = Date.now();
  while (pending.size > 0) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForAllNoiseMaterialized: timed out after ${timeoutMs}ms waiting for jobs [${[...pending].join(",")}] to reach ${NOISE_BYTES} stdout bytes`
      );
    }
    const indices = [...pending];
    const idToIndex = new Map<number, number>();
    const calls = indices.map((i) => {
      const id = nextId();
      idToIndex.set(id, i);
      return { id, toolName: "status", args: { job_id: jobIds[i]! } };
    });
    const responses = await callToolsConcurrently(server, calls);
    for (const [id, body] of responses) {
      const i = idToIndex.get(id)!;
      const structured = requireStructuredContent(
        body,
        `status(job ${i}) while polling for noise completion`
      );
      const counts = structured.counts as { stdout_bytes: number } | undefined;
      if ((counts?.stdout_bytes ?? 0) >= NOISE_BYTES) pending.delete(i);
    }
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
