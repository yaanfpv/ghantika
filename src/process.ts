/**
 * Process-spawning/management primitives. Owns everything about turning a validated
 * intent ("run this argv, or this shell command line, with this cwd/env")
 * into a real OS process: pre-flight cwd/executable resolution (so
 * `src/tools/run.ts` can tell a doomed spawn attempt apart from a real one
 * BEFORE ever calling `child_process.spawn`), building a child's
 * environment from `run`'s `env.mode`, and the actual spawn + event wiring.
 * `src/tools/run.ts` orchestrates calls into this module and into
 * `src/jobStore.ts`; this module knows nothing about `JobStore` itself
 * (kept decoupled/independently testable, matching the existing
 * `test/process.test.ts` pattern of importing this module alone).
 *
 * The one piece of this load-bearing on stdio purity is
 * `MANAGED_CHILD_STDIO`, defined below.
 */
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StdioOptions } from "node:child_process";

/**
 * MCP over stdio uses the SERVER's own stdout as the entire protocol
 * channel (see `src/server.ts`'s docs) - a single stray byte from a child
 * process reaching it corrupts every JSON-RPC message after it. So a
 * managed child's stdout (and stderr) is always `"pipe"`, never
 * `"inherit"`; stdin is `"ignore"` (`run` is fire-and-forget, never
 * interactive). `test/process.test.ts` asserts this exact shape.
 */
export const MANAGED_CHILD_STDIO: StdioOptions = ["ignore", "pipe", "pipe"];

// ---------------------------------------------------------------------------
// cwd resolution
// ---------------------------------------------------------------------------

export type CwdResolution =
  | { readonly ok: true; readonly resolvedCwd: string }
  | { readonly ok: false; readonly message: string };

/**
 * Resolves and validates a job's working directory. An OMITTED `rawCwd`
 * defaults to the server's own `process.cwd()` (documented default
 * behavior). A PROVIDED `rawCwd` that doesn't exist, or exists but isn't a
 * directory, is a validation failure - this deliberately forbids
 * silently falling back to the server's own cwd in that case; the caller
 * (`src/tools/run.ts`) turns a `{ok:false}` here into an already-failed job
 * (`diagnostic.reason: "spawn-error"`) rather than ever attempting to spawn.
 * The successful resolution is realpath-resolved, per the
 * frozen internal `JobRecord.cwd` shape.
 */
export function resolveCwd(rawCwd: string | undefined): CwdResolution {
  const target = rawCwd ?? process.cwd();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return {
      ok: false,
      message:
        rawCwd === undefined
          ? "the server's own working directory is inaccessible"
          : "cwd does not exist",
    };
  }
  if (!stat.isDirectory()) {
    return { ok: false, message: "cwd exists but is not a directory" };
  }
  try {
    return { ok: true, resolvedCwd: fs.realpathSync(target) };
  } catch {
    return { ok: false, message: "cwd could not be resolved" };
  }
}

// ---------------------------------------------------------------------------
// Environment resolution
// ---------------------------------------------------------------------------

export type EnvMode = "merge" | "replace";

/**
 * The default PATH POSIX systems use when a child is spawned with an `env`
 * option that doesn't itself set PATH - confirmed against Node's own
 * `child_process` documentation: "The command lookup is performed using the
 * options.env.PATH environment variable if env is in the options object.
 * ... If options.env is set without PATH, lookup on Unix is performed on a
 * default search path search of /usr/bin:/bin". Used both as part of our
 * own minimal base environment (below) and by `resolveExecutable`'s
 * pre-flight PATH search, so that search mirrors what the real spawn will
 * actually do.
 */
export const POSIX_DEFAULT_PATH = "/usr/bin:/bin";

/**
 * The minimal base environment `env.mode: "merge"` (the default) layers the
 * caller's `env.vars` over - deliberately NOT the full server `process.env`
 * inherited wholesale. Chosen set, and why each is here:
 *
 * - `PATH` (both platforms): without it, a bare (non-path) command name
 *   can't be resolved to an executable at all - this tool would be unable
 *   to run almost anything. Sourced from the server's own `process.env`,
 *   falling back to `POSIX_DEFAULT_PATH` on POSIX if the server itself
 *   somehow has none.
 * - `HOME` (POSIX only): read by a large fraction of real-world CLI tools
 *   (shells, git, npm, ...) to locate config/profile state; omitting it
 *   entirely breaks many ordinary commands in surprising ways.
 * - `SystemRoot` (Windows only): required by the Windows loader/many system
 *   DLLs (e.g. anything touching sockets) to start at all - a
 *   well-documented "the application was unable to start correctly"
 *   footgun for a spawned process missing it.
 * - `USERPROFILE` (Windows only): the closest Windows analogue to POSIX's
 *   `HOME`, for the same class of tools that expect a home directory.
 *
 * `env.mode: "replace"` uses ONLY the caller's `env.vars` - this base is
 * never applied in that mode, so replace mode still inherits no server
 * env at all.
 */
function computeMinimalBaseEnv(): Record<string, string> {
  if (process.platform === "win32") {
    const base: Record<string, string> = {};
    const winPath = effectiveWindowsServerPath();
    if (winPath !== undefined) base.PATH = winPath;
    if (process.env.SystemRoot !== undefined) base.SystemRoot = process.env.SystemRoot;
    if (process.env.USERPROFILE !== undefined) base.USERPROFILE = process.env.USERPROFILE;
    return base;
  }
  const base: Record<string, string> = { PATH: process.env.PATH ?? POSIX_DEFAULT_PATH };
  if (process.env.HOME !== undefined) base.HOME = process.env.HOME;
  return base;
}

/**
 * Windows environment variables are case-insensitive, so the server's own
 * PATH might be visible to this process as `process.env.PATH` or
 * `process.env.Path` depending on how it was launched. `process.env` itself
 * is already exposed by Node as case-insensitive on Windows, so a plain
 * `process.env.PATH` read is correct there too - this helper exists mainly
 * to document that this codebase deliberately does its OWN case-folding
 * nowhere else (see `buildChildEnv`'s docs): Node's `child_process` APIs
 * are documented to handle Windows env-key case-insensitivity correctly on
 * their own when building the CHILD's environment, so this file never
 * re-implements that for values it passes through.
 */
function effectiveWindowsServerPath(): string | undefined {
  return process.env.PATH;
}

/**
 * Resolves which key of `env` Windows' case-insensitive env-key handling
 * would actually pick for "PATH", when `env` may contain multiple case-
 * varied spellings at once (`PATH`/`Path`/`path`) - mirroring Node's own
 * documented behavior for building a CHILD's environment on Windows:
 * "Node.js lexicographically sorts the env keys and uses the first one
 * that case-insensitively matches" (see `buildChildEnv`'s own docs for the
 * same citation). Returns `undefined` when `env` has no key that case-
 * insensitively matches "PATH" at all.
 *
 * Exported as its own small, PURE, platform-INDEPENDENT function
 * specifically so this exact resolution can be unit-tested directly on
 * any host, regardless of which OS actually runs the assertion
 * (guarding against a "Windows env-key casing collision" regression) -
 * `effectivePathForLookup` below gates USE of this behind
 * `process.platform === "win32"`, so that internal branch never runs as
 * live code during local development on a non-Windows machine. There is
 * currently no Windows leg in this repo's CI matrix at all (temporarily
 * removed; see CHANGELOG), so that win32-gated call site is not exercised
 * against a real Windows host anywhere right now. This function's own
 * ALGORITHM stays directly verified independent of that: the case-
 * insensitive-key-resolution logic is not itself platform-specific, and
 * this file's own test suite exercises it against real PATH/Path/path
 * casing-collision fixtures on whatever host the suite runs on - which is
 * exactly what "exported as its own small, pure function" above is for.
 */
export function resolveCaseInsensitivePathKey(
  env: Readonly<Record<string, string>>
): string | undefined {
  const pathKeys = Object.keys(env)
    .filter((key) => key.toUpperCase() === "PATH")
    .sort();
  return pathKeys.length > 0 ? pathKeys[0] : undefined;
}

/**
 * Resolves the environment `spawnManaged` will actually pass to the child,
 * per `env.mode`. Deliberately does no case-folding of its
 * own: per Node's `child_process` documentation, "Node.js lexicographically
 * sorts the env keys and uses the first one that case-insensitively
 * matches" when building a child's environment on Windows, so passing the
 * caller's keys through exactly as given (rather than normalizing them
 * ourselves) is what lets Node's own documented, correct handling apply.
 */
