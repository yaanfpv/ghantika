#!/usr/bin/env node
/**
 * Guards the `src/wake/` boundary: `WAKE_PUBLIC_FILES` names the exact,
 * small set of files under `src/wake/` whose exports may be imported from
 * outside `src/wake/` itself - today, `wakeTransport.ts` (the shared,
 * type-only contract every transport and the selector implement against)
 * and `selectTransport.ts` (the ordered-selection function a real caller
 * actually invokes to request a wake). Two public doors, not one: the
 * selector has to import both concrete transports to do its job, which no
 * single-file design can satisfy without either breaking
 * `wakeTransport.ts`'s own zero-runtime contract or exposing a transport's
 * internals directly. Every OTHER file that comes to live in `src/wake/`
 * (today: `appServerTransport.ts`, `desktopIpcTransport.ts`; tomorrow, any
 * further transport) is "its own module" in that sense, and its symbols
 * may appear only inside `src/wake/` or inside a `test/wake-*.test.ts`
 * file written to exercise it directly.
 *
 * Two transports are built now (`appServerTransport.ts`,
 * `desktopIpcTransport.ts`), plus the selector that orders between them
 * (`selectTransport.ts`) - but nothing outside `src/wake/` imports either
 * concrete transport directly yet, so this check still has nothing to
 * flag in the real tree today. It exists anyway, real and running, so the
 * moment a transport-specific file (rather than one of the two admitted
 * public doors) gets imported from outside the family, it is caught the
 * instant it lands, rather than relying on every future PR remembering
 * the boundary by hand. Same shape and same shared AST toolkit as
 * `scripts/check-module-boundaries.mjs`'s sibling-import scan, inverted: that
 * guard stops `src/tools/*.ts` files reaching each other, this one stops
 * everything ELSE reaching INTO `src/wake/`'s non-public files.
 *
 * Two checks, both run by `checkWakeTransportBoundaries`:
 *
 *   1. findWakeBoundaryImports - scans every `.ts` file under `src/` and
 *      `test/` (excluding `src/wake/` itself, and excluding any
 *      `test/wake-*.test.ts`) for a module-loading construct whose RESOLVED
 *      TARGET sits inside `src/wake/` and is not one of `WAKE_PUBLIC_FILES`.
 *      Uses the same real resolver as `check-module-boundaries.mjs`
 *      (`resolveModuleSpecifierRealPath`), so a symlink, an absolute path,
 *      or an extensionless/directory specifier resolving into `src/wake/`
 *      is caught exactly as a plain relative specifier would be.
 *   2. an inline existence check - `src/wake/` and every file named in
 *      `WAKE_PUBLIC_FILES` must exist; an empty check that always passes
 *      because the directory (or one of its public files) never existed
 *      would be worse than no check.
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

/**
 * The exact, small set of files under `src/wake/` whose exports may cross
 * the boundary - see this file's header. Deliberately a `Set`, not a
 * single string: keep this narrow and explicit by construction, since a
 * boundary guard that admits "everything under `src/wake/`" is no guard
 * at all. Never add a file here for convenience - only for a genuine
 * second (or later) public door that needs to be reachable from outside
 * the family, the same bar `selectTransport.ts` had to clear.
 */
export const WAKE_PUBLIC_FILES = new Set(["wakeTransport.ts", "selectTransport.ts"]);

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
 * than one of `WAKE_PUBLIC_FILES`.
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
  const publicFileReals = new Set(
    [...WAKE_PUBLIC_FILES].map((publicFile) =>
      realpathOrSelf(path.join(wakeDirAbsPath, publicFile))
    )
  );

  for (const { text: specifier } of collectModuleSpecifiers(sourceFile)) {
    if (specifier === undefined) continue;

    const resolvedReal = resolveModuleSpecifierRealPath(specifier, importingFileAbsPath);
    if (resolvedReal === undefined) continue;
    if (publicFileReals.has(resolvedReal)) continue; // one of the permitted doors
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
  const publicDoorList = [...WAKE_PUBLIC_FILES].map((file) => `src/wake/${file}`).join(" or ");

  for (const file of listTsFilesUnder(srcDir)) {
    if (file.startsWith(`${WAKE_SUBDIR}/`)) continue; // src/wake/ never scans itself
    const abs = path.join(srcDir, file);
    const text = readFileSync(abs, "utf8");
    for (const specifier of findWakeBoundaryImports(text, abs, wakeDirAbs)) {
      violations.push(
        `src/${file}: imports "${specifier}" - only ${publicDoorList} may be imported from outside src/wake/`
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
        `test/${file}: imports "${specifier}" - only ${publicDoorList} may be imported outside a test/wake-*.test.ts file`
      );
    }
  }

  if (!existsSync(wakeDirAbs)) {
    violations.push("src/wake/ does not exist - nothing to guard, which is itself the violation");
  } else {
    for (const publicFile of WAKE_PUBLIC_FILES) {
      if (!existsSync(path.join(wakeDirAbs, publicFile))) {
        violations.push(`src/wake/${publicFile} does not exist - a permitted door is missing`);
      }
    }
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
  const publicDoorList = [...WAKE_PUBLIC_FILES].map((file) => `src/wake/${file}`).join(" and ");
  console.log(
    `wake transport boundaries clean: only ${publicDoorList} are reachable from outside src/wake/`
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
