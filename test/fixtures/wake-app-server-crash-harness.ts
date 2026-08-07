/**
 * A genuinely separate OS process, spawned by
 * `test/wake-app-server.test.ts`'s own `neverOrphansOnAHostCrash` test, to
 * prove `src/wake/appServerTransport.ts`'s per-instance `process.on("exit", ...)`
 * crash-safety net (see `AppServerGoalWakeTransport`'s own doc comment for
 * why it is scoped per instance rather than shared module-level state)
 * actually reaps a still-live, still-supervised child even
 * when the process that spawned it exits WITHOUT ever awaiting
 * `waitForBackgroundSupervisionForTests()` first - exactly what an
 * uncontrolled crash elsewhere in a real ghantika process would look like
 * from this transport's own point of view. Never imported by anything;
 * invoked directly as `node <this file> <fixture-path> <scenario-path>`.
 *
 * Not a `*.test.ts` file, so `node --test`'s auto-discovery never tries to
 * run it as a suite - the same convention `test/fixtures/negative-control-server.ts`
 * and `test/fixtures/mock-app-server.ts` already establish for a spawned
 * fixture/harness process.
 */
import { AppServerGoalWakeTransport } from "../../dist/wake/appServerTransport.js";

async function main(): Promise<void> {
  const fixturePath = process.argv[2];
  const scenarioPath = process.argv[3];
  if (fixturePath === undefined || scenarioPath === undefined) {
    process.stderr.write(
      "wake-app-server-crash-harness: expected <fixture-path> <scenario-path>\n"
    );
    process.exit(2);
  }

  const transport = new AppServerGoalWakeTransport({
    command: process.execPath,
    args: [fixturePath, scenarioPath],
  });

  const result = await transport.wake("thread-crash-harness", "keep working while I disappear");
  if (result.outcome !== "delivered") {
    process.stderr.write(
      `wake-app-server-crash-harness: expected outcome "delivered", got "${result.outcome}" (${result.detail ?? "no detail"})\n`
    );
    process.exit(1);
  }

  // Deliberately no await on waitForBackgroundSupervisionForTests() here -
  // this call is the whole point of this file. The child this wake() call
  // just spawned is still alive and still under this transport instance's
  // own background supervision; exiting right now, with zero cleanup, is
  // exactly what an uncontrolled crash looks like.
  process.exit(0);
}

void main();
