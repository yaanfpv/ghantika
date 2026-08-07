#!/usr/bin/env node
/**
 * Guards the `src/wake/` boundary: `wakeTransport.ts`
 * is the ONLY file under `src/wake/` whose exports may be imported from
 * outside `src/wake/` itself. Every other file that comes to live there (a
 * concrete transport - a future app-server transport, a future IPC
 * transport, a future selector that picks among them) is "its own module"
 * in that sense, and its symbols may appear only inside `src/wake/` or
 * inside a `test/wake-*.test.ts` file written to exercise it directly.
 *
 * With zero transports built yet, this check has
 * nothing to flag - it exists now, real and running, so the FIRST transport
 * file that gets imported from outside the family is caught the moment it
 * lands, rather than relying on every future PR remembering the boundary by
 * hand. Same shape and same shared AST toolkit as
 * `scripts/check-module-boundaries.mjs`'s sibling-import scan, inverted: that
 * guard stops `src/tools/*.ts` files reaching each other, this one stops
 * everything ELSE reaching INTO `src/wake/`'s non-public files.
 *
 * Two checks, both run by `checkWakeTransportBoundaries`:
 *
 *   1. findWakeBoundaryImports - scans every `.ts` file under `src/` and
 *      `test/` (excluding `src/wake/` itself, and excluding any
 *      `test/wake-*.test.ts`) for a module-loading construct whose RESOLVED
 *      TARGET sits inside `src/wake/` and is not `wakeTransport.ts`. Uses
 *      the same real resolver as `check-module-boundaries.mjs`
 *      (`resolveModuleSpecifierRealPath`), so a symlink, an absolute path,
 *      or an extensionless/directory specifier resolving into `src/wake/`
 *      is caught exactly as a plain relative specifier would be.
 *   2. an inline existence check - `src/wake/` and its public file must
 *      exist at all; an empty check that always passes because the
 *      directory never existed would be worse than no check.
 *
 * Disclosed scope boundary: this resolves specifiers against `src/` and
 * `test/` source text only - the same surface `check-module-boundaries.mjs`
 * covers for its own sibling-import rule. A `test/*.test.ts` file that
 * reaches a non-public transport's COMPILED output directly (this repo's
 * established `../dist/<module>.js` runtime-import convention, used
 * throughout `test/` for every other module) is not resolved back to its
 * `src/wake/` source and is not caught here. Production code never uses
 * that convention - only `src/`-relative specifiers, which this DOES
 * cover - so the live risk this guard exists for (a caller in `src/`
 * reaching into a transport's internals) is covered; a test author
 * deliberately routing around the public interface via `dist/` is not.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listTsFilesUnder } from "./check-module-boundaries.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import {
  collectModuleSpecifiers,
  parseSourceFile,
  resolveModuleSpecifierRealPath,
} from "./lib/ts-ast.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = path.join(REPO_ROOT, "src");
const TEST_DIR = path.join(REPO_ROOT, "test");
const WAKE_SUBDIR = "wake";

/** The one file under `src/wake/` whose exports may cross the boundary - see this file's header. */
export const WAKE_PUBLIC_FILE = "wakeTransport.ts";

/**
 * `realpathSync`, falling back to `path.resolve(absPath)` when the path
 * doesn't exist on disk yet - mirrors `check-module-boundaries.mjs`'s own
 * `realpathOrSelf` helper exactly, and for the same reason: a fixture test
 * writes only the file it's asserting about, not every intermediate
 * directory a bare `path.resolve` would otherwise silently under-resolve.
 * REQUIRED, not cosmetic - `resolveModuleSpecifierRealPath` (see
 * `findWakeBoundaryImports` below) always returns a REALPATH-resolved
 * target, so comparing it against a plain `path.resolve`d `src/wake/`
 * would false-negative on any host where a path in the tree crosses a
 * symlink - macOS resolves `/var` to `/private/var`, which is exactly
 * where `os.tmpdir()`-based fixtures (this file's own negative-control
 * tests included) live.
 */
function realpathOrSelf(absPath) {
  try {
    return realpathSync(absPath);
  } catch {
    return path.resolve(absPath);
  }
}

