/**
 * A `WakeTransport` (see `./wakeTransport.ts` for the contract this
 * implements) that wakes an idle Codex thread by spawning the `codex
 * app-server` subcommand and driving its versioned JSON-RPC protocol over
 * that subprocess's own stdio: newline-delimited JSON in both directions,
 * one object per line, no `Content-Length` framing (confirmed by spawning
 * the real subcommand and reading its raw stdout bytes - this is NOT the
 * LSP-style framing a reader familiar with other JSON-RPC-over-stdio
 * protocols might expect).
 *
 * NOT to be confused with `src/tasksAdapter.ts`'s `notifications/tasks/status`
 * wake-on-output-arrival mechanism (see `wakeTransport.ts`'s own header for
 * that distinction in full). That module tells an MCP CLIENT its poll would
 * now return new data. THIS module wakes an idle AGENT SESSION - a Codex
 * thread that has gone idle waiting for its next turn - so it resumes and
 * does real work without a human re-invoking it. Same English word, two
 * unrelated mechanisms; this file never imports anything from
 * `tasksAdapter.ts` and `tasksAdapter.ts` never imports anything from here.
 *
 * THE MECHANISM: sending `thread/goal/set` with `status: "active"` for an
 * IDLE thread starts a model turn on that thread, and the `objective` text
 * supplied reaches the model verbatim (Codex wraps it in a
 * `<codex_internal_context source="goal">` block internally - that
 * wrapping is Codex's own concern, not this transport's; this transport's
 * job ends at transmitting `objective` unmodified). Measured directly
 * against a real, stock `codex app-server` (CLI 0.147.0): `initialize`
 * responds in well under a second, `experimentalFeature/list` reports a
 * `"goals"` entry at `stage: "stable"` / `enabled: true`, and a
 * `thread/goal/set` call against a real thread id produces a `turn/started`
 * notification carrying that thread's id, versus a JSON-RPC error response
 * (`code: -32600`) for a malformed or nonexistent thread id.
 *
 * CHILD OWNERSHIP, the two different shapes this file actually spawns:
 *
 *   - `probe()` spawns a short-lived, throwaway `codex app-server` purely
 *     to ask it two questions (does `initialize` succeed at all, and does
 *     `experimentalFeature/list` report `"goals"` as enabled) and tears it
 *     down before returning - no goal is ever set, no turn is ever
 *     started, and the whole call is a bounded, in-order sequence with no
 *     background work left running once the returned promise settles.
 *
 *   - `wake()` spawns a `codex app-server` that becomes, for as long as it
 *     stays alive, the actual process EXECUTING the turn it just
 *     triggered - `codex app-server` is a single foreground process with
 *     no daemon behind it in this deployment shape (see the note just
 *     below the imports for why daemon mode is out of scope here), so
 *     killing it the instant `turn/started` arrives would abort the very
 *     turn this call exists to start. `wake()` therefore
 *     resolves its returned promise as soon as delivery is CONFIRMED
 *     (`turn/started` observed for the target thread, matching the
 *     measured ~200ms latency above), while the child itself is handed to
 *     bounded background supervision that keeps it alive until either
 *     `turn/completed` arrives for that thread or a wall-clock ceiling
 *     (`maxSessionMs`) is reached, whichever comes first - then shuts it
 *     down (`SIGTERM`, a grace period, `SIGKILL` if still alive, and a
 *     real wait for the OS to confirm the process is gone) and stops
 *     tracking it. This is why `wake()`'s own returned promise does not
 *     wait for the turn to finish: a caller that wants "did this deliver"
 *     gets that answer at the measured mechanism's own latency, and the
 *     transport - not the caller - stays responsible for the child's full
 *     lifecycle either way. See `AppServerGoalWakeTransport`'s own doc
 *     comment for the exact bounding numbers and their reasoning.
 *
 * BOUNDING, at the strength the evidence actually supports: the mechanism
 * re-arms on idle transitions by design (an active goal left on a thread
 * will keep prompting new turns as that thread goes idle and comes back),
 * which is a real hazard shape - so every goal this transport sets carries
 * a `tokenBudget` (a genuine field on the protocol's own `ThreadGoalSetParams`,
 * enforced server-side; the goal's own status transitions to
 * `"budgetLimited"` once it's exhausted), and every child this transport
 * spawns for a delivered wake is ALSO bounded client-side by a wall-clock
 * ceiling independent of the server's own accounting, as a second,
 * defense-in-depth backstop. Deliberately NOT built here: any bespoke
 * "runaway turn count" circuit breaker. A previously-reported high-turn-count
 * figure did not reproduce under independent, controlled measurement (one
 * goal produced exactly one turn in 20 seconds, with several ordinary
 * multi-step model calls inside that single turn), and its cause was never
 * established - engineering a bespoke brake for a failure mode nobody has
 * reproduced would be guessing at a shape the evidence does not describe.
 * The token budget and the wall-clock ceiling are the bounds the evidence
 * actually supports.
 *
 * NO FORK, NO PATCH, NO PRIVATE PATH: this file spawns exactly the
 * documented `codex app-server` subcommand (default argv: `["app-server"]`,
 * stdio transport, which is that subcommand's own default) and speaks only
 * its published JSON-RPC surface. It never reads or writes an `app.asar`
 * constant, never guesses at an undocumented IPC socket path, and never
 * patches the installed binary. `codex app-server daemon start` (a
 * different subcommand, requiring a "standalone install layout" this
 * deployment does not have - see the note just below this header) is out
 * of scope here; an IPC-based transport reaching an already-running host
 * process by some other means is a different transport file entirely, not
 * this one.
 */
