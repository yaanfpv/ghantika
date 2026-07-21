#!/usr/bin/env node
/**
 * Guards against a documented or scripted install step regressing from
 * `npm ci` to `npm install` (or its `npm i` shorthand alias). The
 * package-lock.json in this repo is meant to be the single source of
 * truth for the dependency tree, so every gate, script, or CI step that
 * installs dependencies has to use `npm ci` (which installs exactly what
 * the lockfile says and fails if the lockfile and package.json disagree)
 * rather than `npm install`/`npm i` (which can silently update the
 * lockfile).
 *
 * Only actual command text is checked - a fenced or indented code block
 * in a markdown file, any string value in a JSON file (not just
 * package.json's "scripts" - see findForbiddenInJsonValues), the raw text
 * of a script/workflow file, or a programmatic
 * execFileSync/spawnSync/spawn("npm", [...]) call in JS/TS source (see
 * findForbiddenChildProcessNpmCalls) - not ordinary prose, so a sentence
 * that *talks about* `npm install` (like the one in this repo's README
 * explaining why not to use it) doesn't trip the guard.
 *
 * Every permitted gate surface is scanned, not a fixed file list: the
 * always-present baseline docs (DEFAULT_TARGETS) plus every file under
 * the directories in PERMITTED_GATE_SURFACE_DIRS - scripts/ (this guard's
 * own directory) and .github/workflows/ (this repo's own CI). Adding a
 * new script or workflow file is automatically covered; nothing needs to
 * be added to a hardcoded list.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Always scanned, regardless of whether they exist yet.
export const DEFAULT_TARGETS = ["README.md", "package.json"];

// Every permitted gate surface: directories that may contain a gate, CI,
// or install-step invocation. Walked recursively; a directory that
// doesn't exist yet (e.g. .github/workflows before any workflow file
// lands) simply contributes zero targets rather than erroring.
export const PERMITTED_GATE_SURFACE_DIRS = ["scripts", path.join(".github", "workflows")];

// This guard's own source intentionally contains the forbidden substring
// as data (the pattern it looks for, and this file's own comments/doc
// text) - that's not an install invocation, so the file excludes itself
// from the surface it scans rather than tripping on itself.
const SELF_RELATIVE_PATH = "scripts/check-npm-ci-usage.mjs";

// Global npm options that consume the FOLLOWING token as a separate value
// argument, rather than being a bare boolean flag - so the subcommand
// search has to skip both the option AND its value to find the real
// subcommand further along (`npm --prefix /tmp/x install` - the value
// `/tmp/x` is not the subcommand). `-C` is npm's own documented shorthand
// for `--prefix`, and `-w`/`-L` for `--workspace`/`--location` (see the
// "Shorthands and Other CLI Niceties" table in `npm help 7 config`).
// Deliberately scoped to the global options most plausible in a real
// documented/scripted install-step invocation, not npm's entire config
// surface - the same targeted-not-exhaustive trade-off INSTALL_ALIASES
// below takes on subcommand names. A `--flag=value` attached form needs
// no special handling: it's a single whitespace-free token, already
// covered by the generic bare-option branch in the pattern below.
const VALUE_TAKING_GLOBAL_OPTIONS = [
  "--prefix",
  "-C",
  "--registry",
  "--userconfig",
  "--globalconfig",
  "--cache",
  "--otp",
  "--tag",
  "--workspace",
  "-w",
  "--location",
  "-L",
];
const VALUE_TAKING_OPTION_ALTERNATION = VALUE_TAKING_GLOBAL_OPTIONS.join("|");

// Matches an npm invocation and captures its subcommand token, tolerating
// every real-world shape that still executes as npm on some platform:
//   - the command name itself: `npm`, or Windows' `npm.cmd`/`npm.exe`
//     (cmd.exe/PowerShell resolve these, and command lookup on Windows is
//     case-insensitive, hence the whole pattern runs with the `i` flag) -
//     optionally wrapped in a single matching pair of quotes (`"npm"
//     install`), the executable name itself quoted rather than the
//     subcommand. Group 1 captures that opening quote (or nothing) and
//     `\1` requires the same character to close it right after the name.
//   - zero or more global options between the command and the subcommand:
//     either a bare boolean-shaped `-`-prefixed token (`npm --silent
//     install`, `npm -s install`), or one of VALUE_TAKING_GLOBAL_OPTIONS
//     immediately followed by its own whitespace-separated value token
//     (`npm --prefix /tmp/x install`, `npm -C /tmp/x install`) - tried
//     first in the alternation so a value-taking option consumes its
//     value instead of that value being misread as the subcommand.
//   - the subcommand optionally wrapped in a single matching pair of
//     quotes (`npm "install"`, `npm 'install'`) - group 2 captures the
//     opening quote (or nothing), and `\2` requires the same character to
//     close it, so a stray unmatched quote elsewhere on the line can't
//     falsely pair with it.
// Deliberately stops the subcommand token at punctuation like a closing
// backtick or semicolon - what lets a doc comment's inline `` `npm ci` ``
// code span read as the clean subcommand "ci" instead of the noise "ci`".
// The `[ \t]+` separators are the whitespace normalization: one or more
// spaces/tabs are all treated identically, so "npm install",
// "npm  install" (double space), and "npm\tinstall" (tab) are recognized
// as the same invocation without a separate normalization pass.
// Built via the RegExp constructor (rather than a `/.../` literal) only
// because VALUE_TAKING_OPTION_ALTERNATION has to be spliced in from data.
const NPM_INVOCATION_PATTERN = new RegExp(
  "(['\"]?)\\bnpm(?:\\.cmd|\\.exe)?\\b\\1" +
    `(?:[ \\t]+(?:(?:${VALUE_TAKING_OPTION_ALTERNATION})[ \\t]+\\S+|-\\S+))*` +
    "[ \\t]+(['\"]?)([\\w${}]+)\\2",
  "gi"
);

// Every subcommand npm itself resolves to `install` (read straight out of
// npm's own alias table, lib/utils/cmd-list.js) - not just the commonly
// known `i` shorthand. npm carries a long tail of typo-tolerant
// abbreviations (`in`, `ins`, `inst`, ...) alongside the `add` alias, and
// every one of them is exactly as capable of silently rewriting
// package-lock.json as a bare `npm install` is.
const INSTALL_ALIASES = new Set([
  "install",
  "add",
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
]);

/**
 * Finds every `npm <subcommand>` invocation in a line of shell-ish text
 * and classifies each one:
 *   - "install": the subcommand resolves to `install` per npm's own alias
 *     table (INSTALL_ALIASES above) - forbidden.
 *   - "unresolved": the subcommand is a shell variable reference
 *     (`npm ${CMD}`, `npm $CMD`) that can't be confidently resolved one
 *     way or the other - this FAILS CLOSED as a hit requiring manual
 *     review, rather than silently passing as safe. (Backtick/`$()`
 *     command substitution isn't specially detected here - it's covered
 *     incidentally when it appears next to a `$`-prefixed variable, but a
 *     bare `` npm `cmd` `` isn't parsed; that's out of scope for this
 *     guard, which cares about install-step regressions, not general
 *     shell parsing.)
 * `npm ci` - the only permitted install invocation - and every other
 * subcommand (`npm run`, `npm test`, `npm init`, `npm info`, ...) are not
 * hits. The `\b...\b` word-boundary shape means `npm i` never mismatches
 * `npm init`/`npm info`: a boundary requires a transition from a word
 * character to a non-word character, and `i` followed by `n` (as in
 * "init") is word-to-word, so there's no boundary there to match against.
 *
 * A shell line ending in a lone `\` continues onto the next line - joined
 * here (via joinLineContinuations) before matching, so `npm \` followed by
 * `  install` on the next line is recognized as one invocation instead of
 * two harmless-looking fragments.
 *
 * NPM_INVOCATION_PATTERN's capture groups: 1 = the executable name's
 * opening quote (or nothing, if unquoted - e.g. `"npm" install`), 2 = the
 * subcommand's own opening quote (or nothing), 3 = the subcommand text
 * itself. Group 3, not group 2, is the subcommand - the extra leading
 * group is what lets a quoted executable name be recognized at all.
 *
 * @param {string} text
 * @returns {{ match: string, kind: "install" | "unresolved" }[]}
 */
