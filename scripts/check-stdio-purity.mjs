#!/usr/bin/env node
/**
 * Guards the static half of stdio purity: MCP over stdio uses
 * the server's own stdout as the ENTIRE protocol channel, so nothing in
 * this codebase's own source may write to it directly - only the SDK's
 * own `StdioServerTransport` (which lives in node_modules, never scanned
 * here) may. Fails red if any file under `src/`:
 *
 *   - references `process.stdout` (dotted OR computed, e.g.
 *     `process["stdout"]`) - either about to write to it, or itself
 *     already a write;
 *   - calls any of the console methods that actually write to stdout
 *     (dotted OR computed access - see `STDOUT_WRITING_CONSOLE_METHODS`'s
 *     own doc comment for the full set and how it was verified);
 *   - declares a `const`/`let`/`var` whose initializer is (transitively,
 *     up to a bounded number of re-alias hops) the bare `process`
 *     identifier or `globalThis.process`, OR reassigns an already-declared
 *     name to the same thing (`let p; p = process;`, as opposed to a
 *     declaration's own initializer) - the ALIAS-CREATION event itself is
 *     the trigger, whichever syntax expresses it, since a later `.stdout`
 *     access on an unrecognized local name would otherwise escape the
 *     first check entirely.
 *
 * Runs on the real TypeScript AST (see scripts/lib/ts-ast.mjs's header for
 * the full "why AST, not regex" rationale): comments are trivia attached
 * to tokens, never AST nodes at all, so a doc comment mentioning
 * `process.stdout` in prose (like this file's own header, or
 * src/server.ts's) is never even visited by the checks below. A real AST
 * walk sees `process.stdout` and `process["stdout"]` as the same semantic
 * shape (a `PropertyAccessExpression`/`ElementAccessExpression` whose
 * object is the `process` identifier and whose member is the string
 * `"stdout"`), regardless of which JavaScript syntax expresses it - the
 * same computed-access equivalence applies to every stdout-writing
 * `console` method too.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";
import { forEachDescendant, parseSourceFile, stringLiteralText, ts } from "./lib/ts-ast.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = path.join(REPO_ROOT, "src");

/**
 * True for `process.stdout` or `process["stdout"]` (or any computed
 * variant whose key resolves to the literal string "stdout", e.g.
 * `` process[`stdout`] ``) - never for an unrelated identifier that merely
 * happens to also have a `.stdout`/`["stdout"]` member (e.g. some
 * `childProcess.stdout`), since the object being accessed must itself be
 * the bare `process` identifier.
 */
function isProcessStdoutAccess(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "stdout"
    );
  }
  if (ts.isElementAccessExpression(node)) {
    if (!ts.isIdentifier(node.expression) || node.expression.text !== "process") return false;
    return stringLiteralText(node.argumentExpression) === "stdout";
  }
  return false;
}

/**
 * Every `console` method that actually writes to stdout under some real
 * invocation, verified empirically against the installed Node runtime
 * (not merely assumed from a name list) by intercepting `process.stdout
 * .write`/`process.stderr.write` around a call to each candidate method:
 *
 *   - WRITES to stdout: `log`, `info`, `debug`, `dir`, `dirxml`, `table`,
 *     `group`/`groupCollapsed` (when given a label argument - Node's own
 *     Console class formats and prints it exactly like `log`), `count`
 *     (prints "label: N" even with zero arguments), `timeEnd`/`timeLog`
 *     (print the elapsed time).
 *   - NEVER write anything, to stdout OR stderr, under ANY arguments -
 *     confirmed by calling each with both zero and one argument: `time`
 *     (only starts an internal timer), `groupEnd` (only pops the
 *     indentation stack), `countReset` (only resets a counter). These are
 *     deliberately EXCLUDED - flagging a call that can never write
 *     anything would be a pure false positive with zero payoff.
 *   - Write to STDERR, not stdout, so they are NOT included even though
 *     they might look similar at a glance: `trace` (Node's docs say
 *     stderr; confirmed - a plausible miscategorization this set
 *     deliberately avoids), `warn`, `error`, `assert` (stderr only on a
 *     failed assertion).
 */
