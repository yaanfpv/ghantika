#!/usr/bin/env node
/**
 * Guards the frozen module ownership for `src/`: exactly the modules
 * named in FROZEN_MODULES below (`server.ts`, `registry.ts`, `jobStore.ts`,
 * `process.ts`, `policy.ts`, `scheduler.ts`, `tasksAdapter.ts`, the six
 * `tools/*.ts` handler files, `wake/wakeTransport.ts`, and
 * `wake/desktopIpcTransport.ts`), no more, no fewer - `src/index.ts` is
 * deliberately excluded, since it's the package's public entry point
 * (`package.json`'s `"main"`/`"types"`), not one of the six-tool
 * architecture's internal modules.
 *
 * `wake/wakeTransport.ts` is admitted here the same way
 * `tasksAdapter.ts` was: this check governs WHICH FILES may exist, not a
 * blanket ban on new modules - a type-only interface file with zero
 * runtime exports carries no state and imports nothing, so it is scanned
 * by the persistent-state check below like every other root-level file and
 * will always pass. Its OWN boundary (no transport-specific symbol may
 * leak outside `src/wake/`) is a distinct concern enforced separately by
 * `scripts/check-wake-transport-boundaries.mjs`, not by this file.
 *
 * `wake/desktopIpcTransport.ts` is admitted the same way: the first
 * CONCRETE `WakeTransport` implementation, carrying real runtime state
 * (`IpcConnection`'s own `pending`/`fatal` fields, `IpcFrameDecoder`'s own
 * `buffer`) - all of it genuinely per-connection instance state on classes
 * this file's own state scan never treats specially, never a module-scope
 * Map/Set/mutable accumulator of the shape this check actually forbids, so
 * it passes the persistent-state scan on its own merits rather than
 * needing an exclusion.
 *
 * Three checks, matching this repo's established guard style (see
 * scripts/check-npm-ci-usage.mjs): pure, exported functions that operate
 * on file paths and source text, a thin `main()` that reports every
 * violation, and a real filesystem walk rather than a hardcoded file
 * list, so an added or removed file is caught structurally.
 *
 *   1. checkFrozenModuleSet - the exact set of `.ts` files under `src/`
 *      (excluding index.ts) must equal FROZEN_MODULES. Catches both an
 *      extra file appearing anywhere in `src/` and the six tool handlers
 *      being collapsed into fewer files (or split into more).
 *   2. findSiblingToolImports - no file under `src/tools/` may load
 *      (however it does so - a static/dynamic import, `import.meta.resolve`,
 *      or CommonJS `require`/`createRequire`) another file under
 *      `src/tools/`, whether named directly or reached transitively
 *      through a permitted re-export barrel. Two resolution layers: a fast
 *      path of relative-specifier path arithmetic (unchanged from this
 *      guard's original design, and still what most of this file's own
 *      fixture-based tests exercise, since it works even when the
 *      referenced file doesn't exist on disk), plus a real resolver
 *      (`resolveModuleSpecifierRealPath` in scripts/lib/ts-ast.mjs) that
 *      canonicalizes through Node's own CJS resolution + `realpathSync` -
 *      catching an absolute path, a `file://` URL, a package/subpath-import
 *      alias, an extensionless or directory-index specifier, and a symlink
 *      whose real target sits inside `tools/` even when the symlink's OWN
 *      path does not, none of which the fast path alone can see.
 *   3. findPersistentStateDeclarations - no file under `src/tools/`, and
 *      no OTHER core module either (`server.ts`/`registry.ts`/`process.ts`)
 *      may declare its own persistent buffer/state. Only `jobStore.ts`
 *      may - see its own doc comment for why; it is therefore never
 *      scanned by this check at all. Two independent signals, both real
 *      AST checks (see scripts/lib/ts-ast.mjs's header for why AST, not
 *      regex): a `new Map(`/`new Set(`/`new WeakMap(`/`new WeakSet(`/
 *      `Array(`/`new Array(`/`Object(`/`new Object(` construction
 *      anywhere in the file (state-shaped even if assigned to a `const`,
 *      since the *reference* being immutable doesn't make the container
 *      itself immutable) UNLESS it's immediately member-accessed with no
 *      binding at all (structurally transient - nothing can reach it
 *      again after the expression evaluates); and, at module (top-level,
 *      not nested in a function/block) scope specifically, any `let`/`var`
 *      declaration (a plain mutable array/object/counter that isn't a
 *      Map/Set at all) OR a `const` bound directly to an EMPTY array/
 *      object literal (a plain mutable accumulator that starts empty and
 *      grows via `.push`/property writes later).
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";
import {
  collectModuleSpecifiers,
  findCreateRequireImports,
  forEachDescendant,
  isDynamicImportCall,
  isRequireCall,
  parseSourceFile,
  resolveModuleSpecifierRealPath,
  ts,
} from "./lib/ts-ast.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = path.join(REPO_ROOT, "src");

// The frozen module list, posix-relative to src/.
// `src/index.ts` is deliberately excluded - see this file's header.
//
// `tasksAdapter.ts` is the single permitted
// io.modelcontextprotocol/tasks-import site - see
// `scripts/check-no-tasks-import.mjs`'s adapter carveout. It is scanned by
// EVERY check this file runs exactly like every other frozen module
// (the frozen-set membership check, and - since it is not in
// STATE_SCAN_EXCLUDED_ROOT_FILES - the persistent-state scan too, so it
// may never grow its own Map/Set/mutable module state either): admitting
// it here widens WHICH FILE is allowed to exist, not what rules apply to
// it once it does.
//
// `scheduler.ts` is the concurrency-cap/queue-depth admission POLICY -
// deliberately holds no state of its own (see its own header), so it too
// is scanned for persistent state like every other module here, not
// excluded the way `jobStore.ts` is (the real active-slot count and queue
// array live in `jobStore.ts`, the sole designated state owner).
export const FROZEN_MODULES = [
  "jobStore.ts",
  "policy.ts",
  "process.ts",
  "registry.ts",
  "scheduler.ts",
  "server.ts",
  "tasksAdapter.ts",
  "tools/kill.ts",
  "tools/list.ts",
  "tools/output.ts",
  "tools/run.ts",
  "tools/status.ts",
  "tools/tail.ts",
  "wake/desktopIpcTransport.ts",
  "wake/wakeTransport.ts",
];

export const TOOLS_SUBDIR = "tools";

// Root-level files (never under tools/) that the persistent-state scan
// deliberately does NOT cover: `jobStore.ts` is the one designated state
// owner (never scanned for its own legitimate state), and `index.ts` is
// the public entry point, not one of the frozen internal modules at all
// (see this file's header).
const STATE_SCAN_EXCLUDED_ROOT_FILES = new Set(["index.ts", "jobStore.ts"]);

/**
 * Recursively lists every `.ts` file under `dir`, as posix-style paths
 * relative to `dir`. Returns an empty list (rather than throwing) when
 * `dir` doesn't exist, matching this repo's established
 * listFilesUnder-style tolerance for a not-yet-created directory.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listTsFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      for (const nested of listTsFilesUnder(full)) {
        out.push(path.posix.join(dirent.name, nested));
      }
    } else if (dirent.isFile() && dirent.name.endsWith(".ts")) {
      out.push(dirent.name);
    }
  }
  return out;
}

/**
 * @param {string} [srcDir]
 * @returns {{ extra: string[], missing: string[] }} both empty when the
 *   frozen set is exactly satisfied
 */
