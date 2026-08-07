/**
 * The single `WakeTransport` contract every wake mechanism implements, and
 * the only file any caller needs to import to request a wake regardless of
 * which mechanism ends up serving it. No transport-specific symbol - a
 * socket path, an app-server subcommand, a harness backgrounding detail -
 * is permitted to appear outside its own transport module and that
 * module's own tests; `scripts/check-wake-transport-boundaries.mjs`
 * enforces this the same way `check-module-boundaries.mjs` enforces
 * `jobStore`'s single-writer boundary.
 *
 * NOT to be confused with `src/tasksAdapter.ts`'s own output-driven
 * wake-on-output-arrival mechanism (`notifications/ghantika/outputWake` -
 * ghantika's own, non-spec accelerator, exercised by
 * `test/wake-integration.test.ts`) or with the released Tasks extension's
 * own `notifications/tasks` per-transition status notification (the same
 * file, same test suite) - both are unrelated: either one tells an MCP
 * CLIENT its poll would now return new data, over this server's own
 * existing MCP connection. THIS module wakes an idle AGENT SESSION on the
 * host machine - a Codex thread or a backgrounded Claude Code turn - so it
 * resumes without a human re-invoking it. Same English word, unrelated
 * mechanisms, never conflated in code or prose.
 */

/**
 * The result of asking a transport whether it can currently serve a wake,
 * from something it actually checked THIS RUN - never a platform guess.
 * A transport must never report `available: true` because a mechanism is
 * plausible on this OS or in this harness. If a transport cannot determine
 * the answer, it returns `available: false` with a stated `reason` - never
 * `available: true` by default.
 */
export interface Capability {
  readonly available: boolean;
  /** Required when `available` is `false`. Human-readable, names what was checked and what it found. */
  readonly reason?: string;
  /** ISO-8601 instant this probe actually ran. Callers use this to judge staleness themselves - see the caching note below. */
  readonly probedAt: string;
}

/**
 * Three outcomes, never two, because "this will never work here" and
 * "this failed just now" have opposite remedies - the former means fall
 * back permanently, the latter means retry or fall through to the next
 * transport for this one attempt.
 */
export type WakeOutcome = "delivered" | "refused" | "unavailable";

export interface WakeResult {
  readonly outcome: WakeOutcome;
  /** Populated for "refused" and "unavailable"; optional but encouraged for "delivered" (e.g. which target/thread actually got it). */
  readonly detail?: string;
  /** Which transport produced this result - a future selection layer wires this into a retrievable record; this module only carries the field so a transport can report it. */
  readonly transportName: string;
}

/**
 * A single wake target. Deliberately opaque here - what identifies a
 * target (a thread id, a connection id, a process handle) is the concern
 * of each transport, not of this interface. A transport receives this
 * value from its own registration path, never synthesizes one.
 */
export type WakeTarget = string;

export interface WakeTransport {
  /** A stable, unique name for logs and for a future selection record. Never used for branching by any caller - see this file's header. */
  readonly name: string;

  /**
   * Checks whether this transport can currently serve a wake, via a real
   * observation (a socket connect, a subprocess handshake, an env var the
   * harness genuinely sets this run) - never inferred from platform or
   * harness identity alone.
   *
   * THE CALLER decides whether to cache this result and for
   * how long, if at all - `probe()` itself performs no caching and returns
   * a fresh observation on every call. The measured reason a transport
   * must not be assumed stable across a restart of the thing it probes:
   * the ChatGPT app's IPC socket path moved, and a locally-built feature
   * disappeared, inside a single app update on 2026-08-07. A caller that
   * does cache this result states its own cache lifetime explicitly and
   * justifies it against that kind of event, rather than caching
   * indefinitely because probing is expensive.
   */
  probe(): Promise<Capability>;

  /**
   * Attempts a wake. Must not be called before `probe()` has reported
   * `available: true` for this run - a transport is free to assume that
   * precondition and is not required to re-probe internally.
   */
  wake(target: WakeTarget, payload: string): Promise<WakeResult>;
}
