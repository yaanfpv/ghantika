import assert from "node:assert/strict";
import { test } from "node:test";

import { checkNoTasksImport, findTasksImports } from "../scripts/check-no-tasks-import.mjs";

// --- the real src/ tree, as it exists right now, must be clean ---

test("the real src/ tree imports nothing from the Tasks extension", () => {
  assert.deepEqual(checkNoTasksImport(), []);
});

// --- each of the 5 forbidden import forms, independently ---

test("a direct import from the tasks subpath is caught", () => {
  const hits = findTasksImports(
    'import { TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";\n'
  );
  assert.deepEqual(hits, ["@modelcontextprotocol/sdk/experimental/tasks"]);
});

test("a type-only import from the tasks subpath is caught", () => {
  const hits = findTasksImports(
    'import type { TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";\n'
  );
  assert.deepEqual(hits, ["@modelcontextprotocol/sdk/experimental/tasks"]);
});

test("importing the bare /experimental barrel (which itself re-exports tasks) is caught", () => {
  const hits = findTasksImports(
    'import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental";\n'
  );
  assert.deepEqual(hits, ["@modelcontextprotocol/sdk/experimental"]);
});

test("an explicit named re-export from the tasks subpath is caught", () => {
  const hits = findTasksImports(
    'export { TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";\n'
  );
  assert.deepEqual(hits, ["@modelcontextprotocol/sdk/experimental/tasks"]);
});

test("a wildcard re-export of the /experimental barrel is caught", () => {
  const hits = findTasksImports('export * from "@modelcontextprotocol/sdk/experimental";\n');
  assert.deepEqual(hits, ["@modelcontextprotocol/sdk/experimental"]);
});

test("a dynamic import() of the tasks subpath is caught", () => {
  const hits = findTasksImports(
    'const mod = await import("@modelcontextprotocol/sdk/experimental/tasks");\n'
  );
  assert.deepEqual(hits, ["@modelcontextprotocol/sdk/experimental/tasks"]);
});

test("a deep subpath import (e.g. .../tasks/server.js) is caught too", () => {
  const hits = findTasksImports(
    'import { X } from "@modelcontextprotocol/sdk/experimental/tasks/server.js";\n'
  );
  assert.deepEqual(hits, ["@modelcontextprotocol/sdk/experimental/tasks/server.js"]);
});

test("all five forms, mixed together in one file, are each independently caught", () => {
  const source = [
    'import { A } from "@modelcontextprotocol/sdk/experimental/tasks";',
    'import type { B } from "@modelcontextprotocol/sdk/experimental/tasks";',
    'import { C } from "@modelcontextprotocol/sdk/experimental";',
    'export { D } from "@modelcontextprotocol/sdk/experimental/tasks";',
    'const e = await import("@modelcontextprotocol/sdk/experimental/tasks");',
    "",
  ].join("\n");
  const hits = findTasksImports(source);
  assert.equal(hits.length, 5, `expected exactly 5 hits, got: ${JSON.stringify(hits)}`);
});

// --- green control: a legitimate import is never flagged ---

test("green control - a legitimate SDK import (server, not experimental) is never flagged", () => {
  const source = [
    'import { Server } from "@modelcontextprotocol/sdk/server/index.js";',
    'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
    'import { CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";',
    "",
  ].join("\n");
  assert.deepEqual(findTasksImports(source), []);
});

test("green control - a Node builtin import is never flagged", () => {
  const source = [
    'import { spawn } from "node:child_process";',
    'import path from "node:path";',
    "",
  ].join("\n");
  assert.deepEqual(findTasksImports(source), []);
});

test("a fully clean file (only relative + green-control imports) round-trips through checkNoTasksImport-style scanning with zero hits", () => {
  const source = [
    'import { dispatchToolCall, listToolDefinitions } from "./registry.js";',
    'import { Server } from "@modelcontextprotocol/sdk/server/index.js";',
    "",
  ].join("\n");
  assert.deepEqual(findTasksImports(source), []);
});

// --- the mechanism used to LOAD a module never changes what it resolves
// to - a require(...) call, or a require obtained via createRequire(...),
// must be caught the same way a static/dynamic import is. ---

