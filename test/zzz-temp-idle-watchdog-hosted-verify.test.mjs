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
// under verification.
//
// A bare `await new Promise(() => {})` is not enough on its own: once the
// test function returns and nothing else is scheduled, node:test's own
// unresolved-promise detector ("Promise resolution is still pending but
// the event loop has already resolved") fails the test in milliseconds,
// before the supervisor's idle watchdog ever gets a chance to fire - the
// same shape this repo's other hung-test fixtures already avoid. The
// no-op `setTimeout` below is the same fix reapplied: a live timer keeps
// the event loop non-empty for long enough that the supervisor's own
// 180s idle window elapses first.
import { test } from "node:test";

test(
  "TEMPORARY fixture: hangs past the idle watchdog on purpose",
  { timeout: 3600000 },
  async () => {
    setTimeout(() => {}, 3600000);
    await new Promise(() => {});
  }
);