export function checkFrozenModuleSet(srcDir = SRC_DIR) {
  const actual = new Set(listTsFilesUnder(srcDir).filter((file) => file !== "index.ts"));
  const expected = new Set(FROZEN_MODULES);
  const extra = [...actual].filter((file) => !expected.has(file)).sort();
  const missing = [...expected].filter((file) => !actual.has(file)).sort();
  return { extra, missing };
}

/**
 * Label pushed into `findSiblingToolImports`'s hits for a dynamic
 * `import()` or `require()` call whose argument can't be resolved
 * statically (a variable, string concatenation, an interpolated
 * template). The mechanism used to LOAD a module never changes what it
 * ultimately resolves to, so a computed specifier is exactly the kind of
 * thing that could smuggle a sibling import past a purely-static check -
 * this fails CLOSED (reports it as a violation) rather than silently
 * passing it through, the same principle `check-no-tasks-import.mjs`
 * already applies to its own unresolvable dynamic imports.
 */
const UNRESOLVABLE_SIBLING_SPECIFIER_LABEL =
  "<dynamic import()/require() with a computed/non-literal specifier - cannot statically verify it avoids a sibling tools/*.ts file, failing closed>";

/**
 * Builds the violation label for a `findCreateRequireImports` hit,
 * describing the exact binding shape found - see that function's own doc
 * comment in scripts/lib/ts-ast.mjs for why each shape is forbidden
 * outright, independent of the local alias chosen or whether the returned
 * loader is ever called. This is the ONLY layer `findSiblingToolImports`
 * uses to flag `createRequire`: it resolves the IMPORT BINDING itself, so
 * an aliased `import { createRequire as makeLoader } from "node:module"`
 * is caught at the import site regardless of what local name follows -
 * a name-only callee check would need to see past that alias to catch the
 * later `makeLoader(...)` call, which it structurally cannot do.
 *
 * @param {"named" | "namespace" | "default" | "dynamic-import" | "import-equals" | "commonjs-require" | "module-require" | "eval-call" | "function-constructor-call" | "re-export-named" | "re-export-namespace" | "unresolvable-globalthis-access" | "process-dangerous-property-access" | "unresolvable-process-access" | "reflect-reference" | "constructor-property-access" | "property-descriptor-access"} kind
 * @returns {string}
 */