export function buildChildEnv(
  mode: EnvMode,
  vars: Readonly<Record<string, string>>
): Record<string, string> {
  if (mode === "replace") {
    return { ...vars };
  }
  return { ...computeMinimalBaseEnv(), ...vars };
}

// ---------------------------------------------------------------------------
// Executable resolution (the "bad binary" pre-flight check)
// ---------------------------------------------------------------------------

/**
 * Best-effort pre-flight check for whether `command` resolves to a real,
 * executable file - run BEFORE ever calling `child_process.spawn`, so a
 * doomed attempt becomes an already-`failed` job rather
 * than racing an async OS-level error. Mirrors execvp-style resolution:
 *
 * - A command containing a path separator is treated as a literal path
 *   (resolved against `cwd` if relative - matching how Node itself resolves
 *   a slash-containing command against `options.cwd`, verified empirically:
 *   a relative `"./script.sh"` with a `cwd` option runs the script under
 *   that cwd regardless of the server's own `process.cwd()`), never
 *   PATH-searched.
 * - A bare command name is searched across `effectivePathForLookup`'s
 *   result, split on `path.delimiter`.
 *
 * Not a spawn - a real spawn can still race this (permissions changing
 * between the check and the actual `spawn()` call); `spawnManaged`'s own
 * `error` handling is the defense-in-depth backstop for that. Returns the
 * resolved candidate path on success, `undefined` if nothing executable was
 * found.
 */
