/**
 * A `WakeTransport` that wakes a Codex conversation running inside a live
 * ChatGPT desktop app window, by talking directly to that app's own local
 * IPC bus over a Unix domain socket - never over the network, never
 * through any published API.
 *
 * NOT to be confused with `src/tasksAdapter.ts`'s own
 * `notifications/ghantika/outputWake` wake-on-output mechanism, or with
 * the released Tasks extension's own `notifications/tasks` status
 * notification, which tell an MCP CLIENT that its next poll would return
 * new data (or a task's own current status) - notifications sent one layer
 * up the stack, over this server's own existing MCP connection, to
 * whatever client is already talking to it. This module does something
 * unrelated: it reaches ACROSS to a completely different, unrelated OS
 * process (the desktop app) to resume an idle AGENT SESSION sitting open
 * in one of its windows. Same English word, unrelated mechanisms, matching
 * `wakeTransport.ts`'s own header note on exactly this ambiguity.
 *
 * ## Why this is explicitly best-effort, not a stable integration
 *
 * Every identifier this transport touches - the socket path, the three
 * method names below, `turnStartParams`'s field shape, the length-prefix
 * framing itself - is a closed, undocumented internal of the ChatGPT
 * desktop app's own bundled code, never a published API this transport has
 * any right to expect stays still. It already moved once, inside a single
 * app update on 2026-08-07: the socket relocated from an older,
 * per-uid-scoped temp path (shaped like `T/codex-ipc/ipc-<uid>.sock`) to
 * today's fixed `~/.codex/ipc/ipc.sock`, and that SAME update silently
 * removed a previously-working, unrelated local feature outright, with no
 * notice. Nothing here treats any of today's facts as durable:
 * `probe()` (below) re-observes the real socket fresh on every call, never
 * caches an assumption from an earlier run, and every step in this file
 * that gets back something other than what today's app actually produces
 * fails soft with a diagnostic naming exactly what was different - never a
 * crash, never a silent no-op.
 *
 * ## What is MEASURED versus what this transport had to design for itself
 *
 * MEASURED, from a real live session confirmed today and reproduced
 * verbatim below: the socket path, the 4-byte little-endian length-prefix
 * framing ahead of each UTF-8 JSON message, and the three-call sequence's
 * exact method names and parameter field names -
 * `initialize`/`clientType`; `thread-owner-discovery`/`hostId`+
 * `conversationId`; `thread-follower-start-turn`/`conversationId`+
 * `turnStartParams`, including `turnStartParams`'s own exact nested shape
 * (`input`/`model`/`effort`/`serviceTier`/`collaborationMode`). None of
 * these values are invented here - see `INITIALIZE_METHOD`,
 * `THREAD_OWNER_DISCOVERY_METHOD`, `THREAD_FOLLOWER_START_TURN_METHOD`,
 * and `buildStartTurnParams` below.
 *
 * ## The request/reply envelope
 *
 * Every outgoing message carries a `type` discriminator (the literal
 * string `"request"`), a `requestId`, and a `sourceClientId` - `null` on a
 * connection's first call (`initialize`, before the app has assigned this
 * connection an id) and that call's own returned `clientId` on every call
 * after it on the same connection (see `IpcConnection`'s own `clientId`
 * field below):
 *
 *   request:  { type: "request", requestId, sourceClientId, method,
 *               params, targetClientId? }
 *   response: { type: "response", requestId, method, resultType,
 *               handledByClientId, result }
 *
 * A reply is matched to its request by `requestId`. Success is
 * `resultType === "success"`, with `result` carrying the payload; any
 * other `resultType` is a failure, whose text this transport looks for in
 * several plausible locations across the reply rather than committing to
 * one (see `IpcConnection.dispatch` below), since the protocol does not
 * pin a single canonical location for it. A request missing the
 * `type`/`requestId` discriminators is never answered at all - it
 * produces no reply and no error, so a caller of this transport that
 * somehow bypassed the envelope above would see only a request timeout,
 * indistinguishable from a genuinely unresponsive app.
 *
 * `thread-owner-discovery` carries two further requirements beyond the
 * shape above: it needs an explicit `version` field (currently `1`) or it
 * is never answered, and its `hostId` parameter is the fixed literal
 * string `"local"` rather than the calling client's own id. A successful
 * reply's owner id is the envelope-level `handledByClientId` field, never
 * a field inside `result`; a genuine no-owner outcome is
 * `resultType:"error"` with a bare STRING `error` equal to the sentinel
 * in `NO_CLIENT_FOUND_SENTINEL`, never an object and never folded into
 * `result` - see `interpretOwnerDiscoveryResult`'s own docs for the full
 * shape.
 *
 * This transport fails soft on anything outside the shapes above: an
 * envelope field it does not recognise, or a failure-text location none
 * of the checked spellings match, degrades a call to `unavailable` with a
 * named diagnostic rather than mis-delivering or throwing.
 *
 * A disclosed, unresolved limit: `thread-owner-discovery` never replies at
 * all for a conversation id that has never been opened in any live
 * renderer window, rather than answering with a genuine no-owner result.
 * This does not affect a real wake target, which is by definition a
 * conversation that has been opened in a window at some point, so it does
 * not change what a caller of this transport should do - it is recorded
 * because it is a real, observed limit of what this transport's
 * owner-discovery step can answer.
 *
 * ## The owner gate is a disclosed boundary, not a bug to route around
 *
 * `thread-owner-discovery` exists because the app enforces, internally,
 * that only a client which actually has the target conversation OPEN in a
 * live window may start a turn on it - confirmed today against a real
 * session: the one thread genuinely open in a window resolved an owner and
 * a real turn went through; three other, not-presented threads each came
 * back with no owner at all. This transport treats that as a real,
 * legitimate boundary rather than an obstacle: it never fabricates or
 * guesses a `targetClientId`, never sends `thread-follower-start-turn`
 * without a real owner id `thread-owner-discovery` itself just returned,
 * and reports the no-owner case as `"refused"` (this specific attempt
 * cannot be delivered right now - the target conversation would need to be
 * opened in a window first) rather than `"unavailable"` (this transport
 * will never work at all). Every network exchange in `wake()` runs exactly
 * once per call, bounded by `connectTimeoutMs`/`requestTimeoutMs` - there
 * is no internal retry loop anywhere in this file, so a rejected or
 * unreachable wake attempt returns promptly with a stated reason instead
 * of ever presenting as a hang.
 *
 * ## Authorization model: same-uid access to a local socket, nothing else
 *
 * This transport never reads an API token or any other credential, never
 * makes a network call to chatgpt.com or any other remote host, and
 * requires no pairing or handshake flow beyond the plain IPC calls
 * documented above. Its entire authorization model is being the SAME OS
 * user as the socket's owner: `probe()`'s ownership check (below) is the
 * one and only gate this transport enforces, and it is a disclosed,
 * deliberate design boundary rather than an oversight - the app's own
 * undocumented protocol offers nothing stronger to check today, so this
 * transport does not invent a cryptographic handshake that isn't there.
 *
 * ## Never preferred over the durable transport
 *
 * A sibling transport, built separately against the published, documented
 * `codex app-server` subcommand, is the durable path for a headless or
 * terminal Codex session. This transport exists ONLY for the case that one
 * cannot reach at all: a session with no `codex app-server` process behind
 * it because it is running purely inside a ChatGPT desktop window. This
 * file implements no selection or preference logic between transports at
 * all - that ordering is deliberately out of scope here (see
 * `wakeTransport.ts`'s own header) and belongs to a future selection layer
 * this module knows nothing about. Nothing below should be read as this
 * transport volunteering to run first among several; it is built, tested,
 * and documented purely as one candidate a future selector may or may not
 * choose.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type {
  Capability,
  WakeOutcome,
  WakeResult,
  WakeTarget,
  WakeTransport,
} from "./wakeTransport.js";

// ---------------------------------------------------------------------------
// Measured constants - see this file's header for what is measured vs
// designed. Every name below that carries a wire-visible string value is
// exported so a test can assert against the exact literal, never a
// hand-copied duplicate of it.
// ---------------------------------------------------------------------------

/** The stable name this transport reports on every `WakeResult` - unrelated to any protocol-level identifier the app itself uses. */
export const TRANSPORT_NAME = "chatgpt-desktop-ipc";

