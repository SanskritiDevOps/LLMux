import { describe, expect, it } from "vitest";
import { ollamaAdapter } from "../../src/providers/ollama/index.js";
import { parseOllamaStreamChunk } from "../../src/providers/ollama/stream.js";
import { GatewayError } from "../../src/utils/errors.js";
import { replayStream, streamFixture, textOf } from "../helpers/replayStream.js";

// Both fixtures were recorded from a real Ollama 0.40.9 running llama3.2:1b.
const replay = (name, options) =>
  replayStream(ollamaAdapter, streamFixture("ollama", name), options);

const line = (fields) => JSON.stringify({ model: "llama3.2:1b", ...fields });

describe("Ollama stream parsing", () => {
  it("registers as an NDJSON streaming adapter", () => {
    expect(ollamaAdapter.streamFormat).toBe("ndjson");
    expect(ollamaAdapter.parseStreamChunk).toBe(parseOllamaStreamChunk);
  });

  it("turns a recorded stream into deltas, then usage and a finish from the last line", async () => {
    const events = await replay("stream-success.ndjson");

    expect(textOf(events)).toBe("The Amber Fort is a prominent fort in Jaipur.");
    // One delta per generated line; the final done line carries no text.
    expect(events.filter((event) => event.type === "delta")).toHaveLength(11);
    expect(events.slice(-2)).toEqual([
      { type: "usage", usage: { inputTokens: 36, outputTokens: 12, totalTokens: 48 } },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it.each([1, 5, 33, 200])(
    "gives the same events when the bytes arrive %i at a time",
    async (size) => {
      expect(await replay("stream-success.ndjson", { pieceSize: size })).toEqual(
        await replay("stream-success.ndjson"),
      );
    },
  );

  it("maps done_reason length (num_predict reached) to length", async () => {
    const events = await replay("stream-length.ndjson");

    expect(textOf(events)).toBe("Jaipur, also known");
    expect(events.slice(-2)).toEqual([
      { type: "usage", usage: { inputTokens: 31, outputTokens: 5, totalTokens: 36 } },
      { type: "finish", finishReason: "length" },
    ]);
  });

  it("skips the empty message on the final line", () => {
    expect(
      parseOllamaStreamChunk(line({ message: { role: "assistant", content: "" }, done: false })),
    ).toEqual([]);
  });

  it("finishes without usage when Ollama leaves the counts out, so the gateway estimates", () => {
    expect(parseOllamaStreamChunk(line({ done: true, done_reason: "stop" }))).toEqual([
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it("maps an unknown done_reason to error", () => {
    expect(parseOllamaStreamChunk(line({ done: true, done_reason: "unload" }))).toEqual([
      { type: "finish", finishReason: "error" },
    ]);
  });

  it("throws a retryable provider error for an error line, without forwarding its text", () => {
    let error;
    try {
      parseOllamaStreamChunk('{"error":"llama runner process has terminated: exit status 2"}');
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR", provider: "ollama", retryable: true });
    expect(error.message).not.toContain("runner");
  });

  it.each([
    ["broken JSON", '{"message":{"content":"Ja"'],
    ["a line without done", line({ message: { content: "Ja" } })],
    ["a non-string content", line({ message: { content: 7 }, done: false })],
  ])("rejects %s as an unreadable stream", (_label, raw) => {
    expect(() => parseOllamaStreamChunk(raw)).toThrow(
      expect.objectContaining({ code: "PROVIDER_ERROR", provider: "ollama" }),
    );
  });
});
