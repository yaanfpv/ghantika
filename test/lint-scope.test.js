/**
 * test/lint-scope.test.js - proves `npm run lint` targets this project's
 * own source directories (`src`, `scripts`, `test`, `eslint.config.js`)
 * rather than the whole working tree, and that the four-target shape
 * actually covers every file ESLint's own live config considers eligible.
 *
 * Two traps this file guards against:
 *
 *   - Invoking `eslint <the intended targets>` directly proves nothing
 *     about package.json: that exact command already exits 0 today, even
 *     against the unscoped `"lint": "eslint ."`. So the real check below
 *     spawns `npm run lint` itself and separately locks the frozen script
 *     string by exact match - the string check is what actually catches a
 *     revert, since on a clean checkout both the old and the new command
 *     happen to exit 0 (not asserted as a standing test here - see the
 *     note further down, next to the `npm run lint` test).
 *   - A hand-maintained suffix list is both wrong and self-confirming: it
 *     only ever gets checked against whatever extensions already happen to
 *     be tracked. Every eligibility question below goes through ESLint's
 *     own `isPathIgnored`, never a `.endsWith(...)` guess, and the
 *     discriminator control (an out-of-scope `.jsx` file) exists
 *     specifically to catch a suffix-regex stand-in for that.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ESLint, Linter } from "eslint";
import { load as loadYaml } from "js-yaml";

import eslintConfig from "../eslint.config.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_URL = new URL("../package.json", import.meta.url);
const CHANGELOG_URL = new URL("../CHANGELOG.md", import.meta.url);
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const THIS_FILE_PATH = fileURLToPath(import.meta.url);

// -----------------------------------------------------------------------
// The frozen lint-command shape. Declared once, here, and used to build
// BOTH the expected exact script string AND the coverage check's list of
// positive targets below - never re-derived by tokenizing the script
// string at runtime, which would just be a second, ad-hoc shell-semantics
// authority standing in for the real one.
// -----------------------------------------------------------------------
const LINT_TARGET_DIRS = Object.freeze(["src", "scripts", "test"]);
const LINT_TARGET_FILE = "eslint.config.js";
const FROZEN_LINT_SCRIPT = `eslint ${[...LINT_TARGET_DIRS, LINT_TARGET_FILE].join(" ")}`;

function loadPackageJson() {
  return JSON.parse(readFileSync(PACKAGE_URL, "utf8"));
}

/**
 * True when `relPath` (forward-slash, repo-root-relative, exactly the
 * shape `git ls-files` produces) falls under one of the lint command's
 * positive directory targets, or is the exact `eslint.config.js` file.
 * @param {string} relPath
 */
function isCoveredByLintCommand(relPath) {
  if (relPath === LINT_TARGET_FILE) return true;
  return LINT_TARGET_DIRS.some((dir) => relPath === dir || relPath.startsWith(`${dir}/`));
}

/**
 * Splits raw `git ls-files -z` output on the NUL byte, never on a
 * newline. Git guarantees a NUL never appears inside a real tracked path,
 * so it is the only safe record separator; a real filename CAN contain a
 * literal newline, which a `.split("\n")` implementation would fabricate
 * into two paths out of one, silently corrupting the list.
 * @param {Buffer} rawOutput
 * @returns {string[]}
 */
function parseGitLsFilesZ(rawOutput) {
  const text = rawOutput.toString("utf8");
  // Every record - including the last - is NUL-terminated, so the final
  // split segment is always an empty string; drop it.
  return text.split("\0").filter((entry) => entry.length > 0);
}

/**
 * The tracked-file denominator for `repoRoot`, read via `git ls-files -z`
 * and parsed NUL-safe end to end.
 * @param {string} repoRoot
 * @returns {string[]}
 */
function listTrackedFiles(repoRoot) {
  const raw = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot });
  return parseGitLsFilesZ(raw);
}

/**
 * Asks ESLint's own live, effective config whether `relPath` (relative to
 * `eslintInstance`'s cwd) is actually in scope - never a hand-maintained
 * extension guess. Fail-closed: a path ESLint cannot resolve at all comes
 * back as `{ ok: false }` with the real error attached, rather than being
 * silently treated as either eligible or ineligible.
 * @param {ESLint} eslintInstance
 * @param {string} repoRoot
 * @param {string} relPath
 * @returns {Promise<{ ok: true, eligible: boolean } | { ok: false, error: string }>}
 */
