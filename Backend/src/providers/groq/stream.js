import { parseOpenAIStreamChunk } from "../openai/stream.js";
import { mapGroqError } from "./errors.js";

// Token counts may come at the top level, as OpenAI sends them, or in Groq's own x_groq
// object; the docs show neither for streams, so both are read.
const usageOf = (chunk) => chunk.usage ?? chunk.x_groq?.usage;

/**
 * One SSE event of a Groq stream: OpenAI's chunk format, ending with data: [DONE].
 *
 * @param {string} raw
 */
export function parseGroqStreamChunk(raw) {
  return parseOpenAIStreamChunk(raw, { provider: "groq", mapError: mapGroqError, usageOf });
}