const STDOUT_WRITING_CONSOLE_METHODS = new Set([
  "log",
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
]);

/** Returns the matched method name for a `console.<method>(...)` or `console["<method>"](...)` call where `<method>` is one of `STDOUT_WRITING_CONSOLE_METHODS`, `undefined` otherwise. */
function consoleStdoutMethodCallName(node) {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "console")
      return undefined;
    return STDOUT_WRITING_CONSOLE_METHODS.has(callee.name.text) ? callee.name.text : undefined;
  }
  if (ts.isElementAccessExpression(callee)) {
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "console")
      return undefined;
    const methodName = stringLiteralText(callee.argumentExpression);
    return methodName !== undefined && STDOUT_WRITING_CONSOLE_METHODS.has(methodName)
      ? methodName
      : undefined;
  }
  return undefined;
}

/** True for the bare identifier `process` or the property-access expression `globalThis.process`. */
function isProcessOrGlobalThisProcessExpression(node) {
  if (ts.isIdentifier(node)) return node.text === "process";
  if (ts.isPropertyAccessExpression(node)) {
    return (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis" &&
      node.name.text === "process"
    );
  }
  return false;
}

/**
 * How many re-alias hops `isProcessAliasChain` will follow before giving
 * up - a BOUNDED constant-propagation pass, not a full one. `const a =
 * process; const b = a; const c = b; c.stdout.write(...)` is caught (3
 * hops: c -> b -> a -> process); a chain deliberately built deeper than
 * this bound would still escape. Documented residual limitation (judgment
 * call, not full data-flow analysis): a genuinely adversarial, arbitrarily
 * long re-alias chain can still get through - this check closes the
 * one-hop alias-creation case (`const x = process`/`globalThis.process`,
 * OR the bare-reassignment form `let x; x = process;`) plus shallow
 * multi-hop chains a real refactor might plausibly produce, whichever
 * syntax expresses each hop; a hostile, deep chain built specifically to
 * evade this guard is not something a purely syntactic, non-type-checking
 * AST pass can fully close without becoming a real data-flow analyzer.
 */
const MAX_ALIAS_CHAIN_HOPS = 4;

/**
 * True when `expression` is `process`/`globalThis.process` directly, OR
 * (up to `hopsRemaining` further hops) an identifier that was EVER
 * assigned - by its own declaration's initializer, or by a later bare
 * reassignment - a value which itself resolves back to
 * `process`/`globalThis.process` through `assignedValuesByName`. That map
 * is built as a flat, whole-file `name -> [every value ever assigned]`
 * table (see `collectVariableAssignedValuesByName`) rather than a real
 * scope-resolved binding table - a deliberate, documented simplification:
 * a purely syntactic AST pass has no type-checker-grade binder available,
 * so a pathological case with two DIFFERENT same-named locals in
 * different scopes could resolve to the wrong declaration. Given this
 * guard's job is catching realistic mutants, not defending against a
 * maximally adversarial attacker, erring toward FALSE POSITIVE (the flat
 * map can only ever cause this to be MORE aggressive, never less, since
 * failing to find a name in the map simply stops the chain, and checking
 * EVERY assigned value rather than only the most recent one can only add
 * matches, never remove one) is the safe direction for a security guard.
 */
function isProcessAliasChain(expression, assignedValuesByName, hopsRemaining) {
  if (isProcessOrGlobalThisProcessExpression(expression)) return true;
  if (hopsRemaining <= 0) return false;
  if (!ts.isIdentifier(expression)) return false;
  const upstreamValues = assignedValuesByName.get(expression.text);
  if (upstreamValues === undefined) return false;
  return upstreamValues.some((value) =>
    isProcessAliasChain(value, assignedValuesByName, hopsRemaining - 1)
  );
}

