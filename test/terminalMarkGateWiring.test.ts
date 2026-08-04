/**
 * A structural coupling check between `beginSpawn` and `createTerminalMarkGate`
 * (`src/tools/run.ts`). Every other test touching the terminal-mark gate
 * either exercises `createTerminalMarkGate` directly against a synthetic
 * scheduler (`test/terminalMarkGate.test.ts`) or exercises `beginSpawn`
 * through fixtures (`test/wake-integration.test.ts`'s "TERMINAL ORDER" and
 * "BOUNDED TERMINAL WAIT") whose reap timing happens to never race the
 * ordinary fast-reap case - so NEITHER proves `beginSpawn` still routes its
 * six terminal-relevant events through the gate rather than back to some
 * reintroduced inline duplicate: a reintroduced duplicate that happens to
 * preserve the same observable ordering would leave every one of those
 * tests green. This file is a static source check that fails the moment
 * `beginSpawn` stops delegating, independent of any runtime timing.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. This establishes that delegation
 * is PRESENT - the six call sites exist, syntactically, inside `beginSpawn`.
 * It does not establish that delegation is CORRECT: a brace-depth text scan
 * cannot see control flow, so a future edit that wraps one of these calls in
 * an unreachable branch, or otherwise makes the call sit somewhere it never
 * actually executes, would still satisfy this check. In the CURRENT shape
 * that specific failure mode has limited room: `createTerminalMarkGate`'s
 * methods return no value for a caller to discard (each one's whole effect
 * is the closure-captured `fire` callback, invoked directly), and all six
 * call sites sit unconditionally in the exact synchronous position their
 * corresponding `spawnManaged` callback already occupied before this
 * change - so delegation is structurally load-bearing rather than
 * decorative here, not merely present. That property is a fact about this
 * particular wiring, not something this check itself verifies.
 * `terminalMarkGate.test.ts` proves the extracted gate is correct in
 * isolation; this proves production still reaches it. Neither alone is
 * sufficient, and together they are - a reader who finds only this file
 * should not conclude more than "delegation exists," which is why this
 * paragraph is here rather than assumed.
 *
 * THE DISCLOSED COST. This check is coupled to `beginSpawn`'s literal
 * function name, to `terminalMarkGate`'s local variable name, and to the
 * exact method-call text - an ordinary rename or refactor will red it
 * spuriously, with no real regression behind the failure. That is an
 * accepted trade, not an oversight: the property this guards (a reap
 * settling before an ordinary job's own stream drain completes) is a JS
 * event-loop scheduling accident that cannot be forced reliably through a
 * real spawned process's OS-level timing, so a structural check is the
 * only mechanism available to close this specific cell. Written down here
 * so whoever next renames `beginSpawn` finds the reason before the red,
 * rather than discovering it by tripping the check.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_TS_PATH = path.join(HERE, "..", "src", "tools", "run.ts");

/** Extracts `beginSpawn`'s full body, by brace-depth-scanning from its declaration to the matching closing brace - the only region this check cares about (`createTerminalMarkGate`'s own body legitimately calls `fire`, which production wires to `jobStore.markExited`). */
function extractBeginSpawnBody(sourceText: string): string {
  const declIndex = sourceText.indexOf("function beginSpawn(");
  assert.notEqual(declIndex, -1, "expected to find `function beginSpawn(` in src/tools/run.ts");
  const openBraceIndex = sourceText.indexOf("{", declIndex);
  assert.notEqual(openBraceIndex, -1, "expected an opening brace after `function beginSpawn(`");

  let depth = 0;
  for (let i = openBraceIndex; i < sourceText.length; i++) {
    if (sourceText[i] === "{") depth++;
    else if (sourceText[i] === "}") {
      depth--;
      if (depth === 0) return sourceText.slice(openBraceIndex, i + 1);
    }
  }
  throw new Error("never found beginSpawn's matching closing brace - unbalanced braces?");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

test("beginSpawn constructs a terminalMarkGate via createTerminalMarkGate", () => {
  const body = extractBeginSpawnBody(readFileSync(RUN_TS_PATH, "utf8"));
  assert.match(
    body,
    /createTerminalMarkGate\(/,
    "beginSpawn must construct its terminal-mark gate via createTerminalMarkGate - if this fails, the extracted unit exists but production stopped using it"
  );
});

test("beginSpawn's only call to jobStore.markExited is the fire callback handed to createTerminalMarkGate", () => {
  const body = extractBeginSpawnBody(readFileSync(RUN_TS_PATH, "utf8"));
  // Exactly one: the `(code, signal) => jobStore.markExited(jobId, code,
  // signal)` argument passed to createTerminalMarkGate. Any OTHER count
  // means a reintroduced direct call bypassing the gate's own settle-check
  // sequencing - the exact regression a fast, ordinary-job reap would
  // otherwise race silently past, unseen by every timing-based test.
  const count = countOccurrences(body, "jobStore.markExited(");
  assert.equal(
    count,
    1,
    `expected exactly one jobStore.markExited( call inside beginSpawn (the gate's fire callback), found ${count} - a second call site would bypass the gate's settle-check sequencing entirely`
  );
});

test("all six terminal-relevant events route through terminalMarkGate, not a reintroduced inline duplicate", () => {
  const body = extractBeginSpawnBody(readFileSync(RUN_TS_PATH, "utf8"));
  const requiredCalls = [
    "terminalMarkGate.onExit(",
    "terminalMarkGate.onStdoutChunk(",
    "terminalMarkGate.onStderrChunk(",
    "terminalMarkGate.onStdoutEnd(",
    "terminalMarkGate.onStderrEnd(",
    "terminalMarkGate.onReapSettled(",
  ];
  for (const call of requiredCalls) {
    assert.equal(
      countOccurrences(body, call),
      1,
      `expected exactly one ${call} inside beginSpawn - if this is missing, that event no longer reaches the gate at all`
    );
  }
});