export function resolveExecutable(
  command: string,
  cwd: string,
  env: Readonly<Record<string, string>>
): string | undefined {
  const hasSeparator = command.includes("/") || command.includes(path.sep);
  if (hasSeparator) {
    const candidate = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return isExecutableFile(candidate) ? candidate : undefined;
  }

  const pathValue = effectivePathForLookup(env);
  const dirs = pathValue.split(path.delimiter).filter((entry) => entry.length > 0);
  for (const dir of dirs) {
    // A PATH entry itself can be RELATIVE
    // (`PATH: "."` is real, legal PATH content) - `path.join(dir, name)`
    // alone never resolves a relative `dir` against anything, so the
    // resulting candidate stayed a bare relative path string that
    // `fs.statSync` (inside `isExecutableFile`) then resolved against THIS
    // SERVER's own `process.cwd()`, not the CHILD's intended `cwd` - the
    // exact opposite of how Node's real `spawn()` resolves a relative PATH
    // entry (verified against a direct `node spawn(name, {cwd, env:
    // {PATH: "."}})`, which correctly finds a fixture executable living in
    // `cwd`). Resolving each relative PATH entry against `cwd` FIRST closes
    // that gap; an already-absolute PATH entry is used exactly as before.
    const baseDir = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
    for (const candidateName of windowsExtensionCandidates(command)) {
      const candidate = path.join(baseDir, candidateName);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirrors Node's own documented PATH-lookup source for a child spawned WITH
 * an `env` option (which `spawnManaged` always passes): "The command lookup
 * is performed using the options.env.PATH environment variable if env is in
 * the options object. ... If options.env is set without PATH, lookup on
 * Unix is performed on a default search path search of /usr/bin:/bin ...
 * on Windows the current process's environment variable PATH is used."
 */
function effectivePathForLookup(env: Readonly<Record<string, string>>): string {
  if (process.platform === "win32") {
    // Windows env keys are case-insensitive; Node sorts case-varied keys
    // lexicographically and uses the first match (see buildChildEnv's
    // docs and resolveCaseInsensitivePathKey's own docs) - mirror that
    // here so this prediction matches what a real spawn will actually
    // resolve against.
    const pathKey = resolveCaseInsensitivePathKey(env);
    if (pathKey !== undefined) return env[pathKey]!;
    return process.env.PATH ?? "";
  }
  return env.PATH ?? POSIX_DEFAULT_PATH;
}

/**
 * On Windows, a bare command with no extension is tried against each
 * extension in `PATHEXT` (in addition to the bare name), matching
 * `cmd.exe`/`CreateProcess`'s own resolution. Everything below the
 * platform check is a best-effort reading of that documented behavior. A
 * macOS or Linux run returns at the first line and never reaches any of
 * it, and, with no Windows leg in this repo's CI matrix at all right now
 * (temporarily removed; see CHANGELOG), nothing exercises the rest of
 * this function against a real `CreateProcess` anywhere either - the
 * branch below is currently verified only by reading, not by execution.
 */
function windowsExtensionCandidates(command: string): string[] {
  if (process.platform !== "win32") return [command];
  if (path.extname(command) !== "") return [command];
  const pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = pathExt.split(";").filter((entry) => entry.length > 0);
  return [command, ...extensions.map((extension) => command + extension)];
}

// ---------------------------------------------------------------------------
// spawnManaged
// ---------------------------------------------------------------------------

export interface SpawnManagedOptions {
  /** Ignored when `shellCommand` is set. Otherwise `argv[0]` is the program, `argv.slice(1)` its arguments - no shell interpretation. */
  readonly argv: readonly string[];
  /** When set, spawn this full command line via the platform shell instead of `argv` (the `shell: true` escape hatch). */
  readonly shellCommand?: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ManagedChildCallbacks {
  /** The OS confirmed the process actually started (`spawn` event). */
  readonly onSpawn: () => void;
  /** A real spawn-level failure (async `error` event, or a synchronous throw from `child_process.spawn` itself - see this function's docs for why both are handled). */
  readonly onError: (message: string) => void;
  readonly onExit: (exitCode: number | null, signal: NodeJS.Signals | null) => void;
  readonly onStdoutChunk: (chunk: Buffer) => void;
  readonly onStderrChunk: (chunk: Buffer) => void;
  readonly onStdoutEnd: () => void;
  readonly onStderrEnd: () => void;
}

/**
 * Whether `spawnManaged` puts a freshly spawned child in its OWN, detached
 * process group rather than inheriting this server's own group -
 * the real POSIX containment primitive. `detached: true` makes
 * libuv call `setpgid` on the child BEFORE it execs the target program
 * (verified against Node's own `child_process` documentation: with
 * `detached` set, "the child will be a group leader"). There is no window
 * in which the child exists but is NOT yet its own group leader, and no
 * later Node API to join/re-parent a process into a group after the fact -
 * so the property holds by construction (assigned at spawn time, never
 * late, never allowing breakaway), not by a runtime check this file could
 * get wrong later. Once the child is its own
 * group leader, its pid IS the group's pgid - every kill primitive below
 * relies on exactly that identity, so it never has to track a separate
 * pgid value alongside the pid.
 *
 * Windows-only, gated off: on Windows `detached` means something different
 * (survivability past the parent, and its own console window - suppressed
 * here via `windowsHide`) and does nothing for tree containment. This
 * codebase's Windows kill path is a best-effort `taskkill /t` fallback
 * instead of a real Job Object (see `killProcessTreeWindows`'s own docs
 * for the honest reason why a true Job Object isn't implemented), so
 * there's nothing here for `detached` to help with on that platform.
 */
const CONTAIN_IN_OWN_PROCESS_GROUP = process.platform !== "win32";

/**
 * Spawns a real, managed child process and wires its lifecycle/output
 * events to `callbacks` - never awaits anything, so a caller (`run.ts`)
 * that calls this and immediately reads back a `starting`-state job is
 * genuinely non-blocking: the OS-level `spawn`/`error`/
 * `exit` events are ALWAYS asynchronous relative to this call returning
 * (verified empirically against the installed Node version - even an
 * immediately-doomed ENOENT spawn reports its failure via a later `error`
 * event, never synchronously).
 *
 * `child_process.spawn` itself is still wrapped in a try/catch: most
 * failure classes (a missing binary, a nonexistent cwd) are async-only, but
 * at least one (a `cwd` that exists but is a FILE, not a directory) throws
 * SYNCHRONOUSLY from `spawn()` itself (verified empirically: `ENOTDIR`).
 * `run.ts`'s own pre-flight `resolveCwd` is expected to catch that case
 * before ever reaching here, but this catch is the backstop that turns any
 * gap in that pre-check into a normal `onError` callback instead of an
 * uncaught exception.
 *
 * Returns the real `ChildProcess` on success (so the caller can retain it
 * for a future `kill`), or `undefined` if the synchronous throw
 * path was hit (in which case `onError` has already been called and there
 * is no live child to retain).
 */
export function spawnManaged(
  options: SpawnManagedOptions,
  callbacks: ManagedChildCallbacks
): ChildProcess | undefined {
  let child: ChildProcess;
  try {
    if (options.shellCommand !== undefined) {
      // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- running a caller-supplied shell command via a real shell is this tool's documented, intentional purpose (`run`'s `shell: true` opt-in), not an oversight.
      child = spawn(options.shellCommand, {
        cwd: options.cwd,
        env: options.env,
        stdio: MANAGED_CHILD_STDIO,
        shell: true,
        windowsHide: true,
        detached: CONTAIN_IN_OWN_PROCESS_GROUP,
      });
    } else {
      const [program, ...args] = options.argv;
      child = spawn(program ?? "", args, {
        cwd: options.cwd,
        env: options.env,
        stdio: MANAGED_CHILD_STDIO,
        windowsHide: true,
        detached: CONTAIN_IN_OWN_PROCESS_GROUP,
      });
    }
  } catch (error) {
    callbacks.onError(error instanceof Error ? error.message : String(error));
    return undefined;
  }

  child.once("spawn", () => callbacks.onSpawn());
  child.once("error", (error: Error) => callbacks.onError(error.message));
  child.once("exit", (code, signal) => callbacks.onExit(code, signal));
  child.stdout?.on("data", (chunk: Buffer) => callbacks.onStdoutChunk(chunk));
  child.stderr?.on("data", (chunk: Buffer) => callbacks.onStderrChunk(chunk));
  child.stdout?.once("end", () => callbacks.onStdoutEnd());
  child.stderr?.once("end", () => callbacks.onStderrEnd());

  return child;
}

// ---------------------------------------------------------------------------
// kill: process-tree containment and termination
// ---------------------------------------------------------------------------

export type IdentityCheckResult =
  | { readonly status: "alive-confirmed" }
  | { readonly status: "not-found" }
  | { readonly status: "identity-mismatch"; readonly reason: string }
  /**
   * The identity OBSERVER itself (the `ps` shell-out) failed to execute or
   * produced output this codebase could not parse - genuinely different
   * from `not-found` (which means `ps` ran fine and confirmed there is no
   * such pid): here, `ps` never gave a usable answer at all, so this
   * codebase has no basis for either "confirmed alive" or "confirmed
   * gone." Collapsing this into `not-found` is exactly the bug this
   * variant exists to close - see `readProcessElapsedSeconds`'s own docs.
   */
  | { readonly status: "observer-failure"; readonly reason: string };

/**
 * How many seconds of drift between a process's REAL elapsed time (as
 * reported by `ps`) and the elapsed time this codebase EXPECTS (derived
 * from the `spawnedAtMs` it recorded) is tolerated before treating a pid
 * as a mismatch. Generous enough to absorb two real,
 * unavoidable sources of slack - `ps -o etime=`'s own whole-second
 * rounding/truncation, and the small (sub-millisecond in practice) gap
 * between the real OS `spawn()` call and `JobStore.attachChild` recording
 * `spawnedAtMs` (see that method's own docs) - while still tight enough to
 * reject a pid that has clearly belonged to a process started at a
 * meaningfully different time than the one this codebase actually spawned.
 */
export const IDENTITY_TOLERANCE_SECONDS = 5;

/**
 * Parses `ps -o etime=`'s output - `[[dd-]hh:]mm:ss` (verified empirically
 * against the installed macOS/BSD `ps`; GNU/procps `ps` on Linux formats
 * `etime` compatibly per its own documented man page - `etime` was chosen
 * over the locale-dependent `lstart` date text and over the Linux-only
 * `etimes` seconds-only field specifically for this cross-platform
 * portability) - into a total whole-second count. Returns `undefined` for
 * text that doesn't match the expected shape at all (defensive: an
 * unrecognized `ps` output format must never be silently treated as "0
 * seconds old", which would make a genuinely long-lived, correctly-
 * identified process look suspiciously freshly-started and could wrongly
 * fail the identity check).
 */
export function parseEtime(raw: string): number | undefined {
  const trimmed = raw.trim();
  const dayMatch = trimmed.match(/^(\d+)-(.+)$/);
  const days = dayMatch ? Number(dayMatch[1]) : 0;
  const rest = dayMatch ? dayMatch[2]! : trimmed;
  const parts = rest.split(":");
  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((part) => part.length === 0 || !/^\d+$/.test(part))
  ) {
    return undefined;
  }
  const numbers = parts.map(Number);
  const [hours, minutes, seconds] =
    numbers.length === 3 ? [numbers[0]!, numbers[1]!, numbers[2]!] : [0, numbers[0]!, numbers[1]!];
  return days * 86_400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * Whether `actualElapsedSeconds` (real, `ps`-observed) and
 * `expectedElapsedSeconds` (derived from this codebase's own recorded
 * `spawnedAtMs`) are close enough to call the same process - the pure
 * comparison at the heart of `checkProcessIdentity`, split out on its own
 * so it's directly unit-testable with synthetic values (no real `ps` call
 * or real process needed).
 */
export function identityElapsedTimesMatch(
  actualElapsedSeconds: number,
  expectedElapsedSeconds: number,
  toleranceSeconds: number = IDENTITY_TOLERANCE_SECONDS
): boolean {
  return Math.abs(actualElapsedSeconds - expectedElapsedSeconds) <= toleranceSeconds;
}

/** The real outcome of one `ps -p <pid> -o etime=` read - see `readProcessElapsedSeconds`'s own docs for why this is a three-way discrimination, not the `number | undefined` shape this used to return. */
export type ElapsedSecondsReadResult =
  | { readonly status: "found"; readonly elapsedSeconds: number }
  | { readonly status: "not-found" }
  | { readonly status: "observer-failure"; readonly reason: string };

/**
 * Reads `pid`'s real elapsed wall-clock time from the OS via a real `ps`
 * invocation - and, critically, distinguishes WHY no usable reading came
 * back, rather than collapsing every failure into one `undefined`:
 *
 * - `not-found`: `ps` ran successfully and reported, via its own
 *   documented "no such pid" exit code (verified empirically: status 1,
 *   no output), that this pid genuinely isn't alive. A confident,
 *   positive result.
 * - `observer-failure`: `ps` itself failed to execute (a missing binary -
 *   `ENOENT`; a permission failure; any other execution error) or
 *   produced output this codebase couldn't parse. This is NOT a claim
 *   that the pid is alive or dead - it's a claim that the OBSERVER is
 *   broken/unavailable right now, so this codebase has no basis for
 *   either answer. Every caller of this function (`checkProcessIdentity`
 *   below) must treat this differently from `not-found`: silently
 *   collapsing the two let an observer failure masquerade as "nothing
 *   left to signal" and produce a FALSE SUCCESS while the real process
 *   group stayed completely unsignaled and alive - the exact bug this
 *   type exists to close.
 */
/**
 * Interprets a `ps -p <pid> -o etime=` invocation's real STDOUT, once it has
 * actually exited zero (a successful lookup) - the one piece of parsing
 * logic BOTH the sync (`readProcessElapsedSeconds`, via `execFileSync`) and
 * async (`readProcessElapsedSecondsAsync`, via `execFile`) observers share,
 * factored out here so a change to how empty/unparseable output is
 * classified can never drift between the two call paths. See
 * `ElapsedSecondsReadResult`'s own docs for what each outcome means.
 */
function interpretPsOutput(output: string): ElapsedSecondsReadResult {
  if (output.trim().length === 0) {
    // ps exited 0 (success) but printed nothing at all - never actually
    // observed against a real `ps` in this codebase's own testing, but
    // this is still an unusable/ambiguous result, not a confident
    // "not-found" - treated the same as unparseable output below.
    return { status: "observer-failure", reason: "ps produced no output" };
  }
  const elapsedSeconds = parseEtime(output);
  if (elapsedSeconds === undefined) {
    return {
      status: "observer-failure",
      reason: `ps produced output this codebase could not parse: ${JSON.stringify(output)}`,
    };
  }
  return { status: "found", elapsedSeconds };
}

function readProcessElapsedSeconds(pid: number): ElapsedSecondsReadResult {
  let output: string;
  try {
    output = execFileSync("ps", ["-p", String(pid), "-o", "etime="], { encoding: "utf8" });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number | null };
    if (err.status === 1) {
      // ps's own documented "no such pid" exit code - a real, confident
      // "genuinely not alive" result, never itself an observer failure.
      return { status: "not-found" };
    }
    return {
      status: "observer-failure",
      reason:
        err.code !== undefined
          ? `ps failed to execute (${err.code})`
          : `ps failed unexpectedly: ${err.message ?? String(error)}`,
    };
  }
  return interpretPsOutput(output);
}

/**
 * `execFile`'s callback-form error carries its exit code / spawn-error code
 * on the SAME `code` property, typed by Node's own `child_process.d.ts` as
 * `ExecFileException["code"]: number | string` - genuinely different from
 * `NodeJS.ErrnoException.code`'s `string`-only type (`execFileSync`'s
 * thrown-error shape), which is why this needs its own local type rather
 * than reusing `NodeJS.ErrnoException` here (intersecting the two would
 * collapse `code`'s type back down to `string`, silently losing the
 * numeric exit-code case entirely).
 */
type ExecFileCallbackError = Error & { readonly code?: string | number | null };

/**
 * How much longer than the caller's own `timeoutMs` this function waits,
 * on top of `execFile`'s own internal `timeout`, before giving up on the
 * child regardless of whether it has actually exited. `execFile`'s
 * `timeout` option only SENDS a signal (SIGTERM by default) once
 * `timeoutMs` elapses - it does not, and cannot, guarantee the child
 * actually dies from it, so a settlement bound built entirely on that
 * option is not a hard bound at all (see this function's own docs for the
 * real, reproduced case: an observer that installs a SIGTERM handler and
 * ignores it). This grace exists only to give an ORDINARY, cooperative
 * child - one that actually does die from SIGTERM, which is the common
 * case - a brief real window to have its exit observed and reported
 * through the normal callback before the external bound below forces the
 * issue; it is not slack for a resistant child, which the external bound
 * catches regardless.
 */
const ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS = 250;

/**
 * The ASYNC counterpart of `readProcessElapsedSeconds` above - the same
 * real observation (`ps -p <pid> -o etime=`) and the same three-way result
 * shape (shared via `interpretPsOutput` for the success path), but through
 * Node's callback-based `execFile` instead of the blocking `execFileSync`.
 *
 * The settlement bound is CALLER-SIDE, independent of the child's own
 * cooperation - not `execFile`'s own `timeout` option alone. `execFile`'s
 * `timeout` sends `killSignal` (SIGTERM by default) once `timeoutMs`
 * elapses, but that is a request, not a guarantee: a child that installs
 * its own SIGTERM handler and ignores it (reproduced directly against this
 * function: a fake `ps` that does exactly that resolves over 2.5 real
 * seconds past a configured 1-second bound) leaves `execFile`'s own
 * callback genuinely unfired, and a promise built on that callback alone
 * stays pending for as long as the child does - which can be indefinitely.
 * `kill()` and the shutdown reaper both await this same promise through
 * `JobStore.resolveBirthIdentityForKill`, so an unbounded promise here
 * means either can hang past every timeout this codebase claims. A second,
 * independent timer (`setTimeout`, not tied to the child at all) forces
 * this promise to settle at `timeoutMs + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS`
 * regardless of what the child does, and additionally SIGKILLs the child
 * directly at that point - the OS-level force `execFile`'s own SIGTERM-only
 * request cannot provide - so a resistant observer is not left running
 * merely because it chose not to cooperate with the first signal.
 *
 * `execFile`'s callback-form error shape differs from `execFileSync`'s
 * thrown-error shape in exactly the one place this function has to account
 * for: a real nonzero exit (the `not-found` case, `ps`'s documented exit
 * code 1) surfaces on the callback error's `code` property as a NUMBER
 * (there is no separate `status` field on this error shape, unlike
 * `execFileSync`'s), while a genuine spawn failure (`ps` itself missing,
 * `ENOENT`) surfaces on that SAME `code` property as a STRING. A
 * timeout-triggered kill reports NEITHER shape: `code` is `null` and
 * `signal`/`killed` are set instead (the child died from a signal, not a
 * normal exit) - correctly falling through to the generic
 * `observer-failure` branch below, never mistaken for `not-found` (`ps`
 * itself never actually answered).
 */
function readProcessElapsedSecondsAsync(
  pid: number,
  timeoutMs: number
): Promise<ElapsedSecondsReadResult> {
  return new Promise((resolve) => {
    let settled = false;
    const child = execFile(
      "ps",
      ["-p", String(pid), "-o", "etime="],
      { encoding: "utf8", timeout: timeoutMs },
      (error, stdout) => {
        if (settled) return; // the external bound below already resolved this promise
        settled = true;
        clearTimeout(externalBound);
        if (error === null) {
          resolve(interpretPsOutput(stdout));
          return;
        }
        const err = error as ExecFileCallbackError;
        if (err.code === 1) {
          // ps's own documented "no such pid" exit code, surfaced as a
          // NUMBER on this callback-error shape (see this function's own
          // docs) - a real, confident "genuinely not alive" result.
          resolve({ status: "not-found" });
          return;
        }
        resolve({
          status: "observer-failure",
          reason:
            typeof err.code === "string"
              ? `ps failed to execute (${err.code})`
              : `ps failed unexpectedly: ${err.message ?? String(error)}`,
        });
      }
    );
    const externalBound = setTimeout(() => {
      if (settled) return;
      settled = true;
      // `execFile`'s own timeout already sent SIGTERM at this point (its
      // internal timer and this one both start from the same call); if
      // the observer ignored it, SIGKILL directly - uncatchable/
      // unblockable, so this genuinely ends it rather than sending yet
      // another request the observer could also ignore.
      child.kill("SIGKILL");
      resolve({
        status: "observer-failure",
        reason: `ps did not settle within ${timeoutMs}ms (observer unresponsive to SIGTERM)`,
      });
    }, timeoutMs + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS);
  });
}

/**
 * A managed job leader's real, OS-readable birth identity, captured once
 * via a real `ps -o etime=` read as close to the actual OS-level spawn as
 * this codebase can get (see `captureBirthIdentityPosix`'s own docs) -
 * NOT a fresh `Date.now()`-derived guess, and never re-derived later.
 * `elapsedSecondsAtCapture` is the real, `ps`-observed elapsed age at the
 * moment of capture (typically ~0s, but never assumed to be exactly 0);
 * `capturedAtMs` is this codebase's own wall-clock reading of when that
 * capture happened, which is what lets a LATER identity check compute how
 * much more time should have elapsed since then and compare it against a
 * fresh real `ps` reading - see `checkProcessIdentity`'s own docs.
 */
export interface ProcessBirthIdentity {
  readonly capturedAtMs: number;
  readonly elapsedSecondsAtCapture: number;
}

/**
 * Captures a freshly spawned leader's real birth identity via a BLOCKING
 * `ps` read (`execFileSync`). NULLABLE by design, matching this repo's own
 * established principle that `run()` does NOT fail on a capture failure: a
 * job must still be created and remain killable even when this capture
 * itself fails (`ps` unavailable, unparseable output, or the process
 * already gone by the time this runs - genuinely possible for an extremely
 * short-lived command). `undefined` here is the signal every downstream
 * kill/shutdown caller must treat as "identity was never established for
 * this job" and take the honest, disclosed DEGRADED path (pgid-only
 * signaling, no identity confirmation attempted) rather than silently
 * proceeding as if identity had been confirmed - see
 * `evaluatePreSignalIdentityGate`'s own docs for exactly how.
 *
 * NOT what `run()`'s own production handler calls - a synchronous `ps`
 * shell-out on `run()`'s response path blocks the whole MCP call on
 * however long that one invocation takes, with no bound at all, which
 * defeats `run()`'s own documented "returns immediately, no blocking"
 * contract the instant `ps` is slow or hung (see `src/tools/run.ts`'s own
 * docs). `run()` calls `captureBirthIdentityPosixAsync` below instead,
 * fired off without ever being awaited. This synchronous primitive is kept
 * because it's still directly useful wherever a real, immediately-available
 * birth identity is needed to compare against or seed a fixture with, and
 * because `captureBirthIdentityPosixAsync`'s own success path is built by
 * awaiting the identical `ps -o etime=` observation this function makes
 * synchronously - the two are the same real read, just via `execFileSync`
 * vs. a bounded `execFile`.
 *
 * POSIX only, matching every other identity-check primitive in this file:
 * Windows has no equivalent birth-identity model today (see
 * `killProcessTreeWindows`'s own docs), so this always returns `undefined`
 * there rather than attempting a `ps` call that doesn't exist on that
 * platform.
 */
export function captureBirthIdentityPosix(pid: number): ProcessBirthIdentity | undefined {
  if (process.platform === "win32") return undefined;
  const observed = readProcessElapsedSeconds(pid);
  if (observed.status !== "found") return undefined;
  return { capturedAtMs: Date.now(), elapsedSecondsAtCapture: observed.elapsedSeconds };
}

/**
 * How long the ASYNC birth-identity capture's own `ps` invocation is given
 * to answer before this codebase forcibly kills it (`execFile`'s own
 * `timeout` option sends SIGTERM to the child once this elapses) and
 * treats the attempt as a genuine observer failure - a few real seconds,
 * generous enough that an ordinarily-slow `ps` still succeeds, but bounded
 * so a truly hung one can never leave a capture unsettled indefinitely.
 * This bound is what makes `captureBirthIdentityPosixAsync` safe to fire
 * off from `run()`'s handler WITHOUT ever being awaited there (see
 * `src/tools/run.ts`'s own docs), and it's the same bound that caps how
 * long `kill()`/the shutdown reaper can ever wait when they find a capture
 * still genuinely PENDING at the moment they need it (see
 * `src/jobStore.ts`'s `resolveBirthIdentityForKill` and
 * `src/tools/kill.ts`'s own docs) - awaiting an in-flight capture can never
 * take longer than this, however slow or hung the real `ps` process
 * actually is.
 */
export const ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS = 3000;

/**
 * The ASYNC counterpart of `captureBirthIdentityPosix` above - the one
 * `run()`'s real production handler actually calls (see
 * `src/tools/run.ts`'s handler): the identical real observation and the
 * identical nullable-by-design contract, but built on
 * `readProcessElapsedSecondsAsync` (a bounded, non-blocking `execFile`
 * rather than a blocking `execFileSync`) so a slow or hung `ps` can never
 * hold up `run()`'s own response. `run()` fires this off WITHOUT ever
 * awaiting it - see `src/jobStore.ts`'s `attachPendingIdentityCapture`,
 * which is what tracks the returned promise and updates the job's
 * bookkeeping once it actually settles, strictly after `run()` has already
 * returned. POSIX only, matching the synchronous version (see its own docs
 * for why).
 */
export async function captureBirthIdentityPosixAsync(
  pid: number,
  timeoutMs: number = ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS
): Promise<ProcessBirthIdentity | undefined> {
  if (process.platform === "win32") return undefined;
  const observed = await readProcessElapsedSecondsAsync(pid, timeoutMs);
  if (observed.status !== "found") return undefined;
  return { capturedAtMs: Date.now(), elapsedSecondsAtCapture: observed.elapsedSeconds };
}

/**
 * The real, external-to-our-own-bookkeeping identity check `kill` runs
 * before ever signaling a tracked pid: confirms `pid` is both alive right
 * now AND was actually started at approximately the moment `birthIdentity`
 * (captured once, at spawn time - see `captureBirthIdentityPosix`) says it
 * was - i.e. that it is genuinely still the SAME process this codebase
 * spawned, not an unrelated process that happens to have been assigned the
 * same (recycled) pid after the original child already exited. Never
 * trusts this codebase's own internal bookkeeping alone - shells out to
 * the real `ps` utility (present on both macOS and Linux) for an
 * independent, external read of the OS's own process table, and compares
 * it against a REAL prior `ps` observation (`birthIdentity`), never a
 * value derived purely from this codebase's own `Date.now()` math.
 *
 * Honest limitation, stated plainly rather than overclaimed: this is a
 * best-effort, probabilistic defense (a seconds-resolution comparison via
 * a shelled-out `ps`), not a cryptographic guarantee - a true kernel-level
 * "same process" identity token (Linux's `pidfd`, e.g.) needs a native
 * binding this zero-runtime-dependency codebase deliberately does not add
 * (see `killProcessTreeWindows`'s docs for the same trade-off stated for
 * Windows). It closes the realistic, common case (a long-dead job's pid
 * recycled by an unrelated later process) without pretending to close
 * every theoretical one.
 *
 * `birthIdentity` is required (non-nullable) here on purpose: a caller
 * with no captured identity at all has nothing to compare against and
 * must not call this function - see `evaluatePreSignalIdentityGate`,
 * every real caller's actual entry point, for how that "no identity
 * captured" case is handled (the same DEGRADED path an `observer-failure`
 * result from THIS function leads to).
 */
export async function checkProcessIdentity(
  pid: number,
  birthIdentity: ProcessBirthIdentity,
  now: number = Date.now()
): Promise<IdentityCheckResult> {
  const observed = await readProcessElapsedSecondsAsync(
    pid,
    ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS
  );
  if (observed.status === "not-found") return { status: "not-found" };
  if (observed.status === "observer-failure") {
    return { status: "observer-failure", reason: observed.reason };
  }
  const expectedElapsedSeconds =
    birthIdentity.elapsedSecondsAtCapture + (now - birthIdentity.capturedAtMs) / 1000;
  if (!identityElapsedTimesMatch(observed.elapsedSeconds, expectedElapsedSeconds)) {
    return {
      status: "identity-mismatch",
      reason: `pid ${pid} has been alive for ~${observed.elapsedSeconds}s, expected ~${expectedElapsedSeconds.toFixed(1)}s - this looks like a reused pid, not the process we originally spawned`,
    };
  }
  return { status: "alive-confirmed" };
}

/**
 * What a kill/shutdown caller should actually DO before ever signaling a
 * tracked pid - the single real entry point every caller uses, wrapping
 * `checkProcessIdentity` (and the "no identity captured at all" case
 * that function can't handle on its own, since it requires a real
 * `ProcessBirthIdentity` to compare against):
 *
 * - `"skip"`: the pid is genuinely gone (a confident `not-found`) -
 *   nothing to signal, and no error.
 * - `"refuse"`: a genuine identity mismatch - never signal, surface `reason`.
 * - `"proceed"`: either identity was captured AND confirmed
 *   (`identityConfirmed: true`), or identity could never be verified at
 *   all - no birth identity was ever captured at spawn time (`ps` was
 *   unavailable then, or the process died before capture could run), or
 *   the KILL-TIME `ps` read itself just failed (`observer-failure`) -
 *   in which case `identityConfirmed: false` and the caller proceeds via
 *   the honest, disclosed DEGRADED path: pgid-only group signaling,
 *   never silently treated as if identity had been confirmed. Both
 *   `identityConfirmed: false` triggers are deliberately collapsed into
 *   the identical caller-visible outcome - a caller with no reference to
 *   compare against and a caller whose comparison just failed are in the
 *   same epistemic position: it cannot verify identity right now, so it
 *   must not silently claim it did.
 */
export type PreSignalGateResult =
  | { readonly action: "skip" }
  | { readonly action: "refuse"; readonly reason: string }
  | { readonly action: "proceed"; readonly identityConfirmed: boolean };

export async function evaluatePreSignalIdentityGate(
  pid: number,
  birthIdentity: ProcessBirthIdentity | undefined,
  now: number = Date.now()
): Promise<PreSignalGateResult> {
  if (birthIdentity === undefined) {
    // Capture failed (or was never attempted) at spawn time - there is
    // nothing to compare against, so identity cannot be verified at all.
    // Never silently treated as confirmed.
    return { action: "proceed", identityConfirmed: false };
  }
  const identity = await checkProcessIdentity(pid, birthIdentity, now);
  if (identity.status === "not-found") return { action: "skip" };
  if (identity.status === "identity-mismatch") {
    return { action: "refuse", reason: identity.reason };
  }
  if (identity.status === "observer-failure") {
    // The KILL-TIME observer itself is broken/unavailable right now -
    // genuinely unable to verify identity, but NOT genuinely "not found"
    // either (collapsing the two is exactly the bug this whole gate
    // exists to close). Proceed via the same degraded, honestly-
    // disclosed path a missing captured identity uses, rather than
    // either a false success or an uncaught failure.
    return { action: "proceed", identityConfirmed: false };
  }
  return { action: "proceed", identityConfirmed: true };
}

/** True if `pid` still exists, checked via the real, zero-side-effect `kill -0` probe. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code !== "ESRCH";
  }
}

/**
 * True if process GROUP `-pid` still has ANY member alive - the same
 * real, zero-side-effect `kill(target, 0)` probe `isProcessAlive` uses,
 * but targeting the whole group via a NEGATIVE pid (see
 * `signalProcessGroupPosix`'s own docs for the identical POSIX negative-
 * pid semantics: `kill(2)` with a negative target signals every process
 * in that group, and returns ESRCH only once none remain).
 *
 * `isProcessAlive(pid)` alone is NOT sufficient to confirm a process
 * GROUP is dead: it checks only the one pid named. A group's LEADER can
 * exit (from a plain, untrapped SIGTERM, for example) while a descendant
 * - a different pid, in the same group, that ignores or is slower to
 * respond to the same signal - is still running. `isProcessAlive` on the
 * leader's own pid alone reads that as "dead" even though the group
 * patently is not.
 */
export function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code !== "ESRCH";
  }
}

