/**
 * Owns the six tools' schema declarations and dispatches a `tools/call` to
 * the right handler. This is the only file that imports
 * more than one file under `src/tools/` - each tool module stays
 * self-contained and unaware of its siblings; `registry.ts` is what
 * assembles them into the single list/dispatch surface `src/server.ts`
 * talks to.
 */
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

import * as killTool from "./tools/kill.js";
import * as listTool from "./tools/list.js";
import * as outputTool from "./tools/output.js";
import * as runTool from "./tools/run.js";
import * as statusTool from "./tools/status.js";
import * as tailTool from "./tools/tail.js";

/** The shape every `src/tools/*.ts` module must export. */
interface ToolModule {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Tool["inputSchema"];
  handler(args: Record<string, unknown> | undefined): CallToolResult | Promise<CallToolResult>;
}

/**
 * The six tools this server exposes, frozen by design: run, status, list,
 * output, tail, kill - no more, no fewer. Order here is also the order
 * `tools/list` advertises them in.
 */
const TOOL_MODULES: readonly ToolModule[] = [
  runTool,
  statusTool,
  listTool,
  outputTool,
  tailTool,
  killTool,
];

if (new Set(TOOL_MODULES.map((tool) => tool.name)).size !== TOOL_MODULES.length) {
  // A duplicate tool name would silently make `dispatchToolCall` always
  // pick the first match and `tools/list` advertise the same name twice -
  // both are protocol-breaking, so this fails at module load rather than
  // waiting to be discovered by a client.
  throw new Error("registry.ts: duplicate tool name among TOOL_MODULES");
}

/** Every registered tool's name, in registration order. */
export const TOOL_NAMES: readonly string[] = TOOL_MODULES.map((tool) => tool.name);

/** The `tools/list` result body: each tool's name, description, and input schema. */
export function listToolDefinitions(): Tool[] {
  return TOOL_MODULES.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

/**
 * Dispatches a `tools/call` to the named tool's handler.
 *
 * @throws {ProtocolError} with `ProtocolErrorCode.InvalidParams` (-32602)
 *   when `name` isn't one of the six registered tools. This is
 *   deliberately a THROW (a JSON-RPC protocol-level error), not a
 *   returned `{ isError: true }` result: an unknown tool name is an
 *   invalid PARAMETER to the (valid, recognized) `tools/call` method,
 *   which is exactly what -32602 means - it is not the same failure class
 *   as a known tool whose arguments fail its own schema, which IS a
 *   returned tool-execution error (see each tool handler's own
 *   `toolError` path).
 */
export function dispatchToolCall(
  name: string,
  args: Record<string, unknown> | undefined
): CallToolResult | Promise<CallToolResult> {
  const tool = TOOL_MODULES.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: "${name}"`);
  }
  return tool.handler(args);
}
