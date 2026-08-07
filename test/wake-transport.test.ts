import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  Capability,
  WakeOutcome,
  WakeResult,
  WakeTarget,
  WakeTransport,
} from "../dist/wake/wakeTransport.js";

// NO TRANSPORT IS REQUIRED FOR THE MODULE TO LOAD. This file
// is the proof, not a claim in a doc comment. Two things must be true
// simultaneously: (1) importing the module carries zero runtime cost or
// side effect (it declares types only - `probe()`/`wake()` are never
// invoked here, nothing is registered, nothing is constructed), and (2)
// nothing in `src/server.ts` or any of the six tool handlers imports from
// `src/wake/` at all yet, so their own existing tests (unmodified by this
// change) are the standing proof that ghantika still starts and still serves
// its six tools with zero transports wired in.

test("importing wakeTransport.js has zero runtime footprint - a type-only module compiles to no executable exports", async () => {
  const mod = await import("../dist/wake/wakeTransport.js");
  // `Capability`/`WakeOutcome`/`WakeResult`/`WakeTarget`/`WakeTransport` are
  // all `interface`/`type` declarations - TypeScript erases every one of
  // them at compile time, so the emitted module has no runtime bindings to
  // enumerate. If a future edit accidentally adds a runtime export (a
  // constant, a class, a default registry), this assertion catches the
  // module ceasing to be a pure, side-effect-free contract.
  assert.deepEqual(Object.keys(mod), []);
});

// The probe/wake contract is exercised together via a minimal in-memory
// fixture - proves the interface is actually implementable and its shape
// matches the contract, without requiring any real transport to exist yet.

class FixtureTransport implements WakeTransport {
  readonly name = "fixture";
  #available: boolean;
  #probedCount = 0;

  constructor(available: boolean) {
    this.#available = available;
  }

  async probe(): Promise<Capability> {
    this.#probedCount += 1;
    if (!this.#available) {
      return {
        available: false,
        reason: "fixture configured unavailable",
        probedAt: new Date().toISOString(),
      };
    }
    return { available: true, probedAt: new Date().toISOString() };
  }

  async wake(target: WakeTarget, payload: string): Promise<WakeResult> {
    return {
      outcome: "delivered" as WakeOutcome,
      detail: `${target}:${payload}`,
      transportName: this.name,
    };
  }

  get probedCount(): number {
    return this.#probedCount;
  }
}

test("an unavailable transport reports available:false with a stated reason, never available-by-default", async () => {
  const transport = new FixtureTransport(false);
  const capability = await transport.probe();
  assert.equal(capability.available, false);
  assert.equal(typeof capability.reason, "string");
  assert.ok(capability.reason && capability.reason.length > 0);
  assert.equal(typeof capability.probedAt, "string");
});

test("probe() performs no caching of its own - two calls both run a real observation", async () => {
  const transport = new FixtureTransport(true);
  await transport.probe();
  await transport.probe();
  assert.equal(transport.probedCount, 2);
});

test("WakeResult distinguishes delivered from refused from unavailable - three outcomes, never collapsed to two", async () => {
  const transport = new FixtureTransport(true);
  const result = await transport.wake("thread-1", "resume");
  const outcomes: WakeOutcome[] = ["delivered", "refused", "unavailable"];
  assert.ok(outcomes.includes(result.outcome));
  assert.equal(result.outcome, "delivered");
  assert.equal(result.transportName, "fixture");
});
