/**
 * Real end-to-end coverage for the io.modelcontextprotocol/tasks adapter:
 * every test here drives a REAL `@modelcontextprotocol/client` `Client`
 * against a REAL `createServer()` instance over the SDK's own
 * `InMemoryTransport` (the same pattern `test/jobStore.test.ts`'s
 * singleton-sharing regression already uses) - never a bypass straight to
 * `dispatchToolCall` or `tasksAdapter`'s functions in isolation, because
 * the contract under test is what a real client observes on the wire:
 * capability negotiation, the six-tool mint rule, the three registered
 * task methods, and the always-on plain poll floor.
 *
 * `startPair(capable)` builds one such real Client/Server pair, optionally
 * advertising `io.modelcontextprotocol/tasks` in the CLIENT's own
 * `initialize` capabilities - this is deliberately the ONLY per-test knob;
 * nothing here ever sets a per-request opt-in field, which is itself part
 * of what proves minting is connection-level, not per-request.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { CallToolResult, StandardSchemaV1 } from "@modelcontextprotocol/server";

// Imports the BUILT output, not src/ directly - see test/registry.test.ts's
// import comment for why.
import { createServer } from "../dist/server.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  TASK_STATUSES,
  TASKS_EXTENSION_URI,
  isTaskStatusValue,
  taskIdParamsSchema,
} from "../dist/tasksAdapter.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA_PATH = path.join(REPO_ROOT, "schema", "tasks-extension.schema.json");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Pair {
  readonly client: Client;
  readonly close: () => Promise<void>;
}

let pairCounter = 0;

async function startPair(capable: boolean): Promise<Pair> {
  pairCounter += 1;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const instance = createServer(serverTransport);
  await instance.server.connect(instance.transport);

  const client = new Client(
    { name: `ghantika-tasks-test-client-${pairCounter}`, version: "0.0.0" },
    capable ? { capabilities: { extensions: { [TASKS_EXTENSION_URI]: {} } } } : {}
  );
  await client.connect(clientTransport);

  return {
    client,
    close: () => instance.shutdown("tasks.test.ts complete"),
  };
}

/** A permissive Standard Schema that accepts any value unchanged - used only to read the raw result of a custom (non-spec) request via `Client.request`, mirroring `src/tasksAdapter.ts`'s own hand-rolled `taskIdParamsSchema` rather than pulling in a real validation library for a test-only need. */
function passthroughResultSchema(): StandardSchemaV1<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "ghantika-tasks-test",
      validate: (value: unknown) => ({ value }),
    },
  };
}

async function tasksRequest(
  client: Client,
  method: "tasks/get" | "tasks/update" | "tasks/cancel",
  taskId: string
): Promise<Record<string, unknown>> {
  const result = await client.request({ method, params: { taskId } }, passthroughResultSchema());
  return result as Record<string, unknown>;
}

function runResultStructured(result: CallToolResult | unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  assert.equal(typeof structured, "object");
  return structured as Record<string, unknown>;
}

async function runJob(
  client: Client,
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: "run",
    arguments: { command: ["true"], ...overrides },
  });
  assert.notEqual((result as { isError?: boolean }).isError, true);
  return runResultStructured(result);
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A real `Date#toISOString()` shape - shared by every check below that validates a genuinely nondeterministic (real wall-clock) timestamp field's FORMAT rather than skipping it outright. */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Validates that `record[field]` is a real ISO-8601 millisecond timestamp
 * for every field in `fields`, then returns a COPY of `record` with those
 * fields deleted - so the caller can still run a genuine `assert.deepEqual`
 * against a literal expected object for every OTHER field, without having
 * to skip timestamp fields' verification entirely.
 *
 * IMPORTANT: this ONLY checks shape (a real `Date#toISOString()` pattern) -
 * it does NOT by itself prove the value is genuine rather than a
 * stable-but-wrong placeholder. A hardcoded `"2000-01-01T00:00:00.000Z"`
 * is a perfectly valid ISO-8601 millisecond timestamp and would pass this
 * check alone; this exact escape was previously demonstrated on the kill
 * path (a stable, wrong `started_at` survived format- and order-checking
 * undetected).
 * Closing that gap is the CALLER's job, not this helper's: every call
 * site below additionally brackets the parsed timestamp against a real
 * wall-clock window the test itself captured immediately before starting
 * the job and immediately after observing its result (see the
 * `beforeFirstJobMs`/`afterFirstJobMs` and `beforeSecondJobMs`/
 * `afterKillMs` pairs in the six-tool mint rule test below), so a value
 * outside that live window - hardcoded or otherwise stale - is rejected
 * even though it is perfectly ISO-shaped.
 */
