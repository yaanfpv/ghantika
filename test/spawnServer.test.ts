import assert from "node:assert/strict";
import { test } from "node:test";

import { lineTimeoutFor } from "./helpers/spawnServer.ts";

test("lineTimeoutFor: the uninstrumented budget is exactly 2000ms", () => {
  assert.equal(lineTimeoutFor({}), 2000);
});

test("lineTimeoutFor: the instrumented budget is exactly 6000ms", () => {
  // Pinned exactly, not by a floor: 6000 is a defensive value, not a
  // derived one (see spawnServer.ts's own comment on why - the original
  // failure could not be reproduced, so there is no measured worst case
  // to build a floor from). Asserting equality means a future re-tune
  // has to touch this test and its comment rather than silently drifting
  // through a floor that only ever checks "still big enough".
  assert.equal(lineTimeoutFor({ NODE_V8_COVERAGE: "/tmp/some-coverage-dir" }), 6000);
});

test("mutation control: the instrumented budget must always exceed the uninstrumented one, never fall short", () => {
  // Not redundant with the two exact assertions above even though they
  // currently imply it arithmetically: if both constants are re-tuned
  // together in a future change, this is the one assertion left that
  // still enforces the invariant that actually matters - the
  // instrumented budget can never be tighter than the uninstrumented
  // one, which is the exact inversion this control exists to catch.
  assert.ok(
    lineTimeoutFor({ NODE_V8_COVERAGE: "/tmp/some-coverage-dir" }) > lineTimeoutFor({}),
    "a coverage-instrumented run must never get LESS time to produce a line than an uninstrumented run - that inversion is exactly the bug this control exists to catch"
  );
});
