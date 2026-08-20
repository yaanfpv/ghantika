import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/server";
// The SDK's own AJV-based schema validator (the schema-handler-agreement
// coverage below uses this, not a hand-rolled ad hoc check) - the exact
// validation layer a real MCP client/server would run an advertised
// inputSchema through.
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import { jobStore } from "../dist/jobStore.js";
import * as killTool from "../dist/tools/kill.js";
import * as listTool from "../dist/tools/list.js";
import * as outputTool from "../dist/tools/output.js";
import * as runTool from "../dist/tools/run.js";
import * as statusTool from "../dist/tools/status.js";
import * as tailTool from "../dist/tools/tail.js";

// See test/e2e-server.test.ts's import comment for why this is ".ts", not
// ".js" - the shared marker-file poll waits for CONTENT, never for mere
// existence, so a follow-up read never races the write.
import { waitForFile } from "./harness.ts";
import { requireSpawnPolicy } from "./helpers/requireSpawnPolicy.ts";

// Four tests below dispatch a real command through the real `run` tool's
// own handler (in-process - shape (a), never spawnManaged directly) AND
// assert something about the resulting job's own state - so each one
// genuinely needs the ambient policy to ALLOW the command, not merely to
// be reached: a policy-denied job is still a real, successfully-returned
// job record (isError stays false), it just settles state "failed" rather
// than "starting"/"running"/"exited". Each of those four is individually
// wrapped in its own local describe() block carrying a before(requireSpawnPolicy)
// call scoped to just that one test - see test/helpers/requireSpawnPolicy.ts
// for what this checks and why, and see test/kill.test.ts for the same
// scoped-guard pattern applied to a file with more than one gated test per
// block.
//
// Every OTHER test in this file needs no guard at all, for one of four
// distinct reasons: it never calls a job-creating handler in the first
// place (a pure inputSchema/comparator check); it does call run()'s
// handler but the input is schema-invalid, or the cwd/executable never
// resolves, so the call returns before src/policy.ts's
// decideRunPolicy/decideShellPolicy is ever reached at all (see
// src/tools/run.ts's own "Three ways a job can be failed" doc comment -
// only an unresolvable cwd/executable and an actual policy denial share
// the "spawn-error" vs "policy-denied" diagnostic.reason split, and the
// former never even reaches the latter's check); it does reach the policy
// gate but never asserts anything sensitive to its outcome (e.g. a bare
// `isError !== true` check, which holds for an ALLOWED job and a
// policy-DENIED one alike); or it scopes its own dedicated
// GHANTIKA_POLICY_FILE value directly inside the test body (see the
// relative-PATH-entry test below), independent of whatever the ambient
// value happens to be at the moment this file loads.

/**
 * A schema-invalid tool call always returns a tool-execution error result
 * (`isError: true`, never a thrown JSON-RPC error) - the only difference
 * across cases is the message. This asserts that shape for every one
 * of the six legacy tool handlers this file imports directly, at the unit
 * level (the real end-to-end proof lives in test/e2e-server.test.ts;
 * `follow` has its own dedicated coverage in test/follow.test.ts).
 */
function assertToolError(result: CallToolResult, expectedSubstring: string): void {
  assert.equal(
    result.isError,
    true,
    "a stub tool call must always return isError: true, never a success result"
  );
  assert.ok(Array.isArray(result.content) && result.content.length > 0);
  const [first] = result.content;
  assert.equal(first.type, "text");
  assert.ok(
    first.type === "text" && first.text.includes(expectedSubstring),
    `expected content text to include "${expectedSubstring}", got: ${JSON.stringify(result.content)}`
  );
}

// --- run ---

test("run: schema present, requires a non-empty command (an argv array by default, or a shell string via shell: true)", () => {
  assert.deepEqual(runTool.inputSchema.required, ["command"]);
  const commandSchema = runTool.inputSchema.properties?.command as
    { anyOf?: Array<Record<string, unknown>> } | undefined;
  assert.ok(
    Array.isArray(commandSchema?.anyOf) && commandSchema.anyOf.length === 2,
    "command's schema must offer both the argv-array and shell-string shapes"
  );
  assert.equal(commandSchema!.anyOf![0]!.type, "array");
  assert.equal(commandSchema!.anyOf![1]!.type, "string");
});

// Schema-invalid args must produce isError, never a thrown error.
test("run() with a missing/invalid command returns isError: true, not a thrown error", () => {
  assert.doesNotThrow(() => runTool.handler(undefined));
  assertToolError(runTool.handler(undefined), "command");
  assertToolError(runTool.handler({}), "command");
  assertToolError(runTool.handler({ command: 42 }), "command");
  assertToolError(runTool.handler({ command: "" }), "command");
  assertToolError(runTool.handler({ command: [] }), "command"); // empty argv array (min length 1) rejected
});