function withTimestampFieldsChecked(
  record: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> {
  const rest = { ...record };
  for (const field of fields) {
    assert.match(
      rest[field] as string,
      ISO_TIMESTAMP_PATTERN,
      `expected "${field}" to be a real ISO-8601 millisecond timestamp, got ${JSON.stringify(rest[field])}`
    );
    delete rest[field];
  }
  return rest;
}

async function pollUntilTerminal(
  client: Client,
  jobId: string,
  maxAttempts = 100
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await client.callTool({ name: "status", arguments: { job_id: jobId } });
    const structured = runResultStructured(result);
    if (
      structured.state === "exited" ||
      structured.state === "killed" ||
      structured.state === "failed"
    ) {
      return structured;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${jobId} never reached a terminal state within ${maxAttempts} polls`);
}

// ---------------------------------------------------------------------------
// The vendored schema itself - loaded fresh from disk, never hand-copied,
// so every assertion below that "validates against the schema" or "matches
// the schema's status enum" is checked against the REAL, digest-verified
// file (see scripts/check-sdk-exact-pin.mjs / test/check-sdk-exact-pin.test.js
// for the digest-enforcement half of that same pin).
// ---------------------------------------------------------------------------

type JsonSchemaNode = Record<string, unknown>;

interface TasksSchema {
  readonly $defs: Record<string, JsonSchemaNode>;
}

function loadSchema(): TasksSchema {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as TasksSchema;
}

/**
 * Resolves a LOCAL, fragment-only `$ref` (`"#/$defs/taskResult"`, the only
 * form this vendored schema ever uses - confirmed by reading the whole
 * file, never an external URI) against the schema's own root object.
 */
function resolveLocalRef(rootSchema: TasksSchema, ref: string): JsonSchemaNode {
  const segments = ref.replace(/^#\//, "").split("/");
  let node: unknown = rootSchema;
  for (const segment of segments) {
    node = (node as Record<string, unknown>)[segment];
  }
  return node as JsonSchemaNode;
}

/**
 * A REAL, GENUINE JSON Schema validator - not a partial approximation -
 * for exactly the keyword set `schema/tasks-extension.schema.json` (the
 * vendored, digest-verified schema this adapter's results are pinned
 * against) actually uses: `$ref` resolution, `oneOf`, `const`, `enum`,
 * `type` (`object`/`string`/`integer`), `properties`, `required`,
 * `additionalProperties`, `minLength`, `minimum`, `exclusiveMinimum`. See
 * `src/tasksAdapter.ts`'s own `taskIdParamsSchema` doc comment for why
 * this repo hand-rolls small schema-shaped checks rather than adding an
 * undeclared JSON Schema validator dependency (`zod`/`ajv` are both
 * reachable transitively today, through `@modelcontextprotocol/server` and
 * through `eslint` respectively, but neither is a direct dependency of
 * this repo's own package.json - importing either here would be exactly
 * the class of phantom dependency `check-sdk-exact-pin.mjs` exists to rule
 * out for the packages it DOES pin, the same reasoning `taskIdParamsSchema`
 * already applies to its own hand-rolled Standard Schema). This function
 * is deliberately NOT a general-purpose JSON Schema engine - a keyword
 * this vendored schema never uses (`patternProperties`, `allOf`, `anyOf`,
 * numeric `maximum`, string `pattern`, array validation, and more) is not
 * implemented, and a schema node this function does not recognise reds
 * LOUDLY (an "unsupported schema node" problem) rather than silently
 * passing everything through - the earlier, hollow version of this helper
 * checked only required-key presence and additional-property names, so a
 * response could carry the wrong TYPE, the wrong `const`/`enum` value, an
 * empty `taskId` violating `minLength: 1`, or a numeric field violating
 * `minimum`/`exclusiveMinimum`, and every one of those would still read as
 * "validated" - this function actually checks all of them, reading the
 * REAL parsed schema object, never a re-typed description of it, so a
 * change to the vendored schema's constraints is reflected here
 * automatically.
 *
 * @param rootSchema the whole parsed schema document, for `$ref` resolution
 * @param schemaNode the sub-schema `value` is checked against
 * @param value the value under test
 * @param path a human-readable location, for problem messages only
 * @returns every problem found; empty means `value` is valid against `schemaNode`
 */
function validateAgainstSchema(
  rootSchema: TasksSchema,
  schemaNode: JsonSchemaNode,
  value: unknown,
  path: string
): string[] {
  if (typeof schemaNode.$ref === "string") {
    return validateAgainstSchema(
      rootSchema,
      resolveLocalRef(rootSchema, schemaNode.$ref),
      value,
      path
    );
  }

  if (Array.isArray(schemaNode.oneOf)) {
    const branchResults = (schemaNode.oneOf as JsonSchemaNode[]).map((branch) =>
      validateAgainstSchema(rootSchema, branch, value, path)
    );
    const matchingBranches = branchResults.filter((problems) => problems.length === 0);
    if (matchingBranches.length === 1) return [];
    return [
      `${path}: expected exactly one "oneOf" branch to validate, ${matchingBranches.length} did (branch problems: ${JSON.stringify(branchResults)})`,
    ];
  }

  if ("const" in schemaNode) {
    return value === schemaNode.const
      ? []
      : [
          `${path}: expected const ${JSON.stringify(schemaNode.const)}, got ${JSON.stringify(value)}`,
        ];
  }

  if (Array.isArray(schemaNode.enum)) {
    return schemaNode.enum.includes(value)
      ? []
      : [
          `${path}: expected one of ${JSON.stringify(schemaNode.enum)}, got ${JSON.stringify(value)}`,
        ];
  }

  if (schemaNode.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [`${path}: expected an object, got ${JSON.stringify(value)}`];
    }
    const problems: string[] = [];
    const obj = value as Record<string, unknown>;
    const properties = (schemaNode.properties as Record<string, JsonSchemaNode> | undefined) ?? {};
    const required = (schemaNode.required as readonly string[] | undefined) ?? [];
    for (const key of required) {
      if (!(key in obj)) problems.push(`${path}: missing required property "${key}"`);
    }
    if (schemaNode.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) problems.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in obj) {
        problems.push(...validateAgainstSchema(rootSchema, subSchema, obj[key], `${path}.${key}`));
      }
    }
    return problems;
  }

  if (schemaNode.type === "string") {
    if (typeof value !== "string")
      return [`${path}: expected a string, got ${JSON.stringify(value)}`];
    const minLength = schemaNode.minLength as number | undefined;
    if (typeof minLength === "number" && value.length < minLength) {
      return [`${path}: expected length >= ${minLength}, got ${value.length} ("${value}")`];
    }
    return [];
  }

  if (schemaNode.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return [`${path}: expected an integer, got ${JSON.stringify(value)}`];
    }
    const problems: string[] = [];
    const minimum = schemaNode.minimum as number | undefined;
    if (typeof minimum === "number" && value < minimum) {
      problems.push(`${path}: expected >= ${minimum}, got ${value}`);
    }
    const exclusiveMinimum = schemaNode.exclusiveMinimum as number | undefined;
    if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
      problems.push(`${path}: expected > ${exclusiveMinimum}, got ${value}`);
    }
    return problems;
  }

  return [
    `${path}: unsupported schema node ${JSON.stringify(schemaNode)} - this validator only implements the keywords schema/tasks-extension.schema.json actually uses`,
  ];
}

function validatesAsTaskResult(schema: TasksSchema, value: unknown): string[] {
  return validateAgainstSchema(
    schema,
    resolveLocalRef(schema, "#/$defs/taskResult"),
    value,
    "taskResult"
  );
}

function validatesAsTaskNotFound(schema: TasksSchema, value: unknown): string[] {
  return validateAgainstSchema(
    schema,
    resolveLocalRef(schema, "#/$defs/taskNotFound"),
    value,
    "taskNotFound"
  );
}

// ---------------------------------------------------------------------------
// The schema validator's own mutation controls: proving validateAgainstSchema
// GENUINELY enforces the vendored schema's real constraints - type, minLength,
// const, enum, and the numeric minimum/exclusiveMinimum bounds - not merely
// required-key presence and additional-property names (the earlier, hollow
// version of this helper). Every RED case below is a value the old helper
// would have called "valid".
// ---------------------------------------------------------------------------

const VALID_TASK_RESULT: Record<string, unknown> = {
  extension: TASKS_EXTENSION_URI,
  taskId: "11111111-1111-4111-8111-111111111111",
  status: "working",
  createdAt: "2026-01-01T00:00:00.000Z",
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
};

const VALID_TERMINAL_TASK_RESULT: Record<string, unknown> = {
  ...VALID_TASK_RESULT,
  status: "completed",
  exitCode: 0,
  output: { stdout_lines: 1, stdout_bytes: 10, stderr_lines: 0, stderr_bytes: 0 },
};

const VALID_TASK_NOT_FOUND: Record<string, unknown> = {
  extension: TASKS_EXTENSION_URI,
  error: "task_not_found",
  taskId: "11111111-1111-4111-8111-111111111111",
};

test("green control: a genuinely valid, minimal taskResult (no optional fields) passes schema validation", () => {
  const schema = loadSchema();
  assert.deepEqual(validatesAsTaskResult(schema, VALID_TASK_RESULT), []);
});

test("green control: a genuinely valid, terminal taskResult (with exitCode + output) passes schema validation", () => {
  const schema = loadSchema();
  assert.deepEqual(validatesAsTaskResult(schema, VALID_TERMINAL_TASK_RESULT), []);
});

test("green control: a genuinely valid taskNotFound passes schema validation", () => {
  const schema = loadSchema();
  assert.deepEqual(validatesAsTaskNotFound(schema, VALID_TASK_NOT_FOUND), []);
});

test("mutation control: an INVALID-TYPE taskId (a number instead of a string) is caught - the hollow helper never checked types at all", () => {
  const schema = loadSchema();
  const problems = validatesAsTaskResult(schema, { ...VALID_TASK_RESULT, taskId: 12345 });
  assert.ok(problems.length > 0, "a numeric taskId must fail schema validation");
  assert.ok(
    problems.some((p) => /expected a string/.test(p)),
    `got: ${JSON.stringify(problems)}`
  );
});

test("mutation control: an EMPTY-STRING taskId is caught - violates the schema's minLength: 1, which the hollow helper never checked", () => {
  const schema = loadSchema();
  const problems = validatesAsTaskResult(schema, { ...VALID_TASK_RESULT, taskId: "" });
  assert.ok(problems.length > 0, "an empty taskId must fail schema validation");
  assert.ok(
    problems.some((p) => /minLength|length >=/.test(p)),
    `got: ${JSON.stringify(problems)}`
  );
});

test("mutation control: an INVALID status enum value is caught - violates the schema's closed taskStatus enum, which the hollow helper never checked", () => {
  const schema = loadSchema();
  const problems = validatesAsTaskResult(schema, { ...VALID_TASK_RESULT, status: "bogus-status" });
  assert.ok(problems.length > 0, "an out-of-enum status must fail schema validation");
  assert.ok(
    problems.some((p) => /expected one of/.test(p)),
    `got: ${JSON.stringify(problems)}`
  );
});

test("mutation control: an INVALID NUMERIC BOUNDARY - pollIntervalMs of 0 - is caught, violating the schema's exclusiveMinimum: 0 (must be strictly positive)", () => {
  const schema = loadSchema();
  const problems = validatesAsTaskResult(schema, { ...VALID_TASK_RESULT, pollIntervalMs: 0 });
  assert.ok(
    problems.length > 0,
    "a zero pollIntervalMs must fail schema validation (exclusiveMinimum: 0)"
  );
});

test("mutation control: a NEGATIVE nested output count (stdout_bytes: -1) is caught, violating taskOutputCounts' minimum: 0 - a NESTED $ref-resolved constraint the hollow helper never descended into", () => {
  const schema = loadSchema();
  const problems = validatesAsTaskResult(schema, {
    ...VALID_TERMINAL_TASK_RESULT,
    output: { ...(VALID_TERMINAL_TASK_RESULT.output as object), stdout_bytes: -1 },
  });
  assert.ok(problems.length > 0, "a negative stdout_bytes must fail schema validation");
  assert.ok(
    problems.some((p) => /expected >= 0/.test(p)),
    `got: ${JSON.stringify(problems)}`
  );
});

test("mutation control: a NESTED-OUTPUT-SHAPE violation - an unexpected extra key inside output - is caught, since taskOutputCounts sets additionalProperties: false", () => {
  const schema = loadSchema();
  const problems = validatesAsTaskResult(schema, {
    ...VALID_TERMINAL_TASK_RESULT,
    output: { ...(VALID_TERMINAL_TASK_RESULT.output as object), unexpected_field: 1 },
  });
  assert.ok(problems.length > 0, "an extra key inside output must fail schema validation");
  assert.ok(
    problems.some((p) => /unexpected property "unexpected_field"/.test(p)),
    `got: ${JSON.stringify(problems)}`
  );
});

test("mutation control: taskNotFound's wrong error const value is caught - the fixed 'task_not_found' discriminator is a const, not a free-form string", () => {
  const schema = loadSchema();
  const problems = validatesAsTaskNotFound(schema, { ...VALID_TASK_NOT_FOUND, error: "not_found" });
  assert.ok(problems.length > 0, "a wrong error const must fail schema validation");
  assert.ok(
    problems.some((p) => /expected const/.test(p)),
    `got: ${JSON.stringify(problems)}`
  );
});

test("mutation control: taskNotFound's empty taskId is caught too - the same minLength: 1 pin applies here, directly (not via a $ref)", () => {
  const schema = loadSchema();
  const problems = validatesAsTaskNotFound(schema, { ...VALID_TASK_NOT_FOUND, taskId: "" });
  assert.ok(
    problems.length > 0,
    "an empty taskId must fail schema validation on the not-found shape too"
  );
});

// ---------------------------------------------------------------------------
// Capability advertisement: the initialize result's capabilities include
// io.modelcontextprotocol/tasks
// ---------------------------------------------------------------------------

test("the server advertises io.modelcontextprotocol/tasks in its initialize-negotiated capabilities, on both a capable and a non-capable client connection", async () => {
  for (const capable of [true, false]) {
    const pair = await startPair(capable);
    try {
      const serverCapabilities = pair.client.getServerCapabilities();
      assert.ok(
        serverCapabilities?.extensions,
        "expected the server to advertise an extensions bag"
      );
      assert.ok(
        Object.hasOwn(serverCapabilities!.extensions!, TASKS_EXTENSION_URI),
        `expected "${TASKS_EXTENSION_URI}" among the advertised extensions, got: ${JSON.stringify(serverCapabilities?.extensions)}`
      );
    } finally {
      await pair.close();
    }
  }
});

// ---------------------------------------------------------------------------
// The six-tool mint rule: run() mints unsolicited on a capable connection,
// with no per-request opt-in field involved at all
// ---------------------------------------------------------------------------

test("a Tasks-advertised connection gets an unsolicited server-minted task handle on a bare run() call - no opt-in field anywhere in the request", async () => {
  const pair = await startPair(true);
  try {
    const structured = await runJob(pair.client, { label: "mint-unsolicited" });
    assert.equal(structured.extension, TASKS_EXTENSION_URI);
    assert.equal(typeof structured.taskId, "string");
    assert.equal(structured.status, "working");
    assert.equal(
      structured.job_id,
      undefined,
      "the plain {job_id} shape must not also appear on a minted result"
    );
  } finally {
    await pair.close();
  }
});

test("on a capable connection, run() mints a CreateTaskResult even though the call carries no request-level capability/task field whatsoever - minting depends only on the connection", async () => {
  const pair = await startPair(true);
  try {
    // Deliberately no `task`, no `_meta`, no capability-shaped argument of
    // any kind beyond what `run` already accepts - proving the mint
    // decision reads nothing from the individual request.
    const structured = await runJob(pair.client, { command: ["true"], label: "no-opt-in-field" });
    assert.equal(structured.extension, TASKS_EXTENSION_URI);
    assert.equal(typeof structured.taskId, "string");
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// A non-capable connection is byte-stable with the plain {job_id} shape -
// no CreateTaskResult ever appears
// ---------------------------------------------------------------------------

test("a non-capable connection's run() returns the plain job projection - a genuine deep-equality check of the COMPLETE real plain PublicJobProjection response across BOTH structuredContent and content, key set AND field values (started_at format-checked AND bracketed against a real wall-clock window this test itself observed around the run() call, so a stable-but-wrong ISO value cannot survive), not just presence/absence of a few named fields", async () => {
  const pair = await startPair(false);
  try {
    // Not `runJob` here, deliberately - that helper (see `runResultStructured`
    // above) discards `CallToolResult.content` entirely and returns only
    // `structuredContent`, which is exactly the gap previously demonstrated
    // for this test: a mutant changing ONLY `content` (leaving
    // `structuredContent` untouched) still passed. The raw `CallToolResult`
    // is kept here so both halves of the real tool result can be checked.
    //
    // beforeRunMs/afterRunMs bracket the actual run() call below - the
    // real wall-clock window this test itself observed the job start in,
    // used to bind started_at to a genuine observation rather than only
    // its ISO shape (the same class of gap previously demonstrated on the
    // six-tool mint rule test's status/kill checks).
    const beforeRunMs = Date.now();
    const result = await pair.client.callTool({
      name: "run",
      arguments: { command: ["true"], label: "plain-poll-floor" },
    });
    const afterRunMs = Date.now();
    assert.notEqual((result as { isError?: boolean }).isError, true);
    const structured = runResultStructured(result);
    assert.equal(typeof structured.job_id, "string");
    assert.equal(
      structured.extension,
      undefined,
      "a non-capable connection must never see the Tasks discriminator"
    );
    assert.equal(
      structured.taskId,
      undefined,
      "a non-capable connection must never see a minted taskId field"
    );

    // The COMPLETE key set the real PublicJobProjection shape carries -
    // see src/jobStore.ts's own toPublicProjection, which always writes
    // all twelve fields (the six optional ones included, EXPLICITLY as
    // `undefined` when a job hasn't reached that point yet - verified
    // empirically here rather than assumed: InMemoryTransport passes the
    // structured content through without an actual JSON.stringify pass,
    // so an `undefined`-valued own property survives as a present key,
    // unlike what a real JSON-serialized wire would show). This is the
    // genuine deep-equality this test previously lacked: the old
    // assertion only checked for the ABSENCE of two Tasks-specific fields
    // and the PRESENCE of three others, which would still pass even if a
    // mutant added a stray extra field or silently dropped a real one.
    assert.deepEqual(
      Object.keys(structured).sort(),
      [
        "command_summary",
        "counts",
        "diagnostic",
        "ended_at",
        "escalation_refused_reason",
        "exit_code",
        "identity_capture",
        "identity_confirmed",
        "job_id",
        "kill_confirmed",
        "label",
        "queue_position",
        "signal",
        "started_at",
        "state",
      ].sort(),
      `expected the plain projection's key set to deep-equal the real plain job-projection shape exactly, got: ${JSON.stringify(Object.keys(structured).sort())}`
    );
    assert.equal(
      structured.state,
      "starting",
      "a freshly-started job's synchronous projection must be exactly 'starting'"
    );
    // The five fields that are only meaningful once a job progresses/ends
    // must be genuinely unset at this fresh, synchronous point - not a
    // placeholder value of any kind. kill_confirmed/identity_confirmed
    // join them here: the eager reap-at-exit that can set kill_confirmed
    // on an otherwise-never-killed job only fires once the leader has
    // actually exited, which this freshly-"starting" job has not yet done.
    // escalation_refused_reason joins them too: it is only ever written
    // once an actual escalation attempt has been refused, which cannot
    // have happened yet either.
    for (const key of [
      "ended_at",
      "exit_code",
      "signal",
      "diagnostic",
      "queue_position",
      "kill_confirmed",
      "identity_confirmed",
      "escalation_refused_reason",
    ]) {
      assert.equal(
        structured[key],
        undefined,
        `expected "${key}" to be unset on a freshly-started job, got ${JSON.stringify(structured[key])}`
      );
    }
    // identity_capture is unlike the five above: it is captured
    // asynchronously right after spawn (see captureBirthIdentityPosixAsync's
    // own docs) rather than being tied to the job's own progression, but at
    // this exact synchronous instant - immediately after run() returns,
    // before that real ps-based capture has had any chance to even start -
    // it must still genuinely read "pending", never a settled value it
    // could not possibly have reached yet.
    assert.equal(
      structured.identity_capture,
      "pending",
      `expected a freshly-started job's identity_capture to be "pending" at this synchronous instant, got ${JSON.stringify(structured.identity_capture)}`
    );

    // Key-set presence alone (the check above) does not prove any field's
    // VALUE is genuine rather than a stable-but-wrong placeholder (e.g. a
    // `started_at` of "not-a-real-timestamp" preserves both the type and
    // the key set and would still have passed here before this fix - and,
    // more subtly, a stable-but-WRONG ISO-shaped value like
    // "2000-01-01T00:00:00.000Z" would ALSO still pass a format-only check,
    // which is exactly the escape previously demonstrated on this suite's
    // six-tool mint rule test). The real, produced values are checked
    // directly below:
    // `label` is exactly what this call passed, `command_summary` is the
    // real argv[0] basename of the default `["true"]` command (see
    // `computeCommandSummary` in src/jobStore.ts), `started_at` is checked
    // BOTH for its real `Date#toISOString()` shape AND for falling inside
    // `[beforeRunMs, afterRunMs]` - the real wall-clock window this test
    // itself captured around the actual run() call - so a stable-but-wrong
    // ISO value cannot survive undetected, and `counts` is a genuine
    // deep-equal against the exact zero object a freshly-registered job's
    // synchronous projection always carries (subsuming the key-set check
    // the old assertion stopped at).
    assert.equal(
      structured.label,
      "plain-poll-floor",
      "expected the real label supplied to run(), not a placeholder"
    );
    assert.equal(
      structured.command_summary,
      "true",
      'expected the real argv[0] basename of the default ["true"] command, not a placeholder'
    );
    assert.match(
      structured.started_at as string,
      ISO_TIMESTAMP_PATTERN,
      `expected started_at to be a real ISO-8601 millisecond timestamp (Date#toISOString() shape), got ${JSON.stringify(structured.started_at)}`
    );
    const structuredStartedAtMs = Date.parse(structured.started_at as string);
    assert.ok(
      structuredStartedAtMs >= beforeRunMs && structuredStartedAtMs <= afterRunMs,
      `expected started_at (${JSON.stringify(structured.started_at)}) to fall inside the real wall-clock bracket [${beforeRunMs}, ${afterRunMs}] this test captured around the actual run() call - a stable-but-wrong ISO-shaped value would fall outside it`
    );
    assert.deepEqual(
      structured.counts,
      { stdout_lines: 0, stdout_bytes: 0, stderr_lines: 0, stderr_bytes: 0 },
      `expected the real, freshly-started zero counts by full value, not just the right key set - got ${JSON.stringify(structured.counts)}`
    );

    // `structuredContent` (checked completely above) is only HALF of the
    // real `CallToolResult` - `src/tools/run.ts`'s own `toolSuccess` also
    // builds a `content` block holding a real `JSON.stringify(projection,
    // null, 2)` of the SAME projection, not an empty stub (confirmed by
    // direct empirical probing while fixing this: it genuinely carries
    // this call's real values over this transport). A mutant changing ONLY
    // `content` - leaving `structuredContent` untouched - was previously
    // shown to still pass this test, because nothing here ever looked at
    // `content` at all. Checked directly below.
    const contentBlocks = (result as CallToolResult).content;
    assert.ok(
      Array.isArray(contentBlocks) && contentBlocks.length === 1,
      `expected exactly one content block, got ${JSON.stringify(contentBlocks)}`
    );
    const [contentBlock] = contentBlocks;
    assert.equal(
      (contentBlock as { type?: string }).type,
      "text",
      `expected the content block's type to be "text", got ${JSON.stringify(contentBlock)}`
    );
    const contentText = (contentBlock as { text?: unknown }).text;
    assert.equal(typeof contentText, "string", "expected the content block's text to be a string");

    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(contentText as string);
    } catch (error) {
      throw new Error(
        `expected content[0].text to be valid, parseable JSON - src/tools/run.ts's own toolSuccess builds it via JSON.stringify(projection, null, 2) - got ${JSON.stringify(contentText)}`,
        { cause: error }
      );
    }
    const parsedContentRecord = parsedContent as Record<string, unknown>;

    // `content`'s text underwent a REAL `JSON.stringify` pass (unlike
    // `structuredContent`, which the in-memory transport passes through
    // untouched - see the key-set comment above), and `JSON.stringify`
    // DROPS any object key whose value is `undefined`. So content's real,
    // honest serialization of this SAME freshly-started projection omits
    // exactly the seven fields confirmed `undefined` on `structured` above
    // (ended_at/exit_code/signal/diagnostic/queue_position/kill_confirmed/
    // identity_confirmed), while identity_capture - genuinely defined as
    // "pending" here, never undefined - survives the stringify pass and
    // stays present. Verified empirically while fixing this test, not
    // assumed.
    assert.deepEqual(
      Object.keys(parsedContentRecord).sort(),
      ["command_summary", "counts", "identity_capture", "job_id", "label", "started_at", "state"],
      `expected content's real JSON-serialized key set to be exactly the DEFINED PublicJobProjection fields (JSON.stringify drops undefined optional fields), got: ${JSON.stringify(Object.keys(parsedContentRecord).sort())}`
    );

    // The genuine cross-agreement: content and structuredContent must
    // describe the SAME job record, not two independently-built values
    // that merely happen to share a shape. Comparing against
    // `JSON.parse(JSON.stringify(structured))` (rather than `structured`
    // directly) accounts for the same undefined-key-dropping behavior on
    // the expected side too, so this is a genuine like-for-like agreement
    // check, not an artifact of the two objects having different key sets
    // by construction.
    assert.deepEqual(
      parsedContentRecord,
      JSON.parse(JSON.stringify(structured)),
      `expected content's parsed JSON to agree with structuredContent on every field it carries - got content=${JSON.stringify(parsedContentRecord)} vs structuredContent=${JSON.stringify(structured)}`
    );

    // And directly - not merely by delegating to the cross-check above -
    // the real values a mutant touching ONLY content's own construction
    // (leaving structuredContent's untouched) would have to fake
    // correctly to survive: this is exactly the previously-demonstrated
    // escape.
    assert.equal(parsedContentRecord.job_id, structured.job_id);
    assert.equal(parsedContentRecord.state, "starting");
    assert.equal(parsedContentRecord.label, "plain-poll-floor");
    assert.equal(parsedContentRecord.command_summary, "true");
    assert.match(
      parsedContentRecord.started_at as string,
      ISO_TIMESTAMP_PATTERN,
      `expected content's started_at to be a real ISO-8601 millisecond timestamp, got ${JSON.stringify(parsedContentRecord.started_at)}`
    );
    const contentStartedAtMs = Date.parse(parsedContentRecord.started_at as string);
    assert.ok(
      contentStartedAtMs >= beforeRunMs && contentStartedAtMs <= afterRunMs,
      `expected content's started_at (${JSON.stringify(parsedContentRecord.started_at)}) to fall inside the real wall-clock bracket [${beforeRunMs}, ${afterRunMs}] this test captured around the actual run() call - a stable-but-wrong ISO-shaped value would fall outside it`
    );
    assert.deepEqual(
      parsedContentRecord.counts,
      { stdout_lines: 0, stdout_bytes: 0, stderr_lines: 0, stderr_bytes: 0 },
      `expected content's counts to deep-equal the real, freshly-started zero counts, got ${JSON.stringify(parsedContentRecord.counts)}`
    );
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// The minted CreateTaskResult validates against the pinned, digest-verified
// schema and carries its discriminator
// ---------------------------------------------------------------------------

test("the minted CreateTaskResult validates against the real, digest-verified vendored schema and carries the extension discriminator", async () => {
  const pair = await startPair(true);
  try {
    const structured = await runJob(pair.client, { label: "schema-validate" });
    const schema = loadSchema();
    const problems = validatesAsTaskResult(schema, structured);
    assert.deepEqual(
      problems,
      [],
      `minted result failed schema validation: ${JSON.stringify(problems)}`
    );
    assert.equal(structured.extension, TASKS_EXTENSION_URI);
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// N mints produce N distinct, high-entropy (v4 UUID) taskIds
// ---------------------------------------------------------------------------

test("N mints on a capable connection produce N distinct, high-entropy v4-UUID-format taskIds", async () => {
  const pair = await startPair(true);
  try {
    const N = 12;
    const taskIds: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const structured = await runJob(pair.client, { label: `entropy-${i}` });
      taskIds.push(structured.taskId as string);
    }
    assert.equal(new Set(taskIds).size, N, "every minted taskId must be distinct");
    for (const id of taskIds) {
      assert.ok(UUID_V4_PATTERN.test(id), `taskId "${id}" is not a v4-UUID-shaped string`);
    }
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// The registered task method set deep-equals exactly {tasks/get,
// tasks/update, tasks/cancel} - set-equality, no legacy result/list surface,
// no seventh tool
// ---------------------------------------------------------------------------

test("the registered task method set is exactly {tasks/get, tasks/update, tasks/cancel} - no tasks/list, no tasks/result, no seventh method", async () => {
  const pair = await startPair(true);
  try {
    const structured = await runJob(pair.client, { label: "method-set-fixture" });
    const taskId = structured.taskId as string;

    // The three that must exist and succeed.
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"] as const) {
      const result = await tasksRequest(pair.client, method, taskId);
      assert.equal(
        result.extension,
        TASKS_EXTENSION_URI,
        `${method} must return a Tasks-shaped result`
      );
    }

    // The legacy surface must NOT exist - a real JSON-RPC method-not-found
    // error (-32601), not a well-formed response of any shape.
    for (const method of ["tasks/list", "tasks/result"]) {
      await assert.rejects(
        () => pair.client.request({ method, params: {} }, passthroughResultSchema()),
        (error: unknown) => {
          const message = String((error as { message?: unknown })?.message ?? error);
          return /-32601|not found|unknown method/i.test(message);
        },
        `expected ${method} to be unregistered (method not found)`
      );
    }
  } finally {
    await pair.close();
  }
});

test("the registered task/* method set is a genuine SET-EQUALITY over the server's OWN real registration mechanism, not merely '3 named methods answer and 2 named methods 404' - a REAL seventh handler injected into the live registry is caught, which the presence/absence check above cannot see since it never enumerates the registry at all", async () => {
  const [, serverTransport] = InMemoryTransport.createLinkedPair();
  const instance = createServer(serverTransport);
  await instance.server.connect(instance.transport);
  try {
    // The SDK's Protocol class exposes no PUBLIC way to enumerate its
    // registered methods - `_requestHandlers` is a real runtime Map,
    // merely typed `private` at compile time (TypeScript's `private` is
    // erased at emit; it does not exist as a runtime access restriction).
    // This is the actual, live registration mechanism `server.ts`'s own
    // `setRequestHandler` calls populate - introspecting it directly is
    // what makes this a SET-EQUALITY check over the real registry, rather
    // than trusting a fixed list of method-name strings this test happens
    // to try.
    const requestHandlers = (
      instance.server as unknown as { _requestHandlers: Map<string, unknown> }
    )._requestHandlers;
    assert.ok(
      requestHandlers instanceof Map,
      "expected the server's real request-handler registry to be a Map - this test's introspection technique itself needs revisiting if this changes"
    );

    const registeredTaskMethods = () =>
      [...requestHandlers.keys()].filter((method) => method.startsWith("tasks/")).sort();

    assert.deepEqual(
      registeredTaskMethods(),
      ["tasks/cancel", "tasks/get", "tasks/update"],
      `expected the registered tasks/* method set to deep-equal exactly {tasks/get, tasks/update, tasks/cancel}, got: ${JSON.stringify(registeredTaskMethods())}`
    );

    // Inject a REAL seventh tasks/* handler into the LIVE registry, using
    // the SAME 3-arg setRequestHandler form and the SAME params schema
    // src/server.ts's own real registrations use - this is a genuine
    // handler, callable exactly like the other three, not a fake entry.
    instance.server.setRequestHandler(
      "tasks/seventh",
      { params: taskIdParamsSchema() },
      async (params) => ({ extension: TASKS_EXTENSION_URI, taskId: params.taskId, injected: true })
    );

    const afterInjection = registeredTaskMethods();
    assert.deepEqual(
      afterInjection,
      ["tasks/cancel", "tasks/get", "tasks/seventh", "tasks/update"],
      "expected the injected 7th handler to be visible in the real registry - proving this introspection is live, not a stale snapshot"
    );
    assert.notDeepEqual(
      afterInjection,
      ["tasks/cancel", "tasks/get", "tasks/update"],
      "a genuine set-equality check must now DISAGREE with the frozen expected 3-method set once a 7th handler is live - this is exactly the escape previously demonstrated to slip past the old presence/absence check"
    );
  } finally {
    await instance.shutdown("tasks.test.ts complete");
  }
});

// ---------------------------------------------------------------------------
// The adapter's task-status set deep-equals the pinned schema's status enum
// exactly (set-equality), and 'expired' is not a member
// ---------------------------------------------------------------------------

test("TASK_STATUSES deep-equals the vendored schema's own status enum, by set-equality, and 'expired' is never a member", () => {
  const schema = loadSchema();
  const statusEnum = schema.$defs.taskStatus.enum as readonly string[];
  const schemaStatuses = [...statusEnum].sort();
  const adapterStatuses = [...TASK_STATUSES].sort();
  assert.deepEqual(
    adapterStatuses,
    schemaStatuses,
    `adapter status set ${JSON.stringify(adapterStatuses)} must deep-equal the schema enum ${JSON.stringify(schemaStatuses)}`
  );
  assert.ok(!TASK_STATUSES.includes("expired" as never));
  assert.ok(!statusEnum.includes("expired"));
  assert.equal(isTaskStatusValue("expired"), false);
  for (const status of TASK_STATUSES) {
    assert.equal(isTaskStatusValue(status), true);
  }
});

// ---------------------------------------------------------------------------
// tasks/get(taskId) resolves via the identity mapping to the SAME job
// status()/output() already reports, live, including after the job reaches
// a real terminal state (real exit code, real output - never a canned
// 'working')
// ---------------------------------------------------------------------------

test("tasks/get(taskId) resolves to the SAME job status()/output() reports - not just a matching taskId, but genuine cross-field agreement with the real status(), so a not-found-shaped or stale/wrong-status response carrying the same taskId cannot pass", async () => {
  const pair = await startPair(true);
  try {
    const structured = await runJob(pair.client, { label: "identity-mapping" });
    const taskId = structured.taskId as string;

    const statusResult = runResultStructured(
      await pair.client.callTool({ name: "status", arguments: { job_id: taskId } })
    );
    assert.equal(statusResult.job_id, taskId, "taskId must equal the real job_id");

    const taskGet = await tasksRequest(pair.client, "tasks/get", taskId);
    assert.equal(taskGet.taskId, taskId);

    // A not-found-shaped response carrying the SAME taskId (a plausible
    // mutant: a stale cache, or a lookup that fell through to a
    // fabricated not-found while still copying the requested taskId
    // through) would still satisfy the two checks above alone - excluded
    // here by requiring the real TaskResult shape, never the TaskNotFound
    // shape's `error` discriminator.
    assert.equal(
      taskGet.error,
      undefined,
      "a real, live tasks/get result must never carry the not-found discriminator"
    );
    assert.equal(taskGet.extension, TASKS_EXTENSION_URI);

    // The genuine cross-field agreement: tasks/get's status must map from
    // status()'s real job state via the documented mapping (never an
    // unrelated/stale status), and its createdAt must equal status()'s
    // real started_at - the SAME underlying JobRecord read twice, not two
    // different records that merely share a taskId.
    const expectedTaskStatus: Record<string, string> = {
      starting: "working",
      running: "working",
      exited: "completed",
      failed: "failed",
      killed: "cancelled",
    };
    const jobState = statusResult.state as string;
    assert.equal(
      taskGet.status,
      expectedTaskStatus[jobState],
      `expected tasks/get's status to map from status()'s real state "${jobState}" via the documented mapping, got ${JSON.stringify(taskGet.status)}`
    );
    assert.equal(
      taskGet.createdAt,
      statusResult.started_at,
      "tasks/get's createdAt must equal status()'s real started_at - the same underlying job record"
    );
  } finally {
    await pair.close();
  }
});

test("an unresolvable taskId produces the single fixed not-found shape, never a crash or a fabricated 'working' status", async () => {
  const pair = await startPair(true);
  try {
    const bogusId = "00000000-0000-4000-8000-000000000000";
    const schema = loadSchema();
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"] as const) {
      const result = await tasksRequest(pair.client, method, bogusId);
      assert.equal(result.error, "task_not_found");
      assert.equal(result.extension, TASKS_EXTENSION_URI);
      assert.equal(result.taskId, bogusId);
      assert.deepEqual(validatesAsTaskNotFound(schema, result), []);
    }
  } finally {
    await pair.close();
  }
});

test("an EMPTY-STRING taskId is REJECTED at the request-validation boundary on all three task methods, never silently echoed through to a task_not_found result - the vendored schema pins minLength: 1 on every taskId field, so a validated empty taskId would itself violate the schema this adapter's responses are pinned against", async () => {
  const pair = await startPair(true);
  try {
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"] as const) {
      await assert.rejects(
        () => tasksRequest(pair.client, method, ""),
        (error: unknown) => {
          const message = String((error as { message?: unknown })?.message ?? error);
          return /-32602|invalid|taskId/i.test(message);
        },
        `expected ${method} to reject an empty-string taskId at the request-validation boundary`
      );
    }
  } finally {
    await pair.close();
  }
});

test("after the backing job reaches a REAL terminal state (known exit code, known output), tasks/get(taskId) reflects that real state - never a canned 'working' decoupled from the job", async () => {
  const pair = await startPair(true);
  try {
    const minted = await runJob(pair.client, {
      command: [
        process.execPath,
        "-e",
        "process.stdout.write('hello-from-task'); process.exitCode = 7;",
      ],
      label: "terminal-reflection",
    });
    const taskId = minted.taskId as string;

    await pollUntilTerminal(pair.client, taskId);

    const taskGet = await tasksRequest(pair.client, "tasks/get", taskId);
    assert.equal(
      taskGet.status,
      "completed",
      `expected a completed task, got status ${JSON.stringify(taskGet.status)}`
    );
    assert.equal(taskGet.exitCode, 7, "the real exit code must be reflected, not a canned value");
    const output = taskGet.output as Record<string, number> | undefined;
    assert.ok(output, "expected real output counts on a terminal task");
    assert.ok(
      output!.stdout_bytes > 0,
      `expected non-zero stdout_bytes reflecting real output, got ${JSON.stringify(output)}`
    );
  } finally {
    await pair.close();
  }
});

test("a job that never spawns (spawn-error class) maps to task status 'failed', distinct from a completed task whose command happened to exit non-zero", async () => {
  const pair = await startPair(true);
  try {
    const minted = await runJob(pair.client, {
      command: ["this-command-definitely-does-not-exist-ghantika-tasks-test"],
      label: "spawn-failure-mapping",
    });
    const taskId = minted.taskId as string;
    await pollUntilTerminal(pair.client, taskId);

    const taskGet = await tasksRequest(pair.client, "tasks/get", taskId);
    assert.equal(taskGet.status, "failed");
  } finally {
    await pair.close();
  }
});

test("a killed job maps to task status 'cancelled'", async () => {
  const pair = await startPair(true);
  try {
    const minted = await runJob(pair.client, {
      command: [process.execPath, "-e", "setTimeout(() => {}, 60000);"],
      label: "kill-mapping",
    });
    const taskId = minted.taskId as string;

    // Give the process a moment to actually spawn before killing it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await pair.client.callTool({ name: "kill", arguments: { job_id: taskId } });
    await pollUntilTerminal(pair.client, taskId);

    const taskGet = await tasksRequest(pair.client, "tasks/get", taskId);
    assert.equal(taskGet.status, "cancelled");
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// On a capable connection, the backing job stays pollable via the PLAIN
// status/output surface on the mapped job_id after an unsolicited handle is
// minted - the handle augments the poll floor, it never replaces it
// ---------------------------------------------------------------------------

test("on a capable connection, status/output/tail on the mapped job_id keep working normally after a handle is minted - the plain poll floor is never replaced", async () => {
  const pair = await startPair(true);
  try {
    const minted = await runJob(pair.client, {
      command: [process.execPath, "-e", "process.stdout.write('poll-floor-line\\n');"],
      label: "poll-floor-still-reachable",
    });
    const taskId = minted.taskId as string;

    const statusResult = runResultStructured(
      await pair.client.callTool({ name: "status", arguments: { job_id: taskId } })
    );
    assert.equal(statusResult.job_id, taskId);

    const outputResult = (await pair.client.callTool({
      name: "output",
      arguments: { job_id: taskId },
    })) as { isError?: boolean };
    assert.notEqual(
      outputResult.isError,
      true,
      "the plain output tool must still work on a minted job_id"
    );

    const tailResult = (await pair.client.callTool({
      name: "tail",
      arguments: { job_id: taskId, n: 5 },
    })) as { isError?: boolean };
    assert.notEqual(
      tailResult.isError,
      true,
      "the plain tail tool must still work on a minted job_id"
    );
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// tasks/update + tasks/cancel interim contract: LIVE task (current-state,
// read-only), TERMINAL task (idempotent), UNKNOWN taskId (one fixed shape) -
// state-preservation invariant: neither method alters the backing job or
// the tasks/get-observable state
// ---------------------------------------------------------------------------

test("interim contract: on a LIVE (working) task, tasks/update and tasks/cancel each return a well-formed current-state result and mutate NOTHING observable - proven by a FULL-OBJECT deep-equality across all four reads, not just status plus one discriminator field", async () => {
  const pair = await startPair(true);
  try {
    const minted = await runJob(pair.client, {
      command: [process.execPath, "-e", "setTimeout(() => {}, 60000);"],
      label: "live-interim-contract",
    });
    const taskId = minted.taskId as string;
    await new Promise((resolve) => setTimeout(resolve, 30)); // let it actually start running

    const before = await tasksRequest(pair.client, "tasks/get", taskId);
    assert.equal(before.status, "working");
    assert.equal(before.extension, TASKS_EXTENSION_URI);

    const updateResult = await tasksRequest(pair.client, "tasks/update", taskId);
    const cancelResult = await tasksRequest(pair.client, "tasks/cancel", taskId);
    const after = await tasksRequest(pair.client, "tasks/get", taskId);

    // A live, still-working task's current-state snapshot has nothing
    // that legitimately changes across these four back-to-back reads -
    // createdAt is fixed at record creation, status stays "working"
    // throughout a no-output background process, and output/exitCode are
    // not even present until the task reaches a terminal state - so the
    // real invariant is a FULL deep-equal across all four, not merely
    // "status agrees" plus one discriminator field. A mutant that alters
    // ONE specific field (e.g. createdAt) while leaving status/extension
    // untouched survives the old, narrower assertion but is caught here.
    assert.deepEqual(
      updateResult,
      before,
      "tasks/update must return the IDENTICAL current-state snapshot, field for field"
    );
    assert.deepEqual(
      cancelResult,
      before,
      "tasks/cancel must return the IDENTICAL current-state snapshot, field for field - this interim registration does not implement real cooperative cancellation"
    );
    assert.deepEqual(
      after,
      before,
      "tasks/update and tasks/cancel must not have altered the observable job state in ANY field"
    );

    // Clean up the still-live background process.
    await pair.client.callTool({ name: "kill", arguments: { job_id: taskId } });
  } finally {
    await pair.close();
  }
});

test("interim contract: on a TERMINAL task, tasks/update and tasks/cancel are IDEMPOTENT - they return the terminal state unchanged, repeatedly, AND each individually matches the real tasks/get snapshot, not just itself", async () => {
  const pair = await startPair(true);
  try {
    const minted = await runJob(pair.client, {
      command: [process.execPath, "-e", "process.exitCode = 0;"],
      label: "terminal-interim-contract",
    });
    const taskId = minted.taskId as string;
    await pollUntilTerminal(pair.client, taskId);

    const firstGet = await tasksRequest(pair.client, "tasks/get", taskId);
    assert.equal(firstGet.status, "completed");

    const firstUpdate = await tasksRequest(pair.client, "tasks/update", taskId);
    const secondUpdate = await tasksRequest(pair.client, "tasks/update", taskId);
    assert.deepEqual(
      firstUpdate,
      secondUpdate,
      "repeated tasks/update on a terminal task must be idempotent"
    );
    // Repeatability alone (firstUpdate === secondUpdate) is satisfied by
    // ANY stable value, including a stable-but-WRONG one (e.g. a bad
    // createdAt) - it never proves tasks/update's own response matches the
    // true tasks/get state. This is the direct cross-check the LIVE
    // version of this same test already applies (see "on a LIVE (working)
    // task" above): tasks/update must return the IDENTICAL snapshot
    // tasks/get reports, not merely repeat itself.
    assert.deepEqual(
      firstUpdate,
      firstGet,
      "tasks/update on a terminal task must return the IDENTICAL snapshot tasks/get reports, field for field - not merely a value that is stable across repeated calls"
    );

    const firstCancel = await tasksRequest(pair.client, "tasks/cancel", taskId);
    const secondCancel = await tasksRequest(pair.client, "tasks/cancel", taskId);
    assert.deepEqual(
      firstCancel,
      secondCancel,
      "repeated tasks/cancel on a terminal task must be idempotent"
    );
    assert.deepEqual(
      firstCancel,
      firstGet,
      "tasks/cancel on a terminal task must return the IDENTICAL snapshot tasks/get reports, field for field - not merely a value that is stable across repeated calls"
    );

    const finalGet = await tasksRequest(pair.client, "tasks/get", taskId);
    assert.deepEqual(finalGet, firstGet, "neither method may have altered the terminal snapshot");
  } finally {
    await pair.close();
  }
});

test("interim contract: on an UNKNOWN taskId, tasks/get, tasks/update, and tasks/cancel all return the IDENTICAL fixed not-found shape - never an arbitrary/varying shape", async () => {
  const pair = await startPair(true);
  try {
    const bogusId = "11111111-1111-4111-8111-111111111111";
    const getResult = await tasksRequest(pair.client, "tasks/get", bogusId);
    const updateResult = await tasksRequest(pair.client, "tasks/update", bogusId);
    const cancelResult = await tasksRequest(pair.client, "tasks/cancel", bogusId);
    assert.deepEqual(getResult, updateResult);
    assert.deepEqual(getResult, cancelResult);
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// The six-tool mint rule, from the other direction: run() mints,
// status/output/tail/kill/list never mint, regardless of connection
// capability
// ---------------------------------------------------------------------------

// Every field name a minted CreateTaskResult/live handle carries that a
// PLAIN response must never carry any trace of, checked as a SET below -
// not merely "extension is undefined", since a partial/stray handle-shaped
// field (a bare taskId, or pollIntervalMs, injected without the extension
// discriminator) would still survive an extension-only check.
const HANDLE_TELL_TALE_FIELDS = ["extension", "taskId", "pollIntervalMs"] as const;

/** True when NONE of HANDLE_TELL_TALE_FIELDS appears anywhere in `body`'s own JSON serialization - a whole-object sweep, not a check of one named field. */
function carriesNoHandleTellTale(body: unknown): boolean {
  const serialized = JSON.stringify(body);
  return HANDLE_TELL_TALE_FIELDS.every((field) => !serialized.includes(`"${field}"`));
}

test("six-tool mint rule: on a capable connection, run() mints a handle while status/output/tail/kill/list each return their PLAIN response with no handle minted - status/kill (both real PublicJobProjection shapes) are checked by full key-set AND VALUE deep-equality against the real plain job-projection shape (nondeterministic timestamps format-checked, order-checked against each other, AND bracketed against a real wall-clock window this test itself observed around each job's run - so a stable-but-wrong ISO timestamp cannot survive; every other field checked by exact literal value), and list/output/tail are checked by a genuine whole-object comparison against their real, complete values - not just a sweep for handle-tell-tale field names", async () => {
  const pair = await startPair(true);
  try {
    // Captured immediately before this job's REAL run() call, and again
    // (below) immediately after its terminal status is observed - the
    // genuine wall-clock window this test itself watched the job run in.
    // A stable-but-wrong ISO-shaped started_at/ended_at (the exact mutant
    // previously demonstrated) falls outside this window even though it
    // passes the format check untouched.
    const beforeFirstJobMs = Date.now();
    const minted = await runJob(pair.client, {
      command: [process.execPath, "-e", "process.stdout.write('x');"],
      label: "six-tool-mint-rule",
    });
    const taskId = minted.taskId as string;
    assert.equal(minted.extension, TASKS_EXTENSION_URI, "run() must mint on a capable connection");

    // Drive the job to its real terminal state FIRST, so every value
    // asserted below - list's entry, and output's/tail's own events - is
    // deterministic (a known "exited" state and a fully-flushed, single
    // output line) rather than a race against the child process's own
    // real wall-clock exit timing.
    await pollUntilTerminal(pair.client, taskId);

    const PUBLIC_JOB_PROJECTION_KEYS = [
      "command_summary",
      "counts",
      "diagnostic",
      "ended_at",
      "exit_code",
      // escalation_refused_reason/identity_capture/identity_confirmed/
      // kill_confirmed are always present in the real PublicJobProjection
      // (see toPublicProjection in jobStore.ts) - assigned unconditionally,
      // even when their value is undefined, so Object.keys always lists
      // all four regardless of whether this particular job was ever killed
      // or had its escalation refused.
      "escalation_refused_reason",
      "identity_capture",
      "identity_confirmed",
      "job_id",
      "kill_confirmed",
      "label",
      "queue_position",
      "signal",
      "started_at",
      "state",
    ].sort();

    const statusResult = runResultStructured(
      await pair.client.callTool({ name: "status", arguments: { job_id: taskId } })
    );
    // The job is already terminal (pollUntilTerminal above confirmed it),
    // so both started_at and ended_at are fully written by now - this is
    // the "after" edge of the real wall-clock window this test watched the
    // job run in.
    const afterFirstJobMs = Date.now();
    assert.equal(statusResult.job_id, taskId);
    assert.deepEqual(
      Object.keys(statusResult).sort(),
      PUBLIC_JOB_PROJECTION_KEYS,
      `expected status's response to deep-equal the real PublicJobProjection key set exactly (no minted field, no dropped field), got: ${JSON.stringify(Object.keys(statusResult).sort())}`
    );

    // Key-set equality alone (the check above) does not prove any field's
    // VALUE is genuine rather than a stable-but-wrong placeholder - this
    // was previously demonstrated exactly twice: a `label` mutation that
    // preserved the full key set and `job_id` still passed, AND
    // (separately) a hardcoded-but-ISO-shaped `started_at` survived the
    // format/order checks below completely undetected, because neither
    // check ties the value to anything this test actually observed
    // happening. Every
    // field is checked by its real, expected value below: `started_at`/
    // `ended_at` are genuinely nondeterministic real wall-clock reads, so
    // they are format-checked, order-checked against each other, AND
    // bracketed against `[beforeFirstJobMs, afterFirstJobMs]` - the real
    // wall-clock window this test itself captured immediately before
    // starting this job and immediately after observing its terminal
    // status - so a stable-but-wrong ISO value (the same mutant previously
    // demonstrated) now falls outside the live window and is rejected.
    // Every OTHER field -
    // including `state`, `command_summary`, and every key inside `counts`
    // - is checked by exact literal deep-equality against this job's
    // real, known values (the command writes a single byte with no
    // trailing newline and exits cleanly with code 0 - see
    // `pollUntilTerminal` above, and the `outputResult` assertion below
    // independently confirms the single partial stdout byte this job
    // produced).
    assert.ok(
      Date.parse(statusResult.ended_at as string) >= Date.parse(statusResult.started_at as string),
      `expected status's ended_at (${JSON.stringify(statusResult.ended_at)}) to be at or after started_at (${JSON.stringify(statusResult.started_at)})`
    );
    const statusStartedAtMs = Date.parse(statusResult.started_at as string);
    const statusEndedAtMs = Date.parse(statusResult.ended_at as string);
    assert.ok(
      statusStartedAtMs >= beforeFirstJobMs && statusStartedAtMs <= afterFirstJobMs,
      `expected status's started_at (${JSON.stringify(statusResult.started_at)}) to fall inside the real wall-clock bracket [${beforeFirstJobMs}, ${afterFirstJobMs}] this test captured around the job's actual run - a stable-but-wrong ISO-shaped value would fall outside it`
    );
    assert.ok(
      statusEndedAtMs >= beforeFirstJobMs && statusEndedAtMs <= afterFirstJobMs,
      `expected status's ended_at (${JSON.stringify(statusResult.ended_at)}) to fall inside the real wall-clock bracket [${beforeFirstJobMs}, ${afterFirstJobMs}] this test captured around the job's actual run - a stable-but-wrong ISO-shaped value would fall outside it`
    );
    // identity_capture is a real, asynchronous ps-based read fired right
    // after spawn (see captureBirthIdentityPosixAsync's own docs) - it
    // settles independently of this job's own exit, so its exact timing
    // relative to `pollUntilTerminal` above is not something this test
    // controls. Checked for validity here (never a stray/unexpected value),
    // then excluded from the exact-literal comparison below the same way
    // started_at/ended_at are - a field genuinely outside this test's
    // control is checked on its own terms, not hardcoded to one of its
    // several legitimate outcomes.
    assert.ok(
      ["pending", "captured", "unavailable"].includes(statusResult.identity_capture as string),
      `expected status's identity_capture to be one of pending/captured/unavailable, got: ${JSON.stringify(statusResult.identity_capture)}`
    );
    const statusWithoutIdentityCapture = { ...statusResult };
    delete statusWithoutIdentityCapture.identity_capture;
    assert.deepEqual(
      withTimestampFieldsChecked(statusWithoutIdentityCapture, ["started_at", "ended_at"]),
      {
        job_id: taskId,
        state: "exited",
        exit_code: 0,
        signal: undefined,
        diagnostic: undefined,
        queue_position: undefined,
        command_summary: path.basename(process.execPath),
        label: "six-tool-mint-rule",
        counts: { stdout_lines: 1, stdout_bytes: 1, stderr_lines: 0, stderr_bytes: 0 },
        // This job is never explicitly killed, but its leader's own
        // natural exit still triggers the eager reap-at-exit (see
        // reapProcessGroupOnce's own docs) - kill_confirmed reports a
        // STATE (the process group was observed to hold no members), not
        // an ACTION, so it is true here too. That reap never re-runs the
        // leader identity check, so identity_confirmed stays at its unset
        // default, never fabricated as false.
        kill_confirmed: true,
        identity_confirmed: undefined,
        // This job was never signalled at all (a natural exit), so the
        // escalation identity gate never ran - stays at its unset default.
        escalation_refused_reason: undefined,
      },
      `expected status's response to deep-equal its real, complete values (timestamps and identity_capture checked separately above), not just the right key set - got: ${JSON.stringify(statusResult)}`
    );

    // The old assertion for list/output/tail only swept for the 3
    // handle-tell-tale field names - it never checked for any OTHER
    // unexpected stray field, nor for wrong values in fields it did not
    // even look at. Confirmed directly: adding an unexpected non-handle
    // field to these responses still passed. Strengthened below to a genuine
    // whole-object comparison against each tool's real, complete values -
    // an explicit key-set check plus value checks - not merely "these 3
    // handle-marker names are absent."
    const listResult = runResultStructured(
      await pair.client.callTool({ name: "list", arguments: {} })
    );
    assert.deepEqual(
      Object.keys(listResult).sort(),
      ["jobs"],
      `expected list's response to deep-equal the real {jobs} key set exactly, got: ${JSON.stringify(Object.keys(listResult).sort())}`
    );
    const listedJobs = listResult.jobs as unknown[];
    assert.ok(
      Array.isArray(listedJobs),
      `expected list's jobs field to be an array, got: ${JSON.stringify(listResult.jobs)}`
    );
    assert.ok(
      carriesNoHandleTellTale(listedJobs),
      `list's response must carry NONE of ${JSON.stringify(HANDLE_TELL_TALE_FIELDS)} anywhere, got: ${JSON.stringify(listedJobs)}`
    );
    const listedEntry = (listedJobs as Array<Record<string, unknown>>).find(
      (job) => job.job_id === taskId
    );
    assert.ok(
      listedEntry,
      `expected list to include the minted, now-terminal job ${taskId}, got: ${JSON.stringify(listedJobs)}`
    );
    assert.deepEqual(
      listedEntry,
      {
        job_id: taskId,
        label: "six-tool-mint-rule",
        state: "exited",
        started_at: statusResult.started_at,
      },
      `expected list's entry for the minted job to deep-equal its real, complete values - not just an absent handle field - got: ${JSON.stringify(listedEntry)}`
    );

    const outputResult = runResultStructured(
      await pair.client.callTool({ name: "output", arguments: { job_id: taskId } })
    );
    assert.ok(
      carriesNoHandleTellTale(outputResult),
      `output's response must carry NONE of ${JSON.stringify(HANDLE_TELL_TALE_FIELDS)} anywhere, got: ${JSON.stringify(outputResult)}`
    );
    // The single 'x' write with no trailing newline produces exactly one
    // materialized, still-partial line - a deterministic, known-complete
    // value now that the job has actually reached a terminal state.
    // `seq` is this job's own FIRST (and only) line: JobStore hands every
    // job a fresh per-job seq counter starting at 1 (verified directly -
    // src/jobStore.ts's createJob/createFailedJob each call
    // createJobSeqCounter() fresh), so it is stable regardless of how many
    // OTHER jobs this test file has created before this one.
    assert.deepEqual(
      outputResult,
      { events: [{ seq: 1, stream: "stdout", text: "x", partial: true }], next_cursor: 1 },
      `expected output's response to deep-equal its real, complete values exactly - not just an absent handle field - got: ${JSON.stringify(outputResult)}`
    );

    const tailResult = runResultStructured(
      await pair.client.callTool({ name: "tail", arguments: { job_id: taskId, n: 1 } })
    );
    assert.ok(
      carriesNoHandleTellTale(tailResult),
      `tail's response must carry NONE of ${JSON.stringify(HANDLE_TELL_TALE_FIELDS)} anywhere, got: ${JSON.stringify(tailResult)}`
    );
    // tail(n: 1) on this same now-terminal, single-line job must report
    // the IDENTICAL single event and cursor output() already reported -
    // cross-checked directly against outputResult rather than a second
    // hardcoded literal, so this assertion can never silently drift out of
    // sync with the one above.
    assert.deepEqual(
      tailResult,
      outputResult,
      `expected tail's response to deep-equal output's real response exactly for this single-line, now-terminal job - got: ${JSON.stringify(tailResult)}`
    );

    // The kill check needs a job that is GENUINELY still running at the
    // moment kill() is called, so its resulting state is deterministic
    // rather than a race between real OS process-spawn overhead and this
    // in-memory RPC round trip - the SAME long-lived-command-plus-short-
    // wait pattern this file's other kill tests already rely on (see "a
    // killed job maps to task status 'cancelled'" and the LIVE
    // interim-contract test above), used here instead of the previous
    // default `["true"]` command.
    // Captured immediately before this SECOND job's real run() call, and
    // again (below) immediately after kill() returns - the genuine
    // wall-clock window this test itself watched the kill path run in.
    const beforeSecondJobMs = Date.now();
    const second = await runJob(pair.client, {
      command: [process.execPath, "-e", "setTimeout(() => {}, 60000);"],
      label: "six-tool-mint-rule-kill-target",
    });
    const secondTaskId = second.taskId as string;
    await new Promise((resolve) => setTimeout(resolve, 50)); // let it actually start running
    const killResult = runResultStructured(
      await pair.client.callTool({ name: "kill", arguments: { job_id: secondTaskId } })
    );
    // kill() has now returned, so both started_at and ended_at are fully
    // written - the "after" edge of the real wall-clock window.
    const afterKillMs = Date.now();
    assert.deepEqual(
      Object.keys(killResult).sort(),
      PUBLIC_JOB_PROJECTION_KEYS,
      `expected kill's response to deep-equal the real PublicJobProjection key set exactly, got: ${JSON.stringify(Object.keys(killResult).sort())}`
    );

    // Key-set equality alone (the check above) does not prove any field's
    // VALUE is genuine - the same gap previously demonstrated for the
    // status check above applies here identically, and it was demonstrated
    // directly on THIS kill path: a stable-but-wrong ISO-shaped
    // `started_at` hardcoded into the kill projection survived format/order
    // checks alone and this test stayed green. Every field is checked by its
    // real, expected value below: `started_at`/`ended_at` are
    // format-checked, order-checked against each other, AND bracketed
    // against `[beforeSecondJobMs, afterKillMs]` - the real wall-clock
    // window this test itself captured immediately before starting the
    // job kill() targets and immediately after kill() returned - so a
    // stable-but-wrong value can no longer survive undetected. Every
    // OTHER field - `state`, `signal`, `command_summary`, `label`, and
    // every key inside `counts` - is checked by exact literal
    // deep-equality against the real values a `kill` on a genuinely-
    // running, output-free `setTimeout` job always produces (see
    // `src/jobStore.ts`'s `markKilled`: the default SIGTERM-only path
    // records state "killed" and signal "SIGTERM", never touching
    // `exit_code`).
    assert.ok(
      Date.parse(killResult.ended_at as string) >= Date.parse(killResult.started_at as string),
      `expected kill's ended_at (${JSON.stringify(killResult.ended_at)}) to be at or after started_at (${JSON.stringify(killResult.started_at)})`
    );
    const killStartedAtMs = Date.parse(killResult.started_at as string);
    const killEndedAtMs = Date.parse(killResult.ended_at as string);
    assert.ok(
      killStartedAtMs >= beforeSecondJobMs && killStartedAtMs <= afterKillMs,
      `expected kill's started_at (${JSON.stringify(killResult.started_at)}) to fall inside the real wall-clock bracket [${beforeSecondJobMs}, ${afterKillMs}] this test captured around the killed job's actual run - a stable-but-wrong ISO-shaped value would fall outside it`
    );
    assert.ok(
      killEndedAtMs >= beforeSecondJobMs && killEndedAtMs <= afterKillMs,
      `expected kill's ended_at (${JSON.stringify(killResult.ended_at)}) to fall inside the real wall-clock bracket [${beforeSecondJobMs}, ${afterKillMs}] this test captured around the killed job's actual run - a stable-but-wrong ISO-shaped value would fall outside it`
    );
    // identity_confirmed's exact boolean value depends on a real ps-based
    // elapsed-time comparison (see evaluatePreSignalIdentityGate's own
    // docs) - checked for presence/type here, matching the same
    // typeof-boolean convention kill.test.ts's own default-path tests
    // already use for this exact field, rather than asserting one
    // specific value. identity_capture is excluded the same way as the
    // status() check above, for the same reason.
    assert.equal(
      typeof killResult.identity_confirmed,
      "boolean",
      `expected kill's identity_confirmed to be present as a boolean once terminal, got: ${JSON.stringify(killResult.identity_confirmed)}`
    );
    assert.ok(
      ["pending", "captured", "unavailable"].includes(killResult.identity_capture as string),
      `expected kill's identity_capture to be one of pending/captured/unavailable, got: ${JSON.stringify(killResult.identity_capture)}`
    );
    const killResultWithoutIdentityFields = { ...killResult };
    delete killResultWithoutIdentityFields.identity_confirmed;
    delete killResultWithoutIdentityFields.identity_capture;
    assert.deepEqual(
      withTimestampFieldsChecked(killResultWithoutIdentityFields, ["started_at", "ended_at"]),
      {
        job_id: secondTaskId,
        state: "killed",
        exit_code: undefined,
        signal: "SIGTERM",
        diagnostic: undefined,
        queue_position: undefined,
        command_summary: path.basename(process.execPath),
        label: "six-tool-mint-rule-kill-target",
        counts: { stdout_lines: 0, stdout_bytes: 0, stderr_lines: 0, stderr_bytes: 0 },
        // A real, ordinary SIGTERM kill on a genuinely running job: the
        // final external pgrep-based check confirms zero survivors.
        kill_confirmed: true,
        // This job died from the initial SIGTERM within the grace period,
        // so escalation was never even attempted - stays at its unset
        // default.
        escalation_refused_reason: undefined,
      },
      `expected kill's response to deep-equal its real, complete values (timestamps and identity fields checked separately above), not just the right key set - got: ${JSON.stringify(killResult)}`
    );
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// A deterministic, simulated stand-in for verification against a real
// Tasks-capable host - that verification needs an actual external client
// and is not exercised here. A SIMULATED Tasks-capable client observes the
// FULL negotiate -> unsolicited-handle -> tasks/get sequence, and this test
// fails closed (throws) if any step in that sequence is skipped or silently
// absent, so a hollow fixture could never masquerade as this proof.
// ---------------------------------------------------------------------------

test("simulated Tasks-capable host: negotiate -> unsolicited handle -> tasks/get poll, every step observed and none skippable", async () => {
  const pair = await startPair(true);
  try {
    // Step 1: negotiate. Fails closed if the capability never appears.
    const serverCapabilities = pair.client.getServerCapabilities();
    const negotiated = Boolean(serverCapabilities?.extensions?.[TASKS_EXTENSION_URI]);
    if (!negotiated) {
      throw new Error(
        "simulated host: negotiation step failed - server never advertised the Tasks extension"
      );
    }

    // Step 2: an ordinary tool call, with the host doing nothing
    // Tasks-specific beyond having advertised the capability at
    // initialize - and an unsolicited handle must come back.
    const minted = await runJob(pair.client, { label: "simulated-host-e2e" });
    if (minted.extension !== TASKS_EXTENSION_URI || typeof minted.taskId !== "string") {
      throw new Error(
        `simulated host: unsolicited-handle step failed - expected a minted CreateTaskResult, got ${JSON.stringify(minted)}`
      );
    }
    const taskId = minted.taskId;

    // Step 3: poll via tasks/get - the SAME method a real Tasks-capable
    // host would use, driven to a real terminal state.
    await pollUntilTerminal(pair.client, taskId);
    const finalTask = await tasksRequest(pair.client, "tasks/get", taskId);
    if (finalTask.status !== "completed") {
      throw new Error(
        `simulated host: tasks/get poll step failed - expected a completed task, got ${JSON.stringify(finalTask)}`
      );
    }

    // If every step above observed its expected outcome, the full
    // sequence genuinely ran end to end.
    assert.equal(negotiated, true);
    assert.equal(typeof taskId, "string");
    assert.equal(finalTask.status, "completed");
  } finally {
    await pair.close();
  }
});

test("the poll interval hint is a positive, stable constant on every minted/live result", async () => {
  const pair = await startPair(true);
  try {
    const minted = await runJob(pair.client, { label: "poll-interval-hint" });
    assert.equal(minted.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    assert.ok((minted.pollIntervalMs as number) > 0);
  } finally {
    await pair.close();
  }
});

// ---------------------------------------------------------------------------
// A completeness sweep: every tracked behavioral commitment this capability
// makes has a real, findable test backing it SOMEWHERE in this suite - never
// a silently-dropped area. Kept LIGHT, on purpose: each entry names the file
// the commitment is proven in and a short, distinctive substring its real
// test title must contain - not a re-derivation of any internal planning
// document (which would not exist in a checked-out copy of this repo
// anyway), just a checklist of the behaviors this capability's own design
// commits to, each pointed at the real test that proves it. A stale
// substring (a renamed test whose title changed) reds this exactly as
// loudly as a genuinely missing test would - this check cannot pass by
// merely existing once and then rotting quietly as titles drift.
// ---------------------------------------------------------------------------

interface CompletenessArea {
  readonly area: string;
  readonly file: string;
  readonly titleContains: string;
}

/**
 * COMPLETENESS_AREAS is declared in THIS file, so a naive substring search
 * of test/tasks.test.ts's own source text against a same-file row's
 * `titleContains` would trivially "find" the string inside the array's OWN
 * field value below - even after the real test it names has been deleted
 * entirely. Confirmed empirically while fixing this: deleting a real
 * test's title string, while leaving its COMPLETENESS_AREAS row untouched,
 * still left the sweep green, because the row's own `titleContains:`
 * string literal is itself present in this file's text regardless of
 * whether the test it describes still exists. Every row whose `file` is
 * this same file is therefore checked against this file's text with the
 * array's OWN source region excised first (see
 * `textExcludingCompletenessAreasSource` below), so a same-file row can
 * only be satisfied by a REAL test title living elsewhere in the file,
 * never by matching its own row.
 */
const SELF_FILE = "test/tasks.test.ts";

/**
 * Strips the `const COMPLETENESS_AREAS = [ ... ];` array's own source text
 * out of `rawText`, so a same-file completeness check cannot pass by
 * matching its own row's `titleContains` literal - see `SELF_FILE`'s doc
 * comment above for why this is necessary, not merely defensive. Throws
 * loudly (rather than silently scanning the un-stripped text) if the
 * array's boundary markers ever move or are renamed, since a silent
 * fallback here would reintroduce exactly the self-reference hole this
 * function exists to close.
 */
function textExcludingCompletenessAreasSource(rawText: string): string {
  const start = rawText.indexOf("const COMPLETENESS_AREAS");
  const closeMarker = "\n];\n";
  const end = start === -1 ? -1 : rawText.indexOf(closeMarker, start);
  if (start === -1 || end === -1) {
    throw new Error(
      "expected to find the COMPLETENESS_AREAS array's exact source region in " +
        `${SELF_FILE} - the same-file self-reference guard cannot verify same-file ` +
        "completeness rows without it"
    );
  }
  return rawText.slice(0, start) + rawText.slice(end + closeMarker.length);
}

const COMPLETENESS_AREAS: readonly CompletenessArea[] = [
  {
    area: "capability advertisement at initialize, on both a capable and a non-capable connection",
    file: "test/tasks.test.ts",
    titleContains:
      "advertises io.modelcontextprotocol/tasks in its initialize-negotiated capabilities",
  },
  {
    area: "unsolicited mint on a bare run() call, no per-request opt-in field involved",
    file: "test/tasks.test.ts",
    titleContains: "unsolicited server-minted task handle on a bare run() call",
  },
  {
    area: "minting depends only on the connection, never a request-level capability/task field",
    file: "test/tasks.test.ts",
    titleContains: "no request-level capability/task field whatsoever",
  },
  {
    area: "a non-capable connection stays byte-stable with the real plain job_id shape",
    file: "test/tasks.test.ts",
    titleContains: "returns the plain job projection",
  },
  {
    area: "the minted result validates against the vendored, digest-verified schema",
    file: "test/tasks.test.ts",
    titleContains: "validates against the real, digest-verified vendored schema",
  },
  {
    area: "N mints produce N distinct, high-entropy taskIds under the identity mapping",
    file: "test/tasks.test.ts",
    titleContains: "distinct, high-entropy v4-UUID-format taskIds",
  },
  {
    area: "the registered task method set is exactly {tasks/get, tasks/update, tasks/cancel}, by real set-equality",
    file: "test/tasks.test.ts",
    titleContains: "a genuine SET-EQUALITY over the server's OWN real registration mechanism",
  },
  {
    area: "checkSdkExactPin() enforces the exact split-package pin, the required frozen version, and lockfile agreement",
    file: "test/check-sdk-exact-pin.test.js",
    titleContains: "the real, current exact-pinned repo state passes with zero problems",
  },
  {
    area: "the vendored extension schema pin is in-repo and never a fabricated npm dependency",
    file: "test/check-sdk-exact-pin.test.js",
    titleContains: "fabricated io.modelcontextprotocol Tasks npm dependency",
  },
  {
    area: "the vendored schema's recorded digest is ENFORCED against its real bytes, not merely present - editing the schema without updating the digest is flagged",
    file: "test/check-sdk-exact-pin.test.js",
    titleContains: "the recorded digest is ENFORCED, not decorative",
  },
  {
    area: "the symbol-aware Tasks-import guard flags a Tasks symbol reaching a core module, adapter excepted",
    file: "test/no-tasks-import.test.ts",
    titleContains:
      "the real src/ tree references nothing from the Tasks extension outside the permitted adapter carveout",
  },
  {
    area: "the adapter carveout is narrow: it suppresses only its own legitimate Tasks-symbol use, never every finding class",
    file: "test/no-tasks-import.test.ts",
    titleContains: "the adapter carveout is narrow: a MIXED adapter file",
  },
  // (this completeness sweep IS the artifact for "every declared capability
  // behavior has a corresponding test, with nothing silently dropped" - no
  // separate entry needed for a check pointing at itself)
  {
    area: "a simulated Tasks-capable host proves the full negotiate -> unsolicited handle -> tasks/get sequence end to end",
    file: "test/tasks.test.ts",
    titleContains: "simulated Tasks-capable host",
  },
  {
    area: "the adapter's status set deep-equals the schema's status enum and excludes 'expired'",
    file: "test/tasks.test.ts",
    titleContains: "deep-equals the vendored schema's own status enum",
  },
  {
    area: "tasks/get resolves to the same JobRecord status() reports, with genuine cross-field agreement",
    file: "test/tasks.test.ts",
    titleContains: "not just a matching taskId, but genuine cross-field agreement",
  },
  {
    area: "tasks/get reflects a real terminal job state, never a canned working status",
    file: "test/tasks.test.ts",
    titleContains: "reflects that real state - never a canned 'working'",
  },
  {
    area: "the plain poll floor stays reachable after a handle is minted",
    file: "test/tasks.test.ts",
    titleContains: "the plain poll floor is never replaced",
  },
  {
    area: "the update/cancel interim contract preserves state across live, terminal, and unknown taskIds, by full-object comparison",
    file: "test/tasks.test.ts",
    titleContains: "proven by a FULL-OBJECT deep-equality across all four reads",
  },
  {
    area: "the update/cancel interim contract on a TERMINAL task is idempotent AND each of update/cancel individually matches the real tasks/get snapshot, not merely itself",
    file: "test/tasks.test.ts",
    titleContains: "each individually matches the real tasks/get snapshot, not just itself",
  },
  {
    area: "the update/cancel interim contract on an UNKNOWN taskId returns the identical fixed not-found shape across get/update/cancel",
    file: "test/tasks.test.ts",
    titleContains:
      "on an UNKNOWN taskId, tasks/get, tasks/update, and tasks/cancel all return the IDENTICAL fixed not-found shape",
  },
  {
    area: "module-boundary admission adds the adapter without opening the frozen set to any new module",
    file: "test/module-boundaries.test.ts",
    titleContains:
      "the frozen set admits src/tasksAdapter.ts, and a DIFFERENT unknown new src/ module is still rejected",
  },
  {
    area: "run() mints while every other tool stays plain, regardless of capability - every non-timestamp field checked by whole-object comparison, and started_at/ended_at additionally bracketed against a real wall-clock window the test itself observed, so no field (timestamps included) can silently carry a stable-but-wrong placeholder",
    file: "test/tasks.test.ts",
    titleContains:
      "status/kill (both real PublicJobProjection shapes) are checked by full key-set AND VALUE deep-equality",
  },
  {
    area: "an empty-string taskId is rejected at the request-validation boundary, never silently echoed through",
    file: "test/tasks.test.ts",
    titleContains: "REJECTED at the request-validation boundary on all three task methods",
  },
];

test("completeness sweep: every tracked behavioral commitment for this capability has a real, findable test backing it - the absence of any one reds this assertion, so a silently-dropped area or a stale/renamed test title cannot go unnoticed", () => {
  const missing: string[] = [];
  const fileTextCache = new Map<string, string>();
  for (const { area, file, titleContains } of COMPLETENESS_AREAS) {
    let text = fileTextCache.get(file);
    if (text === undefined) {
      const rawText = readFileSync(path.join(REPO_ROOT, file), "utf8");
      // See SELF_FILE's doc comment above: a row pointing at THIS file
      // must never be checked against this file's raw text as-is, since
      // the row's own `titleContains` literal lives in that same text.
      text = file === SELF_FILE ? textExcludingCompletenessAreasSource(rawText) : rawText;
      fileTextCache.set(file, text);
    }
    if (!text.includes(titleContains)) {
      missing.push(`${area} (expected to find "${titleContains}" in ${file})`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `orphaned/uncovered areas - a tracked commitment with no findable backing test: ${JSON.stringify(missing, null, 2)}`
  );
});
