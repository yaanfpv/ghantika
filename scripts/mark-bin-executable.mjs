#!/usr/bin/env node
/**
 * Marks every path package.json's own "bin" field points at as directly
 * executable (0755) on POSIX. `tsc` truncates and rewrites `dist/index.js`
 * on every build, which resets its mode back to whatever the process
 * umask leaves a freshly-created file at (typically 0644) even after a
 * prior run of this same script already set it executable - so this has
 * to run again after every `tsc` invocation, not once. It is wired in as
 * the second half of the `build` script for exactly that reason.
 *
 * `npm pack`/`npm publish` preserve whatever mode a "bin" file already has
 * on disk at pack time rather than forcing it themselves (verified
 * directly against a real `npm pack --json` run: an unfixed 0644 source
 * file packed as 0644, byte-identical mode bits, no silent
 * normalization) - so a 0644 `dist/index.js` ships as a non-executable
 * file in the published tarball, and `npx ghantika`/a global `bin` link
 * would need a `node` prefix to run it. This script is what makes the
 * compiled entry directly runnable once npm links or installs it, with
 * no such prefix required.
 *
 * Windows has no POSIX permission bits - npm generates its own
 * `.cmd`/`.ps1` launcher shims there instead of relying on the file's own
 * mode, so `fs.chmodSync` is a harmless no-op on that platform rather
 * than an error, and this script runs unconditionally on every OS.
 */
import { chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

/** @type {unknown} */
const bin = pkg.bin;
const targets =
  typeof bin === "string"
    ? [bin]
    : bin && typeof bin === "object"
      ? Object.values(bin).filter((value) => typeof value === "string")
      : [];

if (targets.length === 0) {
  console.error('mark-bin-executable: package.json has no "bin" entries to mark executable');
  process.exitCode = 1;
} else {
  for (const target of targets) {
    chmodSync(path.join(REPO_ROOT, target), 0o755);
  }
}
