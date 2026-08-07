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
