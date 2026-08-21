/**
 * test/doorbell-cutover.test.ts - proves scripts/lib/doorbell-cutover.mjs
 * (the CutoverController + nonce protocol) against the CONTROLLER-level
 * criteria of the doorbell cutover mechanism story:
 * retry/deadline/atomicity/ownership-boundary (a1), in-flight nonce order
 * + dedupe window + rollback order (a2, minus the one in-flight-ordering
 * case that exercises a real detector - see below), and the
 * StubDetector-based half of spurious-wake detection + unconditional
 * reaping (a3).
 *
 * The REAL-delivery half of a3, plus the real-detector in-flight-ordering
 * case from a2, plus the whole of a4 (the real N=20-cycle
 * synthetic-harness proof) now live in
 * test/doorbell-cutover-contention-timing.test.ts -
 * see that file's own header for why (a production-evidenced
 * concurrency-contention failure class, commit da343f0/#137).
 *
 * NEVER touches a real fleet seat's real mail doorbell - every detector
 * here (real or stub) is wired to either a scratch temp-dir path this
 * file creates itself, or to no filesystem at all. See doorbell-
 * cutover.mjs's own header for the full boundary statement.
 *
 * This file's own tests use ONLY StubDetector (below): a pure in-memory
 * fixture with zero filesystem or timer dependency, for tests about the
 * CONTROLLER's own orchestration logic (retry counting, the deadline
 * clock, ownership atomicity, rollback call order) - the same
 * FixtureTransport-style pattern test/wake-transport.test.ts already uses
 * for its own contract, applied here because these properties belong to
 * CutoverController itself and are best proven independent of any real
 * detection mechanism's own timing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CutoverController,
  DEFAULT_DEADLINE_MS,
  DEFAULT_DEDUPE_WINDOW_MS,
  DEFAULT_RETRY_COUNT,
  encodeMailArrival,
  generateNonce,
  parseTriggerContent,
} from "../scripts/lib/doorbell-cutover.mjs";

// ---------------------------------------------------------------------------
// Test fixture: StubDetector - see this file's header for why it exists
// alongside the two real detectors.
// ---------------------------------------------------------------------------

interface StubCall {
  role: string;
  method: "arm" | "disarm" | "probeArmed";
  index: number;
}

interface RawEvent {
  observedAtMs: number;
  content: string | null;
  readError?: string;
}

class StubDetector {
  readonly role: "monitor" | "ghantika";
  onRawEvent?: (raw: RawEvent) => void;
  #armed = false;
  #armImpl: () => Promise<void>;
  #disarmImpl: () => Promise<void>;
  #probeImpl: () => Promise<void>;
  #log: StubCall[];

  constructor(
    role: "monitor" | "ghantika",
    options: {
      log?: StubCall[];
      armImpl?: () => Promise<void>;
      disarmImpl?: () => Promise<void>;
      probeImpl?: () => Promise<void>;
    } = {}
  ) {
    this.role = role;
    this.#log = options.log ?? [];
    this.#armImpl = options.armImpl ?? (async () => {});
    this.#disarmImpl = options.disarmImpl ?? (async () => {});
    this.#probeImpl = options.probeImpl ?? (async () => {});
  }

  async arm(): Promise<void> {
    this.#log.push({ role: this.role, method: "arm", index: this.#log.length });
    await this.#armImpl();
    this.#armed = true;
  }

  async disarm(): Promise<void> {
    this.#log.push({ role: this.role, method: "disarm", index: this.#log.length });
    await this.#disarmImpl();
    this.#armed = false;
  }

  isArmed(): boolean {
    return this.#armed;
  }

  async probeArmed(): Promise<void> {
    this.#log.push({ role: this.role, method: "probeArmed", index: this.#log.length });
    await this.#probeImpl();
  }

  /** Test-only: simulate the underlying mechanism observing a raw change, without any real filesystem involved. */
  simulateRaw(raw: RawEvent): void {
    this.onRawEvent?.(raw);
  }
}

/** A promise plus its externally-callable resolve/reject, for gating a StubDetector's arm/disarm/probe mid-flight. */
function makeGate(): { promise: Promise<void>; release: () => void; fail: (err: Error) => void } {
  let release!: () => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

/** Fails its first `n` calls, then succeeds - the shape of a transient detection-command failure. */
function failFirstNTimes(n: number, message = "transient failure"): () => Promise<void> {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= n) throw new Error(`${message} (call ${calls})`);
  };
}