function createRequireImportBindingLabel(kind) {
  switch (kind) {
    case "property-descriptor-access":
      return "<reads Object.getOwnPropertyDescriptor(target, key) where key resolves to a banned identifier - constructor, one of the four bare globals off globalThis, or a dangerous process property - a descriptor read reaches the same value a direct property access would without ever writing the identifier as a property-access key, so it's forbidden at the point of the descriptor call itself, unconditional on whether .value/.get is later extracted>";
    case "process-dangerous-property-access":
      return "<references one of process's dangerous properties (getBuiltinModule, dlopen, or binding) - directly, or through one local alias hop - each a route to native/builtin-loading capability with no import/require syntax naming its target anywhere, forbidden outright at the point of reference the same as the four bare globals, regardless of what specifier it is later called with or how the reference is stored/aliased>";
    case "unresolvable-process-access":
      return "<accesses a computed property of process whose key can't be resolved statically - cannot verify it avoids .getBuiltinModule, failing closed>";
    case "reflect-reference":
      return "<references the global Reflect - forbidden outright at the point of reference, whether called, stored, passed, bound, or never used, unless the name resolves to a local shadow, the same reasoning and the same shadow exception as module: zero legitimate use, banned outright rather than trying to enumerate which of its methods could reach a forbidden primitive>";
    case "constructor-property-access":
      return "<reads a .constructor property - reachable off ANY value, not just an unshadowed global, so this is flagged unconditionally on the base expression, the same acquisition-site principle as the bare globals but applied to a universal property instead of a lexical name>";
    case "namespace":
      return '<imports the whole node:module namespace ("import * as ...") - exposes createRequire via property access, forbidden outright the same as importing createRequire by name, regardless of the local namespace alias chosen>';
    case "default":
      return "<default-imports node:module - exposes createRequire via property access, forbidden outright the same as importing createRequire by name, regardless of the local default-import alias chosen>";
    case "dynamic-import":
      return '<dynamically imports node:module ("await import(...)"/".then(...)") - reaches createRequire the same as a static import, forbidden outright regardless of how the resulting namespace is destructured or consumed>';
    case "import-equals":
      return '<TypeScript import-equals form ("import X = require(...)") binds the whole node:module namespace - exposes createRequire via property access, forbidden outright the same as a default/namespace import>';
    case "commonjs-require":
      return "<references the global require - forbidden outright at the point of reference, whether called, stored, passed, bound, or never used, unless the name resolves to a local shadow (a parameter, a locally declared or imported binding)>";
    case "module-require":
      return "<references the global module (Node's CommonJS module object, from which .require is reachable) - forbidden outright at the point of reference for the same reason and with the same shadow exception as require, however the reference is spelled: dotted, computed, aliased, destructured, or reached via globalThis>";
    case "eval-call":
      return "<references the global eval - forbidden outright at the point of reference, whether called, stored, passed, bound, or never used, unless the name resolves to a local shadow>";
    case "function-constructor-call":
      return "<references the global Function constructor - forbidden outright at the point of reference, whether called (with or without new), stored, passed, bound, or never used, unless the name resolves to a local shadow>";
    case "re-export-named":
      return '<re-exports createRequire from node:module ("export { createRequire as ... } from ...") - hands the capability to whatever module imports the re-exported name, forbidden outright regardless of the exported alias chosen>';
    case "re-export-namespace":
      return '<re-exports the whole node:module namespace ("export * from ..."/"export * as ... from ...") - exposes createRequire transitively to every consumer of the re-export, forbidden outright the same as a namespace import>';
    case "unresolvable-globalthis-access":
      return "<accesses a computed property of globalThis whose key can't be resolved statically - cannot verify it avoids the four forbidden globals, failing closed>";
    case "named":
    default:
      return '<imports createRequire from node:module (or its unprefixed "module" form) - CommonJS interop is forbidden anywhere in this frozen ESM architecture, regardless of the local alias chosen>';
  }
}

