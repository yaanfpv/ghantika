#!/usr/bin/env node
/**
 * Enforces the MCP spec's in-progress "Tasks" extension boundary against
 * the SDK packages this project actually installs. The unit of enforcement
 * is the SYMBOL, matched by its SOURCE imported/exported name (never a
 * local alias), not the module specifier - a prior version of this guard
 * checked for a `@modelcontextprotocol/sdk/experimental` specifier prefix,
 * which is not a barrier at all: this project depends on the split
 * `@modelcontextprotocol/{server,core,client}` packages, which expose no
 * such subpath, and Tasks-related symbols (`Task`, `GetTaskRequest`,
 * `CreateTaskResult`, and sixteen more - see `TASKS_SYMBOLS` below) are
 * reachable straight off the installed `@modelcontextprotocol/server`
 * package's own ROOT specifier, the SAME specifier production imports
 * `Server`/`ProtocolError`/etc. from. A specifier-prefix check has no
 * correct target against that shape and cannot be made non-vacuous by
 * retargeting alone - the fix is symbol-aware enforcement against the real
 * root, which is what this file now does.
 *
 * SCOPE, STATED PLAINLY (matching scripts/lib/ts-ast.mjs's own
 * IN-SCOPE/OUT-OF-SCOPE style):
 *
 * IN SCOPE - every ENUMERATED statically-resolvable reference, from a file
 * under `src/`, to one of the enumerated Tasks symbols (`TASKS_SYMBOLS`
 * below) via the installed `@modelcontextprotocol/server` package root
 * (resolved by real PACKAGE IDENTITY - see `isServerRootSpecifier` - so an
 * aliased, relative, or differently-built (`.cjs` vs `.mjs` vs a `file://`
 * entry) specifier reaching the SAME installed package is judged the same
 * as the bare specifier text):
 *
 *   1. a plain (value) named import         import { GetTaskRequest } from "@modelcontextprotocol/server";
 *   2. a TYPE-ONLY import, statement-level   import type { GetTaskRequest } from "@modelcontextprotocol/server";
 *      or per-specifier                      import { type Task } from "@modelcontextprotocol/server";
 *   3. a named re-export, value or type-only export { Task } / export type { Task } from "@modelcontextprotocol/server";
 *      (aliased or not - export { Task as T } from "...";)
 *   4. a wildcard/namespace re-export, in    export * from "..."; / export * as ns from "...";
 *      every type-only combination too       export type * from "..."; / export type * as ns from "...";
 *      (propagates the WHOLE enumerated set onward, so it is flagged as a
 *      single hit rather than requiring the re-exporting file to spell out
 *      each symbol by name)
 *   5. a namespace member access in VALUE    import * as server from "...";
 *      position - dotted, or a STATIC        void server.GetTaskRequest;
 *      bracket key (folded through one       void server["Task"];
 *      local alias hop, same as this file's
 *      shared `resolvedAccessKeyText`)
 *   6. a namespace member access in TYPE     import * as server from "...";
 *      position - a `QualifiedName` inside   type C = server.Task;
 *      a type, the SAME reference this
 *      file's own symbol resolution proves
 *      resolves to the identical namespace
 *      binding as form 5 (verified empirically)
 *   7. a literal-root dynamic-import         const { GetTaskRequest } = await import("@modelcontextprotocol/server");
 *      destructure, or an immediate          (await import("@modelcontextprotocol/server")).GetTaskRequest
 *      property access off the awaited
 *      result - statically resolvable, so
 *      judged on its actual symbol, never
 *      waved through as "dynamic"
 *   8. a TYPE-IMPORT-QUERY                   type T = import("@modelcontextprotocol/server").Task;
 *      (`ImportTypeNode` - a distinct AST
 *      shape from both form 6's `QualifiedName`
 *      and form 7's dynamic-import `CallExpression`)
 *
 * OUT OF SCOPE, DELIBERATELY, NOT BY OVERSIGHT: a default import of the
 * server root (this package has no meaningful default export shape worth
 * enumerating); a CommonJS `require(...)` of a LITERAL, resolvable root
 * specifier (this codebase is ESM-only end to end - see `createRequire`'s
 * own outright ban below - so a literal `require(root)` is dead code in
 * this repo's real architecture, not a live evasion route worth a separate
 * symbol-aware path); and `import.meta.resolve("@modelcontextprotocol/
 * server")` (performs real resolution but binds no symbol at the call site
 * itself - nothing to check without also tracing what the resolved
 * specifier string is later used for, which this file does not attempt).
 * A Tasks-named symbol imported from any OTHER package is NOT flagged -
 * the boundary is the installed server root only, never a universal
 * symbol-name claim.
 *
 * FAIL-CLOSED, IN THREE INDEPENDENTLY-FLAGGED CLASSES, whenever a
 * reference cannot be proven to avoid the guarded root:
 *
 *   (i)   a computed namespace member key on a confirmed server-root
 *         binding (`server[getKey()]`) - cannot prove the key avoids a
 *         Tasks symbol;
 *   (ii)  a computed/non-literal dynamic-import specifier (`import(getName())`)
 *         - cannot prove the specifier avoids the server root;
 *   (iii) a computed/non-literal `require(...)` specifier
 *         (`require(getName())`), scoped to the real, unshadowed global
 *         `require` the same way `scripts/lib/ts-ast.mjs`'s
 *         `collectModuleSpecifiers` already scopes it - cannot prove the
 *         specifier avoids the server root.
 *
 * Each is its own diagnostic, never folded into another - deleting any ONE
 * of the three leaves the other two catching nothing for it. Conversely, a
 * reference that CAN be statically resolved is judged on its actual
 * symbol, never waved through merely because the syntax "looks dynamic":
 * form 7 above is exactly that case.
 *
 * THE DELIBERATE OPPOSITE OF THIS REPO'S createRequire RULING: a type-only
 * reference to `createRequire` (an erased `import type`) is GREEN
 * elsewhere in this file's design, because `createRequire` is a CAPABILITY
 * boundary - an erased type-only import carries no runtime capability at
 * all. Tasks is an ARCHITECTURAL boundary instead: the coupling this phase
 * forbids is the source-level REFERENCE itself (a type checker resolving a
 * name, a build depending on a shape), not a runtime capability - so a
 * type-only reference to a Tasks symbol is RED in every one of the forms
 * enumerated above, never exempted the way a type-only createRequire
 * import is.
 *
 * SPECIFIER RESOLUTION (see `isServerRootSpecifier` /
 * `resolvePackageIdentity` in scripts/lib/ts-ast.mjs): the guarded root is
 * matched by real PACKAGE IDENTITY (the owning `package.json`'s `name` +
 * that package directory's own real path), not by naive realpath equality
 * on the resolved FILE - two different entry files of the identical
 * installed package version (`dist/index.cjs` vs `dist/index.mjs`, or a
 * `file://` URL naming either) collapse to the same package identity here,
 * where a naive per-file compare would wrongly treat them as different
 * roots. This is a resolver-equivalence layer other module-boundary guards
 * in this repo can build on rather than re-deriving their own. Package-
 * identity comparison is intentionally
 * coarser than "exactly the package's `.` export condition" - a specifier
 * reaching a DIFFERENT subpath of the same installed package (e.g. its
 * `/stdio` entry) is also treated as the guarded root for symbol-membership
 * purposes. This cannot cause a missed detection (only, in principle, a
 * broader-than-strictly-necessary match), and no subpath of this package
 * exports a Tasks-named symbol today - verified against the pinned
 * `@modelcontextprotocol/server@2.0.0-beta.5` package tree.
 *
 * This file's OWN createRequire ban (calling `createRequire` at all, the
 * global `require`/`eval`/`Function`/`module`/`Reflect` acquisition sites,
 * `.constructor` property access, and `Object.getOwnPropertyDescriptor`
 * acquisition) is UNCHANGED from before this rewrite - see
 * `scripts/lib/ts-ast.mjs`'s `findCreateRequireImports` for that whole
 * design, which this file still delegates to unmodified. That ban is
 * independent of Tasks entirely: this codebase is frozen ESM end to end,
 * so CommonJS interop is forbidden outright regardless of what it might
 * ever be used to load.
 *
 * Runs on the real TypeScript AST (see scripts/lib/ts-ast.mjs's header for
 * the full "why AST, not regex" rationale) - a comment or a string literal
 * that merely spells a Tasks symbol's name is never an AST import/export/
 * member-access node, so it is never flagged (see the comment/string-
 * lookalike green control in test/no-tasks-import.test.ts).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";
import {
  bindingElementSourceKeyText,
  collectModuleSpecifiers,
  createScopeCheckedProgram,
  findCreateRequireImports,
  isDynamicImportCall,
  isRequireCall,
  parseSourceFile,
  resolvePackageIdentity,
  resolvedAccessKeyText,
  stringLiteralText,
  ts,
  unwrapTransparentWrapper,
} from "./lib/ts-ast.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = path.join(REPO_ROOT, "src");
const THIS_FILE_PATH = fileURLToPath(import.meta.url);

/** The installed package name this guard's root specifier resolves against. Pinned per package.json/package-lock.json: `@modelcontextprotocol/server@2.0.0-beta.5`. */
const SERVER_PACKAGE_NAME = "@modelcontextprotocol/server";