/**
 * Today's real socket location, confirmed live on 2026-08-07 - see this
 * file's header for the fact that this exact path already moved once,
 * inside a single app update, from an older per-uid temp-directory path.
 * `os.homedir()` is used rather than `process.env.HOME` directly so this
 * still resolves correctly under an environment that has HOME unset but a
 * resolvable passwd entry (mirroring how `node:os` itself documents this
 * function's fallback behavior).
 */
export const DEFAULT_SOCKET_PATH = path.join(os.homedir(), ".codex", "ipc", "ipc.sock");

/** How long `probe()`/`wake()` wait for the initial socket connection before giving up - a local Unix domain socket connect is normally near-instant, so this is generous headroom for a busy host, not a value derived from any measurement of the real app. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 1000;

/** How long each individual request (`initialize`/`thread-owner-discovery`/`thread-follower-start-turn`) waits for its matching reply before giving up - chosen to tolerate a busy desktop-app main thread without letting a single call hang indefinitely. Not a measured value. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 3000;

/** The `method` value sent to obtain a `clientId` - measured verbatim. */
export const INITIALIZE_METHOD = "initialize";

/** The `method` value sent to find which connected client currently owns (has open) a conversation - measured verbatim. */
export const THREAD_OWNER_DISCOVERY_METHOD = "thread-owner-discovery";
/** `thread-owner-discovery`'s current protocol version. Omitting `version` entirely gets no reply at all, the same silent-drop shape as a missing envelope discriminator. See `OutgoingEnvelope.version`'s own docs on why this is a literal rather than a resolved table lookup. */
export const THREAD_OWNER_DISCOVERY_VERSION = 1;

