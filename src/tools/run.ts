/**
 * `run` - starts a command in the background without blocking the calling
 * agent, and returns a job id immediately. This file owns
 * `run`'s registration/schema/validation/orchestration logic; it imports
 * nothing from any sibling under `src/tools/` and holds no state of its
 * own - real job/output state lives in `src/jobStore.ts`'s `jobStore`
 * singleton, real process-spawning mechanics live in `src/process.ts`.
 *
 * ## Non-blocking, by construction
 *
 * `process.spawnManaged` (see its own docs) never awaits anything - the
 * OS-level `spawn`/`error`/`exit` events it wires up are always
 * asynchronous relative to the call returning. So by the time this handler
 * builds its response, at most `resolveCwd`/`resolveExecutable`'s
 * synchronous filesystem checks have run (fast, no child-process I/O
 * involved) - `run` never awaits the spawned command's own execution or
 * completion. Proven under a real client over the real wire in
 * `test/e2e-server.test.ts`.
 *
 * ## Two ways a job can be `failed` before this handler even returns
 *
 * A `cwd` that doesn't exist (or isn't a directory), or a command that
 * doesn't resolve to a real executable file, are validated BEFORE ever
 * calling `spawnManaged` - this handler explicitly forbids silently
 * defaulting a bad `cwd`, and requires that both failure classes produce a
 * job that starts already in a terminal state, rather than either
 * throwing a protocol error or racing an async OS-level failure. See
 * `src/process.ts`'s `resolveCwd`/`resolveExecutable`.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

import { type PublicJobProjection, jobStore, toPublicProjection } from "../jobStore.js";
import { buildChildEnv, resolveCwd, resolveExecutable, spawnManaged } from "../process.js";

export const name = "run";

export const description =
  "Start a command in the background without blocking the calling agent. Returns a job_id immediately; use that id with status to check whether the job is still running, output to read its lines from a cursor, and tail to read just the last N. command is an argv array by default (never shell-interpreted) - pass shell: true to run a real shell command line instead.";

const MAX_LABEL_LENGTH = 64;

/**
 * True if `value` contains a C0 control character (code points 0 through
 * 31), DEL (127), or a C1 control character (128 through 159). Written as
 * an explicit character-code scan (plain decimal/hex numeric comparisons)
 * rather than a regex literal with escape sequences, to keep the exact byte
 * range being matched unambiguous.
 */
function hasControlCharacter(value: string): boolean {
  const DEL = 127;
  const C1_START = 128;
  const C1_END = 159;
  const C0_END = 31;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= C0_END || code === DEL || (code >= C1_START && code <= C1_END)) {
      return true;
    }
  }
  return false;
}

/**
 * The number of Unicode CODE POINTS in `value` - never its native `.length`
 * (UTF-16 code UNITS). JSON Schema defines string length in code points per
 * RFC 8259 (confirmed empirically: AJV's own `maxLength`/`minLength`
 * keywords use `ucs2length`-style code-point counting, not `.length`), so a
 * handler-side length check must count the SAME way the advertised schema
 * does - otherwise a 40-code-point emoji label (80 UTF-16 units, since many
 * emoji are surrogate pairs) can pass the schema's `maxLength: 64` while
 * failing a `.length > 64` handler check, or vice versa.
 * Spreading a string into an array iterates by
 * code point (each surrogate pair yields one array element), which is the
 * simplest correct way to get this count in JS.
 */
function codePointLength(value: string): number {
  return [...value].length;
}

