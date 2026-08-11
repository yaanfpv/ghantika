# Contributing

Thanks for looking at ghantika. This covers day-to-day development: setup, running the tests, and the other checks a change needs to pass. For what the project is and how it's used, see [README.md](README.md).

## Setup

Requires Node.js 22 or newer. Every install goes through `npm ci`, never `npm install`, so you get the exact dependency tree recorded in `package-lock.json`:

    npm ci
    npm run build

## Running the tests

    npm test

This builds the project and then runs the whole suite through `scripts/run-tests.mjs`, the one supported entry point for `npm test`, `npm run coverage`, and every CI test job. It walks `test/` itself and discovers every file matching `*.test.ts`/`.js`/`.mjs`/`.cjs`/`.mts`/`.cts` (no shell glob, so nothing platform-specific can silently match zero files), and, importantly for what follows, it sets one environment variable, `GHANTIKA_POLICY_FILE`, before spawning each test file.

### Why that variable matters

ghantika's command-execution policy (`src/policy.ts`) is default-deny: with no policy file configured, every attempt to spawn a command is refused. A large share of this suite's own tests spawn real commands to prove real behavior, so they need a policy file that allows the small set of ordinary binaries the fixtures use (`node`, `true`, `sleep`, and so on). `scripts/run-tests.mjs` points `GHANTIKA_POLICY_FILE` at `test/fixtures/policy-allow.json` for exactly this reason, and every test file it spawns inherits that setting.

If you bypass `scripts/run-tests.mjs` and invoke `node --test` directly on a file, that variable is never set. Every spawning test in that file will then fail immediately with the command denied - not because anything is broken, but because the policy gate is doing exactly what it's designed to do with no policy configured. Left alone, that shows up as a plain, confusing assertion failure (something like "expected completed, got failed") with nothing pointing at the real cause. Most of the test files that spawn real commands guard against this: they check the variable once, early, and fail with a message naming the actual reason and what to do about it, rather than letting every affected test fail its own way. If you hit that guard's message, you're running tests the unsupported way - see below for the supported one.

### Running a single test

`scripts/run-tests.mjs` always runs the whole discovered suite; today it has no flag to narrow that to one file or one test name. To run a single test directly, set the same policy variable yourself and use Node's own test runner flags:

    GHANTIKA_POLICY_FILE=test/fixtures/policy-allow.json node --test test/tasks.test.ts

    GHANTIKA_POLICY_FILE=test/fixtures/policy-allow.json node --test \
      --test-name-pattern="the pattern from the test's own title" \
      test/tasks.test.ts

This is honest about what it does and doesn't give you: it bypasses `scripts/run-tests.mjs`'s own extras (the discovered-file floor, skip-discipline enforcement, JUnit output, the configurable idle/wall timeouts), but it does not bypass the policy requirement above, which is why it works at all for a file that spawns real commands. A handful of test files manage their own policy value per test (`test/policy.test.ts`, which tests the policy gate itself) and don't need the variable set ambiently; for everything else, set it as shown.

Before running a single test this way, make sure `dist/` is up to date (`npm run build`) - the test files import the built output, not `src/` directly, so a stale or missing build produces its own, unrelated failures.

## Other checks

A change should also pass:

    npm run typecheck
    npm run lint
    npm run format:check

`npm run coverage` runs the same suite as `npm test` under coverage instrumentation and is what CI uses to enforce the coverage floor; you don't need to run it locally unless you're checking coverage on a specific change.

## Opening a change

Keep changes focused, and open an issue first if you're planning something large - the design here is deliberately small, and it's worth checking whether an idea fits before building it out. See the [README](README.md#contributing) for more on that.
