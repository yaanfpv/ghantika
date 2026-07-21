import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when this module was invoked directly (`node scripts/foo.mjs`)
 * rather than imported by another module (e.g. a test file pulling in
 * named exports).
 *
 * Two platform gotchas make a naive `import.meta.url === \`file://${argv[1]}\``
 * compare unreliable, and both are fixed here by decoding through
 * node:path/node:url/node:fs instead of manual string comparison:
 *
 *   1. Encoding: `import.meta.url` is percent-encoded (a space becomes
 *      `%20`) while `process.argv[1]` is a raw filesystem path, so the
 *      two silently diverge whenever the invoking path contains a space
 *      or other URL-reserved character - never throwing, just never
 *      matching, so the script's `main()` quietly never runs.
 *   2. Symlinks: Node's ESM loader resolves the entry point's real path
 *      when constructing `import.meta.url`, but `process.argv[1]` is
 *      never realpath'd. On macOS, `/tmp` and `/var` are themselves
 *      symlinks (`/var` -> `/private/var`), so a script invoked as
 *      `/var/folders/.../script.mjs` gets an `import.meta.url` rooted at
 *      `/private/var/folders/...` - a mismatch that has nothing to do
 *      with encoding at all.
 *
 * Realpath-ing `process.argv[1]` before comparing (matching what Node
 * already does internally for `import.meta.url`) fixes both.
 *
 * @param {string} moduleUrl - the calling module's `import.meta.url`
 * @returns {boolean}
 */
export function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(moduleUrl);
  const invokedPath = path.resolve(process.argv[1]);
  try {
    return modulePath === realpathSync(invokedPath);
  } catch {
    // The invoked path doesn't exist on disk (unusual, but not our
    // problem to throw over) - fall back to the un-realpath'd compare
    // rather than crashing the guard.
    return modulePath === invokedPath;
  }
}