// A bare shell string is rejected UNLESS shell: true is explicitly passed.
test("a bare shell string without shell: true is rejected (argv array required by default)", () => {
  const result = runTool.handler({ command: "echo hi" });
  assertToolError(result, "shell: true");
});

describe("run: dispatches through the real run tool's policy gate", () => {
  // Asserts the resulting job's state is one of ["starting", "running",
  // "exited"] - a policy-denied job settles "failed" instead, so this
  // genuinely needs the ambient policy to ALLOW "true", not merely to be
  // reached. See this file's own top-of-file comment.
  before(requireSpawnPolicy);

  test("run: a valid argv command passes schema validation and returns a real job (never isError, never the old stub message)", () => {
    const result = runTool.handler({ command: ["true"] });
    assert.notEqual(result.isError, true);
    assert.ok(Array.isArray(result.content) && result.content.length > 0);
    assert.equal(result.content[0]!.type, "text");
    assert.ok(
      result.content[0]!.type === "text" && !result.content[0]!.text.includes("not implemented yet")
    );
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(typeof structured.job_id, "string");
    assert.ok(
      ["starting", "running", "exited"].includes(structured.state as string),
      `unexpected state: ${structured.state as string}`
    );
  });
});

test("run: shell: true accepts a bare shell command-line string", () => {
  const result = runTool.handler({ command: "true", shell: true });
  assert.notEqual(result.isError, true);
});

test("run: an invalid cwd produces a real (non-error) job whose state is failed, diagnostic.reason spawn-error - never a thrown error or a silent default", () => {
  const result = runTool.handler({
    command: ["true"],
    cwd: "/no/such/directory/ghantika-unit-test",
  });
  assert.notEqual(result.isError, true);
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(structured.state, "failed");
  assert.deepEqual(structured.diagnostic, { reason: "spawn-error", message: "cwd does not exist" });
  // Caller-level/wire-level regression: run()'s own structured response,
  // not a store-level helper call - a job that never reached
  // child_process.spawn never had a process group, so kill_confirmed must
  // already read true in this exact response, not undefined.
  assert.equal(
    structured.kill_confirmed,
    true,
    "an invalid-cwd job's process group trivially holds zero members, and run()'s own response must say so immediately"
  );
});

test("run: an invalid binary produces a real (non-error) job whose state is failed, diagnostic.reason spawn-error", () => {
  const result = runTool.handler({
    command: ["this-command-definitely-does-not-exist-ghantika-xyz"],
  });
  assert.notEqual(result.isError, true);
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(structured.state, "failed");
  assert.equal((structured.diagnostic as { reason?: string } | undefined)?.reason, "spawn-error");
  // Same caller-level regression as the invalid-cwd case above.
  assert.equal(
    structured.kill_confirmed,
    true,
    "an unresolvable-executable job's process group trivially holds zero members, and run()'s own response must say so immediately"
  );
});

test("run: a policy-denied command produces a real (non-error) job whose state is failed, diagnostic.reason policy-denied, with kill_confirmed already true in run()'s own response", () => {
  // "cat" resolves to a real executable but is not on the test suite's
  // shared command-policy allowlist (test/fixtures/policy-allow.json, set
  // via GHANTIKA_POLICY_FILE by scripts/run-tests.mjs) - denied AFTER
  // resolution, distinct from the missing-executable case above, which
  // never resolves at all. Same three-route sync createFailedJob class
  // test/concurrency.test.ts's own releaseSlot-ownership test already
  // exercises at the wire level for a different concern (slot
  // accounting) - this is the kill_confirmed regression for the same
  // three routes.
  const result = runTool.handler({
    command: ["cat"],
  });
  assert.notEqual(result.isError, true);
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(structured.state, "failed");
  assert.equal((structured.diagnostic as { reason?: string } | undefined)?.reason, "policy-denied");
  assert.equal(
    structured.kill_confirmed,
    true,
    "a policy-denied job's process group trivially holds zero members, and run()'s own response must say so immediately"
  );
});