import { type ChildProcess, spawn } from "node:child_process";

import type { Capability, WakeResult, WakeTarget, WakeTransport } from "./wakeTransport.js";

// Recorded here for anyone reading this file wondering why it never tries
// `codex app-server daemon start`: that subcommand requires a "standalone
// install layout" at `$CODEX_HOME/packages/standalone/current/codex`, and a
// plain Homebrew/npm install of the CLI does not provide one - a real
// attempt against such an install fails immediately with `Error: managed
// standalone Codex install not found`. This transport never attempts daemon
// mode at all (there is no fallback path to probe for), which is itself the
// correct behavior here rather than an oversight: a transport that silently
// fell back to some OTHER mechanism on a daemon-mode failure would violate
// `probe()`'s own contract (report what THIS run actually observed, not
// paper over a gap with a different mechanism under the same name). A
// daemon-backed transport, if one is ever built, is a separate
// `WakeTransport` implementation in its own file.

/** The default subcommand this transport spawns: plain `codex app-server`, stdio transport, never `daemon start` and never any undocumented flag or path - see this file's header comment. Overridable via `AppServerGoalWakeTransportOptions.command`/`args` - tests point this at a fixture script that speaks the same newline-delimited JSON-RPC surface instead of the real binary, so this module's own request/response/notification handling is exercised without depending on a real `codex` install or spending real model-provider quota. Exported so a test can assert directly against these values rather than duplicating the literals. */
export const DEFAULT_COMMAND = "codex";
export const DEFAULT_ARGS: readonly string[] = ["app-server"];

/** Identifies this transport to the app-server's own `initialize` handshake (surfaced in that process's `userAgent`, useful for anyone reading app-server-side logs). Kept as literals rather than read from `package.json` at runtime, mirroring `src/server.ts`'s own `SERVER_VERSION` precedent and for the same reason: the compiled `dist/wake/appServerTransport.js` never depends on `package.json`'s on-disk location relative to it. */
const DEFAULT_CLIENT_NAME = "ghantika";
const DEFAULT_CLIENT_VERSION = "0.1.0";

/** The experimental-feature name this transport checks via `experimentalFeature/list` - confirmed present at `stage: "stable"`, `enabled: true` against a real, stock `codex app-server` (CLI 0.147.0) and the ChatGPT desktop app's own app-server (0.147.0-alpha.6.5) on 2026-08-07. `probe()` never assumes this stays true; it re-checks every call, per `probe()`'s own contract in `wakeTransport.ts`. */
const GOALS_FEATURE_NAME = "goals";

/**
 * The protocol-level bound this transport sets on every goal it arms,
 * via `ThreadGoalSetParams.tokenBudget` - a real field the running
 * app-server enforces server-side (a goal's own `status` transitions to
 * `"budgetLimited"` once exhausted; see this file's header comment for why
 * a bound is needed at all). 20,000 tokens is disclosed as a deliberately
 * modest, round default rather than a measured ceiling: the one full,
 * measured turn this mechanism produced used far less than that for
 * several ordinary tool-calling steps, so this leaves meaningful headroom
 * for genuine multi-step work while still capping a goal well short of an
 * unbounded run. Callers with a different risk tolerance override it via
 * `AppServerGoalWakeTransportOptions.tokenBudget`.
 */
export const DEFAULT_TOKEN_BUDGET = 20_000;

/** How long `probe()` and `wake()` each wait for the app-server's `initialize` response before giving up. Generous over the measured sub-second real-world response; a genuinely hung or misbehaving app-server should not be able to stall a caller indefinitely. */
const DEFAULT_INITIALIZE_TIMEOUT_MS = 5_000;

/** How long `wake()` waits, after a successful `thread/goal/set` response, to observe a `turn/started` notification naming the target thread before concluding the attempt did not deliver. Roughly 25x the measured real-world latency (under a second) to absorb a slow cold start without waiting so long that a genuinely non-idle thread (the most plausible reason no turn ever starts) reads as a hang rather than a prompt "refused" outcome. */
const DEFAULT_TURN_START_TIMEOUT_MS = 5_000;

