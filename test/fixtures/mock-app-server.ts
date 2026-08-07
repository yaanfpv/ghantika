/**
 * A scripted stand-in for the real `codex app-server` subcommand, speaking
 * the exact same newline-delimited JSON-RPC framing over its own stdio
 * (confirmed against the real binary while building
 * `src/wake/appServerTransport.ts` - one complete JSON object per line,
 * `\n`-terminated, no `Content-Length` header block) so
 * `test/wake-app-server.test.ts` can exercise that module's real
 * request/response/notification handling end to end without depending on
 * a real `codex` install, a real thread, or real model-provider quota.
 *
 * Selected via `process.argv[2]`: a path to a JSON scenario file (see
 * `MockAppServerScenario` below for its shape), written by the test that
 * spawns this file. Not a `*.test.ts` file, so `node --test`'s
 * auto-discovery never tries to run it as a suite - matches
 * `test/fixtures/negative-control-server.ts`'s own convention for a
 * spawned comparison/fixture process, and this repo's established
 * `spawn(process.execPath, [fixturePath, ...])` idiom for running a `.ts`
 * fixture directly (see `test/helpers/spawnServer.ts`'s `spawnServer()`).
 *
 * Handles exactly the three methods `AppServerGoalWakeTransport` actually
 * sends (`initialize`, `experimentalFeature/list`, `thread/goal/set`) plus
 * the two notifications it waits for (`turn/started`, `turn/completed`),
 * all driven by the scenario file rather than hardcoded, so one fixture
 * script covers every scenario this test suite needs (a healthy
 * handshake, a missing/disabled `"goals"` feature, a refused goal-set, a
 * goal-set that never produces a turn, a delivered wake whose turn
 * concludes quickly, and a delivered wake whose turn never concludes at
 * all - proving the wall-clock bound actually reaps it).
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

interface ExperimentalFeatureEntryFixture {
  readonly name: string;
  readonly stage: string;
  readonly enabled: boolean;
}

interface GoalSetOutcome {
  readonly kind: "success" | "error";
  readonly code?: number;
  readonly message?: string;
}

/**
 * What one run of this fixture does, in full. Every field is optional so a
 * test's scenario file states only what it needs to differ from the
 * healthy-path defaults below.
 */
interface MockAppServerScenario {
  /** Pages of `experimentalFeature/list` entries - one array per page, walked in order as `cursor` values `"page-1"`, `"page-2"`, ... are requested. Defaults to a single page containing a healthy, enabled `"goals"` entry. */
  readonly experimentalFeaturePages?: readonly (readonly ExperimentalFeatureEntryFixture[])[];
  /** When true, `initialize` never responds at all - proves the transport's own initialize timeout fires rather than hanging forever. */
  readonly hangInitialize?: boolean;
  /** Outcome for `thread/goal/set`. Defaults to `{ kind: "success" }`. */
  readonly goalSetOutcome?: GoalSetOutcome;
  /**
   * Milliseconds after `thread/goal/set`'s own response before emitting a
   * `turn/started` notification for the request's own `threadId`. `null`
   * means never emit one (proves the transport's own turn-start timeout
   * fires and maps to "refused"). A genuinely ABSENT key (as opposed to an
   * explicit `null`) resolves to this scenario's own default of `5` - JSON
   * has no way to represent "explicitly unset", so a scenario file that
   * wants "never emit" must write `null` explicitly rather than omitting
   * the field, since `JSON.stringify` drops an `undefined`-valued key
   * entirely and this fixture's own default-merge (see `loadScenario()`)
   * would then silently fall back to `5` instead.
   */
  readonly turnStartedDelayMs?: number | null;
  /** Same `null`-means-never-emit convention as `turnStartedDelayMs`, for the `turn/completed` notification that follows `turn/started`. Defaults to `10`. */
  readonly turnCompletedDelayMs?: number | null;
  /** Path this fixture appends one JSON line to for every request it receives (`{method, params}`), so a test can assert on exactly what bytes the transport actually sent - never inferred from what the fixture chooses to respond with. */
  readonly captureFile?: string;
  /** Path this fixture writes its own `process.pid` to, synchronously, before doing anything else - so a test can independently confirm, via a real OS-level liveness check, that the transport actually reaped this exact process rather than merely resolving its own promise. */
  readonly pidFile?: string;
}

