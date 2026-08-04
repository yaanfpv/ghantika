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
 * The trusted-source environment variable naming an OPTIONAL,
 * `path.delimiter`-separated list of absolute directory roots a job's
 * resolved cwd must fall inside. Read only from THIS SERVER's own process
 * environment, never from a tool call's own arguments - the same trust
 * boundary `src/policy.ts`'s `POLICY_FILE_ENV_VAR` uses, for the same
 * reason (an operator's own configuration, never caller-suppliable).
 * UNSET, or the raw environment-variable value ITSELF being the empty
 * string, is the ONLY shape meaning no restriction is applied at all: this
 * preserves this codebase's own pre-existing default (any real, existing
 * directory a `resolveCwd` stat/realpath could reach was always
 * acceptable), so root validation is opt-in server configuration layered
 * on top of that existing behavior, never a silently-imposed new
 * default-deny. An operator who wants the restriction sets this; one who
 * doesn't sees no change at all. Any OTHER raw value - including one that
 * splits and filters down to zero effective entries, such as a lone
 * `path.delimiter` on its own - is a non-empty configuration attempt and
 * denies every cwd rather than being read as unrestricted: a non-empty
 * value is evidence the operator intended some restriction, and silently
 * treating a malformed or all-stale one as "no restriction" would be a
 * wildcard, not a narrowing.
 */
export const CWD_ROOTS_ENV_VAR = "GHANTIKA_CWD_ROOTS";

/**
 * `undefined` ONLY when the env var is genuinely unset or its raw value is
 * itself the empty string (see `CWD_ROOTS_ENV_VAR`'s own docs) - that is
 * the sole shape meaning "no restriction". Any other raw value returns the
 * split-and-filtered array AS IS, including an empty one (e.g. a raw value
 * of just `path.delimiter`), so `resolveCwd`'s `configuredRoots !==
 * undefined` check still treats it as configured and `isWithinConfiguredRoots`
 * denies every cwd against zero entries - never silently reinterpreted as
 * unrestricted.
 */
function loadConfiguredCwdRoots(): readonly string[] | undefined {
  const raw = process.env[CWD_ROOTS_ENV_VAR];
  if (raw === undefined || raw.length === 0) return undefined;
  return raw.split(path.delimiter).filter((entry) => entry.length > 0);
}

/**
 * `true` iff `resolvedCwd` (already realpath-resolved by the caller) is
 * EQUAL TO, or a real descendant of, at least one entry in `roots`. Each
 * root is ALSO realpath-resolved here before comparison - a configured
 * root that is itself a symlink is judged by its real target, closing the
 * same "compare a symlink's spelling, not what it actually points at"
 * ambiguity `resolvedCwd` itself is already immune to by having been
 * realpath-resolved before this function ever sees it. A root that cannot
 * be resolved at all (doesn't exist, permission denied) is silently
 * DROPPED from the effective set rather than treated as a match or a hard
 * failure - the same "a stale entry narrows rather than crashes or
 * wildcards" precedent `src/policy.ts`'s `resolveAllowlistEntry` already
 * uses for a stale allowlist entry.
 *
 * Directory-boundary comparison, not a bare string prefix: `/srv/job-2`
 * must never match a configured root of `/srv/job` (a real prefix of that
 * string that is NOT actually an ancestor directory) - the trailing
 * separator appended to `realRoot` before the `startsWith` check is what
 * makes the comparison test path COMPONENTS, not characters.
 */
function isWithinConfiguredRoots(resolvedCwd: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    if (resolvedCwd === realRoot) return true;
    const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (resolvedCwd.startsWith(realRootWithSep)) return true;
  }
  return false;
}