export function findNpmInstallInvocations(text) {
  const hits = [];
  const joined = joinLineContinuations(text);
  for (const m of joined.matchAll(NPM_INVOCATION_PATTERN)) {
    const sub = m[3];
    const subLower = sub.toLowerCase();
    if (subLower === "ci") continue;
    if (INSTALL_ALIASES.has(subLower)) {
      hits.push({ match: m[0].trim(), kind: "install" });
    } else if (sub.includes("$")) {
      hits.push({ match: m[0].trim(), kind: "unresolved" });
    }
  }
  return hits;
}

/**
 * Joins a shell line-continuation (a line ending in a lone `\`, optionally
 * followed by trailing whitespace) with the line that follows, collapsing
 * the backslash and the newline into a single space so a multi-line
 * invocation like:
 *
 *   npm \
 *     install
 *
 * is scanned as the one logical command it actually is. Deliberately
 * replaces the removed newline with a space rather than dropping it
 * outright, so this stays a pure substring transform - callers that also
 * need per-line reporting apply this before their own line-number
 * bookkeeping, accepting that a continued line's reported line number may
 * land one line early, which is an acceptable trade-off for correctly
 * catching the invocation at all.
 *
 * @param {string} text
 * @returns {string}
 */
export function joinLineContinuations(text) {
  return text.replace(/[ \t]*\\[ \t]*\r?\n[ \t]*/g, " ");
}

