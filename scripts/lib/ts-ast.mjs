/**
 * Shared TypeScript-compiler-API helpers for this repo's guard scripts
 * (scripts/check-module-boundaries.mjs, scripts/check-no-tasks-import.mjs,
 * scripts/check-stdio-purity.mjs). These guards run on the real TypeScript
 * AST rather than regex matching, so they catch every syntactic variant of
 * a forbidden CLASS structurally instead of by spelling: comments are
 * trivia, not AST nodes, so they can never hide a real construct from a
 * parser the way they can from a regex; a computed `obj["prop"]` and a
 * dotted `obj.prop` both produce a real, inspectable node shape regardless
 * of the exact characters between them.
 */
import ts from "typescript";

/**
 * Parses `sourceText` (the contents of `fileName`) into a real TypeScript
 * AST. `setParentNodes: true` is required for `.parent` to be populated on
 * every node - several checks in this file's callers walk UP from a node
 * to its parent (e.g. "is this `new Map()` immediately member-accessed,
 * or bound to something that outlives this expression").
 */
export function parseSourceFile(fileName, sourceText) {
  return ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
}

/** Calls `visit(node)` for `node` itself, then recursively for every descendant, depth-first. */
export function forEachDescendant(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => forEachDescendant(child, visit));
}

/**
 * True for a `CallExpression` that IS a dynamic `import(...)` call - the
 * TS AST represents this as a `CallExpression` whose `expression` is the
 * bare `import` keyword token (`SyntaxKind.ImportKeyword`), distinct from
 * calling some ordinary function that happens to be named `import`.
 * `ts.isImportCall` is an internal-only helper in the installed TS
 * version (not part of the public `typescript.d.ts` surface), so this
 * reimplements the same check against public `ts.SyntaxKind`/
 * `ts.isCallExpression` - verified empirically against the installed
 * 5.9.3 package by parsing `import("./x.js")` and inspecting the
 * resulting node shape.
 */
export function isDynamicImportCall(node) {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/**
 * Unwraps any number of syntax layers that are transparent at runtime -
 * parentheses, a non-null assertion (`x!`), an `as`/`satisfies` type
 * wrapper - in any combination and order. All four are erased by
 * TypeScript at emit and change nothing about which value the expression
 * evaluates to, so `(x)`, `x!`, `x as T`, and `x satisfies T` must all
 * resolve identically to bare `x` for every check in this file that asks
 * "what value does this expression actually read at runtime."
 *
 * Originally handled only parentheses (named `unwrapParens`) - broadened
 * after `(globalThis as typeof globalThis).eval(x)` and `globalThis!.eval(x)`
 * were proven to walk straight through the narrower version: a cast or a
 * non-null assertion sitting directly on an acquisition-site base changed
 * the node's shape from a bare `Identifier` to an `AsExpression`/
 * `NonNullExpression`, which every base-expression check in this file
 * requires before it will even look at symbol resolution.
 */
function unwrapTransparentWrapper(node) {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isNonNullExpression(current)) {
      current = current.expression;
    } else if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

/**
 * Extracts the literal text of a string-literal-like AST node - a plain
 * `StringLiteral` (`"x"`/`'x'`) or a no-substitution template literal
 * (`` `x` ``, no `${...}` interpolation). Returns `undefined` for anything
 * else (an identifier, a member expression, string concatenation, or a
 * template WITH an interpolation) - a genuinely dynamic/computed value
 * that can't be resolved without actually running the code.
 */
export function stringLiteralText(node) {
  if (node === undefined) return undefined;
  const unwrapped = unwrapTransparentWrapper(node);
  return ts.isStringLiteralLike(unwrapped) ? unwrapped.text : undefined;
}

/**
 * True for a `CallExpression` whose callee is literally the bare
 * identifier `require` (e.g. `require("./x.js")`, or `require(x)` after
 * `x` was obtained from `createRequire`) - CommonJS's module-loading
 * primitive. This matches on the identifier alone rather than trying to
 * prove it resolves to Node's real `require` at runtime: a codebase whose
 * architecture is ESM-only end to end has no legitimate reason for a
 * `require` identifier to exist at all, so flagging every CallExpression
 * literally named `require` - however that binding was obtained - is the
 * correct, maximally-conservative check for that architecture.
 */
export function isRequireCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require"
  );
}

/**
 * True for a `CallExpression` whose callee is literally the bare
 * identifier `createRequire` (e.g. `createRequire(import.meta.url)`).
 * Calling this at all is the violation callers care about, independent of
 * what's done with the function it returns - an ESM-only codebase has no
 * legitimate CommonJS-interop need anywhere.
 */
export function isCreateRequireCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "createRequire"
  );
}

/**
 * Every module-specifier-bearing construct in `sourceFile`, wherever it
 * appears (a dynamic import or a `require(...)` call is a normal
 * expression and can appear anywhere - inside a function, inside a
 * comment-separated call, inside an argument list; a static import/export
 * is always a top-level statement, but this walks the whole tree
 * uniformly rather than special-casing statement position):
 *
 *   - a static `import ... from "x"` (`import type`, a bare side-effect
 *     `import "x"`, and an ordinary `import { a } from "x"` are all the
 *     same `ImportDeclaration` node kind)
 *   - a re-export (`export { a } from "x"`, `export * from "x"`)
 *   - a dynamic `import("x")` call
 *   - a `require("x")` call - the mechanism used to load a module doesn't
 *     change what target it resolves to, so a caller that cares about the
 *     RESOLVED TARGET (a sibling file, a forbidden package subpath) needs
 *     this alongside the ES forms above, not a separate parallel check.
 *     `createRequire(...)` itself is intentionally NOT included here (it
 *     carries no module specifier of its own - its argument is typically
 *     `import.meta.url` - callers that care about its use at all should
 *     check `isCreateRequireCall` directly).
 *
 * Each entry's `text` is the specifier's literal text when it's
 * statically resolvable (comments between `import`/`export`/`from`/
 * `require` and the specifier, or between `import(`/`require(` and its
 * argument, can never hide it - comments aren't AST nodes). `text` is
 * `undefined` when the specifier is a genuinely dynamic/computed
 * expression that can't be resolved without running the code - callers
 * decide for themselves whether an unresolvable specifier should fail
 * open or fail closed for their own rule.
 *
 * A `require(...)` call is only ever collected when `require` resolves to
 * the real, unshadowed global (via the same scope-aware check
 * `findCreateRequireImports` uses) - a call through a locally shadowed
 * `require` (a parameter, a local function/const, an import) is an
 * ordinary function call, not a module-loading construct, regardless of
 * what its argument happens to look like. Without this check, a
 * sibling-looking or forbidden-looking STRING literal passed to a
 * harmless local function named `require` would be misread as a real,
 * resolved module specifier - an OVER-blocking failure, not an escape:
 * verified empirically against `const require = (x) => x;
 * require("./sibling.js")`, which must never be treated as an actual
 * import of `"./sibling.js"`. `import`/`export`/dynamic-`import()` never
 * need this check - none of those are identifiers a local declaration
 * could shadow.
 */
export function collectModuleSpecifiers(sourceFile) {
  const results = [];
  const { sourceFile: checkedSourceFile, checker } = createScopeCheckedProgram(
    sourceFile.fileName,
    sourceFile.text
  );
  forEachDescendant(checkedSourceFile, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      results.push({ node, text: stringLiteralText(node.moduleSpecifier) });
      return;
    }
    if (isDynamicImportCall(node)) {
      const [firstArg] = node.arguments;
      results.push({ node, text: firstArg ? stringLiteralText(firstArg) : undefined });
      return;
    }
    if (isRequireCall(node) && isUnshadowedGlobalCallee(node, checker, checkedSourceFile)) {
      const [firstArg] = node.arguments;
      results.push({ node, text: firstArg ? stringLiteralText(firstArg) : undefined });
    }
  });
  return results;
}

/**
 * True when `callExpression`'s callee is a bare `Identifier` that resolves
 * to the real, unshadowed global (or is genuinely unresolved, which fails
 * CLOSED here the same way `findCreateRequireImports` does for the bare-
 * identifier acquisition case - see `isUnshadowedGlobalSymbol`'s own doc
 * comment). Shared by `collectModuleSpecifiers`'s `require(...)` handling
 * so a call through a local shadow is recognized as an ordinary function
 * call rather than a real module-loading construct.
 */
function isUnshadowedGlobalCallee(callExpression, checker, checkedSourceFile) {
  const callee = callExpression.expression;
  if (!ts.isIdentifier(callee)) return false;
  const symbol = checker.getSymbolAtLocation(callee);
  return symbol === undefined || isUnshadowedGlobalSymbol(symbol, checkedSourceFile);
}

/**
 * The `node:module` builtin's specifier text, and the unprefixed `"module"`
 * form Node/TS also accept for the same builtin - verified empirically:
 * `import { createRequire } from "module"` resolves identically to the
 * `"node:module"` form under this repo's `nodenext` module resolution, and
 * Node itself resolves the bare specifier to the same builtin at runtime.
 * Both forms must be checked; only checking `"node:module"` would leave the
 * unprefixed spelling as an open escape.
 *
 * This is a literal-text membership check, not resolver-based comparison -
 * see `findCreateRequireImports`'s "SPECIFIER COMPARISON IS ALSO NOT YET
 * RESOLVER-BASED" note for what that leaves open (absolute, file-URL, and
 * resolver-alias specifiers reaching the same builtin).
 */
