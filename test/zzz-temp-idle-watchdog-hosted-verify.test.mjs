// TEMPORARY. This file exists only to trip the idle watchdog on a real
// hosted CI run, confirming that GitHub Actions actually hoists the
// `::error::`-prefixed diagnostic into the run's annotation summary, not
// merely into the raw log body. It is removed in a follow-up commit on
// this same branch before the PR is finalized.
//
// The per-test `timeout` override must exceed both the CI idle-timeout
// (180000ms default) and wall-timeout (600000ms default), or node:test's
// own inherited --test-timeout (120000ms in CI) fires first and this
// produces an ordinary test failure instead of the idle-watchdog path
// under verification. Confirmed locally against this exact mechanism via
// scripts/run-tests-fixture-harness.mjs with scaled timeouts preserving
// the same idle-timeout > test-timeout relationship CI uses.
import { test } from "node:test";

test(
  "TEMPORARY fixture: hangs past the idle watchdog on purpose",
  { timeout: 3600000 },
  async () => {
    await new Promise(() => {});
  }
);