/**
 * Pulls fenced (```) and indented (4-space/tab) code blocks out of a
 * markdown document, each tagged with the 1-based source line its first
 * line came from.
 *
 * @param {string} markdown
 * @returns {{ startLine: number, text: string }[]}
 */
export function extractCodeBlocks(markdown) {
  const lines = markdown.split("\n");
  const blocks = [];
  let inFence = false;
  let fenceLines = [];
  let fenceStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      if (!inFence) {
        inFence = true;
        fenceStartLine = i + 2;
        fenceLines = [];
      } else {
        inFence = false;
        blocks.push({ startLine: fenceStartLine, text: fenceLines.join("\n") });
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }
    if (/^(?: {4}|\t)\S/.test(line)) {
      blocks.push({ startLine: i + 1, text: line.replace(/^(?: {4}|\t)/, "") });
    }
  }
  return blocks;
}

/**
 * @param {string} markdown
 * @returns {{ line: number, match: string, kind: "install" | "unresolved" }[]}
 */
export function findForbiddenInstallCommands(markdown) {
  const hits = [];
  for (const block of extractCodeBlocks(markdown)) {
    // Joined BEFORE splitting into lines, so a continuation inside this
    // block is recognized as one invocation rather than two harmless
    // fragments (see joinLineContinuations - reported line numbers after
    // a continuation may shift by one, an accepted trade-off).
    const blockLines = joinLineContinuations(block.text).split("\n");
    blockLines.forEach((line, offset) => {
      for (const invocation of findNpmInstallInvocations(line)) {
        hits.push({ line: block.startLine + offset, ...invocation });
      }
    });
  }
  return hits;
}

/**
 * @param {string} packageJsonText
 * @returns {{ npmScript: string, match: string, kind: "install" | "unresolved" }[]}
 */
export function findForbiddenNpmScripts(packageJsonText) {
  const pkg = JSON.parse(packageJsonText);
  const hits = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    if (typeof cmd !== "string") continue;
    for (const invocation of findNpmInstallInvocations(cmd)) {
      hits.push({ npmScript: name, ...invocation });
    }
  }
  return hits;
}

/**
 * Recursively scans every STRING VALUE anywhere in a parsed JSON document
 * for a forbidden npm invocation - not just package.json's `scripts`
 * block, which is findForbiddenNpmScripts' job above (kept separate for
 * its own `npmScript`-keyed reporting shape, and so its entries aren't
 * double-reported here under a second shape). This is what catches an
 * install invocation sitting in some OTHER JSON field of a tracked config
 * file - e.g. a `"command": "npm install"` value in a file that isn't
 * package.json at all, or a sibling field of package.json itself - which
 * scripts-only scanning would never look at.
 *
 * The root's own `scripts` property is skipped (that's the exclusion
 * above); every other field, at any depth and inside any array, is in
 * scope. Each hit's `path` is a dotted/bracketed JSON-pointer-ish
 * description of where the string lives (`command`, `steps[2].run`, ...).
 *
 * @param {string} jsonText
 * @returns {{ path: string, match: string, kind: "install" | "unresolved" }[]}
 */
