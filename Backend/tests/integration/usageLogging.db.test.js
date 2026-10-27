import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { redis } from "../../src/config/redis.js";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { createUsageRepository } from "../../src/modules/usage/usage.repository.js";
import { createUsageWriter } from "../../src/modules/usage/usageWriter.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { prisma, resetDatabase } from "../helpers/db.js";
import { realDependencies } from "../setup/testDatabase.js";
import { startMockProvider } from "../mockProvider.js";

// Usage logging end to end with nothing faked but the provider: a key created through the
// API, a chat through the real gateway, the real writer and repository, real Postgres.
describe.runIf(realDependencies)("usage logs written to real Postgres", () => {
  let mock;
  let app;
  let usage;
  let authorization;

  beforeAll(async () => {
    mock = await startMockProvider();
  });

  afterAll(async () => {
    await mock.close();
    await prisma.$disconnect();
    redis.disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
    mock.reset();
    usage = createUsageWriter({
      repository: createUsageRepository(prisma),
      logger: captureLogs().logger,
      flushIntervalMs: 60_000,
    });
    const gateway = createGateway({
      // One attempt per provider: this file checks what is stored, not the retries.
      maxRetries: 0,
      enabledProviders: new Set(["gemini", "ollama"]),
      providerSettings: {
        gemini: { apiKey: "mock-gemini-key", baseUrl: mock.url },
        ollama: { baseUrl: mock.url },
      },
    });
    app = createApp({ logger: captureLogs().logger, gateway, usage });

    const agent = request.agent(app);
    await agent
      .post("/api/auth/register")
      .send({ email: "asha@example.com", password: "correct horse", name: "Asha" });
    const key = await agent.post("/api/keys").send({ name: "trip-planner" });
    authorization = `Bearer ${key.body.apiKey}`;
  });

  const chat = (body) =>
    request(app)
      .post("/v1/chat")
      .set("Authorization", authorization)
      .send({ messages: [{ role: "user", content: "Plan one day in Jaipur." }], ...body });

  it("stores a JSON chat and a stream with their tokens, cost and timings", async () => {
    const json = await chat({ model: "fast", metadata: { app: "trip-planner" } });
    const sse = await chat({ model: "fast", stream: true });
    await usage.close();

    const rows = await prisma.usageLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      requestId: json.headers["x-request-id"],
      modelAlias: "fast",
      provider: "gemini",
      inputTokens: 10,
      outputTokens: 20,
      costMicroUsd: 53n,
      status: "success",
      transport: "http",
      streamed: false,
      timeToFirstTokenMs: null,
      metadata: { app: "trip-planner" },
    });
    expect(rows[1]).toMatchObject({
      requestId: sse.headers["x-request-id"],
      transport: "sse",
      streamed: true,
      costMicroUsd: 53n,
    });
    expect(rows[1].timeToFirstTokenMs).toBeGreaterThan(0);
    // Both rows belong to the key that made the requests.
    const key = await prisma.apiKey.findFirst();
    expect(rows.every((row) => row.apiKeyId === key.id)).toBe(true);
  });

  it("stores failed requests too", async () => {
    mock.behave("gemini", { type: "status", status: 503, body: {} });

    // A direct call has no fallback, so Gemini's own error is what gets stored.
    await chat({ model: "gemini:gemini-3.5-flash-lite" });
    await chat({ model: "fastest" });
    await usage.close();

    const rows = await prisma.usageLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((row) => [row.status, row.errorCode, row.provider])).toEqual([
      ["error", "PROVIDER_UNAVAILABLE", "gemini"],
      ["error", "UNKNOWN_MODEL", null],
    ]);
  });
});