export const inputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {
    command: {
      description:
        'The command to run. By default (shell omitted or false): an argv array, e.g. ["ls", "-la"] - the first element is the program, the rest are its literal arguments, never shell-interpreted. With shell: true: a shell command line, either as a single string or as an array of tokens joined with spaces, interpreted by the platform shell (enabling pipes, redirection, globbing).',
      anyOf: [
        { type: "array", items: { type: "string" }, minItems: 1 },
        { type: "string", minLength: 1 },
      ],
    },
    shell: {
      type: "boolean",
      description:
        "Opt-in escape hatch: when true, command is interpreted as a shell command line instead of a literal argv array. Defaults to false - a bare shell string is rejected unless this is explicitly true.",
    },
    cwd: {
      type: "string",
      description:
        "Working directory to run the command in. Must already exist and be a directory - an invalid cwd fails the job (state: failed) rather than silently falling back to the server's own working directory. Defaults to the server's own working directory when omitted.",
    },
    env: {
      type: "object",
      description:
        "Controls the child's environment. mode 'merge' (default) layers vars over a minimal base environment (PATH, HOME, and on Windows SystemRoot/USERPROFILE) - never the server's full environment. mode 'replace' uses ONLY vars, with no base at all.",
      properties: {
        mode: { type: "string", enum: ["merge", "replace"] },
        vars: { type: "object", additionalProperties: { type: "string" } },
      },
    },
    label: {
      type: "string",
      description:
        "An optional human-readable label for this job. At most 64 characters, no control characters.",
      maxLength: MAX_LABEL_LENGTH,
    },
  },
  required: ["command"],
  // The `command.anyOf` above alone lets
  // AJV accept a bare shell STRING even when `shell` is omitted/false - it
  // has no way to connect `command`'s shape to a SIBLING property's value.
  // `if`/`then`/`else` (draft-07, supported by the SDK's own AJV instance -
  // see AjvJsonSchemaValidator, which uses a default `new Ajv()`) is the
  // standard JSON Schema way to express that dependency: when `shell` is
  // NOT literally `true`, an additional constraint applies ON TOP of (ANDed
  // with) `command`'s own `anyOf` above, narrowing it to ONLY the argv-array
  // shape - closing exactly the gap the handler's own `validateCommand`
  // already enforced at runtime. `items.minLength: 1` here ALSO closes the
  // gap where `{command: [""]}` passed AJV despite the handler rejecting
  // an empty `argv[0]` - but deliberately ONLY in this
  // non-shell-argv branch: with `shell: true`, the handler's own
  // `validateCommand` joins an array's tokens with spaces and only rejects
  // the WHOLE joined-and-trimmed string being empty, so an individual empty
  // token is legitimately accepted there - adding `minLength: 1` to the
  // shared top-level `command.anyOf` array branch instead would create a
  // NEW schema/handler disagreement in the opposite direction (schema
  // over-rejecting what the handler accepts).
  if: {
    properties: { shell: { const: true } },
    required: ["shell"],
  },
  else: {
    properties: {
      command: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
      },
    },
  },
};

interface ValidatedRunInput {
  /** Real argv for a non-shell job (argv[0] is the program). Empty for a shell job - use `shellCommand` instead. */
  readonly argv: string[];
  readonly shellCommand?: string;
  readonly rawCwd?: string;
  readonly envMode: "merge" | "replace";
  readonly envVars: Record<string, string>;
  readonly label?: string;
}

type ValidationResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/**
 * @param args - the raw `tools/call` arguments, exactly as the client sent
 *   them (unvalidated - validating against `inputSchema` is this handler's
 *   own job, per the server's error-class distinction: a schema-invalid
 *   call is a normal successful RPC whose result is a tool execution error,
 *   never a JSON-RPC protocol error - preserved here for run's own real
 *   validation).
 */
