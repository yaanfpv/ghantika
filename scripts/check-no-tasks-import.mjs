#!/usr/bin/env node
/**
 * Checks for an import of the MCP spec's in-progress "Tasks" extension via
 * the monolithic `@modelcontextprotocol/sdk` package's `/experimental`
 * namespace. Fails red if any file under `src/` LOADS a module under that
 * namespace via any means - the loading MECHANISM never changes what
 * module actually gets resolved, so this checks the resolved target, not
 * one fixed syntax:
 *
 *   1. a direct import           import { X } from "@modelcontextprotocol/sdk/experimental/tasks";
 *   2. a type-only import        import type { X } from "@modelcontextprotocol/sdk/experimental/tasks";
 *   3. a barrel re-export        import { X } from "@modelcontextprotocol/sdk/experimental";
 *                                 (that barrel's own index.d.ts does `export * from "./tasks/index.js"`
 *                                  in the monolithic package, so importing ANYTHING from the bare
 *                                  "/experimental" barrel would already transitively pull Tasks in,
 *                                  which is why the bare barrel is forbidden too, not just the
 *                                  "/experimental/tasks" subpath)
 *   4. an explicit re-export     export { X } from "@modelcontextprotocol/sdk/experimental/tasks";
 *                                 export * from "@modelcontextprotocol/sdk/experimental";
 *   5. a dynamic import          await import("@modelcontextprotocol/sdk/experimental/tasks");
 *   6. a CommonJS require        require("@modelcontextprotocol/sdk/experimental/tasks");
 *   7. createRequire itself      const require = createRequire(import.meta.url); - calling
 *                                 createRequire AT ALL is forbidden outright, independent
 *                                 of what its returned function later loads, resolved by
 *                                 where the `createRequire` binding itself came from (see
 *                                 `createRequireImportBindingLabel`'s own doc comment)
 *   8. process.getBuiltinModule  process.getBuiltinModule("node:module").createRequire(...) -
 *                                 referencing this ONE property of the global `process` is
 *                                 forbidden outright, the same acquisition-site principle as
 *                                 form 7, independent of what specifier it is later called
 *                                 with (see scripts/lib/ts-ast.mjs's own header for why this
 *                                 route is closeable by the same machinery while two other,
 *                                 genuinely different reflective/structural routes are not)
 *
 * WHAT THIS GUARD ACTUALLY COVERS, STATED PLAINLY: this project does not
 * depend on the monolithic `@modelcontextprotocol/sdk` package at all -
 * its real dependencies are the split `@modelcontextprotocol/client`,
 * `@modelcontextprotocol/core`, and `@modelcontextprotocol/server`
 * packages, all at 2.0.0-beta.4. The `/experimental` namespace this guard
 * checks does not exist in those split packages; Tasks-related symbols
 * are instead reachable from `@modelcontextprotocol/server`'s own ROOT
 * specifier, a completely different import shape this guard does NOT
 * check. So today this guard is not an effective barrier against a real
 * import of Tasks from the packages this project actually depends on -
 * it only catches an import of a package this project has never
 * installed. Symbol-aware enforcement against the split packages' root
 * export is separate, tracked work, not implemented here.
 *
 * Runs on the real TypeScript AST (see scripts/lib/ts-ast.mjs's header for
 * the full "why AST, not regex" rationale) - every one of forms 1-6 above
 * is a real `ImportDeclaration`/`ExportDeclaration`/dynamic-`import()`/
 * `require(...)`-call AST node regardless of what comments sit between its
 * keywords (`import`/`from`/`import(`/`require(`) and its specifier, or
 * whether the specifier is a plain string or a no-substitution template
 * literal - a comment is trivia attached to a token, never an AST node of
 * its own, so the parser never even considers it part of the expression
 * being matched.
 *
 * A dynamic import or `require(...)` call whose argument is a runtime-
 * computed expression (a variable, string concatenation, an interpolated
 * template) can't be resolved statically - this guard FAILS CLOSED on
 * that case (reports it as a violation) rather than silently passing it
 * through. A computed specifier is exactly the kind of thing that could
 * smuggle a forbidden import past a purely-static check, and this
 * codebase has no legitimate reason to ever compute a module specifier at
 * all - verified against the real src/ tree, which contains zero dynamic
 * imports or `require` calls of any kind (static ES imports only,
 * everywhere).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";
import {
  collectModuleSpecifiers,
  findCreateRequireImports,
  isDynamicImportCall,
  isRequireCall,
  parseSourceFile,
} from "./lib/ts-ast.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = path.join(REPO_ROOT, "src");

const FORBIDDEN_SPECIFIER = "@modelcontextprotocol/sdk/experimental";
const FORBIDDEN_SPECIFIER_PREFIX = `${FORBIDDEN_SPECIFIER}/`;

const UNRESOLVABLE_DYNAMIC_IMPORT_LABEL =
  "<dynamic import()/require() with a computed/non-literal specifier - cannot statically verify it avoids the Tasks extension, failing closed>";

/**
 * Builds the violation label for a `findCreateRequireImports` hit,
 * describing the exact binding shape found - see that function's own doc
 * comment in scripts/lib/ts-ast.mjs for why each shape is forbidden
 * outright, independent of the local alias chosen or whether the returned
 * loader is ever called. This is the ONLY layer `findTasksImports` uses
 * to flag `createRequire`: it resolves the IMPORT BINDING itself, so an
 * aliased `import { createRequire as makeLoader } from "node:module"`
 * followed by `makeLoader(specifier)` is caught at the import site,
 * independent of the specifier-matching loop below (which only recognizes
 * an unaliased `require(...)` callee and never sees `makeLoader` at all).
 * A name-only callee check (matching any call literally named
 * `createRequire`, wherever it came from) was deliberately NOT used here:
 * it would be fully redundant with this layer for the real case, and it
 * would false-positive on a harmless local `createRequire`-named binding
 * or one imported from a package other than `"node:module"` - provenance
 * is the only thing this guard trusts.
 *
 * @param {"named" | "namespace" | "default" | "dynamic-import" | "import-equals" | "commonjs-require" | "module-require" | "eval-call" | "function-constructor-call" | "re-export-named" | "re-export-namespace" | "unresolvable-globalthis-access" | "process-getbuiltinmodule-access" | "unresolvable-process-access"} kind
 * @returns {string}
 */
