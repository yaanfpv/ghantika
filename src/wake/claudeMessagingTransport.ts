/**
 * A `WakeTransport` that wakes THIS PROCESS'S OWN Claude Code session -
 * never a different one - by writing directly to the unix domain socket
 * that session already exported into this process's environment when it
 * spawned ghantika as an MCP server subprocess.
 *
 * NOT to be confused with `src/tasksAdapter.ts`'s own output-driven wake
 * mechanism or with the released Tasks extension's own status notification -
 * see `wakeTransport.ts`'s own header for that distinction in full. Same
 * English word, unrelated mechanisms.
 *
 * ## Why this transport has exactly one destination
 *
 * `appServerTransport.ts` and `desktopIpcTransport.ts` both route a `target`
 * (a thread id, a conversation id) among several candidates a client could
 * reach. This transport cannot do that and does not try to: the socket path
 * and token it reads are the ones THIS session's own parent exported for
 * THIS process alone, so there is exactly one thing on the other end of the
 * connection - the session that spawned ghantika. `target` is accepted (the
 * `WakeTransport` interface requires it) purely to satisfy that contract and
 * to surface in a result's `detail` string for logging; it plays no role in
 * how the message is addressed.
 *
 * ## AC2 - the socket path is read, never constructed
 *
 * `process.env.CLAUDE_CODE_MESSAGING_SOCKET` is the ONLY source this
 * transport ever consults for the socket path. There is no fallback
 * construction of a `cc-socks/<pid>.sock`-shaped path, no directory scan, no
 * enumeration of candidate sockets - a socket path this transport did not
 * itself receive from the environment is a socket path it has no way to
 * know is even the right one, let alone one it is entitled to reach.
 * Absent, empty, or unreadable-later means `available: false` /
 * `"unavailable"`, always - see `readInheritedConnectionInfo` below, which
 * is the single, exhaustively-tested chokepoint every other function in
 * this file goes through to learn the path or the token.
 *
 * ## What is MEASURED versus what this transport had to design for itself
 *
 * MEASURED, read directly out of the deployed Claude Code binary on
 * 2026-08-18 (an embedded usage-example string, not a captured live
 * exchange - see the caveat on delivery confirmation below): the two
 * environment variable names (`CLAUDE_CODE_MESSAGING_SOCKET`,
 * `CLAUDE_CODE_MESSAGING_TOKEN`), and the exact two-line newline-delimited
 * JSON handshake shape -
 *
 *   {"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}
 *   {"type":"user","message":{"role":"user","content":"<payload>"}}
 *
 * - reproduced verbatim in `AUTH_MESSAGE_TYPE`/`USER_MESSAGE_TYPE` and
 * `buildAuthLine`/`buildUserMessageLine` below.
 *
 * ## AC3 - auth is CHECKED, not merely ignored, without ever guessing a
 * credential
 *
 * Two independent pieces of evidence, neither of which required sending a
 * wrong token (which stays off-limits - a deliberately bad credential reads
 * as credential guessing and this transport never does it):
 *
 * 1. The binary's own server-side logic DROPS an unauthenticated connection
 *    (its own diagnostic reads "Dropped ... from a connection that did not
 *    authenticate; closing it") rather than silently accepting it with the
 *    auth line ignored.
 * 2. This transport's actual `probe()` - the real code below, not a
 *    standalone script - was run against a real inherited socket with the
 *    real inherited token on 2026-08-18 and returned `available: true`
 *    (the connection was accepted and not dropped within the grace window).
 *
 * Together: the server enforces auth (1) and this transport's own real
 * request with the real credential passes that enforcement (2). That is
 * AC3 settled from observed behavior on both sides of the boundary, with
 * no negative-control probe attempted or needed.
 *
 * NOT measured, and therefore this transport's own reasoned design: there is
 * no `id`/acknowledgement field anywhere in the measured two-line example,
 * so unlike `desktopIpcTransport.ts`'s correlated request/response calls,
 * this protocol is fire-and-forget as far as any evidence available to this
 * transport shows. `wake()` therefore infers delivery from the ABSENCE of a
 * rejection within a short grace window after both lines are written
 * (`DEFAULT_DELIVERY_GRACE_MS`) rather than from any positive
 * acknowledgement - disclosed here rather than overstated as a confirmed
 * ack, and named explicitly in every "delivered" `WakeResult.detail` this
 * transport returns.
 *
 * ## AC4 - the child path structurally, but end-to-end delivery is unproven
 *
 * The binary's own logic distinguishes a `childToken` (this transport's
 * whole path - the credential this session's own parent already handed it)
 * from a `peerToken` (a separate mechanism, keyed by a published
 * `cc-msg-<32 hex>` file, gated behind a hold-for-approval flow for a
 * genuinely different, unrelated session). This transport never reads,
 * writes, or discovers a peer key file, never presents anything as a peer,
 * and has no code path that could - it sends exactly the token it inherited,
 * which is the child token by construction of how that token reached this
 * process in the first place.
 *
 * THAT IS THE STRUCTURAL ARGUMENT ALONE, and it does not by itself establish
 * that a real `wake()` call is undelivered-or-held. That requires a real
 * delivered `wake()` against a real socket - which, unlike `probe()`'s
 * auth-only line, DOES write the user-message line and therefore DOES
 * inject a real turn into whatever session owns the socket. No such
 * end-to-end delivery has yet been observed. What this section establishes
 * is the shape of the boundary (child versus peer); whether a real `wake()`
 * call actually lands, undelivered, is not yet demonstrated either way, and
 * is disclosed here as open rather than closed by inference.
 */
