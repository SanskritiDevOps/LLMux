import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapGeminiError, parseGeminiResponse } from "../../src/providers/gemini/response.js";
import { GatewayError } from "../../src/utils/errors.js";

// Fixtures follow the documented Gemini response and error formats
// (ai.google.dev/api/generate-content, ai.google.dev/gemini-api/docs/api-errors).
// They are hand-written until a real GEMINI_API_KEY is available to record live ones.
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/gemini/${name}.json`, import.meta.url), "utf8"));

describe("parseGeminiResponse", () => {
  it("joins text parts and reads usage from a normal answer", () => {
    expect(parseGeminiResponse(fixture("success"))).toEqual({
      content: "Morning: Amber Fort. Afternoon: City Palace.",
      finishReason: "stop",
      usage: { inputTokens: 42, outputTokens: 310, totalTokens: 352 },
      usageEstimated: false,
    });
  });

  it("drops thought parts from the answer but bills thinking tokens as output", () => {
    const parsed = parseGeminiResponse(fixture("thinking"));

    expect(parsed.content).toBe("Start at Amber Fort.");
    expect(parsed.usage).toEqual({ inputTokens: 20, outputTokens: 45, totalTokens: 65 });
  });

  it("maps MAX_TOKENS to length and keeps the partial text", () => {
    expect(parseGeminiResponse(fixture("max-tokens"))).toMatchObject({
      content: "Morning: Amber Fort, then",
      finishReason: "length",
    });
  });

  it("reports a safety-blocked candidate as content_filter with no content", () => {
    expect(parseGeminiResponse(fixture("candidate-blocked"))).toMatchObject({
      content: "",
      finishReason: "content_filter",
      usage: { inputTokens: 12, outputTokens: 0, totalTokens: 12 },
    });
  });

  it("reports a blocked prompt (no candidates) as content_filter", () => {
    expect(parseGeminiResponse(fixture("prompt-blocked"))).toMatchObject({
      content: "",
      finishReason: "content_filter",
      usage: { inputTokens: 9, outputTokens: 0, totalTokens: 9 },
    });
  });

  it("marks usage as estimated when Gemini sends no usageMetadata", () => {
    expect(parseGeminiResponse(fixture("no-usage"))).toMatchObject({
      content: "Hello",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      usageEstimated: true,
    });
  });

  it.each([
    ["STOP", "stop"],
    ["MAX_TOKENS", "length"],
    ["CONTINUATION", "length"],
    ["SAFETY", "content_filter"],
    ["RECITATION", "content_filter"],
    ["SPII", "content_filter"],
    ["OTHER", "error"],
    ["MALFORMED_FUNCTION_CALL", "error"],
    ["SOMETHING_NEW_FROM_GOOGLE", "error"],
  ])("maps finishReason %s to %s", (geminiReason, unified) => {
    const json = {
      candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: geminiReason }],
    };

    expect(parseGeminiResponse(json).finishReason).toBe(unified);
  });

  it("treats a missing finishReason as a normal stop", () => {
    const json = { candidates: [{ content: { parts: [{ text: "x" }] } }] };

    expect(parseGeminiResponse(json).finishReason).toBe("stop");
  });

  it.each([
    ["a text body (for example a truncated JSON response)", '{"candidates": ['],
    ["null", null],
    ["no candidates and no block reason", {}],
    ["candidates of the wrong type", { candidates: "nope" }],
    ["negative token counts", { candidates: [], usageMetadata: { promptTokenCount: -1 } }],
  ])("rejects %s as an unreadable PROVIDER_ERROR", (_label, json) => {
    let error;
    try {
      parseGeminiResponse(json);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR", provider: "gemini" });
  });
});

describe("mapGeminiError", () => {
  it.each([
    ["error-invalid-key-401", 401, "PROVIDER_ERROR", false],
    ["error-invalid-key-legacy-400", 400, "PROVIDER_ERROR", false],
    ["error-failed-precondition-400", 400, "PROVIDER_ERROR", false],
    ["error-invalid-request-400", 400, "INVALID_REQUEST", false],
    ["error-rate-limited-429", 429, "PROVIDER_RATE_LIMITED", true],
    ["error-unavailable-503", 503, "PROVIDER_UNAVAILABLE", true],
  ])("maps %s to %s", (name, status, code, retryable) => {
    const error = mapGeminiError({ status, body: fixture(name) });

    expect(error).toMatchObject({ code, retryable, provider: "gemini" });
  });

  it("treats a bad API key as our problem, not the client's, even when Gemini says 400", () => {
    // INVALID_REQUEST would stop fallback; a credentials error lets another provider answer.
    expect(
      mapGeminiError({ status: 400, body: fixture("error-invalid-key-legacy-400") }).code,
    ).not.toBe("INVALID_REQUEST");
  });

  it("never copies Gemini's message into the client-facing error", () => {
    const error = mapGeminiError({ status: 400, body: fixture("error-invalid-request-400") });

    expect(error.message).not.toContain("generation_config");
    expect(error.message).toBe("gemini rejected the request as invalid");
  });

  it("falls back to the status code when the body is HTML or empty", () => {
    expect(mapGeminiError({ status: 502, body: "<html>Bad gateway</html>" })).toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: true,
    });
    expect(mapGeminiError({ status: 504, body: null }).code).toBe("TIMEOUT");
  });
});
