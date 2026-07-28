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
  const timed = await callToolsConcurrentlyTimed(server, calls, timeoutMs, "callToolsConcurrently");
  return new Map([...timed].map(([id, result]) => [id, result.body]));
}

export interface TimedToolCallResult {
  readonly body: ToolCallBody;
  /**
   * Milliseconds from just before this BATCH's requests are written to the
   * wire (the shared `start` taken before the send loop, not after it)
   * until THIS specific response was read back off it - i.e. the moment
   * the CLIENT's own `nextLine()` read loop dequeued/consumed this line,
   * not an independent wire-arrival timestamp (`RawStdoutLine`/the
   * underlying line-reading mechanism carries no such timestamp of its
   * own - see `spawnServer.ts`). Lets a caller prove, with a real
   * timestamp rather than an ordering assumption, that one call's
   * response was genuinely available for the client to consume while
   * another (slower) call in the SAME batch was still unresolved on the
   * server - e.g. a fast read's response already read back while a slow
   * escalating `kill()` elsewhere in the same batch has not yet responded,
   * which is exactly the property "these two things happened
   * concurrently" needs and "both were sent in the same tick" alone does
   * not prove. A dequeue-time ordering is still a valid (if conservative)
   * proof that one response was available for consumption before another -
   * every RELATIVE comparison this file makes between two calls in the
   * same batch relies only on that, never on absolute wire-arrival time.
   * The shared baseline being "just before the writes" rather than "just
   * after" doesn't affect any such comparison either - both elapsedMs
   * values share the same offset, so which one is smaller is unchanged
   * either way.
   */
  readonly elapsedMs: number;
}

/**
 * Same pipelining/id-matching contract as `callToolsConcurrently` (see its
 * own docs - this function backs it), but returns each response's own
 * read/dequeue time (see `TimedToolCallResult.elapsedMs`'s own docs for
 * why that, not wire-arrival time, is the honest description) alongside
 * its body instead of discarding it. Used directly by
 * `callToolsConcurrently`'s callers that don't need timing, and by
 * test/integration.test.ts's resistant-leader-escalation test, which
 * needs concrete, timestamped proof that real activity against other live
 * jobs was answered WHILE a slow, escalating `kill()` in the SAME batch
 * was still in flight - not merely that every request was written to the
 * wire around the same time.
 */
