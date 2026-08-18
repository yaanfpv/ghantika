#!/usr/bin/env node
/**
 * Wraps `npm run check:coverage-floor`'s real command (everything after
 * `--`) in the crash-safe mutual-exclusion lock defined in
 * scripts/lib/coverage-floor-lock.mjs (`acquireAsFloorJob`) - see that
 * module's own header for the full state machine and the deadlock this
 * closes. This file is a THIN CLI entrypoint, the FLOOR-side counterpart
 * of scripts/coverage-lock-worker-wrapper.mjs: argv parsing, reading the
 * real git head SHA, and reporting the real underlying command's own exit
 * code (PASS/FAIL/VOID - see scripts/check-coverage-floor.mjs's own
 * VOID_EXIT_CODE - preserved exactly, never collapsed or remapped). All of
 * the state-machine logic lives in the lock module.
 *
 * Invocation: `node scripts/coverage-lock-floor-wrapper.mjs -- <command> [args...]`
 * - everything after the FIRST `--` is spawned, unmodified, as the real
 *   floor-check command. package.json's own "check:coverage-floor" script
 *   passes `node scripts/check-coverage-floor.mjs` here.
 *
 * Always run as the NEXT, separate CI/local step after "npm run coverage"
 * has already completed (see .github/workflows/ci.yml's `coverage` job) -
 * by the time this process starts, dist/process.js (this wrapper's own
 * transitive dependency, via scripts/lib/coverage-floor-lock.mjs) is
 * already fresh, since "npm run coverage" itself runs `npm run build`
 * before ever handing off to its own worker wrapper.
 */
import { readGitHeadSha } from "./check-sha-parity.mjs";
import { acquireAsFloorJob } from "./lib/coverage-floor-lock.mjs";
import { isMainModule } from "./lib/is-main.mjs";

/**
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {string[] | null} everything after the first `--`, or `null`
 *   (with an explanatory error already printed) when there is no `--`, or
 *   nothing follows it.
 */
export function parseWrappedCommand(argv) {
  const dashDashIndex = argv.indexOf("--");
  if (dashDashIndex === -1 || dashDashIndex === argv.length - 1) {
    console.error(
      "coverage-lock-floor-wrapper: expected `-- <command> [args...]` naming the real floor-check command to run under the lock, e.g. `node scripts/coverage-lock-floor-wrapper.mjs -- node scripts/check-coverage-floor.mjs`"
    );
    return null;
  }
  return argv.slice(dashDashIndex + 1);
}

async function main() {
  const wrapped = parseWrappedCommand(process.argv.slice(2));
  if (wrapped === null) {
    process.exitCode = 1;
    return;
  }
  const headSha = readGitHeadSha();
  const result = await acquireAsFloorJob({ argv: wrapped, headSha });
  process.exitCode = result.exitCode;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(
      `coverage-lock-floor-wrapper: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    );
    process.exitCode = 1;
  });
}