test("the async markSpawnFailed path also settles kill_confirmed true, observed through the real status() tool response - not a store-level read of the record", () => {
  // The three tests above cover run()'s three SYNC preflight-failure
  // routes; this covers the one ASYNC route, src/tools/run.ts's own
  // beginSpawn onError callback, which fires after run() has already
  // returned a "starting"/"running" job - so it can only be observed via
  // a LATER tool call, never in run()'s own response. Mints the job via
  // jobStore.createJob directly (the same simulated-async-transition
  // pattern this codebase already uses for markSpawnFailed elsewhere -
  // see test/concurrency.test.ts's dequeue-spawn-failure test and
  // test/kill.test.ts's own onError wiring - since a genuine OS-level
  // spawn() failure past the sync resolveExecutable check that already
  // gates run() is not reliably reproducible), then reads the outcome
  // through the REAL status() tool handler - the same toPublicProjection
  // path run()'s own response goes through - rather than jobStore.get().
  const record = jobStore.createJob({
    argv: ["this-would-have-spawned"],
    cwd: "/tmp",
    env: {},
    isShell: false,
    label: "caller-level-mark-spawn-failed",
  });
  jobStore.markSpawnFailed(record.job_id, "simulated async spawn failure");

  const statusResult = statusTool.handler({ job_id: record.job_id });
  assert.notEqual(statusResult.isError, true);
  const structured = statusResult.structuredContent as Record<string, unknown>;
  assert.equal(structured.state, "failed");
  assert.equal((structured.diagnostic as { reason?: string } | undefined)?.reason, "spawn-error");
  assert.equal(
    structured.kill_confirmed,
    true,
    "a job whose spawn failed asynchronously never had a process group either, and a real status() call must report the settled value, not undefined"
  );
});

// A REAL spawn (not just a unit-level resolveExecutable check - that
// lives in test/process.test.ts) through the real run() tool: a fixture
// executable living in the job's requested cwd, with env: {PATH: "."} -
// a real, legal relative PATH entry that must be resolved against the
// CHILD's cwd, never this server's own process.cwd().
test('run() with a relative PATH entry (".") and a matching cwd actually spawns the fixture - never a false spawn-error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghantika-run-relpath-"));
  const marker = path.join(dir, "ran-marker.txt");
  const fixture = path.join(dir, "gh-relative-tool");
  fs.writeFileSync(fixture, `#!/bin/sh\necho ran > '${marker}'\n`);
  fs.chmodSync(fixture, 0o755);
  assert.notEqual(
    process.cwd(),
    dir,
    "sanity: the server's own cwd must genuinely differ from the job's cwd"
  );

  // This fixture's own path is freshly generated by this one test run, so
  // it can never appear in the suite's shared, static test policy file -
  // scope a dedicated policy allowlisting exactly this fixture's absolute
  // path to this test alone, restoring the shared value afterward so
  // every other test in this file keeps seeing the ordinary baseline.
  const originalPolicyFile = process.env.GHANTIKA_POLICY_FILE;
  const policyFile = path.join(dir, "policy.json");
  fs.writeFileSync(policyFile, JSON.stringify({ allow: [fixture] }));
  process.env.GHANTIKA_POLICY_FILE = policyFile;
  try {
    const result = runTool.handler({
      command: ["gh-relative-tool"],
      cwd: dir,
      env: { mode: "merge", vars: { PATH: "." } },
    });
    assert.notEqual(result.isError, true);
    const structured = result.structuredContent as Record<string, unknown>;
    assert.notEqual(
      structured.state,
      "failed",
      `must not be a false spawn-error (the OLD bug resolved "." against the server's own cwd, not the job's) - got: ${JSON.stringify(structured)}`
    );
    assert.ok(
      ["starting", "running"].includes(structured.state as string),
      `expected a real in-flight job, got state: ${String(structured.state)}`
    );

    // Confirm it genuinely ran, not just that run() avoided an immediate
    // false-negative diagnostic - a real, deterministic side effect proves
    // the child actually executed. waitForFile polls for the marker to hold
    // its expected content, not merely to exist, so this can't read the file
    // in the gap between the shell's redirect opening it and "ran" landing.
    await waitForFile(marker, { timeoutMs: 3000, until: (content) => content.trim() === "ran" });
  } finally {
    if (originalPolicyFile === undefined) delete process.env.GHANTIKA_POLICY_FILE;
    else process.env.GHANTIKA_POLICY_FILE = originalPolicyFile;
  }
});

test("run: a label over 64 characters is a schema validation error (isError: true)", () => {
  const result = runTool.handler({ command: ["true"], label: "x".repeat(65) });
  assertToolError(result, "label");
});

test("run: a label containing a control character is a schema validation error (isError: true)", () => {
  const result = runTool.handler({ command: ["true"], label: `bad${String.fromCharCode(7)}label` });
  assertToolError(result, "label");
});

