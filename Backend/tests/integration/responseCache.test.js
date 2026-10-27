import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeKeys } from "../helpers/fakeKeys.js";
import { fakeRedis } from "../helpers/fakeRedis.js";
import { fakeUsage } from "../helpers/fakeUsage.js";
import { seedKey } from "../helpers/testKeys.js";
import { startMockProvider } from "../mockProvider.js";

// The response cache end to end: real HTTP to the mock provider, with the cache on an
// in-memory Redis. The mock's request log proves whether a provider was really called.
let mock;
let app;
let usage;
let keys;
let authorization;

beforeAll(async () => {
  mock = await startMockProvider();
});

afterAll(async () => {
  await mock.close();
});

beforeEach(async () => {
  mock.reset();
  usage = fakeUsage();
  keys = fakeKeys();
  ({ authorization } = await seedKey(keys));
  const gateway = createGateway({
    enabledProviders: new Set(["gemini", "ollama"]),
    providerSettings: {
      gemini: { apiKey: "mock-gemini-key", baseUrl: mock.url },
      ollama: { baseUrl: mock.url },
    },
    timeoutMs: 5000,
  });
  app = createApp({ logger: captureLogs().logger, gateway, keys, redis: fakeRedis(), usage });
});

const chat = (body, auth = authorization) =>
  request(app)
    .post("/v1/chat")
    .set("Authorization", auth)
    .send({
      model: "fast",
      temperature: 0,
      messages: [{ role: "user", content: "Plan one day in Jaipur." }],
      ...body,
    });

/** The cache write happens just after the response; give it a moment. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("response cache", () => {
  it("answers a repeated deterministic request from the cache, with X-LLMux-Cache: HIT", async () => {
    mock.behave("gemini", { type: "ok", text: "Morning: Amber Fort." });

    const first = await chat({});
    await settle();
    const second = await chat({});

    expect(mock.requests).toHaveLength(1);
    expect(first.headers["x-llmux-cache"]).toBe("MISS");
    expect(second.headers["x-llmux-cache"]).toBe("HIT");
    expect(second.headers["x-llmux-attempts"]).toBe("0");
    expect(second.body).toMatchObject({
      id: second.headers["x-request-id"],
      content: "Morning: Amber Fort.",
      provider: "gemini",
      cached: true,
      costUsd: 0,
    });
    expect(first.body.costUsd).toBeGreaterThan(0);
  });

  it("records the hit as free in the usage log, with the money it saved", async () => {
    mock.behave("gemini", { type: "ok", text: "Morning: Amber Fort." });

    const first = await chat({});
    await settle();
    const second = await chat({});

    expect(await usage.rowFor(first.headers["x-request-id"])).toMatchObject({
      cached: false,
      costMicroUsd: 53,
      savedMicroUsd: 0,
      attempts: 1,
    });
    expect(await usage.rowFor(second.headers["x-request-id"])).toMatchObject({
      cached: true,
      costMicroUsd: 0,
      // 10 × $0.30/MTok + 20 × $2.50/MTok: what the first answer cost.
      savedMicroUsd: 53,
      attempts: 0,
      provider: "gemini",
      inputTokens: 10,
      outputTokens: 20,
      status: "success",
    });
  });

  it("treats requests that differ only in spacing, metadata or field order as the same", async () => {
    await chat({ messages: [{ role: "user", content: "  Plan one day in Jaipur.  " }] });
    await settle();
    const second = await chat({ metadata: { app: "trip-planner" } });

    expect(second.headers["x-llmux-cache"]).toBe("HIT");
    expect(mock.requests).toHaveLength(1);
  });

  it("never caches the default temperature (0.7)", async () => {
    await chat({ temperature: undefined });
    await settle();
    const second = await chat({ temperature: undefined });

    expect(second.headers["x-llmux-cache"]).toBe("MISS");
    expect(mock.requests).toHaveLength(2);
  });

  it("skips the cache when the client sends cache: false", async () => {
    await chat({});
    await settle();
    const second = await chat({ cache: false });

    expect(second.headers["x-llmux-cache"]).toBe("MISS");
    expect(mock.requests).toHaveLength(2);
  });

  it("never serves one account's cached answer to another account", async () => {
    const other = await seedKey(keys);
    await chat({});
    await settle();

    const second = await chat({}, other.authorization);

    expect(second.headers["x-llmux-cache"]).toBe("MISS");
    expect(mock.requests).toHaveLength(2);
  });

  it("shares the cache between keys of the same account", async () => {
    const first = await seedKey(keys, { userId: "shared-user" });
    const second = await seedKey(keys, { userId: "shared-user" });
    await chat({}, first.authorization);
    await settle();

    const res = await chat({}, second.authorization);

    expect(res.headers["x-llmux-cache"]).toBe("HIT");
  });

  it("doesn't cache errors: the next request tries the provider again", async () => {
    mock.behave("gemini", [{ type: "status", status: 400, body: {} }, { type: "ok" }]);

    await chat({ model: "gemini:gemini-3.5-flash-lite" });
    await settle();
    const second = await chat({ model: "gemini:gemini-3.5-flash-lite" });

    expect(second.status).toBe(200);
    expect(second.headers["x-llmux-cache"]).toBe("MISS");
  });

  it("serves streams live, never from the cache", async () => {
    await chat({});
    await settle();
    const stream = await chat({ stream: true });

    expect(stream.headers["x-llmux-cache"]).toBe("MISS");
    expect(mock.requests).toHaveLength(2);
  });
});
