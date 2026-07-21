# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

- Added public CI on GitHub-hosted runners: build, typecheck, lint, and the full operating-system by Node-version test matrix, plus CodeQL, semgrep, zizmor, and actionlint, all aggregated behind one required `gate` check.
- Added a blocking Prettier format check and a coverage job (an absolute per-metric floor, plus an informational delta against a checked-in baseline) to CI, both required by `gate`.
- Fixed the CI test job never building before running tests, added a `ghantika` executable via `bin`/shebang/`prepack`, and updated dependencies.
- Bumped `typescript-eslint` to 8.65.0 and the `@modelcontextprotocol` SDK packages to 2.0.0-beta.5.
- Fixed the test suite hanging on Windows: added a 30-second per-test timeout and a 15-minute CI job timeout, and gave the handful of tests that exercise real POSIX process-group primitives (`pgrep`, `ps`, negative-pid signaling) a named skip on that platform instead of hanging indefinitely. Windows stays a fully supported platform and a fully supported CI leg; only these specific test-harness primitives lack a Windows-equivalent path today.
- Replaced the `node --test '<glob>'` invocation behind `npm test`/`npm run coverage` with `scripts/run-tests.mjs`, which discovers test files itself instead of handing a glob to a shell (the glob was reaching `cmd.exe` unexpanded on Windows and silently running zero tests) and adds two failure modes a per-test timeout can't catch on its own: an idle watchdog and a wall-clock cap that name the stuck test by file instead of leaving CI to die at the job ceiling with no diagnostic, plus a check for a file whose tests all pass but whose own process never exits.
