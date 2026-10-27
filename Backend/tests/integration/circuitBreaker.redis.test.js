import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { redis } from "../../src/config/redis.js";
import { STATES, createCircuitBreaker } from "../../src/gateway/circuitBreaker.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { realDependencies } from "../setup/testDatabase.js";

// The breaker against real Redis (database 1). Each test uses its own made-up provider
// name, so tests never see each other's circuits and nothing needs cleaning between them.
describe.runIf(realDependencies)("circuit breaker against real Redis", () => {
  const created = [];
  const provider = () => {
    const name = `test-${randomUUID()}`;
    created.push(name);
    return name;
  };
  const breaker = (options) =>
    createCircuitBreaker({ redis, logger: captureLogs().logger, ...options });

  afterAll(async () => {
    const keys = created.flatMap((name) =>
      ["failures", "open", "tripped", "probe"].map((part) => `cb:${name}:${part}`),
    );
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });

  it("opens after 5 failures, with real expiring keys", async () => {
    const name = provider();
    const cb = breaker();
    for (let i = 0; i < 5; i += 1) await cb.recordFailure(name, STATES.CLOSED);

    expect(await cb.allow(name)).toEqual({ allowed: false, state: "open" });
    const ttl = await redis.pttl(`cb:${name}:open`);
    expect(ttl).toBeGreaterThan(29_000);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });

  it("goes half-open when the open key expires, and closes after a good test request", async () => {
    const name = provider();
    const cb = breaker({ openMs: 200 });
    for (let i = 0; i < 5; i += 1) await cb.recordFailure(name, STATES.CLOSED);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const probe = await cb.allow(name);
    expect(probe).toEqual({ allowed: true, state: "half-open" });

    await cb.recordSuccess(name, probe.state);
    expect(await cb.allow(name)).toEqual({ allowed: true, state: "closed" });
  });

  it("lets exactly one of many simultaneous requests test the provider, across instances", async () => {
    const name = provider();
    const first = breaker({ openMs: 100 });
    for (let i = 0; i < 5; i += 1) await first.recordFailure(name, STATES.CLOSED);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Three "instances", each with its own breaker object, sharing one Redis.
    const instances = [first, breaker(), breaker()];
    const answers = await Promise.all(
      Array.from({ length: 30 }, (_, i) => instances[i % 3].allow(name)),
    );

    expect(answers.filter((answer) => answer.allowed)).toHaveLength(1);
    expect(answers.every((answer) => answer.state === "half-open")).toBe(true);
  });

  it("shares state between instances: one opens it, another sees it open", async () => {
    const name = provider();
    for (let i = 0; i < 5; i += 1) await breaker().recordFailure(name, STATES.CLOSED);

    expect((await breaker().allow(name)).state).toBe("open");
  });
});
