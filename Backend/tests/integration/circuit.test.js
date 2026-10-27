import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createCircuitBreaker } from "../../src/gateway/circuitBreaker.js";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeKeys } from "../helpers/fakeKeys.js";
import { fakeRedis } from "../helpers/fakeRedis.js";
import { seedKey } from "../helpers/testKeys.js";
import { startMockProvider } from "../mockProvider.js";

// The circuit breaker end to end: real HTTP to the mock provider, the real gateway and a
// real breaker (on an in-memory Redis). With Gemini down, its circuit opens after 5
// failures, and from then on "fast" goes straight to Ollama.
let mock;
let app;
let authorization;

beforeAll(async () => {
  mock = await startMockProvider();
});

afterAll(async () => {
  await mock.close();
});

beforeEach(async () => {
  mock.reset();
  const keys = fakeKeys();
  ({ authorization } = await seedKey(keys));
  const redis = fakeRedis();
  const logger = captureLogs().logger;
  const gateway = createGateway({
    enabledProviders: new Set(["gemini", "ollama"]),
    providerSettings: {
      gemini: { apiKey: "mock-gemini-key", baseUrl: mock.url },
      ollama: { baseUrl: mock.url },
    },
    // Generous, so a busy machine never times out a normal mock answer (and falls back to
    // another provider mid-test). This suite isn't about timeouts.
    timeoutMs: 5000,
    breaker: createCircuitBreaker({ redis, logger }),
    // The backoff waits are tested elsewhere; here they would only slow things down.
    wait: async () => {},
  });
  app = createApp({ logger, gateway, keys, redis });
});

const chat = () =>
  request(app)
    .post("/v1/chat")
    .set("Authorization", authorization)
    .send({ model: "fast", messages: [{ role: "user", content: "Plan one day in Jaipur." }] });

const geminiCalls = () => mock.requests.filter((r) => r.provider === "gemini").length;

describe("circuit breaker end to end", () => {
  it("stops calling a provider that keeps failing, and the fallback answers at once", async () => {
    mock.behave("gemini", { type: "status", status: 503, body: {} });

    // Request 1: 3 Gemini attempts fail, then Ollama answers.
    const first = await chat();
    expect(first.body.provider).toBe("ollama");
    expect(geminiCalls()).toBe(3);

    // Request 2: 2 more failures make 5, which opens the circuit, so its third try is skipped.
    const second = await chat();
    expect(second.headers["x-llmux-attempts"]).toBe("3");
    expect(geminiCalls()).toBe(5);

    // Request 3: Gemini isn't called at all.
    const third = await chat();
    expect(third.body).toMatchObject({ provider: "ollama", fallbackUsed: true });
    expect(third.headers["x-llmux-attempts"]).toBe("1");
    expect(geminiCalls()).toBe(5);
  });

  it("keeps using a provider whose failures are the request's fault (400)", async () => {
    mock.behave("gemini", { type: "status", status: 400, body: {} });

    for (let i = 0; i < 6; i += 1) await chat();

    // Every request still reached Gemini: a 400 is never retried, and never trips the circuit.
    expect(geminiCalls()).toBe(6);
  });
});