const MODULE_BUILTIN_SPECIFIERS = new Set(["node:module", "module"]);

/**
 * The four names this guard resolves via real lexical scope/symbol
 * resolution rather than by spelling or invocation shape - see
 * `findCreateRequireImports`'s own doc comment for the acquisition-site
 * design this implements. `createRequire` is deliberately NOT here: unlike
 * these four, it is never an ambient global - within this guard's own
 * import-specifier analysis it is reachable only via an IMPORT of
 * `"node:module"`, which the static-import branches of
 * `findCreateRequireImports` (unchanged by this design) cover exhaustively.
 * A route that reaches it WITHOUT going through that analysis at all is
 * out of scope for a different reason - see that function's own
 * "OUT OF SCOPE" section.
 */
const FORBIDDEN_GLOBAL_NAMES = new Set(["eval", "Function", "require", "module", "Reflect"]);

/** Maps a forbidden global's name to the public `kind` string this file's callers switch on. */
const GLOBAL_NAME_TO_KIND = {
  eval: "eval-call",
  Function: "function-constructor-call",
  require: "commonjs-require",
  module: "module-require",
  Reflect: "reflect-reference",
};

const SYNTHETIC_GLOBALS_FILE_NAME = "__ghantika-forbidden-globals__.d.ts";

/**
 * A minimal, hand-written declaration file standing in for the real
 * `lib.*.d.ts`/`@types/node` ambient globals - declares the four names
 * this guard cares about, plus `globalThis` itself (needed so a
 * `globalThis.eval`-shaped reference has something to resolve `globalThis`
 * against in the first place), so building a `ts.Program` to resolve them
 * stays fast (binding a few lines, not the real multi-thousand-line lib
 * chain) and fully in-memory (no disk I/O for the file under test, which
 * is often a bare fixture string with no real path on disk at all).
 */
const SYNTHETIC_GLOBALS_SOURCE = [
  "declare function eval(x: string): any;",
  "declare var Function: any;",
  "declare var require: any;",
  "declare var module: any;",
  "declare var globalThis: any;",
  "declare var process: any;",
  "declare var Reflect: any;",
  "declare var Object: any;",
].join("\n");

/**
 * The `process` properties this guard cares about. `process` itself is
 * NOT flagged outright the way `eval`/`Function`/`require`/`module` are -
 * unlike those four, it is used extensively and legitimately throughout
 * this codebase (`.env`, `.platform`, `.cwd()`, `.kill()`, and more), so
 * treating a bare `process` reference as a violation would be wildly
 * over-broad. Three properties are dangerous:
 *
 *   - `.getBuiltinModule` - `process.getBuiltinModule(id)` returns a real
 *     builtin module's namespace object DIRECTLY, by specifier, completely
 *     independent of any `import`/`require` syntax - calling it with
 *     `"node:module"`/`"module"` reaches `createRequire` exactly as a
 *     namespace import would, through a route with no import specifier
 *     and no `require`/`module`/`eval`/`Function` identifier anywhere in
 *     source.
 *   - `.dlopen` - loads a native addon (a compiled `.node` binary)
 *     directly into the process, a strictly more dangerous capability
 *     than any of the module-loading forms above.
 *   - `.binding` - Node's internal (unstable, undocumented) native-binding
 *     loader, one more sibling acquisition route on the same permitted
 *     `process` base that banning only `.getBuiltinModule` left open -
 *     closing a single named property and stopping there is exactly the
 *     "enumerate one spelling" incompleteness this file's design
 *     otherwise rejects.
 *
 * This codebase's frozen ESM architecture has no legitimate reason to
 * call any of these three (verified: the real `src/` tree contains no
 * reference to any of them).
 */
const PROCESS_DANGEROUS_PROPERTIES = new Set(["getBuiltinModule", "dlopen", "binding"]);

/**
 * The property name `.constructor` - flagged UNCONDITIONALLY, on ANY
 * base expression, unlike every other check in this file. Every value in
 * JavaScript carries a `.constructor` reachable off its own prototype
 * chain, so this is not an acquisition-site check keyed to one lexical
 * name or one known-dangerous base the way `process.getBuiltinModule` is
 * - there is no base expression to require being "the real global"
 * first, because the property exists on every object and function
 * regardless of where it came from (`(() => 1).constructor` reaches
 * `Function` with no identifier named `Function` anywhere in source, the
 * SAME class `Reflect.get(globalThis, "eval")` belongs to - reaching a
 * forbidden primitive through generic language structure rather than a
 * name or an import). This codebase has no legitimate reason to read
 * `.constructor` off anything (verified: the real `src/` tree contains no
 * reference to it), so the property access itself is banned outright, the
 * same "zero legitimate use, ban the whole surface" reasoning
 * `FORBIDDEN_GLOBAL_NAMES` already applies to `module`.
 */
const CONSTRUCTOR_PROPERTY_NAME = "constructor";

/**
 * Builds a real `ts.Program` (and its `TypeChecker`) over exactly two
 * files: the file under test, and the synthetic globals file above -
 * entirely in-memory, via a `CompilerHost` that never touches the real
 * filesystem (`fileExists`/`readFile`/`getSourceFile` all resolve from a
 * `Map`). A checker is what makes REAL scope/symbol resolution possible at
 * all: `ts.createSourceFile` alone (used everywhere else in this file)
 * only parses syntax, it never binds an identifier reference back to its
 * declaration, so there is no way to answer "is this `Function` reference
 * the real global, or a local shadow" without one.
 *
 * `noLib: true` skips the real default lib entirely (the synthetic
 * five-line file stands in for it instead), and no module resolution is
 * configured - an import specifier that can't resolve (e.g. `"node:module"`,
 * meaningless to a `noLib` program) still correctly BINDS its own local
 * specifier name as a local declaration, which is all this file's
 * scope-resolution check ever needs; it does not need the import's TARGET
 * to resolve.
 */
function createScopeCheckedProgram(fileName, sourceText) {
  const options = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    types: [],
  };
  const virtualFiles = new Map([
    [fileName, sourceText],
    [SYNTHETIC_GLOBALS_FILE_NAME, SYNTHETIC_GLOBALS_SOURCE],
  ]);
  const host = {
    getSourceFile(requestedFileName, languageVersion) {
      const text = virtualFiles.get(requestedFileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(requestedFileName, text, languageVersion, true);
    },
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => virtualFiles.has(f),
    readFile: (f) => virtualFiles.get(f),
  };
  const program = ts.createProgram([fileName, SYNTHETIC_GLOBALS_FILE_NAME], options, host);
  return { sourceFile: program.getSourceFile(fileName), checker: program.getTypeChecker() };
}

/**
 * True when `node` (an `Identifier` already known to be named one of the
 * four forbidden globals) sits in a position that could actually READ ITS
 * VALUE at runtime - excludes every position where the same text means
 * something else entirely: the name being DECLARED (a `const`/`let`/
 * parameter/import/class/function declaration - that identifier defines a
 * NEW binding, it does not reference an existing one), a property/method
 * KEY (the `.require` in `x.require`, or `require: ...` in an object/class
 * literal - a label, never a lookup), a DESTRUCTURING SOURCE KEY (the
 * `eval` in `const { eval: localEval } = safe` is a property key naming
 * what to pull OFF `safe`, never a reference to the global - this applies
 * uniformly regardless of what the destructuring source happens to be;
 * see `findGlobalThisDestructureAcquisitions` for the SEPARATE, dedicated
 * check that catches the one case where a destructuring key genuinely IS
 * an acquisition: destructuring straight off the real `globalThis`), or a
 * TYPE position (`: Function`, `typeof eval` used AS a type, a generic
 * type argument - fully erased, carries no runtime capability, so a
 * type-position reference stays green). Everything else - a callee, an
 * operand, an argument, an initializer, a shorthand property VALUE, a
 * computed property key's expression, the operand of the value-level
 * `typeof` OPERATOR (`typeof eval === "function"` genuinely reads the
 * binding at runtime, unlike its type-level namesake `typeof eval` in
 * `type T = ...`) - is a real reference and stays a candidate.
 */
function isValueReferenceCandidate(node) {
  const parent = node.parent;
  if (parent === undefined) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) {
    return false;
  }
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node))
    return false;
  if (ts.isImportClause(parent) && parent.name === node) return false;
  if (ts.isNamespaceImport(parent) && parent.name === node) return false;
  if (ts.isExportSpecifier(parent) && (parent.name === node || parent.propertyName === node))
    return false;
  if (ts.isImportEqualsDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isQualifiedName(parent)) {
    // `typeof module.require` parses `module.require` as a QualifiedName
    // (an EntityName), not a PropertyAccessExpression - a DIFFERENT node
    // shape than the value-level `module.require` this guard otherwise
    // flags. The whole chain (`a.b.c` as a type - QualifiedName nested
    // inside QualifiedName) is erased together if its ROOT sits in a type
    // position, regardless of whether THIS identifier is the qualifier
    // (`.left`) or the member (`.right`) - a qualified name has no
    // partial-erasure concept, so walking to the chain's root before
    // checking is required, not optional.
    let root = parent;
    while (ts.isQualifiedName(root.parent)) root = root.parent;
    if (ts.isTypeNode(root.parent)) return false;
  }
  if (ts.isTypeNode(parent)) return false;
  return true;
}