export type SignalResult =
  | { readonly ok: true; readonly delivered: boolean }
  | { readonly ok: false; readonly message: string; readonly code: string | undefined };

/**
 * Signals pid's WHOLE process GROUP (`-pid`, the negative form - see
 * Node's own `process.kill` docs: a negative pid "will kill the whole
 * process group"), never just the one leader process by itself. That is
 * what makes the containment real: because `spawnManaged` always spawns
 * with the child as its own group leader (`CONTAIN_IN_OWN_PROCESS_GROUP`
 * above), `pid` here IS that group's pgid, so this reaches every
 * descendant that hasn't itself escaped into a different group.
 */
export function signalProcessGroupPosix(pid: number, signal: string): SignalResult {
  try {
    process.kill(-pid, signal);
    return { ok: true, delivered: true };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // The group is already gone - nothing left to signal, not a failure, but
    // also NOT a delivery: no live process ever received this signal, so a
    // caller must never treat this the same as an actual send (see
    // `killProcessGroupPosix`'s own docs for why `delivered` gates
    // `onSignaled` and the terminal-state write it triggers).
    if (err.code === "ESRCH") return { ok: true, delivered: false };
    return { ok: false, message: err.message, code: err.code };
  }
}

/**
 * Polls `isAlive(pid)` until it reports false (confirmed gone) or
 * `timeoutMs` elapses - the real wait loop behind the grace period.
 * `pollIntervalMs` defaults small so death is detected promptly rather
 * than only at the next coarse tick, and is itself capped to never
 * overshoot the deadline. Defaults `isAlive` to `isProcessAlive` (a
 * single pid); pass `isProcessGroupAlive` to wait for a whole process
 * GROUP to be gone instead - `killProcessGroupPosix` does exactly this,
 * since a group-level kill must confirm the group is genuinely gone, not
 * merely that its leader exited (see `isProcessGroupAlive`'s own docs).
 *
 * `isAlive` may return a `boolean` directly (the fast, synchronous
 * `kill(pid, 0)`-based checks above - a real syscall, not a shelled-out
 * process, so there is nothing here for a caller-side bound to guard
 * against) or a `Promise<boolean>` (`hasLiveProcessGroupMembersPosixAsync`,
 * which shells out to a real `pgrep` and carries its own independent
 * settlement bound - see that function's own docs for why a plain
 * synchronous predicate calling `execFileSync` here would block this
 * loop's own event loop for as long as the external process takes). Each
 * tick `await`s whatever `isAlive` returns, which is a no-op for the
 * synchronous case and a real await for the async one.
 */
