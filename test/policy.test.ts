/**
 * The command-spawn policy gate (src/policy.ts, wired into src/tools/run.ts):
 * OS-specific resolution and interpreter-laundering, a live two-sentinel
 * proof that a denied command never actually spawns, a malformed or
 * missing policy source failing closed, and a properly configured policy
 * staying non-vacuous alongside every denial class above. Every sub-test
 * here scopes its own GHANTIKA_POLICY_FILE value for its own duration
 * (writing a fresh temp policy file, then restoring the prior value in a
 * finally block) rather than depending on the suite's own shared baseline
 * (test/fixtures/policy-allow.json, wired in by scripts/run-tests.mjs) -
 * this file's own policy decisions are exactly what is under test here, so
 * nothing in it leans on that shared default.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import * as runTool from "../dist/tools/run.js";

import { waitForFile } from "./harness.ts";

const POLICY_ENV_VAR = "GHANTIKA_POLICY_FILE";

const POSIX_ONLY_SKIP =
  process.platform === "win32"
    ? "the policy gate's own shell-binary resolution and every sentinel fixture below are POSIX shell scripts - see src/policy.ts's resolveManagedShellBinaryPath docs for the disclosed, unexercised Windows path"
    : false;

/**
 * Runs `fn` with GHANTIKA_POLICY_FILE pointed at a freshly written policy
 * file containing `{ "allow": allow }`, restoring whatever value the
 * variable held before (or leaving it unset if it was unset) once `fn`
 * settles either way. A fresh temp directory per call, never shared across
 * calls within this file, so two calls can never race each other's policy
 * file even though node:test runs this file's own tests sequentially by
 * default.
 */
async function withAllowlistPolicy<T>(allow: readonly string[], fn: () => Promise<T> | T): Promise<T> {
  return withRawPolicyFile(JSON.stringify({ allow }), fn);
}

/** Same as withAllowlistPolicy, but writes `rawContent` verbatim - for exercising a malformed or wrong-shaped policy source. */
async function withRawPolicyFile<T>(rawContent: string, fn: () => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-policy-test-"));
  const policyPath = path.join(dir, "policy.json");
  fs.writeFileSync(policyPath, rawContent);
  const original = process.env[POLICY_ENV_VAR];
  process.env[POLICY_ENV_VAR] = policyPath;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env[POLICY_ENV_VAR];
    else process.env[POLICY_ENV_VAR] = original;
  }
}

/** Runs `fn` with GHANTIKA_POLICY_FILE entirely unset, restoring the prior value afterward. */
async function withNoPolicyConfigured<T>(fn: () => Promise<T> | T): Promise<T> {
  const original = process.env[POLICY_ENV_VAR];
  delete process.env[POLICY_ENV_VAR];
  try {
    return await fn();
  } finally {
    if (original !== undefined) process.env[POLICY_ENV_VAR] = original;
  }
}

/** Writes a real, executable `#!/bin/sh` script at `scriptPath` whose body is `body`. */
function writeExecutableScript(scriptPath: string, body: string): void {
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(scriptPath, 0o755);
}

