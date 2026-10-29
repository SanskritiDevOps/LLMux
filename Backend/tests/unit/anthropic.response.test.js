import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnthropicResponse } from "../../src/providers/anthropic/response.js";
import { GatewayError } from "../../src/utils/errors.js";

// Fixtures follow Anthropic's documented Messages format. No ANTHROPIC_API_KEY is set, so
// none are real recordings yet.
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/anthropic/${name}.json`, import.meta.url), "utf8"));

describe("parseAnthropicResponse", () => {
  it("joins the text blocks, skips thinking, and reads the finish reason and usage", () => {
    expect(parseAnthropicResponse(fixture("success"))).toEqual({
      content: "Morning: Amber Fort. Afternoon: City Palace.",
      finishReason: "stop",
      // 30 uncached + 12 read from Anthropic's prompt cache are all prompt tokens.
      usage: { inputTokens: 42, outputTokens: 240, totalTokens: 282 },
      usageEstimated: false,
    });
  });

  it("maps max_tokens to length", () => {
    expect(parseAnthropicResponse(fixture("max-tokens"))).toMatchObject({
      content: "Jaipur is the capital of",
      finishReason: "length",
    });
  });

  it("turns a refusal into an empty answer with content_filter, dropping the partial text", () => {
    expect(parseAnthropicResponse(fixture("refusal"))).toEqual({
      content: "",
      finishReason: "content_filter",
      usage: { inputTokens: 15, outputTokens: 4, totalTokens: 19 },
      usageEstimated: false,
    });
  });

  it("treats a tool call (not supported by the unified format) as error", () => {
    expect(parseAnthropicResponse(fixture("tool-use"))).toMatchObject({
      content: "",
      finishReason: "error",
    });
  });

  it.each([
    ["stop_sequence", "stop"],
    ["model_context_window_exceeded", "length"],
    ["pause_turn", "error"],
  ])("maps %s to %s", (stopReason, finishReason) => {
    const json = { ...fixture("success"), stop_reason: stopReason };

    expect(parseAnthropicResponse(json).finishReason).toBe(finishReason);
  });

  it("flags missing usage as estimated, with zero tokens", () => {
    const noUsage = fixture("success");
    delete noUsage.usage;

    expect(parseAnthropicResponse(noUsage)).toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      usageEstimated: true,
    });
  });

  it("treats a missing stop reason as stop", () => {
    const json = fixture("success");
    delete json.stop_reason;

    expect(parseAnthropicResponse(json).finishReason).toBe("stop");
  });

  it.each([
    ["null", null],
    ["a string", "hello"],
    ["no content", { stop_reason: "end_turn" }],
    ["content that isn't a list", { content: "hi" }],
    ["non-numeric usage", { content: [], usage: { input_tokens: "1" } }],
  ])("rejects %s as an unreadable response", (_label, json) => {
    let error;
    try {
      parseAnthropicResponse(json);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR", provider: "anthropic" });
  });
});
