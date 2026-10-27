import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { ChatResponseSchema } from "../../src/gateway/schemas.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeKeys } from "../helpers/fakeKeys.js";
import { fakeRedis } from "../helpers/fakeRedis.js";
import { seedKey } from "../helpers/testKeys.js";
import { startMockProvider } from "../mockProvider.js";

// The whole request path with nothing faked except the provider itself:
// HTTP → validation → router → adapter → real HTTP client → mock provider → back.
let mock;
let app;
let logs;
// The gateway key every request below sends.
const keys = fakeKeys();
const { authorization } = await seedKey(keys);

beforeAll(async () => {
  mock = await startMockProvider();
});

afterAll(async () => {
  await mock.close();
});

beforeEach(() => {
  mock.reset();
  logs = captureLogs();
  const gateway = createGateway({
    enabledProviders: new Set(["gemini", "ollama"]),
    providerSettings: {
      gemini: { apiKey: "mock-gemini-key", baseUrl: mock.url },
      ollama: { baseUrl: mock.url },
    },
    // These tests are about one provider call; retries and fallback have their own suite
    // (fallback.test.js).
    maxRetries: 0,
    // Long enough that a normal mock answer never times out on a busy machine, short enough
    // that the hang test stays quick.
    timeoutMs: 1000,
  });
  app = createApp({ logger: logs.logger, gateway, keys, redis: fakeRedis() });
});

// A direct call has no fallback, so the provider's own error reaches the client.
const GEMINI_ONLY = "gemini:gemini-3.5-flash-lite";

const chat = (body) =>
  request(app)
    .post("/v1/chat")
    .set("Authorization", authorization)
    .send({ messages: [{ role: "user", content: "Plan one day in Jaipur." }], ...body });

describe("POST /v1/chat end to end", () => {
  it("answers through Gemini for the fast alias", async () => {
    mock.behave("gemini", { type: "ok", text: "Morning: Amber Fort." });

    const res = await chat({ model: "fast" });

    expect(res.status).toBe(200);
    expect(ChatResponseSchema.parse(res.body)).toMatchObject({
      id: res.headers["x-request-id"],
      model: "fast",
      provider: "gemini",
      providerModel: "gemini-3.5-flash-lite",
      content: "Morning: Amber Fort.",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      // 10 × $0.30/MTok + 20 × $2.50/MTok = 53 micro-dollars
      costUsd: 0.000053,
      cached: false,
      fallbackUsed: false,
    });

    const [sent] = mock.requests;
    expect(sent.path).toBe("/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(sent.headers["x-goog-api-key"]).toBe("mock-gemini-key");
    expect(sent.body.contents).toEqual([
      { role: "user", parts: [{ text: "Plan one day in Jaipur." }] },
    ]);
  });

  it("answers through Ollama for the local alias, at no cost", async () => {
    const res = await chat({ model: "local", system: "Be brief." });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      provider: "ollama",
      providerModel: "llama3.2:1b",
      costUsd: 0,
    });
    expect(mock.requests[0].body.messages[0]).toEqual({ role: "system", content: "Be brief." });
  });

  it("supports a direct provider:model call", async () => {
    const res = await chat({ model: "ollama:llama3.2:1b" });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe("ollama:llama3.2:1b");
  });

  it.each([
    [500, 502, "PROVIDER_ERROR", true],
    [401, 502, "PROVIDER_ERROR", false],
    [429, 503, "PROVIDER_RATE_LIMITED", true],
    [503, 503, "PROVIDER_UNAVAILABLE", true],
    [400, 400, "INVALID_REQUEST", false],
  ])("turns a provider %i into a %i %s", async (providerStatus, status, code, retryable) => {
    mock.behave("gemini", {
      type: "status",
      status: providerStatus,
      body: { error: { code: "internal", message: "secret upstream detail: db-7.internal" } },
    });

    const res = await chat({ model: GEMINI_ONLY });

    expect(res.status).toBe(status);
    expect(res.body.error).toMatchObject({ code, retryable, provider: "gemini" });
    expect(JSON.stringify(res.body)).not.toContain("db-7.internal");
  });

  it("logs the provider's error body for debugging", async () => {
    mock.behave("gemini", {
      type: "status",
      status: 500,
      body: { error: { message: "boom-detail" } },
    });

    await chat({ model: GEMINI_ONLY });

    const warning = logs.lines.find((line) => line.msg === "Provider returned an error");
    expect(warning.providerBody).toContain("boom-detail");
  });

  it("times out a provider that never answers with 504 TIMEOUT", async () => {
    mock.behave("gemini", { type: "hang" });

    const started = Date.now();
    const res = await chat({ model: GEMINI_ONLY });

    expect(res.status).toBe(504);
    expect(res.body.error).toMatchObject({ code: "TIMEOUT", provider: "gemini", retryable: true });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("reports a dropped connection as 503 PROVIDER_UNAVAILABLE", async () => {
    mock.behave("gemini", { type: "drop" });

    const res = await chat({ model: GEMINI_ONLY });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("cancels the provider call when the client disconnects", async () => {
    mock.behave("gemini", { type: "ok", delayMs: 1000 });

    await chat({ model: "fast" })
      .timeout(100)
      .catch(() => {});
    // Give the abort a moment to reach the mock provider.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mock.requests).toHaveLength(1);
    expect(mock.aborted).toBe(1);
  });

  it("rejects unknown models without calling any provider", async () => {
    const res = await chat({ model: "fastest" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNKNOWN_MODEL");
    expect(mock.requests).toHaveLength(0);
  });

  it("rejects invalid bodies without calling any provider", async () => {
    const res = await chat({ model: "fast", temperature: 9 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
    expect(mock.requests).toHaveLength(0);
  });
});