export function waitForProcessDeath(
  pid: number,
  timeoutMs: number,
  pollIntervalMs = 50,
  isAlive: (pid: number) => boolean | Promise<boolean> = isProcessAlive
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      void (async () => {
        if (!(await isAlive(pid))) {
          resolve(true);
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          resolve(false);
          return;
        }
        setTimeout(tick, Math.min(pollIntervalMs, remaining));
      })();
    };
    tick();
  });
}

/**
 * The real default POSIX grace period: 5 real seconds, not a
 * token delay. `kill`'s handler always uses this constant for the real
 * MCP-facing tool; only this codebase's OWN tests inject a shorter value
 * into the functions below (which all take the grace period as a
 * parameter) to keep the suite fast without ever testing a DIFFERENT code
 * path than production actually runs.
 */
export const POSIX_KILL_GRACE_PERIOD_MS = 5000;

export interface PosixKillResult {
  readonly finalSignal: "SIGTERM" | "SIGKILL";
  /** True if SIGTERM alone was NOT enough within the grace period, and SIGKILL was actually sent too. */
  readonly escalated: boolean;
  /**
   * Whether the bounded, EXTERNAL, `pgrep`-based process-group check
   * (`confirmProcessGroupReapedPosix`) actually observed zero surviving
   * process-group members after signaling completed (`true`), or the bound
   * elapsed without confirming (`false` - an honest "attempted, not
   * confirmed" result, never silently upgraded to `true`). Computed AFTER,
   * and never gating, the synchronous killed-state transition
   * `callbacks.onSignaled` already claimed - see that field's own docs for
   * why the state transition can't wait on this.
   */
  readonly confirmed: boolean;
}

