import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { redis } from "../../src/config/redis.js";
import { generateKey, hashKey } from "../../src/modules/keys/keyGenerator.js";
import { keyCacheKey } from "../../src/modules/keys/keys.service.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { prisma, resetDatabase } from "../helpers/db.js";
import { realDependencies } from "../setup/testDatabase.js";

// Gateway keys end to end with the real repositories, real Postgres (llmux_test) and real
// Redis (database 1, so dev data is untouched). Runs in CI and with TEST_REAL_DEPS=1.
describe.runIf(realDependencies)("gateway keys against real Postgres and Redis", () => {
  let app;

  beforeEach(async () => {
    await resetDatabase();
    app = createApp({ logger: captureLogs().logger, gateway: { chat: async () => ({}) } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });

  async function loggedIn(email = "asha@example.com") {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ email, password: "correct horse", name: "Asha" });
    return agent;
  }

  async function createKey(agent, name = "trip-planner") {
    const res = await agent.post("/api/keys").send({ name });
    return {
      apiKey: res.body.apiKey,
      key: res.body.key,
      authorization: `Bearer ${res.body.apiKey}`,
    };
  }

  const callV1 = (authorization) => {
    const req = request(app).get("/v1/models");
    return authorization ? req.set("Authorization", authorization) : req;
  };

  it("stores the SHA-256 hash and the 13-character prefix, never the key", async () => {
    const { apiKey, key } = await createKey(await loggedIn());

    const row = await prisma.apiKey.findUnique({ where: { id: key.id } });
    expect(row.keyHash).toBe(hashKey(apiKey));
    expect(row.keyPrefix).toBe(apiKey.slice(0, 13));
    expect(JSON.stringify(row)).not.toContain(apiKey);
  });

  it("accepts the key on /v1 and caches the lookup in Redis for 5 minutes", async () => {
    const { apiKey, authorization } = await createKey(await loggedIn());

    const res = await callV1(authorization);

    expect(res.status).toBe(200);
    const ttl = await redis.ttl(keyCacheKey(hashKey(apiKey)));
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it("records last_used_at after the key is used", async () => {
    const { key, authorization } = await createKey(await loggedIn());
    expect(key.lastUsedAt).toBeNull();

    await callV1(authorization);
    // last_used_at is written without blocking the request, so wait for it briefly.
    let row;
    for (let i = 0; i < 20 && !row?.lastUsedAt; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      row = await prisma.apiKey.findUnique({ where: { id: key.id } });
    }

    expect(row.lastUsedAt).toBeInstanceOf(Date);
  });

  it("rejects missing, malformed and unknown keys with 401 UNAUTHORIZED", async () => {
    for (const authorization of [undefined, "Bearer nope", `Bearer ${generateKey().key}`]) {
      const res = await callV1(authorization);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("rejects a key immediately after it is revoked, even though it was cached", async () => {
    const agent = await loggedIn();
    const { key, authorization } = await createKey(agent);
    expect((await callV1(authorization)).status).toBe(200);

    await agent.delete(`/api/keys/${key.id}`);
    const res = await callV1(authorization);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("KEY_REVOKED");
  });

  it("keeps a revoked key's row so its history survives", async () => {
    const agent = await loggedIn();
    const { key } = await createKey(agent);

    await agent.delete(`/api/keys/${key.id}`);

    const row = await prisma.apiKey.findUnique({ where: { id: key.id } });
    expect(row.revokedAt).toBeInstanceOf(Date);
  });

  it("applies a new rate limit at once by dropping the cached lookup", async () => {
    const agent = await loggedIn();
    const { apiKey, key, authorization } = await createKey(agent);
    await callV1(authorization);

    await agent.patch(`/api/keys/${key.id}`).send({ rateLimitPerMin: 5 });

    expect(await redis.get(keyCacheKey(hashKey(apiKey)))).toBeNull();
  });

  it("never lets one user see or change another user's keys", async () => {
    const asha = await loggedIn("asha@example.com");
    const ravi = await loggedIn("ravi@example.com");
    const { key, authorization } = await createKey(asha);

    const list = await ravi.get("/api/keys");
    const revoke = await ravi.delete(`/api/keys/${key.id}`);

    expect(list.body.keys).toEqual([]);
    expect(revoke.status).toBe(404);
    expect((await callV1(authorization)).status).toBe(200);
  });
});
