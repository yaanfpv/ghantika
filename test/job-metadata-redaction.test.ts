/**
 * This codebase claims env MINIMIZATION, cwd VALIDATION, and metadata
 * REDACTION - and explicitly nothing past that. Two things it does NOT
 * claim, each proven false here by a concrete, real assertion rather than
 * left as an unverified sentence in a doc comment:
 *
 * - NO child-output-secrecy claim: a child that prints something secret-
 *   looking to its OWN stdout is passed through untouched. This server
 *   only ever minimizes what a child RECEIVES; it never inspects or
 *   filters what a child CHOOSES TO EMIT.
 * - NO isolation-from-inspection claim: this server's own internal
 *   JobRecord (`jobStore.get`) holds a job's exact `env` in plain,
 *   unredacted form - the SAME record `toPublicProjection` reads from to
 *   build the redacted client-facing shape. Redaction happens at the
 *   PUBLIC-PROJECTION boundary only; nothing about this codebase's own
 *   internal state, or the real OS process a job's env was handed to, is
 *   hidden from an operator (or any other code running inside this same
 *   process) with ordinary access to either. Proven two ways below: an
 *   in-process read of the internal JobRecord, AND a genuinely EXTERNAL
 *   same-uid OS-level process inspection (`ps eww`) against the real
 *   spawned child - the actual hazard this non-goal names, not merely a
 *   narrower proxy for it.
 *
 * `toPublicProjection`'s own header docs (src/jobStore.ts) already state
 * that command_summary/label/counts are the only fields a client-facing
 * response may carry, and that `env`/raw `argv` are never included - this
 * file exists to prove that boundary against a REAL spawned job's REAL
 * output and REAL server-side state, not just read the doc comment that
 * asserts it.
 */
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { before, test } from "node:test";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import { isTerminalJobState, jobStore, type JobState } from "../dist/jobStore.js";
import * as outputTool from "../dist/tools/output.js";
import * as runTool from "../dist/tools/run.js";

import { requireSpawnPolicy } from "./helpers/requireSpawnPolicy.ts";

// Every test in this file but the "mutation control" test below spawns a
// real job through the real `run` tool's handler - see
// test/helpers/requireSpawnPolicy.ts for what this checks and why. The
// "mutation control" test checks an assertion's discriminating power
// against a local mutant object and never calls `run`.
before(requireSpawnPolicy);

function structuredOf(result: {
  structuredContent?: Record<string, unknown>;
}): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function jobIdOf(result: ReturnType<typeof runTool.handler>): string {
  const structured = structuredOf(result);
  assert.equal(
    typeof structured.job_id,
    "string",
    `expected a real job_id, got: ${JSON.stringify(result)}`
  );
  return structured.job_id as string;
}

