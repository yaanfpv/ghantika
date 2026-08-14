/**
 * scripts/lib/doorbell-cutover.mjs - a nonce-correlated, ownership-tracked
 * handoff between two independent "detector" mechanisms that can each
 * observe a wake trigger (a file whose change means "something wants this
 * agent to resume"), plus the retry/deadline, dedupe, spurious-wake, and
 * reap machinery around that handoff.
 *
 * WHAT THIS MODULE IS NOT: it does not touch, arm, or disarm any real
 * fleet seat's real mail doorbell. It is a generic, reusable mechanism -
 * two detector objects satisfying the small interface documented below,
 * wired to whatever trigger PATH a caller supplies. `scripts/lib/
 * doorbell-cutover-detectors.mjs` provides two concrete detector
 * implementations built for this repo's own synthetic proof harness
 * (`scripts/doorbell-cutover-harness.mjs`) - they are always constructed
 * against a caller-supplied scratch path, never a real inbox.
 *
 * ROLES: "monitor" models a bounded-interval heartbeat/backup watcher -
 * the kind of watch that keeps working as a fallback even after an
 * event-driven watch has stalled or died; "ghantika" models the
 * candidate event-driven wake path this handoff is proving out. The
 * names are generic role labels the caller assigns detectors to -
 * nothing in this file hardcodes what either role's detector actually
 * does internally.
 *
 * OWNERSHIP BOUNDARY: exactly one role owns the trigger at any instant,
 * as far as any external reader of `getOwner()` can ever observe.
 * This is achieved by construction, not by a lock: the private `#owner`
 * field is written exactly once per successful cutover - at the single
 * synchronous statement immediately after the new owner's detector has
 * been confirmed armed and the old owner's detector has been disarmed -
 * and is never written at all on a failed attempt (rollback restores
 * detector arming state, but `#owner` was never touched, so there is
 * nothing to restore on that field). No caller can ever read a
 * "cutting-over" or otherwise transitional value.
 *
 * DOUBLE-ARM OVERLAP IS DELIBERATE, NOT A BUG: two live watches on one
 * trigger at once is a real, observed source of a duplicate wake, not a
 * hypothetical one. A successful cutover arms the TARGET and
 * confirms it before disarming the SOURCE - so for a real but bounded
 * window, both detectors are genuinely armed against the same trigger.
 * That is intentional: the alternative (disarm source first) opens a
 * window where NEITHER detector is watching, which is strictly worse
 * (a missed wake can never be recovered; a duplicate wake can always be
 * deduped). The dedupe window below is what makes that overlap safe.
 *
 * ROLLBACK ORDER is the opposite shape, and deliberately so: when a
 * cutover attempt is abandoned (retries exhausted or the deadline is
 * reached), the target detector is disarmed FIRST, and only then is the
 * source detector (re-)armed. There is no safety reason to overlap here -
 * the target has just proven itself unreliable (that is why we are
 * rolling back), so nothing is gained by leaving it watching a moment
 * longer, and `arm()` on an already-armed detector is required to be an
 * idempotent no-op (see the Detector contract below) precisely so this
 * "re-arm" step is always safe to call even when the source, per this
 * module's own success-path design, was never actually disarmed in the
 * first place.
 */

import { randomBytes } from "node:crypto";

/**
 * @typedef {"monitor" | "ghantika"} Role
 */

/**
 * The Detector contract every concrete detector (see
 * doorbell-cutover-detectors.mjs) implements. Duck-typed deliberately -
 * this module never imports a concrete detector class, so nothing here
 * can accidentally depend on fs.watch, a polling interval, or any other
 * implementation detail.
 *
 * Every method must be safe to call from a state that already satisfies
 * it: `arm()` on an already-armed detector, `disarm()` on an already-
 * disarmed one. Neither may throw merely because the desired state is
 * already the current one - `reapAll()` below, and the rollback path
 * above, both depend on that idempotence to stay simple and correct.
 *
 * @typedef {Object} Detector
 * @property {Role} role
 * @property {() => Promise<void>} arm - Establishes real, observable
 *   watching of the wake trigger. May throw (a real, not simulated,
 *   failure) - the caller (CutoverController) is what applies retry
 *   semantics on top of that, this method itself never retries.
 * @property {() => Promise<void>} disarm - Idempotent. Releases whatever
 *   real resource `arm()` acquired (a filesystem watch handle, a timer).
 *   Must be safe to call on a detector that was never armed, or is
 *   already disarmed.
 * @property {() => boolean} isArmed - A real, current observation of
 *   this detector's own internal state (e.g. "is my watch handle still
 *   open"), never a cached assumption.
 * @property {() => Promise<void>} probeArmed - The "detection command":
 *   a bounded, real self-test proving THIS SPECIFIC arm is actually
 *   delivering events (not merely that `arm()` returned without
 *   throwing). Must throw on failure or timeout - never return a boolean.
 *   Called only while `isArmed()` is true.
 * @property {((raw: { observedAtMs: number, content: string | null, readError?: string }) => void) | undefined} onRawEvent -
 *   A MUTABLE property, not a constructor argument: a detector is
 *   constructed before the controller that will coordinate it exists
 *   (the controller needs both detectors up front), so the controller's
 *   constructor is what assigns this property on each detector it is
 *   given. A detector implementation must read `this.onRawEvent` fresh
 *   at the moment it has something to report - never capture the value
 *   present at `arm()` time into a closure - so a controller assigning
 *   this after construction (the only order that is ever possible) still
 *   gets every event.
 */

