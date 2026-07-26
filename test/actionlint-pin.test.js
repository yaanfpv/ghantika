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
import { parseSourceFile, ts } from "../scripts/lib/ts-ast.mjs";

// This suite has two parts. The first parses .github/workflows/ci.yml as
// data (never executes it) and checks the actionlint job's exact shape:
// the pinned URL, the saved filename, the recorded checksum, the ordering
// that puts verification before extraction, and the canonical invoke
// step's bare, PATH-resolved shape.
//
// The second part actually drives the job's two real run steps, in order,
// inside a scratch directory, with a fake curl (so nothing ever touches
// the network), a portable checksum helper that genuinely hashes whatever
// bytes are on disk, and a fake actionlint binary that only proves it was
// reached. That is what tells the difference between "the text looks
// right" and "a hash mismatch actually stops the job before extraction,"
// which a parse-only check can't do on its own. It also generalizes that
// same execution-based approach across an arbitrary, mutated sequence of
// steps, so that no matter how a stray or inserted line tries to invoke
// actionlint early - a whole extra step, a line buried inside the install
// step's own block, a bare word, a path-qualified path, a variable holding
// the name, or a wrapper command - a real shell actually running that text
// is what decides whether an early invocation gets through, never a guess
// about how the text is shaped.

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
 * Builds everything every check below reads, once, from the raw inputs.
 * Every derived fact an evaluator might need - the located steps, the
 * install step's run text, its `-o` target, whether the checksum record
 * parses at all - is computed here rather than inside an evaluator, so
 * each evaluator is a pure function of `ctx` with no ordering dependency
 * on any other evaluator.
 *
 * @param {any} workflow
 * @param {string | null | undefined} hashRecordContent
 */
function buildValidationContext(workflow, hashRecordContent) {
  const job = workflow?.jobs?.[ACTIONLINT_JOB_ID];
  const { steps, installIndex, invokeIndex } = locateActionlintSteps(workflow);
  const runText = installIndex !== -1 ? steps[installIndex].run : null;

  let savedAs = null;
  if (runText != null) {
    const oMatch = runText.match(/-o\s+(\S+)/);
    savedAs = oMatch ? oMatch[1] : null;
  }

  const hasRecordContent = !(
    hashRecordContent === null ||
    hashRecordContent === undefined ||
    hashRecordContent.trim() === ""
  );
  const nonEmptyLines = hasRecordContent
    ? hashRecordContent.split("\n").filter((line) => line.trim() !== "")
    : [];
  const isOneLine = hasRecordContent && nonEmptyLines.length === 1;
  const lineMatch = isOneLine ? nonEmptyLines[0].match(/^([0-9a-fA-F]{64}) {2}(\S+)$/) : null;
  const isWellFormed = isOneLine && lineMatch !== null;

  return {
    job,
    steps,
    installIndex,
    invokeIndex,
    runText,
    savedAs,
    hasRecordContent,
    nonEmptyLines,
    isOneLine,
    isWellFormed,
    recordHex: isWellFormed ? lineMatch[1] : null,
    recordFilename: isWellFormed ? lineMatch[2] : null,
  };
}

/**
 * The fixed, closed set of static checks validateActionlintRecipe can
 * report - the pinned URL, the saved filename, the recorded checksum
 * record's own well-formedness, the canonical invoke step's bare,
 * PATH-resolved shape, the absence of any executable `uses:` step between
 * verified extraction and the bare invocation, and the structural
 * preconditions needed to evaluate any of that at all. Each entry's
 * `evaluate(ctx)` returns either a message (this check fired) or `null`
 * (it did not); `pattern` and `mapsTo` are consumed only by the scenario
 * audit further down, a second, independent cross-check of emitted
 * message text against this same registry.
 *
 * This registry, and how `validateActionlintRecipe` consumes it below, is
 * what closes the accumulation-seam gap below. Two earlier designs both
 * tried to PROVE completeness after the fact instead of making
 * incompleteness impossible to express:
 * first, counting `problems.push(` occurrences in the function's own
 * source text (defeated by `problems.push.bind(problems)`, a call that
 * stores a message while leaving no matching source text for a regex to
 * find); then, a reporter whose internal list a registered `report(id,
 * message)` call was the only way to append to (defeated by mutating the
 * function's RETURNED copy directly - `reporter.list()` handed back an
 * ordinary array, and anything sitting between obtaining that array and
 * returning it could push onto it without ever calling `report()` at
 * all). Both were procedural: something accumulated a result, and the
 * accumulation step was a seam a later statement could reach around.
 * There is no such seam here. `validateActionlintRecipe`'s entire body is
 * building `ctx` once and returning
 * `KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean)`
 * directly - nothing is appended to anywhere, because nothing is
 * accumulated; the result IS the projection. Adding an unregistered check
 * means adding a `KNOWN_STATIC_CHECKS` entry, which is registering it, or
 * writing an entirely separate statement that ignores this registry and
 * the map/filter pipeline altogether - a conspicuous, structural rewrite
 * of the function, not a one-line aliasing trick indistinguishable from
 * the surrounding code.
 */