export async function callToolsConcurrentlyTimed(
  server: SpawnedServer,
  calls: ReadonlyArray<{
    readonly id: number;
    readonly toolName: string;
    readonly args: Record<string, unknown>;
  }>,
  timeoutMs = 15_000,
  callerName = "callToolsConcurrentlyTimed"
): Promise<Map<number, TimedToolCallResult>> {
  const start = Date.now();
  for (const call of calls) {
    server.send({
      jsonrpc: "2.0",
      id: call.id,
      method: "tools/call",
      params: { name: call.toolName, arguments: call.args },
    });
  }
  const expected = new Set(calls.map((call) => call.id));
  const results = new Map<number, TimedToolCallResult>();
  while (results.size < expected.size) {
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) {
      throw new Error(
        `${callerName}: timed out waiting for ${expected.size - results.size} of ${expected.size} responses (got ids: ${[...results.keys()].join(",")})`
      );
    }
    const line = await server.nextLine(remaining);
    assert.equal(
      line.parseError,
      undefined,
      `${callerName}: a stdout line failed to parse as JSON - framing corruption: ${JSON.stringify(line.raw)}`
    );
    const id = (line.parsed as { id?: unknown })?.id;
    if (typeof id === "number" && expected.has(id)) {
      results.set(id, { body: line.parsed as ToolCallBody, elapsedMs: Date.now() - start });
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

/**
 * The same "wait for the WHOLE number, never a truncated read" reasoning
 * `parsesAsPgid` documents above, generalized to a marker holding several
 * pids appended one per line (used for identifying a set of specific
 * descendant/keep-alive pids by their own `$!`, distinct from the group's
 * own pgid - see `NoisyLiveJobOptions.descendantPidsMarkerPath` below).
 * Requires the content to already end in `\n` (the same truncated-final-
 * append guard `parsesAsPgid` uses) and requires EXACTLY `count` non-empty
 * lines, never `>= count` - reading a marker mid-append, before its last
 * expected line has landed at all, must never be mistaken for "done."
 */
export function parsesAsPidList(content: string, count: number): boolean {
  if (!content.endsWith("\n")) return false;
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length !== count) return false;
  return lines.every((line) => {
    const text = line.trim();
    if (!/^\d+$/.test(text)) return false;
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0;
  });
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
// test/kill.test.ts's own real-wire tests and test/shutdown.test.ts's
// process-group reap tests each already establish independently - never
// this codebase's own bookkeeping, a real external OS-level check).
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
// shape test/kill.test.ts's own real-wire tests and test/shutdown.test.ts's
// spawnServerWithLiveTree already establish (a real shell child that is the
// process-group LEADER, since spawnManaged always spawns detached - see
// src/process.ts's own docs), extended here to DESCENDANTS_PER_JOB
// descendants and NOISE_BYTES of real stdout noise (plus a smaller amount
// of real stderr noise, for stream-isolation proof) before the final
// `wait`, which is what keeps the whole process group genuinely alive
// until the test decides to kill (or shut down under) it.
// ---------------------------------------------------------------------------

/** A short, distinctive, per-job token so a job's own noise text can never be mistaken for a sibling job's (test/integration.test.ts's stream-isolation proof reads this back out of a live job's own `output()`). */
export function noiseToken(jobIndex: number): string {
  return `GHANTIKA-NOISE-JOB-${jobIndex}`;
}

export interface NoisyLiveJobOptions {
  /**
   * When true, the job's own LEADER (the shell process itself, tracked as
   * the job's pid) traps and ignores SIGTERM (`trap '' TERM`, the same
   * fixture shape test/process.test.ts's own "a SIGTERM-resistant process
   * is escalated to SIGKILL" test already establishes at the
   * `killProcessGroupPosix` layer - reused here at the real MCP-tool/wire
   * layer). A plain SIGTERM to the whole process group therefore cannot
   * terminate the leader on its own: `isProcessGroupAlive` (src/process.ts)
   * still reads the group as alive after the leader survives, which is
   * exactly what forces `killProcessGroupPosix`'s real
   * grace-period-then-SIGKILL escalation to actually fire, rather than
   * merely being reachable in principle.
   *
   * This resistance is genuinely LEADER-ONLY, not group-wide - the
   * `DESCENDANTS_PER_JOB` descendants stay plainly killable by a plain
   * SIGTERM, exactly like any other job's descendants. That takes two
   * things working together, both verified empirically (a naive version
   * of either one alone reintroduces a real bug, not just a style
   * difference):
   *
   * 1. The trap is only ever set in the LEADER shell, and only AFTER the
   *    `DESCENDANTS_PER_JOB` descendants have already been forked (see
   *    `buildNoisyLiveJobShellCommand`'s own statement order below). An
   *    ignored (or any) signal disposition is inherited by a forked child
   *    in every POSIX shell, so a descendant forked BEFORE the trap runs
   *    still has the shell's default (terminable) disposition at the
   *    moment it's created, and nothing forked afterward can retroactively
   *    change that for a process that already exists. Getting the order
   *    backwards - trapping first, forking after - was the actual bug: a
   *    plain group SIGTERM then did nothing to any of the group's members,
   *    descendants included, confirmed by reproducing it directly against
   *    a real spawned process group before this fix (see this file's git
   *    history).
   * 2. The trailing `wait` no longer blocks on the `DESCENDANTS_PER_JOB`
   *    descendants alone. Once they're genuinely killable (per point 1),
   *    they die the instant a real SIGTERM reaches the group - and a bare
   *    `wait` only blocks until ITS OWN backgrounded children exit, so it
   *    would unblock right then, letting the leader's script reach its end
   *    and the leader process exit ON ITS OWN, moments after a plain
   *    SIGTERM - never resisting anything for the real ~5s grace period an
   *    escalation proof depends on. A resistant job therefore also forks
   *    one extra background job, `sleep 300 &`, strictly AFTER the trap -
   *    it inherits the leader's OWN ignored disposition (same reasoning as
   *    point 1, in reverse), so only a real SIGKILL ends it, and `wait`
   *    (waiting on every backgrounded job, this one included) stays
   *    genuinely blocked - and so does the leader - through the whole
   *    grace period, decoupled from whatever happens to the
   *    `DESCENDANTS_PER_JOB` descendants. Confirmed empirically:
   *    reordering alone (without this) still self-exited the whole leader
   *    within ~1s of a plain SIGTERM, never reaching escalation at all.
   */
  readonly sigtermResistant?: boolean;

  /**
   * When set, ALSO captures each of the `DESCENDANTS_PER_JOB` descendants'
   * OWN pid (via `$!`, read synchronously right after backgrounding each
   * one - `$!` is POSIX-specified as "the pid of the most recently
   * executed background command", so it must be captured before the next
   * `&` fork overwrites it) and appends it to this marker path, one pid
   * per line, in fork order. This is distinct from `pgidMarkerPath` above,
   * which only ever names the group's LEADER (the group's pgid); this is
   * how a caller identifies exactly which real pids the descendants
   * THEMSELVES are, so it can assert something specific about them later
   * (e.g. "these exact pids, and no others, are gone").
   *
   * Purely additive: when omitted, the produced command line is BYTE-FOR-
   * BYTE identical to what every existing caller already gets - no new
   * statement, no new marker file, nothing for a non-resistant caller (or
   * any caller not asking for this) to be affected by.
   */
  readonly descendantPidsMarkerPath?: string;

  /**
   * `sigtermResistant`-only: the same `$!`-capture mechanism as
   * `descendantPidsMarkerPath` above, but for the keep-alive anchor job
   * (`sleep 300 &`) instead of the `DESCENDANTS_PER_JOB` descendants -
   * lets a caller identify EXACTLY which surviving pid is the anchor,
   * distinct from the leader's own pgid, rather than inferring it from a
   * bare surviving-member count. Ignored when `sigtermResistant` isn't
   * set (there is no anchor job to capture a pid for).
   */
  readonly anchorPidMarkerPath?: string;
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
 * Shape for a plain (non-resistant) job, UNCHANGED from every existing
 * call site: write the pgid marker -> fork `DESCENDANTS_PER_JOB` real
 * background `sleep 60` descendants -> write >= NOISE_BYTES of real
 * stdout noise (via `yes | head -c`, a real, fast, deterministically-sized
 * generator) -> write a smaller amount of real stderr noise -> write the
 * noise-done marker -> `wait` on the backgrounded descendants, which is
 * what keeps the whole process group (leader + descendants) alive until
 * the caller kills it or the server shuts down.
 *
 * Shape for a `sigtermResistant` job - see `NoisyLiveJobOptions.
 * sigtermResistant`'s own docs for why each reordering/addition below is
 * load-bearing, not stylistic: fork the `DESCENDANTS_PER_JOB` descendants
 * and write the pgid marker FIRST -> `trap '' TERM` in the leader -> fork
 * one extra background keep-alive job (`sleep 300 &`) -> the same
 * stdout/stderr noise and done-marker as the plain shape -> the same
 * trailing `wait`, now blocking on 1 + `DESCENDANTS_PER_JOB` backgrounded
 * jobs instead of `DESCENDANTS_PER_JOB`.
 *
 * `descendantPidsMarkerPath`/`anchorPidMarkerPath` (see
 * `NoisyLiveJobOptions`' own docs) each add one `echo $! >> marker`
 * statement per captured pid, immediately after that pid's own background
 * fork - additive only, and OMITTED entirely (byte-for-byte identical
 * output to before) when the corresponding option isn't set.
 */
export function buildNoisyLiveJobShellCommand(
  jobIndex: number,
  pgidMarkerPath: string,
  noiseDonePath: string,
  options?: NoisyLiveJobOptions
): string {
  const token = noiseToken(jobIndex);
  const resistant = options?.sigtermResistant === true;
  const descendantPidsMarkerPath = options?.descendantPidsMarkerPath;
  const anchorPidMarkerPath = options?.anchorPidMarkerPath;

  // Each descendant fork, on its own: with no marker requested, a bare
  // `sleep 60 &` (ends in `&`, already a statement separator - see below);
  // with a marker requested, the fork PLUS an immediate, synchronous
  // `echo $! >> marker` reading back that exact fork's own pid before the
  // next one can overwrite `$!` - this second form ends in an ordinary
  // (non-backgrounded) statement, so it needs a REAL `;` to separate it
  // from whatever statement follows, unlike the bare `&`-terminated form.
  const descendantForkStatement =
    descendantPidsMarkerPath === undefined
      ? "sleep 60 &"
      : `sleep 60 & echo $! >> '${descendantPidsMarkerPath}'`;
  // Each descendant fork ends in `&` (backgrounds it) - `&` is ALREADY a
  // statement separator, exactly like `;`, so joining `DESCENDANTS_PER_JOB`
  // of them with spaces and then continuing straight into the next
  // statement (no extra `;` between the last `&` and what follows) is the
  // only valid shape: `sleep 60 & sleep 60 & sleep 60 &;` is a real POSIX
  // shell SYNTAX ERROR ("unexpected token `;'" - verified empirically
  // against both `sh` and `bash`), since a trailing `&` immediately
  // followed by `;` has nothing between them for the semicolon to
  // terminate. `descendantForksPrefix` therefore ends in a trailing space,
  // not a trailing `;`, UNLESS a marker was requested (see
  // `descendantForkStatement` above), in which case each fork's own
  // trailing `echo` statement is a real, separate statement and the joiner
  // switches to a genuine `; ` (with a matching trailing `; `).
  const descendantForksPrefix =
    descendantPidsMarkerPath === undefined
      ? `${Array.from({ length: DESCENDANTS_PER_JOB }, () => descendantForkStatement).join(" ")} `
      : `${Array.from({ length: DESCENDANTS_PER_JOB }, () => descendantForkStatement).join("; ")}; `;
  const noiseLine = `yes '${token}-0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF' | head -c ${NOISE_BYTES}`;
  const stderrNoiseLine = `yes '${token}-STDERR-NOISE-abcdef0123456789' | head -c 16384 1>&2`;
  const doneMarkerLine = `echo done > '${noiseDonePath}'`;

  if (!resistant) {
    // Unchanged from every existing (non-resistant) caller's original
    // shape (`descendantPidsMarkerPath` is honored the same way here too,
    // though no existing caller passes it on a non-resistant job today).
    return [
      `echo $$ > '${pgidMarkerPath}'`,
      // The descendant forks are prepended directly onto this statement
      // (see `descendantForksPrefix`'s own docs above), not joined via `; `.
      `${descendantForksPrefix}${noiseLine}`,
      stderrNoiseLine,
      doneMarkerLine,
      "wait",
    ].join("; ");
  }

  // Resistant shape - see NoisyLiveJobOptions.sigtermResistant's own docs
  // for why both the reorder and the keep-alive fork below are each
  // individually load-bearing (verified empirically, not just reasoned
  // about): descendants forked before the trap keeps them genuinely
  // killable (leader-only resistance); the keep-alive fork after the trap
  // keeps the leader's own `wait` - and so the leader itself - genuinely
  // alive through the real grace period regardless of what happens to
  // those descendants.
  //
  // The anchor fork mirrors `descendantForkStatement` above: a bare
  // `sleep 300 &` when no marker is requested (unchanged, `&`-terminated),
  // or the fork plus its own immediate `echo $! >> marker` (a real
  // statement, needing a genuine `;` before whatever follows) when one is.
  const anchorForkStatement =
    anchorPidMarkerPath === undefined
      ? "sleep 300 &"
      : `sleep 300 & echo $! >> '${anchorPidMarkerPath}'`;
  return [
    `${descendantForksPrefix}echo $$ > '${pgidMarkerPath}'`,
    `trap '' TERM`,
    // `sleep 300 &`'s own trailing `&` must not be followed by `; ` (the
    // exact syntax error `descendantForksPrefix`'s own docs warn about),
    // so the next statement is appended directly here with a plain space,
    // the same shape `descendantForksPrefix` itself already uses - UNLESS
    // an anchor marker was requested, in which case the anchor line ends
    // in a real statement and needs a genuine `; ` before `noiseLine`.
    anchorPidMarkerPath === undefined
      ? `sleep 300 & ${noiseLine}`
      : `${anchorForkStatement}; ${noiseLine}`,
    stderrNoiseLine,
    doneMarkerLine,
    "wait",
  ].join("; ");
}

export interface NoisyJobsResult {
  readonly jobIds: readonly string[];
  readonly pgids: readonly number[];
  readonly dir: string;
}

/**
 * The shared setup phase both the real stdio-client concurrent-jobs test and
 * the process-group-reap-under-load test build on: starts `count`
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

/**
 * Exported (not just `startNoisyJobs`'s own private setup step) so a test
 * building its OWN mixed job set - e.g. one resistant leader alongside
 * ordinary noisy jobs, a shape `startNoisyJobs`'s own "every job is
 * identical" contract doesn't cover - can still barrier on the same real
 * "genuinely produced NOISE_BYTES" condition without re-deriving it.
 */
export async function waitForAllNoiseMaterialized(
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
