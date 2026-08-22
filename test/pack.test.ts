/**
 * Proves the PUBLISHED shape of this package, not just its source. Every
 * other suite in this repo exercises `dist/index.js` inside the checkout
 * directly (`test/helpers/spawnServer.ts`'s own `SERVER_ENTRY`); nothing
 * until this file ever builds a real `npm pack` tarball, installs it into
 * an isolated prefix the way a real end user's `npx ghantika` would, and
 * proves the result from OUTSIDE the checkout.
 *
 * One real (non-dry) `npm pack` runs exactly ONCE, in this file's own
 * `before()` hook - its resulting `.tgz` bytes are hashed immediately
 * (`RECORDED_TGZ_SHA256`) and every test below operates on that exact
 * artifact (the same file path, the same buffer, the same hash), never a
 * second build. Two real, isolated `npm install --global --prefix <dir>`
 * installs of that one tarball also run once each in the same hook - a
 * NETWORKED one (an intentionally empty cache) and an OFFLINE one (a
 * cache seeded from the networked install's own cache so the offline
 * install can genuinely resolve every dependency with zero network
 * access) - and every test that needs an installed copy reads from one
 * of those two, never installing again.
 *
 * A systematic mutation-matrix pass over the packaging surface is out of
 * scope here - every test below is ordinary test-driven coverage instead
 * (a real assertion with a real negative case, verified directly rather
 * than assumed).
 */
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  callTool,
  makeTempDir,
  parsesAsPgid,
  waitForFile,
  waitForPgrepGroupMembers,
} from "./harness.ts";
import { completeHandshake, type SpawnedServer, spawnServer } from "./helpers/spawnServer.ts";
import { requireSpawnPolicy } from "./helpers/requireSpawnPolicy.ts";
import {
  findDisallowedModeEntries,
  findEntriesOutsidePackagePrefix,
  findLinkEntries,
  findPathTraversalViolations,
  findSourceMapEntries,
  parseTarballGzip,
  readEntryContent,
  type ParsedTarball,
} from "./archive-scan.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHECKOUT_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const PACKAGE_JSON = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  readonly name: string;
  readonly version: string;
  readonly type: string;
  readonly bin: Record<string, string>;
  readonly files: readonly string[];
};

// Every real-process assertion below (child-pid discovery via `pgrep`, the
// installed prefix's own POSIX `lib/node_modules/<name>` layout) is
// POSIX-only, exactly like test/shutdown.test.ts's own `PGREP_ORACLE_SKIP` -
// a real test-harness gap (no CI runner for this repo's `test` job matrix
// includes `windows-latest` today), never a claim that the product itself
// is POSIX-only. See test/shutdown.test.ts's identical constant for the
// established convention this mirrors.
const WINDOWS_SKIP_REASON =
  process.platform === "win32"
    ? "confirms the result via `pgrep`/the POSIX global-install layout, POSIX-only"
    : false;

// ---------------------------------------------------------------------------
// Shared clean-room plumbing.
// ---------------------------------------------------------------------------

/**
 * `node`, `npm`, and `npx` ship as siblings in one `bin/` directory on
 * every official Node distribution (including the one `actions/setup-node`
 * installs in CI) - `path.dirname(process.execPath)` is that directory.
 * Asserted, not assumed: a clean room whose PATH silently lacked `npm`/`npx`
 * would fail with a confusing "command not found" rather than a diagnostic
 * naming what this file actually expected to find there.
 */
function resolveNodeBinDir(): string {
  const dir = path.dirname(process.execPath);
  const npmName = process.platform === "win32" ? "npm.cmd" : "npm";
  const npxName = process.platform === "win32" ? "npx.cmd" : "npx";
  assert.ok(
    existsSync(path.join(dir, npmName)) && existsSync(path.join(dir, npxName)),
    `expected npm/npx alongside node at ${dir} (process.execPath: ${process.execPath})`
  );
  return dir;
}

function npmExecutablePath(): string {
  return path.join(resolveNodeBinDir(), process.platform === "win32" ? "npm.cmd" : "npm");
}

function npxExecutablePath(): string {
  return path.join(resolveNodeBinDir(), process.platform === "win32" ? "npx.cmd" : "npx");
}