/**
 * Resolves and validates a job's working directory. An OMITTED `rawCwd`
 * defaults to the server's own `process.cwd()` (documented default
 * behavior). A PROVIDED `rawCwd` that doesn't exist, or exists but isn't a
 * directory, is a validation failure - this deliberately forbids
 * silently falling back to the server's own cwd in that case; the caller
 * (`src/tools/run.ts`) turns a `{ok:false}` here into an already-failed job
 * (`diagnostic.reason: "spawn-error"`) rather than ever attempting to spawn.
 * The successful resolution is realpath-resolved, per the
 * frozen internal `JobRecord.cwd` shape - and, when `CWD_ROOTS_ENV_VAR` is
 * configured, is ALSO validated against that root set (see
 * `isWithinConfiguredRoots`) before this function reports success; a cwd
 * outside every configured root fails here, the same way a nonexistent one
 * does, rather than ever reaching a real spawn.
 *
 * DISCLOSED TOCTOU RESIDUAL - and the gap is NOT narrow, because `run()`'s
 * own admission queue sits between this validation and the real spawn.
 * This function validates the REAL path a symlink resolves to AT THE
 * MOMENT OF THIS CALL, which happens BEFORE `run()` asks for a concurrency
 * slot. A free slot removes only the QUEUE-DURATION extension of that gap,
 * not the gap itself: between this call and the real spawn, `run()` still
 * builds the child's env, resolves the caller-named executable (a
 * synchronous, unbounded-length walk of a caller-suppliable `PATH`),
 * resolves policy, and creates the job record - none of that is a fixed or
 * guaranteed-short interval, so an immediately admitted job's window is
 * shorter than a queued job's but still open and still unbounded. When the
 * job is QUEUED instead (`src/tools/run.ts`'s own "Concurrency cap + FIFO
 * queue" docs), this exact resolved string is captured in a closure and
 * held, unconfirmed again, for the job's ENTIRE time in that queue - which
 * can be arbitrarily long, bounded only by how long every job ahead of it
 * takes to finish. Nothing re-validates the string against
 * `GHANTIKA_CWD_ROOTS` at the moment the job actually reaches the front of
 * the queue and spawns. And "no SECOND resolution" was never true for
 * either path: passing a pathname to `child_process.spawn` causes the OS
 * itself to resolve it again at process-creation time - the exact same
 * independent-second-resolution shape `src/tools/run.ts` already discloses
 * for the executable/policy check just above this one in that file. So
 * what is actually open here: a symlink somewhere on `resolvedCwd`'s own
 * path being swapped, or the directory itself being replaced, at ANY point
 * between this validation and the moment the OS actually creates the
 * process - a real, exploitable window on either path, wider for a queued
 * job than an immediately admitted one but never zero for either. This
 * story does not close it; it is a known, unclosed time-of-check-to-
 * time-of-use limitation this validation does not claim to guard against,
 * proven by a real queued-job reproduction in
 * `test/concurrency.test.ts`.
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
  let resolvedCwd: string;
  try {
    resolvedCwd = fs.realpathSync(target);
  } catch {
    return { ok: false, message: "cwd could not be resolved" };
  }
  const configuredRoots = loadConfiguredCwdRoots();
  if (configuredRoots !== undefined && !isWithinConfiguredRoots(resolvedCwd, configuredRoots)) {
    return { ok: false, message: "cwd is outside the configured allowed roots" };
  }
  return { ok: true, resolvedCwd };
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
  /** When set, spawn this full command line via the platform shell instead of `argv` (the shell escape hatch). */
  readonly shellCommand?: string;
  /**
   * REQUIRED whenever `shellCommand` is set - the exact, already-resolved
   * absolute path of the platform shell binary `src/policy.ts`'s
   * `decideShellPolicy` already approved. Passed to `child_process.spawn`
   * as a literal `shell: <path>` string, never the bare boolean
   * `shell: true`: a path-separator-containing value is used by Node/the
   * OS exactly as given, with no further bare-name PATH search of any
   * environment, so this is what makes the identity the policy check
   * judged and the identity that actually launches the SAME value, by
   * construction. `shell: true` alone would let Node re-resolve a bare
   * shell name on its own at spawn time from `env` below - the JOB's own,
   * caller-influenced environment (see `effectivePathForLookup`'s own
   * docs for the documented Node behavior this exploits) - a resolution
   * the policy check never sees and, on Windows, one that can land on a
   * completely different executable than the one just approved. Ignored
   * (and unused) when `shellCommand` is unset - an ordinary argv job has
   * no separate shell binary to disclose.
   */
  readonly shellExecutable?: string;
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
 * uncaught exception. The same catch also covers a distinct, non-OS
 * failure: a `shellCommand` given with no `shellExecutable` (see
 * `SpawnManagedOptions.shellExecutable`'s own docs) throws before `spawn`
 * is ever called at all, so a caller-side wiring bug in our own code fails
 * that one job rather than crashing the server.
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
      if (options.shellExecutable === undefined) {
        // A caller-contract violation (see SpawnManagedOptions.shellExecutable's
        // own docs), not a real OS-level spawn failure - this codebase never
        // spawns a shell job without an already-approved, exact executable
        // identity. Thrown inside this try/catch so it is reported through
        // the same onError path as any other spawn-time failure, rather than
        // crashing the whole server process over a wiring bug in our own code.
        throw new Error("spawnManaged: shellExecutable is required whenever shellCommand is set");
      }
      // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- running a caller-supplied shell command via a real shell is this tool's documented, intentional purpose (`run`'s shell escape hatch), not an oversight. `shell` here is `options.shellExecutable`, an already-resolved, policy-approved absolute path - never the bare `true` that would let Node re-resolve a shell name against the job's own env (see `decideShellPolicy`'s docs in src/policy.ts).
      child = spawn(options.shellCommand, {
        cwd: options.cwd,
        env: options.env,
        stdio: MANAGED_CHILD_STDIO,
        shell: options.shellExecutable,
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
 * The widest `dd` (leading days) value `parseEtime` will accept, chosen to
 * be far larger than any real process this codebase could ever observe
 * (a freshly spawned job, or - at the far end - an unrelated long-lived
 * system process a reused pid happens to point at) while still rejecting
 * a malformed or corrupted read several orders of magnitude past any real
 * machine's uptime. No documented real-world uptime approaches even a
 * small fraction of this.
 */
const MAX_PLAUSIBLE_ETIME_DAYS = 36_500; // 100 years

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
 *
 * `hh`, `mm`, and `ss` are each REQUIRED to be exactly two digits (verified
 * empirically: a fresh process reads `00:01`, never `0:1` or `0:01`).
 * Accepting any-length digit runs in these fields let a single corrupted
 * or concatenated read parse as a syntactically-valid but physically-
 * impossible elapsed time (a 14-digit "seconds" field silently producing a
 * value on the order of a million years) instead of the `observer-failure`
 * a malformed read actually is.
 *
 * The leading `dd` field has no fixed width in real `ps` output (a
 * genuinely long-lived process can show any number of days), so it cannot
 * be digit-width-bounded the way the other three fields are - but it is
 * still bounded to `MAX_PLAUSIBLE_ETIME_DAYS`: the same corrupted-value
 * class the digit-width check closes for `hh`/`mm`/`ss` can equally
 * produce an absurd `dd` value (observed directly: a malformed real read
 * that parsed, before this bound existed, as ~441 million days), and an
 * unbounded leading field would let that same class of corruption straight
 * back through this parser's other side.
 */
export function parseEtime(raw: string): number | undefined {
  const trimmed = raw.trim();
  const dayMatch = trimmed.match(/^(\d+)-(.+)$/);
  const days = dayMatch ? Number(dayMatch[1]) : 0;
  if (days > MAX_PLAUSIBLE_ETIME_DAYS) return undefined;
  const rest = dayMatch ? dayMatch[2]! : trimmed;
  const parts = rest.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d{2}$/.test(part))) {
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
 * The real outcome of one `ps -p <pid> -o etime=` read - see
 * `readProcessElapsedSeconds`'s own docs for why this is a three-way
 * discrimination, not the `number | undefined` shape this used to return.
 * `observer-failure`'s `timedOut` is a STRUCTURAL discriminator, set
 * explicitly by whichever call site produced the failure, never inferred
 * from `reason`'s own wording elsewhere - see `BirthIdentityAttemptResult`'s
 * own docs for why a text-matching classifier was the wrong tool here.
 */
export type ElapsedSecondsReadResult =
  | { readonly status: "found"; readonly elapsedSeconds: number }
  | { readonly status: "not-found" }
  | { readonly status: "observer-failure"; readonly reason: string; readonly timedOut: boolean };

/**
 * The human-readable prefix `readProcessElapsedSecondsAsync` uses in an
 * `observer-failure` reason produced by `timeoutMs` itself running out,
 * whichever of that function's TWO timeout paths actually ends the
 * observer: `execFile`'s own internal timeout killing it cooperatively
 * (the common case - the observer dies from the signal, and the exec
 * callback reports it), or, only if the observer ignores that signal, the
 * external-bound timer's own forced SIGKILL. Never produced by a genuine
 * `ps` execution error.
 *
 * TEXT ONLY - `captureBirthIdentityPosixAsync` does NOT match against this
 * (or any) prefix to classify a timeout; it reads the structural
 * `observer-failure.timedOut` field each observer sets explicitly instead.
 * A prior version of this codebase DID classify by matching this exact
 * prefix, which worked only for this POSIX/`ps` observer - the Linux
 * `/proc` observer's own timeout reason never started with it (a different
 * string, "/proc/<pid>/stat did not settle within..."), so every Linux
 * aggregate-shortened timeout was silently misclassified as a genuine
 * observer failure instead of aggregate-exhausted-mid-observation. This
 * constant is kept only so both of this function's own timeout sites emit
 * the same readable wording; it carries no behavioral meaning anymore.
 */
const OBSERVER_TIMEOUT_REASON_PREFIX = "ps did not settle within";

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
    return { status: "observer-failure", reason: "ps produced no output", timedOut: false };
  }
  const elapsedSeconds = parseEtime(output);
  if (elapsedSeconds === undefined) {
    return {
      status: "observer-failure",
      reason: `ps produced output this codebase could not parse: ${JSON.stringify(output)}`,
      timedOut: false,
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
      timedOut: false,
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
type ExecFileCallbackError = Error & {
  readonly code?: string | number | null;
  readonly killed?: boolean;
  readonly signal?: NodeJS.Signals | null;
};

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
export const ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS = 250;

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
    const settle = (result: ElapsedSecondsReadResult): void => {
      resolve(result);
    };
    const child = execFile(
      "ps",
      ["-p", String(pid), "-o", "etime="],
      { encoding: "utf8", timeout: timeoutMs },
      (error, stdout) => {
        if (settled) return; // the external bound below already resolved this promise
        settled = true;
        clearTimeout(externalBound);
        if (error === null) {
          settle(interpretPsOutput(stdout));
          return;
        }
        const err = error as ExecFileCallbackError;
        if (err.code === 1) {
          // ps's own documented "no such pid" exit code, surfaced as a
          // NUMBER on this callback-error shape (see this function's own
          // docs) - a real, confident "genuinely not alive" result.
          settle({ status: "not-found" });
          return;
        }
        if (err.killed === true) {
          // `execFile`'s OWN internal `timeout` option fired and sent its
          // kill signal (SIGTERM by default) before this observer answered
          // - the COMMON, cooperative case `ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS`'s
          // own docs already call out. This branch settles through the
          // callback, strictly before `externalBound` below ever gets a
          // chance to fire (that timer's own delay only starts once this
          // SAME `timeoutMs` has already elapsed, plus this identical
          // grace), so reaching this branch is itself proof that
          // `timeoutMs` - not a genuine `ps` execution error - is what
          // ended this attempt. Node only sets `killed: true` on an error
          // produced by ITS OWN call to the child's `.kill()`; the
          // `externalBound` handler below sets `settled = true`
          // synchronously before it ever calls `child.kill()` itself, so
          // this branch can never be reached for that path - only for
          // `execFile`'s own internal timeout enforcement. Uses the
          // IDENTICAL `OBSERVER_TIMEOUT_REASON_PREFIX` the external bound
          // uses, because `captureBirthIdentityPosixAsync` must treat both
          // kill paths as the same underlying cause: the observer's own
          // `timeoutMs` allowance ran out, never that `ps` itself is
          // broken.
          settle({
            status: "observer-failure",
            reason: `${OBSERVER_TIMEOUT_REASON_PREFIX} ${timeoutMs}ms (observer killed by its own timeout signal: ${err.signal ?? "unknown"})`,
            timedOut: true,
          });
          return;
        }
        settle({
          status: "observer-failure",
          reason:
            typeof err.code === "string"
              ? `ps failed to execute (${err.code})`
              : `ps failed unexpectedly: ${err.message ?? String(error)}`,
          timedOut: false,
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
      settle({
        status: "observer-failure",
        reason: `${OBSERVER_TIMEOUT_REASON_PREFIX} ${timeoutMs}ms (observer unresponsive to SIGTERM)`,
        timedOut: true,
      });
    }, timeoutMs + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS);
  });
}

/**
 * The real outcome of one `/proc/<pid>/stat` read - the LINUX counterpart of
 * `ElapsedSecondsReadResult` above, and deliberately the identical
 * three-way shape (`found` / `not-found` / `observer-failure`) so every
 * caller of either keeps the same handling pattern. `startTimeTicks` is
 * field 22 of that file (`starttime`, clock ticks since boot) - a raw,
 * unconverted kernel counter, never an elapsed DURATION derived from it
 * (see `ProcessBirthIdentity`'s own docs for why that distinction is the
 * entire point of this Linux-specific path).
 */
export type LinuxStartTimeTicksReadResult =
  | { readonly status: "found"; readonly startTimeTicks: string }
  | { readonly status: "not-found" }
  | { readonly status: "observer-failure"; readonly reason: string; readonly timedOut: boolean };

/**
 * Parses ONE `/proc/<pid>/stat` file's raw contents into its field-22
 * (`starttime`) token, as a STRING - never converted to a number here (see
 * `ProcessBirthIdentity`'s own docs for why a string is the right shape for
 * this value everywhere in this codebase). Exported as its own small, PURE
 * function specifically so this exact extraction can be unit-tested
 * directly with a synthetic, injected `/proc/<pid>/stat`-shaped string, on
 * any host OS - mirroring `parseEtime`'s own role for the macOS/`ps` path.
 *
 * The kernel's own documented grammar (`man proc`) is
 * `pid (comm) state ppid ...` - space-separated, EXCEPT that `comm` (field
 * 2) is wrapped in parens and can itself contain literally anything a
 * process's argv[0]/`prctl(PR_SET_NAME)` puts there: spaces, parens, even
 * newlines. A naive whitespace split therefore cannot reliably locate field
 * 22 by position alone when `comm` contains its own spaces or parens. The
 * standard, documented technique (what `man proc` itself recommends, and
 * what libraries such as `psutil` implement) is instead to find the LAST
 * `)` in the line - `comm` is the only field that can contain a `)`, and
 * the kernel itself guarantees no field after it does either, so the last
 * `)` in the whole line is unambiguously the end of `comm` regardless of
 * what it contains - and treat everything after it as a plain
 * space-separated tail starting at field 3 (`state`). Field 22
 * (`starttime`) is therefore that tail's `22 - 3 = 19`th zero-indexed
 * token.
 *
 * Returns `undefined` - never a fabricated value - for: no `)` found at
 * all; fewer than 20 tokens in the tail; or a token at that position that
 * isn't a well-formed non-negative integer string (`/^\d+$/`). Matches this
 * file's own established "never silently treat a malformed read as usable"
 * discipline (see `parseEtime`'s own docs for the identical rationale
 * applied to the macOS/`ps` path).
 */
export function parseLinuxStatStartTimeTicks(raw: string): string | undefined {
  const lastParen = raw.lastIndexOf(")");
  if (lastParen === -1) return undefined;
  const tail = raw
    .slice(lastParen + 1)
    .trim()
    .split(/\s+/);
  // tail[0] is field 3 (state) - the first field after the parenthesized
  // comm - so field 22 (starttime) is tail[22 - 3] = tail[19].
  const startTimeTicks = tail[19];
  if (startTimeTicks === undefined || !/^\d+$/.test(startTimeTicks)) return undefined;
  return startTimeTicks;
}

/**
 * Interprets a `/proc/<pid>/stat` read's real contents, once the file has
 * actually been read successfully - the one piece of parsing logic BOTH the
 * sync (`readLinuxStartTimeTicks`) and async (`readLinuxStartTimeTicksAsync`)
 * observers share, factored out here for the identical reason
 * `interpretPsOutput` above is factored out of the etime path: a change to
 * how malformed output is classified can never drift between the two call
 * paths.
 */
function interpretProcStatOutput(raw: string): LinuxStartTimeTicksReadResult {
  const startTimeTicks = parseLinuxStatStartTimeTicks(raw);
  if (startTimeTicks === undefined) {
    return {
      status: "observer-failure",
      reason: `/proc/<pid>/stat produced output this codebase could not parse: ${JSON.stringify(raw)}`,
      timedOut: false,
    };
  }
  return { status: "found", startTimeTicks };
}

/**
 * Turns a failed `/proc/<pid>/stat` read into the right outcome - shared by
 * both the sync and async observers below, the identical factoring
 * `interpretPsOutput` gets for the shared SUCCESS path, just for the
 * failure path instead (the two observers don't share a single failure
 * call site the way they share `interpretProcStatOutput`, since one throws
 * synchronously and the other rejects a promise, but the CLASSIFICATION
 * logic is one piece of logic either way).
 */
function classifyProcStatReadFailure(error: unknown): LinuxStartTimeTicksReadResult {
  const err = error as NodeJS.ErrnoException;
  if (err.code === "ENOENT") {
    // `/proc/<pid>` not existing is Linux's own confident "no such
    // process" signal - exactly analogous to `ps`'s own "no such pid"
    // exit code elsewhere in this file. Never itself an observer failure.
    return { status: "not-found" };
  }
  return {
    status: "observer-failure",
    reason:
      err.code !== undefined
        ? `/proc/<pid>/stat read failed (${err.code})`
        : `/proc/<pid>/stat read failed unexpectedly: ${err instanceof Error ? err.message : String(error)}`,
    timedOut: false,
  };
}

/**
 * Reads `pid`'s real `starttime` (`/proc/<pid>/stat` field 22) via a
 * BLOCKING `fs.readFileSync` - the Linux counterpart of
 * `readProcessElapsedSeconds` above, used by the SYNC capture primitive
 * (`captureBirthIdentityPosix`). Unlike every `ps`/`pgrep`-shelling
 * observer elsewhere in this file, this has no bounded-timeout/SIGKILL
 * machinery at all: it ASSUMES a read against an in-kernel virtual
 * filesystem like `/proc` cannot hang the way a spawned child process
 * can, but that assumption is not enforced or verified here - unlike
 * `readLinuxStartTimeTicksAsync` below, which races its own read against
 * a caller-supplied bound instead of relying on the assumption alone. A
 * plain try/catch around a synchronous read is what this primitive
 * offers; nothing here would recover if the assumption ever proved
 * wrong for a given host or kernel.
 */
function readLinuxStartTimeTicks(pid: number): LinuxStartTimeTicksReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    return classifyProcStatReadFailure(error);
  }
  return interpretProcStatOutput(raw);
}

/**
 * The real `/proc/<pid>/stat` read `readLinuxStartTimeTicksAsync` performs,
 * factored into its own injectable type for exactly one reason: proving the
 * bound below actually holds requires a reader that never settles at all,
 * and there is no way to make a REAL `/proc` read hang on demand from a
 * portable test. `signal` is passed straight through to `fs.promises.readFile`
 * so the real implementation can react to the timeout below; an injected
 * fake is free to ignore it, and the wrapper's own bound holds regardless -
 * see `readLinuxStartTimeTicksAsync`'s own docs for why that has to be true.
 */
export type ProcStatAsyncReader = (pid: number, signal: AbortSignal) => Promise<string>;

/**
 * The finite set of ways a test may force the real reader below to fail -
 * deliberately NOT a generic override: no path, no content, no way to
 * supply an alternate `stat` line at all. Every member of this type
 * degrades the read; none can satisfy it. `"not-found"` rejects with the
 * same `ENOENT` shape a genuinely-missing pid produces (see
 * `classifyProcStatReadFailure` below); `"observer-failure"` rejects with
 * an unrelated error (any non-`ENOENT` code); `"hang"` never settles on its
 * own, leaving `readLinuxStartTimeTicksAsync`'s own external bound to
 * resolve it, exactly as a genuinely-stuck read would; `"not-found-then-hang"`
 * is `"not-found"` on the first invocation of the current degrade session
 * and `"hang"` on every one after - the shape a retry-then-force-reap test
 * needs to prove a retry genuinely started before the aggregate cap fires.
 */
type ProcStatTestDegradeMode = "not-found" | "observer-failure" | "hang" | "not-found-then-hang";

function isProcStatTestDegradeMode(value: string): value is ProcStatTestDegradeMode {
  return (
    value === "not-found" ||
    value === "observer-failure" ||
    value === "hang" ||
    value === "not-found-then-hang"
  );
}

function resolveProcStatTestDegradeMode(): ProcStatTestDegradeMode | undefined {
  const raw = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ;
  if (raw === undefined || !isProcStatTestDegradeMode(raw)) return undefined;
  return raw;
}

/**
 * How many prior invocations this degrade session has recorded - derived
 * fresh from the marker file itself EVERY call, never from an in-memory
 * counter: this codebase's own architecture reserves persistent module
 * state to `jobStore.ts` alone (see `test/module-boundaries.test.ts`), so
 * `"not-found-then-hang"`'s only real requirement - tell its first
 * invocation from a later one - is answered by reading the same external
 * artifact `recordProcStatDegradeInvocation` writes, exactly the technique
 * the `ps`-shadowing fixtures elsewhere in this test suite already use
 * (`makeFakePsDir`'s own marker file) rather than this codebase's own
 * internal bookkeeping. No marker set means no way to count, so
 * `"not-found-then-hang"` requires `GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER`
 * - every other mode ignores this entirely.
 */
function countPriorProcStatDegradeInvocations(marker: string | undefined): number {
  if (marker === undefined) return 0;
  try {
    return fs
      .readFileSync(marker, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function recordProcStatDegradeInvocation(marker: string | undefined): void {
  if (marker !== undefined) fs.appendFileSync(marker, "x\n");
}

/**
 * TEST-ONLY, FAILURE-ONLY hatch for the real reader below - the Linux
 * analogue of the PATH-shadowing this codebase's own POSIX tests already
 * use to simulate a missing/resistant/failing `ps` (see e.g. `makeFakePsDir`
 * in the test suite): Linux capture never shells out to anything on PATH,
 * so there is no equivalent environment lever for it without this.
 *
 * Deliberately NOT a generic root/content override: `GHANTIKA_TEST_DEGRADE_PROC_READ`
 * only accepts the four literal failure-mode strings above, and every one
 * of them only ever REJECTS the read or leaves it hanging for the caller's
 * own bound to time out - there is no way to make a degraded read come back
 * as a value this codebase would accept as a confirmed identity. A process
 * with this var set gains only a forced degrade to `unavailable`/
 * `unconfirmed`, never a spoofed confirm - see `test/process.test.ts`'s own
 * removal-detects-it control for the mutation-strong proof of this
 * property, and this file's `classifyProcStatReadFailure`/
 * `interpretProcStatOutput` for why a rejection can only ever produce
 * `"not-found"` or `"observer-failure"`, never `"found"`.
 */
const REAL_PROC_STAT_ASYNC_READER: ProcStatAsyncReader = (pid, signal) => {
  const degradeMode = resolveProcStatTestDegradeMode();
  if (degradeMode !== undefined) {
    const marker = process.env.GHANTIKA_TEST_DEGRADE_PROC_READ_MARKER;
    const isFirstInvocation = countPriorProcStatDegradeInvocations(marker) === 0;
    recordProcStatDegradeInvocation(marker);
    if (
      degradeMode === "not-found" ||
      (degradeMode === "not-found-then-hang" && isFirstInvocation)
    ) {
      const err = new Error(
        "ENOENT: simulated by GHANTIKA_TEST_DEGRADE_PROC_READ"
      ) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    }
    if (degradeMode === "observer-failure") {
      return Promise.reject(
        new Error("simulated observer failure (GHANTIKA_TEST_DEGRADE_PROC_READ=observer-failure)")
      );
    }
    // "hang" and every attempt after the first under "not-found-then-hang" -
    // never resolves or rejects on its own; readLinuxStartTimeTicksAsync's
    // own external bound is what settles this, exactly as it would for a
    // real hung read (see that function's own docs: an injected reader
    // that ignores the signal entirely still cannot hold its promise open
    // past the bound).
    return new Promise(() => {});
  }
  return fs.promises.readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal });
};

/**
 * The ASYNC counterpart of `readLinuxStartTimeTicks` above, built on
 * `fs.promises.readFile` instead of the blocking sync call - used by the
 * ASYNC capture primitive (`captureBirthIdentityPosixAsync`) and by
 * `checkProcessIdentity`'s Linux branch.
 *
 * BOUNDED by `timeoutMs`, exactly like `readProcessElapsedSecondsAsync`
 * above - `readLinuxStartTimeTicks`'s own doc comment names an assumption
 * that an underlying `/proc` read cannot hang; this function does not rely
 * on that assumption holding, because a slow or contended host (a starved
 * thread pool, a virtualized guest under heavy
 * I/O pressure) can leave `fs.promises.readFile`'s promise unsettled for far
 * longer than a normal `/proc` read takes, and `run()`'s own documented
 * "never blocks the caller" contract (see this function's own callers'
 * docs) depends on EVERY observer on this path actually honoring a bound,
 * not on the common case being fast. An unbounded `await` here left
 * `captureBirthIdentityPosixAsync`'s own aggregate deadline unenforced on
 * Linux specifically - the one platform this function exists for - which is
 * exactly the gap a caller-side race closes: an `AbortController` fired by
 * an independent `setTimeout` forces this function's own returned promise to
 * settle at `timeoutMs` regardless of whether the underlying read ever
 * does, mirroring `readProcessElapsedSecondsAsync`'s `settled`-flag race
 * against its external bound (no settlement grace is needed here the way
 * that function needs one for a resistant child process to actually die
 * from SIGKILL - aborting a promise is immediate, there is no second
 * process to force-kill).
 */
export async function readLinuxStartTimeTicksAsync(
  pid: number,
  timeoutMs: number,
  reader: ProcStatAsyncReader = REAL_PROC_STAT_ASYNC_READER
): Promise<LinuxStartTimeTicksReadResult> {
  return new Promise((resolve) => {
    let settled = false;
    const controller = new AbortController();
    reader(pid, controller.signal).then(
      (raw) => {
        if (settled) return; // the external bound below already resolved this promise
        settled = true;
        clearTimeout(externalBound);
        resolve(interpretProcStatOutput(raw));
      },
      (error) => {
        if (settled) return; // the external bound below already resolved this promise
        settled = true;
        clearTimeout(externalBound);
        resolve(classifyProcStatReadFailure(error));
      }
    );
    const externalBound = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Best-effort: a real `fs.promises.readFile` reacts to this and
      // rejects with an AbortError (harmlessly swallowed by the `settled`
      // guard above, since this branch has already resolved). An injected
      // reader that ignores `signal` entirely still cannot hold this
      // function's own promise open past this point.
      controller.abort();
      resolve({
        status: "observer-failure",
        reason: `/proc/<pid>/stat did not settle within ${timeoutMs}ms`,
        timedOut: true,
      });
    }, timeoutMs);
  });
}