/**
 * The wall-clock ceiling on how long a delivered wake's child is allowed
 * to keep running once `wake()` has already returned - `wake()`'s own
 * background supervision (see this file's header) shuts the child down
 * once EITHER a `turn/completed` notification arrives for the target
 * thread OR this ceiling elapses, whichever is first. This is the
 * client-side half of this file's bounding strategy (the server-side half
 * is `tokenBudget` above); it exists so a goal's own turn can never keep a
 * spawned child - and therefore real system resources - alive
 * unmonitored, regardless of what the server side does or does not
 * enforce. Two minutes is disclosed as a deliberately generous, round
 * default given the measured single-turn duration (well under a minute)
 * for ordinary multi-step work, not a measured ceiling; callers override
 * it via `AppServerGoalWakeTransportOptions.maxSessionMs`.
 */
const DEFAULT_MAX_SESSION_MS = 120_000;

/** SIGTERM grace period before this transport escalates to SIGKILL for any child it owns - short enough that a hung or unresponsive app-server is never allowed to stall a shutdown for long, long enough that a normally-exiting process is not needlessly force-killed mid-flush. */
const DEFAULT_GRACEFUL_SHUTDOWN_GRACE_MS = 3_000;

/** A bound on how many `experimentalFeature/list` pages `probe()` will walk looking for the `"goals"` entry, so a misbehaving or adversarial app-server that always returns a non-null `nextCursor` cannot make `probe()` loop forever. Every real response observed during development carried a single page (`nextCursor: null`) with roughly a hundred entries; this is headroom, not a measured requirement. */
const MAX_FEATURE_LIST_PAGES = 20;

/** Configuration for `AppServerGoalWakeTransport`. Every field is optional; see each module-level `DEFAULT_*` constant above for what an omitted field resolves to and why that default was chosen. */
export interface AppServerGoalWakeTransportOptions {
  /** The executable to spawn. Defaults to `"codex"` (resolved via `PATH`, exactly like a user typing `codex` at a shell). Tests override this to point at a fixture script. */
  readonly command?: string;
  /** Arguments passed to `command`. Defaults to `["app-server"]` (plain app-server over stdio, never daemon mode - see the note just below this file's imports). */
  readonly args?: readonly string[];
  /** Working directory for the spawned process. Defaults to this transport's own process's cwd (Node's own `spawn()` default when omitted). */
  readonly cwd?: string;
  /** Environment for the spawned process. Defaults to this transport's own process's environment (Node's own `spawn()` default when omitted) - notably, this means `CODEX_HOME` is inherited unmodified unless the caller overrides it, which is deliberate: this transport has no opinion about which `$CODEX_HOME` the target thread lives under, that is entirely the caller's/operator's configuration to get right. */
  readonly env?: NodeJS.ProcessEnv;
  /** Reported to the app-server as `clientInfo.name` during `initialize`. Defaults to `"ghantika"`. */
  readonly clientName?: string;
  /** Reported to the app-server as `clientInfo.version` during `initialize`. Defaults to `"0.1.0"`. */
  readonly clientVersion?: string;
  /** The `tokenBudget` set on every goal this transport arms. Defaults to `20000`. See `DEFAULT_TOKEN_BUDGET`'s own doc comment for the reasoning. */
  readonly tokenBudget?: number;
  /** Milliseconds to wait for `initialize` to respond before giving up. Defaults to `5000`. */
  readonly initializeTimeoutMs?: number;
  /** Milliseconds `wake()` waits, after a successful `thread/goal/set`, for a `turn/started` notification naming the target thread. Defaults to `5000`. */
  readonly turnStartTimeoutMs?: number;
  /** Wall-clock ceiling, in milliseconds, on a delivered wake's background-supervised child lifetime. Defaults to `120000` (two minutes). See `DEFAULT_MAX_SESSION_MS`'s own doc comment. */
  readonly maxSessionMs?: number;
  /** SIGTERM grace period, in milliseconds, before this transport escalates to SIGKILL for any child it owns. Defaults to `3000`. */
  readonly gracefulShutdownGraceMs?: number;
}

interface ResolvedOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly tokenBudget: number;
  readonly initializeTimeoutMs: number;
  readonly turnStartTimeoutMs: number;
  readonly maxSessionMs: number;
  readonly gracefulShutdownGraceMs: number;
}

function resolveOptions(options: AppServerGoalWakeTransportOptions): ResolvedOptions {
  return {
    command: options.command ?? DEFAULT_COMMAND,
    args: options.args ?? DEFAULT_ARGS,
    cwd: options.cwd,
    env: options.env,
    clientName: options.clientName ?? DEFAULT_CLIENT_NAME,
    clientVersion: options.clientVersion ?? DEFAULT_CLIENT_VERSION,
    tokenBudget: options.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    initializeTimeoutMs: options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
    turnStartTimeoutMs: options.turnStartTimeoutMs ?? DEFAULT_TURN_START_TIMEOUT_MS,
    maxSessionMs: options.maxSessionMs ?? DEFAULT_MAX_SESSION_MS,
    gracefulShutdownGraceMs: options.gracefulShutdownGraceMs ?? DEFAULT_GRACEFUL_SHUTDOWN_GRACE_MS,
  };
}