/** A fresh, empty scratch directory under the OS temp dir - genuinely outside this checkout regardless of where the checkout itself is cloned. */
function freshDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Builds ONE real (non-dry) `.tgz` via `npm pack` against this checkout,
 * runs in the checkout's OWN environment (it needs the checkout's real
 * devDependencies - `tsc` in particular, via `prepack` -> `build` - which
 * is why this is the one step in this file that does NOT run inside a
 * scrubbed clean-room env). Records the resulting file's sha256
 * immediately after the pack command returns, before anything else in
 * this file ever touches the file again.
 */
function buildRealTarballOnce(): { tgzPath: string; buffer: Buffer; sha256: string } {
  const outDir = freshDir("ghantika-pack-out-");
  const stdout = execFileSync(npmExecutablePath(), ["pack", REPO_ROOT, "--json"], {
    cwd: outDir,
    encoding: "utf8",
  });
  // `npm pack --json` prints an OBJECT keyed by package name (verified
  // directly against a real run), never an array - `{"ghantika": {
  // "filename": "ghantika-0.1.0.tgz", ... }}`.
  const parsed = JSON.parse(stdout) as Record<string, { filename: string }>;
  const packedEntries = Object.values(parsed);
  assert.equal(packedEntries.length, 1, `expected exactly one packed artifact, got: ${stdout}`);
  const tgzPath = path.join(outDir, packedEntries[0]!.filename);
  const buffer = readFileSync(tgzPath);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return { tgzPath, buffer, sha256 };
}

interface GlobalInstallOptions {
  readonly prefix: string;
  readonly cache: string;
  readonly home: string;
  readonly cwd: string;
  readonly tgzPath: string;
  /** When true: forces `--offline` plus a proxy pointed at a closed local port, so ANY attempted network fetch fails immediately instead of silently succeeding - the install must be satisfiable from `cache` alone. */
  readonly blockNetwork?: boolean;
}