/**
 * True when `declaration` is an ambient `declare` - `declare const X: T;`,
 * or a declaration nested inside a `declare global { ... }`/`declare
 * module "..." { ... }` block. An ambient declaration is TypeScript-only:
 * it is fully erased at emit and produces no runtime binding whatsoever,
 * so a reference to a name that resolves ONLY to an ambient declaration in
 * this file is not actually shadowed at runtime - the name still reads
 * whatever it would have read had the `declare` never been written.
 */
function isAmbientDeclaration(declaration) {
  return (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0;
}

/**
 * True when `symbol` resolves to a declaration OUTSIDE `checkedSourceFile`
 * - the real global, since the only two files this guard's `Program` ever
 * contains are the file under test and the synthetic globals file, so "not
 * declared in our own file" and "declared in the synthetic globals file"
 * are the same fact. `false` for a symbol whose declarations sit in
 * `checkedSourceFile` (a real local shadow: a `const`, a parameter, an
 * import binding, a catch clause, a `for`/`for-of` declaration, a class
 * name - any of them) - UNLESS every one of those in-file declarations is
 * itself ambient (`isAmbientDeclaration`), in which case none of them
 * produces a real runtime binding and the reference still reads the true
 * global at runtime: `declare const Reflect: {...}; Reflect.get(...)`
 * type-checks as if `Reflect` were locally declared, but emits no
 * `Reflect` declaration at all, so the compiled reference is the real
 * global. Treating an in-file declaration as a shadow only when it
 * actually EMITS is what closes that gap without weakening the ordinary
 * case: a real (non-ambient) local `const`/parameter/import still shadows
 * exactly as before.
 */
function isUnshadowedGlobalSymbol(symbol, checkedSourceFile) {
  if (symbol === undefined) return false;
  const declarations = symbol.declarations ?? [];
  if (declarations.length === 0) return false;
  return declarations.every(
    (d) => d.getSourceFile() !== checkedSourceFile || isAmbientDeclaration(d)
  );
}

/**
 * True when `node` (already unwrapped of transparent syntax) resolves -
 * directly, or through exactly ONE local alias hop - to the real,
 * unshadowed global named `targetName` (`"globalThis"` or `"process"`).
 *
 * The DIRECT case handles `globalThis`/`process` written literally.
 * `globalThis` needs a HYBRID approach unlike every other name this guard
 * resolves: a PARAMETER, catch-binding, or `for`/`for-of` shadow resolves
 * normally through `checker.getSymbolAtLocation` (proven empirically -
 * those go through the same declarations-based check as every other
 * name), but a MODULE-OR-BLOCK-SCOPE `const`/`let` shadow does not:
 * `globalThis` has intrinsic compiler support, and a later reference to it
 * resolves to a symbol with NO `.declarations` at all regardless of
 * whether a `const globalThis = {...}` precedes it (verified empirically
 * against the installed 5.9.3 package) - so "declared outside this file"
 * is unanswerable from the symbol alone in that specific shape, and this
 * falls back to a real lexical scope walk (`hasEnclosingLocalDeclaration`)
 * for `globalThis` specifically. `process` carries no such intrinsic
 * compiler support, so it never hits that no-declarations case in
 * practice - the fallback simply never fires for it.
 *
 * The ONE-HOP ALIAS case handles TWO distinct ways a local binding can come
 * to hold the real target, both verified to actually occur and both
 * covered here: an INITIALIZER (`const g = globalThis; g.eval(x)` /
 * `const p = process; p.getBuiltinModule(...)`), and a bare REASSIGNMENT
 * with no initializer of its own (`let g; g = globalThis; g.eval(x)`) -
 * the second form is exactly as real an acquisition as the first, and
 * omitting it left a genuine gap: a variable declared without an
 * initializer (`decl.initializer === undefined`) was previously treated as
 * never-aliased, even when the very next statement assigned it the real
 * global. `g`/`p` are ordinary local bindings, so the direct check above
 * correctly says they are NOT `globalThis`/`process` by name in either
 * form - but the acquisition is just as real as if the alias had never
 * existed. When the direct check fails, this looks at whether `node`
 * resolves to a symbol with EXACTLY ONE declaration in this file that is a
 * `const`/`let`, and then checks BOTH forms: (a) the declaration's own
 * initializer, if any, resolving (after unwrapping) to a direct reference
 * to the real target; (b) failing that, a bare `<name> = <target>`
 * assignment anywhere else in the file whose left side resolves to this
 * SAME symbol (`findReassignmentAliasTarget`, compared by symbol identity,
 * not by text - two different local variables that happen to share a name
 * in different scopes never collide). Either form is ONE hop, not a
 * chain - this is the verified boundary (mirrors this file's "verified
 * shapes close, a shape outside this list may not" posture elsewhere): a
 * two-hop alias (`const g = globalThis; const h = g; h.eval(x)`, or
 * `let g; g = globalThis; let h; h = g; h.eval(x)`) is not chased here and
 * would be a further row if demonstrated, not a claim this function
 * silently already covers.
 */
function isUnshadowedGlobalOrOneHopAlias(node, targetName, checker, checkedSourceFile) {
  if (!ts.isIdentifier(node)) return false;

  if (node.text === targetName) {
    const symbol = checker.getSymbolAtLocation(node);
    // `globalThis` has intrinsic compiler support: a reference to it
    // resolves to a symbol with NO `.declarations` at all regardless of
    // whether a `const globalThis = {...}` shadow precedes it (verified
    // empirically against the installed 5.9.3 package) - and that
    // "truthy symbol, empty .declarations" shape is what actually occurs
    // here, not `symbol === undefined` (also verified empirically; an
    // earlier version of this check only tested for `undefined` and
    // silently mis-classified this exact case as shadowed, regressing
    // detection of a bare, unaliased `globalThis.eval(...)` entirely).
    // Checking `declarations.length === 0` catches both possible shapes
    // uniformly. `process`/`Object` carry no such intrinsic compiler
    // support (both are declared in the synthetic globals file), so they
    // never hit this branch in practice - it exists for `globalThis`
    // specifically, and this falls back to a real lexical scope walk
    // (`hasEnclosingLocalDeclaration`) to answer the same question the
    // checker's symbol resolution could not for that one name.
    const declarations = symbol?.declarations ?? [];
    if (declarations.length === 0) {
      return targetName === "globalThis" && !hasEnclosingLocalDeclaration(node, targetName);
    }
    return isUnshadowedGlobalSymbol(symbol, checkedSourceFile);
  }

  // One-hop local alias: `node` names some OTHER local binding - check
  // whether that binding is a single const/let in this file, via either
  // its own initializer or a later bare reassignment (see this function's
  // own header comment for why both forms are checked).
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return false;
  const declarations = symbol.declarations ?? [];
  if (declarations.length !== 1) return false;
  const [decl] = declarations;
  if (!ts.isVariableDeclaration(decl)) return false;
  if (decl.getSourceFile() !== checkedSourceFile) return false;

  if (decl.initializer !== undefined) {
    const initializer = unwrapTransparentWrapper(decl.initializer);
    if (
      ts.isIdentifier(initializer) &&
      initializer.text === targetName &&
      isUnshadowedGlobalOrOneHopAlias(initializer, targetName, checker, checkedSourceFile)
    ) {
      return true;
    }
  }

  return findReassignmentAliasTarget(symbol, targetName, checker, checkedSourceFile);
}

/**
 * Scans every `<identifier> = <expr>` assignment in `checkedSourceFile`
 * for one whose LEFT side resolves (by SYMBOL IDENTITY, not text - two
 * unrelated variables that happen to share a name in different scopes
 * never collide) to `variableSymbol`, and whose RIGHT side (after
 * unwrapping) is itself a direct, unshadowed reference to `targetName`.
 * This is the bare-reassignment half of the one-hop alias check above:
 * `let g; g = globalThis;` carries no initializer for `g`'s own
 * declaration to inspect, so the acquisition is only visible by looking
 * for a later WRITE to the same binding. One hop only, matching the
 * declaration-initializer form: a reassignment FROM another alias
 * (`g = someOtherAlias`) is not chased here.
 */
function findReassignmentAliasTarget(variableSymbol, targetName, checker, checkedSourceFile) {
  let matched = false;
  forEachDescendant(checkedSourceFile, (node) => {
    if (matched) return;
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isIdentifier(node.left)
    ) {
      return;
    }
    if (checker.getSymbolAtLocation(node.left) !== variableSymbol) return;
    const rhs = unwrapTransparentWrapper(node.right);
    if (
      ts.isIdentifier(rhs) &&
      rhs.text === targetName &&
      isUnshadowedGlobalOrOneHopAlias(rhs, targetName, checker, checkedSourceFile)
    ) {
      matched = true;
    }
  });
  return matched;
}

