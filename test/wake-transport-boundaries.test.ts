import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  WAKE_PUBLIC_FILES,
  checkWakeTransportBoundaries,
  findWakeBoundaryImports,
  isPermittedWakeTestFile,
} from "../scripts/check-wake-transport-boundaries.mjs";

// --- the real tree, as it exists right now (two transports plus the
// selector, with neither concrete transport imported from outside
// src/wake/ yet), must be clean ---

test("the real src/ and test/ trees have zero wake-transport-boundary violations", () => {
  assert.deepEqual(checkWakeTransportBoundaries(), []);
});

// --- isPermittedWakeTestFile ---

test("isPermittedWakeTestFile accepts a wake-*.test.ts file directly under test/", () => {
  assert.equal(isPermittedWakeTestFile("test/wake-transport.test.ts"), true);
  assert.equal(isPermittedWakeTestFile("test/wake-integration.test.ts"), true);
});

test("isPermittedWakeTestFile rejects a non-wake test, a nested wake test, and a non-test wake file", () => {
  assert.equal(isPermittedWakeTestFile("test/tasks.test.ts"), false);
  assert.equal(isPermittedWakeTestFile("test/helpers/wake-fixture.test.ts"), false);
  assert.equal(isPermittedWakeTestFile("test/wake-notes.ts"), false);
});

test("isPermittedWakeTestFile accepts a wake-*.ts fixture directly under test/fixtures/ - the live case is test/fixtures/wake-app-server-crash-harness.ts, which reaches appServerTransport.ts via dist/ to run it as a real subprocess", () => {
  assert.equal(isPermittedWakeTestFile("test/fixtures/wake-app-server-crash-harness.ts"), true);
  assert.equal(isPermittedWakeTestFile("test/fixtures/wake-desktop-ipc-crash-harness.ts"), true);
});

test("isPermittedWakeTestFile rejects a test/fixtures/ file that does not match the wake- convention, and a wake-*.ts file nested deeper than test/fixtures/ itself (the exemption is narrow, not a blanket allowance for test/fixtures/)", () => {
  // real siblings of the live fixture, neither of which reaches into src/wake/
  assert.equal(isPermittedWakeTestFile("test/fixtures/mock-app-server.ts"), false);
  assert.equal(isPermittedWakeTestFile("test/fixtures/negative-control-server.ts"), false);
  // a wake-*.ts file one directory deeper than test/fixtures/ itself
  assert.equal(isPermittedWakeTestFile("test/fixtures/nested/wake-thing.ts"), false);
});

// --- findWakeBoundaryImports: negative control (fixture-based, proves the check actually fires) ---

/**
 * Builds a scratch `src/wake/` carrying every admitted public file (see
 * `WAKE_PUBLIC_FILES`) plus both real concrete transport filenames -
 * `appServerTransport.ts` and `desktopIpcTransport.ts` - as stand-ins for
 * the genuinely non-public files, so a test proving the admitted set is
 * narrow proves it against the exact filenames that matter, not a made-up
 * hypothetical one.
 */
function buildFixtureWakeDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-wake-boundary-"));
  const wakeDir = path.join(dir, "wake");
  mkdirSync(wakeDir, { recursive: true });
  for (const publicFile of WAKE_PUBLIC_FILES) {
    writeFileSync(
      path.join(wakeDir, publicFile),
      "export type Capability = { available: boolean };\n"
    );
  }
  writeFileSync(
    path.join(wakeDir, "appServerTransport.ts"),
    "export const DEFAULT_COMMAND = 'codex';\n"
  );
  writeFileSync(
    path.join(wakeDir, "desktopIpcTransport.ts"),
    "export const DEFAULT_SOCKET_PATH = '/tmp/whatever.sock';\n"
  );
  return { dir, wakeDir };
}