function structuredOf(result: ReturnType<typeof runTool.handler>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function isTerminalFailed(structured: Record<string, unknown>): boolean {
  return structured.state === "failed";
}

function diagnosticReasonOf(structured: Record<string, unknown>): unknown {
  return (structured.diagnostic as { reason?: unknown } | undefined)?.reason;
}

// ---------------------------------------------------------------------------
// OS-specific resolution converges every spelling of the same real binary
// onto the same allow/deny decision, an allowlisted interpreter/wrapper
// cannot launder a call to a denied target, and shell: true gets the
// identical check a direct invocation would.
// ---------------------------------------------------------------------------

test(
  "OS resolution: PATH lookup, an absolute path, mismatched case, a redundant separator, and a symlink all resolve to the same allowed target; an allowlisted interpreter still refuses to launder a denied command, and shell: true is judged on the resolved shell binary, not the caller's command string",
  { skip: POSIX_ONLY_SKIP },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-policy-resolution-"));
    const allowedBin = path.join(dir, "allowed-leaf");
    writeExecutableScript(allowedBin, "exit 0");
    const deniedBin = path.join(dir, "denied-leaf");
    writeExecutableScript(deniedBin, "exit 0");

    await withAllowlistPolicy([allowedBin], () => {
      // (a) direct absolute-path invocation.
      const absolute = structuredOf(runTool.handler({ command: [allowedBin] }));
      assert.notEqual(
        isTerminalFailed(absolute),
        true,
        `an absolute path to an allowlisted binary must be allowed, got: ${JSON.stringify(absolute)}`
      );

      // (b) PATH lookup - a bare name resolved via a job env pointing PATH
      // at the fixture's own directory.
      const viaPath = structuredOf(
        runTool.handler({
          command: ["allowed-leaf"],
          env: { mode: "merge", vars: { PATH: dir } },
        })
      );
      assert.notEqual(
        isTerminalFailed(viaPath),
        true,
        `the same binary found via PATH must be allowed too, got: ${JSON.stringify(viaPath)}`
      );

      // (c) mismatched case - only meaningful on a platform whose default
      // filesystem folds case (see src/policy.ts's own documented,
      // platform-heuristic scope for isCaseInsensitiveFilesystemPlatform).
      // On a case-sensitive filesystem (ordinary Linux), the same-cased
      // path simply would not resolve to a real file at all, so this
      // branch is skipped there rather than asserted - the documented
      // POSIX case-sensitive skip this test case calls for.
      if (process.platform === "win32" || process.platform === "darwin") {
        const upperCased = path.join(dir.toUpperCase(), "ALLOWED-LEAF");
        // Only proceed if the uppercased path genuinely resolves to the
        // SAME real file on this filesystem (true on a case-insensitive
        // one) - otherwise this assertion would be checking nothing real.
        if (fs.existsSync(upperCased)) {
          const mismatchedCase = structuredOf(runTool.handler({ command: [upperCased] }));
          assert.notEqual(
            isTerminalFailed(mismatchedCase),
            true,
            `a case-folded spelling of the same allowlisted real file must still be allowed on this case-insensitive platform, got: ${JSON.stringify(mismatchedCase)}`
          );
        }
      }

      // (d) a different path-separator form - a redundant separator that
      // still names the identical real file once realpath normalizes it.
      const redundantSeparator = `${dir}//allowed-leaf`;
      const viaRedundantSeparator = structuredOf(runTool.handler({ command: [redundantSeparator] }));
      assert.notEqual(
        isTerminalFailed(viaRedundantSeparator),
        true,
        `a redundant-separator spelling of the same real file must still be allowed, got: ${JSON.stringify(viaRedundantSeparator)}`
      );

      // (e) through a symlink - the policy allows the REAL target's path,
      // not this one, so reaching it via a symlink must resolve to the
      // same decision.
      const symlinkPath = path.join(dir, "allowed-leaf-link");
      fs.symlinkSync(allowedBin, symlinkPath);
      const viaSymlink = structuredOf(runTool.handler({ command: [symlinkPath] }));
      assert.notEqual(
        isTerminalFailed(viaSymlink),
        true,
        `a symlink to an allowlisted real file must be allowed, resolving through the link, got: ${JSON.stringify(viaSymlink)}`
      );

      // A DIFFERENT real binary, never allowlisted, is denied even though
      // it sits in the very same directory - this is the negative control
      // for (a)-(e): the mechanism discriminates on the resolved identity,
      // it does not merely allow "anything in this directory".
      const deniedDirect = structuredOf(runTool.handler({ command: [deniedBin] }));
      assert.equal(isTerminalFailed(deniedDirect), true);
      assert.equal(diagnosticReasonOf(deniedDirect), "policy-denied");
    });

    // --- interpreter/wrapper laundering ---
    // This codebase ships NO default allowlist at all (nothing is allowed
    // until an operator puts it there - see src/policy.ts's own docs), so
    // an interpreter/wrapper capable of running an arbitrary further
    // target (sh, env, ...) is never present on it either: the acceptable
    // shape this story builds is "don't allowlist interpreters/wrappers by
    // default", not "recognize and specially block a wrapper's own
    // arguments" - so laundering is closed here by the wrapper itself
    // never being an allowed target in the first place, under the policy
    // this codebase actually ships. Proven against BOTH illustrative forms
    // the story names: sh -c '<denied command>' and env <denied command>.
    const envBin = "/usr/bin/env";
    await withAllowlistPolicy([deniedBin], () => {
      // deniedBin IS on the allowlist here, by name - proving the refusal
      // below is about the WRAPPER's own identity, not merely that
      // nothing at all is allowed in this scope.
      const viaShLaunder = structuredOf(runTool.handler({ command: `${deniedBin}`, shell: true }));
      assert.equal(
        isTerminalFailed(viaShLaunder),
        true,
        `sh -c invoking deniedBin must still be denied under shell: true, because the resolved SHELL BINARY (/bin/sh) - never deniedBin itself - is what shell: true's own policy check judges, and /bin/sh is not on this allowlist; got: ${JSON.stringify(viaShLaunder)}`
      );
      assert.equal(diagnosticReasonOf(viaShLaunder), "policy-denied");

      if (fs.existsSync(envBin)) {
        const viaEnvLaunder = structuredOf(runTool.handler({ command: [envBin, deniedBin] }));
        assert.equal(
          isTerminalFailed(viaEnvLaunder),
          true,
          `env <deniedBin> must still be denied - the resolved TARGET judged here is "env" itself (argv[0]), which is not on this allowlist, regardless of deniedBin being allowlisted or of what env's own arguments name; got: ${JSON.stringify(viaEnvLaunder)}`
        );
        assert.equal(diagnosticReasonOf(viaEnvLaunder), "policy-denied");
      }
    });

    // shell: true gets the SAME check as a direct invocation: once /bin/sh
    // itself is explicitly allowlisted, a shell: true command actually
    // runs - proving the shell: true gate is real (denies when /bin/sh
    // isn't allowed, allows when it is), not merely "always denied".
    await withAllowlistPolicy(["/bin/sh"], () => {
      const allowedShell = structuredOf(runTool.handler({ command: "exit 0", shell: true }));
      assert.notEqual(
        isTerminalFailed(allowedShell),
        true,
        `shell: true must be allowed once /bin/sh itself is on the allowlist, got: ${JSON.stringify(allowedShell)}`
      );
    });
  }
);