import net from "node:net";

import type { Capability, WakeResult, WakeTarget, WakeTransport } from "./wakeTransport.js";

// ---------------------------------------------------------------------------
// Measured constants. Every wire-visible string is exported so a test can
// assert directly against the exact literal rather than a hand-copied
// duplicate.
// ---------------------------------------------------------------------------

/** The stable name this transport reports on every `WakeResult`. */
export const TRANSPORT_NAME = "claude-code-uds-messaging";

/** Exactly what this session's own parent exported it as - see this file's header for why nothing here ever falls back to constructing a path. */
export const SOCKET_PATH_ENV_VAR = "CLAUDE_CODE_MESSAGING_SOCKET";

/** Exactly what this session's own parent exported it as - see this file's header. */
export const TOKEN_ENV_VAR = "CLAUDE_CODE_MESSAGING_TOKEN";

/** The first line's `type` value, measured verbatim from the binary's own embedded usage example. */
export const AUTH_MESSAGE_TYPE = "auth";

/** The second line's `type` value, measured verbatim. */
export const USER_MESSAGE_TYPE = "user";

/** How long `probe()`/`wake()` wait for the initial socket connection before giving up - a local unix domain socket connect is normally near-instant, so this is generous headroom for a busy host, not a measured value. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 1000;

/**
 * How long, after both lines are written, `probe()`/`wake()` wait to see
 * whether the connection is dropped (interpreted as authentication having
 * failed - see this file's header on the binary's own "Dropped ... did not
 * authenticate" diagnostic) before concluding it was accepted. Not a
 * measured value - the drop is presumably near-instant once the server
 * parses the auth line, so this is generous headroom over that, not a
 * derived bound.
 */
export const DEFAULT_DELIVERY_GRACE_MS = 500;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// AC2 chokepoint - reading the inherited path/token. Every other function in
// this file that needs either value goes through here; there is no second
// place in this file that reads `process.env` for these two names.
// ---------------------------------------------------------------------------

export type InheritedConnectionInfo =
  | { readonly ok: true; readonly socketPath: string; readonly token: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads `SOCKET_PATH_ENV_VAR` and `TOKEN_ENV_VAR` from `env` (defaults to
 * `process.env`, overridable for tests). Both must be present and non-empty
 * for this transport to have anything to do - a socket path with no way to
 * authenticate against it is not a usable connection, and this transport
 * never sends the auth line with an empty or missing token to find out.
 * This function never falls back to constructing a path from any other
 * value; see this file's header (AC2).
 */
export function readInheritedConnectionInfo(
  env: NodeJS.ProcessEnv = process.env
): InheritedConnectionInfo {
  const socketPath = env[SOCKET_PATH_ENV_VAR];
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    return {
      ok: false,
      reason: `${SOCKET_PATH_ENV_VAR} is not set - this session was not given an inherited messaging socket`,
    };
  }
  const token = env[TOKEN_ENV_VAR];
  if (typeof token !== "string" || token.length === 0) {
    return {
      ok: false,
      reason: `${TOKEN_ENV_VAR} is not set - a socket path with no token to authenticate against it is not usable`,
    };
  }
  return { ok: true, socketPath, token };
}

// ---------------------------------------------------------------------------
// Wire framing - measured verbatim, see this file's header.
// ---------------------------------------------------------------------------