/**
 * True when `path.relative(dirRealPath, candidateRealPath)` shows
 * `candidateRealPath` sitting genuinely INSIDE `dirRealPath` - segment-
 * aware, so a sibling directory that merely shares a string prefix (e.g.
 * `tools-backup/` alongside `tools/`) is never mistaken for a subdirectory
 * the way a naive `startsWith` string compare would be.
 */
function isRealPathInsideDir(candidateRealPath, dirRealPath) {
  const rel = path.relative(dirRealPath, candidateRealPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** `realpathSync`, falling back to the path as given when it doesn't exist on disk - most of this guard's own fixture-based tests never write the importing file itself to disk. */
function realpathOrSelf(absPath) {
  try {
    return realpathSync(absPath);
  } catch {
    return absPath;
  }
}

const MAX_TRANSITIVE_BARREL_HOPS = 8;

/**
 * Follows the module-specifier graph starting from `fileRealAbsPath` - a
 * REAL file that resolved OUTSIDE `toolsDirRealAbsPath` (a permitted,
 * directly-named import) - looking for a specifier that resolves,
 * possibly several hops away, to a REAL file INSIDE `toolsDirRealAbsPath`.
 * This is what closes a re-export BARREL (`export * from
 * "./tools/sibling.js"`) or an ordinary import chain that transitively
 * pulls a sibling in without the importING file ever naming it directly -
 * a specifier check that only ever inspects the DIRECTLY-named target
 * would see a barrel import as a legitimate non-sibling reference and
 * never look further.
 *
 * Bounded (`MAX_TRANSITIVE_BARREL_HOPS`) and cycle-safe
 * (`visitedRealPaths` accumulates every real path already followed, so a
 * re-export graph that cycles back on itself terminates instead of
 * looping forever), and deliberately never follows into `node_modules` -
 * this guard's job is catching an internal barrel indirection, not
 * scanning arbitrary vendored dependency trees. Genuinely different from
 * every other check in this file: it reads files off disk the CALLER
 * never asked about, since following a barrel means inspecting files
 * beyond the one the caller already has the text of.
 *
 * @returns {string | undefined} the real path of the first sibling file
 *   reached transitively, or `undefined` if none is reached within budget
 */
function findTransitiveSiblingThroughReExports(
  fileRealAbsPath,
  toolsDirRealAbsPath,
  visitedRealPaths
) {
  if (visitedRealPaths.has(fileRealAbsPath)) return undefined;
  visitedRealPaths.add(fileRealAbsPath);
  if (visitedRealPaths.size > MAX_TRANSITIVE_BARREL_HOPS) return undefined;
  if (fileRealAbsPath.split(path.sep).includes("node_modules")) return undefined;

  let text;
  try {
    text = readFileSync(fileRealAbsPath, "utf8");
  } catch {
    return undefined; // not a real, readable file - nothing to follow
  }

  const barrelSourceFile = parseSourceFile(fileRealAbsPath, text);
  for (const { text: specifier } of collectModuleSpecifiers(barrelSourceFile)) {
    if (specifier === undefined) continue;
    const resolvedReal = resolveModuleSpecifierRealPath(specifier, fileRealAbsPath);
    if (resolvedReal === undefined) continue;
    if (isRealPathInsideDir(resolvedReal, toolsDirRealAbsPath)) {
      return resolvedReal;
    }
    const deeper = findTransitiveSiblingThroughReExports(
      resolvedReal,
      toolsDirRealAbsPath,
      visitedRealPaths
    );
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

/**
 * Finds every module-loading construct in `sourceText` (the contents of a
 * file under `src/tools/`) whose RESOLVED TARGET is a DIFFERENT file that
 * is itself under `toolsDir`, DIRECTLY or TRANSITIVELY through a permitted
 * barrel - and separately, every use of `createRequire(...)`, which is
 * forbidden outright. Real AST analysis: walks every
 * `ImportDeclaration`/`ExportDeclaration`/dynamic `import()`/
 * `import.meta.resolve(...)`/`require(...)` call in the file (see
 * scripts/lib/ts-ast.mjs's `collectModuleSpecifiers`), so a comment
 * sitting between `import`/`export`/`from`/`require` and the specifier -
 * or between `import(`/`require(` and its string-literal argument - can
 * never hide a sibling import from this scan the way it could dodge a
 * regex (a comment isn't an AST node at all).
 *
 * The mechanism used to load a module (ES `import`, dynamic `import()`,
 * `import.meta.resolve`, CommonJS `require(...)`, a `require` obtained
 * from `createRequire(...)`) is deliberately irrelevant here - only the
 * RESOLVED TARGET matters, so every form collected by
 * `collectModuleSpecifiers` is resolved the same way and checked against
 * the same rule.
 *
 * TWO resolution layers, run in order for every specifier:
 *
 *   1. A fast path of pure path arithmetic for a relative dot-specifier
 *      (unchanged from this guard's original design): strips the
 *      NodeNext-style `.js` extension back to `.ts` and checks whether
 *      the COMPUTED path falls inside `toolsDir`. Works even when the
 *      referenced file doesn't exist on disk at all - most of this
 *      guard's own fixture-based tests exercise exactly this, writing
 *      only the source TEXT under test, never a real sibling file.
 *   2. A real resolver (`resolveModuleSpecifierRealPath`, scripts/lib/
 *      ts-ast.mjs) for every specifier the fast path didn't already
 *      flag: Node's own CJS resolution plus `realpathSync`, canonicalizing
 *      an absolute path, a `file://` URL, a package/subpath-import alias,
 *      an extensionless or directory-index specifier, or a symlink whose
 *      REAL TARGET sits inside `toolsDir` even when the symlink's own
 *      path does not - none of which the fast path can see, since it only
 *      ever computes from the specifier's literal text against the
 *      importing file's own directory, never touching the filesystem or
 *      following an indirection. This layer only fires when the specifier
 *      resolves to a REAL file (it is a real resolver, not string
 *      matching) - a specifier naming a file that doesn't exist (most of
 *      this guard's own fixtures) simply resolves to nothing here, and is
 *      caught by the fast path instead when it's a relative dot specifier.
 *      When the real resolver's target sits OUTSIDE `toolsDir`, it is
 *      followed ONE step further (`findTransitiveSiblingThroughReExports`)
 *      to catch a permitted barrel that itself re-exports a sibling.
 *
 * Never false-positives on "../registry.js" or "../jobStore.js" (both
 * resolve OUTSIDE tools/, and are legitimate) under either layer.
 *
 * @param {string} sourceText
 * @param {string} importingFileAbsPath - absolute path of the file being scanned
 * @param {string} toolsDirAbsPath - absolute path of src/tools/
 * @returns {string[]} the raw specifier text (or a violation label) of each hit found
 */
export function findSiblingToolImports(sourceText, importingFileAbsPath, toolsDirAbsPath) {
  const hits = [];
  const importingDir = path.dirname(importingFileAbsPath);
  const sourceFile = parseSourceFile(importingFileAbsPath, sourceText);
  const importingFileReal = realpathOrSelf(importingFileAbsPath);
  const toolsDirReal = realpathOrSelf(toolsDirAbsPath);

  for (const { node, text: specifier } of collectModuleSpecifiers(sourceFile)) {
    if (specifier === undefined) {
      if (isDynamicImportCall(node) || isRequireCall(node)) {
        hits.push(UNRESOLVABLE_SIBLING_SPECIFIER_LABEL);
      }
      continue;
    }

    // Layer 1: the original fast path, pure text arithmetic on a relative
    // dot-specifier - see this function's own doc comment for why it
    // stays alongside the real resolver below.
    if (specifier.startsWith(".")) {
      const withoutJsExt = specifier.replace(/\.js$/, "");
      const resolved = `${path.resolve(importingDir, withoutJsExt)}.ts`;
      if (resolved !== importingFileAbsPath) {
        const relToTools = path.relative(toolsDirAbsPath, resolved);
        const staysInsideTools =
          relToTools !== "" && !relToTools.startsWith("..") && !path.isAbsolute(relToTools);
        if (staysInsideTools) {
          hits.push(specifier);
          continue;
        }
      }
    }

    // Layer 2: the real resolver - canonical resolution + realpath
    // compare, catching every form layer 1 structurally cannot (see this
    // function's own doc comment).
    const resolvedReal = resolveModuleSpecifierRealPath(specifier, importingFileAbsPath);
    if (resolvedReal === undefined) continue;
    if (resolvedReal === importingFileReal) continue; // a file can't sibling-import itself

    if (isRealPathInsideDir(resolvedReal, toolsDirReal)) {
      hits.push(specifier);
      continue;
    }

    // The resolved target sits OUTSIDE tools/ - itself a legitimate,
    // directly-named reference, but if THAT file transitively re-exports
    // or imports something inside tools/, the importing file has pulled a
    // sibling in through a permitted intermediate barrel.
    const transitiveSibling = findTransitiveSiblingThroughReExports(
      resolvedReal,
      toolsDirReal,
      new Set()
    );
    if (transitiveSibling !== undefined) {
      hits.push(
        `${specifier} -> transitively re-exports/imports sibling "${transitiveSibling}" through this permitted target`
      );
    }
  }

  // The ONLY layer that flags createRequire: it resolves the IMPORT
  // BINDING itself, structurally (see findCreateRequireImports's own doc
  // comment), so an aliased `import { createRequire as makeLoader } from
  // "node:module"` is caught at the import site regardless of what local
  // name or call shape follows. A name-only callee check (matching any
  // call literally named `createRequire`, wherever it came from) was
  // removed from here deliberately: it is fully redundant with this
  // import-site layer for the real case (which is caught at the import
  // regardless of whether the binding is ever called), and it produced
  // false positives on a harmless LOCAL function/const that merely
  // happens to be named `createRequire` and on `createRequire` imported
  // from a package other than `"node:module"` - neither of those is a
  // real acquisition, and provenance is the only thing this guard trusts.
  for (const { kind } of findCreateRequireImports(sourceFile)) {
    hits.push(createRequireImportBindingLabel(kind));
  }

  return hits;
}

const STATE_CONSTRUCTOR_NAMES = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

/**
 * `Array`/`Object` support BOTH `new X(...)` and a bare `X(...)` call
 * (unlike `Map`/`Set`/`WeakMap`/`WeakSet`, which throw at runtime without
 * `new`) - either form is the CALL-EXPRESSION-shaped equivalent of an
 * empty array/object LITERAL (the module-scope literal signal below): the
 * same mutable, starts-empty container, just spelled as a constructor
 * call instead of literal syntax. A bare `Array(...)`/`Object(...)` call
 * (never `Array.from(...)`/`Object.keys(...)` - those are property-access
 * callees, a structurally different shape this check never matches) is
 * just as unusual to construct transiently as a `Map`/`Set` is, so it
 * gets the same "anywhere in the file" treatment as `STATE_CONSTRUCTOR_NAMES`
 * below, not just the module-scope-only treatment the literal check uses.
 * `Object` is included alongside `Array` even though the mutant that
 * prompted this only used `Array()` - both are the same escape class.
 */
const STATE_CONTAINER_FACTORY_NAMES = new Set(["Array", "Object"]);

/**
 * True when `expressionNode` (a `new Map(...)` or `Array(...)`-shaped
 * node) is immediately member-accessed with no binding at all - e.g.
 * `new Set(x).size`, `new Map(x).get(y)`, `Array(x).length`. That shape is
 * structurally TRANSIENT: nothing retains a reference to the constructed
 * object once the containing expression finishes evaluating, so it cannot
 * possibly be "held" as persistent state, however paranoid the rest of
 * this check is.
 *
 * This carve-out is what lets the scan extend past `src/tools/` to
 * `registry.ts` without false-positiving on registry.ts's own real,
 * legitimate `if (new Set(TOOL_MODULES.map(...)).size !== TOOL_MODULES.length)`
 * duplicate-name check - a genuine transient computation, not state at
 * all. Works identically for a `NewExpression` or a `CallExpression`,
 * since it only ever inspects `.parent`.
 *
 * @param {import("typescript").NewExpression | import("typescript").CallExpression} expressionNode
 * @returns {boolean}
 */
function isTransientImmediateMemberAccess(expressionNode) {
  const parent = expressionNode.parent;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === expressionNode) return true;
  if (ts.isElementAccessExpression(parent) && parent.expression === expressionNode) return true;
  return false;
}

/**
 * @param {string} sourceText
 * @param {string} [fileName]
 * @returns {string[]} a human-readable description of each persistent-
 *   state declaration found, empty when the file declares none
 */
export function findPersistentStateDeclarations(sourceText, fileName = "source.ts") {
  const hits = [];
  const sourceFile = parseSourceFile(fileName, sourceText);

  // Signal 1: a Map/Set/WeakMap/WeakSet construction (always via `new` -
  // these throw without it), or an Array/Object construction (via `new`
  // OR a bare call, both valid) ANYWHERE in the file (any scope, not just
  // module scope - a tool handler should hold zero state anywhere in its
  // body), unless it's the transient shape above.
  forEachDescendant(sourceFile, (node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (!STATE_CONSTRUCTOR_NAMES.has(name) && !STATE_CONTAINER_FACTORY_NAMES.has(name)) return;
      if (isTransientImmediateMemberAccess(node)) return;
      hits.push(`constructs a ${name} (state container)`);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      STATE_CONTAINER_FACTORY_NAMES.has(node.expression.text)
    ) {
      if (isTransientImmediateMemberAccess(node)) return;
      hits.push(`constructs a ${node.expression.text}(...) (state container)`);
    }
  });

  // Signal 2/3: restricted to MODULE (top-level) scope specifically - real
  // AST scope (only `sourceFile.statements`, never descending into a
  // function/block body), not a column-0 text heuristic.
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    const isLet = (statement.declarationList.flags & ts.NodeFlags.Let) !== 0;

    for (const declaration of statement.declarationList.declarations) {
      const declaredName = ts.isIdentifier(declaration.name)
        ? declaration.name.text
        : "<destructured>";

      if (!isConst) {
        // A module-scope let/var - flagged regardless of its initializer,
        // matching this rule's original (deliberately paranoid) scope.
        hits.push(
          `module-scope "${isLet ? "let" : "var"} ${declaredName}" declaration (mutable state)`
        );
        continue;
      }

      const initializer = declaration.initializer;
      if (initializer === undefined) continue;
      if (ts.isArrayLiteralExpression(initializer) && initializer.elements.length === 0) {
        // A `const` binding doesn't stop the bound value from being a
        // mutable container written into later (`.push`), and an EMPTY
        // literal is the structural signature of an accumulator that
        // starts empty and grows. A non-empty top-level const array (this
        // repo's real one: registry.ts's frozen `TOOL_MODULES` list,
        // never mutated after construction) is deliberately NOT flagged -
        // see this file's own header for the full design rationale.
        hits.push(
          `module-scope "const ${declaredName}" bound to an empty array literal (mutable state)`
        );
      } else if (ts.isObjectLiteralExpression(initializer) && initializer.properties.length === 0) {
        hits.push(
          `module-scope "const ${declaredName}" bound to an empty object literal (mutable state)`
        );
      }
    }
  }

  return hits;
}

/**
 * Runs all three checks against the real `src/` tree.
 *
 * @param {string} [srcDir]
 * @returns {string[]} every violation found, empty when clean
 */
export function checkModuleBoundaries(srcDir = SRC_DIR) {
  const violations = [];

  const { extra, missing } = checkFrozenModuleSet(srcDir);
  for (const file of extra) {
    violations.push(`src/${file}: not part of the frozen module list - extra file`);
  }
  for (const file of missing) {
    violations.push(`src/${file}: required by the frozen module list but missing`);
  }

  // Both the sibling-import scan AND the persistent-state scan for
  // src/tools/ walk the SAME real, dynamic directory listing - never a
  // hardcoded name list - so a file added to tools/ (frozen-list member
  // or not - checkFrozenModuleSet above independently polices THAT) is
  // always scanned for both violation classes.
  const toolsDir = path.join(srcDir, TOOLS_SUBDIR);
  for (const file of listTsFilesUnder(toolsDir)) {
    const abs = path.join(toolsDir, file);
    const text = readFileSync(abs, "utf8");
    for (const specifier of findSiblingToolImports(text, abs, toolsDir)) {
      violations.push(
        `src/tools/${file}: imports sibling "${specifier}" - a tools/*.ts file may not import another`
      );
    }
    for (const reason of findPersistentStateDeclarations(text, abs)) {
      violations.push(`src/tools/${file}: ${reason} - only jobStore.ts may own persistent state`);
    }
  }

  // The persistent-state scan ALSO runs across every other ROOT-level core
  // module (server.ts/registry.ts/process.ts) - not just src/tools/. A
  // buffer/state variable is equally a violation whether it's hiding in a
  // tool handler or in one of these. Same dynamic-walk principle as
  // tools/ above: `listTsFilesUnder(srcDir)`
  // filtered to exclude the tools/ subtree (scanned separately above) and
  // the two deliberately-excluded root files, rather than a hardcoded
  // name list - so this too is structural, not spelling-based.
  const rootTsFiles = listTsFilesUnder(srcDir).filter(
    (file) => !file.startsWith(`${TOOLS_SUBDIR}/`)
  );
  for (const file of rootTsFiles) {
    if (STATE_SCAN_EXCLUDED_ROOT_FILES.has(file)) continue;
    const abs = path.join(srcDir, file);
    const text = readFileSync(abs, "utf8");
    for (const reason of findPersistentStateDeclarations(text, abs)) {
      violations.push(`src/${file}: ${reason} - only jobStore.ts may own persistent state`);
    }
  }

  return violations;
}

function main() {
  const violations = checkModuleBoundaries();
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(violation);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `module boundaries clean: ${FROZEN_MODULES.length} frozen modules, no sibling imports, no stray state`
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