const KNOWN_STATIC_CHECKS = [
  {
    id: "no-job",
    mapsTo:
      "structural precondition: no actionlint job found (none of (i)-(iv) can be evaluated without a job)",
    pattern: /no "actionlint" job found in the workflow/,
    evaluate: (ctx) => (ctx.job ? null : `no "${ACTIONLINT_JOB_ID}" job found in the workflow`),
  },
  {
    id: "install-missing",
    mapsTo:
      "structural precondition: no install/verify step found ((i), (ii), (iii) are all read off the install step's own run text)",
    pattern: /the install\/verify step is missing/,
    evaluate: (ctx) =>
      ctx.job && ctx.installIndex === -1
        ? 'no step runs "sha256sum --check" - the install/verify step is missing'
        : null,
  },
  {
    id: "invoke-missing",
    mapsTo:
      "The invocation is a bare, PATH-resolved actionlint, not ./actionlint or any path-qualified form",
    pattern: /bare "actionlint -color"/,
    evaluate: (ctx) =>
      ctx.job && ctx.invokeIndex === -1
        ? 'no later step runs the bare "actionlint -color" - it must resolve from PATH, not "./actionlint"'
        : null,
  },
  {
    id: "uses-step-between",
    mapsTo:
      'No executable "uses:" step sits between the verified extraction and the bare invocation - a bounded, closed-form fact the hermetic drive is structurally incapable of proving, since it can only run shell run: text',
    pattern: /an executable "uses:" step/,
    evaluate: (ctx) => {
      if (!ctx.job || ctx.installIndex === -1 || ctx.invokeIndex === -1) return null;
      for (let i = ctx.installIndex + 1; i < ctx.invokeIndex; i += 1) {
        if (typeof ctx.steps[i]?.uses === "string") {
          return `an executable "uses:" step ("${ctx.steps[i].uses}") sits between the verified extraction and the bare invocation - the hermetic harness can only drive shell run: text, so it cannot prove anything about what an action does, and this window must stay free of executable steps entirely`;
        }
      }
      return null;
    },
  },
  {
    id: "pinned-url-missing",
    mapsTo: "The install step fetches the exact pinned URL literal",
    pattern: /does not fetch the exact pinned URL/,
    evaluate: (ctx) =>
      ctx.job && ctx.installIndex !== -1 && !ctx.runText.includes(PINNED_URL)
        ? `install step does not fetch the exact pinned URL ${PINNED_URL}`
        : null,
  },
  {
    id: "moving-reference",
    mapsTo:
      "The install step does not fetch from a moving reference (the same pinned-vs-moving fact, the other direction)",
    pattern: /fetches from a moving reference/,
    evaluate: (ctx) => {
      if (!ctx.job || ctx.installIndex === -1) return null;
      const matched = MOVING_REFERENCE_PATTERNS.find((pattern) => pattern.test(ctx.runText));
      return matched ? `install step fetches from a moving reference (matched ${matched})` : null;
    },
  },
  {
    id: "filename-mismatch",
    mapsTo: "The -o filename is exactly the pinned archive name",
    pattern: /saves the download as/,
    evaluate: (ctx) =>
      ctx.job && ctx.installIndex !== -1 && ctx.savedAs !== PINNED_ARCHIVE_FILENAME
        ? `install step saves the download as "${ctx.savedAs}", expected exactly "${PINNED_ARCHIVE_FILENAME}"`
        : null,
  },
  {
    id: "verify-target-mismatch",
    mapsTo:
      "The verify command targets the tracked checksum-record file (a precondition for the record's own content to be the thing actually enforced)",
    pattern: /does not run "sha256sum --check/,
    evaluate: (ctx) =>
      ctx.job &&
      ctx.installIndex !== -1 &&
      !ctx.runText.includes(`sha256sum --check ${HASH_FILE_RELATIVE_PATH}`)
        ? `install step does not run "sha256sum --check ${HASH_FILE_RELATIVE_PATH}"`
        : null,
  },
  {
    id: "record-missing",
    mapsTo: "The checksum record is present and non-empty",
    pattern: /missing or empty/,
    evaluate: (ctx) =>
      ctx.job && !ctx.hasRecordContent ? "the recorded checksum file is missing or empty" : null,
  },
  {
    id: "record-not-one-line",
    mapsTo: "The checksum record is exactly one line",
    pattern: /exactly one line/,
    evaluate: (ctx) =>
      ctx.job && ctx.hasRecordContent && ctx.nonEmptyLines.length !== 1
        ? `the recorded checksum file must contain exactly one line, found ${ctx.nonEmptyLines.length}`
        : null,
  },
  {
    id: "record-malformed",
    mapsTo: "The checksum record's one line is well-formed (<64-hex>  <filename>)",
    pattern: /malformed/,
    evaluate: (ctx) =>
      ctx.job && ctx.isOneLine && !ctx.isWellFormed
        ? `the recorded checksum line is malformed (expected "<64-hex>  <filename>"): "${ctx.nonEmptyLines[0]}"`
        : null,
  },
  {
    id: "record-hex-mismatch",
    mapsTo: "The checksum record's hex matches the independently verified release digest",
    pattern: /does not match the independently verified release digest/,
    evaluate: (ctx) =>
      ctx.job &&
      ctx.isWellFormed &&
      ctx.recordHex.toLowerCase() !== VERIFIED_PINNED_SHA256.toLowerCase()
        ? `the recorded checksum ${ctx.recordHex} does not match the independently verified release digest ${VERIFIED_PINNED_SHA256}`
        : null,
  },
  {
    id: "record-filename-mismatch",
    // Anchored to the start of the string: "the archive is saved as ... but
    // the recorded checksum names ... - they must agree" also contains the
    // substring "the recorded checksum names" (it names both filenames),
    // so an unanchored pattern here would swallow that message too and the
    // "they must agree" mapping below would never register as triggered.
    mapsTo: "The checksum record's filename matches the pinned archive name",
    pattern: /^the recorded checksum names/,
    evaluate: (ctx) =>
      ctx.job && ctx.isWellFormed && ctx.recordFilename !== PINNED_ARCHIVE_FILENAME
        ? `the recorded checksum names "${ctx.recordFilename}", expected exactly "${PINNED_ARCHIVE_FILENAME}"`
        : null,
  },
  {
    id: "record-oname-disagreement",
    mapsTo: "The checksum record's filename agrees with the -o target",
    pattern: /they must agree/,
    evaluate: (ctx) =>
      ctx.job && ctx.isWellFormed && ctx.savedAs && ctx.savedAs !== ctx.recordFilename
        ? `the archive is saved as "${ctx.savedAs}" but the recorded checksum names "${ctx.recordFilename}" - they must agree`
        : null,
  },
];

/**
 * Everything this file's static, text-only pass checks about the
 * actionlint recipe: the pinned URL, the saved filename, the recorded
 * checksum record's own well-formedness, the canonical invoke step's
 * bare, PATH-resolved shape, and the absence of any executable `uses:`
 * step between verified extraction and the bare invocation - plus the
 * structural preconditions needed to evaluate any of that at all (the job
 * and the install step actually existing). The `uses:` fact is asserted
 * here, statically, rather than by the hermetic drive further down,
 * because the hermetic harness only ever runs shell `run:` text through a
 * real shell - it cannot execute a GitHub Action at all, so it is
 * structurally incapable of proving anything about what one does. A
 * bounded, closed-form fact belongs in this static pass; only an unbounded
 * behavioral property needs the hermetic drive. Deliberately does NOT scan
 * install-step text for unbounded, behavioral properties - "did curl
 * actually download something," "did tar
 * actually extract it," "did the checksum check get swallowed" - by
 * matching against a tool name or an enumerated pattern list; those are
 * asserted for real by the hermetic execution tests further down, which
 * run the actual step text through a real shell instead of guessing from
 * its shape. The audit test further down keeps this file honest about
 * which named fact or precondition every surviving check here maps to.
 * The return value IS the projection over `KNOWN_STATIC_CHECKS` - there
 * is no intermediate accumulator anywhere in this function for a later
 * statement to append to.
 *
 * @param {any} workflow
 * @param {string | null | undefined} hashRecordContent
 * @returns {string[]}
 */
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};

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

test("negative: invoking ./actionlint instead of the bare PATH-resolved binary is flagged", () => {
  const workflow = structuredClone(loadWorkflow());
  const { steps, invokeIndex } = locateActionlintSteps(workflow);
  assert.notEqual(invokeIndex, -1, "test setup: could not locate the real invoke step");
  steps[invokeIndex] = { ...steps[invokeIndex], run: "./actionlint -color" };
  const problems = validateActionlintRecipe(workflow, readFileSync(HASH_FILE_PATH, "utf8"));
  assert.ok(problems.some((p) => /bare "actionlint -color"/.test(p)));
});

test("negative: an executable uses: step inserted between the verified extraction and the bare invocation is flagged - the hermetic drive cannot execute an action, so this fact is asserted statically instead", () => {
  const workflow = structuredClone(loadWorkflow());
  const { steps, installIndex, invokeIndex } = locateActionlintSteps(workflow);
  assert.notEqual(installIndex, -1, "test setup: could not locate the real install step");
  assert.notEqual(invokeIndex, -1, "test setup: could not locate the real invoke step");
  steps.splice(installIndex + 1, 0, {
    name: "a pinned action inserted between verify and invoke",
    uses: "actions/checkout@v4",
  });
  const problems = validateActionlintRecipe(workflow, readFileSync(HASH_FILE_PATH, "utf8"));
  assert.ok(problems.some((p) => /an executable "uses:" step/.test(p)));
});

test("positive: the real ci.yml has no uses: step between the verified extraction and the bare invocation", () => {
  const workflow = loadWorkflow();
  const { steps, installIndex, invokeIndex } = locateActionlintSteps(workflow);
  assert.notEqual(installIndex, -1);
  assert.notEqual(invokeIndex, -1);
  const between = steps.slice(installIndex + 1, invokeIndex);
  assert.ok(
    between.every((step) => typeof step?.uses !== "string"),
    "test setup: expected no uses: step in the real recipe's verify-to-invoke window"
  );
  const problems = validateActionlintRecipe(workflow, readFileSync(HASH_FILE_PATH, "utf8"));
  assert.ok(!problems.some((p) => /an executable "uses:" step/.test(p)));
});