function defaultScenario(): MockAppServerScenario {
  return {
    experimentalFeaturePages: [[{ name: "goals", stage: "stable", enabled: true }]],
    goalSetOutcome: { kind: "success" },
    turnStartedDelayMs: 5,
    turnCompletedDelayMs: 10,
  };
}

function loadScenario(): MockAppServerScenario {
  const scenarioPath = process.argv[2];
  if (scenarioPath === undefined) return defaultScenario();
  const raw = readFileSync(scenarioPath, "utf8");
  return { ...defaultScenario(), ...(JSON.parse(raw) as MockAppServerScenario) };
}

const scenario = loadScenario();

if (scenario.pidFile !== undefined) {
  writeFileSync(scenario.pidFile, String(process.pid));
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: number, result: unknown): void {
  send({ id, result });
}

function sendError(id: number, code: number, message: string): void {
  send({ id, error: { code, message } });
}

function sendNotification(method: string, params: unknown): void {
  send({ method, params, emittedAtMs: Date.now() });
}

function capture(method: string, params: unknown): void {
  if (scenario.captureFile === undefined) return;
  appendFileSync(scenario.captureFile, `${JSON.stringify({ method, params })}\n`);
}

const featurePages = scenario.experimentalFeaturePages ?? [];

function handleExperimentalFeatureList(id: number, params: unknown): void {
  const cursor = (params as { cursor?: unknown } | undefined)?.cursor;
  const pageIndex =
    typeof cursor === "string" ? Number.parseInt(cursor.replace("page-", ""), 10) : 0;
  const data = featurePages[pageIndex] ?? [];
  const isLastPage = pageIndex + 1 >= featurePages.length;
  sendResult(id, { data, nextCursor: isLastPage ? null : `page-${pageIndex + 1}` });
}

function handleThreadGoalSet(id: number, params: unknown): void {
  const outcome = scenario.goalSetOutcome ?? { kind: "success" };
  const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
  if (outcome.kind === "error") {
    sendError(
      id,
      outcome.code ?? -32600,
      outcome.message ?? "mock-app-server: scripted goal-set error"
    );
    return;
  }
  sendResult(id, {
    goal: {
      threadId,
      objective: (params as { objective?: unknown } | undefined)?.objective,
      status: "active",
      tokenBudget: (params as { tokenBudget?: unknown } | undefined)?.tokenBudget ?? null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    },
  });
  if (typeof scenario.turnStartedDelayMs !== "number") return;
  setTimeout(() => {
    sendNotification("turn/started", {
      threadId,
      turn: { id: "mock-turn-1", items: [], status: "inProgress" },
    });
    if (typeof scenario.turnCompletedDelayMs !== "number") return;
    setTimeout(() => {
      sendNotification("turn/completed", {
        threadId,
        turn: { id: "mock-turn-1", items: [], status: "completed" },
      });
    }, scenario.turnCompletedDelayMs);
  }, scenario.turnStartedDelayMs);
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const rawLine = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    if (rawLine.trim().length > 0) handleLine(rawLine);
    newlineIndex = buffer.indexOf("\n");
  }
});

function handleLine(rawLine: string): void {
  const message = JSON.parse(rawLine) as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof message.id !== "number" || typeof message.method !== "string") return;
  const { id, method, params } = message as { id: number; method: string; params: unknown };
  capture(method, params);

  if (method === "initialize") {
    if (scenario.hangInitialize === true) return;
    sendResult(id, {
      userAgent: "mock-app-server/0.0.0",
      codexHome: "/mock-codex-home",
      platformFamily: "unix",
      platformOs: "mock",
    });
    return;
  }
  if (method === "experimentalFeature/list") {
    handleExperimentalFeatureList(id, params);
    return;
  }
  if (method === "thread/goal/set") {
    handleThreadGoalSet(id, params);
    return;
  }
  sendError(id, -32601, `mock-app-server: no scripted handler for method "${method}"`);
}

process.stdin.resume();