/**
 * The SINGLE permitted Tasks-import site: the thin adapter over the frozen
 * output-event seam (`src/jobStore.ts`). This is NOT a widening of what the
 * symbol-aware scan below tolerates - the SAME `findTasksImports` primitive,
 * unmodified, still runs against this file too, exactly as it runs against
 * every OTHER `src/` file, NEVER skipped (see
 * `test/no-tasks-import.test.ts`'s dedicated carveout tests). The carveout
 * lives entirely in `checkNoTasksImport`'s RESULT filtering, not in what
 * gets scanned: for this one file, a hit that positively identifies one
 * specific, legitimately-used Tasks symbol (`isNamedTasksSymbolHit`) is
 * suppressed, while every OTHER class of finding `findTasksImports` can
 * produce - a createRequire/CommonJS-loader violation, a wildcard
 * re-export (which propagates the WHOLE Tasks surface onward, a strictly
 * bigger hole than this carveout exists to permit), or any fail-closed
 * "cannot statically verify" diagnostic - still surfaces for the adapter
 * exactly as it does for any other file. See `isNamedTasksSymbolHit`'s own
 * doc comment for the precise boundary and why those other classes are
 * deliberately excluded. Posix-relative to `srcDir` (the function's own
 * parameter, defaulting to `SRC_DIR`) - the SAME convention
 * `scripts/check-module-boundaries.mjs`'s `FROZEN_MODULES` list already
 * uses ("server.ts", "tools/kill.ts", never a "src/"-prefixed form) - so a
 * test exercising a scratch `srcDir` that is not literally
 * `<repo root>/src` still resolves the carveout correctly. A basename-only
 * match would ALSO admit `tools/tasksAdapter.ts` or any other nested
 * same-named file; matching the exact relative path does not.
 */