/** A real `npm install --global --prefix <prefix> <tgzPath>`, in a fully explicit (never-inherited) environment - see this function's callers for exactly which isolation properties each clean room needs. */
function runGlobalInstall(options: GlobalInstallOptions): void {
  const env: NodeJS.ProcessEnv = {
    HOME: options.home,
    // A minimal PATH containing ONLY node's own bin dir - no inherited
    // ambient PATH, so no accidental repo/global `ghantika` (or anything
    // else) can leak into what this install or a later `npx` call sees.
    PATH: [resolveNodeBinDir(), "/usr/bin", "/bin"].join(path.delimiter),
    TMPDIR: os.tmpdir(),
    npm_config_cache: options.cache,
  };
  if (options.blockNetwork) {
    env.npm_config_offline = "true";
    env.HTTP_PROXY = "http://127.0.0.1:1/";
    env.HTTPS_PROXY = "http://127.0.0.1:1/";
  }
  execFileSync(
    npmExecutablePath(),
    [
      "install",
      "--global",
      "--prefix",
      options.prefix,
      options.tgzPath,
      "--no-audit",
      "--no-fund",
      "--loglevel=warn",
    ],
    { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
  );
}

/** Where a `--global --prefix <prefix>` install of this package puts its compiled entry, on POSIX (`<prefix>/lib/node_modules/ghantika/dist/index.js` - verified directly against a real install, not assumed from documentation). */
function installedEntryPath(prefix: string): string {
  return path.join(prefix, "lib", "node_modules", PACKAGE_JSON.name, "dist", "index.js");
}

function installedPackageRoot(prefix: string): string {
  return path.join(prefix, "lib", "node_modules", PACKAGE_JSON.name);
}

/** `true` iff the OS process table still has `pid` (via the `kill(pid, 0)` existence-check convention - an EXTERNAL, kernel-level fact, never anything this codebase's own tool responses report about themselves). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ESRCH") return false;
    // EPERM would mean the process exists under another uid we can't
    // signal - every process in this suite runs as this same test
    // runner's own uid, so that should never actually occur here; treat
    // it as "still alive" rather than silently swallowing an unexpected
    // condition into a false negative.
    return true;
  }
}

/** Polls the real OS process table (never this codebase's own bookkeeping) until `pid` is gone, or a deadline elapses - a real external oracle with a deadline for confirming the server itself has exited, not merely its own reported exit. */
async function waitForProcessGone(pid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!isProcessAlive(pid)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `pid ${pid} is still alive per a real external process-table check after ${timeoutMs}ms`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function pgrepChildren(parentPid: number): number[] {
  try {
    const output = execFileSync("pgrep", ["-P", String(parentPid)], { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(Number);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number };
    if (err.status === 1) return []; // pgrep's own "nothing matched" exit code
    throw error;
  }
}

async function waitForAChildPid(parentPid: number, timeoutMs = 5000): Promise<number> {
  const start = Date.now();
  for (;;) {
    const children = pgrepChildren(parentPid);
    if (children.length >= 1) return children[0]!;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`no child process appeared under pid ${parentPid} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The real, OS-reported command line of a live process (`ps -o args=`), used only to read back WHICH script path a resolved `node <script>` invocation is actually running - the one fact this file cannot get any other way, since nothing in this codebase's own protocol reports its own script path. */
function resolvedCommandLineOf(pid: number): string {
  return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim();
}

// ---------------------------------------------------------------------------
// A minimal, self-contained real-stdio spawn - deliberately NOT
// `spawnServer()` from `./helpers/spawnServer.ts`. That helper always
// inherits this test runner's own `process.env` (see its own
// `envWithoutInheritedMessagingChannel`), which is correct for every OTHER
// suite in this repo but is exactly what the clean-room resolution proof
// below must NOT do - a leaked ambient PATH/HOME/cache would silently defeat the
// isolation this test exists to prove. This is used for exactly one
// thing: spawning `npx` itself (not `node <entry>`) under a fully
// explicit, non-inherited environment.
// ---------------------------------------------------------------------------

interface MiniLine {
  readonly raw: string;
  readonly parsed: unknown;
}

interface MiniSpawned {
  readonly child: ChildProcessWithoutNullStreams;
  send(message: unknown): void;
  nextLine(timeoutMs?: number): Promise<MiniLine>;
  stderrText(): string;
}

function spawnMinimal(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string
): MiniSpawned {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    cwd,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  let stdoutBuffer = "";
  let stderrBuffer = "";
  const backlog: MiniLine[] = [];
  const waiters: Array<(line: MiniLine) => void> = [];

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    let index: number;
    while ((index = stdoutBuffer.indexOf("\n")) !== -1) {
      const raw = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      const line: MiniLine = { raw, parsed };
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else backlog.push(line);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });

  return {
    child,
    send(message: unknown) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    nextLine(timeoutMs = 8000): Promise<MiniLine> {
      const buffered = backlog.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(onLine);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(
            new Error(
              `timed out after ${timeoutMs}ms waiting for a stdout line (stderr so far: ${stderrBuffer})`
            )
          );
        }, timeoutMs);
        function onLine(line: MiniLine): void {
          clearTimeout(timer);
          resolve(line);
        }
        waiters.push(onLine);
      });
    },
    stderrText: () => stderrBuffer,
  };
}

// ---------------------------------------------------------------------------
// One-time expensive setup, shared by every test below.
// ---------------------------------------------------------------------------

let tgzPath: string;
let tgzBuffer: Buffer;
let RECORDED_TGZ_SHA256: string;
let parsedTarball: ParsedTarball;

let primaryHome: string;
let primaryCache: string;
let primaryPrefix: string;
let primaryCwd: string;

let offlineHome: string;
let offlineCache: string;
let offlinePrefix: string;
let offlineCwd: string;

const scratchDirsToClean: string[] = [];

before(() => {
  const built = buildRealTarballOnce();
  tgzPath = built.tgzPath;
  tgzBuffer = built.buffer;
  RECORDED_TGZ_SHA256 = built.sha256;
  parsedTarball = parseTarballGzip(tgzBuffer);
  scratchDirsToClean.push(path.dirname(tgzPath));

  // --- primary clean-room install (network allowed; cache starts empty) ---
  primaryHome = freshDir("ghantika-cleanroom-home-");
  primaryCache = freshDir("ghantika-cleanroom-cache-");
  primaryPrefix = freshDir("ghantika-cleanroom-prefix-");
  primaryCwd = freshDir("ghantika-cleanroom-cwd-");
  scratchDirsToClean.push(primaryHome, primaryCache, primaryPrefix, primaryCwd);

  assert.deepEqual(
    readdirSync(primaryCache),
    [],
    "the primary clean-room's npm cache dir must start genuinely empty"
  );

  if (!WINDOWS_SKIP_REASON) {
    runGlobalInstall({
      prefix: primaryPrefix,
      cache: primaryCache,
      home: primaryHome,
      cwd: primaryCwd,
      tgzPath,
    });

    // --- offline clean-room install, seeded from the networked
    // install's own now-populated cache, with network access structurally
    // blocked (--offline plus a proxy pointed at a closed port) so this
    // install can only possibly succeed by resolving every dependency
    // from `offlineCache` alone. ---
    offlineHome = freshDir("ghantika-offline-home-");
    offlineCache = freshDir("ghantika-offline-cache-");
    offlinePrefix = freshDir("ghantika-offline-prefix-");
    offlineCwd = freshDir("ghantika-offline-cwd-");
    scratchDirsToClean.push(offlineHome, offlineCache, offlinePrefix, offlineCwd);

    cpSync(primaryCache, offlineCache, { recursive: true });
    runGlobalInstall({
      prefix: offlinePrefix,
      cache: offlineCache,
      home: offlineHome,
      cwd: offlineCwd,
      tgzPath,
      blockNetwork: true,
    });
  }
});

after(() => {
  for (const dir of scratchDirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The npm-pack-built artifact, clean-room install, npx resolution, provenance.
// ---------------------------------------------------------------------------

describe("a real npm-pack tarball, installed and resolved from an isolated prefix", () => {
  test("the recorded artifact is a real, non-dry .tgz whose bytes still match RECORDED_TGZ_SHA256 on a fresh read", () => {
    assert.ok(existsSync(tgzPath), `expected a real tarball at ${tgzPath}`);
    const rereadBuffer = readFileSync(tgzPath);
    const rereadSha256 = createHash("sha256").update(rereadBuffer).digest("hex");
    assert.equal(
      rereadSha256,
      RECORDED_TGZ_SHA256,
      "re-reading the tarball from disk must reproduce the exact sha256 recorded when it was built"
    );
  });

  test(
    "npx ghantika resolves and executes the binary FROM the ephemeral prefix - not the checkout, not a global install, not any inherited PATH",
    { skip: WINDOWS_SKIP_REASON },
    async () => {
      const env: NodeJS.ProcessEnv = {
        HOME: primaryHome,
        // Only the ephemeral prefix's own bin dir plus node's bin dir -
        // no inherited ambient PATH at all, so nothing but this install
        // could possibly satisfy `ghantika` on PATH.
        PATH: [path.join(primaryPrefix, "bin"), resolveNodeBinDir(), "/usr/bin", "/bin"].join(
          path.delimiter
        ),
        TMPDIR: os.tmpdir(),
        npm_config_cache: primaryCache,
        // REQUIRED for npx to recognize this custom --prefix location as
        // ITS global install root, rather than falling through to a
        // registry lookup for a real package also named "ghantika" -
        // verified empirically: without this, npx hit
        // https://registry.npmjs.org/ghantika (a real, unrelated,
        // already-registered package name) and failed with "could not
        // determine executable to run". `--no-install` alone does NOT
        // prevent that metadata fetch - only recognizing the local
        // global root before ever consulting the registry does.
        npm_config_prefix: primaryPrefix,
      };

      const spawned = spawnMinimal(
        npxExecutablePath(),
        ["--no-install", "ghantika"],
        env,
        primaryCwd
      );
      try {
        // npx spawns a real child process running the resolved entry
        // (verified directly: this test's own `spawned.child.pid` is
        // `npm exec ghantika`, and its own real OS child's command line
        // is `/usr/bin/env node <resolved-bin-path>` - the shebang
        // interpreted literally rather than exec'd directly) - reading
        // THAT child's own OS-reported command line is what proves which
        // file is genuinely executing, independent of anything npx or
        // this package reports about itself. The resolved script is
        // always the LAST whitespace-separated token, regardless of
        // whether the OS reports a 2-token (`node <path>`) or 3-token
        // (`/usr/bin/env node <path>`) command line.
        const runnerPid = await waitForAChildPid(spawned.child.pid!);
        const commandLine = resolvedCommandLineOf(runnerPid);
        const tokens = commandLine.split(/\s+/).filter((token) => token.length > 0);
        const resolvedScriptPath = tokens[tokens.length - 1];
        assert.ok(
          resolvedScriptPath,
          `could not parse a script path out of command line: ${JSON.stringify(commandLine)}`
        );
        const resolvedRealPath = realpathSync(resolvedScriptPath!);

        assert.equal(
          resolvedRealPath,
          realpathSync(installedEntryPath(primaryPrefix)),
          `npx ghantika must run the ephemeral prefix's own installed entry; actually ran: ${JSON.stringify(commandLine)}`
        );
        assert.notEqual(
          resolvedRealPath,
          realpathSync(CHECKOUT_ENTRY),
          "npx ghantika must not resolve to the checkout's own dist/index.js"
        );
        const systemGlobalPrefix = execFileSync(npmExecutablePath(), ["config", "get", "prefix"], {
          encoding: "utf8",
        }).trim();
        assert.ok(
          !resolvedRealPath.startsWith(`${realpathSync(systemGlobalPrefix)}${path.sep}`),
          "npx ghantika must not resolve to the host's own real global npm prefix"
        );

        // "executes", not merely "resolves": a real initialize round trip
        // over the real stdio wire, against the process just identified.
        spawned.send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "ghantika-pack-test", version: "0.0.0" },
          },
        });
        const response = await spawned.nextLine();
        const body = response.parsed as {
          result?: { serverInfo?: { name?: string; version?: string } };
        };
        assert.equal(body.result?.serverInfo?.name, PACKAGE_JSON.name);
        assert.equal(body.result?.serverInfo?.version, PACKAGE_JSON.version);
      } finally {
        spawned.child.stdin.end();
        spawned.child.kill("SIGKILL");
      }
    }
  );

  test(
    "a fresh readback of the installed provenance matches RECORDED_TGZ_SHA256, entry by entry",
    { skip: WINDOWS_SKIP_REASON },
    () => {
      // Every REGULAR file the recorded tarball contains must exist,
      // byte-for-byte identical, at the corresponding path inside the
      // installed prefix - proving the install chain (pack -> tarball on
      // disk -> `npm install --global`) delivered exactly what
      // RECORDED_TGZ_SHA256 names, never a substituted or drifted copy.
      // (`npm pack` cannot be re-run against an INSTALLED tree to compare
      // hashes directly - verified: it re-invokes this package's own
      // `prepack`/`build`/`tsc`, which is absent from an install that only
      // received "dependencies", not "devDependencies" - so content
      // comparison, not a second pack, is how this file establishes
      // "the installed provenance".)
      const regularFileEntries = parsedTarball.entries.filter(
        (entry) => entry.typeflag === "0" || entry.typeflag === "\0"
      );
      assert.ok(regularFileEntries.length > 0);
      for (const entry of regularFileEntries) {
        const relativePath = entry.path.replace(/^package\//, "");
        const installedPath = path.join(installedPackageRoot(primaryPrefix), relativePath);
        assert.ok(existsSync(installedPath), `expected ${entry.path} to exist at ${installedPath}`);
        const installedContent = readFileSync(installedPath);
        const tarballContent = readEntryContent(parsedTarball, entry);
        assert.ok(
          installedContent.equals(tarballContent),
          `installed ${relativePath} must be byte-identical to the tarball entry ${entry.path}`
        );
      }
    }
  );
});

