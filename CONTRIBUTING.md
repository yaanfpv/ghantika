# Contributing

Contributions are welcome. Ghantika is a small project on purpose, so before you sink real time into something big, open an issue first and we'll figure out together whether it belongs here.

## Setting up

You'll need Node.js 22 or newer. Clone the repo and install with `npm ci`, not `npm install`. That keeps you on the exact dependency tree recorded in `package-lock.json` instead of whatever your local resolver feels like giving you.

```bash
npm ci
npm run build
npm test
```

## Before you open a PR

Run the same checks CI runs, so a typo doesn't cost you a round trip through a red build:

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

`npm run format` fixes most formatting issues on its own; `format:check` just tells you if something's off, the way CI checks it. CI also runs a coverage floor, CodeQL, semgrep, and a handful of other static scans, all rolled up behind one required `gate` check. If `gate` is green, everything underneath it passed too.

## What a good PR looks like

Keep it to one change. A drive-by fix for something unrelated is easier to review as its own PR anyway, even if it's small.

New behavior gets a new test, and a bug fix gets a test that fails without the fix and passes with it, so the regression can't quietly come back later. Write the PR description around why, not just what: if it fixes a bug, say what you actually saw before describing the fix.

## Reporting a bug

Open an issue with what you ran, what you expected, and what actually happened. A minimal repro, the smallest command or config that still shows the problem, saves everyone time chasing it.

## License

By contributing, you agree your changes are licensed under this project's MIT license.