export const TASKS_ADAPTER_RELATIVE_PATH = "tasksAdapter.ts";

/**
 * The enumerated Tasks export set - exactly the root exports of the pinned
 * `@modelcontextprotocol/server@2.0.0-beta.5` package's `dist/index.d.mts`
 * whose PUBLIC name matches `/Task/i`, copied here by hand from that real,
 * pinned declaration file (never hand-guessed or trimmed to "the symbols
 * some earlier row happened to import"). Spans type-only symbols
 * (`GetTaskRequest`, `TaskStatus`, ...) and real runtime VALUES (the
 * function `isTaskAugmentedRequestParams`, the string constant
 * `RELATED_TASK_META_KEY`) - the guard does not distinguish the two, since
 * a type-level reference is exactly as forbidden as a value one here (see
 * this file's header on the architectural-vs-capability distinction).
 *
 * `test/no-tasks-import.test.ts`'s parity test RE-DERIVES this exact set,
 * independently, straight from the pinned `.d.mts` at test time (via the
 * real TypeScript parser, not a regex), and asserts a deep-equal against
 * this constant - so under- or over-enumerating this list, or the set
 * drifting out of sync with a future dependency bump, reds that test
 * rather than silently narrowing (or vacuously widening) what this guard
 * catches. Byte-identical to `2.0.0-beta.4`'s own `/Task/i` root-export
 * set (verified by a direct `dist/index.d.mts` diff) - the beta.4 -> beta.5
 * bump is inert for the Tasks surface this guard cares about.
 */
export const TASKS_SYMBOLS = new Set([
  "CancelTaskRequest",
  "CancelTaskResult",
  "CreateTaskResult",
  "GetTaskPayloadRequest",
  "GetTaskPayloadResult",
  "GetTaskRequest",
  "GetTaskResult",
  "ListTasksRequest",
  "ListTasksResult",
  "RELATED_TASK_META_KEY",
  "RelatedTaskMetadata",
  "Task",
  "TaskAugmentedRequestParams",
  "TaskCreationParams",
  "TaskMetadata",
  "TaskStatus",
  "TaskStatusNotification",
  "TaskStatusNotificationParams",
  "isTaskAugmentedRequestParams",
]);

/**
 * The three fail-closed diagnostic label constants below are exported
 * specifically so `test/no-tasks-import.test.ts` can assert EXACT label
 * identity (`hits.includes(THE_LABEL)`) rather than a loose substring/regex
 * match - each label's FULL text is kept pairwise DISTINCT from the other
 * two (the three constants are simply not equal to one another as complete
 * strings; they do share several substrings, e.g. "cannot statically
 * verify it avoids" and "failing closed") precisely so an exact-match
 * assertion can distinguish "the right diagnostic fired" from "some
 * diagnostic matching a shared word fired" - see the owning tests' own doc
 * comments for the mislabeling mutant this guards against (e.g. the
 * dynamic-import branch emitting the require-specifier label, or vice
 * versa).
 */
export const COMPUTED_NAMESPACE_MEMBER_KEY_LABEL =
  "<computed namespace member key on a resolved @modelcontextprotocol/server root binding - cannot statically verify it avoids a Tasks-guarded symbol, failing closed>";

export const COMPUTED_DYNAMIC_IMPORT_SPECIFIER_LABEL =
  "<dynamic import() with a computed/non-literal specifier - cannot statically verify it avoids the Tasks extension, failing closed>";

export const COMPUTED_REQUIRE_SPECIFIER_LABEL =
  "<computed require() specifier - cannot statically verify it avoids the @modelcontextprotocol/server root, failing closed (independent of the separate global-require-acquisition ban)>";

function namedImportHitLabel(symbolName, specifierText) {
  return `imports Tasks symbol "${symbolName}" from "${specifierText}"`;
}

function namedReexportHitLabel(symbolName, specifierText) {
  return `re-exports Tasks symbol "${symbolName}" from "${specifierText}"`;
}

