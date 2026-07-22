# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

- Added public CI on GitHub-hosted runners: build, typecheck, lint, and the full operating-system by Node-version test matrix, plus CodeQL, semgrep, zizmor, and actionlint, all aggregated behind one required `gate` check.
- Added a blocking Prettier format check and a coverage job (an absolute per-metric floor, plus an informational delta against a checked-in baseline) to CI, both required by `gate`.
- Fixed the CI test job never building before running tests, added a `ghantika` executable via `bin`/shebang/`prepack`, and updated dependencies.
- Bumped `typescript-eslint` to 8.65.0 and the `@modelcontextprotocol` SDK packages to 2.0.0-beta.5.
- Fixed the test suite hanging on Windows: added a 30-second per-test timeout and a 15-minute CI job timeout, and gave the handful of tests that exercise real POSIX process-group primitives (`pgrep`, `ps`, negative-pid signaling) a named skip on that platform instead of hanging indefinitely - a harness limitation, not a decision to drop Windows. Windows is a platform this project is actively working to bring to green CI; it isn't there yet, and the remaining gaps go beyond those named skips.
- Replaced the `node --test '<glob>'` invocation behind `npm test`/`npm run coverage` with `scripts/run-tests.mjs`, which discovers test files itself instead of handing a glob to a shell (the glob was reaching `cmd.exe` unexpanded on Windows and silently running zero tests) and adds two separate diagnostics a per-test timeout can't produce on its own: an idle watchdog that names every file with no completion event of its own once nothing has happened for too long, without attributing a cause, plus a wall-clock cap for the whole run; and a distinct check for a run that finished normally and then failed to drain, a different failure shape than a file stalling mid-run.
- Removed a temporary Windows diagnostic workflow: its two timeout bounds were composed so its own pass condition could never be reached on any run, by construction, which made its intended product-file diagnosis uninterpretable. The real CI gate reproduces the underlying Windows test failures independently of it.
