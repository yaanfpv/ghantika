// NOTE ON THIS FILE'S `eval(...)`/`Function(...)` SNIPPETS: every occurrence
// below is an inert STRING LITERAL handed to `findTasksImports` as scanned
// fixture source text - the AST guard under test parses it, nothing in this
// test file ever executes it. These rows exist to prove the guard flags a
// real `eval`/`Function` reference wherever it appears in scanned source;
// none of them run that code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import {
  checkNoTasksImport,
  COMPUTED_DYNAMIC_IMPORT_SPECIFIER_LABEL,
  COMPUTED_NAMESPACE_MEMBER_KEY_LABEL,
  COMPUTED_REQUIRE_SPECIFIER_LABEL,
  findTasksImports,
  TASKS_SYMBOLS,
} from "../scripts/check-no-tasks-import.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER_PACKAGE_DIST = path.join(
  REPO_ROOT,
  "node_modules",
  "@modelcontextprotocol",
  "server",
  "dist"
);

/**
 * Builds a scratch tree DIRECTLY under the repo root (never the OS tmpdir),
 * so a RELATIVE specifier written inside a fixture can actually resolve
 * through Node's real module resolver back to this repo's own
 * `node_modules` - mirroring the identical pattern
 * `test/loader-escape-matrix.test.ts`'s `loadMutatedGuardCopy` already uses
 * for the same reason. This repo's `.gitignore` is an ALLOW-LIST (`/*` then
 * explicit `!/...` un-ignores), so any new top-level directory - this one
 * included - is untracked automatically; nothing extra is needed to keep it
 * out of git.
 */
function buildRepoRootScratchSrc(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".ghantika-tasks-resolver-"));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// The real src/ tree, as it exists right now, references nothing from the
// Tasks extension.
// ---------------------------------------------------------------------------

test("the real src/ tree references nothing from the Tasks extension", () => {
  assert.deepEqual(checkNoTasksImport(), []);
});

// ---------------------------------------------------------------------------
// The guard's unit is the SYMBOL (matched by its SOURCE name), not the
// module specifier - a plain import of an enumerated Tasks symbol is
// flagged regardless of which of the 19 enumerated names it is, including
// ones that do NOT begin with the literal string "Task" (ruling out a
// name-prefix shortcut) and ones that are runtime VALUES, not types.
// ---------------------------------------------------------------------------

test("a plain import of a Tasks symbol from the installed server root is flagged, by its source name", () => {
  const hits = findTasksImports('import { GetTaskRequest } from "@modelcontextprotocol/server";\n');
  assert.deepEqual(hits, [
    'imports Tasks symbol "GetTaskRequest" from "@modelcontextprotocol/server"',
  ]);
});

test('CreateTaskResult - a real enumerated Tasks export whose name is NOT prefixed "Task" - is flagged the same as Task/GetTaskRequest, ruling out a name.startsWith("Task") shortcut', () => {
  const hits = findTasksImports(
    'import { CreateTaskResult } from "@modelcontextprotocol/server";\n'
  );
  assert.ok(
    hits.some((h) => h.includes('"CreateTaskResult"')),
    `expected CreateTaskResult to be flagged despite not starting with "Task", got: ${JSON.stringify(hits)}`
  );
});

test('out-of-the-common-three enumeration: CancelTaskRequest and ListTasksRequest (type-only, non-"Task"-prefixed) and the runtime VALUES isTaskAugmentedRequestParams (a function) and RELATED_TASK_META_KEY (a string constant) are each flagged - ruling out an enumeration hand-trimmed to a few frequently-mentioned names', () => {
  const source = [
    'import { CancelTaskRequest } from "@modelcontextprotocol/server";',
    'import { ListTasksRequest } from "@modelcontextprotocol/server";',
    'import { isTaskAugmentedRequestParams } from "@modelcontextprotocol/server";',
    'import { RELATED_TASK_META_KEY } from "@modelcontextprotocol/server";',
    "",
  ].join("\n");
  const hits = findTasksImports(source);
  for (const name of [
    "CancelTaskRequest",
    "ListTasksRequest",
    "isTaskAugmentedRequestParams",
    "RELATED_TASK_META_KEY",
  ]) {
    assert.ok(
      hits.some((h) => h.includes(`"${name}"`)),
      `expected ${name} to be flagged, got: ${JSON.stringify(hits)}`
    );
  }
});

test("an aliased import matches on the SOURCE name, never the local binding: `Task as Server` is flagged (source is Task); the inverse `Server as Task` stays green (source is the permitted Server)", () => {
  const flagged = findTasksImports(
    'import { Task as Server } from "@modelcontextprotocol/server";\n'
  );
  assert.ok(
    flagged.some((h) => h.includes('"Task"')),
    `expected the source name Task to be flagged despite the permitted-looking local alias, got: ${JSON.stringify(flagged)}`
  );
  const green = findTasksImports(
    'import { Server as Task } from "@modelcontextprotocol/server";\n'
  );
  assert.deepEqual(
    green,
    [],
    "the source name Server is permitted, regardless of the Task-looking local alias"
  );
});

