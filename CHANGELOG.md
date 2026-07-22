# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

- Added public CI on GitHub-hosted runners: build, typecheck, lint, and the full operating-system by Node-version test matrix, plus CodeQL, semgrep, zizmor, and actionlint, all aggregated behind one required `gate` check.
- Added a blocking Prettier format check and a coverage job (an absolute per-metric floor, plus an informational delta against a checked-in baseline) to CI, both required by `gate`.
- Fixed the `test` job never building before running tests, even though the suite imports from `dist/`: it now runs `npm run build` first, on every leg.
- Removed Windows from CI's test matrix for now: the `test` job runs `ubuntu-latest` and `macos-latest` only, each against Node 22 and 24. `windowsExtensionCandidates` (part of executable resolution) and the Windows process-tree kill path keep their existing local test coverage but no longer run against real Windows anywhere. The workflow-matrix and gate-dependency guards gained independent, hard-coded oracles so a coordinated edit to the workflow and to a guard's own expected-values constants can no longer both slip past unnoticed, and `continue-on-error` detection now catches an expression-valued or string setting, not just the literal boolean.
