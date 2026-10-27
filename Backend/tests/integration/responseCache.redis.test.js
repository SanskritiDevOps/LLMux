import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { redis } from "../../src/config/redis.js";
import { cacheKey } from "../../src/gateway/cacheKey.js";
import { createResponseCache } from "../../src/gateway/responseCache.js";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { realDependencies } from "../setup/testDatabase.js";

// The response cache's storage against real Redis (database 1). Each test uses its own
// made-up account, so its key is unique, and the keys are removed afterwards.
describe.runIf(realDependencies)("response cache against real Redis", () => {
  const written = [];
  const keyFor = () => {
    const request = ChatRequestSchema.parse({
      model: "fast",
      temperature: 0,
      messages: [{ role: "user", content: "Plan one day in Jaipur." }],
    });
    const key = cacheKey(request, { scope: `test-${randomUUID()}` });
    written.push(key);
    return key;
  };
  const cache = createResponseCache({ redis, logger: captureLogs().logger });

  afterAll(async () => {
    if (written.length > 0) await redis.del(...written);
    redis.disconnect();
  });

  it("stores an entry as JSON that expires after CACHE_TTL_SECONDS (1 hour)", async () => {
    const key = keyFor();
    const entry = { provider: "gemini", content: "Morning: Amber Fort.", costMicroUsd: 788 };

    await cache.set(key, entry);

    expect(await cache.get(key)).toEqual(entry);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(3590);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it("returns null for a key that was never stored", async () => {
    expect(await cache.get(keyFor())).toBeNull();
  });
});
