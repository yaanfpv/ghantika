/**
 * The command-spawn policy gate `src/tools/run.ts` calls at launch time -
 * as late as possible before the real OS-level spawn, for both an
 * ordinary argv-array invocation and a `shell: true` one. Default-deny:
 * a command is only ever allowed when it resolves to something an
 * operator explicitly put on the allowlist; every other outcome (no
 * policy configured, a policy file that can't be read or parsed, a
 * resolution failure) denies.
 *
 * ## Where the policy comes from
 *
 * The allowlist is loaded from a JSON file whose PATH is named by the
 * `GHANTIKA_POLICY_FILE` environment variable - a value this SERVER's own
 * process environment carries, set by whoever configured the server, never
 * anything derived from a tool call's own arguments. Neither `decideRunPolicy`
 * nor `decideShellPolicy` below ever looks at a caller's `command`/`env`
 * argument to decide what is on the allowlist - the only caller-influenced
 * input `decideRunPolicy` takes is the CANDIDATE being judged (an already-
 * resolved executable path); `decideShellPolicy` takes no caller input at
 * all, since the fixed shell-binary location Node itself would use is read
 * from THIS SERVER's own environment, never the job's (see
 * `resolveManagedShellBinaryPath`). `loadPolicy` below re-reads and
 * re-parses the file fresh on every call - no caching, so a corrected
 * policy takes effect on the very next `run` call with no server restart,
 * and there is no cached state for a stale read to hide behind.
 *
 * No configured source, an unreadable file, invalid JSON, or a JSON shape
 * that isn't `{ "allow": [...] }` with every element a string, are all
 * collapsed into the same outcome: deny everything. `loadPolicy` has
 * exactly one success return; every other path returns a denial reason,
 * so there is no route from "policy didn't load" to "allow" anywhere in
 * this file.
 *
 * ## Canonical resolution, not string comparison
 *
 * `decideRunPolicy` takes the SAME resolved executable path `run.ts`'s own
 * pre-flight `resolveExecutable` call already computed - never re-derived
 * here, so there is exactly one PATH/PATHEXT resolution per candidate, not
 * two that could disagree. `decideShellPolicy` has no caller-supplied
 * executable to resolve at all: `shell: true` always spawns Node's own
 * default platform shell (`/bin/sh` on POSIX; the environment's `ComSpec`
 * on Windows - see `resolveManagedShellBinaryPath`), never anything the
 * caller's command line names, so that fixed binary is what gets judged,
 * and the shell command string itself plays no role in the decision.
 *
 * Both funnel into `canonicalizeForComparison`: realpath-resolve the
 * candidate (closing a symlink to its real target), normalize the path
 * separator, and case-fold only where a live, per-path probe proves the
 * real filesystem is case-insensitive there (see
 * `isPathOnCaseInsensitiveFilesystem` for that probe, never a platform-wide
 * guess). Every allowlist entry is put through the identical pipeline
 * before comparison, so any spelling of the
 * same real binary - a bare name found via PATH, an absolute path, a
 * different case, a different separator, a path that goes through a
 * symlink - converges on the same allow/deny answer. Allowlist entries are
 * resolved against THIS SERVER's own trusted PATH/cwd, captured ONCE at
 * module load (see `TRUSTED_SERVER_ENV`/`TRUSTED_SERVER_CWD`'s own docs),
 * never the caller-supplied job env/cwd - a caller who controls their own
 * job's `env.vars.PATH` must never be able to redirect what an allowlist
 * entry like `"node"` resolves to by pointing PATH at a directory of their
 * own choosing.
 *
 * ## Interpreter/wrapper laundering
 *
 * This module ships no allowlist of its own - the default (nothing
 * configured) is deny-everything, so there is nothing here for a caller to
 * launder through by default. Nothing in the decision logic treats an
 * interpreter or wrapper (`sh`, `bash`, `node`, `python`, `env`, ...)
 * specially: `sh -c "<anything>"` is decided purely on whether the
 * resolved `/bin/sh` itself is on the allowlist, exactly like any other
 * direct invocation - the arguments after it are never inspected, and
 * being on the allowlist is never inferred from anything except an exact,
 * canonical match. If an operator chooses to put an interpreter on their
 * own allowlist, that is a decision they made explicitly for their own
 * deployment, not something this module defaults to or narrows.
 *
 * ## Disclosed residual: TOCTOU between resolution and the real spawn
 *
 * This check runs against the executable's REAL, resolved path at the
 * moment of the decision. The actual spawn that follows a few
 * microseconds later still asks the OS to resolve/open that same target
 * again - for an ordinary argv[0] job, a bare name is resolved a SECOND
 * time via PATH/execvp inside `child_process.spawn` itself (see
 * `src/process.ts`'s `spawnManaged`); for a `shell: true` job, the
 * resolved absolute path is passed straight through as a literal
 * `shell: <path>` string (see `decideShellPolicy`), so there is no bare
 * name left to re-resolve, only the OS opening that same literal path
 * again. Either way, a concurrent filesystem change in that narrow window
 * (a symlink swapped, a file replaced) between this decision and the real
 * spawn is a known, disclosed, unclosed limitation - a time-of-check-to-
 * time-of-use gap this story does not attempt to close, the same
 * honest-disclosure shape `src/process.ts`'s own kill-path residuals
 * already use for their own narrow, unavoidable races.
 */
