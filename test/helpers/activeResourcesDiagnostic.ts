/**
 * TEMPORARY DIAGNOSTIC - not for merge. On Windows, public CI's test job
 * never exits even though every test in the run reports pass or fail
 * normally, which means some file's process is left with an open handle
 * after its own tests finish. `node --test` runs each test file in its
 * own process, in parallel, so the culprit could be any file that spawns
 * a real child - this prints exactly what Node itself still considers
 * active at the end of THIS file's run, so the real leaked resource can
 * be read directly from a Windows CI log instead of guessed at.
 */
export function logActiveResourcesAtFileEnd(fileLabel: string): void {
  const active =
    typeof process.getActiveResourcesInfo === "function"
      ? process.getActiveResourcesInfo()
      : ["process.getActiveResourcesInfo is not available on this Node version"];
  process.stderr.write(
    `[DIAGNOSTIC ${fileLabel} after-all] active resources at file end: ${JSON.stringify(active)}\n`
  );
}
