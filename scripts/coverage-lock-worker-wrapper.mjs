#!/usr/bin/env node
/**
 * Wraps `npm run coverage`'s real coverage command (everything after `--`)
 * in the crash-safe mutual-exclusion lock defined in
 * scripts/lib/coverage-floor-lock.mjs (`acquireAsWorker`) - see that
 * module's own header for the full state machine and the deadlock this
 * closes. This file is a THIN CLI entrypoint: argv parsing, reading the
 * real git head SHA, and reporting the real underlying command's own exit
 * code. All of the state-machine logic lives in the lock module, where it
 * is directly unit-testable with injected dependencies rather than needing
 * a real spawned child process for every scenario - only
 * test/coverage-lock-wrappers.test.ts drives THIS file itself as a real
 * child process, exercising the argv wiring and the real two-process
 * handoff end to end.
 *
 * Invocation: `node scripts/coverage-lock-worker-wrapper.mjs -- <command> [args...]`
 * - everything after the FIRST `--` is spawned, unmodified, as the real
 *   coverage command. package.json's own "coverage" script passes
 *   `c8 --reporter=text --reporter=json-summary node scripts/run-tests.mjs`
 *   here; this wrapper interprets none of those tokens itself, it only
 *   spawns them.
 *
 * Deliberately does NOT wrap `npm run build`: the resources this lock
 * actually protects (coverage/coverage-summary.json, coverage/run-
 * truncated.json (+ its fallback), coverage/run-completed.json, and
 * .run-token.json - see scripts/run-tests.mjs's and scripts/check-
 * coverage-floor.mjs's own header comments) are all written only by the
 * `c8`/run-tests.mjs half of the coverage command, never by the build
 * step. package.json's own "coverage" script therefore runs `npm run
 * build` as a SEPARATE shell command (joined by `&&`) BEFORE this wrapper
 * ever starts, for a second, more basic reason too: this wrapper's own
 * dependency (scripts/lib/coverage-floor-lock.mjs) imports the BUILT
 * dist/process.js, which must already exist by the time this process
 * starts at all. Trying to fold `npm run build` INSIDE this wrapper's own
 * wrapped command (`-- npm run build && c8 ...`) would not work anyway:
 * npm hands the ENTIRE "coverage" script string to one shell, so a bare
 * `&&` inside it is parsed by THAT shell before this wrapper ever sees its
 * own argv - only the tokens up to (but not including) a `&&` become this
 * process's own arguments, and everything after it would run as a
 * completely separate, unwrapped shell command instead of this wrapper's
 * spawned child.
 */
import { readGitHeadSha } from "./check-sha-parity.mjs";
import { acquireAsWorker } from "./lib/coverage-floor-lock.mjs";
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
      "coverage-lock-worker-wrapper: expected `-- <command> [args...]` naming the real coverage command to run under the lock, e.g. `node scripts/coverage-lock-worker-wrapper.mjs -- c8 --reporter=text node scripts/run-tests.mjs`"
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
  const result = await acquireAsWorker({ argv: wrapped, headSha });
  process.exitCode = result.exitCode;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(
      `coverage-lock-worker-wrapper: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    );
    process.exitCode = 1;
  });
}