export function findForbiddenInJsonValues(jsonText) {
  const root = JSON.parse(jsonText);
  const hits = [];

  function walk(value, jsonPath) {
    if (typeof value === "string") {
      for (const invocation of findNpmInstallInvocations(value)) {
        hits.push({ path: jsonPath, ...invocation });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${jsonPath}[${index}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (jsonPath === "" && key === "scripts") continue; // handled by findForbiddenNpmScripts
        walk(child, jsonPath === "" ? key : `${jsonPath}.${key}`);
      }
    }
  }

  walk(root, "");
  return hits;
}

/**
 * Drops full-line `#`-prefixed comments (shell and YAML both use `#` for
 * comments) before scanning raw script/workflow text, mirroring the same
 * prose-vs-code distinction extractCodeBlocks applies to markdown - a
 * comment line that merely *mentions* an install command isn't an install
 * *step*. This only strips whole comment lines, not a trailing `# ...`
 * after real content, to avoid misparsing a `#` that appears inside a
 * quoted string.
 *
 * @param {string} text
 * @returns {string}
 */
function stripFullLineHashComments(text) {
  return text
    .split("\n")
    .map((line) => (line.trim().startsWith("#") ? "" : line))
    .join("\n");
}

/**
 * Raw (non-markdown, non-JSON) scan for scripts/*.sh, .github/workflows/*.yml,
 * and similar - the whole file is command/config text, so there's no
 * markdown-style prose-vs-code split to apply first.
 *
 * @param {string} text
 * @returns {{ line: number, match: string, kind: "install" | "unresolved" }[]}
 */
export function findForbiddenInRawText(text) {
  // Comments stripped first (so a comment line ending in a lone `\`
  // doesn't swallow the next real line of code into itself), then
  // continuations joined, then split for line-number reporting.
  const stripped = joinLineContinuations(stripFullLineHashComments(text));
  const hits = [];
  stripped.split("\n").forEach((line, idx) => {
    for (const invocation of findNpmInstallInvocations(line)) {
      hits.push({ line: idx + 1, ...invocation });
    }
  });
  return hits;
}

// child_process functions capable of actually running a program, whether
// called bare (`execFileSync(...)`) or namespaced (`child_process.spawn(...)`,
// `cp.spawnSync(...)`) - the namespace, if any, doesn't change what
// actually executes, so the pattern below doesn't require or exclude one.
const CHILD_PROCESS_EXEC_FUNCTIONS = ["execFileSync", "spawnSync", "spawn"];

// Matches `execFileSync("npm", [...])` / `spawnSync("npm", [...])` /
// `spawn("npm", [...])` - a PROGRAMMATIC npm invocation in JS/TS source,
// as opposed to shell-command-shaped text. The first argument must be a
// quoted, non-interpolated "npm" (or "npm.cmd"/"npm.exe"); the second must
// be an array literal, whose raw inner text (up to the first `]`) is
// captured in group 3 for parseArrayStringElements to walk separately.
// Only this direct, statically-visible shape is recognized - a subcommand
// built through concatenation, a variable, or a spread argument isn't
// resolvable by a regex and is out of scope here, the same "targeted, not
// a full parser" posture the rest of this guard takes (this repo has no
// JS-parsing dependency and shouldn't gain one just for this).
const CHILD_PROCESS_NPM_CALL_PATTERN = new RegExp(
  `\\b(?:${CHILD_PROCESS_EXEC_FUNCTIONS.join("|")})\\s*\\(\\s*(['"])(npm(?:\\.cmd|\\.exe)?)\\1\\s*,\\s*\\[([^\\]]*)\\]`,
  "gi"
);

/**
 * Extracts the string-literal elements of a raw `[...]` array's inner
 * text, in encounter order - each element either a quoted string
 * (`'...'`/`"..."`, with `\'`/`\"`/other backslash escapes tolerated
 * inside it) or a non-interpolated template literal. A template literal
 * containing `${...}` interpolation is still captured, but flagged
 * `dynamic: true`, since its actual runtime value can't be resolved
 * statically - mirroring findNpmInstallInvocations' own "unresolved"
 * fail-closed treatment of a shell `${VAR}`.
 *
 * @param {string} rawArrayText
 * @returns {{ text: string, dynamic: boolean }[]}
 */
function parseArrayStringElements(rawArrayText) {
  const elements = [];
  const stringLiteralPattern = /(['"])((?:\\.|(?!\1)[^\\])*)\1|`((?:\\.|[^\\`])*)`/g;
  for (const m of rawArrayText.matchAll(stringLiteralPattern)) {
    if (m[3] !== undefined) {
      elements.push({ text: m[3], dynamic: m[3].includes("${") });
    } else {
      elements.push({ text: m[2], dynamic: false });
    }
  }
  return elements;
}

/**
 * Given an npm args array's parsed string elements, finds the subcommand:
 * the first element that isn't itself flag-shaped (doesn't start with
 * `-`). Mirrors the shell-text scanner's leading-option-skip, without
 * modelling which specific flags consume a following value element - a
 * programmatic args array overwhelmingly places the subcommand first
 * (`["ci"]`, `["install", "--save"]`), unlike a shell line where a global
 * option commonly precedes the subcommand.
 *
 * @param {{ text: string, dynamic: boolean }[]} elements
 * @returns {{ text: string, dynamic: boolean } | undefined}
 */
function findChildProcessArgSubcommand(elements) {
  return elements.find((el) => !el.text.startsWith("-"));
}

/**
 * Strips JS `//` line comments and `/* ... *\/` block comments before
 * scanning, so example code inside a doc comment - like the ones just
 * above, or another script's header - isn't mistaken for a real call.
 * Block comments are blanked out character-for-character (newlines kept)
 * so reported line numbers stay accurate for anything found after one; a
 * `//` is only treated as a comment start when it isn't immediately
 * preceded by `:`, a cheap guard against truncating a `https://` URL
 * embedded in a string on the same line.
 *
 * @param {string} text
 * @returns {string}
 */
function stripJsComments(text) {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, " ")
  );
  return withoutBlockComments
    .split("\n")
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ""))
    .join("\n");
}

