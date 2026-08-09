#!/usr/bin/env node
/**
 * Enforces a property found the hard way on a loaded CI runner: no loop in
 * this repo may assert a fixed wall-clock deadline on `kill_confirmed`
 * actually settling. `src/tools/kill.ts`'s own doc comment on that field is
 * explicit that the gap between a process group emptying and the
 * confirmation write landing is real event-loop scheduling latency,
 * "deliberately never stated as a wall-clock bound" - so a test asserting
 * any fixed number of milliseconds is asserting a bound the production
 * contract declines to give, and it can lose under enough scheduling
 * pressure regardless of how generous the number is.
 *
 * This is deliberately NOT a grep for a specific number (e.g. "5000") - a
 * pattern like that catches the one number this repo happened to pick and
 * misses the next author who writes "3000" or "10000", and it would red on
 * every honest, unrelated timeout that has nothing to do with this field.
 * The check below is structural instead: it parses the real TypeScript AST
 * and flags a loop only when BOTH of these are true inside the SAME loop
 * body, wherever they are spelled:
 *
 *   1. the loop body references the literal `kill_confirmed` - as a
 *      property/element access (`x.kill_confirmed`, `x["kill_confirmed"]`)
 *      or as a bare string literal (a JSON key, an object property key) -
 *      the two forms every real call site in this repo actually uses;
 *   2. the loop body contains an `if` statement whose CONDITION calls
 *      `Date.now()` and whose THEN-branch contains a `throw` - the general
 *      shape of "read the clock, and fail if too much of it has passed."
 *
 * Neither condition alone is a violation: a loop that reads `kill_confirmed`
 * with no deadline at all is exactly the fixed shape (poll unbounded, log a
 * breadcrumb, never throw on elapsed time); a loop that has an honest
 * Date.now()-gated timeout with no reference to this field anywhere (the
 * `waitForPgrepGroupMembers` / `pollUntilCountsSettled`-style waits
 * elsewhere in this suite) is an ordinary bound on an ordinary quantity and
 * is left alone. Both must coexist in the same loop for this to fire.
 *
 * WHAT THIS DOES NOT CATCH, stated plainly rather than left to be
 * discovered: this is a targeted detector for the ONE literal pattern that
 * actually caused this bug across every site it was found in - a bare
 * `Date.now()` call inside an `if` whose then-branch contains a `throw` -
 * never a general property that a fixed deadline on `kill_confirmed` is
 * absent. It does not see an equivalent deadline built from a different
 * clock source (an aliased or renamed reference to `Date.now`,
 * `globalThis.Date.now()`, `performance.now()`), a bound enforced by
 * something other than `if`-plus-`throw` (an assertion call, a
 * loop-header condition, a flag set and checked later), or a `.js` file
 * (this scans `.ts` sources only). A guard for the broader semantic
 * property - any bounded wait on this field, however constructed - is
 * unbuilt; this one is worth having because it reliably catches the exact
 * recurrence of the form every real instance in this repo actually took.
 *
 * See test/no-bounded-kill-confirmed-wait.test.ts for the negative control:
 * a planted violation (this exact forbidden shape, constructed fresh) is
 * proven to red, and a lookalike clean loop (an honest, unrelated timeout)
 * is proven to stay green - so this check is not vacuous in either
 * direction.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";
import { forEachDescendant, parseSourceFile, ts } from "./lib/ts-ast.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["src", "test"];

const KILL_CONFIRMED_LITERAL = "kill_confirmed";

/**
 * Recursively lists every `.ts` file under `dir`, as absolute paths.
 * Returns an empty list when `dir` doesn't exist - the same convention
 * `scripts/check-no-tasks-import.mjs`'s own `listTsFilesUnder` uses.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listTsFilesUnder(dir) {
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

/** True when `node` is a reference to the literal `kill_confirmed`, as a property/element access or a bare string literal. */
function isKillConfirmedReference(node) {
  if (ts.isPropertyAccessExpression(node) && node.name.text === KILL_CONFIRMED_LITERAL) {
    return true;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === KILL_CONFIRMED_LITERAL
  ) {
    return true;
  }
  if (ts.isStringLiteralLike(node) && node.text === KILL_CONFIRMED_LITERAL) {
    return true;
  }
  return false;
}