// ---------------------------------------------------------------------------
// Live two-sentinel proof, real spawns, not mocked: an allowed sentinel's
// marker file appears, a denied sentinel's never does.
// ---------------------------------------------------------------------------

test(
  "a denied command settles failed and never spawns, proven live: an allowed sentinel's marker file appears, a denied sentinel's marker file never does",
  { skip: POSIX_ONLY_SKIP },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-policy-sentinel-"));
    const allowedMarker = path.join(dir, "allowed-marker.txt");
    const deniedMarker = path.join(dir, "denied-marker.txt");
    const allowedSentinel = path.join(dir, "allowed-sentinel");
    const deniedSentinel = path.join(dir, "denied-sentinel");
    writeExecutableScript(allowedSentinel, `echo ran > '${allowedMarker}'`);
    writeExecutableScript(deniedSentinel, `echo ran > '${deniedMarker}'`);

    await withAllowlistPolicy([allowedSentinel], async () => {
      // Positive control: allowed -> the marker file genuinely appears,
      // proving the real process actually ran.
      const allowedResult = structuredOf(runTool.handler({ command: [allowedSentinel] }));
      assert.notEqual(isTerminalFailed(allowedResult), true, JSON.stringify(allowedResult));
      const content = await waitForFile(allowedMarker, {
        timeoutMs: 3000,
        until: (text) => text.trim() === "ran",
      });
      assert.equal(content.trim(), "ran");

      // Negative control: denied -> a terminal failed job with the right
      // diagnostic reason, settled BEFORE this handler even returns.
      const deniedResult = structuredOf(runTool.handler({ command: [deniedSentinel] }));
      assert.equal(isTerminalFailed(deniedResult), true);
      assert.equal(diagnosticReasonOf(deniedResult), "policy-denied");

      // The proof that matters: waiting confirms the marker file for the
      // DENIED sentinel never appears - not merely that the job was
      // reported denied, but that the OS-level spawn genuinely never
      // happened. A fixed wait comfortably longer than the allowed
      // sentinel above needed to actually run and write its own marker.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(
        fs.existsSync(deniedMarker),
        false,
        "a denied command's marker file must never appear - its process must never have been spawned at all"
      );
    });
  }
);

