import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkNoBoundedKillConfirmedWait,
  findBoundedKillConfirmedWaits,
} from "../scripts/check-no-bounded-kill-confirmed-wait.mjs";

test("flags a for(;;) loop that reads kill_confirmed via property access and throws on a Date.now() deadline", () => {
  const source = `
    async function pollUntilKillConfirmed(client, jobId) {
      const deadline = Date.now() + 5000;
      for (;;) {
        const result = await client.callTool({ name: "status", arguments: { job_id: jobId } });
        if (result.kill_confirmed !== undefined) return result;
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for kill_confirmed to settle");
        }
        await sleep(25);
      }
    }
  `;
  const violations = findBoundedKillConfirmedWaits(source, "planted-property-access.ts");
  assert.equal(
    violations.length,
    1,
    `expected exactly one violation, got: ${JSON.stringify(violations)}`
  );
});

test("flags a while loop that reads kill_confirmed via element access (a bracketed string key) and throws on a Date.now() deadline", () => {
  const source = `
    async function poll(jobId) {
      const deadline = Date.now() + 5000;
      while (true) {
        const result = await status(jobId);
        if (result["kill_confirmed"] !== undefined) return result;
        if (Date.now() - startedAt >= 5000) {
          throw new Error("timed out");
        }
      }
    }
  `;
  const violations = findBoundedKillConfirmedWaits(source, "planted-element-access.ts");
  assert.equal(
    violations.length,
    1,
    `expected exactly one violation, got: ${JSON.stringify(violations)}`
  );
});

test('flags a loop that references the bare string literal "kill_confirmed" (a JSON key) alongside a Date.now()-gated throw', () => {
  const source = `
    for (;;) {
      const body = JSON.parse(await readLine());
      if (Object.prototype.hasOwnProperty.call(body.result.structuredContent, "kill_confirmed")) break;
      if (Date.now() > deadline) throw new Error("timed out");
    }
  `;
  const violations = findBoundedKillConfirmedWaits(source, "planted-string-literal.ts");
  assert.equal(
    violations.length,
    1,
    `expected exactly one violation, got: ${JSON.stringify(violations)}`
  );
});

test("does NOT flag an honest, unrelated Date.now()-gated timeout that never references kill_confirmed - the lookalike green control", () => {
  const source = `
    async function waitForPgrepGroupMembers(pgid, predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const members = pgrepGroupMembers(pgid);
        if (predicate(members)) return members;
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for pgrep group membership");
        }
        await sleep(25);
      }
    }
  `;
  const violations = findBoundedKillConfirmedWaits(source, "clean-unrelated-timeout.ts");
  assert.deepEqual(
    violations,
    [],
    `expected zero violations on an honest unrelated timeout, got: ${JSON.stringify(violations)}`
  );
});

test("does NOT flag an unbounded kill_confirmed poll that logs a breadcrumb instead of throwing - the fixed shape this check exists to keep fixed", () => {
  const source = `
    async function pollUntilKillConfirmed(client, jobId) {
      const breadcrumbIntervalMs = 5000;
      let lastBreadcrumbAt = Date.now();
      for (;;) {
        const result = await client.callTool({ name: "kill", arguments: { job_id: jobId } });
        const last = runResultStructured(result);
        if (last.kill_confirmed !== undefined) return last;
        if (Date.now() - lastBreadcrumbAt >= breadcrumbIntervalMs) {
          console.error("still waiting for kill_confirmed to settle for job " + jobId);
          lastBreadcrumbAt = Date.now();
        }
        await sleep(25);
      }
    }
  `;
  const violations = findBoundedKillConfirmedWaits(source, "clean-unbounded-poll.ts");
  assert.deepEqual(
    violations,
    [],
    `expected zero violations on the unbounded-poll-with-breadcrumb shape, got: ${JSON.stringify(violations)}`
  );
});

test("does NOT flag a Date.now()-gated throw and a kill_confirmed reference that live in DIFFERENT, unrelated loops in the same file", () => {
  const source = `
    for (;;) {
      if (Date.now() > deadline) throw new Error("unrelated timeout");
      await sleep(25);
    }
    for (;;) {
      if (result.kill_confirmed !== undefined) break;
      await sleep(25);
    }
  `;
  const violations = findBoundedKillConfirmedWaits(source, "clean-separate-loops.ts");
  assert.deepEqual(
    violations,
    [],
    `expected zero violations when the two conditions never share a loop, got: ${JSON.stringify(violations)}`
  );
});

test("the real scan (checkNoBoundedKillConfirmedWait over this repo's own src/ and test/) is currently clean", () => {
  const violations = checkNoBoundedKillConfirmedWait();
  assert.deepEqual(
    violations,
    [],
    `expected the real repo tree to be clean of this class, got: ${JSON.stringify(violations)}`
  );
});

// THE DOCUMENTED, ACCEPTED GAP - not a bug in this test, proof the limit
// stated in this guard's own doc comment is real. This detector matches a
// bare `Date.now()` call inside an `if`-plus-`throw`; a deadline built from
// a different clock source is invisible to it by construction, and this is
// deliberately never widened to chase it (see the guard's own header:
// "WHAT THIS DOES NOT CATCH"). No enumeration of every escape form is
// attempted here - one representative example is enough to make the stated
// limit checkable rather than merely asserted in prose.
test("does NOT flag the identical deadline/throw shape built on performance.now() instead of Date.now() - the documented clock-source gap", () => {
  const source = `
    async function pollUntilKillConfirmed(client, jobId) {
      const deadline = performance.now() + 5000;
      for (;;) {
        const result = await client.callTool({ name: "status", arguments: { job_id: jobId } });
        if (result.kill_confirmed !== undefined) return result;
        if (performance.now() > deadline) {
          throw new Error("timed out waiting for kill_confirmed to settle");
        }
        await sleep(25);
      }
    }
  `;
  const violations = findBoundedKillConfirmedWaits(source, "gap-performance-now.ts");
  assert.deepEqual(
    violations,
    [],
    `expected this guard to miss a performance.now()-based deadline (documented gap), got: ${JSON.stringify(violations)}`
  );
});
