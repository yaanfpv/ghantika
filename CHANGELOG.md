# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

- Added public CI on GitHub-hosted runners: build, typecheck, lint, and the full operating-system by Node-version test matrix, plus CodeQL, semgrep, zizmor, and actionlint, all aggregated behind one required `gate` check.
- Added a blocking Prettier format check and a coverage job (an absolute per-metric floor, plus an informational delta against a checked-in baseline) to CI, both required by `gate`.
- Fixed the CI test job never building before running tests, added a `ghantika` executable via `bin`/shebang/`prepack`, and updated dependencies.
- Bumped `typescript-eslint` to 8.65.0 and the `@modelcontextprotocol` SDK packages to 2.0.0-beta.5.