// ---------------------------------------------------------------------------
// Audit control. Every static failure path that validateActionlintRecipe
// can still produce must map to one of the five bounded facts this recipe
// asserts statically - (i) the pinned URL literal, (ii) the -o filename,
// (iii) the checksum record being exactly one well-formed line whose hex
// matches the verified release digest and whose filename agrees with the
// -o target, (iv) the bare, PATH-resolved invocation - or to a named
// structural precondition (something that has to hold before (i)-(iv) can
// even be evaluated, such as the job or the install step existing at all).
// Anything checking an unbounded/behavioral property by scanning shell
// text belongs to neither bucket and must be removed once it is proven
// redundant with existing hermetic coverage (this is what removed the
// former swallow/curl/tar/GITHUB_PATH-append checks). KNOWN_STATIC_CHECKS
// and buildValidationContext are declared earlier in the file, next to
// validateActionlintRecipe, since validateActionlintRecipe's entire body
// is the projection over this registry - it has no existence apart from
// it.
//
// This is not a comment-only audit. AUDIT_SCENARIOS below constructs a
// real, minimal mutation of the actual workflow and/or hash record for
// each surviving check, actually calls validateActionlintRecipe, and
// asserts (a) the check's own mapped message fires, (b) every message the
// mutation produced - not just the expected one - matches some entry in
// KNOWN_STATIC_CHECKS, and (c) the total problem count matches exactly
// what the scenario's own analysis predicts. (b) is what makes this
// falsifiable against the future: if someone adds a new KNOWN_STATIC_CHECKS
// entry whose evaluate(ctx) fires under a condition that also happens to
// hold in one of these constructed scenarios (a very likely case for
// anything added to the same install-step or hash-record blocks these
// scenarios already exercise on every axis) without also naming that entry
// here in a scenario's `expect`, this test reds on the count mismatch. A
// completeness pass below also confirms every registered mapping is
// actually exercised by at least one scenario, so the registry itself can
// never silently rot into force-fit entries nobody triggers.
//
// This is the coverage question - "of the messages this recipe actually
// produced across the scenarios we thought to write, is each one a known
// one, and is each known one actually reached." It is not, and does not
// need to be, what closes the accumulation-seam gap described above. That
// gap is closed by validateActionlintRecipe having no code path other
// than `KNOWN_STATIC_CHECKS.map((entry) =>
// entry.evaluate(ctx)).filter(Boolean)`: every entry's evaluate() runs on
// EVERY call, unconditionally, whether its own condition is true or not,
// because .map() iterates the whole array every time - there is no
// "unreached, so invisible" state a registered check can be in, and there
// is no other statement in the function for an unregistered message to
// come from. This scenario battery and that structural fact answer
// different questions; this file does not ask the battery to answer the
// second one.
// ---------------------------------------------------------------------------

