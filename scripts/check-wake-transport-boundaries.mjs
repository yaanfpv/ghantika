#!/usr/bin/env node
/**
 * Guards the `src/wake/` boundary: `WAKE_PUBLIC_FILES` names the exact,
 * small set of files under `src/wake/` whose exports may be imported from
 * outside `src/wake/` itself - `wakeTransport.ts` (the shared, type-only
 * contract every transport and the selector implement against),
 * `selectTransport.ts` (the ordered-selection function a real caller
 * actually invokes to request a wake), and `resolveWakeTarget.ts` (the pure
 * function that resolves a `WakeTarget` from an incoming `tools/call`
 * request's own `_meta`, without ever fabricating one). Three public
 * doors, not one: the selector has to import both concrete transports to
 * do its job, which no single-file design can satisfy without either
 * breaking `wakeTransport.ts`'s own zero-runtime contract or exposing a
 * transport's internals directly; `resolveWakeTarget.ts` is admitted as a
 * genuine THIRD door because `src/server.ts` needs to call it directly, at
 * the same `tools/call` `run`-branch call site that already reads the
 * request's own capability declaration, to resolve the wake target BEFORE
 * handing it to `src/tasksAdapter.ts` - the same bar `selectTransport.ts`
 * itself had to clear (a caller genuinely outside the `src/wake/` family
 * needing to reach it directly, not merely a convenience). Every OTHER file
 * that comes to live in `src/wake/` (today: `appServerTransport.ts`,
 * `desktopIpcTransport.ts`; tomorrow, any further transport) is "its own
 * module" in that sense, and its symbols may appear only inside
 * `src/wake/`, inside a `test/wake-*.test.ts` file written to exercise it
 * directly, or inside a `test/fixtures/wake-*.ts` fixture one of those test
 * files spawns as a real, separate OS process (see "Disclosed scope
 * boundary" below for the one, already-real, case of this).
 *
 * Two transports are built now (`appServerTransport.ts`,
 * `desktopIpcTransport.ts`), plus the selector that orders between them
 * (`selectTransport.ts`) - but nothing outside `src/wake/` imports either
 * concrete transport directly yet, so this check still has nothing to
 * flag on THAT pair in the real tree today; `resolveWakeTarget.ts` IS now
 * imported from outside the family (`src/server.ts`), which is exactly the
 * admitted case above, not a violation. It exists anyway, real and
 * running, so the moment a transport-specific file (rather than one of the
 * three admitted public doors) gets imported from outside the family, it
 * is caught the instant it lands, rather than relying on every future PR
 * remembering the boundary by hand. Same shape and same shared AST toolkit
 * as `scripts/check-module-boundaries.mjs`'s sibling-import scan, inverted:
 * that guard stops `src/tools/*.ts` files reaching each other, this one
 * stops everything ELSE reaching INTO `src/wake/`'s non-public files.
 *
 * Two checks, both run by `checkWakeTransportBoundaries`:
 *
 *   1. findWakeBoundaryImports - scans every `.ts` file under `src/` and
 *      `test/` (excluding `src/wake/` itself, and excluding any file
 *      `isPermittedWakeTestFile` admits - a `test/wake-*.test.ts` file, or
 *      a `test/fixtures/wake-*.ts` fixture one of those spawns) for a
 *      module-loading construct whose RESOLVED TARGET sits inside
 *      `src/wake/` and is not one of `WAKE_PUBLIC_FILES`.
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
 * covers for its own sibling-import rule. A test file that reaches a
 * non-public transport's COMPILED output directly (this repo's established
 * `../dist/<module>.js` runtime-import convention, used throughout `test/`
 * for every other module) is not resolved back to its `src/wake/` source
 * and is not caught here - and this is not a hypothetical: `test/fixtures/
 * wake-app-server-crash-harness.ts` already does exactly this, importing
 * `appServerTransport.ts` (a non-public file) via
 * `../../dist/wake/appServerTransport.js` so it can run as a genuinely
 * separate OS process rather than in-process code the test runner loaded
 * (see that file's own header comment). `isPermittedWakeTestFile` names
 * this fixture, and the narrow `test/fixtures/wake-*.ts` convention it
 * belongs to, an explicit exemption for exactly this reason, rather than
 * leaving it an accident of this scope boundary alone. Production code
 * never uses the `dist/` convention - only `src/`-relative specifiers,
 * which this DOES cover - so the live risk this guard exists for (a caller
 * in `src/` reaching into a transport's internals) is covered; a test
 * file's own `dist/`-routed reach into a non-public transport, to run it
 * as a real subprocess, is a known and accepted route, not a gap this
 * guard is trying to close.
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
export const WAKE_PUBLIC_FILES = new Set([
  "wakeTransport.ts",
  "selectTransport.ts",
  "resolveWakeTarget.ts",
]);

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

/**
 * True when `filePathPosix` (posix-relative to the repo root) is one of the
 * two classes of file outside `src/wake/` permitted to reach a non-public
 * wake file directly:
 *
 *   - a `test/wake-*.test.ts` file, written to unit-test a transport
 *     directly, or
 *   - a `test/fixtures/wake-*.ts` fixture spawned as a real, separate OS
 *     process by one of those test files - `test/fixtures/
 *     wake-app-server-crash-harness.ts` is the live instance of this today
 *     (see this file's header, "Disclosed scope boundary").
 *
 * Deliberately narrow on both branches - `wake-` only, directly under
 * `test/` or `test/fixtures/` respectively, never every file those two
 * directories happen to contain.
 */
export function isPermittedWakeTestFile(filePathPosix) {
  const dir = path.posix.dirname(filePathPosix);
  const base = path.posix.basename(filePathPosix);
  if (dir === "test" && base.startsWith("wake-") && base.endsWith(".test.ts")) {
    return true;
  }
  if (dir === "test/fixtures" && base.startsWith("wake-") && base.endsWith(".ts")) {
    return true;
  }
  return false;
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
 * (excluding whatever `isPermittedWakeTestFile` admits - a
 * `test/wake-*.test.ts` file, or a `test/fixtures/wake-*.ts` fixture one of
 * those spawns).
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
    if (isPermittedWakeTestFile(filePosix)) continue; // a wake-*.test.ts, or a test/fixtures/wake-*.ts fixture it spawns, may reach its own transport directly
    const abs = path.join(testDir, file);
    const text = readFileSync(abs, "utf8");
    for (const specifier of findWakeBoundaryImports(text, abs, wakeDirAbs)) {
      violations.push(
        `test/${file}: imports "${specifier}" - only ${publicDoorList} may be imported outside a test/wake-*.test.ts file or a test/fixtures/wake-*.ts fixture it spawns`
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
