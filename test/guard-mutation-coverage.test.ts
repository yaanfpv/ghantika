import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkModuleBoundaries,
  findPersistentStateDeclarations,
  findSiblingToolImports,
} from "../scripts/check-module-boundaries.mjs";
import { checkNoTasksImport, findTasksImports } from "../scripts/check-no-tasks-import.mjs";
import { checkStdioPurity, findStdoutWrites } from "../scripts/check-stdio-purity.mjs";

/**
 * Mutation-completeness regression coverage for this repo's three
 * source-level AST guards (`check-module-boundaries.mjs`,
 * `check-no-tasks-import.mjs`, `check-stdio-purity.mjs`): every escape
 * form these guards are known to need to catch, each applied as a REAL
 * temporary mutation to a real scratch fixture file under a real
 * directory tree (never just the low-level find* functions called with
 * an inline string, though those are exercised too, below) - the
 * orchestrating `checkModuleBoundaries`/`checkNoTasksImport`/
 * `checkStdioPurity` functions are run against the scratch tree, proving
 * each violation is caught at the SAME layer `npm run guard:*` runs at,
 * not just at the underlying pure-function layer. Each fixture is removed
 * (restored) immediately after its assertions, and the REAL src/ tree is
 * re-confirmed clean at the end of this file, proving the scratch
 * mutations never leaked into (or were somehow satisfied by) production
 * source.
 *
 * The forms below are grouped by the escape CLASS each one belongs to, not
 * by the literal syntax any single example happens to use. Three classes:
 * a violation written in syntax no regex scan can see (a bare sibling
 * side-effect import, a const-bound empty array literal, a comment
 * splitting `import` from `(` in a dynamic import, a computed
 * `process["stdout"]` access); a violation reached INDIRECTLY (an
 * `Array()` call in place of an empty literal, a sibling/Tasks load via
 * `require`/`createRequire` instead of ES import syntax, a stdout write
 * through a `globalThis.process` alias, a stdout-writing `console` method
 * other than `log`); and a loader whose IMPORT BINDING is renamed, so no
 * call site is spelled `require` or `createRequire` at all. Where a class
 * has more members than the one example, the siblings are covered too
 * (`Object()` alongside `Array()`, every stdout-writing `console` method,
 * not just `info`), since owning the whole class is the point.
 */

