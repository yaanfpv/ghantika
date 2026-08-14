#!/usr/bin/env node
/**
 * TEST-ONLY. Nothing production-facing ever invokes this file: not
 * `npm test`, not `npm run coverage`, not any CI workflow step, not any
 * other automated entrypoint. A structural check in
 * test/skip-discipline.test.ts reads package.json's `scripts` and every
 * workflow file under .github/workflows/ and asserts none of them names
 * it.
 *
 * scripts/run-tests.mjs's production entrypoint takes no caller-
 * controlled redirect of any kind - see its own header comment for why.
 * The only way left to prove its discovery, skip-baseline-loading,
 * critical-test-loading, classification, and exit-code wiring end to end
 * against a throwaway fixture tree, instead of only ever against this
 * repo's own real test/ directory, is through this file: it imports that
 * same wiring directly from scripts/run-tests.mjs and drives it with
 * whatever paths its own positional arguments name - the ordinary way any
 * caller of those functions supplies them, no environment variable
 * involved on either side.
 *
 * Usage:
 *   node scripts/run-tests-fixture-harness.mjs <testDir> <baselinePath> <criticalTestsPath> [--test-timeout=N] [--idle-timeout=N] [--wall-timeout=N] [--leak-window=N]
 *
 * Tracked-file parity never runs here, and never can: that check compares
 * node:fs discovery against this repo's own git-tracked test/ directory
 * (see checkTrackedFileParity in scripts/run-tests.mjs), and a throwaway
 * fixture tree under a temp directory has no such relationship to check.
 * `tracked: null` below is exactly the same "cannot enforce the
 * tracked-file floor this run" signal the production entrypoint already
 * understands when git itself is unavailable to it - every other check
 * (skip-discipline classification, critical-test presence, the exit-code
 * decision) still runs regardless.
 */
import path from "node:path";
import {
  discoverTestFiles,
  loadCriticalTests,
  loadSkipBaseline,
  parseArgs,
  runOnce,
} from "./run-tests.mjs";
import { isMainModule } from "./lib/is-main.mjs";

async function main() {
  const [, , rawTestDir, rawBaselinePath, rawCriticalTestsPath, ...rest] = process.argv;

  if (!rawTestDir || !rawBaselinePath || !rawCriticalTestsPath) {
    console.error(
      "run-tests-fixture-harness: usage: node run-tests-fixture-harness.mjs " +
        "<testDir> <baselinePath> <criticalTestsPath> [timing flags]"
    );
    process.exitCode = 1;
    return;
  }

  let options;
  try {
    options = parseArgs(rest);
  } catch (err) {
    console.error(`run-tests-fixture-harness: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const testDir = path.resolve(rawTestDir);
  const baselinePath = path.resolve(rawBaselinePath);
  const criticalTestsPath = path.resolve(rawCriticalTestsPath);

  const discovered = discoverTestFiles(testDir);
  if (discovered.length === 0) {
    console.error(
      `run-tests-fixture-harness: discovered zero test files under ${testDir} - refusing to report a silent pass`
    );
    process.exitCode = 1;
    return;
  }

  let skipBaseline;
  try {
    skipBaseline = loadSkipBaseline(baselinePath);
  } catch (err) {
    console.error(`run-tests-fixture-harness: could not read ${baselinePath}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  let criticalTests;
  try {
    criticalTests = loadCriticalTests(criticalTestsPath);
  } catch (err) {
    console.error(`run-tests-fixture-harness: could not read ${criticalTestsPath}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const junitPath = process.env.GHANTIKA_JUNIT ? path.resolve(process.env.GHANTIKA_JUNIT) : null;

  // Scoped to this fixture's OWN directory, never the real, shared default
  // - a scenario driven through this harness (including one that
  // deliberately forces a watchdog fire, to prove the watchdog mechanism
  // itself against a throwaway fixture) must never write into the real
  // repo's own coverage/ directory. Leaving this at the shared default
  // would let a deliberately-hung fixture scenario write a real truncation
  // marker that a later, genuinely complete top-level `npm run coverage`
  // run - sharing the same process tree in one gate invocation - would then
  // read and wrongly refuse to certify.
  const truncationMarkerPath = path.join(testDir, ".truncation-marker.json");

  // tracked: null - see the module doc comment above for why this harness
  // never checks tracked-file parity against a fixture tree.
  await runOnce({
    discovered,
    tracked: null,
    junitPath,
    options,
    skipBaseline,
    criticalTests,
    truncationMarkerPath,
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("run-tests-fixture-harness: unexpected error:", err);
    process.exitCode = 1;
  });
}
