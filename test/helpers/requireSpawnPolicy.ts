/**
 * A shared preflight for the tests that dispatch a real command through
 * this server's `run` tool's policy gate and rely on the runner's ambient
 * policy to do so - whether via a real MCP client/server pair over
 * `InMemoryTransport`, a real spawned `dist/index.js` subprocess sent a
 * real `tools/call` over the wire (see `./spawnServer.ts`), or a direct
 * in-process call to `src/tools/run.ts`'s own `handler`. Every one of
 * those paths ends up inside `src/policy.ts`'s
 * `decideRunPolicy`/`decideShellPolicy`, and that gate is default-deny: with
 * no `GHANTIKA_POLICY_FILE` configured, every spawn attempt through it is
 * denied and the backing job settles `failed` with `diagnostic.reason:
 * "policy-denied"`. That is the policy gate working exactly as designed -
 * the defect this helper exists to fix is downstream of it: a plain
 * `assert.equal(state, "completed")` against a policy-denied job reads as
 * an ordinary, confusing "expected completed got failed" failure, with
 * nothing pointing a contributor at the real cause.
 *
 * A call to `spawnManaged` (from `src/process.ts`) directly is a DIFFERENT
 * path that never reaches this gate at all - `test/process-slow-paths.test.ts`
 * is the clearest example, but any test anywhere that spawns via
 * `spawnManaged` without going through `run.ts`'s handler needs this helper
 * exactly as little, for the identical reason. `test/policy.test.ts` is a
 * third, narrower case: it does reach the gate, but manages its own
 * `GHANTIKA_POLICY_FILE` value per test (see CONTRIBUTING.md) to exercise
 * the gate's own absent/malformed/narrow-policy behavior directly, so it
 * stays unguarded rather than call this helper.
 *
 * `scripts/run-tests.mjs` (the supported entry point behind `npm test` /
 * `npm run coverage`) sets `GHANTIKA_POLICY_FILE` on its OWN process before
 * spawning each test-file child process, so every file discovered and run
 * through it inherits an allowlist wide enough for this suite's own
 * fixtures (see that file's own `TEST_POLICY_ALLOW_PATH` doc comment). A
 * bare `node --test <file>` invocation bypasses that script entirely, so
 * the variable is simply never set there - every test that reaches the
 * policy gate in the bypassed file then denies immediately, for the
 * identical reason, at every call site.
 *
 * CALL `requireSpawnPolicy()` FROM THE NARROWEST `before()` HOOK THAT COVERS
 * ONLY THE TESTS WHOSE ASSERTED BEHAVIOR NEEDS A POLICY-ALLOWED COMMAND TO
 * PASS - never from a file-level `before()` unless every single test in the
 * file needs one. "Reaches the policy gate" is NOT the predicate: a call can
 * reach `decideRunPolicy`/`decideShellPolicy` and still not need this helper,
 * in three distinct ways -
 *
 *   - it returns BEFORE the policy decision (pre-policy validation, a
 *     schema-invalid request, an unconfigured/rejected cwd);
 *   - every test that would reach it is SKIPPED first (a Windows-only or
 *     availability-gated suite where no child ever runs the spawning path) -
 *     in this case the REMEDY is not to omit the call, it is to CONDITION
 *     the `before()` REGISTRATION ITSELF on the identical predicate that
 *     skips its tests (`if (process.platform !== "win32") {
 *     before(requireSpawnPolicy); }`), never to register it unconditionally.
 *     `before()` runs regardless of whether its covered tests end up
 *     skipped, so an unconditioned registration still throws on an unset
 *     policy variable on the very platform where nothing it guards can ever
 *     run - the guard fires with nothing left to guard;
 *   - its assertion holds under DENIAL just as well as under ALLOW (an
 *     `assert.doesNotReject` against `dispatchToolCall`, or a bare
 *     `isError !== true` check) - `src/tools/run.ts`'s handler resolves a
 *     policy denial as an ordinary failed-job tool result rather than
 *     throwing, so an outcome-insensitive assertion never notices which way
 *     the gate decided.
 *
 * `node:test` fails EVERY test a `before()` hook covers when that hook
 * throws, not just the ones that depend on its precondition: a file-level
 * registration in a file that mixes tests needing the policy with tests that
 * do not fails the latter too, as collateral damage, under an unset policy
 * variable - exactly the confusing-failure class this helper exists to
 * eliminate, just moved one level up. Scope the guard to a `describe()`
 * block wrapping only the tests whose assertion actually depends on a
 * policy-allowed outcome (see any of this repo's spawning test files for the
 * pattern: `describe("<name>", () => { before(requireSpawnPolicy);
 * ...policy-dependent tests only... });`), and leave every other test in the
 * file outside any such block. Register at file level only when every test
 * in the file genuinely needs the policy allowed, so there is nothing to
 * isolate the guard from.
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
      "test covered by THIS `before()` hook needs a policy-allowed command " +
      "to pass its assertion, and each would otherwise fail with a " +
      "confusing, unrelated-looking assertion error instead of naming the " +
      "real cause. (A test whose assertion holds under denial too - an " +
      "outcome-insensitive `doesNotReject`, a pre-policy validation case, " +
      "a fully-skipped platform suite - does not need this helper and " +
      "should not be inside this hook's scope.) Run tests via `npm test` " +
      "(or `node scripts/run-tests.mjs`), which set " +
      `${POLICY_FILE_ENV_VAR} automatically before spawning each test ` +
      "file. See CONTRIBUTING.md for how to run a single test directly."
  );
}