/**
 * A managed job leader's real, OS-readable birth identity, captured once as
 * close to the actual OS-level spawn as this codebase can get (see
 * `captureBirthIdentityPosix`'s own docs) - NOT a fresh `Date.now()`-derived
 * guess, and never re-derived later.
 *
 * A DISCRIMINATED UNION on `platform`, not a single POSIX-uniform shape -
 * this is the fix for a real, confirmed class of bug (see the CHANGELOG
 * entry for this fix): `ps -o etime=` does not read an elapsed time, it
 * COMPUTES one from `/proc/<pid>/stat`'s own `starttime` field converted
 * against `/proc/uptime`, and in a virtualized guest those two values can
 * come from mismatched sources, producing a wildly wrong elapsed-time
 * reading even though `ps` itself ran and parsed cleanly. A raw, unconverted,
 * directly-comparable token has no
 * such dependency, which is why the Linux variant below reads and compares
 * one directly instead of ever deriving a duration. Keeping the two
 * variants as a discriminated union (rather than a single shape with
 * optional fields, or silently unifying them) makes it IMPOSSIBLE to
 * accidentally compare a Linux-captured identity against a macOS-shaped
 * comparison, or vice versa - a caller must narrow on `platform` before it
 * can read either variant's own fields at all (see `checkProcessIdentity`'s
 * own docs for exactly how it does that).
 *
 * - `"posix-elapsed"` (macOS, and every non-Linux, non-Windows POSIX
 *   platform this codebase runs on): `elapsedSecondsAtCapture` is the real,
 *   `ps`-observed elapsed age at the moment of capture (typically ~0s, but
 *   never assumed to be exactly 0); `capturedAtMs` is this codebase's own
 *   wall-clock reading of when that capture happened, which is what lets a
 *   LATER identity check compute how much more time should have elapsed
 *   since then and compare it against a fresh real `ps` reading.
 * - `"linux-starttime-ticks"`: `startTimeTicks` is `/proc/<pid>/stat` field
 *   22 (`starttime`, in clock ticks since boot since the kernel booted) -
 *   read directly, never converted, and compared later for EXACT STRING
 *   equality, never an elapsed-time derivation. Kept as a STRING rather
 *   than a `number`: it is a raw kernel counter that can in principle
 *   exceed `Number.MAX_SAFE_INTEGER` on a sufficiently long-uptime host,
 *   and since this codebase only ever compares it for exact equality
 *   (never arithmetic), a string comparison is both safe and simpler than
 *   parsing it to a number at all - see `parseLinuxStatStartTimeTicks`'s
 *   own docs for how it is extracted and validated as a well-formed digit
 *   string.
 */
