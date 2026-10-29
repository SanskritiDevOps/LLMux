import { readFileSync } from "node:fs";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";
import { captureLogs } from "../helpers/captureLogs.js";

// A fake Anthropic that answers with the fixtures, so the whole adapter runs through the
// real gateway and HTTP client: build → HTTP → parse, stream or map the error.
const fixture = (name) => readFileSync(new URL(`../fixtures/anthropic/${name}`, import.meta.url));

let server;
let baseUrl;
let lastRequest;
let replies;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
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
  replies = Array.isArray(reply) ? [...reply] : [reply];
  const gw = createGateway({
    enabledProviders: new Set(["anthropic"]),
    providerSettings: { anthropic: { apiKey: "sk-ant-test", baseUrl } },
    maxRetries,
    wait: async () => {},
  });
  const request = ChatRequestSchema.parse({
    model: "anthropic:claude-sonnet-5-5",
    system: "Be brief.",
    messages: [{ role: "user", content: "Plan one day in Jaipur." }],
    ...fields,
  });
  const context = { requestId: "req_test", log: captureLogs().logger };
  return { gw, request, context };
}

describe("Anthropic through the gateway", () => {
  it("sends a Messages request and returns the unified answer with its cost", async () => {
    const { gw, request, context } = run({ file: "success.json", status: 200 });

    const { response } = await gw.chat(request, context);

    expect(lastRequest.url).toBe("/v1/messages");
    expect(lastRequest.headers["x-api-key"]).toBe("sk-ant-test");
    expect(lastRequest.headers["anthropic-version"]).toBe("2026-10-21");
    expect(lastRequest.body).toMatchObject({
      model: "claude-sonnet-5-5",
      system: "Be brief.",
      messages: [{ role: "user", content: "Plan one day in Jaipur." }],
    });
    expect(lastRequest.body).not.toHaveProperty("temperature");
    expect(lastRequest.body.max_tokens).toBeGreaterThan(0);
    expect(response).toMatchObject({
      provider: "anthropic",
      providerModel: "claude-sonnet-5-5",
      content: "Morning: Amber Fort. Afternoon: City Palace.",
      finishReason: "stop",
      usage: { inputTokens: 42, outputTokens: 240, totalTokens: 282 },
    });
    expect(response.costUsd).toBeGreaterThan(0);
  });

  it("streams, combining input tokens from message_start with output from message_delta", async () => {
    const { gw, request, context } = run(
      { file: "stream-success.sse", status: 200 },
      {
        stream: true,
      },
    );

    const events = [];
    for await (const event of gw.stream(request, context)) events.push(event);

    expect(lastRequest.body.stream).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["start", "delta", "delta", "delta", "end"]);
    expect(events[0].provider).toBe("anthropic");
    expect(events.at(-1)).toMatchObject({
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 11, totalTokens: 23 },
    });
    expect(events.at(-1)).not.toHaveProperty("usageEstimated");
  });

  it("retries an overloaded (529) answer, then succeeds", async () => {
    const { gw, request, context } = run(
      [
        { file: "error-overloaded-529.json", status: 529 },
        { file: "success.json", status: 200 },
      ],
      {},
      { maxRetries: 1 },
    );

    const { response } = await gw.chat(request, context);

    expect(response).toMatchObject({ provider: "anthropic", finishReason: "stop" });
  });

  it("maps an error response, without Anthropic's own text", async () => {
    const { gw, request, context } = run({ file: "error-billing-402.json", status: 402 });

    const error = await gw.chat(request, context).catch((err) => err);

    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      provider: "anthropic",
      retryable: false,
    });
    expect(error.message).not.toContain("credit balance");
  });

  it("answers the smart alias as its primary target, with no fallback", async () => {
    const { gw, request, context } = run(
      { file: "success.json", status: 200 },
      {
        model: "smart",
      },
    );

    const { response } = await gw.chat(request, context);

    expect(response).toMatchObject({ model: "smart", provider: "anthropic", fallbackUsed: false });
  });
});