async function resolveEligibility(eslintInstance, repoRoot, relPath) {
  const absPath = path.join(repoRoot, relPath);
  try {
    const ignored = await eslintInstance.isPathIgnored(absPath);
    return { ok: true, eligible: !ignored };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A safely escaped, single-line description of a coverage gap - used so a
 * path containing an unusual character (a literal newline, say) still
 * renders as one legible diagnostic line instead of visually splitting
 * across lines or otherwise garbling the message it appears in.
 * @param {string} relPath
 */
function formatCoverageGapMessage(relPath) {
  return `eligible file outside the lint command's scope: ${JSON.stringify(relPath)}`;
}

/**
 * The same single-line-safe rendering as `formatCoverageGapMessage`, for
 * an entry in `unresolved` instead of a plain path: names both the path
 * that could not be classified at all and the real error its resolution
 * threw, so a failure here always points at what broke and why rather
 * than just reporting "something didn't resolve."
 * @param {{ path: string, error: string }} entry
 */
function formatUnresolvedMessage(entry) {
  return `path whose ESLint eligibility could not be resolved: ${JSON.stringify(entry.path)} (${entry.error})`;
}

/**
 * Runs the full coverage check against `repoRoot`: every tracked file is
 * classified eligible/ineligible by ESLint's live config, and every
 * eligible file is checked against the lint command's positive targets.
 * The eligible count is always derived live from this run - nothing here
 * compares against a fixed/expected number.
 * @param {string} repoRoot
 * @param {ESLint} eslintInstance
 */
async function checkLintCoverage(repoRoot, eslintInstance) {
  const tracked = listTrackedFiles(repoRoot);
  const gaps = [];
  const unresolved = [];
  let eligibleCount = 0;

  for (const relPath of tracked) {
    const result = await resolveEligibility(eslintInstance, repoRoot, relPath);
    if (!result.ok) {
      unresolved.push({ path: relPath, error: result.error });
      continue;
    }
    if (!result.eligible) continue;
    eligibleCount += 1;
    if (!isCoveredByLintCommand(relPath)) {
      gaps.push(relPath);
    }
  }

  return { trackedCount: tracked.length, eligibleCount, gaps: gaps.sort(), unresolved };
}

/**
 * Builds a disposable, real git repository under the OS tmpdir with the
 * full discriminator set the tests below need: an eligible file under
 * each positive root (`src`, `scripts`, `test`, plus `eslint.config.js`
 * itself), three eligible-but-uncovered file types sitting outside every
 * positive root (`.mjs`, `.mts`, `.cts`), an out-of-scope `.jsx` (the
 * discriminator - ESLint does not consider it eligible at all, so it must
 * never show up as a gap), and a real tracked file whose OWN NAME
 * contains a literal newline character (also outside every positive root,
 * so it doubles as both a coverage gap and the NUL-vs-newline parsing
 * control).
 *
 * A real `git init` + `git add` + `git commit`, never touching this
 * project's own working checkout or index.
 * @returns {{ dir: string, cleanup: () => void }}
 */
function makeScratchFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-lint-scope-scratch-"));

  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "test"), { recursive: true });
  mkdirSync(path.join(dir, "lib"), { recursive: true }); // not a positive lint target

  // eslint.config.js itself - a positive target, and its actual content is
  // never evaluated (the real config below is injected via
  // overrideConfig), so a placeholder body is fine.
  writeFileSync(path.join(dir, "eslint.config.js"), "// placeholder - real config is overridden\n");

  // Eligible, correctly placed under a positive root - must read GREEN.
  writeFileSync(path.join(dir, "src", "inside.ts"), "export const inside = 1;\n");
  writeFileSync(path.join(dir, "scripts", "inside.mjs"), "export const inside = 1;\n");
  writeFileSync(path.join(dir, "test", "inside.js"), "export const inside = 1;\n");

  // Eligible, but sitting OUTSIDE every positive root - real coverage
  // gaps, must read RED, each named by its own path.
  writeFileSync(path.join(dir, "lib", "outside.mjs"), "export const outsideMjs = 1;\n");
  writeFileSync(path.join(dir, "lib", "outside.mts"), "export const outsideMts = 1;\n");
  writeFileSync(path.join(dir, "lib", "outside.cts"), "export const outsideCts = 1;\n");

  // The discriminator: also outside every positive root, but NOT eligible
  // at all under the real config - must stay GREEN, proving eligibility
  // follows ESLint's live config rather than a suffix match that would
  // treat this the same as the .mjs/.mts/.cts cases above.
  writeFileSync(path.join(dir, "lib", "outside.jsx"), "export const outsideJsx = 1;\n");

  // Eligible, outside scope, AND its own name contains a literal newline -
  // both a real coverage gap and the NUL-vs-newline parsing control.
  writeFileSync(path.join(dir, "lib", "weird\nname.mjs"), "export const weird = 1;\n");

  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "lint-scope-test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "ghantika-lint-scope-test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "--quiet", "-m", "initial fixture"], { cwd: dir });

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * An ESLint instance evaluating the REAL project's own `eslint.config.js`
 * (imported once above, at module load), directed at `cwd` instead of
 * discovered from disk - so a scratch fixture is judged by the exact same
 * live config production runs under, never a re-typed or approximate copy
 * of it.
 * @param {string} cwd
 */
function makeEslintForScratchFixture(cwd) {
  return new ESLint({ cwd, overrideConfigFile: true, overrideConfig: eslintConfig });
}

// =============================================================================
// The frozen script shape: package.json's lint script must remain exactly
// this project's four intended targets, with no bypass or stray path.
// =============================================================================

test("package.json's lint script names exactly the frozen four-target shape", () => {
  const pkg = loadPackageJson();
  assert.equal(
    pkg.scripts.lint,
    FROZEN_LINT_SCRIPT,
    "the lint script must be exactly `eslint src scripts test eslint.config.js` - no more, no less"
  );
});