// ---------------------------------------------------------------------------
// A malformed or missing policy source fails CLOSED (deny everything),
// never open; policy is never read from tool-call arguments.
// ---------------------------------------------------------------------------

test(
  "a malformed or missing policy source fails closed (denies everything, never falls open), and nothing in the tool call's own arguments can supply or widen the policy",
  { skip: POSIX_ONLY_SKIP },
  async () => {
    const trueBin = fs.existsSync("/bin/true") ? "/bin/true" : "/usr/bin/true";
    assert.ok(fs.existsSync(trueBin), "sanity: this test needs a real, ordinary leaf binary");

    // (a) the env var itself entirely unset - "no policy configured" is
    // NOT "allow everything"; it is exactly the same denial as a broken one.
    await withNoPolicyConfigured(() => {
      const result = structuredOf(runTool.handler({ command: [trueBin] }));
      assert.equal(isTerminalFailed(result), true);
      assert.equal(diagnosticReasonOf(result), "policy-denied");
    });

    // (b) the env var set, but naming a file that does not exist.
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-policy-missing-"));
      const original = process.env[POLICY_ENV_VAR];
      process.env[POLICY_ENV_VAR] = path.join(dir, "does-not-exist.json");
      try {
        const result = structuredOf(runTool.handler({ command: [trueBin] }));
        assert.equal(isTerminalFailed(result), true);
        assert.equal(diagnosticReasonOf(result), "policy-denied");
      } finally {
        if (original === undefined) delete process.env[POLICY_ENV_VAR];
        else process.env[POLICY_ENV_VAR] = original;
      }
    }

    // (c) the file exists but is not valid JSON.
    await withRawPolicyFile("{ this is not valid json", () => {
      const result = structuredOf(runTool.handler({ command: [trueBin] }));
      assert.equal(isTerminalFailed(result), true);
      assert.equal(diagnosticReasonOf(result), "policy-denied");
    });

    // (d) valid JSON, wrong shape (no "allow" field at all).
    await withRawPolicyFile(JSON.stringify({ notAllow: [trueBin] }), () => {
      const result = structuredOf(runTool.handler({ command: [trueBin] }));
      assert.equal(isTerminalFailed(result), true);
      assert.equal(diagnosticReasonOf(result), "policy-denied");
    });

    // (e) valid JSON, "allow" present but not an array of strings.
    await withRawPolicyFile(JSON.stringify({ allow: [42, true] }), () => {
      const result = structuredOf(runTool.handler({ command: [trueBin] }));
      assert.equal(isTerminalFailed(result), true);
      assert.equal(diagnosticReasonOf(result), "policy-denied");
    });

    // (f) once a VALID, permissive policy is in place, the SAME command
    // that was denied above is now allowed - proving the denials above
    // were genuinely caused by the malformed source, not by trueBin being
    // unspawnable for some unrelated reason.
    await withAllowlistPolicy([trueBin], () => {
      const result = structuredOf(runTool.handler({ command: [trueBin] }));
      assert.notEqual(isTerminalFailed(result), true, JSON.stringify(result));
    });

    // (g) policy is read ONLY from this server's own trusted environment,
    // never from the incoming tool call's own arguments. A caller-supplied
    // argv element carrying a policy-shaped JSON string has zero effect on
    // the real decision - the server never parses argv contents as policy
    // at all.
    await withAllowlistPolicy([], () => {
      const smuggled = structuredOf(
        runTool.handler({ command: [trueBin, JSON.stringify({ allow: [trueBin] })] })
      );
      assert.equal(
        isTerminalFailed(smuggled),
        true,
        `a policy-shaped string riding along as an ordinary argv argument must never widen the real policy decision, got: ${JSON.stringify(smuggled)}`
      );
      assert.equal(diagnosticReasonOf(smuggled), "policy-denied");

      // A caller cannot widen the policy via the job's OWN env argument
      // either - GHANTIKA_POLICY_FILE set inside env.vars only affects the
      // CHILD process's environment were it ever spawned; the server's own
      // decision reads its OWN process.env, never the job's.
      const deceptivelyPermissivePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-policy-smuggle-")),
        "permissive.json"
      );
      fs.writeFileSync(deceptivelyPermissivePath, JSON.stringify({ allow: [trueBin] }));
      const smuggledViaEnv = structuredOf(
        runTool.handler({
          command: [trueBin],
          env: { mode: "merge", vars: { [POLICY_ENV_VAR]: deceptivelyPermissivePath } },
        })
      );
      assert.equal(
        isTerminalFailed(smuggledViaEnv),
        true,
        `a caller-supplied env.vars.${POLICY_ENV_VAR} must never influence the server's own policy decision, got: ${JSON.stringify(smuggledViaEnv)}`
      );
      assert.equal(diagnosticReasonOf(smuggledViaEnv), "policy-denied");
    });
  }
);