/**
 * A flat, whole-file map of every locally-bound NAME to EVERY expression
 * ever assigned to it - a `const`/`let`/`var`'s own declaration
 * initializer, AND any later bare reassignment (`name = <expr>;`) found
 * anywhere in the file. A name maps to an ARRAY, not a single value:
 * `let p; p = somethingHarmless; p = process;` assigns `p` twice, and
 * `isProcessAliasChain` only needs ONE of those values to resolve to
 * `process` for the alias to be real - collecting every assignment rather
 * than only the declaration's own initializer is what makes the bare-
 * reassignment form (no initializer of its own to inspect) resolvable at
 * all (see `isProcessAliasChain`'s doc comment for the deliberate scope-
 * resolution simplification this implies).
 */
function collectVariableAssignedValuesByName(sourceFile) {
  const map = new Map();
  const record = (name, value) => {
    const existing = map.get(name);
    if (existing === undefined) {
      map.set(name, [value]);
    } else {
      existing.push(value);
    }
  };
  forEachDescendant(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      record(node.name.text, node.initializer);
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      record(node.left.text, node.right);
    }
  });
  return map;
}

/**
 * @param {string} sourceText
 * @param {string} [fileName]
 * @returns {string[]} every forbidden construct found, empty when clean.
 *   Each hit is either the offending construct's own literal source text
 *   (e.g. `"process.stdout"`, `"console.log("`, `` `process["stdout"]` ``)
 *   or, for a process-alias declaration, a description naming the alias -
 *   comments are never part of any hit, since they were never part of the
 *   AST to begin with.
 */
export function findStdoutWrites(sourceText, fileName = "source.ts") {
  const hits = [];
  const sourceFile = parseSourceFile(fileName, sourceText);
  const assignedValuesByName = collectVariableAssignedValuesByName(sourceFile);

  forEachDescendant(sourceFile, (node) => {
    if (isProcessStdoutAccess(node)) {
      hits.push(node.getText(sourceFile));
      return;
    }
    const consoleMethodName = consoleStdoutMethodCallName(node);
    if (consoleMethodName !== undefined) {
      hits.push(`${node.expression.getText(sourceFile)}(`);
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      if (isProcessAliasChain(node.initializer, assignedValuesByName, MAX_ALIAS_CHAIN_HOPS)) {
        hits.push(
          `const/let/var "${node.name.text}" aliases process (directly or through re-aliasing) - stdout could be reached through it`
        );
      }
      return;
    }
    // --- a bare REASSIGNMENT (`p = process;`, as opposed to `p`'s own
    // declaration initializer) is exactly as real an alias-creation event
    // as a declaration with an initializer is - `let p;` carries no
    // initializer of its own to inspect, so the assignment statement
    // itself is the only place this alias becomes visible. ---
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      if (isProcessAliasChain(node.right, assignedValuesByName, MAX_ALIAS_CHAIN_HOPS)) {
        hits.push(
          `"${node.left.text}" is reassigned to alias process (directly or through re-aliasing) - stdout could be reached through it`
        );
      }
    }
  });

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
 * @returns {{ file: string, match: string }[]} every violation found
 *   across the whole `src/` tree, empty when clean
 */
export function checkStdioPurity(srcDir = SRC_DIR) {
  const violations = [];
  for (const absFile of listTsFilesUnder(srcDir)) {
    const text = readFileSync(absFile, "utf8");
    const relFile = path.relative(REPO_ROOT, absFile).split(path.sep).join("/");
    for (const match of findStdoutWrites(text, absFile)) {
      violations.push({ file: relFile, match });
    }
  }
  return violations;
}

function main() {
  const violations = checkStdioPurity();
  if (violations.length > 0) {
    for (const { file, match } of violations) {
      console.error(
        `${file}: forbidden "${match}" - only the SDK's own transport may write to process.stdout`
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log("stdio purity clean: no console.log or process.stdout reference anywhere under src/");
}

if (isMainModule(import.meta.url)) {
  main();
}
