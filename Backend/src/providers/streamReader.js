/**
 * Turns the raw bytes of a provider stream into complete payloads, one at a time.
 *
 * The network delivers bytes in arbitrary pieces: a JSON object, a line ending or even a
 * multi-byte character can be split across two chunks. Nothing here parses JSON; it only
 * waits until a payload is complete, so adapters always receive whole JSON text.
 *
 *   "sse"     Server-Sent Events (Gemini, OpenAI, Anthropic): the payload is the joined
 *             `data:` lines of one event, which ends at a blank line
 *   "ndjson"  newline-delimited JSON (Ollama): every non-empty line is a payload
 *
 * Reference for the SSE rules: https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

export const STREAM_FORMATS = Object.freeze(["sse", "ndjson"]);

/**
 * Buffers text and hands back only complete lines. Accepts \n, \r\n and \r endings,
 * including a \r\n split across two chunks.
 */
export function createLineSplitter() {
  let buffer = "";

  return {
    /** @returns {string[]} the lines completed by this text, without their endings */
    push(text) {
      buffer += text;
      const lines = [];
      let start = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const char = buffer[i];
        if (char !== "\n" && char !== "\r") continue;
        // A \r at the very end might be the first half of \r\n: wait for the next chunk.
        if (char === "\r" && i === buffer.length - 1) break;

        lines.push(buffer.slice(start, i));
        if (char === "\r" && buffer[i + 1] === "\n") i += 1;
        start = i + 1;
      }
      buffer = buffer.slice(start);
      return lines;
    },

    /** The stream ended: whatever is left is the last line (it had no line ending). */
    flush() {
      const rest = buffer.replace(/\r$/, "");
      buffer = "";
      return rest === "" ? [] : [rest];
    },
  };
}

/**
 * Groups lines into SSE events. Only `data` matters to LLMux: `event:`, `id:` and `retry:`
 * are ignored, and lines starting with ":" are comments (often keep-alive pings).
 */
function createSseParser() {
  let data = [];

  return {
    /** @returns {string | undefined} the event's data, when this line completes an event */
    push(line) {
      if (line === "") {
        if (data.length === 0) return undefined;
        const payload = data.join("\n");
        data = [];
        return payload;
      }
      if (line.startsWith(":")) return undefined;

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      if (field !== "data") return undefined;

      // One optional space after the colon is part of the format, not the value.
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      data.push(value);
      return undefined;
    },

    /** An event cut off by the end of the stream (no closing blank line) still counts. */
    flush() {
      const payload = data.length > 0 ? data.join("\n") : undefined;
      data = [];
      return payload;
    },
  };
}

/**
 * @param {AsyncIterable<Uint8Array | string>} chunks  the response body, as it arrives
 * @param {"sse" | "ndjson"} format
 * @returns {AsyncGenerator<string>} complete payloads, in order
 */
export async function* readStreamPayloads(chunks, format) {
  if (!STREAM_FORMATS.includes(format)) {
    throw new TypeError(`Unknown stream format "${format}"`);
  }

  // stream: true keeps a multi-byte character that is split across chunks until it is whole.
  const decoder = new TextDecoder();
  const lines = createLineSplitter();
  const sse = format === "sse" ? createSseParser() : null;

  function* payloadsFrom(completeLines) {
    for (const line of completeLines) {
      if (sse) {
        const payload = sse.push(line);
        if (payload !== undefined) yield payload;
      } else if (line.trim() !== "") {
        yield line;
      }
    }
  }

  for await (const chunk of chunks) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    yield* payloadsFrom(lines.push(text));
  }

  yield* payloadsFrom(lines.push(decoder.decode()));
  yield* payloadsFrom(lines.flush());
  const last = sse?.flush();
  if (last !== undefined) yield last;
}