test("findWakeBoundaryImports flags a direct import of a non-public wake file (negative control: the check fires on a planted violation)", () => {
  const { dir, wakeDir } = buildFixtureWakeDir();
  try {
    const callerAbs = path.join(dir, "server.ts");
    const hits = findWakeBoundaryImports(
      "import { DEFAULT_COMMAND } from './wake/appServerTransport.js';\n",
      callerAbs,
      wakeDir
    );
    assert.deepEqual(hits, ["./wake/appServerTransport.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findWakeBoundaryImports STILL flags a direct import of appServerTransport.ts or desktopIpcTransport.ts from outside src/wake/ (negative control: the admitted set is a real, narrow list of exactly two files, not "everything under src/wake/")', () => {
  const { dir, wakeDir } = buildFixtureWakeDir();
  try {
    const callerAbs = path.join(dir, "server.ts");
    const appServerHits = findWakeBoundaryImports(
      "import { DEFAULT_COMMAND } from './wake/appServerTransport.js';\n",
      callerAbs,
      wakeDir
    );
    const desktopIpcHits = findWakeBoundaryImports(
      "import { DEFAULT_SOCKET_PATH } from './wake/desktopIpcTransport.js';\n",
      callerAbs,
      wakeDir
    );
    assert.deepEqual(appServerHits, ["./wake/appServerTransport.js"]);
    assert.deepEqual(desktopIpcHits, ["./wake/desktopIpcTransport.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findWakeBoundaryImports does not flag an import of the wakeTransport.ts public file", () => {
  const { dir, wakeDir } = buildFixtureWakeDir();
  try {
    const callerAbs = path.join(dir, "server.ts");
    const hits = findWakeBoundaryImports(
      "import type { Capability } from './wake/wakeTransport.js';\n",
      callerAbs,
      wakeDir
    );
    assert.deepEqual(hits, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findWakeBoundaryImports does not flag an import of the selectTransport.ts public file - the point of this story's change", () => {
  const { dir, wakeDir } = buildFixtureWakeDir();
  try {
    const callerAbs = path.join(dir, "server.ts");
    const hits = findWakeBoundaryImports(
      "import { selectAndWake } from './wake/selectTransport.js';\n",
      callerAbs,
      wakeDir
    );
    assert.deepEqual(hits, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findWakeBoundaryImports does not flag an import of a file outside src/wake/ entirely (green control)", () => {
  const { dir, wakeDir } = buildFixtureWakeDir();
  try {
    writeFileSync(path.join(dir, "jobStore.ts"), "export const x = 1;\n");
    const callerAbs = path.join(dir, "server.ts");
    const hits = findWakeBoundaryImports(
      "import { x } from './jobStore.js';\n",
      callerAbs,
      wakeDir
    );
    assert.deepEqual(hits, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkWakeTransportBoundaries reports a missing src/wake/ directory as a violation rather than passing vacuously", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-wake-boundary-empty-"));
  const testDir = path.join(dir, "test");
  mkdirSync(testDir, { recursive: true });
  try {
    const violations = checkWakeTransportBoundaries(dir, testDir);
    assert.equal(
      violations.some((v) => v.includes("does not exist")),
      true,
      `expected a "does not exist" violation, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- checkWakeTransportBoundaries end-to-end: the new test/fixtures/
// wake-*.ts exemption, exercised through the real scanning pipeline rather
// than isPermittedWakeTestFile's return value alone. ---
//
// Deliberately uses a plain src/-relative specifier here, not a literal
// dist/ one: this guard's own disclosed scope boundary (see the guard's
// header comment) never resolves a dist/-targeting specifier back into
// src/wake/ at all, for ANY file, permitted or not - so a dist/-style
// import can never produce a violation through this pipeline regardless of
// this exemption, and could not tell a red case from a green one. A
// src/-relative specifier IS inside findWakeBoundaryImports's resolution
// scope, so it is what actually exercises the exemption's real effect. The
// genuine, literal dist/-reaching case is already covered above: the real
// tree - including the live test/fixtures/wake-app-server-crash-harness.ts
// fixture - is asserted clean by this file's very first test.

/**
 * A scratch `<dir>/src/wake/` carrying both admitted public files (see
 * `WAKE_PUBLIC_FILES` - required so the inline existence check doesn't add
 * its own "a permitted door is missing" violations to the count) plus one
 * non-public file, and an empty `<dir>/test/fixtures/`, laid out so a
 * `../../src/wake/nonPublicFile.js` specifier written from a file placed
 * directly in `<dir>/test/fixtures/` resolves for real.
 */
function buildFixtureTreeWithFixturesDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-wake-boundary-fixtures-"));
  const srcDir = path.join(dir, "src");
  const testDir = path.join(dir, "test");
  const wakeDir = path.join(srcDir, "wake");
  const fixturesDir = path.join(testDir, "fixtures");
  mkdirSync(wakeDir, { recursive: true });
  mkdirSync(fixturesDir, { recursive: true });
  for (const publicFile of WAKE_PUBLIC_FILES) {
    writeFileSync(
      path.join(wakeDir, publicFile),
      "export type Capability = { available: boolean };\n"
    );
  }
  writeFileSync(path.join(wakeDir, "nonPublicFile.ts"), "export const SECRET = 1;\n");
  return { dir, srcDir, testDir, fixturesDir };
}

test("checkWakeTransportBoundaries permits a test/fixtures/wake-*.ts fixture that reaches a non-public wake file directly (green: the new exemption's real effect on the actual scan)", () => {
  const { dir, srcDir, testDir, fixturesDir } = buildFixtureTreeWithFixturesDir();
  try {
    writeFileSync(
      path.join(fixturesDir, "wake-scratch-harness.ts"),
      'import "../../src/wake/nonPublicFile.js";\n'
    );
    assert.deepEqual(checkWakeTransportBoundaries(srcDir, testDir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkWakeTransportBoundaries still flags a test/fixtures/ file that does NOT match the wake- convention reaching the same non-public wake file (red: the exemption stays narrow, proven against the real scan rather than the predicate alone)", () => {
  const { dir, srcDir, testDir, fixturesDir } = buildFixtureTreeWithFixturesDir();
  try {
    writeFileSync(
      path.join(fixturesDir, "scratch-harness.ts"),
      'import "../../src/wake/nonPublicFile.js";\n'
    );
    const violations = checkWakeTransportBoundaries(srcDir, testDir);
    assert.equal(
      violations.length,
      1,
      `expected exactly one violation, got: ${JSON.stringify(violations)}`
    );
    assert.match(
      violations[0],
      /^test\/fixtures\/scratch-harness\.ts: imports "\.\.\/\.\.\/src\/wake\/nonPublicFile\.js"/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