function wildcardReexportHitLabel(specifierText) {
  return `wildcard/namespace re-export of "${specifierText}" propagates the whole enumerated Tasks symbol set onward`;
}

function namespaceMemberValueHitLabel(symbolName) {
  return `references Tasks symbol "${symbolName}" via a namespace member access (value position) on the @modelcontextprotocol/server root`;
}

function namespaceMemberTypeHitLabel(symbolName) {
  return `references Tasks symbol "${symbolName}" in a TYPE position via a namespace-qualified access on the @modelcontextprotocol/server root`;
}

function dynamicImportDestructureHitLabel(symbolName) {
  return `destructures/accesses Tasks symbol "${symbolName}" from a literal-root dynamic import of "${SERVER_PACKAGE_NAME}"`;
}

function importTypeQueryHitLabel(symbolName, specifierText) {
  return `references Tasks symbol "${symbolName}" via a type-import query (import("${specifierText}").${symbolName}) on the @modelcontextprotocol/server root`;
}

/**
 * Builds the violation label for a `findCreateRequireImports` hit - see
 * that function's own doc comment in scripts/lib/ts-ast.mjs for why each
 * shape is forbidden outright, independent of the local alias chosen or
 * whether the returned loader is ever called. Unchanged from before this
 * rewrite: createRequire is banned in this frozen-ESM codebase regardless
 * of Tasks.
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
 * Lazily-computed, memoized package identity of the pinned
 * `@modelcontextprotocol/server` package, resolved once from THIS file's
 * own real, on-disk location (always a real file under this repo, so real
 * resolution always has a genuine node_modules ancestor to walk). `null`
 * when the package genuinely cannot be resolved (should not happen in a
 * correctly-installed tree) - the resolver-based fallback in
 * `isServerRootSpecifier` then simply never matches anything beyond the
 * literal bare-specifier fast path, degrading safely rather than throwing.
 */
let cachedCanonicalServerRoot;

function canonicalServerPackageRoot() {
  if (cachedCanonicalServerRoot === undefined) {
    cachedCanonicalServerRoot = resolvePackageIdentity(SERVER_PACKAGE_NAME, THIS_FILE_PATH) ?? null;
  }
  return cachedCanonicalServerRoot;
}

/**
 * True when `specifierText` (as written in source, resolved relative to
 * `fromAbsFilePath`) names the guarded `@modelcontextprotocol/server`
 * package root - either by exact literal text (the fast path: no
 * filesystem resolution needed at all, correct for the overwhelming common
 * case and for every test fixture that spells the bare specifier directly),
 * or by real PACKAGE-IDENTITY resolution (`resolvePackageIdentity` in
 * scripts/lib/ts-ast.mjs) for anything else - an aliased, relative, or
 * absolute specifier, or a `file://` URL, that resolves to the SAME
 * installed package (see this file's header for why package identity, not
 * naive realpath-of-the-resolved-FILE equality, is the right compare).
 */
function isServerRootSpecifier(specifierText, fromAbsFilePath) {
  if (specifierText === SERVER_PACKAGE_NAME) return true;
  const canonical = canonicalServerPackageRoot();
  if (canonical === null) return false;
  const identity = resolvePackageIdentity(specifierText, fromAbsFilePath);
  return (
    identity !== undefined && identity.name === canonical.name && identity.root === canonical.root
  );
}

/** Every NAMED import specifier's source name (`propertyName ?? name`) checked against `TASKS_SYMBOLS`; a bare side-effect import or a default/namespace import carries no NAMED specifier here (a namespace import's later member access is handled separately, by `collectRootNamespaceSymbols`/`collectNamespaceMemberAccessHits`). */
function collectNamedImportSymbolHits(importDeclNode, specifierText, hits) {
  const importClause = importDeclNode.importClause;
  if (importClause === undefined) return;
  const namedBindings = importClause.namedBindings;
  if (namedBindings === undefined || !ts.isNamedImports(namedBindings)) return;
  for (const specifier of namedBindings.elements) {
    const sourceName = (specifier.propertyName ?? specifier.name).text;
    if (TASKS_SYMBOLS.has(sourceName)) {
      hits.push(namedImportHitLabel(sourceName, specifierText));
    }
  }
}

/** Every re-export form from the server root: named (aliased or not), wildcard (`export * from root`), and namespace-aliased (`export * as ns from root`) - type-only or not uniformly, since a re-export hands the symbol onward exactly as an import does and Tasks is an architectural, not capability, boundary (see this file's header). */
function collectReexportSymbolHits(exportDeclNode, specifierText, hits) {
  const exportClause = exportDeclNode.exportClause;
  if (exportClause === undefined) {
    // export * from root; / export type * from root;
    hits.push(wildcardReexportHitLabel(specifierText));
    return;
  }
  if (ts.isNamespaceExport(exportClause)) {
    // export * as ns from root; / export type * as ns from root;
    hits.push(wildcardReexportHitLabel(specifierText));
    return;
  }
  if (ts.isNamedExports(exportClause)) {
    for (const specifier of exportClause.elements) {
      const sourceName = (specifier.propertyName ?? specifier.name).text;
      if (TASKS_SYMBOLS.has(sourceName)) {
        hits.push(namedReexportHitLabel(sourceName, specifierText));
      }
    }
  }
}