/**
 * The classes of internal action the controller emits on every cutover
 * and every processed wake, given to the caller as `onCommand` - this is
 * the "c1-c6 (command)" event stream that must be counted separately
 * from `local_seat (resumption)` events (see CutoverController's own
 * `onResumption`). Six kinds, matching the six distinct actions this
 * module ever takes against a detector or its own bookkeeping:
 *
 *   c1-arm       a detector's arm() was invoked
 *   c2-disarm    a detector's disarm() was invoked
 *   c3-probe     a detector's probeArmed() (detection command) was invoked
 *   c4-retry     a cutover attempt beyond the first was started
 *   c5-rollback  a failed cutover's rollback sequence was started
 *   c6-reap      reapAll() unconditionally disarmed both detectors
 *
 * @typedef {"c1-arm" | "c2-disarm" | "c3-probe" | "c4-retry" | "c5-rollback" | "c6-reap"} CommandKind
 */

/** @typedef {{ kind: CommandKind, role: Role | "both", atMs: number, attempt?: number }} CommandEvent */

/**
 * A single mail-arrival nonce, as this module's own synthetic protocol
 * writes it into a trigger file's content (never the real fleet
 * doorbell's bare `touch` - see this file's header). `seq` is what lets a
 * test (or the harness) prove send-order was preserved through a
 * cutover, independent of `id`'s own randomness.
 *
 * @typedef {{ id: string, seq: number }} Nonce
 */

/**
 * Generates a fresh nonce: a monotonic sequence number (supplied by the
 * caller, never tracked internally here, so two independent generators
 * can never collide on `seq` by construction) plus 6 random bytes of
 * hex, so `id` is unique across every nonce this process ever mints
 * regardless of how fast `seq` repeats across independent callers.
 *
 * @param {number} seq
 * @returns {Nonce}
 */
export function generateNonce(seq) {
  return { id: `n${seq}-${randomBytes(6).toString("hex")}`, seq };
}

/**
 * Serializes a nonce into the exact bytes this module's synthetic
 * mail-arrival protocol writes to a trigger file. A trailing newline is
 * load-bearing the same way test/harness.ts's own `parsesAsPgid` cares
 * about one: it is what lets a reader (parseTriggerContent below) refuse
 * a value still mid-write rather than parsing a truncated JSON object as
 * if it were complete.
 *
 * @param {Nonce} nonce
 * @param {number} sentAtMs
 * @returns {string}
 */
export function encodeMailArrival(nonce, sentAtMs) {
  return `${JSON.stringify({ nonce: nonce.id, seq: nonce.seq, sentAtMs })}\n`;
}

/**
 * The inverse of encodeMailArrival - real parsing, not a regex guess.
 * Returns `null` for anything that is not a complete, well-formed mail
 * arrival: missing trailing newline (still being written), invalid JSON,
 * a missing/non-string `nonce` field, or a missing/non-number `seq`.
 * This is the SYNTACTIC half of what counts as a spurious wake - the
 * SEMANTIC half (a well-formed nonce nobody was expecting) is the
 * controller's own job below, since it needs the expected-nonce set this
 * function has no access to.
 *
 * @param {string | null} content
 * @returns {{ id: string, seq: number, sentAtMs: number | null } | null}
 */
export function parseTriggerContent(content) {
  if (content === null || content === "" || !content.endsWith("\n")) return null;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  if (typeof parsed.nonce !== "string" || parsed.nonce.length === 0) return null;
  if (typeof parsed.seq !== "number" || !Number.isFinite(parsed.seq)) return null;
  const sentAtMs = typeof parsed.sentAtMs === "number" ? parsed.sentAtMs : null;
  return { id: parsed.nonce, seq: parsed.seq, sentAtMs };
}