/** The `method` value sent to actually start a turn on a conversation, targeted at its owning client - measured verbatim. */
export const THREAD_FOLLOWER_START_TURN_METHOD = "thread-follower-start-turn";

/**
 * This transport's own self-identification, sent as `initialize`'s
 * `clientType` value - a choice this transport makes about itself, not a
 * measured fact about what the real app expects there. A real desktop
 * window presumably sends something else; the app's own
 * `thread-owner-discovery`/ownership model is what decides whether this
 * transport can reach a given conversation, never `clientType` itself.
 */
export const GHANTIKA_CLIENT_TYPE = "ghantika-wake-transport";

/**
 * The sentinel string the measured facts quote verbatim for "no client has
 * this conversation open." Used both to recognize the no-owner case in a
 * reply this transport did not have to guess the exact shape of (see
 * `interpretOwnerDiscoveryResult` below) and as the literal text this
 * transport's own `"refused"` detail quotes back to a caller.
 */
export const NO_CLIENT_FOUND_SENTINEL = "no-client-found";

// ---------------------------------------------------------------------------
// Wire framing - a 4-byte little-endian length prefix ahead of each UTF-8
// JSON message, measured verbatim. Kept as small, independently testable
// pure functions/classes so the framing logic can be exercised with
// synthetic buffers, with no real socket involved at all.
// ---------------------------------------------------------------------------

const LENGTH_PREFIX_BYTES = 4;

/**
 * A defensive upper bound on one frame's declared body length, applied
 * BEFORE any buffering happens - a hostile or corrupted length prefix
 * (e.g. a stray four bytes that happen to decode to a huge number) must
 * never make this transport try to buffer an unbounded amount of memory
 * waiting for a frame that will never complete. 16 MiB comfortably exceeds
 * anything this transport's own three calls ever send or expect to
 * receive; it exists purely as a sanity ceiling, not a tuned production
 * limit.
 */
export const MAX_IPC_FRAME_BYTES = 16 * 1024 * 1024;

/** Encodes one JSON-serializable message as a length-prefixed frame, ready to write directly to the socket. */
export function encodeIpcFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Reassembles length-prefixed frames out of an arbitrarily-chunked byte
 * stream - a Unix domain socket delivers bytes with no regard for message
 * boundaries, so a single `data` event can carry a partial frame, exactly
 * one complete frame, or several frames back to back, and this decoder
 * handles all three the same way: buffer everything received so far, and
 * peel off as many complete frames as are currently available.
 */