const AUDIT_SCENARIOS = [
  {
    name: "no actionlint job found",
    build: () => ({ workflow: { jobs: {} }, hashRecord: readFileSync(HASH_FILE_PATH, "utf8") }),
    expect: [/no "actionlint" job found in the workflow/],
  },
  {
    name: "install/verify step missing (no step's run text mentions sha256sum --check at all)",
    build: () => ({
      workflow: withMutatedInstallRun(() => "echo this step never verifies a checksum at all"),
      hashRecord: readFileSync(HASH_FILE_PATH, "utf8"),
    }),
    expect: [/the install\/verify step is missing/],
  },
  {
    name: "invoke step is ./actionlint instead of the bare PATH-resolved form",
    build: () => {
      const workflow = structuredClone(loadWorkflow());
      const { steps, invokeIndex } = locateActionlintSteps(workflow);
      assert.notEqual(invokeIndex, -1, "test setup: could not locate the real invoke step");
      steps[invokeIndex] = { ...steps[invokeIndex], run: "./actionlint -color" };
      return { workflow, hashRecord: readFileSync(HASH_FILE_PATH, "utf8") };
    },
    expect: [/bare "actionlint -color"/],
  },
  {
    name: "install step fetches a URL that is neither the pin nor a moving reference",
    build: () => ({
      workflow: withMutatedInstallRun((run) =>
        run.replace(PINNED_URL, "https://example.com/not-the-pinned-archive.tar.gz")
      ),
      hashRecord: readFileSync(HASH_FILE_PATH, "utf8"),
    }),
    expect: [/does not fetch the exact pinned URL/],
  },
  {
    name: "install step's text matches a moving-reference pattern while the pinned URL itself stays untouched",
    build: () => ({
      workflow: withMutatedInstallRun((run) => `${run}\n# see rhysd/actionlint@main for context`),
      hashRecord: readFileSync(HASH_FILE_PATH, "utf8"),
    }),
    expect: [/fetches from a moving reference/],
  },
  {
    name: "install step saves the archive under a different filename than the pin",
    build: () => ({
      workflow: withMutatedInstallRun((run) =>
        run.replace(`-o ${PINNED_ARCHIVE_FILENAME}`, "-o actionlint.tar.gz")
      ),
      hashRecord: readFileSync(HASH_FILE_PATH, "utf8"),
    }),
    expect: [/saves the download as "actionlint\.tar\.gz"/, /they must agree/],
  },
  {
    name: "install step runs sha256sum --check against a file other than the tracked checksum record",
    build: () => ({
      workflow: withMutatedInstallRun((run) =>
        run.replace(
          `sha256sum --check ${HASH_FILE_RELATIVE_PATH}`,
          "sha256sum --check some/other/file.sha256"
        )
      ),
      hashRecord: readFileSync(HASH_FILE_PATH, "utf8"),
    }),
    expect: [/does not run "sha256sum --check/],
  },
  {
    name: "checksum record is empty",
    build: () => ({ workflow: loadWorkflow(), hashRecord: "" }),
    expect: [/missing or empty/],
  },
  {
    name: "checksum record has more than one line",
    build: () => ({
      workflow: loadWorkflow(),
      hashRecord: `${VERIFIED_PINNED_SHA256}  ${PINNED_ARCHIVE_FILENAME}\n${VERIFIED_PINNED_SHA256}  extra-file\n`,
    }),
    expect: [/exactly one line/],
  },
  {
    name: "checksum record's single line is malformed",
    build: () => ({ workflow: loadWorkflow(), hashRecord: "not-a-real-hash-line\n" }),
    expect: [/malformed/],
  },
  {
    name: "checksum record's hex does not match the verified digest",
    build: () => ({
      workflow: loadWorkflow(),
      hashRecord: `${"0".repeat(64)}  ${PINNED_ARCHIVE_FILENAME}\n`,
    }),
    expect: [/does not match the independently verified release digest/],
  },
  {
    name: "checksum record names a different filename than the pin",
    build: () => ({
      workflow: loadWorkflow(),
      hashRecord: `${VERIFIED_PINNED_SHA256}  some-other-name.tar.gz\n`,
    }),
    expect: [/the recorded checksum names "some-other-name\.tar\.gz"/, /they must agree/],
  },
  {
    name: "an executable uses: step is inserted between the verified extraction and the bare invocation",
    build: () => {
      const workflow = structuredClone(loadWorkflow());
      const { steps, installIndex, invokeIndex } = locateActionlintSteps(workflow);
      assert.notEqual(installIndex, -1, "test setup: could not locate the real install step");
      assert.notEqual(invokeIndex, -1, "test setup: could not locate the real invoke step");
      steps.splice(installIndex + 1, 0, {
        name: "a pinned action inserted between verify and invoke",
        uses: "actions/checkout@v4",
      });
      return { workflow, hashRecord: readFileSync(HASH_FILE_PATH, "utf8") };
    },
    expect: [/an executable "uses:" step/],
  },
];

test("every surviving static failure path in validateActionlintRecipe maps to a named bounded fact or structural precondition, and nothing else", () => {
  const triggeredMappings = new Set();

  for (const scenario of AUDIT_SCENARIOS) {
    const { workflow, hashRecord } = scenario.build();
    const problems = validateActionlintRecipe(workflow, hashRecord);

    assert.ok(
      problems.length > 0,
      `scenario "${scenario.name}": test setup produced no problems at all - the mutation did not take effect`
    );

    for (const expectedPattern of scenario.expect) {
      assert.ok(
        problems.some((p) => expectedPattern.test(p)),
        `scenario "${scenario.name}": expected a problem matching ${expectedPattern}, got: ${JSON.stringify(problems)}`
      );
    }

    assert.equal(
      problems.length,
      scenario.expect.length,
      `scenario "${scenario.name}": expected exactly ${scenario.expect.length} problem(s) (${scenario.expect.join(", ")}), got ${problems.length}: ${JSON.stringify(problems)}`
    );

    for (const problem of problems) {
      const match = KNOWN_STATIC_CHECKS.find((entry) => entry.pattern.test(problem));
      assert.ok(
        match,
        `scenario "${scenario.name}" surfaced an UNMAPPED static check: "${problem}" - every static ` +
          "failure path in validateActionlintRecipe must map to a named bounded fact or a " +
          "named structural precondition; either add this check to KNOWN_STATIC_CHECKS " +
          "with an honest mapping, or remove it once proven redundant with existing hermetic coverage"
      );
      triggeredMappings.add(match.mapsTo);
    }
  }

  // Completeness the other way: a registered mapping that no scenario ever
  // triggers is dead weight the audit itself would never have caught - the
  // exact force-fit-mapping failure this whole exercise exists to prevent.
  for (const entry of KNOWN_STATIC_CHECKS) {
    assert.ok(
      triggeredMappings.has(entry.mapsTo),
      `registered mapping "${entry.mapsTo}" (pattern ${entry.pattern}) was never triggered by any ` +
        "AUDIT_SCENARIOS entry - either add a scenario that exercises it or remove the stale mapping"
    );
  }
});

// ---------------------------------------------------------------------------
// Completeness requirement: the static check SITES in
// validateActionlintRecipe must be inventoried STRUCTURALLY, FROM ITS OWN
// SOURCE, with every site mapping to a named bounded fact or structural
// precondition, and a site that is neither enumerated nor removed must
// fail this audit. Scenario-derived and runtime-derived coverage do not
// satisfy that requirement, however sound the property they establish -
// three earlier designs each proved a real property and still missed it:
//
//   1. counting `problems.push(` in source text (defeated by
//      `problems.push.bind(problems)`, a call storing a message while
//      leaving no matching text for the regex to find);
//   2. a reporter whose internal list only a registered `report(id,
//      message)` could append to (defeated by mutating the plain array
//      `list()` handed back, after it left the reporter entirely - the
//      append never went near `report()`);
//   3. a runtime length bound plus a scenario/message audit over
//      KNOWN_STATIC_CHECKS (both still true and still checked below, but
//      neither is derived from the function's SOURCE - an early return or
//      a conditional return injected before the projection line stays
//      invisible to both, since no scenario ever sets the condition that
//      would exercise it, and the function still returns a normal-looking
//      array of the right shape either way).
//
// The requirement has two conjuncts and neither alone is sufficient:
//
//   (a) every REGISTERED site maps to a named bounded fact or structural
//       precondition - the KNOWN_STATIC_CHECKS registry itself, checked by
//       the scenario/message audit above (`entry.mapsTo` is a real,
//       programmatically-read field, not comment prose);
//   (b) the function contains no OTHER site - inventoried structurally
//       from its own source, which is what the AST permitted-shape check
//       below does.
//
// The check below parses the real TypeScript/JavaScript syntax (never a
// regex over source text - a source-text pattern has no quote or comment
// state at all, the exact defect class this whole story exists to close,
// and the exact mistake an early hand-written version of this very check
// made against its own test input) and asserts that
// validateActionlintRecipe's body is EXACTLY: one variable declaration
// binding a context value from a direct call to buildValidationContext,
// then one return statement whose argument is precisely
// `KNOWN_STATIC_CHECKS.map((<param>) => <param>.evaluate(<ctx>)).filter(Boolean)`
// - structurally, by real AST node kind and identifier text, never by
// comparing source strings - and nothing else. Any other statement, or any
// wrapping of the return expression at all, is a site this function's own
// source does not enumerate, and therefore violates the audit.
// ---------------------------------------------------------------------------

/**
 * Resolves the function BODY the runtime actually calls for the top-level
 * identifier `functionName` - never a depth-first search over the whole
 * tree. A deep search can be pointed at a decoy: an unused, nested
 * declaration sharing the same name is not the module's own top-level
 * binding and never runs, but a search that does not check nesting depth
 * cannot tell the two apart, and a first-match search returns whichever one
 * it reaches first in source order regardless of which one is live. This
 * only ever looks at `sourceFile.statements` - a module's own top-level
 * statement list - so a nested decoy, however it is spelled, is never even
 * a candidate.
 *
 * Exactly ONE top-level form is accepted: a `const functionName = ...`
 * binding whose initializer is a function expression or arrow function
 * with a block body. A `function functionName(...) { ... }` declaration
 * and a top-level `let`/`var` binding are both recognized (so they
 * produce a clear, named violation instead of silently reading as
 * "nothing found"), but neither is accepted, because both are
 * REASSIGNABLE: a later plain assignment elsewhere in the source
 * (`functionName = somethingElse;`) would silently change which value the
 * module actually calls, without that assignment ever needing to become a
 * second top-level candidate the way a nested decoy or a duplicate
 * declaration would. An earlier version of this check tried to find every
 * such later write instead of narrowing the accepted form - that is
 * DETECTION, and detection is exactly the shape every earlier version of
 * this whole completeness requirement failed at, one step short of the
 * runtime each time (a source-text counter guarded a spelling; a
 * reporter's own returned array was mutated after leaving it; a
 * depth-first shape check inspected a decoy instead of the live node).
 * A `const` binding is not merely harder to defeat, it makes the defeat
 * UNCONSTRUCTIBLE: reassigning a `const` is a real, immediate `TypeError`
 * the moment that statement would execute, so there is no later value for
 * this audit, or anything else, to need to inventory. Finding zero
 * top-level candidates of ANY of the three forms, or a `const` candidate
 * whose initializer is not a function at all, is a violation. Finding
 * more than one top-level candidate is also a violation and fails closed
 * rather than guessing which one is real - a decoy sharing the name at
 * the SAME top level as the live binding is exactly as disqualifying as
 * one nested inside it.
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} functionName
 * @returns {{ body: import("typescript").Block | undefined, violations: string[] }}
 */
function resolveTopLevelFunctionBody(sourceFile, functionName) {
  const candidates = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === functionName) {
      candidates.push({
        kind: "a top-level function declaration (reassignable - not accepted)",
        accepted: false,
        body: undefined,
      });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== functionName) continue;
      if (!isConst) {
        candidates.push({
          kind: "a top-level let/var binding (reassignable - not accepted)",
          accepted: false,
          body: undefined,
        });
        continue;
      }
      const init = decl.initializer;
      const isFunctionLike = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
      candidates.push({
        kind: "a top-level const binding",
        accepted: true,
        body: isFunctionLike && ts.isBlock(init.body) ? init.body : undefined,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      body: undefined,
      violations: [
        `no top-level "${functionName}" binding was found in this source at all - only an ` +
          "immutable top-level const binding is accepted",
      ],
    };
  }
  const rejected = candidates.filter((c) => !c.accepted);
  if (rejected.length > 0) {
    return {
      body: undefined,
      violations: [
        `"${functionName}" is declared as ${rejected.map((c) => c.kind).join(", ")} - only a ` +
          "top-level const binding is accepted; every other form is reassignable, so a later " +
          "write anywhere in the source could silently change which value is actually called",
      ],
    };
  }
  if (candidates.length > 1) {
    return {
      body: undefined,
      violations: [
        `expected exactly one top-level const "${functionName}" binding, found ${candidates.length} ` +
          "- refusing to guess which one is the real, live binding the suite actually calls",
      ],
    };
  }
  const [only] = candidates;
  if (!only.body) {
    return {
      body: undefined,
      violations: [
        `the top-level const "${functionName}" binding is not a function with a block body`,
      ],
    };
  }
  return { body: only.body, violations: [] };
}