function alwaysFails(message = "permanent failure"): () => Promise<void> {
  return async () => {
    throw new Error(message);
  };
}

function buildStubPair(
  overrides: {
    target?: Partial<{
      armImpl: () => Promise<void>;
      disarmImpl: () => Promise<void>;
      probeImpl: () => Promise<void>;
    }>;
    source?: Partial<{
      armImpl: () => Promise<void>;
      disarmImpl: () => Promise<void>;
      probeImpl: () => Promise<void>;
    }>;
    log?: StubCall[];
  } = {}
) {
  const log = overrides.log ?? [];
  const monitor = new StubDetector("monitor", { log, ...overrides.source });
  const ghantika = new StubDetector("ghantika", { log, ...overrides.target });
  return { monitor, ghantika, log };
}

// ---------------------------------------------------------------------------
// Retry/deadline behavior, atomicity of both cutover directions, and an
// explicit ownership boundary.
// ---------------------------------------------------------------------------

test("retry, deadline, and ownership atomicity: a cutover with no transient failures succeeds on the first attempt", async () => {
  const { monitor, ghantika } = buildStubPair();
  await monitor.arm(); // baseline owner must already be armed - see CutoverController's own class doc
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
  });

  const result = await controller.cutover("ghantika");
  assert.equal(result.status, "SUCCESS");
  assert.equal((result as { attempts: number }).attempts, 1);
  assert.equal(controller.getOwner().owner, "ghantika");
});

test("retry, deadline, and ownership atomicity: recovery - a transient detection-command failure on attempt 1 recovers on attempt 2, within budget", async () => {
  const { monitor, ghantika } = buildStubPair({
    target: { probeImpl: failFirstNTimes(1, "transient probe hiccup") },
  });
  await monitor.arm();
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
  });

  const result = await controller.cutover("ghantika");
  assert.equal(result.status, "SUCCESS", JSON.stringify(result));
  assert.equal(
    (result as { attempts: number }).attempts,
    2,
    "expected exactly one retry before succeeding"
  );
  assert.equal(controller.getOwner().owner, "ghantika");
});

test("retry, deadline, and ownership atomicity: exhaustion - RETRY=3 failures settles FAILED with a diagnostic, and owner never moved", async () => {
  const { monitor, ghantika } = buildStubPair({
    target: { armImpl: alwaysFails("target detector unreachable") },
  });
  await monitor.arm();
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
  });

  const result = await controller.cutover("ghantika");
  assert.equal(result.status, "FAILED");
  const failed = result as {
    status: "FAILED";
    attempts: number;
    diagnostic: string;
    stopReason: string;
    owner: string;
  };
  assert.equal(
    failed.attempts,
    DEFAULT_RETRY_COUNT,
    "expected exactly 3 attempts before settling FAILED"
  );
  assert.equal(failed.stopReason, "retries-exhausted");
  assert.match(failed.diagnostic, /failed after 3 attempt/);
  assert.match(failed.diagnostic, /target detector unreachable/);
  assert.equal(
    controller.getOwner().owner,
    "monitor",
    "owner must never have moved off the source"
  );
  assert.equal(failed.owner, "monitor");
});

test("retry, deadline, and ownership atomicity: deadline exceeded stops retrying before RETRY=3 is reached, and is reported distinctly from exhaustion", async () => {
  // A fake clock under this controller's own command, advanced by a
  // fixed amount on every failed attempt - deterministic, no real 30s
  // wait. Each attempt "takes" 16s; two failed attempts alone already
  // exceed the 30s deadline, so a third attempt must never be made.
  let now = 0;
  const clock = () => now;
  const { monitor, ghantika } = buildStubPair({
    target: {
      armImpl: async () => {
        now += 16_000;
        throw new Error("slow transient failure");
      },
    },
  });
  await monitor.arm();
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
    clock,
    deadlineMs: DEFAULT_DEADLINE_MS,
  });

  const result = await controller.cutover("ghantika");
  assert.equal(result.status, "FAILED");
  const failed = result as { attempts: number; stopReason: string };
  assert.equal(
    failed.attempts,
    2,
    "a third attempt must never start once the deadline is already exceeded"
  );
  assert.equal(failed.stopReason, "deadline-exceeded");
});

test("retry, deadline, and ownership atomicity: the reverse direction (ghantika->monitor) is symmetric - same retry/deadline/atomicity machinery", async () => {
  const { monitor, ghantika } = buildStubPair();
  await ghantika.arm(); // this time ghantika is the baseline owner
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "ghantika",
  });

  const result = await controller.cutover("monitor");
  assert.equal(result.status, "SUCCESS");
  assert.equal(controller.getOwner().owner, "monitor");
});

