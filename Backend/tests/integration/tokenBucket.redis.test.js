import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { redis } from "../../src/config/redis.js";
import { createTokenBucket } from "../../src/modules/ratelimit/tokenBucket.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeRedis } from "../helpers/fakeRedis.js";
import { realDependencies } from "../setup/testDatabase.js";

// The token bucket runs as a Lua script inside Redis, so it is tested against real Redis
// (database 1). Each test uses its own bucket key, removed afterwards.
describe.runIf(realDependencies)("token bucket against real Redis", () => {
  const used = [];
  const bucketKey = () => {
    const key = `rl:test:${randomUUID()}`;
    used.push(key);
    return key;
  };
  const bucket = createTokenBucket({ redis, logger: captureLogs().logger });

  afterAll(async () => {
    if (used.length > 0) await redis.del(...used);
    redis.disconnect();
  });

  it("starts full: allows a burst up to the limit, then refuses", async () => {
    const key = bucketKey();
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await bucket.take(key, { limit: 5 }));

    expect(results.map((result) => result.allowed)).toEqual([true, true, true, true, true, false]);
    expect(results.map((result) => result.remaining)).toEqual([4, 3, 2, 1, 0, 0]);
    expect(results[0]).toMatchObject({ limit: 5, retryAfterMs: 0 });
  });

  it("says how long until the next token: one minute divided by the limit", async () => {
    const key = bucketKey();
    for (let i = 0; i < 60; i += 1) await bucket.take(key, { limit: 60 });

    const refused = await bucket.take(key, { limit: 60 });

    expect(refused.allowed).toBe(false);
    // 60 per minute is 1 per second, so the next token is under a second away.
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it("refills over time, at the limit per minute", async () => {
    const key = bucketKey();
    // 60 per minute is 1 token per second. One request costing 60 empties the bucket.
    expect((await bucket.take(key, { limit: 60, cost: 60 })).allowed).toBe(true);
    expect((await bucket.take(key, { limit: 60 })).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const later = await bucket.take(key, { limit: 60 });
    expect(later.allowed).toBe(true);
    expect(later.remaining).toBe(0);
  });

  it("is atomic: 100 requests at once on a bucket of 10 let exactly 10 through", async () => {
    const key = bucketKey();
    // Separate clients, like separate LLMux instances, all racing for the same bucket.
    const clients = Array.from({ length: 4 }, () => redis.duplicate());
    try {
      const buckets = clients.map((client) => createTokenBucket({ redis: client }));
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) => buckets[i % 4].take(key, { limit: 10 })),
      );

      expect(results.filter((result) => result.allowed)).toHaveLength(10);
    } finally {
      for (const client of clients) client.disconnect();
    }
  });

  it("keeps buckets separate", async () => {
    const a = bucketKey();
    const b = bucketKey();
    for (let i = 0; i < 3; i += 1) await bucket.take(a, { limit: 3 });

    expect((await bucket.take(a, { limit: 3 })).allowed).toBe(false);
    expect((await bucket.take(b, { limit: 3 })).allowed).toBe(true);
  });

  it("lets an idle bucket expire, so Redis doesn't keep one per key forever", async () => {
    const key = bucketKey();
    await bucket.take(key, { limit: 60 });

    const ttl = await redis.pttl(key);
    // Full again after 60 s, plus a second: then it is the same as no bucket.
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(61_000);
  });
});

describe("token bucket when Redis can't run it", () => {
  it("allows every request rather than failing it", async () => {
    // The in-memory test Redis can't run Lua, which is the same as Redis being unreachable.
    const bucket = createTokenBucket({
      redis: fakeRedis({ failing: true }),
      logger: captureLogs().logger,
    });

    expect(await bucket.take("rl:key:x", { limit: 5 })).toEqual({
      allowed: true,
      limit: 5,
      remaining: 5,
      retryAfterMs: 0,
      unavailable: true,
    });
  });
});
