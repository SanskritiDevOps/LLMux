/**
 * Reads a Server-Sent Events body from fetch() as { type, ...data } objects, the shape the
 * API's stream events have (docs/API.md section 4). EventSource can't be used: it only
 * sends GET requests, and the playground needs a POST with a JSON body.
 *
 * Bytes can arrive split anywhere, even inside a character, so text is decoded as a
 * stream and only complete events (ending in a blank line) are parsed. Comment lines
 * (": heartbeat") are skipped.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<{ type: string } & Record<string, unknown>>}
 */
export async function* readSseEvents(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  // A "\r" at the end of a chunk may be the first half of "\r\n", so it waits for the next.
  let pendingCr = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = pendingCr + value;
      pendingCr = text.endsWith("\r") ? "\r" : "";
      buffer += text.slice(0, text.length - pendingCr.length).replace(/\r\n?/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const event = parseEvent(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event) yield event;
      }
    }
  } finally {
    // Stopping early (the user pressed Stop) cancels the response, which closes the
    // connection, so the server stops the provider call too.
    reader.cancel().catch(() => {});
  }
}

function parseEvent(block) {
  let type = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") type = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { type, ...JSON.parse(data.join("\n")) };
}
