# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

- Added public CI on GitHub-hosted runners: build, typecheck, lint, and an operating-system by Node-version test matrix, plus CodeQL, semgrep, zizmor, and actionlint, all aggregated behind one required `gate` check.
- Added a blocking Prettier format check and a coverage job (an absolute per-metric floor, plus an informational delta against a checked-in baseline) to CI, both required by `gate`.
- Fixed the `test` job never building before running tests, even though the suite imports from `dist/`: it now runs `npm run build` first, on every leg. The `coverage` script had the identical gap since this repo's very first commit - the `test` script already built first, `coverage` never did - fixed the same way.
- Removed Windows from CI's test matrix for now: the `test` job runs `ubuntu-latest` and `macos-latest` only, each against Node 22 and 24. There is no Windows CI signal of any kind right now - no hosted leg, no VM, no nightly substitute.
- `windowsExtensionCandidates` (part of executable resolution) remains live production code but is now verified only by reading, not by execution, and the Windows process-tree kill path's own test degrades to shape-only coverage, both for the same reason: nothing exercises either against a real Windows host anymore.
- Hardened the workflow-matrix and gate-dependency guards: each derived its own expected values from the same workflow file it checks, so shrinking the workflow and a guard's own expected-values constants together used to slip past unnoticed. Each guard now also carries an independent, hard-coded expectation living only in its test file, so shrinking the workflow and a guard's expected values together now also has to change a hard-coded list in the test file.
- `continue-on-error` detection now catches a quoted string or a GitHub Actions expression, not just the literal boolean `true`, since GitHub treats all three identically at runtime.
- Three semgrep findings are suppressed with an inline justification rather than changed: running a caller-supplied shell command through a real shell is this tool's own documented `run` feature, and two diagnostic log lines that include a job id use this codebase's own generated id, never anything attacker-supplied.
