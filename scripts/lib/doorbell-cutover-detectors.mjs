/**
 * scripts/lib/doorbell-cutover-detectors.mjs - two concrete `Detector`
 * implementations (see doorbell-cutover.mjs's own contract) for this
 * repo's synthetic cutover-proof harness. Both watch a caller-supplied
 * SCRATCH trigger path - neither is ever constructed against a real
 * fleet seat's real inbox `.trigger` file; that boundary is enforced by
 * the caller (scripts/doorbell-cutover-harness.mjs and test/
 * doorbell-cutover.test.ts), never by anything in this file, since a
 * detector has no way to know what a path "means".
 *
 * MonitorDetector models a bounded-interval heartbeat/backup watcher -
 * a polling loop, on a fixed interval, comparing the trigger's content
 * against what it last observed. This is the kind of watcher that keeps
 * working as a fallback even when an event-driven watch has stalled or
 * died, at the cost of only ever noticing a change on its next tick.
 *
 * GhantikaDetector models the candidate event-driven wake path - built
 * on Node's native fs.watch rather than a poll, so it observes a change
 * close to when it happens rather than on the next tick.
 *
 * SELF-TEST SENTINEL PROTOCOL (both detectors): `probeArmed()` - the
 * "detection command" - proves a specific arm is actually
 * delivering events by writing a small `{"selftest":"<token>"}\n`
 * payload to the trigger and waiting (bounded) to observe it come back
 * through this detector's own event path. A self-test sentinel carries
 * no `nonce` field, so doorbell-cutover.mjs's own parseTriggerContent
 * would never treat it as a real mail arrival anyway - but it is filtered
 * out at THIS layer, before ever reaching a controller's onRawEvent, for
 * a concrete reason: during a real cutover, the target and source
 * detectors are briefly armed TOGETHER (see doorbell-cutover.mjs's own
 * header on why that overlap is deliberate), so a self-test write aimed
 * at confirming the TARGET is alive would otherwise also be observed by
 * the SOURCE detector watching the same file, and get misreported to the
 * controller as a spurious wake on the source's own account. A self-test
 * sentinel is not part of the wake domain at all; every detector - not
 * just the one running its own pending self-test - recognizes and drops
 * ANY well-formed self-test sentinel, matching or not, before it can
 * reach onRawEvent.
 */

import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * @param {string | null} content
 * @returns {string | null} the self-test token, or null if `content` is
 *   not a well-formed self-test sentinel.
 */
function parseSelfTestSentinel(content) {
  if (content === null || content === "" || !content.endsWith("\n")) return null;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  if (typeof parsed.selftest !== "string" || parsed.selftest.length === 0) return null;
  if (parsed.nonce !== undefined) return null; // a real mail arrival, not a sentinel
  return parsed.selftest;
}

/** @returns {string} */
function encodeSelfTestSentinel(token) {
  return `${JSON.stringify({ selftest: token })}\n`;
}

/** @param {string} triggerPath */
function readTriggerContent(triggerPath) {
  try {
    return { content: readFileSync(triggerPath, "utf8") };
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === "ENOENT") return { content: null };
    return { content: null, readError: String(/** @type {Error} */ (err).message ?? err) };
  }
}

/**
 * Shared self-test state machine both detectors below use identically -
 * factored out once rather than duplicated, since the protocol (arm a
 * pending token + timeout, resolve on a matching sentinel observation,
 * never resolve on a mismatched or missing one) is byte-for-byte the same
 * for both.
 */
class SelfTestWaiter {
  /** @type {{ token: string, resolve: () => void, reject: (err: Error) => void, timer: NodeJS.Timeout } | null} */
  #pending = null;