export function handler(args: Record<string, unknown> | undefined): CallToolResult {
  const validated = validateRunInput(args);
  if (!validated.ok) return toolError(validated.message);
  const { argv, shellCommand, rawCwd, envMode, envVars, label } = validated.value;
  const isShell = shellCommand !== undefined;

  const cwdResult = resolveCwd(rawCwd);
  const resolvedEnv = buildChildEnv(envMode, envVars);
  const internalArgv = isShell ? [shellCommand] : argv;

  if (!cwdResult.ok) {
    const record = jobStore.createFailedJob({
      argv: internalArgv,
      cwd: rawCwd ?? process.cwd(),
      env: resolvedEnv,
      label,
      isShell,
      diagnosticMessage: cwdResult.message,
    });
    return toolSuccess(toPublicProjection(record, jobStore.getOutputCounts(record.job_id)));
  }

  if (!isShell) {
    const resolvedBinary = resolveExecutable(argv[0]!, cwdResult.resolvedCwd, resolvedEnv);
    if (resolvedBinary === undefined) {
      const record = jobStore.createFailedJob({
        argv: internalArgv,
        cwd: cwdResult.resolvedCwd,
        env: resolvedEnv,
        label,
        isShell,
        diagnosticMessage: "command not found or not executable",
      });
      return toolSuccess(toPublicProjection(record, jobStore.getOutputCounts(record.job_id)));
    }
  }

  const record = jobStore.createJob({
    argv: internalArgv,
    cwd: cwdResult.resolvedCwd,
    env: resolvedEnv,
    label,
    isShell,
  });
  const jobId = record.job_id;

  const child = spawnManaged(
    { argv, shellCommand, cwd: cwdResult.resolvedCwd, env: resolvedEnv },
    {
      onSpawn: () => jobStore.markRunning(jobId),
      onError: (message) => jobStore.markSpawnFailed(jobId, message),
      onExit: (code, signal) => jobStore.markExited(jobId, code, signal),
      onStdoutChunk: (chunk) => jobStore.appendOutput(jobId, "stdout", chunk),
      onStderrChunk: (chunk) => jobStore.appendOutput(jobId, "stderr", chunk),
      onStdoutEnd: () => jobStore.finalizeStream(jobId, "stdout"),
      onStderrEnd: () => jobStore.finalizeStream(jobId, "stderr"),
    }
  );
  if (child !== undefined) jobStore.attachChild(jobId, child);

  // Re-read from the store rather than reusing `record`: spawnManaged's
  // synchronous try/catch path (see its docs) can already have called
  // `onError` by the time it returns, so the freshest state may already
  // differ from what `createJob` originally returned.
  return toolSuccess(toPublicProjection(jobStore.get(jobId)!, jobStore.getOutputCounts(jobId)));
}

function validateRunInput(
  args: Record<string, unknown> | undefined
): ValidationResult<ValidatedRunInput> {
  const shellRaw = args?.shell;
  if (shellRaw !== undefined && typeof shellRaw !== "boolean") {
    return { ok: false, message: 'run\'s "shell" argument, if provided, must be a boolean' };
  }
  const shell = shellRaw === true;

  const commandResult = validateCommand(args?.command, shell);
  if (!commandResult.ok) return commandResult;

  if (args?.cwd !== undefined && typeof args.cwd !== "string") {
    return { ok: false, message: 'run\'s "cwd" argument, if provided, must be a string' };
  }

  const envResult = validateEnvArg(args?.env);
  if (!envResult.ok) return envResult;

  const labelResult = validateLabel(args?.label);
  if (!labelResult.ok) return labelResult;

  return {
    ok: true,
    value: {
      argv: commandResult.value.argv,
      shellCommand: commandResult.value.shellCommand,
      rawCwd: args?.cwd as string | undefined,
      envMode: envResult.value.mode,
      envVars: envResult.value.vars,
      label: labelResult.value,
    },
  };
}

/**
 * By default (`shell` omitted or `false`), `command` MUST be
 * a real argv array of strings, length >= 1, with a non-empty program name
 * (`argv[0]`) - a bare shell string is rejected outright. With
 * `shell: true`, `command` may instead be a non-empty shell
 * STRING, or a non-empty array of strings joined with a single space into
 * one shell command line (a convenience for simple cases - a caller that
 * needs precise control over quoting/spacing should pass a single string
 * element instead).
 */
