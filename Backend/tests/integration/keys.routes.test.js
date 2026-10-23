import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { hashKey } from "../../src/modules/keys/keyGenerator.js";
import { keyCacheKey } from "../../src/modules/keys/keys.service.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeKeys } from "../helpers/fakeKeys.js";
import { fakeRedis } from "../helpers/fakeRedis.js";
import { fakeUsers } from "../helpers/fakeUsers.js";

let keys;
let redis;
let app;
let logs;

beforeEach(() => {
  keys = fakeKeys();
  redis = fakeRedis();
  logs = captureLogs();
  app = createApp({
    logger: logs.logger,
    users: fakeUsers(),
    keys,
    redis,
    gateway: { chat: async () => ({}) },
  });
});

/** A logged-in browser: an agent that keeps the session cookie. */
async function loggedIn(email = "asha@example.com") {
  const agent = request.agent(app);
  await agent.post("/api/auth/register").send({ email, password: "correct horse", name: "Asha" });
  return agent;
}

describe("POST /api/keys", () => {
  it("creates a key and returns the full key exactly once", async () => {
    const agent = await loggedIn();

    const res = await agent.post("/api/keys").send({ name: "trip-planner-prod" });

    expect(res.status).toBe(201);
    expect(res.body.apiKey).toMatch(/^llmux_sk_[A-Za-z0-9_-]{43}$/);
    expect(res.body.key).toEqual({
      id: expect.any(String),
      name: "trip-planner-prod",
      prefix: res.body.apiKey.slice(0, 13),
      rateLimitPerMin: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: expect.any(String),
    });
  });

  it("stores only the SHA-256 hash and the prefix, never the key", async () => {
    const agent = await loggedIn();

    const { body } = await agent.post("/api/keys").send({ name: "k" });

    const [row] = keys.rows;
    expect(row.keyHash).toBe(hashKey(body.apiKey));
    expect(JSON.stringify(row)).not.toContain(body.apiKey);
  });

  it("accepts a custom rate limit", async () => {
    const agent = await loggedIn();

    const res = await agent.post("/api/keys").send({ name: "k", rateLimitPerMin: 120 });

    expect(res.body.key.rateLimitPerMin).toBe(120);
  });

  it.each([
    ["an empty name", { name: "  " }],
    ["a rate limit of 0", { name: "k", rateLimitPerMin: 0 }],
    ["a fractional rate limit", { name: "k", rateLimitPerMin: 1.5 }],
    ["an unknown field", { name: "k", keyHash: "abc" }],
  ])("rejects %s", async (_label, body) => {
    const agent = await loggedIn();

    const res = await agent.post("/api/keys").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
  });
});

describe("GET /api/keys", () => {
  it("lists my keys newest first, with prefixes but never the key or its hash", async () => {
    const agent = await loggedIn();
    const first = await agent.post("/api/keys").send({ name: "first" });
    await agent.post("/api/keys").send({ name: "second" });

    const res = await agent.get("/api/keys");

    expect(res.status).toBe(200);
    expect(res.body.keys.map((key) => key.name)).toEqual(["second", "first"]);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(first.body.apiKey);
    expect(raw).not.toContain(keys.rows[0].keyHash);
    expect(raw).not.toContain("keyHash");
  });

  it("never shows another user's keys", async () => {
    const asha = await loggedIn("asha@example.com");
    const ravi = await loggedIn("ravi@example.com");
    await asha.post("/api/keys").send({ name: "asha-key" });

    const res = await ravi.get("/api/keys");

    expect(res.body.keys).toEqual([]);
  });
});