test("run: the public result never includes env or the raw argv array", () => {
  const result = runTool.handler({
    command: ["true", "--secret-arg"],
    env: { mode: "merge", vars: { SECRET: "leak-me-not" } },
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("leak-me-not"), false);
  assert.equal(serialized.includes("--secret-arg"), false);
  assert.equal("env" in (result.structuredContent as Record<string, unknown>), false);
  assert.equal("argv" in (result.structuredContent as Record<string, unknown>), false);
});

// --- output / tail: same job_id-required shape ---
// (status's real implementation is tested in its own dedicated section
// below. kill's own schema/validation/real-behavior tests
// live in test/kill.test.ts - both have real implementations,
// so neither shares this loop's job_id-validation-only assertions.)

const jobIdTools = [
  { mod: outputTool, name: "output" },
  { mod: tailTool, name: "tail" },
];

for (const { mod, name } of jobIdTools) {
  test(`${name}: schema requires a non-empty string job_id`, () => {
    assert.deepEqual(mod.inputSchema.required, ["job_id"]);
    assert.equal(mod.inputSchema.properties?.job_id?.type, "string");
  });

  test(`${name}: missing/wrong-typed job_id returns isError: true, not a thrown error`, () => {
    assert.doesNotThrow(() => mod.handler(undefined));
    assertToolError(mod.handler(undefined), "job_id");
    assertToolError(mod.handler({}), "job_id");
    assertToolError(mod.handler({ job_id: 7 }), "job_id");
    assertToolError(mod.handler({ job_id: "" }), "job_id");
  });
}

// status is fully implemented (tested below, its own dedicated
// section), output/tail are fully implemented too (their "valid
// job_id" behavior is real, unknown-job not-found, tested thoroughly in
// test/output-tail.test.ts), and kill is fully implemented as well
// (its own real-behavior tests, including the external pgrep process-group
// proof, live in test/kill.test.ts) - none of the six legacy tool handlers
// this file imports are left returning the old "not implemented yet" stub
// message (follow was never one of them - it shipped already implemented).

// --- schema-handler agreement: the ADVERTISED inputSchema itself agrees
// with what the handler already enforces - proving schema and handler are consistent,
// not just separately asserting the handler's own behavior. Every tool's
// inputSchema is exactly what `tools/list` sends over the wire, so a
// real MCP client (or a schema-validating gateway in front of this
// server) validating against the SAME advertised schema must reach the
// same result the handler would. Uses the SDK's own AjvJsonSchemaValidator
// (@modelcontextprotocol/server/validators/ajv) rather than a hand-rolled
// check, so this is validated through the exact JSON-Schema engine a real
// client-side implementation would use.

const ajvValidator = new AjvJsonSchemaValidator();

test("schema-handler agreement: run's advertised inputSchema itself rejects an empty command string, matching the handler's own rejection", () => {
  const validate = ajvValidator.getValidator(runTool.inputSchema);
  const result = validate({ command: "", shell: true });
  assert.equal(
    result.valid,
    false,
    `expected the advertised schema to reject {command: ""}, got: ${JSON.stringify(result)}`
  );
});

test("schema-handler agreement: run's advertised inputSchema accepts a non-empty command string", () => {
  const validate = ajvValidator.getValidator(runTool.inputSchema);
  const result = validate({ command: "echo hi", shell: true });
  assert.equal(
    result.valid,
    true,
    `expected a valid shell command string to pass schema validation, got: ${JSON.stringify(result)}`
  );
});

test("schema-handler agreement: run's advertised inputSchema accepts a non-empty argv array", () => {
  const validate = ajvValidator.getValidator(runTool.inputSchema);
  const result = validate({ command: ["true"] });
  assert.equal(
    result.valid,
    true,
    `expected a valid argv array to pass schema validation, got: ${JSON.stringify(result)}`
  );
});

// ---------------------------------------------------------------------------
// Three real schema/handler disagreement cases, found by validating
// the exact boundary input against the SDK's own AJV validator AND calling
// the handler, then asserting they agree - the SAME pattern the
// schema-handler-agreement tests above already established.
// ---------------------------------------------------------------------------

test("a bare shell string with shell OMITTED is rejected by the advertised schema itself, agreeing with the handler's own rejection", () => {
  const validate = ajvValidator.getValidator(runTool.inputSchema);
  const input = { command: "echo hi" };
  const schemaResult = validate(input);
  const handlerResult = runTool.handler(input);
  assert.equal(
    schemaResult.valid,
    false,
    `expected the advertised schema to reject a bare string command without shell: true, got: ${JSON.stringify(schemaResult)}`
  );
  assert.equal(handlerResult.isError, true, "the handler must also reject this");
  assertToolError(handlerResult, "shell: true");
});

test("the SAME bare string with shell: true IS accepted by both - the schema's if/then/else only narrows the DEFAULT (shell-omitted) case, never the opt-in one", () => {
  const validate = ajvValidator.getValidator(runTool.inputSchema);
  const input = { command: "echo hi", shell: true };
  const schemaResult = validate(input);
  const handlerResult = runTool.handler(input);
  assert.equal(
    schemaResult.valid,
    true,
    `expected the advertised schema to accept a bare string command WITH shell: true, got: ${JSON.stringify(schemaResult)}`
  );
  assert.notEqual(handlerResult.isError, true, "the handler must also accept this");
});

test("an argv array containing one empty string is rejected by the advertised schema itself (shell omitted), agreeing with the handler's own argv[0]-non-empty rejection", () => {
  const validate = ajvValidator.getValidator(runTool.inputSchema);
  const input = { command: [""] };
  const schemaResult = validate(input);
  const handlerResult = runTool.handler(input);
  assert.equal(
    schemaResult.valid,
    false,
    `expected the advertised schema to reject {command: [""]}, got: ${JSON.stringify(schemaResult)}`
  );
  assert.equal(handlerResult.isError, true, "the handler must also reject this");
  assertToolError(handlerResult, "argv[0]");
});

test("(green control) an argv array of genuinely non-empty strings still passes both, unaffected by the new items.minLength constraint", () => {
  const validate = ajvValidator.getValidator(runTool.inputSchema);
  const input = { command: ["ls", "-la"] };
  const schemaResult = validate(input);
  const handlerResult = runTool.handler(input);
  assert.equal(
    schemaResult.valid,
    true,
    `expected a valid non-empty argv array to still pass schema validation, got: ${JSON.stringify(schemaResult)}`
  );
  assert.notEqual(handlerResult.isError, true);
});

test("(shell green control) with shell: true, an array containing an empty-string TOKEN is still accepted by both (never regressed by the non-shell-only minLength constraint) - only the WHOLE joined-and-trimmed command matters there", () => {
  const validate = ajvValidator.getValidator(runTool.inputSchema);
  const input = { command: ["", "echo", "hi"], shell: true };
  const schemaResult = validate(input);
  const handlerResult = runTool.handler(input);
  assert.equal(
    schemaResult.valid,
    true,
    `expected the schema to still accept an empty-string token within a shell: true array (only the joined-and-trimmed whole matters), got: ${JSON.stringify(schemaResult)}`
  );
  assert.notEqual(
    handlerResult.isError,
    true,
    "the handler already accepted this shape (joins tokens, only rejects an all-blank result)"
  );
});

test("a 40-Unicode-code-point emoji label (80 UTF-16 code units, comfortably under the 64 code-point limit) is accepted by BOTH the advertised schema (which counts code points, per the JSON Schema spec) and the handler (which also counts code points, not .length)", () => {
  const emojiLabel = "\u{1F600}".repeat(40); // U+1F600 (😀) is a surrogate pair - 40 code points, 80 UTF-16 code units
  assert.equal(
    [...emojiLabel].length,
    40,
    "sanity: exactly 40 code points - well under the 64-code-point limit"
  );
  assert.equal(
    emojiLabel.length,
    80,
    "sanity: 80 UTF-16 code units - OVER 64 in UTF-16-unit terms, which is exactly what made the OLD .length-based handler check wrongly reject this"
  );
  const validate = ajvValidator.getValidator(runTool.inputSchema);
  const input = { command: ["true"], label: emojiLabel };
  const schemaResult = validate(input);
  const handlerResult = runTool.handler(input);
  assert.equal(
    schemaResult.valid,
    true,
    `expected the advertised schema (code-point counting) to accept a 40-code-point label, got: ${JSON.stringify(schemaResult)}`
  );
  assert.notEqual(
    handlerResult.isError,
    true,
    `expected the handler (now also code-point counting) to accept the same label, got: ${JSON.stringify(handlerResult)}`
  );
  assert.equal(
    (handlerResult.structuredContent as Record<string, unknown> | undefined)?.label,
    emojiLabel
  );
});

test("the REAL 64-code-point boundary, exercised with emoji - exactly 64 code points (128 UTF-16 units) is accepted by both, 65 code points (130 UTF-16 units) is rejected by both", () => {
  const validate = ajvValidator.getValidator(runTool.inputSchema);

  const atLimit = "\u{1F600}".repeat(64);
  assert.equal([...atLimit].length, 64);
  const atLimitInput = { command: ["true"], label: atLimit };
  const atLimitSchemaResult = validate(atLimitInput);
  const atLimitHandlerResult = runTool.handler(atLimitInput);
  assert.equal(
    atLimitSchemaResult.valid,
    true,
    `expected the schema to accept exactly 64 code points, got: ${JSON.stringify(atLimitSchemaResult)}`
  );
  assert.notEqual(
    atLimitHandlerResult.isError,
    true,
    `expected the handler to accept exactly 64 code points (using code-point counting, not the 128 UTF-16 units), got: ${JSON.stringify(atLimitHandlerResult)}`
  );

  const overLimit = "\u{1F600}".repeat(65);
  assert.equal([...overLimit].length, 65);
  const overLimitInput = { command: ["true"], label: overLimit };
  const overLimitSchemaResult = validate(overLimitInput);
  const overLimitHandlerResult = runTool.handler(overLimitInput);
  assert.equal(
    overLimitSchemaResult.valid,
    false,
    `expected the schema to reject 65 code points, got: ${JSON.stringify(overLimitSchemaResult)}`
  );
  assert.equal(overLimitHandlerResult.isError, true, "the handler must also reject 65 code points");
  assertToolError(overLimitHandlerResult, "label");
});

for (const { mod, name } of jobIdTools) {
  test(`schema-handler agreement: ${name}'s advertised inputSchema itself rejects an empty job_id, matching the handler's own rejection`, () => {
    const validate = ajvValidator.getValidator(mod.inputSchema);
    const result = validate({ job_id: "" });
    assert.equal(
      result.valid,
      false,
      `expected the advertised schema to reject {job_id: ""}, got: ${JSON.stringify(result)}`
    );
  });

  test(`schema-handler agreement: ${name}'s advertised inputSchema accepts a non-empty job_id`, () => {
    const validate = ajvValidator.getValidator(mod.inputSchema);
    const result = validate({ job_id: "abc-123" });
    assert.equal(
      result.valid,
      true,
      `expected a valid job_id to pass schema validation, got: ${JSON.stringify(result)}`
    );
  });
}

// status left the shared jobIdTools loop once it became a real
// implementation, so its own schema-handler agreement
// pair is asserted directly here rather than through that loop.
test("schema-handler agreement: status's advertised inputSchema itself rejects an empty job_id, matching the handler's own rejection", () => {
  const validate = ajvValidator.getValidator(statusTool.inputSchema);
  const result = validate({ job_id: "" });
  assert.equal(
    result.valid,
    false,
    `expected the advertised schema to reject {job_id: ""}, got: ${JSON.stringify(result)}`
  );
});

test("schema-handler agreement: status's advertised inputSchema accepts a non-empty job_id", () => {
  const validate = ajvValidator.getValidator(statusTool.inputSchema);
  const result = validate({ job_id: "abc-123" });
  assert.equal(
    result.valid,
    true,
    `expected a valid job_id to pass schema validation, got: ${JSON.stringify(result)}`
  );
});

// kill left the shared jobIdTools loop for the same reason status did
// (it also got a real implementation), so its own
// schema-handler agreement pair is asserted directly here too.
test("schema-handler agreement: kill's advertised inputSchema itself rejects an empty job_id, matching the handler's own rejection", () => {
  const validate = ajvValidator.getValidator(killTool.inputSchema);
  const result = validate({ job_id: "" });
  assert.equal(
    result.valid,
    false,
    `expected the advertised schema to reject {job_id: ""}, got: ${JSON.stringify(result)}`
  );
});

test("schema-handler agreement: kill's advertised inputSchema accepts a non-empty job_id", () => {
  const validate = ajvValidator.getValidator(killTool.inputSchema);
  const result = validate({ job_id: "abc-123" });
  assert.equal(
    result.valid,
    true,
    `expected a valid job_id to pass schema validation, got: ${JSON.stringify(result)}`
  );
});

// ---------------------------------------------------------------------------
// status: real implementation
// ---------------------------------------------------------------------------

test("status: schema requires a non-empty string job_id", () => {
  assert.deepEqual(statusTool.inputSchema.required, ["job_id"]);
  assert.equal(statusTool.inputSchema.properties?.job_id?.type, "string");
});

test("status: missing/wrong-typed job_id returns isError: true, not a thrown error", () => {
  assert.doesNotThrow(() => statusTool.handler(undefined));
  assertToolError(statusTool.handler(undefined), "job_id");
  assertToolError(statusTool.handler({}), "job_id");
  assertToolError(statusTool.handler({ job_id: 7 }), "job_id");
  assertToolError(statusTool.handler({ job_id: "" }), "job_id");
});

// An unknown job_id stays a clean typed not-found result.
test("(green control) status on an unknown job_id is a typed not-found isError result, never a thrown error", () => {
  assert.doesNotThrow(() => statusTool.handler({ job_id: "no-such-job-ghantika-status-test" }));
  assertToolError(
    statusTool.handler({ job_id: "no-such-job-ghantika-status-test" }),
    'no job with job_id "no-such-job-ghantika-status-test"'
  );
});

// The message must disclose that job ids are scoped to the server process
// that started them - never a bare "not found" that reads as proof the id
// was invalid, when it may simply be live in a different ghantika instance.
test("status on an unknown job_id discloses per-server-process job scoping, not a bare not-found", () => {
  const result = statusTool.handler({ job_id: "no-such-job-ghantika-status-test" });
  assertToolError(result, "scoped to the server process");
  assertToolError(result, "different one");
});

describe("status: dispatches through the real run tool's policy gate (via a real run() call)", () => {
  // Asserts the resulting job's state is one of ["starting", "running",
  // "exited"] - a policy-denied job settles "failed" instead, so this
  // genuinely needs the ambient policy to ALLOW "true", not merely to be
  // reached. See this file's own top-of-file comment.
  before(requireSpawnPolicy);

  test("status: a real job's status is queryable immediately after run(), never the old not-implemented stub message", () => {
    const runResult = runTool.handler({ command: ["true"] });
    const jobId = (runResult.structuredContent as Record<string, unknown>).job_id as string;
    const statusResult = statusTool.handler({ job_id: jobId });
    assert.notEqual(statusResult.isError, true);
    assert.ok(
      statusResult.content[0]!.type === "text" &&
        !statusResult.content[0]!.text.includes("not implemented yet")
    );
    const structured = statusResult.structuredContent as Record<string, unknown>;
    assert.equal(structured.job_id, jobId);
    assert.ok(["starting", "running", "exited"].includes(structured.state as string));
    assert.equal(typeof structured.started_at, "string");
  });
});

// status() must never fabricate exit_code on a failed job.
//
// Checked by VALUE (=== undefined), not by the `in` operator: toPublicProjection's
// return object literal always assigns the `exit_code`/`signal` keys (see
// jobStore.ts), just with value `undefined` for a non-matching state - so
// `"exit_code" in structured` is true REGARDLESS of state at this in-process
// unit-test layer (before any JSON-RPC serialization strips undefined-valued
// keys, which is what test/e2e-server.test.ts's wire-level test observes
// instead). A value check is what actually distinguishes "faithfully
// undefined" from "fabricated" here.
test("a failed job's status carries diagnostic + ended_at, and NEVER fabricates exit_code/signal", () => {
  const runResult = runTool.handler({
    command: ["this-command-definitely-does-not-exist-ghantika-status-nullability"],
  });
  const jobId = (runResult.structuredContent as Record<string, unknown>).job_id as string;
  const structured = statusTool.handler({ job_id: jobId }).structuredContent as Record<
    string,
    unknown
  >;
  assert.equal(structured.state, "failed");
  assert.equal(typeof structured.ended_at, "string");
  assert.equal(
    structured.exit_code,
    undefined,
    "a failed job must never carry a real exit_code value"
  );
  assert.equal(structured.signal, undefined, "a failed job must never carry a real signal value");
  assert.ok(structured.diagnostic, "a failed job must carry a diagnostic");
});

describe("status: dispatches through the real run tool's policy gate (live-transition polling)", () => {
  // Asserts the resulting job's INITIAL state is one of ["starting",
  // "running"] and later polls to "exited" - a policy-denied job settles
  // "failed" immediately instead, so this genuinely needs the ambient
  // policy to ALLOW the spawned node subprocess, not merely to be reached.
  // See this file's own top-of-file comment.
  before(requireSpawnPolicy);

  // status() must read fresh on every call, never a cached snapshot.
  test("status: reflects a job's live state transitions across separate calls, never a stale cached snapshot", async () => {
    const runResult = runTool.handler({ command: [process.execPath, "-e", "process.exit(0)"] });
    const jobId = (runResult.structuredContent as Record<string, unknown>).job_id as string;
    const first = statusTool.handler({ job_id: jobId }).structuredContent as Record<
      string,
      unknown
    >;
    assert.ok(
      ["starting", "running"].includes(first.state as string),
      `expected a non-terminal state right after run(), got ${first.state as string}`
    );

    const deadline = Date.now() + 5000;
    let last: Record<string, unknown> = first;
    while (Date.now() < deadline) {
      last = statusTool.handler({ job_id: jobId }).structuredContent as Record<string, unknown>;
      if (last.state === "exited") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      last.state,
      "exited",
      "a later status() call must observe the job's real, fresh terminal state"
    );
  });
});

// A syntactically-valid but unknown job_id must be a typed not-found error,
// never the old "not implemented yet" stub message and never a silent success.
test("output/tail: a syntactically-valid but unknown job_id is a typed not-found error, never the old stub message", () => {
  for (const mod of [outputTool, tailTool]) {
    const result = mod.handler({ job_id: "some-job-id-that-does-not-exist" });
    assertToolError(result, 'no job with job_id "some-job-id-that-does-not-exist"');
    assertToolError(result, "scoped to the server process");
    assert.ok(
      !(
        result.content[0]!.type === "text" &&
        result.content[0]!.text.includes("not implemented yet")
      )
    );
  }
});

// ---------------------------------------------------------------------------
// list: real implementation
// ---------------------------------------------------------------------------

test("list: schema declares no required arguments", () => {
  assert.ok(
    listTool.inputSchema.required === undefined || listTool.inputSchema.required.length === 0
  );
});

describe("list: dispatches through the real run tool's policy gate (via a real run() call)", () => {
  // Asserts the enumerated job's state is one of ["starting", "running",
  // "exited"] - a policy-denied job settles "failed" instead, so this
  // genuinely needs the ambient policy to ALLOW "true", not merely to be
  // reached. See this file's own top-of-file comment.
  before(requireSpawnPolicy);

  test("list: enumerates a real job immediately after run(), never the old not-implemented stub message", () => {
    const runResult = runTool.handler({ command: ["true"], label: "ghantika-list-unit-test" });
    const jobId = (runResult.structuredContent as Record<string, unknown>).job_id as string;
    const listResult = listTool.handler();
    assert.notEqual(listResult.isError, true);
    assert.ok(
      listResult.content[0]!.type === "text" &&
        !listResult.content[0]!.text.includes("not implemented yet")
    );
    const jobs = (listResult.structuredContent as Record<string, unknown>).jobs as Array<
      Record<string, unknown>
    >;
    const found = jobs.find((j) => j.job_id === jobId);
    assert.ok(found, "the job just created via run() must appear in list()'s output");
    assert.equal(found?.label, "ghantika-list-unit-test");
    assert.ok(["starting", "running", "exited"].includes(found?.state as string));
    assert.equal(typeof found?.started_at, "string");
    assert.equal("job_id" in found!, true);
    assert.equal(
      Object.keys(found!).sort().join(","),
      ["job_id", "label", "started_at", "state", "queue_position"].sort().join(",")
    );
  });
});

test("list: the most-recently-created real job appears FIRST (most-recent-first ordering)", () => {
  const first = runTool.handler({ command: ["true"], label: "ghantika-list-order-a" });
  const second = runTool.handler({ command: ["true"], label: "ghantika-list-order-b" });
  const firstId = (first.structuredContent as Record<string, unknown>).job_id as string;
  const secondId = (second.structuredContent as Record<string, unknown>).job_id as string;
  const jobs = (listTool.handler().structuredContent as Record<string, unknown>).jobs as Array<
    Record<string, unknown>
  >;
  const firstIndex = jobs.findIndex((j) => j.job_id === firstId);
  const secondIndex = jobs.findIndex((j) => j.job_id === secondId);
  assert.ok(firstIndex !== -1 && secondIndex !== -1, "both jobs must be present");
  assert.ok(
    secondIndex < firstIndex,
    "the job created SECOND must sort BEFORE the job created first (most-recent-first)"
  );
});

// The comparator itself, tested in isolation against hand-constructed
// fixtures sharing a LITERAL identical started_at (never relying on insertion-order-reversal alone).
test("compareMostRecentFirst tie-breaks jobs sharing an identical started_at by DESCENDING seq", () => {
  const sameTimestamp = "2026-01-01T00:00:00.000Z";
  const older = { started_at: sameTimestamp, seq: 5 } as Parameters<
    typeof listTool.compareMostRecentFirst
  >[0];
  const newer = { started_at: sameTimestamp, seq: 9 } as Parameters<
    typeof listTool.compareMostRecentFirst
  >[0];
  assert.ok(
    listTool.compareMostRecentFirst(newer, older) < 0,
    "the higher-seq (more-recently-created) job must sort BEFORE the lower-seq job when started_at is identical"
  );
  assert.ok(listTool.compareMostRecentFirst(older, newer) > 0);
  assert.equal(listTool.compareMostRecentFirst(older, older), 0);
  const jobs = [older, newer];
  jobs.sort(listTool.compareMostRecentFirst);
  assert.deepEqual(
    jobs.map((j) => j.seq),
    [9, 5],
    "sorting a real array with Array.prototype.sort must produce newer-seq-first"
  );
});

test("compareMostRecentFirst: a strictly later started_at always sorts first, regardless of seq", () => {
  const earlier = { started_at: "2026-01-01T00:00:00.000Z", seq: 99 } as Parameters<
    typeof listTool.compareMostRecentFirst
  >[0];
  const later = { started_at: "2026-01-01T00:00:01.000Z", seq: 1 } as Parameters<
    typeof listTool.compareMostRecentFirst
  >[0];
  assert.ok(listTool.compareMostRecentFirst(later, earlier) < 0);
  assert.ok(listTool.compareMostRecentFirst(earlier, later) > 0);
});
