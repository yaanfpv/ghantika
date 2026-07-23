import assert from "node:assert/strict";
import { before, test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FROZEN_MODULES, checkModuleBoundaries } from "../scripts/check-module-boundaries.mjs";
import { checkNoTasksImport } from "../scripts/check-no-tasks-import.mjs";
import { checkStdioPurity } from "../scripts/check-stdio-purity.mjs";

/**
 * Executes 45 physical mutation-test cases covering the module-loader
 * guards' full documented escape-route class against this repo's ACTUAL,
 * CURRENT head - never a stale commit any prior planning was authored
 * against. A prior result is always void once the head moves; this file
 * always re-executes in full rather than carrying a prior result forward.
 *
 * PLUS three additional cases (grouped in their own section below) that
 * are NOT part of the 45-case set and are NOT required to red: they
 * evidence a two-hop acquisition frontier this guard intentionally leaves
 * open, one hop past the closed one-hop alias/computed-member forms
 * earlier in this file. This file's authoritative-open-ledger status now
 * covers both: every case that must red still must red exactly as
 * before, and the three open cases must stay green - a change to either
 * is void on head move.
 *
 * Methodology, matching test/guard-mutation-coverage.test.ts: a real
 * scratch directory on disk (`mkdtempSync`), a fixture file written into
 * it containing the EXACT code shape a case describes, then the REAL
 * orchestrating guard function (`checkModuleBoundaries`/`checkNoTasksImport`
 * imported from the actual `scripts/*.mjs` guards, never the low-level
 * `find*` helpers) run against that scratch directory - proving each case
 * is caught at the SAME layer `npm run guard:*` runs at. Every scratch
 * directory is removed (`rmSync`) immediately after its assertions.
 *
 * The kill criterion: a case is killed only when the NAMED OWNING GUARD
 * rejects it and the rejection matches that case's OWNING PREDICATE - the
 * specific diagnostic text the guard is expected to emit. A red from the
 * other guard, a parse error, or a generic non-zero exit is NOT a kill.
 * Every assertion below matches on the exact predicate substring expected
 * for that case, not merely "some violation exists".
 *
 * The guard-self-mutation cases near the end of this file are different
 * in kind from the fixture-mutation cases earlier: those mutate a FIXTURE
 * and run the real, unmutated guard against it; the guard-self-mutation
 * cases mutate the GUARD ITSELF. The TRACKED guard files
 * (scripts/check-module-boundaries.mjs,
 * scripts/check-no-tasks-import.mjs, scripts/check-stdio-purity.mjs,
 * scripts/lib/ts-ast.mjs) are never modified - those cases instead copy
 * the guard's own source text (plus its unmutated scripts/lib/*.mjs
 * dependencies) into a scratch directory, apply one exact, deterministic
 * textual mutation to the COPY, dynamically `import()` the mutated copy,
 * and run its OWN exported orchestrating function - never touching the
 * real file on disk. See `loadMutatedGuardCopy` below.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Builds a scratch src/-shaped tree from a flat map of relative path -> file contents. Mirrors test/guard-mutation-coverage.test.ts's own helper of the same name. */
function buildScratchSrc(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-loader-escape-"));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/**
 * Builds a scratch tree containing EVERY file `FROZEN_MODULES` requires
 * (a trivial `export {};` stub for each), then overwrites `mutantRelPath`
 * - one of those same frozen names, never an extra file - with the real
 * fixture content. `checkModuleBoundaries`'s frozen-module-completeness
 * check and `checkNoTasksImport`'s whole-tree scan can BOTH return a
 * literal, unfiltered empty array against a tree built this way (verified
 * empirically), which is the stronger, more defensible form for a case
 * that must prove "genuinely unflagged," not merely "unflagged once an
 * unrelated check's noise is filtered out."
 */
function buildCompleteFrozenScratchSrc(mutantRelPath: string, mutantContent: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-loader-escape-frozen-"));
  for (const rel of FROZEN_MODULES) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "export {};\n");
  }
  const mutantAbs = path.join(dir, mutantRelPath);
  mkdirSync(path.dirname(mutantAbs), { recursive: true });
  writeFileSync(mutantAbs, mutantContent);
  return dir;
}

/**
 * Replaces `search` with `replace` in `text`, but only after confirming
 * `search` appears EXACTLY ONCE - a mutation discipline matching the
 * governing standard ("applied to exactly one target"). Refuses an
 * ambiguous (zero, or more than one occurrence) mutation rather than
 * silently guessing.
 */
function mutateExactlyOnce(text: string, search: string, replace: string): string {
  const occurrences = text.split(search).length - 1;
  assert.equal(
    occurrences,
    1,
    `expected the mutation target text to appear EXACTLY once in the source, found ${occurrences} - refusing an ambiguous or vacuous mutation. Target was:\n${search}`
  );
  return text.replace(search, replace);
}

/**
 * Guard-self-mutation cases only. Copies `guardRelFile` (e.g.
 * "check-module-boundaries.mjs") from the REAL `scripts/` directory, plus
 * its unmutated `scripts/lib/*.mjs` dependencies, into a fresh scratch
 * directory placed directly under the repo root (never inside an OS
 * tmpdir) so that `import ts from "typescript"` inside the copied
 * `ts-ast.mjs` still resolves via Node's ordinary node_modules ancestor
 * walk, which finds this repo's own `node_modules/typescript` from the
 * scratch directory's parent. Applies `mutate` to the target guard file's
 * text (via `mutateExactlyOnce`, so a mutation that doesn't land exactly
 * once throws rather than silently doing nothing), writes the mutated copy,
 * and dynamically `import()`s it - the REAL tracked file at
 * `scripts/<guardRelFile>` is read but never written. The caller is
 * responsible for `rmSync`-ing the returned `scratchDir` once done.
 */
