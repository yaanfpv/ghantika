/**
 * TEMPORARY DIAGNOSTIC - not for merge. On Windows, public CI's test job
 * never exits even though every test in the run reports pass or fail
 * normally, which means some file's process is left with an open handle
 * after its own tests finish. `node --test` runs each test file in its
 * own process, in parallel, so the culprit could be any file that spawns
 * a real child - this prints exactly what Node itself still considers
 * active at the end of THIS file's run, so the real leaked resource can
 * be read directly from a Windows CI log instead of guessed at.
 *
 * Two layers, deliberately: `getActiveResourcesInfo()` is the documented
 * public API and only names resource TYPES ("ChildProcess", "Pipe"), not
 * which one. `_getActiveHandles()` is undocumented and unstable across
 * Node versions, but it hands back the real handle objects, so a
 * ChildProcess handle's own `pid`/`killed`/`exitCode`/`signalCode` can be
 * read directly - the difference between "something is still open" and
 * "job X's child, pid Y, was never actually reaped".
 */

import { execFileSync } from "node:child_process";

/**
 * Whether the OS itself still considers `pid` alive AND still the same
 * command we spawned - independent of whether NODE's own ChildProcess
 * object has observed an exit event. `killed:true, exitCode:null` is
 * ambiguous on its own: it could mean a real live orphaned process, or it
 * could mean the OS process is genuinely gone (and possibly this exact
 * pid already recycled to something unrelated) with only Node's own
 * exit-event delivery not having caught up. This is the external,
 * ground-truth check that tells those apart - a bare "is this pid alive"
 * is not enough on its own (pid reuse is exactly the class of bug this
 * codebase's own checkProcessIdentity exists to guard against for the
 * product's real kill path), so this also confirms the live process's
 * command name still matches what we actually spawned.
 *
 * Deliberately NOT `ps`/`pgrep` on win32 - the predecessor project hit
 * exactly this (MSYS `ps` on a Windows runner does not behave like real
 * `ps`, and an ENOENT there can silently collapse into "nothing found").
 * `tasklist` is Windows' own native tool for this.
 */
function isPidExternallyAlive(
  pid: number,
  expectedCommand: string
): { alive: boolean | "unknown"; sameCommand: boolean | "unknown" } {
  try {
    if (process.platform === "win32") {
      const output = execFileSync("tasklist", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], {
        encoding: "utf8",
      });
      const alive = output.includes(String(pid));
      // tasklist's CSV image-name column is the first field, quoted.
      const imageName = output.split(",")[0]?.replace(/"/g, "") ?? "";
      return {
        alive,
        sameCommand: alive
          ? imageName.toLowerCase().includes(expectedCommand.toLowerCase())
          : false,
      };
    }
    const comm = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
    }).trim();
    return { alive: true, sameCommand: comm.toLowerCase().includes(expectedCommand.toLowerCase()) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number | null };
    if (typeof err.status === "number") return { alive: false, sameCommand: false }; // the tool ran and reported "not found"
    return { alive: "unknown", sameCommand: "unknown" }; // the tool itself could not run (e.g. ENOENT) - don't guess
  }
}

interface PossibleChildProcessHandle {
  readonly constructor: { readonly name: string };
  readonly pid?: unknown;
  readonly killed?: unknown;
  readonly exitCode?: unknown;
  readonly signalCode?: unknown;
  readonly spawnfile?: unknown;
  readonly spawnargs?: unknown;
  readonly connected?: unknown;
  readonly destroyed?: unknown;
  readonly _handle?: unknown;
}

function describeHandle(handle: unknown): Record<string, unknown> {
  const h = handle as PossibleChildProcessHandle;
  const constructorName = h?.constructor?.name ?? typeof handle;
  const description: Record<string, unknown> = { constructor: constructorName };
  for (const key of [
    "pid",
    "killed",
    "exitCode",
    "signalCode",
    "spawnfile",
    "spawnargs",
    "connected",
    "destroyed",
  ] as const) {
    if (h != null && key in h) description[key] = h[key];
  }
  // A Socket's own internal libuv handle (`_handle`) carries an `fd` that
  // identifies WHICH of a ChildProcess's three stdio pipes this is
  // (0=stdin/1=stdout/2=stderr) - the difference between "some pipe is
  // open" and "specifically stdout is still open on job X's child".
  const internalHandle = h?._handle as { fd?: unknown } | undefined;
  if (internalHandle != null && typeof internalHandle === "object" && "fd" in internalHandle) {
    description.fd = internalHandle.fd;
  }
  if (constructorName === "ChildProcess" && typeof h?.pid === "number") {
    const expectedCommand =
      typeof h.spawnfile === "string" ? (h.spawnfile.split(/[/\\]/).pop() ?? h.spawnfile) : "";
    const { alive, sameCommand } = isPidExternallyAlive(h.pid, expectedCommand);
    description.externallyAlive = alive;
    description.externallySameCommand = sameCommand;
  }
  return description;
}

export function logActiveResourcesAtFileEnd(fileLabel: string): void {
  const active =
    typeof process.getActiveResourcesInfo === "function"
      ? process.getActiveResourcesInfo()
      : ["process.getActiveResourcesInfo is not available on this Node version"];
  process.stderr.write(
    `[DIAGNOSTIC ${fileLabel} after-all] active resources at file end: ${JSON.stringify(active)}\n`
  );

  const getActiveHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })
    ._getActiveHandles;
  const handles =
    typeof getActiveHandles === "function"
      ? getActiveHandles.call(process).map(describeHandle)
      : ["process._getActiveHandles is not available on this Node version"];
  process.stderr.write(
    `[DIAGNOSTIC ${fileLabel} after-all] active handle detail at file end: ${JSON.stringify(handles)}\n`
  );
}