/**
 * True for an (already unwrapped) `Identifier` node reading `globalThis`,
 * directly or through one local alias hop - see
 * `isUnshadowedGlobalOrOneHopAlias` for the shared design both this and
 * the `process` check below build on.
 */
function isUnshadowedGlobalThisReference(node, checker, checkedSourceFile) {
  return isUnshadowedGlobalOrOneHopAlias(node, "globalThis", checker, checkedSourceFile);
}

/**
 * True for an (already unwrapped) `Identifier` node reading `process`,
 * directly or through one local alias hop - see
 * `isUnshadowedGlobalOrOneHopAlias`. Unlike `globalThis`, `process` is not
 * itself banned (it is used extensively and legitimately throughout this
 * codebase) - this only tells a caller whether a BASE expression resolves
 * to the real `process`; the caller still decides which property access
 * off that base is dangerous.
 */
function isUnshadowedProcessReference(node, checker, checkedSourceFile) {
  return isUnshadowedGlobalOrOneHopAlias(node, "process", checker, checkedSourceFile);
}

/**
 * True for an (already unwrapped) `Identifier` node reading `Object`,
 * directly or through one local alias hop - see
 * `isUnshadowedGlobalOrOneHopAlias`. Needed only for the
 * `Object.getOwnPropertyDescriptor` acquisition check below: `Object`
 * itself is not banned (it is a completely ordinary, extensively used
 * global), so this only tells a caller whether a callee's base resolves to
 * the real `Object`; the caller still decides whether the specific method
 * being called off it (`getOwnPropertyDescriptor`) and its arguments amount
 * to a violation.
 */
function isUnshadowedObjectReference(node, checker, checkedSourceFile) {
  return isUnshadowedGlobalOrOneHopAlias(node, "Object", checker, checkedSourceFile);
}

/**
 * The AST node kinds that introduce their own lexical scope for a
 * `const`/`let`/`var`/function/parameter/catch-binding/for-loop
 * declaration - used only by `hasEnclosingLocalDeclaration`'s scope walk,
 * the fallback path for the one name (`globalThis`) the checker's own
 * symbol resolution cannot answer directly (see that function's own doc
 * comment for why).
 */
function isScopeBoundary(node) {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node)
  );
}

/** True when `bindingName` (a declaration's `name`, possibly a destructuring pattern) binds `name` anywhere within it. */
function bindingDeclaresName(bindingName, name) {
  if (ts.isIdentifier(bindingName)) return bindingName.text === name;
  if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
    for (const element of bindingName.elements) {
      if (ts.isBindingElement(element) && bindingDeclaresName(element.name, name)) return true;
    }
  }
  return false;
}

/**
 * True when `name` is declared DIRECTLY within `scopeNode`'s own scope -
 * its parameters (if function-like), its own catch/for-loop binding, or a
 * `const`/`let`/`var`/function/class declaration among its immediate
 * statements. Deliberately does NOT descend into a nested scope boundary
 * (that is what makes this a per-scope check rather than a whole-subtree
 * search) and does not model `var`/function hoisting through nested
 * blocks precisely - a simplification acceptable here because this is a
 * fallback for one specific, narrow shape (see
 * `isUnshadowedGlobalThisReference`), not a general-purpose binder.
 */
function scopeDeclaresName(scopeNode, name) {
  if (
    ts.isFunctionDeclaration(scopeNode) ||
    ts.isFunctionExpression(scopeNode) ||
    ts.isArrowFunction(scopeNode) ||
    ts.isMethodDeclaration(scopeNode) ||
    ts.isConstructorDeclaration(scopeNode) ||
    ts.isGetAccessorDeclaration(scopeNode) ||
    ts.isSetAccessorDeclaration(scopeNode)
  ) {
    for (const param of scopeNode.parameters) {
      if (bindingDeclaresName(param.name, name)) return true;
    }
  }
  if (ts.isCatchClause(scopeNode) && scopeNode.variableDeclaration !== undefined) {
    if (bindingDeclaresName(scopeNode.variableDeclaration.name, name)) return true;
  }
  if (
    (ts.isForStatement(scopeNode) ||
      ts.isForInStatement(scopeNode) ||
      ts.isForOfStatement(scopeNode)) &&
    scopeNode.initializer !== undefined &&
    ts.isVariableDeclarationList(scopeNode.initializer)
  ) {
    for (const decl of scopeNode.initializer.declarations) {
      if (bindingDeclaresName(decl.name, name)) return true;
    }
  }

  const statements =
    scopeNode.statements ??
    (scopeNode.body !== undefined && ts.isBlock(scopeNode.body)
      ? scopeNode.body.statements
      : undefined);
  if (statements === undefined) return false;
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (bindingDeclaresName(decl.name, name)) return true;
      }
    }
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name !== undefined &&
      statement.name.text === name
    ) {
      return true;
    }
  }
  return false;
}

