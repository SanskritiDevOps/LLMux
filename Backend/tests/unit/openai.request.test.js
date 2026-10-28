import { describe, expect, it } from "vitest";
import { OPENAI_DEFAULT_BASE_URL, buildOpenAIRequest } from "../../src/providers/openai/request.js";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";

const target = { provider: "openai", model: "gpt-6.1-sol" };
const context = { apiKey: "sk-test", maxTokens: 800 };
const unified = (fields) =>
  ChatRequestSchema.parse({
    model: "smart",
    messages: [{ role: "user", content: "Plan one day in Jaipur." }],
    ...fields,
  });

describe("buildOpenAIRequest", () => {
  it("builds a Chat Completions call with the system prompt first", () => {
    const req = buildOpenAIRequest(
      unified({
        system: "You are a helpful travel assistant.",
        temperature: 0.2,
        messages: [
          { role: "user", content: "Plan one day in Jaipur." },
          { role: "assistant", content: "Morning: Amber Fort." },
          { role: "user", content: "And the evening?" },
        ],
      }),
      target,
      context,
    );

    expect(req).toEqual({
      url: `${OPENAI_DEFAULT_BASE_URL}/v1/chat/completions`,
      method: "POST",
      headers: { authorization: "Bearer sk-test" },
      body: {
        model: "gpt-6.1-sol",
        messages: [
          { role: "system", content: "You are a helpful travel assistant." },
          { role: "user", content: "Plan one day in Jaipur." },
          { role: "assistant", content: "Morning: Amber Fort." },
          { role: "user", content: "And the evening?" },
        ],
        temperature: 0.2,
        max_completion_tokens: 800,
      },
    });
  });

  it("uses max_completion_tokens, never the deprecated max_tokens", () => {
    const { body } = buildOpenAIRequest(unified({}), target, context);

    expect(body.max_completion_tokens).toBe(800);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("asks for usage in the last chunk when streaming", () => {
    const { body, url } = buildOpenAIRequest(unified({ stream: true }), target, context);

    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(url).toBe(`${OPENAI_DEFAULT_BASE_URL}/v1/chat/completions`);
  });

  it("sends no stream fields for a normal request", () => {
    const { body } = buildOpenAIRequest(unified({}), target, context);

    expect(body).not.toHaveProperty("stream");
    expect(body).not.toHaveProperty("stream_options");
  });

  it("uses the default temperature when none is given", () => {
    expect(buildOpenAIRequest(unified({}), target, context).body.temperature).toBe(0.7);
  });

  it("puts the key in the Authorization header, never the URL or body", () => {
    const req = buildOpenAIRequest(unified({}), target, context);

    expect(req.headers.authorization).toBe("Bearer sk-test");
    expect(req.url).not.toContain("sk-test");
    expect(JSON.stringify(req.body)).not.toContain("sk-test");
  });

  it("honours a base URL override and trims its trailing slash", () => {
    const req = buildOpenAIRequest(unified({}), target, {
      ...context,
      baseUrl: "http://mock.test/",
    });

    expect(req.url).toBe("http://mock.test/v1/chat/completions");
  });

  it("never sends LLMux-only fields (metadata, cache)", () => {
    const { body } = buildOpenAIRequest(
      unified({ metadata: { app: "trip" }, cache: false }),
      target,
      context,
    );

    expect(Object.keys(body).sort()).toEqual([
      "max_completion_tokens",
      "messages",
      "model",
      "temperature",
    ]);
  });

  it("refuses to build a request without a key", () => {
    expect(() => buildOpenAIRequest(unified({}), target, { maxTokens: 10 })).toThrow(TypeError);
  });
});