/**
 * Structurally verifies `expr` is exactly
 * `KNOWN_STATIC_CHECKS.map((<param>) => <param>.evaluate(<ctxName>)).filter(Boolean)`
 * - every check below inspects a real AST node kind and identifier text,
 * never source text. `ctxName` is whatever name the function's own context
 * binding actually used, so a consistent rename (`ctx` -> `context`) is
 * permitted - the invariant is the shape, never the spelling.
 */
function describeProjectionReturnViolations(expr, ctxName) {
  const violations = [];

  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) {
    violations.push("the return argument must be a direct .filter(...) call");
    return violations;
  }
  const filterAccess = expr.expression;
  if (filterAccess.name.text !== "filter") {
    violations.push(
      `expected the outer call to be ".filter(...)", found ".${filterAccess.name.text}(...)"`
    );
  }
  if (
    expr.arguments.length !== 1 ||
    !ts.isIdentifier(expr.arguments[0]) ||
    expr.arguments[0].text !== "Boolean"
  ) {
    violations.push('.filter(...) must be called with exactly the bare identifier "Boolean"');
  }

  const mapCall = filterAccess.expression;
  if (!ts.isCallExpression(mapCall) || !ts.isPropertyAccessExpression(mapCall.expression)) {
    violations.push(
      ".filter(...) must be called directly on a .map(...) call, with nothing else in between"
    );
    return violations;
  }
  const mapAccess = mapCall.expression;
  if (mapAccess.name.text !== "map") {
    violations.push(
      `expected the inner call to be ".map(...)", found ".${mapAccess.name.text}(...)"`
    );
  }
  if (
    !ts.isIdentifier(mapAccess.expression) ||
    mapAccess.expression.text !== "KNOWN_STATIC_CHECKS"
  ) {
    violations.push(
      '.map(...) must be called directly on the bare identifier "KNOWN_STATIC_CHECKS"'
    );
  }

  if (mapCall.arguments.length !== 1 || !ts.isArrowFunction(mapCall.arguments[0])) {
    violations.push(".map(...) must take exactly one arrow-function argument");
    return violations;
  }
  const arrow = mapCall.arguments[0];
  if (arrow.parameters.length !== 1 || !ts.isIdentifier(arrow.parameters[0].name)) {
    violations.push("the .map(...) arrow must take exactly one plain-identifier parameter");
    return violations;
  }
  const paramName = arrow.parameters[0].name.text;

  const body = arrow.body;
  if (ts.isBlock(body)) {
    violations.push("the .map(...) arrow must use a concise (non-block) body");
    return violations;
  }
  const isExactEvaluateCall =
    ts.isCallExpression(body) &&
    ts.isPropertyAccessExpression(body.expression) &&
    body.expression.name.text === "evaluate" &&
    ts.isIdentifier(body.expression.expression) &&
    body.expression.expression.text === paramName &&
    body.arguments.length === 1 &&
    ts.isIdentifier(body.arguments[0]) &&
    body.arguments[0].text === ctxName;
  if (!isExactEvaluateCall) {
    violations.push(
      `the .map(...) arrow's body must be exactly "${paramName}.evaluate(${ctxName})"`
    );
  }

  return violations;
}

/**
 * The structural half of the completeness requirement. Returns a list of
 * violation descriptions; an empty list means validateActionlintRecipe's
 * body, parsed from `sourceText` as real syntax, is exactly the permitted
 * projection shape.
 *
 * @param {string} sourceText
 * @returns {string[]}
 */
function describeValidateActionlintRecipeShapeViolations(sourceText) {
  const sourceFile = parseSourceFile("validate-actionlint-recipe-shape-check.ts", sourceText);
  const { body, violations: resolutionViolations } = resolveTopLevelFunctionBody(
    sourceFile,
    "validateActionlintRecipe"
  );
  if (resolutionViolations.length > 0) return resolutionViolations;

  const statements = body.statements;
  if (statements.length !== 2) {
    return [
      "expected exactly 2 statements in validateActionlintRecipe's body (one context " +
        `binding, one return), found ${statements.length}`,
    ];
  }
  const [first, second] = statements;
  const violations = [];
  let ctxName;

  if (!ts.isVariableStatement(first)) {
    violations.push("the first statement must be a variable declaration binding the context");
  } else {
    const decls = first.declarationList.declarations;
    if (decls.length !== 1) {
      violations.push("the first statement must declare exactly one variable");
    } else {
      const decl = decls[0];
      if (ts.isIdentifier(decl.name)) {
        ctxName = decl.name.text;
      } else {
        violations.push(
          "the context binding must be a plain identifier, not a destructuring pattern"
        );
      }
      const init = decl.initializer;
      if (
        !init ||
        !ts.isCallExpression(init) ||
        !ts.isIdentifier(init.expression) ||
        init.expression.text !== "buildValidationContext"
      ) {
        violations.push(
          "the context variable must be initialized from a direct call to buildValidationContext(...)"
        );
      }
    }
  }

  if (!ts.isReturnStatement(second)) {
    violations.push("the second (last) statement must be a return statement");
  } else if (!second.expression) {
    violations.push("the return statement must have an argument");
  } else {
    // Even when the first statement already failed above (so ctxName is
    // unset), still inspect the return shape against a name that can
    // never legitimately match - a malformed first statement must not
    // silently suppress an independent violation in the second.
    violations.push(
      ...describeProjectionReturnViolations(second.expression, ctxName ?? "\0no-ctx-binding")
    );
  }

  return violations;
}

test("static-check completeness audit: every KNOWN_STATIC_CHECKS entry is a real, callable evaluator", () => {
  for (const entry of KNOWN_STATIC_CHECKS) {
    assert.equal(
      typeof entry.evaluate,
      "function",
      `KNOWN_STATIC_CHECKS entry "${entry.id}" must carry a callable evaluate(ctx)`
    );
  }
});

