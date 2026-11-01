import { describe, expect, it } from "vitest";
import { readSseEvents } from "../src/lib/sse.js";

/**
 * A response body that delivers `text` in pieces of `size` bytes, one piece each time it's
 * read, like a network stream that is still open until the last piece.
 */
function body(text, size = text.length, onCancel) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
    cancel: onCancel,
  });
}

async function collect(stream) {
  const events = [];
  for await (const event of readSseEvents(stream)) events.push(event);
  return events;
}

// The shape POST /v1/chat and the playground send, with CRLF and LF line endings mixed,
// a heartbeat comment, and a character that takes two bytes.
const STREAM =
  ": heartbeat\r\n\r\n" +
  'event: start\r\ndata: {"id":"req_1","provider":"ollama"}\r\n\r\n' +
  'event: delta\ndata: {"text":"Namasté "}\n\n' +
  'event: delta\ndata: {"text":"Jaipur"}\n\n' +
  'event: end\ndata: {"finishReason":"stop","costUsd":0}\n\n';

describe("readSseEvents", () => {
  it("parses each event's type and JSON data, skipping comments", async () => {
    expect(await collect(body(STREAM))).toEqual([
      { type: "start", id: "req_1", provider: "ollama" },
      { type: "delta", text: "Namasté " },
      { type: "delta", text: "Jaipur" },
      { type: "end", finishReason: "stop", costUsd: 0 },
    ]);
  });

  // 1 byte splits every \r\n and the two-byte "é"; 3 and 7 split events at odd places.
  it.each([1, 3, 7])("gives the same events when bytes arrive %i at a time", async (size) => {
    expect(await collect(body(STREAM, size))).toEqual(await collect(body(STREAM)));
  });

  it("joins multi-line data, as the SSE format allows", async () => {
    const events = await collect(body('event: delta\ndata: {"text":\ndata: "hi"}\n\n'));

    expect(events).toEqual([{ type: "delta", text: "hi" }]);
  });

  it('calls an event without an "event:" line a message', async () => {
    expect(await collect(body('data: {"n":1}\n\n'))).toEqual([{ type: "message", n: 1 }]);
  });

  it("ignores an unfinished event at the end of the stream", async () => {
    expect(await collect(body('event: delta\ndata: {"text":"cut off"}\n'))).toEqual([]);
  });

  it("cancels the response when the reader stops early, which closes the connection", async () => {
    let cancelled = false;
    const stream = body(STREAM, 1, () => {
      cancelled = true;
    });

    for await (const event of readSseEvents(stream)) {
      if (event.type === "start") break;
    }

    // The cancel travels back through the decoder to the body, which takes a moment.
    await expect.poll(() => cancelled).toBe(true);
  });
});
