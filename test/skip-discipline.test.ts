import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTestIdentity,
  checkSkipDiscipline,
  classifyTestCompletionForSkipDiscipline,
  isSkippedValue,
  isTodoValue,
  loadCriticalTests,
  loadSkipBaseline,
} from "../scripts/run-tests.mjs";
import { pgrepGroupMembers } from "./harness.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "run-tests.mjs");
const HARNESS_PATH = path.join(REPO_ROOT, "scripts", "run-tests-fixture-harness.mjs");
const REAL_SKIP_BASELINE_PATH = path.join(REPO_ROOT, "test", "skip-baseline.json");
const REAL_CRITICAL_TESTS_PATH = path.join(REPO_ROOT, "test", "critical-tests.json");

// ---------------------------------------------------------------------------
// isSkippedValue: the single classification the whole guard shares. A
// bare `true` and a non-empty reason string both count as skipped; an
// absent field, `false`, and an empty string all mean the test ran.
// ---------------------------------------------------------------------------

test("isSkippedValue treats a bare boolean true and a non-empty reason string as equally skipped", () => {
  assert.equal(isSkippedValue(true), true);
  assert.equal(isSkippedValue("posix-only, no win32 equivalent"), true);
});

test("isSkippedValue treats false, an empty string, and an absent field as not skipped", () => {
  assert.equal(isSkippedValue(false), false);
  assert.equal(isSkippedValue(""), false);
  assert.equal(isSkippedValue(undefined), false);
});

// ---------------------------------------------------------------------------
// isTodoValue: the same two-shape classification as isSkippedValue, applied
// to node:test's `todo` field instead of `skip`.
// ---------------------------------------------------------------------------

test("isTodoValue treats a bare boolean true and a non-empty reason string as equally TODO", () => {
  assert.equal(isTodoValue(true), true);
  assert.equal(isTodoValue("not implemented yet"), true);
});

test("isTodoValue treats false, an empty string, and an absent field as not TODO", () => {
  assert.equal(isTodoValue(false), false);
  assert.equal(isTodoValue(""), false);
  assert.equal(isTodoValue(undefined), false);
});

// ---------------------------------------------------------------------------
// buildTestIdentity: separator normalization matching the sibling guard
// scripts' own idiom, proven with an injected win32-style path
// implementation so the win32 behavior is checkable from any host OS.
// ---------------------------------------------------------------------------

test("identity normalization matches the sibling guard scripts' idiom, and normalizes a win32-style separator to forward slashes", () => {
  const posixIdentity = buildTestIdentity(
    path.join(REPO_ROOT, "test", "process.test.ts"),
    "a real test name"
  );
  assert.equal(posixIdentity, "test/process.test.ts::a real test name");

  // node:path's own `path.win32` computes Windows-semantics path math
  // regardless of the host OS running this test, so the win32 separator
  // branch is provable here without a Windows machine.
  const win32Identity = buildTestIdentity("C:\\repo\\test\\process.test.ts", "a real test name", {
    baseDir: "C:\\repo",
    pathImpl: path.win32,
  });
  assert.equal(
    win32Identity,
    "test/process.test.ts::a real test name",
    "a hand-written forward-slash baseline entry must match even conceptually on win32"
  );
});

// ---------------------------------------------------------------------------
// checkSkipDiscipline: the pure core, exercised directly against
// constructed results/baseline/criticalTests - no process spawn needed
// for any of this.
// ---------------------------------------------------------------------------