// ---------------------------------------------------------------------------
// bin declaration, shebang, ESM type, POSIX mode, offline dependency closure.
// ---------------------------------------------------------------------------

describe("bin.ghantika is a compiled ESM entry, POSIX-executable, with an offline-resolvable dependency closure", () => {
  test("package.json declares bin.ghantika -> a compiled ESM entry with a real #!/usr/bin/env node shebang", () => {
    assert.equal(PACKAGE_JSON.type, "module", 'package.json must declare "type": "module"');
    assert.equal(PACKAGE_JSON.bin.ghantika, "dist/index.js");
    const source = readFileSync(CHECKOUT_ENTRY, "utf8");
    assert.equal(source.split("\n")[0], "#!/usr/bin/env node");
  });

  test("on POSIX the compiled entry is mode 0755 and directly executable; on every platform npm's own bin-shim mechanism is what makes it runnable without a node prefix", () => {
    if (process.platform === "win32") {
      // npm generates the `.cmd`/`.ps1` launcher shims for every "bin"
      // entry itself, on install, regardless of the target file's own
      // mode - a well-established, first-party npm mechanism this
      // package does not need to (and does not) implement itself. Not
      // independently exercised here: no runner in this repo's CI matrix
      // is `windows-latest` today (same disclosed gap
      // test/shutdown.test.ts's own `PGREP_ORACLE_SKIP` names).
      return;
    }
    const checkoutMode = statSync(CHECKOUT_ENTRY).mode & 0o777;
    assert.equal(
      checkoutMode,
      0o755,
      `expected the checkout's own compiled entry to be mode 0755, got ${checkoutMode.toString(8)}`
    );
    // The tarball's own recorded mode for this entry, and the mode it
    // still carries once actually installed - `npm pack` preserves
    // whatever mode a "bin" file has on disk rather than forcing it
    // (verified directly), so this is what makes 0755 an invariant of
    // the BUILD (scripts/mark-bin-executable.mjs, wired into the "build"
    // script) rather than an accident of this one checkout's state.
    const tarballEntry = parsedTarball.entries.find(
      (entry) => entry.path === "package/dist/index.js"
    );
    assert.ok(tarballEntry, "expected package/dist/index.js in the tarball");
    assert.equal(tarballEntry!.mode, 0o755);
    // Reached only past the win32 early-return above, so `primaryPrefix`
    // is guaranteed populated here (`before()` only skips the two real
    // installs when WINDOWS_SKIP_REASON is set).
    const installedMode = statSync(installedEntryPath(primaryPrefix)).mode & 0o777;
    assert.equal(installedMode, 0o755);
  });

  test(
    "the runtime dependency closure resolves and runs with NO network: an offline install (seeded cache, --offline, network structurally blocked) followed by an offline run produces no MODULE_NOT_FOUND",
    { skip: WINDOWS_SKIP_REASON },
    async () => {
      assert.ok(
        existsSync(path.join(installedPackageRoot(offlinePrefix), "node_modules")),
        "the offline install must have resolved its own dependency closure into its own node_modules"
      );

      const env: NodeJS.ProcessEnv = {
        HOME: offlineHome,
        PATH: [resolveNodeBinDir(), "/usr/bin", "/bin"].join(path.delimiter),
        TMPDIR: os.tmpdir(),
        // Network stays structurally blocked for the RUN too - the same
        // proof the install step used, now applied to actually starting
        // the server: nothing at startup can succeed by reaching out.
        HTTP_PROXY: "http://127.0.0.1:1/",
        HTTPS_PROXY: "http://127.0.0.1:1/",
      };
      const spawned = spawnMinimal(
        process.execPath,
        [installedEntryPath(offlinePrefix)],
        env,
        offlineCwd
      );
      try {
        spawned.send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "ghantika-pack-test-offline", version: "0.0.0" },
          },
        });
        const response = await spawned.nextLine();
        const body = response.parsed as {
          result?: { serverInfo?: { name?: string } };
          error?: unknown;
        };
        assert.equal(body.error, undefined, `expected no protocol error: ${JSON.stringify(body)}`);
        assert.equal(body.result?.serverInfo?.name, PACKAGE_JSON.name);
        assert.doesNotMatch(
          spawned.stderrText(),
          /MODULE_NOT_FOUND|Cannot find module/,
          `an offline-installed server must never fail to resolve its own dependency closure at startup: ${spawned.stderrText()}`
        );
      } finally {
        spawned.child.stdin.end();
        spawned.child.kill("SIGKILL");
      }
    }
  );
});