/** Builds the first of the two NDJSON lines this transport ever sends - measured verbatim, see this file's header. Exported for direct, process-free unit testing. */
export function buildAuthLine(token: string): string {
  return `${JSON.stringify({ type: AUTH_MESSAGE_TYPE, token })}\n`;
}

/** Builds the second of the two NDJSON lines this transport ever sends - measured verbatim, see this file's header. Exported for direct, process-free unit testing. */
export function buildUserMessageLine(payload: string): string {
  return `${JSON.stringify({ type: USER_MESSAGE_TYPE, message: { role: "user", content: payload } })}\n`;
}

// ---------------------------------------------------------------------------
// The connection itself - open, write both lines, observe whether the
// server drops the connection within the grace window. No request/response
// correlation of any kind: see this file's header on why this protocol is,
// as far as any evidence available to this transport shows, fire-and-forget.
// ---------------------------------------------------------------------------

export type SendOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "dropped"; readonly detail: string }
  | { readonly kind: "connect-failed"; readonly detail: string }
  | { readonly kind: "write-failed"; readonly detail: string };

/**
 * Opens a connection to `socketPath`, writes the auth line and (when
 * `payload` is provided) the user-message line, then waits up to
 * `graceMs` to see whether the server closes or errors the connection -
 * the one observable signal this protocol offers (see this file's header).
 * Always closes the connection itself before returning, whatever the
 * outcome. Never throws - every failure path resolves a stated
 * `SendOutcome` instead.
 *
 * `payload === undefined` sends only the auth line - this is what `probe()`
 * uses: a side-effect-free way to observe whether the token is accepted,
 * since a connection that only ever sends `type:"auth"` never reaches the
 * server's own enqueue-a-message code path at all.
 */
export function sendOverSocket(
  socketPath: string,
  token: string,
  payload: string | undefined,
  connectTimeoutMs: number,
  graceMs: number
): Promise<SendOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: SendOutcome, socket?: net.Socket): void => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(outcome);
    };

    const socket = net.createConnection({ path: socketPath });

    const connectTimer = setTimeout(() => {
      settle(
        {
          kind: "connect-failed",
          detail: `connection to ${socketPath} did not complete within ${connectTimeoutMs}ms`,
        },
        socket
      );
    }, connectTimeoutMs);

    socket.once("error", (error: Error) => {
      clearTimeout(connectTimer);
      // An error before the grace window has even started is a connect
      // failure; an error that lands DURING the grace window (handled by
      // the "close" listener installed after connect below) is the drop
      // signal itself, not a distinct failure mode - see the header.
      settle({ kind: "connect-failed", detail: describeError(error) }, socket);
    });

    socket.once("connect", () => {
      clearTimeout(connectTimer);

      const authLine = buildAuthLine(token);
      const lines = payload === undefined ? [authLine] : [authLine, buildUserMessageLine(payload)];

      let writeIndex = 0;
      const writeNext = (): void => {
        if (settled) return;
        if (writeIndex >= lines.length) {
          armGraceWindow();
          return;
        }
        const line = lines[writeIndex];
        writeIndex += 1;
        socket.write(line, (writeError) => {
          if (writeError !== null && writeError !== undefined) {
            settle({ kind: "write-failed", detail: describeError(writeError) }, socket);
            return;
          }
          writeNext();
        });
      };

      const armGraceWindow = (): void => {
        const droppedDuringGrace = (detail: string) => () => {
          settle({ kind: "dropped", detail }, socket);
        };
        socket.once(
          "close",
          droppedDuringGrace(
            "connection closed before the grace window elapsed - the server did not accept this connection (see this file's header on the drop-on-unauthenticated diagnostic)"
          )
        );
        socket.once("error", (error: Error) => {
          settle({ kind: "dropped", detail: describeError(error) }, socket);
        });
        setTimeout(() => {
          settle({ kind: "accepted" }, socket);
        }, graceMs);
      };

      writeNext();
    });
  });
}

// ---------------------------------------------------------------------------
// The transport itself
// ---------------------------------------------------------------------------

export interface ClaudeMessagingWakeTransportOptions {
  /** Overrides `process.env` for reading the inherited socket path/token - exists so tests can supply a synthetic environment, never used in production. */
  readonly env?: NodeJS.ProcessEnv;
  readonly connectTimeoutMs?: number;
  readonly deliveryGraceMs?: number;
}

/**
 * The concrete `WakeTransport` implementation described in this file's
 * header. See that header for the full design, what is measured versus
 * this transport's own reasoned design, and the AC2/AC4 boundaries.
 */
