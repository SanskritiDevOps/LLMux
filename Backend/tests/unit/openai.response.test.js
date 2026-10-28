import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOpenAIResponse } from "../../src/providers/openai/response.js";
import { GatewayError } from "../../src/utils/errors.js";

// Fixtures follow OpenAI's documented Chat Completions format. No OPENAI_API_KEY is set,
// so none are real recordings yet.
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/openai/${name}.json`, import.meta.url), "utf8"));

describe("parseOpenAIResponse", () => {
  it("reads the answer, finish reason and usage", () => {
    expect(parseOpenAIResponse(fixture("success"))).toEqual({
      content: "Morning: Amber Fort. Afternoon: City Palace.",
      finishReason: "stop",
      // completion_tokens already includes the 120 reasoning tokens, so they aren't added again.
      usage: { inputTokens: 42, outputTokens: 310, totalTokens: 352 },
      usageEstimated: false,
    });
  });

  it("maps length to length", () => {
    expect(parseOpenAIResponse(fixture("length"))).toMatchObject({
      content: "Jaipur is the capital of",
      finishReason: "length",
    });
  });

  it("maps content_filter to content_filter", () => {
    expect(parseOpenAIResponse(fixture("content-filter")).finishReason).toBe("content_filter");
  });

  it("turns a refusal into an empty answer with content_filter, not the refusal text", () => {
    expect(parseOpenAIResponse(fixture("refusal"))).toEqual({
      content: "",
      finishReason: "content_filter",
      usage: { inputTokens: 15, outputTokens: 9, totalTokens: 24 },
      usageEstimated: false,
    });
  });

  it("treats a tool call (not supported by the unified format) as error", () => {
    expect(parseOpenAIResponse(fixture("tool-calls"))).toMatchObject({
      content: "",
      finishReason: "error",
    });
  });

  it("flags missing usage as estimated, with zero tokens", () => {
    const noUsage = fixture("success");
    delete noUsage.usage;

    expect(parseOpenAIResponse(noUsage)).toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      usageEstimated: true,
    });
  });

  it("treats a missing finish reason as stop", () => {
    const json = fixture("success");
    delete json.choices[0].finish_reason;

    expect(parseOpenAIResponse(json).finishReason).toBe("stop");
  });

  it.each([
    ["null", null],
    ["a string", "hello"],
    ["no choices", { usage: { prompt_tokens: 1, completion_tokens: 1 } }],
    ["empty choices", { choices: [] }],
    ["a choice without a message", { choices: [{ finish_reason: "stop" }] }],
    [
      "non-numeric usage",
      { choices: [{ message: { content: "x" } }], usage: { prompt_tokens: "1" } },
    ],
  ])("rejects %s as an unreadable response", (_label, json) => {
    let error;
    try {
      parseOpenAIResponse(json);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR", provider: "openai" });
  });
});