function buildScratchSrc(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-guard-mutation-"));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Combined mutant: one file carrying four violations at once, each written
// in syntax a regex-based scan cannot see.
// ---------------------------------------------------------------------------

const DISGUISED_SYNTAX_COMBINED_MUTANT = [
  'import "./status.js";', // bare sibling side-effect import
  "const outputBuffer: string[] = [];", // module-scope mutable state (not a Map/Set)
  'import/* comment */("@modelcontextprotocol/sdk/experimental/tasks");', // Tasks import with a comment splitting import( from the string
  'process["stdout"].write("leak");', // computed stdout access
  "",
].join("\n");

test("a file combining four regex-invisible escape forms is caught, every form at once, by the real orchestrating guard functions on a real scratch fixture tree", () => {
  const dir = buildScratchSrc({ "tools/mutant.ts": DISGUISED_SYNTAX_COMBINED_MUTANT });
  try {
    const moduleBoundaryViolations = checkModuleBoundaries(dir);
    const siblingHit = moduleBoundaryViolations.find(
      (v) => v.includes("imports sibling") && v.includes("./status.js")
    );
    const stateHit = moduleBoundaryViolations.find(
      (v) => v.includes("only jobStore.ts may own") && v.includes("outputBuffer")
    );
    assert.ok(
      siblingHit,
      `expected a sibling-import violation for "./status.js", got: ${JSON.stringify(moduleBoundaryViolations)}`
    );
    assert.ok(
      stateHit,
      `expected a persistent-state violation for "outputBuffer", got: ${JSON.stringify(moduleBoundaryViolations)}`
    );

    const tasksViolations = checkNoTasksImport(dir);
    assert.ok(
      tasksViolations.some((v) => v.specifier.includes("experimental")),
      `expected a Tasks-extension import violation, got: ${JSON.stringify(tasksViolations)}`
    );

    const stdioViolations = checkStdioPurity(dir);
    assert.ok(
      stdioViolations.some((v) => v.match.includes("stdout")),
      `expected a stdio-purity violation for process["stdout"], got: ${JSON.stringify(stdioViolations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true }); // restore
  }
});

test("restored: with the combined regex-invisible fixture removed, the REAL src/ tree is still clean on all three guards (the scratch mutant never leaked into production source)", () => {
  assert.deepEqual(
    checkModuleBoundaries().filter(
      (v) => v.includes("imports sibling") || v.includes("only jobStore.ts may own")
    ),
    []
  );
  assert.deepEqual(checkNoTasksImport(), []);
  assert.deepEqual(checkStdioPurity(), []);
});

// ---------------------------------------------------------------------------
// Each of those four forms again on its own, at the pure-function level
// (before/after real evidence: red under the mutant text, clean once
// removed).
// ---------------------------------------------------------------------------

test("module-boundaries: a bare sibling side-effect import - findSiblingToolImports goes red on the mutant text, clean on the original", () => {
  const dir = buildScratchSrc({});
  const toolsDir = path.join(dir, "tools");
  try {
    const importingFile = path.join(toolsDir, "run.ts");
    const before = findSiblingToolImports("export const x = 1;\n", importingFile, toolsDir);
    assert.deepEqual(before, [], "clean before the mutation");
    const after = findSiblingToolImports(
      'import "./status.js";\nexport const x = 1;\n',
      importingFile,
      toolsDir
    );
    assert.deepEqual(
      after,
      ["./status.js"],
      "red after the mutation - the bare side-effect import form"
    );
    const restored = findSiblingToolImports("export const x = 1;\n", importingFile, toolsDir);
    assert.deepEqual(restored, [], "clean again once restored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("module-boundaries: a const-bound EMPTY array literal at module scope - findPersistentStateDeclarations goes red on the mutant text, clean on the original", () => {
  const before = findPersistentStateDeclarations('export const name = "run";\n');
  assert.deepEqual(before, [], "clean before the mutation");
  const after = findPersistentStateDeclarations(
    'const outputBuffer: string[] = [];\nexport const name = "run";\n'
  );
  assert.equal(
    after.length,
    1,
    `red after the mutation - the const-bound empty array form, got: ${JSON.stringify(after)}`
  );
  assert.match(after[0]!, /outputBuffer/);
  assert.match(after[0]!, /empty array/);
  const restored = findPersistentStateDeclarations('export const name = "run";\n');
  assert.deepEqual(restored, [], "clean again once restored");
});

test("no-tasks-import: a comment splitting `import` from `(` in a dynamic import - findTasksImports goes red on the mutant text, clean on the original", () => {
  const before = findTasksImports(
    'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\n'
  );
  assert.deepEqual(before, [], "clean before the mutation");
  const after = findTasksImports(
    'import/* comment */("@modelcontextprotocol/sdk/experimental/tasks");\n'
  );
  assert.deepEqual(
    after,
    ["@modelcontextprotocol/sdk/experimental/tasks"],
    "red after the mutation - the comment-split dynamic import form"
  );
  const restored = findTasksImports(
    'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\n'
  );
  assert.deepEqual(restored, [], "clean again once restored");
});

test('stdio-purity: a computed process["stdout"] access - findStdoutWrites goes red on the mutant text, clean on the original', () => {
  const before = findStdoutWrites("export function handler() { return 1; }\n");
  assert.deepEqual(before, [], "clean before the mutation");
  const after = findStdoutWrites('process["stdout"].write("leak");\n');
  assert.equal(
    after.length,
    1,
    `red after the mutation - the computed process["stdout"] form, got: ${JSON.stringify(after)}`
  );
  const restored = findStdoutWrites("export function handler() { return 1; }\n");
  assert.deepEqual(restored, [], "clean again once restored");
});

// ---------------------------------------------------------------------------
// Further members of the same classes, beyond the four forms above - each
// independently, before/after.
// ---------------------------------------------------------------------------

test("additional form (no-tasks-import): a no-substitution TEMPLATE LITERAL used as a dynamic import argument is caught, not just a plain string literal", () => {
  const before = findTasksImports("const x = 1;\n");
  assert.deepEqual(before, [], "clean before the mutation");
  const after = findTasksImports(
    "const mod = await import(`@modelcontextprotocol/sdk/experimental/tasks`);\n"
  );
  assert.deepEqual(
    after,
    ["@modelcontextprotocol/sdk/experimental/tasks"],
    "red after the mutation - the template-literal dynamic import form"
  );
  const restored = findTasksImports("const x = 1;\n");
  assert.deepEqual(restored, [], "clean again once restored");
});

test("additional form (no-tasks-import): a dynamic import with a RUNTIME-COMPUTED specifier (a variable) fails CLOSED - reported as a violation, never silently skipped", () => {
  const before = findTasksImports("const x = 1;\n");
  assert.deepEqual(before, [], "clean before the mutation");
  const after = findTasksImports(
    "const specifier = getSpecifierFromSomewhere();\nconst mod = await import(specifier);\n"
  );
  assert.equal(
    after.length,
    1,
    `expected the unresolvable dynamic import to fail closed as a violation, got: ${JSON.stringify(after)}`
  );
  assert.match(after[0]!, /computed/i);
  const restored = findTasksImports("const x = 1;\n");
  assert.deepEqual(restored, [], "clean again once restored");
});

test("additional form (no-tasks-import): a dynamic import with a runtime-computed specifier built via string CONCATENATION also fails CLOSED", () => {
  const after = findTasksImports(
    'const mod = await import("@modelcontextprotocol/sdk/" + "experimental/tasks");\n'
  );
  assert.equal(
    after.length,
    1,
    `expected the concatenated dynamic import to fail closed, got: ${JSON.stringify(after)}`
  );
  assert.match(after[0]!, /computed/i);
});

test("additional form (no-tasks-import): a green control - a dynamic import of a LEGITIMATE, unrelated statically-resolvable specifier is never flagged", () => {
  const hits = findTasksImports('const mod = await import("./registry.js");\n');
  assert.deepEqual(hits, []);
});

test('additional form (stdio-purity): a computed console["log"](...) call is caught, not just process["stdout"]', () => {
  const before = findStdoutWrites("export const x = 1;\n");
  assert.deepEqual(before, [], "clean before the mutation");
  const after = findStdoutWrites('console["log"]("leak");\n');
  assert.equal(
    after.length,
    1,
    `red after the mutation - the computed console["log"] form, got: ${JSON.stringify(after)}`
  );
  const restored = findStdoutWrites("export const x = 1;\n");
  assert.deepEqual(restored, [], "clean again once restored");
});

test("additional form (module-boundaries): a const-bound `new Map()`/`new Set()` at module scope is still caught (already partly covered, re-confirmed here alongside the other forms)", () => {
  const before = findPersistentStateDeclarations("export const name = 1;\n");
  assert.deepEqual(before, [], "clean before the mutation");
  const afterMap = findPersistentStateDeclarations("const jobs = new Map();\n");
  assert.equal(afterMap.length, 1);
  assert.match(afterMap[0]!, /Map/);
  const afterSet = findPersistentStateDeclarations("const seen = new Set();\n");
  assert.equal(afterSet.length, 1);
  assert.match(afterSet[0]!, /Set/);
  const restored = findPersistentStateDeclarations("export const name = 1;\n");
  assert.deepEqual(restored, [], "clean again once restored");
});

test("additional form (module-boundaries): a const-bound EMPTY OBJECT literal (not just an empty array) at module scope is caught too", () => {
  const before = findPersistentStateDeclarations(
    'export const inputSchema = { type: "object", properties: {} };\n'
  );
  assert.deepEqual(before, [], "a real, non-empty schema object is never flagged");
  const after = findPersistentStateDeclarations("const jobsById = {};\n");
  assert.equal(
    after.length,
    1,
    `red after the mutation - the const-bound empty object literal form, got: ${JSON.stringify(after)}`
  );
  assert.match(after[0]!, /jobsById/);
  assert.match(after[0]!, /empty object/);
});

test("green control (module-boundaries): registry.ts's own real, transient `new Set(...).size` duplicate-name check is never flagged, once the state scan is extended past src/tools/", () => {
  // The exact real production shape from src/registry.ts - a Map/Set
  // construction that's immediately member-accessed with no binding at
  // all is structurally transient (nothing can reach it again after this
  // expression evaluates), so it must NOT be flagged even though the
  // state scan now covers registry.ts too.
  const source = [
    "const TOOL_MODULES = [1, 2, 3];",
    "if (new Set(TOOL_MODULES.map((t) => t)).size !== TOOL_MODULES.length) {",
    '  throw new Error("duplicate");',
    "}",
    "",
  ].join("\n");
  assert.deepEqual(findPersistentStateDeclarations(source), []);
});

test("mutation control: the transient-access carve-out is genuinely narrow - a Map bound to a variable right next to a similar-looking transient one is still caught", () => {
  const source = ["const cache = new Map();", "const size = new Set([1, 2]).size;", ""].join("\n");
  const hits = findPersistentStateDeclarations(source);
  assert.equal(
    hits.length,
    1,
    `expected exactly the bound Map to be flagged, the transient Set to be exempt, got: ${JSON.stringify(hits)}`
  );
  assert.match(hits[0]!, /Map/);
});

// ---------------------------------------------------------------------------
// Combined mutant: a DIFFERENT file whose four violations are each reached
// INDIRECTLY rather than written out directly - `Array()` in place of an
// empty literal, a sibling/Tasks load via require()/createRequire() instead
// of ES import syntax, a stdout write through a globalThis.process alias,
// and a stdout-writing console method other than log.
// ---------------------------------------------------------------------------

const INDIRECT_REACH_COMBINED_MUTANT = [
  "const outputBuffer: string[] = Array();", // module-scope mutable state via a CallExpression, not an empty literal
  'import { createRequire } from "node:module";', // createRequire itself is forbidden the moment it's imported, whether or not it's ever called
  'require("./status.js");', // sibling load via bare CommonJS require, not ES import syntax
  "const aliasedProcess = globalThis.process;",
  'aliasedProcess.stdout.write("leak");', // stdout write through an alias, not bare process.stdout
  'console.info("also leaks");', // a stdout-writing console method other than log
  "",
].join("\n");

test("a file combining four indirect-reach escape forms is caught, every form at once, by the real orchestrating guard functions on a real scratch fixture tree", () => {
  const dir = buildScratchSrc({ "tools/mutant2.ts": INDIRECT_REACH_COMBINED_MUTANT });
  try {
    const moduleBoundaryViolations = checkModuleBoundaries(dir);
    const siblingHit = moduleBoundaryViolations.find(
      (v) => v.includes("imports sibling") && v.includes("./status.js")
    );
    const createRequireHit = moduleBoundaryViolations.find((v) => v.includes("createRequire"));
    const stateHit = moduleBoundaryViolations.find(
      (v) => v.includes("only jobStore.ts may own") && v.includes("Array")
    );
    assert.ok(
      siblingHit,
      `expected a sibling-import violation for "./status.js" via require(), got: ${JSON.stringify(moduleBoundaryViolations)}`
    );
    assert.ok(
      createRequireHit,
      `expected createRequire(...) itself to be flagged, got: ${JSON.stringify(moduleBoundaryViolations)}`
    );
    assert.ok(
      stateHit,
      `expected a persistent-state violation for the Array() call, got: ${JSON.stringify(moduleBoundaryViolations)}`
    );

    const tasksViolations = checkNoTasksImport(dir);
    assert.ok(
      tasksViolations.some((v) => v.specifier.includes("createRequire")),
      `expected createRequire(...) to be flagged by the Tasks-import guard too (it scans the whole src/ tree), got: ${JSON.stringify(tasksViolations)}`
    );

    const stdioViolations = checkStdioPurity(dir);
    assert.ok(
      stdioViolations.some(
        (v) => v.match.includes("aliasedProcess") && v.match.includes("aliases process")
      ),
      `expected the globalThis.process alias to be flagged, got: ${JSON.stringify(stdioViolations)}`
    );
    assert.ok(
      stdioViolations.some((v) => v.match === "console.info("),
      `expected console.info(...) to be flagged as a stdout-writing method, got: ${JSON.stringify(stdioViolations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true }); // restore
  }
});

test("restored: with the combined indirect-reach fixture removed, the REAL src/ tree is still clean on all three guards", () => {
  assert.deepEqual(
    checkModuleBoundaries().filter(
      (v) =>
        v.includes("imports sibling") ||
        v.includes("only jobStore.ts may own") ||
        v.includes("createRequire")
    ),
    []
  );
  assert.deepEqual(checkNoTasksImport(), []);
  assert.deepEqual(checkStdioPurity(), []);
});

// ---------------------------------------------------------------------------
// Each of those four forms again on its own, at the pure-function level
// (before/after real evidence: red under the mutant text, clean once
// removed).
// ---------------------------------------------------------------------------

test("module-boundaries: a bare Array() call in place of an empty array literal - findPersistentStateDeclarations goes red on the mutant text, clean on the original", () => {
  const before = findPersistentStateDeclarations('export const name = "run";\n');
  assert.deepEqual(before, [], "clean before the mutation");
  const after = findPersistentStateDeclarations(
    'const outputBuffer: string[] = Array();\nexport const name = "run";\n'
  );
  assert.equal(
    after.length,
    1,
    `red after the mutation - the Array() call form, got: ${JSON.stringify(after)}`
  );
  // Signal 1 (the "anywhere in file" scan) reports the CONSTRUCTED-TYPE
  // name, not the declared variable name - matching the pre-existing
  // Map/Set message shape, which never names the variable either.
  assert.match(after[0]!, /Array/);
  const restored = findPersistentStateDeclarations('export const name = "run";\n');
  assert.deepEqual(restored, [], "clean again once restored");
});

test("module-boundaries: a sibling load via require() (after createRequire()) instead of ES import syntax - findSiblingToolImports goes red on the mutant text, clean on the original", () => {
  const dir = buildScratchSrc({});
  const toolsDir = path.join(dir, "tools");
  try {
    const importingFile = path.join(toolsDir, "run.ts");
    const before = findSiblingToolImports("export const x = 1;\n", importingFile, toolsDir);
    assert.deepEqual(before, [], "clean before the mutation");
    const mutantSource = [
      'import { createRequire } from "node:module";',
      'require("./status.js");',
      "",
    ].join("\n");
    const after = findSiblingToolImports(mutantSource, importingFile, toolsDir);
    assert.ok(
      after.includes("./status.js"),
      `red after the mutation - the require() sibling form, got: ${JSON.stringify(after)}`
    );
    assert.ok(
      after.some((h) => h.includes("createRequire")),
      `expected createRequire(...) itself to be flagged too, got: ${JSON.stringify(after)}`
    );
    const restored = findSiblingToolImports("export const x = 1;\n", importingFile, toolsDir);
    assert.deepEqual(restored, [], "clean again once restored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stdio-purity: a stdout write reached through a globalThis.process alias, not bare process.stdout - findStdoutWrites goes red on the mutant text, clean on the original", () => {
  const before = findStdoutWrites("export function handler() { return 1; }\n");
  assert.deepEqual(before, [], "clean before the mutation");
  const after = findStdoutWrites(
    'const aliasedProcess = globalThis.process;\naliasedProcess.stdout.write("leak");\n'
  );
  assert.ok(
    after.some((h) => h.includes("aliasedProcess") && h.includes("aliases process")),
    `red after the mutation - the alias-creation form, got: ${JSON.stringify(after)}`
  );
  const restored = findStdoutWrites("export function handler() { return 1; }\n");
  assert.deepEqual(restored, [], "clean again once restored");
});

test("stdio-purity: console.info(...) - a stdout-writing console method other than log - findStdoutWrites goes red on the mutant text, clean on the original", () => {
  const before = findStdoutWrites("export function handler() { return 1; }\n");
  assert.deepEqual(before, [], "clean before the mutation");
  const after = findStdoutWrites('console.info("also leaks");\n');
  assert.equal(
    after.length,
    1,
    `red after the mutation - the console.info form, got: ${JSON.stringify(after)}`
  );
  assert.equal(after[0], "console.info(");
  const restored = findStdoutWrites("export function handler() { return 1; }\n");
  assert.deepEqual(restored, [], "clean again once restored");
});

// ---------------------------------------------------------------------------
// A loader whose IMPORT BINDING is renamed defeats every call-site check.
// Aliasing the createRequire import itself (`import { createRequire as
// makeLoader } from "node:module"`) turns every later call through the alias
// into an identifier spelled nothing like `require`/`createRequire`, so
// `isRequireCall`/`isCreateRequireCall` - which both match a CallExpression's
// callee by identifier TEXT - can never see it. That is a "match a spelling,
// not a binding" escape, structurally different from the forms above, which
// all wrap new SYNTAX around a call site rather than renaming the BINDING at
// the import itself. The fix (scripts/lib/ts-ast.mjs's
// `findCreateRequireImports`) resolves the IMPORT BINDING - what name is
// actually imported (`ImportSpecifier.propertyName ?? .name`), never the
// local alias - so it is immune to renaming by construction: no alias name,
// however novel, changes what's imported. Each row below independently
// verifies that immunity with a DIFFERENT, never-before-used alias pair, so
// no single row's pass could be explained by an accidental match against one
// specific name.
// ---------------------------------------------------------------------------

const ALIASED_LOADER_COMBINED_MUTANT = [
  'import { createRequire as makeLoader } from "node:module";',
  "const loadModule = makeLoader(import.meta.url);",
  'loadModule("./status.js");', // sibling load, reached only through the ALIASED loader
  'loadModule("@modelcontextprotocol/sdk/experimental/tasks");', // Tasks load, reached only through the ALIASED loader
  "",
].join("\n");

test("an aliased createRequire import reaching BOTH a sibling tools/*.ts file AND the forbidden Tasks specifier through the same aliased loader is caught by both guards at once on a real scratch fixture tree", () => {
  const dir = buildScratchSrc({ "tools/mutant3.ts": ALIASED_LOADER_COMBINED_MUTANT });
  try {
    const moduleBoundaryViolations = checkModuleBoundaries(dir);
    // The fix is the IMPORT-BINDING ban, deliberately WITHOUT tracking what
    // the aliased loader variable is later called with (see
    // findCreateRequireImports's own doc comment). Once the import itself
    // is forbidden, code that would go on to call the
    // never-successfully-imported loader never gets that far in a compliant
    // world - so this does NOT resolve `loadModule("./status.js")` to a
    // literal "./status.js" sibling-specifier hit the way a real ES
    // `import "./status.js"` would; it resolves the IMPORT ITSELF as the
    // single violation, independent of how many times or with what
    // arguments the aliased loader is called.
    const importBindingHit = moduleBoundaryViolations.find(
      (v) => v.includes("imports sibling") && v.includes("imports createRequire")
    );
    assert.ok(
      importBindingHit,
      `expected the aliased createRequire IMPORT itself to be flagged as a sibling-boundary violation, got: ${JSON.stringify(moduleBoundaryViolations)}`
    );

    const tasksViolations = checkNoTasksImport(dir);
    assert.ok(
      tasksViolations.some((v) => v.specifier.includes("imports createRequire")),
      `expected the aliased createRequire import to be flagged by the Tasks-import guard too (it scans the whole src/ tree), got: ${JSON.stringify(tasksViolations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true }); // restore
  }
});

test("restored: with the combined aliased-loader fixture removed, the REAL src/ tree is still clean on both guards (the scratch mutant never leaked into production source)", () => {
  assert.deepEqual(
    checkModuleBoundaries().filter(
      (v) => v.includes("imports sibling") || v.includes("imports createRequire")
    ),
    []
  );
  assert.deepEqual(checkNoTasksImport(), []);
});

test("an aliased createRequire reaching a sibling module, alias pair grabLoader/spawn (different names than the combined mutant's makeLoader/loadModule): findSiblingToolImports goes red specifically, clean on the original", () => {
  const dir = buildScratchSrc({});
  const toolsDir = path.join(dir, "tools");
  try {
    const importingFile = path.join(toolsDir, "run.ts");
    const before = findSiblingToolImports("export const x = 1;\n", importingFile, toolsDir);
    assert.deepEqual(before, [], "clean before the mutation");
    const mutantSource = [
      'import { createRequire as grabLoader } from "node:module";',
      "const spawn = grabLoader(import.meta.url);",
      'spawn("./status.js");',
      "",
    ].join("\n");
    const after = findSiblingToolImports(mutantSource, importingFile, toolsDir);
    assert.ok(
      after.some((h) => h.includes("imports createRequire")),
      `red after the mutation - the aliased-import form must be caught by findSiblingToolImports specifically, got: ${JSON.stringify(after)}`
    );
    const restored = findSiblingToolImports("export const x = 1;\n", importingFile, toolsDir);
    assert.deepEqual(restored, [], "clean again once restored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an aliased createRequire reaching the Tasks specifier, alias pair grabLoader/spawn (the same pair as the sibling-target row above, proving the SAME aliased binding is caught independent of which target it's later used to load): findTasksImports goes red specifically, clean on the original", () => {
  const before = findTasksImports(
    'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\n'
  );
  assert.deepEqual(before, [], "clean before the mutation");
  const mutantSource = [
    'import { createRequire as grabLoader } from "node:module";',
    "const spawn = grabLoader(import.meta.url);",
    'spawn("@modelcontextprotocol/sdk/experimental/tasks");',
    "",
  ].join("\n");
  const after = findTasksImports(mutantSource);
  assert.ok(
    after.some((h) => h.includes("imports createRequire")),
    `red after the mutation - the aliased-import form must be caught by findTasksImports specifically, got: ${JSON.stringify(after)}`
  );
  const restored = findTasksImports(
    'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\n'
  );
  assert.deepEqual(restored, [], "clean again once restored");
});

test("a THIRD independent alias pair (cjsBridge/fetchModule - proving the fix is genuinely name-independent, not accidentally still matching one or two specific spellings): both guards go red on their respective targets", () => {
  const dir = buildScratchSrc({});
  const toolsDir = path.join(dir, "tools");
  try {
    const importingFile = path.join(toolsDir, "run.ts");
    const siblingMutant = [
      'import { createRequire as cjsBridge } from "node:module";',
      "const fetchModule = cjsBridge(import.meta.url);",
      'fetchModule("./status.js");',
      "",
    ].join("\n");
    const siblingHits = findSiblingToolImports(siblingMutant, importingFile, toolsDir);
    assert.ok(
      siblingHits.some((h) => h.includes("imports createRequire")),
      `expected the third alias pair to be caught on the sibling target, got: ${JSON.stringify(siblingHits)}`
    );

    const tasksMutant = [
      'import { createRequire as cjsBridge } from "node:module";',
      "const fetchModule = cjsBridge(import.meta.url);",
      'fetchModule("@modelcontextprotocol/sdk/experimental/tasks");',
      "",
    ].join("\n");
    const tasksHits = findTasksImports(tasksMutant);
    assert.ok(
      tasksHits.some((h) => h.includes("imports createRequire")),
      `expected the third alias pair to be caught on the Tasks target, got: ${JSON.stringify(tasksHits)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a namespace import (import * as ns from "node:module") reaching a sibling via ns.createRequire(...) is caught outright at the import site, not deferred to the later property-access call', () => {
  const dir = buildScratchSrc({});
  const toolsDir = path.join(dir, "tools");
  try {
    const importingFile = path.join(toolsDir, "run.ts");
    const mutantSource = [
      'import * as modns from "node:module";',
      "const ld = modns.createRequire(import.meta.url);",
      'ld("./status.js");',
      "",
    ].join("\n");
    const hits = findSiblingToolImports(mutantSource, importingFile, toolsDir);
    assert.ok(
      hits.some((h) => h.includes("node:module namespace")),
      `expected the namespace-import form to be flagged outright, got: ${JSON.stringify(hits)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a default import of node:module (import mod from "node:module") reaching the Tasks specifier via mod.createRequire(...) is caught outright at the import site - verified empirically that node:module\'s default export also carries createRequire as a property', () => {
  const mutantSource = [
    'import modDefault from "node:module";',
    "const ld = modDefault.createRequire(import.meta.url);",
    'ld("@modelcontextprotocol/sdk/experimental/tasks");',
    "",
  ].join("\n");
  const hits = findTasksImports(mutantSource);
  assert.ok(
    hits.some((h) => h.includes("default-imports node:module")),
    `expected the default-import form to be flagged outright, got: ${JSON.stringify(hits)}`
  );
});

test("green control (aliased loader): a legitimate, unrelated import (jobStore, outside tools/) is never flagged by the sibling-import guard", () => {
  const dir = buildScratchSrc({});
  const toolsDir = path.join(dir, "tools");
  try {
    const importingFile = path.join(toolsDir, "run.ts");
    const hits = findSiblingToolImports(
      'import { jobStore } from "../jobStore.js";\nexport const x = 1;\n',
      importingFile,
      toolsDir
    );
    assert.deepEqual(hits, [], "a legitimate, unrelated import must never be flagged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("green control (aliased loader): an aliased import of something ENTIRELY UNRELATED (readFileSync from node:fs, not createRequire from node:module) is never flagged - only createRequire from node:module specifically is forbidden, not aliasing in general", () => {
  const dir = buildScratchSrc({});
  const toolsDir = path.join(dir, "tools");
  try {
    const importingFile = path.join(toolsDir, "run.ts");
    const source = 'import { readFileSync as rf } from "node:fs";\nconst x = rf("./foo.txt");\n';
    const siblingHits = findSiblingToolImports(source, importingFile, toolsDir);
    const tasksHits = findTasksImports(source);
    assert.deepEqual(
      siblingHits,
      [],
      "aliasing an unrelated import must never be flagged as a sibling-import violation"
    );
    assert.deepEqual(
      tasksHits,
      [],
      "aliasing an unrelated import must never be flagged as a Tasks-import violation"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("green control (aliased loader): an UNALIASED, unrelated node:module named export (builtinModules, not createRequire) is never flagged", () => {
  const source =
    'import { builtinModules } from "node:module";\nconst x = builtinModules.length;\n';
  assert.deepEqual(findTasksImports(source), []);
});