function createRequireImportBindingLabel(kind) {
  switch (kind) {
    case "process-getbuiltinmodule-access":
      return "<references process.getBuiltinModule - reaches createRequire (and any other builtin module) via a Node builtin-module API with no import/require syntax naming its target anywhere, forbidden outright at the point of reference the same as the four bare globals, regardless of what specifier it is later called with or how the reference is stored/aliased>";
    case "unresolvable-process-access":
      return "<accesses a computed property of process whose key can't be resolved statically - cannot verify it avoids .getBuiltinModule, failing closed>";
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
 * @param {string} sourceText
 * @param {string} [fileName]
 * @returns {string[]} every forbidden specifier (or violation label) found, empty when clean.
 *   A specifier text of `undefined` (a dynamic import or `require()` call
 *   whose argument can't be resolved statically) is reported via
 *   `UNRESOLVABLE_DYNAMIC_IMPORT_LABEL` - see this file's header for why
 *   that fails closed rather than being silently skipped.
 */
export function findTasksImports(sourceText, fileName = "source.ts") {
  const hits = [];
  const sourceFile = parseSourceFile(fileName, sourceText);

  for (const { node, text: specifier } of collectModuleSpecifiers(sourceFile)) {
    if (specifier === undefined) {
      // A static import/export always carries a literal string-or-
      // template moduleSpecifier per the ECMAScript/TS grammar itself -
      // `specifier === undefined` for a static import/export node would
      // mean the parser accepted genuinely invalid syntax, which can't
      // happen for well-formed source. Only a dynamic import or a
      // `require(...)` call can legitimately have an unresolvable
      // (computed) specifier - and that's exactly the case this fails
      // closed on, per this file's header.
      if (isDynamicImportCall(node) || isRequireCall(node)) {
        hits.push(UNRESOLVABLE_DYNAMIC_IMPORT_LABEL);
      }
      continue;
    }
    if (specifier === FORBIDDEN_SPECIFIER || specifier.startsWith(FORBIDDEN_SPECIFIER_PREFIX)) {
      hits.push(specifier);
    }
  }

  // The ONLY layer that flags createRequire: it resolves the IMPORT
  // BINDING itself, structurally (see findCreateRequireImports's own doc
  // comment in scripts/lib/ts-ast.mjs, and createRequireImportBindingLabel's
  // own doc comment above for why a name-only callee check was
  // deliberately not used instead), so an aliased
  // `import { createRequire as makeLoader } from "node:module"` followed
  // by `makeLoader("@modelcontextprotocol/sdk/experimental/tasks")` is
  // caught at the import site - independent of the specifier-matching
  // loop above, which only recognizes an unaliased `require(...)` callee
  // and never sees `makeLoader` at all.
  for (const { kind } of findCreateRequireImports(sourceFile)) {
    hits.push(createRequireImportBindingLabel(kind));
  }

  return hits;
}

/**
 * Recursively lists every `.ts` file under `dir`, as absolute paths.
 * Returns an empty list when `dir` doesn't exist.
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
      out.push(...listTsFilesUnder(full));
    } else if (dirent.isFile() && dirent.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * @param {string} [srcDir]
 * @returns {{ file: string, specifier: string }[]} every violation found
 *   across the whole `src/` tree, empty when clean
 */
export function checkNoTasksImport(srcDir = SRC_DIR) {
  const violations = [];
  for (const absFile of listTsFilesUnder(srcDir)) {
    const text = readFileSync(absFile, "utf8");
    const relFile = path.relative(REPO_ROOT, absFile).split(path.sep).join("/");
    for (const specifier of findTasksImports(text, absFile)) {
      violations.push({ file: relFile, specifier });
    }
  }
  return violations;
}

function main() {
  const violations = checkNoTasksImport();
  if (violations.length > 0) {
    for (const { file, specifier } of violations) {
      console.error(
        `${file}: forbidden Tasks-extension import "${specifier}" - this project does not depend on it`
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log("no Tasks-extension import found anywhere under src/");
}

if (isMainModule(import.meta.url)) {
  main();
}