function validateCommand(
  command: unknown,
  shell: boolean
): ValidationResult<{ argv: string[]; shellCommand?: string }> {
  if (shell) {
    if (typeof command === "string") {
      if (command.length === 0) {
        return {
          ok: false,
          message:
            'run requires a non-empty "command" (a shell string or argv array) with shell: true',
        };
      }
      return { ok: true, value: { argv: [], shellCommand: command } };
    }
    if (
      Array.isArray(command) &&
      command.length > 0 &&
      command.every((element) => typeof element === "string")
    ) {
      const joined = (command as string[]).join(" ");
      if (joined.trim().length === 0) {
        return {
          ok: false,
          message:
            'run\'s "command" array must contain at least one non-empty string with shell: true',
        };
      }
      return { ok: true, value: { argv: [], shellCommand: joined } };
    }
    return {
      ok: false,
      message:
        'with shell: true, run\'s "command" must be a non-empty string or a non-empty array of strings',
    };
  }

  if (!Array.isArray(command) || command.length === 0) {
    return {
      ok: false,
      message:
        'run requires "command" as a non-empty argv array of strings (e.g. ["ls", "-la"]) - a bare shell string is only accepted with shell: true',
    };
  }
  if (!command.every((element) => typeof element === "string")) {
    return { ok: false, message: 'every element of run\'s "command" argv array must be a string' };
  }
  const argv = command as string[];
  if (argv[0]!.length === 0) {
    return {
      ok: false,
      message: 'run\'s "command" argv[0] (the program to run) must be a non-empty string',
    };
  }
  return { ok: true, value: { argv } };
}

function validateEnvArg(
  env: unknown
): ValidationResult<{ mode: "merge" | "replace"; vars: Record<string, string> }> {
  if (env === undefined) return { ok: true, value: { mode: "merge", vars: {} } };
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    return { ok: false, message: 'run\'s "env" argument, if provided, must be an object' };
  }
  const record = env as Record<string, unknown>;

  const modeRaw = record.mode;
  if (modeRaw !== undefined && modeRaw !== "merge" && modeRaw !== "replace") {
    return { ok: false, message: 'run\'s "env.mode", if provided, must be "merge" or "replace"' };
  }
  const mode = (modeRaw as "merge" | "replace" | undefined) ?? "merge";

  const varsRaw = record.vars;
  if (varsRaw === undefined) return { ok: true, value: { mode, vars: {} } };
  if (typeof varsRaw !== "object" || varsRaw === null || Array.isArray(varsRaw)) {
    return {
      ok: false,
      message: 'run\'s "env.vars", if provided, must be an object of string values',
    };
  }
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(varsRaw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      return { ok: false, message: `run's "env.vars.${key}" must be a string` };
    }
    vars[key] = value;
  }
  return { ok: true, value: { mode, vars } };
}

function validateLabel(label: unknown): ValidationResult<string | undefined> {
  if (label === undefined) return { ok: true, value: undefined };
  if (typeof label !== "string") {
    return { ok: false, message: 'run\'s "label" argument, if provided, must be a string' };
  }
  // Count Unicode CODE POINTS here, the
  // same way the advertised schema's `maxLength: 64` does (see
  // codePointLength's own docs) - NOT native `.length` (UTF-16 code units),
  // which over-counts a surrogate-pair emoji as 2 and could reject a label
  // the schema itself already accepted as valid.
  if (codePointLength(label) > MAX_LABEL_LENGTH) {
    return { ok: false, message: `run's "label" must be at most ${MAX_LABEL_LENGTH} characters` };
  }
  if (hasControlCharacter(label)) {
    return { ok: false, message: 'run\'s "label" must not contain control characters' };
  }
  return { ok: true, value: label };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolSuccess(projection: PublicJobProjection): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(projection, null, 2) }],
    structuredContent: { ...projection },
  };
}