export interface PosixKillCallbacks {
  /**
   * Called SYNCHRONOUSLY, immediately after a signal has actually been
   * sent successfully - BEFORE this function's own next `await`. This is
   * the hook `kill.ts` uses to claim a job's terminal state in
   * `JobStore` right then, deterministically WINNING the kill/exit race
   * against that same job's own natural `exit` event:
   * both are triggered by the identical signal, but the natural event can
   * only ever fire asynchronously (on a later turn of the event loop),
   * while a synchronous same-tick write can't be preempted by it. Without
   * this hook, the caller would have to `await` the whole
   * phase-split-plus-wait sequence before writing anything, and during
   * that wait the job's own `exit` event would reliably win the race
   * instead - a job this codebase itself deliberately killed would end up
   * recorded as `exited`, not `killed`.
   */
  readonly onSignaled?: (signal: "SIGTERM" | "SIGKILL") => void;
}

/**
 * How long `killProcessGroupPosix` waits, AFTER sending the escalation
 * SIGKILL, to confirm the group is actually gone before returning.
 * SIGKILL is uncatchable/unblockable, so on a real system this resolves
 * almost immediately - this bound exists only to close the tiny, real
 * async gap between "the signal was sent" and "the OS has actually
 * reclaimed the process" (signal delivery and reaping are asynchronous
 * relative to `process.kill` returning), so a caller awaiting
 * `killProcessGroupPosix` sees a settled result rather than a group that
 * is, for a few milliseconds, still technically visible to `ps`/`pgrep`.
 */
const SIGKILL_CONFIRMATION_TIMEOUT_MS = 1000;

/**
 * An INDEPENDENT-of-`kill()` survivor check for a whole process group,
 * used ONLY to arbitrate the ONE specific signal-send failure this file
 * has actually observed being ambiguous: `EPERM`. `signalProcessGroupPosix`
 * already treats `ESRCH` as success (the group is gone, nothing left to
 * signal); `EPERM` was observed empirically on macOS for the EXACT SAME
 * already-gone race that would otherwise report `ESRCH`, most likely
 * because the OS is mid-reclaiming the group's pid at the moment of the
 * call. A SECOND `kill(pid, 0)` probe (`isProcessGroupAlive`) cannot
 * arbitrate this: it is subject to the identical kernel-level ambiguity,
 * and was verified empirically to reproduce the same false `EPERM` in the
 * same race, making it a no-op as a disambiguator. `pgrep -g <pgid>` reads
 * the real process table through an entirely different mechanism, so it
 * is not fooled the same way - the same external, independent-of-our-own-
 * bookkeeping check already used elsewhere in this codebase for exactly
 * this purpose, now needed for a production decision too.
 *
 * A pgrep EXECUTION failure (a missing binary - `ENOENT`; any other
 * unexpected execution error) is FAIL-CLOSED to `true` ("treat the group
 * as still alive/unconfirmed"), never rethrown. This function is this
 * codebase's ONE real external process-table observer, consulted from two
 * places, and `true` is the safe answer at both: `throwUnlessBenignAlreadyGoneRace`
 * reads `true` as "the group is NOT confirmed gone" and correctly
 * surfaces the ambiguous signal-send failure as real rather than silently
 * swallowing it as the benign already-gone race; `confirmProcessGroupReapedPosix`'s
 * poll loop reads `true` as "not yet confirmed dead" and simply keeps
 * waiting until its own bound elapses, at which point it honestly reports
 * `confirmed: false` - the same "attempted, never silently upgraded to
 * confirmed" disclosure this codebase already uses everywhere else,
 * rather than an uncaught exception reaching a client with no tool result
 * at all (the bug this fail-closed behavior exists to close - see
 * `confirmProcessGroupReapedPosix`'s own docs). Only pgrep's own
 * documented "nothing matched" exit code (1) is a confident, POSITIVE
 * "zero real survivors" result - every other execution failure is treated
 * as "cannot tell," never as either extreme. POSIX-only, matching every
 * other function in this section.
 */