test("static-check completeness audit: validateActionlintRecipe can never return more messages than KNOWN_STATIC_CHECKS has entries, for any input, including a maximally-broken one", () => {
  const maximallyBroken = {
    jobs: { [ACTIONLINT_JOB_ID]: { steps: [{ name: "decoy", uses: "actions/checkout@v4" }] } },
  };
  const problems = validateActionlintRecipe(maximallyBroken, "not-a-real-hash-line\n");
  assert.ok(
    problems.length <= KNOWN_STATIC_CHECKS.length,
    `got ${problems.length} problems from ${KNOWN_STATIC_CHECKS.length} registered checks - ` +
      "a projection over a fixed-length array can never exceed that array's own length"
  );

  for (const { workflow, hashRecord } of AUDIT_SCENARIOS.map((s) => s.build())) {
    assert.ok(validateActionlintRecipe(workflow, hashRecord).length <= KNOWN_STATIC_CHECKS.length);
  }
});

test("static-check completeness audit: validateActionlintRecipe's real, committed source is exactly the permitted projection shape", () => {
  const ownSourceText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const violations = describeValidateActionlintRecipeShapeViolations(ownSourceText);
  assert.deepEqual(
    violations,
    [],
    "the real, committed validateActionlintRecipe must exactly match the permitted shape; " +
      `violations: ${JSON.stringify(violations)}`
  );
});

const SHAPE_GREEN_CONTROLS = [
  {
    name: "formatting-only change (extra blank lines and whitespace)",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {

  const ctx    =    buildValidationContext(workflow, hashRecordContent);


  return KNOWN_STATIC_CHECKS
    .map((entry) => entry.evaluate(ctx))
    .filter(Boolean);
};
`,
  },
  {
    name: 'a comment containing the word "return" and a banned-looking call - must be invisible to a real parser',
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  // return ["mutant"]; problems.push("this is only a comment, never live code")
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
  {
    name: "a consistent rename of the context binding (ctx -> context) - the invariant is the shape, never the spelling",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const context = buildValidationContext(workflow, hashRecordContent);
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(context)).filter(Boolean);
};
`,
  },
  {
    name: "a function expression instead of an arrow function, still bound to a top-level const - both are accepted forms for the same reason (neither is reassignable)",
    source: `
const validateActionlintRecipe = function (workflow, hashRecordContent) {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
  {
    name: "known, disclosed boundary: a top-level const binding followed by a later direct assignment attempting to reassign it - accepted by this STATIC check, because inspecting only the declaration's own body is correct once the declaration is const; the reassignment attempt is not a static-check gap, it is a real, immediate TypeError the moment that statement would actually execute in the real, committed file, which is what makes the const form closed by construction rather than by detection",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  if (workflow?.__bypassFlag) {
    return ["mutant: reassigned live validator bypassed the evaluator registry"];
  }
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
];

for (const { name, source } of SHAPE_GREEN_CONTROLS) {
  test(`static-check completeness audit green control: ${name}`, () => {
    const violations = describeValidateActionlintRecipeShapeViolations(source);
    assert.deepEqual(
      violations,
      [],
      `expected this shape to be PERMITTED, got violations: ${JSON.stringify(violations)}`
    );
  });
}

const SHAPE_MUTATIONS = [
  {
    name: "injected early return, before the context is even built",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  if (workflow?.__bypassFlag) {
    return ["mutant: unregistered static check bypassed the evaluator registry"];
  }
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
  {
    name: "injected conditional return after the context is built",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  if (workflow?.__bypassFlag) {
    return ["mutant: unregistered static check bypassed the evaluator registry"];
  }
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
  {
    name: "a ternary at the return (defeats a naive single-return-statement count)",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return workflow?.__bypassFlag
    ? ["mutant: unregistered static check bypassed the evaluator registry"]
    : KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
  {
    name: "a || short-circuit at the return",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return (workflow?.__bypassFlag && ["mutant"]) || KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
  {
    name: "a ?? short-circuit at the return",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return workflow?.__bypassResult ?? KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
  {
    name: "an extra statement inserted between the context binding and the return",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  console.log("side effect");
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
  {
    name: ".filter(Boolean) removed entirely",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx));
};
`,
  },
  {
    name: "the registry identifier swapped for something else",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return SOME_OTHER_ARRAY.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
  {
    name: "entry.evaluate reached via bracket notation instead of a dotted property access",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return KNOWN_STATIC_CHECKS.map((entry) => entry["evaluate"](ctx)).filter(Boolean);
};
`,
  },
  {
    name: "entry.evaluate called through an aliased .call indirection",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate.call(entry, ctx)).filter(Boolean);
};
`,
  },
  {
    name: "entry.evaluate called with an alternate argument instead of the context binding",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(workflow)).filter(Boolean);
};
`,
  },
  {
    name: "the whole return wrapped in an IIFE",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return (() => KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean))();
};
`,
  },
  {
    name: "the return wrapped in a sequence (comma) expression",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return (sideEffect(), KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean));
};
`,
  },
  {
    name: "a standalone string-literal statement inside the body (a real third statement, not a comment)",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  "not a directive, just a stray statement";
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
  {
    name: "a permitted decoy nested inside an unused wrapper function, in front of the real top-level declaration carrying an unregistered conditional return",
    source: `