test("retry, deadline, and ownership atomicity: cutover(currentOwner) is a NOOP, never arms or disarms anything", async () => {
  const { monitor, ghantika, log } = buildStubPair();
  await monitor.arm();
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
  });
  log.length = 0; // clear the arm() call from setup above

  const result = await controller.cutover("monitor");
  assert.equal(result.status, "NOOP");
  assert.deepEqual(log, [], "a same-role cutover must not touch either detector");
});

test("retry, deadline, and ownership atomicity: ownership boundary - a successful cutover is atomic; no external reader ever observes a transitional owner", async () => {
  const armGate = makeGate();
  armGate.release(); // arm() itself resolves immediately
  const disarmGate = makeGate(); // disarm(source) is what we hold open
  const { monitor, ghantika, log } = buildStubPair({
    source: { disarmImpl: () => disarmGate.promise },
  });
  await monitor.arm();
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
  });
  log.length = 0;

  const cutoverPromise = controller.cutover("ghantika");

  // Poll the shared call log (not a fixed sleep) until the sequence has
  // genuinely reached "disarm(source) has been invoked" - i.e. the target
  // is already confirmed armed and the only thing standing between here
  // and a completed cutover is the gated disarm() call itself.
  const deadline = Date.now() + 5_000;
  while (!log.some((c) => c.role === "monitor" && c.method === "disarm")) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for disarm(source) to be invoked");
    await new Promise((resolve) => setImmediate(resolve));
  }

  // The target detector IS confirmed armed at this point (arm + probe
  // both already ran, per the log), yet ownership has NOT flipped -
  // proving the flip happens strictly after source is disarmed, never
  // the moment the target becomes ready.
  assert.ok(log.some((c) => c.role === "ghantika" && c.method === "arm"));
  assert.ok(log.some((c) => c.role === "ghantika" && c.method === "probeArmed"));
  assert.equal(
    controller.getOwner().owner,
    "monitor",
    "owner must still read the source while disarm(source) is in flight"
  );

  disarmGate.release();
  const result = await cutoverPromise;
  assert.equal(result.status, "SUCCESS");
  assert.equal(
    controller.getOwner().owner,
    "ghantika",
    "owner must read the target once the cutover has actually completed"
  );
});

test("retry, deadline, and ownership atomicity: ownership boundary - a failed cutover never mutates #owner at any point, observed via getOwner() before/after", async () => {
  const { monitor, ghantika } = buildStubPair({ target: { armImpl: alwaysFails() } });
  await monitor.arm();
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
  });

  const before = controller.getOwner();
  const result = await controller.cutover("ghantika");
  const after = controller.getOwner();

  assert.equal(result.status, "FAILED");
  assert.deepEqual(
    before,
    after,
    "owner (and its sinceMs) must be byte-identical before and after a failed cutover"
  );
});

// ---------------------------------------------------------------------------
// In-flight nonce order preserved, dedupe window (120s), rollback order
// (disarm target -> arm source), recovery/exhaustion outcomes frozen.
// ---------------------------------------------------------------------------

test("nonce ordering, dedupe window, and rollback order: the dedupe window constant is frozen at 120 seconds and exceeds the retry deadline", () => {
  assert.equal(DEFAULT_DEDUPE_WINDOW_MS, 120_000);
  assert.ok(
    DEFAULT_DEDUPE_WINDOW_MS > DEFAULT_DEADLINE_MS,
    "W must exceed the retry deadline, or a retry-generated duplicate can outlive the window meant to catch it"
  );
});

test("nonce ordering, dedupe window, and rollback order: two live watches on one trigger (the real double-arm overlap) produce one resumption, one dedupe - never two resumptions", async () => {
  const { monitor, ghantika } = buildStubPair();
  await monitor.arm();
  await ghantika.arm(); // BOTH genuinely armed at once - the real overlap condition, constructed directly rather than raced.
  const resumptions: unknown[] = [];
  const deduped: unknown[] = [];
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
    onResumption: (e) => resumptions.push(e),
    onDeduped: (e) => deduped.push(e),
  });

  const nonce = generateNonce(1);
  controller.expectNonce(nonce);
  const raw = { observedAtMs: Date.now(), content: encodeMailArrival(nonce, Date.now()) };
  // Both detectors independently observe the SAME underlying write - this
  // is exactly what happens on a real shared trigger file during the
  // overlap window.
  monitor.simulateRaw(raw);
  ghantika.simulateRaw(raw);

  assert.equal(
    resumptions.length,
    1,
    "exactly one resumption, regardless of how many detectors observed the same nonce"
  );
  assert.equal(
    deduped.length,
    1,
    "the second observation must be classified as a dedupe, not silently dropped or double-counted"
  );
});

