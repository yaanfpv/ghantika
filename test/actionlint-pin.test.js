import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

// This suite has three parts. The first parses .github/workflows/ci.yml as
// data (never executes it) and checks the actionlint job's exact shape:
// the pinned URL, the saved filename, the recorded checksum, and the
// ordering that puts verification before extraction. Its early-invocation
// scan is a fast, text-only first pass, not a proof - it recognizes a
// handful of known ways a shell line can spell "run actionlint" (a bare
// word, a path-qualified form, a couple of common wrappers), and a shell
// script can always spell a command a way this kind of pattern list hasn't
// thought of yet (a plain variable holding the name, a function, an alias,
// `eval`, and more).
//
// The second part actually drives the job's two real run steps, in order,
// inside a scratch directory, with a fake curl (so nothing ever touches
// the network), a portable checksum helper that genuinely hashes whatever
// bytes are on disk, and a fake actionlint binary that only proves it was
// reached. That is what tells the difference between "the text looks
// right" and "a hash mismatch actually stops the job before extraction,"
// which a parse-only check can't do on its own.
//
// The third part generalizes that same execution-based approach across an
// arbitrary, mutated sequence of steps, so that no matter how a stray or
// inserted line tries to invoke actionlint early - a whole extra step, a
// line buried inside the install step's own block, a bare word, a
// path-qualified path, a variable holding the name, or a wrapper command -
// a real shell actually running that text is what decides whether an early
// invocation gets through, never a guess about how the text is shaped.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const HASH_FILE_PATH = path.join(REPO_ROOT, "config", "actionlint-artifact.sha256");

const ACTIONLINT_JOB_ID = "actionlint";
const PINNED_VERSION = "1.7.12";
const PINNED_ARCHIVE_FILENAME = `actionlint_${PINNED_VERSION}_linux_amd64.tar.gz`;
const PINNED_URL = `https://github.com/rhysd/actionlint/releases/download/v${PINNED_VERSION}/${PINNED_ARCHIVE_FILENAME}`;
const HASH_FILE_RELATIVE_PATH = "config/actionlint-artifact.sha256";
// The expected SHA-256 digest of the real actionlint_1.7.12_linux_amd64.tar.gz
// release asset published at PINNED_URL.
const VERIFIED_PINNED_SHA256 = "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8";

const MOVING_REFERENCE_PATTERNS = [
  /raw\.githubusercontent\.com/,
  /\/(?:main|master|HEAD)\//,
  /@(?:main|master|HEAD)\b/,
];

const SWALLOW_PATTERNS = [/\|\|\s*true\b/, /\|\|\s*:(\s|$)/, /;\s*true\s*$/];