/** Walks `node`'s enclosing scope chain looking for ANY declaration of `name` - see `isUnshadowedGlobalThisReference`'s doc comment for why this exists and what narrow case it covers. */
function hasEnclosingLocalDeclaration(node, name) {
  let current = node.parent;
  while (current !== undefined) {
    if (isScopeBoundary(current) && scopeDeclaresName(current, name)) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Reads a property/element access's static key text - a dotted `.foo`, or
 * a computed `["foo"]`/`["re" + "quire"]` key foldable to a literal string.
 * `undefined` for a key that can't be statically resolved (a variable, an
 * interpolated template).
 */
function accessKeyText(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return foldConstantString(node.argumentExpression);
  return undefined;
}

/**
 * Resolves a plain expression to its literal string value, extending
 * `foldConstantString`'s direct case through exactly ONE local alias hop
 * when direct folding fails: `const k = "constructor"; use(k)` folds `k` to
 * nothing on its own (`foldConstantString` only handles literals and `+`
 * concatenation, never a variable reference), even though the value is
 * exactly as statically determined as `use("constructor")` would have been
 * - `k` can only ever hold `"constructor"`. When the expression is a bare
 * Identifier resolving to a single `const`/`let` declared in THIS file with
 * a literal (or literal-foldable) initializer, this resolves through that
 * one hop. One hop only, matching this file's other one-hop alias
 * resolution (`isUnshadowedGlobalOrOneHopAlias`) - a further indirection
 * (the value itself assigned from another variable) is not chased here.
 * Shared by `resolvedAccessKeyText` below (a computed element-access key)
 * and the `Object.getOwnPropertyDescriptor` acquisition check further down
 * (an ordinary call argument, not an access key) - both need the identical
 * one-hop resolution, just applied to a different AST position.
 */
function resolveOneHopStringExpression(node, checker, checkedSourceFile) {
  const direct = foldConstantString(node);
  if (direct !== undefined) return direct;

  const unwrapped = unwrapTransparentWrapper(node);
  if (!ts.isIdentifier(unwrapped)) return undefined;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (symbol === undefined) return undefined;
  const declarations = symbol.declarations ?? [];
  if (declarations.length !== 1) return undefined;
  const [decl] = declarations;
  if (!ts.isVariableDeclaration(decl) || decl.initializer === undefined) return undefined;
  if (decl.getSourceFile() !== checkedSourceFile) return undefined;
  return foldConstantString(decl.initializer);
}

/**
 * Same as `accessKeyText`, extended to resolve a computed element-access
 * key through exactly ONE local alias hop when direct folding fails - see
 * `resolveOneHopStringExpression`'s own doc comment for the shared
 * mechanism this builds on.
 */
function resolvedAccessKeyText(node, checker, checkedSourceFile) {
  const direct = accessKeyText(node);
  if (direct !== undefined) return direct;
  if (!ts.isElementAccessExpression(node)) return undefined;
  return resolveOneHopStringExpression(node.argumentExpression, checker, checkedSourceFile);
}

/**
 * Folds a string-producing expression to its literal text, beyond
 * `stringLiteralText`'s plain-literal case: a `+` concatenation chain of
 * string literals (`"re" + "quire"`) is exactly as statically resolvable
 * as the literal it produces character-for-character, and whitespace or a
 * comment between the operands can never hide the result (neither is an
 * AST node). Returns `undefined` for anything genuinely dynamic - a
 * non-literal operand, any other operator, a template with interpolation.
 */
function foldConstantString(node) {
  if (node === undefined) return undefined;
  const unwrapped = unwrapTransparentWrapper(node);
  const direct = stringLiteralText(unwrapped);
  if (direct !== undefined) return direct;
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = foldConstantString(unwrapped.left);
    const right = foldConstantString(unwrapped.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

/**
 * Finds every NAMED LEXICAL ACQUISITION in `sourceFile` of `createRequire`
 * (or the `node:module` namespace it lives on), of Node's per-module
 * `module.require`, or of the global `eval`/`Function`/`require` - resolved
 * by PROVENANCE (what a reference actually traces back to, via real
 * TypeScript symbol/scope resolution for the four bare-global names, and
 * via specifier analysis for the `node:module`-sourced import forms), never
 * by matching one fixed spelling or invocation shape.
 *
 * SCOPE, STATED PRECISELY (see "OUT OF SCOPE" below before reading this as
 * a completeness claim it is not): this function is built to close a
 * route that acquires one of these primitives through a LEXICAL REFERENCE
 * to its own name, or through an IMPORT of `"node:module"`/`"module"` by
 * specifier - including through a local alias, a destructure, a
 * `globalThis` qualification, or an indirect-invocation form standing
 * between the acquisition and any eventual use, for every SPECIFIC shape
 * enumerated and verified below. This is deliberately NOT stated as
 * "every possible shape": JavaScript/TypeScript's scoping and
 * destructuring grammar is large, and a claim of exhaustive coverage over
 * all of it is a claim this AST walk cannot back - the honest claim is
 * "these verified shapes close, and a shape outside this list may not."
 * It does NOT and CANNOT close a route that reaches the same capability
 * WITHOUT ever naming it or importing its module at all - see "OUT OF
 * SCOPE" below for the concrete forms this guard is currently verified
 * NOT to catch, on purpose, with the boundary enforced by dedicated tests
 * rather than left as a sentence in this comment. That list has already
 * been revised once (two forms it originally named were closed by
 * treating them as acquisition sites too, the same way as the four bare
 * globals), so it is stated as the CURRENT known boundary, not a claim
 * that no further form will ever be found.
 *
 * THE ACQUISITION-SITE DESIGN, AND WHY NOT INVOCATION SHAPE. Matching one
 * callee spelling at a time, then a hand-built alias map tracking local
 * aliases, destructures, `.call`/`.apply`, `Reflect.apply`/`construct`,
 * and comma-operator indirection, cannot terminate: invocation shape is
 * an infinite space
 * (closing `.call` leaves `.bind` open, closing `.bind` leaves storage in
 * an object open, and so on indefinitely), so it can only ever be
 * incomplete by one more form. The fix is to reject the primitive at its
 * ACQUISITION site instead: a runtime reference that resolves to the true
 * global `eval`,
 * `Function`, or `require`, or to Node's `module` global (from which
 * `.require` is reachable), IS ITSELF the violation - whether it is
 * called, stored, passed, returned, bound, or never used again. Once the
 * BARE REFERENCE is flagged, every downstream invocation shape disappears
 * from the problem: there is nothing left to enumerate, because the
 * violation already happened before any wrapping syntax could matter.
 *
 * This is implemented with real TypeScript symbol resolution
 * (`createScopeCheckedProgram` builds a `ts.Program` + `TypeChecker` over
 * the file under test plus a five-line synthetic globals file), not name
 * matching: an `Identifier` named `eval`/`Function`/`require`/`module`, in
 * a genuine value-reference position (`isValueReferenceCandidate` excludes
 * declaration names, property/method keys, and type positions), is a
 * violation exactly when its resolved symbol's declarations sit OUTSIDE
 * the file under test (`isUnshadowedGlobalSymbol`) - i.e. it resolves to
 * the synthetic global, not to a real local `const`/`let`/parameter/
 * import/class/catch-binding/for-loop declaration in THIS file. This is
 * what makes a locally shadowed or imported harmless name of the same text
 * stay green (`const Function = () => "safe"; Function()` never reads the
 * real constructor) without needing to special-case a single invocation
 * shape - `.bind(...)`, storage in an object, passing as an argument, and
 * every other downstream use of an UNSHADOWED reference are simply
 * ordinary value-reference positions this same check already covers.
 *
 * Every shape below was verified empirically - either by parsing and
 * inspecting the resulting node shape (the import forms, against the
 * installed 5.9.3 package), or by running the real symbol-resolution check
 * against a battery of fixtures (the acquisition forms, including every
 * green control: a locally shadowed name, a parameter binding, an
 * import-aliased shadow, an unrelated object's own property, and a
 * type-only reference):
 *
 *   - STATIC import - `import { createRequire } from "node:module"` (named,
 *     aliased or not), `import * as mod from "node:module"` (namespace),
 *     `import mod from "node:module"` (default - verified empirically to
 *     ALSO expose `createRequire` as a property, same as namespace), or a
 *     bare side-effect `import "node:module"` (carries no binding at all -
 *     nothing to flag). A named specifier's real imported name is
 *     `specifier.propertyName ?? specifier.name`, which is the true source
 *     name regardless of a local alias.
 *   - DYNAMIC import - `import("node:module")` - a `CallExpression` whose
 *     `expression` is the bare `import` keyword. Flagged at the call
 *     itself, uniformly covering every consumption shape verified
 *     empirically to produce the identical call node: awaited and
 *     destructured (`const { createRequire: x } = await import(...)`),
 *     awaited into a bare namespace variable, and `.then(m => ...)` -
 *     because all three share the same underlying `import("node:module")`
 *     call node, flagging that one node closes all three without needing
 *     to trace what the result is later assigned or destructured into.
 *   - TS import-equals - `import moduleCrate = require("node:module")` - an
 *     `ImportEqualsDeclaration` whose `moduleReference` is an
 *     `ExternalModuleReference` wrapping the specifier. Binds the whole
 *     `node:module` namespace to `moduleCrate`, exposing `createRequire`
 *     exactly as a default/namespace import would.
 *   - RE-EXPORT - `export { createRequire as exportedBridge } from
 *     "node:module"` (named, resolved the same `propertyName ?? name` way
 *     as an import), `export * from "node:module"` (wildcard - exposes
 *     `createRequire` transitively the same as a namespace import, so
 *     flagged the same way, outright), and `export * as ns from
 *     "node:module"` (namespace re-export - same reasoning).
 *   - GLOBAL `eval` / `Function` / `require` - flagged at ANY unshadowed
 *     value-reference position, unconditionally on what is done with the
 *     reference: called directly, called via `.call`/`.apply`/`.bind`,
 *     called via `Reflect.apply`/`Reflect.construct`, reached through the
 *     classic comma-operator indirection (`(0, eval)`), reached via
 *     `globalThis.eval`/`globalThis["eval"]`, aliased through any number of
 *     local `const`/`let` hops, stored in an object or array, passed as an
 *     argument, or never invoked at all.
 *   - GLOBAL `module` (and therefore `module.require`, its only relevant
 *     property) - flagged the same unconditional way as the other three,
 *     including through `globalThis.module`/`globalThis["module"]`. This
 *     is broader than "flag only `.require` access off `module`" on
 *     purpose: the codebase's frozen architecture has zero legitimate
 *     reason to reference the CommonJS `module` global for ANY purpose
 *     (verified: the real `src/` tree contains no reference to it at all),
 *     and flagging the bare reference is what lets the alias/destructure
 *     case (`const alias = module; alias.require(...)`) close via the same
 *     acquisition-site principle as the other three, instead of needing a
 *     dedicated two-step "traces to module, AND accesses .require" check.
 *   - `process`'s dangerous properties - a FIFTH acquisition site, narrower
 *     in shape than the four bare globals above: unlike them, bare
 *     `process` is NOT flagged (it is used extensively and legitimately
 *     throughout this codebase), only three specific properties are -
 *     `getBuiltinModule`, `dlopen`, and `binding` (`PROCESS_DANGEROUS_
 *     PROPERTIES`, a three-name set - `dlopen`/`binding` were added
 *     alongside the one-hop alias support below, closing the sibling
 *     acquisition routes that banning `getBuiltinModule` alone left open)
 *     - resolved the same PropertyAccessExpression/ElementAccessExpression
 *     + static-key-text machinery this file already uses for
 *     `globalThis.eval`-shaped access, just applied to a different
 *     unshadowed base identifier and a three-name dangerous-key set.
 *     `process.getBuiltinModule("node:module").createRequire(...)` is
 *     flagged at the `process.getBuiltinModule` property-access itself -
 *     the same acquisition-site principle as the other four, so storage,
 *     aliasing, or any invocation shape downstream of that reference is
 *     already covered without a separate check. `process`'s base is now
 *     resolved through exactly one local alias hop too, the same as
 *     `globalThis` (`const p = process; p.getBuiltinModule(...)`, and
 *     `let p; p = process; p.getBuiltinModule(...)` - a bare reassignment
 *     with no initializer of its own is exactly as real an alias as one
 *     with an initializer, and is followed the same way). A COMPUTED, non-
 *     statically-foldable key on an unshadowed `process` base
 *     (`process[someComputedExpr]`) FAILS CLOSED the same way an
 *     unresolvable `globalThis[...]` access does, verified against the
 *     real `src/` tree, which contains zero computed access on `process`
 *     of any kind today.
 *
 *   - GLOBAL `Reflect` - flagged the same unconditional way as `module`:
 *     the codebase's frozen architecture has zero legitimate reason to
 *     reference `Reflect` for ANY purpose (verified: the real `src/` tree
 *     contains no reference to it at all), so the bare reference is
 *     banned outright rather than trying to enumerate which of its many
 *     methods (`.get`, `.apply`, `.construct`, `.defineProperty`, and
 *     more) could reach a forbidden primitive - `Reflect.get(globalThis,
 *     "eval")` is caught here, at the `Reflect` reference itself, not by
 *     recognizing that specific call shape.
 *   - `.constructor` PROPERTY ACCESS - flagged UNCONDITIONALLY, on ANY
 *     base expression, not just an unshadowed global's. Unlike every
 *     other check in this function, there is no "is the base a real
 *     global" question to ask first: every value in JavaScript carries a
 *     `.constructor` reachable off its own prototype chain regardless of
 *     where it came from, so `(() => 1).constructor` reaches `Function`
 *     with no identifier named `Function`, no import, and no globalThis
 *     qualification anywhere in source - a genuinely different
 *     acquisition SHAPE than every check above it, closed by treating the
 *     PROPERTY ITSELF, universally, as the violation (the same "zero
 *     legitimate use, ban the whole surface" reasoning as `module` and
 *     `Reflect`, just applied to a property key instead of a global
 *     identifier - verified: the real `src/` tree contains no
 *     `.constructor` access of any kind). Two further spellings of this
 *     same unconditional-on-base access are closed the same way, each
 *     independently, since the ban is on the KEY, not the syntax that
 *     names it: a COMPUTED key foldable to the literal string
 *     `"constructor"` through one local alias hop (`const k =
 *     "constructor"; obj[k]` - `accessKeyText` alone folds only a literal
 *     or `+`-concatenated key, never a variable reference, even though `k`
 *     can only ever hold that one string; `resolvedAccessKeyText` extends
 *     it through that one hop, mirroring `isUnshadowedGlobalOrOneHopAlias`'s
 *     own one-hop discipline), and DESTRUCTURING the property directly off
 *     any source (`const { constructor: F } = anything`, `({ constructor:
 *     F } = anything)`) - both checked unconditionally on their own source
 *     expression, before any globalThis/process-specific destructuring
 *     check runs, for the identical reason the direct property-access
 *     form is unconditional on its base.
 *   - A CAST OR NON-NULL ASSERTION sitting directly on an acquisition base
 *     no longer defeats symbol resolution: `globalThis!.eval(x)` and
 *     `(globalThis as typeof globalThis).eval(x)` both walked straight
 *     through an earlier version of this file, because unwrapping only
 *     stripped parentheses (`unwrapParens`) - a `NonNullExpression` or an
 *     `AsExpression`/`SatisfiesExpression` changed the base node's shape
 *     from a bare `Identifier` to a wrapper node every base-expression
 *     check here requires seeing PAST before it will even attempt symbol
 *     resolution. `unwrapParens` is now `unwrapTransparentWrapper`, a
 *     general unwrapper for all four syntax layers that are erased at
 *     TypeScript emit and change nothing about which value an expression
 *     reads at runtime - parentheses, a non-null assertion, an `as` cast,
 *     and a `satisfies` clause, in any combination and order.
 *   - AN AMBIENT `declare` SHADOW does not actually shadow at runtime:
 *     `declare const Reflect: {...}; Reflect.get(globalThis, "eval")`
 *     type-checks as though `Reflect` were declared locally, but `declare`
 *     is TypeScript-only and emits no runtime binding whatsoever - the
 *     compiled reference is the real global. `isUnshadowedGlobalSymbol`
 *     now treats an in-file declaration as a real shadow only when it
 *     actually EMITS (`isAmbientDeclaration` checks for the `Ambient`
 *     modifier flag), so a genuine local `const`/`let`/parameter/import
 *     still shadows exactly as before, and only the ambient, erased case
 *     falls through to the true global.
 *
 * WHY THESE TWO ARE HERE NOW, NOT DOCUMENTED AS OUT OF SCOPE: an earlier
 * version of this guard treated `process.getBuiltinModule`, `.constructor`,
 * and `Reflect.get(globalThis, "eval")` as equally out of scope, reasoning
 * that all three "reach the same capability WITHOUT a lexical reference to
 * its name or a `"node:module"` import specifier." That framing was
 * incomplete: closing `process.getBuiltinModule` alone left `.constructor`
 * and `Reflect` as UNCLOSED escape routes into the exact same reflective/
 * structural acquisition class it was trying to close - fixing one
 * demonstrated route while leaving the class it belongs to open would have
 * re-manufactured the appearance of closure without delivering it, the
 * same failure mode this file's own prior version warned against.
 * The actual fix is not "pattern-match `(() => 1).constructor` and
 * `Reflect.get(globalThis, "eval")` as two more named spellings" - that
 * would ITSELF be vacuous, since the next unenumerated form in the same
 * class (`Reflect.apply`, `Reflect.construct`, `[].constructor`,
 * `obj.constructor.constructor`) would still walk straight through. The
 * fix that actually closes the class is banning the ACQUISITION SURFACE
 * outright: the whole `Reflect` global (any method, any invocation shape,
 * matching how `module` is banned outright rather than just
 * `module.require`), and the `.constructor` property universally (any
 * base, matching the same "the codebase has zero legitimate use" evidence
 * standard already established for `module` and now `Reflect`). Both are
 * NOW covered by the acquisition-site design's core claim - "once the BARE
 * REFERENCE is flagged, every downstream invocation shape disappears from
 * the problem" - the same guarantee `eval`/`Function`/`require`/`module`
 * already had, extended to two more surfaces this file can resolve by
 * provenance (a real lexical reference for `Reflect`, a real static
 * property key for `.constructor`) rather than by name-matching an
 * invocation shape.
 *
 * OUT OF SCOPE, DELIBERATELY, NOT BY OVERSIGHT: a statement-level
 * `import type`/`export type` declaration or an individual specifier
 * carrying the inline `type` modifier (fully erased by TypeScript, carries
 * no runtime capability under any of the shapes above); and a `typeof X`
 * used AS A TYPE (`type T = typeof eval`, erased the same way - contrast
 * with `typeof eval === "function"`, a genuine runtime reference this
 * guard DOES flag). Closing `Reflect` and `.constructor` outright - rather
 * than pattern-matching one demonstrated combination of them - removed
 * the specific class those two belonged to, not the open-ended reflective/
 * structural category itself: `Object.getOwnPropertyDescriptor` reaching
 * the same primitives via a property-descriptor read was a further,
 * independently-discovered form in that category, and IS now closed here
 * too (the `property-descriptor-access` acquisition check above) - the
 * category is not claimed exhausted by closing this one further form
 * either. This file does not claim the reflective/structural category is
 * exhausted, and per the reasoning above (a fixed list of named spellings
 * is never the boundary itself), it never will - a newly demonstrated
 * route is a reason to extend this function's real coverage, not evidence
 * that the prior extension failed.
 *
 * SPECIFIER COMPARISON IS ALSO NOT YET RESOLVER-BASED: every import/
 * dynamic-import/re-export branch above decides whether a specifier reaches
 * `"node:module"` by checking its literal text against
 * `MODULE_BUILTIN_SPECIFIERS`, a two-entry string set - not by running the
 * specifier through a real module resolver and comparing the resolved,
 * canonical module identity the way `isUnshadowedGlobalSymbol` does for the
 * four bare globals. That is string/path arithmetic, not resolver-based
 * comparison, and it means an absolute specifier, a `file://` URL
 * specifier, or a specifier reaching the same builtin through a resolver
 * alias or path-mapping entry is not detected here even though it resolves
 * to the identical module at runtime. Closing that gap needs the same kind
 * of provenance-based resolution this function already uses for the four
 * bare globals, applied to specifiers instead of identifiers - it is not
 * done yet.
 *
 * A MIXED import clause (a value specifier next to a type-only one in the
 * same clause) still flags the value specifier - the type modifier is
 * checked per-specifier, never treated as clearing the whole clause.
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {{ node: import("typescript").Node, kind: "named" | "namespace" | "default" | "dynamic-import" | "import-equals" | "commonjs-require" | "module-require" | "eval-call" | "function-constructor-call" | "re-export-named" | "re-export-namespace" | "unresolvable-globalthis-access" | "process-dangerous-property-access" | "unresolvable-process-access" | "reflect-reference" | "constructor-property-access" | "property-descriptor-access" }[]}
 */
export function findCreateRequireImports(sourceFile) {
  const hits = [];
  const { sourceFile: checkedSourceFile, checker } = createScopeCheckedProgram(
    sourceFile.fileName,
    sourceFile.text
  );
  forEachDescendant(checkedSourceFile, (node) => {
    // --- Static import ---
    if (ts.isImportDeclaration(node)) {
      const specifierText = stringLiteralText(node.moduleSpecifier);
      if (specifierText === undefined || !MODULE_BUILTIN_SPECIFIERS.has(specifierText)) return;

      const importClause = node.importClause;
      if (importClause === undefined) return; // bare side-effect import - no binding at all

      // A statement-level `import type ...` is fully erased by TypeScript -
      // it emits nothing, produces no binding at runtime, and cannot yield
      // a callable loader under any of the shapes below. The unit of
      // analysis is a binding that CAN COME TO HOLD the runtime capability;
      // this one provably cannot, so the whole declaration is out of scope,
      // not just skipped-and-fallen-through (flagging it would be
      // over-blocking, a failure in its own right - not just a false
      // negative to avoid, a false positive to avoid).
      if (importClause.isTypeOnly) return;

      if (importClause.name !== undefined) {
        hits.push({ node: importClause, kind: "default" });
      }

      const namedBindings = importClause.namedBindings;
      if (namedBindings === undefined) return;

      if (ts.isNamespaceImport(namedBindings)) {
        hits.push({ node: namedBindings, kind: "namespace" });
        return;
      }

      if (ts.isNamedImports(namedBindings)) {
        for (const specifier of namedBindings.elements) {
          // The INLINE per-specifier form - `import { type createRequire }
          // from "..."` - erases that one binding the same way the
          // statement-level form erases the whole declaration, even though
          // the import statement itself may survive (a side-effect import
          // of the builtin). A MIXED clause - `import { createRequire,
          // type Something }` - must still flag the value specifier next
          // to a type-only one: this check is per-specifier, never
          // suppressed by another specifier's modifier in the same clause.
          if (specifier.isTypeOnly) continue;
          const importedName = (specifier.propertyName ?? specifier.name).text;
          if (importedName === "createRequire") {
            hits.push({ node: specifier, kind: "named" });
          }
        }
      }
      return;
    }

    // --- Re-export: named, wildcard, or namespace ---
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifierText = stringLiteralText(node.moduleSpecifier);
      if (specifierText === undefined || !MODULE_BUILTIN_SPECIFIERS.has(specifierText)) return;

      // Same erasure reasoning as the import side: a statement-level
      // `export type { ... } from "..."` (or `export type * from "..."`)
      // is fully erased and hands off no runtime capability to whatever
      // imports the re-exported name.
      if (node.isTypeOnly) return;

      const exportClause = node.exportClause;
      if (exportClause === undefined) {
        // `export * from "node:module"` - wildcard re-export, exposes
        // createRequire transitively the same as a namespace import.
        hits.push({ node, kind: "re-export-namespace" });
        return;
      }
      if (ts.isNamespaceExport(exportClause)) {
        // `export * as ns from "node:module"` - same reasoning.
        hits.push({ node: exportClause, kind: "re-export-namespace" });
        return;
      }
      if (ts.isNamedExports(exportClause)) {
        for (const specifier of exportClause.elements) {
          // Same per-specifier inline-type-modifier erasure as the import
          // side, and the same mixed-clause rule: never suppressed by a
          // sibling specifier's modifier.
          if (specifier.isTypeOnly) continue;
          const reExportedFromName = (specifier.propertyName ?? specifier.name).text;
          if (reExportedFromName === "createRequire") {
            hits.push({ node: specifier, kind: "re-export-named" });
          }
        }
      }
      return;
    }

    // --- Dynamic import: import("node:module"), any consumption shape ---
    if (isDynamicImportCall(node)) {
      const [firstArg] = node.arguments;
      const specifierText = firstArg ? stringLiteralText(firstArg) : undefined;
      if (specifierText !== undefined && MODULE_BUILTIN_SPECIFIERS.has(specifierText)) {
        hits.push({ node, kind: "dynamic-import" });
      }
      return;
    }

    // --- TS import-equals: import X = require("node:module") ---
    if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ref !== undefined && ts.isExternalModuleReference(ref)) {
        const specifierText = stringLiteralText(ref.expression);
        if (specifierText !== undefined && MODULE_BUILTIN_SPECIFIERS.has(specifierText)) {
          hits.push({ node, kind: "import-equals" });
        }
      }
      return;
    }

    // --- Object.getOwnPropertyDescriptor(target, key) - a DESCRIPTOR READ
    // reaches the same value a direct property access would (an accessor
    // descriptor's `.get`, or a data descriptor's `.value`), without ever
    // writing the target's key as a real PropertyAccessExpression/
    // ElementAccessExpression AST node at all - every check above this one
    // resolves a dangerous key off an ACCESS node's own base/key fields,
    // and a descriptor call has neither: `target` and `key` are ordinary
    // call arguments, so this needs its own recognition rather than
    // falling out of the access-based checks for free. `Object` is
    // resolved the same unshadowed-global-or-one-hop-alias way as
    // `globalThis`/`process` (`isUnshadowedObjectReference`) so a locally
    // shadowed `Object` stays green; the call's own callee key
    // (`getOwnPropertyDescriptor`, dotted or computed) is resolved via
    // `resolvedAccessKeyText`, the same machinery every other property
    // access in this file already uses. Once confirmed to be a real
    // `Object.getOwnPropertyDescriptor` call, the SAME dangerous-key
    // reasoning already applied to a direct access is applied to the
    // call's OWN two arguments instead of an access node's base/key: the
    // key argument is resolved through one alias hop
    // (`resolveOneHopStringExpression`, the same as a computed access
    // key), and is UNCONDITIONALLY a violation when it folds to
    // `"constructor"` (matching the direct `.constructor` check's own
    // unconditional-on-base reasoning - a descriptor read cannot make a
    // universally-dangerous property any safer than a direct read would
    // have been), or a violation when the TARGET argument resolves to the
    // real unshadowed `globalThis`/`process` and the key names one of
    // their own respective dangerous keys (or is unresolvable, failing
    // closed the same way an unresolvable direct access does). This is
    // flagged at the CALL itself, unconditional on whether the returned
    // descriptor's `.value`/`.get` is ever actually extracted - the same
    // acquisition-site principle as every other check in this function. ---
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        resolvedAccessKeyText(callee, checker, checkedSourceFile) === "getOwnPropertyDescriptor" &&
        isUnshadowedObjectReference(
          unwrapTransparentWrapper(callee.expression),
          checker,
          checkedSourceFile
        )
      ) {
        const [targetArg, keyArg] = node.arguments;
        const key =
          keyArg !== undefined
            ? resolveOneHopStringExpression(keyArg, checker, checkedSourceFile)
            : undefined;

        if (key === CONSTRUCTOR_PROPERTY_NAME) {
          hits.push({ node, kind: "property-descriptor-access" });
          return;
        }

        const targetBase =
          targetArg !== undefined ? unwrapTransparentWrapper(targetArg) : undefined;
        if (
          targetBase !== undefined &&
          isUnshadowedGlobalThisReference(targetBase, checker, checkedSourceFile) &&
          (key === undefined || FORBIDDEN_GLOBAL_NAMES.has(key))
        ) {
          hits.push({ node, kind: "property-descriptor-access" });
          return;
        }
        if (
          targetBase !== undefined &&
          isUnshadowedProcessReference(targetBase, checker, checkedSourceFile) &&
          (key === undefined || PROCESS_DANGEROUS_PROPERTIES.has(key))
        ) {
          hits.push({ node, kind: "property-descriptor-access" });
          return;
        }
      }
    }

    // --- ACQUISITION SITE: the global `eval` / `Function` / `require` /
    // `module` - flagged at any unshadowed VALUE-REFERENCE position,
    // unconditionally on what happens to the reference afterward. This is
    // the whole point of the acquisition-site design (see this function's
    // own header comment): a `.call`/`.apply`/`.bind`/`Reflect.apply`/
    // `Reflect.construct` invocation, a comma-operator indirection, an
    // alias chain of any length, storage in an object/array, or passing as
    // an argument are all just ordinary value-reference positions this one
    // check already covers - none of them need their own special case. ---
    if (ts.isIdentifier(node) && FORBIDDEN_GLOBAL_NAMES.has(node.text)) {
      if (!isValueReferenceCandidate(node)) return;
      const symbol = checker.getSymbolAtLocation(node);
      // An unresolved symbol for one of these four specific names should
      // not happen (all four are always declared in the synthetic globals
      // file), but fails CLOSED rather than silently passing if it ever
      // does - consistent with this guard's fail-closed posture elsewhere.
      if (symbol === undefined || isUnshadowedGlobalSymbol(symbol, checkedSourceFile)) {
        hits.push({ node, kind: GLOBAL_NAME_TO_KIND[node.text] });
      }
      return;
    }

    // --- globalThis.eval / globalThis["Function"] / globalThis.module /
    // globalThis["require"] - `globalThis` bypasses lexical scoping by
    // design (that is its entire purpose), so its property key ALONE -
    // resolved dotted or computed/foldable, same as every other property
    // access in this file - tells us definitively whether this reaches one
    // of the four forbidden globals, with no need for a separate
    // property-symbol lookup. A computed key that can't be resolved
    // (`globalThis[someComputedExpr]`) FAILS CLOSED: this guard cannot
    // prove it does NOT reach one of the four, so it is flagged rather
    // than silently passed. ---
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = unwrapTransparentWrapper(node.expression);

      // --- .constructor - see CONSTRUCTOR_PROPERTY_NAME's own doc
      // comment. Checked FIRST and unconditionally on the base
      // expression, before the globalThis/process-specific checks below:
      // every value carries this property regardless of where it came
      // from, so there is no "is the base the real global" question to
      // ask first the way the other two checks below need to.
      //
      // Uses `resolvedAccessKeyText`, not plain `accessKeyText` - so
      // `const k = "constructor"; obj[k]` is caught the same way
      // `obj["constructor"]` already is: the key is exactly as statically
      // determined in both cases, one is just spelled through a one-hop
      // local alias. ---
      if (resolvedAccessKeyText(node, checker, checkedSourceFile) === CONSTRUCTOR_PROPERTY_NAME) {
        hits.push({ node, kind: "constructor-property-access" });
        return;
      }

      if (isUnshadowedGlobalThisReference(base, checker, checkedSourceFile)) {
        const key = resolvedAccessKeyText(node, checker, checkedSourceFile);
        if (key === undefined) {
          hits.push({ node, kind: "unresolvable-globalthis-access" });
          return;
        }
        if (FORBIDDEN_GLOBAL_NAMES.has(key)) {
          hits.push({ node, kind: GLOBAL_NAME_TO_KIND[key] });
        }
        return;
      }

      // --- process.getBuiltinModule / process.dlopen / process.binding
      // (dotted or computed, direct or through one local alias hop) - see
      // PROCESS_DANGEROUS_PROPERTIES's own doc comment for why bare
      // `process` is not flagged the way the four globals above are, and
      // why these three properties are. `isUnshadowedProcessReference`
      // (not a literal `base.text === "process"` check) is what makes
      // `const p = process; p.getBuiltinModule(...)` resolve the same as
      // `process.getBuiltinModule(...)` - the one-hop alias case this
      // check previously missed. A computed, non-statically-foldable key
      // on an unshadowed `process` base fails closed the same way an
      // unresolvable `globalThis[...]` access does above - this guard
      // cannot prove it does NOT reach one of the three. ---
      if (isUnshadowedProcessReference(base, checker, checkedSourceFile)) {
        const key = resolvedAccessKeyText(node, checker, checkedSourceFile);
        if (key === undefined) {
          hits.push({ node, kind: "unresolvable-process-access" });
          return;
        }
        if (PROCESS_DANGEROUS_PROPERTIES.has(key)) {
          hits.push({ node, kind: "process-dangerous-property-access" });
        }
        return;
      }

      return;
    }

    // --- DESTRUCTURING straight off the real, unshadowed globalThis is an
    // acquisition of whatever property it pulls out - `const { eval } =
    // globalThis` genuinely reads the global eval the same way
    // `globalThis.eval` does. This is a SEPARATE, dedicated check from the
    // bare-identifier walk above: a destructuring KEY is never a value-
    // reference candidate on its own (`isValueReferenceCandidate` excludes
    // a BindingElement's `propertyName` uniformly, since MOST destructuring
    // sources are ordinary objects where a same-named key means nothing -
    // `const { eval: localEval } = safe` must stay green regardless of what
    // `safe` is) - the acquisition only exists when the SOURCE being
    // destructured is confirmed to be the real globalThis, resolved the
    // same provenance-based way every other check in this function works.
    // Scoped to TOP-LEVEL destructuring off a KNOWN initializer - a
    // `VariableDeclaration`'s own `.initializer` (`const { eval } =
    // globalThis`), OR a `Parameter`'s own DEFAULT value, which uses the
    // exact same `.initializer` field for a different purpose
    // (`function f({ eval } = globalThis)` - the default fires whenever
    // the caller omits the argument, so it is exactly as real an
    // acquisition as a variable declaration's initializer, not a
    // hypothetical). A nested pattern (`const { a: { eval: x } } = obj`)
    // is out of scope, not by oversight: `obj.a` is an arbitrary value,
    // never provably globalThis itself. A catch clause's destructuring
    // pattern (or a parameter with NO default) has no initializer at all
    // to check against, so it falls through this check untouched -
    // correctly green regardless of key spelling. ---
    if (ts.isObjectBindingPattern(node)) {
      // --- .constructor via destructuring - `const { constructor: F } =
      // anything` - UNCONDITIONAL on the destructuring source, the same
      // way the property-access .constructor check above is unconditional
      // on its base: every value carries a .constructor property
      // regardless of where it came from, so there is no "is the source
      // the real global" question to ask first. Runs for every
      // ObjectBindingPattern regardless of whether it has a known
      // initializer at all (a catch clause, a parameter with no default -
      // the destructuring PATTERN itself names "constructor" as the key to
      // pull, independent of what the runtime source turns out to be). ---
      for (const element of node.elements) {
        if (element.dotDotDotToken) continue;
        if (bindingElementSourceKeyText(element) === CONSTRUCTOR_PROPERTY_NAME) {
          hits.push({ node: element, kind: "constructor-property-access" });
        }
      }

      const parent = node.parent;
      const hasKnownInitializer =
        (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) &&
        parent.initializer !== undefined;
      if (hasKnownInitializer) {
        const source = unwrapTransparentWrapper(parent.initializer);
        if (isUnshadowedGlobalThisReference(source, checker, checkedSourceFile)) {
          for (const element of node.elements) {
            if (element.dotDotDotToken) continue; // a rest element carries no single source key
            const key = bindingElementSourceKeyText(element);
            if (key === undefined) {
              hits.push({ node: element, kind: "unresolvable-globalthis-access" });
              continue;
            }
            if (FORBIDDEN_GLOBAL_NAMES.has(key)) {
              hits.push({ node: element, kind: GLOBAL_NAME_TO_KIND[key] });
            }
          }
        }
        // --- `const { getBuiltinModule } = process` (direct or one-hop
        // alias) - the same destructuring-is-an-acquisition reasoning as
        // globalThis above, applied to process's dangerous properties. ---
        if (isUnshadowedProcessReference(source, checker, checkedSourceFile)) {
          for (const element of node.elements) {
            if (element.dotDotDotToken) continue;
            const key = bindingElementSourceKeyText(element);
            if (key === undefined) {
              hits.push({ node: element, kind: "unresolvable-process-access" });
              continue;
            }
            if (PROCESS_DANGEROUS_PROPERTIES.has(key)) {
              hits.push({ node: element, kind: "process-dangerous-property-access" });
            }
          }
        }
      }
      return;
    }

    // --- The ASSIGNMENT-destructuring form of the same acquisition -
    // `({ eval: execute } = globalThis)` - parses its LEFT side as an
    // `ObjectLiteralExpression` rather than an `ObjectBindingPattern`
    // (TypeScript's grammar reuses object-literal syntax for a
    // destructuring ASSIGNMENT target, distinguished only by appearing on
    // the left of a plain `=`), so it needs the same "source resolves to
    // the real globalThis" check applied to a structurally different node
    // shape. ---
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(node.left)
    ) {
      // --- .constructor via assignment-destructuring - `({ constructor: F
      // } = anything)` - unconditional on the source, same reasoning as
      // the binding-pattern form above. ---
      for (const property of node.left.properties) {
        if (objectLiteralDestructurePropertyKeyText(property) === CONSTRUCTOR_PROPERTY_NAME) {
          hits.push({ node: property, kind: "constructor-property-access" });
        }
      }

      const source = unwrapTransparentWrapper(node.right);
      if (isUnshadowedGlobalThisReference(source, checker, checkedSourceFile)) {
        for (const property of node.left.properties) {
          const key = objectLiteralDestructurePropertyKeyText(property);
          if (key === undefined) {
            hits.push({ node: property, kind: "unresolvable-globalthis-access" });
            continue;
          }
          if (FORBIDDEN_GLOBAL_NAMES.has(key)) {
            hits.push({ node: property, kind: GLOBAL_NAME_TO_KIND[key] });
          }
        }
      }
      if (isUnshadowedProcessReference(source, checker, checkedSourceFile)) {
        for (const property of node.left.properties) {
          const key = objectLiteralDestructurePropertyKeyText(property);
          if (key === undefined) {
            hits.push({ node: property, kind: "unresolvable-process-access" });
            continue;
          }
          if (PROCESS_DANGEROUS_PROPERTIES.has(key)) {
            hits.push({ node: property, kind: "process-dangerous-property-access" });
          }
        }
      }
    }
  });
  return hits;
}

