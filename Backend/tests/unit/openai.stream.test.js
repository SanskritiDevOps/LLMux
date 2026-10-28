import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyError } from "../../src/gateway/errorPolicy.js";
import { mapOpenAIError } from "../../src/providers/openai/errors.js";
import { openaiAdapter } from "../../src/providers/openai/index.js";
import { parseOpenAIStreamChunk } from "../../src/providers/openai/stream.js";
import { providerRegistry } from "../../src/providers/index.js";
import { GatewayError } from "../../src/utils/errors.js";
import { replayStream, streamFixture, textOf } from "../helpers/replayStream.js";

// Fixtures follow OpenAI's documented formats; no OPENAI_API_KEY is set to record real ones.
const replay = (name, options) =>
  replayStream(openaiAdapter, streamFixture("openai", name), options);
const errorBody = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/openai/${name}.json`, import.meta.url), "utf8"));

describe("the OpenAI adapter", () => {
  it("is registered, streams over SSE and uses the stream parser", () => {
    expect(providerRegistry.get("openai")).toBe(openaiAdapter);
    expect(openaiAdapter.streamFormat).toBe("sse");
    expect(openaiAdapter.parseStreamChunk).toBe(parseOpenAIStreamChunk);
  });
});

describe("OpenAI stream parsing", () => {
  it("turns a stream into deltas, a finish, and the usage chunk at the end", async () => {
    const events = await replay("stream-success.sse");

    expect(textOf(events)).toBe("Morning: Amber Fort, then lunch at LMB.");
    expect(events.filter((event) => event.type === "delta")).toHaveLength(3);
    expect(events.slice(-2)).toEqual([
      { type: "finish", finishReason: "stop" },
      { type: "usage", usage: { inputTokens: 12, outputTokens: 11, totalTokens: 23 } },
    ]);
  });

  it.each([1, 7, 64])("gives the same events when the bytes arrive %i at a time", async (size) => {
    expect(await replay("stream-success.sse", { pieceSize: size })).toEqual(
      await replay("stream-success.sse"),
    );
  });

  it("maps length to length", async () => {
    const events = await replay("stream-length.sse");

    expect(textOf(events)).toBe("Jaipur is the capital of");
    expect(events.find((event) => event.type === "finish").finishReason).toBe("length");
  });

  it("throws a retryable error when OpenAI fails mid-stream, without its text", async () => {
    const error = await replay("stream-error-midway.sse").catch((err) => err);

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR", provider: "openai", retryable: true });
    expect(error.message).not.toContain("processing your request");
  });

  it("ignores the [DONE] marker and the empty first chunk", () => {
    expect(parseOpenAIStreamChunk("[DONE]")).toEqual([]);
    expect(
      parseOpenAIStreamChunk(
        '{"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
      ),
    ).toEqual([]);
  });

  it("leaves out refusal text, which isn't an answer", () => {
    expect(parseOpenAIStreamChunk('{"choices":[{"delta":{"refusal":"I can\'t help."}}]}')).toEqual(
      [],
    );
  });

  it("maps a tool-call finish to error", () => {
    expect(
      parseOpenAIStreamChunk('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'),
    ).toEqual([{ type: "finish", finishReason: "error" }]);
  });

  it.each([
    ["broken JSON", '{"choices": ['],
    ["a non-object", '"hello"'],
    ["usage without counts", '{"choices":[],"usage":{"prompt_tokens":"x"}}'],
  ])("rejects %s as an unreadable stream", (_label, raw) => {
    expect(() => parseOpenAIStreamChunk(raw)).toThrow(
      expect.objectContaining({ code: "PROVIDER_ERROR", provider: "openai" }),
    );
  });
});

describe("mapOpenAIError", () => {
  it.each([
    [
      "a bad key (401)",
      401,
      "error-invalid-key-401",
      "PROVIDER_ERROR",
      false,
      { retry: false, fallback: true, alert: true },
    ],
    [
      "a rate limit (429)",
      429,
      "error-rate-limited-429",
      "PROVIDER_RATE_LIMITED",
      true,
      { retry: true, fallback: true, alert: false },
    ],
    [
      "no credit left (429 insufficient_quota)",
      429,
      "error-insufficient-quota-429",
      "PROVIDER_ERROR",
      false,
      { retry: false, fallback: true, alert: false },
    ],
    [
      "a prompt that is too long (400)",
      400,
      "error-context-length-400",
      "INVALID_REQUEST",
      false,
      { retry: false, fallback: false, alert: false },
    ],
    [
      "a setting this model refuses (400 unsupported_value)",
      400,
      "error-unsupported-value-400",
      "PROVIDER_ERROR",
      false,
      { retry: false, fallback: true, alert: false },
    ],
    [
      "a missing model (404)",
      404,
      "error-model-not-found-404",
      "PROVIDER_ERROR",
      false,
      { retry: false, fallback: true, alert: false },
    ],
    [
      "a server error (500)",
      500,
      "error-server-500",
      "PROVIDER_ERROR",
      true,
      { retry: true, fallback: true, alert: false },
    ],
  ])(
    "maps %s, with the right retry and fallback",
    (_label, status, fixture, code, retryable, decision) => {
      const error = mapOpenAIError({ status, body: errorBody(fixture) });

      expect(error).toBeInstanceOf(GatewayError);
      expect(error).toMatchObject({ code, retryable, provider: "openai" });
      expect(classifyError(error)).toEqual(decision);
    },
  );

  it("never copies OpenAI's own message, which can contain the key or account details", () => {
    const error = mapOpenAIError({ status: 401, body: errorBody("error-invalid-key-401") });

    expect(error.message).not.toContain("sk-test");
    expect(error.message).not.toContain("platform.openai.com");
  });

  it.each([
    ["an HTML page", "<html>Bad gateway</html>"],
    ["an empty body", null],
  ])("falls back to the status for %s", (_label, body) => {
    expect(mapOpenAIError({ status: 503, body })).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});