import fs from "node:fs";
import path from "node:path";

import { POSIX_DEFAULT_PATH, resolveExecutable } from "./process.js";

/** The trusted-source environment variable naming the policy file's path. Read only from THIS server's own process environment, never from a tool call's arguments. */
export const POLICY_FILE_ENV_VAR = "GHANTIKA_POLICY_FILE";

export interface PolicyDecision {
  readonly allowed: boolean;
  /** A short, safe-to-disclose reason - present only when `allowed` is `false`. Never echoes the policy file's own path or contents; see `denyDecision`'s own docs. */
  readonly reason?: string;
  /**
   * The exact, already-resolved platform-shell executable path this
   * decision judged - present only when `allowed` is `true` and the
   * decision came from `decideShellPolicy` (a `shell: true` job).
   * `run.ts` threads this straight into `spawnManaged`'s
   * `shellExecutable` option so the identity this check approved is the
   * identity that actually launches, with no separate re-resolution at
   * spawn time - see `decideShellPolicy`'s own docs for why that identity
   * EQUALITY, not merely the same source informing two independent
   * resolutions, is the property being enforced. Absent for a
   * `decideRunPolicy` (ordinary argv) decision, which has no separate
   * "shell binary" to disclose.
   */
  readonly resolvedShellBinary?: string;
}

/**
 * Flips the case of every cased character in `value` (lowercase becomes
 * uppercase and vice versa; anything without a case, like digits or
 * separators, is left alone). Used only to build a same-length, different-
 * spelling candidate for the live case-sensitivity probe below - never a
 * general-purpose case utility.
 */
function flipCase(value: string): string {
  return [...value]
    .map((char) => {
      const lower = char.toLowerCase();
      const upper = char.toUpperCase();
      if (lower === upper) return char; // no case distinction for this character
      return char === lower ? upper : lower;
    })
    .join("");
}

/**
 * `true` when `resolvedPath` (already realpath-resolved) genuinely lives on
 * a case-INSENSITIVE filesystem, decided by a REAL, LIVE probe of the
 * WHOLE path - never a platform guess, and never a probe of the basename
 * alone. Flips every cased character across the ENTIRE path (every
 * component, not just the leaf) and stats both spellings: if they resolve
 * to the identical device+inode, the filesystem treats every spelling this
 * flip could produce as one file, so folding case for comparison is safe.
 * If the fully-flipped spelling doesn't exist, or exists as a DIFFERENT
 * device+inode, this exact path is case-sensitive at some component (or
 * its case-sensitivity couldn't be proven), so this returns `false` -
 * never folds. That is the fail-closed direction: an unproven probe is
 * treated as case-sensitive, which can only narrow a match (denying two
 * spellings that are actually the same file), never widen one (accepting
 * two spellings that are actually different files).
 *
 * Probing the WHOLE path rather than only the basename closes a real
 * blind spot: a case-free leaf like `123` would give a basename-only
 * probe nothing to test, so it would return `true` unconditionally and
 * let the caller fold the whole path regardless of whether an ancestor
 * directory's case actually mattered on that filesystem. Flipping the
 * whole path removes that blind spot by construction - there is no
 * component this probe does not examine.
 */
