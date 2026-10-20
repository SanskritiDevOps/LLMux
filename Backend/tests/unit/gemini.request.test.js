import { describe, expect, it } from "vitest";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";
import { GEMINI_DEFAULT_BASE_URL, buildGeminiRequest } from "../../src/providers/gemini/request.js";

const target = { provider: "gemini", model: "gemini-3.5-flash-lite" };
const context = { maxTokens: 800, apiKey: "test-key" };

// Requests go through the real schema first, exactly as the gateway will pass them.
const unified = (body) =>
  ChatRequestSchema.parse({ model: "fast", messages: [{ role: "user", content: "Hi" }], ...body });

describe("buildGeminiRequest", () => {
  it("builds the README example as a generateContent call", () => {
    const req = buildGeminiRequest(
      unified({
        system: "You are a helpful travel assistant.",
        messages: [{ role: "user", content: "Plan one day in Jaipur." }],
        temperature: 0.7,
      }),
      target,
      context,
    );

    expect(req).toEqual({
      url: `${GEMINI_DEFAULT_BASE_URL}/v1beta/models/gemini-3.5-flash-lite:generateContent`,
      method: "POST",
      headers: { "x-goog-api-key": "test-key" },
      body: {
        systemInstruction: { parts: [{ text: "You are a helpful travel assistant." }] },
        contents: [{ role: "user", parts: [{ text: "Plan one day in Jaipur." }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 800 },
      },
    });
  });

  it("renames the assistant role to model and keeps turn order", () => {
    const req = buildGeminiRequest(
      unified({
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello!" },
          { role: "user", content: "Plan a trip" },
        ],
      }),
      target,
      context,
    );

    expect(req.body.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(req.body.contents[1].parts).toEqual([{ text: "Hello!" }]);
  });

  it("omits systemInstruction when there is no system prompt", () => {
    expect(buildGeminiRequest(unified({}), target, context).body).not.toHaveProperty(
      "systemInstruction",
    );
  });

  it("uses the already-capped maxTokens from the context, not the client's value", () => {
    const req = buildGeminiRequest(unified({ maxTokens: 50_000 }), target, {
      ...context,
      maxTokens: 8192,
    });

    expect(req.body.generationConfig.maxOutputTokens).toBe(8192);
  });

  it("sends the schema's default temperature when the client gave none", () => {
    expect(buildGeminiRequest(unified({}), target, context).body.generationConfig.temperature).toBe(
      0.7,
    );
  });

  it("uses streamGenerateContent with SSE for streaming requests", () => {
    const req = buildGeminiRequest(unified({ stream: true }), target, context);

    expect(req.url).toBe(
      `${GEMINI_DEFAULT_BASE_URL}/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse`,
    );
  });

  it("puts the API key in a header, never in the URL", () => {
    const req = buildGeminiRequest(unified({}), target, context);

    expect(req.url).not.toContain("test-key");
    expect(req.url).not.toContain("key=");
    expect(req.headers["x-goog-api-key"]).toBe("test-key");
  });

  it("honours a base URL override and strips trailing slashes", () => {
    const req = buildGeminiRequest(unified({}), target, {
      ...context,
      baseUrl: "http://127.0.0.1:9999///",
    });

    expect(req.url).toBe(
      "http://127.0.0.1:9999/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
  });

  it("URL-encodes the model name", () => {
    const req = buildGeminiRequest(
      unified({}),
      { provider: "gemini", model: "odd model/../x" },
      context,
    );

    expect(req.url).toContain("/models/odd%20model%2F..%2Fx:generateContent");
  });

  it("does not leak unified-only fields such as metadata or cache into the provider body", () => {
    const req = buildGeminiRequest(
      unified({ metadata: { app: "trip-planner" }, cache: false }),
      target,
      context,
    );

    expect(JSON.stringify(req.body)).not.toContain("trip-planner");
    expect(Object.keys(req.body).sort()).toEqual(["contents", "generationConfig"]);
  });

  it("refuses to build a request without an API key", () => {
    expect(() => buildGeminiRequest(unified({}), target, { maxTokens: 10 })).toThrow(/API key/);
  });
});