/** True when `node` (an expression) contains a call to `Date.now()` anywhere within it. */
function containsDateNowCall(node) {
  let found = false;
  forEachDescendant(node, (inner) => {
    if (found) return;
    if (
      ts.isCallExpression(inner) &&
      ts.isPropertyAccessExpression(inner.expression) &&
      ts.isIdentifier(inner.expression.expression) &&
      inner.expression.expression.text === "Date" &&
      inner.expression.name.text === "now"
    ) {
      found = true;
    }
  });
  return found;
}

/** True when `node` (a statement, possibly a block) contains a `throw` anywhere within it. */
function containsThrow(node) {
  if (!node) return false;
  let found = false;
  forEachDescendant(node, (inner) => {
    if (found) return;
    if (ts.isThrowStatement(inner)) found = true;
  });
  return found;
}

/**
 * @param {import("typescript").Node} loopBody
 * @returns {{ referencesKillConfirmed: boolean, boundedThrowLine: number | null }}
 */
function inspectLoopBody(loopBody, sourceFile) {
  let referencesKillConfirmed = false;
  let boundedThrowLine = null;
  forEachDescendant(loopBody, (inner) => {
    if (isKillConfirmedReference(inner)) referencesKillConfirmed = true;
    if (
      boundedThrowLine === null &&
      ts.isIfStatement(inner) &&
      containsDateNowCall(inner.expression) &&
      containsThrow(inner.thenStatement)
    ) {
      boundedThrowLine =
        sourceFile.getLineAndCharacterOfPosition(inner.getStart(sourceFile)).line + 1;
    }
  });
  return { referencesKillConfirmed, boundedThrowLine };
}

/**
 * @param {string} sourceText
 * @param {string} fileName
 * @returns {{ line: number }[]} every violation found in this one file
 */
export function findBoundedKillConfirmedWaits(sourceText, fileName) {
  const sourceFile = parseSourceFile(fileName, sourceText);
  const violations = [];
  forEachDescendant(sourceFile, (node) => {
    const isLoop = ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);
    if (!isLoop) return;
    const body = node.statement;
    if (!body) return;
    const { referencesKillConfirmed, boundedThrowLine } = inspectLoopBody(body, sourceFile);
    if (referencesKillConfirmed && boundedThrowLine !== null) {
      violations.push({ line: boundedThrowLine });
    }
  });
  return violations;
}

/**
 * @param {string[]} [scanDirs] repo-root-relative directories to scan
 * @returns {{ file: string, line: number }[]} every violation found across
 *   the whole scan, empty when clean
 */
export function checkNoBoundedKillConfirmedWait(scanDirs = SCAN_DIRS) {
  const violations = [];
  for (const dirName of scanDirs) {
    const absDir = path.join(REPO_ROOT, dirName);
    for (const absFile of listTsFilesUnder(absDir)) {
      const relFile = path.relative(REPO_ROOT, absFile).split(path.sep).join("/");
      const text = readFileSync(absFile, "utf8");
      for (const { line } of findBoundedKillConfirmedWaits(text, absFile)) {
        violations.push({ file: relFile, line });
      }
    }
  }
  return violations;
}

function main() {
  const violations = checkNoBoundedKillConfirmedWait();
  if (violations.length > 0) {
    for (const { file, line } of violations) {
      console.error(
        `${file}:${line}: a loop reading kill_confirmed asserts a fixed wall-clock deadline - that field's own contract (src/tools/kill.ts) declines to bound its settling time, so no fixed number here is honest; poll unbounded and log a breadcrumb instead (see test/tasks.test.ts's pollUntilKillConfirmed for the pattern)`
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    "no .ts loop under src/ or test/ pairs a bare Date.now()-plus-throw deadline with a kill_confirmed read"
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
