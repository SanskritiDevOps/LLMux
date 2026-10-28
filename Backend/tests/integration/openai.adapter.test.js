import { readFileSync } from "node:fs";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";
import { captureLogs } from "../helpers/captureLogs.js";

// A fake OpenAI that answers with the fixtures, so the whole adapter runs through the real
// gateway and HTTP client: build → HTTP → parse, stream or map the error.
const fixture = (name) => readFileSync(new URL(`../fixtures/openai/${name}`, import.meta.url));

let server;
let baseUrl;
let lastRequest;
let reply;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
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

function run(file, status = 200, fields = {}) {
  reply = { file, status };
  const gw = createGateway({
    enabledProviders: new Set(["openai"]),
    providerSettings: { openai: { apiKey: "sk-test", baseUrl } },
    maxRetries: 0,
  });
  const request = ChatRequestSchema.parse({
    model: "openai:gpt-6.1-sol",
    system: "Be brief.",
    messages: [{ role: "user", content: "Plan one day in Jaipur." }],
    ...fields,
  });
  const context = { requestId: "req_test", log: captureLogs().logger };
  return { gw, request, context };
}

describe("OpenAI through the gateway", () => {
  it("sends a Chat Completions request and returns the unified answer with its cost", async () => {
    const { gw, request, context } = run("success.json");

    const { response } = await gw.chat(request, context);

    expect(lastRequest.url).toBe("/v1/chat/completions");
    expect(lastRequest.headers.authorization).toBe("Bearer sk-test");
    expect(lastRequest.body).toMatchObject({
      model: "gpt-6.1-sol",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Plan one day in Jaipur." },
      ],
    });
    expect(response).toMatchObject({
      provider: "openai",
      providerModel: "gpt-6.1-sol",
      content: "Morning: Amber Fort. Afternoon: City Palace.",
      finishReason: "stop",
      usage: { inputTokens: 42, outputTokens: 310, totalTokens: 352 },
    });
    expect(response.costUsd).toBeGreaterThan(0);
  });

  it("streams, asking for usage in the last chunk", async () => {
    const { gw, request, context } = run("stream-success.sse", 200, { stream: true });

    const events = [];
    for await (const event of gw.stream(request, context)) events.push(event);

    expect(lastRequest.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(events.map((event) => event.type)).toEqual(["start", "delta", "delta", "delta", "end"]);
    expect(events[0].provider).toBe("openai");
    expect(events.at(-1)).toMatchObject({
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 11, totalTokens: 23 },
    });
    expect(events.at(-1)).not.toHaveProperty("usageEstimated");
  });

  it("maps an error response, without OpenAI's own text", async () => {
    const { gw, request, context } = run("error-insufficient-quota-429.json", 429);

    const error = await gw.chat(request, context).catch((err) => err);

    expect(error).toMatchObject({ code: "PROVIDER_ERROR", provider: "openai", retryable: false });
    expect(error.message).toBe("openai account has no remaining credit");
  });

  it("answers the smart alias when OpenAI is the only provider of its chain with a key", async () => {
    const { gw, request, context } = run("success.json", 200, { model: "smart" });

    const { response } = await gw.chat(request, context);

    // smart is anthropic → openai → gemini. Providers without a key are left out of the
    // chain, so OpenAI is the first configured target: no fallback happened.
    expect(response).toMatchObject({ model: "smart", provider: "openai", fallbackUsed: false });
  });
});