// ---------------------------------------------------------------------------
// The low-level newline-delimited JSON-RPC session
// ---------------------------------------------------------------------------

/** Thrown when the app-server replies to a request with a genuine JSON-RPC error object (`{"error": {"code", "message"}}`) - distinguished from every other failure mode (a spawn failure, a timeout, an unexpected exit) so callers can map exactly this case to the `"refused"` outcome, per this file's own outcome-mapping notes on `wake()` below. */
export class AppServerRpcError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "AppServerRpcError";
    this.code = code;
  }
}

/** A parsed notification (a message with a `method` but no `id`) received from the app-server. */
export interface AppServerNotification {
  readonly method: string;
  readonly params: unknown;
}

interface PendingRequest {
  readonly id: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface NotificationWaiter {
  readonly predicate: (notification: AppServerNotification) => boolean;
  readonly resolve: (notification: AppServerNotification | undefined) => void;
  readonly timer: NodeJS.Timeout;
}

/** How much of a spawned child's stderr this connection retains for diagnostics, capped so a chatty or misbehaving process can never grow this without bound. Only ever surfaced inside an already-failing `reason`/`detail` string - never treated as protocol data. */
const STDERR_TAIL_CAP_CHARS = 4_000;

/**
 * Owns one spawned `codex app-server` child's newline-delimited JSON-RPC
 * traffic: request/response correlation, notification dispatch, and a
 * captured tail of the child's stderr for diagnostics. Framing is exactly
 * what a real spawned `codex app-server` was observed to produce and
 * accept: one complete JSON object per line, `\n`-terminated, in both
 * directions - no `Content-Length` header block.
 *
 * Holds AT MOST ONE in-flight request and AT MOST ONE active notification
 * wait at a time, by a single nullable field each rather than a
 * Map/Set keyed collection - this is not a simplification made for its
 * own sake, it is the actual shape of every call this file makes: every
 * caller in this module `await`s one `request()` before issuing the next,
 * and `wake()`'s own two `waitForNotification()` calls (`turn/started`
 * inline, `turn/completed` in background supervision) never overlap in
 * real time - the second only starts once the first has already settled.
 * `request()`/`waitForNotification()` both throw synchronously if called
 * while one is already outstanding, turning any FUTURE accidental
 * concurrent use into a loud, immediate programmer error instead of a
 * silently dropped or misattributed response.
 *
 * This class never spawns or kills anything itself - `spawnAppServer()`
 * and `shutdownChild()` below own that, so a connection's own lifetime is
 * cleanly separable from its child's OS-process lifetime (the same child
 * can be handed to background supervision, well after this connection's
 * constructor has run, without this class needing to know anything about
 * that).
 */
class AppServerConnection {
  #buffer = "";
  #nextRequestId = 1;
  #pendingRequest: PendingRequest | undefined;
  #notificationWaiter: NotificationWaiter | undefined;
  #terminalError: Error | undefined;
  #stderrTail = "";
  #expectingExit = false;

  constructor(private readonly child: ChildProcess) {
    child.stdout?.on("data", (chunk: Buffer) => this.#onStdoutData(chunk));
    // Every child is spawned with a real stdio pipe for stderr (never
    // "inherit", matching this codebase's own MANAGED_CHILD_STDIO
    // precedent in src/process.ts, for the identical reason - a stray
    // byte on OUR OWN stdout would corrupt ghantika's own MCP protocol
    // stream, though that concern is moot here since this is the CHILD's
    // stdout/stderr, not ghantika's; the real reason to pipe rather than
    // inherit stderr is so it never intermixes with ghantika's own
    // process output at all). An un-drained "pipe" stderr risks the
    // classic Node deadlock (the OS pipe buffer fills and blocks the
    // child's own writes), so this handler always drains it, keeping only
    // a bounded tail for diagnostics.
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderrTail = (this.#stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CAP_CHARS);
    });
    child.on("error", (error) => {
      this.#onTerminal(new Error(`app-server process error: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      if (this.#expectingExit) return;
      const stderrNote = this.#stderrTail.length > 0 ? ` stderr tail: ${this.#stderrTail}` : "";
      this.#onTerminal(
        new Error(
          `app-server process exited unexpectedly (code=${String(code)}, signal=${String(signal)}).${stderrNote}`
        )
      );
    });
  }

  /** Marks this session's child as expected to exit right now, so its own `exit` handler above never mistakes a deliberate shutdown for an unexpected failure. Called by `shutdownChild()` before it signals the child. */
  expectExit(): void {
    this.#expectingExit = true;
  }