export type ProcessBirthIdentity =
  | { readonly platform: "linux-starttime-ticks"; readonly startTimeTicks: string }
  | {
      readonly platform: "posix-elapsed";
      readonly capturedAtMs: number;
      readonly elapsedSecondsAtCapture: number;
    };

/**
 * Captures a freshly spawned leader's real birth identity via a BLOCKING
 * read (`ps -o etime=` on non-Linux POSIX, a direct `/proc/<pid>/stat` read
 * on Linux - see `ProcessBirthIdentity`'s own docs for why the two need to
 * be different shapes). NULLABLE by design, matching this repo's own
 * established principle that `run()` does NOT fail on a capture failure: a
 * job must still be created and remain killable even when this capture
 * itself fails (the observer unavailable, unparseable output, or the
 * process already gone by the time this runs - genuinely possible for an
 * extremely short-lived command). `undefined` here is the signal every
 * downstream kill/shutdown caller must treat as "identity was never
 * established for this job" and take the honest, disclosed DEGRADED path
 * (pgid-only signaling, no identity confirmation attempted) rather than
 * silently proceeding as if identity had been confirmed - see
 * `evaluatePreSignalIdentityGate`'s own docs for exactly how.
 *
 * NOT what `run()`'s own production handler calls - a synchronous
 * shell-out/file-read on `run()`'s response path blocks the whole MCP call
 * on however long that one invocation takes, with no bound at all, which
 * defeats `run()`'s own documented "returns immediately, no blocking"
 * contract the instant the observer is slow or hung (see
 * `src/tools/run.ts`'s own docs). `run()` calls
 * `captureBirthIdentityPosixAsync` below instead, fired off without ever
 * being awaited. This synchronous primitive is kept because it's still
 * directly useful wherever a real, immediately-available birth identity is
 * needed to compare against or seed a fixture with, and because
 * `captureBirthIdentityPosixAsync`'s own success path is built by awaiting
 * the identical real observation this function makes synchronously - the
 * two are the same real read on either platform, just via a blocking call
 * vs. an async one.
 *
 * POSIX only, matching every other identity-check primitive in this file:
 * Windows has no equivalent birth-identity model today (see
 * `killProcessTreeWindows`'s own docs), so this always returns `undefined`
 * there rather than attempting an observation that doesn't exist on that
 * platform.
 */
export function captureBirthIdentityPosix(pid: number): ProcessBirthIdentity | undefined {
  if (process.platform === "win32") return undefined;
  if (process.platform === "linux") {
    const observed = readLinuxStartTimeTicks(pid);
    if (observed.status !== "found") return undefined;
    return { platform: "linux-starttime-ticks", startTimeTicks: observed.startTimeTicks };
  }
  const observed = readProcessElapsedSeconds(pid);
  if (observed.status !== "found") return undefined;
  return {
    platform: "posix-elapsed",
    capturedAtMs: Date.now(),
    elapsedSecondsAtCapture: observed.elapsedSeconds,
  };
}

/**
 * How long the ASYNC birth-identity capture's own `ps` invocation (the
 * non-Linux path) is given to answer before this codebase forcibly kills it
 * (`execFile`'s own `timeout` option sends SIGTERM to the child once this
 * elapses) and treats the attempt as a genuine observer failure - a few
 * real seconds, generous enough that an ordinarily-slow `ps` still
 * succeeds, but bounded so a truly hung one can never leave a capture
 * unsettled indefinitely. This bound is what makes
 * `captureBirthIdentityPosixAsync` safe to fire off from `run()`'s handler
 * WITHOUT ever being awaited there (see `src/tools/run.ts`'s own docs), and
 * it's the same bound that caps how long `kill()`/the shutdown reaper can
 * ever wait when they find a capture still genuinely PENDING at the moment
 * they need it (see `src/jobStore.ts`'s `resolveBirthIdentityForKill` and
 * `src/tools/kill.ts`'s own docs) - awaiting an in-flight capture can never
 * take longer than this, however slow or hung the real `ps` process
 * actually is.
 *
 * On Linux this value bounds the OVERALL capture identically to the
 * non-Linux path (the aggregate deadline `captureBirthIdentityPosixAsync`
 * computes from it applies to both), AND each individual Linux attempt too:
 * `readLinuxStartTimeTicksAsync` races its own `/proc/<pid>/stat` read
 * against this same effective timeout (see that function's own docs for why
 * this codebase's PROMISE around the read needs a caller-side bound even
 * though the underlying kernel read itself is ordinarily near-instant).
 */
export const ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS = 3000;

/**
 * How long a `not-found` observation is given to resolve into `found`
 * before `captureBirthIdentityPosixAsync` schedules no further retry.
 * Absorbs the fork-visibility race where a just-forked child is not yet
 * visible to `ps` (or, on Linux, does not yet have a `/proc/<pid>` entry)
 * at the exact instant a capture call runs immediately after
 * `spawnManaged()` returns. This is a RETRY-SCHEDULING budget, not a
 * total capture window: the first observation always runs regardless of
 * this value (even zero), and the deadline it produces starts only once
 * that first observation actually returns `not-found` - never at function
 * entry, never reset by a later `not-found`. `observer-failure` is never
 * retried: that status has already consumed its own
 * `ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS` budget, so retrying it would
 * silently widen the real timeout under a different name.
 */
export const BIRTH_IDENTITY_NOT_FOUND_RETRY_BOUND_MS = 1000;

/**
 * How long `captureBirthIdentityPosixAsync` waits before each `not-found`
 * retry attempt - a real, honored delay, not merely a ceiling: no retry
 * ever starts before this wait (or the remaining retry/aggregate budget,
 * whichever is shorter) has actually elapsed.
 */
export const BIRTH_IDENTITY_NOT_FOUND_RETRY_POLL_INTERVAL_MS = 20;

/**
 * The clock/sleeper `captureBirthIdentityPosixAsync` schedules its retries
 * against. Defaults to the real wall clock; tests inject a fake one so the
 * retry-budget and aggregate-cap bookkeeping can be driven deterministically
 * without waiting on real time or on a real slow `ps`.
 */
export interface CaptureRetryClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CAPTURE_RETRY_CLOCK: CaptureRetryClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * The real outcome of ONE birth-identity observation attempt, whichever
 * platform-specific observer produced it - the small, platform-BLIND shape
 * `captureBirthIdentityPosixAsync`'s own retry loop is built against, so
 * that loop's aggregate-deadline/retry-budget bookkeeping never has to
 * know or care which real observer is underneath it. `identity` on
 * `"found"` is already the fully-shaped `ProcessBirthIdentity` (tagged with
 * the right `platform`), never a bare platform-specific reading the loop
 * would have to wrap itself.
 */
type BirthIdentityAttemptResult =
  | { readonly status: "found"; readonly identity: ProcessBirthIdentity }
  | { readonly status: "not-found" }
  | { readonly status: "observer-failure"; readonly reason: string; readonly timedOut: boolean };

/**
 * Makes ONE real birth-identity observation attempt for `pid`, dispatching
 * to the right platform-specific observer - `readLinuxStartTimeTicksAsync`
 * (a `/proc` read bounded by `effectiveTimeoutMs`, same as the other branch -
 * see that function's own docs) on Linux, `readProcessElapsedSecondsAsync`
 * (a bounded, force-reaped `execFile` of `ps`) everywhere else - and
 * wrapping whichever one answers into the identical
 * `BirthIdentityAttemptResult` shape `captureBirthIdentityPosixAsync`'s
 * retry loop consumes. This is the ONLY place that loop's platform
 * dispatch happens; every bound/retry/deadline decision below it is
 * platform-independent bookkeeping over this result.
 */
async function attemptBirthIdentityCaptureAsync(
  pid: number,
  effectiveTimeoutMs: number
): Promise<BirthIdentityAttemptResult> {
  if (process.platform === "linux") {
    const observed = await readLinuxStartTimeTicksAsync(pid, effectiveTimeoutMs);
    if (observed.status !== "found") return observed;
    return {
      status: "found",
      identity: { platform: "linux-starttime-ticks", startTimeTicks: observed.startTimeTicks },
    };
  }
  const observed = await readProcessElapsedSecondsAsync(pid, effectiveTimeoutMs);
  if (observed.status !== "found") return observed;
  return {
    status: "found",
    identity: {
      platform: "posix-elapsed",
      capturedAtMs: Date.now(),
      elapsedSecondsAtCapture: observed.elapsedSeconds,
    },
  };
}

/**
 * The ASYNC counterpart of `captureBirthIdentityPosix` above - the one
 * `run()`'s real production handler actually calls (see
 * `src/tools/run.ts`'s handler): the identical real observation and
 * nullable-by-design contract, but built on a bounded, non-blocking
 * observer (`attemptBirthIdentityCaptureAsync`, dispatching per-platform -
 * see that function's own docs) so a slow or hung observer can never hold
 * up `run()`'s own response. `run()` fires this off without ever awaiting
 * it - see `src/jobStore.ts`'s `attachPendingIdentityCapture`. POSIX only,
 * matching the synchronous version.
 *
 * Two independent bounds, never collapsed into one, and identical on both
 * platforms - the platform split lives entirely inside
 * `attemptBirthIdentityCaptureAsync`, never in this bookkeeping:
 *
 * - The AGGREGATE cap, `timeoutMs + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS`
 *   from function entry, moved by nothing below it. This is the pre-existing
 *   published bound `kill()`/the shutdown reaper already document
 *   (`src/jobStore.ts`'s `resolveBirthIdentityForKill`, `src/tools/kill.ts`'s
 *   own docs): the whole capture - first observation plus every retry -
 *   settles by this deadline, full stop. Each attempt's own effective
 *   observer timeout is capped to whatever remains of this budget (minus
 *   `ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS`, since
 *   `readProcessElapsedSecondsAsync` adds that grace on top of whatever
 *   timeout it is given - the Linux attempt honors this same effective
 *   timeout directly, via `readLinuxStartTimeTicksAsync`'s own caller-side
 *   race, no grace added, since aborting a promise needs no second
 *   force-kill phase the way a resistant child process does), so a retry
 *   can never itself run past this deadline on EITHER path -
 *   `readProcessElapsedSecondsAsync`'s own force-SIGKILL reaps a
 *   still-running `ps` observer, `readLinuxStartTimeTicksAsync`'s own
 *   `AbortController` race reaps a still-unsettled `/proc` read, both
 *   surfacing as an ordinary `observer-failure`. This is what keeps the
 *   retry addition from silently widening a latency bound other code
 *   already relies on.
 * - The RETRY budget, `BIRTH_IDENTITY_NOT_FOUND_RETRY_BOUND_MS` starting
 *   from the first `not-found`, governs only whether ANOTHER retry is
 *   allowed to START. It never gates whether an already-started attempt's
 *   `found` result is accepted - a retry that began while budget remained
 *   may resolve `found` after that budget has technically expired, and it
 *   is honored, because a valid, already-obtained observation is worth more
 *   than the schedule that produced it (the aggregate cap above is what
 *   still bounds how late "late" can be). Kept wired on the Linux path too
 *   (not skipped just because a fresh `/proc` entry is typically populated
 *   synchronously at fork time, likely faster than this race needs) -
 *   deliberately: this codebase has no way to verify that timing claim
 *   against a genuinely contended CI host from here, and keeping the same
 *   cheap, already-proven retry shape costs nothing if it turns out to be
 *   unnecessary on Linux, while removing it and being wrong about the
 *   timing would reintroduce exactly the race this budget exists to
 *   absorb.
 */
