import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyError } from "../../src/gateway/errorPolicy.js";
import { mapAnthropicError } from "../../src/providers/anthropic/errors.js";
import { anthropicAdapter } from "../../src/providers/anthropic/index.js";
import { parseAnthropicStreamChunk } from "../../src/providers/anthropic/stream.js";
import { providerRegistry } from "../../src/providers/index.js";
import { GatewayError } from "../../src/utils/errors.js";
import { replayStream, streamFixture, textOf } from "../helpers/replayStream.js";

// Fixtures follow Anthropic's documented formats; no ANTHROPIC_API_KEY is set to record
// real ones.
const replay = (name, options) =>
  replayStream(anthropicAdapter, streamFixture("anthropic", name), options);
const errorBody = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/anthropic/${name}.json`, import.meta.url), "utf8"));

describe("the Anthropic adapter", () => {
  it("is registered, streams over SSE and uses the stream parser", () => {
    expect(providerRegistry.get("anthropic")).toBe(anthropicAdapter);
    expect(anthropicAdapter.streamFormat).toBe("sse");
    expect(anthropicAdapter.parseStreamChunk).toBe(parseAnthropicStreamChunk);
  });
});

describe("Anthropic stream parsing", () => {
  it("turns typed events into deltas, input then output usage, and a finish", async () => {
    const events = await replay("stream-success.sse");

    expect(textOf(events)).toBe("Morning: Amber Fort, then lunch at LMB.");
    expect(events.filter((event) => event.type === "delta")).toHaveLength(3);
    // message_start gives the input tokens; message_delta the output total and the stop.
    expect(events[0]).toEqual({ type: "usage", usage: { inputTokens: 12, outputTokens: 1 } });
    expect(events.slice(-2)).toEqual([
      { type: "usage", usage: { outputTokens: 11 } },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it.each([1, 7, 64])("gives the same events when the bytes arrive %i at a time", async (size) => {
    expect(await replay("stream-success.sse", { pieceSize: size })).toEqual(
      await replay("stream-success.sse"),
    );
  });

  it("skips thinking blocks, signatures and pings", () => {
    for (const raw of [
      '{"type":"ping"}',
      '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Hmm"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"Eq"}}',
      '{"type":"content_block_stop","index":0}',
      '{"type":"message_stop"}',
    ]) {
      expect(parseAnthropicStreamChunk(raw)).toEqual([]);
    }
  });

  it("maps max_tokens to length", async () => {
    const events = await replay("stream-max-tokens.sse");

    expect(textOf(events)).toBe("Jaipur is the capital of");
    expect(events.find((event) => event.type === "finish").finishReason).toBe("length");
  });

  it("maps a refusal to content_filter", async () => {
    const events = await replay("stream-refusal.sse");

    expect(events.find((event) => event.type === "finish").finishReason).toBe("content_filter");
  });

  it("maps a tool-use stop to error", () => {
    expect(
      parseAnthropicStreamChunk('{"type":"message_delta","delta":{"stop_reason":"tool_use"}}'),
    ).toEqual([{ type: "finish", finishReason: "error" }]);
  });

  it("throws a retryable unavailable error when Anthropic is overloaded mid-stream", async () => {
    const error = await replay("stream-error-midway.sse").catch((err) => err);

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      provider: "anthropic",
      retryable: true,
    });
    expect(error.message).not.toContain("Overloaded");
  });

  it.each([
    ["rate_limit_error", "PROVIDER_RATE_LIMITED"],
    ["api_error", "PROVIDER_ERROR"],
    ["something_new", "PROVIDER_ERROR"],
  ])("maps a mid-stream %s error to %s", (type, code) => {
    expect(() =>
      parseAnthropicStreamChunk(JSON.stringify({ type: "error", error: { type, message: "x" } })),
    ).toThrow(expect.objectContaining({ code, retryable: true }));
  });

  it.each([
    ["broken JSON", '{"type": "message_'],
    ["a non-object", '"hello"'],
    ["usage without numbers", '{"type":"message_delta","usage":{"output_tokens":"x"}}'],
  ])("rejects %s as an unreadable stream", (_label, raw) => {
    expect(() => parseAnthropicStreamChunk(raw)).toThrow(
      expect.objectContaining({ code: "PROVIDER_ERROR", provider: "anthropic" }),
    );
  });
});

describe("mapAnthropicError", () => {
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
      "no credit left (402)",
      402,
      "error-billing-402",
      "PROVIDER_ERROR",
      false,
      { retry: false, fallback: true, alert: false },
    ],
    [
      "an invalid request (400)",
      400,
      "error-invalid-request-400",
      "INVALID_REQUEST",
      false,
      { retry: false, fallback: false, alert: false },
    ],
    [
      "a missing model (404)",
      404,
      "error-not-found-404",
      "PROVIDER_ERROR",
      false,
      { retry: false, fallback: true, alert: false },
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
      "a server error (500)",
      500,
      "error-server-500",
      "PROVIDER_ERROR",
      true,
      { retry: true, fallback: true, alert: false },
    ],
    [
      "overloaded (529)",
      529,
      "error-overloaded-529",
      "PROVIDER_UNAVAILABLE",
      true,
      { retry: true, fallback: true, alert: false },
    ],
  ])(
    "maps %s, with the right retry and fallback",
    (_label, status, fixture, code, retryable, decision) => {
      const error = mapAnthropicError({ status, body: errorBody(fixture) });

      expect(error).toBeInstanceOf(GatewayError);
      expect(error).toMatchObject({
        code,
        retryable,
        provider: "anthropic",
        providerStatus: status,
      });
      expect(classifyError(error)).toEqual(decision);
    },
  );

  it("never copies Anthropic's own message, which can contain account details", () => {
    const error = mapAnthropicError({ status: 402, body: errorBody("error-billing-402") });

    expect(error.message).not.toContain("Plans & Billing");
  });

  it.each([
    ["an HTML page", "<html>Bad gateway</html>"],
    ["an empty body", null],
  ])("falls back to the status for %s", (_label, body) => {
    expect(mapAnthropicError({ status: 503, body })).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });
});