export class IpcFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Feeds one newly-received chunk and returns every complete frame's
   * parsed JSON value now available, in arrival order (empty when `chunk`
   * only completes a partial frame with nothing left over). Throws if a
   * frame's declared length exceeds `MAX_IPC_FRAME_BYTES` (see that
   * constant's own docs) or if a complete frame's body is not valid JSON -
   * both are real, structural protocol violations a caller must treat as
   * this transport's whole connection being unusable, never a value to
   * silently skip past.
   */
  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      if (this.buffer.length < LENGTH_PREFIX_BYTES) break;
      const declaredLength = this.buffer.readUInt32LE(0);
      if (declaredLength > MAX_IPC_FRAME_BYTES) {
        throw new Error(
          `ipc frame declared a ${declaredLength}-byte body, exceeding the ${MAX_IPC_FRAME_BYTES}-byte defensive bound - refusing to buffer it`
        );
      }
      const frameTotalLength = LENGTH_PREFIX_BYTES + declaredLength;
      if (this.buffer.length < frameTotalLength) break; // wait for the rest of this frame
      const body = this.buffer.subarray(LENGTH_PREFIX_BYTES, frameTotalLength);
      this.buffer = this.buffer.subarray(frameTotalLength);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch (error) {
        throw new Error(
          `ipc frame body failed to parse as JSON: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
      messages.push(parsed);
    }
    return messages;
  }
}

// ---------------------------------------------------------------------------
// The request/response envelope - see this file's header for the shape.
// ---------------------------------------------------------------------------

interface OutgoingEnvelope {
  /**
   * Every request the app's IPC router accepts carries a literal
   * `"request"` discriminator - omitting it produces total silence (no
   * reply, no error) rather than a rejection, because the router never
   * recognizes the message as a request at all.
   */
  readonly type: "request";
  /** The app correlates a reply by `requestId`, never a bare `id`. */
  readonly requestId: string;
  /**
   * `null` only for the very first `initialize` call on a fresh
   * connection, before the app has assigned this connection a clientId;
   * every subsequent call on the same connection carries that assigned id
   * here.
   */
  readonly sourceClientId: string | null;
  readonly method: string;
  readonly params: Record<string, unknown>;
  /** Present only on the final, targeted call - see this file's header on how routing to one specific client is assumed to work. */
  readonly targetClientId?: string;
  /**
   * Required by `thread-owner-discovery` specifically: a call with no
   * `version` field gets no reply at all, the same silent-drop shape as a
   * missing envelope discriminator above. Currently `1`. This transport
   * does not generalise to reading every method's protocol version from
   * the app, so this field is set only where a call is known to need it,
   * as a literal rather than a resolved table lookup.
   */
  readonly version?: number;
}

/** The result of one `IpcConnection.call` - a protocol-level `error` reply is `{ok:false}`, never a thrown exception, so a caller can distinguish "the app answered and refused" from "the connection itself broke" (the latter surfaces as a rejected promise instead - see `IpcConnection.call`'s own docs). `handledByClientId` is carried on the success case because `thread-owner-discovery` reports the owner there, at the envelope level, never inside `result` - see this file's header and `IpcConnection.dispatch` below. */
type IpcCallOutcome =
  | { readonly ok: true; readonly result: unknown; readonly handledByClientId: string | undefined }
  | { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Renders an arbitrary reply value into a short, safe diagnostic string - never assumes the shape it's describing, since the whole point of calling this is that the shape was NOT what was expected. */
function describeUnexpectedReply(value: unknown): string {
  try {
    const rendered = JSON.stringify(value);
    return rendered.length > 200 ? `${rendered.slice(0, 200)}...(truncated)` : rendered;
  } catch {
    return String(value);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One outstanding `IpcConnection.call` awaiting its reply - see that method's own docs. */
interface PendingIpcCall {
  readonly requestId: string;
  readonly settle: (outcome: IpcCallOutcome) => void;
  readonly onFatal: (error: Error) => void;
}

/** One live connection to the desktop app's IPC socket - opens the socket, tracks at most one outstanding request at a time (this transport's own three-call sequence is always strictly sequential, never concurrent), and closes cleanly. */
class IpcConnection {
  private readonly socket: net.Socket;
  private readonly decoder = new IpcFrameDecoder();
  private pending: PendingIpcCall | undefined;
  private fatal: Error | undefined;
  /**
   * `null` until this connection's own `initialize` call succeeds, then the
   * clientId the app assigned it - every call after that stamps this as
   * `sourceClientId` (see `OutgoingEnvelope.sourceClientId`'s own docs).
   * Set by `call()` itself reading its own outcome, so a caller never has
   * to remember to wire it through separately.
   */
  private clientId: string | null = null;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    this.socket.on("error", (error: Error) => this.handleFatal(error));
    this.socket.on("close", () => this.handleFatal(new Error("ipc socket closed")));
  }

  /** Opens a fresh connection, bounded by `connectTimeoutMs` - rejects (never hangs) on a connect error or timeout. */
  static open(socketPath: string, connectTimeoutMs: number): Promise<IpcConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(
          new Error(`connection to ${socketPath} did not complete within ${connectTimeoutMs}ms`)
        );
      }, connectTimeoutMs);
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new IpcConnection(socket));
      });
      socket.once("error", (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private handleData(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.decoder.push(chunk);
    } catch (error) {
      this.handleFatal(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const message of messages) this.dispatch(message);
  }

  /**
   * Matches an incoming frame against this connection's one outstanding
   * call - by `requestId`, per this file's header and `OutgoingEnvelope`'s
   * own docs. A live connection also receives frames that are never a
   * reply to anything this transport sent - a `broadcast` (e.g.
   * `thread-stream-following-changed`) or a `client-discovery-request` the
   * app addresses to every connected client. Neither carries a matching
   * `requestId`, so the identity check below already ignores them
   * correctly; this transport's short-lived, one-shot connection has no
   * need to answer a discovery request the way a persistent participant
   * would.
   */
  private dispatch(message: unknown): void {
    if (this.pending === undefined) return; // no outstanding call - nothing this transport sent could be replying, so this is silently ignored rather than treated as a fatal surprise
    if (!isRecord(message) || message.requestId !== this.pending.requestId) return; // not our reply - this transport's own sequence never has more than one outstanding call, but a stray or unrelated frame from the bus (a broadcast, a discovery request) is still handled gracefully rather than misfiled onto the wrong caller
    const pending = this.pending;
    this.pending = undefined;
    if (message.resultType === "success") {
      // `handledByClientId` is carried on the envelope itself, sibling to
      // `result` - `thread-owner-discovery`'s success reply is
      // `{..., handledByClientId: "<owner clientId>", result: {}}`. Read
      // unconditionally here (not just for that one method) since it
      // costs nothing when a reply omits it.
      const handledByClientId =
        isRecord(message) && typeof message.handledByClientId === "string"
          ? message.handledByClientId
          : undefined;
      pending.settle({ ok: true, result: message.result, handledByClientId });
      return;
    }
    // A non-success `resultType` is the app's own failure signal.
    // `thread-owner-discovery`'s own no-owner case is a bare top-level
    // `error` STRING equal to the literal sentinel
    // (`resultType:"error", error:"no-client-found"`) - not an object, not
    // nested in `result`. Checked first since it is the one confirmed
    // shape; every other shape below remains this transport's own
    // contingency, kept because a failure on some OTHER method could
    // still spell its message differently.
    const errorValue = isRecord(message) ? message.error : undefined;
    const resultValue = isRecord(message) ? message.result : undefined;
    const text =
      typeof errorValue === "string"
        ? errorValue
        : isRecord(resultValue) && typeof resultValue.message === "string"
          ? resultValue.message
          : isRecord(errorValue) && typeof errorValue.message === "string"
            ? errorValue.message
            : typeof message.result === "string"
              ? message.result
              : describeUnexpectedReply(message);
    pending.settle({ ok: false, message: text });
  }

  private handleFatal(error: Error): void {
    if (this.fatal !== undefined) return; // already reported once
    this.fatal = error;
    if (this.pending !== undefined) {
      const pending = this.pending;
      this.pending = undefined;
      pending.onFatal(error);
    }
  }

  /**
   * Sends one request and waits for its matching reply, bounded by
   * `timeoutMs`. Resolves with `{ok:false}` for a protocol-level `error`
   * reply (the app answered and refused) - only a connection-level failure
   * (a socket error, the socket closing, or the timeout elapsing with no
   * reply at all) rejects the returned promise.
   */
  call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    targetClientId?: string,
    version?: number
  ): Promise<IpcCallOutcome> {
    if (this.fatal !== undefined) return Promise.reject(this.fatal);
    const requestId = randomUUID();
    const envelope: OutgoingEnvelope = {
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      method,
      params,
      ...(targetClientId === undefined ? {} : { targetClientId }),
      ...(version === undefined ? {} : { version }),
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pending = undefined;
        reject(new Error(`"${method}" received no reply within ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending = {
        requestId,
        settle: (outcome: IpcCallOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // Self-assigns this connection's clientId the moment its OWN
          // `initialize` call succeeds, so every later call on the same
          // connection stamps the real `sourceClientId` without the caller
          // (`wake()`) having to remember to wire it through separately -
          // see `OutgoingEnvelope.sourceClientId`'s own docs.
          if (this.clientId === null && method === INITIALIZE_METHOD && outcome.ok) {
            const assigned = extractClientId(outcome.result);
            if (assigned !== undefined) this.clientId = assigned;
          }
          resolve(outcome);
        },
        onFatal: (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      };

      this.socket.write(encodeIpcFrame(envelope), (error) => {
        if (error !== undefined && error !== null && !settled) {
          settled = true;
          clearTimeout(timer);
          this.pending = undefined;
          reject(error);
        }
      });
    });
  }

  /** Closes the underlying socket. Idempotent - safe to call even after a fatal error already destroyed it. */
  close(): void {
    this.socket.destroy();
  }
}