export type BirthIdentityCaptureFailureBranch =
  | "aggregate-exhausted-before-attempt"
  | "not-found-retry-closed-on-resume"
  | "observer-genuine-failure"
  | "aggregate-exhausted-mid-observation"
  | "not-found-retry-exhausted-first-pass"
  | "aggregate-exhausted-before-sleep";

/**
 * Every place `captureBirthIdentityPosixAsync` settles `undefined` on a
 * labelled POSIX failure names exactly which of its six distinct labels
 * produced that outcome, to stderr only (`console.error`, never
 * `console.log` - `src/server.ts`'s own docs on why stdout is reserved
 * for the MCP protocol apply equally here). This is diagnostic-only: it
 * changes no return value or control flow, and never fires on the
 * `found` path, so an ordinary successful capture is silent exactly as
 * before. It also never fires for this function's separate, unlabelled
 * `if (process.platform === "win32") return undefined;` guard at entry -
 * that guard is a real, additional way this function settles
 * `undefined`, entirely outside the POSIX failure family this
 * diagnostic instruments.
 *
 * Six labels from five labelled POSIX failure-return LOCATIONS, not six -
 * two of the six read similarly but are not: a budget exhausted before
 * another observation could even be attempted differs from the same
 * budget exhausted mid-observation, and a not-found retry window closing
 * on resume differs from one exhausted immediately after establishing
 * itself - each pair shares a return location's general shape but means
 * something different depending on WHEN in the iteration it fires. The
 * sixth distinction is sharper still: a single literal return location
 * can settle either `observer-genuine-failure` or
 * `aggregate-exhausted-mid-observation` depending on whether
 * `cutShortByAggregateBudget` says the shrinking aggregate budget - not a
 * real `ps` failure - is what actually cut this attempt's own timeout
 * short. Collapsing any of these distinctions into one label would make a
 * future occurrence unable to say which of two different situations
 * actually happened, which is the exact failure this diagnostic exists to
 * prevent. This function makes no claim about which label actually fires
 * in production; it only allows a real occurrence to say which one did.
 *
 * Also reports whatever `getConcurrencyContext` returns, if the caller
 * supplied one - this module owns no persistent state of its own (only
 * `jobStore.ts` may, per this codebase's own module-boundary rule), so a
 * caller that DOES hold relevant state passes a snapshot of it in at call
 * time instead. Never required, and its absence changes nothing about the
 * diagnostic's own correctness. Calling it is CONTAINED: a throwing hook
 * can never escape this function or change what it does - this stays a
 * diagnostic `console.error` and nothing else, exactly as promised,
 * regardless of what a caller's hook does. This is a claim about the
 * WHOLE CLASS of things a hook can throw, not merely `throw new Error(...)`:
 * JS permits throwing any value, including one whose own `toString` or
 * `Symbol.toPrimitive` itself throws, so the catch handler below performs
 * NO operation on the thrown value that could itself throw - it never
 * coerces, inspects, or stringifies it. A hook failure is disclosed with a
 * fixed, literal message carrying no data derived from what was thrown, so
 * there is nothing left in this path that JS could refuse to convert to a
 * string. A diagnostic that risked the operation it observes in order to
 * describe a failure would be worth less than no diagnostic at all.
 */
function logCaptureUndefined(
  pid: number,
  branch: BirthIdentityCaptureFailureBranch,
  detail: string,
  getConcurrencyContext: (() => string) | undefined
): void {
  let contextClause = "";
  if (getConcurrencyContext !== undefined) {
    try {
      contextClause = ` - ${getConcurrencyContext()}`;
    } catch {
      contextClause = " - concurrency-context hook threw";
    }
  }
  // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- pid is a real OS pid (a number), and detail/contextClause are this codebase's own literal/computed text, never attacker-supplied; this is a diagnostic console.error to stderr, not a format-string sink.
  console.error(
    `[ghantika] captureBirthIdentityPosixAsync(pid=${pid}) settled undefined - branch: ${branch} - ${detail}${contextClause}`
  );
}

export async function captureBirthIdentityPosixAsync(
  pid: number,
  timeoutMs: number = ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS,
  notFoundRetryBoundMs: number = BIRTH_IDENTITY_NOT_FOUND_RETRY_BOUND_MS,
  notFoundRetryPollIntervalMs: number = BIRTH_IDENTITY_NOT_FOUND_RETRY_POLL_INTERVAL_MS,
  clock: CaptureRetryClock = REAL_CAPTURE_RETRY_CLOCK,
  getConcurrencyContext?: () => string
): Promise<ProcessBirthIdentity | undefined> {
  if (process.platform === "win32") return undefined;
  const aggregateDeadline = clock.now() + timeoutMs + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS;
  let retryDeadline: number | undefined;

  for (;;) {
    const remainingAggregate = aggregateDeadline - clock.now();
    if (remainingAggregate <= ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS) {
      logCaptureUndefined(
        pid,
        "aggregate-exhausted-before-attempt",
        `only ${remainingAggregate}ms of the ${timeoutMs}ms+${ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS}ms grace aggregate budget remained at loop entry, before another observation could even be attempted this iteration`,
        getConcurrencyContext
      );
      return undefined;
    }
    if (retryDeadline !== undefined && clock.now() >= retryDeadline) {
      logCaptureUndefined(
        pid,
        "not-found-retry-closed-on-resume",
        `the ${notFoundRetryBoundMs}ms not-found retry deadline had already passed by the time a later iteration resumed after sleeping`,
        getConcurrencyContext
      );
      return undefined;
    }

    const effectiveTimeoutMs = Math.min(
      timeoutMs,
      remainingAggregate - ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS
    );
    const attempt = await attemptBirthIdentityCaptureAsync(pid, effectiveTimeoutMs);

    if (attempt.status === "found") {
      return attempt.identity;
    }
    if (attempt.status !== "not-found") {
      // A genuine execution error (ps missing, a real nonzero exit) is a
      // true observer-genuine-failure regardless of how much time this
      // attempt had. But when THIS attempt's own bounded wait is what
      // actually fired - named by the platform-neutral, STRUCTURAL
      // `timedOut` field every observer sets explicitly, never by matching
      // any particular wording in `reason` - and that wait was itself
      // capped short of the observer's normal timeoutMs because the
      // aggregate budget was running out, the real cause is the aggregate
      // cap, not the observer: the observer never got the chance to answer
      // within its own ordinary allowance. Reported as
      // aggregate-exhausted-mid-observation so the two genuinely different
      // causes - "ps itself is broken" vs. "ps was still working, just
      // out of time" - are never collapsed into one. A prior version of
      // this check matched `reason` against a POSIX/`ps`-specific prefix,
      // which silently misclassified every Linux aggregate-shortened
      // timeout as observer-genuine-failure instead (the Linux `/proc`
      // observer's own timeout reason never started with that prefix) -
      // see `OBSERVER_TIMEOUT_REASON_PREFIX`'s own docs for the full story.
      const cutShortByAggregateBudget = effectiveTimeoutMs < timeoutMs && attempt.timedOut;
      logCaptureUndefined(
        pid,
        cutShortByAggregateBudget
          ? "aggregate-exhausted-mid-observation"
          : "observer-genuine-failure",
        cutShortByAggregateBudget
          ? `the observer's own wait was capped to ${effectiveTimeoutMs}ms (below its ${timeoutMs}ms allowance) by the remaining aggregate budget and did not settle in time - ${attempt.reason}`
          : attempt.reason,
        getConcurrencyContext
      );
      return undefined;
    }

    if (retryDeadline === undefined) retryDeadline = clock.now() + notFoundRetryBoundMs;
    const remainingRetry = retryDeadline - clock.now();
    if (remainingRetry <= 0) {
      logCaptureUndefined(
        pid,
        "not-found-retry-exhausted-first-pass",
        `no time remained in the ${notFoundRetryBoundMs}ms not-found retry budget immediately after this attempt's own first not-found result established the retry deadline`,
        getConcurrencyContext
      );
      return undefined;
    }

    const remainingAggregateForSleep = aggregateDeadline - clock.now();
    if (remainingAggregateForSleep <= 0) {
      logCaptureUndefined(
        pid,
        "aggregate-exhausted-before-sleep",
        `no time remained in the aggregate budget to sleep before the next not-found retry`,
        getConcurrencyContext
      );
      return undefined;
    }

    await clock.sleep(
      Math.min(notFoundRetryPollIntervalMs, remainingRetry, remainingAggregateForSleep)
    );
  }
}

