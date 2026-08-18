/**
 * Shared test-only helper for spawning the REAL built ghantika server
 * (`dist/index.js`) as a real child process and speaking real JSON-RPC to
 * it over its actual stdin/stdout: a real spawned process, real stdio,
 * real protocol bytes end to end, no internal function calls standing in
 * for any of it. Not a `*.test.ts` file itself (so
 * `node --test`'s auto-discovery never tries to run it as a suite).
 *
 * Imported directly by every spawned-real-child suite in this repo -
 * `test/e2e-server.test.ts`, `test/shutdown.test.ts`,
 * `test/modern-handshake.test.ts`, `test/kill.test.ts`,
 * `test/kill-slow-paths.test.ts`, `test/output-tail.test.ts`, and
 * `test/helpers/hostileGroupKillProbe.ts` - plus `test/harness.ts`, which
 * re-exports `spawnServer` for its own two callers,
 * `test/integration.test.ts` and `test/wake-integration.test.ts`.
 * `test/spawnServer.test.ts` imports only this file's own `lineTimeoutFor`
 * (the budget function below), never `spawnServer` itself, so it is not a
 * spawned-real-child suite.
 *
 * `npm test` runs `npm run build` first (see package.json), so
 * `dist/index.js` is guaranteed fresh by the time any test file that
 * imports this helper runs.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

/**
 * Mirrors `src/process.ts`'s own `CONTAIN_IN_OWN_PROCESS_GROUP`: the
 * spawned server-under-test gets its own process group, the same
 * containment every real job spawn already has, so a group-scoped
 * termination aimed at it cannot land on whatever group its caller
 * belongs to.
 */
const CONTAIN_TEST_SERVER_IN_OWN_PROCESS_GROUP = process.platform !== "win32";

/**
 * The per-line wait `nextLine` defaults to, as a pure function of the
 * environment it's given - not read from `process.env` at module load -
 * so a test can assert on it directly (see `test/spawnServer.test.ts`)
 * without mutating real process state. The env parameter is kept even
 * though the current value is coverage-independent: it is the seam a
 * future re-split would use if the two paths ever again need different
 * numbers, and `test/spawnServer.test.ts`'s own mutation control still
 * asserts that a coverage-instrumented run is never given LESS time
 * than an uninstrumented one, which now holds by equality rather than
 * by a strict inequality.
 *
 * Both paths return 6000ms. They were not always equal: the coverage
 * path carried a measured 6000ms while the non-coverage branch stayed at
 * an unmeasured flat 2000ms - an asymmetry that assumed file-level
 * concurrency was a coverage-only concern. It stopped being one once
 * `npm test` gained an opt-in concurrent-file mode (that contention now
 * lands on exactly the branch with no measurement behind it, never the
 * one with 12x headroom). Raised to match the coverage branch instead of
 * inventing a second, differently-justified number.
 *
 * The measurement behind the raise: `npm run coverage -- --test-concurrency=4`,
 * 14 full-suite runs on a genuinely loaded shared host (load 4-9
 * throughout, via `single-run.sh`), instrumented to record every bare
 * `nextLine()` wait in the entire suite. Zero timeouts across all 14;
 * worst observed wait 653ms, and - worth stating plainly because it
 * inverts the intuition this story started from - the worst case landed
 * at concurrency=4, not the also-tested concurrency=8, so ambient host
 * load mattered more than the concurrency setting itself on this run.
 * 6000ms is ~9.2x that measured worst case.
 *
 * 653ms is a measured FLOOR on the worst case, not a proven ceiling: the
 * documented failure mode this story investigates (this file's
 * `nextLine()` wait itself was once observed to time out at the previous
 * 2000ms budget under real contention) did not reproduce in any of the
 * 14 runs. That non-reproduction is disclosed here rather than treated
 * as confirmation the failure mode is gone - it may be rare, or it may
 * be sensitive to conditions this particular run of 14 did not hit. The
 * margin is deliberately wide because of that, not despite it; do not
 * read "measured max 653ms" as license to tighten this toward 653ms
 * without a fresh measurement of your own.
 *
 * A server that never emits a line still rejects, on this budget as on
 * the old one - this only changes how long a genuine failure takes to
 * report.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- documented seam, see the doc comment above
export function lineTimeoutFor(_env: Pick<NodeJS.ProcessEnv, "NODE_V8_COVERAGE">): number {
  return 6000;
}

const DEFAULT_LINE_TIMEOUT_MS = lineTimeoutFor(process.env);

export interface RawStdoutLine {
  readonly raw: string;
  readonly parsed: unknown;
  readonly parseError: string | undefined;
}

export interface SpawnedServer {
  readonly child: ChildProcessWithoutNullStreams;
  /** Sends one JSON-RPC message (serialized + newline-terminated). */
  send(message: unknown): void;
  /** Sends raw, unmodified text - for deliberately malformed input. */
  sendRaw(text: string): void;
  /** Resolves with the next stdout line, once one arrives (parsed as JSON when possible). */
  nextLine(timeoutMs?: number): Promise<RawStdoutLine>;
  /** Every stdout line seen so far, in arrival order. */
  allLines(): RawStdoutLine[];
  /** All stderr text collected so far. */
  stderrText(): string;
  /** Resolves once the child process has exited, with its exit code/signal. */
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Spawns `dist/index.js` (or, when `entry` is given, a different real
 * entry point - e.g. a standalone comparison fixture under
 * `test/fixtures/`, run directly via Node's own native TypeScript support
 * exactly like `dist/index.js` itself, since both are real files on disk
 * rather than something requiring a build step) as a real child process
 * and wires up line-based stdout collection exactly the way a real MCP
 * client would (newline-delimited JSON-RPC messages).
 */