/** The dynamic-import call's own AwaitExpression parent, when directly awaited - otherwise the call node itself. Both `const { X } = await import(root)` and (in principle) a non-awaited `const { X } = import(root)` are handled uniformly by looking at this "outer" node's own parent next. */
function outerNodeAfterAwait(callNode) {
  const parent = callNode.parent;
  if (parent !== undefined && ts.isAwaitExpression(parent) && parent.expression === callNode) {
    return parent;
  }
  return callNode;
}

/**
 * A literal-root dynamic import's specifier is confirmed to be the guarded
 * server root (checked by the caller before this runs) - this inspects
 * what the call's result is immediately used for: a destructuring pattern
 * (`const { X, Y: Z } = await import(root)`), or a direct property access
 * off the (possibly parenthesized) awaited result
 * (`(await import(root)).X` / `(await import(root))["X"]`). Each pulled
 * symbol name is checked against `TASKS_SYMBOLS` the same as any other
 * enumerated form - a statically-resolvable reference is judged on its
 * actual symbol, never waved through as "dynamic" merely because the
 * loading MECHANISM is `import()`.
 */
function collectLiteralRootDynamicImportUsageHits(callNode, hits) {
  const outer = outerNodeAfterAwait(callNode);

  const declParent = outer.parent;
  if (
    declParent !== undefined &&
    ts.isVariableDeclaration(declParent) &&
    declParent.initializer === outer &&
    ts.isObjectBindingPattern(declParent.name)
  ) {
    for (const element of declParent.name.elements) {
      if (element.dotDotDotToken) continue; // a rest element carries no single source key
      const sourceName = bindingElementSourceKeyText(element);
      if (sourceName !== undefined && TASKS_SYMBOLS.has(sourceName)) {
        hits.push(dynamicImportDestructureHitLabel(sourceName));
      }
    }
  }

  let accessNode = outer.parent;
  if (accessNode !== undefined && ts.isParenthesizedExpression(accessNode)) {
    accessNode = accessNode.parent;
  }
  if (
    accessNode !== undefined &&
    (ts.isPropertyAccessExpression(accessNode) || ts.isElementAccessExpression(accessNode)) &&
    unwrapTransparentWrapper(accessNode.expression) === outer
  ) {
    const key = ts.isPropertyAccessExpression(accessNode)
      ? accessNode.name.text
      : stringLiteralText(accessNode.argumentExpression);
    if (key !== undefined && TASKS_SYMBOLS.has(key)) {
      hits.push(dynamicImportDestructureHitLabel(key));
    }
  }
}

/**
 * Collects the `ts.Symbol`s of every `import * as ns from root` (value or
 * type-only) namespace-import binding whose specifier resolves to the
 * guarded server root - the set later member-access checks compare
 * against, by symbol IDENTITY (never by binding-name text, so a locally
 * shadowed name of the same text is never confused with the real
 * namespace).
 */
function collectRootNamespaceSymbols(checkedSourceFile, checker, fromAbsFilePath) {
  const symbols = new Set();
  ts.forEachChild(checkedSourceFile, function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      const specifierText = stringLiteralText(node.moduleSpecifier);
      if (specifierText !== undefined && isServerRootSpecifier(specifierText, fromAbsFilePath)) {
        const importClause = node.importClause;
        const namedBindings = importClause?.namedBindings;
        if (namedBindings !== undefined && ts.isNamespaceImport(namedBindings)) {
          const symbol = checker.getSymbolAtLocation(namedBindings.name);
          if (symbol !== undefined) symbols.add(symbol);
        }
      }
    }
    ts.forEachChild(node, visit);
  });
  return symbols;
}

