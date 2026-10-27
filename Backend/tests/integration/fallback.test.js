import http from "node:http";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../../src/app.js";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { createKeyLookup } from "../../src/modules/keys/keyLookup.js";
import { attachWebSocket } from "../../src/transports/websocket.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeKeys } from "../helpers/fakeKeys.js";
import { fakeRedis } from "../helpers/fakeRedis.js";
import { fakeUsage } from "../helpers/fakeUsage.js";
import { seedKey } from "../helpers/testKeys.js";
import { startMockProvider } from "../mockProvider.js";

// Retries and fallback end to end: real HTTP all the way to the mock provider, which can
// be scripted to fail and then recover. "fast" is gemini → ollama. The backoff waits are
// real but short (the README's 250 ms, then 500 ms), so a few of these tests take about a
// second.
let mock;
let server;
let websocket;
let baseUrl;
let usage;
let apiKey;
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
  const keys = fakeKeys();
  ({ apiKey, authorization } = await seedKey(keys));
  const redis = fakeRedis();
  const logger = captureLogs().logger;
  const gateway = createGateway({
    enabledProviders: new Set(["gemini", "ollama"]),
    providerSettings: {
      gemini: { apiKey: "mock-gemini-key", baseUrl: mock.url },
      ollama: { baseUrl: mock.url },
    },
    timeoutMs: 1000,
    maxRetries: 2,
  });
  server = http.createServer(createApp({ logger, gateway, keys, redis, usage }));
  websocket = attachWebSocket(server, {
    gateway,
    keyLookup: createKeyLookup({ keys, redis }),
    logger,
    usage,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await websocket.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await expect.poll(() => mock.open, { timeout: 3000 }).toBe(0);
});

const chat = (body) =>
  request(server)
    .post("/v1/chat")
    .set("Authorization", authorization)
    .send({ messages: [{ role: "user", content: "Plan one day in Jaipur." }], ...body });

const down = (status = 500) => ({ type: "status", status, body: { error: { message: "down" } } });
const providersCalled = () => mock.requests.map((request) => request.provider);

