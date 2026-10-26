import http from "node:http";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { createKeyLookup } from "../../src/modules/keys/keyLookup.js";
import { attachWebSocket } from "../../src/transports/websocket.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeKeys } from "../helpers/fakeKeys.js";
import { fakeRedis } from "../helpers/fakeRedis.js";
import { fakeUsage } from "../helpers/fakeUsage.js";
import { seedKey } from "../helpers/testKeys.js";
import { startMockProvider } from "../mockProvider.js";

// One usage row per chat, on every transport, and the X-LLMux-* headers: a real server with
// the WebSocket attached, the real gateway and recorder, and the mock provider. The usage
// writer is replaced by an in-memory one, so the rows can be checked exactly.
let mock;
let server;
let websocket;
let baseUrl;
let usage;
let apiKey;
let authorization;
let keyRow;

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
  ({ apiKey, authorization, row: keyRow } = await seedKey(keys));
  const redis = fakeRedis();
  const logger = captureLogs().logger;
  const gateway = createGateway({
    enabledProviders: new Set(["gemini", "ollama"]),
    providerSettings: {
      gemini: { apiKey: "mock-gemini-key", baseUrl: mock.url },
      ollama: { baseUrl: mock.url },
    },
    timeoutMs: 1000,
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

describe("usage rows for HTTP chats", () => {
  it("records a JSON chat with tokens, cost, latency and its request ID", async () => {
    mock.behave("gemini", { type: "ok", text: "Amber Fort." });

    const res = await chat({ model: "fast", metadata: { app: "trip-planner" } });

    const row = await usage.rowFor(res.headers["x-request-id"]);
    expect(row).toEqual({
      requestId: res.headers["x-request-id"],
      apiKeyId: keyRow.id,
      modelAlias: "fast",
      provider: "gemini",
      providerModel: "gemini-3.5-flash-lite",
      inputTokens: 10,
      outputTokens: 20,
      usageEstimated: false,
      // 10 × $0.30/MTok + 20 × $2.50/MTok = 53 micro-dollars
      costMicroUsd: 53,
      savedMicroUsd: 0,
      latencyMs: expect.any(Number),
      timeToFirstTokenMs: null,
      status: "success",
      errorCode: null,
      cached: false,
      fallbackUsed: false,
      attempts: 1,
      streamed: false,
      transport: "http",
      metadata: { app: "trip-planner" },
    });
    expect(usage.rows).toHaveLength(1);
  });

  it("records a provider error with its code and provider, at no cost", async () => {
    mock.behave("gemini", { type: "status", status: 429, body: { error: { code: 429 } } });

    const res = await chat({ model: "fast" });

    expect(res.status).toBe(503);
    expect(await usage.rowFor(res.headers["x-request-id"])).toMatchObject({
      status: "error",
      errorCode: "PROVIDER_RATE_LIMITED",
      provider: "gemini",
      inputTokens: 0,
      costMicroUsd: 0,
    });
  });

  it("records an unknown model with no provider", async () => {
    const res = await chat({ model: "fastest" });

    expect(await usage.rowFor(res.headers["x-request-id"])).toMatchObject({
      modelAlias: "fastest",
      provider: null,
      status: "error",
      errorCode: "UNKNOWN_MODEL",
    });
  });

  it("writes no row for a request rejected before the gateway (bad body or no key)", async () => {
    await chat({ model: "fast", temperature: 9 });
    await request(server).post("/v1/chat").send({ model: "fast" });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(usage.rows).toEqual([]);
  });

  it("records an SSE stream with time to first token", async () => {
    mock.behave("gemini", { type: "stream", chunks: ["Morning: ", "Amber Fort."], gapMs: 20 });

    const res = await chat({ model: "fast", stream: true });

    const row = await usage.rowFor(res.headers["x-request-id"]);
    expect(row).toMatchObject({
      status: "success",
      streamed: true,
      transport: "sse",
      inputTokens: 10,
      outputTokens: 20,
      usageEstimated: false,
      costMicroUsd: 53,
    });
    expect(row.timeToFirstTokenMs).toBeGreaterThan(0);
    expect(row.timeToFirstTokenMs).toBeLessThanOrEqual(row.latencyMs);
  });

  it("records a stream that fails part-way as an error, with its tokens estimated", async () => {
    // The mock's Gemini deltas carry no usageMetadata, so the tokens must be estimated.
    mock.behave("gemini", { type: "stream", chunks: ["Morning: Amber Fort, "], then: "drop" });

    const res = await chat({ model: "fast", stream: true });

    expect(await usage.rowFor(res.headers["x-request-id"])).toMatchObject({
      status: "error",
      errorCode: "PROVIDER_UNAVAILABLE",
      usageEstimated: true,
      // "Plan one day in Jaipur." = 23 chars → 6 tokens; 21 chars streamed → 6 tokens.
      inputTokens: 6,
      outputTokens: 6,
      costMicroUsd: 17,
    });
  });

  it("records a stream the client walked away from as cancelled", async () => {
    mock.behave("gemini", {
      type: "stream",
      chunks: Array.from({ length: 100 }, (_, i) => `w${i} `),
      gapMs: 50,
    });
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fast",
        stream: true,
        messages: [{ role: "user", content: "Hi" }],
      }),
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();

    expect(await usage.rowFor(res.headers.get("x-request-id"))).toMatchObject({
      status: "cancelled",
      errorCode: null,
      transport: "sse",
      usageEstimated: true,
    });
  });
});