/**
 * The real, external-to-our-own-bookkeeping identity check `kill` runs
 * before ever signaling a tracked pid: confirms `pid` is both alive right
 * now AND was actually started at approximately the moment `birthIdentity`
 * (captured once, at spawn time - see `captureBirthIdentityPosix`) says it
 * was - i.e. that it is genuinely still the SAME process this codebase
 * spawned, not an unrelated process that happens to have been assigned the
 * same (recycled) pid after the original child already exited. Never
 * trusts this codebase's own internal bookkeeping alone - always makes an
 * independent, external read of the OS's own process table, and compares
 * it against a REAL prior observation (`birthIdentity`), never a value
 * derived purely from this codebase's own `Date.now()` math.
 *
 * Branches on `birthIdentity.platform`, never on the live `process.platform`
 * directly (see `ProcessBirthIdentity`'s own docs for why the discriminant
 * lives on the captured value itself): the two branches are genuinely
 * different comparisons, not the same math with a different observer
 * underneath.
 *
 * - `"linux-starttime-ticks"`: re-reads `/proc/<pid>/stat` field 22
 *   directly (`readLinuxStartTimeTicksAsync`) and compares it against the
 *   captured `startTimeTicks` for EXACT STRING EQUALITY - no tolerance, no
 *   arithmetic against `now`/`capturedAtMs` at all, because there is
 *   nothing to derive: both sides are the same raw kernel counter, so they
 *   either match exactly (the same process) or they don't (a different one
 *   now holds this pid). `now` is accepted but genuinely unused on this
 *   path - kept as a parameter only because the macOS/`posix-elapsed`
 *   branch below still needs it.
 * - `"posix-elapsed"` (every other POSIX platform): shells out to the real
 *   `ps` utility for a fresh elapsed-time reading and compares it, within
 *   `IDENTITY_TOLERANCE_SECONDS`, against how much MORE time should have
 *   elapsed since `birthIdentity.capturedAtMs` - the same best-effort,
 *   probabilistic comparison this function has always made on this
 *   platform (see below for its honest limitations).
 *
 * Honest limitation of the `posix-elapsed` branch, stated plainly rather
 * than overclaimed: it is a best-effort, probabilistic defense
 * (a seconds-resolution comparison via a shelled-out `ps`), not a
 * cryptographic guarantee - a true kernel-level "same process" identity
 * token (Linux's `pidfd`, e.g.) needs a native binding this
 * zero-runtime-dependency codebase deliberately does not add (see
 * `killProcessTreeWindows`'s docs for the same trade-off stated for
 * Windows). It closes the realistic, common case (a long-dead job's pid
 * recycled by an unrelated later process) without pretending to close
 * every theoretical one. The Linux branch's exact-token comparison is
 * strictly STRONGER than this (no tolerance window at all, no elapsed-time
 * derivation to be wrong about), but it is not a cryptographic guarantee
 * either: pid recycling itself is still possible in principle, this only
 * closes the "our own bookkeeping's derived elapsed time drifted" class of
 * false confirmation that motivated this whole fix.
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
  if (birthIdentity.platform === "linux-starttime-ticks") {
    const observed = await readLinuxStartTimeTicksAsync(
      pid,
      ASYNC_BIRTH_IDENTITY_CAPTURE_TIMEOUT_MS
    );
    if (observed.status === "not-found") return { status: "not-found" };
    if (observed.status === "observer-failure") {
      return { status: "observer-failure", reason: observed.reason };
    }
    if (observed.startTimeTicks !== birthIdentity.startTimeTicks) {
      return {
        status: "identity-mismatch",
        reason: `pid ${pid} reports a start-time of ${observed.startTimeTicks} ticks since boot, expected exactly ${birthIdentity.startTimeTicks} - this looks like a reused pid, not the process we originally spawned`,
      };
    }
    return { status: "alive-confirmed" };
  }

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

/**
 * The whole-phase budget for EACH of the two real observations the
 * escalation identity gate makes - the pre-SIGTERM membership snapshot
 * (`captureEscalationIdentitySnapshot`) and the escalation-time re-read
 * (`evaluateEscalationIdentityGate`). Both phases get their OWN fresh
 * 2000ms, never one budget shared or split across the two - a slow
 * snapshot never eats into the re-read's own allowance, and neither
 * phase's OBSERVATION COUNT scales with how many process-group members
 * it observes (see `readPidStartTimesBatchPosix`'s own docs: every
 * member is read in ONE batched `ps` call, never one call per member) -
 * though that one batched call still constructs, emits, and parses data
 * proportional to the group's own size, so the byte cost of a single
 * observation is not itself size-independent, only its call count is.
 *
 * Strictly less than `POSIX_KILL_GRACE_PERIOD_MS` (asserted directly by
 * this codebase's own test suite, not just eyeballed here) - so neither
 * observation phase can ever outlast the grace window it sits beside.
 */
export const PROCESS_IDENTITY_OBSERVATION_TIMEOUT_MS = 2000;

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
  /**
   * Present ONLY when the group survived the grace period AND the
   * escalation identity gate (`evaluateEscalationIdentityGate`) refused to
   * confirm the group is still the one this codebase spawned - in which
   * case no SIGKILL was ever sent (`escalated` stays `false`, the same as
   * a group that died from SIGTERM alone). Absent whenever escalation was
   * never reached at all (the group died within grace, or was already
   * gone) - never present-as-undefined-string, genuinely absent. The
   * value is a short, honest description of WHICH fail-closed cell fired
   * (see `evaluateEscalationIdentityGate`'s own docs for the full
   * enumeration) - never a claim that the group is confirmed gone, and
   * never a claim that the earlier SIGTERM was "confirmed" or "guarded"
   * when identity could not be verified at all (see this field's own
   * combined-degraded wording in `captureEscalationIdentitySnapshot`'s
   * docs).
   */
  readonly escalationRefusedReason?: string;
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

// ---------------------------------------------------------------------------
// The escalation identity gate: before the SIGKILL escalation, check
// whether the group is still the one this codebase spawned - never before
// the FIRST SIGTERM (that send is covered by
// process.evaluatePreSignalIdentityGate's own, separate etime-based
// mechanism, out of scope here by design).
// ---------------------------------------------------------------------------

/** One originally-recorded process-group member's real, OS-read identity: a pid plus the instant it started (never a `Date.now()`-derived guess). */
export interface RecordedGroupMember {
  readonly pid: number;
  /** Epoch milliseconds, parsed under the frozen `LC_ALL=C`/`TZ=UTC0` grammar `parsePidLstartRow` implements. */
  readonly startTimeMs: number;
}

/**
 * The real outcome of one batched `ps -p <pid[,pid...]> -o pid=,lstart=`
 * read - never per-member sequential calls, so the NUMBER OF REAL CALLS
 * this observer makes never scales with how many pids are asked about
 * (see this function's own docs further down for why that single-batch
 * shape is what keeps a group of any size inside ONE whole-operation
 * deadline). That single call's own BYTE cost is a different question:
 * it still constructs a comma-joined pid list, and `ps` still emits and
 * this function still parses one row per requested pid, so the data a
 * batch of size N produces and this function processes genuinely grows
 * with N - only the CALL COUNT is size-independent, not the work inside
 * that one call.
 *
 * `rows` holds only the pids whose row parsed cleanly under
 * `parsePidLstartRow`'s frozen six-token grammar - a pid simply absent from
 * `rows` may mean it has genuinely exited (the normal, expected "not
 * found" outcome - real `ps` silently omits a nonexistent pid from a
 * multi-pid query rather than erroring, confirmed empirically), or that
 * its own row was present but malformed and therefore discarded (never
 * guessed at). Distinguishing those two would require attributing
 * a malformed row to a specific pid, which this parser's own contract explicitly forbids - so
 * this deliberately does not attempt to; the caller's own "did any
 * ORIGINALLY-RECORDED pid still produce an exactly-matching row" question
 * never needs that distinction; it only needs to know a pid's own
 * attempted read failed to produce a positive match.
 */
export type PidBatchReadResult =
  | { readonly status: "ok"; readonly rows: readonly RecordedGroupMember[] }
  | { readonly status: "observer-failure"; readonly reason: string };

/**
 * Which of `readPidStartTimesBatchPosix`'s two `observer-failure` return
 * sites produced a given outcome - the real `ps` execution failing outright
 * (a missing binary, a non-zero exit this function does not otherwise
 * recognize) versus this function's own external timeout force-reaping a
 * `ps` that never settled. Named separately for the same reason
 * `BirthIdentityCaptureFailureBranch` names its own sites separately: they
 * are different situations even though both surface as one `status`.
 */
export type PidBatchReadFailureBranch = "exec-failure" | "timeout";

/**
 * Every `readPidStartTimesBatchPosix` `observer-failure` outcome, logged to
 * stderr only, diagnostic-only exactly like `logCaptureUndefined` above -
 * changes no return value, fires on every caller (the pre-SIGTERM
 * escalation snapshot's leader and descendant reads, and the escalation
 * gate's own later re-read alike) without threading a separate caller
 * label through this shared, low-level function. The logged `pids` does
 * NOT reliably name which of the three call sites fired it: the
 * snapshot's leader read always passes `[leaderPid]`, and the escalation
 * gate's own re-read passes the SAME single-element `[leaderPid]` array
 * whenever the snapshot recorded no descendants - the two are
 * indistinguishable by this list alone in that case. A real occurrence
 * still tells the reader THAT one of these callers failed and why; it
 * does not by itself say which one.
 */
function logPidBatchReadObserverFailure(
  pids: readonly number[],
  branch: PidBatchReadFailureBranch,
  reason: string
): void {
  console.error(
    `[ghantika] readPidStartTimesBatchPosix(pids=${pids.join(",")}) observer-failure - branch: ${branch} - ${reason}`
  );
}

/** Looks up `pid`'s start time in a `PidBatchReadResult`'s (or a snapshot's) `readonly RecordedGroupMember[]` rows - a plain linear scan over a small, per-call, never-persisted array (see this module's own "no persistent state outside jobStore.ts" boundary), not a `Map`. */
function findRecordedStartTime(
  rows: readonly RecordedGroupMember[],
  pid: number
): number | undefined {
  return rows.find((row) => row.pid === pid)?.startTimeMs;
}

/** `ps`'s ordinary weekday abbreviations under the `C` locale - part of this module's own frozen six-token grammar's sanity check, not merely a token-count check. */
const LSTART_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** `ps`'s ordinary month abbreviations under the `C` locale. */
const LSTART_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Parses ONE `ps -p <pid> -o pid=,lstart=` output ROW - this module's own
 * frozen grammar: `pid weekday month day HH:MM:SS year`, produced under pinned
 * `LC_ALL=C`/`TZ=UTC0` - into a real pid plus an epoch-millisecond instant.
 * Splits on any RUN of whitespace, never a single space: `ps` pads its
 * `lstart` column to a fixed width, so a single-digit day (`" 5"` rather
 * than `"25"`) would otherwise shift plain single-space splitting off by
 * one token (verified empirically against the real installed `ps`).
 *
 * Returns `undefined` - a failed read for this row, never a partial or
 * best-effort one - for ANY of: not exactly six tokens after that
 * whitespace-collapse; an unrecognized weekday or month abbreviation; a
 * day/hour/minute/second/year field that isn't the right shape; a parsed
 * instant that does not ROUND-TRIP exactly back through `Date.UTC` (e.g.
 * a day value `Date` would otherwise silently normalize into the next
 * month); or a weekday token that is a recognized abbreviation but
 * disagrees with the day-of-week the other five tokens actually compute
 * to. `Date.UTC` never looks at the weekday token at all, so without this
 * last check a row like `123 Mon Jul 25 15:00:00 2026` would parse
 * identically to the genuinely correct `123 Sat Jul 25 15:00:00 2026` (25
 * July 2026 is a real Saturday) even though the two rows contradict each
 * other - stated plainly: a guard exactly right about which token is
 * which and silently wrong by hours about what it means is worse than
 * one that fails to parse.
 *
 * The zone is FROZEN, not merely the layout: `lstart` itself carries no
 * zone token at all, so the pinned `TZ=UTC0` environment (see
 * `readPidStartTimesBatchPosix`) is what makes treating tokens 2-6 as a
 * plain UTC instant (via `Date.UTC`, no offset math) correct - this
 * function trusts that environment was actually set by its one real
 * caller, it does not (and cannot) verify it from the string alone.
 */
export function parsePidLstartRow(rawLine: string): RecordedGroupMember | undefined {
  const tokens = rawLine.trim().split(/\s+/);
  if (tokens.length !== 6) return undefined;
  const [pidRaw, weekday, month, dayRaw, time, yearRaw] = tokens as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!/^\d+$/.test(pidRaw)) return undefined;
  const pid = Number(pidRaw);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const weekdayIndex = LSTART_WEEKDAYS.indexOf(weekday);
  if (weekdayIndex === -1) return undefined;
  const monthIndex = LSTART_MONTHS.indexOf(month);
  if (monthIndex === -1) return undefined;
  if (!/^\d{1,2}$/.test(dayRaw)) return undefined;
  const day = Number(dayRaw);
  const timeParts = time.split(":");
  if (timeParts.length !== 3 || timeParts.some((part) => !/^\d{2}$/.test(part))) return undefined;
  const [hours, minutes, seconds] = timeParts.map(Number) as [number, number, number];
  if (!/^\d{4}$/.test(yearRaw)) return undefined;
  const year = Number(yearRaw);

  const startTimeMs = Date.UTC(year, monthIndex, day, hours, minutes, seconds);
  const roundTrip = new Date(startTimeMs);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== monthIndex ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hours ||
    roundTrip.getUTCMinutes() !== minutes ||
    roundTrip.getUTCSeconds() !== seconds ||
    roundTrip.getUTCDay() !== weekdayIndex
  ) {
    // Either did not round-trip (invalid/out-of-range/ambiguous), or DID
    // round-trip to a real instant whose actual day-of-week contradicts
    // the weekday token this row claimed - never guessed at either way.
    return undefined;
  }
  return { pid, startTimeMs };
}

