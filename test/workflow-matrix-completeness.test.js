import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXPECTED_NODE,
  EXPECTED_OS,
  TEST_JOB_ID,
  computeMatrixLegs,
  loadWorkflow,
  verifyExpectedAxesNonEmpty,
  verifyMatrixCompleteness,
} from "../scripts/lint-workflow-jobs.mjs";

test("the real test job's matrix covers all 4 OS x Node legs", () => {
  const workflow = loadWorkflow();
  const testJob = workflow.jobs[TEST_JOB_ID];
  assert.ok(testJob, `expected a "${TEST_JOB_ID}" job in the workflow`);
  assert.deepEqual(verifyMatrixCompleteness(testJob), []);

  const legs = computeMatrixLegs(testJob.strategy.matrix);
  assert.equal(
    legs.length,
    EXPECTED_OS.length * EXPECTED_NODE.length,
    "expected exactly 4 legs, no more, no fewer"
  );
});

// Mutation control: drop one operating system from a copy of the real
// matrix and confirm the check names exactly the two legs (one per Node
// version) that go missing with it - then confirm restoring it goes clean
// again. Retargeted at macos-latest (was windows-latest, before Windows
// was temporarily removed from the matrix - see CHANGELOG); when the
// Windows leg is restored, re-aim this back at windows-latest.
test("mutation control: dropping macos-latest from the matrix is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs[TEST_JOB_ID].strategy.matrix.os = mutated.jobs[
    TEST_JOB_ID
  ].strategy.matrix.os.filter((os) => os !== "macos-latest");

  const missing = verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]);
  assert.deepEqual(missing.sort(), ["macos-latest::22", "macos-latest::24"].sort());
});

test("mutation control: dropping node 24 from the matrix is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs[TEST_JOB_ID].strategy.matrix.node = mutated.jobs[
    TEST_JOB_ID
  ].strategy.matrix.node.filter((node) => String(node) !== "24");

  const missing = verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]);
  assert.deepEqual(missing.sort(), ["ubuntu-latest::24", "macos-latest::24"].sort());
});

test("mutation control: an exclude entry silently dropping one leg is caught", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs[TEST_JOB_ID].strategy.matrix.exclude = [{ os: "macos-latest", node: "24" }];

  const missing = verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]);
  assert.deepEqual(missing, ["macos-latest::24"]);
});

// Mutation control: a real GitHub Actions `exclude` entry may omit the
// `node` key entirely - meaning "drop every node version for this os", not
// "drop nothing". Before the fix, computeMatrixLegs always required
// String(entry.node) === String(node), and String(undefined) is the
// literal string "undefined", which never matches a real node value - so
// an os-only exclude was silently ignored and both legs it should have
// dropped stayed in the matrix.
test("mutation control: an os-only exclude entry (no node key) drops every node version for that os", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs[TEST_JOB_ID].strategy.matrix.exclude = [{ os: "macos-latest" }];

  const legs = computeMatrixLegs(mutated.jobs[TEST_JOB_ID].strategy.matrix);
  assert.ok(
    !legs.includes("macos-latest::22") && !legs.includes("macos-latest::24"),
    `expected both macos-latest legs to be excluded, got: ${JSON.stringify(legs)}`
  );

  const missing = verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]);
  assert.deepEqual(missing.sort(), ["macos-latest::22", "macos-latest::24"].sort());
});

// Sibling shape, for coverage rather than a second bug proof: an exclude
// entry may instead omit the `os` key entirely - meaning "drop this node
// version across every os". This direction was NEVER broken, before or
// after the fix - entry.os === undefined already meant "any os" in the
// old code too, so a node-only exclude already worked correctly. This
// test is asserting that the fix didn't regress the direction that was
// already fine, not proving a second bug was killed.
test("mutation control: a node-only exclude entry (no os key) drops that node version across every os", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs[TEST_JOB_ID].strategy.matrix.exclude = [{ node: "24" }];

  const legs = computeMatrixLegs(mutated.jobs[TEST_JOB_ID].strategy.matrix);
  assert.ok(
    !legs.includes("ubuntu-latest::24") && !legs.includes("macos-latest::24"),
    `expected both node-24 legs to be excluded, got: ${JSON.stringify(legs)}`
  );

  const missing = verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]);
  assert.deepEqual(missing.sort(), ["ubuntu-latest::24", "macos-latest::24"].sort());
});

test("restoring the full matrix after a mutation goes clean again", () => {
  const workflow = loadWorkflow();
  const mutated = structuredClone(workflow);
  const originalOs = mutated.jobs[TEST_JOB_ID].strategy.matrix.os;
  mutated.jobs[TEST_JOB_ID].strategy.matrix.os = originalOs.filter((os) => os !== "macos-latest");
  assert.notDeepEqual(verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]), []);

  mutated.jobs[TEST_JOB_ID].strategy.matrix.os = originalOs;
  assert.deepEqual(verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID]), []);
});

// --- Mandatory protection: paired-shrink independent literal oracle ---
//
// verifyMatrixCompleteness above derives "what's expected" from
// EXPECTED_OS/EXPECTED_NODE, imported from the very module it is checking.
// A coordinated edit that shrinks ci.yml's real matrix AND EXPECTED_OS or
// EXPECTED_NODE together (in the same commit) leaves nothing for
// verifyMatrixCompleteness to notice: both sides moved together. The
// closed set below is a genuinely independent, hard-coded expectation
// written directly in this test file rather than imported from anywhere -
// a coordinated edit to the workflow and to lint-workflow-jobs.mjs's own
// constants would ALSO have to touch this file to keep the suite green.
const INDEPENDENT_EXPECTED_LEGS = [
  "ubuntu-latest::22",
  "ubuntu-latest::24",
  "macos-latest::22",
  "macos-latest::24",
];

