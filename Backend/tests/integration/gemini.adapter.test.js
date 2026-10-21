import { readFileSync } from "node:fs";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";
import { geminiAdapter } from "../../src/providers/gemini/index.js";
import { sendRequest } from "../../src/providers/httpClient.js";
import { providerRegistry } from "../../src/providers/index.js";

// A fake Gemini that records what it receives and answers with the fixtures, so the
// whole adapter (build → HTTP → parse / map error) runs exactly as it will in production.
const fixture = (name) =>
  readFileSync(new URL(`../fixtures/gemini/${name}.json`, import.meta.url), "utf8");

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
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(fixture(reply.fixture));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function call(fixtureName, status = 200) {
  reply = { fixture: fixtureName, status };
  const request = ChatRequestSchema.parse({
    model: "fast",
    system: "Be brief.",
    messages: [{ role: "user", content: "Plan one day in Jaipur." }],
  });
  const target = { provider: "gemini", model: "gemini-3.5-flash-lite" };

  const providerRequest = geminiAdapter.buildRequest(request, target, {
    maxTokens: 1024,
    apiKey: "test-key",
    baseUrl,
  });
  const response = await sendRequest(providerRequest, { provider: "gemini", timeoutMs: 2000 });
  return response.ok
    ? geminiAdapter.parseResponse(response.body)
    : geminiAdapter.mapError(response);
}

describe("Gemini adapter end to end against a fake Gemini", () => {
  it("sends a well-formed generateContent call and parses the answer", async () => {
    const result = await call("success");

    expect(lastRequest.url).toBe("/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(lastRequest.headers["x-goog-api-key"]).toBe("test-key");
    expect(lastRequest.body).toEqual({
      systemInstruction: { parts: [{ text: "Be brief." }] },
      contents: [{ role: "user", parts: [{ text: "Plan one day in Jaipur." }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
    });
    expect(result).toMatchObject({
      content: "Morning: Amber Fort. Afternoon: City Palace.",
      finishReason: "stop",
    });
  });

  it("turns a Gemini error response into a unified error", async () => {
    const error = await call("error-rate-limited-429", 429);

    expect(error).toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
      provider: "gemini",
      retryable: true,
    });
  });
});

describe("provider registry", () => {
  it("has the Gemini adapter registered", () => {
    expect(providerRegistry.get("gemini")).toBe(geminiAdapter);
    expect(providerRegistry.names()).toContain("gemini");
  });

  it("is a frozen, complete adapter", () => {
    expect(Object.isFrozen(geminiAdapter)).toBe(true);
    expect(geminiAdapter.defaultBaseUrl).toBe("https://generativelanguage.googleapis.com");
  });
});