// ---------------------------------------------------------------------------
// A correctly-configured policy keeps working - fixing the source
// un-denies what was denied a moment ago - and every escape/control class
// exercised above has its own green (successfully-runs) counterpart,
// proving the gate discriminates rather than denying everything by
// accident.
// ---------------------------------------------------------------------------

test(
  "a properly configured policy is not vacuous - it keeps ordinary allowed commands running normally alongside every denial class exercised above",
  { skip: POSIX_ONLY_SKIP },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-policy-green-"));
    const leafMarker = path.join(dir, "leaf-marker.txt");
    const leafBin = path.join(dir, "leaf-tool");
    writeExecutableScript(leafBin, `echo ran > '${leafMarker}'`);
    const otherBin = path.join(dir, "other-tool");
    writeExecutableScript(otherBin, "exit 0");

    await withAllowlistPolicy([leafBin], async () => {
      // Green control for the live sentinel proof above: an allowlisted
      // plain leaf binary runs normally and produces its real side
      // effect - the policy isn't accidentally denying everything.
      const result = structuredOf(runTool.handler({ command: [leafBin] }));
      assert.notEqual(isTerminalFailed(result), true, JSON.stringify(result));
      const content = await waitForFile(leafMarker, {
        timeoutMs: 3000,
        until: (text) => text.trim() === "ran",
      });
      assert.equal(content.trim(), "ran");

      // Green control for the OS-resolution class above: the SAME
      // allowlisted binary reached via a bare-name PATH lookup also runs.
      const viaPath = structuredOf(
        runTool.handler({ command: ["leaf-tool"], env: { mode: "merge", vars: { PATH: dir } } })
      );
      assert.notEqual(isTerminalFailed(viaPath), true, JSON.stringify(viaPath));

      // Green control for the interpreter/wrapper laundering checks above:
      // a plain, non-interpreter leaf binary sitting right next to another
      // real binary is judged on its OWN resolved identity - allowing one
      // never implies allowing the other; otherBin stays denied throughout.
      const otherResult = structuredOf(runTool.handler({ command: [otherBin] }));
      assert.equal(isTerminalFailed(otherResult), true);
      assert.equal(diagnosticReasonOf(otherResult), "policy-denied");
    });

    // Green control for the fail-closed checks above: once otherBin is
    // ALSO explicitly allowlisted, it stops being denied - fixing the
    // policy (no server restart, no caching to invalidate) immediately
    // un-denies exactly the command that was denied a moment ago under the
    // narrower policy above.
    await withAllowlistPolicy([leafBin, otherBin], () => {
      const nowAllowed = structuredOf(runTool.handler({ command: [otherBin] }));
      assert.notEqual(isTerminalFailed(nowAllowed), true, JSON.stringify(nowAllowed));
    });
  }
);
