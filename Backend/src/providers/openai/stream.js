import { mapOpenAIError } from "./errors.js";
import { FINISH_REASONS, toUsage, unreadable } from "./response.js";

/**
 * One SSE event of an OpenAI Chat Completions stream → unified stream events.
 * Reference: https://platform.openai.com/docs/api-reference/chat/streaming
 *
 *   choices[0].delta.content     → delta
 *   choices[0].finish_reason     → finish (on the last content chunk)
 *   usage (choices: [])          → usage (one extra chunk at the end, because the request
 *                                  sets stream_options.include_usage)
 *   [DONE]                       → nothing: the end marker
 *   { error: { … } }             → thrown, mapped like a non-streaming error
 *
 * A refusal arrives as delta.refusal; its text isn't an answer, so it is left out.
 *
 * @param {string} raw  one event's data, already complete (see streamReader.js)
 * @returns {import("../adapter.js").ProviderStreamEvent[]}
 */
export function parseOpenAIStreamChunk(raw) {
  if (raw.trim() === "[DONE]") return [];

  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw unreadable(err);
  }
  if (json === null || typeof json !== "object") throw unreadable(new Error("Not an object"));

  // After the 200, a failure can only arrive as an event. It carries no HTTP status, so
  // it is treated as a server error.
  if (json.error) {
    throw mapOpenAIError({ status: 500, body: json });
  }

  const events = [];
  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  const text = choice?.delta?.content;
  if (typeof text === "string" && text !== "") events.push({ type: "delta", text });

  if (json.usage) {
    if (
      !Number.isInteger(json.usage.prompt_tokens) ||
      !Number.isInteger(json.usage.completion_tokens)
    ) {
      throw unreadable(new Error("Usage chunk without token counts"));
    }
    events.push({ type: "usage", usage: toUsage(json.usage) });
  }

  if (choice?.finish_reason) {
    events.push({ type: "finish", finishReason: FINISH_REASONS[choice.finish_reason] ?? "error" });
  }
  return events;
}