export function spawnServer(entry: readonly string[] = [SERVER_ENTRY]): SpawnedServer {
  const child = spawn(process.execPath, [...entry], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: CONTAIN_TEST_SERVER_IN_OWN_PROCESS_GROUP,
    windowsHide: true,
  });

  // `allLines` is the full historical log (what `allLines()` returns).
  // `unconsumed` is a genuine PULL queue: a line a burst delivered before
  // any consumer called `nextLine()` sits here until someone asks for it.
  // Without this second queue, a line that arrives while `waiters` is
  // empty (e.g. a rapid burst of many requests sent before the test loop
  // starts awaiting responses one at a time) would be pushed into the
  // history log and then simply lost from `nextLine()`'s point of view -
  // it would only ever resolve against a FUTURE data event, and a test
  // that sends N requests up front then awaits N responses one at a time
  // would silently misalign or hang waiting for a "new" line that will
  // never come, because every line already arrived before the first
  // `nextLine()` call registered its waiter. This bit the very first
  // version of the under-load test in test/e2e-server.test.ts.
  const allLines: RawStdoutLine[] = [];
  const unconsumed: RawStdoutLine[] = [];
  const waiters: Array<(line: RawStdoutLine) => void> = [];
  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    let index: number;
    while ((index = stdoutBuffer.indexOf("\n")) !== -1) {
      const raw = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      let parsed: unknown;
      let parseError: string | undefined;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
      const line: RawStdoutLine = { raw, parsed, parseError };
      allLines.push(line);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        unconsumed.push(line);
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });

  let exitResolve: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      exitResolve = resolve;
    }
  );
  child.on("exit", (code, signal) => {
    exitResolve({ code, signal });
  });

  return {
    child,
    send(message: unknown) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    sendRaw(text: string) {
      child.stdin.write(text);
    },
    nextLine(timeoutMs = DEFAULT_LINE_TIMEOUT_MS): Promise<RawStdoutLine> {
      // Serve an already-arrived, not-yet-consumed line first (see the
      // `unconsumed` queue's doc comment above) - only fall back to
      // waiting on a future data event once that queue is empty.
      const buffered = unconsumed.shift();
      if (buffered) {
        return Promise.resolve(buffered);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(onLine);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(
            new Error(
              `timed out after ${timeoutMs}ms waiting for a stdout line (stderr so far: ${stderrBuffer})`
            )
          );
        }, timeoutMs);
        function onLine(line: RawStdoutLine): void {
          clearTimeout(timer);
          resolve(line);
        }
        waiters.push(onLine);
      });
    },
    allLines() {
      return [...allLines];
    },
    stderrText() {
      return stderrBuffer;
    },
    waitForExit() {
      return exitPromise;
    },
  };
}

/** A minimal, valid `initialize` request. */
export function initializeRequest(id: number | string = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ghantika-e2e-test", version: "0.0.0" },
    },
  };
}

/** The `notifications/initialized` notification that completes the handshake. */
export function initializedNotification() {
  return { jsonrpc: "2.0", method: "notifications/initialized" };
}

/**
 * The modern (2026-07-28) revision's per-request `_meta` envelope reserved
 * keys, hand-rolled here rather than imported from the installed SDK's
 * internal-only constants: `io.modelcontextprotocol/protocolVersion` and
 * `io.modelcontextprotocol/clientCapabilities` are the two the installed
 * `@modelcontextprotocol/server` package's own `checkInboundEnvelope`
 * REQUIRES on every modern-era request (confirmed by reading its own
 * `REQUIRED_ENVELOPE_KEYS` source, not assumed) - `clientCapabilities` may
 * be an empty object, but its KEY must be present, or the message
 * classifies as a claim-less (legacy) request instead of a modern one.
 */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

function modernMetaEnvelope(extra: Record<string, unknown> = {}) {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
    ...extra,
  };
}

/** A minimal, valid `server/discover` request (the modern revision's opening exchange, in place of `initialize`). */
export function discoverRequest(id: number | string = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "server/discover",
    params: { _meta: modernMetaEnvelope() },
  };
}

/**
 * Wraps `params` (already containing whatever the request itself needs)
 * with the modern revision's required `_meta` envelope - for any request
 * sent AFTER a `server/discover` has already pinned/probed a modern
 * connection (e.g. a modern-era `tools/call`).
 *
 * `clientCapabilities` overrides the envelope's required
 * `io.modelcontextprotocol/clientCapabilities` key, defaulting to `{}` (a
 * present-but-empty declaration - a valid, non-capable-of-anything
 * declaration, never the same thing as omitting the key entirely, which
 * the modern era does not allow at all). This is what lets a caller
 * declare - or deliberately omit - Tasks support on a PER-REQUEST basis,
 * exactly as the 2026-07-28 revision's own capability model requires (see
 * `src/server.ts`'s own header doc, "Reading a request's own declared
 * client capabilities," for why this era has no connection-level
 * declaration at all).
 */
export function withModernEnvelope(
  params: Record<string, unknown> = {},
  clientCapabilities: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...params,
    _meta: modernMetaEnvelope({
      "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
    }),
  };
}

/**
 * Drives a spawned server through the full initialize handshake and waits
 * for the initialize response - the shared setup nearly every e2e test
 * needs before it can exercise `tools/list`/`tools/call`.
 */
export async function completeHandshake(
  server: SpawnedServer,
  id: number | string = 1
): Promise<RawStdoutLine> {
  server.send(initializeRequest(id));
  const response = await server.nextLine();
  server.send(initializedNotification());
  return response;
}