/**
 * Finds every programmatic `execFileSync("npm", [...])`-shaped npm
 * invocation in JS/TS source text and classifies its subcommand the same
 * way the shell-text scanner does: `ci` is permitted, an install alias is
 * forbidden, and an interpolated/unresolved subcommand fails closed. This
 * is what catches a literal like `execFileSync("npm", ["ci"])` regressing
 * to `execFileSync("npm", ["install"])` - a real install invocation with
 * no `npm install` SUBSTRING anywhere in the source text, since the
 * command name and subcommand are separate JS array elements rather than
 * concatenated shell text, so findNpmInstallInvocations' own pattern can
 * never see it.
 *
 * @param {string} text
 * @returns {{ line: number, match: string, kind: "install" | "unresolved" }[]}
 */
export function findForbiddenChildProcessNpmCalls(text) {
  const stripped = stripJsComments(text);
  const hits = [];
  for (const m of stripped.matchAll(CHILD_PROCESS_NPM_CALL_PATTERN)) {
    const subcommand = findChildProcessArgSubcommand(parseArrayStringElements(m[3]));
    if (!subcommand) continue;
    const subLower = subcommand.text.toLowerCase();
    let kind;
    if (subcommand.dynamic) {
      kind = "unresolved";
    } else if (subLower === "ci") {
      continue;
    } else if (INSTALL_ALIASES.has(subLower)) {
      kind = "install";
    } else {
      continue;
    }
    const line = stripped.slice(0, m.index).split("\n").length;
    hits.push({ line, match: m[0].trim(), kind });
  }
  return hits;
}