/** True when `filePathPosix` (posix-relative to the repo root) is a `test/wake-*.test.ts` file - the one class of file outside `src/wake/` permitted to reach a non-public wake file directly, to unit-test it. */
export function isPermittedWakeTestFile(filePathPosix) {
  const base = path.posix.basename(filePathPosix);
  return (
    path.posix.dirname(filePathPosix) === "test" &&
    base.startsWith("wake-") &&
    base.endsWith(".test.ts")
  );
}

/**
 * @param {string} candidateRealPath
 * @param {string} wakeDirRealPath
 * @returns {boolean} true when candidateRealPath sits inside wakeDirRealPath, segment-aware (never a bare string-prefix match)
 */
function isRealPathInsideWakeDir(candidateRealPath, wakeDirRealPath) {
  const rel = path.relative(wakeDirRealPath, candidateRealPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Scans `sourceText` (the contents of `importingFileAbsPath`, a file OUTSIDE
 * `src/wake/` and not a permitted wake test) for every module-loading
 * construct whose resolved target is a real file inside `src/wake/` other
 * than `WAKE_PUBLIC_FILE`.
 *
 * @param {string} sourceText
 * @param {string} importingFileAbsPath
 * @param {string} [wakeDirAbsPath]
 * @returns {string[]} the raw specifier text of each violation found
 */
export function findWakeBoundaryImports(
  sourceText,
  importingFileAbsPath,
  wakeDirAbsPath = path.join(SRC_DIR, WAKE_SUBDIR)
) {
  const hits = [];
  const sourceFile = parseSourceFile(importingFileAbsPath, sourceText);
  const wakeDirReal = realpathOrSelf(wakeDirAbsPath);
  const publicFileReal = realpathOrSelf(path.join(wakeDirAbsPath, WAKE_PUBLIC_FILE));

  for (const { text: specifier } of collectModuleSpecifiers(sourceFile)) {
    if (specifier === undefined) continue;

    const resolvedReal = resolveModuleSpecifierRealPath(specifier, importingFileAbsPath);
    if (resolvedReal === undefined) continue;
    if (resolvedReal === publicFileReal) continue; // the one permitted door
    if (isRealPathInsideWakeDir(resolvedReal, wakeDirReal)) {
      hits.push(specifier);
    }
  }
  return hits;
}

/**
 * Runs the boundary scan across the real repo tree: every `.ts` file under
 * `src/` (excluding `src/wake/` itself) and every `.ts` file under `test/`
 * (excluding `test/wake-*.test.ts`).
 *
 * @param {string} [srcDir]
 * @param {string} [testDir]
 * @returns {string[]} every violation found, empty when clean
 */
export function checkWakeTransportBoundaries(srcDir = SRC_DIR, testDir = TEST_DIR) {
  const violations = [];
  const wakeDirAbs = path.join(srcDir, WAKE_SUBDIR);

  for (const file of listTsFilesUnder(srcDir)) {
    if (file.startsWith(`${WAKE_SUBDIR}/`)) continue; // src/wake/ never scans itself
    const abs = path.join(srcDir, file);
    const text = readFileSync(abs, "utf8");
    for (const specifier of findWakeBoundaryImports(text, abs, wakeDirAbs)) {
      violations.push(
        `src/${file}: imports "${specifier}" - only src/wake/${WAKE_PUBLIC_FILE} may be imported from outside src/wake/`
      );
    }
  }

  for (const file of listTsFilesUnder(testDir)) {
    const filePosix = path.posix.join("test", file);
    if (isPermittedWakeTestFile(filePosix)) continue; // a wake-*.test.ts may reach its own transport directly
    const abs = path.join(testDir, file);
    const text = readFileSync(abs, "utf8");
    for (const specifier of findWakeBoundaryImports(text, abs, wakeDirAbs)) {
      violations.push(
        `test/${file}: imports "${specifier}" - only src/wake/${WAKE_PUBLIC_FILE} may be imported outside a test/wake-*.test.ts file`
      );
    }
  }

  if (!existsSync(wakeDirAbs)) {
    violations.push("src/wake/ does not exist - nothing to guard, which is itself the violation");
  } else if (!existsSync(path.join(wakeDirAbs, WAKE_PUBLIC_FILE))) {
    violations.push(
      `src/wake/${WAKE_PUBLIC_FILE} does not exist - the one permitted door is missing`
    );
  }

  return violations;
}

function main() {
  const violations = checkWakeTransportBoundaries();
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(violation);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `wake transport boundaries clean: only src/wake/${WAKE_PUBLIC_FILE} is reachable from outside src/wake/`
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