test("the frozen shape admits no shell operator and no bypass/ignore flag", () => {
  const pkg = loadPackageJson();
  const value = pkg.scripts.lint;

  assert.doesNotMatch(
    value,
    /[;&|`$<>]/,
    "must contain no shell operator or substitution character"
  );
  assert.doesNotMatch(value, /\|\|/, "must contain no `||` bypass");
  assert.doesNotMatch(value, /\s-/, "must contain no CLI flag of any kind");
  assert.doesNotMatch(
    value,
    /\.gitignore/,
    "must not reference .gitignore or an ignored path by name"
  );

  // Positive shape check, independent of the exact-match test above: every
  // token after the leading `eslint` command is one of the four frozen
  // targets, and there are no others.
  const tokens = value.trim().split(/\s+/);
  assert.equal(tokens[0], "eslint");
  assert.deepEqual(tokens.slice(1).sort(), [...LINT_TARGET_DIRS, LINT_TARGET_FILE].sort());
});

// =============================================================================
// The guard runs the real `npm run lint` package script as an actual
// child process, rather than invoking `eslint` directly, and asserts it
// exits clean.
// =============================================================================

test("`npm run lint`, run as a real child process, exits clean", () => {
  const result = spawnSync("npm", ["run", "lint"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `npm run lint must exit 0; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
});

// What is deliberately NOT a standing test here: on a clean checkout,
// both the old bare `eslint .` and the new scoped command exit 0. An
// exit-code difference between the two only shows up once additional
// ignored or untracked files happen to be present in the working tree
// alongside the tracked project sources. That comparison depends on
// working-tree state this environment does not guarantee, so it is not
// encoded as a test here. The standing regression guard against a
// revert is the exact-string check above, which does not depend on
// tree state at all.

// =============================================================================
// The guard above only proves something asserted as `result.status`
// exits clean - it says nothing about whether `result` actually came
// from the canonical `spawnSync("npm", ["run", "lint"], ...)` call.
// A file-level search for that call's syntax existing somewhere in this
// file would also pass against a decoy sitting in dead code, or after
// the live call had quietly drifted onto some other command while a
// stale, canonical-looking one lingered nearby - ordinary refactoring
// could cause either with no adversary involved. What actually matters
// is which child process the exit-status assertion is fed by, so the
// check below parses this file's own source, finds the identifier
// compared against exit status `0`, resolves it back to its real
// declaration, and confirms structurally that the declared expression is
// the canonical call - never merely that matching text exists.
// =============================================================================

/**
 * True for a call of the shape `assert.equal(<identifier>.status, 0, ...)`
 * or `assert.strictEqual(<identifier>.status, 0, ...)` - the exact
 * assertion the "exits clean" test above makes. Any other shape (a
 * computed member, a non-identifier object, an expected value other than
 * the literal `0`) is left alone rather than guessed at.
 * @param {object} node a CallExpression AST node
 */
function isExitStatusZeroAssertion(node) {
  if (node.callee.type !== "MemberExpression" || node.callee.computed) return false;
  const { object, property } = node.callee;
  if (object.type !== "Identifier" || object.name !== "assert") return false;
  if (property.type !== "Identifier" || !["equal", "strictEqual"].includes(property.name)) {
    return false;
  }

  const [actual, expected] = node.arguments;
  if (!actual || actual.type !== "MemberExpression" || actual.computed) return false;
  if (actual.object.type !== "Identifier") return false;
  if (actual.property.type !== "Identifier" || actual.property.name !== "status") return false;
  return Boolean(expected) && expected.type === "Literal" && expected.value === 0;
}

/**
 * True when `node`'s arguments are exactly `("npm", ["run", "lint"], ...)`
 * - the command literal and the two argv literals in order - checked
 * structurally, never by rendering the call back to text and
 * pattern-matching that. Says nothing about the callee: a callee spelled
 * `spawnSync` satisfies this exactly as well as the real import does; see
 * `classifySpawnSyncCallee` for the check that actually tells them apart.
 * @param {object} node a CallExpression AST node
 */
function hasCanonicalNpmRunLintArguments(node) {
  const [command, argv] = node.arguments;
  if (!command || command.type !== "Literal" || command.value !== "npm") return false;
  if (!argv || argv.type !== "ArrayExpression" || argv.elements.length !== 2) return false;

  const [first, second] = argv.elements;
  return (
    first?.type === "Literal" &&
    first.value === "run" &&
    second?.type === "Literal" &&
    second.value === "lint"
  );
}

/**
 * True when `node` is a CallExpression whose callee is a plain identifier
 * and whose arguments are the canonical `("npm", ["run", "lint"], ...)`
 * shape. This is the structural half only - it proves nothing about what
 * the callee identifier actually resolves to, since a local declaration
 * named `spawnSync` satisfies it exactly as well as the real import does.
 * See `classifySpawnSyncCallee` for the binding check that tells them
 * apart.
 * @param {object | null} node an AST node, or null if nothing resolved
 */
function hasCanonicalNpmRunLintShape(node) {
  if (!node || node.type !== "CallExpression") return false;
  if (node.callee.type !== "Identifier") return false;
  return hasCanonicalNpmRunLintArguments(node);
}

/**
 * Classifies whether `node`'s callee identifier actually refers to the
 * real `spawnSync` export of `node:child_process`, using ESLint's own
 * real scope analysis (`context.sourceCode.getScope`, `reference.resolved`)
 * - never a callee-name text match. A callee spelled `spawnSync` proves
 * nothing on its own: a local declaration of that same name (a shadowing
 * function, a reassigned variable, an unrelated import) satisfies a text
 * match while never calling into `node:child_process` at all. Fails
 * closed - naming what was actually found - on every binding shape other
 * than a single, unambiguous import of `spawnSync` from
 * `"node:child_process"`: an unresolved (global) reference, a variable
 * with more than one declaration site, a locally-declared function or
 * variable, and an import of some other name or from some other module
 * are all rejected by name rather than risked against a text match.
 * @param {import("eslint").Rule.RuleContext} context
 * @param {object} node the CallExpression whose callee is being classified
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function classifySpawnSyncCallee(context, node) {
  const { callee } = node;
  if (callee.type !== "Identifier") {
    return {
      ok: false,
      reason: `the callee is a ${callee.type}, not a plain identifier, so it cannot be verified as the real \`spawnSync\` import`,
    };
  }

  const calleeName = callee.name;
  const scope = context.sourceCode.getScope(node);
  const reference = findReferenceForIdentifier(scope, callee);

  if (!reference || !reference.resolved) {
    return {
      ok: false,
      reason: `\`${calleeName}\` has no resolvable binding under ESLint's own scope analysis - it may be a global or otherwise unresolved reference, not the real \`spawnSync\` import from \`node:child_process\``,
    };
  }

  const variable = reference.resolved;
  if (variable.defs.length !== 1) {
    return {
      ok: false,
      reason: `\`${calleeName}\` has ${variable.defs.length} distinct binding sites, which makes its real origin ambiguous`,
    };
  }

  const [def] = variable.defs;
  if (def.type !== "ImportBinding" || def.node.type !== "ImportSpecifier") {
    return {
      ok: false,
      reason: `\`${calleeName}\` is bound as a ${def.type} binding, not an import of a named export, so it is not the real \`spawnSync\` from \`node:child_process\``,
    };
  }

  if (def.node.imported.name !== "spawnSync") {
    return {
      ok: false,
      reason: `\`${calleeName}\` is imported as \`${def.node.imported.name}\`, not \`spawnSync\``,
    };
  }

  const importSource = def.parent.source.value;
  if (importSource !== "node:child_process") {
    return {
      ok: false,
      reason: `\`${calleeName}\` is imported from \`${importSource}\`, not \`node:child_process\``,
    };
  }

  return { ok: true };
}

/**
 * Finds the `Reference` object for `identifierNode` starting from
 * `scope`, walking outward through `scope.upper` if it is not present in
 * the immediate scope. In practice a reference always lives in the same
 * scope as the read it represents, so this walk is a defensive fallback
 * rather than something expected to run more than once - it is never
 * used to look further outward once a reference itself IS found; that is
 * `reference.resolved`'s job, and it already performs the real,
 * closure-aware lookup all the way up the scope chain to whatever the
 * identifier actually binds to.
 * @param {import("eslint").Scope.Scope | null} scope
 * @param {object} identifierNode
 * @returns {import("eslint").Scope.Reference | null}
 */
function findReferenceForIdentifier(scope, identifierNode) {
  let current = scope;
  while (current) {
    const found = current.references.find((ref) => ref.identifier === identifierNode);
    if (found) return found;
    current = current.upper;
  }
  return null;
}

/**
 * Classifies what `identifierNode` (the object of the asserted
 * `<identifier>.status`) actually refers to, using ESLint's own real
 * scope analysis via `context.sourceCode.getScope` - never hand-rolled
 * tree-walking. Fails closed on anything that is not a single,
 * unambiguous plain `const`/`let`/`var` declarator with a plain
 * `Identifier` id and a call-expression initializer: an unresolved
 * (global) reference, a variable with more than one declaration site, a
 * function parameter, a destructuring pattern, a catch-clause binding,
 * an import binding, and a declarator with no initializer are all real,
 * distinct binding shapes that a hand-rolled walker can mis-resolve - a
 * walker that searches outward through enclosing block statements has no
 * notion of a function boundary as a scope boundary, so a same-named
 * function parameter shadowing an outer variable can be walked straight
 * past, matching the unrelated outer declaration instead. Real scope
 * data reports each of those shapes directly
 * (`reference.resolved.defs[0].type`), so there is no need to enumerate
 * them by hand, and no new binding shape ESLint's scope analyzer
 * understands can slip past this the way a parameter shadowing an outer
 * variable would slip past a hand-rolled walker.
 * @param {import("eslint").Rule.RuleContext} context
 * @param {object} assertionNode the `assert.equal(...)` CallExpression
 * @param {object} identifierNode the `<identifier>` in `<identifier>.status`
 * @returns {{ ok: true, initNode: object } | { ok: false, reason: string }}
 */
function classifyIdentifierBinding(context, assertionNode, identifierNode) {
  const identifierName = identifierNode.name;
  const scope = context.sourceCode.getScope(assertionNode);
  const reference = findReferenceForIdentifier(scope, identifierNode);

  if (!reference || !reference.resolved) {
    return {
      ok: false,
      reason: `\`${identifierName}\` has no resolvable binding under ESLint's own scope analysis - it may be a global or otherwise unresolved reference`,
    };
  }

  const variable = reference.resolved;
  if (variable.defs.length !== 1) {
    return {
      ok: false,
      reason: `\`${identifierName}\` has ${variable.defs.length} distinct binding sites, which makes the exercised binding ambiguous`,
    };
  }

  const [def] = variable.defs;
  if (def.type !== "Variable") {
    return {
      ok: false,
      reason: `\`${identifierName}\` is bound as a ${def.type} binding, not a plain \`const\`/\`let\`/\`var\` declaration, so its real binding cannot be verified as the canonical call`,
    };
  }
  if (def.node.id.type !== "Identifier") {
    return {
      ok: false,
      reason: `\`${identifierName}\` is bound by a destructuring pattern rather than a plain identifier, so its real binding cannot be verified as the canonical call`,
    };
  }
  if (!def.node.init) {
    return {
      ok: false,
      reason: `\`${identifierName}\`'s declaration has no initializer, so its real binding cannot be verified as the canonical call`,
    };
  }

  return { ok: true, initNode: def.node.init };
}

/**
 * Renders `node` back to a single-line, whitespace-collapsed snippet of
 * `source` - just enough to name what was actually found in a failure
 * message, rather than reproducing a multi-line call verbatim.
 * @param {string} source
 * @param {{ range: [number, number] }} node
 */
function formatBoundCallSnippet(source, node) {
  return source.slice(node.range[0], node.range[1]).replace(/\s+/g, " ").trim();
}

/**
 * Parses `source` (this file's own text) with ESLint's `Linter` - already
 * a project dependency, so no separate parser package is needed - and
 * locates the one call whose `.status` this file actually compares
 * against `0`. Resolves that call's asserted identifier using ESLint's
 * own real scope analysis (`classifyIdentifierBinding`, run live during
 * traversal via `context.sourceCode.getScope`) rather than hand-rolled
 * tree-walking, then confirms the resolved initializer is structurally
 * the canonical `spawnSync("npm", ["run", "lint"], ...)` shape AND that
 * its callee identifier itself resolves - via that same real scope
 * analysis, never a name/text match - to the actual `spawnSync` import
 * from `"node:child_process"` (`classifySpawnSyncCallee`). Fails closed -
 * naming what was actually found rather than guessing further - in every
 * one of these cases: zero or more than one status assertion exists in
 * the file; the asserted identifier is an unresolved (global) reference;
 * it has more than one distinct binding site; its one binding is not a
 * plain `const`/`let`/`var` declarator (a parameter, a destructuring
 * pattern, a catch-clause binding, an import binding, and so on all fail
 * here); its declarator has no initializer; its declarator's initializer
 * resolves but is some other call entirely, in which case the reason
 * names that call exactly; or its callee, though spelled `spawnSync` and
 * shaped exactly like the canonical call, resolves to something other
 * than the real import - a locally-declared function or variable, or an
 * import of another name or from another module - in which case the
 * reason names that binding instead.
 * @param {string} source
 * @returns {{ bound: true } | { bound: false, reason: string }}
 */
function resolveAssertedLintInvocation(source) {
  const linter = new Linter();
  const statusAssertions = [];
  let ruleContext = null;

  linter.verify(
    source,
    {
      languageOptions: { ecmaVersion: "latest", sourceType: "module" },
      plugins: {
        "lint-scope-self-check": {
          rules: {
            "collect-status-assertions": {
              meta: { schema: [] },
              create(context) {
                ruleContext = context;
                return {
                  CallExpression(node) {
                    if (!isExitStatusZeroAssertion(node)) return;
                    const identifierNode = node.arguments[0].object;
                    statusAssertions.push({
                      identifierName: identifierNode.name,
                      binding: classifyIdentifierBinding(context, node, identifierNode),
                    });
                  },
                };
              },
            },
          },
        },
      },
      rules: { "lint-scope-self-check/collect-status-assertions": "error" },
    },
    { filename: "lint-scope-self-check.js" }
  );

  if (statusAssertions.length === 0) {
    return {
      bound: false,
      reason:
        "no assertion of the shape `<identifier>.status` compared against the literal `0` was found in this file - the exit-status check this guard relies on appears to have been removed or rewritten",
    };
  }
  if (statusAssertions.length > 1) {
    return {
      bound: false,
      reason: `found ${statusAssertions.length} assertions of an identifier's \`.status\` against \`0\`, which makes the exercised binding ambiguous - expected exactly one`,
    };
  }

  const [{ identifierName, binding }] = statusAssertions;
  if (!binding.ok) {
    return { bound: false, reason: binding.reason };
  }
  if (!hasCanonicalNpmRunLintShape(binding.initNode)) {
    return {
      bound: false,
      reason: `the child process bound to \`${identifierName}\` (the one whose \`.status\` this file actually asserts) is \`${formatBoundCallSnippet(source, binding.initNode)}\`, not the canonical \`spawnSync("npm", ["run", "lint"], ...)\` invocation`,
    };
  }

  const calleeBinding = classifySpawnSyncCallee(ruleContext, binding.initNode);
  if (!calleeBinding.ok) {
    return {
      bound: false,
      reason: `the child process bound to \`${identifierName}\` (the one whose \`.status\` this file actually asserts) calls \`${formatBoundCallSnippet(source, binding.initNode)}\`, but ${calleeBinding.reason}`,
    };
  }

  return { bound: true };
}

test('the exit-status assertion above is bound to a real, canonical `spawnSync("npm", ["run", "lint"])` call - not merely to matching text elsewhere in the file', () => {
  const source = readFileSync(THIS_FILE_PATH, "utf8");
  const result = resolveAssertedLintInvocation(source);
  assert.ok(result.bound, result.reason);
});

// =============================================================================
// A same-named function PARAMETER shadowing an outer variable must never
// be resolved to that outer, unrelated declaration - a textual/lexical
// walk that searches outward through enclosing blocks has no notion of a
// function boundary as a scope boundary, so it could conflate the two.
// Real scope analysis reports the parameter binding directly, so this
// must fail closed instead of guessing.
// =============================================================================

test("resolveAssertedLintInvocation fails closed when the asserted identifier is a function parameter that shadows an outer variable of the same name", () => {
  const source = `
const result = spawnSync("npm", ["run", "lint"], { encoding: "utf8" });

function assertLintExitsClean(result) {
  assert.equal(result.status, 0, "lint should exit clean");
}

assertLintExitsClean(
  spawnSync("eslint", ["src", "scripts", "test", "eslint.config.js"], { encoding: "utf8" })
);
`;

  const outcome = resolveAssertedLintInvocation(source);
  assert.equal(
    outcome.bound,
    false,
    "a parameter that shadows an outer variable of the same name must never be reported as bound to that outer declaration"
  );
  assert.ok(
    outcome.reason.includes("Parameter"),
    `the failure must name the real binding shape (a function parameter) rather than a generic refusal; got: ${outcome.reason}`
  );
});

// =============================================================================
// A callee spelled `spawnSync` proves nothing on its own: the guard must
// resolve it back to the real `node:child_process` export, never accept
// it on name alone. A local declaration sharing that name - a shadowing
// function, say - satisfies a text/name match while never calling into
// `node:child_process` at all, so this must fail closed, naming the real
// binding it found rather than the import it did not.
// =============================================================================

test("resolveAssertedLintInvocation fails closed when spawnSync is shadowed by a same-named local function, never actually calling node:child_process", () => {
  const source = `
import { execFileSync } from "node:child_process";

function spawnSync() {
  return { status: 0, stdout: "", stderr: "" };
}

const result = spawnSync("npm", ["run", "lint"], { encoding: "utf8" });
assert.equal(result.status, 0, "lint should exit clean");
`;

  const outcome = resolveAssertedLintInvocation(source);
  assert.equal(
    outcome.bound,
    false,
    "a callee shadowed by a locally-declared function of the same name must never be reported as bound to the real spawnSync import"
  );
  assert.ok(
    outcome.reason.includes("FunctionName"),
    `the failure must name the real binding shape (a locally-declared function), not the real import; got: ${outcome.reason}`
  );
  assert.ok(
    outcome.reason.includes("node:child_process"),
    `the failure must name the real module the callee was expected to come from, not refuse silently; got: ${outcome.reason}`
  );
});

// =============================================================================
// Eligibility comes from ESLint's own live config, applied to the real
// project tree: zero coverage gaps, zero unresolved paths, and a live
// (never hard-coded) eligible count.
// =============================================================================

test("every real tracked file resolves without error under ESLint's live config (fail-closed: nothing silently skipped)", async () => {
  const eslintInstance = new ESLint({ cwd: REPO_ROOT });
  const { unresolved, trackedCount, eligibleCount } = await checkLintCoverage(
    REPO_ROOT,
    eslintInstance
  );
  assert.deepEqual(
    unresolved,
    [],
    `every tracked path must resolve; unresolved: ${unresolved.map(formatUnresolvedMessage).join("; ")}`
  );
  assert.ok(trackedCount > 0, "the real repo must have tracked files to check");
  // Derived live, never compared against a fixed number - the count is
  // only asserted to be a real, positive, non-hardcoded value.
  assert.ok(eligibleCount > 0, "at least some tracked files must be ESLint-eligible");
});

test("a path whose ESLint eligibility resolution genuinely fails is recorded in `unresolved`, named with its own error, and the coverage guard's clean-run assertion goes red on it", async () => {
  const fixture = makeScratchFixture();
  try {
    const eslintInstance = makeEslintForScratchFixture(fixture.dir);
    const realIsPathIgnored = eslintInstance.isPathIgnored.bind(eslintInstance);
    const injectedErrorMessage = "synthetic resolution failure for scripts/inside.mjs";
    const failingAbsPath = path.join(fixture.dir, "scripts", "inside.mjs");

    // A real thrown error from ESLint's own `isPathIgnored`, for exactly
    // one real path - not a hand-substituted `{ ok: false }` object built
    // to look like what `resolveEligibility`'s catch block would produce.
    // Every other path still resolves through the real, unmodified
    // ESLint instance.
    eslintInstance.isPathIgnored = async (absPath) => {
      if (absPath === failingAbsPath) throw new Error(injectedErrorMessage);
      return realIsPathIgnored(absPath);
    };

    const { unresolved, gaps } = await checkLintCoverage(fixture.dir, eslintInstance);

    assert.equal(
      unresolved.length,
      1,
      `expected exactly one unresolved path; got: ${JSON.stringify(unresolved)}`
    );
    assert.equal(unresolved[0].path, "scripts/inside.mjs");
    assert.ok(
      unresolved[0].error.includes(injectedErrorMessage),
      `unresolved entry must carry the real thrown error; got: ${JSON.stringify(unresolved[0])}`
    );

    // A path that fails to resolve is never silently treated as covered -
    // it must not slip into gaps either, since gaps is only ever
    // populated for paths ESLint successfully classified as eligible.
    assert.ok(
      !gaps.includes("scripts/inside.mjs"),
      "an unresolved path must not also appear in gaps"
    );

    // What every other "clean run" assertion in this file actually
    // requires is that `unresolved` comes back `[]`. Demonstrating that
    // requirement itself failing here, with a diagnostic naming both the
    // offending path and the real resolution error, is what proves this
    // would actually be caught rather than silently passing a run with
    // one path it could not classify at all.
    assert.throws(
      () => {
        assert.deepEqual(
          unresolved,
          [],
          `every tracked path must resolve; unresolved: ${unresolved.map(formatUnresolvedMessage).join("; ")}`
        );
      },
      (err) =>
        err instanceof assert.AssertionError &&
        err.message.includes("scripts/inside.mjs") &&
        err.message.includes(injectedErrorMessage),
      "the clean-run assertion must fail, naming both the offending path and its real resolution error"
    );
  } finally {
    fixture.cleanup();
  }
});

test("every ESLint-eligible tracked file in the real repo is covered by the frozen lint command (zero gaps)", async () => {
  const eslintInstance = new ESLint({ cwd: REPO_ROOT });
  const { gaps, unresolved } = await checkLintCoverage(REPO_ROOT, eslintInstance);
  assert.deepEqual(
    unresolved,
    [],
    `every tracked path must resolve; unresolved: ${unresolved.map(formatUnresolvedMessage).join("; ")}`
  );
  assert.deepEqual(
    gaps,
    [],
    `eligible files outside the lint command's scope: ${gaps.map(formatCoverageGapMessage).join("; ")}`
  );
});

test("ESLint discovery-API claims, verified directly against the real live config: .ts/.mts/.cts/.tsx are in scope, .jsx is not", async () => {
  const eslintInstance = new ESLint({ cwd: REPO_ROOT });
  const inScope = ["src/probe.ts", "src/probe.mts", "src/probe.cts", "src/probe.tsx"];
  for (const rel of inScope) {
    const ignored = await eslintInstance.isPathIgnored(path.join(REPO_ROOT, rel));
    assert.equal(ignored, false, `${rel} must be in scope under the real live config`);
  }
  // Verified independently, as its own assertion - a .jsx file is NOT
  // discovered by this config at all, which is a DIFFERENT outcome from
  // every extension above and must not be assumed to match them.
  const jsxIgnored = await eslintInstance.isPathIgnored(path.join(REPO_ROOT, "src/probe.jsx"));
  assert.equal(jsxIgnored, true, "src/probe.jsx must NOT be in scope under the real live config");
});

// =============================================================================
// A hermetic, disposable git fixture exercising the full discriminator
// set: files correctly placed under a covered root, real out-of-scope
// gaps, the .jsx file that sits outside every root yet still is not
// eligible at all, and a filename containing a literal newline.
// =============================================================================

test("hermetic fixture: an eligible file outside every positive root is flagged as a coverage gap, named by path (.mjs, .mts, .cts), and removing it clears the gap", async () => {
  const fixture = makeScratchFixture();
  try {
    const eslintInstance = makeEslintForScratchFixture(fixture.dir);
    const before = await checkLintCoverage(fixture.dir, eslintInstance);
    assert.deepEqual(
      before.unresolved,
      [],
      `every tracked path must resolve; unresolved: ${before.unresolved.map(formatUnresolvedMessage).join("; ")}`
    );
    for (const expectedGap of ["lib/outside.mjs", "lib/outside.mts", "lib/outside.cts"]) {
      assert.ok(
        before.gaps.includes(expectedGap),
        `expected ${expectedGap} to be reported as a gap; got: ${JSON.stringify(before.gaps)}`
      );
    }

    // Remove the offending files and commit the removal - so `git
    // ls-files`, which the tracked-file denominator is built from,
    // actually stops listing them - and confirm each one's gap clears.
    // This fixture also carries a sibling out-of-scope eligible file (the
    // newline-named one, covered by its own test below) - removing only
    // the three paths this test names would leave that sibling's gap
    // standing, so `after.gaps` could never actually reach `[]` and the
    // "restored to green" claim below would never be a real assertion.
    // Clearing every out-of-scope entry this fixture carries is what
    // makes it one.
    for (const relPath of [
      "lib/outside.mjs",
      "lib/outside.mts",
      "lib/outside.cts",
      "lib/weird\nname.mjs",
    ]) {
      rmSync(path.join(fixture.dir, relPath));
    }
    execFileSync("git", ["add", "-A"], { cwd: fixture.dir });
    execFileSync("git", ["commit", "--quiet", "-m", "remove out-of-scope files"], {
      cwd: fixture.dir,
    });

    const after = await checkLintCoverage(fixture.dir, eslintInstance);
    assert.deepEqual(
      after.unresolved,
      [],
      `every tracked path must resolve; unresolved: ${after.unresolved.map(formatUnresolvedMessage).join("; ")}`
    );
    for (const removedPath of ["lib/outside.mjs", "lib/outside.mts", "lib/outside.cts"]) {
      assert.ok(
        !after.gaps.includes(removedPath),
        `${removedPath} was removed and must no longer be reported as a gap; got: ${JSON.stringify(after.gaps)}`
      );
    }
    assert.deepEqual(
      after.gaps,
      [],
      "the repaired fixture must actually return to green, with every eligible out-of-scope entry gone, not merely the three paths this test names"
    );
  } finally {
    fixture.cleanup();
  }
});

test("hermetic fixture DISCRIMINATOR: an out-of-scope .jsx file is GREEN, proving eligibility follows the real live config rather than a suffix match", async () => {
  const fixture = makeScratchFixture();
  try {
    const eslintInstance = makeEslintForScratchFixture(fixture.dir);

    // Verified independently at the eligibility layer first: it is
    // excluded because ESLint itself does not consider it eligible, not
    // because the coverage check happens to treat it as covered.
    const eligibility = await resolveEligibility(eslintInstance, fixture.dir, "lib/outside.jsx");
    assert.deepEqual(eligibility, { ok: true, eligible: false });

    const { gaps, unresolved } = await checkLintCoverage(fixture.dir, eslintInstance);
    assert.deepEqual(
      unresolved,
      [],
      `every tracked path must resolve; unresolved: ${unresolved.map(formatUnresolvedMessage).join("; ")}`
    );
    assert.ok(
      !gaps.includes("lib/outside.jsx"),
      "a .jsx file must never be reported as a gap - it is out of ESLint's scope entirely, same location as the RED cases above, different outcome, and only a suffix-regex stand-in would confuse the two"
    );
  } finally {
    fixture.cleanup();
  }
});

test("hermetic fixture: an eligible file placed correctly under src/, scripts/, test/, or as eslint.config.js is GREEN", async () => {
  const fixture = makeScratchFixture();
  try {
    const eslintInstance = makeEslintForScratchFixture(fixture.dir);
    const { gaps, unresolved } = await checkLintCoverage(fixture.dir, eslintInstance);
    assert.deepEqual(
      unresolved,
      [],
      `every tracked path must resolve; unresolved: ${unresolved.map(formatUnresolvedMessage).join("; ")}`
    );
    for (const expectedClean of [
      "src/inside.ts",
      "scripts/inside.mjs",
      "test/inside.js",
      "eslint.config.js",
    ]) {
      assert.ok(
        !gaps.includes(expectedClean),
        `${expectedClean} sits inside a positive root and must never be reported as a gap`
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test("hard-coding the current eligible count is a trap: growing the fixture by one eligible file changes the live count, which a fixed/guessed number would silently miss", async () => {
  const fixture = makeScratchFixture();
  try {
    const eslintInstance = makeEslintForScratchFixture(fixture.dir);
    const before = await checkLintCoverage(fixture.dir, eslintInstance);
    assert.deepEqual(
      before.unresolved,
      [],
      `every tracked path must resolve; unresolved: ${before.unresolved.map(formatUnresolvedMessage).join("; ")}`
    );
    const guessedCount = before.eligibleCount; // stands in for a naive implementation's fixed number

    writeFileSync(path.join(fixture.dir, "src", "grown.ts"), "export const grown = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: fixture.dir });
    execFileSync("git", ["commit", "--quiet", "-m", "grow"], { cwd: fixture.dir });

    const after = await checkLintCoverage(fixture.dir, eslintInstance);
    assert.deepEqual(
      after.unresolved,
      [],
      `every tracked path must resolve; unresolved: ${after.unresolved.map(formatUnresolvedMessage).join("; ")}`
    );

    assert.notEqual(
      after.eligibleCount,
      guessedCount,
      "the live eligible count must change once a new eligible file is tracked"
    );
    // The point being demonstrated: had the coverage check compared
    // against `guessedCount` instead of deriving this number live on
    // every run, it would now be silently wrong about a tree it has never
    // actually looked at.
    assert.equal(
      guessedCount === after.eligibleCount,
      false,
      "a fixed/guessed eligible count goes stale the moment the tree grows - this is exactly why the real check never hard-codes one"
    );
  } finally {
    fixture.cleanup();
  }
});

// =============================================================================
// NUL-safe parsing of `git ls-files -z`, end to end, against a real
// tracked filename containing a literal newline character.
// =============================================================================

test("a tracked filename containing a literal newline is parsed as one real file, not fabricated into two, and removing it clears the reported gap", async () => {
  const fixture = makeScratchFixture();
  try {
    const tracked = listTrackedFiles(fixture.dir);
    assert.ok(
      tracked.includes("lib/weird\nname.mjs"),
      `the newline-containing filename must appear intact among tracked files; got: ${JSON.stringify(tracked)}`
    );

    const eslintInstance = makeEslintForScratchFixture(fixture.dir);
    const before = await checkLintCoverage(fixture.dir, eslintInstance);
    assert.deepEqual(
      before.unresolved,
      [],
      `every tracked path must resolve; unresolved: ${before.unresolved.map(formatUnresolvedMessage).join("; ")}`
    );
    assert.ok(
      before.gaps.includes("lib/weird\nname.mjs"),
      "the newline-containing file is eligible and outside every positive root, so it must be reported as a real, single gap"
    );

    const message = formatCoverageGapMessage("lib/weird\nname.mjs");
    assert.equal(
      message,
      'eligible file outside the lint command\'s scope: "lib/weird\\nname.mjs"',
      "the diagnostic must render the embedded newline as an escaped `\\n`, not a literal line break"
    );

    // Removing the file and committing that removal must clear its gap,
    // the same restored-green proof required for the other out-of-scope
    // cases above. This fixture also carries three sibling out-of-scope
    // eligible files (the .mjs/.mts/.cts case, covered by its own test
    // above) - removing only the newline-named path would leave those
    // siblings' gaps standing, so `after.gaps` could never actually reach
    // `[]`. Clearing every out-of-scope entry this fixture carries is
    // what makes the "restored to green" claim below a real assertion.
    for (const relPath of [
      "lib/weird\nname.mjs",
      "lib/outside.mjs",
      "lib/outside.mts",
      "lib/outside.cts",
    ]) {
      rmSync(path.join(fixture.dir, relPath));
    }
    execFileSync("git", ["add", "-A"], { cwd: fixture.dir });
    execFileSync("git", ["commit", "--quiet", "-m", "remove newline-named file"], {
      cwd: fixture.dir,
    });

    const after = await checkLintCoverage(fixture.dir, eslintInstance);
    assert.deepEqual(
      after.unresolved,
      [],
      `every tracked path must resolve; unresolved: ${after.unresolved.map(formatUnresolvedMessage).join("; ")}`
    );
    assert.ok(
      !after.gaps.includes("lib/weird\nname.mjs"),
      "the newline-named file was removed and must no longer be reported as a gap"
    );
    assert.deepEqual(
      after.gaps,
      [],
      "the repaired fixture must actually return to green, with every eligible out-of-scope entry gone, not merely the newline-named one"
    );
  } finally {
    fixture.cleanup();
  }
});

test("a plain newline-split of the same raw `git ls-files -z` output fabricates a corrupted entry, which the real NUL-safe parser never produces", () => {
  const fixture = makeScratchFixture();
  try {
    const raw = execFileSync("git", ["ls-files", "-z"], { cwd: fixture.dir });

    const correct = parseGitLsFilesZ(raw);
    // The wrong way, kept here only to demonstrate the failure mode this
    // control exists to catch - never used by the real implementation
    // above, which always splits on NUL.
    const wrong = raw
      .toString("utf8")
      .split("\n")
      .filter((entry) => entry.length > 0);

    assert.ok(
      correct.includes("lib/weird\nname.mjs"),
      "the NUL-safe parse must keep the newline-containing filename intact"
    );
    assert.ok(
      !wrong.includes("lib/weird\nname.mjs"),
      "a newline-split parse must NOT keep the filename intact - it should have fabricated it into pieces"
    );
    // No real tracked path can ever contain a raw NUL byte (git's own -z
    // format depends on that being true), so an entry containing one is
    // unambiguous proof the newline-split glued two separate NUL-delimited
    // records together across a real newline.
    assert.ok(
      wrong.some((entry) => entry.includes("\0")),
      "a newline-split parse must fabricate an entry containing a raw NUL byte, proving two real records were glued together"
    );
  } finally {
    fixture.cleanup();
  }
});

// =============================================================================
// Public CI must invoke the same `npm run lint` package script this
// change touches, bound to the specific job and step that runs it - not
// merely present as matching text somewhere in the workflow file.
// =============================================================================

function loadCiWorkflow() {
  return loadYaml(readFileSync(CI_WORKFLOW_PATH, "utf8"));
}

/**
 * True when a step's `if:` condition is present and unambiguously
 * disables it - a bare `false`, or a GitHub Actions expression
 * (`${{ ... }}`) that reduces to nothing but the literal `false`. A step
 * with no `if:` key at all is unconditional, i.e. authoritative; a step
 * carrying any other condition (a real runtime expression such as
 * `${{ !cancelled() }}`) is left alone rather than guessed at, since a
 * genuine conditional step is a normal, legitimate shape for a CI job to
 * contain.
 * @param {{ if?: unknown }} step
 * @returns {boolean}
 */
function isStepDisabled(step) {
  if (!Object.prototype.hasOwnProperty.call(step, "if")) return false;
  const raw = step.if;
  if (raw === false) return true;
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  const wrapped = trimmed.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  const expr = (wrapped ? wrapped[1] : trimmed).trim();
  return /^(false|'false'|"false")$/i.test(expr);
}

/**
 * Finds the "lint" job's own step whose run command is exactly `npm run
 * lint` - never any text that merely contains that substring, which would
 * also match the unrelated `npm run lint:workflow-jobs` step in the same
 * job (a word-boundary regex over the whole file matches that step too,
 * since a colon still counts as a word boundary). Real YAML structure is
 * parsed here with the same loader this repo's other workflow checks
 * already use, and the match is scoped to one named job's own step list,
 * with exact string equality rather than a substring search.
 *
 * A step whose `run` matches `npm run lint` exactly is not enough on its
 * own: it must also be LIVE (see `isStepDisabled`), since a disabled step
 * carrying the canonical text is not what actually executes. And a live
 * canonical step is rejected too if some OTHER live step in the same job
 * invokes eslint directly - a decoy that carries the canonical text while
 * disabled, sitting next to a real step that bypasses it, must fail this
 * check rather than pass on the decoy's text alone.
 * @param {{ jobs?: Record<string, any> }} workflow
 * @returns {{ found: true } | { found: false, reason: string }}
 */
function findLintJobOwnLintStep(workflow) {
  const lintJob = workflow?.jobs?.lint;
  if (!lintJob) {
    return { found: false, reason: 'the workflow has no job named "lint"' };
  }
  const steps = lintJob.steps ?? [];
  const canonicalSteps = steps.filter(
    (step) => typeof step.run === "string" && step.run.trim() === "npm run lint"
  );
  if (canonicalSteps.length === 0) {
    return {
      found: false,
      reason:
        'the "lint" job has no step whose run command is exactly `npm run lint` - it may have been changed to invoke eslint some other way',
    };
  }

  const liveCanonicalSteps = canonicalSteps.filter((step) => !isStepDisabled(step));
  if (liveCanonicalSteps.length === 0) {
    return {
      found: false,
      reason:
        'the "lint" job has a step whose run command is exactly `npm run lint`, but it is disabled by its `if:` condition and is not actually authoritative - no live step actually runs the canonical command',
    };
  }
  if (liveCanonicalSteps.length > 1) {
    return {
      found: false,
      reason: `the "lint" job has ${liveCanonicalSteps.length} live steps whose run command is exactly \`npm run lint\`, which makes the binding ambiguous`,
    };
  }

  const bypassSteps = steps.filter((step) => {
    if (step === liveCanonicalSteps[0]) return false;
    if (typeof step.run !== "string") return false;
    if (step.run.trim() === "npm run lint") return false;
    if (isStepDisabled(step)) return false;
    return /\beslint\b/i.test(step.run);
  });
  if (bypassSteps.length > 0) {
    return {
      found: false,
      reason:
        'the "lint" job has another live step that invokes eslint directly instead of through `npm run lint`, bypassing the canonical command',
    };
  }

  return { found: true };
}

test('public CI\'s "lint" job runs a step whose command is exactly `npm run lint`, bound to that specific job and step rather than to matching text anywhere in the workflow file', () => {
  const workflow = loadCiWorkflow();
  const result = findLintJobOwnLintStep(workflow);
  assert.ok(result.found, result.reason);
});

// =============================================================================
// The CHANGELOG line describes the change on its own terms, for readers
// of the published changelog.
// =============================================================================

test("CHANGELOG.md contains the exact expected description of this change", () => {
  const changelog = readFileSync(CHANGELOG_URL, "utf8");
  const expectedLine =
    "- `npm run lint` now targets this project's own source directories (`src`, `scripts`, `test`, `eslint.config.js`) instead of the whole working tree.";
  assert.ok(
    changelog.includes(expectedLine),
    "CHANGELOG.md must contain the exact expected line describing this change"
  );
});

// =============================================================================
// Dropping a positive root from the covered-roots list turns a file that
// currently sits cleanly inside it into a reported gap; with all four
// real targets in place, that same file reads clean.
// =============================================================================

test("removing a positive root from the coverage check turns a previously-clean file into a reported gap; restoring it clears it again", async () => {
  const fixture = makeScratchFixture();
  try {
    const eslintInstance = makeEslintForScratchFixture(fixture.dir);

    function isCoveredWithout(relPath, excludedDir) {
      if (relPath === LINT_TARGET_FILE) return true;
      return LINT_TARGET_DIRS.filter((dir) => dir !== excludedDir).some(
        (dir) => relPath === dir || relPath.startsWith(`${dir}/`)
      );
    }

    const tracked = listTrackedFiles(fixture.dir);
    const withoutSrc = [];
    for (const relPath of tracked) {
      const result = await resolveEligibility(eslintInstance, fixture.dir, relPath);
      if (result.ok && result.eligible && !isCoveredWithout(relPath, "src")) {
        withoutSrc.push(relPath);
      }
    }
    assert.ok(
      withoutSrc.includes("src/inside.ts"),
      "dropping src/ from the covered roots must turn src/inside.ts into a reported gap"
    );

    const { gaps, unresolved } = await checkLintCoverage(fixture.dir, eslintInstance);
    assert.deepEqual(
      unresolved,
      [],
      `every tracked path must resolve; unresolved: ${unresolved.map(formatUnresolvedMessage).join("; ")}`
    );
    assert.ok(
      !gaps.includes("src/inside.ts"),
      "with all four real targets restored, src/inside.ts must read clean again"
    );
  } finally {
    fixture.cleanup();
  }
});