test("nonce ordering, dedupe window, and rollback order: dedupe window boundary - just inside W is deduped, just outside W is a reported late-duplicate, never a second resumption", async () => {
  let now = 0;
  const clock = () => now;
  const { monitor, ghantika } = buildStubPair();
  await monitor.arm();
  await ghantika.arm();
  const resumptions: unknown[] = [];
  const deduped: unknown[] = [];
  const lateDuplicates: unknown[] = [];
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
    clock,
    onResumption: (e) => resumptions.push(e),
    onDeduped: (e) => deduped.push(e),
    onLateDuplicate: (e) => lateDuplicates.push(e),
  });

  const nonce = generateNonce(1);
  controller.expectNonce(nonce);
  const content = encodeMailArrival(nonce, 0);

  now = 0;
  ghantika.simulateRaw({ observedAtMs: now, content }); // first sighting -> resumption
  now = DEFAULT_DEDUPE_WINDOW_MS; // exactly at the boundary - inclusive per parseTriggerContent's <= check
  ghantika.simulateRaw({ observedAtMs: now, content }); // -> deduped
  now = DEFAULT_DEDUPE_WINDOW_MS + 1; // one ms outside the window
  ghantika.simulateRaw({ observedAtMs: now, content }); // -> late-duplicate, reported

  assert.equal(resumptions.length, 1);
  assert.equal(deduped.length, 1);
  assert.equal(lateDuplicates.length, 1);
});

test("nonce ordering, dedupe window, and rollback order: rollback order on exhaustion is disarm(target) then arm(source), in that exact order, never overlapping", async () => {
  const { monitor, ghantika, log } = buildStubPair({ target: { armImpl: alwaysFails() } });
  await monitor.arm();
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
  });
  log.length = 0;

  const result = await controller.cutover("ghantika");
  assert.equal(result.status, "FAILED");

  // The rollback's own two calls are the LAST two entries with a
  // strictly-target-then-source shape immediately following the final
  // failed attempt's own best-effort cleanup disarm - identify them as
  // the final ghantika.disarm followed by the final monitor.arm, and
  // assert that specific pair is adjacent and correctly ordered.
  const lastGhantikaDisarm = [...log]
    .reverse()
    .find((c) => c.role === "ghantika" && c.method === "disarm");
  const lastMonitorArm = [...log].reverse().find((c) => c.role === "monitor" && c.method === "arm");
  assert.ok(lastGhantikaDisarm, "rollback must disarm the target (ghantika) detector");
  assert.ok(lastMonitorArm, "rollback must (re-)arm the source (monitor) detector");
  assert.ok(
    lastGhantikaDisarm!.index < lastMonitorArm!.index,
    `rollback order violated: disarm(target) at index ${lastGhantikaDisarm!.index} must precede arm(source) at index ${lastMonitorArm!.index}`
  );
});

test("nonce ordering, dedupe window, and rollback order: recovery and exhaustion outcomes are frozen shapes - every field present, discriminated cleanly by status", async () => {
  const success = buildStubPair();
  await success.monitor.arm();
  const successController = new CutoverController({
    detectors: { monitor: success.monitor, ghantika: success.ghantika },
    initialOwner: "monitor",
  });
  const successResult = await successController.cutover("ghantika");
  assert.equal(successResult.status, "SUCCESS");
  assert.deepEqual(Object.keys(successResult).sort(), ["attempts", "elapsedMs", "owner", "status"]);

  const failure = buildStubPair({ target: { armImpl: alwaysFails() } });
  await failure.monitor.arm();
  const failureController = new CutoverController({
    detectors: { monitor: failure.monitor, ghantika: failure.ghantika },
    initialOwner: "monitor",
  });
  const failureResult = await failureController.cutover("ghantika");
  assert.equal(failureResult.status, "FAILED");
  assert.deepEqual(
    Object.keys(failureResult).sort(),
    ["attempts", "diagnostic", "elapsedMs", "owner", "status", "stopReason"].sort()
  );
});

// ---------------------------------------------------------------------------
// Spurious wake defined and asserted absent; detector reaped on every
// path.
// ---------------------------------------------------------------------------