/** Default retry count for a cutover attempt. */
export const DEFAULT_RETRY_COUNT = 3;
/** Default wall-clock deadline, in milliseconds, for a whole cutover attempt. */
export const DEFAULT_DEADLINE_MS = 30_000;
/**
 * Default dedupe window, in milliseconds, frozen at 120s: must exceed
 * DEFAULT_DEADLINE_MS or a retry-generated duplicate can outlive the
 * window it is supposed to be caught by. 120_000 is 4x the 30_000ms
 * deadline above - a floor argument, not a measurement: if a real
 * duplicate is ever observed arriving later than this, the number moves
 * and the measurement wins, rather than the window being silently
 * widened to make an observed duplicate disappear.
 */
export const DEFAULT_DEDUPE_WINDOW_MS = 120_000;

/**
 * CutoverController - owns exactly one Role's worth of "who owns the
 * trigger", drives the arm/probe/disarm sequence for both directions of
 * cutover, classifies every raw wake a detector reports (resumption /
 * deduped / spurious / late-duplicate), and guarantees both detectors end
 * up disarmed on every path via `reapAll()`.
 *
 * `initialOwner` is a bookkeeping claim only - the constructor never
 * calls `arm()` on either detector. The caller is responsible for
 * arming `detectors[initialOwner]` itself before relying on this
 * controller to deliver anything, exactly as a real baseline mechanism
 * (Monitor's own heartbeat, in the real fleet) is already running before
 * any cutover machinery starts tracking it - `cutover()`'s own arm-
 * target-before-disarm-source sequence only ever arms the OTHER role's
 * detector, on the assumption that `initialOwner`'s is already live.
 */
export class CutoverController {
  /** @type {Role} */
  #owner;
  /** @type {number} */
  #ownerSinceMs;
  /** @type {Record<Role, Detector>} */
  #detectors;
  /** @type {number} */
  #retryCount;
  /** @type {number} */
  #deadlineMs;
  /** @type {number} */
  #dedupeWindowMs;
  /** @type {() => number} */
  #clock;
  /** @type {Set<string>} in-flight nonce ids this controller expects to see. */
  #expectedNonces = new Set();
  /** @type {Map<string, number>} nonce id -> the ms (per #clock) it was first RECEIVED. */
  #firstSeenAtMs = new Map();
  /** @type {Set<string>} nonce ids that have already produced one resumption - consulted for the late-duplicate classification once a nonce ages out of the dedupe window. */
  #consumed = new Set();
  #onResumption;
  #onDeduped;
  #onSpurious;
  #onLateDuplicate;
  #onCommand;

  /**
   * @param {Object} options
   * @param {Record<Role, Detector>} options.detectors
   * @param {Role} options.initialOwner
   * @param {number} [options.retryCount]
   * @param {number} [options.deadlineMs]
   * @param {number} [options.dedupeWindowMs]
   * @param {() => number} [options.clock] - injectable for deterministic tests; defaults to Date.now.
   * @param {(event: { nonce: Nonce, role: Role, observedAtMs: number }) => void} [options.onResumption]
   * @param {(event: { nonce: Nonce, role: Role, observedAtMs: number, firstSeenAtMs: number }) => void} [options.onDeduped]
   * @param {(event: { role: Role, observedAtMs: number, reason: string, raw: unknown }) => void} [options.onSpurious]
   * @param {(event: { nonce: Nonce, role: Role, observedAtMs: number, firstSeenAtMs: number }) => void} [options.onLateDuplicate]
   * @param {(event: CommandEvent) => void} [options.onCommand]
   */
  constructor({
    detectors,
    initialOwner,
    retryCount = DEFAULT_RETRY_COUNT,
    deadlineMs = DEFAULT_DEADLINE_MS,
    dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
    clock = Date.now,
    onResumption = () => {},
    onDeduped = () => {},
    onSpurious = () => {},
    onLateDuplicate = () => {},
    onCommand = () => {},
  }) {
    if (!detectors.monitor || !detectors.ghantika) {
      throw new Error("CutoverController requires both a monitor and a ghantika detector");
    }
    this.#detectors = detectors;
    this.#owner = initialOwner;
    this.#ownerSinceMs = clock();
    this.#retryCount = retryCount;
    this.#deadlineMs = deadlineMs;
    this.#dedupeWindowMs = dedupeWindowMs;
    this.#clock = clock;
    this.#onResumption = onResumption;
    this.#onDeduped = onDeduped;
    this.#onSpurious = onSpurious;
    this.#onLateDuplicate = onLateDuplicate;
    this.#onCommand = onCommand;

    for (const role of /** @type {Role[]} */ (["monitor", "ghantika"])) {
      this.#detectors[role].onRawEvent = (raw) => this.#handleRawEvent(role, raw);
    }
  }

