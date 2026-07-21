import assert from "node:assert/strict";
import { test } from "node:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_TARGETS,
  checkFile,
  findForbiddenChildProcessNpmCalls,
  findForbiddenInJsonValues,
  findForbiddenInRawText,
  findForbiddenInstallCommands,
  findForbiddenNpmScripts,
  findNpmInstallInvocations,
  listScanTargets,
} from "../scripts/check-npm-ci-usage.mjs";
import { isMainModule } from "../scripts/lib/is-main.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("the documented install step never uses npm install", () => {
  for (const target of DEFAULT_TARGETS) {
    const hits = checkFile(target);
    assert.deepEqual(hits, [], `${target} should not contain "npm install"`);
  }
});

test("README documents npm ci as the install step", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes("npm ci"), "README.md should document `npm ci` as the install step");
});

test("mutation control: the guard actually catches a regression to npm install", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-npm-ci-guard-"));
  const fixture = path.join(dir, "fixture-install-step.md");
  try {
    // Simulate a doc or gate script that regressed from `npm ci` to `npm install`.
    writeFileSync(fixture, "## Install\n\n    npm install\n");
    const hits = findForbiddenInstallCommands(readFileSync(fixture, "utf8"));
    assert.equal(hits.length, 1, "guard must flag a regressed `npm install` step");
    assert.equal(hits[0].match, "npm install");

    // Revert the fixture back to the compliant form and confirm the guard
    // goes quiet again - this is what proves the guard actually reacts to
    // the change instead of just always being red or always being green.
    writeFileSync(fixture, "## Install\n\n    npm ci\n");
    const cleanHits = findForbiddenInstallCommands(readFileSync(fixture, "utf8"));
    assert.deepEqual(cleanHits, [], "guard should be clean once the fixture uses `npm ci`");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation control: an npm-install regression inside package.json's scripts is caught too", () => {
  const withRegression = JSON.stringify({ scripts: { build: "npm install && tsc" } });
  const hits = findForbiddenNpmScripts(withRegression);
  assert.equal(hits.length, 1, "guard must flag a regressed npm-script command");
  assert.equal(hits[0].npmScript, "build");

  const clean = JSON.stringify({ scripts: { build: "npm ci && tsc" } });
  assert.deepEqual(
    findForbiddenNpmScripts(clean),
    [],
    "guard should be clean once the script uses `npm ci`"
  );
});

test("prose that merely mentions npm install (not a code block) does not trip the guard", () => {
  const prose = "Use `npm ci` here, never `npm install` - the latter can rewrite the lockfile.";
  assert.deepEqual(
    findForbiddenInstallCommands(prose),
    [],
    "a narrative sentence about npm install is not an install *step*"
  );
});

// --- Full argv-form matrix: every whitespace/alias variant of the forbidden
// install invocation, each as an independent mutation-control test. ---

test("mutation control: `npm install` is caught", () => {
  const hits = findNpmInstallInvocations("npm install");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
  assert.equal(hits[0].match, "npm install");
});

test("mutation control: the `npm i` shorthand alias is caught", () => {
  const hits = findNpmInstallInvocations("npm i");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
  assert.equal(hits[0].match, "npm i");
});

test("mutation control: the `npm add` alias is caught", () => {
  const hits = findNpmInstallInvocations("npm add left-pad");
  assert.equal(
    hits.length,
    1,
    "`npm add` is npm's own alias for install and must be caught the same way"
  );
  assert.equal(hits[0].kind, "install");
  assert.equal(hits[0].match, "npm add");
});

test("mutation control: npm's typo-tolerant abbreviations (`in`, `instal`, `isntall`, ...) are every one of them caught", () => {
  for (const alias of [
    "in",
    "ins",
    "inst",
    "insta",
    "instal",
    "isnt",
    "isnta",
    "isntal",
    "isntall",
  ]) {
    const hits = findNpmInstallInvocations(`npm ${alias}`);
    assert.equal(
      hits.length,
      1,
      `"npm ${alias}" resolves to install per npm's own alias table and must be caught`
    );
    assert.equal(hits[0].kind, "install");
  }
});