// ---------------------------------------------------------------------------
// Tasks is an ARCHITECTURAL boundary, not a capability one (the deliberate
// opposite of this repo's createRequire ruling, stated in the guard's own
// header): a type-only reference is flagged in every type-level form.
// ---------------------------------------------------------------------------

test("a type-only import of a Tasks symbol is flagged - both the statement-level form and the inline per-specifier form", () => {
  const statementLevel = findTasksImports(
    'import type { GetTaskRequest } from "@modelcontextprotocol/server";\n'
  );
  assert.ok(
    statementLevel.some((h) => h.includes('"GetTaskRequest"')),
    `expected the statement-level type-only import to be flagged, got: ${JSON.stringify(statementLevel)}`
  );
  const inline = findTasksImports('import { type Task } from "@modelcontextprotocol/server";\n');
  assert.ok(
    inline.some((h) => h.includes('"Task"')),
    `expected the inline type-only specifier to be flagged, got: ${JSON.stringify(inline)}`
  );
});

test('green control: production\'s real `import type { CallToolResult, Tool } from "@modelcontextprotocol/server"` produces zero hits - a guard keying on type-only-ness instead of Tasks-symbol identity would red this', () => {
  const hits = findTasksImports(
    'import type { CallToolResult, Tool } from "@modelcontextprotocol/server";\n'
  );
  assert.deepEqual(hits, []);
});

