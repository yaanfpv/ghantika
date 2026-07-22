import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FROZEN_MODULES,
  checkFrozenModuleSet,
  checkModuleBoundaries,
  findPersistentStateDeclarations,
  findSiblingToolImports,
  listTsFilesUnder,
} from "../scripts/check-module-boundaries.mjs";

/** A tiny helper for tests that only need `findSiblingToolImports`'s specifier/violation-label list, not the fixture-file machinery `buildFixtureSrc` sets up below. */
function siblingImportsFrom(sourceText: string): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-sibling-import-"));
  const toolsDir = path.join(dir, "tools");
  try {
    return findSiblingToolImports(sourceText, path.join(toolsDir, "run.ts"), toolsDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the real src/ tree, as it exists right now, must be clean ---

test("the real src/ tree satisfies the frozen module set exactly", () => {
  const { extra, missing } = checkFrozenModuleSet();
  assert.deepEqual(extra, [], `unexpected extra files: ${JSON.stringify(extra)}`);
  assert.deepEqual(missing, [], `missing required files: ${JSON.stringify(missing)}`);
});

test("the real src/ tree has zero module-boundary violations", () => {
  assert.deepEqual(checkModuleBoundaries(), []);
});

test("FROZEN_MODULES lists exactly ten modules: four core files plus six tool handlers", () => {
  assert.equal(FROZEN_MODULES.length, 10);
  const core = FROZEN_MODULES.filter((f) => !f.startsWith("tools/"));
  const tools = FROZEN_MODULES.filter((f) => f.startsWith("tools/"));
  assert.deepEqual([...core].sort(), ["jobStore.ts", "process.ts", "registry.ts", "server.ts"]);
  assert.deepEqual([...tools].sort(), [
    "tools/kill.ts",
    "tools/list.ts",
    "tools/output.ts",
    "tools/run.ts",
    "tools/status.ts",
    "tools/tail.ts",
  ]);
});

// --- file-COUNT mutants (collapse/split), via a real scratch src/ tree ---

function buildFixtureSrc(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-module-boundaries-"));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const CLEAN_FIXTURE_FILES: Record<string, string> = Object.fromEntries(
  FROZEN_MODULES.map((f) => [f, "// fixture module\nexport const marker = true;\n"])
);
CLEAN_FIXTURE_FILES["index.ts"] = "// entry point, excluded from the frozen set\n";

test("an exact ten-file fixture (matching FROZEN_MODULES) is reported clean", () => {
  const dir = buildFixtureSrc(CLEAN_FIXTURE_FILES);
  try {
    assert.deepEqual(checkFrozenModuleSet(dir), { extra: [], missing: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collapsing two tool handlers into one file is caught as a missing module", () => {
  const collapsed = { ...CLEAN_FIXTURE_FILES };
  delete collapsed["tools/tail.ts"];
  // Simulates "kill.ts" absorbing tail's responsibility too - the file
  // count under tools/ drops from six to five.
  collapsed["tools/kill.ts"] =
    "// now also handles tail, in violation of the one-tool-per-file rule\n";
  const dir = buildFixtureSrc(collapsed);
  try {
    const { extra, missing } = checkFrozenModuleSet(dir);
    assert.deepEqual(extra, []);
    assert.deepEqual(missing, ["tools/tail.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("splitting a tool handler into a seventh tools/ file is caught as extra", () => {
  const split = {
    ...CLEAN_FIXTURE_FILES,
    "tools/run-helpers.ts": "// a stray seventh file under tools/\n",
  };
  const dir = buildFixtureSrc(split);
  try {
    const { extra, missing } = checkFrozenModuleSet(dir);
    assert.deepEqual(extra, ["tools/run-helpers.ts"]);
    assert.deepEqual(missing, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an extra core-level file (outside tools/) is caught as extra too", () => {
  const split = { ...CLEAN_FIXTURE_FILES, "schema.ts": "// a stray extra internal module\n" };
  const dir = buildFixtureSrc(split);
  try {
    const { extra } = checkFrozenModuleSet(dir);
    assert.deepEqual(extra, ["schema.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listTsFilesUnder is zero-match-safe against a directory that doesn't exist", () => {
  assert.deepEqual(listTsFilesUnder(path.join(tmpdir(), "ghantika-nonexistent-dir-xyz")), []);
});

// --- sibling-import guard, via real path resolution ---

test('a tools/*.ts file importing a sibling via "./other.js" is caught', () => {
  const dir = buildFixtureSrc({});
  const toolsDir = path.join(dir, "tools");
  try {
    const importing = path.join(toolsDir, "run.ts");
    const hits = findSiblingToolImports(
      'import { name } from "./status.js";\n',
      importing,
      toolsDir
    );
    assert.deepEqual(hits, ["./status.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a sibling import spelled the roundabout way ("../tools/other.js") is caught too', () => {
  const dir = buildFixtureSrc({});
  const toolsDir = path.join(dir, "tools");
  try {
    const importing = path.join(toolsDir, "run.ts");
    const hits = findSiblingToolImports(
      'import { name } from "../tools/status.js";\n',
      importing,
      toolsDir
    );
    assert.deepEqual(hits, ["../tools/status.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("green control: a tools/*.ts file importing registry.ts, jobStore.ts, or the SDK is never flagged as a sibling import", () => {
  const dir = buildFixtureSrc({});
  const toolsDir = path.join(dir, "tools");
  try {
    const importing = path.join(toolsDir, "run.ts");
    const source = [
      'import type { CallToolResult, Tool } from "@modelcontextprotocol/server";',
      'import { dispatchToolCall } from "../registry.js";',
      'import { JobStore } from "../jobStore.js";',
      "",
    ].join("\n");
    assert.deepEqual(findSiblingToolImports(source, importing, toolsDir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation control: the real src/tools/*.ts files, scanned directly, produce zero sibling imports", () => {
  const violations = checkModuleBoundaries();
  const siblingViolations = violations.filter((v) => v.includes("imports sibling"));
  assert.deepEqual(siblingViolations, []);
});

// --- the sibling-import check must catch CommonJS loading forms too, not
// just ES import/export/dynamic-import() - the mechanism used to load a
// module never changes what it resolves to. ---

test("a tools/*.ts file loading a sibling via a bare require(...) call is caught, the same as an ES import would be", () => {
  const hits = siblingImportsFrom('require("./status.js");\n');
  // The sibling specifier is caught, AND the bare require reference is its
  // own independent violation (the global require is forbidden at the
  // point of reference regardless of target) - both hits, not one instead
  // of the other.
  assert.ok(
    hits.includes("./status.js"),
    `expected the sibling specifier hit, got: ${JSON.stringify(hits)}`
  );
  assert.ok(
    hits.some((h) => h.includes("references the global require")),
    `expected the require reference itself to also be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("createRequire(...) imported from node:module is flagged at the import site; the local require it produces is then judged as the local callable it is, so a subsequent call through it - even to a sibling-looking specifier - adds no second hit, per the same local-binding rule that keeps an ordinary local require green", () => {
  const source = [
    'import { createRequire } from "node:module";',
    "const require = createRequire(import.meta.url);",
    'require("./status.js");',
    "",
  ].join("\n");
  const hits = siblingImportsFrom(source);
  assert.equal(
    hits.length,
    1,
    `expected exactly the import-binding hit, got: ${JSON.stringify(hits)}`
  );
  assert.ok(hits.some((h) => h.includes("imports createRequire")));
});

test("createRequire(...) called with its return value never used at all is STILL flagged - calling it is the violation, independent of what (if anything) is done with the returned function", () => {
  const hits = siblingImportsFrom(
    'import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\n'
  );
  assert.ok(
    hits.some((h) => h.includes("createRequire")),
    `expected createRequire(...) to be flagged even though its return value is unused, got: ${JSON.stringify(hits)}`
  );
});

test("a require(...) call with a computed/non-literal specifier fails CLOSED - reported as a violation, never silently skipped", () => {
  const hits = siblingImportsFrom(
    "const specifier = getSpecifierFromSomewhere();\nrequire(specifier);\n"
  );
  assert.ok(
    hits.some((h) => /computed/i.test(h)),
    `expected the unresolvable specifier to fail closed, got: ${JSON.stringify(hits)}`
  );
  // The bare `require` reference is ALSO its own, independent violation now
  // (the global require is forbidden at the point of reference, regardless
  // of target) - both hits are expected together, not one instead of the
  // other.
  assert.ok(
    hits.some((h) => h.includes("references the global require")),
    `expected the require reference itself to also be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a require(...) call to a legitimate, non-sibling specifier produces no SIBLING-import hit (the bare require reference is still its own, separate violation - see the acquisition-site tests below)", () => {
  const hits = siblingImportsFrom('require("node:path");\n');
  assert.ok(
    !hits.some((h) => h === "node:path" || h.startsWith(".")),
    `expected no sibling-shaped hit, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a plain function that happens to be named require but is locally defined (never a real CommonJS require) is judged as the local callable it is - a sibling-looking argument passed to it is never treated as a real import, matching the same local-binding rule applied to every other forbidden name", () => {
  const hits = siblingImportsFrom(
    'function require(x: string) { return x; }\nrequire("./status.js");\n'
  );
  assert.deepEqual(
    hits,
    [],
    "a local require declaration is a real lexical shadow of the global - its argument's shape is irrelevant once the callee itself resolves locally"
  );
});

// ---------------------------------------------------------------------------
// The guard's unit of analysis is the BINDING and its provenance, not the
// ImportDeclaration node: any route that can deliver createRequire (or the
// node:module namespace it lives on) is in scope, however it was obtained -
// including a dynamic `await import("node:module")` destructured for
// createRequire, which is just as executable a route to a sibling
// tools/*.ts file at runtime as a static import. Same entry routes as
// no-tasks-import.test.ts, exercised here against the sibling-import guard.
// ---------------------------------------------------------------------------

test("a dynamic import of node:module, destructured for createRequire, is caught", () => {
  const hits = siblingImportsFrom(
    'const { createRequire: weaveBridge } = await import("node:module");\n' +
      "const retrieveUnit = weaveBridge(import.meta.url);\n" +
      'retrieveUnit("./status.js");\n'
  );
  assert.ok(
    hits.some((h) => h.includes("dynamically imports node:module")),
    `expected the dynamic-import binding hit, got: ${JSON.stringify(hits)}`
  );
});

test("a dynamic import of node:module assigned to a bare namespace variable is caught, independent of how the property is later accessed", () => {
  const hits = siblingImportsFrom(
    'const m = await import("node:module");\nm.createRequire(import.meta.url);\n'
  );
  assert.ok(hits.some((h) => h.includes("dynamically imports node:module")));
});

test("a dynamic import of node:module consumed via .then(...) is caught, the same call node as the awaited forms", () => {
  const hits = siblingImportsFrom(
    'import("node:module").then((m) => { m.createRequire(import.meta.url); });\n'
  );
  assert.ok(hits.some((h) => h.includes("dynamically imports node:module")));
});

test('TypeScript import-equals (import X = require("node:module")) is caught - binds the whole namespace the same as a default import', () => {
  const hits = siblingImportsFrom(
    'import moduleCrate = require("node:module");\nmoduleCrate.createRequire(import.meta.url);\n'
  );
  assert.ok(
    hits.some((h) => h.includes("import-equals")),
    `expected the import-equals binding hit, got: ${JSON.stringify(hits)}`
  );
});

test('a bare CommonJS require("node:module") call is caught - reaches createRequire transitively via the whole module object', () => {
  const hits = siblingImportsFrom('require("node:module").createRequire(import.meta.url);\n');
  assert.ok(
    hits.some((h) => h.includes("references the global require")),
    `expected the commonjs-require binding hit, got: ${JSON.stringify(hits)}`
  );
});

test("module.require(...) is caught - Node's per-module CommonJS require, a second CommonJS-interop primitive distinct from the global require", () => {
  const hits = siblingImportsFrom('module.require("./status.js");\n');
  assert.ok(
    hits.some((h) => h.includes("references the global module")),
    `expected the module-require binding hit, got: ${JSON.stringify(hits)}`
  );
});

test("a named re-export of createRequire from node:module is caught - hands the capability to whatever module imports the re-exported name", () => {
  const hits = siblingImportsFrom(
    'export { createRequire as exportedBridge } from "node:module";\n'
  );
  assert.ok(hits.some((h) => h.includes("re-exports createRequire")));
});

test("a wildcard re-export of node:module is caught - exposes createRequire transitively the same as a namespace import", () => {
  const hits = siblingImportsFrom('export * from "node:module";\n');
  assert.ok(hits.some((h) => h.includes("re-exports the whole node:module namespace")));
});

test("green control: a dynamic import of a legitimate, non-sibling module is never flagged", () => {
  const hits = siblingImportsFrom('const mod = await import("node:path");\n');
  assert.deepEqual(hits, []);
});

test("green control: an unrelated object's own .require(...) method is never confused with module.require", () => {
  const hits = siblingImportsFrom('someOtherObject.require("./status.js");\n');
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// module.require(...) is a single primitive regardless of how the property
// access is spelled or wrapped - dotted, computed/bracket, and any depth of
// parenthesization all denote it, so the guard's contract - spelling must
// not change the result - is exercised against both non-dotted forms too.
// ---------------------------------------------------------------------------

test("module.require(...) is caught via computed/bracket property access, not just the dotted spelling", () => {
  const hits = siblingImportsFrom(
    'const moduleDeck = module["require"]("./status.js");\n' +
      "const pull = moduleDeck.createRequire(import.meta.url);\n"
  );
  assert.ok(
    hits.some((h) => h.includes("references the global module")),
    `expected the module-require binding hit, got: ${JSON.stringify(hits)}`
  );
});

test("module.require(...) is caught through a parenthesized callee, not just the unwrapped spelling", () => {
  const hits = siblingImportsFrom(
    'const moduleDeck = (module.require)("./status.js");\n' +
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
// produces is undecidable in general.
// ---------------------------------------------------------------------------

test("eval(...) used to obtain a dynamic loader is caught, unconditionally on its argument", () => {
  const hits = siblingImportsFrom(
    "const moduleDeck = await eval('import(\"node:module\")');\n" +
      "const pull = moduleDeck.createRequire(import.meta.url);\n" +
      'pull("./status.js");\n'
  );
  assert.ok(
    hits.some((h) => h.includes("references the global eval")),
    `expected the eval-call hit, got: ${JSON.stringify(hits)}`
  );
});

test("Function(...) used to construct a dynamic loader is caught, unconditionally on its argument", () => {
  const hits = siblingImportsFrom(
    "const importModule = Function('return import(\"node:module\")');\n" +
      "const moduleDeck = await importModule();\n" +
      "const pull = moduleDeck.createRequire(import.meta.url);\n" +
      'pull("./status.js");\n'
  );
  assert.ok(
    hits.some((h) => h.includes("references the global Function")),
    `expected the function-constructor-call hit, got: ${JSON.stringify(hits)}`
  );
});

// ---------------------------------------------------------------------------
// The forbidden globals are resolved by real lexical scope, not by name -
// a LOCAL binding that merely happens to be spelled the same as one of the
// four never carries the capability, so it must stay green regardless of
// how unusual the shadowing looks. `globalThis` needs its own coverage
// here specifically because a module/block-scope `const globalThis = ...`
// resolves through a different code path than an ordinary parameter shadow
// (see ts-ast.mjs's own doc comment on `isUnshadowedGlobalThisReference`).
// ---------------------------------------------------------------------------

test("green control: a local const named globalThis, holding harmless properties named eval/Function/require, is never confused with the real global object", () => {
  const hits = siblingImportsFrom(
    "const globalThis = { eval: () => 1, Function: () => 1, require: () => 1 };\n" +
      "void globalThis.eval; void globalThis.Function; void globalThis.require;\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: a parameter named globalThis shadows the real global object inside its own function body", () => {
  const hits = siblingImportsFrom(
    "function inspect(globalThis: any, key: string) { void globalThis[key]; }\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: a local const named module is never confused with the real CommonJS module global, even when it carries its own .require", () => {
  const hits = siblingImportsFrom(
    'const module = { require: (x: string) => x };\nmodule.require("x");\n'
  );
  assert.deepEqual(hits, []);
});

test("green control: a parameter named module shadows the real CommonJS module global inside its own function body", () => {
  const hits = siblingImportsFrom('function foo(module: any) { module.require("x"); }\n');
  assert.deepEqual(hits, []);
});

test("green control: typeof module.require used AS A TYPE is fully erased and carries no runtime capability", () => {
  const hits = siblingImportsFrom("export type RequireShape = typeof module.require;\n");
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
  const hits = siblingImportsFrom(
    "function acquire({ eval: execute }: any = globalThis) { void execute; }\n"
  );
  assert.ok(
    hits.some((h) => h.includes("references the global eval")),
    `expected the destructured default off globalThis to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a destructured parameter defaulted from a HARMLESS source is never flagged, regardless of its key names", () => {
  const hits = siblingImportsFrom(
    "function acquire({ eval: execute, Function: fn, require: req, module: mod }: any = {}) {\n" +
      "  void execute; void fn; void req; void mod;\n" +
      "}\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: a catch clause's destructuring pattern has no initializer to check against at all, and stays green regardless of key names", () => {
  const hits = siblingImportsFrom(
    "try { void 0; } catch ({ eval: execute, Function: fn, require: req, module: mod }) {\n" +
      "  void execute; void fn; void req; void mod;\n" +
      "}\n"
  );
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// process.getBuiltinModule, the bare Reflect global, and the .constructor
// property are all closed as of this file - see findCreateRequireImports's
// own doc comment (scripts/lib/ts-ast.mjs) for the full acquisition-site
// design and why banning the whole Reflect/.constructor surface (rather
// than pattern-matching one demonstrated combination of them) is what
// actually closes that specific class, plus why the broader reflective/
// structural category is not claimed exhausted by doing so.
// ---------------------------------------------------------------------------

test("REGRESSION: obtaining the Function constructor via an ordinary function object's own .constructor property IS now detected", () => {
  const hits = siblingImportsFrom('const F = (() => 1).constructor;\nF("return 1");\n');
  assert.ok(
    hits.some((hit) => hit.includes(".constructor")),
    `expected a constructor-property-access violation, got: ${JSON.stringify(hits)}`
  );
});

test('REGRESSION: obtaining the global eval via Reflect.get(globalThis, "eval") IS now detected - at the bare Reflect reference itself', () => {
  const hits = siblingImportsFrom('const e = Reflect.get(globalThis, "eval");\ne("1");\n');
  assert.ok(
    hits.some((hit) => hit.includes("references the global Reflect")),
    `expected a reflect-reference violation, got: ${JSON.stringify(hits)}`
  );
});

test("Reflect is flagged at the ACQUISITION site regardless of which method is used or how the reference is stored", () => {
  const hits = siblingImportsFrom("const R = Reflect;\nR.construct(Object, []);\n");
  assert.ok(
    hits.some((hit) => hit.includes("references the global Reflect")),
    `expected the aliased Reflect reference to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a LOCALLY SHADOWED Reflect (never the real global) is never flagged", () => {
  const hits = siblingImportsFrom(
    "function f(Reflect: { get: (t: unknown, k: string) => unknown }) {\n" +
      '  return Reflect.get(globalThis, "eval");\n' +
      "}\n"
  );
  assert.deepEqual(hits, []);
});

test(".constructor is flagged on ANY base, not just a known-dangerous one - a plain object literal's .constructor is just as flagged as a function's", () => {
  const hits = siblingImportsFrom("const c = ({}).constructor;\n");
  assert.ok(
    hits.some((hit) => hit.includes(".constructor")),
    `expected the plain-object .constructor access to be flagged too, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a class's OWN constructor method declaration is never confused with a .constructor property READ - defining a constructor is not an acquisition", () => {
  const hits = siblingImportsFrom(
    "class Foo {\n  constructor() {\n    this.ready = true;\n  }\n}\nnew Foo();\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: an object literal's own 'constructor' property KEY (defining, not reading) is never flagged", () => {
  const hits = siblingImportsFrom('const obj = { constructor: () => "not a real class" };\n');
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// globalThis/process ONE-HOP ALIAS - see the matching section in
// test/no-tasks-import.test.ts for the full rationale, including the
// REGRESSION this closes (a prior version only checked `symbol === undefined`
// as the "genuinely unshadowed globalThis" signal, but the real checker
// returns a truthy symbol with an EMPTY declarations array for that case, so
// even a direct, non-aliased `globalThis.eval(...)` silently stopped being
// detected). Mirrored here since this guard shares the exact same
// resolution function.
// ---------------------------------------------------------------------------

test("REGRESSION: a direct, unshadowed globalThis.eval(...) reference (no alias, no local shadow) is detected", () => {
  const hits = siblingImportsFrom("globalThis.eval('1');\n");
  assert.ok(
    hits.some((h) => h.includes("references the global eval")),
    `expected the direct globalThis.eval access to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("a local const aliasing globalThis, then accessed through the alias, is caught - const g = globalThis; g.eval(x)", () => {
  const hits = siblingImportsFrom("const g = globalThis;\ng.eval('1');\n");
  assert.ok(
    hits.some((h) => h.includes("references the global eval")),
    `expected the one-hop globalThis alias to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("a local const aliasing process's BASE (not just its method), then accessed through the alias, is caught - const p = process; p.getBuiltinModule(...)", () => {
  const hits = siblingImportsFrom("const p = process;\np.getBuiltinModule('node:module');\n");
  assert.ok(
    hits.some((h) => h.includes("getBuiltinModule")),
    `expected the one-hop process BASE alias to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("a BARE REASSIGNMENT (no initializer on the variable's own declaration) aliasing globalThis is caught the same as a declaration initializer - let g; g = globalThis; g.eval(x)", () => {
  const hits = siblingImportsFrom("let g;\ng = globalThis;\ng.eval('1');\n");
  assert.ok(
    hits.some((h) => h.includes("references the global eval")),
    `expected the bare-reassignment globalThis alias to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("a bare reassignment aliasing process is caught the same way - let p; p = process; p.getBuiltinModule(...)", () => {
  const hits = siblingImportsFrom("let p;\np = process;\np.getBuiltinModule('node:module');\n");
  assert.ok(
    hits.some((h) => h.includes("getBuiltinModule")),
    `expected the bare-reassignment process alias to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("green control: an unrelated bare reassignment (never process/globalThis) is never flagged", () => {
  const hits = siblingImportsFrom("let x;\nx = 5;\nvoid x;\n");
  assert.deepEqual(hits, []);
});

test("documented boundary: a TWO-HOP alias chain is not chased (const g = globalThis; const h = g; h.eval(x)) - a further row if this shape is ever demonstrated live, not a claim this function already covers", () => {
  const hits = siblingImportsFrom("const g = globalThis;\nconst h = g;\nh.eval('1');\n");
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
  const hits = siblingImportsFrom(
    'const r = process.getBuiltinModule("node:module").createRequire(import.meta.url);\n' +
      'r("./status.js");\n'
  );
  assert.ok(
    hits.some((hit) => hit.includes("getBuiltinModule")),
    `expected a process.getBuiltinModule violation, got: ${JSON.stringify(hits)}`
  );
});

test("process.getBuiltinModule is flagged at the ACQUISITION site regardless of invocation shape - stored, aliased, never immediately called", () => {
  const hits = siblingImportsFrom(
    "const acquire = process.getBuiltinModule;\nconst mod = acquire('node:module');\n"
  );
  assert.ok(
    hits.some((hit) => hit.includes("getBuiltinModule")),
    `expected the aliased acquisition to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test('process.getBuiltinModule via bracket notation ("computed" but statically foldable) is still detected', () => {
  const hits = siblingImportsFrom('const m = process["getBuiltinModule"]("node:module");\n');
  assert.ok(
    hits.some((hit) => hit.includes("getBuiltinModule")),
    `expected the bracket-notation access to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("fail-closed: a COMPUTED, non-statically-foldable property key on process is flagged - this guard cannot prove it does not reach .getBuiltinModule", () => {
  const hits = siblingImportsFrom("const key = getKey();\nconst m = process[key]();\n");
  assert.ok(
    hits.some((hit) => hit.includes("computed property of process")),
    `expected an unresolvable-process-access violation, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a LOCALLY SHADOWED process (never the real global) accessing .getBuiltinModule is never flagged", () => {
  const hits = siblingImportsFrom(
    "function f(process: { getBuiltinModule: (id: string) => unknown }) {\n" +
      '  return process.getBuiltinModule("node:module");\n' +
      "}\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: every OTHER property of the real process global stays completely unflagged - only .getBuiltinModule is dangerous", () => {
  const hits = siblingImportsFrom(
    "const a = process.env;\n" +
      "const b = process.platform;\n" +
      "const c = process.cwd();\n" +
      "const d = process.argv;\n" +
      'process.kill(1, "SIGTERM");\n'
  );
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// Type-only knowledge of createRequire is permitted; only a binding that can
// come to hold the runtime capability is forbidden.
// ---------------------------------------------------------------------------

test("green control: a statement-level 'import type' of createRequire is never flagged - fully erased, no runtime capability", () => {
  const hits = siblingImportsFrom(
    'import type { createRequire } from "node:module";\n' +
      "export type LoaderFactory = typeof createRequire;\n"
  );
  assert.deepEqual(hits, []);
});

test("green control: an inline 'type' specifier on createRequire is never flagged, even though the import statement itself survives", () => {
  const hits = siblingImportsFrom('import { type createRequire } from "node:module";\n');
  assert.deepEqual(hits, []);
});

test("a MIXED import clause still reds on its value specifier - a sibling type-only specifier never suppresses it", () => {
  const hits = siblingImportsFrom('import { createRequire, type Something } from "node:module";\n');
  assert.ok(
    hits.some((h) => h.includes("imports createRequire")),
    `expected the value specifier to still be flagged despite the type-only sibling, got: ${JSON.stringify(hits)}`
  );
});

// --- combined guard: state-declaration checks ---

test("a tools/*.ts file constructing its own Map is flagged as holding state", () => {
  const hits = findPersistentStateDeclarations("const jobs = new Map();\n");
  assert.equal(hits.length, 1);
  assert.match(hits[0], /Map/);
});

test("a tools/*.ts file constructing its own Set is flagged too", () => {
  assert.equal(findPersistentStateDeclarations("const seen = new Set();\n").length, 1);
});

test("a module-scope mutable let/var is flagged even without a Map/Set", () => {
  const hits = findPersistentStateDeclarations("let outputBuffer = [];\n");
  assert.equal(hits.length, 1);
  assert.match(hits[0], /let/);
});

test("green control: a module-scope const function/schema declaration is never flagged as state", () => {
  const source = [
    'export const name = "run";',
    'export const inputSchema = { type: "object", properties: {} };',
    "export function handler() { return { content: [], isError: true }; }",
    "",
  ].join("\n");
  assert.deepEqual(findPersistentStateDeclarations(source), []);
});

test("green control: a let/var declared INSIDE a function body (not module scope) is never flagged", () => {
  const source = [
    "export function handler() {",
    "  let localCounter = 0;",
    "  return localCounter;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(findPersistentStateDeclarations(source), []);
});

test("mutation control: the real src/tools/*.ts files, scanned directly, declare zero persistent state", () => {
  const violations = checkModuleBoundaries();
  const stateViolations = violations.filter((v) => v.includes("only jobStore.ts may own"));
  assert.deepEqual(stateViolations, []);
});

// --- the state check must catch a CALL-EXPRESSION-shaped mutable
// container, not just an empty array/object LITERAL - Array()/new Array()
// and Object()/new Object() are the same escape class as `[]`/`{}`, just
// spelled as a constructor call. ---

test("a bare Array() call anywhere in the file is flagged as constructing state, the same class as an empty array literal", () => {
  const hits = findPersistentStateDeclarations("const outputBuffer: string[] = Array();\n");
  assert.equal(hits.length, 1);
  assert.match(hits[0]!, /Array/);
});

test("new Array() is flagged the same way as the bare call form", () => {
  const hits = findPersistentStateDeclarations("const outputBuffer = new Array();\n");
  assert.equal(hits.length, 1);
  assert.match(hits[0]!, /Array/);
});

test("Object()/new Object() are flagged too - the same escape class as Array(), closed for real completeness rather than only the exact form the reproduction used", () => {
  const bareCall = findPersistentStateDeclarations("const state = Object();\n");
  assert.equal(bareCall.length, 1);
  assert.match(bareCall[0]!, /Object/);
  const withNew = findPersistentStateDeclarations("const state = new Object();\n");
  assert.equal(withNew.length, 1);
  assert.match(withNew[0]!, /Object/);
});

test("an Array()/Object() construction is flagged ANYWHERE in the file, not just at module scope - matching Map/Set's stronger scope, since a bare Array()/Object() call is just as unusual to construct transiently", () => {
  const source = [
    "export function handler() {",
    "  const buffer = Array();",
    "  return buffer;",
    "}",
    "",
  ].join("\n");
  const hits = findPersistentStateDeclarations(source);
  assert.equal(
    hits.length,
    1,
    `expected the function-scoped Array() to still be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("green control: Array.from(...) and Object.keys(...)/Object.assign(...) are never flagged - a property-access callee is a structurally different shape from the bare Array()/Object() call this check targets", () => {
  const source = [
    "const a = Array.from([1, 2, 3]);",
    "const b = Object.keys({ x: 1 });",
    "const c = Object.assign({}, { y: 2 });",
    "",
  ].join("\n");
  assert.deepEqual(findPersistentStateDeclarations(source), []);
});

test("green control: Array(x).length and Object(x).valueOf() (transient immediate member access) are never flagged, the same carve-out that already exempts new Set(...).size", () => {
  const source = ["const len = Array(3).length;", "const v = Object(1).valueOf();", ""].join("\n");
  assert.deepEqual(findPersistentStateDeclarations(source), []);
});

test("mutation control: the guard reacts to the change - clean before, red after a bare Array() call is introduced, clean again once reverted", () => {
  const clean = 'export const name = "run";\n';
  assert.deepEqual(findPersistentStateDeclarations(clean), []);
  const withRegression = 'const outputBuffer: string[] = Array();\nexport const name = "run";\n';
  assert.equal(findPersistentStateDeclarations(withRegression).length, 1);
  assert.deepEqual(findPersistentStateDeclarations(clean), []);
});
