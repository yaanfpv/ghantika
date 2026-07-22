/**
 * test/helpers/windowsChildTree.mjs - a real, tiny Node.js fixture process,
 * used ONLY by the Windows-native process-tree-kill verification in
 * test/kill.test.ts and test/shutdown.test.ts.
 *
 * Why this exists: the POSIX centerpiece tests prove "kill reaps the WHOLE
 * tree" with a one-line shell command (`echo $$ > marker; sleep 60 & sleep
 * 60 & wait`, see test/harness.ts's `buildNoisyLiveJobShellCommand`) - a
 * real process-group LEADER that forks real descendants via `&`. Windows
 * has no `&`/`wait`/`sleep` and no process-group primitive at all, so
 * there is nothing equivalent to shell out to. This file plays the exact
 * same structural role (a real multi-level tree of real, long-lived OS
 * processes for `taskkill /t` to walk) using nothing but Node's own
 * cross-platform `child_process` API - runnable on every platform (so a
 * POSIX run of this file, if anyone ever did that, behaves identically),
 * but exercised for real ONLY by this repo's Windows-only counterpart
 * tests. Not a `*.test.ts` file itself (mirrors
 * test/helpers/spawnServer.ts's own "not auto-discovered by node --test's
 * glob" property).
 *
 * Usage: node windowsChildTree.mjs <selfPidMarkerPath> <childCount> [childPidsDir]
 *
 * Writes its own pid to `selfPidMarkerPath` IMMEDIATELY, in the exact shape
 * test/harness.ts's `parsesAsPgid` already validates (a bare positive
 * integer, newline-terminated) - so a caller can reuse that same predicate
 * and `waitForFile` helper unchanged, on either platform's fixture.
 *
 * When `childCount > 0`, spawns that many further copies of ITSELF, each
 * invoked with `childCount=0` (so every spawned child is a genuine LEAF -
 * no recursion beyond one level, matching the POSIX fixture's fixed
 * "leader + N flat descendants" shape rather than a deep chain), each
 * writing its OWN pid to `<childPidsDir>/child-<i>-pid.txt`. The caller
 * (the test) is responsible for waiting on those files the same way it
 * waits on the leader's own marker - there is no separate "ready" signal
 * here, deliberately: waiting for each REAL marker's REAL content is
 * already the honest barrier, exactly like the POSIX side's own pgid
 * marker.
 *
 * Every level then stays alive on a no-op interval until something
 * external ends it - there is no natural exit, matching the POSIX
 * fixture's own `wait`-on-live-descendants shape (see
 * `buildNoisyLiveJobShellCommand`'s own docs in test/harness.ts).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);

const [, , selfPidMarkerPath, childCountArg, childPidsDir] = process.argv;

if (!selfPidMarkerPath) {
  throw new Error("windowsChildTree: requires <selfPidMarkerPath> as its first argument");
}

const childCount = Number(childCountArg ?? "0");

// Written first, before anything else - the caller polls for this exact
// file/content to know this process (and, transitively, this level of the
// tree) genuinely exists, the same "wait for real content, never for mere
// existence" discipline test/harness.ts's own `waitForFile` docs describe.
fs.writeFileSync(selfPidMarkerPath, `${process.pid}\n`);

if (childCount > 0) {
  if (!childPidsDir) {
    throw new Error("windowsChildTree: childCount > 0 requires a <childPidsDir> argument");
  }
  for (let i = 0; i < childCount; i += 1) {
    const childMarker = path.join(childPidsDir, `child-${i}-pid.txt`);
    // A genuine LEAF: childCount is always "0" here, so this never
    // recurses past one level. `stdio: "ignore"` - this fixture produces
    // no output any test needs to read; a real, normal (non-detached)
    // child, which is exactly what lets Windows' own live parent-pid
    // tracking (what `taskkill /t` walks) see it as part of this tree.
    spawn(process.execPath, [THIS_FILE, childMarker, "0"], { stdio: "ignore" });
  }
}

// Keep this process (and, transitively, the whole tree) genuinely alive
// until an external kill ends it - never a `process.exit`. `unref()`'d on
// nothing: an active interval is exactly what keeps the event loop (and
// so this process) running.
setInterval(() => {}, 1 << 30);
