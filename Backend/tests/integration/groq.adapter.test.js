import { readFileSync } from "node:fs";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";
import { captureLogs } from "../helpers/captureLogs.js";

// A fake Groq that answers with the fixtures, so the adapter runs through the real gateway
// and HTTP client: build → HTTP → parse, stream, or map the error and fall back.
const fixture = (name) => readFileSync(new URL(`../fixtures/groq/${name}`, import.meta.url));

let server;
let baseUrl;
let requests;
let replies;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
      const reply = replies.length > 1 ? replies.shift() : replies[0];
      const type = reply.file.endsWith(".sse") ? "text/event-stream" : "application/json";
      res.writeHead(reply.status, { "content-type": type });
      res.end(fixture(reply.file));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function run(reply, fields = {}, { maxRetries = 0 } = {}) {
  requests = [];
  replies = Array.isArray(reply) ? [...reply] : [reply];
  const gateway = createGateway({
    enabledProviders: new Set(["groq"]),
    providerSettings: { groq: { apiKey: "gsk_test", baseUrl } },
    maxRetries,
    wait: async () => {},
  });
  const request = ChatRequestSchema.parse({
    model: "groq:openai/gpt-oss-20b",
    messages: [{ role: "user", content: "Plan one day in Jaipur." }],
    ...fields,
  });
  return { gateway, request, context: { requestId: "req_test", log: captureLogs().logger } };
}

describe("Groq through the gateway", () => {
  it("answers with the unified response and a cost from Groq's prices", async () => {
    const { gateway, request, context } = run({ file: "success.json", status: 200 });

    const { response } = await gateway.chat(request, context);

    expect(requests[0].url).toBe("/v1/chat/completions");
    expect(requests[0].headers.authorization).toBe("Bearer gsk_test");
    expect(requests[0].body.model).toBe("openai/gpt-oss-20b");
    expect(response).toMatchObject({
      provider: "groq",
      providerModel: "openai/gpt-oss-20b",
      content: "Morning: Amber Fort. Afternoon: City Palace.",
      usage: { inputTokens: 18, outputTokens: 56, totalTokens: 74 },
    });
    // 18 input tokens at $0.075/M and 56 output tokens at $0.30/M = 18.15 micro-dollars,
    // stored as a whole 18.
    expect(response.costUsd).toBe(0.000018);
  });

  it("streams, with usage from x_groq", async () => {
    const { gateway, request, context } = run(
      { file: "stream-usage-x-groq.sse", status: 200 },
      { stream: true },
    );

    const events = [];
    for await (const event of gateway.stream(request, context)) events.push(event);

    expect(requests[0].body).not.toHaveProperty("stream_options");
    expect(events.map((event) => event.type)).toEqual(["start", "delta", "delta", "end"]);
    expect(events.at(-1)).toMatchObject({ usage: { inputTokens: 12, outputTokens: 9 } });
    expect(events.at(-1)).not.toHaveProperty("usageEstimated");
  });

  it("estimates usage when a stream carries none", async () => {
    const { gateway, request, context } = run(
      { file: "stream-no-usage.sse", status: 200 },
      { stream: true },
    );

    const events = [];
    for await (const event of gateway.stream(request, context)) events.push(event);

    expect(events.at(-1)).toMatchObject({ type: "end", usageEstimated: true });
  });

  it("retries Groq's 498 (over capacity), then answers", async () => {
    const { gateway, request, context } = run(
      [
        { file: "error-capacity-498.json", status: 498 },
        { file: "success.json", status: 200 },
      ],
      {},
      { maxRetries: 1 },
    );

    const { response } = await gateway.chat(request, context);

    expect(requests).toHaveLength(2);
    expect(response.provider).toBe("groq");
  });

  it("answers the fast alias with Groq when Gemini and Ollama aren't configured", async () => {
    const { gateway, request, context } = run(
      { file: "success.json", status: 200 },
      { model: "fast" },
    );

    const { response } = await gateway.chat(request, context);

    expect(response).toMatchObject({ model: "fast", provider: "groq", fallbackUsed: false });
  });
});
