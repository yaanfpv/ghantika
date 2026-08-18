#!/usr/bin/env node
/**
 * test/fixtures/dogfood-external-checker-fixture.js - a deterministic
 * stand-in for scripts/dogfood-gh-run-checker.mjs, so
 * test/dogfood-external.test.ts never depends on network access, a real
 * `gh` CLI, or an actual GitHub Actions run existing. Speaks the exact
 * same checker contract scripts/dogfood-external-wake.mjs's own header
 * documents (one line on stdout, a real exit code), so the detector code
 * under test never knows the difference between this and a real checker.
 *
 * Usage: `node dogfood-external-checker-fixture.js <planPath> <counterPath>`
 *
 * `planPath` names a JSON file of the shape `{ "steps": ["pending", ...] }`
 * - a test writes this once, before starting the detector. Each
 * invocation of this fixture reads a plain integer from `counterPath`
 * (0 if the file doesn't exist yet - the first invocation), writes back
 * `index + 1`, and acts on `steps[min(index, steps.length - 1)]` - so a
 * plan can name exactly how many pending polls happen before the terminal
 * or error step, and every invocation past the end of the plan repeats its
 * last step rather than throwing on an out-of-range read.
 *
 * Recognized steps:
 *   "pending"   prints EXTERNAL_STATE_PENDING, exits 0
 *   "terminal"  prints EXTERNAL_STATE_TERMINAL:<json carrying this
 *               invocation's own step index, so a test can correlate the
 *               eventual wake payload back to the exact invocation that
 *               fired it>, exits 0
 *   "error"     prints an unrelated line to stderr and exits nonzero -
 *               a real detection failure, never a line the checker
 *               contract itself recognizes as terminal or pending
 */
import fs from "node:fs";

const [, , planPath, counterPath] = process.argv;
if (!planPath || !counterPath) {
  console.error("usage: dogfood-external-checker-fixture.js <planPath> <counterPath>");
  process.exit(2);
}

const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));

let index = 0;
try {
  index = Number(fs.readFileSync(counterPath, "utf8").trim());
} catch {
  // No counter file yet - this is the first invocation, index stays 0.
}
fs.writeFileSync(counterPath, String(index + 1), "utf8");

const step = plan.steps[Math.min(index, plan.steps.length - 1)];

if (step === "terminal") {
  process.stdout.write(`EXTERNAL_STATE_TERMINAL:${JSON.stringify({ fixtureInvocation: index })}\n`);
  process.exit(0);
}
if (step === "error") {
  process.stderr.write(`dogfood-external-checker-fixture: simulated detection failure at invocation ${index}\n`);
  process.exit(3);
}
process.stdout.write("EXTERNAL_STATE_PENDING\n");
process.exit(0);