describe("JSON chats", () => {
  it("retries a provider that fails once, and says so in the headers and the usage row", async () => {
    mock.behave("gemini", [down(503), { type: "ok", text: "Amber Fort." }]);

    const res = await chat({ model: "fast" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      provider: "gemini",
      content: "Amber Fort.",
      fallbackUsed: false,
    });
    expect(res.headers).toMatchObject({
      "x-llmux-attempts": "2",
      "x-llmux-fallback-used": "false",
    });
    expect(providersCalled()).toEqual(["gemini", "gemini"]);
    expect(await usage.rowFor(res.headers["x-request-id"])).toMatchObject({
      status: "success",
      provider: "gemini",
      attempts: 2,
      fallbackUsed: false,
    });
  });

  it("falls back to Ollama when Gemini keeps failing", async () => {
    mock.behave("gemini", down(500));
    mock.behave("ollama", { type: "ok", text: "City Palace." });

    const res = await chat({ model: "fast" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      provider: "ollama",
      providerModel: "llama3.2:1b",
      content: "City Palace.",
      fallbackUsed: true,
      costUsd: 0,
    });
    expect(res.headers).toMatchObject({
      "x-llmux-provider": "ollama",
      "x-llmux-attempts": "4",
      "x-llmux-fallback-used": "true",
    });
    expect(providersCalled()).toEqual(["gemini", "gemini", "gemini", "ollama"]);
    expect(await usage.rowFor(res.headers["x-request-id"])).toMatchObject({
      provider: "ollama",
      attempts: 4,
      fallbackUsed: true,
      costMicroUsd: 0,
    });
  });

  it("falls back straight away when Gemini rejects the key", async () => {
    mock.behave("gemini", down(401));

    const res = await chat({ model: "fast" });

    expect(res.body.provider).toBe("ollama");
    expect(providersCalled()).toEqual(["gemini", "ollama"]);
  });

  it("falls back when Gemini times out, then answers within the deadline", async () => {
    mock.behave("gemini", { type: "hang" });

    const started = Date.now();
    const res = await chat({ model: "fast" });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("ollama");
    // 3 timeouts of 1 s each, with backoff in between, then Ollama.
    expect(Date.now() - started).toBeLessThan(10_000);
    // About 4 s normally; the timeout leaves room for a busy machine (Testing doc, timing rule).
  }, 15_000);

  it("does not fall back on a 400: Ollama is never asked", async () => {
    mock.behave("gemini", down(400));

    const res = await chat({ model: "fast" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "INVALID_REQUEST", provider: "gemini" });
    expect(providersCalled()).toEqual(["gemini"]);
  });

  it("returns the last provider's error, with every attempt counted, when all fail", async () => {
    mock.behave("gemini", down(500));
    mock.behave("ollama", down(503));

    const res = await chat({ model: "fast" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", provider: "ollama" });
    expect(await usage.rowFor(res.headers["x-request-id"])).toMatchObject({
      status: "error",
      errorCode: "PROVIDER_UNAVAILABLE",
      provider: "ollama",
      attempts: 6,
      fallbackUsed: true,
    });
  });

  it("honours a short Retry-After before retrying", async () => {
    mock.behave("gemini", [
      { type: "status", status: 429, headers: { "Retry-After": "1" }, body: {} },
      { type: "ok", text: "Amber Fort." },
    ]);

    const started = Date.now();
    const res = await chat({ model: "fast" });

    expect(res.body.provider).toBe("gemini");
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });
});

describe("SSE streams", () => {
  it("falls back before the first token: the client only ever sees Ollama", async () => {
    // Gemini accepts the stream, then the connection drops before any text.
    mock.behave("gemini", { type: "stream", chunks: [], then: "drop" });
    mock.behave("ollama", { type: "stream", chunks: ["City ", "Palace."] });

    const res = await chat({ model: "fast", stream: true });

    expect(res.status).toBe(200);
    expect(res.headers["x-llmux-provider"]).toBe("ollama");
    expect(res.text).toContain('"provider":"ollama"');
    expect(res.text).not.toContain("gemini");
    expect(res.text).toContain("event: end");
    expect(await usage.rowFor(res.headers["x-request-id"])).toMatchObject({
      transport: "sse",
      provider: "ollama",
      fallbackUsed: true,
      status: "success",
    });
  });

  it("does not fall back after the first token: the error follows the text", async () => {
    mock.behave("gemini", { type: "stream", chunks: ["Morning: "], then: "drop" });

    const res = await chat({ model: "fast", stream: true });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"text":"Morning: "');
    expect(res.text).toContain("event: error");
    expect(providersCalled()).toEqual(["gemini"]);
  });

  it("answers with a JSON error when every target fails before streaming", async () => {
    mock.behave("gemini", down(500));
    mock.behave("ollama", down(503));

    const res = await chat({ model: "fast", stream: true });

    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toContain("application/json");
  });
});

describe("WebSocket chats", () => {
  it("fall back before the first token like SSE", async () => {
    mock.behave("gemini", down(503));
    mock.behave("ollama", { type: "stream", chunks: ["City Palace."] });
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/v1/ws`);
    const messages = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ type: "auth", apiKey }));
    ws.send(
      JSON.stringify({
        type: "chat",
        requestId: "c1",
        model: "fast",
        messages: [{ role: "user", content: "Hi" }],
      }),
    );

    await expect.poll(() => messages.find((m) => m.type === "end"), { timeout: 5000 }).toBeTruthy();
    const start = messages.find((m) => m.type === "start");
    expect(start.provider).toBe("ollama");
    expect(await usage.rowFor(start.id)).toMatchObject({
      transport: "ws",
      attempts: 4,
      fallbackUsed: true,
    });
    ws.close();
  });
});
