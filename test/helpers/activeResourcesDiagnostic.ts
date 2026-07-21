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
