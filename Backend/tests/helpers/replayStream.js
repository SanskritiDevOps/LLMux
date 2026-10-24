import { readFileSync } from "node:fs";
import { readStreamPayloads } from "../../src/providers/streamReader.js";

/** A recorded stream from tests/fixtures/<provider>/, as raw bytes. */
export function streamFixture(provider, name) {
  return readFileSync(new URL(`../fixtures/${provider}/${name}`, import.meta.url));
}

/**
 * Feeds recorded bytes through the real stream reader and an adapter's parseStreamChunk,
 * cut into pieces of `pieceSize` bytes so payloads and characters split mid-way get tested.
 *
 * @param {Readonly<import("../../src/providers/adapter.js").ProviderAdapter>} adapter
 * @param {Uint8Array} bytes
 */
export async function replayStream(adapter, bytes, { pieceSize = bytes.length } = {}) {
  async function* pieces() {
    for (let i = 0; i < bytes.length; i += pieceSize) yield bytes.subarray(i, i + pieceSize);
  }

  const events = [];
  for await (const payload of readStreamPayloads(pieces(), adapter.streamFormat)) {
    events.push(...adapter.parseStreamChunk(payload));
  }
  return events;
}

/** The answer text a client would see: every delta joined. */
export const textOf = (events) =>
  events
    .filter((event) => event.type === "delta")
    .map((event) => event.text)
    .join("");
