import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TRANSPORTS,
  SELECTOR_TRANSPORT_NAME,
  selectAndWake,
} from "../dist/wake/selectTransport.js";
import type {
  Capability,
  WakeOutcome,
  WakeResult,
  WakeTarget,
  WakeTransport,
} from "../dist/wake/wakeTransport.js";
import { AppServerGoalWakeTransport } from "../dist/wake/appServerTransport.js";
import { DesktopIpcWakeTransport } from "../dist/wake/desktopIpcTransport.js";

// This file exercises `selectAndWake`'s own selection logic exclusively
// against lightweight fakes built here - never the real
// `AppServerGoalWakeTransport`/`DesktopIpcWakeTransport` classes, which
// need a real app-server process or a real IPC socket and already have
// their own dedicated test files (test/wake-app-server.test.ts,
// test/wake-desktop-ipc.test.ts). The one place the real classes appear
// below is the `DEFAULT_TRANSPORTS` shape test, which is specifically
// about what that constant is built from, not about driving either
// transport.

// --- a controllable fake WakeTransport, with call-order + call-count spying ---

/** Shared by every fake constructed in a single test, so probe()/wake() calls across MULTIPLE fakes can be checked for relative order, not just per-fake counts. */
function makeCallLog(): { log: string[]; record: (entry: string) => void } {
  const log: string[] = [];
  return { log, record: (entry: string) => log.push(entry) };
}

class FakeTransport implements WakeTransport {
  readonly name: string;
  #probeImpl: () => Promise<Capability>;
  #wakeImpl: (target: WakeTarget, payload: string) => Promise<WakeResult>;
  #recordCall: ((entry: string) => void) | undefined;
  #probeCalls = 0;
  #wakeCalls = 0;

  constructor(
    name: string,
    probeImpl: () => Promise<Capability>,
    wakeImpl: (target: WakeTarget, payload: string) => Promise<WakeResult>,
    recordCall?: (entry: string) => void
  ) {
    this.name = name;
    this.#probeImpl = probeImpl;
    this.#wakeImpl = wakeImpl;
    this.#recordCall = recordCall;
  }

  async probe(): Promise<Capability> {
    this.#probeCalls += 1;
    this.#recordCall?.(`${this.name}:probe`);
    return this.#probeImpl();
  }

  async wake(target: WakeTarget, payload: string): Promise<WakeResult> {
    this.#wakeCalls += 1;
    this.#recordCall?.(`${this.name}:wake`);
    return this.#wakeImpl(target, payload);
  }

  get probeCallCount(): number {
    return this.#probeCalls;
  }