describe("PATCH /api/keys/:id", () => {
  it("renames a key and changes or clears its rate limit", async () => {
    const agent = await loggedIn();
    const { body } = await agent.post("/api/keys").send({ name: "old", rateLimitPerMin: 60 });

    const renamed = await agent.patch(`/api/keys/${body.key.id}`).send({ name: "new" });
    const cleared = await agent.patch(`/api/keys/${body.key.id}`).send({ rateLimitPerMin: null });

    expect(renamed.body.key).toMatchObject({ name: "new", rateLimitPerMin: 60 });
    expect(cleared.body.key).toMatchObject({ name: "new", rateLimitPerMin: null });
  });

  it("drops the cached lookup so a new rate limit applies at once", async () => {
    const agent = await loggedIn();
    const { body } = await agent.post("/api/keys").send({ name: "k" });
    redis.store.set(keyCacheKey(hashKey(body.apiKey)), { value: "{}" });

    await agent.patch(`/api/keys/${body.key.id}`).send({ rateLimitPerMin: 10 });

    expect(redis.store.has(keyCacheKey(hashKey(body.apiKey)))).toBe(false);
  });

  it("requires at least one field", async () => {
    const agent = await loggedIn();
    const { body } = await agent.post("/api/keys").send({ name: "k" });

    expect((await agent.patch(`/api/keys/${body.key.id}`).send({})).status).toBe(400);
  });
});

describe("DELETE /api/keys/:id", () => {
  it("revokes the key (keeping the row) and clears its cached lookup", async () => {
    const agent = await loggedIn();
    const { body } = await agent.post("/api/keys").send({ name: "k" });
    const cacheKey = keyCacheKey(hashKey(body.apiKey));
    redis.store.set(cacheKey, { value: "{}" });

    const res = await agent.delete(`/api/keys/${body.key.id}`);

    expect(res.status).toBe(200);
    expect(res.body.key.revokedAt).toEqual(expect.any(String));
    expect(keys.rows).toHaveLength(1);
    expect(redis.store.has(cacheKey)).toBe(false);
  });

  it("is idempotent: revoking twice keeps the first revocation time", async () => {
    const agent = await loggedIn();
    const { body } = await agent.post("/api/keys").send({ name: "k" });

    const first = await agent.delete(`/api/keys/${body.key.id}`);
    const second = await agent.delete(`/api/keys/${body.key.id}`);

    expect(second.status).toBe(200);
    expect(second.body.key.revokedAt).toBe(first.body.key.revokedAt);
  });

  it("still revokes when Redis is down, and logs a warning", async () => {
    app = createApp({
      logger: logs.logger,
      users: fakeUsers(),
      keys,
      redis: fakeRedis({ failing: true }),
      gateway: { chat: async () => ({}) },
    });
    const agent = await loggedIn();
    const { body } = await agent.post("/api/keys").send({ name: "k" });

    const res = await agent.delete(`/api/keys/${body.key.id}`);

    expect(res.status).toBe(200);
    expect(keys.rows[0].revokedAt).toBeInstanceOf(Date);
    expect(logs.lines.some((line) => line.msg === "Could not clear the cached key lookup")).toBe(
      true,
    );
  });
});

describe("ownership and access", () => {
  it("returns 404, not 403, for another user's key, so its existence is not revealed", async () => {
    const asha = await loggedIn("asha@example.com");
    const ravi = await loggedIn("ravi@example.com");
    const { body } = await asha.post("/api/keys").send({ name: "asha-key" });

    const rename = await ravi.patch(`/api/keys/${body.key.id}`).send({ name: "stolen" });
    const revoke = await ravi.delete(`/api/keys/${body.key.id}`);

    for (const res of [rename, revoke]) {
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({ code: "NOT_FOUND", message: "Key not found" });
    }
    expect(keys.rows[0]).toMatchObject({ name: "asha-key", revokedAt: null });
  });

  it("rejects a malformed key ID before touching the database", async () => {
    const agent = await loggedIn();

    const res = await agent.delete("/api/keys/not-a-uuid");

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("id:");
  });

  it("requires a logged-in session", async () => {
    expect((await request(app).get("/api/keys")).status).toBe(401);
    expect((await request(app).post("/api/keys").send({ name: "k" })).status).toBe(401);
  });

  it("blocks key creation from another website", async () => {
    const agent = await loggedIn();

    const res = await agent
      .post("/api/keys")
      .set("Origin", "https://evil.example")
      .send({ name: "k" });

    expect(res.status).toBe(403);
    expect(keys.rows).toHaveLength(0);
  });
});
