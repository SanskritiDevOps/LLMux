import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_BASE_URL,
  buildAnthropicRequest,
} from "../../src/providers/anthropic/request.js";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";

const target = { provider: "anthropic", model: "claude-sonnet-5-5" };
const context = { apiKey: "sk-ant-test", maxTokens: 800 };
const unified = (fields) =>
  ChatRequestSchema.parse({
    model: "smart",
    messages: [{ role: "user", content: "Plan one day in Jaipur." }],
    ...fields,
  });

describe("buildAnthropicRequest", () => {
  it("builds a Messages call with the system prompt as its own field", () => {
    const req = buildAnthropicRequest(
      unified({
        system: "You are a helpful travel assistant.",
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
      url: `${ANTHROPIC_DEFAULT_BASE_URL}/v1/messages`,
      method: "POST",
      headers: { "x-api-key": "sk-ant-test", "anthropic-version": "2026-10-21" },
      body: {
        model: "claude-sonnet-5-5",
        max_tokens: 800,
        system: "You are a helpful travel assistant.",
        messages: [
          { role: "user", content: "Plan one day in Jaipur." },
          { role: "assistant", content: "Morning: Amber Fort." },
          { role: "user", content: "And the evening?" },
        ],
      },
    });
  });

  it("always sends max_tokens, which Anthropic requires", () => {
    expect(buildAnthropicRequest(unified({}), target, context).body.max_tokens).toBe(800);
  });

  it("never sends temperature, which API version 2026-10-21 rejects", () => {
    const { body } = buildAnthropicRequest(unified({ temperature: 0.2 }), target, context);

    expect(ANTHROPIC_API_VERSION).toBe("2026-10-21");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
  });

  it("leaves system out when there is none", () => {
    expect(buildAnthropicRequest(unified({}), target, context).body).not.toHaveProperty("system");
  });

  it("asks for a stream only when streaming", () => {
    expect(buildAnthropicRequest(unified({ stream: true }), target, context).body.stream).toBe(
      true,
    );
    expect(buildAnthropicRequest(unified({}), target, context).body).not.toHaveProperty("stream");
  });

  it("puts the key in the x-api-key header, never the URL or body", () => {
    const req = buildAnthropicRequest(unified({}), target, context);

    expect(req.headers["x-api-key"]).toBe("sk-ant-test");
    expect(req.headers).not.toHaveProperty("authorization");
    expect(req.url).not.toContain("sk-ant-test");
    expect(JSON.stringify(req.body)).not.toContain("sk-ant-test");
  });

  it("honours a base URL override and trims its trailing slash", () => {
    const req = buildAnthropicRequest(unified({}), target, {
      ...context,
      baseUrl: "http://mock.test/",
    });

    expect(req.url).toBe("http://mock.test/v1/messages");
  });

  it("never sends LLMux-only fields (metadata, cache)", () => {
    const { body } = buildAnthropicRequest(
      unified({ metadata: { app: "trip" }, cache: false }),
      target,
      context,
    );

    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model"]);
  });

  it("refuses to build a request without a key", () => {
    expect(() => buildAnthropicRequest(unified({}), target, { maxTokens: 10 })).toThrow(TypeError);
  });
});