/**
 * Recursively lists every regular file under `dir` (absolute path in,
 * absolute paths out) - including a symlink that resolves to a regular
 * file or directory, since a tracked symlink pointing at command text is
 * exactly as reachable as a real file and would otherwise scan clean.
 * `readdirSync`'s dirent type reflects the link itself (`isFile()` is
 * false for a symlink even when its target is a real file), so a symlink
 * needs its target resolved explicitly via `statSync` (which follows
 * links, unlike `lstatSync`); a broken link (target doesn't exist) is
 * skipped rather than thrown over, since there's no content there to scan.
 * Returns an empty list, without erroring, when `dir` doesn't exist - so a
 * permitted gate-surface directory that hasn't been created yet (e.g.
 * .github/workflows before any workflow file lands) simply contributes
 * zero scan targets.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      out.push(...listFilesUnder(full));
    } else if (dirent.isFile()) {
      out.push(full);
    } else if (dirent.isSymbolicLink()) {
      let resolved;
      try {
        resolved = statSync(full);
      } catch {
        continue; // broken symlink - nothing to scan
      }
      if (resolved.isDirectory()) {
        out.push(...listFilesUnder(full));
      } else if (resolved.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Every permitted gate surface, relative to `root`: the always-scanned
 * baseline files plus every file under PERMITTED_GATE_SURFACE_DIRS,
 * excluding this guard's own source. Defaults to the real repo root; a
 * test can pass a scratch directory to prove the walk works against an
 * isolated fixture (including the zero-match case before any workflow
 * file exists).
 *
 * @param {string} [root]
 * @returns {string[]}
 */
export function listScanTargets(root = REPO_ROOT) {
  const targets = [...DEFAULT_TARGETS];
  for (const dir of PERMITTED_GATE_SURFACE_DIRS) {
    const abs = path.join(root, dir);
    for (const file of listFilesUnder(abs)) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (rel === SELF_RELATIVE_PATH) continue;
      targets.push(rel);
    }
  }
  return targets;
}

/**
 * @param {string} relativePath
 * @param {string} [root]
 * @returns {Array<Record<string, unknown> & { file: string }>}
 */
export function checkFile(relativePath, root = REPO_ROOT) {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) {
    return [];
  }
  const text = readFileSync(absolute, "utf8");
  let hits;
  if (relativePath.endsWith(".json")) {
    // Two independent JSON scans, combined: the scripts{}-block scan
    // (its own reporting shape, keyed by script name) plus a general
    // scan of every OTHER string value in the document (see
    // findForbiddenInJsonValues - it skips the root's own `scripts`
    // property so the two never double-report the same entry).
    hits = [...findForbiddenNpmScripts(text), ...findForbiddenInJsonValues(text)];
  } else if (relativePath.endsWith(".md")) {
    hits = findForbiddenInstallCommands(text);
  } else {
    // Two independent scans of the same raw text: the shell-command-shaped
    // scanner (findForbiddenInRawText) plus the programmatic
    // execFileSync/spawnSync/spawn("npm", [...]) scanner - the latter is a
    // no-op on a file with no such call (a .sh/.yml file, for instance),
    // so running both unconditionally is harmless.
    hits = [...findForbiddenInRawText(text), ...findForbiddenChildProcessNpmCalls(text)];
  }
  return hits.map((hit) => ({ ...hit, file: relativePath }));
}

function describeHit(hit) {
  const reviewNote =
    hit.kind === "unresolved" ? " (unresolved subcommand - requires manual review)" : "";
  if ("line" in hit) {
    return `${hit.file}:${hit.line}: forbidden "${hit.match}"${reviewNote}`;
  }
  if ("npmScript" in hit) {
    return `${hit.file}#scripts.${hit.npmScript}: forbidden "${hit.match}"${reviewNote}`;
  }
  return `${hit.file}#${hit.path}: forbidden "${hit.match}"${reviewNote}`;
}

function main() {
  const targets = listScanTargets();
  const allHits = targets.flatMap((target) => checkFile(target));
  if (allHits.length > 0) {
    for (const hit of allHits) {
      console.error(`${describeHit(hit)} - every gate/CI install step must use "npm ci"`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`no forbidden npm install invocation found across: ${targets.join(", ")}`);
}

if (isMainModule(import.meta.url)) {
  main();
}
