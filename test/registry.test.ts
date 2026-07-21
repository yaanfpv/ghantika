import assert from "node:assert/strict";
import { test } from "node:test";

import { ProtocolError } from "@modelcontextprotocol/server";

// Imports the BUILT output, not src/ directly: this codebase's internal
// imports use NodeNext-style ".js" specifiers pointing at the compiled
// sibling (required by tsconfig's moduleResolution: "NodeNext" for real
// ESM resolution), and Node's native TypeScript type-stripping does not
// remap those back to a sibling ".ts" file at runtime - only a real build
// produces something Node can actually load end-to-end. `npm test` runs
// `npm run build` first for exactly this reason (see package.json).
import { TOOL_NAMES, dispatchToolCall, listToolDefinitions } from "../dist/registry.js";

const EXPECTED_TOOL_NAMES = ["run", "status", "list", "output", "tail", "kill"];

test("exactly the six frozen tools are registered, by name", () => {
  assert.deepEqual([...TOOL_NAMES].sort(), [...EXPECTED_TOOL_NAMES].sort());
  assert.equal(TOOL_NAMES.length, 6);
});

test("listToolDefinitions returns all six tools, each with a name, description, and object-typed input schema", () => {
  const tools = listToolDefinitions();
  assert.equal(tools.length, 6);
  for (const tool of tools) {
    assert.equal(typeof tool.name, "string");
    assert.ok(tool.name.length > 0);
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 0, `${tool.name} must have a non-empty description`);
    assert.equal(
      tool.inputSchema.type,
      "object",
      `${tool.name}'s inputSchema must be a JSON Schema object`
    );
  }
  assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOL_NAMES].sort());
});

test("run and status and output and tail and kill each require a job-identifying or command argument in their schema", () => {
  const tools = new Map(listToolDefinitions().map((t) => [t.name, t]));
  assert.deepEqual(tools.get("run")?.inputSchema.required, ["command"]);
  for (const name of ["status", "output", "tail", "kill"]) {
    assert.deepEqual(
      tools.get(name)?.inputSchema.required,
      ["job_id"],
      `${name} must require job_id`
    );
  }
});

test("list has no required arguments", () => {
  const tools = new Map(listToolDefinitions().map((t) => [t.name, t]));
  const listSchema = tools.get("list")?.inputSchema;
  assert.ok(listSchema);
  assert.ok(
    listSchema.required === undefined || listSchema.required.length === 0,
    "list should not require any arguments"
  );
});

// --- unknown tool name -> ProtocolError(InvalidParams), -32602, never -32601 ---

test("dispatching an unknown tool name throws ProtocolError with code -32602 (InvalidParams), not -32601", async () => {
  await assert.rejects(
    async () => dispatchToolCall("this-tool-does-not-exist", {}),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolError, "must throw a ProtocolError");
      assert.equal(
        error.code,
        -32602,
        "unknown tool name must be InvalidParams (-32602), never MethodNotFound (-32601)"
      );
      assert.notEqual(
        error.code,
        -32601,
        "an unknown TOOL NAME is never the same failure class as an unknown METHOD"
      );
      return true;
    }
  );
});

test("mutation control: the SAME unknown-tool-name check, applied to each of the six real tool names, never throws", async () => {
  for (const name of EXPECTED_TOOL_NAMES) {
    // Every real name must dispatch successfully (resolve, not reject) -
    // proves the -32602 path is reached only for names NOT in the
    // registered set, not for every call indiscriminately.
    await assert.doesNotReject(async () =>
      dispatchToolCall(name, name === "run" ? { command: ["true"] } : { job_id: "x" })
    );
  }
});

test("dispatching a known tool delegates to its handler and returns a CallToolResult, never throws", async () => {
  // list() is a real implementation: a fresh JobStore with no
  // jobs yet still succeeds (an empty enumeration is not an error), unlike
  // the old not-implemented stub which always returned isError: true.
  const result = await dispatchToolCall("list", {});
  assert.notEqual(result.isError, true);
  assert.ok(Array.isArray(result.content));
  assert.ok(Array.isArray((result.structuredContent as { jobs?: unknown } | undefined)?.jobs));
});
