import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { redis } from "../../src/config/redis.js";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { createTokenBucket } from "../../src/modules/ratelimit/tokenBucket.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeKeys } from "../helpers/fakeKeys.js";
import { seedKey } from "../helpers/testKeys.js";
import { realDependencies } from "../setup/testDatabase.js";
import { startMockProvider } from "../mockProvider.js";

// The whole rate limit with the real Lua script in real Redis (database 1): /v1 requests
// through the app until the key's bucket is empty. Each run uses new keys, so new buckets.
describe.runIf(realDependencies)("rate limit with real Redis", () => {
  let mock;
  let app;
  let keys;
  const buckets = [];

  beforeAll(async () => {
    mock = await startMockProvider();
    keys = fakeKeys();
    const gateway = createGateway({
      enabledProviders: new Set(["ollama"]),
      providerSettings: { ollama: { baseUrl: mock.url } },
    });
    const limiter = createTokenBucket({ redis, logger: captureLogs().logger });
    app = createApp({ logger: captureLogs().logger, gateway, keys, redis, limiter });
  });

  afterAll(async () => {
    await mock.close();
    if (buckets.length > 0) await redis.del(...buckets);
    redis.disconnect();
  });

  it("allows a key's limit per minute, then answers 429 with Retry-After", async () => {
    const { authorization, row } = await seedKey(keys);
    await keys.update(row.id, row.userId, { rateLimitPerMin: 3 });
    buckets.push(`rl:key:${row.id}`);
    const chat = () =>
      request(app)
        .post("/v1/chat")
        .set("Authorization", authorization)
        .send({ model: "local", messages: [{ role: "user", content: "Hi" }] });

    const answers = [await chat(), await chat(), await chat()];
    const refused = await chat();

    expect(answers.map((res) => res.status)).toEqual([200, 200, 200]);
    expect(answers.map((res) => res.headers["x-ratelimit-remaining"])).toEqual(["2", "1", "0"]);
    expect(refused.status).toBe(429);
    // 3 per minute is one token every 20 s.
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(15);
    expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(20);
    expect(await redis.hget(`rl:key:${row.id}`, "tokens")).not.toBeNull();
  });
});