// ---------------------------------------------------------------------------
// The exact tarball whitelist, and zero shipped source maps.
// ---------------------------------------------------------------------------

describe("the tarball payload is an exact whitelist - dist/** + package.json + LICENSE + README only", () => {
  test('package.json\'s own "files" field declares exactly this whitelist', () => {
    assert.deepEqual(PACKAGE_JSON.files, ["dist", "!dist/**/*.map", "README.md", "LICENSE"]);
  });

  test("every packed entry lives under package/dist/, or is one of package.json/LICENSE/README.md - nothing from local/, test/, or .github/", () => {
    const allowedBareNames = new Set([
      "package/package.json",
      "package/LICENSE",
      "package/README.md",
    ]);
    const violations = parsedTarball.entries.filter(
      (entry) => !allowedBareNames.has(entry.path) && !entry.path.startsWith("package/dist/")
    );
    assert.deepEqual(
      violations.map((entry) => entry.path),
      [],
      "every tarball entry must be package.json, LICENSE, README.md, or under dist/"
    );
    for (const forbidden of ["local/", "test/", ".github/"]) {
      const leaked = parsedTarball.entries.filter((entry) => entry.path.includes(forbidden));
      assert.deepEqual(leaked, [], `no tarball entry may contain ${JSON.stringify(forbidden)}`);
    }
  });

  test("zero .map files ship - the source-map policy is frozen at zero, so there is no sourcesContent or internal source path to leak", () => {
    const mapEntries = findSourceMapEntries(parsedTarball.entries);
    assert.deepEqual(
      mapEntries.map((entry) => entry.path),
      [],
      "no .map file may appear in the tarball"
    );
  });
});