// ---------------------------------------------------------------------------
// Reply interpretation - isolated from IpcConnection itself so each can be
// tested directly against synthetic reply values, with no real socket
// involved.
// ---------------------------------------------------------------------------

/** Extracts a usable `clientId` string from an `initialize` reply's `result`, or `undefined` if the shape is not what this transport expects - see this file's header on why `initialize`'s exact reply shape is a design assumption, not a measured fact. */
export function extractClientId(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const clientId = result.clientId;
  return typeof clientId === "string" && clientId.length > 0 ? clientId : undefined;
}

/**
 * The outcome of interpreting a successful `thread-owner-discovery` reply.
 *
 * A successful reply's owner id is the envelope-level `handledByClientId`
 * field (`IpcCallOutcome.handledByClientId`), with `result` itself empty
 * (`{}`). The no-owner case is decided BEFORE this function ever runs -
 * see `wake()`'s own call site, which checks `isNoClientFoundMessage` on a
 * non-`ok` outcome first: `resultType:"error"`, `error:"no-client-found"`
 * (a bare string). This function's only job is the success case: a
 * present, non-empty `handledByClientId` is a real owner; its absence on
 * an otherwise-successful reply is `malformed` rather than assumed to
 * mean "no owner", since a genuine no-owner reply is never a success in
 * the first place.
 */