export function hasLiveProcessGroupMembersPosix(pid: number): boolean {
  try {
    const output = execFileSync("pgrep", ["-g", String(pid)], { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .some((line) => line.length > 0);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number };
    if (err.status === 1) return false; // pgrep's own "nothing matched" exit code - a real, expected zero-survivors result
    // Any other failure (ENOENT - pgrep missing entirely; a permission
    // failure; anything unanticipated) means THIS observer is broken
    // right now, not that the group is confirmed gone - fail closed to
    // "still alive/unconfirmed" rather than rethrow (see this function's
    // own docs above for exactly how each real caller turns that into a
    // safe, honest outcome on its own).
    return true;
  }
}

/**
 * How long a single `hasLiveProcessGroupMembersPosixAsync` call is given to
 * answer before this codebase gives up on IT specifically and force-reaps
 * it - independent of, and smaller than, `confirmProcessGroupReapedPosix`'s
 * own outer polling deadline, so one resistant `pgrep` invocation cannot
 * consume that entire budget by itself.
 */
export const PGREP_SINGLE_CALL_TIMEOUT_MS = 500;

/**
 * The ASYNC counterpart of `hasLiveProcessGroupMembersPosix` above, built
 * on the identical caller-side-bound-plus-force-reap shape
 * `readProcessElapsedSecondsAsync` already establishes (see that function's
 * own docs for the full rationale): `execFile`'s own `timeout` option only
 * REQUESTS SIGTERM, so a `pgrep` that installs a handler and ignores it
 * would otherwise leave this promise - and the single Node event loop this
 * whole server runs on - unsettled for as long as that `pgrep` process
 * chooses to run. A second, independent timer forces settlement regardless
 * of the child's cooperation, and SIGKILLs it directly if it is still alive
 * at that point.
 *
 * Fails closed to `true` ("still alive/unconfirmed") on any observer
 * failure or timeout, exactly matching the sync version's own documented
 * fail-closed behavior - never silently upgraded to a confirmed-gone
 * result just because this codebase gave up waiting.
 */
function hasLiveProcessGroupMembersPosixAsync(
  pid: number,
  timeoutMs: number = PGREP_SINGLE_CALL_TIMEOUT_MS
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const child = execFile(
      "pgrep",
      ["-g", String(pid)],
      { encoding: "utf8", timeout: timeoutMs },
      (error, stdout) => {
        if (settled) return;
        settled = true;
        clearTimeout(externalBound);
        if (error === null) {
          resolve(
            stdout
              .split("\n")
              .map((line) => line.trim())
              .some((line) => line.length > 0)
          );
          return;
        }
        const err = error as ExecFileCallbackError & { status?: number };
        if (err.status === 1 || err.code === 1) {
          resolve(false); // pgrep's own "nothing matched" exit code - a real, expected zero-survivors result
          return;
        }
        resolve(true); // observer failure - fail closed to "still alive/unconfirmed"
      }
    );
    const externalBound = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve(true); // did not settle in time - fail closed to "still alive/unconfirmed"
    }, timeoutMs + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS);
  });
}

/**
 * How long the FINAL, external `pgrep`-based process-group confirmation
 * (`confirmProcessGroupReapedPosix`) is given to observe zero surviving
 * process-group members before giving up and reporting the kill as
 * attempted-but-unconfirmed rather than silently claiming confirmed. On a
 * real system this resolves almost immediately once the group is actually
 * gone (signaling already happened, and in the default phased path an
 * internal `kill(pid, 0)`-based wait already ran first) - this bound exists
 * purely to close the same tiny real async gap `SIGKILL_CONFIRMATION_TIMEOUT_MS`
 * closes, one level up: between "signaling is done" and "an independent,
 * differently-mechanized oracle also agrees the group is gone."
 */
export const GROUP_CONFIRMATION_TIMEOUT_MS = 1000;

/**
 * The final, external check a kill's `confirmed` result relies on: polls the
 * real process table via `pgrep -g` (`hasLiveProcessGroupMembersPosixAsync`)
 * until it reports zero surviving members or `timeoutMs` elapses without
 * confirming, reusing `waitForProcessDeath`'s poll loop with this pgrep-based
 * predicate. ASYNC, not the plain synchronous `hasLiveProcessGroupMembersPosix`
 * - a blocking `execFileSync` here would stall the single Node event loop
 * this whole server runs on for as long as `pgrep` takes, which defeats the
 * "bounded" half of this function's own name the moment `pgrep` is slow or
 * hung (see `hasLiveProcessGroupMembersPosixAsync`'s own docs for the
 * measured case: a resistant `pgrep` left this promise settling seconds
 * after its configured bound, with every other job's output/status and
 * every other MCP request frozen for that whole span).
 *
 * This function always just resolves a `confirmed` boolean and never
 * touches job state directly. Callers differ in what they do with it:
 * `killProcessGroupPosix`'s phased default and the shutdown reaper run this
 * AFTER the synchronous `killed`-state transition already happened, so it
 * only refines the result's honesty, never the state itself. For a
 * caller-supplied signal with no termination guarantee (SIGSTOP), this
 * return value is what gates whether the job becomes `killed` at all. For
 * one that cannot be caught or ignored (an explicit SIGKILL), the state can
 * independently reach `killed` via the process's own exit before this ever
 * resolves - this value then only gates `kill_confirmed`/`identity_confirmed`,
 * never the state itself.
 */
export function confirmProcessGroupReapedPosix(
  pid: number,
  timeoutMs: number = GROUP_CONFIRMATION_TIMEOUT_MS
): Promise<boolean> {
  return waitForProcessDeath(pid, timeoutMs, 50, (p) => hasLiveProcessGroupMembersPosixAsync(p));
}

/**
 * The real POSIX phase split: SIGTERM to the whole group, THEN
 * a real wait of `graceMs`, THEN SIGKILL to the whole group only if it's
 * still alive - never the reverse, never simultaneous, never skipped. The
 * escalation SIGKILL is followed by a short confirmation wait (see
 * `SIGKILL_CONFIRMATION_TIMEOUT_MS`) so this function's return genuinely
 * means "done," not merely "the final signal was sent." `callbacks.onSignaled`
 * fires synchronously after each real signal send - see its own docs for
 * why that matters (the kill/exit race).
 *
 * Both waits check the WHOLE GROUP (`isProcessGroupAlive`), never just
 * the leader's own single pid. A group's leader can exit from a plain,
 * untrapped SIGTERM while a descendant - a different pid, in the same
 * group, that ignores or is slower to respond to the same signal - keeps
 * running; checking only the leader's pid would read that as "the group
 * died from SIGTERM alone" and return `escalated: false` while a real
 * process in the group it was asked to terminate stayed alive.
 *
 * A signal SEND itself can fail for a benign reason distinct from every
 * other failure this function reports: the whole group can exit in the
 * narrow window between a caller's own liveness/identity check and this
 * function's signal call - a short-lived child (an ordinary `true`, say)
 * finishing on its own right then. A signal failure is therefore not
 * trusted at face value - `hasLiveProcessGroupMembersPosix` (see its own
 * docs for why a second `kill(pid, 0)` probe cannot do this job) is
 * checked before deciding whether the failure is real: if the group is
 * confirmed gone despite the failed send, the call still achieved its
 * actual goal (a dead group) and is treated as success, exactly as if
 * `ESRCH` had been returned; only a failed send where the group is
 * CONFIRMED still alive is a genuine failure worth throwing over.
 * `callbacks.onSignaled` does NOT fire in the benign-race case, nor for a
 * signal that resolved to ESRCH before ever reaching this arbitration -
 * both are "the group was already gone," never a real send, and firing
 * the callback for either would claim a terminal kill on a job nothing
 * here ever signaled. An earlier version of this comment reasoned about
 * only ONE direction of the natural-exit-vs-signal race: it observed that
 * firing `onSignaled` in the benign-race case was safe because
 * `jobStore.markKilled`'s terminal-state guard is first-write-wins, so a
 * natural `exit` that already claimed the slot couldn't be overwritten.
 * True for that ordering - but the opposite ordering is the one that
 * actually bites: `markKilled` claiming the slot FIRST, for a process
 * nobody signaled, with first-write-wins then locking in the WRONG
 * answer before the real natural `exit` ever arrives. `delivered` on
 * `SignalResult` (see its own docs) is what closes this: only a
 * genuine send may ever call `onSignaled`.
 */