// ---------------------------------------------------------------------------
// Archive safety over the exact recorded tarball.
// ---------------------------------------------------------------------------

describe("archive safety over the exact recorded tarball", () => {
  test("every entry is a relative path under package/, with no .. traversal and no absolute path", () => {
    assert.deepEqual(findPathTraversalViolations(parsedTarball.entries), []);
    assert.deepEqual(findEntriesOutsidePackagePrefix(parsedTarball.entries), []);
  });

  test("no symlink or hardlink entries", () => {
    assert.deepEqual(findLinkEntries(parsedTarball.entries), []);
  });

  test("every entry's file mode is within {0644, 0755}", () => {
    const violations = findDisallowedModeEntries(parsedTarball.entries);
    assert.deepEqual(
      violations.map((entry) => ({ path: entry.path, mode: entry.mode.toString(8) })),
      []
    );
  });

  test("entry count and total unpacked size are bounded and recorded", () => {
    const entryCount = parsedTarball.entries.length;
    const totalUnpackedSize = parsedTarball.totalUnpackedSize;
    // Measured on the real artifact at authoring time: 45 entries,
    // ~1.27MB unpacked. Bounds below are a generous ceiling (this
    // package's compiled output growing modestly should never trip
    // them) rather than a tight pin - a real regression (an accidental
    // huge asset, or a whitelist regression reintroducing schema/config)
    // trips this long before either bound, and the exact numbers are
    // asserted into this test's own failure message either way.
    assert.ok(
      entryCount > 0 && entryCount <= 200,
      `entry count out of bounds: ${entryCount} (expected 1..200)`
    );
    assert.ok(
      totalUnpackedSize > 0 && totalUnpackedSize <= 10 * 1024 * 1024,
      `total unpacked size out of bounds: ${totalUnpackedSize} bytes (expected 1..${10 * 1024 * 1024})`
    );
  });
});

