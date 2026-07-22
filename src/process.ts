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
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
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
  | { readonly status: "identity-mismatch"; readonly reason: string };

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

/**
 * Reads `pid`'s real elapsed wall-clock time from the OS via a real `ps`
 * invocation - `undefined` if `ps` reports nothing for this pid (it isn't
 * alive) or produces output this codebase can't parse.
 */
function readProcessElapsedSeconds(pid: number): number | undefined {
  let output: string;
  try {
    output = execFileSync("ps", ["-p", String(pid), "-o", "etime="], { encoding: "utf8" });
  } catch {
    return undefined; // ps exits non-zero when there is no such pid
  }
  if (output.trim().length === 0) return undefined;
  return parseEtime(output);
}

/**
 * The real, external-to-our-own-bookkeeping identity check `kill` runs
 * before ever signaling a tracked pid: confirms `pid` is both alive right
 * now AND was actually started at approximately
 * `expectedSpawnedAtMs` - i.e. that it is genuinely still the SAME process
 * this codebase spawned, not an unrelated process that happens to have
 * been assigned the same (recycled) pid after the original child already
 * exited. Never trusts this codebase's own internal bookkeeping alone -
 * shells out to the real `ps` utility (present on both macOS and Linux)
 * for an independent, external read of the OS's own process table.
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
 */
export function checkProcessIdentity(
  pid: number,
  expectedSpawnedAtMs: number,
  now: number = Date.now()
): IdentityCheckResult {
  const actualElapsedSeconds = readProcessElapsedSeconds(pid);
  if (actualElapsedSeconds === undefined) return { status: "not-found" };
  const expectedElapsedSeconds = (now - expectedSpawnedAtMs) / 1000;
  if (!identityElapsedTimesMatch(actualElapsedSeconds, expectedElapsedSeconds)) {
    return {
      status: "identity-mismatch",
      reason: `pid ${pid} has been alive for ~${actualElapsedSeconds}s, expected ~${expectedElapsedSeconds.toFixed(1)}s - this looks like a reused pid, not the process we originally spawned`,
    };
  }
  return { status: "alive-confirmed" };
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

export type SignalResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

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
    return { ok: true };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ESRCH") return { ok: true }; // the group is already gone - nothing left to signal, not a failure
    return { ok: false, message: err.message };
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
 */
export function waitForProcessDeath(
  pid: number,
  timeoutMs: number,
  pollIntervalMs = 50,
  isAlive: (pid: number) => boolean = isProcessAlive
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (!isAlive(pid)) {
        resolve(true);
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        resolve(false);
        return;
      }
      setTimeout(tick, Math.min(pollIntervalMs, remaining));
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
 */
export async function killProcessGroupPosix(
  pid: number,
  graceMs: number = POSIX_KILL_GRACE_PERIOD_MS,
  callbacks?: PosixKillCallbacks
): Promise<PosixKillResult> {
  const termResult = signalProcessGroupPosix(pid, "SIGTERM");
  if (!termResult.ok)
    throw new Error(`kill: failed to send SIGTERM to process group ${pid}: ${termResult.message}`);
  callbacks?.onSignaled?.("SIGTERM");

  const diedFromTerm = await waitForProcessDeath(pid, graceMs, 50, isProcessGroupAlive);
  if (diedFromTerm) return { finalSignal: "SIGTERM", escalated: false };

  const killResult = signalProcessGroupPosix(pid, "SIGKILL");
  if (!killResult.ok)
    throw new Error(`kill: failed to send SIGKILL to process group ${pid}: ${killResult.message}`);
  callbacks?.onSignaled?.("SIGKILL");
  await waitForProcessDeath(pid, SIGKILL_CONFIRMATION_TIMEOUT_MS, 50, isProcessGroupAlive);
  return { finalSignal: "SIGKILL", escalated: true };
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
 * A real `taskkill` only exists on Windows, so it is the suite's Windows
 * legs that run this against the actual utility. Everywhere else the call
 * fails with ENOENT and lands in the catch below, which exercises the
 * error-swallowing path but proves nothing about a real Windows kill.
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