/**
 * Collects the `ts.Symbol`s of every PLAIN identifier a literal-root
 * dynamic import of the guarded server root is bound to directly -
 * `const m = await import(root);` (or the same without an explicit
 * `await` - `outerNodeAfterAwait` treats both uniformly, the same way
 * `collectLiteralRootDynamicImportUsageHits` already does for the
 * destructure form). This is the counterpart to
 * `collectRootNamespaceSymbols` for `import * as ns from root`, one level
 * later: a static namespace import binds the module's namespace object to
 * `ns` directly; this binds the SAME kind of value to a plain `const`/
 * `let`/`var` identifier instead, via an ordinary variable declaration
 * rather than import syntax. A later `m.CreateTaskResult` reference is
 * structurally identical to `ns.CreateTaskResult` off a real namespace
 * import - both are a property/element access whose base identifier
 * resolves to a value that IS the imported module's namespace object - so
 * this function's whole job is producing the SAME kind of `ts.Symbol` set
 * `collectRootNamespaceSymbols` does, for this different binding route,
 * so both sets can feed the identical `collectNamespaceMemberAccessHits`
 * scan (see this file's call site below): reuse, not a parallel primitive.
 *
 * A DESTRUCTURING pattern (`const { X } = await import(root)`) is OUT OF
 * SCOPE here on purpose - that shape is already handled, completely and
 * separately, by `collectLiteralRootDynamicImportUsageHits` (over the raw,
 * unchecked source), since a destructured binding never holds the whole
 * module namespace object itself, only whichever properties were pulled
 * off it at the destructuring site.
 *
 * ZERO-HOP, matching this file's EXISTING precedent for the sibling
 * namespace-import case: `collectRootNamespaceSymbols` above tracks only
 * the DIRECT `import * as ns from root` binding's own symbol - it does not
 * chase a further alias of `ns` itself (`const n = ns;`) - so this
 * function does not chase a further alias of `m` either
 * (`const m = await import(root); const n = m;`). This is a DISCLOSED
 * boundary, not a claimed-closed one (see
 * `test/no-tasks-import.test.ts`'s own dedicated test for this exact
 * shape): a further alias hop is a plausible further escape, and closing
 * it would be a genuine extension of this file's real coverage, not
 * evidence that this fix failed - the same posture `scripts/lib/ts-ast.mjs`
 * states explicitly for its own one-hop alias boundaries.
 */
function collectDynamicImportBoundIdentifierSymbols(checkedSourceFile, checker, fromAbsFilePath) {
  const symbols = new Set();
  ts.forEachChild(checkedSourceFile, function visit(node) {
    if (isDynamicImportCall(node)) {
      const [firstArg] = node.arguments;
      const specifierText = firstArg !== undefined ? stringLiteralText(firstArg) : undefined;
      if (specifierText !== undefined && isServerRootSpecifier(specifierText, fromAbsFilePath)) {
        const outer = outerNodeAfterAwait(node);
        const declParent = outer.parent;
        if (
          declParent !== undefined &&
          ts.isVariableDeclaration(declParent) &&
          declParent.initializer === outer &&
          ts.isIdentifier(declParent.name)
        ) {
          const symbol = checker.getSymbolAtLocation(declParent.name);
          if (symbol !== undefined) symbols.add(symbol);
        }
      }
    }
    ts.forEachChild(node, visit);
  });
  return symbols;
}

/**
 * Namespace member access off a confirmed server-root binding, in BOTH
 * positions: VALUE (`server.GetTaskRequest`, a `PropertyAccessExpression`,
 * or the static-bracket-key form `server["Task"]`, an
 * `ElementAccessExpression`) and TYPE (`type C = server.Task`, a
 * `QualifiedName` - proven, empirically, to resolve through the SAME
 * `ts.Symbol` as the value-position form off the identical namespace
 * import). A key that cannot be statically resolved on a confirmed
 * server-root base FAILS CLOSED (fail-closed class i, this file's header) -
 * this guard cannot prove it avoids a Tasks symbol.
 */
function collectNamespaceMemberAccessHits(checkedSourceFile, checker, rootNamespaceSymbols, hits) {
  if (rootNamespaceSymbols.size === 0) return;
  ts.forEachChild(checkedSourceFile, function visit(node) {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = unwrapTransparentWrapper(node.expression);
      if (ts.isIdentifier(base)) {
        const baseSymbol = checker.getSymbolAtLocation(base);
        if (baseSymbol !== undefined && rootNamespaceSymbols.has(baseSymbol)) {
          const key = resolvedAccessKeyText(node, checker, checkedSourceFile);
          if (key === undefined) {
            hits.push(COMPUTED_NAMESPACE_MEMBER_KEY_LABEL);
          } else if (TASKS_SYMBOLS.has(key)) {
            hits.push(namespaceMemberValueHitLabel(key));
          }
        }
      }
    } else if (ts.isQualifiedName(node) && ts.isIdentifier(node.left)) {
      const leftSymbol = checker.getSymbolAtLocation(node.left);
      if (leftSymbol !== undefined && rootNamespaceSymbols.has(leftSymbol)) {
        const key = node.right.text;
        if (TASKS_SYMBOLS.has(key)) {
          hits.push(namespaceMemberTypeHitLabel(key));
        }
      }
    }
    ts.forEachChild(node, visit);
  });
}

/**
 * The TYPE-IMPORT-QUERY form - `type T = import("@modelcontextprotocol/
 * server").Task` - a distinct AST node kind (`ImportTypeNode`, not a
 * `QualifiedName` and not a dynamic-import `CallExpression`): the module
 * specifier lives on `.argument` (a `LiteralTypeNode` wrapping a string
 * literal - always a literal here, since this form has no computed-
 * specifier grammar to speak of) and the member name on `.qualifier` (an
 * `Identifier` for a single segment, matching the enumerated form this file
 * owns). No symbol resolution is needed - the specifier is always a
 * literal and the qualifier is plain syntax - so this runs over the
 * original, un-checked `sourceFile` directly.
 */