export type OwnerDiscoveryOutcome =
  | { readonly kind: "found"; readonly ownerId: string }
  | { readonly kind: "no-owner" }
  | { readonly kind: "malformed"; readonly detail: string };

export function interpretOwnerDiscoveryResult(
  handledByClientId: string | undefined
): OwnerDiscoveryOutcome {
  if (handledByClientId === undefined || handledByClientId.length === 0) {
    return {
      kind: "malformed",
      detail: `a successful thread-owner-discovery reply carried no usable handledByClientId (got: ${describeUnexpectedReply(handledByClientId)})`,
    };
  }
  return { kind: "found", ownerId: handledByClientId };
}

/** True when a protocol-level error message (from either `thread-owner-discovery` or `thread-follower-start-turn`) is this app's own way of saying no window currently owns the target conversation, rather than some other, genuinely unexpected failure. */
export function isNoClientFoundMessage(message: string): boolean {
  return message.includes(NO_CLIENT_FOUND_SENTINEL);
}

/** The exact `thread-follower-start-turn` params shape, measured verbatim - see this file's header. `payload` becomes the single text element of the started turn's input. */
export function buildStartTurnParams(
  conversationId: string,
  payload: string
): Record<string, unknown> {
  return {
    conversationId,
    turnStartParams: {
      input: [{ type: "text", text: payload, text_elements: [] }],
      model: null,
      effort: null,
      serviceTier: null,
      collaborationMode: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Socket ownership check - split out as a pure function of a stat-like
// value so it can be unit-tested against a synthetic uid/type without
// needing root privileges to actually chown a real socket to another user.
// ---------------------------------------------------------------------------

/** The minimal shape this transport actually reads off a real `fs.Stats` - kept narrow so a test can supply a plain object instead of a real filesystem entry. */
export interface SocketStatLike {
  isSocket(): boolean;
  readonly uid: number;
}

export type SocketOwnershipCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Evaluates whether `stat` describes a socket this transport may safely talk to: it must actually be a socket (not a plain file, directory, or anything else left at that path), and it must be owned by `currentUid` - see this file's header ("Authorization model") for why same-uid ownership is this transport's entire trust boundary. */
export function evaluateSocketOwnership(
  stat: SocketStatLike,
  currentUid: number
): SocketOwnershipCheck {
  if (!stat.isSocket()) {
    return { ok: false, reason: "path exists but is not a unix domain socket" };
  }
  if (stat.uid !== currentUid) {
    return {
      ok: false,
      reason: `socket is owned by uid ${stat.uid}, not this process's own uid ${currentUid} - refusing to talk to a socket this process does not own`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The transport itself
// ---------------------------------------------------------------------------

export interface DesktopIpcTransportOptions {
  /** Overrides `DEFAULT_SOCKET_PATH` - exists so tests can point this transport at a fake socket, never used in production. */
  readonly socketPath?: string;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

/**
 * The concrete `WakeTransport` implementation described in this file's
 * header. See that header for the full design, the owner-gate handling,
 * and exactly what is measured versus assumed.
 */
export class DesktopIpcWakeTransport implements WakeTransport {
  readonly name = TRANSPORT_NAME;
  private readonly socketPath: string;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: DesktopIpcTransportOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Checks, in the order this file's header promises, whether this
   * transport can currently reach the desktop app at all: the socket path
   * exists, it is actually a socket, it is owned by this process's own
   * uid, and it actually answers a real `initialize` call. Every step
   * fails soft with a specific, named reason - never a thrown exception,
   * never a bare `false` with no explanation.
   */
  async probe(): Promise<Capability> {
    const probedAt = new Date().toISOString();

    if (typeof process.getuid !== "function") {
      return {
        available: false,
        reason:
          "this transport requires POSIX unix-domain-socket ownership checks (process.getuid is unavailable on this platform)",
        probedAt,
      };
    }

    let stat: { isSocket(): boolean; uid: number };
    try {
      stat = statSync(this.socketPath);
    } catch (error) {
      return {
        available: false,
        reason: `socket path does not exist or is inaccessible: ${this.socketPath} (${describeError(error)})`,
        probedAt,
      };
    }

    const ownership = evaluateSocketOwnership(stat, process.getuid());
    if (!ownership.ok) {
      return { available: false, reason: `${this.socketPath}: ${ownership.reason}`, probedAt };
    }

    let connection: IpcConnection;
    try {
      connection = await IpcConnection.open(this.socketPath, this.connectTimeoutMs);
    } catch (error) {
      return {
        available: false,
        reason: `could not connect to ${this.socketPath}: ${describeError(error)}`,
        probedAt,
      };
    }

    try {
      const outcome = await connection.call(
        INITIALIZE_METHOD,
        { clientType: GHANTIKA_CLIENT_TYPE },
        this.requestTimeoutMs
      );
      if (!outcome.ok) {
        return {
          available: false,
          reason: `initialize was rejected: ${outcome.message}`,
          probedAt,
        };
      }
      if (extractClientId(outcome.result) === undefined) {
        return {
          available: false,
          reason: `initialize replied without a usable clientId - this app's IPC shape may have changed since this transport was built (reply: ${describeUnexpectedReply(outcome.result)})`,
          probedAt,
        };
      }
      return { available: true, probedAt };
    } catch (error) {
      return {
        available: false,
        reason: `initialize handshake failed: ${describeError(error)}`,
        probedAt,
      };
    } finally {
      connection.close();
    }
  }

  /**
   * Attempts to wake `target` (a Codex `conversationId`) with `payload` as
   * the started turn's input text. Runs the full three-call sequence
   * exactly once - see this file's header for why the owner gate is
   * honored rather than routed around, and why nothing here ever retries
   * internally. Never throws: every failure path returns a `WakeResult`
   * with a stated `detail`.
   */
  async wake(target: WakeTarget, payload: string): Promise<WakeResult> {
    let connection: IpcConnection;
    try {
      connection = await IpcConnection.open(this.socketPath, this.connectTimeoutMs);
    } catch (error) {
      return this.unavailable(`could not connect to ${this.socketPath}: ${describeError(error)}`);
    }

    try {
      const initOutcome = await connection.call(
        INITIALIZE_METHOD,
        { clientType: GHANTIKA_CLIENT_TYPE },
        this.requestTimeoutMs
      );
      if (!initOutcome.ok)
        return this.unavailable(`initialize was rejected: ${initOutcome.message}`);
      const clientId = extractClientId(initOutcome.result);
      if (clientId === undefined) {
        return this.unavailable(
          `initialize replied without a usable clientId (reply: ${describeUnexpectedReply(initOutcome.result)})`
        );
      }

      const discoveryOutcome = await connection.call(
        THREAD_OWNER_DISCOVERY_METHOD,
        // hostId is the fixed literal string "local", never the calling
        // client's own clientId - see this file's header.
        { hostId: "local", conversationId: target },
        this.requestTimeoutMs,
        undefined,
        THREAD_OWNER_DISCOVERY_VERSION
      );
      if (!discoveryOutcome.ok) {
        if (isNoClientFoundMessage(discoveryOutcome.message)) return this.refusedNoOwner(target);
        return this.unavailable(`thread-owner-discovery was rejected: ${discoveryOutcome.message}`);
      }
      const interpreted = interpretOwnerDiscoveryResult(discoveryOutcome.handledByClientId);
      if (interpreted.kind === "no-owner") return this.refusedNoOwner(target);
      if (interpreted.kind === "malformed") {
        return this.unavailable(
          `thread-owner-discovery replied with an unexpected shape: ${interpreted.detail}`
        );
      }

      const startTurnOutcome = await connection.call(
        THREAD_FOLLOWER_START_TURN_METHOD,
        buildStartTurnParams(target, payload),
        this.requestTimeoutMs,
        interpreted.ownerId
      );
      if (!startTurnOutcome.ok) {
        // A race between discovery and delivery - the owning window closed
        // in between - is the SAME disclosed boundary as the up-front
        // no-owner case (see this file's header), never a reason to treat
        // this transport itself as broken.
        if (isNoClientFoundMessage(startTurnOutcome.message)) return this.refusedNoOwner(target);
        return this.unavailable(
          `thread-follower-start-turn was rejected: ${startTurnOutcome.message}`
        );
      }

      return {
        outcome: "delivered",
        detail: `delivered to conversation ${target} via owning client ${interpreted.ownerId}`,
        transportName: this.name,
      };
    } catch (error) {
      return this.unavailable(`ipc exchange failed: ${describeError(error)}`);
    } finally {
      connection.close();
    }
  }

  private refusedNoOwner(target: WakeTarget): WakeResult {
    return {
      outcome: "refused",
      detail: `no client currently has conversation ${target} open (${NO_CLIENT_FOUND_SENTINEL}) - it must be open in a live ChatGPT desktop window for this transport to reach it`,
      transportName: this.name,
    };
  }

  private unavailable(detail: string): WakeResult {
    const outcome: WakeOutcome = "unavailable";
    return { outcome, detail, transportName: this.name };
  }
}
