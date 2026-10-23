import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { generateKey } from "../../src/modules/keys/keyGenerator.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeKeys } from "../helpers/fakeKeys.js";
import { fakeRedis } from "../helpers/fakeRedis.js";
import { fakeUsers } from "../helpers/fakeUsers.js";
import { seedKey } from "../helpers/testKeys.js";

let keys;
let app;
let logs;
let gateway;

beforeEach(() => {
  keys = fakeKeys();
  logs = captureLogs();
  gateway = {
    chat: vi.fn(async (_request, { log }) => {
      log.info("inside chat");
      return { response: { ok: true }, meta: {} };
    }),
  };
  app = createApp({ logger: logs.logger, gateway, keys, redis: fakeRedis(), users: fakeUsers() });
});

const chatBody = { model: "fast", messages: [{ role: "user", content: "Hi" }] };

describe("gateway key auth on /v1", () => {
  it("lets a valid key through", async () => {
    const { authorization } = await seedKey(keys);

    const res = await request(app).get("/v1/models").set("Authorization", authorization);

    expect(res.status).toBe(200);
  });

  it("accepts the scheme in any case (bearer, Bearer)", async () => {
    const { apiKey } = await seedKey(keys);

    const res = await request(app).get("/v1/models").set("Authorization", `bearer ${apiKey}`);

    expect(res.status).toBe(200);
  });

  it("rejects a missing key with a hint about the header", async () => {
    const res = await request(app).post("/v1/chat").send(chatBody);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    expect(res.body.error.message).toContain("Authorization: Bearer");
    expect(gateway.chat).not.toHaveBeenCalled();
  });

  it.each([
    ["another scheme", "Basic dXNlcjpwYXNz"],
    ["a malformed key", "Bearer llmux_sk_short"],
    ["a well-formed key that does not exist", `Bearer ${generateKey().key}`],
  ])("rejects %s as an invalid key", async (_label, header) => {
    const res = await request(app).post("/v1/chat").set("Authorization", header).send(chatBody);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    expect(gateway.chat).not.toHaveBeenCalled();
  });

  it("gives the same message for malformed and unknown keys", async () => {
    const malformed = await request(app).get("/v1/models").set("Authorization", "Bearer x");
    const unknown = await request(app)
      .get("/v1/models")
      .set("Authorization", `Bearer ${generateKey().key}`);

    expect(malformed.body.error.message).toBe("Invalid gateway key");
    expect(unknown.body.error.message).toBe("Invalid gateway key");
  });

  it("rejects a revoked key with KEY_REVOKED", async () => {
    const { authorization, row } = await seedKey(keys);
    await keys.revoke(row.id, row.userId);

    const res = await request(app)
      .post("/v1/chat")
      .set("Authorization", authorization)
      .send(chatBody);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({
      code: "KEY_REVOKED",
      message: "This gateway key has been revoked",
    });
  });

  it("does not accept a dashboard session in place of a key", async () => {
    const agent = request.agent(app);
    await agent
      .post("/api/auth/register")
      .send({ email: "a@b.co", password: "correct horse", name: "A" });

    const res = await agent.get("/v1/models");

    expect(res.status).toBe(401);
  });

  it("tags handler logs with keyId and never logs the key", async () => {
    const { apiKey, authorization, row } = await seedKey(keys);

    await request(app).post("/v1/chat").set("Authorization", authorization).send(chatBody);

    const handlerLine = logs.lines.find((line) => line.msg === "inside chat");
    expect(handlerLine.keyId).toBe(row.id);
    expect(JSON.stringify(logs.lines)).not.toContain(apiKey);
  });

  it("works when Redis is down, by reading Postgres", async () => {
    app = createApp({
      logger: logs.logger,
      gateway,
      keys,
      redis: fakeRedis({ failing: true }),
      users: fakeUsers(),
    });
    const { authorization } = await seedKey(keys);

    const res = await request(app).get("/v1/models").set("Authorization", authorization);

    expect(res.status).toBe(200);
  });
});

describe("revocation takes effect at once", () => {
  it("rejects a key right after it is revoked, even though it was cached", async () => {
    const agent = request.agent(app);
    await agent
      .post("/api/auth/register")
      .send({ email: "asha@example.com", password: "correct horse", name: "Asha" });
    const created = await agent.post("/api/keys").send({ name: "k" });
    const authorization = `Bearer ${created.body.apiKey}`;

    const before = await request(app).get("/v1/models").set("Authorization", authorization);
    await agent.delete(`/api/keys/${created.body.key.id}`);
    const after = await request(app).get("/v1/models").set("Authorization", authorization);

    expect(before.status).toBe(200);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("KEY_REVOKED");
  });
});
