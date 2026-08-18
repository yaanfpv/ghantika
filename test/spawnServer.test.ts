import assert from "node:assert/strict";
import { test } from "node:test";

import { lineTimeoutFor } from "./helpers/spawnServer.ts";

test("lineTimeoutFor: the non-coverage budget is exactly 6000ms", () => {
  // Raised from the old unmeasured 2000ms - see spawnServer.ts's own
  // comment for the 14-run measurement (worst case 653ms) this rests on,
  // and why the constant is not tuned tighter toward that number.
  assert.equal(lineTimeoutFor({}), 6000);
});

test("lineTimeoutFor: the coverage budget is exactly 6000ms", () => {
  // Pinned exactly, not by a floor: both paths now carry the same
  // measured-with-margin value rather than two independently-justified
  // ones. Asserting equality means a future re-tune has to touch this
  // test and its comment rather than silently drifting through a floor
  // that only ever checks "still big enough".
  assert.equal(lineTimeoutFor({ NODE_V8_COVERAGE: "/tmp/some-coverage-dir" }), 6000);
});

test("mutation control: the instrumented budget must never fall short of the uninstrumented one", () => {
  // Not redundant with the two exact assertions above even though they
  // currently imply it arithmetically: if both constants are re-tuned
  // together in a future change, this is the one assertion left that
  // still enforces the invariant that actually matters - the
  // instrumented budget can never be tighter than the uninstrumented
  // one. The two paths are equal today (both 6000ms), so this is a
  // >= check rather than the strict > it used to be when the two paths
  // carried different numbers - equality is not the inversion this
  // control exists to catch; a coverage budget SMALLER than the
  // non-coverage one is.
  assert.ok(
    lineTimeoutFor({ NODE_V8_COVERAGE: "/tmp/some-coverage-dir" }) >= lineTimeoutFor({}),
    "a coverage-instrumented run must never get LESS time to produce a line than an uninstrumented run - that inversion is exactly the bug this control exists to catch"
  );
});