// --- Real-executable forms a plain "npm install" regex could plausibly
// miss: quoting, global options before the subcommand, a shell line
// continuation, the Windows executable name, and Windows' case-insensitive
// command lookup. Each of these is a form a real shell genuinely executes
// as npm install - not a theoretical edge case. ---

test('mutation control: a double-quoted subcommand `npm "install"` is caught', () => {
  const hits = findNpmInstallInvocations('npm "install"');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
});

test("mutation control: a single-quoted subcommand `npm 'install'` is caught", () => {
  const hits = findNpmInstallInvocations("npm 'install'");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
});

test("mutation control: a global option before the subcommand (`npm --silent install`) is caught", () => {
  const hits = findNpmInstallInvocations("npm --silent install");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
});

test("mutation control: a short global option before the subcommand (`npm -s install`) is caught", () => {
  const hits = findNpmInstallInvocations("npm -s install");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
});

test("mutation control: a shell line-continuation between `npm` and `install` is caught", () => {
  const hits = findNpmInstallInvocations("npm \\\n  install");
  assert.equal(hits.length, 1, "a backslash-newline continuation is still one logical invocation");
  assert.equal(hits[0].kind, "install");
});

test("mutation control: the real workflow guard catches a continuation across two real lines, and reports a line number", () => {
  const hits = findForbiddenInRawText("#!/usr/bin/env bash\nnpm \\\n  install\n");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
});

test("mutation control: the Windows executable name `npm.cmd install` is caught", () => {
  const hits = findNpmInstallInvocations("npm.cmd install");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
});

test("mutation control: `npm.exe install` is caught too", () => {
  const hits = findNpmInstallInvocations("npm.exe install");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
});

test("mutation control: Windows' case-insensitive command lookup (`NPM INSTALL`) is caught", () => {
  const hits = findNpmInstallInvocations("NPM INSTALL");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
});

test("mutation control: mixed case (`Npm Install`) is caught", () => {
  const hits = findNpmInstallInvocations("Npm Install");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
});