  #onStdoutData(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (rawLine.trim().length > 0) this.#dispatchLine(rawLine);
      newlineIndex = this.#buffer.indexOf("\n");
    }
  }

  #dispatchLine(rawLine: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      // A malformed or non-protocol line on the child's stdout is not
      // this session's concern to validate further - silently skipped,
      // the same tolerance any JSON-RPC-over-stdio client extends to a
      // peer's own framing rather than tearing down the whole session
      // over one bad line.
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as {
      id?: unknown;
      result?: unknown;
      error?: unknown;
      method?: unknown;
      params?: unknown;
    };
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      this.#resolvePendingRequest(message.id, message);
      return;
    }
    if (typeof message.method === "string") {
      this.#dispatchNotification({ method: message.method, params: message.params });
    }
  }

  #resolvePendingRequest(id: number, message: { result?: unknown; error?: unknown }): void {
    const pending = this.#pendingRequest;
    if (pending === undefined || pending.id !== id) return;
    this.#pendingRequest = undefined;
    if ("error" in message && message.error !== undefined) {
      const errorObj = message.error as { code?: unknown; message?: unknown };
      pending.reject(
        new AppServerRpcError(
          typeof errorObj.message === "string"
            ? errorObj.message
            : "app-server returned an error with no message",
          typeof errorObj.code === "number" ? errorObj.code : -1
        )
      );
      return;
    }
    pending.resolve(message.result);
  }

  #dispatchNotification(notification: AppServerNotification): void {
    const waiter = this.#notificationWaiter;
    if (waiter === undefined || !waiter.predicate(notification)) return;
    clearTimeout(waiter.timer);
    this.#notificationWaiter = undefined;
    waiter.resolve(notification);
  }

  #onTerminal(error: Error): void {
    if (this.#terminalError !== undefined) return;
    this.#terminalError = error;
    this.#pendingRequest?.reject(error);
    this.#pendingRequest = undefined;
    if (this.#notificationWaiter !== undefined) {
      clearTimeout(this.#notificationWaiter.timer);
      this.#notificationWaiter.resolve(undefined);
      this.#notificationWaiter = undefined;
    }
  }

  /**
   * Sends a JSON-RPC request and resolves with its `result`, or rejects
   * with `AppServerRpcError` for a genuine protocol-level error response,
   * or a plain `Error` for a spawn/exit failure or a timeout. Throws
   * synchronously (before sending anything) if a previous `request()` on
   * this same connection is still outstanding - see this class's own doc
   * comment for why that is a programmer error here rather than something
   * to queue or overwrite.
   */
  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.#pendingRequest !== undefined) {
      throw new Error(
        `AppServerConnection.request("${method}") called while request id ${this.#pendingRequest.id} is still outstanding - this connection supports at most one in-flight request at a time`
      );
    }
    if (this.#terminalError !== undefined) throw this.#terminalError;
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequest = undefined;
        reject(new Error(`"${method}" did not receive a response within ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pendingRequest = {
        id,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.child.stdin?.write(line, (writeError) => {
        if (writeError === null || writeError === undefined) return;
        if (this.#pendingRequest?.id !== id) return;
        this.#pendingRequest = undefined;
        reject(writeError);
      });
    });
  }

  /**
   * Resolves with the first notification matching `predicate`, or
   * `undefined` if none arrives within `timeoutMs` (a timeout here is an
   * ordinary, expected outcome - see every call site - never itself an
   * error). Also resolves `undefined` immediately if this session has
   * already hit a terminal spawn/exit failure. Throws synchronously if a
   * previous `waitForNotification()` on this same connection is still
   * outstanding - see this class's own doc comment.
   */
  async waitForNotification(
    predicate: (notification: AppServerNotification) => boolean,
    timeoutMs: number
  ): Promise<AppServerNotification | undefined> {
    if (this.#notificationWaiter !== undefined) {
      throw new Error(
        "AppServerConnection.waitForNotification() called while a previous wait on this same connection is still outstanding - this connection supports at most one active wait at a time"
      );
    }
    if (this.#terminalError !== undefined) return undefined;
    return new Promise<AppServerNotification | undefined>((resolve) => {
      this.#notificationWaiter = {
        predicate,
        resolve: (value) => resolve(value),
        timer: setTimeout(() => {
          this.#notificationWaiter = undefined;
          resolve(undefined);
        }, timeoutMs),
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Spawn / shutdown
// ---------------------------------------------------------------------------

/** POSIX-only: a spawned `codex app-server` may itself spawn descendant processes (shell commands run as part of a turn's tool calls), so this transport contains each child in its OWN process group (mirroring `src/process.ts`'s `CONTAIN_IN_OWN_PROCESS_GROUP` and `test/helpers/spawnServer.ts`'s own identical convention) and signals the whole group on shutdown, not just the direct child - otherwise a descendant spawned mid-turn could be orphaned the moment the direct child exits. Windows has no equivalent process-group signaling primitive available here, so on Windows this transport falls back to signaling the direct child process only. */
const CONTAIN_APP_SERVER_IN_OWN_PROCESS_GROUP = process.platform !== "win32";

function spawnAppServer(options: ResolvedOptions): ChildProcess {
  return spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: CONTAIN_APP_SERVER_IN_OWN_PROCESS_GROUP,
  });
}

function killChildOrGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (CONTAIN_APP_SERVER_IN_OWN_PROCESS_GROUP) {
    process.kill(-pid, signal);
  } else {
    child.kill(signal);
  }
}

function onceExited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
}

function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    onceExited(child).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * The real POSIX phase split this transport uses to reap every child it
 * spawns: SIGTERM to the whole owned process group, a real bounded wait
 * for the OS to confirm it has actually exited, THEN SIGKILL to the same
 * group only if it has not - and a final, unconditional wait for that
 * exit to be confirmed too (SIGKILL is uncatchable, so this second wait
 * cannot itself hang). Safe to call on an already-exited child (a no-op).
 * Marks `connection` as expecting this exit first, if one is supplied, so
 * `AppServerConnection`'s own `exit` handler never misreports a deliberate
 * shutdown as an unexpected failure.
 */
async function shutdownChild(
  child: ChildProcess,
  gracefulShutdownGraceMs: number,
  connection?: AppServerConnection
): Promise<void> {
  connection?.expectExit();
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    killChildOrGroup(child, "SIGTERM");
  } catch {
    // Already gone between the liveness check above and this call.
  }
  const exitedAfterTerm = await exitedWithin(child, gracefulShutdownGraceMs);
  if (exitedAfterTerm) return;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      killChildOrGroup(child, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await onceExited(child);
}

// ---------------------------------------------------------------------------
// Protocol-shaped helpers
// ---------------------------------------------------------------------------

function buildInitializeParams(options: ResolvedOptions): unknown {
  return {
    clientInfo: { name: options.clientName, version: options.clientVersion },
    // Opts into experimental methods/fields per the protocol's own
    // documented meaning of this flag - `thread/goal/*` is generated only
    // under `--experimental` schema generation, so this is the
    // protocol-faithful way to reach it even though the specific installed
    // version this was verified against did not, in practice, reject
    // those methods without it.
    capabilities: { experimentalApi: true },
  };
}

/** The shape this transport actually reads off one `experimentalFeature/list` entry - a defensive subset of the real (much larger) schema, validated field-by-field rather than trusted wholesale, so a future schema addition never breaks parsing and a genuinely malformed entry is simply skipped rather than crashing `probe()`. */
export interface ExperimentalFeatureEntry {
  readonly name: string;
  readonly stage: string;
  readonly enabled: boolean;
}

/** Validates and narrows `data` (the raw `experimentalFeature/list` response's `.data` field) down to the entries this transport can actually read - never throws, silently drops anything that does not match. Exported for direct, process-free unit testing. */
export function parseExperimentalFeatureEntries(
  data: unknown
): readonly ExperimentalFeatureEntry[] {
  if (!Array.isArray(data)) return [];
  const entries: ExperimentalFeatureEntry[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as { name?: unknown; stage?: unknown; enabled?: unknown };
    if (typeof candidate.name !== "string") continue;
    if (typeof candidate.stage !== "string") continue;
    if (typeof candidate.enabled !== "boolean") continue;
    entries.push({ name: candidate.name, stage: candidate.stage, enabled: candidate.enabled });
  }
  return entries;
}

/** True when `notification.params` carries a `threadId` field equal to `target` - the correlation every notification this transport waits on (`turn/started`, `turn/completed`) is keyed by. Exported for direct unit testing. */
export function isNotificationForThread(
  notification: AppServerNotification,
  target: WakeTarget
): boolean {
  if (typeof notification.params !== "object" || notification.params === null) return false;
  const params = notification.params as { threadId?: unknown };
  return params.threadId === target;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Walks `experimentalFeature/list`'s pages (bounded by `MAX_FEATURE_LIST_PAGES`) looking for `GOALS_FEATURE_NAME`, returning it the moment it's found or `undefined` if the pages run out first without finding it. */
async function findGoalsFeature(
  connection: AppServerConnection,
  options: ResolvedOptions
): Promise<ExperimentalFeatureEntry | undefined> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_FEATURE_LIST_PAGES; page += 1) {
    const params = cursor === undefined ? {} : { cursor };
    const raw = (await connection.request(
      "experimentalFeature/list",
      params,
      options.initializeTimeoutMs
    )) as {
      data?: unknown;
      nextCursor?: unknown;
    };
    const found = parseExperimentalFeatureEntries(raw.data).find(
      (entry) => entry.name === GOALS_FEATURE_NAME
    );
    if (found !== undefined) return found;
    if (typeof raw.nextCursor !== "string") return undefined;
    cursor = raw.nextCursor;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/**
 * Concrete `WakeTransport` implementation - see `wakeTransport.ts` for the
 * interface contract and this file's own header comment for the
 * mechanism, the child-ownership model, and the bounding strategy.
 *
 * Crash safety is PER-INSTANCE, not a shared module-level registry: each
 * instance owns its own private `#liveChildrenForCrashSafety` array (a
 * plain array, appended to and spliced from - never a `Map`/`Set`) and
 * its own `process.on("exit", ...)` listener, so a hard crash elsewhere in
 * the process still gets a best-effort SIGKILL pass over whatever THIS
 * instance still has tracked, with no state shared across instances at
 * all. The listener itself is installed and removed ON DEMAND - present
 * only while `#liveChildrenForCrashSafety` is non-empty - rather than
 * once for the instance's whole lifetime: an exit LISTENER closes over
 * `this`, so a listener left registered for the instance's entire life
 * would itself keep that instance (and everything it references)
 * reachable from `process` forever, and registering one per instance with
 * no removal is a real, measured problem the moment more than a handful
 * of instances are ever constructed in one process (Node's own
 * `MaxListenersExceededWarning` fired at eleven short-lived transports
 * built back-to-back in this file's own test suite). Removing the
 * listener the moment there is nothing left for it to protect keeps the
 * steady-state listener count bounded by how many instances currently
 * have a live child in flight, never by how many have EVER been
 * constructed.
 */
export class AppServerGoalWakeTransport implements WakeTransport {
  readonly name = "codex-app-server-goal";
  readonly #options: ResolvedOptions;
  readonly #liveChildrenForCrashSafety: ChildProcess[] = [];
  readonly #backgroundSupervision: Promise<void>[] = [];
  #crashSafetyHandler: (() => void) | undefined;

  constructor(options: AppServerGoalWakeTransportOptions = {}) {
    this.#options = resolveOptions(options);
  }

  #trackChild(child: ChildProcess): void {
    this.#liveChildrenForCrashSafety.push(child);
    if (this.#crashSafetyHandler !== undefined) return;
    this.#crashSafetyHandler = () => {
      for (const tracked of this.#liveChildrenForCrashSafety) {
        if (tracked.exitCode !== null || tracked.signalCode !== null) continue;
        try {
          killChildOrGroup(tracked, "SIGKILL");
        } catch {
          // Already gone between the liveness check above and this call -
          // nothing further a synchronous exit handler can or needs to do.
        }
      }
    };
    process.on("exit", this.#crashSafetyHandler);
  }

  #untrackChild(child: ChildProcess): void {
    const index = this.#liveChildrenForCrashSafety.indexOf(child);
    if (index !== -1) this.#liveChildrenForCrashSafety.splice(index, 1);
    if (this.#liveChildrenForCrashSafety.length > 0) return;
    if (this.#crashSafetyHandler === undefined) return;
    process.off("exit", this.#crashSafetyHandler);
    this.#crashSafetyHandler = undefined;
  }

  async probe(): Promise<Capability> {
    const probedAt = new Date().toISOString();
    let child: ChildProcess | undefined;
    let connection: AppServerConnection | undefined;
    try {
      child = spawnAppServer(this.#options);
      this.#trackChild(child);
      connection = new AppServerConnection(child);
      await connection.request(
        "initialize",
        buildInitializeParams(this.#options),
        this.#options.initializeTimeoutMs
      );
      const feature = await findGoalsFeature(connection, this.#options);
      if (feature === undefined) {
        return {
          available: false,
          reason: `the running app-server's experimentalFeature/list did not report a "${GOALS_FEATURE_NAME}" feature`,
          probedAt,
        };
      }
      if (!feature.enabled) {
        return {
          available: false,
          reason: `the "${GOALS_FEATURE_NAME}" feature is present (stage: ${feature.stage}) but not enabled on this app-server`,
          probedAt,
        };
      }
      return { available: true, probedAt };
    } catch (error) {
      return {
        available: false,
        reason: `failed to probe "${this.#options.command}": ${errorMessage(error)}`,
        probedAt,
      };
    } finally {
      if (child !== undefined) {
        await shutdownChild(child, this.#options.gracefulShutdownGraceMs, connection);
        this.#untrackChild(child);
      }
    }
  }

  async wake(target: WakeTarget, payload: string): Promise<WakeResult> {
    let child: ChildProcess;
    try {
      child = spawnAppServer(this.#options);
    } catch (error) {
      return {
        outcome: "unavailable",
        detail: `failed to spawn "${this.#options.command}": ${errorMessage(error)}`,
        transportName: this.name,
      };
    }
    this.#trackChild(child);
    const connection = new AppServerConnection(child);

    try {
      await connection.request(
        "initialize",
        buildInitializeParams(this.#options),
        this.#options.initializeTimeoutMs
      );
    } catch (error) {
      await shutdownChild(child, this.#options.gracefulShutdownGraceMs, connection);
      this.#untrackChild(child);
      return {
        outcome: "unavailable",
        detail: `codex app-server did not complete the initialize handshake: ${errorMessage(error)}`,
        transportName: this.name,
      };
    }

    try {
      await connection.request(
        "thread/goal/set",
        {
          threadId: target,
          objective: payload,
          status: "active",
          tokenBudget: this.#options.tokenBudget,
        },
        this.#options.turnStartTimeoutMs
      );
    } catch (error) {
      await shutdownChild(child, this.#options.gracefulShutdownGraceMs, connection);
      this.#untrackChild(child);
      if (error instanceof AppServerRpcError) {
        return {
          outcome: "refused",
          detail: `codex app-server refused thread/goal/set for "${target}": ${error.message}`,
          transportName: this.name,
        };
      }
      return {
        outcome: "unavailable",
        detail: `thread/goal/set did not complete for "${target}": ${errorMessage(error)}`,
        transportName: this.name,
      };
    }

    const turnStarted = await connection.waitForNotification(
      (notification) =>
        notification.method === "turn/started" && isNotificationForThread(notification, target),
      this.#options.turnStartTimeoutMs
    );

    if (turnStarted === undefined) {
      // The goal was accepted, but no turn/started ever arrived for this
      // thread within the bound above. The most plausible cause is that
      // the target thread was not actually idle (a precondition this
      // transport documents but cannot itself verify - see
      // wakeTransport.ts's own `wake()` doc comment: probe() establishes
      // that the MECHANISM is available in general, never that a specific
      // target is ready right now). Mapped to "refused" rather than
      // "unavailable": this is "this failed just now" for THIS specific
      // attempt against THIS target, not "this will never work here" -
      // the caller can retry once the thread is genuinely idle, or try a
      // different transport for this one attempt, per WakeOutcome's own
      // documented distinction in wakeTransport.ts.
      await shutdownChild(child, this.#options.gracefulShutdownGraceMs, connection);
      this.#untrackChild(child);
      return {
        outcome: "refused",
        detail: `thread/goal/set for "${target}" was accepted but no turn/started was observed within ${this.#options.turnStartTimeoutMs}ms (the thread may not have been idle)`,
        transportName: this.name,
      };
    }

    const result: WakeResult = {
      outcome: "delivered",
      detail: `turn started for thread "${target}"`,
      transportName: this.name,
    };

    // Delivery is confirmed - this promise resolves now, at the measured
    // mechanism's own latency, rather than waiting for the triggered turn
    // to finish. The child that is actually executing that turn is handed
    // to bounded background supervision below, which THIS transport
    // instance still fully owns (tracked in #backgroundSupervision, and
    // in #liveChildrenForCrashSafety until it is reaped) - see this file's
    // header comment for why killing it now would abort the very turn
    // this call just started.
    const supervision = superviseUntilConcluded(connection, child, target, this.#options)
      .catch(() =>
        shutdownChild(child, this.#options.gracefulShutdownGraceMs, connection).catch(
          () => undefined
        )
      )
      .finally(() => {
        const index = this.#backgroundSupervision.indexOf(supervision);
        if (index !== -1) this.#backgroundSupervision.splice(index, 1);
        this.#untrackChild(child);
      });
    this.#backgroundSupervision.push(supervision);

    return result;
  }

  /**
   * TEST-ONLY: resolves once every child this instance has handed to
   * background supervision (see `wake()` above) has actually been reaped.
   * A production caller of the `WakeTransport` interface never sees this
   * method - it exists purely so `test/wake-app-server.test.ts` can await
   * full, deterministic teardown of every process this transport spawned
   * before a test file ends, which this repo's own test runner
   * (`scripts/run-tests.mjs`) requires: it fails the WHOLE suite if any
   * live handle (a timer, an open child) outlives the last test's own
   * completion by more than a few seconds. Never imported outside
   * `src/wake/` or a `test/wake-*.test.ts` file - see
   * `scripts/check-wake-transport-boundaries.mjs`'s own enforcement of
   * exactly that.
   */
  async waitForBackgroundSupervisionForTests(): Promise<void> {
    await Promise.all(this.#backgroundSupervision);
  }
}

/** Keeps `child` alive under `connection` until EITHER a `turn/completed` notification arrives for `target` OR `options.maxSessionMs` elapses, whichever is first, then shuts it down. This is the background half of a delivered `wake()` call - see `AppServerGoalWakeTransport.wake()`'s own doc comment above for why it is not simply awaited inline. */
async function superviseUntilConcluded(
  connection: AppServerConnection,
  child: ChildProcess,
  target: WakeTarget,
  options: ResolvedOptions
): Promise<void> {
  await connection.waitForNotification(
    (notification) =>
      notification.method === "turn/completed" && isNotificationForThread(notification, target),
    options.maxSessionMs
  );
  await shutdownChild(child, options.gracefulShutdownGraceMs, connection);
}