// ---------------------------------------------------------------------------
// The full stdio lifecycle against the INSTALLED binary, with reap
// confirmed by a real external oracle - never this codebase's own report.
// ---------------------------------------------------------------------------

describe("the installed binary completes a full stdio lifecycle and reaps every process it started", () => {
  before(requireSpawnPolicy);

  test(
    "initialize, tools/list, run, status/output/tail, kill, and shutdown - each live job's process group AND the server's own pid confirmed gone by a real external check with a deadline",
    { skip: WINDOWS_SKIP_REASON },
    async (t) => {
      const server: SpawnedServer = spawnServer([installedEntryPath(primaryPrefix)]);
      t.after(() => {
        if (!server.child.killed) server.child.kill("SIGKILL");
      });

      // --- initialize ---
      await completeHandshake(server);

      // --- tools/list ---
      server.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const toolsLine = await server.nextLine();
      const toolsBody = toolsLine.parsed as { result?: { tools?: Array<{ name: string }> } };
      const toolNames = new Set((toolsBody.result?.tools ?? []).map((tool) => tool.name));
      for (const expected of ["run", "status", "output", "tail", "kill", "list"]) {
        assert.ok(
          toolNames.has(expected),
          `expected tools/list to include "${expected}", got: ${[...toolNames]}`
        );
      }

      // --- run: a short job to exercise status/output/tail against ---
      const shortRunResult = await callTool(server, 3, "run", {
        command: "echo pack-test-a5-output",
        shell: true,
        label: "a5-short-job",
      });
      const shortJobId = (shortRunResult.result?.structuredContent as { job_id?: string })?.job_id;
      assert.equal(typeof shortJobId, "string");

      // --- status ---
      const statusResult = await callTool(server, 4, "status", { job_id: shortJobId });
      assert.equal(statusResult.error, undefined);
      assert.notEqual(statusResult.result?.isError, true);

      // --- output ---
      const outputResult = await callTool(server, 5, "output", { job_id: shortJobId });
      assert.equal(outputResult.error, undefined);
      assert.notEqual(outputResult.result?.isError, true);

      // --- tail ---
      const tailResult = await callTool(server, 6, "tail", { job_id: shortJobId });
      assert.equal(tailResult.error, undefined);
      assert.notEqual(tailResult.result?.isError, true);

      // --- run: a live, multi-process job that KILL will terminate,
      // confirmed via a real external pgrep both before and after. ---
      const killDir = makeTempDir();
      const killMarker = path.join(killDir, "kill-target-pgid.txt");
      const killRunResult = await callTool(server, 7, "run", {
        command: `echo $$ > '${killMarker}'; sleep 60 & sleep 60 & wait`,
        shell: true,
        label: "a5-kill-target",
      });
      const killJobId = (killRunResult.result?.structuredContent as { job_id?: string })?.job_id;
      assert.equal(typeof killJobId, "string");
      const killPgidText = await waitForFile(killMarker, { until: parsesAsPgid });
      const killPgid = Number(killPgidText.trim());
      const killBeforeMembers = await waitForPgrepGroupMembers(
        killPgid,
        (members) => members.length >= 3,
        3000
      );
      assert.ok(
        killBeforeMembers.length >= 3,
        `expected the kill-target job's real process group alive before kill(), pgrep saw: ${JSON.stringify(killBeforeMembers)}`
      );

      // --- kill (the tool) ---
      const killResult = await callTool(server, 8, "kill", { job_id: killJobId });
      assert.equal(killResult.error, undefined);
      assert.notEqual(
        killResult.result?.isError,
        true,
        `kill() must succeed: ${JSON.stringify(killResult)}`
      );
      const killAfterMembers = await waitForPgrepGroupMembers(
        killPgid,
        (members) => members.length === 0,
        5000
      );
      assert.deepEqual(
        killAfterMembers,
        [],
        `expected zero surviving process-group members after kill(), pgrep still saw: ${JSON.stringify(killAfterMembers)}`
      );

      // --- run: a SECOND live job, deliberately left alive - this is
      // what makes the upcoming shutdown reap check non-vacuous: it
      // proves shutdown's own cleanup path reaps a job nothing else ever
      // signaled, not merely a job that was already gone by the time
      // shutdown ran. ---
      const shutdownDir = makeTempDir();
      const shutdownMarker = path.join(shutdownDir, "shutdown-target-pgid.txt");
      const shutdownRunResult = await callTool(server, 9, "run", {
        command: `echo $$ > '${shutdownMarker}'; sleep 60 & sleep 60 & wait`,
        shell: true,
        label: "a5-shutdown-target",
      });
      assert.equal(shutdownRunResult.error, undefined);
      const shutdownPgidText = await waitForFile(shutdownMarker, { until: parsesAsPgid });
      const shutdownPgid = Number(shutdownPgidText.trim());
      const shutdownBeforeMembers = await waitForPgrepGroupMembers(
        shutdownPgid,
        (members) => members.length >= 3,
        3000
      );
      assert.ok(
        shutdownBeforeMembers.length >= 3,
        `expected the shutdown-target job's real process group alive before shutdown, pgrep saw: ${JSON.stringify(shutdownBeforeMembers)}`
      );

      const serverPid = server.child.pid!;

      // --- shutdown ---
      server.child.kill("SIGTERM");
      const { code, signal } = await server.waitForExit();
      assert.equal(code, 0, "the installed server's own SIGTERM handler must exit cleanly");
      assert.equal(signal, null);

      // Reap confirmation, external oracle, both halves of "the server
      // pid and every child are gone" - never trusting the server's own
      // report of having shut down cleanly:
      await waitForProcessGone(serverPid, 3000);
      const shutdownAfterMembers = await waitForPgrepGroupMembers(
        shutdownPgid,
        (members) => members.length === 0,
        5000
      );
      assert.deepEqual(
        shutdownAfterMembers,
        [],
        `expected zero surviving process-group members for the still-live job after shutdown, pgrep still saw: ${JSON.stringify(shutdownAfterMembers)} (server stderr: ${server.stderrText()})`
      );

      rmSync(killDir, { recursive: true, force: true });
      rmSync(shutdownDir, { recursive: true, force: true });
    }
  );
});
