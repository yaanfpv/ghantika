import assert from "node:assert/strict";
import { test } from "node:test";

import { checkStdioPurity, findStdoutWrites } from "../scripts/check-stdio-purity.mjs";

// --- the real src/ tree, as it exists right now, must be clean ---

test("static half: the real src/ tree contains no console.log or process.stdout reference", () => {
  assert.deepEqual(checkStdioPurity(), []);
});

// --- static guard side: production mutant "write to stdout" ---

test("a console.log call is caught", () => {
  assert.deepEqual(findStdoutWrites('console.log("hello");\n'), ["console.log("]);
});

test("a direct process.stdout reference is caught", () => {
  const hits = findStdoutWrites("process.stdout.write(data);\n");
  assert.equal(hits.length, 1);
  assert.equal(hits[0], "process.stdout");
});

test("a mutant that pipes a hypothetical child's stdout into the server's own stdout is caught", () => {
  // The exact shape of regression this guard exists to prevent:
  // something in this codebase wiring a child's output stream directly to
  // the server's own stdout.
  const mutant = "childProcess.stdout.pipe(process.stdout);\n";
  const hits = findStdoutWrites(mutant);
  assert.ok(hits.includes("process.stdout"));
});

test("mutation control: the guard actually reacts to the change - clean before, red after console.log is introduced, clean again once reverted", () => {
  const clean = "export function handler() {\n  return { content: [] };\n}\n";
  assert.deepEqual(findStdoutWrites(clean), []);

  const withRegression =
    "export function handler() {\n  console.log('debug');\n  return { content: [] };\n}\n";
  assert.equal(findStdoutWrites(withRegression).length, 1);

  const reverted = clean;
  assert.deepEqual(findStdoutWrites(reverted), []);
});

// --- findStdoutWrites runs on the real TypeScript AST, where a comment is
// trivia attached to a token and never an AST node at all - so a comment
// that merely TALKS ABOUT process.stdout/console.log can never register
// as a violation, structurally, with no separate "strip the comments
// first" step required. That used to be a distinct regex pass (a
// standalone `stripComments` helper with its own dedicated unit tests);
// the AST rewrite made a comment-stripping step unnecessary, so its
// capability moved from that standalone utility to a structural property
// of the parser itself. These two tests assert the SAME invariant the old
// ones did - a doc-comment/prose mention of process.stdout is never
// flagged - now proven directly against findStdoutWrites's real output,
// the surface that actually matters, instead of against the (now-removed)
// intermediate comment-stripping step. ---

test("a block comment mentioning process.stdout in prose is never itself flagged as a violation", () => {
  const source = "/* this mentions process.stdout in a comment */\nconst x = 1;\n";
  assert.deepEqual(findStdoutWrites(source), []);
});

test("a line comment mentioning process.stdout/console.log in prose is never itself flagged as a violation", () => {
  const source =
    "// never write to process.stdout directly, and never call console.log either\nconst x = 1;\n";
  assert.deepEqual(findStdoutWrites(source), []);
});

// --- computed member access is the same semantic shape as dotted access
// to a real parser, e.g. `process["stdout"].write("leak")`. ---

test('a computed process["stdout"] reference is caught, not just the dotted process.stdout spelling', () => {
  const hits = findStdoutWrites('process["stdout"].write("leak");\n');
  assert.equal(hits.length, 1);
  assert.match(hits[0], /process\[.stdout.\]/);
});

