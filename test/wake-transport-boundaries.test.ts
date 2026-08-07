import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  WAKE_PUBLIC_FILE,
  checkWakeTransportBoundaries,
  findWakeBoundaryImports,
  isPermittedWakeTestFile,
} from "../scripts/check-wake-transport-boundaries.mjs";

// --- the real tree, as it exists right now (zero transports built yet), must be clean ---

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

/** Builds a scratch `src/wake/` with a non-public transport file, returning its absolute dir. */
function buildFixtureWakeDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "ghantika-wake-boundary-"));
  const wakeDir = path.join(dir, "wake");
  mkdirSync(wakeDir, { recursive: true });
  writeFileSync(path.join(wakeDir, WAKE_PUBLIC_FILE), "export type Capability = { available: boolean };\n");
  writeFileSync(
    path.join(wakeDir, "secretTransport.ts"),
    "export const SOCKET_PATH = '/tmp/whatever.sock';\n"
  );
  return { dir, wakeDir };
}

test("findWakeBoundaryImports flags a direct import of a non-public wake file (negative control: the check fires on a planted violation)", () => {
  const { dir, wakeDir } = buildFixtureWakeDir();
  try {
    const callerAbs = path.join(dir, "server.ts");
    const hits = findWakeBoundaryImports(
      "import { SOCKET_PATH } from './wake/secretTransport.js';\n",
      callerAbs,
      wakeDir
    );
    assert.deepEqual(hits, ["./wake/secretTransport.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findWakeBoundaryImports does not flag an import of the public wakeTransport.ts file", () => {
  const { dir, wakeDir } = buildFixtureWakeDir();
  try {
    const callerAbs = path.join(dir, "server.ts");
    const hits = findWakeBoundaryImports(
      `import type { Capability } from './wake/${WAKE_PUBLIC_FILE.replace(/\.ts$/, ".js")}';\n`,
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
    const hits = findWakeBoundaryImports("import { x } from './jobStore.js';\n", callerAbs, wakeDir);
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