/**
 * Reads a static property/binding key's text - a plain `Identifier`, a
 * string literal, or a computed key foldable to a literal string
 * (`["eval"]`, `["ev" + "al"]`). `undefined` for anything else (a
 * numeric-literal key, which can never match one of the four forbidden
 * names anyway, or a genuinely dynamic computed key).
 */
function staticPropertyKeyText(key) {
  if (key === undefined) return undefined;
  if (ts.isIdentifier(key)) return key.text;
  if (ts.isStringLiteralLike(key)) return key.text;
  if (ts.isComputedPropertyName(key)) return foldConstantString(key.expression);
  return undefined;
}

/**
 * Reads a `BindingElement`'s source property key - the name it destructures
 * OFF the right-hand object, which is `element.propertyName` when the
 * binding renames (`{ eval: localEval }`) or `element.name` itself when it
 * doesn't (`{ eval }`, shorthand - `undefined` here only if `.name` is
 * itself a nested pattern, out of scope). `undefined` for a computed key
 * that can't be statically resolved.
 */
function bindingElementSourceKeyText(element) {
  if (element.propertyName !== undefined) return staticPropertyKeyText(element.propertyName);
  return ts.isIdentifier(element.name) ? element.name.text : undefined;
}

/**
 * Reads the source key an `ObjectLiteralExpression` property denotes when
 * that object literal is being used as an ASSIGNMENT-destructuring
 * target - a named `PropertyAssignment` (`{ eval: execute }`, key is
 * `.name`) or a shorthand `ShorthandPropertyAssignment` (`{ eval }`, the
 * identifier IS the key). `undefined` for a spread element (no single
 * source key) or a shape that can't appear in a real destructuring target
 * (a method/accessor - included only for exhaustiveness, since a genuine
 * destructuring assignment's grammar never produces one).
 */
function objectLiteralDestructurePropertyKeyText(property) {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  if (ts.isPropertyAssignment(property)) return staticPropertyKeyText(property.name);
  return undefined;
}

export { ts };