test("real-executable proof: each of the quoted/option/continuation POSIX forms genuinely runs as npm install (--dry-run, no network/lockfile effects)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-real-npm-forms-"));
  try {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" })
    );
    const forms = ['npm "install"', "npm 'install'", "npm --silent install"];
    for (const form of forms) {
      const guardHits = findNpmInstallInvocations(form);
      assert.equal(guardHits.length, 1, `guard must flag: ${form}`);

      const [cmd, ...args] = form.replace(/['"]/g, "").split(/\s+/);
      const result = spawnSync(
        cmd,
        [...args, "--dry-run", "--ignore-scripts", "--no-package-lock"],
        {
          cwd: dir,
          encoding: "utf8",
        }
      );
      assert.equal(
        result.status,
        0,
        `expected "${form}" to actually run as a real npm install (dry-run): ${result.stderr}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("green control: a global option before a permitted subcommand (`npm --silent ci`) is never flagged", () => {
  assert.deepEqual(findNpmInstallInvocations("npm --silent ci"), []);
});

test("mutation control: an npm-install invocation reachable only through a tracked SYMLINK is caught, not silently skipped", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ghantika-symlink-guard-"));
  try {
    const scriptsDir = path.join(scratch, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    const realFile = path.join(scriptsDir, "real-install.sh");
    writeFileSync(realFile, "#!/usr/bin/env bash\nnpm install\n");
    symlinkSync(realFile, path.join(scriptsDir, "install-link.sh"));

    const targets = listScanTargets(scratch);
    assert.ok(
      targets.some((t) => t === "scripts/install-link.sh"),
      "a symlinked file under a permitted gate-surface directory must be included in the scan targets"
    );

    const hits = checkFile("scripts/install-link.sh", scratch);
    assert.equal(
      hits.length,
      1,
      "the npm install inside the symlink's target content must be caught"
    );
    assert.equal(hits[0].kind, "install");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("mutation control: a double-space-separated `npm  install` is caught", () => {
  const hits = findNpmInstallInvocations("npm  install");
  assert.equal(
    hits.length,
    1,
    "whitespace normalization must treat a run of spaces the same as one space"
  );
  assert.equal(hits[0].kind, "install");
});

test("mutation control: a tab-separated `npm\\tinstall` is caught", () => {
  const hits = findNpmInstallInvocations("npm\tinstall");
  assert.equal(hits.length, 1, "whitespace normalization must treat a tab the same as a space");
  assert.equal(hits[0].kind, "install");
});

test("green control: `npm ci` - the only permitted install invocation - is never flagged", () => {
  assert.deepEqual(findNpmInstallInvocations("npm ci"), []);
});

test("green control: `npm init`/`npm info` are not mistaken for the `npm i` alias", () => {
  assert.deepEqual(findNpmInstallInvocations("npm init -y"), []);
  assert.deepEqual(findNpmInstallInvocations("npm info some-package"), []);
});

test("green control: a doc comment's inline `` `npm ci` `` code span reads as the clean subcommand, not a false 'unresolved' hit off the trailing backtick", () => {
  assert.deepEqual(
    findNpmInstallInvocations("Proves that `npm ci` produces a byte-identical tree."),
    []
  );
});

// --- Fail-closed: an unresolved (variable-interpolated) subcommand. ---

test("fail-closed: a `${VAR}`-interpolated npm subcommand is flagged for manual review, not silently passed", () => {
  const hits = findNpmInstallInvocations("npm ${INSTALL_CMD}");
  assert.equal(hits.length, 1, "a variable-interpolated npm subcommand must fail closed as a hit");
  assert.equal(hits[0].kind, "unresolved");
});

test("fail-closed: a bare `$VAR`-interpolated npm subcommand is flagged for manual review too", () => {
  const hits = findNpmInstallInvocations("npm $INSTALL_CMD");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "unresolved");
});

test("fail-closed: a fixture shell script with a variable-interpolated npm command surfaces as a hit requiring manual review", () => {
  const hits = findForbiddenInRawText("#!/usr/bin/env bash\nset -e\nnpm ${INSTALL_CMD}\n");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "unresolved");
  assert.equal(hits[0].line, 3);
});

test("a full-line `#` comment mentioning npm install is not itself an install step", () => {
  assert.deepEqual(findForbiddenInRawText("# don't use npm install here\nnpm ci\n"), []);
});

// --- Generalized scan surface: scripts/ and .github/workflows/, glob-safe
// at zero matches, proven to catch a match once one exists. ---

test("the generalized scan surface includes every file under scripts/, excluding this guard's own source", () => {
  const targets = listScanTargets();
  assert.ok(targets.includes("README.md"));
  assert.ok(targets.includes("package.json"));
  assert.ok(
    targets.some((t) => t.startsWith("scripts/") && t !== "scripts/check-npm-ci-usage.mjs"),
    "expected at least one other scripts/ file besides the guard's own source to be scanned"
  );
  assert.ok(
    !targets.includes("scripts/check-npm-ci-usage.mjs"),
    "the guard must exclude its own source from the surface it scans"
  );
});

test("the real .github/workflows/ci.yml is included in the scan surface and is itself clean", () => {
  const targets = listScanTargets();
  assert.ok(
    targets.includes(".github/workflows/ci.yml"),
    "the repo's real workflow file must be part of the generalized scan surface"
  );
  const hits = checkFile(".github/workflows/ci.yml");
  assert.deepEqual(hits, [], "the real ci.yml must not contain a forbidden npm install invocation");
});

test("mutation control: a new .github/workflows/*.yml gate surface is scanned and its `run: npm install` step is caught, once that surface exists", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ghantika-workflow-guard-"));
  try {
    const workflowDir = path.join(scratch, ".github", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      path.join(workflowDir, "mutant.yml"),
      [
        "name: mutant",
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm install",
        "",
      ].join("\n")
    );

    const targets = listScanTargets(scratch);
    assert.ok(
      targets.includes(".github/workflows/mutant.yml"),
      "the new workflow fixture must be picked up by the generalized glob"
    );

    const hits = checkFile(".github/workflows/mutant.yml", scratch);
    assert.equal(hits.length, 1, "a `run: npm install` workflow step must be caught");
    assert.equal(hits[0].kind, "install");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// --- Platform cells: the import.meta.url-vs-argv path-with-spaces bug. ---

test("isMainModule still matches when the invoking path contains a space (a raw file://+argv string compare silently breaks here)", () => {
  const scriptPath = path.join("/tmp", "ghantika test dir", "scripts", "check-npm-ci-usage.mjs");
  const encodedUrl = pathToFileURL(scriptPath).href; // percent-encodes the space as %20
  const originalArgv1 = process.argv[1];
  process.argv[1] = scriptPath; // argv is never percent-encoded
  try {
    assert.equal(
      isMainModule(encodedUrl),
      true,
      "isMainModule must still match when the path contains a space"
    );
    // the previously-broken naive comparison, kept here only to document
    // exactly what regressed: it silently mismatches on the same inputs.
    assert.notEqual(
      encodedUrl,
      `file://${scriptPath}`,
      "sanity check: the raw compare really does diverge on a space-containing path"
    );
  } finally {
    process.argv[1] = originalArgv1;
  }
});

test("mutation control: the guard still runs end-to-end (and reports its violation) when invoked from a path containing a space", () => {
  const base = mkdtempSync(path.join(tmpdir(), "ghantika npm ci guard "));
  try {
    const scriptDir = path.join(base, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    copyFileSync(
      path.join(REPO_ROOT, "scripts", "check-npm-ci-usage.mjs"),
      path.join(scriptDir, "check-npm-ci-usage.mjs")
    );
    mkdirSync(path.join(scriptDir, "lib"), { recursive: true });
    copyFileSync(
      path.join(REPO_ROOT, "scripts", "lib", "is-main.mjs"),
      path.join(scriptDir, "lib", "is-main.mjs")
    );
    writeFileSync(
      path.join(base, "package.json"),
      JSON.stringify({ scripts: { build: "npm install && tsc" } })
    );
    writeFileSync(path.join(base, "README.md"), "# fixture\n");

    const result = spawnSync(process.execPath, [path.join(scriptDir, "check-npm-ci-usage.mjs")], {
      cwd: base,
      encoding: "utf8",
    });

    assert.equal(
      result.status,
      1,
      `guard should exit 1 for a violation even from a space-containing path (stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)})`
    );
    assert.ok(
      result.stderr.length > 0,
      "guard must print its violation, not silently exit with no output - that silence is exactly the old bug"
    );
    assert.match(result.stderr, /forbidden "npm install"/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Windows-style paths can't be natively round-tripped through the real
// filesystem on this (macOS/Linux) test runner - path.sep is `/` here, so
// a literal `C:\\foo\\bar` isn't exercisable end-to-end without a Windows
// host. What's assertable without one: isMainModule and the guard's own
// path handling go through node:path/node:url (fileURLToPath, path.join,
// path.relative) rather than manual string slicing on `/` or `\\`, which is
// what makes the comparison platform-correct in the first place - manual
// slicing is exactly the shape of bug the space-path case above already
// demonstrates for POSIX. See scripts/lib/is-main.mjs.
test("isMainModule is built on node:path/node:url APIs, not manual path-string slicing (documents the Windows-path limitation of this test host)", () => {
  assert.equal(typeof isMainModule, "function");
  const relPath = path.join("nested", "dir", "check-npm-ci-usage.mjs");
  const absPath = path.join(REPO_ROOT, relPath);
  const url = pathToFileURL(absPath).href;
  const originalArgv1 = process.argv[1];
  process.argv[1] = absPath;
  try {
    assert.equal(isMainModule(url), true);
  } finally {
    process.argv[1] = originalArgv1;
  }
});

// --- Form 1: a value-taking global option (`--prefix`, `-C`, ...) between
// `npm` and the subcommand. Unlike a bare boolean flag (`--silent`), these
// consume a SEPARATE following token as their value, so a naive "skip
// leading dash tokens" scanner misreads that value as the subcommand and
// misses the real one further along. ---

test("mutation control: a value-taking global option before the subcommand (`npm --prefix /tmp/x install`) is caught", () => {
  const hits = findNpmInstallInvocations("npm --prefix /tmp/fixture install");
  assert.equal(
    hits.length,
    1,
    "the guard must skip past --prefix's VALUE to find the real subcommand"
  );
  assert.equal(hits[0].kind, "install");
});

test("mutation control: the `-C` shorthand for --prefix is caught the same way", () => {
  const hits = findNpmInstallInvocations("npm -C /tmp/fixture install");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
});

test("mutation control: --registry as a value-taking option before the subcommand is caught", () => {
  const hits = findNpmInstallInvocations("npm --registry https://registry.example.invalid install");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
});

test("green control: a value-taking global option before a PERMITTED subcommand (`npm --prefix /tmp/x ci`) is never flagged", () => {
  assert.deepEqual(findNpmInstallInvocations("npm --prefix /tmp/fixture ci"), []);
  assert.deepEqual(findNpmInstallInvocations("npm -C /tmp/fixture ci"), []);
});

test("real-executable proof: `npm --prefix <dir> install` and `npm -C <dir> install` genuinely run as npm install (--dry-run, no network/lockfile effects)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-prefix-form-"));
  try {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" })
    );
    for (const form of [`npm --prefix ${dir} install`, `npm -C ${dir} install`]) {
      const guardHits = findNpmInstallInvocations(form);
      assert.equal(guardHits.length, 1, `guard must flag: ${form}`);

      const [cmd, ...args] = form.split(/\s+/);
      const result = spawnSync(
        cmd,
        [...args, "--dry-run", "--ignore-scripts", "--no-package-lock"],
        { encoding: "utf8" }
      );
      assert.equal(
        result.status,
        0,
        `expected "${form}" to actually run as a real npm install (dry-run): ${result.stderr}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Form 2: the executable name ITSELF quoted (`"npm" install`), as
// opposed to the already-handled quoted subcommand (`npm "install"`). ---

test('mutation control: a double-quoted executable name (`"npm" install`) is caught', () => {
  const hits = findNpmInstallInvocations('"npm" install');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
});

test("mutation control: a single-quoted executable name (`'npm' install`) is caught", () => {
  const hits = findNpmInstallInvocations("'npm' install");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
});

test('green control: a quoted executable name with a permitted subcommand (`"npm" ci`) is never flagged', () => {
  assert.deepEqual(findNpmInstallInvocations('"npm" ci'), []);
});

test("real-executable proof: a quoted executable name genuinely runs as npm install (--dry-run, no network/lockfile effects)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-quoted-exe-form-"));
  try {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" })
    );
    const form = '"npm" install';
    const guardHits = findNpmInstallInvocations(form);
    assert.equal(guardHits.length, 1, `guard must flag: ${form}`);

    const [cmd, ...args] = form.replace(/['"]/g, "").split(/\s+/);
    const result = spawnSync(cmd, [...args, "--dry-run", "--ignore-scripts", "--no-package-lock"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `expected '${form}' to actually run as a real npm install (dry-run): ${result.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Form 3: a PROGRAMMATIC child_process invocation
// (`execFileSync("npm", ["install"])`) in JS/TS source, as opposed to
// shell-command-shaped text. This is the form with no `npm install`
// SUBSTRING anywhere in the file - the command name and subcommand are
// separate JS array elements, so the shell-text scanner can never see it;
// it needs its own detection path (findForbiddenChildProcessNpmCalls). ---

test('mutation control: a real execFileSync("npm", ["install"]) call is caught', () => {
  const hits = findForbiddenChildProcessNpmCalls(
    'execFileSync("npm", ["install"], { cwd: REPO_ROOT, stdio: "inherit" });'
  );
  assert.equal(
    hits.length,
    1,
    "a programmatic npm install invocation must be caught even with no shell-text substring"
  );
  assert.equal(hits[0].kind, "install");
});

test('green control: the real execFileSync("npm", ["ci"]) call this repo\'s own verify-install-reproducibility.mjs makes is never flagged', () => {
  const hits = findForbiddenChildProcessNpmCalls(
    'execFileSync("npm", ["ci"], { cwd: REPO_ROOT, stdio: "inherit" });'
  );
  assert.deepEqual(hits, [], "npm ci is the permitted invocation - it must not be flagged");
});

test("mutation control: spawnSync and spawn are caught the same way as execFileSync, including single-quoted args", () => {
  assert.equal(
    findForbiddenChildProcessNpmCalls("spawnSync('npm', ['install']);")[0].kind,
    "install"
  );
  assert.equal(findForbiddenChildProcessNpmCalls("spawn('npm', ['install']);")[0].kind, "install");
  assert.deepEqual(findForbiddenChildProcessNpmCalls("spawnSync('npm', ['ci']);"), []);
});

test("mutation control: a namespaced call (`child_process.execFileSync(...)`) is caught too", () => {
  const hits = findForbiddenChildProcessNpmCalls('child_process.execFileSync("npm", ["install"]);');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "install");
});

test("green control: example code inside a // or block comment is not mistaken for a real call", () => {
  const withLineComment =
    '// execFileSync("npm", ["install"]) is an example\nexecFileSync("npm", ["ci"]);';
  assert.deepEqual(findForbiddenChildProcessNpmCalls(withLineComment), []);

  const withBlockComment =
    '/* e.g. execFileSync("npm", ["install"]) */\nexecFileSync("npm", ["ci"]);';
  assert.deepEqual(findForbiddenChildProcessNpmCalls(withBlockComment), []);
});

test("green control: a // comment does not truncate a real call sharing a line with a https:// URL-bearing string", () => {
  // The `(?<!:)` guard in stripJsComments is what keeps this from being
  // misread as a comment starting at the URL's own `//`.
  const line = 'log("see https://example.invalid"); execFileSync("npm", ["ci"]); // done';
  assert.deepEqual(findForbiddenChildProcessNpmCalls(line), []);
});

test("fail-closed: an interpolated template-literal subcommand in an args array is flagged unresolved, not silently passed", () => {
  const hits = findForbiddenChildProcessNpmCalls('execFileSync("npm", [`${cmd}`]);');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "unresolved");
});

test("reports a 1-based line number for a programmatic call further down the file", () => {
  const source = [
    'import { execFileSync } from "node:child_process";',
    "",
    'execFileSync("npm", ["install"]);',
    "",
  ].join("\n");
  const hits = findForbiddenChildProcessNpmCalls(source);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
});

test("checkFile picks up a programmatic npm-install regression in a scripts/*.mjs file", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ghantika-programmatic-guard-"));
  try {
    const scriptsDir = path.join(scratch, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      path.join(scriptsDir, "mutant-installer.mjs"),
      'import { execFileSync } from "node:child_process";\nexecFileSync("npm", ["install"]);\n'
    );

    const hits = checkFile("scripts/mutant-installer.mjs", scratch);
    assert.equal(
      hits.length,
      1,
      "checkFile must run the programmatic scanner too, not just the shell-text one"
    );
    assert.equal(hits[0].kind, "install");
    assert.equal(hits[0].line, 2);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('real-executable proof (conceptual): execFileSync("npm", ["install", ...]) genuinely runs as npm install (--dry-run, no network/lockfile effects)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-real-execfilesync-"));
  try {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" })
    );
    const guardHits = findForbiddenChildProcessNpmCalls('execFileSync("npm", ["install"]);');
    assert.equal(guardHits.length, 1, 'guard must flag execFileSync("npm", ["install"])');

    const result = spawnSync(
      "npm",
      ["install", "--dry-run", "--ignore-scripts", "--no-package-lock"],
      {
        cwd: dir,
        encoding: "utf8",
      }
    );
    assert.equal(
      result.status,
      0,
      `expected the programmatic form to actually run as a real npm install (dry-run): ${result.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Form 4: a JSON field OTHER than package.json's "scripts" block
// holding an install invocation (e.g. `"command": "npm install"` in some
// other tracked JSON config file). findForbiddenNpmScripts only ever
// looks inside `scripts{}`; findForbiddenInJsonValues covers the rest of
// the document. ---

test("mutation control: an npm-install regression in a JSON field OTHER than scripts is caught", () => {
  const withRegression = JSON.stringify({ command: "npm install", scripts: { build: "npm ci" } });
  const hits = findForbiddenInJsonValues(withRegression);
  assert.equal(
    hits.length,
    1,
    "a non-scripts JSON field holding an install invocation must be caught"
  );
  assert.equal(hits[0].path, "command");
  assert.equal(hits[0].kind, "install");
});

test("mutation control: a nested/array JSON field holding an install invocation is caught, with a descriptive path", () => {
  const withRegression = JSON.stringify({ steps: [{ run: "npm ci" }, { run: "npm install" }] });
  const hits = findForbiddenInJsonValues(withRegression);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "steps[1].run");
  assert.equal(hits[0].kind, "install");
});

test("green control: a clean non-scripts JSON field is never flagged", () => {
  const clean = JSON.stringify({ command: "npm ci", scripts: { build: "npm ci" } });
  assert.deepEqual(findForbiddenInJsonValues(clean), []);
});

test("findForbiddenInJsonValues skips the root scripts{} block (that's findForbiddenNpmScripts' job), so a scripts regression isn't double-reported", () => {
  const withScriptsRegression = JSON.stringify({ scripts: { build: "npm install" } });
  assert.deepEqual(
    findForbiddenInJsonValues(withScriptsRegression),
    [],
    "scripts{} is out of scope for this scanner - findForbiddenNpmScripts already covers it"
  );
  assert.equal(
    findForbiddenNpmScripts(withScriptsRegression).length,
    1,
    "sanity check: the scripts-scoped scanner does catch it"
  );
});

test("checkFile combines both JSON scans for a .json file, catching a regression in either scripts or another field", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ghantika-json-fields-guard-"));
  try {
    writeFileSync(
      path.join(scratch, "config.json"),
      JSON.stringify({ command: "npm install", scripts: { build: "npm install" } })
    );
    // config.json only becomes a scan target once README.md/package.json
    // exist too, since listScanTargets always walks the same permitted
    // surfaces - but checkFile itself works standalone against any path.
    const hits = checkFile("config.json", scratch);
    assert.equal(
      hits.length,
      2,
      "both the scripts-block hit and the other-field hit must be reported"
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// --- Form 5: a markdown code block whose invocation is split across a
// shell line continuation (`npm \` then a newline then `  install`).
// findForbiddenInstallCommands already joins continuations INSIDE a code
// block before splitting it into lines (see its own source) - this is a
// regression test locking that in, not a new fix. ---

test("a markdown code block's line continuation is recognized as one invocation (already covered by findForbiddenInstallCommands, not a new fix)", () => {
  const markdown = ["## Install", "", "```", "npm \\", "  install", "```", ""].join("\n");
  const hits = findForbiddenInstallCommands(markdown);
  assert.equal(
    hits.length,
    1,
    "a continuation inside a fenced code block must be recognized as one invocation"
  );
  assert.equal(hits[0].kind, "install");
  assert.equal(hits[0].match, "npm install");
});
