import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ChatRequestSchema } from "../../src/gateway/schemas.js";
import { providerRegistry } from "../../src/providers/index.js";
import { ollamaAdapter } from "../../src/providers/ollama/index.js";
import { OLLAMA_DEFAULT_BASE_URL, buildOllamaRequest } from "../../src/providers/ollama/request.js";
import { mapOllamaError, parseOllamaResponse } from "../../src/providers/ollama/response.js";
import { GatewayError } from "../../src/utils/errors.js";

// Recorded from a real Ollama 0.40.6 running llama3.2:1b on 2026-10-21.
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/ollama/${name}.json`, import.meta.url), "utf8"));

const target = { provider: "ollama", model: "llama3.2:1b" };
const unified = (body) =>
  ChatRequestSchema.parse({ model: "local", messages: [{ role: "user", content: "Hi" }], ...body });

describe("buildOllamaRequest", () => {
  it("builds a non-streaming /api/chat call with the system prompt first", () => {
    const req = buildOllamaRequest(
      unified({
        system: "Answer in one short sentence.",
        messages: [
          { role: "user", content: "Name one fort in Jaipur." },
          { role: "assistant", content: "Amber Fort." },
          { role: "user", content: "Another?" },
        ],
        temperature: 0,
      }),
      target,
      { maxTokens: 60 },
    );

    expect(req).toEqual({
      url: `${OLLAMA_DEFAULT_BASE_URL}/api/chat`,
      method: "POST",
      headers: {},
      body: {
        model: "llama3.2:1b",
        stream: false,
        messages: [
          { role: "system", content: "Answer in one short sentence." },
          { role: "user", content: "Name one fort in Jaipur." },
          { role: "assistant", content: "Amber Fort." },
          { role: "user", content: "Another?" },
        ],
        options: { temperature: 0, num_predict: 60 },
      },
    });
  });

  it("always sends stream explicitly, because Ollama streams by default", () => {
    expect(buildOllamaRequest(unified({}), target, { maxTokens: 10 }).body.stream).toBe(false);
    expect(
      buildOllamaRequest(unified({ stream: true }), target, { maxTokens: 10 }).body.stream,
    ).toBe(true);
  });

  it("uses OLLAMA_BASE_URL when given and strips trailing slashes", () => {
    const req = buildOllamaRequest(unified({}), target, {
      maxTokens: 10,
      baseUrl: "http://gpu-box:11434/",
    });

    expect(req.url).toBe("http://gpu-box:11434/api/chat");
  });

  it("keeps the full model tag and sends no auth header", () => {
    const req = buildOllamaRequest(unified({}), target, { maxTokens: 10, apiKey: "ignored" });

    expect(req.body.model).toBe("llama3.2:1b");
    expect(req.headers).toEqual({});
  });

  it("does not send LLMux-only fields to Ollama", () => {
    const req = buildOllamaRequest(unified({ metadata: { app: "x" }, cache: false }), target, {
      maxTokens: 10,
    });

    expect(Object.keys(req.body).sort()).toEqual(["messages", "model", "options", "stream"]);
  });
});

describe("parseOllamaResponse (real recordings)", () => {
  it("parses a normal answer and its token counts", () => {
    expect(parseOllamaResponse(fixture("success"))).toEqual({
      content: "The Amber Fort is a famous fort in Jaipur.",
      finishReason: "stop",
      usage: { inputTokens: 39, outputTokens: 12, totalTokens: 51 },
      usageEstimated: false,
    });
  });

  it("maps done_reason length to length and keeps the partial text", () => {
    expect(parseOllamaResponse(fixture("length"))).toMatchObject({
      content: "Jaipur, also known",
      finishReason: "length",
      usage: { inputTokens: 31, outputTokens: 5, totalTokens: 36 },
    });
  });

  it("marks usage as estimated when Ollama omits a count", () => {
    const withoutPromptCount = fixture("success");
    delete withoutPromptCount.prompt_eval_count;

    expect(parseOllamaResponse(withoutPromptCount)).toMatchObject({
      usage: { inputTokens: 0, outputTokens: 12, totalTokens: 12 },
      usageEstimated: true,
    });
  });

  it("maps an unknown done_reason to error", () => {
    expect(parseOllamaResponse({ ...fixture("success"), done_reason: "unload" }).finishReason).toBe(
      "error",
    );
  });

  it.each([
    ["an unfinished (streaming) message", { ...fixture("success"), done: false }],
    ["a missing message", { done: true }],
    ["text instead of JSON", "Internal Server Error"],
    ["null", null],
  ])("rejects %s as an unreadable PROVIDER_ERROR", (_label, json) => {
    expect(() => parseOllamaResponse(json)).toThrow(GatewayError);
  });
});

describe("mapOllamaError (real recordings)", () => {
  it("turns a model that was never pulled into a non-retryable PROVIDER_ERROR with a hint", () => {
    const error = mapOllamaError({ status: 404, body: fixture("error-model-not-found-404") });

    expect(error).toMatchObject({ code: "PROVIDER_ERROR", provider: "ollama", retryable: false });
    expect(error.message).toContain("ollama pull");
  });

  it("turns a rejected request into INVALID_REQUEST without Ollama's Go error text", () => {
    const error = mapOllamaError({ status: 400, body: fixture("error-bad-request-400") });

    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).not.toContain("unmarshal");
  });

  it("treats a 500 as retryable", () => {
    expect(mapOllamaError({ status: 500, body: { error: "llama runner crashed" } })).toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: true,
    });
  });
});

describe("ollamaAdapter", () => {
  it("is registered", () => {
    expect(providerRegistry.get("ollama")).toBe(ollamaAdapter);
    expect(providerRegistry.names()).toEqual(["gemini", "ollama"]);
  });
});