function collectImportTypeQueryHits(sourceFile, fromAbsFilePath, hits) {
  ts.forEachChild(sourceFile, function visit(node) {
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal) &&
      node.qualifier !== undefined &&
      ts.isIdentifier(node.qualifier)
    ) {
      const specifierText = node.argument.literal.text;
      const symbolName = node.qualifier.text;
      if (isServerRootSpecifier(specifierText, fromAbsFilePath) && TASKS_SYMBOLS.has(symbolName)) {
        hits.push(importTypeQueryHitLabel(symbolName, specifierText));
      }
    }
    ts.forEachChild(node, visit);
  });
}

/**
 * The whole symbol-aware Tasks-boundary scan for one file: static import/
 * export specifiers and the two fail-closed computed-specifier classes
 * (ii - dynamic import, iii - require) via the shared
 * `collectModuleSpecifiers` primitive (which already scopes a
 * `require(...)` call to the real, unshadowed global the same way this
 * file's createRequire ban does, so a local require shadow is never
 * mistaken for the real thing here either); namespace member access (value
 * and type position) and literal-root dynamic-import destructure/property-
 * access symbol inspection via this file's own real-scope-checked pass
 * (see `collectRootNamespaceSymbols`/`collectNamespaceMemberAccessHits`).
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} fromAbsFilePath
 * @returns {string[]}
 */
function findServerRootFindings(sourceFile, fromAbsFilePath) {
  const hits = [];

  for (const { node, text: specifierText } of collectModuleSpecifiers(sourceFile)) {
    if (ts.isImportDeclaration(node)) {
      if (specifierText === undefined) continue; // a static import always carries a literal specifier per grammar
      if (isServerRootSpecifier(specifierText, fromAbsFilePath)) {
        collectNamedImportSymbolHits(node, specifierText, hits);
      }
      continue;
    }
    if (ts.isExportDeclaration(node)) {
      if (specifierText === undefined) continue;
      if (isServerRootSpecifier(specifierText, fromAbsFilePath)) {
        collectReexportSymbolHits(node, specifierText, hits);
      }
      continue;
    }
    if (isDynamicImportCall(node)) {
      if (specifierText === undefined) {
        // Fail-closed class ii (this file's header): a computed/non-literal
        // dynamic-import specifier that cannot be proven not-the-root -
        // fail closed, independent of whether anything is later
        // destructured off it.
        hits.push(COMPUTED_DYNAMIC_IMPORT_SPECIFIER_LABEL);
        continue;
      }
      if (isServerRootSpecifier(specifierText, fromAbsFilePath)) {
        collectLiteralRootDynamicImportUsageHits(node, hits);
      }
      continue;
    }
    if (isRequireCall(node)) {
      if (specifierText === undefined) {
        // Fail-closed class iii (this file's header): a computed/non-
        // literal require() specifier - its OWN, independently-flagged
        // diagnostic, distinct from the global-require-acquisition ban
        // below (that ban fires on the bare `require` reference regardless
        // of its argument; this fires on the SPECIFIER being unresolvable,
        // so deleting this check alone cannot be masked by the other still
        // firing).
        hits.push(COMPUTED_REQUIRE_SPECIFIER_LABEL);
      }
      // A require() of a LITERAL, resolvable root specifier is out of
      // scope for symbol-checking (see this file's header) - this
      // codebase is ESM-only, so that shape is dead code, not a live
      // evasion route.
      continue;
    }
    // import.meta.resolve(...) and anything else collectModuleSpecifiers
    // surfaces is out of scope here (see this file's header).
  }

  const { sourceFile: checkedSourceFile, checker } = createScopeCheckedProgram(
    sourceFile.fileName,
    sourceFile.text
  );
  const rootNamespaceSymbols = collectRootNamespaceSymbols(
    checkedSourceFile,
    checker,
    fromAbsFilePath
  );
  const dynamicImportBoundIdentifierSymbols = collectDynamicImportBoundIdentifierSymbols(
    checkedSourceFile,
    checker,
    fromAbsFilePath
  );
  // Both sets bind an identifier to the guarded root's whole namespace
  // object - one via `import * as ns`, the other via
  // `const m = await import(root)` - so a later member access off either
  // is judged by the SAME scan, never a duplicated parallel check. See
  // collectDynamicImportBoundIdentifierSymbols's own doc comment for why
  // this reuses collectNamespaceMemberAccessHits rather than a bespoke
  // pass.
  const namespaceLikeSymbols =
    dynamicImportBoundIdentifierSymbols.size === 0
      ? rootNamespaceSymbols
      : new Set([...rootNamespaceSymbols, ...dynamicImportBoundIdentifierSymbols]);
  collectNamespaceMemberAccessHits(checkedSourceFile, checker, namespaceLikeSymbols, hits);
  collectImportTypeQueryHits(sourceFile, fromAbsFilePath, hits);

  return hits;
}

/**
 * @param {string} sourceText
 * @param {string} [fileName]
 * @returns {string[]} every forbidden reference (or violation label) found, empty when clean.
 */