describe("usage rows for WebSocket chats", () => {
  async function connect() {
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/v1/ws`);
    const messages = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ type: "auth", apiKey }));
    const wait = async (match) => {
      await expect.poll(() => messages.find(match), { timeout: 3000 }).toBeTruthy();
      return messages.find(match);
    };
    await wait((message) => message.type === "auth_ok");
    return { ws, messages, wait, send: (message) => ws.send(JSON.stringify(message)) };
  }

  const wsChat = (requestId, fields) => ({
    type: "chat",
    requestId,
    model: "local",
    messages: [{ role: "user", content: "Hi" }],
    ...fields,
  });

  it("records each chat under the server's request ID, with transport ws", async () => {
    mock.behave("ollama", { type: "stream", chunks: ["The Amber ", "Fort."] });
    const client = await connect();
    client.send(wsChat("c1"));

    const start = await client.wait((message) => message.type === "start");
    await client.wait((message) => message.type === "end");

    expect(await usage.rowFor(start.id)).toMatchObject({
      apiKeyId: keyRow.id,
      modelAlias: "local",
      provider: "ollama",
      status: "success",
      streamed: true,
      transport: "ws",
      inputTokens: 10,
      outputTokens: 20,
      costMicroUsd: 0,
      timeToFirstTokenMs: expect.any(Number),
    });
    client.ws.close();
  });

  it("records a cancelled chat and a failed one", async () => {
    mock.behave("gemini", {
      type: "stream",
      chunks: Array.from({ length: 100 }, (_, i) => `w${i} `),
      gapMs: 50,
    });
    const client = await connect();
    client.send(wsChat("slow", { model: "fast" }));
    client.send(wsChat("bad", { model: "fastest" }));
    const slow = await client.wait((m) => m.type === "start" && m.requestId === "slow");
    client.send({ type: "cancel", requestId: "slow" });
    await client.wait((m) => m.type === "cancelled");

    expect(await usage.rowFor(slow.id)).toMatchObject({ status: "cancelled", transport: "ws" });
    await expect
      .poll(() => usage.rows.find((row) => row.errorCode === "UNKNOWN_MODEL"))
      .toMatchObject({
        status: "error",
        transport: "ws",
        provider: null,
      });
    client.ws.close();
  });

  it("records chats cut off by shutdown before close() resolves", async () => {
    mock.behave("gemini", {
      type: "stream",
      chunks: Array.from({ length: 100 }, (_, i) => `w${i} `),
      gapMs: 50,
    });
    const client = await connect();
    client.send(wsChat("c1", { model: "fast" }));
    const start = await client.wait((m) => m.type === "delta");

    await websocket.close();

    // No waiting: the row must already be recorded when close() resolves.
    expect(
      usage.rows.find((row) => row.status === "cancelled" && row.transport === "ws"),
    ).toBeTruthy();
    expect(start).toBeTruthy();
  });
});

describe("response headers", () => {
  it("describes a JSON answer in X-Request-Id and X-LLMux-* headers", async () => {
    mock.behave("gemini", { type: "ok", text: "Amber Fort." });

    const res = await chat({ model: "fast" });

    expect(res.headers).toMatchObject({
      "x-request-id": res.body.id,
      "x-llmux-provider": "gemini",
      "x-llmux-provider-model": "gemini-3.5-flash-lite",
      "x-llmux-cache": "MISS",
      "x-llmux-attempts": "1",
      "x-llmux-fallback-used": "false",
      "x-llmux-latency-ms": String(res.body.latencyMs),
    });
  });

  it("names the provider on an SSE stream before the first token", async () => {
    mock.behave("ollama", { type: "stream", chunks: ["Amber"] });

    const res = await chat({ model: "local", stream: true });

    expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(res.headers).toMatchObject({ "x-llmux-provider": "ollama", "x-llmux-cache": "MISS" });
    expect(res.headers["x-request-id"]).toMatch(/^req_/);
  });

  it("keeps X-Request-Id on errors, without X-LLMux-* headers", async () => {
    const res = await chat({ model: "fastest" });

    expect(res.headers["x-request-id"]).toBe(res.body.error.requestId);
    expect(res.headers["x-llmux-provider"]).toBeUndefined();
  });

  it("reuses a client's own X-Request-Id, in the header and the usage row", async () => {
    const res = await chat({ model: "local" }).set("X-Request-Id", "trip-planner:day-1");

    expect(res.headers["x-request-id"]).toBe("trip-planner:day-1");
    expect((await usage.rowFor("trip-planner:day-1")).modelAlias).toBe("local");
  });

  it("lets the dashboard read the headers through CORS", async () => {
    const res = await chat({ model: "local" }).set("Origin", env.DASHBOARD_URL);

    const exposed = res.headers["access-control-expose-headers"].split(",");
    expect(exposed).toEqual(
      expect.arrayContaining([
        "X-Request-Id",
        "X-LLMux-Provider",
        "X-LLMux-Cache",
        "X-LLMux-Latency-Ms",
      ]),
    );
  });
});