export class ClaudeMessagingWakeTransport implements WakeTransport {
  readonly name = TRANSPORT_NAME;
  private readonly env: NodeJS.ProcessEnv;
  private readonly connectTimeoutMs: number;
  private readonly deliveryGraceMs: number;

  constructor(options: ClaudeMessagingWakeTransportOptions = {}) {
    this.env = options.env ?? process.env;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.deliveryGraceMs = options.deliveryGraceMs ?? DEFAULT_DELIVERY_GRACE_MS;
  }

  /**
   * Checks whether this process has an inherited socket/token pair
   * (AC2's chokepoint - see `readInheritedConnectionInfo`) and, if so,
   * whether the token this session was actually given is accepted: a
   * connection carrying only the auth line, with the grace window elapsing
   * without a drop. This never sends a `type:"user"` line, so a `probe()`
   * call has no observable side effect on the target session.
   */
  async probe(): Promise<Capability> {
    const probedAt = new Date().toISOString();
    const inherited = readInheritedConnectionInfo(this.env);
    if (!inherited.ok) {
      // permanent: true - readInheritedConnectionInfo's only failure
      // mode is one of the two inherited env vars being absent or
      // empty, and an environment variable is fixed at this process's
      // spawn time: it cannot appear, disappear, or change value later
      // in this same process's life. Genuinely known here, never
      // guessed - see Capability.permanent's own docs for the bar this
      // has to clear.
      return { available: false, reason: inherited.reason, probedAt, permanent: true };
    }

    const outcome = await sendOverSocket(
      inherited.socketPath,
      inherited.token,
      undefined,
      this.connectTimeoutMs,
      this.deliveryGraceMs
    );

    switch (outcome.kind) {
      case "accepted":
        return { available: true, probedAt };
      case "dropped":
        return {
          available: false,
          reason: `inherited token was not accepted by ${inherited.socketPath}: ${outcome.detail}`,
          probedAt,
        };
      case "connect-failed":
        return {
          available: false,
          reason: `could not connect to ${inherited.socketPath}: ${outcome.detail}`,
          probedAt,
        };
      case "write-failed":
        return {
          available: false,
          reason: `could not write the auth line to ${inherited.socketPath}: ${outcome.detail}`,
          probedAt,
        };
    }
  }

  /**
   * Attempts to wake this session's own parent by sending the auth line
   * followed by the user-message line carrying `payload`. `target` plays
   * no addressing role here - see this file's header on why this transport
   * has exactly one destination - and is surfaced only in `detail` strings.
   * Never throws: every failure path returns a `WakeResult` with a stated
   * `detail`. Runs the exchange exactly once; there is no internal retry.
   */
  async wake(target: WakeTarget, payload: string): Promise<WakeResult> {
    const inherited = readInheritedConnectionInfo(this.env);
    if (!inherited.ok) {
      // Defensive only - the WakeTransport contract requires probe() to
      // have already reported available: true before wake() is ever
      // called, and readInheritedConnectionInfo reads the exact same
      // fixed-at-spawn env vars probe() already checked moments earlier
      // in the same process, so this branch should not be reachable in
      // practice. If it ever is, the reason is the identical structural
      // one probe() would have reported - see this method's own
      // permanent:true comment above.
      return {
        outcome: "unavailable",
        detail: inherited.reason,
        transportName: this.name,
        permanent: true,
      };
    }

    const outcome = await sendOverSocket(
      inherited.socketPath,
      inherited.token,
      payload,
      this.connectTimeoutMs,
      this.deliveryGraceMs
    );

    switch (outcome.kind) {
      case "accepted":
        return {
          outcome: "delivered",
          detail: `sent to this session's own parent over ${inherited.socketPath} (target "${target}" is informational only - see this file's header); no positive acknowledgement exists in this protocol, so "delivered" here means the connection was not dropped within ${this.deliveryGraceMs}ms of writing both lines`,
          transportName: this.name,
        };
      case "dropped":
        return {
          outcome: "refused",
          detail: `connection to ${inherited.socketPath} was dropped before delivery could be confirmed: ${outcome.detail}`,
          transportName: this.name,
        };
      case "connect-failed":
        return {
          outcome: "unavailable",
          detail: `could not connect to ${inherited.socketPath}: ${outcome.detail}`,
          transportName: this.name,
        };
      case "write-failed":
        return {
          outcome: "unavailable",
          detail: `could not write to ${inherited.socketPath}: ${outcome.detail}`,
          transportName: this.name,
        };
    }
  }
}