export function findTasksImports(sourceText, fileName = "source.ts") {
  const hits = [];
  const sourceFile = parseSourceFile(fileName, sourceText);
  const fromAbsFilePath = path.isAbsolute(fileName) ? fileName : path.join(process.cwd(), fileName);

  hits.push(...findServerRootFindings(sourceFile, fromAbsFilePath));

  // The ONLY layer that flags createRequire and the other CommonJS-interop
  // acquisition sites - see createRequireImportBindingLabel's own doc
  // comment above. Unchanged from before this rewrite: createRequire is
  // banned in this frozen-ESM codebase independent of Tasks.
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
 * True when `hit` is one of the SIX label shapes `findTasksImports` emits
 * that positively identify ONE SPECIFIC member of `TASKS_SYMBOLS` actually
 * being referenced by name - a named import (`namedImportHitLabel`), a
 * named re-export (`namedReexportHitLabel`), a namespace member access in
 * either position (`namespaceMemberValueHitLabel` /
 * `namespaceMemberTypeHitLabel`), a literal-root dynamic-import destructure/
 * property access (`dynamicImportDestructureHitLabel`), or a type-import
 * query (`importTypeQueryHitLabel`). Every one of those six functions
 * shares the literal phrase `Tasks symbol "` immediately before the quoted
 * symbol name - verified against each of their own template strings above,
 * and deliberately never reused by any OTHER diagnostic this file emits -
 * which is what makes this a safe, lightweight classifier rather than a
 * fragile guess. This is the ONLY class `checkNoTasksImport`'s adapter
 * carveout is permitted to suppress - see its own call site below.
 *
 * Two adjacent classes are DELIBERATELY EXCLUDED, on purpose, not by
 * oversight:
 *
 *   - `wildcardReexportHitLabel` ("...propagates the whole enumerated
 *     Tasks symbol set onward") names no single symbol; a wildcard
 *     re-export from the adapter would hand the WHOLE Tasks surface to
 *     every OTHER file that imports from the adapter, a strictly BIGGER
 *     hole than the carveout exists to permit (the adapter's own internal
 *     use of specific, named symbols) - so it stays a violation even here.
 *   - every fail-closed "cannot statically verify" diagnostic
 *     (`COMPUTED_NAMESPACE_MEMBER_KEY_LABEL`,
 *     `COMPUTED_DYNAMIC_IMPORT_SPECIFIER_LABEL`,
 *     `COMPUTED_REQUIRE_SPECIFIER_LABEL`) and every createRequire/
 *     CommonJS-loader label (`createRequireImportBindingLabel`) - none of
 *     these positively identifies a permitted Tasks symbol, and the
 *     createRequire ban in particular is a COMPLETELY SEPARATE prohibition
 *     (frozen ESM, independent of Tasks - see this file's header), so
 *     neither class is something this carveout was ever meant to permit.
 *
 * @param {string} hit
 * @returns {boolean}
 */
export function isNamedTasksSymbolHit(hit) {
  return hit.includes('Tasks symbol "');
}

/**
 * @param {string} [srcDir]
 * @returns {{ file: string, specifier: string }[]} every violation found
 *   across the whole `src/` tree, empty when clean
 */
export function checkNoTasksImport(srcDir = SRC_DIR) {
  const violations = [];
  for (const absFile of listTsFilesUnder(srcDir)) {
    // The single permitted carveout (see TASKS_ADAPTER_RELATIVE_PATH's own
    // doc comment): the adapter file is SCANNED exactly like every other
    // src/ file - findTasksImports never skips it - but a hit that
    // positively identifies one specific, legitimately-used Tasks symbol
    // is suppressed for this ONE file. Every other class of finding
    // (createRequire/CommonJS-loader violations, a wildcard re-export,
    // any fail-closed "cannot verify" diagnostic) still surfaces for the
    // adapter exactly as it does for any other src/ file - see
    // isNamedTasksSymbolHit's own doc comment. Matched relative to
    // `srcDir` itself (not `REPO_ROOT`), so a test exercising a scratch
    // `srcDir` resolves the carveout the same way the real tree does.
    const relToSrcDir = path.relative(srcDir, absFile).split(path.sep).join("/");
    const isAdapterFile = relToSrcDir === TASKS_ADAPTER_RELATIVE_PATH;

    const relFile = path.relative(REPO_ROOT, absFile).split(path.sep).join("/");
    const text = readFileSync(absFile, "utf8");
    for (const specifier of findTasksImports(text, absFile)) {
      if (isAdapterFile && isNamedTasksSymbolHit(specifier)) continue;
      violations.push({ file: relFile, specifier });
    }
  }
  return violations;
}

function main() {
  const violations = checkNoTasksImport();
  if (violations.length > 0) {
    for (const { file, specifier } of violations) {
      console.error(`${file}: forbidden Tasks-extension reference "${specifier}"`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `no forbidden Tasks-extension reference found under src/ outside the permitted ${TASKS_ADAPTER_RELATIVE_PATH} seam`
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