function parseLstartBatchOutput(stdout: string): RecordedGroupMember[] {
  const rows: RecordedGroupMember[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = parsePidLstartRow(trimmed);
    if (parsed !== undefined) rows.push(parsed);
  }
  return rows;
}

/**
 * Reads pid+lstart for a SET of pids in ONE real `ps -p <comma-list>` call
 * - this module's own frozen six-token grammar, run under pinned `LC_ALL=C`/`TZ=UTC0`
 * (never the server's own inherited locale/zone, which could vary the
 * output shape) - batched so this observer's cost is ONE real subprocess
 * call regardless of how many members the group has (an N-member
 * group must never create N sequential timeout windows).
 *
 * Bounded and force-reaped exactly like this file's other async `ps`/`pgrep`
 * observers (`readProcessElapsedSecondsAsync`, `hasLiveProcessGroupMembersPosixAsync`):
 * `execFile`'s own `timeout` option only REQUESTS SIGTERM, so a second,
 * independent settlement timer forces this promise to resolve at
 * `timeoutMs` plus a small fixed grace regardless of the child's own
 * cooperation, SIGKILLing it directly if it is still alive then - a
 * resistant `ps` can never leave this pending indefinitely, and can never
 * outlive this call as a leaked process either.
 *
 * `ps -p <list>` returns exit code 1 with EMPTY output when NONE of the
 * requested pids currently exist (confirmed empirically) - a real,
 * confident "nothing there" result, `{status: "ok", rows: <empty>}`,
 * never an observer failure. Any OTHER execution failure (a missing
 * binary, a permission failure, this call's own settlement timer firing)
 * is `{status: "observer-failure"}` - genuinely different: this observer
 * never ran successfully at all, so there is no basis for either "found"
 * or "not found" about ANY requested pid.
 *
 * An empty `pids` array is a defensive no-op (`{status: "ok", rows: <empty>}`
 * without ever shelling out) - there is nothing to ask `ps` about.
 */
export function readPidStartTimesBatchPosix(
  pids: readonly number[],
  timeoutMs: number = PROCESS_IDENTITY_OBSERVATION_TIMEOUT_MS
): Promise<PidBatchReadResult> {
  if (pids.length === 0) return Promise.resolve({ status: "ok", rows: [] });
  return new Promise((resolve) => {
    let settled = false;
    const child = execFile(
      "ps",
      ["-p", pids.join(","), "-o", "pid=,lstart="],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
      },
      (error, stdout) => {
        if (settled) return;
        settled = true;
        clearTimeout(externalBound);
        if (error === null) {
          resolve({ status: "ok", rows: parseLstartBatchOutput(stdout) });
          return;
        }
        const err = error as ExecFileCallbackError;
        if (err.code === 1) {
          // ps's own documented "none of the requested pids matched" exit
          // code - a real, confident "nothing there" result, not an
          // observer failure.
          resolve({ status: "ok", rows: [] });
          return;
        }
        if (err.killed === true) {
          // `execFile`'s OWN internal `timeout` option fired and sent its
          // kill signal cooperatively before this observer answered - the
          // same real cause the `externalBound` timer below reports as
          // `timeout`, just settled through the callback rather than the
          // external force-SIGKILL (see `readProcessElapsedSecondsAsync`'s
          // identical distinction and its own docs on why `err.killed` can
          // only mean this path here, never this function's own later
          // external kill). Reported as `timeout`, never `exec-failure`,
          // so a real occurrence never sends a future fix at `ps` itself
          // when the true cause is this call's own timeout budget.
          const reason = `ps did not settle within ${timeoutMs}ms (observer killed by its own timeout signal: ${err.signal ?? "unknown"})`;
          logPidBatchReadObserverFailure(pids, "timeout", reason);
          resolve({ status: "observer-failure", reason });
          return;
        }
        const reason =
          typeof err.code === "string"
            ? `ps failed to execute (${err.code})`
            : `ps failed unexpectedly: ${err.message ?? String(error)}`;
        logPidBatchReadObserverFailure(pids, "exec-failure", reason);
        resolve({ status: "observer-failure", reason });
      }
    );
    const externalBound = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      const reason = `ps did not settle within ${timeoutMs}ms (observer unresponsive to SIGTERM)`;
      logPidBatchReadObserverFailure(pids, "timeout", reason);
      resolve({ status: "observer-failure", reason });
    }, timeoutMs + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS);
  });
}

/** The real outcome of enumerating a process group's current membership via `pgrep -g <pgid>`. */
export type PgrepEnumerationResult =
  | { readonly status: "ok"; readonly pids: readonly number[] }
  | { readonly status: "observer-failure"; readonly reason: string };

/**
 * Enumerates a process group's CURRENT real members via `pgrep -g <pgid>` -
 * bounded and force-reaped on the identical shape `readPidStartTimesBatchPosix`
 * above and `hasLiveProcessGroupMembersPosixAsync` (elsewhere in this file)
 * both already use. A pgrep line that isn't a bare positive integer marks
 * the WHOLE enumeration malformed (`observer-failure`) rather than
 * silently discarding just that one line - unlike a `ps` row (where a
 * malformed ROW only ever costs that one pid's identity, never the
 * others'), a malformed pgrep line means this codebase cannot trust that
 * it has correctly enumerated membership AT ALL, so the safe, fail-closed
 * reading is to distrust the whole read rather than guess at a partial
 * member list.
 */
function enumerateProcessGroupMembersPosixAsync(
  pid: number,
  timeoutMs: number
): Promise<PgrepEnumerationResult> {
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
          const parsed = parsePgrepPidList(stdout);
          if (parsed === undefined) {
            resolve({
              status: "observer-failure",
              reason: `pgrep produced output this codebase could not parse: ${JSON.stringify(stdout)}`,
            });
            return;
          }
          resolve({ status: "ok", pids: parsed });
          return;
        }
        const err = error as ExecFileCallbackError & { status?: number };
        if (err.status === 1 || err.code === 1) {
          resolve({ status: "ok", pids: [] }); // pgrep's own "nothing matched" exit code
          return;
        }
        resolve({
          status: "observer-failure",
          reason:
            typeof err.code === "string"
              ? `pgrep failed to execute (${err.code})`
              : `pgrep failed unexpectedly: ${err.message ?? String(error)}`,
        });
      }
    );
    const externalBound = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        status: "observer-failure",
        reason: `pgrep did not settle within ${timeoutMs}ms (observer unresponsive to SIGTERM)`,
      });
    }, timeoutMs + ASYNC_ELAPSED_READ_SETTLEMENT_GRACE_MS);
  });
}

function parsePgrepPidList(stdout: string): number[] | undefined {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const pids: number[] = [];
  for (const line of lines) {
    if (!/^\d+$/.test(line)) return undefined; // malformed - never guessed at
    const parsedPid = Number(line);
    if (!Number.isInteger(parsedPid) || parsedPid <= 0) return undefined;
    pids.push(parsedPid);
  }
  return pids;
}

/**
 * The pre-SIGTERM membership snapshot the escalation identity gate is
 * built on: the leader's own pid plus every CURRENTLY-live descendant's
 * pid, each paired with its real, `ps`-read start time (this module's own frozen grammar) -
 * captured BEFORE the first signal in this escalation is ever sent, never
 * re-derived later. `degraded: true` means this snapshot captured ZERO
 * usable records (every candidate pid was gone, unreadable, or the
 * observation itself failed/timed out/produced malformed output) - see
 * `degradedReason` for which. A degraded snapshot is never fatal to the
 * SIGTERM this codebase is about to send (terminating the job is the
 * user's own request, and must not be blocked by an observation failure -
 * see `killProcessGroupPosix`'s own call site) - it only means the
 * escalation gate below has nothing positive to work with later, and must
 * therefore refuse (see `evaluateEscalationIdentityGate`'s own docs).
 */
export interface EscalationIdentitySnapshot {
  readonly members: readonly RecordedGroupMember[];
  readonly degraded: boolean;
  readonly degradedReason?: string;
}

/**
 * Every one of `captureEscalationIdentitySnapshot`'s seven distinct
 * `degraded`-producing sites - named separately for the same reason
 * `BirthIdentityCaptureFailureBranch` names its own six sites separately:
 * "budget exhausted before this step could even run" and "this step ran
 * and its own observer reported a failure" are different situations even
 * within the same step, and collapsing either pair - or the three steps
 * themselves - into one label would make a real occurrence unable to say
 * which one actually happened.
 */
export type EscalationSnapshotDegradedBranch =
  | "leader-read-budget-exhausted"
  | "leader-read-observer-failure"
  | "enumeration-budget-exhausted"
  | "enumeration-observer-failure"
  | "descendant-read-budget-exhausted"
  | "descendant-read-observer-failure"
  | "zero-usable-records";

/**
 * `captureEscalationIdentitySnapshot`'s own `degraded` outcome, logged to
 * stderr only, diagnostic-only exactly like `logCaptureUndefined` above -
 * changes no return value. This is THE pre-SIGTERM snapshot on the real
 * kill path (see `killProcessGroupPosix`'s own call site), so a real
 * occurrence here says which of the three capture steps - not merely that
 * "the snapshot degraded" - left the later escalation gate with nothing
 * positive to work with.
 */
function logEscalationSnapshotDegraded(
  leaderPid: number,
  branch: EscalationSnapshotDegradedBranch,
  reason: string
): void {
  console.error(
    `[ghantika] captureEscalationIdentitySnapshot(leaderPid=${leaderPid}) degraded - branch: ${branch} - ${reason}`
  );
}

/**
 * Captures `EscalationIdentitySnapshot` for `leaderPid`'s process group -
 * the ORIGINAL membership the escalation identity gate later re-reads and
 * compares against. Three real observations, in order, ALL sharing ONE
 * overall `timeoutMs` deadline (never `timeoutMs` per step - see this
 * function's own docs for why that single shared deadline is what keeps
 * this phase's total cost independent of how it happens to be internally
 * split):
 *
 * 1. The leader's OWN start time, read on its own (`readPidStartTimesBatchPosix`
 *    with a single pid) - independently observable/testable from step 2's
 *    own failure modes (this is "the initial leader read").
 * 2. The group's CURRENT descendants, discovered via `pgrep -g leaderPid`
 *    (`enumerateProcessGroupMembersPosixAsync`) - "member enumeration".
 * 3. Every discovered descendant's own start time, in ONE batched
 *    `readPidStartTimesBatchPosix` call.
 *
 * FAIL CLOSED, WITH THE CASES ENUMERATED: a genuine observer failure at
 * ANY of the three steps above (a timeout, a missing binary, malformed
 * enumeration output) marks the WHOLE snapshot `degraded`, even if an
 * earlier step already captured a usable record - a member enumeration
 * that itself timed out or came back malformed means this codebase cannot
 * trust that it has correctly discovered the group's real membership, so
 * the safe reading is to distrust the whole attempt, not to quietly keep
 * whatever partial success came before it. Distinct from a pid simply
 * being ABSENT from a successful read (gone, not malformed, not timed
 * out) - that is a legitimate, expected outcome (a member that
 * disappeared on its own, or was never there), never itself a
 * degradation, and never prevents another, still-present member from
 * being recorded. Zero usable records after an otherwise-clean read is
 * ALSO `degraded` (there is nothing to compare against later, regardless
 * of whether every step "succeeded").
 *
 * `now` is an injectable time source, defaulting to the real `Date.now`,
 * that this function's own budget arithmetic reads exclusively - never a
 * raw `Date.now()` call scattered through the body. Production behavior
 * is unchanged (the default IS `Date.now`); the seam exists so a test can
 * deterministically force a budget-exhausted branch (`*-budget-exhausted`)
 * without depending on a real, host-speed-sensitive sleep race, matching
 * `captureBirthIdentityPosixAsync`'s own injectable-clock pattern above
 * for exactly the same reason.
 */