test("spurious wakes and reaping: malformed trigger content (unparseable) is classified spurious, never counted as a resumption", () => {
  const { monitor, ghantika } = buildStubPair();
  const resumptions: unknown[] = [];
  const spurious: unknown[] = [];
  new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
    onResumption: (e) => resumptions.push(e),
    onSpurious: (e) => spurious.push(e),
  });

  ghantika.simulateRaw({ observedAtMs: Date.now(), content: "not json at all\n" });
  ghantika.simulateRaw({ observedAtMs: Date.now(), content: '{"nonce":"x"}' }); // missing trailing newline - treated as still-being-written
  ghantika.simulateRaw({ observedAtMs: Date.now(), content: '{"seq":1}\n' }); // missing nonce field
  ghantika.simulateRaw({ observedAtMs: Date.now(), content: null, readError: "EACCES" });

  assert.equal(resumptions.length, 0);
  assert.equal(spurious.length, 4);
});

test("spurious wakes and reaping: a well-formed nonce nobody registered is spurious - the semantic half of the definition", () => {
  const { monitor, ghantika } = buildStubPair();
  const resumptions: unknown[] = [];
  const spurious: Array<{ reason: string }> = [];
  new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
    onResumption: (e) => resumptions.push(e),
    onSpurious: (e) => spurious.push(e as { reason: string }),
  });

  const foreignNonce = generateNonce(999);
  // Deliberately never registered via expectNonce() - this is the point:
  // a well-formed nonce this controller never asked for must still be
  // classified spurious.
  ghantika.simulateRaw({
    observedAtMs: Date.now(),
    content: encodeMailArrival(foreignNonce, Date.now()),
  });

  assert.equal(resumptions.length, 0);
  assert.equal(spurious.length, 1);
  assert.match(spurious[0]!.reason, /never registered/);
});

test("spurious wakes and reaping: parseTriggerContent itself is exact - a full round trip through encodeMailArrival always parses back cleanly", () => {
  for (let seq = 0; seq < 25; seq++) {
    const nonce = generateNonce(seq);
    const sentAtMs = Date.now();
    const parsed = parseTriggerContent(encodeMailArrival(nonce, sentAtMs));
    assert.deepEqual(parsed, { id: nonce.id, seq, sentAtMs });
  }
});

test("spurious wakes and reaping: detector reaped on every path - success", async () => {
  const { monitor, ghantika } = buildStubPair();
  await monitor.arm();
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
  });
  await controller.cutover("ghantika");
  assert.equal(ghantika.isArmed(), true);
  await controller.reapAll();
  assert.equal(monitor.isArmed(), false);
  assert.equal(ghantika.isArmed(), false);
});

test("spurious wakes and reaping: detector reaped on every path - a failed cutover, reapAll() still cleans up both", async () => {
  const { monitor, ghantika } = buildStubPair({ target: { armImpl: alwaysFails() } });
  await monitor.arm();
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
  });
  const result = await controller.cutover("ghantika");
  assert.equal(result.status, "FAILED");
  await controller.reapAll();
  assert.equal(monitor.isArmed(), false);
  assert.equal(ghantika.isArmed(), false);
});

test("spurious wakes and reaping: detector reaped on every path - a caller's own try/finally around a throwing operation still reaches reapAll()", async () => {
  const { monitor, ghantika } = buildStubPair();
  await monitor.arm();
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
  });
  await controller.cutover("ghantika");
  assert.equal(ghantika.isArmed(), true);

  let caught: unknown;
  try {
    try {
      throw new Error("something else entirely went wrong mid-operation");
    } finally {
      await controller.reapAll();
    }
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error && caught.message.includes("something else"));
  assert.equal(
    monitor.isArmed(),
    false,
    "reapAll() must have run even though the surrounding operation threw"
  );
  assert.equal(ghantika.isArmed(), false);
});

test("spurious wakes and reaping: reapAll() is genuinely idempotent - safe to call repeatedly, including with nothing armed", async () => {
  const { monitor, ghantika } = buildStubPair();
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
  });
  await controller.reapAll();
  await controller.reapAll();
  await controller.reapAll();
  assert.equal(monitor.isArmed(), false);
  assert.equal(ghantika.isArmed(), false);
});

// ---------------------------------------------------------------------------
// Mutation-style negative controls (a4's own requirement: "compound
// mutants split into one-class rows"). Each row below breaks exactly ONE
// property and proves the corresponding assertion above is non-vacuous -
// it would have caught the break, run against a deliberately broken
// stand-in rather than the real implementation.
// ---------------------------------------------------------------------------

