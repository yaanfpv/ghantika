import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveWakeTarget } from "../dist/wake/resolveWakeTarget.js";
import type { WakeTargetResolution } from "../dist/wake/resolveWakeTarget.js";

// --- "resolved" path ---

test('a real UUID-shaped threadId resolves - state: "resolved", target equal to that exact string', () => {
  const threadId = "b3e1c2a4-5f6d-4e7a-8b9c-0d1e2f3a4b5c";
  const result = resolveWakeTarget({ threadId });
  assert.deepEqual(result, { state: "resolved", target: threadId });
});

// --- "absent" path, two ways: both must produce the identical state ---

test('meta itself undefined resolves to state: "absent"', () => {
  const result = resolveWakeTarget(undefined);
  assert.deepEqual(result, { state: "absent" });
});

test('meta present but carrying no threadId key at all resolves to state: "absent" - the identical state as meta itself being undefined', () => {
  const result = resolveWakeTarget({ someOtherField: "x" });
  assert.deepEqual(result, { state: "absent" });
  assert.deepEqual(result, resolveWakeTarget(undefined));
});

// --- "malformed" path, several shapes - each names what was actually found ---

test("threadId: null is malformed, with a reason naming null specifically", () => {
  const result = resolveWakeTarget({ threadId: null });
  assert.equal(result.state, "malformed");
  assert.ok("reason" in result && result.reason.length > 0);
  assert.match((result as { reason: string }).reason, /\bnull\b/);
});

test("threadId: 42 is malformed, with a reason naming its real type", () => {
  const result = resolveWakeTarget({ threadId: 42 });
  assert.equal(result.state, "malformed");
  assert.match((result as { reason: string }).reason, /'number'/);
});

test("threadId: {} is malformed, with a reason naming its real type", () => {
  const result = resolveWakeTarget({ threadId: {} });
  assert.equal(result.state, "malformed");
  assert.match((result as { reason: string }).reason, /'object'/);
});

test("threadId: [] is malformed, with a reason naming it as an array specifically (never lumped in with a plain object)", () => {
  const result = resolveWakeTarget({ threadId: [] });
  assert.equal(result.state, "malformed");
  assert.match((result as { reason: string }).reason, /array/);
});

test('threadId: "" (empty string) is malformed, not absent - the boundary case between the two states', () => {
  const result = resolveWakeTarget({ threadId: "" });
  assert.equal(result.state, "malformed");
  assert.notEqual(result.state, "absent");
  assert.match((result as { reason: string }).reason, /empty string/);
});

test("the malformed reason string differs meaningfully by input - not one generic message reused for every shape", () => {
  const reasons = [null, 42, {}, [], ""].map((value) => {
    const result = resolveWakeTarget({ threadId: value });
    assert.equal(result.state, "malformed");
    return (result as { reason: string }).reason;
  });
  assert.equal(
    new Set(reasons).size,
    reasons.length,
    `expected five distinct reasons, got: ${JSON.stringify(reasons)}`
  );
  for (const reason of reasons) {
    assert.ok(typeof reason === "string" && reason.length > 0);
  }
});

// --- the fail-closed proof itself ---

test('neither "absent" nor "malformed" ever exposes a "target" own-key - a caller reading the object directly without narrowing on state first cannot accidentally extract a target that does not exist', () => {
  const absent: WakeTargetResolution = resolveWakeTarget(undefined);
  const malformed: WakeTargetResolution = resolveWakeTarget({ threadId: null });
  assert.equal(absent.state, "absent");
  assert.equal(malformed.state, "malformed");
  assert.equal(Object.hasOwn(absent, "target"), false);
  assert.equal(Object.hasOwn(malformed, "target"), false);
});

test("a caller falls back cleanly to the poll floor for every non-resolved shape: no wake is ever attempted, no exception is thrown, and no target field ever reaches a caller reading the raw object directly", () => {
  const nonResolvedInputs: Array<Record<string, unknown> | undefined> = [
    undefined,
    {},
    { threadId: undefined },
    { threadId: null },
    { threadId: 1 },
    { threadId: {} },
    { threadId: [] },
    { threadId: "" },
  ];
  for (const input of nonResolvedInputs) {
    let threw = false;
    let result: WakeTargetResolution | undefined;
    try {
      result = resolveWakeTarget(input);
    } catch {
      threw = true;
    }
    assert.equal(
      threw,
      false,
      `resolveWakeTarget must never throw, got a throw for: ${JSON.stringify(input)}`
    );
    assert.ok(result !== undefined);
    assert.notEqual(result.state, "resolved");
    assert.equal(Object.hasOwn(result, "target"), false);
  }
});

// --- a realistic negative control against a real, different client's own measured shape ---

test('a real Claude Code _meta shape ({"claudecode/toolUseId", progressToken}) resolves to "absent" - correctly read as "nothing here" rather than misreading one of its fields as a thread id', () => {
  const result = resolveWakeTarget({ "claudecode/toolUseId": "abc", progressToken: 1 });
  assert.deepEqual(result, { state: "absent" });
});