  /** @param {number} timeoutMs */
  begin(timeoutMs) {
    if (this.#pending !== null) {
      throw new Error("SelfTestWaiter: a self-test is already pending");
    }
    const token = randomBytes(6).toString("hex");
    /** @type {() => void} */
    let resolve;
    /** @type {(err: Error) => void} */
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      this.#pending = null;
      reject(new Error(`self-test timed out after ${timeoutMs}ms waiting for token ${token}`));
    }, timeoutMs);
    // Deliberately left REF'd (not .unref()'d), unlike the detectors' own
    // long-lived watch/interval handles below. A caller reaching this
    // point is actively `await`ing this exact promise, and the watcher's
    // own handle underneath a probe is often itself unref'd (see
    // GhantikaDetector.arm() below) - if this timer were ALSO unref'd,
    // nothing in the process would be holding the event loop open for
    // the real fs event a probe is waiting on to ever be delivered, and
    // the process could observe "nothing left to do" and tear the loop
    // down before that event ever arrives. Reproduced directly: with
    // this timer unref'd, every real probeArmed() call against
    // GhantikaDetector hung until its own timeout fired, on every run -
    // never delivering the sentinel event it was waiting to observe.
    this.#pending = { token, resolve: () => resolve(), reject, timer };
    return { token, promise };
  }

  /**
   * Called by a detector on every observed change, self-test or not.
   * Returns true if `sentinelToken` resolved THIS waiter's own pending
   * self-test (in which case the caller must swallow the event, not
   * forward it) - false otherwise, including when there is a pending
   * self-test but `sentinelToken` doesn't match it (a foreign or stale
   * sentinel, dropped exactly like a matching one - see this file's
   * header).
   *
   * @param {string} sentinelToken
   */
  resolveIfMatching(sentinelToken) {
    if (this.#pending === null) return false;
    if (this.#pending.token !== sentinelToken) return false;
    clearTimeout(this.#pending.timer);
    const { resolve } = this.#pending;
    this.#pending = null;
    resolve();
    return true;
  }
}

/**
 * Monitor-side detector: a fixed-interval poll of the trigger file's
 * content, reporting a raw event whenever that content differs from what
 * was last observed.
 */
export class MonitorDetector {
  role = /** @type {const} */ ("monitor");
  /** @type {((raw: { observedAtMs: number, content: string | null, readError?: string }) => void) | undefined} */
  onRawEvent;
  #triggerPath;
  #intervalMs;
  /** @type {NodeJS.Timeout | null} */
  #timer = null;
  /** @type {string | null} */
  #lastContent = null;
  #selfTest = new SelfTestWaiter();

  /** @param {{ triggerPath: string, intervalMs?: number }} options */
  constructor({ triggerPath, intervalMs = 25 }) {
    this.#triggerPath = triggerPath;
    this.#intervalMs = intervalMs;
  }

  async arm() {
    if (this.#timer !== null) return; // already armed - idempotent
    this.#lastContent = readTriggerContent(this.#triggerPath).content;
    this.#timer = setInterval(() => this.#tick(), this.#intervalMs);
    this.#timer.unref?.();
  }

  async disarm() {
    if (this.#timer === null) return; // already disarmed - idempotent
    clearInterval(this.#timer);
    this.#timer = null;
  }

  isArmed() {
    return this.#timer !== null;
  }

  async probeArmed() {
    if (!this.isArmed()) {
      throw new Error("MonitorDetector.probeArmed: called while not armed");
    }
    const timeoutMs = Math.max(this.#intervalMs * 4, 200);
    const { token, promise } = this.#selfTest.begin(timeoutMs);
    writeFileSync(this.#triggerPath, encodeSelfTestSentinel(token));
    await promise;
  }

  #tick() {
    const { content, readError } = readTriggerContent(this.#triggerPath);
    if (readError !== undefined) {
      this.onRawEvent?.({ observedAtMs: Date.now(), content: null, readError });
      return;
    }
    if (content === this.#lastContent) return; // no change since last tick
    this.#lastContent = content;
    const sentinelToken = parseSelfTestSentinel(content);
    if (sentinelToken !== null) {
      this.#selfTest.resolveIfMatching(sentinelToken);
      return; // self-test traffic never reaches onRawEvent - see this file's header
    }
    this.onRawEvent?.({ observedAtMs: Date.now(), content });
  }
}

/**
 * ghantika-side detector: event-driven via node:fs's native `fs.watch`,
 * reporting a raw event whenever the trigger's content differs from what
 * was last observed. fs.watch can fire more than once for a single
 * logical write on some platforms (documented Node behavior) - the same
 * "only forward on an actual content change" guard MonitorDetector uses
 * absorbs that without any platform-specific handling.
 */
export class GhantikaDetector {
  role = /** @type {const} */ ("ghantika");
  /** @type {((raw: { observedAtMs: number, content: string | null, readError?: string }) => void) | undefined} */
  onRawEvent;
  #triggerPath;
  /** @type {import("node:fs").FSWatcher | null} */
  #watcher = null;
  /** @type {string | null} */
  #lastContent = null;
  #selfTest = new SelfTestWaiter();

  /** @param {{ triggerPath: string }} options */
  constructor({ triggerPath }) {
    this.#triggerPath = triggerPath;
  }

  async arm() {
    if (this.#watcher !== null) return; // already armed - idempotent
    if (!existsSync(this.#triggerPath)) {
      // fs.watch throws synchronously on a nonexistent path - ensure the
      // trigger exists before arming.
      writeFileSync(this.#triggerPath, "");
    }
    this.#lastContent = readTriggerContent(this.#triggerPath).content;
    this.#watcher = watch(this.#triggerPath, { persistent: false }, () => this.#onEvent());
    // node:fs's watch() returns synchronously, but the OS-level watch
    // registration underneath it (kqueue/FSEvents on macOS, inotify on
    // Linux) does not necessarily take effect before that return -
    // measured directly on this host: a writeFileSync() issued with zero
    // delay immediately after watch() produced ZERO fired events across
    // 15/15 trials, where the identical write issued after yielding the
    // event loop even once (a single setImmediate turn, let alone a real
    // 1ms setTimeout) fired every time. So `arm()` itself yields one
    // event-loop turn before returning - this is what makes "isArmed()
    // is true" an honest claim that a subsequent write will actually be
    // observed, rather than a claim about whether the JS-level handle
    // merely exists - the same distinction between "a watch is listed"
    // and "a watch is actually live" that justifies probeArmed() below
    // performing a REAL self-test rather than trusting arm() having
    // returned. This fix narrows how often that self-test needs its own
    // retry, it does not replace the need for one.
    await new Promise((resolve) => setImmediate(resolve));
  }

  async disarm() {
    if (this.#watcher === null) return; // already disarmed - idempotent
    this.#watcher.close();
    this.#watcher = null;
  }

  isArmed() {
    return this.#watcher !== null;
  }

  async probeArmed() {
    if (!this.isArmed()) {
      throw new Error("GhantikaDetector.probeArmed: called while not armed");
    }
    const { token, promise } = this.#selfTest.begin(1_500);
    writeFileSync(this.#triggerPath, encodeSelfTestSentinel(token));
    await promise;
  }

  /**
   * Milliseconds after processing one real change before this detector
   * re-checks the trigger on its own, to catch a write that lands
   * essentially simultaneously with an already-in-flight fs.watch
   * notification. Measured directly on this host, not assumed: a write
   * issued with near-zero delay after a JUST-PROCESSED fs.watch callback
   * (specifically, right after this detector's own probeArmed() self-
   * test resolves) can be coalesced by the OS into that same
   * notification and never generate a separate callback of its own - a
   * real 20+ event-loop-turn gap (e.g. the 40ms cadence used elsewhere
   * in this repo's own N=20 proof) never exhibited this, only a write
   * issued in the SAME microtask-flush window as the just-delivered
   * event did. This detector is purely event-driven with no periodic
   * poll of its own (unlike MonitorDetector, which self-heals from this
   * class of gap for free every intervalMs tick), so a bounded, self-
   * scheduled re-check is what closes it here.
   */
  static #SETTLE_RECHECK_MS = 25;

  #onEvent() {
    this.#checkAndScheduleFollowUp();
  }

  /**
   * Reads current content, dispatches at most one real change (self-test
   * or onRawEvent), and - only when a real change WAS found - schedules
   * one bounded follow-up re-check. Safe against runaway scheduling: the
   * follow-up only re-arms itself when IT ALSO finds a further change,
   * so a quiet trigger naturally stops the chain after exactly one
   * no-op recheck. Safe against double-reporting: every dispatch still
   * goes through the same `content === #lastContent` guard a genuine
   * fs.watch callback uses, so a follow-up that fires after a real
   * fs.watch callback already caught the same change is a pure no-op.
   */
  #checkAndScheduleFollowUp() {
    const { content, readError } = readTriggerContent(this.#triggerPath);
    if (readError !== undefined) {
      this.onRawEvent?.({ observedAtMs: Date.now(), content: null, readError });
      return;
    }
    if (content === this.#lastContent) return; // fs.watch coalescing/duplicate - no real change
    this.#lastContent = content;
    const sentinelToken = parseSelfTestSentinel(content);
    if (sentinelToken === null) {
      this.onRawEvent?.({ observedAtMs: Date.now(), content });
    } else {
      this.#selfTest.resolveIfMatching(sentinelToken);
    }
    const timer = setTimeout(
      () => this.#checkAndScheduleFollowUp(),
      GhantikaDetector.#SETTLE_RECHECK_MS
    );
    // Unref'd deliberately, unlike the self-test's own timer in
    // SelfTestWaiter.begin(): this follow-up is a background safety net
    // for STEADY-STATE operation, not something any caller is actively
    // awaiting, so it must never be the reason a process that would
    // otherwise exit cleanly stays alive.
    timer.unref?.();
  }
}