async function loadMutatedGuardCopy(
  guardRelFile: string,
  mutate: (originalText: string) => string
): Promise<{ mod: Record<string, unknown>; scratchDir: string }> {
  const scratchDir = mkdtempSync(path.join(REPO_ROOT, ".ghantika-self-mutant-"));
  try {
    const scriptsDir = path.join(scratchDir, "scripts");
    const libDir = path.join(scriptsDir, "lib");
    mkdirSync(libDir, { recursive: true });
    for (const libFile of ["ts-ast.mjs", "is-main.mjs"]) {
      writeFileSync(
        path.join(libDir, libFile),
        readFileSync(path.join(REPO_ROOT, "scripts", "lib", libFile), "utf8")
      );
    }
    const originalText = readFileSync(path.join(REPO_ROOT, "scripts", guardRelFile), "utf8");
    const mutatedText = mutate(originalText);
    assert.notEqual(
      mutatedText,
      originalText,
      "the mutation must actually change the source text - a no-op mutation proves nothing"
    );
    const mutatedPath = path.join(scriptsDir, guardRelFile);
    writeFileSync(mutatedPath, mutatedText);
    const mod = (await import(pathToFileURL(mutatedPath).href)) as Record<string, unknown>;
    return { mod, scratchDir };
  } catch (err) {
    rmSync(scratchDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Spawns a FRESH `node --test` process over the three permanent guard test
 * files, and parses the real, current pass/fail/tests counts off its
 * summary lines - never a hardcoded historical figure. Node's default
 * (non-TTY) test-runner summary reporter prints `ℹ tests N` / `ℹ pass N` /
 * `ℹ fail N` (verified empirically against this exact invocation before
 * writing this helper); the `#`-prefixed TAP form is accepted too as a
 * defensive fallback in case the reporter's exact prefix ever changes.
 */
function runPermanentGuardSuite(): { tests: number; pass: number; fail: number; raw: string } {
  // NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID are set by the OUTER `node
  // --test` process running THIS file and, being ordinary environment
  // variables, are inherited by spawnSync's child by default - which makes
  // the child's own `node --test` invocation think it is a recursive
  // re-entry into an already-running test file and print "run() is being
  // called recursively within a test file. skipping running files."
  // instead of actually running anything (verified empirically: without
  // this strip, the child prints only that warning and zero test output).
  // Stripping just these two lets the child run as a genuinely independent
  // process, matching how CI or a bare terminal invocation would run it.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "test/guard-mutation-coverage.test.ts",
      "test/module-boundaries.test.ts",
      "test/no-tasks-import.test.ts",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 * 64, env: childEnv }
  );
  const raw = `${result.stdout}\n${result.stderr}`;
  const testsMatch = raw.match(/[ℹ#] tests (\d+)/);
  const passMatch = raw.match(/[ℹ#] pass (\d+)/);
  const failMatch = raw.match(/[ℹ#] fail (\d+)/);
  if (!testsMatch || !passMatch || !failMatch) {
    throw new Error(`could not parse node --test summary from output:\n${raw}`);
  }
  return {
    tests: Number(testsMatch[1]),
    pass: Number(passMatch[1]),
    fail: Number(failMatch[1]),
    raw,
  };
}

/** Captured once, before any test in this file runs (node:test's `before()` hook guarantee) - the pre-mutation baseline the later denominator/consistency checks compare against. */
let baseline: ReturnType<typeof runPermanentGuardSuite> | undefined;

before(() => {
  baseline = runPermanentGuardSuite();
});

// =============================================================================
// ACQUISITION: how the loader capability is OBTAINED (19 executions). All
// must RED. The first ten are owned by the no-tasks guard except for two
// specifier-resolution cases owned by module-boundaries; the remaining
// eight (adversarially-verified acquisition escapes) are all owned by the
// no-tasks guard, which walks the whole src/ tree.
//
// The one-hop alias and computed-member acquisition cases close the
// ONE-HOP form. A second hop of the identical kind is a separate,
// disclosed boundary - see the dedicated section below, immediately after
// this one - never folded into these 19 RED executions.
// =============================================================================

test('import { createRequire } from "node:module" - the recognised path, the control that already works - must ALSO red on the unmutated tree as the guard\'s liveness control', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": 'import { createRequire } from "node:module";\n',
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("imports createRequire from node:module")),
      `expected the named-import createRequire diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('process.getBuiltinModule("node:module").createRequire(...) - a runtime-executing escape from the recognised import path - is caught by the banned-acquisition diagnostic naming the property access, not merely the specifier "node:module"', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      'const req = process.getBuiltinModule("node:module").createRequire(import.meta.url);',
      'req("./sibling.js");',
      "",
    ].join("\n"),
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("process's dangerous properties")),
      `expected the process.getBuiltinModule acquisition diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('require("module").createRequire(...) is caught at the bare require reference itself, naming require as a banned construct', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": 'const req = require("module").createRequire(import.meta.url);\n',
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("references the global require")),
      `expected the bare-require acquisition diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(await import("node:module")).createRequire(...) is caught on the awaited-import member access', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts":
      'const req = (await import("node:module")).createRequire(import.meta.url);\n',
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("dynamically imports node:module")),
      `expected the awaited dynamic-import createRequire diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('import("node:module").then(m => m.createRequire(...)) is caught despite the capability being reached in a callback, never bound at module scope - a scope-limited check would fail this row', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      'import("node:module").then((m) => {',
      "  const req = m.createRequire(import.meta.url);",
      '  req("./sibling.js");',
      "});",
      "",
    ].join("\n"),
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("dynamically imports node:module")),
      `expected the .then-chained dynamic-import createRequire diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('destructured off an intermediate - const {createRequire: cr} = process.getBuiltinModule("node:module") - is caught under its ALIAS cr, at the acquisition site regardless of the downstream destructure', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      'const { createRequire: cr } = process.getBuiltinModule("node:module");',
      "const req = cr(import.meta.url);",
      "",
    ].join("\n"),
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("process's dangerous properties")),
      `expected the process.getBuiltinModule acquisition diagnostic despite the destructured alias, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aliased through a variable - const g = process.getBuiltinModule; g("node:module").createRequire(...) - is caught despite the callee being an alias; a callee-name-only check would fail this row', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      "const g = process.getBuiltinModule;",
      'const req = g("node:module").createRequire(import.meta.url);',
      "",
    ].join("\n"),
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("process's dangerous properties")),
      `expected the process.getBuiltinModule acquisition diagnostic at the ALIASED access site, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("module.constructor.createRequire(...) is caught via the .constructor banned-property-access diagnostic", () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": "const req = module.constructor.createRequire(import.meta.url);\n",
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("reads a .constructor property")),
      `expected the .constructor property-access diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prototype-chain reach to the same constructor - Object.getPrototypeOf(module).constructor - is caught the same way; a distinct physical mutation from the direct .constructor access above", () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      "const proto = Object.getPrototypeOf(module);",
      "const req = proto.constructor.createRequire(import.meta.url);",
      "",
    ].join("\n"),
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("reads a .constructor property")),
      `expected the prototype-chain .constructor property-access diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('import.meta.resolve("../tools/sibling.js") handing the resolved URL to a process.getBuiltinModule loader is caught by the SPECIFIER check itself - not merely by the separate, already-banned process.getBuiltinModule acquisition', () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": [
      'const resolvedUrl = import.meta.resolve("../tools/sibling.js");',
      'const req = process.getBuiltinModule("node:module").createRequire(import.meta.url);',
      "req(resolvedUrl);",
      "",
    ].join("\n"),
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "../tools/sibling.js"')
      ),
      `expected the import.meta.resolve specifier itself to be flagged as a sibling reference, got: ${JSON.stringify(violations)}`
    );
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes("process's dangerous properties")
      ),
      `expected the process.getBuiltinModule acquisition to ALSO be flagged (both are real), got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bare module.require(...) in a CJS-shaped context is caught, naming module.require's own reachable-global acquisition", () => {
  const dir = buildScratchSrc({ "tools/mutant.ts": 'module.require("./sibling.js");\n' });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes("references the global module")
      ),
      `expected the module.require diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Object.getOwnPropertyDescriptor(globalThis, "eval")?.value is caught by the property-descriptor-access diagnostic', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts":
      "const e = Object.getOwnPropertyDescriptor(globalThis, 'eval')?.value;\ne?.('1');\n",
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("getOwnPropertyDescriptor")),
      `expected the descriptor-read acquisition diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Object.getOwnPropertyDescriptor(Object.getPrototypeOf(fn), "constructor")?.value is caught the same way, unconditional on the target (an arbitrary function, not globalThis/process)', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      "function fn() {}",
      "const F = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(fn), 'constructor')?.value;",
      "",
    ].join("\n"),
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("getOwnPropertyDescriptor")),
      `expected the descriptor-read acquisition diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one-hop alias acquisition - const g = globalThis; g.eval(x) / const p = process; p.getBuiltinModule(...) / const {getBuiltinModule} = process - each caught through exactly one local alias hop to the real base", () => {
  const dirA = buildScratchSrc({ "tools/mutant.ts": "const g = globalThis;\ng.eval('1');\n" });
  const dirB = buildScratchSrc({
    "tools/mutant.ts": [
      "const p = process;",
      'const req = p.getBuiltinModule("node:module").createRequire(import.meta.url);',
      "",
    ].join("\n"),
  });
  const dirC = buildScratchSrc({
    "tools/mutant.ts": [
      "const { getBuiltinModule } = process;",
      'const req = getBuiltinModule("node:module").createRequire(import.meta.url);',
      "",
    ].join("\n"),
  });
  try {
    const violationsA = checkNoTasksImport(dirA);
    assert.ok(
      violationsA.some((v) => v.specifier.includes("references the global eval")),
      `expected the globalThis one-hop-alias eval diagnostic, got: ${JSON.stringify(violationsA)}`
    );
    const violationsB = checkNoTasksImport(dirB);
    assert.ok(
      violationsB.some((v) => v.specifier.includes("process's dangerous properties")),
      `expected the process one-hop-alias getBuiltinModule diagnostic, got: ${JSON.stringify(violationsB)}`
    );
    const violationsC = checkNoTasksImport(dirC);
    assert.ok(
      violationsC.some((v) => v.specifier.includes("process's dangerous properties")),
      `expected the destructured-directly-off-process getBuiltinModule diagnostic, got: ${JSON.stringify(violationsC)}`
    );
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(dirC, { recursive: true, force: true });
  }
});

test('variable-keyed .constructor - const k="constructor"; (()=>{})[k] - is caught on a computed key foldable to the literal through one local alias hop', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": "const k = 'constructor';\nconst F = (() => {})[k];\n",
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("reads a .constructor property")),
      `expected the variable-keyed .constructor diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("destructured .constructor - const {constructor: F} = (()=>{}) - is caught unconditionally on the destructuring source", () => {
  const dir = buildScratchSrc({ "tools/mutant.ts": "const { constructor: F } = (() => {});\n" });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("reads a .constructor property")),
      `expected the destructured .constructor diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cast / non-null base - globalThis!.eval(x) / (globalThis as typeof globalThis).eval(x) - neither defeats detection after stripping the transparent syntax wrapper", () => {
  const dirA = buildScratchSrc({ "tools/mutant.ts": "globalThis!.eval('1');\n" });
  const dirB = buildScratchSrc({
    "tools/mutant.ts": "(globalThis as typeof globalThis).eval('1');\n",
  });
  try {
    const violationsA = checkNoTasksImport(dirA);
    assert.ok(
      violationsA.some((v) => v.specifier.includes("references the global eval")),
      `expected the non-null-assertion form to be caught, got: ${JSON.stringify(violationsA)}`
    );
    const violationsB = checkNoTasksImport(dirB);
    assert.ok(
      violationsB.some((v) => v.specifier.includes("references the global eval")),
      `expected the as-cast form to be caught, got: ${JSON.stringify(violationsB)}`
    );
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("process.dlopen(...) / process.binding(...) are caught, naming a dangerous process property from the extended set, not only getBuiltinModule", () => {
  const dirA = buildScratchSrc({
    "tools/mutant.ts": "process.dlopen({ exports: {} }, './native.node');\n",
  });
  const dirB = buildScratchSrc({
    "tools/mutant.ts": "const b = process.binding('fs');\nvoid b;\n",
  });
  try {
    const violationsA = checkNoTasksImport(dirA);
    assert.ok(
      violationsA.some((v) => v.specifier.includes("process's dangerous properties")),
      `expected process.dlopen to be flagged, got: ${JSON.stringify(violationsA)}`
    );
    const violationsB = checkNoTasksImport(dirB);
    assert.ok(
      violationsB.some((v) => v.specifier.includes("process's dangerous properties")),
      `expected process.binding to be flagged, got: ${JSON.stringify(violationsB)}`
    );
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('ambient declare const Reflect: {...}; Reflect.get(globalThis, "eval") is caught - an Ambient-flagged declaration is not a runtime shadow', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      "declare const Reflect: { get: (t: unknown, k: string) => unknown };",
      "const e = Reflect.get(globalThis, 'eval');",
      "e('1');",
      "",
    ].join("\n"),
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("references the global Reflect")),
      `expected the ambient-declare Reflect diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// THE INTENTIONALLY OPEN TWO-HOP FRONTIER (3 executions). This guard is a
// hop-bounded HYGIENE contract, never a security boundary: the one-hop
// alias and computed-member acquisition cases above are CLOSED, and a
// second hop of the identical kind is a DISCLOSED, deliberately-unchased
// boundary - not a gap found later and left unspoken. Closing it would
// only move the frontier to three hops, which this guard's own scope does
// not chase, the same judgment call `check-stdio-purity.mjs`'s own
// `MAX_ALIAS_CHAIN_HOPS` doc comment already makes for a sibling guard's
// stdout/stderr-purity check.
//
// Each case is EVIDENCED, not merely asserted not-to-red: every fixture is
// confirmed BOTH guard-green at both production entry points
// (`checkNoTasksImport`/`checkModuleBoundaries`, LITERAL empty offender
// arrays - via `buildCompleteFrozenScratchSrc`, a scratch tree containing
// every file `FROZEN_MODULES` requires, so `checkModuleBoundaries`'s
// unrelated completeness check never has anything to report and there is
// no filtering to explain away) AND a real, successfully-EXECUTING use of
// the forbidden capability under Node - so this is a proven open route,
// never an artifact of a fixture that merely never ran. These cases are
// GREEN CONTROLS for the disclosed boundary - the mirror image of the
// green controls near the end of this file (which guard already-covered
// green paths against a false red) - do NOT add a deeper-hop variant
// here, and do NOT change guard logic to chase these: guard logic is
// UNCHANGED here - the correction is that this frontier is now
// DISCLOSED, not that it is closed.
// =============================================================================

test("TWO-HOP globalThis-base alias - const g = globalThis; const h = g; h.eval(x) - stays guard-green (both guards LITERALLY empty, no filtering) at both entry points AND genuinely executes - the disclosed one-hop hygiene boundary", async () => {
  const src = "const g = globalThis;\nconst h = g;\nexport const result = h.eval('40 + 2');\n";
  const dir = buildCompleteFrozenScratchSrc("tools/run.ts", src);
  try {
    assert.deepEqual(
      checkNoTasksImport(dir),
      [],
      "expected the two-hop globalThis-base alias to stay guard-green (checkNoTasksImport) - a real hit here means the disclosed boundary moved and the known-open list is stale"
    );
    assert.deepEqual(
      checkModuleBoundaries(dir),
      [],
      "expected the two-hop globalThis-base alias to stay LITERALLY guard-green, unfiltered (checkModuleBoundaries) - the scratch tree here is complete against FROZEN_MODULES, so a real hit is never masked by an unrelated frozen-module-completeness finding"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const execDir = mkdtempSync(path.join(tmpdir(), "ghantika-loader-escape-exec-"));
  const execFile = path.join(execDir, "probe.mjs");
  writeFileSync(execFile, src);
  try {
    const mod = await import(pathToFileURL(execFile).href);
    assert.equal(
      mod.result,
      42,
      "expected the two-hop globalThis.eval alias to genuinely evaluate '40 + 2' under Node - proving this is a working escape, not a fixture that merely never ran"
    );
  } finally {
    rmSync(execDir, { recursive: true, force: true });
  }
});

test("TWO-HOP process-base alias - const p = process; const q = p; q.getBuiltinModule(...).createRequire(...) - stays guard-green (both guards LITERALLY empty, no filtering) at both entry points AND genuinely loads a real builtin module", async () => {
  const src =
    "const p = process;\n" +
    "const q = p;\n" +
    'const req = q.getBuiltinModule("node:module").createRequire(import.meta.url);\n' +
    'export const fs = req("node:fs");\n';
  const dir = buildCompleteFrozenScratchSrc("tools/run.ts", src);
  try {
    assert.deepEqual(
      checkNoTasksImport(dir),
      [],
      "expected the two-hop process-base alias to stay guard-green (checkNoTasksImport) - a real hit here means the disclosed boundary moved and the known-open list is stale"
    );
    assert.deepEqual(
      checkModuleBoundaries(dir),
      [],
      "expected the two-hop process-base alias to stay LITERALLY guard-green, unfiltered (checkModuleBoundaries) - the scratch tree here is complete against FROZEN_MODULES, so a real hit is never masked by an unrelated frozen-module-completeness finding"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const execDir = mkdtempSync(path.join(tmpdir(), "ghantika-loader-escape-exec-"));
  const execFile = path.join(execDir, "probe.mjs");
  writeFileSync(execFile, src);
  try {
    const mod = await import(pathToFileURL(execFile).href);
    assert.equal(
      typeof mod.fs.readFileSync,
      "function",
      "expected the two-hop process.getBuiltinModule alias to genuinely load node:fs via createRequire under Node - proving this is a working escape, not a fixture that merely never ran"
    );
  } finally {
    rmSync(execDir, { recursive: true, force: true });
  }
});

test('TWO-HOP variable-keyed computed .constructor - const k1 = "constructor"; const k2 = k1; (()=>{})[k2] - stays guard-green (both guards LITERALLY empty, no filtering) at both entry points AND genuinely constructs and runs a real function', async () => {
  const src =
    'const k1 = "constructor";\n' +
    "const k2 = k1;\n" +
    "const F = (() => {})[k2];\n" +
    'export const result = new F("return 40 + 2")();\n';
  const dir = buildCompleteFrozenScratchSrc("tools/run.ts", src);
  try {
    assert.deepEqual(
      checkNoTasksImport(dir),
      [],
      "expected the two-hop variable-keyed .constructor access to stay guard-green (checkNoTasksImport) - a real hit here means the disclosed boundary moved and the known-open list is stale"
    );
    assert.deepEqual(
      checkModuleBoundaries(dir),
      [],
      "expected the two-hop variable-keyed .constructor access to stay LITERALLY guard-green, unfiltered (checkModuleBoundaries) - the scratch tree here is complete against FROZEN_MODULES, so a real hit is never masked by an unrelated frozen-module-completeness finding"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const execDir = mkdtempSync(path.join(tmpdir(), "ghantika-loader-escape-exec-"));
  const execFile = path.join(execDir, "probe.mjs");
  writeFileSync(execFile, src);
  try {
    const mod = await import(pathToFileURL(execFile).href);
    assert.equal(
      mod.result,
      42,
      "expected the two-hop variable-keyed .constructor access to genuinely construct and run a real function under Node - proving this is a working escape, not a fixture that merely never ran"
    );
  } finally {
    rmSync(execDir, { recursive: true, force: true });
  }
});

// =============================================================================
// THE SPECIFIER, once a capability exists (12 executions). Each fixture
// uses a PERMITTED loader form (an ordinary static import, or - for a
// shape a static import cannot syntactically carry - a permitted dynamic
// import()) so the module-boundary specifier diagnostic is the ONLY thing
// that can produce the red, never an acquisition diagnostic from a banned
// loader (a self-masking failure mode this file's own history has hit and
// corrected before).
// =============================================================================

test("an ordinary string literal relative specifier naming a sibling is caught, naming the resolved sibling path", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": 'import { x } from "./sibling.js";\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "./sibling.js"')
      ),
      `expected the ordinary-literal sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a no-substitution TEMPLATE LITERAL specifier, via a permitted dynamic import(), is read as a literal and caught the same as a plain string", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": "import(`./sibling.js`);\n",
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "./sibling.js"')
      ),
      `expected the template-literal sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an INTERPOLATED template specifier, via a permitted dynamic import(), fails CLOSED - a SKIP is a FAIL", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": 'const seg = "sibling";\nimport(`./${seg}.js`);\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes("computed/non-literal specifier")
      ),
      `expected the interpolated-template specifier to fail closed, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a string-CONCATENATION specifier, via a permitted dynamic import(), fails CLOSED", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": 'import("./" + "sibling.js");\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes("computed/non-literal specifier")
      ),
      `expected the concatenated specifier to fail closed, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a COMPUTED / VARIABLE specifier, via a permitted dynamic import(), fails CLOSED", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": "const specifier = getSiblingPath();\nimport(specifier);\n",
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes("computed/non-literal specifier")
      ),
      `expected the computed specifier to fail closed, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a relative specifier crossing up-and-back (../tools/sibling.js) resolves via the real resolver, canonical compare, sibling named", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": 'import { x } from "../tools/sibling.js";\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "../tools/sibling.js"')
      ),
      `expected the up-and-back relative sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an ABSOLUTE PATH specifier pointing at a real sibling file is caught - the fast path skips non-dot specifiers entirely, only the real resolver sees this; a prefix/suffix test passes this and must not", () => {
  const dir = buildScratchSrc({ "tools/sibling.ts": "export const marker = 1;\n" });
  try {
    const toolsDir = path.join(dir, "tools");
    const absSpecifier = path.join(toolsDir, "sibling.js");
    writeFileSync(path.join(toolsDir, "mutant.ts"), `import { x } from "${absSpecifier}";\n`);
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes(`imports sibling "${absSpecifier}"`)
      ),
      `expected the absolute-path sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an EXTENSIONLESS relative specifier resolving to a real sibling .ts file is caught, via real-resolver resolution", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": 'import { x } from "../tools/sibling";\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "../tools/sibling"')
      ),
      `expected the extensionless sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a DIRECTORY-INDEX specifier (trailing slash, resolving to the real index.ts) is caught; a distinct physical mutation from the extensionless case above", () => {
  const dir = buildScratchSrc({
    "tools/index.ts": "export const marker = 2;\n",
    "tools/mutant.ts": 'import { x } from "../tools/";\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "../tools/"')
      ),
      `expected the directory-index sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file:// URL specifier pointing at a real sibling file is caught - URL normalised through the real resolver before compare", () => {
  const dir = buildScratchSrc({ "tools/sibling.ts": "export const marker = 1;\n" });
  try {
    const toolsDir = path.join(dir, "tools");
    const fileUrl = pathToFileURL(path.join(toolsDir, "sibling.js")).href;
    writeFileSync(path.join(toolsDir, "mutant.ts"), `import { x } from "${fileUrl}";\n`);
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes(`imports sibling "${fileUrl}"`)
      ),
      `expected the file:// URL sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a SYMLINK resolving to the same real sibling file is caught via realpath compare - a string compare passes this and must not", () => {
  const dir = buildScratchSrc({ "tools/sibling.ts": "export const marker = 1;\n" });
  try {
    const toolsDir = path.join(dir, "tools");
    const libDir = path.join(dir, "lib");
    mkdirSync(libDir, { recursive: true });
    symlinkSync(path.join(toolsDir, "sibling.ts"), path.join(libDir, "sibling-alias.ts"));
    writeFileSync(
      path.join(toolsDir, "mutant.ts"),
      'import { x } from "../lib/sibling-alias.js";\n'
    );
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) =>
          v.includes("tools/mutant.ts") && v.includes('imports sibling "../lib/sibling-alias.js"')
      ),
      `expected the symlink-indirection sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a PACKAGE/SUBPATH-IMPORT ALIAS (package.json\'s own "imports" field) resolving to a real sibling file is caught via resolver-based compare; a distinct physical mutation from the symlink case above', () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "package.json": JSON.stringify({
      name: "fixture",
      imports: { "#sibling": "./tools/sibling.ts" },
    }),
    "tools/mutant.ts": 'import { x } from "#sibling";\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "#sibling"')
      ),
      `expected the package-alias sibling-import violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// STATIC-ANALYSIS EVASION (5 executions).
// =============================================================================

test('a side-effect-only static import - import "../tools/sibling.js" - is caught on the specifier alone, since a bare side-effect import has no binding to inspect', () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": 'import "../tools/sibling.js";\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "../tools/sibling.js"')
      ),
      `expected the side-effect-import sibling violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a re-export BARREL that pulls the sibling transitively is caught, naming both the barrel and the transitively-reached sibling", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "barrel.ts": 'export * from "./tools/sibling.js";\n',
    "tools/mutant.ts": 'export * from "../barrel.js";\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) =>
          v.includes("tools/mutant.ts") &&
          v.includes("../barrel.js") &&
          v.includes("transitively") &&
          v.includes("sibling.ts")
      ),
      `expected a transitive-barrel violation naming both the barrel and the sibling, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a specifier ASSEMBLED so it is not statically resolvable (an array .join call) fails CLOSED, never skipped", () => {
  const dir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/mutant.ts": 'const parts = ["./", "sibling.js"];\nimport(parts.join(""));\n',
  });
  try {
    const violations = checkModuleBoundaries(dir);
    assert.ok(
      violations.some(
        (v) => v.includes("tools/mutant.ts") && v.includes("computed/non-literal specifier")
      ),
      `expected the assembled specifier to fail closed, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eval(\"require('./sibling.js')\") is caught as a banned construct naming eval - a prohibition of the construct, never a claim that its string argument was analysed", () => {
  const dir = buildScratchSrc({ "tools/mutant.ts": "eval(\"require('./sibling.js')\");\n" });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("references the global eval")),
      `expected the banned-construct diagnostic naming the global eval reference, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('new Function("return require")() is caught as a banned construct naming Function - the same prohibition-not-analysis boundary as the eval(...) case above', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": 'const makeFn = new Function("return require");\nmakeFn();\n',
  });
  try {
    const violations = checkNoTasksImport(dir);
    assert.ok(
      violations.some((v) => v.specifier.includes("references the global Function constructor")),
      `expected the Function-constructor banned-construct diagnostic, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// THE GUARD GUARDS ITSELF (4 executions: one stays NOT EXECUTABLE - its
// dependency, a standalone external integrity guard, does not exist in
// code yet; the other three are each executed via a mutated SCRATCH COPY
// of the guard source - the TRACKED files under scripts/ are never
// written to.
// =============================================================================

test("delete the assertion that owns any acquisition case above - NOT EXECUTABLE at this head, since its own dependency does not exist in code", () => {
  // The ruled disposition for this case: reported NOT EXECUTABLE, neither
  // a pass nor a failure - nothing tested it - kept in its own column
  // rather than folded into either. It must not block the guard work
  // overall, because this case's own text has said since it was first
  // written that the guard it depends on does not exist; a dependency
  // disclosed at authoring time is not a defect discovered at execution
  // time. The reason: it would require a standalone external integrity
  // guard, which does not exist in code. (The canonical-resolution
  // guard-self case below was originally dispositioned alongside this one
  // at a stale head, and is executed separately below - its own
  // precondition has since changed; see that test's comment.)
  //
  // No mutation is invented here to force an artificial result on a guard
  // that does not exist, because doing so would fabricate evidence about
  // absent code, exactly what the ruled disposition warns against. The
  // one concrete, checkable fact assertable without inventing anything is
  // that the REAL, current frozen module list still names no such guard
  // module.
  assert.ok(
    !FROZEN_MODULES.some((m) => /integrity/i.test(m)),
    "the external integrity guard this case depends on still does not appear in the frozen module list at this head - its NOT-EXECUTABLE precondition still holds"
  );
});

test("replace canonical resolution (remove the real resolver, reverting to layer-1-only string/path arithmetic) - the specifier-resolution cases' owning assertions go RED under the mutant, proving those assertions are non-vacuous now that the resolver they depend on exists", async () => {
  // This case was originally dispositioned NOT EXECUTABLE at an earlier
  // head, because the code did not yet have a canonical resolver to
  // degrade - there was nothing to mutate, so the mutation described was
  // not applicable. It becomes executable once the absolute-path/file-URL/
  // package-alias specifier cases above are implemented via a real
  // resolver, and must be run in the same pass that closes them.
  //
  // At THIS head, that precondition has changed: the absolute-path,
  // file-URL, and package-alias specifier cases above all pass via a real
  // resolver (resolveModuleSpecifierRealPath in scripts/lib/ts-ast.mjs)
  // plus a canonical isRealPathInsideDir containment compare
  // (path.relative-based, in scripts/check-module-boundaries.mjs) - not
  // the string/path arithmetic the original disposition describes as
  // absent. This case is executed in this same pass accordingly.
  //
  // The mutation: EMPIRICALLY, swapping only isRealPathInsideDir's
  // path.relative-based compare for a naive startsWith prefix test on the
  // ALREADY-RESOLVED real path does NOT distinguish the two implementations
  // for these fixtures (a genuinely-resolved absolute real path is a valid
  // string prefix of its real containing directory too, absent an
  // adversarial "shares-a-string-prefix-but-isn't-really-inside" sibling
  // like tools-backup/ - which these fixtures don't construct, since that
  // tests OVER-blocking prevention, a different property than this case
  // asks about). Tried first, found not to distinguish, not reported
  // silently.
  //
  // The mutation this case actually names - "replace CANONICAL
  // RESOLUTION" - is the whole real-resolver step, not merely its
  // downstream compare: resolveModuleSpecifierRealPath (scripts/lib/
  // ts-ast.mjs) forced to return undefined, reverting to exactly the
  // "string/path arithmetic" (layer-1 dot-specifier fast path) state that
  // existed before this resolver was built. This is the mutation
  // independently confirmed, outside this file, to produce the expected
  // cascade across the absolute-path/directory-index/file-URL/symlink/
  // package-alias/transitive-barrel cases above.
  const { mod, scratchDir } = await loadMutatedGuardCopy("check-module-boundaries.mjs", (text) =>
    mutateExactlyOnce(
      text,
      '  resolveModuleSpecifierRealPath,\n  ts,\n} from "./lib/ts-ast.mjs";',
      '  ts,\n} from "./lib/ts-ast.mjs";\n' +
        "/* GUARD-SELF MUTANT: canonical resolution replaced - the real resolver is gone, reverting to the pre-existing string/path arithmetic (layer 1) alone */\n" +
        "function resolveModuleSpecifierRealPath() {\n  return undefined;\n}"
    )
  );
  const spec7Dir = buildScratchSrc({ "tools/sibling.ts": "export const marker = 1;\n" });
  const spec10aDir = buildScratchSrc({ "tools/sibling.ts": "export const marker = 1;\n" });
  const spec10bDir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "package.json": JSON.stringify({
      name: "fixture",
      imports: { "#sibling": "./tools/sibling.ts" },
    }),
  });
  try {
    const mutatedCheckModuleBoundaries = mod.checkModuleBoundaries as (dir?: string) => string[];

    const spec7Tools = path.join(spec7Dir, "tools");
    const spec7AbsSpecifier = path.join(spec7Tools, "sibling.js");
    writeFileSync(
      path.join(spec7Tools, "mutant.ts"),
      `import { x } from "${spec7AbsSpecifier}";\n`
    );
    const spec7Mutated = mutatedCheckModuleBoundaries(spec7Dir);
    assert.equal(
      spec7Mutated.filter((v) => v.includes("tools/mutant.ts") && v.includes("imports sibling"))
        .length,
      0,
      `expected the absolute-path case's assertion to go RED (zero violations) under the resolver-removal mutant, got: ${JSON.stringify(spec7Mutated)}`
    );

    const spec10aTools = path.join(spec10aDir, "tools");
    const spec10aLib = path.join(spec10aDir, "lib");
    mkdirSync(spec10aLib, { recursive: true });
    symlinkSync(path.join(spec10aTools, "sibling.ts"), path.join(spec10aLib, "sibling-alias.ts"));
    writeFileSync(
      path.join(spec10aTools, "mutant.ts"),
      'import { x } from "../lib/sibling-alias.js";\n'
    );
    const spec10aMutated = mutatedCheckModuleBoundaries(spec10aDir);
    assert.equal(
      spec10aMutated.filter((v) => v.includes("tools/mutant.ts") && v.includes("imports sibling"))
        .length,
      0,
      `expected the symlink case's assertion to go RED (zero violations) under the resolver-removal mutant, got: ${JSON.stringify(spec10aMutated)}`
    );

    writeFileSync(path.join(spec10bDir, "tools", "mutant.ts"), 'import { x } from "#sibling";\n');
    const spec10bMutated = mutatedCheckModuleBoundaries(spec10bDir);
    assert.equal(
      spec10bMutated.filter((v) => v.includes("tools/mutant.ts") && v.includes("imports sibling"))
        .length,
      0,
      `expected the package-alias case's assertion to go RED (zero violations) under the resolver-removal mutant, got: ${JSON.stringify(spec10bMutated)}`
    );

    // Contrast: the REAL, unmutated guard (imported at the top of this
    // file) DOES catch all three on the identical fixtures - proving the
    // mutation genuinely matters and the fixtures are valid.
    const spec7Real = checkModuleBoundaries(spec7Dir);
    assert.ok(
      spec7Real.some(
        (v) => v.includes("tools/mutant.ts") && v.includes(`imports sibling "${spec7AbsSpecifier}"`)
      ),
      `expected the REAL guard to still catch the absolute-path fixture, got: ${JSON.stringify(spec7Real)}`
    );
    const spec10aReal = checkModuleBoundaries(spec10aDir);
    assert.ok(
      spec10aReal.some(
        (v) =>
          v.includes("tools/mutant.ts") && v.includes('imports sibling "../lib/sibling-alias.js"')
      ),
      `expected the REAL guard to still catch the symlink fixture, got: ${JSON.stringify(spec10aReal)}`
    );
    const spec10bReal = checkModuleBoundaries(spec10bDir);
    assert.ok(
      spec10bReal.some(
        (v) => v.includes("tools/mutant.ts") && v.includes('imports sibling "#sibling"')
      ),
      `expected the REAL guard to still catch the package-alias fixture, got: ${JSON.stringify(spec10bReal)}`
    );
  } finally {
    rmSync(spec7Dir, { recursive: true, force: true });
    rmSync(spec10aDir, { recursive: true, force: true });
    rmSync(spec10bDir, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("make the fail-closed branch fail OPEN (in a scratch COPY of check-module-boundaries.mjs, never the tracked file) - the non-literal-specifier cases' owning assertions go RED under the mutant, proving those assertions are non-vacuous", async () => {
  const { mod, scratchDir } = await loadMutatedGuardCopy("check-module-boundaries.mjs", (text) =>
    mutateExactlyOnce(
      text,
      "      if (isDynamicImportCall(node) || isRequireCall(node)) {\n" +
        "        hits.push(UNRESOLVABLE_SIBLING_SPECIFIER_LABEL);\n" +
        "      }\n",
      "      if (isDynamicImportCall(node) || isRequireCall(node)) {\n" +
        "        /* GUARD-SELF MUTANT: fail-closed push removed - now fails OPEN */\n" +
        "      }\n"
    )
  );
  const fixtureDir = buildScratchSrc({
    "tools/sibling.ts": "export const marker = 1;\n",
    "tools/spec3.ts": 'const seg = "sibling";\nimport(`./${seg}.js`);\n',
    "tools/spec4.ts": 'import("./" + "sibling.js");\n',
    "tools/spec5.ts": "const specifier = getSiblingPath();\nimport(specifier);\n",
    "tools/eva3.ts": 'const parts = ["./", "sibling.js"];\nimport(parts.join(""));\n',
  });
  try {
    const mutatedCheckModuleBoundaries = mod.checkModuleBoundaries as (dir?: string) => string[];
    const mutatedViolations = mutatedCheckModuleBoundaries(fixtureDir);
    assert.equal(
      mutatedViolations.filter((v) => v.includes("computed/non-literal specifier")).length,
      0,
      `expected the MUTATED (fail-open) guard to report ZERO computed/non-literal violations - proving the non-literal-specifier cases' owning assertion would go RED under this mutant, got: ${JSON.stringify(mutatedViolations)}`
    );

    // Contrast: the REAL, unmutated guard (imported at the top of this
    // file) DOES catch all four on the identical fixture tree - proving
    // the mutation genuinely matters and the fixture is valid, not merely
    // that the mutated import failed silently.
    const realViolations = checkModuleBoundaries(fixtureDir);
    for (const file of ["spec3.ts", "spec4.ts", "spec5.ts", "eva3.ts"]) {
      assert.ok(
        realViolations.some(
          (v) => v.includes(`tools/${file}`) && v.includes("computed/non-literal specifier")
        ),
        `expected the REAL guard to catch tools/${file} on the identical fixture, got: ${JSON.stringify(realViolations)}`
      );
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("narrow the guard's file glob so src/tools/ is no longer scanned (in a scratch COPY of check-no-tasks-import.mjs, never the tracked file) - every acquisition case above loses its red simultaneously; the named-import liveness control goes RED under the mutant", async () => {
  const { mod, scratchDir } = await loadMutatedGuardCopy("check-no-tasks-import.mjs", (text) =>
    mutateExactlyOnce(
      text,
      "    if (dirent.isDirectory()) {\n      out.push(...listTsFilesUnder(full));\n",
      '    if (dirent.isDirectory()) {\n      if (dirent.name === "tools") continue; /* GUARD-SELF MUTANT: narrows the glob so src/tools/ is never scanned */\n      out.push(...listTsFilesUnder(full));\n'
    )
  );
  const fixtureDir = buildScratchSrc({
    "tools/obt1.ts": 'import { createRequire } from "node:module";\n',
  });
  try {
    const mutatedCheckNoTasksImport = mod.checkNoTasksImport as (
      dir?: string
    ) => { file: string; specifier: string }[];
    const mutatedViolations = mutatedCheckNoTasksImport(fixtureDir);
    assert.equal(
      mutatedViolations.length,
      0,
      `expected the MUTATED (tools/-excluded) guard to report ZERO violations for the named-import fixture - proving that case's owning assertion would go RED under this glob-narrowing mutant, got: ${JSON.stringify(mutatedViolations)}`
    );

    // Contrast: the REAL, unmutated guard DOES catch it on the identical
    // fixture tree.
    const realViolations = checkNoTasksImport(fixtureDir);
    assert.ok(
      realViolations.some((v) => v.specifier.includes("imports createRequire from node:module")),
      `expected the REAL guard to catch the named-import fixture on the identical tree, got: ${JSON.stringify(realViolations)}`
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

// =============================================================================
// GREEN CONTROLS (5 executions). A guard that reds on everything is as
// useless as one that reds on nothing.
// =============================================================================

test("a permitted import of a non-sibling module is never flagged as a sibling-import violation - both guards exit clean with an empty offender list, not merely a zero exit", () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": 'import { readFile } from "node:fs/promises";\n',
  });
  try {
    const moduleBoundaryViolations = checkModuleBoundaries(dir).filter((v) =>
      v.includes("imports sibling")
    );
    assert.deepEqual(
      moduleBoundaryViolations,
      [],
      `expected zero sibling-import violations, got: ${JSON.stringify(moduleBoundaryViolations)}`
    );
    const tasksViolations = checkNoTasksImport(dir);
    assert.deepEqual(
      tasksViolations,
      [],
      `expected an empty offender list, got: ${JSON.stringify(tasksViolations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the string "createRequire" inside a comment or a string literal is never flagged - it is not a call', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": [
      "// this comment mentions createRequire but never calls it",
      'const label = "createRequire";',
      "",
    ].join("\n"),
  });
  try {
    const tasksViolations = checkNoTasksImport(dir);
    assert.deepEqual(
      tasksViolations,
      [],
      `expected an empty offender list, got: ${JSON.stringify(tasksViolations)}`
    );
    const moduleBoundaryViolations = checkModuleBoundaries(dir).filter((v) =>
      v.includes("imports sibling")
    );
    assert.deepEqual(moduleBoundaryViolations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exactly one fixture - import { readFile } from "node:fs/promises" - is never flagged against the real allow-list; pinned to ONE named import so no open-ended set is silently satisfied', () => {
  const dir = buildScratchSrc({
    "tools/mutant.ts": 'import { readFile } from "node:fs/promises";\n',
  });
  try {
    const tasksViolations = checkNoTasksImport(dir);
    assert.deepEqual(
      tasksViolations,
      [],
      `expected an empty offender list, got: ${JSON.stringify(tasksViolations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the existing permanent guard-test suite is unchanged - same denominator - after every scratch mutation case in this file has run and been restored", () => {
  assert.ok(baseline, "the before() hook must have captured the pre-mutation baseline first");
  const after = runPermanentGuardSuite();
  assert.equal(
    after.fail,
    0,
    `expected zero failures in the permanent suite after all scratch mutations, got:\n${after.raw}`
  );
  assert.equal(
    after.pass,
    baseline!.pass,
    `expected the SAME pass count as the pre-mutation baseline (${baseline!.pass}) - a mismatch would mean a scratch mutation leaked into or altered production source; got ${after.pass}`
  );
});

test("the three permanent guard test files pass at a literal, self-consistent baseline observed at THIS head (never a stale hardcoded figure) - both production guard commands also exit 0", () => {
  assert.ok(baseline, "the before() hook must have captured the baseline first");
  assert.equal(
    baseline!.fail,
    0,
    `expected zero failures in the real baseline run, got:\n${baseline!.raw}`
  );
  assert.equal(
    baseline!.tests,
    baseline!.pass,
    "self-consistency: with fail=0 (and no skipped/cancelled tests), the tests count must equal the pass count"
  );
  const mb = spawnSync(process.execPath, ["scripts/check-module-boundaries.mjs"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const nt = spawnSync(process.execPath, ["scripts/check-no-tasks-import.mjs"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(
    mb.status,
    0,
    `expected "npm run guard:module-boundaries" to exit 0, got ${mb.status}, stderr=${mb.stderr}`
  );
  assert.equal(
    nt.status,
    0,
    `expected "npm run guard:no-tasks-import" to exit 0, got ${nt.status}, stderr=${nt.stderr}`
  );
});

// =============================================================================
// FINAL RESTORATION CHECK - not one of the 45 physical executions above,
// an additional closing proof: the REAL src/ tree
// (no argument -> the guards' own default SRC_DIR) is still completely
// clean on all three guards after every scratch mutation case in this file
// has run and been torn down.
// =============================================================================

test("final restoration check: the REAL (non-scratch) src/ tree is still completely clean on all three guards - no scratch mutation from any case above ever leaked into, or was satisfied by, production source", () => {
  assert.deepEqual(
    checkModuleBoundaries(),
    [],
    "the real src/ tree must report zero module-boundary violations"
  );
  assert.deepEqual(
    checkNoTasksImport(),
    [],
    "the real src/ tree must report zero Tasks-import violations"
  );
  assert.deepEqual(
    checkStdioPurity(),
    [],
    "the real src/ tree must report zero stdio-purity violations"
  );
  // The two TRACKED guard files the guard-self cases above read (but only
  // ever copied, never wrote to) must also still be byte-identical to
  // what a fresh read returns now - a final proof that this file never
  // wrote to them.
  assert.ok(existsSync(path.join(REPO_ROOT, "scripts", "check-module-boundaries.mjs")));
  assert.ok(existsSync(path.join(REPO_ROOT, "scripts", "check-no-tasks-import.mjs")));
});