function independentLegsMissingFrom(actualLegs) {
  const present = new Set(actualLegs);
  return INDEPENDENT_EXPECTED_LEGS.filter((leg) => !present.has(leg));
}

test("independent literal oracle: the real matrix legs exactly match a hard-coded closed set", () => {
  const workflow = loadWorkflow();
  const legs = computeMatrixLegs(workflow.jobs[TEST_JOB_ID].strategy.matrix);
  assert.deepEqual(independentLegsMissingFrom(legs), []);
  assert.equal(legs.length, INDEPENDENT_EXPECTED_LEGS.length);
});

// One row per axis value (ubuntu, macos, node 22, node 24). Each row
// simulates the coordinated edit - the real matrix AND a locally-computed,
// equally-shrunk copy of EXPECTED_OS/EXPECTED_NODE both drop the same
// value - and first proves (as a sanity check) that verifyMatrixCompleteness
// alone is fooled by it, before proving the independent oracle above,
// which never reads EXPECTED_OS/EXPECTED_NODE at all, still catches it.
for (const [axis, droppedValue] of [
  ["os", "ubuntu-latest"],
  ["os", "macos-latest"],
  ["node", "22"],
  ["node", "24"],
]) {
  test(`mutation control (paired shrink): dropping ${droppedValue} from both the real matrix and a simulated EXPECTED_${axis.toUpperCase()} is still caught by the independent oracle`, () => {
    const workflow = loadWorkflow();
    const mutated = structuredClone(workflow);
    const matrix = mutated.jobs[TEST_JOB_ID].strategy.matrix;
    matrix[axis] = matrix[axis].filter((value) => String(value) !== droppedValue);

    const pairedExpectedOs =
      axis === "os" ? EXPECTED_OS.filter((value) => value !== droppedValue) : EXPECTED_OS;
    const pairedExpectedNode =
      axis === "node"
        ? EXPECTED_NODE.filter((value) => String(value) !== droppedValue)
        : EXPECTED_NODE;

    // Sanity check: this is the escape itself. Given an equally-shrunk
    // "expected" set, the derived checker sees nothing missing.
    assert.deepEqual(
      verifyMatrixCompleteness(mutated.jobs[TEST_JOB_ID], pairedExpectedOs, pairedExpectedNode),
      [],
      "sanity check: the derived checker, given a paired-shrink expectation, sees nothing missing - this is the escape this protection exists to close"
    );

    // The independent oracle never derived its expectations from
    // EXPECTED_OS/EXPECTED_NODE, so the coordinated edit above cannot
    // reach it - it still reports the dropped leg(s) as missing.
    const actualLegs = computeMatrixLegs(matrix);
    const missing = independentLegsMissingFrom(actualLegs);
    assert.ok(
      missing.length > 0,
      `expected the independent oracle to catch the dropped ${axis} "${droppedValue}", got no missing legs`
    );
  });
}

// --- Mandatory protection: EXPECTED_OS/EXPECTED_NODE can't be emptied ---
//
// verifyMatrixCompleteness derives "what's expected" by cross-producting
// expectedOs x expectedNode. If either axis is emptied, the cross-product
// is empty, so the completeness loop iterates zero times and reports zero
// missing legs - vacuously "complete" regardless of what the real matrix
// contains. verifyExpectedAxesNonEmpty is the direct guard against that:
// it has no opinion about the real matrix at all, only about whether the
// two module-level constants themselves are non-empty.
test("the real EXPECTED_OS/EXPECTED_NODE constants pass the non-empty guard clean", () => {
  assert.deepEqual(verifyExpectedAxesNonEmpty(), []);
});

test("mutation control: an emptied EXPECTED_OS is named by the non-empty guard", () => {
  const errors = verifyExpectedAxesNonEmpty([], EXPECTED_NODE);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /EXPECTED_OS is empty/);
});

test("mutation control: an emptied EXPECTED_NODE is named by the non-empty guard", () => {
  const errors = verifyExpectedAxesNonEmpty(EXPECTED_OS, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /EXPECTED_NODE is empty/);
});

test("mutation control: both axes emptied at once are both named by the non-empty guard", () => {
  const errors = verifyExpectedAxesNonEmpty([], []);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => /EXPECTED_OS is empty/.test(error)));
  assert.ok(errors.some((error) => /EXPECTED_NODE is empty/.test(error)));
});

// "Non-empty" alone is not the whole escape class: a non-empty ARRAY of
// non-empty STRINGS is the real invariant. Each of the three sibling forms
// below is a distinct way to satisfy a naive non-empty check while still
// producing a degenerate or garbage expectation.

test("mutation control: EXPECTED_OS containing an empty-string element is named by the guard", () => {
  const errors = verifyExpectedAxesNonEmpty(["ubuntu-latest", ""], EXPECTED_NODE);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /EXPECTED_OS contains a non-string or empty-string element at index 1/);
});

test("mutation control: EXPECTED_NODE containing a null element is named by the guard", () => {
  const errors = verifyExpectedAxesNonEmpty(EXPECTED_OS, ["22", null]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /EXPECTED_NODE contains a non-string or empty-string element at index 1/);
});

test("mutation control: EXPECTED_OS being a bare string (not an array) is named by the guard, not silently accepted by a naive .length check", () => {
  // "ubuntu-latest" has .length > 0 and would pass a naive non-empty
  // check, while actually iterating as individual characters if ever
  // spread or mapped over - exactly the escape this case exists to catch.
  const errors = verifyExpectedAxesNonEmpty("ubuntu-latest", EXPECTED_NODE);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /EXPECTED_OS is not an array \(got the string "ubuntu-latest"\)/);
});