test("form 6: a require(...) call for the forbidden tasks subpath is caught, the same as a static import would be - AND the bare require reference is its own, independent violation", () => {
  const hits = findTasksImports('require("@modelcontextprotocol/sdk/experimental/tasks");\n');
  assert.ok(hits.includes("@modelcontextprotocol/sdk/experimental/tasks"));
  assert.ok(
    hits.some((h) => h.includes("references the global require")),
    `expected the require reference itself to also be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("form 6: a require(...) call for the bare /experimental barrel is caught too, alongside the require reference itself", () => {
  const hits = findTasksImports('require("@modelcontextprotocol/sdk/experimental");\n');
  assert.ok(hits.includes("@modelcontextprotocol/sdk/experimental"));
  assert.ok(hits.some((h) => h.includes("references the global require")));
});

test("form 7: calling createRequire(...) at all is flagged as forbidden, independent of what its returned function is used for - resolved at the IMPORT BINDING itself (see findCreateRequireImports's own doc comment in scripts/lib/ts-ast.mjs), not by matching the call's callee text, which could never see past a renamed import alias", () => {
  const hits = findTasksImports(
    'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n'
  );
  assert.equal(
    hits.length,
    1,
    `expected exactly the import-binding hit, got: ${JSON.stringify(hits)}`
  );
  assert.ok(
    hits.some((h) => h.includes("imports createRequire")),
    `expected the import-binding hit, got: ${JSON.stringify(hits)}`
  );
});

test("createRequire(...) imported from node:module is flagged at the import site; the local require it produces is then judged as the local callable it is, so a subsequent call through it - even with a forbidden Tasks specifier - adds no second hit, per the same local-binding rule that keeps an ordinary local require green", () => {
  const source = [
    'import { createRequire } from "node:module";',
    "const require = createRequire(import.meta.url);",
    'require("@modelcontextprotocol/sdk/experimental/tasks");',
    "",
  ].join("\n");
  const hits = findTasksImports(source);
  assert.equal(
    hits.length,
    1,
    `expected exactly the import-binding hit, got: ${JSON.stringify(hits)}`
  );
  assert.ok(hits.some((h) => h.includes("imports createRequire")));
});

test("a require(...) call with a computed/non-literal specifier fails CLOSED, the same principle already applied to a computed dynamic import() - AND the bare require reference is its own, independent violation", () => {
  const hits = findTasksImports(
    "const specifier = getSpecifierFromSomewhere();\nrequire(specifier);\n"
  );
  assert.ok(
    hits.some((h) => /computed/i.test(h)),
    `expected the unresolvable specifier to fail closed, got: ${JSON.stringify(hits)}`
  );
  assert.ok(
    hits.some((h) => h.includes("references the global require")),
    `expected the require reference itself to also be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a require(...) call to a legitimate, unrelated specifier produces no TASKS-import hit (the bare require reference is still its own, separate violation)", () => {
  const hits = findTasksImports('require("node:path");\n');
  assert.ok(
    !hits.includes("node:path"),
    `expected no Tasks-specifier-shaped hit, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a require(...) call through a LOCAL binding - a plain function that merely happens to be named require, never Node's real CommonJS require - is judged as the local callable: a forbidden-looking specifier passed to it is never treated as a real import", () => {
  const hits = findTasksImports(
    'function require(x: string) { return x; }\nrequire("@modelcontextprotocol/sdk/experimental/tasks");\n'
  );
  assert.deepEqual(
    hits,
    [],
    "a local require binding is the local callable, regardless of what its argument looks like"
  );
});

test("green control: a file with neither require nor createRequire at all stays clean", () => {
  const source = [
    'import { spawn } from "node:child_process";',
    'import path from "node:path";',
    "",
  ].join("\n");
  assert.deepEqual(findTasksImports(source), []);
});

// ---------------------------------------------------------------------------
// The guard's unit of analysis is the BINDING and its provenance, not the
// ImportDeclaration node: any route that can deliver createRequire (or the
// node:module namespace it lives on) is in scope, however it was obtained -
// including a dynamic `await import("node:module")` destructured for
// createRequire, which is just as executable a route to the forbidden
// Tasks subpath at runtime as a static import. Each row below is a
// distinct entry route, each independently caught, plus green controls
// proving legitimate dynamic imports and an unrelated property named
// "require" stay clean.
// ---------------------------------------------------------------------------

test("a dynamic import of node:module, destructured for createRequire, is caught - the executable survivor that motivated this fix", () => {
  const hits = findTasksImports(
    'const { createRequire: weaveBridge } = await import("node:module");\n' +
      "const retrieveUnit = weaveBridge(import.meta.url);\n" +
      'retrieveUnit("@modelcontextprotocol/sdk/experimental/tasks");\n'
  );
  assert.ok(
    hits.some((h) => h.includes("dynamically imports node:module")),
    `expected the dynamic-import binding hit, got: ${JSON.stringify(hits)}`
  );
});

test("a dynamic import of node:module assigned to a bare namespace variable is caught, independent of how the property is later accessed", () => {
  const hits = findTasksImports(
    'const m = await import("node:module");\nm.createRequire(import.meta.url);\n'
  );
  assert.ok(hits.some((h) => h.includes("dynamically imports node:module")));
});

test("a dynamic import of node:module consumed via .then(...) is caught, the same call node as the awaited forms", () => {
  const hits = findTasksImports(
    'import("node:module").then((m) => { m.createRequire(import.meta.url); });\n'
  );
  assert.ok(hits.some((h) => h.includes("dynamically imports node:module")));
});

test("a dynamic import of the unprefixed 'module' specifier is caught too, not just the 'node:module' spelling", () => {
  const hits = findTasksImports('const { createRequire } = await import("module");\n');
  assert.ok(hits.some((h) => h.includes("dynamically imports node:module")));
});

test('TypeScript import-equals (import X = require("node:module")) is caught - binds the whole namespace the same as a default import', () => {
  const hits = findTasksImports(
    'import moduleCrate = require("node:module");\nmoduleCrate.createRequire(import.meta.url);\n'
  );
  assert.ok(
    hits.some((h) => h.includes("import-equals")),
    `expected the import-equals binding hit, got: ${JSON.stringify(hits)}`
  );
});

test('a bare CommonJS require("node:module") call is caught - reaches createRequire transitively via the whole module object', () => {
  const hits = findTasksImports('require("node:module").createRequire(import.meta.url);\n');
  assert.ok(
    hits.some((h) => h.includes("references the global require")),
    `expected the commonjs-require binding hit, got: ${JSON.stringify(hits)}`
  );
});

test("module.require(...) is caught - Node's per-module CommonJS require, a second CommonJS-interop primitive distinct from the global require", () => {
  const hits = findTasksImports(
    'module.require("@modelcontextprotocol/sdk/experimental/tasks");\n'
  );
  assert.ok(
    hits.some((h) => h.includes("references the global module")),
    `expected the module-require binding hit, got: ${JSON.stringify(hits)}`
  );
});

test("a named re-export of createRequire from node:module is caught - hands the capability to whatever module imports the re-exported name", () => {
  const hits = findTasksImports('export { createRequire as exportedBridge } from "node:module";\n');
  assert.ok(
    hits.some((h) => h.includes("re-exports createRequire")),
    `expected the re-export binding hit, got: ${JSON.stringify(hits)}`
  );
});

test("a wildcard re-export of node:module is caught - exposes createRequire transitively the same as a namespace import", () => {
  const hits = findTasksImports('export * from "node:module";\n');
  assert.ok(hits.some((h) => h.includes("re-exports the whole node:module namespace")));
});

test("a namespace-aliased re-export (export * as ns from node:module) is caught too", () => {
  const hits = findTasksImports('export * as ns from "node:module";\n');
  assert.ok(hits.some((h) => h.includes("re-exports the whole node:module namespace")));
});

test("the static aliased-import form from the prior fix still regresses to RED - this fix widens the guard, it does not narrow it", () => {
  const hits = findTasksImports('import { createRequire as makeLoader } from "node:module";\n');
  assert.ok(hits.some((h) => h.includes("imports createRequire")));
});

// ---------------------------------------------------------------------------
// module.require(...) is a single primitive regardless of how the property
// access is spelled or wrapped - dotted, computed/bracket, and any depth of
// parenthesization all denote it, and the guard's own contract already said
// spelling must not change the result. These two rows are the executable
// survivors that showed the guard was not living up to that contract yet.
// ---------------------------------------------------------------------------

test("module.require(...) is caught via computed/bracket property access, not just the dotted spelling", () => {
  const hits = findTasksImports(
    'const moduleDeck = module["require"]("node:module");\n' +
      "const pull = moduleDeck.createRequire(import.meta.url);\n"
  );
  assert.ok(
    hits.some((h) => h.includes("references the global module")),
    `expected the module-require binding hit, got: ${JSON.stringify(hits)}`
  );
});

test("module.require(...) is caught through a parenthesized callee, not just the unwrapped spelling", () => {
  const hits = findTasksImports(
    'const moduleDeck = (module.require)("node:module");\n' +
      "const pull = moduleDeck.createRequire(import.meta.url);\n"
  );
  assert.ok(
    hits.some((h) => h.includes("references the global module")),
    `expected the module-require binding hit, got: ${JSON.stringify(hits)}`
  );
});

// ---------------------------------------------------------------------------
// eval(...) and Function(...) are prohibited OUTRIGHT - flagged
// unconditionally on their argument, never analysed, because what either
// produces is undecidable in general. Both are real, executable routes to
// obtaining node:module dynamically and reaching the forbidden Tasks
// subpath from it.
// ---------------------------------------------------------------------------

test("eval(...) used to obtain a dynamic loader is caught, unconditionally on its argument", () => {
  const hits = findTasksImports(
    "const moduleDeck = await eval('import(\"node:module\")');\n" +
      "const pull = moduleDeck.createRequire(import.meta.url);\n" +
      'pull("@modelcontextprotocol/sdk/experimental/tasks");\n'
  );
  assert.ok(
    hits.some((h) => h.includes("references the global eval")),
    `expected the eval-call hit, got: ${JSON.stringify(hits)}`
  );
});

test("Function(...) used to construct a dynamic loader is caught, unconditionally on its argument", () => {
  const hits = findTasksImports(
    "const importModule = Function('return import(\"node:module\")');\n" +
      "const moduleDeck = await importModule();\n" +
      "const pull = moduleDeck.createRequire(import.meta.url);\n" +
      'pull("@modelcontextprotocol/sdk/experimental/tasks");\n'
  );
  assert.ok(
    hits.some((h) => h.includes("references the global Function")),
    `expected the function-constructor-call hit, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a bare eval(...) call with an argument unrelated to any loader is still flagged - the prohibition is unconditional, not content-aware", () => {
  const hits = findTasksImports('eval("1 + 1");\n');
  assert.ok(hits.some((h) => h.includes("references the global eval")));
});

// ---------------------------------------------------------------------------
// Type-only knowledge of createRequire is permitted; only a binding that can
// come to hold the runtime capability is forbidden. A statement-level
// `import type` (or an inline `type` specifier) is fully erased by
// TypeScript and cannot yield a callable loader under any circumstance -
// flagging it would be over-blocking, a failure in its own right. A MIXED
// clause must still red on its value specifier: the type modifier is
// checked per-specifier, never treated as clearing the whole clause.
// ---------------------------------------------------------------------------

test("green control: a statement-level 'import type' of createRequire is never flagged - fully erased, no runtime capability", () => {
  const hits = findTasksImports(
    'import type { createRequire } from "node:module";\n' +
      "export type LoaderFactory = typeof createRequire;\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: an inline 'type' specifier on createRequire is never flagged, even though the import statement itself survives", () => {
  const hits = findTasksImports('import { type createRequire } from "node:module";\n');
  assert.deepEqual(hits, []);
});

test("a MIXED import clause still reds on its value specifier - a sibling type-only specifier never suppresses it", () => {
  const hits = findTasksImports('import { createRequire, type Something } from "node:module";\n');
  assert.ok(
    hits.some((h) => h.includes("imports createRequire")),
    `expected the value specifier to still be flagged despite the type-only sibling, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a statement-level 'export type' re-export of createRequire is never flagged - fully erased, hands off no capability", () => {
  const hits = findTasksImports('export type { createRequire } from "node:module";\n');
  assert.deepEqual(hits, []);
});

test("green control: a dynamic import of a legitimate, unrelated module is never flagged", () => {
  const hits = findTasksImports('const mod = await import("./registry.js");\n');
  assert.deepEqual(hits, []);
});

test("green control: a dynamic import of an unrelated Node builtin, destructured and aliased, is never flagged", () => {
  const hits = findTasksImports('const { readFile: rf } = await import("node:fs/promises");\n');
  assert.deepEqual(hits, []);
});

test("green control: an unrelated object's own .require(...) method is never confused with module.require", () => {
  const hits = findTasksImports('someOtherObject.require("./x.js");\n');
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// The forbidden globals are resolved by real lexical scope, not by name -
// a LOCAL binding that merely happens to be spelled the same as one of the
// four never carries the capability. `globalThis` is covered here
// specifically because a module/block-scope `const globalThis = ...`
// resolves through a different code path than an ordinary parameter shadow
// (see ts-ast.mjs's own doc comment on `isUnshadowedGlobalThisReference`).
// A LOCAL require/createRequire binding is judged as the local callable it
// is - its argument's shape (even a sibling-looking or Tasks-looking
// literal) is never treated as a real specifier once the callee itself is
// shadowed, matching the same green-control principle throughout.
// ---------------------------------------------------------------------------

test("green control: a local const named globalThis, holding harmless properties named eval/Function/require, is never confused with the real global object", () => {
  const hits = findTasksImports(
    "const globalThis = { eval: () => 1, Function: () => 1, require: () => 1 };\n" +
      "void globalThis.eval; void globalThis.Function; void globalThis.require;\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: a parameter named globalThis shadows the real global object inside its own function body", () => {
  const hits = findTasksImports(
    "function inspect(globalThis: any, key: string) { void globalThis[key]; }\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: a local const named module is never confused with the real CommonJS module global, even when it carries its own .require", () => {
  const hits = findTasksImports(
    'const module = { require: (x: string) => x };\nmodule.require("x");\n'
  );
  assert.deepEqual(hits, []);
});

test("green control: a parameter named module shadows the real CommonJS module global inside its own function body", () => {
  const hits = findTasksImports('function foo(module: any) { module.require("x"); }\n');
  assert.deepEqual(hits, []);
});

test("green control: typeof module.require used AS A TYPE is fully erased and carries no runtime capability", () => {
  const hits = findTasksImports("export type RequireShape = typeof module.require;\n");
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// A destructured PARAMETER's own DEFAULT value uses the same `.initializer`
// field a VariableDeclaration's initializer does, for a different purpose -
// `function f({ eval } = globalThis)` fires the default whenever a caller
// omits the argument, so it is exactly as real an acquisition as a
// variable declaration's initializer, not a hypothetical. Permanent
// regression coverage for both directions in one place, so the parameter
// extension can never quietly broaden into flagging a harmless default or
// a catch binding (which has no default at all to check against).
// ---------------------------------------------------------------------------

test("a destructured parameter DEFAULTED from the real globalThis is an acquisition, the same as a variable declaration's initializer", () => {
  const hits = findTasksImports(
    "function acquire({ eval: execute }: any = globalThis) { void execute; }\n"
  );
  assert.ok(
    hits.some((h) => h.includes("references the global eval")),
    `expected the destructured default off globalThis to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a destructured parameter defaulted from a HARMLESS source is never flagged, regardless of its key names", () => {
  const hits = findTasksImports(
    "function acquire({ eval: execute, Function: fn, require: req, module: mod }: any = {}) {\n" +
      "  void execute; void fn; void req; void mod;\n" +
      "}\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: a catch clause's destructuring pattern has no initializer to check against at all, and stays green regardless of key names", () => {
  const hits = findTasksImports(
    "try { void 0; } catch ({ eval: execute, Function: fn, require: req, module: mod }) {\n" +
      "  void execute; void fn; void req; void mod;\n" +
      "}\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: a require(...) call through a local binding with a SIBLING-looking literal is judged as the local callable, not a real module load", () => {
  const hits = findTasksImports(
    'const require = (x: string) => x;\nrequire("@modelcontextprotocol/sdk/experimental/tasks");\n'
  );
  assert.deepEqual(hits, []);
});

test("green control: a require(...) call through a local binding with a COMPUTED argument is judged as the local callable - never treated as an unresolvable real specifier failing closed", () => {
  const hits = findTasksImports(
    "const require = (x: string) => x;\nconst target = getTarget();\nrequire(target);\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: a local const named createRequire, unrelated to node:module, is never confused with the real createRequire", () => {
  const hits = findTasksImports(
    'const createRequire = () => "safe";\ncreateRequire(import.meta.url);\n'
  );
  assert.deepEqual(hits, []);
});

test("green control: createRequire imported from a package OTHER than node:module is never flagged - only the node:module-sourced binding is forbidden", () => {
  const hits = findTasksImports(
    'import { createRequire } from "safe-package";\ncreateRequire(import.meta.url);\n'
  );
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// process.getBuiltinModule, the bare Reflect global, and the .constructor
// property are all closed as of this file - see findCreateRequireImports's
// own doc comment for the full acquisition-site design and why banning the
// whole Reflect/.constructor surface (rather than pattern-matching one
// demonstrated combination of them) is what actually closes that specific
// class, plus why the broader reflective/structural category is not
// claimed exhausted by doing so.
// ---------------------------------------------------------------------------

test("REGRESSION: obtaining the Function constructor via an ordinary function object's own .constructor property IS now detected", () => {
  const hits = findTasksImports('const F = (() => 1).constructor;\nF("return 1");\n');
  assert.ok(
    hits.some((hit) => hit.includes(".constructor")),
    `expected a constructor-property-access violation, got: ${JSON.stringify(hits)}`
  );
});

test('REGRESSION: obtaining the global eval via Reflect.get(globalThis, "eval") IS now detected - at the bare Reflect reference itself', () => {
  const hits = findTasksImports('const e = Reflect.get(globalThis, "eval");\ne("1");\n');
  assert.ok(
    hits.some((hit) => hit.includes("references the global Reflect")),
    `expected a reflect-reference violation, got: ${JSON.stringify(hits)}`
  );
});

test("Reflect is flagged at the ACQUISITION site regardless of which method is used or how the reference is stored", () => {
  const hits = findTasksImports("const R = Reflect;\nR.construct(Object, []);\n");
  assert.ok(
    hits.some((hit) => hit.includes("references the global Reflect")),
    `expected the aliased Reflect reference to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a LOCALLY SHADOWED Reflect (never the real global) is never flagged", () => {
  const hits = findTasksImports(
    "function f(Reflect: { get: (t: unknown, k: string) => unknown }) {\n" +
      '  return Reflect.get(globalThis, "eval");\n' +
      "}\n"
  );
  assert.deepEqual(hits, []);
});

test(".constructor is flagged on ANY base, not just a known-dangerous one - a plain object literal's .constructor is just as flagged as a function's", () => {
  const hits = findTasksImports("const c = ({}).constructor;\n");
  assert.ok(
    hits.some((hit) => hit.includes(".constructor")),
    `expected the plain-object .constructor access to be flagged too, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a class's OWN constructor method declaration is never confused with a .constructor property READ - defining a constructor is not an acquisition", () => {
  const hits = findTasksImports(
    "class Foo {\n  constructor() {\n    this.ready = true;\n  }\n}\nnew Foo();\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: an object literal's own 'constructor' property KEY (defining, not reading) is never flagged", () => {
  const hits = findTasksImports('const obj = { constructor: () => "not a real class" };\n');
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// globalThis/process ONE-HOP ALIAS - a local binding that comes to hold the
// real globalThis/process, either via its own declaration initializer or a
// later bare reassignment, is exactly as real an acquisition route as the
// bare name would have been. REGRESSION coverage: a prior version of the
// resolution helper only recognized `symbol === undefined` as the signal
// that a `globalThis` reference is genuinely unshadowed, but the real
// checker returns a TRUTHY symbol with an EMPTY `.declarations` array for
// that exact case - so the direct, non-aliased form (`globalThis.eval(...)`
// with no local shadow anywhere) silently stopped being detected at all.
// That regression is caught here alongside the new alias coverage, since
// both routes share the same underlying resolution function.
// ---------------------------------------------------------------------------

test("REGRESSION: a direct, unshadowed globalThis.eval(...) reference (no alias, no local shadow) is detected", () => {
  const hits = findTasksImports("globalThis.eval('1');\n");
  assert.ok(
    hits.some((h) => h.includes("references the global eval")),
    `expected the direct globalThis.eval access to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("REGRESSION: a direct, unshadowed globalThis['eval'] (computed) reference is detected too", () => {
  const hits = findTasksImports("globalThis['eval']('1');\n");
  assert.ok(
    hits.some((h) => h.includes("references the global eval")),
    `expected the direct computed globalThis['eval'] access to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("a local const aliasing globalThis, then accessed through the alias, is caught - const g = globalThis; g.eval(x)", () => {
  const hits = findTasksImports("const g = globalThis;\ng.eval('1');\n");
  assert.ok(
    hits.some((h) => h.includes("references the global eval")),
    `expected the one-hop globalThis alias to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("a local const aliasing process's BASE (not just its method), then accessed through the alias, is caught - const p = process; p.getBuiltinModule(...)", () => {
  const hits = findTasksImports("const p = process;\np.getBuiltinModule('node:module');\n");
  assert.ok(
    hits.some((h) => h.includes("getBuiltinModule")),
    `expected the one-hop process BASE alias to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("a BARE REASSIGNMENT (no initializer on the variable's own declaration) aliasing globalThis is caught the same as a declaration initializer - let g; g = globalThis; g.eval(x)", () => {
  const hits = findTasksImports("let g;\ng = globalThis;\ng.eval('1');\n");
  assert.ok(
    hits.some((h) => h.includes("references the global eval")),
    `expected the bare-reassignment globalThis alias to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("a bare reassignment aliasing process is caught the same way - let p; p = process; p.getBuiltinModule(...)", () => {
  const hits = findTasksImports("let p;\np = process;\np.getBuiltinModule('node:module');\n");
  assert.ok(
    hits.some((h) => h.includes("getBuiltinModule")),
    `expected the bare-reassignment process alias to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("a reassignment aliasing globalThis AFTER an unrelated initializer is still caught - let g = 5; g = globalThis; g.eval(x)", () => {
  const hits = findTasksImports("let g = 5;\ng = globalThis;\ng.eval('1');\n");
  assert.ok(
    hits.some((h) => h.includes("references the global eval")),
    `expected the reassignment to be flagged despite the harmless initial value, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a locally SHADOWED globalThis aliased through a const is never flagged, even though the alias-resolution machinery now checks reassignments too", () => {
  const hits = findTasksImports(
    "const globalThis = { eval: () => 1 };\nconst g = globalThis;\ng.eval('1');\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: an unrelated bare reassignment (never process/globalThis) is never flagged", () => {
  const hits = findTasksImports("let x;\nx = 5;\nvoid x;\n");
  assert.deepEqual(hits, []);
});

test("documented boundary: a TWO-HOP alias chain is not chased (const g = globalThis; const h = g; h.eval(x)) - a further row if this shape is ever demonstrated live, not a claim this function already covers", () => {
  const hits = findTasksImports("const g = globalThis;\nconst h = g;\nh.eval('1');\n");
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// Object.getOwnPropertyDescriptor - a DESCRIPTOR READ reaches the same value
// a direct property access would, without ever writing the target's key as
// a real property-access AST node - an independent adversarial pass proved
// both rows below guard-green and runtime-executing before this guard
// recognized Object.getOwnPropertyDescriptor as an acquisition site at all.
// ---------------------------------------------------------------------------

test('Object.getOwnPropertyDescriptor(globalThis, "eval")?.value reaches the real eval through a descriptor read, not a direct property access, and is caught', () => {
  const hits = findTasksImports(
    "const e = Object.getOwnPropertyDescriptor(globalThis, 'eval')?.value;\ne('1');\n"
  );
  assert.ok(
    hits.some((h) => h.includes("getOwnPropertyDescriptor")),
    `expected a property-descriptor-access violation, got: ${JSON.stringify(hits)}`
  );
});

test('Object.getOwnPropertyDescriptor(Object.getPrototypeOf(fn), "constructor")?.value reaches .constructor through a descriptor read off an ARBITRARY target - caught unconditionally on the key, the same as a direct .constructor access', () => {
  const hits = findTasksImports(
    "const fn = () => {};\n" +
      "const F = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(fn), 'constructor')?.value;\n" +
      "F('return 1');\n"
  );
  assert.ok(
    hits.some((h) => h.includes("getOwnPropertyDescriptor")),
    `expected a property-descriptor-access violation, got: ${JSON.stringify(hits)}`
  );
});

test('a descriptor read via computed/bracket Object["getOwnPropertyDescriptor"] is caught too, not just the dotted spelling', () => {
  const hits = findTasksImports(
    "const d = Object['getOwnPropertyDescriptor'](globalThis, 'eval');\n"
  );
  assert.ok(hits.some((h) => h.includes("getOwnPropertyDescriptor")));
});

test("a descriptor read targeting process's own dangerous property is caught the same way", () => {
  const hits = findTasksImports(
    "const d = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule');\n"
  );
  assert.ok(hits.some((h) => h.includes("getOwnPropertyDescriptor")));
});

test("a descriptor key resolved through one local alias hop (const k = 'eval'; Object.getOwnPropertyDescriptor(globalThis, k)) is caught, not just a literal key", () => {
  const hits = findTasksImports(
    "const k = 'eval';\nconst d = Object.getOwnPropertyDescriptor(globalThis, k);\n"
  );
  assert.ok(hits.some((h) => h.includes("getOwnPropertyDescriptor")));
});

test("fail-closed: a descriptor read off globalThis with a genuinely unresolvable key is flagged, cannot prove it avoids a forbidden name", () => {
  const hits = findTasksImports(
    "const key = getKey();\nconst d = Object.getOwnPropertyDescriptor(globalThis, key);\n"
  );
  assert.ok(
    hits.some((h) => h.includes("getOwnPropertyDescriptor")),
    `expected the unresolvable-key descriptor read to fail closed, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a LOCALLY SHADOWED Object is never flagged, even for a descriptor read against globalThis", () => {
  const hits = findTasksImports(
    "const Object = { getOwnPropertyDescriptor: () => undefined };\n" +
      "const d = Object.getOwnPropertyDescriptor(globalThis, 'eval');\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: a descriptor read off an unrelated, harmless object with an unrelated key is never flagged", () => {
  const hits = findTasksImports(
    "const safe = {};\nconst d = Object.getOwnPropertyDescriptor(safe, 'eval');\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: a descriptor read for a harmless property on the real process global is never flagged - only the dangerous three properties are", () => {
  const hits = findTasksImports("const d = Object.getOwnPropertyDescriptor(process, 'env');\n");
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// process.getBuiltinModule - REGRESSION: an executable fixture demonstrated
// this route reaches createRequire via a supported Node builtin-module API
// with no import/require syntax naming "node:module" anywhere - previously
// undetected, now flagged at the property-access acquisition site the same
// way the four bare globals are.
// ---------------------------------------------------------------------------

test('REGRESSION: process.getBuiltinModule("node:module").createRequire(...) IS now detected (prior out-of-scope ruling overturned by an executable fixture)', () => {
  const hits = findTasksImports(
    'const r = process.getBuiltinModule("node:module").createRequire(import.meta.url);\n' +
      'r("@modelcontextprotocol/sdk/experimental/tasks");\n'
  );
  assert.ok(
    hits.some((hit) => hit.includes("getBuiltinModule")),
    `expected a process.getBuiltinModule violation, got: ${JSON.stringify(hits)}`
  );
});

test("process.getBuiltinModule is flagged at the ACQUISITION site regardless of invocation shape - stored, aliased, never immediately called", () => {
  const hits = findTasksImports(
    "const acquire = process.getBuiltinModule;\nconst mod = acquire('node:module');\n"
  );
  assert.ok(
    hits.some((hit) => hit.includes("getBuiltinModule")),
    `expected the aliased acquisition to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test('process.getBuiltinModule via bracket notation ("computed" but statically foldable) is still detected', () => {
  const hits = findTasksImports('const m = process["getBuiltinModule"]("node:module");\n');
  assert.ok(
    hits.some((hit) => hit.includes("getBuiltinModule")),
    `expected the bracket-notation access to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("process.getBuiltinModule via a folded string-concatenation key is still detected", () => {
  const hits = findTasksImports('const m = process["getBuiltin" + "Module"]("node:module");\n');
  assert.ok(
    hits.some((hit) => hit.includes("getBuiltinModule")),
    `expected the concatenated-key access to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("fail-closed: a COMPUTED, non-statically-foldable property key on process is flagged - this guard cannot prove it does not reach .getBuiltinModule", () => {
  const hits = findTasksImports("const key = getKey();\nconst m = process[key]();\n");
  assert.ok(
    hits.some((hit) => hit.includes("computed property of process")),
    `expected an unresolvable-process-access violation, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a LOCALLY SHADOWED process (never the real global) accessing .getBuiltinModule is never flagged", () => {
  const hits = findTasksImports(
    "function f(process: { getBuiltinModule: (id: string) => unknown }) {\n" +
      '  return process.getBuiltinModule("node:module");\n' +
      "}\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: every OTHER property of the real process global stays completely unflagged - only .getBuiltinModule is dangerous", () => {
  const hits = findTasksImports(
    "const a = process.env;\n" +
      "const b = process.platform;\n" +
      "const c = process.cwd();\n" +
      "const d = process.argv;\n" +
      'process.kill(1, "SIGTERM");\n'
  );
  assert.deepEqual(hits, []);
});

test("green control: process.getBuiltinModule called with a DIFFERENT builtin (not node:module) is still flagged at the acquisition site - the property reference itself is the violation, independent of the argument", () => {
  // This is deliberately NOT a green control in the usual sense: the
  // acquisition-site design (see ts-ast.mjs's own header) flags the bare
  // process.getBuiltinModule REFERENCE, unconditionally on what it is
  // later called with - the same principle that makes `const r = require;
  // r("anything")` a violation at `r`'s own definition, not at the call.
  // A real green control for "process.getBuiltinModule genuinely unused"
  // is the passing test suite everywhere this string never appears.
  const hits = findTasksImports('const fsModule = process.getBuiltinModule("fs");\n');
  assert.ok(
    hits.some((hit) => hit.includes("getBuiltinModule")),
    `expected the acquisition itself to be flagged regardless of argument, got: ${JSON.stringify(hits)}`
  );
});
