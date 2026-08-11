/**
 * A shared preflight for the test files that spawn a real command through
 * this server's `run` tool and rely on the runner's ambient policy to do
 * so - whether via a real MCP client/server pair over `InMemoryTransport`,
 * a real spawned `dist/index.js` subprocess (see `./spawnServer.ts`), or a
 * direct in-process call to `src/tools/run.ts`'s own `handler`.
 * `test/policy.test.ts` is the one exception: it also spawns real commands
 * through that same `handler`, but manages its own `GHANTIKA_POLICY_FILE`
 * value per test (see CONTRIBUTING.md) to exercise the gate's own
 * absent/malformed/narrow-policy behavior directly, so it stays unguarded
 * rather than call this helper. Every ordinary path ends up inside
 * `src/policy.ts`'s
 * `decideRunPolicy`/`decideShellPolicy`, and that gate is default-deny: with
 * no `GHANTIKA_POLICY_FILE` configured, every spawn attempt is denied and
 * the backing job settles `failed` with `diagnostic.reason: "policy-denied"`.
 * That is the policy gate working exactly as designed - the defect this
 * helper exists to fix is downstream of it: a plain `assert.equal(state,
 * "completed")` against a policy-denied job reads as an ordinary, confusing
 * "expected completed got failed" failure, with nothing pointing a
 * contributor at the real cause.
 *
 * `scripts/run-tests.mjs` (the supported entry point behind `npm test` /
 * `npm run coverage`) sets `GHANTIKA_POLICY_FILE` on its OWN process before
 * spawning each test-file child process, so every file discovered and run
 * through it inherits an allowlist wide enough for this suite's own
 * fixtures (see that file's own `TEST_POLICY_ALLOW_PATH` doc comment). A
 * bare `node --test <file>` invocation bypasses that script entirely, so
 * the variable is simply never set there - every spawning test in the
 * bypassed file then denies immediately, for the identical reason, at
 * every call site.
 *
 * Call `requireSpawnPolicy()` from a file-level `before()` hook (see any of
 * this repo's own spawning test files for the call-site pattern), never
 * inline at individual assertions: the check itself only needs to run once,
 * early, before the first test in the file. `node:test` then fails every
 * test the hook covers with this same, real message, rather than requiring
 * a contributor to trace one confusing state mismatch back to its actual
 * cause by hand.
 *
 * This deliberately does not import `src/policy.ts`'s own `loadPolicy` (or
 * anything else beyond the one exported constant naming the env var) - a
 * test helper re-implementing or calling into the real policy-loading and
 * validation logic would be exactly the kind of production/test coupling
 * this file is meant to avoid. It mirrors just the first of `loadPolicy`'s
 * checks (unset or empty counts as "not configured"), which is also the
 * only one this suite's own shared fixture (`test/fixtures/policy-allow.json`,
 * wired in by `scripts/run-tests.mjs`) can ever actually trip on a bare
 * `node --test` run - a genuinely unreadable or malformed policy file is a
 * different, unrelated failure mode this helper makes no claim about.
 */
import { POLICY_FILE_ENV_VAR } from "../../dist/policy.js";

/**
 * Throws an actionable error when `GHANTIKA_POLICY_FILE` is unset or empty.
 * See this file's own header for why this exists, what it checks, and why
 * it stops at that one check rather than validating the policy file itself.
 */
export function requireSpawnPolicy(): void {
  const value = process.env[POLICY_FILE_ENV_VAR];
  if (value !== undefined && value.length > 0) return;
  throw new Error(
    `${POLICY_FILE_ENV_VAR} is not set. This repo's command-execution ` +
      "policy (src/policy.ts) is default-deny with no fallback, so every " +
      "spawning test in this file would otherwise fail with a confusing, " +
      "unrelated-looking assertion error instead of naming the real cause. " +
      "Run tests via `npm test` (or `node scripts/run-tests.mjs`), which " +
      `set ${POLICY_FILE_ENV_VAR} automatically before spawning each test ` +
      "file. See CONTRIBUTING.md for how to run a single test directly."
  );
}