/** Polls `status()` until the job reaches a terminal state (per jobStore's own `isTerminalJobState` - `exited`/`killed`/`failed`) - no fixed sleep, since a child's real exit timing is never exact. */
async function waitForTerminal(
  jobId: string,
  statusTool: { handler: (args: unknown) => unknown }
): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = structuredOf(
      statusTool.handler({ job_id: jobId }) as { structuredContent?: Record<string, unknown> }
    );
    if (isTerminalJobState(result.state as JobState)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `job ${jobId} did not reach a terminal state within the test's own wait budget`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// Non-goal 1: NO child-output-secrecy claim
// ---------------------------------------------------------------------------

test("NEGATIVE CONTROL: a child that prints a secret-looking string to its own stdout is passed through UNTOUCHED - this server never inspects or redacts what a child chooses to emit", async () => {
  // Dynamic import to avoid a hard, file-scope dependency on status.js's
  // export shape colliding with the other imports above - loaded once, used
  // by the waitForTerminal helper.
  const statusTool = await import("../dist/tools/status.js");

  const secret = "GHANTIKA-TEST-SECRET-token-do-not-redact-me-9f2a";
  const result = runTool.handler({
    command: ["node", "-e", `process.stdout.write(${JSON.stringify(secret)})`],
  });
  assert.notEqual(result.isError, true, `run() must succeed: ${JSON.stringify(result)}`);
  const jobId = jobIdOf(result);

  await waitForTerminal(jobId, statusTool);

  const output = structuredOf(
    outputTool.handler({ job_id: jobId, stream: "stdout" }) as {
      structuredContent?: Record<string, unknown>;
    }
  );
  const events = output.events as Array<{ text: string }>;
  const combined = events.map((event) => event.text).join("");
  assert.ok(
    combined.includes(secret),
    `expected the child's own secret-looking stdout output to pass through VERBATIM (proving no child-output-secrecy claim), got: ${JSON.stringify(combined)}`
  );
});

test("the same child-emitted secret never appears in the job's PUBLIC metadata projection (status), even though it passes through the real output stream untouched", async () => {
  const statusTool = await import("../dist/tools/status.js");

  const secret = "GHANTIKA-TEST-SECRET-token-never-in-metadata-7c3e";
  const result = runTool.handler({
    command: ["node", "-e", `process.stdout.write(${JSON.stringify(secret)})`],
  });
  assert.notEqual(result.isError, true);
  const jobId = jobIdOf(result);

  await waitForTerminal(jobId, statusTool);

  const status = structuredOf(
    statusTool.handler({ job_id: jobId }) as {
      structuredContent?: Record<string, unknown>;
    }
  );
  const statusText = JSON.stringify(status);
  assert.ok(
    !statusText.includes(secret),
    `expected the secret to be absent from status()'s public projection (command_summary/label never carry it), but found it in: ${statusText}`
  );
});

// ---------------------------------------------------------------------------
// Non-goal 2: NO isolation-from-inspection claim
// ---------------------------------------------------------------------------

test("NEGATIVE CONTROL: this server's own internal JobRecord holds a job's exact env in PLAIN, UNREDACTED form - env minimization is real, hiding it from anyone with server-level access is NOT something this codebase attempts or claims", () => {
  const result = runTool.handler({
    command: ["node", "-e", "setTimeout(() => {}, 2000)"],
    env: { mode: "merge", vars: { GHANTIKA_TEST_CANARY_VAR: "canary-value-12345" } },
  });
  assert.notEqual(result.isError, true, `run() must succeed: ${JSON.stringify(result)}`);
  const jobId = jobIdOf(result);

  // The SAME internal record toPublicProjection reads from (src/jobStore.ts)
  // - a plain in-memory object, not a separate encrypted or access-controlled
  // store. Reading it directly here is exactly the level of access an
  // operator (or any other code in this same process) already has.
  const record = jobStore.get(jobId);
  assert.notEqual(record, undefined, "expected a real tracked JobRecord for this job");
  assert.equal(
    record!.env.GHANTIKA_TEST_CANARY_VAR,
    "canary-value-12345",
    "expected the server's own internal state to hold the exact caller-supplied env value in plain text - proving no isolation-from-inspection layer exists even at the server's own storage level"
  );

  // Cleanup: this job's child would otherwise sit alive for its own 2s
  // sleep - kill it directly via jobStore's own tracked child handle rather
  // than importing kill.ts, keeping this file's own scope narrow.
  const handle = jobStore.getChildHandle(jobId);
  if (handle !== undefined) {
    try {
      process.kill(-handle.pid, "SIGKILL");
    } catch {
      // already gone - fine, this is best-effort cleanup only.
    }
  }
});

test("mutation control: the negative control above is actually discriminating - a record whose env was genuinely redacted (the caller's var replaced with a placeholder) would fail the same assertion", () => {
  const mutant = { env: { GHANTIKA_TEST_CANARY_VAR: "[REDACTED]" } };
  assert.notEqual(mutant.env.GHANTIKA_TEST_CANARY_VAR, "canary-value-12345");
  assert.throws(() => assert.equal(mutant.env.GHANTIKA_TEST_CANARY_VAR, "canary-value-12345"));
});

test(
  "NEGATIVE CONTROL: a genuinely EXTERNAL same-uid OS process inspection (a real `ps eww` call, not an in-process read) can observe a live child's own env - the actual hazard this non-goal names, exercised directly rather than substituted with a weaker in-process proxy",
  {
    skip:
      process.platform === "win32"
        ? "ps-based same-uid env inspection is a POSIX-specific surface - win32 has no equivalent same-uid ps flag"
        : false,
  },
  () => {
    const canary = "GHANTIKA_QA_SAME_UID_CANARY_8b7d";
    const result = runTool.handler({
      command: ["node", "-e", "setTimeout(() => {}, 5000)"],
      env: { mode: "merge", vars: { GHANTIKA_QA_SAME_UID: canary } },
    });
    assert.notEqual(result.isError, true, `run() must succeed: ${JSON.stringify(result)}`);
    const jobId = jobIdOf(result);

    const handle = jobStore.getChildHandle(jobId);
    assert.notEqual(handle, undefined, "expected a real attached child handle for this job");
    try {
      // The real hazard, exercised directly: a SEPARATE process (this test
      // process), running as the SAME OS user, using a standard OS
      // inspection tool - never this server's own code, never an in-
      // process object read. If this codebase's env-minimization were ever
      // mistaken for a same-uid inspection defense, this is the exact
      // command that would disprove it.
      const psOutput = execFileSync("ps", ["eww", "-p", String(handle!.pid), "-o", "command="], {
        encoding: "utf8",
      });
      assert.ok(
        psOutput.includes(canary),
        `expected a real external same-uid \`ps eww\` call to observe the child's own env (proving no same-uid inspection isolation is claimed or exists), but the canary was absent from: ${JSON.stringify(psOutput)}`
      );
    } finally {
      // Cleanup: this job's child would otherwise sit alive for its own 5s
      // sleep.
      try {
        process.kill(-handle!.pid, "SIGKILL");
      } catch {
        // already gone - fine, this is best-effort cleanup only.
      }
    }
  }
);
