import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Explicit ".ts" extension - see test/e2e-server.test.ts's identical
// comment on this same helper for why (no relative imports of its own, so
// Node's native TypeScript support can load it directly).
import { tasklistOutputHasPid, windowsTaskExists } from "./harness.ts";

// =============================================================================
// tasklistOutputHasPid - pure parsing, no real `tasklist` invocation
// needed, so every case here runs on every platform (macOS/Linux CI
// included). This is the exact parsing logic `windowsTaskExists` uses to
// decide "does this pid genuinely appear as a real CSV row's PID column" -
// see test/harness.ts's own docs for the false-positive shapes a prior,
// substring-based version of this check let through.
// =============================================================================

test("tasklistOutputHasPid: a genuine matching CSV row is found", () => {
  const output = '"node.exe","4212","Console","1","10,000 K"\r\n';
  assert.equal(tasklistOutputHasPid(output, 4212), true);
});

test("tasklistOutputHasPid: a clean no-match (tasklist's own INFO line, exit 0) reports false", () => {
  const output = "INFO: No tasks are running which match the specified criteria.\r\n";
  assert.equal(tasklistOutputHasPid(output, 4212), false);
});

test("tasklistOutputHasPid: a malformed/garbage line containing the target pid's digits is never mistaken for a real row", () => {
  // No leading `"` at all - not shaped like a real `/fo csv` row, whatever
  // digits it happens to contain.
  const output = "some diagnostic line mentions 4212 but is not a real tasklist row\r\n";
  assert.equal(tasklistOutputHasPid(output, 4212), false);
});

test("tasklistOutputHasPid: an UNRELATED row whose OTHER field contains the target digits as a substring is never mistaken for a match", () => {
  // pid 4212 does NOT appear in the PID column (that's 5678) - it only
  // appears as a substring of the MemUsage field ("42120 K"). A prior,
  // substring-based version of this check matched this exact shape.
  const output = '"proc.exe","5678","Console","1","42120 K"\r\n';
  assert.equal(tasklistOutputHasPid(output, 4212), false);
});

test("tasklistOutputHasPid: a row whose MemUsage field embeds its own comma stays correctly parsed (never mis-split into a false field boundary)", () => {
  const output = '"node.exe","4212","Console","1","10,000 K"\r\n';
  // Sanity: the SAME fixture also correctly finds an unrelated pid absent.
  assert.equal(tasklistOutputHasPid(output, 4212), true);
  assert.equal(tasklistOutputHasPid(output, 10), false);
  assert.equal(tasklistOutputHasPid(output, 1), false);
  assert.equal(tasklistOutputHasPid(output, 0), false);
});

test("tasklistOutputHasPid: finds the right row among several, matching only the exact PID column", () => {
  const output = [
    '"node.exe","111","Console","1","5,000 K"',
    '"node.exe","222","Console","1","6,000 K"',
    '"node.exe","333","Console","1","7,000 K"',
    "",
  ].join("\r\n");
  assert.equal(tasklistOutputHasPid(output, 222), true);
  assert.equal(tasklistOutputHasPid(output, 111), true);
  assert.equal(tasklistOutputHasPid(output, 333), true);
  assert.equal(tasklistOutputHasPid(output, 999), false);
});

test("tasklistOutputHasPid: empty output reports false, never throws", () => {
  assert.equal(tasklistOutputHasPid("", 4212), false);
});

test("(green control) tasklistOutputHasPid: a pid that is a strict PREFIX of the real PID column does not falsely match", () => {
  // Real PID is 42123; querying for 4212 must not match it just because
  // "4212" is a textual prefix of "42123" - the field comparison is exact,
  // never a prefix/substring test.
  const output = '"node.exe","42123","Console","1","10,000 K"\r\n';
  assert.equal(tasklistOutputHasPid(output, 4212), false);
  assert.equal(tasklistOutputHasPid(output, 42123), true);
});

// =============================================================================
// windowsTaskExists - the exec-wrapping layer around tasklistOutputHasPid.
// Its own contract (independent of tasklist.exe's real behavior, which
// only a genuine Windows host can exercise) is to fail CLOSED - propagate a
// real exception - on anything it cannot confidently execute, rather than
// silently reporting "alive" or "gone". That contract is Node's own
// `execFileSync` default behavior (throws on ENOENT and on a nonzero exit
// code), so these tests exist to confirm this file does not accidentally
// swallow either.
// =============================================================================

test("windowsTaskExists: a missing `tasklist` executable throws rather than silently reporting true/false (real ENOENT, no fake binary needed)", () => {
  // An empty PATH genuinely cannot resolve ANY command named `tasklist` -
  // portable across every platform (there is nothing OS-specific about
  // "this directory contains no such file"), so this exercises the real
  // ENOENT path without needing a fake executable at all.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-no-tasklist-"));
  try {
    assert.throws(() => windowsTaskExists(4212, { PATH: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A fake `tasklist` that actually RUNS (to prove the nonzero-exit-code
// path, and a real matching/no-matching exec round-trip) needs a real,
// executable fixture file - written here as a POSIX shell script. This is
// honestly a stand-in for a real Windows tasklist.exe, not a claim of one:
// it exercises windowsTaskExists's own exec-wrapping and error-propagation
// contract (identical Node.js behavior regardless of host OS - `execFileSync`
// throwing on a nonzero exit is not a Windows-specific fact), which
// tasklistOutputHasPid's own pure tests above do not touch at all. Skipped
// on an actual win32 host, where a POSIX shebang script is not executable.
const FAKE_EXECUTABLE_SKIP =
  process.platform === "win32"
    ? "this fixture is a POSIX shell script, not runnable on a real Windows host - see tasklistOutputHasPid's own pure-parsing tests above for platform-independent coverage of the parsing logic itself; this layer exists only to prove windowsTaskExists's exec-wrapping/error-propagation contract, exercised here via a stand-in executable"
    : false;

function writeFakeTasklist(dir: string, body: string): void {
  const file = path.join(dir, "tasklist");
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

test(
  "windowsTaskExists: a nonzero exit code from `tasklist` throws rather than being silently treated as alive or gone",
  { skip: FAKE_EXECUTABLE_SKIP },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-fake-tasklist-nonzero-"));
    try {
      writeFakeTasklist(dir, "exit 7");
      assert.throws(() => windowsTaskExists(4212, { PATH: dir }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  "windowsTaskExists: a real exec round-trip through a genuine matching fake tasklist reports true",
  { skip: FAKE_EXECUTABLE_SKIP },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-fake-tasklist-match-"));
    try {
      writeFakeTasklist(dir, 'printf \'"node.exe","4212","Console","1","10,000 K"\\r\\n\'');
      assert.equal(windowsTaskExists(4212, { PATH: dir }), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  "windowsTaskExists: a real exec round-trip through a genuine no-match fake tasklist reports false",
  { skip: FAKE_EXECUTABLE_SKIP },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-fake-tasklist-nomatch-"));
    try {
      writeFakeTasklist(
        dir,
        "printf 'INFO: No tasks are running which match the specified criteria.\\r\\n'"
      );
      assert.equal(windowsTaskExists(4212, { PATH: dir }), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
