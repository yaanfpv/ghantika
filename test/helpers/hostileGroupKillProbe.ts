/**
 * Standalone entry point for test/e2e-server.test.ts's hostile group-kill
 * exercise. Spawned as its own detached process group (see that test's own
 * comment on the spawnSync call), so a containment defect in spawnServer()
 * can only ever kill this probe process, never the process that launched
 * it. Not a `*.test.ts` file, so `node --test`'s auto-discovery never
 * tries to run it as a suite.
 */
import { execFileSync } from "node:child_process";
import { spawnServer } from "./spawnServer.ts";

async function waitForPgid(pid: number, timeoutMs = 3000, pollIntervalMs = 10): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return Number(
        execFileSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" }).trim()
      );
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

async function main(): Promise<void> {
  const server = spawnServer();
  const serverPid = server.child.pid!;
  const serverPgid = await waitForPgid(serverPid);
  const exitPromise = server.waitForExit();
  process.kill(-serverPgid, "SIGKILL");
  const { signal } = await exitPromise;
  const ownPgidAfter = await waitForPgid(process.pid);
  process.stdout.write(`${JSON.stringify({ serverSignal: signal, serverPgid, ownPgidAfter })}\n`);
}

main();