test('a computed console["log"](...) call is caught, not just the dotted console.log spelling', () => {
  const hits = findStdoutWrites('console["log"]("leak");\n');
  assert.equal(hits.length, 1);
  assert.match(hits[0], /console\[.log.\]\(/);
});

test("green control: a computed access on an UNRELATED object (never process/console) is never flagged", () => {
  const source = 'const x = someOtherObject["stdout"]; const y = notConsole["log"]("hi");\n';
  assert.deepEqual(findStdoutWrites(source), []);
});

test("green control: a doc comment discussing process.stdout is never flagged as a violation", () => {
  const source = [
    "/**",
    " * This module never writes to process.stdout - logging goes through",
    " * console.error only.",
    " */",
    "export const marker = true;",
    "",
  ].join("\n");
  assert.deepEqual(findStdoutWrites(source), []);
});

test("green control: console.error is never flagged - it writes to stderr, not stdout", () => {
  assert.deepEqual(findStdoutWrites('console.error("diagnostic");\n'), []);
});

test("green control: process.stderr is never flagged (only process.stdout is forbidden)", () => {
  assert.deepEqual(findStdoutWrites("process.stderr.write(data);\n"), []);
});

test("mutation control: the real src/ tree's own doc comments (which discuss process.stdout by name) do not trip the guard - comments are trivia, never AST nodes, so real parsing has no comment-related blind spot at all", () => {
  // src/server.ts's header explicitly discusses process.stdout in prose.
  // If the AST walk somehow visited comment text, checkStdioPurity() on
  // the real tree (asserted clean above) would fail.
  assert.deepEqual(checkStdioPurity(), []);
});

// --- the guard must catch every console method that actually writes to
// stdout under Node's real, documented behavior - not just console.log -
// and must NOT flag a method that never writes anything (that would be a
// pure false positive), nor a method that writes only to stderr. See
// check-stdio-purity.mjs's STDOUT_WRITING_CONSOLE_METHODS doc comment for
// the full empirical verification this set is built from. ---

test("every stdout-writing console method beyond log is caught, dotted form", () => {
  const methods = [
    "info",
    "debug",
    "dir",
    "dirxml",
    "table",
    "group",
    "groupCollapsed",
    "count",
    "timeEnd",
    "timeLog",
  ];
  for (const method of methods) {
    const hits = findStdoutWrites(`console.${method}("x");\n`);
    assert.equal(
      hits.length,
      1,
      `expected console.${method}(...) to be caught, got: ${JSON.stringify(hits)}`
    );
    assert.equal(hits[0], `console.${method}(`);
  }
});

test("every stdout-writing console method beyond log is caught, computed-bracket form", () => {
  const methods = [
    "info",
    "debug",
    "dir",
    "dirxml",
    "table",
    "group",
    "groupCollapsed",
    "count",
    "timeEnd",
    "timeLog",
  ];
  for (const method of methods) {
    const hits = findStdoutWrites(`console["${method}"]("x");\n`);
    assert.equal(
      hits.length,
      1,
      `expected console["${method}"](...) to be caught, got: ${JSON.stringify(hits)}`
    );
  }
});

test("green control: console.trace is never flagged - Node writes it to stderr, not stdout, despite superficially resembling console.log", () => {
  assert.deepEqual(findStdoutWrites('console.trace("x");\n'), []);
});

test("green control: console.warn and console.assert are never flagged - both write to stderr only", () => {
  assert.deepEqual(findStdoutWrites('console.warn("x");\n'), []);
  assert.deepEqual(findStdoutWrites('console.assert(false, "x");\n'), []);
});

test("green control: console.groupEnd, console.countReset, and console.time are never flagged - none of the three writes anything, to stdout or anywhere else, under any arguments (verified empirically, not merely assumed)", () => {
  assert.deepEqual(findStdoutWrites("console.groupEnd();\n"), []);
  assert.deepEqual(findStdoutWrites('console.countReset("x");\n'), []);
  assert.deepEqual(findStdoutWrites('console.time("x");\n'), []);
});

test("mutation control: the guard reacts to the change for a non-log method too - clean before, red after console.info is introduced, clean again once reverted", () => {
  const clean = "export function handler() {\n  return { content: [] };\n}\n";
  assert.deepEqual(findStdoutWrites(clean), []);
  const withRegression =
    "export function handler() {\n  console.info('debug');\n  return { content: [] };\n}\n";
  assert.equal(findStdoutWrites(withRegression).length, 1);
  assert.deepEqual(findStdoutWrites(clean), []);
});

// --- the ALIAS-CREATION itself must be the trigger - a later .stdout
// access on some unrecognized local name would otherwise escape the
// process.stdout check above entirely. ---

test("a const bound directly to the bare process identifier is caught at the declaration - the alias creation itself, before any .stdout access", () => {
  const hits = findStdoutWrites("const aliasedProcess = process;\n");
  assert.equal(
    hits.length,
    1,
    `expected the alias declaration itself to be flagged, got: ${JSON.stringify(hits)}`
  );
  assert.match(hits[0]!, /aliasedProcess/);
});

test("a const bound to globalThis.process is caught the same way as the bare process form, with a subsequent .stdout access through the alias", () => {
  const hits = findStdoutWrites(
    'const aliasedProcess = globalThis.process;\naliasedProcess.stdout.write("leak");\n'
  );
  assert.ok(
    hits.some((h) => h.includes("aliasedProcess")),
    `expected the globalThis.process alias to be flagged, got: ${JSON.stringify(hits)}`
  );
});

test("let and var aliases of process are caught too, not just const", () => {
  const letHits = findStdoutWrites("let aliasedProcess = process;\n");
  assert.equal(letHits.length, 1);
  const varHits = findStdoutWrites("var aliasedProcess = process;\n");
  assert.equal(varHits.length, 1);
});

test("a bounded multi-hop re-alias chain (up to a documented hop limit) is still caught - each intermediate name resolves transitively back to process", () => {
  const source = [
    "const a = process;",
    "const b = a;",
    "const c = b;",
    'c.stdout.write("leak");',
    "",
  ].join("\n");
  const hits = findStdoutWrites(source);
  const aliasHits = hits.filter((h) => h.includes("aliases process"));
  assert.equal(
    aliasHits.length,
    3,
    `expected all three chained names (a, b, c) to be flagged, got: ${JSON.stringify(hits)}`
  );
  assert.ok(aliasHits.some((h) => h.includes('"a"')));
  assert.ok(aliasHits.some((h) => h.includes('"b"')));
  assert.ok(aliasHits.some((h) => h.includes('"c"')));
});

test("green control: a const/let/var bound to an UNRELATED value is never flagged as a process alias", () => {
  const source = [
    "const a = 1;",
    'const b = "process-like-string-but-not-the-identifier";',
    "const c = someOtherObject;",
    "",
  ].join("\n");
  assert.deepEqual(findStdoutWrites(source), []);
});

test('green control: a const bound to childProcess (an unrelated identifier that merely contains the substring "process") is never flagged - the check matches the exact identifier `process`, never a substring', () => {
  const hits = findStdoutWrites("const alias = childProcess;\n");
  assert.deepEqual(hits, []);
});

test("mutation control: the alias guard reacts to the change - clean before, red after a process alias declaration is introduced, clean again once reverted", () => {
  const clean = "export function handler() {\n  return { content: [] };\n}\n";
  assert.deepEqual(findStdoutWrites(clean), []);
  const withRegression =
    "const aliasedProcess = process;\nexport function handler() {\n  return { content: [] };\n}\n";
  assert.equal(findStdoutWrites(withRegression).length, 1);
  assert.deepEqual(findStdoutWrites(clean), []);
});