function isPathOnCaseInsensitiveFilesystem(resolvedPath: string): boolean {
  const flipped = flipCase(resolvedPath);
  try {
    const originalStat = fs.statSync(resolvedPath);
    const flippedStat = fs.statSync(flipped);
    return originalStat.dev === flippedStat.dev && originalStat.ino === flippedStat.ino;
  } catch {
    return false;
  }
}

/**
 * Puts a real, already-resolved filesystem path through the one pipeline
 * BOTH a candidate executable and every allowlist entry are judged by:
 * realpath (closing any symlink to its real target), separator
 * normalization (so a Windows backslash and a POSIX forward slash on the
 * same logical path compare equal), then a case-fold decided by a live
 * per-path probe (see `isPathOnCaseInsensitiveFilesystem`) rather than a
 * platform-wide guess - so a non-default case-sensitive macOS volume, or a
 * non-default case-insensitive Linux mount, is judged by what that exact
 * filesystem actually does, never assumed from the platform alone. Returns
 * `undefined` only when the realpath read itself fails - a path that
 * existed a moment ago but no longer resolves; the caller treats that as
 * "cannot canonicalize this candidate", which denies for a real candidate
 * and simply drops a stale allowlist entry from the effective set (see
 * `loadPolicy`), never a crash either way.
 */
function canonicalizeForComparison(resolvedPath: string): string | undefined {
  let real: string;
  try {
    real = fs.realpathSync(resolvedPath);
  } catch {
    return undefined;
  }
  const separatorNormalized = real.split(path.sep).join("/");
  return isPathOnCaseInsensitiveFilesystem(real)
    ? separatorNormalized.toLowerCase()
    : separatorNormalized;
}

/**
 * The trusted PATH/cwd allowlist-entry resolution uses: this SERVER's own
 * real `PATH` and working directory, captured ONCE at module load - the
 * moment this file is first imported, always before any request this
 * server ever handles - rather than re-read from `process.env`/`process.cwd()`
 * on every decision. Deliberately NOT the same "read fresh every time"
 * choice `loadPolicy` makes for the policy FILE's own content (see this
 * file's header docs for why re-reading the file is exactly what lets an
 * edited policy take effect with no restart) - the two are independent
 * design choices about two different things. A bare allowlist name like
 * `"node"` names a real, fixed installation on this machine; nothing about
 * this server's own legitimate operation is expected to relocate that
 * installation or move its own working directory mid-lifetime, so
 * resolving against a value captured once at startup is the more STABLE
 * trust anchor, not a weaker one: it is immune to some unrelated later
 * code path in this same process transiently mutating `process.env.PATH`
 * for an entirely different purpose (this codebase's own test suite does
 * exactly that, elsewhere, to exercise `src/process.ts`'s birth-identity
 * capture against a broken server PATH - a policy decision made from a
 * live read would otherwise ALSO see that unrelated, transient breakage
 * and deny a command it should allow). The caller-supplied job env/cwd
 * `decideRunPolicy`'s own candidate is resolved against is never affected
 * either way - only allowlist-ENTRY resolution uses this trusted snapshot.
 */
const TRUSTED_SERVER_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: process.env.PATH ?? POSIX_DEFAULT_PATH,
});
const TRUSTED_SERVER_CWD: string = process.cwd();

/**
 * Resolves one raw allowlist entry (a bare name or a path, exactly as an
 * operator wrote it in the policy file) to its canonical comparison key,
 * using `resolveExecutable` - the SAME PATH/PATHEXT/Windows-extension
 * resolution `src/process.ts` already applies to a real job's own
 * `argv[0]` - but against THIS SERVER's own trusted cwd/env (see
 * `TRUSTED_SERVER_ENV`/`TRUSTED_SERVER_CWD`'s own docs), never a job's.
 * A stale entry (naming a binary that no longer exists) simply resolves to
 * `undefined` here and is dropped from the effective allowed set - it is
 * not a load failure, since a policy file is allowed to list more than the
 * current machine happens to have installed.
 */