function unusedWrapper() {
  function validateActionlintRecipe(workflow, hashRecordContent) {
    const ctx = buildValidationContext(workflow, hashRecordContent);
    return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
  }
}
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  if (workflow?.__bypassFlag) {
    return ["mutant: unregistered static check bypassed the evaluator registry"];
  }
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
  {
    name: "the same nested decoy, but the real top-level binding is an arrow function assigned to a const carrying the same unregistered conditional return - the decoy stays invisible regardless of which accepted form the live binding uses",
    source: `
function unusedWrapper() {
  function validateActionlintRecipe(workflow, hashRecordContent) {
    const ctx = buildValidationContext(workflow, hashRecordContent);
    return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
  }
}
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  if (workflow?.__bypassFlag) {
    return ["mutant: unregistered static check bypassed the evaluator registry"];
  }
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
  {
    name: "two genuine top-level const declarations of validateActionlintRecipe, no nesting at all - both individually accepted forms, but ambiguous as a pair, refused rather than guessed at",
    source: `
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
const validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  if (workflow?.__bypassFlag) {
    return ["mutant: unregistered static check bypassed the evaluator registry"];
  }
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
  {
    name: "a top-level function declaration is rejected outright - reassignable, not an accepted form, regardless of whether anything actually reassigns it",
    source: `
function validateActionlintRecipe(workflow, hashRecordContent) {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
}
`,
  },
  {
    name: "a top-level 'let' binding to an arrow function is rejected outright - reassignable, not an accepted form, regardless of whether anything actually reassigns it",
    source: `
let validateActionlintRecipe = (workflow, hashRecordContent) => {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
  {
    name: "a top-level 'var' binding to a function expression is rejected outright - reassignable, not an accepted form, regardless of whether anything actually reassigns it",
    source: `
var validateActionlintRecipe = function (workflow, hashRecordContent) {
  const ctx = buildValidationContext(workflow, hashRecordContent);
  return KNOWN_STATIC_CHECKS.map((entry) => entry.evaluate(ctx)).filter(Boolean);
};
`,
  },
];

for (const { name, source } of SHAPE_MUTATIONS) {
  test(`static-check completeness audit mutation row: ${name}`, () => {
    const violations = describeValidateActionlintRecipeShapeViolations(source);
    assert.ok(
      violations.length > 0,
      "expected this mutated shape to be REJECTED by the permitted-shape check, but it " +
        "passed with zero violations"
    );
  });
}

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
 * {name, run, if?} objects, for the hermetic drive below. A `uses:` step
 * (the checkout above them) carries no shell text of its own and is
 * skipped here, since the hermetic drive can only run shell `run:` text
 * through a real shell - it cannot execute a GitHub Action at all, so
 * filtering one out here is not a judgment that it is harmless. Whether a
 * `uses:` step matters is instead answered statically: validateActionlintRecipe
 * asserts no such step may appear between the verified extraction and the
 * bare invocation, which is the one place in this job's structure where
 * that would matter. The step's own `if:` field (when present) rides along
 * unchanged - never synthesized when absent from the source step - so
 * downstream logic (classifyStepCondition, isProvenAuthoritative,
 * mayExecute) can tell a genuinely live step apart from one whose text
 * merely looks right but never actually executes.
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
 * Strips a `#` that starts a token (the line's own first non-blank
 * character, or immediately after whitespace or a statement separator)
 * through the end of that line, before command-position detection runs. A
 * `#` that is not a token start (e.g. mid-word, as in `foo#bar`) is left
 * alone. This is what stops a line shaped as `# ; sha256sum --check ...`
 * from reading, to a naive scan, as "a real statement separator followed by
 * the command" - the whole line is one comment and this strips it before
 * that scan ever runs.
 *
 * NOT quote-aware, and this is a real, disclosed limitation rather than a
 * claim of general comment parsing. The exact implemented boundary: a `#`
 * is stripped, to end of line, when it is preceded by start-of-line or by
 * one of `[\s;&|(]` - nothing else. That boundary is wrong in BOTH
 * directions, not just one:
 *
 * - Too eager (false REJECT): a `#` lexically inside a single- or
 *   double-quoted argument (e.g. `echo "prefix # quoted data"; sha256sum
 *   --check ...`) is still treated as a comment opener here, because this
 *   function has no notion of quote state at all - it truncates a real
 *   command that genuinely follows the quoted string. Adding `(` to the
 *   separator class widened this exact direction rather than only
 *   narrowing the false-accept direction below: a quoted `#` immediately
 *   preceded by a `(` (e.g. `echo "a(#b"; sha256sum --check ...`) was
 *   NOT stripped before this class gained `(` - it correctly, if
 *   coincidentally, still read as command position - and IS stripped
 *   now, wrongly rejecting a step a real shell genuinely runs. This is
 *   not a zero-cost change: it trades a narrower false-accept surface for
 *   a wider false-reject one, on this specific quoted-`(`-before-`#`
 *   shape, and both this file's own prose and its commit history say so
 *   plainly rather than describing the trade as free.
 * - Not eager enough (false ACCEPT): a `#` immediately following a
 *   character outside `[\s;&|(]` - a backtick, the second `(` of `$((`,
 *   or any other command-substitution/subshell opener this boundary
 *   doesn't name - is NOT stripped, even though a real shell would still
 *   treat it as a comment. Text after it that merely looks like a
 *   verify command is left in place and can be misread as one.
 *
 * Both directions are demonstrated by name in the "known residual" tests
 * below - narrowly, for the specific characters this boundary does and
 * does not cover, never as a claim that one direction is impossible.
 * Doing this properly needs real shell quoting/escaping/here-doc
 * semantics, which is out of scope for a test-support selector. The real
 * safety net for an unsafe recipe is the hermetic execution battery
 * further down, which runs actual step text through a real shell instead
 * of pattern-matching its shape; this selector only locates which step
 * that battery should be driving from, it is not itself the security
 * boundary.
 *
 * @param {string} text
 * @returns {string}
 */
function stripShellLineComments(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/(^|[\s;&|(])#.*$/, "$1"))
    .join("\n");
}

/**
 * True when a step's own run text actually EXECUTES the checksum-verify
 * command - "sha256sum --check" in command position: right at the start of
 * the script, right after a newline, or right after a shell statement
 * separator (`;`, `&`, `|`) or command-substitution opener (`$(`, a
 * backtick) - as opposed to merely mentioning that phrase inside a comment
 * or an echo/printf argument. A shell command is defined by where it sits,
 * not by which characters happen to appear somewhere in the line, and a
 * character that only LOOKS like a separator because it sits inside a
 * comment is not a separator at all - see stripShellLineComments. A step
 * whose text only references the phrase, without ever running it, has
 * verified nothing, however convincing the surrounding text reads - a
 * decoy comment or echo that quotes "sha256sum --check
 * config/actionlint-artifact.sha256" must never be mistaken for a step
 * that ran it.
 *
 * Inherits stripShellLineComments's boundary exactly, in both directions:
 * a genuinely-verifying step can be misread as not verifying (quote-
 * unaware false reject), and a step that never actually runs the check
 * can be misread as verifying (false accept, for a comment opened by a
 * character stripShellLineComments does not recognize as one). Neither
 * direction is silent for THIS story's actual safety property, though,
 * because two independent backstops exist: every real caller of the
 * index-locating function built on this (locateRunStepIndices) asserts
 * its installIndex is not -1, so a false reject fails that test loudly;
 * and the hermetic execution battery further down drives the real,
 * unmutated recipe through a real shell regardless of what this selector
 * concludes, so a false accept on a genuinely-unsafe recipe is still
 * caught there.
 *
 * @param {string} runText
 * @returns {boolean}
 */
function stepPerformsChecksumVerification(runText) {
  return (
    typeof runText === "string" &&
    /(?:^|\n|[;&|]|\$\(|`)\s*sha256sum\s+--check\b/.test(stripShellLineComments(runText))
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
 * directory and one accumulating environment. A step classified "always"
 * (classifyStepCondition) is skipped once an earlier step in the sequence
 * has failed - matching the default per-step `if: success()` every real
 * job step gets unless a workflow opts out, so a failed verification step
 * genuinely prevents an ordinary later step from running, not merely from
 * being marked as passed. A step classified "mayRun" is the deliberate
 * exception: it is still driven regardless of prior failure, since its own
 * unproven condition might specifically be written to run because an
 * earlier step failed (`if: always()` or `if: failure()`), and skipping it
 * here would let exactly that kind of competing installer hide behind an
 * ordinary-looking condition nobody can evaluate.
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

test('negative control: a comment-only line shaped as "# ; sha256sum --check ..." is never mistaken for command position - the semicolon inside a comment is not a statement separator', () => {
  // Exercises the exact adversarial shape a naive "look for a separator
  // right before the phrase" scan would miss: everything from the leading
  // "#" to end of line is a shell comment, so the ";" here never separates
  // two real statements - it is just a character inside comment text, and
  // sha256sum --check never actually runs.
  const commentOnlyLine = "# ; sha256sum --check config/actionlint-artifact.sha256";
  assert.equal(
    stepPerformsChecksumVerification(commentOnlyLine),
    false,
    "a comment-only line must never be accepted as running the checksum-verify command"
  );

  const baselineSteps = extractActionlintRunSteps(loadWorkflow());
  const { installIndex: baselineInstallIndex } = locateRunStepIndices(baselineSteps);
  assert.notEqual(baselineInstallIndex, -1, "test setup: could not locate the real install step");
  const canonicalStep = baselineSteps[baselineInstallIndex];
  const decoyRun = canonicalStep.run.replace(
    /^sha256sum --check config\/actionlint-artifact\.sha256$/m,
    commentOnlyLine
  );
  assert.notEqual(
    decoyRun,
    canonicalStep.run,
    "test setup: the replacement must actually change something"
  );
  const mutatedSteps = baselineSteps.slice();
  mutatedSteps[baselineInstallIndex] = { ...canonicalStep, run: decoyRun };
  const { installIndex: mutatedInstallIndex } = locateRunStepIndices(mutatedSteps);
  assert.equal(
    mutatedInstallIndex,
    -1,
    "a comment-only decoy line must never be accepted as the canonical install step"
  );
});

test('green control: a genuine "; sha256sum --check ..." after a real statement separator (no leading comment) is still accepted as command position', () => {
  // The comment-stripping fix must not overcorrect into rejecting a real
  // semicolon-separated command - only a "#" that actually starts a
  // comment token neutralizes what follows it.
  assert.equal(
    stepPerformsChecksumVerification("true ; sha256sum --check config/actionlint-artifact.sha256"),
    true,
    "a real statement separator, with no comment involved, must still count as command position"
  );
});

test("known residual, disclosed and narrowed: a '#' inside shell-quoted text is still treated as a comment opener, causing a false REJECT of a genuine step - bound to the real fail-loud oracle, never the validator's diagnostic", () => {
  // A '#' that is lexically inside a double-quoted shell argument,
  // immediately followed on the same line by a real, executable
  // sha256sum --check command. A real shell runs this command - the
  // quotes protect the '#' from ever opening a comment - but
  // stripShellLineComments has no notion of quote state at all, so it
  // still truncates the line at that '#' and discards the real command
  // that genuinely follows it.
  const quotedHashThenRealCheck =
    'echo "prefix # quoted data"; sha256sum --check config/actionlint-artifact.sha256';

  assert.equal(
    stripShellLineComments(quotedHashThenRealCheck),
    'echo "prefix ',
    "known residual: locks in the exact documented truncation, so a future change to this behavior " +
      "is a deliberate decision rather than an unnoticed drift"
  );
  assert.equal(
    stepPerformsChecksumVerification(quotedHashThenRealCheck),
    false,
    "known residual: a real, later sha256sum --check is invisible here when a '#' inside shell " +
      "quoting precedes it on the same line - this is the documented false-rejection direction"
  );

  // The fail-loud half, bound to the ACTUAL oracle this residual reaches -
  // locateRunStepIndices, never validateActionlintRecipe's diagnostic.
  // locateActionlintSteps (the static validator's own locator) finds the
  // install step by a permissive `.includes("sha256sum --check")`
  // substring test, which still matches this exact text - installIndex is
  // NOT -1 there, and the "install/verify step is missing" message is
  // never emitted for this mutation. The real oracle is
  // locateRunStepIndices, built on stepPerformsChecksumVerification: every
  // one of its real callers immediately asserts installIndex is not -1, so
  // this residual reds the hermetic suite rather than silently letting an
  // unverified recipe through.
  const { installIndex } = locateRunStepIndices([
    { name: "install", run: quotedHashThenRealCheck },
  ]);
  assert.equal(
    installIndex,
    -1,
    "the quote-unaware residual must continue to REJECT this step (installIndex === -1) for this " +
      "specific quoted-hash case - a flip here is a regression worth re-examining against the real " +
      "hermetic battery, the same way the command-substitution-comment case below was"
  );
});

test("comment-selector fix: a '#' immediately after a $( command-substitution opener is now recognized as a comment, so text that only looks like a verify command inside it is correctly REJECTED", () => {
  // Confirmed with a real bash sentinel: the '#' right
  // after $( opens a real comment, the subshell exits 0 with "safe", and
  // sha256sum never runs. Before this fix, '(' was not in the separator
  // class, so the '#' was left in place and the detector's own
  // [;&|] alternative matched the ';' sitting inside what a real shell
  // treats as a comment - a false ACCEPT. Adding '(' to the separator
  // class closes this one specific shape; it does not close the class
  // (see the next test).
  const commandSubstitutionComment =
    "value=$(# ; sha256sum --check config/actionlint-artifact.sha256\nprintf safe)";

  assert.equal(
    stepPerformsChecksumVerification(commandSubstitutionComment),
    false,
    "a '#' right after $( must now be recognized as a comment opener, so the text that follows it " +
      "is stripped and never read as a real verify command"
  );
  const { installIndex } = locateRunStepIndices([
    { name: "install", run: commandSubstitutionComment },
  ]);
  assert.equal(
    installIndex,
    -1,
    "this text must not be recognized as the install step - a real shell never runs sha256sum here"
  );
});

test("known, NOT closed: a '#' immediately after a backtick command-substitution opener is still misread as not starting a comment, so this selector still false-ACCEPTS text a real shell never runs - the hermetic execution battery is what actually keeps this from being a silent escape, not this selector", () => {
  // Same real-shell fact as the $( case above - a '#' right after a
  // backtick also opens a real comment - but backtick is not in
  // stripShellLineComments's separator class ([\s;&|(] only), so this
  // exact shape is NOT recognized and the text after '#' is left in
  // place, reading as command position to the detector. This makes the
  // general point concrete: widening the separator class narrows
  // the surface one character at a time and never closes the class -
  // arithmetic expansion's second "(" in "$((", and other subshell/
  // substitution openers, remain equally open. Disclosed here rather
  // than silently left for someone else to discover later.
  const backtickComment =
    "value=`# ; sha256sum --check config/actionlint-artifact.sha256\nprintf safe`";

  assert.equal(
    stepPerformsChecksumVerification(backtickComment),
    true,
    "known, disclosed, NOT-closed gap: a backtick-preceded '#' is still misread as command position " +
      "here, exactly as it was before this fix - only the $( shape was addressed, not the class"
  );
  const { installIndex } = locateRunStepIndices([{ name: "install", run: backtickComment }]);
  assert.equal(
    installIndex,
    0,
    "this selector still (wrongly) accepts this text as the install step for this input - the real " +
      "safety net for an actually-unsafe recipe is the hermetic execution battery further down, " +
      "which drives real step text through a real shell regardless of what this heuristic concludes, " +
      "and is what a real-execution check catches for this exact shape (4 pass / 2 fail) when it " +
      "replaced the real workflow's verifier line"
  );
});

test("comment-selector cost, disclosed: adding '(' to the separator class is not free - it widens the quote-unaware false-REJECT direction on a quoted-'(' shape that the PREVIOUS class did not misdetect", () => {
  // The exact measurement. Before '(' joined the separator class, the
  // '#' here was NOT preceded by a recognized separator character (it
  // sits right after '(', which was not yet in the class), so this line
  // was correctly read as command position - not because the old class
  // understood quoting, but because it happened not to reach this '#' at
  // all. Adding '(' now makes this same '#' match the separator class,
  // and since this function still has no quote state, it strips from
  // '#' onward exactly as it would for an unquoted '#' - wrongly
  // rejecting a step whose real shell genuinely runs the checksum
  // command. This is the opposite direction from the $( fix above: that
  // one closed a false ACCEPT, this one is a new false REJECT the same
  // one-character class change introduced. Not a claim this cannot be
  // stated honestly - it must be, which is the entire point of this test.
  const quotedParenBeforeHash = 'echo "a(#b"; sha256sum --check config/actionlint-artifact.sha256';

  assert.equal(
    stripShellLineComments(quotedParenBeforeHash),
    'echo "a(',
    "known widened residual: locks in the exact new truncation the '(' addition introduced"
  );
  assert.equal(
    stepPerformsChecksumVerification(quotedParenBeforeHash),
    false,
    "known widened residual: a real, later sha256sum --check is now invisible here specifically " +
      "because '(' joined the separator class - it was visible before"
  );
  const { installIndex } = locateRunStepIndices([{ name: "install", run: quotedParenBeforeHash }]);
  assert.equal(
    installIndex,
    -1,
    "this step is now (wrongly) rejected - a real shell genuinely runs its sha256sum --check, since " +
      "the '#' sits inside real double-quoting and never opens a comment there at all"
  );
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
