import { z } from "zod";
import { GatewayError } from "../../utils/errors.js";
import { FINISH_REASONS, mapOllamaError } from "./response.js";

/**
 * One line of Ollama's /api/chat stream (newline-delimited JSON) → unified stream events.
 * Fixtures in tests/fixtures/ollama/stream-*.ndjson were recorded from a real Ollama 0.40.9.
 *
 *   { message: { content }, done: false }               → delta
 *   { done: true, done_reason, prompt_eval_count, ... }  → usage and finish (the last line)
 *   { error: "<text>" }                                  → thrown (the run failed mid-answer)
 */

const PROVIDER = "ollama";

const OllamaStreamLineSchema = z.object({
  message: z.object({ content: z.string() }).optional(),
  done: z.boolean(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.int().nonnegative().optional(),
  eval_count: z.int().nonnegative().optional(),
});

function unreadable(cause) {
  return new GatewayError("PROVIDER_ERROR", `${PROVIDER} returned a stream LLMux could not read`, {
    provider: PROVIDER,
    cause,
  });
}

/**
 * @param {string} raw  one complete line (see streamReader.js)
 * @returns {import("../adapter.js").ProviderStreamEvent[]}
 */
export function parseOllamaStreamChunk(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw unreadable(err);
  }

  // The status was already 200, so a failure after that arrives as a line. Its text is
  // never forwarded; it is treated as a provider server error.
  if (typeof json?.error === "string") {
    throw mapOllamaError({ status: 500, body: json });
  }

  const result = OllamaStreamLineSchema.safeParse(json);
  if (!result.success) throw unreadable(result.error);
  const { message, done, done_reason, prompt_eval_count, eval_count } = result.data;

  const events = [];
  if (message?.content) events.push({ type: "delta", text: message.content });
  if (!done) return events;

  // Without both counts the gateway estimates usage instead, and says so.
  if (prompt_eval_count !== undefined && eval_count !== undefined) {
    events.push({
      type: "usage",
      usage: {
        inputTokens: prompt_eval_count,
        outputTokens: eval_count,
        totalTokens: prompt_eval_count + eval_count,
      },
    });
  }
  events.push({ type: "finish", finishReason: FINISH_REASONS[done_reason ?? "stop"] ?? "error" });
  return events;
}