  /** The confirmed owner - never a transitional value (see this file's header). */
  getOwner() {
    return { owner: this.#owner, sinceMs: this.#ownerSinceMs };
  }

  /**
   * Registers a nonce this controller should treat as a legitimate,
   * in-flight expectation - called by a caller (the harness, a test)
   * immediately before writing the corresponding mail-arrival bytes to
   * the trigger file, mirroring how a real sender would mint a nonce and
   * only then ring the doorbell. A wake carrying a nonce never registered
   * here is spurious by the SEMANTIC definition (see parseTriggerContent
   * for the syntactic one).
   *
   * @param {Nonce} nonce
   */
  expectNonce(nonce) {
    this.#expectedNonces.add(nonce.id);
  }

  /**
   * @param {Role} role
   * @param {{ observedAtMs: number, content: string | null, readError?: string }} raw
   */
  #handleRawEvent(role, raw) {
    if (raw.readError !== undefined || raw.content === null) {
      this.#onSpurious({
        role,
        observedAtMs: raw.observedAtMs,
        reason: raw.readError ?? "trigger content unreadable",
        raw,
      });
      return;
    }
    const parsed = parseTriggerContent(raw.content);
    if (parsed === null) {
      this.#onSpurious({
        role,
        observedAtMs: raw.observedAtMs,
        reason: "trigger content did not parse as a well-formed nonce",
        raw,
      });
      return;
    }
    if (!this.#expectedNonces.has(parsed.id)) {
      // Well-formed, but never registered by expectNonce() - the semantic
      // half of "spurious": something wrote a nonce-shaped payload this
      // controller never asked for.
      this.#onSpurious({
        role,
        observedAtMs: raw.observedAtMs,
        reason: `nonce ${parsed.id} was never registered as expected`,
        raw,
      });
      return;
    }

    const nonce = { id: parsed.id, seq: parsed.seq };
    const firstSeen = this.#firstSeenAtMs.get(parsed.id);
    const now = this.#clock();

    if (firstSeen === undefined) {
      // First time this controller has seen this nonce - a genuine
      // resumption.
      this.#firstSeenAtMs.set(parsed.id, now);
      this.#consumed.add(parsed.id);
      this.#onResumption({ nonce, role, observedAtMs: now });
      return;
    }

    const ageMs = now - firstSeen;
    if (ageMs <= this.#dedupeWindowMs) {
      this.#onDeduped({ nonce, role, observedAtMs: now, firstSeenAtMs: firstSeen });
      return;
    }
    // Outside the dedupe window: this must be REPORTED, never silently
    // folded into either a second resumption or a normal dedupe.
    this.#onLateDuplicate({ nonce, role, observedAtMs: now, firstSeenAtMs: firstSeen });
  }

  /**
   * @param {CommandKind} kind
   * @param {Role | "both"} role
   * @param {number} [attempt]
   */
  #emitCommand(kind, role, attempt) {
    this.#onCommand({ kind, role, atMs: this.#clock(), attempt });
  }

  /**
   * Attempts to move ownership of the trigger to `target`. Symmetric in
   * both directions - both cutover directions are equally atomic - the
   * same method drives Monitor->ghantika and ghantika->Monitor, since the
   * only thing that differs between them is which role is currently
   * `#owner`.
   *
   * Success path (target-armed-before-source-disarmed, tolerating the
   * real overlap - see this file's header): arm(target) -> probeArmed
   * (target) -> disarm(source) -> flip #owner. Any thrown error at either
   * of the first two steps counts as one failed attempt; the target is
   * best-effort disarmed before the next attempt so a retry always starts
   * from a clean slate rather than potentially compounding a partial arm.
   *
   * Retried up to `retryCount` times (default 3), bounded by `deadlineMs`
   * (default 30s) measured from the first attempt - whichever limit is
   * reached first stops retrying and settles the outcome as failed.
   *
   * On exhaustion: rollback (disarm target, then re-arm source - see
   * this file's header for why this is the opposite order from the
   * success path), and the outcome is returned as
   * `{ status: "FAILED", ... }` with a diagnostic. `#owner` is never
   * written on this path - it was never touched, so there is nothing to
   * restore on it; only detector arming state needed correcting.
   *
   * @param {Role} target
   * @returns {Promise<
   *   | { status: "NOOP", owner: Role }
   *   | { status: "SUCCESS", owner: Role, attempts: number, elapsedMs: number }
   *   | { status: "FAILED", owner: Role, attempts: number, elapsedMs: number, diagnostic: string, stopReason: "retries-exhausted" | "deadline-exceeded" }
   * >}
   */
  async cutover(target) {
    const source = this.#owner;
    if (source === target) {
      return { status: "NOOP", owner: this.#owner };
    }

    const startMs = this.#clock();
    let attempts = 0;
    /** @type {unknown} */
    let lastError;
    /** @type {"retries-exhausted" | "deadline-exceeded" | null} */
    let stopReason = null;

    for (let attempt = 1; attempt <= this.#retryCount; attempt++) {
      if (this.#clock() - startMs >= this.#deadlineMs) {
        stopReason = "deadline-exceeded";
        break;
      }
      attempts = attempt;
      if (attempt > 1) this.#emitCommand("c4-retry", target, attempt);

      try {
        this.#emitCommand("c1-arm", target, attempt);
        await this.#detectors[target].arm();
        this.#emitCommand("c3-probe", target, attempt);
        await this.#detectors[target].probeArmed();

        // Target confirmed. Now safe to give up the source.
        this.#emitCommand("c2-disarm", source, attempt);
        await this.#detectors[source].disarm();

        // The single synchronous write that makes ownership atomic - see
        // this file's header. Nothing between the two lines above and
        // this one can observe an intermediate state, because nothing
        // above this line has touched #owner at all.
        this.#owner = target;
        this.#ownerSinceMs = this.#clock();
        return {
          status: "SUCCESS",
          owner: this.#owner,
          attempts,
          elapsedMs: this.#clock() - startMs,
        };
      } catch (err) {
        lastError = err;
        try {
          await this.#detectors[target].disarm();
        } catch {
          // best-effort cleanup before the next attempt; a failure here
          // doesn't change the outcome of THIS attempt, which already failed.
        }
      }
    }
    // The loop can only fall through here (rather than returning or
    // `break`-ing into the deadline branch above) once `attempts` has
    // reached `retryCount` and the last attempt's own catch block ran -
    // so a null `stopReason` at this point unambiguously means retries,
    // not the deadline, are what stopped it.
    if (stopReason === null) stopReason = "retries-exhausted";

    // Exhausted (retries or deadline). Roll back: disarm target, then
    // re-arm source - the opposite of the success path above on
    // purpose (see this file's header).
    this.#emitCommand("c5-rollback", target, attempts);
    try {
      await this.#detectors[target].disarm();
    } catch {
      // best-effort - it is likely already disarmed from the last failed attempt.
    }
    try {
      await this.#detectors[source].arm();
    } catch (rearmError) {
      // The source failing to re-arm is a strictly worse outcome than the
      // original cutover failure (now NEITHER detector may be reliably
      // armed) - surfaced by folding it into the diagnostic rather than
      // swallowing it, but #owner still correctly reports `source`: it was
      // never moved, so "who owns the trigger" stays a true statement even
      // though the answer may not currently be well-watched.
      lastError = new AggregateError(
        [lastError, rearmError].filter(Boolean),
        "cutover failed AND rollback could not re-arm the source detector"
      );
    }

    const elapsedMs = this.#clock() - startMs;
    const lastErrorMessage =
      lastError === undefined
        ? "no attempt ran before the deadline was reached"
        : lastError instanceof Error
          ? lastError.message
          : String(lastError);
    const diagnostic = `cutover ${source}->${target} failed after ${attempts} attempt(s) in ${elapsedMs}ms (stopped: ${stopReason}): ${lastErrorMessage}`;
    return { status: "FAILED", owner: this.#owner, attempts, elapsedMs, diagnostic, stopReason };
  }

  /**
   * Unconditionally disarms BOTH detectors, regardless of #owner or
   * either detector's current state - every detector must be reaped on
   * every path. Safe to call any number of times, and safe to call
   * after a cutover has already succeeded, failed, or never run at all -
   * disarm() is required to be idempotent (see the Detector contract),
   * so this never throws merely because one or both detectors are
   * already disarmed.
   */
  async reapAll() {
    this.#emitCommand("c6-reap", "both");
    const results = await Promise.allSettled([
      this.#detectors.monitor.disarm(),
      this.#detectors.ghantika.disarm(),
    ]);
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((f) => /** @type {PromiseRejectedResult} */ (f).reason),
        "reapAll: one or more detectors failed to disarm"
      );
    }
  }
}
