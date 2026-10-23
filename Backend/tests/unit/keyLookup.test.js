import { describe, expect, it, vi } from "vitest";
import { hashKey } from "../../src/modules/keys/keyGenerator.js";
import {
  KEY_CACHE_TTL_SECONDS,
  MISSING_KEY_CACHE_TTL_SECONDS,
  createKeyLookup,
} from "../../src/modules/keys/keyLookup.js";
import { keyCacheKey } from "../../src/modules/keys/keys.service.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeKeys } from "../helpers/fakeKeys.js";
import { fakeRedis } from "../helpers/fakeRedis.js";
import { seedKey } from "../helpers/testKeys.js";

async function setup({ redis = fakeRedis() } = {}) {
  const keys = fakeKeys();
  const seeded = await seedKey(keys, { userId: "user-1" });
  vi.spyOn(keys, "findByHash");
  vi.spyOn(keys, "touchLastUsed");
  const lookup = createKeyLookup({ keys, redis });
  return { keys, redis, lookup, seeded, hash: hashKey(seeded.apiKey) };
}

describe("createKeyLookup", () => {
  it("reads Postgres on a miss and caches the record for 5 minutes", async () => {
    const { lookup, keys, redis, seeded, hash } = await setup();

    const record = await lookup.find(hash);

    expect(record).toEqual({
      id: seeded.row.id,
      userId: "user-1",
      rateLimitPerMin: null,
      revoked: false,
    });
    expect(keys.findByHash).toHaveBeenCalledTimes(1);
    const entry = redis.store.get(keyCacheKey(hash));
    expect(entry.ttlSeconds).toBe(KEY_CACHE_TTL_SECONDS);
    expect(KEY_CACHE_TTL_SECONDS).toBe(300);
  });

  it("serves repeat lookups from Redis without touching Postgres", async () => {
    const { lookup, keys, hash } = await setup();

    await lookup.find(hash);
    const second = await lookup.find(hash);

    expect(second.userId).toBe("user-1");
    expect(keys.findByHash).toHaveBeenCalledTimes(1);
  });

  it("never caches the key itself or its hash inside the value", async () => {
    const { lookup, redis, seeded, hash } = await setup();

    await lookup.find(hash);

    const value = redis.store.get(keyCacheKey(hash)).value;
    expect(value).not.toContain(seeded.apiKey);
    expect(value).not.toContain(hash);
  });

  it("caches unknown keys briefly, so repeated wrong keys do not hit Postgres", async () => {
    const { lookup, keys, redis } = await setup();
    const unknown = hashKey("llmux_sk_unknown");

    expect(await lookup.find(unknown)).toBeNull();
    expect(await lookup.find(unknown)).toBeNull();

    expect(keys.findByHash).toHaveBeenCalledTimes(1);
    expect(redis.store.get(keyCacheKey(unknown)).ttlSeconds).toBe(MISSING_KEY_CACHE_TTL_SECONDS);
  });

  it("reports a revoked key as revoked", async () => {
    const { lookup, keys, seeded, hash } = await setup();
    await keys.revoke(seeded.row.id, "user-1");

    expect((await lookup.find(hash)).revoked).toBe(true);
  });

  it("falls back to Postgres when Redis is down, so keys keep working", async () => {
    const { lookup, keys, hash } = await setup({ redis: fakeRedis({ failing: true }) });

    const record = await lookup.find(hash);
    await lookup.find(hash);

    expect(record.userId).toBe("user-1");
    expect(keys.findByHash).toHaveBeenCalledTimes(2);
  });

  it("updates last_used_at on a miss when it is older than a minute", async () => {
    const { lookup, keys, seeded, hash } = await setup();

    await lookup.find(hash);

    expect(keys.touchLastUsed).toHaveBeenCalledWith(seeded.row.id);
  });

  it("does not update last_used_at again within a minute", async () => {
    const { lookup, keys, seeded, hash } = await setup();
    seeded.row.lastUsedAt = new Date(Date.now() - 10_000);

    await lookup.find(hash);

    expect(keys.touchLastUsed).not.toHaveBeenCalled();
  });

  it("does not update last_used_at for revoked keys", async () => {
    const { lookup, keys, seeded, hash } = await setup();
    await keys.revoke(seeded.row.id, "user-1");

    await lookup.find(hash);

    expect(keys.touchLastUsed).not.toHaveBeenCalled();
  });

  it("logs a failed last_used_at write instead of failing the request", async () => {
    const { lookup, keys, hash } = await setup();
    keys.touchLastUsed.mockRejectedValueOnce(new Error("db hiccup"));
    const logs = captureLogs();

    const record = await lookup.find(hash, { log: logs.logger });
    await new Promise((resolve) => setImmediate(resolve));

    expect(record).not.toBeNull();
    expect(logs.lines.some((line) => line.msg === "Could not update the key's last_used_at")).toBe(
      true,
    );
  });
});
