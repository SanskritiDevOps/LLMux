import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { StreamEventSchema } from "../../src/gateway/schemas.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeKeys } from "../helpers/fakeKeys.js";
import { fakeRedis } from "../helpers/fakeRedis.js";
import { seedKey } from "../helpers/testKeys.js";
import { startMockProvider } from "../mockProvider.js";

// POST /v1/chat with stream: true, end to end: real HTTP client, stream reader, adapters
// and SSE writer, against the mock provider (which splits every event across two writes).
let mock;
let app;
let logs;
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
    // An idle limit between chunks: generous for normal streams, short for the stall test.
    timeoutMs: 1000,
  });
  app = createApp({ logger: logs.logger, gateway, keys, redis: fakeRedis() });
});

const body = (overrides) => ({
  stream: true,
  messages: [{ role: "user", content: "Plan one day in Jaipur." }],
  ...overrides,
});

const streamChat = (overrides) =>
  request(app).post("/v1/chat").set("Authorization", authorization).send(body(overrides));

/** Parses an SSE body into [{ type, ...data }], checking the wire format on the way. */
function parseSse(text) {
  return text
    .split("\n\n")
    .filter((block) => block !== "" && !block.startsWith(":"))
    .map((block) => {
      const [eventLine, dataLine, ...rest] = block.split("\n");
      expect(rest).toEqual([]);
      expect(eventLine).toMatch(/^event: \w+$/);
      expect(dataLine).toMatch(/^data: /);
      const event = { type: eventLine.slice("event: ".length), ...JSON.parse(dataLine.slice(6)) };
      return StreamEventSchema.parse(event);
    });
}

const textOf = (events) =>
  events
    .filter((event) => event.type === "delta")
    .map((event) => event.text)
    .join("");

describe("POST /v1/chat with stream: true", () => {
  it("streams a Gemini answer as SSE: start, deltas in order, end", async () => {
    mock.behave("gemini", { type: "stream", chunks: ["Morning: ", "Amber Fort, ", "then lunch."] });

    const res = await streamChat({ model: "fast" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-cache, no-transform");
    const events = parseSse(res.text);
    expect(events.map((event) => event.type)).toEqual(["start", "delta", "delta", "delta", "end"]);
    expect(events[0]).toEqual({
      type: "start",
      id: res.headers["x-request-id"],
      model: "fast",
      provider: "gemini",
    });
    expect(textOf(events)).toBe("Morning: Amber Fort, then lunch.");
    expect(events.at(-1)).toMatchObject({
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
    expect(mock.requests[0].path).toBe(
      "/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent",
    );
  });

  it("streams an Ollama answer for the local alias", async () => {
    mock.behave("ollama", { type: "ok", text: "The Amber Fort is in Jaipur." });

    const res = await streamChat({ model: "local" });

    const events = parseSse(res.text);
    expect(events[0].provider).toBe("ollama");
    expect(textOf(events)).toBe("The Amber Fort is in Jaipur.");
    expect(events.at(-1).type).toBe("end");
    expect(mock.requests[0].body.stream).toBe(true);
  });

  it("answers with a normal JSON error when the provider fails before streaming", async () => {
    mock.behave("gemini", { type: "status", status: 429, body: { error: { code: 429 } } });

    const res = await streamChat({ model: "fast" });

    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.error).toMatchObject({ code: "PROVIDER_RATE_LIMITED", provider: "gemini" });
  });

  it("still needs a gateway key", async () => {
    const res = await request(app)
      .post("/v1/chat")
      .send(body({ model: "fast" }));

    expect(res.status).toBe(401);
    expect(mock.requests).toHaveLength(0);
  });

  it("rejects unknown models with 400 before opening a stream", async () => {
    const res = await streamChat({ model: "fastest" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNKNOWN_MODEL");
  });

  it.each([
    ["the provider reports an error", "error", "PROVIDER_UNAVAILABLE"],
    ["the connection drops", "drop", "PROVIDER_UNAVAILABLE"],
    ["the stream ends without finishing", "end", "PROVIDER_ERROR"],
  ])("ends with an error event after the deltas when %s", async (_label, then, code) => {
    mock.behave("gemini", { type: "stream", chunks: ["Morning: ", "Amber"], then });

    const res = await streamChat({ model: "fast" });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events.map((event) => event.type)).toEqual(["start", "delta", "delta", "error"]);
    expect(events.at(-1)).toEqual({ type: "error", code, message: expect.any(String) });
  });

  it("ends with a TIMEOUT error event when the provider goes silent mid-stream", async () => {
    mock.behave("ollama", { type: "stream", chunks: ["Amber"], then: "stall" });

    const res = await streamChat({ model: "local" });

    const events = parseSse(res.text);
    expect(events.at(-1)).toEqual({
      type: "error",
      code: "TIMEOUT",
      message: "ollama went silent for 1000 ms",
    });
  });

  it("does not leak the provider's error text into the error event", async () => {
    mock.behave("ollama", { type: "stream", chunks: ["Amber"], then: "error" });

    const res = await streamChat({ model: "local" });

    expect(res.text).not.toContain("llama runner");
    expect(logs.lines.find((line) => line.msg === "Provider stream failed").providerBody).toContain(
      "llama runner",
    );
  });
});

describe("client disconnect", () => {
  let server;
  let baseUrl;

  beforeEach(async () => {
    server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("cancels the provider request when the client closes the stream", async () => {
    // A slow stream: far more chunks than the client will wait for.
    const chunks = Array.from({ length: 100 }, (_, i) => `word${i} `);
    mock.behave("gemini", { type: "stream", chunks, gapMs: 50 });
    const controller = new AbortController();

    const res = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body({ model: "fast" })),
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("event: delta")) {
      received += decoder.decode((await reader.read()).value, { stream: true });
    }
    controller.abort();

    await expect.poll(() => mock.aborted, { timeout: 3000 }).toBe(1);
    await expect
      .poll(() =>
        logs.lines.some((line) => line.msg === "Client disconnected; provider call cancelled"),
      )
      .toBe(true);
    // Cancelled long before the provider would have finished (100 chunks × 50 ms = 5 s).
    expect(received).not.toContain("event: end");
  });
});