// Forms that make "actionlint" the thing actually being EXECUTED in a CI
// `run:` block, as opposed to it merely appearing inside a larger token -
// a versioned archive filename (actionlint_1.7.12_linux_amd64.tar.gz), the
// checksum record's own filename (actionlint-artifact.sha256), a URL path
// segment. Each pattern requires "actionlint" to sit in command position:
// right at the start of a line, right after a shell command separator (`;`,
// `&&`, `||`, a pipe), inside a command substitution (`$(...)` or
// backticks), path-qualified (`./actionlint`, `$RUNNER_TEMP/bin/actionlint`),
// or passed as the argument to a small set of pass-through wrappers real CI
// scripts actually use (`exec`, `command`, `env`, `sudo`, `time`, `xargs`,
// or a `bash -c` / `sh -c` string).
//
// This list can never be complete. A shell can indirect a command through
// a plain variable (`tool=actionlint; "$tool" -color`), a function, an
// alias, `eval`, and other forms this pattern set doesn't name, and every
// one of those resolves "actionlint" exactly the way a bare invocation
// does. Treat this as a fast, incomplete first pass, not the real guard -
// the hermetic execution tests further down actually run the step text
// through a real shell against a sentinel-writing stand-in, which is what
// proves the property regardless of how the invocation is spelled.
const ACTIONLINT_INVOCATION_PATTERNS = [
  /(?:^|[;&|]|\$\(|`)\s*(?:\.{1,2}\/|\/[\w./-]*\/|\$\{?RUNNER_TEMP\}?\/(?:bin\/)?|\$\{?GITHUB_WORKSPACE\}?\/)?actionlint\b/,
  /\b(?:exec|command|env|sudo|time|xargs)\s+(?:-\S+\s+)*actionlint\b/,
  /\b(?:bash|sh|zsh)\s+-c\b.*\bactionlint\b/,
];

/**
 * @param {string} line
 * @returns {boolean}
 */
function lineInvokesActionlint(line) {
  return ACTIONLINT_INVOCATION_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * @param {string} [filePath]
 * @returns {{ jobs: Record<string, any> }}
 */
function loadWorkflow(filePath = WORKFLOW_PATH) {
  return loadYaml(readFileSync(filePath, "utf8"));
}

/**
 * Locates the actionlint job's two load-bearing steps inside an already
 * parsed workflow object: the install/verify step (identified by the
 * `sha256sum --check` it runs, not by position, so a mutation that adds or
 * removes a step around it doesn't change what this finds) and the later
 * step that invokes the bare `actionlint -color` from PATH.
 *
 * @param {any} workflow
 * @returns {{ steps: any[], installIndex: number, invokeIndex: number }}
 */
function locateActionlintSteps(workflow) {
  const steps = workflow?.jobs?.[ACTIONLINT_JOB_ID]?.steps ?? [];
  const installIndex = steps.findIndex(
    (step) => typeof step?.run === "string" && step.run.includes("sha256sum --check")
  );
  const invokeIndex = steps.findIndex(
    (step, index) =>
      index > installIndex &&
      typeof step?.run === "string" &&
      step.run.trim() === "actionlint -color"
  );
  return { steps, installIndex, invokeIndex };
}

/**
 * Scans every step STRICTLY BEFORE installIndex - never installIndex
 * itself or later, since the recipe's own tar-extraction line legitimately
 * names "actionlint" as the member to extract, and that is not an
 * invocation - for anything matching one of the recognized invocation
 * forms above. It checks each step's own index against installIndex,
 * never a fixed position, so an inserted extra step shifts installIndex and
 * is still scanned correctly.
 *
 * This is a fast, text-only pass at this recipe's real security property
 * (nothing before verification may ever invoke actionlint, in any form) -
 * the pattern list above is necessarily incomplete, so the hermetic
 * execution tests further down are what actually establish the property,
 * by observing real shell behavior instead of matching text.
 *
 * @param {any[]} steps
 * @param {number} installIndex
 * @returns {{ index: number, name: string, line: string } | null}
 */
function findEarlyActionlintInvocation(steps, installIndex) {
  if (installIndex === -1) return null;
  for (let index = 0; index < installIndex; index += 1) {
    const step = steps[index];
    if (typeof step?.run !== "string") continue;
    for (const line of step.run.split("\n")) {
      if (lineInvokesActionlint(line)) {
        return { index, name: step.name ?? `step ${index}`, line: line.trim() };
      }
    }
  }
  return null;
}

/**
 * Everything this file's static, text-only pass checks about the
 * actionlint recipe, checked directly against the parsed workflow plus the
 * recorded checksum file's content
 * (passed in rather than read from disk, so a mutation test can hand it a
 * broken record without touching the real file). Returns a list of
 * problems; an empty list means the recipe is clean.
 *
 * @param {any} workflow
 * @param {string | null | undefined} hashRecordContent
 * @returns {string[]}
 */
function validateActionlintRecipe(workflow, hashRecordContent) {
  const problems = [];
  const job = workflow?.jobs?.[ACTIONLINT_JOB_ID];
  if (!job) {
    problems.push(`no "${ACTIONLINT_JOB_ID}" job found in the workflow`);
    return problems;
  }

  const { steps, installIndex, invokeIndex } = locateActionlintSteps(workflow);

  if (installIndex === -1) {
    problems.push('no step runs "sha256sum --check" - the install/verify step is missing');
  }
  if (invokeIndex === -1) {
    problems.push(
      'no later step runs the bare "actionlint -color" - it must resolve from PATH, not "./actionlint"'
    );
  }

  const earlyInvocation = findEarlyActionlintInvocation(steps, installIndex);
  if (earlyInvocation) {
    problems.push(
      `step ${earlyInvocation.index} ("${earlyInvocation.name}") invokes actionlint before the checksum verification/extraction step - this must never happen: "${earlyInvocation.line}"`
    );
  }

  let savedAs = null;
  if (installIndex !== -1) {
    const runText = steps[installIndex].run;
    const lines = runText.split("\n");
    const lineIndexOf = (pattern) => lines.findIndex((line) => pattern.test(line));

    if (!runText.includes(PINNED_URL)) {
      problems.push(`install step does not fetch the exact pinned URL ${PINNED_URL}`);
    }
    for (const pattern of MOVING_REFERENCE_PATTERNS) {
      if (pattern.test(runText)) {
        problems.push(`install step fetches from a moving reference (matched ${pattern})`);
      }
    }

    const oMatch = runText.match(/-o\s+(\S+)/);
    savedAs = oMatch ? oMatch[1] : null;
    if (savedAs !== PINNED_ARCHIVE_FILENAME) {
      problems.push(
        `install step saves the download as "${savedAs}", expected exactly "${PINNED_ARCHIVE_FILENAME}"`
      );
    }

    if (!runText.includes(`sha256sum --check ${HASH_FILE_RELATIVE_PATH}`)) {
      problems.push(`install step does not run "sha256sum --check ${HASH_FILE_RELATIVE_PATH}"`);
    }

    const shaLineIndex = lineIndexOf(/sha256sum --check/);
    if (shaLineIndex !== -1) {
      const shaLine = lines[shaLineIndex];
      for (const pattern of SWALLOW_PATTERNS) {
        if (pattern.test(shaLine)) {
          problems.push(
            `the checksum-verification line swallows a nonzero exit (matched ${pattern}): "${shaLine.trim()}"`
          );
        }
      }
    }

    const curlLineIndex = lineIndexOf(/curl\b/);
    const tarLineIndex = lineIndexOf(/tar -xzf/);
    const pathAppendLineIndex = lineIndexOf(/>>\s*"\$GITHUB_PATH"/);

    if (curlLineIndex === -1) problems.push("install step never downloads with curl");
    if (tarLineIndex === -1) problems.push("install step never extracts with tar -xzf");
    if (pathAppendLineIndex === -1) {
      problems.push('install step never appends the extraction directory to "$GITHUB_PATH"');
    }
  }

  if (
    hashRecordContent === null ||
    hashRecordContent === undefined ||
    hashRecordContent.trim() === ""
  ) {
    problems.push("the recorded checksum file is missing or empty");
  } else {
    const nonEmptyLines = hashRecordContent.split("\n").filter((line) => line.trim() !== "");
    if (nonEmptyLines.length !== 1) {
      problems.push(
        `the recorded checksum file must contain exactly one line, found ${nonEmptyLines.length}`
      );
    } else {
      const match = nonEmptyLines[0].match(/^([0-9a-fA-F]{64}) {2}(\S+)$/);
      if (!match) {
        problems.push(
          `the recorded checksum line is malformed (expected "<64-hex>  <filename>"): "${nonEmptyLines[0]}"`
        );
      } else {
        const [, hex, filename] = match;
        if (hex.toLowerCase() !== VERIFIED_PINNED_SHA256.toLowerCase()) {
          problems.push(
            `the recorded checksum ${hex} does not match the independently verified release digest ${VERIFIED_PINNED_SHA256}`
          );
        }
        if (filename !== PINNED_ARCHIVE_FILENAME) {
          problems.push(
            `the recorded checksum names "${filename}", expected exactly "${PINNED_ARCHIVE_FILENAME}"`
          );
        }
        if (savedAs && savedAs !== filename) {
          problems.push(
            `the archive is saved as "${savedAs}" but the recorded checksum names "${filename}" - they must agree`
          );
        }
      }
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Static shape: parse ci.yml as data and check it against the pinned recipe.
// ---------------------------------------------------------------------------

test("positive: the real ci.yml pins the exact v1.7.12 release asset, verifies before extracting, and invokes a bare actionlint later", () => {
  const workflow = loadWorkflow();
  const hashRecord = readFileSync(HASH_FILE_PATH, "utf8");
  assert.deepEqual(validateActionlintRecipe(workflow, hashRecord), []);
});

test("green control: the recorded checksum matches the value independently verified against the real v1.7.12 release archive", () => {
  const hashRecord = readFileSync(HASH_FILE_PATH, "utf8").trim();
  assert.equal(hashRecord, `${VERIFIED_PINNED_SHA256}  ${PINNED_ARCHIVE_FILENAME}`);
});

/**
 * Clones the real, currently-loaded workflow and rewrites the install
 * step's run text through `mutate`, leaving everything else untouched -
 * so each test below exercises exactly one dimension of the real recipe
 * rather than a hand-built stand-in for it.
 *
 * @param {(run: string) => string} mutate
 */
function withMutatedInstallRun(mutate) {
  const workflow = structuredClone(loadWorkflow());
  const { steps, installIndex } = locateActionlintSteps(workflow);
  assert.notEqual(installIndex, -1, "test setup: could not locate the real install step");
  steps[installIndex] = { ...steps[installIndex], run: mutate(steps[installIndex].run) };
  return workflow;
}

test("negative: fetching from the old moving main-branch source is flagged", () => {
  const workflow = withMutatedInstallRun((run) =>
    run.replace(
      PINNED_URL,
      "https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash"
    )
  );
  const problems = validateActionlintRecipe(workflow, readFileSync(HASH_FILE_PATH, "utf8"));
  assert.ok(problems.length > 0);
  assert.ok(problems.some((p) => /pinned URL|moving reference/.test(p)));
});

test("negative: saving the archive under a different filename than the pin is flagged, including its disagreement with the checksum record", () => {
  const workflow = withMutatedInstallRun((run) =>
    run.replace(`-o ${PINNED_ARCHIVE_FILENAME}`, "-o actionlint.tar.gz")
  );
  const problems = validateActionlintRecipe(workflow, readFileSync(HASH_FILE_PATH, "utf8"));
  assert.ok(problems.length > 0);
  assert.ok(problems.some((p) => /saves the download as "actionlint\.tar\.gz"/.test(p)));
  assert.ok(problems.some((p) => /they must agree/.test(p)));
});

test("negative: altering the pinned version in the URL away from 1.7.12 is flagged", () => {
  const workflow = withMutatedInstallRun((run) => run.replace(/v1\.7\.12/g, "v1.7.11"));
  const problems = validateActionlintRecipe(workflow, readFileSync(HASH_FILE_PATH, "utf8"));
  assert.ok(problems.length > 0);
  assert.ok(problems.some((p) => /pinned URL/.test(p)));
});

test("negative: an empty recorded checksum file is flagged", () => {
  const workflow = loadWorkflow();
  const problems = validateActionlintRecipe(workflow, "");
  assert.ok(problems.some((p) => /missing or empty/.test(p)));
});

test("negative: a malformed recorded checksum line is flagged", () => {
  const workflow = loadWorkflow();
  const problems = validateActionlintRecipe(workflow, "not-a-real-hash-line\n");
  assert.ok(problems.some((p) => /malformed/.test(p)));
});

test("negative: a recorded checksum that does not match the verified release digest is flagged", () => {
  const workflow = loadWorkflow();
  const wrongHex = "0".repeat(64);
  const problems = validateActionlintRecipe(workflow, `${wrongHex}  ${PINNED_ARCHIVE_FILENAME}\n`);
  assert.ok(
    problems.some((p) => /does not match the independently verified release digest/.test(p))
  );
});

test("negative: more than one line in the recorded checksum file is flagged", () => {
  const workflow = loadWorkflow();
  const record = `${VERIFIED_PINNED_SHA256}  ${PINNED_ARCHIVE_FILENAME}\n${VERIFIED_PINNED_SHA256}  extra-file\n`;
  const problems = validateActionlintRecipe(workflow, record);
  assert.ok(problems.some((p) => /exactly one line/.test(p)));
});

test("negative: swallowing a hash-check failure with a trailing || true is flagged", () => {
  const workflow = withMutatedInstallRun((run) =>
    run.replace(
      `sha256sum --check ${HASH_FILE_RELATIVE_PATH}`,
      `sha256sum --check ${HASH_FILE_RELATIVE_PATH} || true`
    )
  );
  const problems = validateActionlintRecipe(workflow, readFileSync(HASH_FILE_PATH, "utf8"));
  assert.ok(problems.some((p) => /swallows a nonzero exit/.test(p)));
});

test("negative: invoking ./actionlint instead of the bare PATH-resolved binary is flagged", () => {
  const workflow = structuredClone(loadWorkflow());
  const { steps, invokeIndex } = locateActionlintSteps(workflow);
  assert.notEqual(invokeIndex, -1, "test setup: could not locate the real invoke step");
  steps[invokeIndex] = { ...steps[invokeIndex], run: "./actionlint -color" };
  const problems = validateActionlintRecipe(workflow, readFileSync(HASH_FILE_PATH, "utf8"));
  assert.ok(problems.some((p) => /bare "actionlint -color"/.test(p)));
});

test("negative: an early, unverified actionlint invocation before the checksum-verify step is flagged, and reverting the insertion restores a clean result", () => {
  const workflow = structuredClone(loadWorkflow());
  const hashRecord = readFileSync(HASH_FILE_PATH, "utf8");
  const { steps, installIndex: baselineInstallIndex } = locateActionlintSteps(workflow);
  assert.notEqual(baselineInstallIndex, -1, "test setup: could not locate the real install step");

  // Baseline, before any mutation: the untouched clone is clean, same as
  // the positive check above - this is the "confirm green again" half done up front too,
  // so the red in the middle is provably caused by the insertion and
  // nothing else.
  assert.deepEqual(validateActionlintRecipe(workflow, hashRecord), []);

  // Apply the mutation for real: splice a brand-new step running a bare,
  // unverified `actionlint -color` in immediately before the checksum-verify
  // step. Nothing else in the recipe changes, so this isolates exactly the
  // one property under test - the exact gap in the old
  // `index > installIndex`-only search, which never looked here at all.
  const earlyStep = { name: "premature actionlint (must be rejected)", run: "actionlint -color" };
  steps.splice(baselineInstallIndex, 0, earlyStep);
  const { installIndex: mutatedInstallIndex } = locateActionlintSteps(workflow);
  assert.equal(
    mutatedInstallIndex,
    baselineInstallIndex + 1,
    "test setup: the insertion should shift the install step forward by exactly one"
  );

  const problemsWithMutation = validateActionlintRecipe(workflow, hashRecord);
  assert.ok(problemsWithMutation.length > 0, "the early invocation must be flagged");
  assert.ok(
    problemsWithMutation.some(
      (p) => /invokes actionlint before/.test(p) && /premature actionlint/.test(p)
    ),
    `expected a problem naming the early step, got: ${JSON.stringify(problemsWithMutation)}`
  );

  // Revert: remove exactly the step just inserted, nothing else, and
  // confirm the recipe reads clean again - proving the mutation itself is
  // what made it red, and that removing it (not some other side effect)
  // is what makes it green again.
  const removed = steps.splice(baselineInstallIndex, 1);
  assert.equal(
    removed[0],
    earlyStep,
    "test cleanup: removed a different step than the one inserted"
  );
  assert.deepEqual(validateActionlintRecipe(workflow, hashRecord), []);
});

// findEarlyActionlintInvocation states, in its own doc comment, that it is a
// fast, text-only pre-filter over a documented set of recognized invocation
// shapes - never the actual guarantee, which the hermetic execution tests
// further down establish by really running the step text through a shell.
// The two checks below confirm exactly that division of labor with real
// constructed mutants rather than trusting the comment: a path-qualified
// and a wrapper-command early invocation - both forms ACTIONLINT_INVOCATION_PATTERNS
// explicitly documents as recognized - are caught by this static check
// alone, while a shell-variable indirection - a form the same doc comment
// explicitly says this pattern list cannot name - passes it clean, exactly
// as documented, with the suite's own hermetic mutation test further down
// ("actionlint invoked through a shell variable that holds its name is
// caught by real execution...") the one that actually needs to catch it.
test("findEarlyActionlintInvocation catches every documented invocation shape - path-qualified and wrapper forms - and honestly passes a shell-variable indirection clean, exactly as its own incompleteness is documented to allow", () => {
  const hashRecord = readFileSync(HASH_FILE_PATH, "utf8");

  const pathQualifiedWorkflow = structuredClone(loadWorkflow());
  {
    const { steps, installIndex } = locateActionlintSteps(pathQualifiedWorkflow);
    assert.notEqual(installIndex, -1, "test setup: could not locate the real install step");
    steps.splice(installIndex, 0, {
      name: "premature path-qualified invocation (must be rejected)",
      run: "$RUNNER_TEMP/bin/actionlint -color",
    });
  }
  const pathQualifiedProblems = validateActionlintRecipe(pathQualifiedWorkflow, hashRecord);
  assert.ok(
    pathQualifiedProblems.some(
      (p) => /invokes actionlint before/.test(p) && /premature path-qualified invocation/.test(p)
    ),
    `expected the path-qualified early invocation to be flagged, got: ${JSON.stringify(pathQualifiedProblems)}`
  );

  const wrapperWorkflow = structuredClone(loadWorkflow());
  {
    const { steps, installIndex } = locateActionlintSteps(wrapperWorkflow);
    assert.notEqual(installIndex, -1, "test setup: could not locate the real install step");
    steps.splice(installIndex, 0, {
      name: "premature exec-wrapped invocation (must be rejected)",
      run: "exec actionlint -color",
    });
  }
  const wrapperProblems = validateActionlintRecipe(wrapperWorkflow, hashRecord);
  assert.ok(
    wrapperProblems.some(
      (p) => /invokes actionlint before/.test(p) && /premature exec-wrapped invocation/.test(p)
    ),
    `expected the exec-wrapped early invocation to be flagged, got: ${JSON.stringify(wrapperProblems)}`
  );

  const indirectedWorkflow = structuredClone(loadWorkflow());
  {
    const { steps, installIndex } = locateActionlintSteps(indirectedWorkflow);
    assert.notEqual(installIndex, -1, "test setup: could not locate the real install step");
    steps.splice(installIndex, 0, {
      name: "premature variable-indirected invocation (this static check cannot see it)",
      run: 'tool=actionlint\n"$tool" -color',
    });
  }
  const indirectedProblems = validateActionlintRecipe(indirectedWorkflow, hashRecord);
  assert.ok(
    !indirectedProblems.some((p) => /invokes actionlint before/.test(p)),
    `test assumption: this static check is documented not to catch variable indirection, but it did: ${JSON.stringify(indirectedProblems)}`
  );
});

// ---------------------------------------------------------------------------
// Hermetic execution: drive the real two run steps for real, never touching
// the network. A fake curl copies a local fixture archive instead of
// fetching one; a portable checksum helper genuinely hashes whatever bytes
// are actually on disk (it does not know in advance whether they match);
// the real system tar extracts; a fake actionlint only proves it ran.
// ---------------------------------------------------------------------------

const ACTIONLINT_FIXTURE_SCRIPT = [
  "#!/usr/bin/env node",
  'require("fs").writeFileSync(process.env.ACTIONLINT_INVOKED_SENTINEL, "invoked\\n");',
  "",
].join("\n");

// A second, distinctly-behaving "actionlint" stand-in used only inside a
// rogue archive built by the driveWithRogueMarker mutation controls below:
// it touches ROGUE_ACTIONLINT_MARKER instead of the shared sentinel, so
// "the invoke step ran the rogue, unverified replacement" is a distinct,
// observable fact rather than indistinguishable from the legitimate case.
const ROGUE_ACTIONLINT_FIXTURE_SCRIPT = [
  "#!/usr/bin/env node",
  'require("fs").writeFileSync(process.env.ROGUE_ACTIONLINT_MARKER, "invoked\\n");',
  "",
].join("\n");

const FAKE_CURL_SCRIPT = [
  "#!/usr/bin/env node",
  "// Hermetic stand-in for curl: never touches the network. Copies the local",
  "// fixture archive named by FIXTURE_ARCHIVE to whatever destination the",
  "// real recipe's \"-o\" flag names, so the recipe's own text runs",
  "// unmodified against a real file on disk.",
  'const fs = require("fs");',
  "const args = process.argv.slice(2);",
  'const oIndex = args.indexOf("-o");',
  "if (oIndex === -1 || oIndex + 1 >= args.length) {",
  '  console.error("fixture curl: expected a -o <dest> argument");',
  "  process.exit(2);",
  "}",
  "const dest = args[oIndex + 1];",
  "const src = process.env.FIXTURE_ARCHIVE;",
  "if (!src) {",
  '  console.error("fixture curl: FIXTURE_ARCHIVE is not set");',
  "  process.exit(2);",
  "}",
  "fs.copyFileSync(src, dest);",
  "",
].join("\n");

const FAKE_SHA256SUM_SCRIPT = [
  "#!/usr/bin/env node",
  '// Portable stand-in for GNU coreutils sha256sum\'s "--check" mode: this',
  "// project's test job also runs on macOS runners that do not ship a real",
  "// sha256sum. It genuinely hashes whatever bytes the named file actually",
  "// contains, with Node's own crypto module, and compares hex digests - it",
  "// never trusts a canned pass or fail.",
  'const fs = require("fs");',
  'const crypto = require("crypto");',
  "const args = process.argv.slice(2);",
  'if (args[0] !== "--check" || args.length < 2) {',
  "  console.error('fixture sha256sum: only \"--check <file>\" is supported');",
  "  process.exit(2);",
  "}",
  "function parseLine(line) {",
  "  let i = 0;",
  '  while (i < line.length && line[i] !== " " && line[i] !== "\\t") i++;',
  "  const hex = line.slice(0, i);",
  "  let rest = line.slice(i);",
  "  let j = 0;",
  '  while (j < rest.length && (rest[j] === " " || rest[j] === "\\t")) j++;',
  '  if (rest[j] === "*") j++;',
  "  return { hex, filename: rest.slice(j) };",
  "}",
  "const lines = fs",
  '  .readFileSync(args[1], "utf8")',
  '  .split("\\n")',
  '  .filter((line) => line.trim() !== "");',
  "let failed = false;",
  "for (const line of lines) {",
  "  const { hex, filename } = parseLine(line);",
  "  if (hex.length !== 64 || !filename) {",
  '    console.error("fixture sha256sum: malformed record line: " + line);',
  "    failed = true;",
  "    continue;",
  "  }",
  "  if (!fs.existsSync(filename)) {",
  '    console.log(filename + ": FAILED open or read");',
  "    failed = true;",
  "    continue;",
  "  }",
  '  const actualHex = crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");',
  "  if (actualHex.toLowerCase() === hex.toLowerCase()) {",
  '    console.log(filename + ": OK");',
  "  } else {",
  '    console.log(filename + ": FAILED");',
  "    failed = true;",
  "  }",
  "}",
  "if (failed) {",
  '  console.error("fixture sha256sum: WARNING: 1 computed checksum did NOT match");',
  "  process.exit(1);",
  "}",
  "process.exit(0);",
  "",
].join("\n");

// Stands in for an actionlint binary that already happens to be on the
// runner's inherited PATH before this job's own install step ever runs.
// If anything called "actionlint" while this was reachable, it would
// write to PREEXISTING_ACTIONLINT_MARKER - a different marker from the
// real extracted binary's own sentinel below, so the two can never be
// confused with each other.
const PREEXISTING_ACTIONLINT_STUB_SCRIPT = [
  "#!/usr/bin/env node",
  'require("fs").writeFileSync(process.env.PREEXISTING_ACTIONLINT_MARKER, "invoked\\n");',
  "",
].join("\n");

/**
 * @param {(scratch: string) => any} fn
 */
function withScratchRun(fn) {
  const scratch = mkdtempSync(path.join(tmpdir(), "ghantika-actionlint-hermetic-"));
  try {
    return fn(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Builds a small real tar.gz fixture archive containing one executable
 * member named "actionlint", using the real system tar (both GNU and BSD
 * tar handle a single small member identically for this purpose).
 *
 * @param {string} scratch
 * @param {string} actionlintScript
 * @param {string} name
 */
function buildFixtureArchive(scratch, actionlintScript, name) {
  const archivePath = path.join(scratch, `${name}-archive.tar.gz`);
  const buildDir = path.join(scratch, `${name}-build`);
  mkdirSync(buildDir, { recursive: true });
  const scriptPath = path.join(buildDir, "actionlint");
  writeFileSync(scriptPath, actionlintScript);
  chmodSync(scriptPath, 0o755);
  execFileSync("tar", ["-czf", archivePath, "-C", buildDir, "actionlint"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return archivePath;
}

/**
 * @param {string} scratch
 */
function buildFakeBin(scratch) {
  const fakeBin = path.join(scratch, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(path.join(fakeBin, "curl"), FAKE_CURL_SCRIPT);
  chmodSync(path.join(fakeBin, "curl"), 0o755);
  writeFileSync(path.join(fakeBin, "sha256sum"), FAKE_SHA256SUM_SCRIPT);
  chmodSync(path.join(fakeBin, "sha256sum"), 0o755);
  return fakeBin;
}

/**
 * Builds a directory holding a stand-in for an actionlint binary that
 * already happens to be reachable on the runner's inherited PATH before
 * this job's own install step ever runs - some hosted images ship
 * commonly used tools preinstalled. Kept on PATH for the whole drive
 * (both run steps), it turns "nothing calls actionlint early" from a
 * static claim about the recipe's text into something actually exercised:
 * if anything in either step reached for a bare "actionlint" before the
 * job's own verified extraction, this is what it would find and run,
 * silently succeeding instead of failing with "command not found" - which
 * is exactly the gap an early, unverified invocation could hide behind on
 * a real runner that ships one already.
 *
 * @param {string} scratch
 */
function buildPreexistingActionlintBin(scratch) {
  const dir = path.join(scratch, "preexisting-actionlint-bin");
  mkdirSync(dir, { recursive: true });
  const binPath = path.join(dir, "actionlint");
  writeFileSync(binPath, PREEXISTING_ACTIONLINT_STUB_SCRIPT);
  chmodSync(binPath, 0o755);
  return dir;
}

/**
 * Runs `scriptText` the same way GitHub Actions runs a multi-line `run:`
 * block on a non-Windows runner: `bash --noprofile --norc -eo pipefail
 * <scriptfile>`. That `-e` is what makes a mid-script command failure stop
 * the rest of the script - without replicating it, a hermetic drive would
 * not actually prove anything about the real job's behavior.
 *
 * @param {string} scriptText
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 * @returns {number}
 */
function runShellScript(scriptText, { cwd, env }) {
  const scriptFile = path.join(cwd, `.step-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(scriptFile, scriptText);
  try {
    execFileSync("/bin/bash", ["--noprofile", "--norc", "-eo", "pipefail", scriptFile], {
      cwd,
      env,
      stdio: "pipe",
    });
    return 0;
  } catch (err) {
    return typeof err.status === "number" ? err.status : 1;
  } finally {
    rmSync(scriptFile, { force: true });
  }
}

/**
 * Drives the real actionlint job's two run steps, in order, exactly as
 * GitHub Actions would: the install/verify step first, then - only if that
 * step succeeded, matching the default per-step `if: success()` every job
 * step gets unless a workflow opts out - the later bare-actionlint invoke
 * step, with the extraction directory recorded via GITHUB_PATH folded into
 * PATH for the second step the same way the real runner does it.
 *
 * @param {string} scratch
 * @param {{ installRun: string, invokeRun: string, hashRecordLine: string, archivePath: string }} options
 */
function driveActionlintRecipe(scratch, { installRun, invokeRun, hashRecordLine, archivePath }) {
  const workDir = path.join(scratch, "workdir");
  const runnerTemp = path.join(scratch, "runner-temp");
  const configDir = path.join(workDir, "config");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  const fakeBin = buildFakeBin(scratch);
  // Reachable on PATH for both steps, exactly like a tool a hosted runner
  // image ships preinstalled - see buildPreexistingActionlintBin's own
  // comment for why this has to be part of the drive itself, not just the
  // static text checks above.
  const preexistingActionlintBin = buildPreexistingActionlintBin(scratch);
  const githubPathFile = path.join(scratch, "github_path");
  writeFileSync(githubPathFile, "");
  writeFileSync(path.join(configDir, "actionlint-artifact.sha256"), `${hashRecordLine}\n`);
  const actionlintSentinel = path.join(scratch, "actionlint-invoked.sentinel");
  const preexistingActionlintMarker = path.join(scratch, "preexisting-actionlint-invoked.marker");

  const step1Env = {
    ...process.env,
    PATH: `${fakeBin}:${preexistingActionlintBin}:${process.env.PATH}`,
    RUNNER_TEMP: runnerTemp,
    GITHUB_PATH: githubPathFile,
    FIXTURE_ARCHIVE: archivePath,
    PREEXISTING_ACTIONLINT_MARKER: preexistingActionlintMarker,
  };
  const installExitCode = runShellScript(installRun, { cwd: workDir, env: step1Env });
  const extractionHappened = existsSync(path.join(runnerTemp, "bin", "actionlint"));

  let invokeExitCode = null;
  let actionlintInvoked = false;
  if (installExitCode === 0) {
    const pathAdditions = readFileSync(githubPathFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    // The extraction directory (from pathAdditions, reversed so the most
    // recently appended entry comes first) leads PATH, exactly as GITHUB_PATH
    // prepending does on a real runner, so a correct recipe still reaches the
    // just-extracted, freshly verified binary and not this step's own
    // preexisting-PATH stand-in.
    const step2Env = {
      ...process.env,
      PATH: [...pathAdditions.slice().reverse(), process.env.PATH, preexistingActionlintBin].join(
        ":"
      ),
      RUNNER_TEMP: runnerTemp,
      ACTIONLINT_INVOKED_SENTINEL: actionlintSentinel,
      PREEXISTING_ACTIONLINT_MARKER: preexistingActionlintMarker,
    };
    invokeExitCode = runShellScript(invokeRun, { cwd: workDir, env: step2Env });
    actionlintInvoked = existsSync(actionlintSentinel);
  }

  const preexistingActionlintInvoked = existsSync(preexistingActionlintMarker);

  return {
    installExitCode,
    invokeExitCode,
    extractionHappened,
    actionlintInvoked,
    preexistingActionlintInvoked,
  };
}

/**
 * @param {string} filePath
 */
function computeSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Drives an ordered list of run steps - the real canonical install step
 * plus one extra, hand-authored "rogue" step exercising one specific way
 * of getting an unverified actionlint reachable - through a real shell,
 * then the real invoke step, exactly like driveActionlintStepSequence,
 * but with a SECOND, distinctly-named marker file
 * (ROGUE_ACTIONLINT_MARKER) threaded into every step's env alongside the
 * shared sentinel. The real, checksum-verified fixture archive's
 * actionlint script only ever touches ACTIONLINT_INVOKED_SENTINEL; a rogue
 * step's own hand-written stand-in touches ROGUE_ACTIONLINT_MARKER
 * instead. This is what makes "the invoke step ran the rogue, unverified
 * binary instead of the genuine one" an observable, distinct fact rather
 * than indistinguishable from the legitimate case - both would otherwise
 * report the same "something touched the shared sentinel" signal.
 *
 * This is a separate, additive helper - it never modifies
 * driveActionlintRecipe or driveActionlintStepSequence, so the existing
 * tests built on those two keep depending on exactly the behavior they
 * already pass against.
 *
 * A step's own classification (classifyStepCondition/mayExecute) is
 * consulted here the same way driveActionlintStepSequence does: a "never"
 * step is never driven, in any form, regardless of prior status; the
 * prior-failure skip (the implicit "if: success()" default) applies only
 * to a step classified "always"; a "mayRun" step is driven exactly like
 * "always" regardless of whether an earlier step already failed, since its
 * own unproven condition might specifically be designed to run because of
 * that failure.
 *
 * By default the recorded checksum matches the fixture archive this
 * builds, so the canonical install step succeeds. Passing a
 * `hashRecordScript` records the digest of a second, separately built
 * archive instead, so the recorded hash and the actually-built bytes
 * genuinely disagree and the canonical install step genuinely fails -
 * mirroring the same option on driveActionlintStepSequence.
 *
 * @param {{ name: string, run: string, if?: unknown }[]} runSteps
 * @param {{ hashRecordScript?: string }} [options]
 * @returns {{ trace: object[], rogueMarkerTouched: boolean }}
 */
function driveWithRogueMarker(runSteps, { hashRecordScript } = {}) {
  return withScratchRun((scratch) => {
    const workDir = path.join(scratch, "workdir");
    const runnerTemp = path.join(scratch, "runner-temp");
    const configDir = path.join(workDir, "config");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(runnerTemp, { recursive: true });
    const fakeBin = buildFakeBin(scratch);
    const archivePath = buildFixtureArchive(scratch, ACTIONLINT_FIXTURE_SCRIPT, "candidate");
    const hashRecordDigest =
      hashRecordScript === undefined
        ? computeSha256(archivePath)
        : computeSha256(buildFixtureArchive(scratch, hashRecordScript, "reference"));
    writeFileSync(
      path.join(configDir, "actionlint-artifact.sha256"),
      `${hashRecordDigest}  ${PINNED_ARCHIVE_FILENAME}\n`
    );
    const githubPathFile = path.join(scratch, "github_path");
    writeFileSync(githubPathFile, "");
    const sentinelPath = path.join(scratch, "actionlint-invoked.sentinel");
    const rogueMarkerPath = path.join(scratch, "rogue-actionlint-invoked.marker");

    const trace = [];
    let priorStepFailed = false;
    for (let index = 0; index < runSteps.length; index += 1) {
      const step = runSteps[index];

      // "never" is checked unconditionally first, regardless of prior
      // status - a hardcoded-false condition never runs either way, and
      // this is never counted as a failure.
      if (!mayExecute(step)) {
        trace.push({ index, name: step.name, exitCode: null, skipped: false, disabledByIf: true });
        continue;
      }

      // The prior-failure skip (the implicit "if: success()" default)
      // applies only to a step classified "always" here - never to
      // "mayRun", which must still be driven even after an earlier
      // failure, since its own unproven condition might specifically be
      // designed to run because of that failure.
      if (priorStepFailed && classifyStepCondition(step) === "always") {
        trace.push({ index, name: step.name, exitCode: null, skipped: true, disabledByIf: false });
        continue;
      }

      const pathAdditions = readFileSync(githubPathFile, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const env = {
        ...process.env,
        PATH: [...pathAdditions.slice().reverse(), fakeBin, process.env.PATH].join(":"),
        RUNNER_TEMP: runnerTemp,
        GITHUB_PATH: githubPathFile,
        FIXTURE_ARCHIVE: archivePath,
        ACTIONLINT_INVOKED_SENTINEL: sentinelPath,
        ROGUE_ACTIONLINT_MARKER: rogueMarkerPath,
      };
      const exitCode = runShellScript(step.run, { cwd: workDir, env });
      trace.push({ index, name: step.name, exitCode, skipped: false, disabledByIf: false });
      if (exitCode !== 0) priorStepFailed = true;
    }

    return { trace, rogueMarkerTouched: existsSync(rogueMarkerPath) };
  });
}

/**
 * Runs one full rogue-marker round-trip against driveWithRogueMarker:
 * confirm the unmutated recipe never touches the rogue marker and its
 * canonical install step succeeds, splice in one rogue step built by
 * `buildRogueStep` immediately after the canonical install step, drive the
 * mutated sequence and confirm the rogue marker WAS touched - the escape is
 * real and observable - while the rogue step's own commands and the
 * canonical install step's own exit code both remain untouched (the
 * canonical step stays completely correct, which is what makes the escape
 * dangerous rather than obviously broken), then drive the original,
 * never-mutated steps again and confirm the rogue marker stays untouched -
 * proving the escape came from the rogue step and reverting it restores a
 * clean result.
 *
 * @param {(baselineInstallIndex: number) => { name: string, run: string }} buildRogueStep
 */
function assertRogueEscapeCaughtAndReversible(buildRogueStep) {
  const baselineSteps = extractActionlintRunSteps(loadWorkflow());
  const { installIndex: baselineInstallIndex } = locateRunStepIndices(baselineSteps);
  assert.notEqual(baselineInstallIndex, -1, "test setup: could not locate the real install step");

  const baselineResult = driveWithRogueMarker(baselineSteps);
  assert.equal(
    baselineResult.rogueMarkerTouched,
    false,
    "test setup: the unmutated recipe must never touch the rogue marker"
  );
  assert.equal(
    baselineResult.trace[baselineInstallIndex].exitCode,
    0,
    "test setup: the canonical install step must succeed against a matching archive"
  );

  const rogueStep = buildRogueStep(baselineInstallIndex);
  const splicePosition = baselineInstallIndex + 1;
  const mutatedSteps = baselineSteps.slice();
  mutatedSteps.splice(splicePosition, 0, rogueStep);

  // Prove the mutation was applied to a separate copy, never to
  // baselineSteps itself - re-deriving a fresh copy from the real workflow
  // and comparing confirms nothing about the original was touched.
  const freshBaselineSteps = extractActionlintRunSteps(loadWorkflow());
  assert.deepEqual(
    baselineSteps,
    freshBaselineSteps,
    "constructing the rogue step must never alter the original steps it was derived from"
  );

  const rogueIndex = splicePosition;
  const mutatedInstallIndex = baselineInstallIndex;

  const mutatedResult = driveWithRogueMarker(mutatedSteps);
  assert.equal(
    mutatedResult.trace[rogueIndex].exitCode,
    0,
    `the rogue step's own commands must genuinely succeed, got trace: ${JSON.stringify(mutatedResult.trace)}`
  );
  assert.equal(
    mutatedResult.trace[mutatedInstallIndex].exitCode,
    0,
    "the canonical install step itself remains completely correct even though the rogue step defeats PATH resolution"
  );
  assert.equal(
    mutatedResult.rogueMarkerTouched,
    true,
    "the rogue step's replacement must be what the invoke step actually runs"
  );

  // Revert: driving the original, never-mutated baseline steps again must
  // restore a clean result.
  const revertedResult = driveWithRogueMarker(baselineSteps);
  assert.equal(
    revertedResult.rogueMarkerTouched,
    false,
    "driving the original, unmutated steps again must restore a clean result"
  );
}

test("positive hermetic: a matching archive verifies, extracts, and reaches actionlint", () => {
  const workflow = loadWorkflow();
  const { steps, installIndex, invokeIndex } = locateActionlintSteps(workflow);
  assert.notEqual(installIndex, -1);
  assert.notEqual(invokeIndex, -1);
  const installRun = steps[installIndex].run;
  const invokeRun = steps[invokeIndex].run;

  withScratchRun((scratch) => {
    const archivePath = buildFixtureArchive(scratch, ACTIONLINT_FIXTURE_SCRIPT, "good");
    const digest = computeSha256(archivePath);
    const result = driveActionlintRecipe(scratch, {
      installRun,
      invokeRun,
      hashRecordLine: `${digest}  ${PINNED_ARCHIVE_FILENAME}`,
      archivePath,
    });
    assert.equal(
      result.installExitCode,
      0,
      "the verify step must succeed against a matching archive"
    );
    assert.equal(result.extractionHappened, true, "the archive must be extracted once verified");
    assert.equal(
      result.invokeExitCode,
      0,
      "the invoke step must succeed once actionlint is on PATH"
    );
    assert.equal(result.actionlintInvoked, true, "the extracted actionlint must actually run");
    assert.equal(
      result.preexistingActionlintInvoked,
      false,
      "the freshly extracted, verified actionlint must win PATH resolution - the preexisting stand-in on PATH must never be reached"
    );
  });
});

test("negative hermetic: a mismatched archive fails verification, never extracts, and never reaches actionlint", () => {
  const workflow = loadWorkflow();
  const { steps, installIndex, invokeIndex } = locateActionlintSteps(workflow);
  assert.notEqual(installIndex, -1);
  assert.notEqual(invokeIndex, -1);
  const installRun = steps[installIndex].run;
  const invokeRun = steps[invokeIndex].run;

  withScratchRun((scratch) => {
    const goodArchivePath = buildFixtureArchive(scratch, ACTIONLINT_FIXTURE_SCRIPT, "good");
    const goodDigest = computeSha256(goodArchivePath);
    // A genuinely different archive (distinct fixture bytes, so a
    // genuinely different real digest) is what the fake curl actually
    // "downloads," while the recorded checksum still names the one above -
    // a real mismatch the portable checksum helper has to discover for
    // itself, not a pre-decided failure.
    const badArchivePath = buildFixtureArchive(
      scratch,
      ACTIONLINT_FIXTURE_SCRIPT + "// a genuinely different fixture\n",
      "bad"
    );

    const result = driveActionlintRecipe(scratch, {
      installRun,
      invokeRun,
      hashRecordLine: `${goodDigest}  ${PINNED_ARCHIVE_FILENAME}`,
      archivePath: badArchivePath,
    });
    assert.notEqual(result.installExitCode, 0, "a genuine hash mismatch must fail the verify step");
    assert.equal(
      result.extractionHappened,
      false,
      "extraction must never run after a failed verification"
    );
    assert.equal(
      result.invokeExitCode,
      null,
      "the invoke step must be skipped, matching a real job's default if: success()"
    );
    assert.equal(
      result.actionlintInvoked,
      false,
      "actionlint must never be reached on a hash mismatch"
    );
    // Closes the gap an inherited PATH could otherwise hide behind: even
    // with a working actionlint stand-in reachable on PATH throughout this
    // entire failing run, nothing in the recipe ever reaches for it before
    // - or instead of - the verification this run correctly failed.
    assert.equal(
      result.preexistingActionlintInvoked,
      false,
      "actionlint must never be reached on a hash mismatch, even one already sitting on the inherited PATH"
    );
  });
});

// ---------------------------------------------------------------------------
// Multi-step hermetic execution: the property this recipe depends on is
// "nothing before the verified extraction ever actually runs actionlint" -
// and a bare-word check, a step-scoped check, and even a check that
// pattern-matched several known invocation forms have each, in turn, missed
// a real way of writing that invocation. Shell offers unlimited ways to
// indirect a command (a variable holding the name, a function, an alias,
// `eval`, and more), so any list of recognized forms is a promise to keep
// discovering the next one that gets past it. Executing the literal step
// text through a real shell against a sentinel-writing stand-in sidesteps
// the classification problem entirely: whatever the text looks like, if
// the shell's own PATH resolution reaches something literally named
// "actionlint", the stand-in runs and says so.
//
// The functions below drive an arbitrary, ordered list of {name, run} steps
// - drawn straight from the parsed workflow's actionlint job, with an extra
// step spliced in, or with a step's own text rewritten - inside one
// persistent scratch working directory and one accumulating shell
// environment, exactly like real job steps share state across a real
// GitHub Actions run. A sentinel-writing "actionlint" stand-in is reachable
// two ways from before the very first step runs: a bare name on PATH
// (which is also how `env actionlint`, `exec actionlint`,
// `bash -c 'actionlint ...'`, and a shell variable holding the string
// "actionlint" all resolve - none of them differ from an ordinary PATH
// lookup) and a path-qualified `./actionlint` sitting in the steps' own
// working directory. The genuinely extracted, checksum-verified binary
// this recipe installs writes to that exact same sentinel, so there is one
// single answer to "did actionlint, in any form, actually run" - recorded
// after every step, not only at the very end, so a step that should never
// reach it can be told apart from the one that legitimately does.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A step's `if:` condition is classified on the raw YAML value alone - no
// expression parsing, no evaluation. Parsing and reducing the GitHub
// Actions expression language is itself an unbounded space (the set of ways
// to spell "this always evaluates to some value" in a language with &&,
// ||, !, function calls, and context references has no fixed enumeration),
// so this file no longer tries to solve it. A YAML boolean `false` is the
// only thing that ever definitely means "never runs"; everything else that
// could possibly still run - no `if:` at all, YAML boolean `true`, or any
// string (an expression, a bare literal spelled as a string, anything) -
// is left alone rather than reduced.
// ---------------------------------------------------------------------------

/**
 * Classifies a step's `if:` field on the raw YAML value alone - no
 * expression parsing, no evaluation. A YAML boolean `false` is the only
 * thing that ever means "never runs." Everything else that could possibly
 * still run - no `if:` at all, YAML boolean `true`, or ANY string (an
 * expression, a bare literal spelled as a string, anything) - is left
 * alone rather than reduced, because reducing an expression language is
 * exactly the unbounded problem this file no longer tries to solve.
 *
 * @param {{ if?: unknown }} step
 * @returns {"always" | "never" | "mayRun"}
 */
function classifyStepCondition(step) {
  if (!Object.prototype.hasOwnProperty.call(step, "if")) return "always";
  const raw = step.if;
  if (raw === true) return "always";
  if (raw === false) return "never";
  return "mayRun";
}

/**
 * True only when a step is PROVEN to always run - gates a POSITIVE claim
 * ("this is THE authoritative canonical step"). A step whose condition is
 * merely "mayRun" (any expression, however plausible) must never be
 * accepted as proven-authoritative: accepting an unproven condition here
 * would let a quietly-disabled decoy pass as the real thing.
 *
 * @param {{ if?: unknown }} step
 * @returns {boolean}
 */
function isProvenAuthoritative(step) {
  return classifyStepCondition(step) === "always";
}

/**
 * True whenever a step MIGHT run - gates scrutiny of something that could
 * be a threat (a competing installer, an early invocation). "never" is the
 * only classification safe to skip; "mayRun" must still be treated as
 * live, because skipping an unproven condition here would let a real
 * competing installer hide behind an ordinary-looking `if:` nobody can
 * evaluate.
 *
 * @param {{ if?: unknown }} step
 * @returns {boolean}
 */
function mayExecute(step) {
  const classification = classifyStepCondition(step);
  return classification === "always" || classification === "mayRun";
}

/**
 * Every `run:` step in the actionlint job, in order, as plain
 * {name, run, if?} objects. A `uses:` step (the checkout above them)
 * carries no shell text of its own and is skipped, since nothing about
 * actionlint ever depends on what that kind of step does. The step's own
 * `if:` field (when present) rides along unchanged - never synthesized
 * when absent from the source step - so downstream logic (classifyStepCondition,
 * isProvenAuthoritative, mayExecute) can tell a genuinely live step apart
 * from one whose text merely looks right but never actually executes.
 *
 * @param {any} workflow
 * @returns {{ name: string, run: string, if?: unknown }[]}
 */
function extractActionlintRunSteps(workflow) {
  const steps = workflow?.jobs?.[ACTIONLINT_JOB_ID]?.steps ?? [];
  return steps
    .map((step, index) => {
      const entry = { name: step?.name ?? `step ${index}`, run: step?.run };
      if (step && Object.prototype.hasOwnProperty.call(step, "if")) {
        entry.if = step.if;
      }
      return entry;
    })
    .filter((step) => typeof step.run === "string");
}

/**
 * True when a step's own run text actually EXECUTES the checksum-verify
 * command - "sha256sum --check" in command position: right at the start of
 * the script, right after a newline, or right after a shell statement
 * separator (`;`, `&`, `|`) or command-substitution opener (`$(`, a
 * backtick) - as opposed to merely mentioning that phrase inside a comment
 * or an echo/printf argument. Mirrors the same command-position idea
 * ACTIONLINT_INVOCATION_PATTERNS already uses for detecting a real
 * actionlint invocation: a shell command is defined by where it sits, not
 * by which characters happen to appear somewhere in the line. A step whose
 * text only references the phrase, without ever running it, has verified
 * nothing, however convincing the surrounding text reads - a decoy comment
 * or echo that quotes "sha256sum --check config/actionlint-artifact.sha256"
 * must never be mistaken for a step that ran it.
 *
 * @param {string} runText
 * @returns {boolean}
 */
function stepPerformsChecksumVerification(runText) {
  return (
    typeof runText === "string" && /(?:^|\n|[;&|]|\$\(|`)\s*sha256sum\s+--check\b/.test(runText)
  );
}

/**
 * Finds the install/verify step and the later bare-invoke step
 * (`actionlint -color`, at or after it) inside an array already narrowed
 * to run steps by extractActionlintRunSteps - located by content, never
 * by a fixed position, so a spliced-in extra step shifts these indices
 * correctly instead of silently pointing at the wrong step.
 *
 * The install/verify step must both actually RUN the checksum-verify
 * command (stepPerformsChecksumVerification, never merely mention that
 * text in a comment or decoy echo) and be PROVEN authoritative
 * (isProvenAuthoritative) - a step whose `if:` cannot be proven to always
 * run is never accepted as the canonical step, however correct its text
 * reads, since real GitHub Actions semantics mean an unproven condition
 * might never execute it at all.
 *
 * @param {{ name: string, run: string, if?: unknown }[]} runSteps
 * @returns {{ installIndex: number, invokeIndex: number }}
 */
function locateRunStepIndices(runSteps) {
  const installIndex = runSteps.findIndex(
    (step) => stepPerformsChecksumVerification(step.run) && isProvenAuthoritative(step)
  );
  const invokeIndex = runSteps.findIndex(
    (step, index) => index > installIndex && step.run.trim() === "actionlint -color"
  );
  return { installIndex, invokeIndex };
}

/**
 * Returns a new array with an extra step inserted immediately before
 * installIndex - never mutates runSteps itself, so the caller's original
 * list is still exactly what it was.
 *
 * @param {{ name: string, run: string }[]} runSteps
 * @param {number} installIndex
 * @param {string} run
 * @param {string} name
 * @returns {{ name: string, run: string }[]}
 */
function withExtraStepBefore(runSteps, installIndex, run, name) {
  const copy = runSteps.slice();
  copy.splice(installIndex, 0, { name, run });
  return copy;
}

/**
 * Returns a new array where the install step's own run text has extra
 * lines spliced in immediately before its `sha256sum --check` line - never
 * mutates runSteps or any of its step objects, so the caller's original
 * list is still exactly what it was.
 *
 * @param {{ name: string, run: string }[]} runSteps
 * @param {number} installIndex
 * @param {...string} mutantLines
 * @returns {{ name: string, run: string }[]}
 */
function withLinesInsertedBeforeVerification(runSteps, installIndex, ...mutantLines) {
  return runSteps.map((step, index) => {
    if (index !== installIndex) return step;
    const lines = step.run.split("\n");
    const shaIndex = lines.findIndex((line) => /sha256sum --check/.test(line));
    const mutatedLines = lines.slice();
    mutatedLines.splice(shaIndex, 0, ...mutantLines);
    return { ...step, run: mutatedLines.join("\n") };
  });
}

/**
 * Drives an ordered list of run steps inside one persistent scratch
 * directory and one accumulating environment, stopping at the first step
 * that exits non-zero - matching the default per-step `if: success()`
 * every real job step gets unless a workflow opts out, so a failed
 * verification step genuinely prevents everything after it from running,
 * not merely from being marked as passed.
 *
 * A step classified "never" (classifyStepCondition / mayExecute) is never
 * driven at all - its run text is never handed to a shell, in any form,
 * regardless of the job's status so far, matching real GitHub Actions
 * semantics for an `if:` that is a hardcoded YAML boolean false. This is
 * tracked separately from `skipped` below (see the trace entry shape):
 * `skipped` means "did not run because an earlier step in this sequence
 * failed" (the default if: success() propagation), `disabledByIf` means
 * "did not run because this step's own if: disables it," and the two are
 * never conflated.
 *
 * By default the "downloaded" archive genuinely matches the recorded
 * checksum (both built from the same fixture script). Passing a different
 * `hashRecordScript` records the checksum of a second, separately built
 * archive instead, so the recorded hash and the actually-downloaded bytes
 * genuinely disagree - a real mismatch the fake sha256sum has to discover
 * for itself, not a pre-decided failure.
 *
 * @param {{ name: string, run: string, if?: unknown }[]} runSteps
 * @param {{ archiveScript?: string, hashRecordScript?: string }} [options]
 * @returns {{ index: number, name: string, exitCode: number | null, skipped: boolean, disabledByIf: boolean, sentinelInvocationCountAfter: number }[]}
 */
function driveActionlintStepSequence(
  runSteps,
  { archiveScript = ACTIONLINT_FIXTURE_SCRIPT, hashRecordScript } = {}
) {
  return withScratchRun((scratch) => {
    const workDir = path.join(scratch, "workdir");
    const runnerTemp = path.join(scratch, "runner-temp");
    const configDir = path.join(workDir, "config");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(runnerTemp, { recursive: true });

    const fakeBin = buildFakeBin(scratch);

    // Reachable by bare name via PATH from before step 0 - covers a plain
    // invocation plus every wrapper and indirection form, since all of
    // them resolve "actionlint" the same way a bare invocation does.
    const standInDir = path.join(scratch, "actionlint-standin-bin");
    mkdirSync(standInDir, { recursive: true });
    writeFileSync(path.join(standInDir, "actionlint"), ACTIONLINT_FIXTURE_SCRIPT);
    chmodSync(path.join(standInDir, "actionlint"), 0o755);

    // The same stand-in, reachable path-qualified as "./actionlint" from
    // the steps' own working directory - the one form a PATH-only stand-in
    // can never cover.
    writeFileSync(path.join(workDir, "actionlint"), ACTIONLINT_FIXTURE_SCRIPT);
    chmodSync(path.join(workDir, "actionlint"), 0o755);

    const archivePath = buildFixtureArchive(scratch, archiveScript, "candidate");
    const hashRecordDigest =
      hashRecordScript === undefined
        ? computeSha256(archivePath)
        : computeSha256(buildFixtureArchive(scratch, hashRecordScript, "reference"));
    writeFileSync(
      path.join(configDir, "actionlint-artifact.sha256"),
      `${hashRecordDigest}  ${PINNED_ARCHIVE_FILENAME}\n`
    );

    const githubPathFile = path.join(scratch, "github_path");
    writeFileSync(githubPathFile, "");

    const sentinelPath = path.join(scratch, "actionlint-invoked.sentinel");
    const sentinelInvocationCount = () =>
      existsSync(sentinelPath)
        ? readFileSync(sentinelPath, "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "").length
        : 0;

    const trace = [];
    let priorStepFailed = false;

    for (let index = 0; index < runSteps.length; index += 1) {
      const step = runSteps[index];

      // The two axes below are independent and are checked in this order
      // on purpose: classification first, prior status second - never the
      // other way around, and never conflated.
      //
      // A step whose condition is definitely "never" never runs, in any
      // form, regardless of the job's status so far - real GitHub Actions
      // semantics, not this harness's control flow - so this is checked
      // unconditionally first, before prior status is even consulted. Its
      // run text is never handed to the shell at all, so it can never
      // touch the sentinel or the filesystem; the loop moves on to the
      // next step exactly as a real runner would, and this does not count
      // as a failure (a disabled step is a neutral no-op, not a broken
      // one), so it never sets priorStepFailed.
      if (!mayExecute(step)) {
        trace.push({
          index,
          name: step.name,
          exitCode: null,
          skipped: false,
          disabledByIf: true,
          sentinelInvocationCountAfter: sentinelInvocationCount(),
        });
        continue;
      }

      // Only now does prior status matter, and only for a step classified
      // "always": a step with no if: key (or if: true) inherits the
      // implicit "if: success()" default every job step gets unless a
      // workflow opts out, so it is correctly skipped once something
      // earlier has failed. A "mayRun" condition (any expression, however
      // plausible) does NOT inherit that default - its own condition
      // decides, and this file cannot evaluate what that condition
      // actually says, so a "mayRun" step is driven exactly like "always"
      // REGARDLESS of prior status: skipping it here would let a real
      // competing installer hide behind an ordinary-looking `if:` nobody
      // can evaluate, specifically one designed to run BECAUSE something
      // failed (e.g. `always()` or `failure()`).
      if (priorStepFailed && classifyStepCondition(step) === "always") {
        trace.push({
          index,
          name: step.name,
          exitCode: null,
          skipped: true,
          disabledByIf: false,
          sentinelInvocationCountAfter: sentinelInvocationCount(),
        });
        continue;
      }

      const pathAdditions = readFileSync(githubPathFile, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const env = {
        ...process.env,
        PATH: [...pathAdditions.slice().reverse(), fakeBin, standInDir, process.env.PATH].join(":"),
        RUNNER_TEMP: runnerTemp,
        GITHUB_PATH: githubPathFile,
        FIXTURE_ARCHIVE: archivePath,
        ACTIONLINT_INVOKED_SENTINEL: sentinelPath,
      };

      const exitCode = runShellScript(step.run, { cwd: workDir, env });
      trace.push({
        index,
        name: step.name,
        exitCode,
        skipped: false,
        disabledByIf: false,
        sentinelInvocationCountAfter: sentinelInvocationCount(),
      });
      if (exitCode !== 0) priorStepFailed = true;
    }

    return trace;
  });
}

/**
 * The one rule every mutation test below exercises: nothing at or before
 * `invokeStepIndex` may ever cause the sentinel to be touched - only the
 * step at `invokeStepIndex` itself is allowed to. Returns the first
 * offending trace entry, or null when the whole sequence up to that point
 * is clean.
 *
 * @param {{ index: number, sentinelInvocationCountAfter: number }[]} trace
 * @param {number} invokeStepIndex
 * @returns {{ index: number, name: string } | null}
 */
function findPrematureActionlintExecution(trace, invokeStepIndex) {
  return (
    trace.find(
      (entry) => entry.index < invokeStepIndex && entry.sentinelInvocationCountAfter > 0
    ) ?? null
  );
}

/**
 * Runs one full mutation round-trip: confirm the untouched recipe is clean,
 * apply a mutation that must genuinely reach a real actionlint early, drive
 * it and confirm the resulting trace is flagged, then drive the original,
 * never-mutated steps again and confirm they're still clean - proving the
 * red came from the mutation and reverting it is what restores green, not
 * some other side effect.
 *
 * @param {(runSteps: { name: string, run: string }[], installIndex: number) => { name: string, run: string }[]} applyMutation
 * @returns {{ index: number, name: string }} the violation found in the mutated (red) drive
 */
function assertMutationIsCaughtAndReversible(applyMutation) {
  const baselineSteps = extractActionlintRunSteps(loadWorkflow());
  const { installIndex: baselineInstallIndex, invokeIndex: baselineInvokeIndex } =
    locateRunStepIndices(baselineSteps);
  assert.notEqual(baselineInstallIndex, -1, "test setup: could not locate the real install step");
  assert.notEqual(baselineInvokeIndex, -1, "test setup: could not locate the real invoke step");

  const cleanTraceBefore = driveActionlintStepSequence(baselineSteps);
  assert.equal(
    findPrematureActionlintExecution(cleanTraceBefore, baselineInvokeIndex),
    null,
    "test setup: the unmutated recipe must already be clean before any mutation is applied"
  );

  const mutatedSteps = applyMutation(baselineSteps, baselineInstallIndex);

  // Prove the mutation was genuinely applied to a separate copy, never to
  // baselineSteps itself - re-deriving a fresh copy from the real workflow
  // and comparing confirms nothing about the original was touched, which is
  // what makes driving baselineSteps again below a real revert rather than
  // an assumption.
  const freshBaselineSteps = extractActionlintRunSteps(loadWorkflow());
  assert.deepEqual(
    baselineSteps,
    freshBaselineSteps,
    "applying a mutation must never alter the original steps it was derived from"
  );

  const { invokeIndex: mutatedInvokeIndex } = locateRunStepIndices(mutatedSteps);
  assert.notEqual(
    mutatedInvokeIndex,
    -1,
    "test setup: the mutation must not remove the invoke step"
  );

  const redTrace = driveActionlintStepSequence(mutatedSteps);
  const violation = findPrematureActionlintExecution(redTrace, mutatedInvokeIndex);
  assert.notEqual(
    violation,
    null,
    "the mutation must cause a real, observable early execution of actionlint"
  );

  const cleanTraceAfter = driveActionlintStepSequence(baselineSteps);
  assert.equal(
    findPrematureActionlintExecution(cleanTraceAfter, baselineInvokeIndex),
    null,
    "driving the original, unmutated steps again must restore a clean result"
  );

  return violation;
}

test("the real recipe never lets actionlint execute before the checksum-verified extraction, and the later step runs it exactly once", () => {
  const runSteps = extractActionlintRunSteps(loadWorkflow());
  const { installIndex, invokeIndex } = locateRunStepIndices(runSteps);
  assert.notEqual(installIndex, -1, "test setup: could not locate the install step");
  assert.notEqual(invokeIndex, -1, "test setup: could not locate the invoke step");

  const trace = driveActionlintStepSequence(runSteps);

  assert.equal(
    trace[installIndex].exitCode,
    0,
    "the verify step must succeed against a matching archive"
  );
  assert.equal(
    trace[installIndex].sentinelInvocationCountAfter,
    0,
    "the install/verify/extract step must never itself execute actionlint"
  );
  assert.equal(findPrematureActionlintExecution(trace, invokeIndex), null);
  assert.equal(
    trace[invokeIndex].exitCode,
    0,
    "the invoke step must succeed once actionlint is on PATH"
  );
  assert.equal(
    trace[invokeIndex].sentinelInvocationCountAfter,
    1,
    "actionlint must run exactly once, by the later invoke step"
  );
  assert.equal(
    trace[installIndex].disabledByIf,
    false,
    "the real canonical install step must not be disabled"
  );
});

test("a mismatched archive fails verification and actionlint is never executed at any point in the job", () => {
  const runSteps = extractActionlintRunSteps(loadWorkflow());
  const { installIndex, invokeIndex } = locateRunStepIndices(runSteps);
  assert.notEqual(installIndex, -1);
  assert.notEqual(invokeIndex, -1);

  const tamperedArchiveScript = ACTIONLINT_FIXTURE_SCRIPT + "// a genuinely different fixture\n";
  const trace = driveActionlintStepSequence(runSteps, {
    archiveScript: tamperedArchiveScript,
    hashRecordScript: ACTIONLINT_FIXTURE_SCRIPT,
  });

  assert.notEqual(
    trace[installIndex].exitCode,
    0,
    "a genuine hash mismatch must fail the verify step"
  );
  assert.equal(trace[installIndex].sentinelInvocationCountAfter, 0);
  const invokeEntry = trace.find((entry) => entry.index === invokeIndex);
  assert.equal(
    invokeEntry.skipped,
    true,
    "the invoke step must be skipped, matching a real job's default if: success()"
  );
  assert.equal(
    invokeEntry.sentinelInvocationCountAfter,
    0,
    "actionlint must never run after a failed verification"
  );
});

test("extracting the archive member never itself executes anything named actionlint", () => {
  const runSteps = extractActionlintRunSteps(loadWorkflow());
  const { installIndex } = locateRunStepIndices(runSteps);
  assert.notEqual(installIndex, -1);

  // Sliced down to the install step alone: whatever runs after it is
  // irrelevant to this claim, so nothing after it gets the chance to
  // confuse the result.
  const trace = driveActionlintStepSequence(runSteps.slice(0, installIndex + 1));

  assert.equal(trace[installIndex].exitCode, 0);
  assert.equal(
    trace[installIndex].sentinelInvocationCountAfter,
    0,
    "tar -xzf reads bytes and writes a file - it must never actually run the program it extracts"
  );
});

test("a whole extra step inserted before verification that runs actionlint is caught by real execution, and reverting it restores a clean result", () => {
  assertMutationIsCaughtAndReversible((steps, installIndex) =>
    withExtraStepBefore(
      steps,
      installIndex,
      "actionlint -color",
      "an extra step that must never be allowed to run early"
    )
  );
});

test("a bare actionlint invocation inserted inside the install step, ahead of its own checksum check, is caught by real execution, and reverting it restores a clean result", () => {
  assertMutationIsCaughtAndReversible((steps, installIndex) =>
    withLinesInsertedBeforeVerification(steps, installIndex, "actionlint -color")
  );
});

test("a path-qualified ./actionlint invocation inserted inside the install step is caught by real execution, and reverting it restores a clean result", () => {
  assertMutationIsCaughtAndReversible((steps, installIndex) =>
    withLinesInsertedBeforeVerification(steps, installIndex, "./actionlint -color")
  );
});

test("actionlint invoked through a shell variable that holds its name is caught by real execution, and reverting it restores a clean result", () => {
  assertMutationIsCaughtAndReversible((steps, installIndex) =>
    withLinesInsertedBeforeVerification(steps, installIndex, "tool=actionlint", '"$tool" -color')
  );
});

test("actionlint invoked through the env wrapper is caught by real execution, and reverting it restores a clean result", () => {
  assertMutationIsCaughtAndReversible((steps, installIndex) =>
    withLinesInsertedBeforeVerification(steps, installIndex, "env actionlint -color")
  );
});

test("actionlint invoked through bash -c is caught by real execution, and reverting it restores a clean result", () => {
  assertMutationIsCaughtAndReversible((steps, installIndex) =>
    withLinesInsertedBeforeVerification(steps, installIndex, "bash -c 'actionlint -color'")
  );
});

test('a step that touches the sentinel through a mechanism naming no form of the word "actionlint" at all is still caught by real execution, proving the check depends on the observed fact of an early sentinel write, never on recognizing the word', () => {
  // findPrematureActionlintExecution only ever reads sentinelInvocationCountAfter
  // off a trace produced by really running the step text - it has no
  // notion of "actionlint" as a word at all. This line never spells that
  // word anywhere, in any of the forms the static, text-only checks
  // recognize or fail to recognize; it reaches the exact same sentinel file
  // through Node's own fs module instead, which is a plain stand-in for
  // "some other program on this step's PATH happens to write there" (a
  // build tool invoking a plugin, a shared library shimming a binary,
  // anything not literally named "actionlint"). If this is still caught,
  // the guarantee does not depend on recognizing a name at all.
  assertMutationIsCaughtAndReversible((steps, installIndex) =>
    withLinesInsertedBeforeVerification(
      steps,
      installIndex,
      `node -e "require('fs').writeFileSync(process.env.ACTIONLINT_INVOKED_SENTINEL, 'invoked')"`
    )
  );
});

// ---------------------------------------------------------------------------
// locateRunStepIndices must identify the canonical step by whether
// it actually RUNS the checksum-verify command, never by whether that text
// merely appears somewhere in its run text. A decoy comment or echo that
// quotes "sha256sum --check config/actionlint-artifact.sha256" reads, to a
// plain substring search, exactly like a step that really ran it - but
// extraction and the PATH append still happen unconditionally in that
// mutation, regardless of whether the downloaded archive was ever
// legitimate, which is exactly the guarantee this recipe depends on.
// ---------------------------------------------------------------------------

test("a step whose real checksum-verify command is replaced by a decoy comment merely mentioning the same text is never accepted as the canonical install step, and reverting restores a clean result", () => {
  const baselineSteps = extractActionlintRunSteps(loadWorkflow());
  const { installIndex: baselineInstallIndex, invokeIndex: baselineInvokeIndex } =
    locateRunStepIndices(baselineSteps);
  assert.notEqual(baselineInstallIndex, -1, "test setup: could not locate the real install step");
  assert.notEqual(baselineInvokeIndex, -1, "test setup: could not locate the real invoke step");

  // Apply the mutation for real: replace the real "sha256sum --check ..."
  // line with an echo that merely quotes the same text - extraction and
  // the PATH append are left completely unconditional, exactly as a real
  // adversary trying to defeat a naive textual scanner would leave them.
  const canonicalStep = baselineSteps[baselineInstallIndex];
  const decoyRun = canonicalStep.run.replace(
    /^sha256sum --check config\/actionlint-artifact\.sha256$/m,
    'echo "note: sha256sum --check config/actionlint-artifact.sha256 was already verified upstream"'
  );
  assert.notEqual(
    decoyRun,
    canonicalStep.run,
    "test setup: the replacement must actually change something"
  );
  const decoyCanonicalStep = { ...canonicalStep, run: decoyRun };
  const mutatedSteps = baselineSteps.slice();
  mutatedSteps[baselineInstallIndex] = decoyCanonicalStep;

  // Prove the mutation was applied to a separate copy, never to
  // baselineSteps itself.
  const freshBaselineSteps = extractActionlintRunSteps(loadWorkflow());
  assert.deepEqual(
    baselineSteps,
    freshBaselineSteps,
    "constructing the mutation must never alter the original steps it was derived from"
  );

  // A plain substring search would still find "sha256sum --check" inside
  // the decoy echo's own argument - proving this is a genuine test of
  // command-position detection, not an accidental miss.
  assert.ok(
    decoyRun.includes("sha256sum --check"),
    "test setup: the decoy text must still contain the phrase, just not as a command"
  );

  const { installIndex: mutatedInstallIndex } = locateRunStepIndices(mutatedSteps);
  assert.equal(
    mutatedInstallIndex,
    -1,
    "a decoy echo merely mentioning the checksum-verify text must never be accepted as actually running it"
  );

  // Revert: the original, unmutated steps are untouched and still read
  // clean.
  const { installIndex: revertedInstallIndex } = locateRunStepIndices(baselineSteps);
  assert.equal(revertedInstallIndex, baselineInstallIndex);
});

// ---------------------------------------------------------------------------
// The classifier's whole contract lives in these two named predicates:
// isProvenAuthoritative gates a POSITIVE claim ("this is THE canonical
// step") and must reject anything it cannot prove always runs, however
// plausible the condition reads; mayExecute gates SCRUTINY of something
// that could be a threat and must never skip anything it cannot prove
// never runs. Neither one evaluates the expression behind a `mayRun`
// classification - it does not need to, since both directions are decided
// by the classification alone.
// ---------------------------------------------------------------------------

test("isProvenAuthoritative rejects any step whose condition is not provably 'always', and the classifier's bare edge cases hold", () => {
  const canonicalLikeStep = { name: "install", run: "sha256sum --check x" };

  assert.equal(
    isProvenAuthoritative({ ...canonicalLikeStep, if: "${{ !cancelled() }}" }),
    false,
    "a plausible-looking runtime conditional must never be accepted as proven-authoritative"
  );
  assert.equal(
    isProvenAuthoritative({ ...canonicalLikeStep, if: "${{ success() }}" }),
    false,
    "any other mayRun-classified string is rejected the same way - the exact text never matters, nothing evaluates it"
  );

  assert.equal(
    classifyStepCondition({ run: "echo hi" }),
    "always",
    "no if: key at all classifies as always"
  );
  assert.equal(classifyStepCondition({ if: true }), "always", "a bare YAML boolean true is always");
  assert.equal(classifyStepCondition({ if: false }), "never", "a bare YAML boolean false is never");
  assert.equal(
    mayExecute({ if: false }),
    false,
    "a never-classified step must never be treated as possibly executing"
  );
  assert.equal(
    mayExecute({ if: "${{ anything }}" }),
    true,
    "any mayRun-classified string must still be treated as possibly executing"
  );
});

test("the real workflow's if:-less actionlint run steps classify as 'always' and are accepted, with no false rejection", () => {
  // The actionlint job has three steps in total (a checkout, the install/
  // verify step, and the bare-invoke step); extractActionlintRunSteps
  // filters to the two carrying a `run:` block, since a `uses:` step (the
  // checkout) has no shell text of its own for this classifier to look at.
  const runSteps = extractActionlintRunSteps(loadWorkflow());
  assert.equal(runSteps.length, 2, "test setup: expected exactly two run steps in the real job");
  for (const step of runSteps) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(step, "if"),
      false,
      `expected step "${step.name}" to carry no if: key at all`
    );
    assert.equal(
      isProvenAuthoritative(step),
      true,
      `expected step "${step.name}" to be proven authoritative`
    );
    assert.equal(
      mayExecute(step),
      true,
      `expected step "${step.name}" to be classified as possibly executing`
    );
  }
});

// ---------------------------------------------------------------------------
// The escape coverage the old cross-step shell-text scanner used to
// (imperfectly) provide, now proven by really executing a mutated step
// sequence through a real shell rather than by pattern-matching. Each
// control below splices in one hand-authored "rogue" step exercising one
// specific way of getting an unverified actionlint reachable, drives the
// whole sequence through driveWithRogueMarker, and asserts the rogue
// marker was actually touched - an observable fact, not a guess about
// what the step's text looks like.
// ---------------------------------------------------------------------------

test("hermetic control: shell redirection into an already PATH-reachable $RUNNER_TEMP/bin/actionlint REDs, restored green", () => {
  assertRogueEscapeCaughtAndReversible(() => ({
    name: "silently refresh actionlint via redirection (never verified)",
    run: [
      `cat <<'ROGUE' > "$RUNNER_TEMP/bin/actionlint"`,
      "#!/usr/bin/env node",
      'require("fs").writeFileSync(process.env.ROGUE_ACTIONLINT_MARKER, "invoked\\n");',
      "ROGUE",
      `chmod +x "$RUNNER_TEMP/bin/actionlint"`,
    ].join("\n"),
  }));
});

test('hermetic control: extraction via tar -C "$target" variable indirection REDs, restored green', () => {
  withScratchRun((rogueScratch) => {
    const rogueArchivePath = buildFixtureArchive(
      rogueScratch,
      ROGUE_ACTIONLINT_FIXTURE_SCRIPT,
      "rogue"
    );
    assertRogueEscapeCaughtAndReversible(() => ({
      name: "extract a replacement archive via a variable-indirected target (never verified)",
      run: [
        'target="$RUNNER_TEMP/bin"',
        `tar -xzf "${rogueArchivePath}" -C "$target" actionlint`,
      ].join("\n"),
    }));
  });
});

// Like the two controls above, this one is spliced immediately AFTER the
// canonical install step. The real GitHub Actions runner accumulates
// $GITHUB_PATH entries in append order but then REVERSES that accumulated
// list before joining it onto PATH (actions/runner's
// AddPathFileCommand.ProcessCommand appends each line to PrependPath as it's
// read, and Handler.AddPrependPathToEnvironment joins PrependPath.Reverse()
// onto PATH), so the MOST RECENTLY appended directory wins PATH resolution,
// not the earliest one - driveWithRogueMarker's own PATH construction
// mirrors that same reversal. A directory a step appends AFTER the
// canonical step runs therefore wins PATH resolution over the canonical
// step's own earlier, entirely-correct append, even though the canonical
// step still genuinely verifies and extracts to its own directory
// correctly. Splicing this same rogue step BEFORE the canonical step
// instead would put its directory EARLIER in the accumulated (and then
// reversed) PATH, so the legitimate binary would resolve first and the
// escape would not reproduce - the position is load-bearing, not
// incidental, and is exercised here rather than assumed.
test("hermetic control: printf-based $GITHUB_PATH append with an unverified replacement REDs, restored green", () => {
  assertRogueEscapeCaughtAndReversible(() => ({
    name: "add a new install location via printf (never verified)",
    run: [
      'mkdir -p "$RUNNER_TEMP/rogue-bin"',
      `cat <<'ROGUE' > "$RUNNER_TEMP/rogue-bin/actionlint"`,
      "#!/usr/bin/env node",
      'require("fs").writeFileSync(process.env.ROGUE_ACTIONLINT_MARKER, "invoked\\n");',
      "ROGUE",
      `chmod +x "$RUNNER_TEMP/rogue-bin/actionlint"`,
      `printf '%s\\n' "$RUNNER_TEMP/rogue-bin" >> "$GITHUB_PATH"`,
    ].join("\n"),
  }));
});

test("hermetic control: a mayRun sibling reached after the canonical install step genuinely fails is still driven and detected, not silently skipped (the missing cross-product cell)", () => {
  const baselineSteps = extractActionlintRunSteps(loadWorkflow());
  const { installIndex: baselineInstallIndex } = locateRunStepIndices(baselineSteps);
  assert.notEqual(baselineInstallIndex, -1, "test setup: could not locate the real install step");

  const siblingStep = {
    name: "refresh actionlint with a newer patch (never verified)",
    if: "${{ always() }}",
    run: [
      `cat <<'ROGUE' > "$RUNNER_TEMP/rogue-actionlint"`,
      "#!/usr/bin/env node",
      'require("fs").writeFileSync(process.env.ROGUE_ACTIONLINT_MARKER, "invoked\\n");',
      "ROGUE",
      `chmod +x "$RUNNER_TEMP/rogue-actionlint"`,
      `"$RUNNER_TEMP/rogue-actionlint"`,
    ].join("\n"),
  };

  // A mayRun condition (any expression, however plausible) must never be
  // skipped from scrutiny - an unproven condition is treated as live, not
  // dismissed, since that is exactly where a real competing installer
  // would hide.
  assert.equal(
    mayExecute(siblingStep),
    true,
    "a mayRun-classified sibling must be treated as possibly executing, never skipped from scrutiny"
  );

  const siblingIndex = baselineInstallIndex + 1;
  const mutatedSteps = baselineSteps.slice();
  mutatedSteps.splice(siblingIndex, 0, siblingStep);

  // A genuinely different fixture script than the one actually built as
  // the "downloaded" archive means the recorded digest and the real
  // archive bytes disagree for real - the canonical install step's own
  // sha256sum --check must fail on its own merits. This is exactly the
  // scenario a priorStepFailed-first check used to mishandle: everything
  // after the failure got skipped unconditionally, regardless of a
  // sibling step's own condition.
  const tamperedArchiveScript = ACTIONLINT_FIXTURE_SCRIPT + "// a genuinely different fixture\n";
  const result = driveWithRogueMarker(mutatedSteps, { hashRecordScript: tamperedArchiveScript });

  assert.notEqual(
    result.trace[baselineInstallIndex].exitCode,
    0,
    "test setup: the canonical install step must genuinely fail against a mismatched archive"
  );
  assert.equal(
    result.trace[siblingIndex].skipped,
    false,
    "a mayRun-classified sibling must never be skipped just because an earlier step failed"
  );
  assert.equal(
    result.trace[siblingIndex].disabledByIf,
    false,
    "a mayRun-classified sibling is not disabled by its own condition - always() is unproven, not false"
  );
  assert.equal(
    result.rogueMarkerTouched,
    true,
    "the mayRun sibling must actually run despite the prior failure - this is the missing cell a priorStepFailed-first check would silently skip"
  );

  // The real, unrelated "always"-classified invoke step further down the
  // sequence is still correctly skipped once the canonical install
  // genuinely failed - only the mayRun sibling escapes the shortcut, never
  // an ordinary always-classified step.
  const invokeIndexInMutated = siblingIndex + 1;
  assert.equal(
    result.trace[invokeIndexInMutated].skipped,
    true,
    "an always-classified step must still be skipped after a genuine prior failure"
  );
});

test("driveActionlintStepSequence: every cell of the classification x prior-step-status cross product drives, skips, or disables exactly as real GitHub Actions semantics require", () => {
  // Six cells: {prior step succeeded, prior step failed} x
  // {always, mayRun, never}. Each row states its own expected outcome
  // explicitly - nothing here is inferred from a sibling row.
  const cells = [
    {
      description: "always, prior succeeded: driven normally",
      priorRun: "exit 0",
      condition: (step) => step,
      expectSkipped: false,
      expectDisabledByIf: false,
      expectExitCode: 0,
      expectSentinelCount: 1,
    },
    {
      description: "always, prior failed: skipped - the implicit if: success() default applies",
      priorRun: "exit 1",
      condition: (step) => step,
      expectSkipped: true,
      expectDisabledByIf: false,
      expectExitCode: null,
      expectSentinelCount: 0,
    },
    {
      description: "mayRun, prior succeeded: driven normally (already-correct behavior)",
      priorRun: "exit 0",
      condition: (step) => ({ ...step, if: "${{ always() }}" }),
      expectSkipped: false,
      expectDisabledByIf: false,
      expectExitCode: 0,
      expectSentinelCount: 1,
    },
    {
      description:
        "mayRun, prior failed: driven normally - an unproven condition might specifically override the default, so it must still be treated as possibly executing (the missing cell)",
      priorRun: "exit 1",
      condition: (step) => ({ ...step, if: "${{ always() }}" }),
      expectSkipped: false,
      expectDisabledByIf: false,
      expectExitCode: 0,
      expectSentinelCount: 1,
    },
    {
      description: "never, prior succeeded: never driven regardless of job status",
      priorRun: "exit 0",
      condition: (step) => ({ ...step, if: false }),
      expectSkipped: false,
      expectDisabledByIf: true,
      expectExitCode: null,
      expectSentinelCount: 0,
    },
    {
      description: "never, prior failed: never driven regardless of job status",
      priorRun: "exit 1",
      condition: (step) => ({ ...step, if: false }),
      expectSkipped: false,
      expectDisabledByIf: true,
      expectExitCode: null,
      expectSentinelCount: 0,
    },
  ];

  for (const cell of cells) {
    const priorStep = { name: "prior step", run: cell.priorRun };
    const targetStep = cell.condition({ name: "target step", run: "actionlint -color" });

    const trace = driveActionlintStepSequence([priorStep, targetStep]);
    const targetEntry = trace[1];

    assert.equal(targetEntry.skipped, cell.expectSkipped, `${cell.description}: skipped`);
    assert.equal(
      targetEntry.disabledByIf,
      cell.expectDisabledByIf,
      `${cell.description}: disabledByIf`
    );
    assert.equal(targetEntry.exitCode, cell.expectExitCode, `${cell.description}: exitCode`);
    assert.equal(
      targetEntry.sentinelInvocationCountAfter,
      cell.expectSentinelCount,
      `${cell.description}: sentinelInvocationCountAfter`
    );
  }
});