function resolveAllowlistEntry(entry: string): string | undefined {
  const resolved = resolveExecutable(entry, TRUSTED_SERVER_CWD, TRUSTED_SERVER_ENV);
  if (resolved === undefined) return undefined;
  return canonicalizeForComparison(resolved);
}

type PolicyLoadResult =
  | { readonly ok: true; readonly allowedTargets: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Loads and validates the policy file named by `GHANTIKA_POLICY_FILE`,
 * resolving every allowlist entry to its canonical comparison key. Every
 * failure path - the env var unset, the file unreadable, invalid JSON, or
 * a JSON shape other than `{ "allow": string[] }` - returns `{ ok: false
 * }` with a short, generic reason: none of these branches ever falls
 * through to "allow everything", and none of them echoes the policy
 * file's own path or raw content back into the reason string (that string
 * ultimately reaches a job's `diagnostic.message`, a field visible to
 * whoever is polling `status`/`list` - see `denyDecision`'s own docs).
 * Re-reads and re-parses from disk on every call - see this file's own
 * header for why that is deliberate, not an oversight.
 */
function loadPolicy(): PolicyLoadResult {
  const policyPath = process.env[POLICY_FILE_ENV_VAR];
  if (policyPath === undefined || policyPath.length === 0) {
    return { ok: false, reason: `no policy source configured (${POLICY_FILE_ENV_VAR} unset)` };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(policyPath, "utf8");
  } catch {
    return { ok: false, reason: "policy source could not be read" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "policy source is not valid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'policy source must be a JSON object with an "allow" field' };
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "allow") {
    return { ok: false, reason: 'policy source must contain exactly one field, "allow"' };
  }
  const allowRaw = (parsed as Record<string, unknown>).allow;
  if (!Array.isArray(allowRaw) || !allowRaw.every((entry) => typeof entry === "string")) {
    return { ok: false, reason: 'policy source\'s "allow" field must be an array of strings' };
  }

  const allowedTargets: string[] = [];
  for (const entry of allowRaw as string[]) {
    const canonical = resolveAllowlistEntry(entry);
    if (canonical !== undefined) allowedTargets.push(canonical);
  }
  return { ok: true, allowedTargets };
}

/** The one, safe, user-facing denial shape every deny path in this file returns through - never leaks the policy file's own path/content, only ever this file's own short, fixed reason strings or the equally short "not on the allowlist" outcome. */
function denyDecision(reason: string): PolicyDecision {
  return { allowed: false, reason };
}

/**
 * Decides whether `resolvedExecutablePath` - the SAME real, existing path
 * `run.ts`'s own pre-flight `resolveExecutable` already computed for
 * `argv[0]` - may be spawned. This is the argv-array (non-`shell`) path;
 * see `decideShellPolicy` for `shell: true`.
 */
export function decideRunPolicy(resolvedExecutablePath: string): PolicyDecision {
  const loaded = loadPolicy();
  if (!loaded.ok) return denyDecision(loaded.reason);

  const candidate = canonicalizeForComparison(resolvedExecutablePath);
  if (candidate === undefined) {
    return denyDecision("the resolved executable could not be canonicalized");
  }
  if (loaded.allowedTargets.includes(candidate)) return { allowed: true };
  return denyDecision("command is not on the allowlist");
}

/**
 * Resolves the FIXED binary `child_process.spawn`'s own `shell: true`
 * option will actually invoke - never anything derived from the caller's
 * shell command line, which plays no role in this decision at all. On
 * POSIX this is always `/bin/sh`, Node's own documented default. On
 * Windows, Node's own `shell: true` resolution reads `process.env.comspec`
 * from THIS SERVER's own process environment - never from the job's `env`
 * option, which only becomes the child's environment after the shell
 * binary has already been chosen - falling back to the bare name `cmd.exe`
 * when unset, exactly as Node does.
 *
 * That value - whether an absolute `ComSpec` path or the bare fallback
 * name - is then run through the SAME `resolveExecutable` PATH+PATHEXT
 * resolution `run.ts`'s own pre-flight already uses for an ordinary
 * argv[0] (see that function's own docs): a path-separator-containing
 * value is treated as a literal path, a bare name is searched across
 * `PATH` trying each `PATHEXT` extension in turn, mirroring
 * `cmd.exe`/`CreateProcess`'s own resolution. This is what makes the
 * bare-fallback case resolve the way Windows actually would, rather than
 * the plain cwd-relative realpath `canonicalizeForComparison` alone would
 * perform on an unresolved bare name. Returns `undefined` when nothing
 * executable is found - denies, same as any other unresolvable candidate.
 * This codebase has no Windows leg in its CI matrix today (see
 * `src/process.ts`'s `windowsExtensionCandidates` for the same disclosed
 * scope), so this branch is verified by reading and by a platform-mocked
 * unit test, not by real CI execution here.
 *
 * `cwd`/`env` default to this server's own trusted values and every real
 * caller (`decideShellPolicy` below) takes those defaults - the parameters
 * exist only so a test can mock `process.platform` as `"win32"` and supply
 * a scratch PATH to prove the fallback genuinely performs a PATH search
 * rather than a cwd-relative realpath, without needing a real Windows
 * machine or being able to influence what a live server actually trusts.
 */
export function resolveManagedShellBinaryPath(
  cwd: string = TRUSTED_SERVER_CWD,
  env: Readonly<Record<string, string>> = TRUSTED_SERVER_ENV
): string | undefined {
  if (process.platform === "win32") {
    const comSpec = process.env.ComSpec ?? "cmd.exe";
    return resolveExecutable(comSpec, cwd, env);
  }
  return "/bin/sh";
}

/**
 * Decides whether a `shell` job may spawn, AND returns the exact resolved
 * platform shell binary that decision approved. Resolves to the fixed
 * platform shell binary (see `resolveManagedShellBinaryPath` - this reads
 * only THIS SERVER's own trusted environment, never the job's, because
 * that is the environment an operator's allowlist is meant to trust) and
 * runs it through the identical `decideRunPolicy` check a direct
 * invocation of that same binary would get - an operator must explicitly
 * allowlist the shell binary itself (`/bin/sh` on POSIX) before any shell
 * job can ever run, exactly as they would for any other executable.
 *
 * On an `allowed` outcome, the caller (`run.ts`) threads the returned
 * `resolvedShellBinary` straight into `spawnManaged`'s `shellExecutable`
 * option, which is passed to `child_process.spawn` as a literal
 * `shell: <path>` string - never the bare boolean `shell: true`. That
 * distinction is what actually closes the gap this decision alone cannot:
 * `shell: true` lets Node re-resolve a BARE shell-binary name on its own,
 * at spawn time, from the JOB's own `env` option (see `spawnManaged`'s own
 * docs and `effectivePathForLookup` in `src/process.ts`) - a second,
 * independent resolution this policy check never sees and cannot judge,
 * and on Windows one that can name a completely different executable than
 * the one just approved. Passing the already-resolved, already-approved
 * absolute path instead leaves no bare name for Node to re-resolve: a
 * path-separator-containing value is used exactly as given, with no
 * PATH+PATHEXT search of any environment at all. So the identity this
 * function judges and the identity that launches are the SAME string, by
 * construction, never merely by the two resolutions happening to agree.
 * `undefined` means the platform shell binary could not be resolved at
 * all - denies, same as any other unresolvable candidate.
 */
export function decideShellPolicy(): PolicyDecision {
  const shellBinary = resolveManagedShellBinaryPath();
  if (shellBinary === undefined) {
    return denyDecision("the platform shell binary could not be resolved");
  }
  const decision = decideRunPolicy(shellBinary);
  return decision.allowed ? { allowed: true, resolvedShellBinary: shellBinary } : decision;
}