test("an unsanctioned skip yields exactly one error naming the offending test", () => {
  const errors = checkSkipDiscipline({
    results: [{ identity: "test/foo.test.ts::an odd one out", skip: true }],
    baseline: { darwin: [] },
    criticalTests: [],
    platform: "darwin",
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("test/foo.test.ts::an odd one out"));
});

test("clean state - skips within the sanctioned set, all criticals present and passed - yields no error", () => {
  const errors = checkSkipDiscipline({
    results: [
      { identity: "test/process.test.ts::posix only", skip: "posix-only, no win32 equivalent" },
      { identity: "test/module-boundaries.test.ts::the guard itself", skip: undefined },
    ],
    baseline: { win32: ["test/process.test.ts::posix only"] },
    criticalTests: ["test/module-boundaries.test.ts::the guard itself"],
    platform: "win32",
  });
  assert.deepEqual(errors, []);
});

test("the tracked baseline file, not a live re-count of the run, drives the verdict", () => {
  const results = [{ identity: "test/foo.test.ts::a skip", skip: true }];

  const withoutSanction = checkSkipDiscipline({
    results,
    baseline: { linux: [] },
    criticalTests: [],
    platform: "linux",
  });
  assert.equal(withoutSanction.length, 1);

  // The exact same results, unchanged - only the baseline argument
  // differs. If the verdict were re-derived from `results` alone, this
  // could never turn clean without touching `results`.
  const withSanction = checkSkipDiscipline({
    results,
    baseline: { linux: ["test/foo.test.ts::a skip"] },
    criticalTests: [],
    platform: "linux",
  });
  assert.deepEqual(withSanction, []);
});

test("a declared-critical test reported skipped reds, and the error names that critical test", () => {
  const errors = checkSkipDiscipline({
    results: [{ identity: "test/module-boundaries.test.ts::the guard itself", skip: true }],
    // Sanctioned, so this is isolated to the critical-must-run check -
    // otherwise the unsanctioned-skip check would ALSO fire on the same
    // identity and the assertion below couldn't tell which check named it.
    baseline: { darwin: ["test/module-boundaries.test.ts::the guard itself"] },
    criticalTests: ["test/module-boundaries.test.ts::the guard itself"],
    platform: "darwin",
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("test/module-boundaries.test.ts::the guard itself"));
  assert.ok(errors[0].includes("skipped"));
});

test("a declared-critical test absent from results reds as did-not-run, naming it", () => {
  const errors = checkSkipDiscipline({
    results: [],
    baseline: { darwin: [] },
    criticalTests: ["test/module-boundaries.test.ts::the guard itself"],
    platform: "darwin",
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("test/module-boundaries.test.ts::the guard itself"));
  assert.ok(errors[0].includes("did not run"));
});

test("every declared-critical test present and passed or failed yields no critical error", () => {
  const errors = checkSkipDiscipline({
    results: [
      { identity: "test/a.test.ts::one", skip: undefined },
      { identity: "test/b.test.ts::two", skip: false },
    ],
    baseline: { darwin: [] },
    criticalTests: ["test/a.test.ts::one", "test/b.test.ts::two"],
    platform: "darwin",
  });
  assert.deepEqual(errors, []);
});

test("restore-to-clean returns green after a red state - mutation proof, both directions", () => {
  const criticalTests = ["test/module-boundaries.test.ts::the guard itself"];
  // Sanctioned, so the red state below is isolated to the critical-must-
  // run check - an unsanctioned skip on this same identity would ALSO
  // fire the unsanctioned-skip check and inflate the count this test
  // asserts on.
  const baseline = { darwin: [criticalTests[0]] };

  const clean = checkSkipDiscipline({
    results: [{ identity: criticalTests[0], skip: undefined }],
    baseline,
    criticalTests,
    platform: "darwin",
  });
  assert.deepEqual(clean, []);

  const red = checkSkipDiscipline({
    results: [{ identity: criticalTests[0], skip: true }],
    baseline,
    criticalTests,
    platform: "darwin",
  });
  assert.equal(red.length, 1);

  const restored = checkSkipDiscipline({
    results: [{ identity: criticalTests[0], skip: undefined }],
    baseline,
    criticalTests,
    platform: "darwin",
  });
  assert.deepEqual(restored, []);
});

test("a legitimate skip on the injected platform stays green, and reds under a per-platform-collapse-style regression", () => {
  const baseline = { win32: ["test/process.test.ts::posix only"], linux: [] };

  const onWin32 = checkSkipDiscipline({
    results: [{ identity: "test/process.test.ts::posix only", skip: true }],
    baseline,
    criticalTests: [],
    platform: "win32",
  });
  assert.deepEqual(onWin32, []);

  // A model that collapsed every platform's sanctioned skips into one
  // shared set would let this same skip pass on linux too, since it is
  // legitimate SOMEWHERE. The real per-platform model must not: linux's
  // own array is empty, so this reds.
  const onLinux = checkSkipDiscipline({
    results: [{ identity: "test/process.test.ts::posix only", skip: true }],
    baseline,
    criticalTests: [],
    platform: "linux",
  });
  assert.equal(onLinux.length, 1);
  assert.ok(onLinux[0].includes("test/process.test.ts::posix only"));
});

test("an illegitimate skip alongside legitimate ones still reds, named - no blanket amnesty", () => {
  const errors = checkSkipDiscipline({
    results: [
      { identity: "test/a.test.ts::legit one", skip: true },
      { identity: "test/b.test.ts::the odd one", skip: true },
      { identity: "test/c.test.ts::legit two", skip: "posix-only" },
    ],
    baseline: { darwin: ["test/a.test.ts::legit one", "test/c.test.ts::legit two"] },
    criticalTests: [],
    platform: "darwin",
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("test/b.test.ts::the odd one"));
});

test("the skip-drift diagnostic names the offending test and the baseline it was checked against", () => {
  const errors = checkSkipDiscipline({
    results: [{ identity: "test/b.test.ts::the odd one", skip: true }],
    baseline: { darwin: [] },
    criticalTests: [],
    platform: "darwin",
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("test/b.test.ts::the odd one"));
  assert.ok(errors[0].includes("test/skip-baseline.json"));
  assert.ok(errors[0].includes("darwin"));
});

test("the skip-drift diagnostic names only the unexpected delta and excludes legitimate skips", () => {
  const errors = checkSkipDiscipline({
    results: [
      { identity: "test/a.test.ts::legit one", skip: true },
      { identity: "test/b.test.ts::the odd one", skip: true },
      { identity: "test/c.test.ts::legit two", skip: "posix-only" },
    ],
    baseline: { darwin: ["test/a.test.ts::legit one", "test/c.test.ts::legit two"] },
    criticalTests: [],
    platform: "darwin",
  });
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes("legit one"));
  assert.ok(!errors[0].includes("legit two"));
});

test("critical presence is matched by exact identity - a renamed critical with a substring-colliding survivor still reds", () => {
  const errors = checkSkipDiscipline({
    results: [{ identity: "fileA::guardCore_smoke", skip: undefined }],
    baseline: { darwin: [] },
    criticalTests: ["fileA::guardCore"],
    platform: "darwin",
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("fileA::guardCore"));
  assert.ok(
    !errors[0].includes("guardCore_smoke"),
    "the survivor's name should never satisfy the exact-identity check for the renamed critical"
  );
});

test("both skip forms - bare true and a non-empty reason string - red a critical test identically", () => {
  const criticalTests = ["test/module-boundaries.test.ts::the guard itself"];
  // Sanctioned for the same reason as the mutation-proof test above -
  // isolates this to the critical-must-run check alone.
  const baseline = { darwin: [criticalTests[0]] };

  const skippedBare = checkSkipDiscipline({
    results: [{ identity: criticalTests[0], skip: true }],
    baseline,
    criticalTests,
    platform: "darwin",
  });
  const skippedWithReason = checkSkipDiscipline({
    results: [{ identity: criticalTests[0], skip: "flaky on this runner" }],
    baseline,
    criticalTests,
    platform: "darwin",
  });

  assert.equal(skippedBare.length, 1);
  assert.equal(skippedWithReason.length, 1);
  assert.ok(skippedBare[0].includes("skipped"));
  assert.ok(skippedWithReason[0].includes("skipped"));
});

test("both skip forms also trigger the unsanctioned-skip check identically, not only the critical-must-run check", () => {
  const unsanctionedId = "test/foo.test.ts::an odd one out";

  const bareTrue = checkSkipDiscipline({
    results: [{ identity: unsanctionedId, skip: true }],
    baseline: { darwin: [] },
    criticalTests: [],
    platform: "darwin",
  });
  const withReason = checkSkipDiscipline({
    results: [{ identity: unsanctionedId, skip: "flaky on this runner" }],
    baseline: { darwin: [] },
    criticalTests: [],
    platform: "darwin",
  });

  assert.equal(bareTrue.length, 1);
  assert.equal(withReason.length, 1);
  assert.ok(bareTrue[0].includes(unsanctionedId));
  assert.ok(withReason[0].includes(unsanctionedId));
});

// ---------------------------------------------------------------------------
// classifyTestCompletionForSkipDiscipline: the synthetic-file-wrapper
// filter. A real test can legitimately be named identically to its own
// absolute file path, and must not be mistaken for node:test's own
// synthetic "this whole file, as a test" completion. The two hand-built
// payload shapes below are exactly what a throwaway fixture produced
// empirically during development: the real test carries the ordinary
// Object.prototype; the synthetic wrapper carries a null prototype and
// always sits at line 1, column 1.
// ---------------------------------------------------------------------------

test("a real test named identically to its own file, with a skip on it, still reds as an unsanctioned skip - the synthetic-wrapper filter must not drop it", () => {
  const file = path.join(REPO_ROOT, "test", "example.test.ts");
  const realTestNamedLikeFile = {
    name: file,
    file,
    skip: true,
    details: { type: "test" },
    line: 10,
    column: 1,
  };

  const classified = classifyTestCompletionForSkipDiscipline(realTestNamedLikeFile);
  assert.ok(classified, "a real test named like its own file must classify as a real result");
  assert.equal(classified.identity, buildTestIdentity(file, file));
  assert.equal(classified.skip, true);

  const errors = checkSkipDiscipline({
    results: [classified],
    baseline: { [process.platform]: [] },
    criticalTests: [],
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("unsanctioned skip"));
  assert.ok(errors[0].includes(classified.identity));
});

test("node:test's own synthetic file-level completion is excluded, even though its name equals the file just like the real test above", () => {
  const file = path.join(REPO_ROOT, "test", "example.test.ts");
  // The synthetic wrapper's payload is built with a null prototype
  // (confirmed empirically: Object.getPrototypeOf(data) === null),
  // unlike any real per-test completion, which always carries the
  // ordinary Object.prototype regardless of name, line, skip, or todo.
  const syntheticWrapper = Object.assign(Object.create(null), {
    name: file,
    file,
    details: Object.assign(Object.create(null), { type: "test" }),
    line: 1,
    column: 1,
  });

  assert.equal(
    classifyTestCompletionForSkipDiscipline(syntheticWrapper),
    null,
    "the synthetic file-level wrapper must be excluded, never treated as a test result"
  );
});

test("a real test whose name differs from its file, and which sits at line 1 column 1 itself, is not mistaken for the synthetic wrapper - line/column alone is corroborating, not authoritative", () => {
  const file = path.join(REPO_ROOT, "test", "example.test.ts");
  const realTestAtLineOne = {
    name: "a test on line 1",
    file,
    skip: undefined,
    details: { type: "test" },
    line: 1,
    column: 34,
  };

  const classified = classifyTestCompletionForSkipDiscipline(realTestAtLineOne);
  assert.ok(classified);
  assert.equal(classified.identity, buildTestIdentity(file, "a test on line 1"));
});

// ---------------------------------------------------------------------------
// checkSkipDiscipline: duplicate identities. node:test allows more than
// one test in a file to share the same name (two `test('x', ...)` calls,
// or a colliding subtest name), so a later completion of an identity
// must never silently erase an earlier one's skip.
// ---------------------------------------------------------------------------

test("a [skip: true, skip: false] pair for the same identity still reds as an unsanctioned skip - the earlier skip must not be overwritten by the later completion", () => {
  const identity = "test/dup.test.ts::dup name";
  const errors = checkSkipDiscipline({
    results: [
      { identity, skip: true },
      { identity, skip: false },
    ],
    baseline: { darwin: [] },
    criticalTests: [],
    platform: "darwin",
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes(identity));
  assert.ok(errors[0].includes("unsanctioned skip"));
});

test("the same [skip: true, skip: false] pair, with that identity declared critical, also reds as a critical test reported skipped", () => {
  const identity = "test/dup.test.ts::dup name";
  const errors = checkSkipDiscipline({
    results: [
      { identity, skip: true },
      { identity, skip: false },
    ],
    // Sanctioned so the unsanctioned-skip check does not also fire on
    // this identity - isolates the assertion to the critical-must-run
    // check alone.
    baseline: { darwin: [identity] },
    criticalTests: [identity],
    platform: "darwin",
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes(identity));
  assert.ok(errors[0].includes("skipped"));
});

test("duplicate completions for the same identity, none of them skipped or TODO, do not red - collecting every occurrence must not itself create a false positive", () => {
  const identity = "test/dup.test.ts::dup name";
  const errors = checkSkipDiscipline({
    results: [
      { identity, skip: false },
      { identity, skip: undefined },
    ],
    baseline: { darwin: [] },
    criticalTests: [identity],
    platform: "darwin",
  });
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------
// checkSkipDiscipline: TODO tests. node:test reports a present, passing-
// shaped completion for a `todo: true` test with no function body - it
// never genuinely runs, but only inspecting `skip` would read it as
// clean. Scoped to the critical-must-run check only: a non-critical
// TODO's place in the sanctioned-skip baseline is out of scope.
// ---------------------------------------------------------------------------

test("a critical identity present only as todo: true reds as TODO, not read as clean", () => {
  const identity = "test/todo.test.ts::not implemented";
  const errors = checkSkipDiscipline({
    results: [{ identity, skip: undefined, todo: true }],
    baseline: { darwin: [] },
    criticalTests: [identity],
    platform: "darwin",
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes(identity));
  assert.ok(errors[0].includes("critical test"));
  assert.ok(errors[0].includes("TODO"));
});

test("a critical identity present only as a non-empty todo reason string reds as TODO identically to a bare true", () => {
  const identity = "test/todo.test.ts::not implemented with reason";
  const errors = checkSkipDiscipline({
    results: [{ identity, skip: undefined, todo: "not implemented yet" }],
    baseline: { darwin: [] },
    criticalTests: [identity],
    platform: "darwin",
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes(identity));
  assert.ok(errors[0].includes("TODO"));
});

test("a critical identity that is both skipped and TODO reds with the skipped message, not the TODO message - skipped is the more specific diagnosis", () => {
  const identity = "test/both.test.ts::both skip and todo";
  const errors = checkSkipDiscipline({
    results: [{ identity, skip: true, todo: true }],
    // Sanctioned so the unsanctioned-skip check does not also fire on
    // this identity - isolates the assertion to the critical-must-run
    // check's own skip-vs-TODO priority.
    baseline: { darwin: [identity] },
    criticalTests: [identity],
    platform: "darwin",
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("skipped"));
  assert.ok(!errors[0].includes("TODO"));
});

test("a non-critical test reported TODO does not red anything - a non-critical TODO's place in the sanctioned-skip baseline is explicitly out of scope for this guard", () => {
  const errors = checkSkipDiscipline({
    results: [
      { identity: "test/todo.test.ts::not critical, just todo", skip: undefined, todo: true },
    ],
    baseline: { darwin: [] },
    criticalTests: [],
    platform: "darwin",
  });
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------
// Loaders: plain, unconditional reads of the tracked files - never a
// live re-derivation. Proven by round-tripping known content through a
// scratch file and confirming the loader returns it unchanged.
// ---------------------------------------------------------------------------

test("loadSkipBaseline and loadCriticalTests are unconditional passthroughs of the tracked file's content", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-skip-loaders-"));
  try {
    const baselinePath = path.join(dir, "skip-baseline.json");
    const criticalPath = path.join(dir, "critical-tests.json");
    const baselineContent = { win32: ["test/x.test.ts::one", "test/x.test.ts::two"] };
    const criticalContent = ["test/y.test.ts::three"];
    writeFileSync(baselinePath, JSON.stringify(baselineContent));
    writeFileSync(criticalPath, JSON.stringify(criticalContent));

    assert.deepEqual(loadSkipBaseline(baselinePath), baselineContent);
    assert.deepEqual(loadCriticalTests(criticalPath), criticalContent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real tracked test/skip-baseline.json and test/critical-tests.json parse and load as the runtime path would read them", () => {
  const baseline = loadSkipBaseline(REAL_SKIP_BASELINE_PATH);
  const criticalTests = loadCriticalTests(REAL_CRITICAL_TESTS_PATH);
  assert.ok(Array.isArray(baseline.win32));
  assert.ok(baseline.win32.length > 0);
  assert.ok(Array.isArray(criticalTests));
  assert.ok(criticalTests.length > 0);
});

// ---------------------------------------------------------------------------
// Seed denominator: an independent, purely static re-derivation of every
// win32-conditional skip site in the real test/ tree right now, compared
// against the tracked seed in test/skip-baseline.json. This is a
// VALIDATION-TIME proof that the seed was not hand-typo'd - it is
// entirely separate from the runtime enforcement path above, which never
// re-scans source text and always reads the tracked file.
// ---------------------------------------------------------------------------

/**
 * Finds every top-level `const NAME = process.platform === "win32" ? ... :
 * ...` declaration in a source file, returning the set of names that
 * resolve to a win32-conditional skip reason. Purely a static-text scan,
 * used only to build/verify the baseline seed - never part of the
 * runtime check, which always reads the tracked JSON file instead.
 */
function findWin32SkipConstantNames(sourceText: string): Set<string> {
  const names = new Set<string>();
  const re = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*\n?\s*process\.platform\s*===\s*"win32"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sourceText))) {
    names.add(match[1]);
  }
  return names;
}

/**
 * Returns the name of every `test(...)` in `sourceText` whose options
 * object carries a win32-conditional skip, either inline
 * (`skip: process.platform === "win32" ? ... : ...`) or via a named
 * constant resolved by findWin32SkipConstantNames above.
 */
function findWin32SkipTestNames(sourceText: string): string[] {
  const win32Constants = findWin32SkipConstantNames(sourceText);
  const testCallPattern = /\btest\(\s*\n?\s*"((?:[^"\\]|\\.)*)"/g;
  const testStarts: { name: string; start: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = testCallPattern.exec(sourceText))) {
    testStarts.push({ name: match[1], start: match.index });
  }

  const names: string[] = [];
  for (let i = 0; i < testStarts.length; i++) {
    const start = testStarts[i].start;
    const end = i + 1 < testStarts.length ? testStarts[i + 1].start : sourceText.length;
    const block = sourceText.slice(start, end);
    const directWin32 = /skip:\s*\n?\s*process\.platform\s*===\s*"win32"/.test(block);
    const viaConstant = [...win32Constants].some((name) =>
      new RegExp(`skip:\\s*${name}\\b`).test(block)
    );
    if (directWin32 || viaConstant) {
      names.push(testStarts[i].name);
    }
  }
  return names;
}

test("seed denominator is exact and machine-derived - an independent static audit of the real tree deep-equals the pinned win32 baseline, and the runtime check reads the tracked file rather than re-deriving it", () => {
  const testDir = path.join(REPO_ROOT, "test");
  // This file itself is excluded: its own source text is data for this
  // scan, not a subject of it - it contains the win32-detection regex as
  // a literal pattern string, and fixture source strings containing
  // `skip:` text for the end-to-end tests below, both of which would
  // false-positive against a scan looking for exactly that shape.
  const selfFile = path.basename(fileURLToPath(import.meta.url));
  const derived: string[] = [];
  for (const entry of readdirSync(testDir)) {
    if (!/\.test\.ts$/.test(entry) || entry === selfFile) continue;
    const sourceText = readFileSync(path.join(testDir, entry), "utf8");
    for (const name of findWin32SkipTestNames(sourceText)) {
      derived.push(`test/${entry}::${name}`);
    }
  }
  derived.sort();

  const baseline = loadSkipBaseline(REAL_SKIP_BASELINE_PATH);
  const seeded = [...baseline.win32].sort();

  assert.deepEqual(
    derived,
    seeded,
    "test/skip-baseline.json's win32 entry must exactly match every win32-conditional skip site actually present in test/ right now"
  );

  // Runtime independence: this static scan exists only to VALIDATE the
  // seed at authoring time, and must never become the thing the runtime
  // check itself consults. Prove checkSkipDiscipline is driven purely by
  // the baseline object it is handed, not by re-scanning source text, by
  // deliberately tampering with a copy of the loaded baseline (dropping
  // one real, still-present win32 entry) and confirming the verdict
  // follows the tampered ARGUMENT rather than silently re-deriving the
  // correct answer from disk. A self-matching oracle - one that quietly
  // falls back to (or is secretly backed by) the same static scan used to
  // build it - would stay green here even though the entry no longer
  // shows up in the input baseline; the real implementation must instead
  // report the now-unsanctioned skip.
  const droppedEntry = seeded[0];
  assert.ok(
    derived.includes(droppedEntry),
    "sanity: the entry under test must still be a real win32-conditional skip in the tree"
  );
  const tamperedBaseline = { win32: baseline.win32.filter((id) => id !== droppedEntry) };
  const errorsAgainstTamperedBaseline = checkSkipDiscipline({
    results: [{ identity: droppedEntry, skip: true }],
    baseline: tamperedBaseline,
    criticalTests: [],
    platform: "win32",
  });
  assert.equal(
    errorsAgainstTamperedBaseline.length,
    1,
    "checkSkipDiscipline must follow the baseline argument it was given, never re-derive legitimacy from source text - it is not a self-matching oracle"
  );
  assert.ok(errorsAgainstTamperedBaseline[0].includes(droppedEntry));
});

// ---------------------------------------------------------------------------
// End to end: the real supervisor, as a real child process, against a
// scratch fixture tree - proving the wiring inside scripts/run-tests.mjs
// itself, not only the pure function above.
// ---------------------------------------------------------------------------

interface FixtureResult {
  status: number;
  stdout: string;
  stderr: string;
  /** The harness's own pid, which is also its process-group id (`detached: true` below makes it its own group leader) - exposed so a caller can independently confirm zero real survivors via `pgrepGroupMembers`. */
  pgid: number;
}

/**
 * Spawns `scriptPath` with `args` and `env`, collecting the exit status
 * and both streams uniformly regardless of exit code. Deliberately
 * spawnSync, not execFileSync: execFileSync only returns stdout on a zero
 * exit and silently drops stderr in that case (it is captured only on the
 * thrown-error path for a non-zero exit) - spawnSync captures both
 * streams every time, which several assertions below depend on even when
 * the expected exit is 0. Shared by every helper below that spawns a real
 * child process against this exact same interface.
 *
 * `detached: true` makes the spawned harness process its own process-group
 * leader (pgid == its own pid) instead of inheriting this test file's own
 * group - the same reason this repository's own kill.ts owns a job's group
 * rather than signaling a bare pid. `run()` from node:test spawns each
 * discovered file as its own child process internally; when a test inside
 * one of those per-file children never resolves (a hung `await new
 * Promise(() => {})`), `--test-timeout` marks that individual TEST failed
 * but does not by itself guarantee the underlying OS process exits - its
 * event loop can still be pinned open by the very promise that never
 * settles. spawnSync only waits for the DIRECT child (the harness); a
 * grandchild left running that way survives the harness's own exit and
 * reparents to init. Isolating the group here means a single group-level
 * kill below - explicitly, never left to whatever the harness or node:test
 * would otherwise do - reaches every process the harness's own run started,
 * regardless of which one is still holding its event loop open, and never
 * touches this test file's own process group in the process.
 */
function collectChildResult(
  scriptPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): FixtureResult {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    env,
    detached: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  const pgid = result.pid;
  if (typeof pgid !== "number") {
    throw new Error("collectChildResult: spawnSync returned no pid for a detached child");
  }
  reapFixtureProcessGroup(pgid);
  return {
    status: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    pgid,
  };
}

/**
 * Force-kills every process still alive in the fixture harness's own
 * process group (`pgid` here is exactly the group id `detached: true`
 * above establishes) and blocks synchronously - via a real external
 * `pgrep -g` check, never this file's own bookkeeping - until none
 * remain or a bounded 2s ceiling is reached. SIGKILL is sent
 * unconditionally: spawnSync above has already returned, so the
 * harness's own useful work is already done and there is no reason to
 * wait out a grace period first. Signaling the NEGATIVE pid targets the
 * whole process group, never just its leader - the same real
 * distinction this repository's own kill.ts relies on for the product
 * path this test file never touches. `ESRCH` means the group was
 * already empty by the time the signal was sent, a normal, accepted
 * outcome, not a failure - a group that never left a survivor to begin
 * with is not a bug. A survivor still present after the full 2s throws
 * loudly, naming the exact pids left, rather than letting a leak pass
 * silently the way the fixture that motivated this helper once did.
 *
 * A no-op on win32: `process.kill` with a negative pid and `pgrep -g`
 * are both POSIX-only primitives with no Windows equivalent used here.
 * This is a disclosed test-harness gap, not a claim that the underlying
 * leak this guards against cannot happen on Windows - it means this
 * repository's suite does not yet verify it there, matching this same
 * PR's own production kill.ts, which already discloses no process-group
 * confirmation on Windows today. Every one of `collectChildResult`'s
 * callers keeps working on win32 exactly as it did before this reap
 * existed; only the extra protection is unavailable there.
 */
function reapFixtureProcessGroup(pgid: number): void {
  if (process.platform === "win32") return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ESRCH") throw error;
  }
  const deadlineMs = Date.now() + 2000;
  let survivors = pgrepGroupMembers(pgid);
  while (survivors.length > 0 && Date.now() < deadlineMs) {
    execFileSync("sleep", ["0.05"]);
    survivors = pgrepGroupMembers(pgid);
  }
  if (survivors.length > 0) {
    throw new Error(
      `reapFixtureProcessGroup: pgid ${pgid} still has real survivors 2s after SIGKILL: ${JSON.stringify(survivors)}`
    );
  }
}

/**
 * Spawns scripts/run-tests-fixture-harness.mjs - never scripts/run-tests.mjs
 * itself, which reads no redirect of any kind, by construction, see its own
 * header comment - as a real child process against a throwaway fixture
 * tree, passing the fixture's test directory, skip-baseline path, and
 * critical-tests path as the harness's own explicit positional arguments.
 * This helper is the harness's one legitimate caller in the whole
 * codebase. `buildBaseline` and `buildCriticalTests` receive the fixture
 * directory's absolute path so callers can compute identities with the
 * SAME buildTestIdentity used above, guaranteeing they match what the
 * spawned harness process itself will compute.
 *
 * `testFiles` covers every caller whose fixture source is static text
 * decided up front. `buildTestFiles` exists for the one case that can't
 * be: the same-as-file collision route below needs a test whose NAME is
 * exactly its own fixture file's resolved absolute path, and that path
 * doesn't exist until `dir` has already been created. Exactly one of the
 * two must be supplied.
 */
function runSupervisorAgainstFixture({
  testFiles,
  buildTestFiles,
  buildBaseline,
  buildCriticalTests,
  extraArgs = [],
}: {
  testFiles?: Record<string, string>;
  buildTestFiles?: (dir: string) => Record<string, string>;
  buildBaseline: (dir: string) => Record<string, string[]>;
  buildCriticalTests: (dir: string) => string[];
  /** Timing-flag overrides (e.g. `--test-timeout=500`) appended after the harness's three positional arguments - see run-tests-fixture-harness.mjs's own usage comment. */
  extraArgs?: string[];
}): FixtureResult {
  // Realpath'd for the same reason scripts/lib/is-main.mjs realpaths
  // process.argv[1]: on macOS, /tmp and /var are themselves symlinks
  // (/var -> /private/var), so mkdtempSync's own return value differs
  // from the path node:test reports on its TestsStream events, which
  // resolves symlinks when constructing a spawned test file's `file`
  // property. Without this, the identity buildBaseline/buildCriticalTests
  // compute below (from this raw `dir`) would silently never match the
  // identity the real supervisor computes at runtime (from the resolved
  // `data.file`) - confirmed empirically, not assumed.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ghantika-skip-discipline-e2e-")));
  try {
    const filesToWrite = buildTestFiles ? buildTestFiles(dir) : testFiles;
    if (!filesToWrite) {
      throw new Error(
        "runSupervisorAgainstFixture: must supply either testFiles or buildTestFiles"
      );
    }
    for (const [relPath, content] of Object.entries(filesToWrite)) {
      const abs = path.join(dir, relPath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }

    const baselinePath = path.join(dir, "skip-baseline.json");
    const criticalPath = path.join(dir, "critical-tests.json");
    writeFileSync(baselinePath, JSON.stringify(buildBaseline(dir)));
    writeFileSync(criticalPath, JSON.stringify(buildCriticalTests(dir)));

    const env = { ...process.env };
    delete env.GHANTIKA_JUNIT;
    // node:test sets this on the process running THIS test file (one of
    // its own per-file child processes), to detect a recursive run()
    // call within the same process. Left inherited, the grandchild
    // spawned below sees it, concludes it is itself such a recursive
    // call, and silently skips running the fixture entirely - "clean"
    // for the wrong reason, since nothing actually ran. Confirmed
    // empirically via the "node:test run() is being called recursively"
    // warning this produces if left in place. The harness's own call to
    // runOnce() invokes node:test's run() exactly like production does,
    // so this deletion is exactly as necessary here as it always was.
    delete env.NODE_TEST_CONTEXT;

    return collectChildResult(HARNESS_PATH, [dir, baselinePath, criticalPath, ...extraArgs], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the real supervisor exits non-zero and prints the offending skip for an unsanctioned skip", () => {
  const result = runSupervisorAgainstFixture({
    testFiles: {
      "basic.test.mjs": [
        'import { test } from "node:test";',
        'test("a test that is skipped for no sanctioned reason", { skip: true }, () => {});',
        'test("a plain passing test", () => {});',
        "",
      ].join("\n"),
    },
    buildBaseline: () => ({}),
    buildCriticalTests: () => [],
  });

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("a test that is skipped for no sanctioned reason"));
});

test("the real supervisor exits non-zero naming a disappeared declared-critical test", () => {
  const result = runSupervisorAgainstFixture({
    testFiles: {
      "basic.test.mjs": [
        'import { test } from "node:test";',
        'test("a plain passing test", () => {});',
        "",
      ].join("\n"),
    },
    buildBaseline: () => ({}),
    buildCriticalTests: (dir) => [
      buildTestIdentity(path.join(dir, "basic.test.mjs"), "a critical test that got renamed away"),
    ],
  });

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("a critical test that got renamed away"));
  assert.ok(result.stderr.includes("did not run"));
});

test("the real supervisor exits zero when only legitimate per-platform skips are present", () => {
  const result = runSupervisorAgainstFixture({
    testFiles: {
      "basic.test.mjs": [
        'import { test } from "node:test";',
        'test("a posix-only check", { skip: true }, () => {});',
        'test("a plain passing test", () => {});',
        "",
      ].join("\n"),
    },
    buildBaseline: (dir) => ({
      [process.platform]: [
        buildTestIdentity(path.join(dir, "basic.test.mjs"), "a posix-only check"),
      ],
    }),
    buildCriticalTests: (dir) => [
      buildTestIdentity(path.join(dir, "basic.test.mjs"), "a plain passing test"),
    ],
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
});

// ---------------------------------------------------------------------------
// Negative control for the `--test-timeout` ceiling itself (production
// value: run-tests.mjs's own testTimeoutMs default and ci.yml's explicit
// flag, kept in lockstep). Raising that ceiling to give real workloads
// enough room is only safe if a genuinely hung test still fails fast at
// WHATEVER value is configured - this proves the mechanism itself, at a
// short timeout chosen for this test's own speed, never at the
// production value (which would make this test itself slow and would
// prove nothing a short timeout doesn't already prove just as well).
// ---------------------------------------------------------------------------

/**
 * The hung fixture shared by both the cross-platform timeout test below
 * and its POSIX-only survivor-check companion. A bare
 * `await new Promise(() => {})` with nothing else scheduled lets
 * node:test take a DIFFERENT, faster exit on some Node versions -
 * confirmed empirically, not assumed: Node 22 on CI cancels this shape
 * in a few milliseconds via its own "Promise resolution is still
 * pending but the event loop has already resolved" diagnostic, never
 * reaching the configured `--test-timeout` at all, while a version
 * tested locally instead waits out the real bound. The bounded
 * `setTimeout` below keeps the event loop genuinely busy across that
 * window - the same shape a real hung test in this codebase's own suite
 * has (a spawned process, a pending signal) - so neither Node version
 * can take that early exit and the assertions built on this fixture
 * actually prove the configured bound, not whichever mechanism happens
 * to fire first. Bounded (not setInterval) so nothing about this
 * fixture's OWN timer lingers past its own 2s expiry - comfortably
 * longer than the 500ms both tests below configure, comfortably shorter
 * than run-tests.mjs's own 60s idle watchdog. This bound does not, by
 * itself, guarantee the underlying OS process exits: node:test's own
 * `--test-timeout` marks THIS TEST failed without necessarily
 * terminating the process it runs in, if something else (the
 * never-resolving promise below) still holds the event loop open -
 * `collectChildResult`'s own process-group reap is what actually closes
 * that gap on POSIX, not this timer.
 */
function buildHungTestFixtureFiles(): Record<string, string> {
  return {
    "hang.test.mjs": [
      'import { test } from "node:test";',
      'test("a deliberately hung test that never resolves", async () => {',
      "  setTimeout(() => {}, 2000);",
      "  await new Promise(() => {});",
      "});",
      "",
    ].join("\n"),
  };
}

test("the real supervisor still fails a genuinely hung test fast, at whatever --test-timeout value is configured - proving the mechanism a raised production ceiling depends on", () => {
  const result = runSupervisorAgainstFixture({
    testFiles: buildHungTestFixtureFiles(),
    buildBaseline: () => ({}),
    buildCriticalTests: () => [],
    extraArgs: ["--test-timeout=500"],
  });

  assert.notEqual(
    result.status,
    0,
    `expected the hung test to fail the run, got exit ${result.status}. stdout: ${result.stdout}`
  );
  assert.ok(
    result.stdout.includes("test timed out after 500ms"),
    `expected node:test's own timeout message naming the configured 500ms value, got: ${result.stdout}`
  );

  // The exit code and stdout above only prove the SUPERVISOR reported the
  // timeout - they say nothing about whether the hung test's own real OS
  // process is actually gone. collectChildResult (via
  // reapFixtureProcessGroup) already force-killed and confirmed the whole
  // group empty before returning; this is a second, independent
  // confirmation of exactly the property that once went unchecked - a real
  // orphan surviving this exact fixture, reparented to init, running for
  // over 20 hours before it was found.
  //
  // Deliberately a plain runtime conditional rather than a node:test
  // `{skip}` option: this file's own "seed denominator" test above scans
  // every other test/*.test.ts file for win32-conditional skips and
  // excludes THIS file from that scan (its own source text contains the
  // scanner's regex as a string, plus fixture-building code with literal
  // `skip:`/`process.platform === "win32"` substrings that would
  // false-positive the scanner if it read itself). A `{skip}` here could
  // never be matched by that derived side, so any matching baseline entry
  // would be a permanent, unfixable parity mismatch. A plain conditional
  // sidesteps that architecture entirely - node:test always reports this
  // test as fully passed, nothing is "skipped", so there is nothing for
  // the seed-denominator scan to derive or disagree with - while still
  // unconditionally enforcing the real POSIX postcondition on every
  // platform this suite's CI actually runs today (macOS/Linux; Windows
  // carries no CI presence for this repo, per CHANGELOG history). No
  // Windows-equivalent path exists here yet, matching every other
  // identity/process-group test in this codebase (see
  // test/process.test.ts's own POSIX_PROCESS_GROUP_SKIP for the identical
  // rationale) and this repository's own production kill.ts, which
  // discloses no process-group confirmation on Windows either.
  if (process.platform !== "win32") {
    assert.deepEqual(
      pgrepGroupMembers(result.pgid),
      [],
      `expected zero real survivors in pgid ${result.pgid} after the hung fixture's supervisor exited`
    );
  }
});

// ---------------------------------------------------------------------------
// End to end: the duplicate-identity route and the TODO route, both
// "wiring can silently defeat this" classes - a defect that only shows up
// once the real collect->classify->exit path runs, not at the pure-
// function level alone.
// ---------------------------------------------------------------------------

test("the real supervisor exits non-zero and names the offending test for a duplicate test name where an earlier occurrence was skipped and a later occurrence of the same name was not", () => {
  const result = runSupervisorAgainstFixture({
    testFiles: {
      "dup.test.mjs": [
        'import { test } from "node:test";',
        'test("dup name", { skip: true }, () => {});',
        'test("dup name", () => {});',
        "",
      ].join("\n"),
    },
    buildBaseline: () => ({}),
    buildCriticalTests: () => [],
  });

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("dup name"));
  assert.ok(result.stderr.includes("unsanctioned skip"));
});

test("the real supervisor exits non-zero naming a declared-critical test whose duplicate-named earlier occurrence was skipped, even though a later occurrence of the identical name passed", () => {
  const result = runSupervisorAgainstFixture({
    testFiles: {
      "dup.test.mjs": [
        'import { test } from "node:test";',
        'test("dup name", { skip: true }, () => {});',
        'test("dup name", () => {});',
        "",
      ].join("\n"),
    },
    buildBaseline: (dir) => ({
      [process.platform]: [buildTestIdentity(path.join(dir, "dup.test.mjs"), "dup name")],
    }),
    buildCriticalTests: (dir) => [buildTestIdentity(path.join(dir, "dup.test.mjs"), "dup name")],
  });

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("dup name"));
  assert.ok(result.stderr.includes("skipped"));
});

test("the real supervisor exits non-zero naming a declared-critical test that is present only as TODO and never genuinely ran", () => {
  const result = runSupervisorAgainstFixture({
    testFiles: {
      "todo.test.mjs": [
        'import { test } from "node:test";',
        'test("not implemented yet", { todo: true });',
        'test("a plain passing test", () => {});',
        "",
      ].join("\n"),
    },
    buildBaseline: () => ({}),
    buildCriticalTests: (dir) => [
      buildTestIdentity(path.join(dir, "todo.test.mjs"), "not implemented yet"),
    ],
  });

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("not implemented yet"));
  assert.ok(result.stderr.includes("TODO"));
});

// ---------------------------------------------------------------------------
// End to end: the same-as-file collision route. The pure-core tests above
// ("a real test named identically to its own file..." and "node:test's own
// synthetic file-level completion is excluded...") only ever exercise
// classifyTestCompletionForSkipDiscipline against hand-built payload
// objects - neither drives the real collect->classify->exit path a genuine
// node:test run produces for this exact collision. This proves the wiring
// end to end, the same way the duplicate-identity and TODO routes above
// already do for their own classes.
// ---------------------------------------------------------------------------

test("the real supervisor exits non-zero and names the offending test for a real test whose name is exactly its own fixture file's absolute path, skipped and unsanctioned for the running platform", () => {
  let fixtureAbsPath = "";

  const result = runSupervisorAgainstFixture({
    // A plain testFiles map can't express this fixture: the test's own
    // NAME has to be the fixture file's resolved absolute path, and that
    // path doesn't exist until the temp dir has already been created -
    // hence buildTestFiles, which runs after `dir` is known.
    buildTestFiles: (dir) => {
      const absPath = path.join(dir, "same-as-file.test.mjs");
      fixtureAbsPath = absPath;
      return {
        "same-as-file.test.mjs": [
          'import { test } from "node:test";',
          `test(${JSON.stringify(absPath)}, { skip: true }, () => {});`,
          'test("a plain passing test", () => {});',
          "",
        ].join("\n"),
      };
    },
    buildBaseline: () => ({}),
    buildCriticalTests: () => [],
  });

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("unsanctioned skip"));
  assert.ok(
    result.stderr.includes(fixtureAbsPath),
    "the diagnostic should name the exact same-as-file identity, not merely fail for some other reason"
  );
});

// ---------------------------------------------------------------------------
// Redirection immunity: scripts/run-tests.mjs's production entrypoint must
// have zero effect from any of the four historical override variable
// names (a prior design gated three of them behind a fourth, a fixed
// token string - see scripts/run-tests.mjs's own module doc comment for
// why that boundary was retired rather than kept). The tests below prove
// that directly against a byte-for-byte copy of the real, current
// production script (never a hand-authored reimplementation, which could
// silently drift from what actually ships), placed in its own throwaway
// "repo root". They never point the real, in-place supervisor at THIS
// repo's own test/ directory - doing that would make the spawned process
// discover and attempt to run this very file recursively (node:test's
// default per-file process isolation forks a grandchild for
// skip-discipline.test.ts, which would spawn a great-grandchild the same
// way, without bound).
// ---------------------------------------------------------------------------

/**
 * The exact literal value of the retired fixture-mode token gate this
 * repo's history once used. Hardcoded here rather than imported - it is
 * no longer exported by anything, and the whole point of the test below
 * is proving this value (and the three variable names it used to unlock)
 * have zero effect now, even for a caller who still has the old literal
 * memorized or finds it in git history.
 */
const RETIRED_FIXTURE_TOKEN = "ghantika-run-tests-fixture-mode-v1";

/**
 * Copies the real, current scripts/run-tests.mjs and its
 * scripts/lib/is-main.mjs dependency, byte for byte, into `root`, which
 * becomes an entirely independent "repo root" the copy computes its own
 * REPO_ROOT from (derived from its own import.meta.url once invoked as
 * `root/scripts/run-tests.mjs`). Reading the real file's current bytes
 * rather than re-typing its logic is what keeps this test bound to actual
 * production behavior instead of a parallel copy that could quietly stop
 * matching it.
 */
function copyProductionScriptIntoIsolatedRoot(root: string): void {
  const scriptsDir = path.join(root, "scripts");
  const libDir = path.join(scriptsDir, "lib");
  mkdirSync(libDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, "run-tests.mjs"), readFileSync(SCRIPT_PATH));
  writeFileSync(
    path.join(libDir, "is-main.mjs"),
    readFileSync(path.join(REPO_ROOT, "scripts", "lib", "is-main.mjs"))
  );
}

/**
 * `git init` plus a commit of everything currently in `root`, using a
 * fixed local identity and gpg signing disabled so this never depends on
 * (or is blocked by) any ambient git config - global user.name/user.email
 * may be unset, and global commit signing may be on, in a given
 * environment. This is a throwaway fixture directory removed at the end
 * of the test that spawned it, never a real commit against real history.
 */
function gitInitAndCommitAll(root: string): void {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  run(["init", "--quiet"]);
  run(["add", "-A"]);
  run([
    "-c",
    "user.name=ghantika-test-fixture",
    "-c",
    "user.email=ghantika-test-fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture commit",
  ]);
}

/**
 * A clean child env for the isolated-root helpers below: any retired
 * override variable that might already be set in this process's own
 * environment is deleted first so each test starts from a known-clean
 * slate before deliberately setting its own values, and the same
 * NODE_TEST_CONTEXT/GHANTIKA_JUNIT deletions runSupervisorAgainstFixture
 * above already relies on carry over here too.
 */
function baseIsolatedChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GHANTIKA_JUNIT;
  delete env.GHANTIKA_TEST_DIR;
  delete env.GHANTIKA_SKIP_BASELINE_PATH;
  delete env.GHANTIKA_CRITICAL_TESTS_PATH;
  delete env.GHANTIKA_TEST_FIXTURE_TOKEN;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test("scripts/run-tests.mjs cannot be redirected even when every historical override variable is set to its exact known value, including the retired fixture token - the real production entrypoint still scans its own real test directory and enforces its own real critical-test list, never the decoy's", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ghantika-redirect-immunity-")));
  const decoyDir = realpathSync(
    mkdtempSync(path.join(tmpdir(), "ghantika-redirect-immunity-decoy-"))
  );
  try {
    copyProductionScriptIntoIsolatedRoot(root);

    const testDir = path.join(root, "test");
    mkdirSync(testDir, { recursive: true });
    const criticalTestName = "a critical test that only the real test directory declares";
    const realTestPath = path.join(testDir, "real.test.mjs");
    writeFileSync(
      realTestPath,
      [
        'import { test } from "node:test";',
        `test(${JSON.stringify(criticalTestName)}, () => {});`,
        "",
      ].join("\n")
    );
    writeFileSync(path.join(testDir, "skip-baseline.json"), "{}");
    writeFileSync(
      path.join(testDir, "critical-tests.json"),
      JSON.stringify([buildTestIdentity(realTestPath, criticalTestName, { baseDir: root })])
    );
    gitInitAndCommitAll(root);

    // The decoy tree sits at a completely different location and carries a
    // test designed to fail loudly if it is ever actually executed. If
    // redirection were still possible, this run would either fail on that
    // marker or exit 0 having silently swapped in the decoy's own test -
    // either way a visible break from "the real directory ran instead."
    writeFileSync(
      path.join(decoyDir, "decoy.test.mjs"),
      [
        'import { test } from "node:test";',
        'test("decoy marker - must never execute", () => { throw new Error("DECOY_EXECUTED_MARKER"); });',
        "",
      ].join("\n")
    );
    const decoyBaselinePath = path.join(decoyDir, "skip-baseline.json");
    const decoyCriticalPath = path.join(decoyDir, "critical-tests.json");
    writeFileSync(decoyBaselinePath, "{}");
    // Names a critical test that exists nowhere in real.test.mjs: if
    // GHANTIKA_CRITICAL_TESTS_PATH were somehow still honored, the run
    // would fail loudly on "critical test did not run" instead of merely
    // passing by coincidence - a regression here cannot go quiet.
    writeFileSync(
      decoyCriticalPath,
      JSON.stringify([
        "decoy.test.mjs::a critical test declared only by the decoy critical-tests.json",
      ])
    );

    const env = baseIsolatedChildEnv();
    // All four historical variable names, set to their exact known values -
    // including the literal old token, in case a caller still has it
    // memorized or finds it in git history.
    env.GHANTIKA_TEST_DIR = decoyDir;
    env.GHANTIKA_SKIP_BASELINE_PATH = decoyBaselinePath;
    env.GHANTIKA_CRITICAL_TESTS_PATH = decoyCriticalPath;
    env.GHANTIKA_TEST_FIXTURE_TOKEN = RETIRED_FIXTURE_TOKEN;

    const result = collectChildResult(path.join(root, "scripts", "run-tests.mjs"), [], env);

    assert.equal(
      result.status,
      0,
      `expected exit 0 (the real repo's own test ran cleanly), got ${result.status}. stderr: ${result.stderr}`
    );
    assert.ok(
      result.stderr.includes("real.test.mjs"),
      "the real default test directory's own test must have run"
    );
    assert.ok(
      result.stderr.includes(criticalTestName),
      "the real default critical-tests.json's own declared critical test must be the one that was enforced"
    );
    assert.ok(
      !result.stdout.includes("decoy") &&
        !result.stderr.includes("decoy") &&
        !result.stderr.includes("DECOY_EXECUTED_MARKER"),
      "the decoy fixture tree must never be referenced or executed"
    );
    assert.ok(
      !result.stderr.includes("override active"),
      "no fixture-mode override message can ever print again - that whole notion is retired"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(decoyDir, { recursive: true, force: true });
  }
});

test("tracked-file parity is enforced unconditionally - setting GHANTIKA_TEST_DIR (or any of the other three retired variables, including the old fixture token) does not skip it, and a tracked-but-missing-from-disk file is still caught", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ghantika-redirect-immunity-parity-")));
  const decoyDir = realpathSync(
    mkdtempSync(path.join(tmpdir(), "ghantika-redirect-immunity-parity-decoy-"))
  );
  try {
    copyProductionScriptIntoIsolatedRoot(root);

    const testDir = path.join(root, "test");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      path.join(testDir, "present.test.mjs"),
      [
        'import { test } from "node:test";',
        'test("a present on-disk tracked test", () => {});',
        "",
      ].join("\n")
    );
    // Tracked in git, then deleted from disk after the commit - the exact
    // shape checkTrackedFileParity treats as a hard failure: git still
    // lists it, discovery on disk does not.
    const ghostPath = path.join(testDir, "ghost.test.mjs");
    writeFileSync(
      ghostPath,
      [
        'import { test } from "node:test";',
        'test("a test that will vanish from disk", () => {});',
        "",
      ].join("\n")
    );
    writeFileSync(path.join(testDir, "skip-baseline.json"), "{}");
    writeFileSync(path.join(testDir, "critical-tests.json"), "[]");
    gitInitAndCommitAll(root);
    rmSync(ghostPath);

    writeFileSync(
      path.join(decoyDir, "decoy.test.mjs"),
      [
        'import { test } from "node:test";',
        'test("the decoy fixture must never run", () => {});',
        "",
      ].join("\n")
    );
    const decoyBaselinePath = path.join(decoyDir, "skip-baseline.json");
    const decoyCriticalPath = path.join(decoyDir, "critical-tests.json");
    writeFileSync(decoyBaselinePath, "{}");
    writeFileSync(decoyCriticalPath, "[]");

    const env = baseIsolatedChildEnv();
    env.GHANTIKA_TEST_DIR = decoyDir;
    env.GHANTIKA_SKIP_BASELINE_PATH = decoyBaselinePath;
    env.GHANTIKA_CRITICAL_TESTS_PATH = decoyCriticalPath;
    env.GHANTIKA_TEST_FIXTURE_TOKEN = RETIRED_FIXTURE_TOKEN;

    const result = collectChildResult(path.join(root, "scripts", "run-tests.mjs"), [], env);

    assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stdout: ${result.stdout}`);
    assert.ok(
      result.stderr.includes(
        "git tracks the following test file(s), but they were not found on disk"
      ),
      "the real git-based tracked-file parity check must have run and caught the missing tracked file"
    );
    assert.ok(result.stderr.includes("ghost.test.mjs"));
    assert.ok(
      !result.stderr.includes("override active") && !result.stderr.includes("UNSCANNED"),
      "tracked-file parity must not have been skipped"
    );
    assert.ok(
      !result.stdout.includes("decoy") && !result.stderr.includes("decoy"),
      "the decoy fixture tree must never be referenced"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(decoyDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Structural consumer check: nothing production-facing ever invokes the
// test-only fixture harness, and the production entrypoint's own source
// carries no reference to any of the four historical override variable
// names. This is a proof about the shipped source itself, not merely
// about today's runtime behavior - a future edit that reintroduced
// environment-variable reading in scripts/run-tests.mjs, or wired the
// harness into an npm script or a workflow step, reds this the same way
// it would red a mutation.
// ---------------------------------------------------------------------------

test("nothing production-facing - neither package.json's scripts nor any workflow under .github/workflows/ - ever invokes the test-only fixture harness", () => {
  const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const harnessBasename = path.basename(HARNESS_PATH);

  const scriptEntries = Object.entries(packageJson.scripts ?? {});
  assert.ok(scriptEntries.length > 0, "sanity: package.json must declare at least one script");
  for (const [name, value] of scriptEntries) {
    assert.ok(
      typeof value === "string" && !value.includes(harnessBasename),
      `package.json script "${name}" must never reference the test-only fixture harness`
    );
  }

  const workflowsDir = path.join(REPO_ROOT, ".github", "workflows");
  const workflowFiles = readdirSync(workflowsDir).filter((entry) => /\.ya?ml$/.test(entry));
  assert.ok(workflowFiles.length > 0, "sanity: at least one workflow file must exist to check");
  for (const entry of workflowFiles) {
    const workflowText = readFileSync(path.join(workflowsDir, entry), "utf8");
    assert.ok(
      !workflowText.includes(harnessBasename),
      `workflow file ${entry} must never reference the test-only fixture harness`
    );
  }
});

test("scripts/run-tests.mjs itself contains no reference to any of the four historical fixture override variable names", () => {
  const sourceText = readFileSync(SCRIPT_PATH, "utf8");
  const retiredNames = [
    "GHANTIKA_TEST_DIR",
    "GHANTIKA_SKIP_BASELINE_PATH",
    "GHANTIKA_CRITICAL_TESTS_PATH",
    "GHANTIKA_TEST_FIXTURE_TOKEN",
  ];
  for (const name of retiredNames) {
    assert.ok(
      !sourceText.includes(name),
      `scripts/run-tests.mjs must not reference ${name} anywhere in its own source`
    );
  }
});
