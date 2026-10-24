import { describe, expect, it } from "vitest";
import { createLineSplitter, readStreamPayloads } from "../../src/providers/streamReader.js";

const encoder = new TextEncoder();

async function* chunksOf(...pieces) {
  for (const piece of pieces) yield typeof piece === "string" ? encoder.encode(piece) : piece;
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const read = (format, ...pieces) => collect(readStreamPayloads(chunksOf(...pieces), format));

/** Splits text into chunks of `size` bytes, the worst case a network can deliver. */
function bytesInPiecesOf(text, size) {
  const bytes = encoder.encode(text);
  const pieces = [];
  for (let i = 0; i < bytes.length; i += size) pieces.push(bytes.slice(i, i + size));
  return pieces;
}

describe("createLineSplitter", () => {
  it("keeps a partial line until its ending arrives", () => {
    const lines = createLineSplitter();

    expect(lines.push('{"a":')).toEqual([]);
    expect(lines.push('1}\n{"b"')).toEqual(['{"a":1}']);
    expect(lines.push(":2}\n")).toEqual(['{"b":2}']);
  });

  it("accepts \\n, \\r\\n and \\r endings", () => {
    expect(createLineSplitter().push("a\nb\r\nc\rd\n")).toEqual(["a", "b", "c", "d"]);
  });

  it("does not split a \\r\\n that arrives in two chunks into two lines", () => {
    const lines = createLineSplitter();

    expect(lines.push("a\r")).toEqual([]);
    expect(lines.push("\nb\n")).toEqual(["a", "b"]);
  });

  it("returns the last line on flush even without a line ending", () => {
    const lines = createLineSplitter();
    lines.push("a\nlast");

    expect(lines.flush()).toEqual(["last"]);
    expect(lines.flush()).toEqual([]);
  });
});

describe("readStreamPayloads with ndjson", () => {
  it("yields one payload per line, skipping blank lines", async () => {
    expect(await read("ndjson", '{"a":1}\n\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("joins a JSON object split across chunks", async () => {
    expect(await read("ndjson", '{"message":{"con', 'tent":"Ja"}}\n{"do', 'ne":true}\n')).toEqual([
      '{"message":{"content":"Ja"}}',
      '{"done":true}',
    ]);
  });

  it("yields a final line that has no trailing newline", async () => {
    expect(await read("ndjson", '{"a":1}\n{"done":true}')).toEqual(['{"a":1}', '{"done":true}']);
  });

  it("survives a stream delivered one byte at a time, including multi-byte characters", async () => {
    const text = '{"content":"जयपुर 🏰"}\n{"content":"done"}\n';

    expect(await read("ndjson", ...bytesInPiecesOf(text, 1))).toEqual([
      '{"content":"जयपुर 🏰"}',
      '{"content":"done"}',
    ]);
  });
});

describe("readStreamPayloads with sse", () => {
  it("yields the data of each event, which ends at a blank line", async () => {
    expect(await read("sse", 'data: {"a":1}\n\ndata: {"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("handles \\r\\n\\r\\n separators split anywhere", async () => {
    const text = 'data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n';

    for (const size of [1, 2, 3, 7]) {
      expect(await read("sse", ...bytesInPiecesOf(text, size))).toEqual(['{"a":1}', '{"b":2}']);
    }
  });

  it("joins several data lines of one event with newlines", async () => {
    expect(await read("sse", "data: line one\ndata: line two\n\n")).toEqual(["line one\nline two"]);
  });

  it("ignores comments, event names, ids and retry hints", async () => {
    const text = ': keep-alive\n\nevent: message\nid: 7\nretry: 1000\ndata: {"a":1}\n\n';

    expect(await read("sse", text)).toEqual(['{"a":1}']);
  });

  it("keeps the value exactly, removing only one space after the colon", async () => {
    expect(await read("sse", "data:no-space\n\ndata:  two-spaces\n\n")).toEqual([
      "no-space",
      " two-spaces",
    ]);
  });

  it("yields an event cut off by the end of the stream", async () => {
    expect(await read("sse", 'data: {"a":1}\n\ndata: {"last":true}')).toEqual([
      '{"a":1}',
      '{"last":true}',
    ]);
  });
});

it("rejects an unknown format", async () => {
  await expect(read("xml", "<a/>")).rejects.toThrow('Unknown stream format "xml"');
});