export async function captureEscalationIdentitySnapshot(
  leaderPid: number,
  timeoutMs: number = PROCESS_IDENTITY_OBSERVATION_TIMEOUT_MS,
  now: () => number = Date.now
): Promise<EscalationIdentitySnapshot> {
  const deadline = now() + timeoutMs;
  const remainingBudget = (): number => Math.max(0, deadline - now());

  let sawObserverFailure = false;
  let observerFailureReason: string | undefined;
  let degradedBranch: EscalationSnapshotDegradedBranch | undefined;
  const recorded: RecordedGroupMember[] = [];

  // Step 1: the initial leader read - independently observable from step 2's own timeout/failure below.
  const leaderBudget = remainingBudget();
  if (leaderBudget <= 0) {
    sawObserverFailure = true;
    degradedBranch = "leader-read-budget-exhausted";
    observerFailureReason =
      "pre-SIGTERM snapshot budget exhausted before the initial leader read could run";
  } else {
    const leaderRead = await readPidStartTimesBatchPosix([leaderPid], leaderBudget);
    if (leaderRead.status === "observer-failure") {
      sawObserverFailure = true;
      degradedBranch = "leader-read-observer-failure";
      observerFailureReason = `the initial leader read failed: ${leaderRead.reason}`;
    } else {
      const leaderStart = findRecordedStartTime(leaderRead.rows, leaderPid);
      if (leaderStart !== undefined) recorded.push({ pid: leaderPid, startTimeMs: leaderStart });
    }
  }

  // Step 2: member enumeration - who else is currently in this group.
  const enumerationBudget = remainingBudget();
  let descendantPids: readonly number[] = [];
  if (enumerationBudget <= 0) {
    sawObserverFailure = true;
    degradedBranch ??= "enumeration-budget-exhausted";
    observerFailureReason ??=
      "pre-SIGTERM snapshot budget exhausted before member enumeration could run";
  } else {
    const enumeration = await enumerateProcessGroupMembersPosixAsync(leaderPid, enumerationBudget);
    if (enumeration.status === "observer-failure") {
      sawObserverFailure = true;
      degradedBranch ??= "enumeration-observer-failure";
      observerFailureReason ??= `member enumeration failed: ${enumeration.reason}`;
    } else {
      descendantPids = enumeration.pids.filter((candidate) => candidate !== leaderPid);
    }
  }

  // Step 3: every discovered descendant's own start time, batched in ONE call.
  if (descendantPids.length > 0) {
    const readBudget = remainingBudget();
    if (readBudget <= 0) {
      sawObserverFailure = true;
      degradedBranch ??= "descendant-read-budget-exhausted";
      observerFailureReason ??=
        "pre-SIGTERM snapshot budget exhausted before the descendant start-time read could run";
    } else {
      const descendantRead = await readPidStartTimesBatchPosix(descendantPids, readBudget);
      if (descendantRead.status === "observer-failure") {
        sawObserverFailure = true;
        degradedBranch ??= "descendant-read-observer-failure";
        observerFailureReason ??= `descendant start-time read failed: ${descendantRead.reason}`;
      } else {
        for (const candidate of descendantPids) {
          const startTimeMs = findRecordedStartTime(descendantRead.rows, candidate);
          if (startTimeMs !== undefined) recorded.push({ pid: candidate, startTimeMs });
        }
      }
    }
  }

  if (sawObserverFailure || recorded.length === 0) {
    const reason =
      observerFailureReason ??
      "zero usable identity records captured (every candidate pid was gone, unreadable, or malformed)";
    logEscalationSnapshotDegraded(leaderPid, degradedBranch ?? "zero-usable-records", reason);
    return { members: [], degraded: true, degradedReason: reason };
  }
  return { members: recorded, degraded: false };
}

export type EscalationIdentityGateResult =
  { readonly action: "escalate" } | { readonly action: "refuse"; readonly reason: string };

/**
 * THE ESCALATION IDENTITY GATE - the single real decision point for
 * whether `killProcessGroupPosix` may send its SIGKILL escalation.
 * Boundedly re-reads ONLY the pids `snapshot` already recorded (never a
 * fresh enumeration - the group is compared against its OWN prior
 * snapshot, not re-discovered) via ONE batched `readPidStartTimesBatchPosix`
 * call, on its OWN fresh `timeoutMs` budget (never the snapshot phase's
 * leftover budget - see `PROCESS_IDENTITY_OBSERVATION_TIMEOUT_MS`'s own
 * docs for why each phase gets its own independent allowance).
 *
 * THE ALGORITHM, exactly: if ANY ONE originally-recorded member's current
 * start time EXACTLY matches its recorded value, the group is still ours
 * and escalation proceeds - the leader is NOT a special case here, it is
 * compared through the identical exact-match rule as every descendant, no
 * tolerance window. If NONE matches, escalation is refused. This is a
 * strict superset of every enumerated fail-closed cell, because every one
 * of them collapses to the same observable fact - "no positive match was
 * found":
 *
 * - the snapshot itself never captured a usable original member
 *   (`snapshot.degraded`) - nothing to compare against at all;
 * - the bounded re-read TIMES OUT or the observer fails to execute -
 *   `observer-failure`, so no member's current state could be read;
 * - every recorded member is gone at re-read (a real `ps -p <list>` read
 *   that simply omits every one of them - the SIGTERM working, never
 *   itself a failure);
 * - a recorded member is still present but its start time DIFFERS from
 *   the record (the recycled-pid case);
 * - a recorded member's row came back malformed (discarded, never
 *   guessed at - contributes no match, same as if it were absent).
 *
 * In every one of those, `matched` below is `false`, and this function
 * refuses - there is no separate branch to keep in sync with this list,
 * so a change to any one of them can never silently diverge from the
 * others.
 *
 * IDENTITY IS THE GATE, NEVER THE TARGET: this function only ever decides
 * WHETHER to escalate - the escalation itself remains the single
 * group-granularity `kill(-pgid, SIGKILL)` `killProcessGroupPosix` already
 * sends; nothing here ever signals an individual member's own pid.
 *
 * THE RESIDUAL, DISCLOSED AS NARROWED, NEVER AS CLOSED: this gate does not
 * make identity-and-signal atomic. After this function returns `escalate`,
 * the member that proved the match can still exit, and the numeric pgid
 * can still become reusable, in the real gap between this check completing
 * and the caller's own `kill(-pgid, SIGKILL)` syscall - two separate
 * syscalls, with no atomic check-and-signal for a process group anywhere
 * in portable POSIX. This narrows the exposure from the multi-second
 * grace window (the OLD, un-gated behavior) down to one syscall-to-syscall
 * interval plus this gate's own whole-second `lstart` resolution - it does
 * not eliminate it.
 */
export async function evaluateEscalationIdentityGate(
  snapshot: EscalationIdentitySnapshot,
  timeoutMs: number = PROCESS_IDENTITY_OBSERVATION_TIMEOUT_MS
): Promise<EscalationIdentityGateResult> {
  if (snapshot.degraded || snapshot.members.length === 0) {
    return {
      action: "refuse",
      reason:
        "escalation refused: the pre-SIGTERM identity snapshot never captured a usable original process-group member" +
        (snapshot.degradedReason !== undefined ? ` (${snapshot.degradedReason})` : ""),
    };
  }

  const pids = snapshot.members.map((member) => member.pid);
  const read = await readPidStartTimesBatchPosix(pids, timeoutMs);
  if (read.status === "observer-failure") {
    return {
      action: "refuse",
      reason: `escalation refused: the escalation-time identity re-read failed (${read.reason})`,
    };
  }

  const matched = snapshot.members.some(
    (member) => findRecordedStartTime(read.rows, member.pid) === member.startTimeMs
  );
  if (!matched) {
    return {
      action: "refuse",
      reason:
        "escalation refused: none of the originally-recorded process-group members still report their original start time (each is either gone, has a differing start time, or could not be read)",
    };
  }
  return { action: "escalate" };
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

  // Snapshot the ORIGINAL process-group membership - the leader plus every
  // currently-live descendant, each one's pid and real OS-read start time -
  // BEFORE the first signal below is ever sent. This is the escalation
  // identity gate's own pre-SIGTERM observation (see
  // captureEscalationIdentitySnapshot's own docs for the full three-step
  // capture and its fail-closed cells). A degraded/failed snapshot here
  // NEVER blocks this SIGTERM - terminating the job is the caller's own
  // request, and must not be held hostage by an observation failure - it
  // only means the escalation gate further down has nothing positive to
  // work with later and must therefore refuse (see evaluateEscalationIdentityGate).
  const identitySnapshot = await captureEscalationIdentitySnapshot(pid);

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
  // intended outcome of the SIGTERM above.
  if (!isProcessGroupAlive(pid)) {
    return {
      finalSignal: "SIGTERM",
      escalated: false,
      confirmed: await confirmProcessGroupReapedPosix(pid),
    };
  }

  // THE ESCALATION IDENTITY GATE (see evaluateEscalationIdentityGate's own
  // docs for the full algorithm and its complete fail-closed enumeration):
  // boundedly re-reads ONLY the members identitySnapshot already recorded
  // and requires at least one of them to still report an EXACTLY matching
  // start time before this codebase will ever send SIGKILL. This narrows -
  // materially, not completely - the window between "still alive" and
  // "about to send SIGKILL": an unrelated group that happens to receive
  // this exact recycled pgid, with a member whose start time happens to
  // fall within the SAME whole second as an originally-recorded one, would
  // still read as a match and would still receive this SIGKILL - the
  // check and the signal below remain two separate syscalls, and portable
  // POSIX offers no atomic check-and-signal for a process group. This is
  // distinct from the eager-reap gap (`reapProcessGroupOnce`'s own docs),
  // which is a single scheduling tick, not a whole grace period, and
  // arises only when a job's leader exits on its own rather than being
  // actively signaled here. The once-per-job reap guard does not help
  // here either: it prevents a LATER `kill` call from re-signaling this
  // job, not a reused pgid encountered within this SAME escalation.
  const identityGate = await evaluateEscalationIdentityGate(identitySnapshot);
  if (identityGate.action === "refuse") {
    return {
      finalSignal: "SIGTERM",
      escalated: false,
      confirmed: await confirmProcessGroupReapedPosix(pid),
      escalationRefusedReason: identityGate.reason,
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