/**
 * The ONE owning arbitration point for a failed signal-send, shared by
 * BOTH the SIGTERM and the SIGKILL call sites below - a single function,
 * not two copies of the same condition, so a mutation to this logic can
 * only ever have one owner to be tested against, never a second,
 * accidentally-untested copy. Only `EPERM` is the known already-gone-race
 * errno (verified empirically); any OTHER non-ESRCH failure (EINVAL, or
 * anything unanticipated) is surfaced unconditionally, fail-closed,
 * without ever consulting the survivor oracle - `hasLiveProcessGroupMembersPosixAsync`
 * exists to arbitrate the ONE specific ambiguity this file has actually
 * observed, not as a blanket "maybe it's fine" check for any failure shape.
 * ASYNC because that oracle shells out to a real `pgrep`; a synchronous
 * arbitration here would block the event loop on the exact same live kill
 * path this function already guards. Throws when the failure is real;
 * returns normally when it is the benign already-gone race.
 */
export async function throwUnlessBenignAlreadyGoneRace(
  pid: number,
  signal: string,
  result: SignalResult
): Promise<void> {
  if (result.ok) return;
  if (result.code !== "EPERM" || (await hasLiveProcessGroupMembersPosixAsync(pid))) {
    throw new Error(`kill: failed to send ${signal} to process group ${pid}: ${result.message}`);
  }
}

export async function killProcessGroupPosix(
  pid: number,
  graceMs: number = POSIX_KILL_GRACE_PERIOD_MS,
  callbacks?: PosixKillCallbacks
): Promise<PosixKillResult> {
  // Existence check before the FIRST signal - distinguishes a group that
  // has already gone from one that is present. This establishes only
  // EXISTENCE, never OWNERSHIP: a process group that has been fully
  // vacated and had its numeric pgid recycled by an unrelated later group
  // reports exactly as "alive" here as our own would. A gone group is a
  // clean no-op - nothing is signaled, and "no signal delivered to any
  // live process" (see `src/tools/kill.ts`'s own docs) is therefore
  // literally true here, not merely true because a signal attempt happens
  // to return ESRCH harmlessly.
  if (!isProcessGroupAlive(pid)) {
    return { finalSignal: "SIGTERM", escalated: false, confirmed: true };
  }

  const termResult = signalProcessGroupPosix(pid, "SIGTERM");
  await throwUnlessBenignAlreadyGoneRace(pid, "SIGTERM", termResult);
  // Only a GENUINE delivery may claim the terminal slot - an already-gone
  // group (ESRCH, delivered:false) or a benign already-gone race arbitrated
  // above (ok:false but not thrown) never reaches here as a live send, and
  // must never fire the callback that records "we killed this" (see this
  // function's own docs for the ordering bug this guards against: a job
  // that exited naturally must never be recorded as killed).
  if (termResult.ok && termResult.delivered) {
    callbacks?.onSignaled?.("SIGTERM");
  }
  if (!termResult.ok) {
    return {
      finalSignal: "SIGTERM",
      escalated: false,
      confirmed: await confirmProcessGroupReapedPosix(pid),
    };
  }

  const diedFromTerm = await waitForProcessDeath(pid, graceMs, 50, isProcessGroupAlive);
  if (diedFromTerm) {
    return {
      finalSignal: "SIGTERM",
      escalated: false,
      confirmed: await confirmProcessGroupReapedPosix(pid),
    };
  }

  // Re-check existence immediately before escalating. The group can empty
  // during the grace period just waited out - that is the normal,
  // intended outcome of the SIGTERM above - and its numeric pgid can be
  // recycled before this exact instant. A gone group here is treated as
  // success, never as a reason to retry or to escalate further: escalating
  // against a group that no longer exists would only ever land on
  // whatever, if anything, has since taken its number. This narrows the
  // window between "still alive" and "about to send SIGKILL" as far as an
  // existence check can, but does not close it: an unrelated group that
  // happens to receive this exact recycled pgid in between this check and
  // the SIGKILL call below reads identically to a survived original one,
  // and would receive that SIGKILL - disclosed in README.md and this
  // tool's own served `description`, distinct from the eager-reap gap
  // (`reapProcessGroupOnce`'s own docs), which is a single scheduling
  // tick, not a whole grace period, and arises only when a job's leader
  // exits on its own rather than being actively signaled here. The
  // once-per-job reap guard does not help here either: it prevents a
  // LATER `kill` call from re-signaling this job, not a reused pgid
  // encountered within this SAME escalation.
  if (!isProcessGroupAlive(pid)) {
    return {
      finalSignal: "SIGTERM",
      escalated: false,
      confirmed: await confirmProcessGroupReapedPosix(pid),
    };
  }

  const killResult = signalProcessGroupPosix(pid, "SIGKILL");
  await throwUnlessBenignAlreadyGoneRace(pid, "SIGKILL", killResult);
  // Same guard as the SIGTERM site above - only a genuine delivery claims
  // the terminal slot.
  if (killResult.ok && killResult.delivered) {
    callbacks?.onSignaled?.("SIGKILL");
  }
  if (!killResult.ok) {
    return {
      finalSignal: "SIGKILL",
      escalated: true,
      confirmed: await confirmProcessGroupReapedPosix(pid),
    };
  }

  await waitForProcessDeath(pid, SIGKILL_CONFIRMATION_TIMEOUT_MS, 50, isProcessGroupAlive);
  return {
    finalSignal: "SIGKILL",
    escalated: true,
    confirmed: await confirmProcessGroupReapedPosix(pid),
  };
}

// ---------------------------------------------------------------------------
// Windows kill: honest best-effort, NOT a real Job Object
// ---------------------------------------------------------------------------

export interface WindowsKillResult {
  readonly method: "taskkill-tree";
}

/**
 * The CORRECT Windows primitive would be a Job Object
 * created and assigned to the child at spawn time, with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` set and breakaway EXPLICITLY
 * disabled (`JOB_OBJECT_LIMIT_SILENT_BREAKAWAY` off), so `TerminateJobObject`
 * kills the whole contained tree atomically and no descendant can ever
 * escape containment. This codebase does NOT implement that, and says so
 * plainly rather than overclaiming it. Node's standard library has no Job
 * Object API, and a correct one needs either a native addon (node-gyp, a
 * compiled DLL) or an FFI dependency (e.g. `koffi`/`ffi-napi`) - both are a
 * NEW runtime dependency for a project whose whole premise (see this
 * repo's `package.json`) is a lean command-runner with a single existing
 * dependency (the MCP SDK itself).
 *
 * This codebase implements POSIX properly and, on Windows, is honest
 * about what its fallback actually does rather than overclaiming a
 * guarantee it can't provide: `taskkill /pid <pid> /t /f`, which walks
 * the LIVE parent-pid tree Windows itself maintains at the MOMENT of the
 * kill and force-terminates every process it finds there. That is real,
 * and it does successfully reap a normal, non-adversarial process tree.
 * What it is explicitly NOT:
 *
 *   - Containment established AT SPAWN TIME. A real Job Object assignment
 *     (assigned at spawn time) closes any window for a descendant to escape
 *     BEFORE the kill ever runs; `taskkill /t` only looks at whatever
 *     parent-child links still exist at the moment it runs, so a
 *     descendant that has already re-parented/detached itself before then
 *     is not covered the way `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY` would
 *     have prevented it from escaping in the first place.
 *   - Atomic. `TerminateJobObject` tears down the whole contained tree in
 *     one kernel operation; `taskkill /t` walks and signals processes
 *     individually, so in principle (though not in any case this
 *     codebase's own tests exercise) a process could still be created in
 *     the tiny window while the walk is in progress.
 *   - A graceful phase of any kind: `/f` is immediate and
 *     forceful, full stop - there is no SIGTERM-equivalent attempted
 *     first, and this function deliberately implements no wait/grace logic
 *     at all (see `killProcessTreeWindows` itself: no `await`, no
 *     `setTimeout`, nothing SIGTERM-shaped).
 *
 * A real `taskkill` only exists on Windows, and with no Windows leg in
 * this repo's CI matrix at all right now (temporarily removed; see
 * CHANGELOG), nothing exercises this against the actual utility anywhere
 * currently - this function's test degrades to shape-only coverage: it
 * can still be checked for structure and logic, not against a real
 * Windows kill. Everywhere the suite DOES run, the call fails with ENOENT
 * and lands in the catch below, which exercises the error-swallowing path
 * but proves nothing about a real Windows kill either.
 */
export function killProcessTreeWindows(pid: number): WindowsKillResult {
  try {
    execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
  } catch {
    // taskkill exits non-zero when the pid is already gone (among other
    // reasons) - treated the same as the POSIX ESRCH-is-success handling
    // above: nothing left to kill is not a failure.
  }
  return { method: "taskkill-tree" };
}
