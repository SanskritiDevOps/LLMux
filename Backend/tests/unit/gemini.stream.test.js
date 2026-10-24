import { describe, expect, it } from "vitest";
import { geminiAdapter } from "../../src/providers/gemini/index.js";
import { parseGeminiStreamChunk } from "../../src/providers/gemini/stream.js";
import { GatewayError } from "../../src/utils/errors.js";
import { replayStream, streamFixture, textOf } from "../helpers/replayStream.js";

// Fixtures follow the documented streamGenerateContent?alt=sse format, including its
// \r\n\r\n event separators. No Gemini key is available yet to record real ones.
const replay = (name, options) =>
  replayStream(geminiAdapter, streamFixture("gemini", name), options);

describe("Gemini stream parsing", () => {
  it("registers as an SSE streaming adapter", () => {
    expect(geminiAdapter.streamFormat).toBe("sse");
    expect(geminiAdapter.parseStreamChunk).toBe(parseGeminiStreamChunk);
  });

  it("turns a complete stream into deltas, running usage and a finish", async () => {
    const events = await replay("stream-success.sse");

    expect(textOf(events)).toBe("Morning: Amber Fort, then lunch at LMB.");
    expect(events.filter((event) => event.type === "delta")).toHaveLength(3);
    expect(events.filter((event) => event.type === "usage").at(-1)).toEqual({
      type: "usage",
      usage: { inputTokens: 12, outputTokens: 11, totalTokens: 23 },
    });
    expect(events.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
  });

  it.each([1, 3, 17, 64])(
    "gives the same events when the bytes arrive %i at a time",
    async (size) => {
      expect(await replay("stream-success.sse", { pieceSize: size })).toEqual(
        await replay("stream-success.sse"),
      );
    },
  );

  it("maps MAX_TOKENS to length", async () => {
    const events = await replay("stream-max-tokens.sse");

    expect(textOf(events)).toBe("Jaipur is the capital of");
    expect(events.at(-1)).toEqual({ type: "finish", finishReason: "length" });
  });

  it("ends with content_filter when the answer is blocked part-way", async () => {
    const events = await replay("stream-safety.sse");

    expect(textOf(events)).toBe("Here is how");
    expect(events.at(-1)).toEqual({ type: "finish", finishReason: "content_filter" });
  });

  it("finishes with content_filter when the prompt itself is blocked", async () => {
    const events = await replay("stream-prompt-blocked.sse");

    expect(textOf(events)).toBe("");
    expect(events.at(-1)).toEqual({ type: "finish", finishReason: "content_filter" });
  });

  it("skips thought parts but counts thinking tokens as output", async () => {
    const events = await replay("stream-thinking.sse");

    expect(textOf(events)).toBe("Amber Fort.");
    expect(events.filter((event) => event.type === "usage").at(-1).usage).toEqual({
      inputTokens: 10,
      outputTokens: 9,
      totalTokens: 19,
    });
  });

  it("throws a mapped, retryable error when Gemini fails mid-stream", async () => {
    const error = await replay("stream-error-midway.sse").catch((err) => err);

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      provider: "gemini",
      retryable: true,
    });
    // Gemini's own text stays in the logs; the client sees the generic message.
    expect(error.message).not.toContain("overloaded");
  });

  it("emits nothing for an event without text, usage or finish", () => {
    expect(parseGeminiStreamChunk('{"candidates":[{"content":{"parts":[]}}]}')).toEqual([]);
  });

  it("maps an unknown finish reason to error", () => {
    expect(parseGeminiStreamChunk('{"candidates":[{"finishReason":"NEW_REASON"}]}')).toEqual([
      { type: "finish", finishReason: "error" },
    ]);
  });

  it.each([
    ["broken JSON", '{"candidates": ['],
    ["a non-object", '"hello"'],
    ["a wrong shape", '{"candidates":"nope"}'],
  ])("rejects %s as an unreadable response", (_label, raw) => {
    expect(() => parseGeminiStreamChunk(raw)).toThrow(
      expect.objectContaining({ code: "PROVIDER_ERROR", provider: "gemini" }),
    );
  });
});
