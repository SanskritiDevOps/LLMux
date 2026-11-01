import { parseOpenAIResponse } from "../openai/response.js";

/**
 * Groq's answers have OpenAI's shape (choices, finish_reason, usage.prompt_tokens and
 * usage.completion_tokens), plus Groq-only timing fields that are ignored. Reasoning
 * models (gpt-oss) return their reasoning in a separate message.reasoning field, so
 * `content` is the answer alone.
 *
 * @param {unknown} json
 */
export function parseGroqResponse(json) {
  return parseOpenAIResponse(json, "groq");
}