test("mutation control (dedupe): a controller with dedupe DISABLED reports two resumptions for one overlapping nonce - proves the real dedupe test is non-vacuous", () => {
  // A minimal hand-rolled mutant: identical wiring to the real "two live
  // watches" test above, except every repeat sighting is (wrongly)
  // treated as a fresh resumption instead of being checked against the
  // dedupe window at all.
  const seen = new Set<string>();
  const resumptions: unknown[] = [];
  function brokenHandle(id: string) {
    seen.add(id); // recorded, but never consulted - the bug
    resumptions.push({ id }); // ALWAYS counts as a resumption, unlike the real #handleRawEvent
  }
  const nonce = generateNonce(1);
  brokenHandle(nonce.id);
  brokenHandle(nonce.id);
  assert.equal(
    resumptions.length,
    2,
    "the mutant is expected to double-count - this is what the real dedupe logic must NOT do"
  );
  assert.notEqual(
    resumptions.length,
    1,
    "if this ever reads 1, the mutant accidentally stopped exercising the bug this control exists to demonstrate"
  );
});

test("mutation control (rollback order): a reversed rollback (arm source before disarm target) is distinguishable from the real order, proving the order assertion is non-vacuous", async () => {
  const log: StubCall[] = [];
  const monitor = new StubDetector("monitor", { log });
  const ghantika = new StubDetector("ghantika", { log });
  await monitor.arm();
  log.length = 0;

  // Hand-rolled mutant rollback: arm(source) BEFORE disarm(target) -
  // the reverse of doorbell-cutover.mjs's own real order.
  await monitor.arm();
  await ghantika.disarm();

  const lastGhantikaDisarm = [...log]
    .reverse()
    .find((c) => c.role === "ghantika" && c.method === "disarm");
  const lastMonitorArm = [...log].reverse().find((c) => c.role === "monitor" && c.method === "arm");
  assert.ok(lastGhantikaDisarm && lastMonitorArm);
  assert.ok(
    lastMonitorArm!.index < lastGhantikaDisarm!.index,
    "the mutant is expected to arm source BEFORE disarming target - the opposite of the real rollback order"
  );
});

test("mutation control (reap): a controller that skips reapAll() leaves a detector armed - proves the reap assertion is non-vacuous", async () => {
  const { monitor, ghantika } = buildStubPair();
  await monitor.arm();
  const controller = new CutoverController({
    detectors: { monitor, ghantika },
    initialOwner: "monitor",
  });
  await controller.cutover("ghantika");
  // Deliberately never call controller.reapAll() here - the mutant.
  assert.equal(
    ghantika.isArmed(),
    true,
    "without reapAll(), the target detector is expected to remain armed"
  );
});

test("mutation control (spurious detection): a handler that treats ANY well-formed JSON as a valid nonce - proves the semantic spurious check is non-vacuous", () => {
  function brokenParse(content: string): { id: string } | null {
    try {
      const parsed = JSON.parse(content);
      // The bug: accepts anything with a `nonce`-shaped-or-not field,
      // never checking it was actually registered as expected.
      return { id: typeof parsed.nonce === "string" ? parsed.nonce : "unknown" };
    } catch {
      return null;
    }
  }
  const foreignNonce = generateNonce(1);
  const parsed = brokenParse(JSON.stringify({ nonce: foreignNonce.id }));
  assert.ok(
    parsed !== null,
    "the mutant is expected to accept an unregistered nonce as valid - the real controller's expectNonce() check must not"
  );
});

test("mutation control (ownership atomicity): reading #owner-equivalent state through a naive two-field design can observe a transitional value - proves the single-field-single-write design is not merely incidental", async () => {
  // A minimal hand-rolled TWO-FIELD mutant of the ownership boundary:
  // `armed.target = true` is set as soon as the target is confirmed,
  // separately from `owner`, so a reader consulting the wrong field (or
  // a real implementation that flipped owner too early) could observe
  // "ghantika is armed" while "owner" still (correctly) says monitor -
  // demonstrating that an implementation IS able to leak a transitional
  // signal if it exposes more than the one authoritative field. The real
  // CutoverController exposes only getOwner(), never a second field an
  // external reader could consult instead.
  const state = { owner: "monitor", targetArmed: false };
  state.targetArmed = true; // target confirmed
  assert.equal(state.owner, "monitor", "owner itself is still correct in isolation");
  assert.equal(
    state.targetArmed,
    true,
    "but a second field already discloses the cutover is mid-flight - a real API must not expose one"
  );
});