  get wakeCallCount(): number {
    return this.#wakeCalls;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function available(): Promise<Capability> {
  return Promise.resolve({ available: true, probedAt: nowIso() });
}

function unavailableCapability(reason: string): () => Promise<Capability> {
  return () => Promise.resolve({ available: false, reason, probedAt: nowIso() });
}

function delivers(transportName: string, detail = "delivered"): () => Promise<WakeResult> {
  return () => Promise.resolve({ outcome: "delivered", detail, transportName });
}

function refuses(transportName: string, detail = "declined"): () => Promise<WakeResult> {
  return () => Promise.resolve({ outcome: "refused", detail, transportName });
}

function reportsUnavailable(transportName: string, detail = "raced"): () => Promise<WakeResult> {
  return () => Promise.resolve({ outcome: "unavailable", detail, transportName });
}

/** A wake() that never resolves cleanly - used for both the throw case and the promise-rejection case. */
function throwsSynchronously(message: string): () => Promise<WakeResult> {
  return () => {
    throw new Error(message);
  };
}

function rejectsAsync(message: string): () => Promise<WakeResult> {
  return () => Promise.reject(new Error(message));
}

/** wake() should never even be reached in a test asserting probe-unavailable skips it - this fails loudly if it is. */
function unreachableWake(): Promise<WakeResult> {
  throw new Error("wake() should never have been called for this transport");
}

// --- 1. first delivers, second never touched ---

test("first transport probes available and delivers - returns its exact WakeResult, second transport's probe/wake are never called", async () => {
  const first = new FakeTransport("first", available, delivers("first", "hello first"));
  const second = new FakeTransport("second", available, unreachableWake);

  const result = await selectAndWake([first, second], "thread-1", "resume");

  assert.deepEqual(result, { outcome: "delivered", detail: "hello first", transportName: "first" });
  assert.equal(first.probeCallCount, 1);
  assert.equal(first.wakeCallCount, 1);
  assert.equal(second.probeCallCount, 0);
  assert.equal(second.wakeCallCount, 0);
});

// --- 2. first probe-unavailable, second delivers; first's wake() never called ---

test("first transport probes unavailable - second transport is tried and delivers; first transport's wake() is never called", async () => {
  const first = new FakeTransport(
    "first",
    unavailableCapability("not on this host"),
    unreachableWake
  );
  const second = new FakeTransport("second", available, delivers("second"));

  const result = await selectAndWake([first, second], "thread-1", "resume");

  assert.equal(result.outcome, "delivered");
  assert.equal(result.transportName, "second");
  assert.equal(first.probeCallCount, 1);
  assert.equal(first.wakeCallCount, 0);
  assert.equal(second.probeCallCount, 1);
  assert.equal(second.wakeCallCount, 1);
});

// --- 3. first probes available but wake() refuses -> falls through to second ---

test("first transport probes available but wake() returns refused - falls through to second transport, which delivers", async () => {
  const first = new FakeTransport("first", available, refuses("first", "owner gate closed"));
  const second = new FakeTransport("second", available, delivers("second"));

  const result = await selectAndWake([first, second], "thread-1", "resume");

  assert.equal(result.outcome, "delivered");
  assert.equal(result.transportName, "second");
  assert.equal(first.wakeCallCount, 1);
  assert.equal(second.wakeCallCount, 1);
});

// --- 4. first's wake() itself reports unavailable (probe/wake race) -> falls through ---

test("first transport's wake() returns unavailable (a race between probe and wake) - falls through to the next transport", async () => {
  const first = new FakeTransport(
    "first",
    available,
    reportsUnavailable("first", "process exited mid-call")
  );
  const second = new FakeTransport("second", available, delivers("second"));

  const result = await selectAndWake([first, second], "thread-1", "resume");

  assert.equal(result.outcome, "delivered");
  assert.equal(result.transportName, "second");
});

// --- 5. all transports probe-unavailable -> aggregate unavailable, zero wake() calls anywhere, detail names every transport ---

test("all transports probe unavailable - selector returns non-delivered with a detail naming every transport and its reason; zero wake() calls anywhere", async () => {
  const first = new FakeTransport(
    "first",
    unavailableCapability("no app-server running"),
    unreachableWake
  );
  const second = new FakeTransport(
    "second",
    unavailableCapability("no socket present"),
    unreachableWake
  );

  const result = await selectAndWake([first, second], "thread-1", "resume");

  assert.notEqual(result.outcome, "delivered");
  assert.equal(result.outcome, "unavailable");
  assert.equal(first.wakeCallCount, 0);
  assert.equal(second.wakeCallCount, 0);
  assert.ok(result.detail?.includes("first"), `detail should name "first": ${result.detail}`);
  assert.ok(
    result.detail?.includes("no app-server running"),
    `detail should include first's reason: ${result.detail}`
  );
  assert.ok(result.detail?.includes("second"), `detail should name "second": ${result.detail}`);
  assert.ok(
    result.detail?.includes("no socket present"),
    `detail should include second's reason: ${result.detail}`
  );
  // Order matters: the detail should read as first, then second.
  assert.ok((result.detail?.indexOf("first") ?? -1) < (result.detail?.indexOf("second") ?? -1));
});

// --- 6. all transports attempted and refused -> aggregate refused, detail names every transport + its refusal detail ---

test("all transports attempted and refused - selector returns non-delivered aggregate refused, detail names every transport and its refusal detail", async () => {
  const first = new FakeTransport("first", available, refuses("first", "owner gate closed"));
  const second = new FakeTransport("second", available, refuses("second", "no owning client"));

  const result = await selectAndWake([first, second], "thread-1", "resume");

  assert.notEqual(result.outcome, "delivered");
  assert.equal(result.outcome, "refused");
  assert.ok(result.detail?.includes("first"));
  assert.ok(result.detail?.includes("owner gate closed"));
  assert.ok(result.detail?.includes("second"));
  assert.ok(result.detail?.includes("no owning client"));
});

// --- 7. deterministic order across 3+ transports, proven via a call-order spy ---

test("transports are tried strictly in array order - a 3-transport spy proves probe()/wake() call sequence, not just call counts", async () => {
  const { log, record } = makeCallLog();
  const a = new FakeTransport("a", unavailableCapability("skip a"), unreachableWake, record);
  const b = new FakeTransport("b", available, refuses("b", "declined"), record);
  const c = new FakeTransport("c", available, delivers("c"), record);

  const result = await selectAndWake([a, b, c], "thread-1", "resume");

  assert.equal(result.outcome, "delivered");
  assert.equal(result.transportName, "c");
  // a is skipped after its probe (never woken); b is probed then woken and
  // refuses; c is probed then woken and delivers. This sequence could not
  // arise from a concurrent (Promise.all-style) implementation, since a
  // concurrent run would probe all three before waking any of them.
  assert.deepEqual(log, ["a:probe", "b:probe", "b:wake", "c:probe", "c:wake"]);
});

// --- 8. empty transports array -> clean non-delivered result, never throws ---

test("an empty transports array returns cleanly with a non-delivered outcome and does not throw", async () => {
  const result = await selectAndWake([], "thread-1", "resume");
  assert.notEqual(result.outcome, "delivered");
  assert.equal(result.outcome, "unavailable");
  assert.equal(typeof result.detail, "string");
  assert.ok(result.detail && result.detail.length > 0);
});

// --- 9. mutation-style negative controls: the "never fabricate delivered" invariant holds against hostile/broken transports ---

test("a transport whose wake() throws synchronously is treated as failed and falls through - never crashes the caller, never reported as delivered", async () => {
  const broken = new FakeTransport("broken", available, throwsSynchronously("boom"));
  const healthy = new FakeTransport("healthy", available, delivers("healthy"));

  const result = await selectAndWake([broken, healthy], "thread-1", "resume");

  assert.equal(result.outcome, "delivered");
  assert.equal(result.transportName, "healthy");
});

test("a transport whose wake() promise rejects is treated as failed and falls through - never crashes the caller", async () => {
  const broken = new FakeTransport("broken", available, rejectsAsync("connection reset"));
  const healthy = new FakeTransport("healthy", available, delivers("healthy"));

  const result = await selectAndWake([broken, healthy], "thread-1", "resume");

  assert.equal(result.outcome, "delivered");
  assert.equal(result.transportName, "healthy");
});

test("when EVERY transport's wake() throws, the selector still returns cleanly with a non-delivered outcome, never propagating the exception", async () => {
  const onlyThrows = new FakeTransport("onlyThrows", available, throwsSynchronously("no luck"));

  const result = await selectAndWake([onlyThrows], "thread-1", "resume");

  assert.notEqual(result.outcome, "delivered");
  assert.equal(result.outcome, "unavailable");
  assert.ok(result.detail?.includes("onlyThrows"));
});

test("a transport whose probe() itself throws is treated as unavailable and skipped, never crashing the caller or being attempted", async () => {
  const brokenProbe = new FakeTransport(
    "brokenProbe",
    () => {
      throw new Error("probe blew up");
    },
    unreachableWake
  );
  const healthy = new FakeTransport("healthy", available, delivers("healthy"));

  const result = await selectAndWake([brokenProbe, healthy], "thread-1", "resume");

  assert.equal(result.outcome, "delivered");
  assert.equal(result.transportName, "healthy");
  assert.equal(brokenProbe.wakeCallCount, 0);
});

test('a malformed wake() outcome (a runtime contract violation the type system can\'t prevent) is never treated as delivered - only the exact literal "delivered" short-circuits the loop', async () => {
  // Deliberately bypasses TypeScript's WakeOutcome literal union with a
  // cast, simulating a buggy real-world transport that returns something
  // that merely LOOKS like success (wrong case, trailing text) rather than
  // the exact string this function is required to check for. If
  // selectAndWake ever used a loose check (a truthy check, a
  // case-insensitive compare, a .startsWith/.includes match) instead of a
  // strict `=== "delivered"`, this test would catch it by getting a
  // fabricated "delivered" back from the aggregate instead of falling
  // through to the healthy transport below.
  const malformedOutcome = "DELIVERED" as unknown as WakeOutcome;
  const malformed = new FakeTransport("malformed", available, () =>
    Promise.resolve({
      outcome: malformedOutcome,
      detail: "looks like success but isn't",
      transportName: "malformed",
    })
  );
  const healthy = new FakeTransport("healthy", available, delivers("healthy"));

  const result = await selectAndWake([malformed, healthy], "thread-1", "resume");

  assert.equal(result.outcome, "delivered");
  assert.equal(result.transportName, "healthy");
});

test("a malformed wake() outcome, tried alone with no fallback transport, still never surfaces as delivered on the aggregate", async () => {
  const malformedOutcome = "delivered " as unknown as WakeOutcome; // trailing space
  const malformed = new FakeTransport("malformed", available, () =>
    Promise.resolve({ outcome: malformedOutcome, transportName: "malformed" })
  );

  const result = await selectAndWake([malformed], "thread-1", "resume");

  assert.notEqual(result.outcome, "delivered");
  // The stronger assertion: proves the loop actually fell through to the
  // aggregate path rather than short-circuiting on a near-miss and
  // returning the malformed transport's own result verbatim (which would
  // also happen to satisfy the bare notEqual above, by coincidence of the
  // trailing space, without the code having taken the correct branch at
  // all). The aggregate's own transportName is the tell: only the
  // exhaustion path ever produces it.
  assert.equal(result.transportName, SELECTOR_TRANSPORT_NAME);
});

// --- aggregate-outcome rule: the documented "unavailable unless a genuine refusal occurred" boundary ---

test("every transport attempted but every wake() reports unavailable (no genuine refusal anywhere) - aggregate is unavailable, not refused", async () => {
  const first = new FakeTransport("first", available, reportsUnavailable("first"));
  const second = new FakeTransport("second", available, reportsUnavailable("second"));

  const result = await selectAndWake([first, second], "thread-1", "resume");

  assert.equal(result.outcome, "unavailable");
});

test("a mix of attempted-unavailable and attempted-refused - a single genuine refusal anywhere makes the aggregate refused", async () => {
  const first = new FakeTransport("first", available, reportsUnavailable("first"));
  const second = new FakeTransport("second", available, refuses("second"));

  const result = await selectAndWake([first, second], "thread-1", "resume");

  assert.equal(result.outcome, "refused");
});

test("the aggregate result's own transportName never claims to be a real transport", async () => {
  const first = new FakeTransport("first", unavailableCapability("gone"), unreachableWake);

  const result = await selectAndWake([first], "thread-1", "resume");

  assert.equal(result.transportName, SELECTOR_TRANSPORT_NAME);
  assert.notEqual(result.transportName, "first");
});

// --- 10. DEFAULT_TRANSPORTS shape ---

test("DEFAULT_TRANSPORTS contains exactly the two real transports, app-server first then desktop-IPC, in that order", () => {
  assert.equal(DEFAULT_TRANSPORTS.length, 2);
  assert.ok(DEFAULT_TRANSPORTS[0] instanceof AppServerGoalWakeTransport);
  assert.ok(DEFAULT_TRANSPORTS[1] instanceof DesktopIpcWakeTransport);
  assert.equal(DEFAULT_TRANSPORTS[0].name, "codex-app-server-goal");
  assert.equal(DEFAULT_TRANSPORTS[1].name, "chatgpt-desktop-ipc");
});
