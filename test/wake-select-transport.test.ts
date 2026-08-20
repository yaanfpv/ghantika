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
import { ClaudeMessagingWakeTransport } from "../dist/wake/claudeMessagingTransport.js";
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

function unavailableCapability(reason: string, permanent?: boolean): () => Promise<Capability> {
  return () => Promise.resolve({ available: false, reason, probedAt: nowIso(), permanent });
}

function delivers(transportName: string, detail = "delivered"): () => Promise<WakeResult> {
  return () => Promise.resolve({ outcome: "delivered", detail, transportName });
}

function refuses(
  transportName: string,
  detail = "declined",
  permanent?: boolean
): () => Promise<WakeResult> {
  return () => Promise.resolve({ outcome: "refused", detail, transportName, permanent });
}

function reportsUnavailable(
  transportName: string,
  detail = "raced",
  permanent?: boolean
): () => Promise<WakeResult> {
  return () => Promise.resolve({ outcome: "unavailable", detail, transportName, permanent });
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

// --- CLAUDECODE env-var seam, following test/process.test.ts's own established save/mutate/restore convention for GHANTIKA_CWD_ROOTS ---

const CLAUDE_CODE_ENV_VAR_NAME = "CLAUDECODE";

/**
 * Saves, sets (or deletes), runs `fn`, then restores CLAUDECODE around a
 * single test - the exact save/mutate/restore-in-finally shape
 * test/process.test.ts already uses for GHANTIKA_CWD_ROOTS, adapted for an
 * async body since selectAndWake is async. Never relies on the ambient
 * value: CLAUDECODE=1 is genuinely set in this repo's own real Bash-tool
 * subprocess environment (Claude Code sets it for every stdio MCP server
 * subprocess AND every Bash/PowerShell tool subprocess it spawns - see
 * https://code.claude.com/docs/en/env-vars.md), so a test that wants a
 * SPECIFIC value - present or absent - must state it explicitly rather
 * than trust whatever the invoking shell happens to carry. node:test's
 * default per-file process isolation means this mutation never crosses
 * into a sibling test file's own process.
 */
async function withClaudeCodeEnv(
  value: string | undefined,
  fn: () => Promise<void>
): Promise<void> {
  const original = process.env[CLAUDE_CODE_ENV_VAR_NAME];
  try {
    if (value === undefined) delete process.env[CLAUDE_CODE_ENV_VAR_NAME];
    else process.env[CLAUDE_CODE_ENV_VAR_NAME] = value;
    await fn();
  } finally {
    if (original === undefined) delete process.env[CLAUDE_CODE_ENV_VAR_NAME];
    else process.env[CLAUDE_CODE_ENV_VAR_NAME] = original;
  }
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

// --- 6b. aggregate `permanent` - see selectTransport.ts's own
// computeAggregatePermanence doc comment for the rule this section proves:
// TRUE only when every attempted transport's own contribution reported
// itself permanent; false the moment even one did not, or made no
// permanence claim at all (probe()/wake() throwing, or a transport simply
// leaving Capability.permanent/WakeResult.permanent unset). ---

test("every transport probes permanently unavailable - the aggregate result reports permanent:true", async () => {
  const first = new FakeTransport(
    "first",
    unavailableCapability("no socket env var", true),
    unreachableWake
  );
  const second = new FakeTransport(
    "second",
    unavailableCapability("no token env var", true),
    unreachableWake
  );

  const result = await selectAndWake([first, second], "thread-1", "resume");

  assert.equal(result.outcome, "unavailable");
  assert.equal(result.permanent, true);
});

test("every transport probes unavailable but NOT permanently - the aggregate result is NOT permanent (a later attempt might still work)", async () => {
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

  assert.equal(result.outcome, "unavailable");
  assert.notEqual(result.permanent, true);
});

test("a mix of one permanently-unavailable transport and one merely situationally-unavailable transport - the aggregate is NOT permanent, since at least one might still resolve later", async () => {
  const first = new FakeTransport(
    "first",
    unavailableCapability("no env var - fixed for this process", true),
    unreachableWake
  );
  const second = new FakeTransport(
    "second",
    unavailableCapability("no app-server running right now"),
    unreachableWake
  );

  const result = await selectAndWake([first, second], "thread-1", "resume");

  assert.equal(result.outcome, "unavailable");
  assert.notEqual(
    result.permanent,
    true,
    "one non-permanent transport is enough to make the WHOLE aggregate non-permanent"
  );
});

test("every transport's wake() attempt refuses permanently - the aggregate refused result reports permanent:true too, not just the unavailable case", async () => {
  const first = new FakeTransport("first", available, refuses("first", "owner gate closed", true));
  const second = new FakeTransport(
    "second",
    available,
    refuses("second", "no owning client", true)
  );

  const result = await selectAndWake([first, second], "thread-1", "resume");

  assert.equal(result.outcome, "refused");
  assert.equal(result.permanent, true);
});

test("a transport whose probe() throws is never counted as permanent, even when every OTHER transport genuinely is - an exception is not a permanence claim", async () => {
  const brokenProbe = new FakeTransport(
    "brokenProbe",
    () => {
      throw new Error("probe blew up");
    },
    unreachableWake
  );
  const permanentlyGone = new FakeTransport(
    "permanentlyGone",
    unavailableCapability("no env var - fixed for this process", true),
    unreachableWake
  );

  const result = await selectAndWake([brokenProbe, permanentlyGone], "thread-1", "resume");

  assert.equal(result.outcome, "unavailable");
  assert.notEqual(
    result.permanent,
    true,
    "a thrown probe() makes no claim about permanence at all, so it must never be treated as one"
  );
});

test("a transport whose wake() throws is never counted as permanent, even when it probed as permanently unavailable would have been reported by a sibling", async () => {
  const throwsOnWake = new FakeTransport(
    "throwsOnWake",
    available,
    throwsSynchronously("wake blew up")
  );

  const result = await selectAndWake([throwsOnWake], "thread-1", "resume");

  assert.equal(result.outcome, "unavailable");
  assert.notEqual(result.permanent, true);
});

test("an empty transports array reports permanent:false - the absence of any attempt is a configuration fact, never a permanence claim any transport made", async () => {
  const result = await selectAndWake([], "thread-1", "resume");
  assert.notEqual(result.outcome, "delivered");
  assert.equal(result.permanent, false);
});

test("a delivered result never carries an aggregate permanent claim - permanence is meaningless once a wake actually succeeded", async () => {
  const permanentlyGone = new FakeTransport(
    "permanentlyGone",
    unavailableCapability("no env var - fixed for this process", true),
    unreachableWake
  );
  const healthy = new FakeTransport("healthy", available, delivers("healthy"));

  const result = await selectAndWake([permanentlyGone, healthy], "thread-1", "resume");

  assert.equal(result.outcome, "delivered");
  assert.equal(result.permanent, undefined);
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

test("DEFAULT_TRANSPORTS contains exactly the three real transports, Claude-messaging first, then app-server, then desktop-IPC, in that order", () => {
  assert.equal(DEFAULT_TRANSPORTS.length, 3);
  assert.ok(DEFAULT_TRANSPORTS[0] instanceof ClaudeMessagingWakeTransport);
  assert.ok(DEFAULT_TRANSPORTS[1] instanceof AppServerGoalWakeTransport);
  assert.ok(DEFAULT_TRANSPORTS[2] instanceof DesktopIpcWakeTransport);
  assert.equal(DEFAULT_TRANSPORTS[0].name, "claude-code-uds-messaging");
  assert.equal(DEFAULT_TRANSPORTS[1].name, "codex-app-server-goal");
  assert.equal(DEFAULT_TRANSPORTS[2].name, "chatgpt-desktop-ipc");
});

// --- 11. exhaustion detail has no harness-specific wording, on any CLAUDECODE value ---
//
// This section used to assert a Claude-Code-aware summary in
// buildExhaustionDetail, on the premise that none of DEFAULT_TRANSPORTS
// served that harness at all. Adding ClaudeMessagingWakeTransport made
// that premise false, so the special-cased wording was removed from
// selectTransport.ts (see that file's own buildExhaustionDetail doc
// comment) rather than kept alive on a now-false claim. What replaces
// the six tests that used to live here is the inverse
// property: the exhaustion detail is the SAME bare per-transport
// enumeration regardless of CLAUDECODE's value, proving no harness-specific
// branch exists to regress back in later. withClaudeCodeEnv is kept for
// exactly this - a real save/mutate/restore of the env var this repo's own
// Bash-tool subprocesses genuinely set, per that helper's own doc comment.

test('the exhaustion detail is the identical bare per-transport enumeration whether CLAUDECODE is "1", unset, or any other value - no harness-specific wording exists to vary by', async () => {
  for (const claudeCodeValue of ["1", undefined, "0"]) {
    await withClaudeCodeEnv(claudeCodeValue, async () => {
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

      assert.equal(result.outcome, "unavailable");
      assert.equal(
        result.detail,
        "no transport delivered; tried 2 in order - first: skipped, probe reported unavailable - no app-server running; second: skipped, probe reported unavailable - no socket present",
        `CLAUDECODE=${String(claudeCodeValue)} should not change the exhaustion wording: ${result.detail}`
      );
      assert.ok(!result.detail?.includes("Claude Code"));
      assert.ok(!/\bpoll\b/i.test(result.detail ?? ""));
    });
  }
});