test('green control: an inline permitted type import - `import { type CallToolResult, Server } from "@modelcontextprotocol/server"` - produces zero hits; the inline `type` modifier on a PERMITTED symbol is not itself a Tasks reference', () => {
  const hits = findTasksImports(
    'import { type CallToolResult, Server } from "@modelcontextprotocol/server";\n'
  );
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// Re-exports hand a symbol onward exactly as an import does, so every
// enumerated re-export form is flagged too, type-only or not: named
// (aliased or not), wildcard, and namespace-aliased.
// ---------------------------------------------------------------------------

test("a named re-export of a Tasks symbol is flagged, including when aliased (matched on the SOURCE name, same as the import side)", () => {
  const named = findTasksImports('export { Task } from "@modelcontextprotocol/server";\n');
  assert.ok(named.some((h) => h.includes('"Task"')));
  const aliased = findTasksImports('export { Task as T } from "@modelcontextprotocol/server";\n');
  assert.ok(
    aliased.some((h) => h.includes('"Task"')),
    `expected the aliased re-export to flag on the SOURCE name Task, got: ${JSON.stringify(aliased)}`
  );
});

test("a wildcard re-export (`export * from root`) and a namespace-aliased re-export (`export * as ns from root`) are each flagged - both propagate the whole enumerated Tasks set onward", () => {
  const wildcard = findTasksImports('export * from "@modelcontextprotocol/server";\n');
  assert.equal(wildcard.length, 1, JSON.stringify(wildcard));
  const namespaced = findTasksImports('export * as ns from "@modelcontextprotocol/server";\n');
  assert.equal(namespaced.length, 1, JSON.stringify(namespaced));
});

test("type-only re-export forms are flagged too, exactly as their value counterparts: statement-level `export type { X }`, inline `export { type X }`, and `export type * from root`", () => {
  const statementLevel = findTasksImports(
    'export type { GetTaskRequest } from "@modelcontextprotocol/server";\n'
  );
  assert.ok(statementLevel.some((h) => h.includes('"GetTaskRequest"')));
  const inline = findTasksImports('export { type Task } from "@modelcontextprotocol/server";\n');
  assert.ok(inline.some((h) => h.includes('"Task"')));
  const wildcard = findTasksImports('export type * from "@modelcontextprotocol/server";\n');
  assert.equal(wildcard.length, 1, JSON.stringify(wildcard));
});

test('a type-only NAMESPACE re-export (`export type * as ns from root`) is flagged too - a valid TypeScript form (parses with zero diagnostics), owned by the enumerated set rather than left to an open-ended "every form" promise', () => {
  const source = 'export type * as ns from "@modelcontextprotocol/server";\n';
  const sourceFile = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  assert.deepEqual(
    (sourceFile as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [],
    [],
    "sanity: this form must actually parse with zero diagnostics"
  );
  const hits = findTasksImports(source);
  assert.equal(hits.length, 1, JSON.stringify(hits));
});

test('green control: a permitted-symbol re-export (`export { Server, McpServer } from root`) and a bare `export *` from a NON-server module each produce zero hits - an overbroad "flag any re-export from the server root" guard would red the first; an overbroad "flag any wildcard re-export" guard would red the second', () => {
  const permitted = findTasksImports(
    'export { Server, McpServer } from "@modelcontextprotocol/server";\n'
  );
  assert.deepEqual(permitted, []);
  const unrelated = findTasksImports('export * from "./local-module.js";\n');
  assert.deepEqual(unrelated, []);
});

test('green control: an inline permitted type re-export - `export { type CallToolResult, Server } from "@modelcontextprotocol/server"` - produces zero hits', () => {
  const hits = findTasksImports(
    'export { type CallToolResult, Server } from "@modelcontextprotocol/server";\n'
  );
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// A namespace member access reaches a Tasks symbol exactly as a named
// import does - in VALUE position (a PropertyAccessExpression, or the
// static-bracket-key form) and in TYPE position (a QualifiedName), which
// this guard proves resolves through the SAME namespace binding as the
// value-position form.
// ---------------------------------------------------------------------------

test("a namespace member access in VALUE position (`server.GetTaskRequest`) is flagged; the permitted sibling `server.Server` stays green", () => {
  const flagged = findTasksImports(
    'import * as server from "@modelcontextprotocol/server";\nvoid server.GetTaskRequest;\n'
  );
  assert.ok(
    flagged.some((h) => h.includes('"GetTaskRequest"')),
    `expected the namespace value access to be flagged, got: ${JSON.stringify(flagged)}`
  );
  const green = findTasksImports(
    'import * as server from "@modelcontextprotocol/server";\nvoid server.Server;\n'
  );
  assert.deepEqual(green, []);
});

test('a STATIC bracket-key member access (`server["Task"]`) is flagged the same as the dotted form; the permitted sibling `server["Server"]` stays green - ruling out a guard that only handles dotted member access', () => {
  const flagged = findTasksImports(
    'import * as server from "@modelcontextprotocol/server";\nvoid server["Task"];\nvoid server["GetTaskRequest"];\n'
  );
  assert.ok(flagged.some((h) => h.includes('"Task"')));
  assert.ok(flagged.some((h) => h.includes('"GetTaskRequest"')));
  const green = findTasksImports(
    'import * as server from "@modelcontextprotocol/server";\nvoid server["Server"];\n'
  );
  assert.deepEqual(green, []);
});

test("fail-closed: a computed namespace member key on a resolved server-root binding (`server[getKey()]`) is flagged with its own EXACT diagnostic, not silently skipped, and not satisfied by either sibling fail-closed diagnostic (the dynamic-import or require() specifier classes) - this guard cannot prove the key avoids a Tasks symbol, and the three fail-closed classes are independently pinned so relabeling one as another cannot go unnoticed", () => {
  const hits = findTasksImports(
    'import * as server from "@modelcontextprotocol/server";\n' +
      "declare function getKey(): string;\n" +
      "void server[getKey()];\n"
  );
  assert.ok(
    hits.includes(COMPUTED_NAMESPACE_MEMBER_KEY_LABEL),
    `expected the exact computed-namespace-member-key diagnostic, got: ${JSON.stringify(hits)}`
  );
  assert.ok(
    !hits.includes(COMPUTED_DYNAMIC_IMPORT_SPECIFIER_LABEL) &&
      !hits.includes(COMPUTED_REQUIRE_SPECIFIER_LABEL),
    `expected neither sibling fail-closed diagnostic (dynamic-import or require specifier) to be present, got: ${JSON.stringify(hits)}`
  );
});

test("a namespace-qualified TYPE reference (`type C = server.Task`) is flagged - a QualifiedName inside a type is the same coupling as a value-position member access; the permitted sibling `type S = server.Server` stays green - ruling out a guard that walks PropertyAccessExpression but skips QualifiedName", () => {
  const flagged = findTasksImports(
    'import * as server from "@modelcontextprotocol/server";\ntype C = server.Task;\n'
  );
  assert.ok(
    flagged.some((h) => h.includes('"Task"') && /type position/i.test(h)),
    `expected the type-position namespace reference to be flagged, got: ${JSON.stringify(flagged)}`
  );
  const green = findTasksImports(
    'import * as server from "@modelcontextprotocol/server";\ntype S = server.Server;\n'
  );
  assert.deepEqual(green, []);
});

test('the type-import-QUERY form (`type T = import("@modelcontextprotocol/server").Task`) is flagged - a distinct AST shape from both the dynamic-import call and the namespace-qualified type reference', () => {
  const flagged = findTasksImports('type T = import("@modelcontextprotocol/server").Task;\n');
  assert.ok(
    flagged.some((h) => h.includes('"Task"')),
    `expected the type-import-query form to be flagged, got: ${JSON.stringify(flagged)}`
  );
  const green = findTasksImports('type T = import("@modelcontextprotocol/server").Server;\n');
  assert.deepEqual(green, []);
});

// ---------------------------------------------------------------------------
// A literal-root dynamic-import destructure is statically resolvable, so
// it is judged on its actual symbol, never waved through merely because
// the loading mechanism is `import()`.
// ---------------------------------------------------------------------------

test("a literal-root dynamic-import destructure (`const { GetTaskRequest } = await import(root)`) is flagged; the permitted destructure `const { Server } = await import(root)` stays green", () => {
  const flagged = findTasksImports(
    'const { GetTaskRequest } = await import("@modelcontextprotocol/server");\n'
  );
  assert.ok(
    flagged.some((h) => h.includes('"GetTaskRequest"')),
    `expected the destructure to be flagged, got: ${JSON.stringify(flagged)}`
  );
  const green = findTasksImports(
    'const { Server } = await import("@modelcontextprotocol/server");\n'
  );
  assert.deepEqual(green, []);
});

test("a direct property access off an awaited literal-root dynamic import (`(await import(root)).GetTaskRequest`) is flagged too, the same as the destructure form", () => {
  const hits = findTasksImports('(await import("@modelcontextprotocol/server")).GetTaskRequest;\n');
  assert.ok(
    hits.some((h) => h.includes('"GetTaskRequest"')),
    `expected the property access off the awaited dynamic import to be flagged, got: ${JSON.stringify(hits)}`
  );
});

// ---------------------------------------------------------------------------
// Three independently-flagged fail-closed classes for anything this guard
// cannot statically resolve - never an "or" that lets one pass.
// ---------------------------------------------------------------------------

test("fail-closed: a computed/non-literal dynamic-import specifier (`import(getName())`) is flagged with its own EXACT diagnostic, not merely something matching /computed/i - a loose regex match would also be satisfied by the sibling require()-specifier diagnostic if the dynamic-import branch were ever relabeled to emit it by mistake (a copy-paste/wrong-constant bug), so this pins the EXACT label and asserts the sibling's absence too", () => {
  const hits = findTasksImports(
    "declare function getName(): string;\nconst mod = await import(getName());\n"
  );
  assert.ok(
    hits.includes(COMPUTED_DYNAMIC_IMPORT_SPECIFIER_LABEL),
    `expected the exact dynamic-import fail-closed diagnostic, got: ${JSON.stringify(hits)}`
  );
  assert.ok(
    !hits.includes(COMPUTED_REQUIRE_SPECIFIER_LABEL),
    `expected the sibling require()-specifier diagnostic to be absent, got: ${JSON.stringify(hits)}`
  );
});

test('fail-closed: a computed/non-literal require() specifier (`require(getName())`) is flagged by its OWN EXACT, independently-pinned diagnostic - deleting this check cannot be masked by the separate global-require-acquisition ban still firing on the same line (asserted separately here too), NOR by the sibling dynamic-import diagnostic (whose text used to contain the substring "require()" too, which a loose `h.includes("require()")` check could not tell apart from this diagnostic\'s own text - see scripts/check-no-tasks-import.mjs\'s label constants, now pairwise distinct as complete strings, even though they still share substrings)', () => {
  const hits = findTasksImports("declare function getName(): string;\nrequire(getName());\n");
  assert.ok(
    hits.includes(COMPUTED_REQUIRE_SPECIFIER_LABEL),
    `expected the exact require()-specifier fail-closed diagnostic, got: ${JSON.stringify(hits)}`
  );
  assert.ok(
    !hits.includes(COMPUTED_DYNAMIC_IMPORT_SPECIFIER_LABEL),
    `expected the sibling dynamic-import diagnostic to be absent, got: ${JSON.stringify(hits)}`
  );
  assert.ok(
    hits.some((h) => h.includes("references the global require")),
    `expected the SEPARATE global-require-acquisition diagnostic to also be present, got: ${JSON.stringify(hits)}`
  );
});

// ---------------------------------------------------------------------------
// Green controls proving the guard is not overbroad. Each is a required
// member of the suite - the matrix-completeness assertion at the end of
// this section reds if any one of them is ever deleted.
// ---------------------------------------------------------------------------

const executedGreenControls = new Set<string>();
function markGreenControl(name: string): void {
  executedGreenControls.add(name);
}

test("green control: the real permitted-only production shape - composited from src/server.ts's `import { ProtocolError, ProtocolErrorCode, Server, deserializeMessage }` + `import type { JSONRPCMessage, Transport }` and src/registry.ts's `import type { CallToolResult, Tool }`, all from the server root - produces zero hits", () => {
  markGreenControl("permitted-only-production-shape");
  const source = [
    'import { ProtocolError, ProtocolErrorCode, Server, deserializeMessage } from "@modelcontextprotocol/server";',
    'import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";',
    'import type { CallToolResult, Tool } from "@modelcontextprotocol/server";',
    "",
  ].join("\n");
  assert.deepEqual(findTasksImports(source), []);
});

test("green control: a file that only MENTIONS Tasks symbols in a comment and a string literal, with no real Tasks import/export, produces zero hits - proves the guard reads the AST, not the characters", () => {
  markGreenControl("comment-string-lookalike");
  const source = [
    "// GetTaskRequest handling lives elsewhere",
    'const label = "CreateTaskResult";',
    "",
  ].join("\n");
  assert.deepEqual(findTasksImports(source), []);
});

test("green control: a Tasks-NAMED symbol imported from an UNRELATED package produces zero hits - the boundary is the installed server root only, never a universal symbol-name claim", () => {
  markGreenControl("unrelated-package-task-import");
  const hits = findTasksImports('import { Task } from "some-unrelated-package";\n');
  assert.deepEqual(hits, []);
});

test("green control: a permitted-symbol re-export and a bare wildcard re-export of a non-server module each produce zero hits (re-confirmed here as its own standalone suite member for the completeness assertion below)", () => {
  markGreenControl("permitted-reexport-and-unrelated-wildcard");
  assert.deepEqual(
    findTasksImports('export { Server, McpServer } from "@modelcontextprotocol/server";\n'),
    []
  );
  assert.deepEqual(findTasksImports('export * from "./local-module.js";\n'), []);
});

test("suite-completeness: the four standalone green controls above each actually ran - the absence of any one reds this assertion, so silently deleting a green control cannot go unnoticed", () => {
  const required = [
    "permitted-only-production-shape",
    "comment-string-lookalike",
    "unrelated-package-task-import",
    "permitted-reexport-and-unrelated-wildcard",
  ];
  const missing = required.filter((name) => !executedGreenControls.has(name));
  assert.deepEqual(
    missing,
    [],
    `expected every required green control to have run, missing: ${JSON.stringify(missing)}`
  );
});

// ---------------------------------------------------------------------------
// The enumerated Tasks export set is DERIVED, never hand-listed: this
// parity test re-derives it independently, straight from the pinned
// @modelcontextprotocol/server package's real dist/index.d.mts (via the
// real TypeScript parser, not a regex over the file's raw text), and
// asserts the guard's own exported TASKS_SYMBOLS deep-equals it - so
// under- or over-enumerating the guard's list reds this test.
// ---------------------------------------------------------------------------

/** Parses the pinned server package's root `.d.mts` and returns every PUBLIC export name (after `as`-aliasing) matching /Task/i, straight off its final `export { ... }` statement - real AST traversal, not string matching. */
function deriveTasksExportNamesFromPinnedDeclarationFile(): string[] {
  const declarationFilePath = path.join(SERVER_PACKAGE_DIST, "index.d.mts");
  const text = readFileSync(declarationFilePath, "utf8");
  const sourceFile = ts.createSourceFile(declarationFilePath, text, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  sourceFile.forEachChild((node) => {
    if (
      ts.isExportDeclaration(node) &&
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        names.push(element.name.text);
      }
    }
  });
  return names.filter((name) => /Task/i.test(name));
}

test("parity: the guard's TASKS_SYMBOLS deep-equals the /Task/i root-export set re-derived, independently, from the pinned @modelcontextprotocol/server package's real dist/index.d.mts - under- or over-enumeration reds this test", () => {
  const derived = new Set(deriveTasksExportNamesFromPinnedDeclarationFile());
  assert.ok(
    derived.size > 0,
    "sanity: the derivation itself must find something in the real .d.mts"
  );
  assert.deepEqual(
    TASKS_SYMBOLS,
    derived,
    `guard TASKS_SYMBOLS diverges from the pinned package's real /Task/i export set.\nguard: ${JSON.stringify([...TASKS_SYMBOLS].sort())}\nderived: ${JSON.stringify([...derived].sort())}`
  );
});

// ---------------------------------------------------------------------------
// Specifier-resolution ownership: the guarded root is matched by real
// PACKAGE IDENTITY, not naive realpath-of-the-resolved-file equality - a
// relative/aliased specifier resolving to the SAME installed package is
// judged the same as the bare specifier text, and the three real,
// differently-built entry forms of the identical package version
// (index.cjs, index.mjs, a file:// URL) all collapse to one identity.
// These need a REAL file on a REAL path (never the OS tmpdir) so Node's
// actual resolver can walk up to this repo's own node_modules.
// ---------------------------------------------------------------------------

test("resolver-equivalence: a RELATIVE specifier resolving to the installed @modelcontextprotocol/server root is flagged for a Tasks symbol; an unrelated REAL package that happens to export a symbol NAMED exactly like a guarded Tasks symbol (Task) stays green - specifically because its package IDENTITY differs from the guarded root, not because the symbol name fails to match. A green control built from a symbol that was never Task-named in the first place (as this test used to use) cannot tell a correct identity check apart from one mutated to treat ANY resolvable package as the guarded root - only a REAL, resolvable, differently-identified package that legitimately exports a Task-named symbol can.", () => {
  const dir = buildRepoRootScratchSrc({
    "node_modules/ghantika-fixture-unrelated-task-export/package.json": JSON.stringify(
      { name: "ghantika-fixture-unrelated-task-export", version: "1.0.0", main: "index.js" },
      null,
      2
    ),
    "node_modules/ghantika-fixture-unrelated-task-export/index.js":
      "// A REAL, resolvable scratch package - deliberately a DIFFERENT\n" +
      "// package identity than @modelcontextprotocol/server - that\n" +
      '// happens to export a symbol named exactly "Task" (a real\n' +
      "// TASKS_SYMBOLS member), so this fixture proves the guard\n" +
      "// discriminates by PACKAGE IDENTITY rather than by whether a\n" +
      "// specifier merely resolves to something real.\n" +
      'module.exports.Task = "unrelated task marker - not the guarded server root";\n',
  });
  try {
    const fixturePath = path.join(dir, "tools", "mutant.ts");
    mkdirSync(path.dirname(fixturePath), { recursive: true });
    writeFileSync(
      fixturePath,
      'import { GetTaskRequest } from "../../node_modules/@modelcontextprotocol/server/dist/index.mjs";\n'
    );
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes('"GetTaskRequest"')),
      `expected the relative specifier to be flagged, got: ${JSON.stringify(violations)}`
    );

    const greenPath = path.join(dir, "tools", "green.ts");
    writeFileSync(
      greenPath,
      'import { Task } from "ghantika-fixture-unrelated-task-export";\nvoid Task;\n'
    );
    const greenViolations = checkNoTasksImport(dir).filter((v) => v.file.includes("green.ts"));
    assert.deepEqual(
      greenViolations,
      [],
      `expected the unrelated real package's Task-named export to stay green - a package-identity check mutated to "any resolvable package == the server root" (return identity !== undefined) would wrongly flag this, got: ${JSON.stringify(greenViolations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('package-identity discrimination is by real ROOT, not merely by NAME string: a vendored/nested lookalike package that declares the SAME literal name ("@modelcontextprotocol/server") but resolves to a totally different real root stays green for a Task-named symbol - proving the guard compares identity.root (not just identity.name), a distinct dimension from both the different-name case above and the package-root-normalization case elsewhere in this file (the same package reached via different entry files)', () => {
  const dir = buildRepoRootScratchSrc({
    "vendor/@modelcontextprotocol/server/package.json": JSON.stringify(
      { name: "@modelcontextprotocol/server", version: "0.0.1-lookalike", main: "index.js" },
      null,
      2
    ),
    "vendor/@modelcontextprotocol/server/index.js":
      "// A DIFFERENT real package that happens to declare the identical\n" +
      "// literal name as the guarded root, but lives at a completely\n" +
      "// different real path (never installed under node_modules at\n" +
      "// all) - proves identity.root, not merely identity.name, is what\n" +
      "// this guard actually compares.\n" +
      'module.exports.Task = "lookalike vendored copy, not the pinned real package";\n',
  });
  try {
    const fixturePath = path.join(dir, "tools", "lookalike.ts");
    mkdirSync(path.dirname(fixturePath), { recursive: true });
    writeFileSync(
      fixturePath,
      'import { Task } from "../vendor/@modelcontextprotocol/server/index.js";\nvoid Task;\n'
    );
    const violations = checkNoTasksImport(dir).filter((v) => v.file.includes("lookalike.ts"));
    assert.deepEqual(
      violations,
      [],
      `expected the same-named-but-different-root vendored lookalike to stay green - a check comparing identity.name alone (dropping the root comparison) would wrongly flag this, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('package-root normalization: three real resolution axes - a specifier resolving to the package\'s index.cjs, one resolving to its index.mjs, and one resolving via a file:// URL - are ALL treated as the SAME server package root and ALL flagged for a Tasks symbol; a naive realpath-of-the-resolved-file guard would split these into three different "roots"', () => {
  const dir = buildRepoRootScratchSrc({});
  try {
    const cjsPath = path.join(dir, "tools", "cjs-axis.ts");
    mkdirSync(path.dirname(cjsPath), { recursive: true });
    writeFileSync(
      cjsPath,
      'import { GetTaskRequest } from "../../node_modules/@modelcontextprotocol/server/dist/index.cjs";\n'
    );

    const mjsPath = path.join(dir, "tools", "mjs-axis.ts");
    writeFileSync(
      mjsPath,
      'import { GetTaskRequest } from "../../node_modules/@modelcontextprotocol/server/dist/index.mjs";\n'
    );

    const fileUrl = pathToFileURL(path.join(SERVER_PACKAGE_DIST, "index.cjs")).href;
    const fileUrlPath = path.join(dir, "tools", "file-url-axis.ts");
    writeFileSync(fileUrlPath, `import { GetTaskRequest } from "${fileUrl}";\n`);

    const violations = checkNoTasksImport(dir);
    for (const [label, relFile] of [
      ["index.cjs axis", "cjs-axis.ts"],
      ["index.mjs axis", "mjs-axis.ts"],
      ["file:// URL axis", "file-url-axis.ts"],
    ] as const) {
      assert.ok(
        violations.some(
          (v) => v.file.includes(relFile) && v.specifier.includes('"GetTaskRequest"')
        ),
        `expected the ${label} to be flagged as the same package root, got: ${JSON.stringify(violations)}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The mechanism used to LOAD a module never changes what it resolves to -
// a require(...) call, or a require obtained via createRequire(...), is
// caught the same way a static/dynamic import is. This whole section is
// UNCHANGED behavior from before the symbol-aware rewrite above: this
// codebase is frozen ESM end to end, so CommonJS interop (createRequire,
// the global require/eval/Function/module/Reflect, .constructor property
// access, and Object.getOwnPropertyDescriptor acquisition) is banned
// outright, independent of Tasks entirely - see
// scripts/lib/ts-ast.mjs's findCreateRequireImports for the whole design.
// Any argument string below is an arbitrary, unrelated placeholder - none
// of these rows are testing Tasks-symbol detection.
// ---------------------------------------------------------------------------

test("a require(...) call is caught at the require reference itself, independent of what it is called with", () => {
  const hits = findTasksImports('require("some-other-package/loaded-path");\n');
  assert.ok(
    hits.some((h) => h.includes("references the global require")),
    `expected the require reference itself to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("calling createRequire(...) at all is flagged as forbidden, independent of what its returned function is used for - resolved at the IMPORT BINDING itself (see findCreateRequireImports's own doc comment in scripts/lib/ts-ast.mjs), not by matching the call's callee text, which could never see past a renamed import alias", () => {
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

test("createRequire(...) imported from node:module is flagged at the import site; the local require it produces is then judged as the local callable it is, so a subsequent call through it adds no second hit, per the same local-binding rule that keeps an ordinary local require green", () => {
  const source = [
    'import { createRequire } from "node:module";',
    "const require = createRequire(import.meta.url);",
    'require("some-other-package/loaded-path");',
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

test("green control: a require(...) call to a legitimate, unrelated specifier produces no unexpected hit (the bare require reference is still its own, separate violation)", () => {
  const hits = findTasksImports('require("node:path");\n');
  assert.ok(
    !hits.some((h) => h.includes('"node:path"')),
    `expected no Tasks-shaped hit naming this specifier, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a require(...) call through a LOCAL binding - a plain function that merely happens to be named require, never Node's real CommonJS require - is judged as the local callable: its argument is never treated as a real import", () => {
  const hits = findTasksImports(
    'function require(x: string) { return x; }\nrequire("some-other-package/loaded-path");\n'
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
// createRequire, which is just as executable a route as a static import.
// Each row below is a distinct entry route, each independently caught, plus
// green controls proving legitimate dynamic imports and an unrelated
// property named "require" stay clean.
// ---------------------------------------------------------------------------

test("a dynamic import of node:module, destructured for createRequire, is caught - the executable survivor that motivated this fix", () => {
  const hits = findTasksImports(
    'const { createRequire: weaveBridge } = await import("node:module");\n' +
      "const retrieveUnit = weaveBridge(import.meta.url);\n" +
      'retrieveUnit("some-other-package/loaded-path");\n'
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
  const hits = findTasksImports('module.require("some-other-package/loaded-path");\n');
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
// spelling must not change the result.
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
// produces is undecidable in general.
// ---------------------------------------------------------------------------

test("eval(...) used to obtain a dynamic loader is caught, unconditionally on its argument", () => {
  const hits = findTasksImports(
    "const moduleDeck = await eval('import(\"node:module\")');\n" +
      "const pull = moduleDeck.createRequire(import.meta.url);\n" +
      'pull("some-other-package/loaded-path");\n'
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
      'pull("some-other-package/loaded-path");\n'
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
// come to hold the runtime capability is forbidden - this is the createRequire
// side of this file's own architectural-vs-capability distinction (see
// scripts/check-no-tasks-import.mjs's header).
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
// four never carries the capability.
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
// permanent regression coverage for both directions in one place.
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
    'const require = (x: string) => x;\nrequire("some-other-package/loaded-path");\n'
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
// property are all closed - see findCreateRequireImports's own doc comment
// for the full acquisition-site design.
// ---------------------------------------------------------------------------

test("REGRESSION: obtaining the Function constructor via an ordinary function object's own .constructor property IS detected", () => {
  const hits = findTasksImports('const F = (() => 1).constructor;\nF("return 1");\n');
  assert.ok(
    hits.some((hit) => hit.includes(".constructor")),
    `expected a constructor-property-access violation, got: ${JSON.stringify(hits)}`
  );
});

test('REGRESSION: obtaining the global eval via Reflect.get(globalThis, "eval") IS detected - at the bare Reflect reference itself', () => {
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
// real globalThis/process is exactly as real an acquisition route as the
// bare name would have been.
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

test("documented boundary: a TWO-HOP alias chain is not chased (const g = globalThis; const h = g; h.eval(x)) - guard logic is unchanged, this stays green by design", () => {
  const hits = findTasksImports("const g = globalThis;\nconst h = g;\nh.eval('1');\n");
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------------------
// Object.getOwnPropertyDescriptor - a DESCRIPTOR READ reaches the same value
// a direct property access would, without ever writing the target's key as
// a real property-access AST node.
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
// process.getBuiltinModule - reaches createRequire via a supported Node
// builtin-module API with no import/require syntax naming "node:module"
// anywhere - flagged at the property-access acquisition site.
// ---------------------------------------------------------------------------

test('process.getBuiltinModule("node:module").createRequire(...) is detected', () => {
  const hits = findTasksImports(
    'const r = process.getBuiltinModule("node:module").createRequire(import.meta.url);\n' +
      'r("some-other-package/loaded-path");\n'
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
  const hits = findTasksImports('const fsModule = process.getBuiltinModule("fs");\n');
  assert.ok(
    hits.some((hit) => hit.includes("getBuiltinModule")),
    `expected the acquisition itself to be flagged regardless of argument, got: ${JSON.stringify(hits)}`
  );
});

// ---------------------------------------------------------------------------
// Six further acquisition shapes, each an idiomatic variant of a route
// already closed above rather than a new mechanism.
// ---------------------------------------------------------------------------

test("a destructured getBuiltinModule reached DIRECTLY off process (no intermediate alias variable) is caught the same way an aliased base is - const { getBuiltinModule } = process", () => {
  const hits = findTasksImports(
    "const { getBuiltinModule } = process;\n" +
      "const m = getBuiltinModule('node:module');\n" +
      "m.createRequire(import.meta.url);\n"
  );
  assert.ok(
    hits.some((h) => h.includes("getBuiltinModule")),
    `expected the direct destructure off process to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("green control: destructuring a HARMLESS property directly off process is never flagged", () => {
  const hits = findTasksImports("const { env } = process;\nvoid env;\n");
  assert.deepEqual(hits, []);
});

test("a variable-keyed .constructor access, resolved through one local alias hop, is caught the same way a literal bracketed key already is - const k = 'constructor'; obj[k]", () => {
  const hits = findTasksImports(
    "const k = 'constructor';\nconst F = (() => 1)[k];\nF('return 1');\n"
  );
  assert.ok(
    hits.some((h) => h.includes(".constructor")),
    `expected the alias-resolved computed .constructor key to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a variable-keyed property access whose alias resolves to an UNRELATED string is never mistaken for a .constructor access", () => {
  const hits = findTasksImports("const k = 'toString';\nconst t = ({})[k];\nvoid t;\n");
  assert.deepEqual(hits, []);
});

test("a .constructor binding destructured directly off a NON-GLOBAL source (an arrow function, not globalThis/process) is caught - the ban is on the key, unconditional on where it's destructured from", () => {
  const hits = findTasksImports("const { constructor: F } = (() => {});\nF('return 1');\n");
  assert.ok(
    hits.some((h) => h.includes(".constructor")),
    `expected the destructured .constructor off a non-global source to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("green control: destructuring a HARMLESS key off a non-global source is never flagged", () => {
  const hits = findTasksImports("const { toString: t } = (() => {});\nvoid t;\n");
  assert.deepEqual(hits, []);
});

test("a non-null assertion sitting directly on the globalThis base does not defeat detection - globalThis!.eval(x)", () => {
  const hits = findTasksImports("globalThis!.eval('1');\n");
  assert.ok(
    hits.some((h) => h.includes("references the global eval")),
    `expected the non-null-asserted globalThis base to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("an 'as' cast sitting directly on the globalThis base does not defeat detection either - (globalThis as typeof globalThis).eval(x)", () => {
  const hits = findTasksImports("(globalThis as typeof globalThis).eval('1');\n");
  assert.ok(
    hits.some((h) => h.includes("references the global eval")),
    `expected the cast globalThis base to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("a non-null assertion sitting directly on the process base is caught the same way - process!.getBuiltinModule(...)", () => {
  const hits = findTasksImports("process!.getBuiltinModule('node:module');\n");
  assert.ok(
    hits.some((h) => h.includes("getBuiltinModule")),
    `expected the non-null-asserted process base to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a cast or non-null assertion on an UNRELATED, harmless base is never flagged", () => {
  const hits = findTasksImports(
    "const safe = { run: () => 1 };\nconst x = (safe as typeof safe)!.run();\nvoid x;\n"
  );
  assert.deepEqual(hits, []);
});

test("process.dlopen is caught - one of the two process properties beyond getBuiltinModule this guard also treats as dangerous", () => {
  const hits = findTasksImports("process.dlopen({ exports: {} }, './native.node');\n");
  assert.ok(
    hits.some((h) => h.includes("process's dangerous properties")),
    `expected a process.dlopen violation, got: ${JSON.stringify(hits)}`
  );
});

test("process.binding is caught the same way - Node's internal native-binding loader", () => {
  const hits = findTasksImports("const b = process.binding('fs');\nvoid b;\n");
  assert.ok(
    hits.some((h) => h.includes("process's dangerous properties")),
    `expected a process.binding violation, got: ${JSON.stringify(hits)}`
  );
});

test("an AMBIENT 'declare const Reflect' does not actually shadow at runtime - the guard treats the reference as the real global, not a local shadow", () => {
  const hits = findTasksImports(
    "declare const Reflect: { get: (t: unknown, k: string) => unknown };\n" +
      "const e = Reflect.get(globalThis, 'eval');\n" +
      "e('1');\n"
  );
  assert.ok(
    hits.some((h) => h.includes("references the global Reflect")),
    `expected the ambient-shadowed Reflect reference to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("green control: a REAL (non-ambient) local Reflect declaration still shadows correctly - only the ambient, erased form fails to shadow", () => {
  const hits = findTasksImports(
    "const Reflect = { get: (t: unknown, k: string) => undefined };\n" +
      "const e = Reflect.get(globalThis, 'eval');\n" +
      "void e;\n"
  );
  assert.deepEqual(hits, []);
});
