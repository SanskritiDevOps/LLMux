import { z } from "zod";
import { GatewayError } from "../../utils/errors.js";

/**
 * Anthropic Messages response → unified result.
 * Reference: https://platform.claude.com/docs/en/api/messages
 *
 *   content[] of type "text"     → content, joined in order. Other blocks (thinking,
 *                                  tool_use) aren't part of the answer and are skipped.
 *   stop_reason                  → finishReason
 *   usage.input_tokens           → inputTokens, plus any cache_creation_input_tokens and
 *                                  cache_read_input_tokens (all three are prompt tokens)
 *   usage.output_tokens          → outputTokens (thinking tokens are already included, and
 *                                  billed as output)
 */

const PROVIDER = "anthropic";

const UsageFields = z.object({
  input_tokens: z.int().nonnegative().optional(),
  cache_creation_input_tokens: z.int().nonnegative().nullable().optional(),
  cache_read_input_tokens: z.int().nonnegative().nullable().optional(),
  output_tokens: z.int().nonnegative().optional(),
});

// Only the fields LLMux reads; everything else Anthropic sends is ignored. stream.js reads
// the same usage fields from message_start and message_delta.
export const AnthropicResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullable().optional(),
  usage: UsageFields.optional(),
});
export const AnthropicUsageSchema = UsageFields;

// Anthropic's stop_reason → the four unified reasons. tool_use and pause_turn can't be
// shown as an answer by the unified format, so anything unlisted becomes "error".
export const FINISH_REASONS = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  refusal: "content_filter",
};

export function unreadable(cause) {
  return new GatewayError(
    "PROVIDER_ERROR",
    `${PROVIDER} returned a response LLMux could not read`,
    {
      provider: PROVIDER,
      cause,
    },
  );
}

/**
 * Anthropic usage → unified usage. Fields Anthropic left out stay undefined, so a stream
 * can report input and output tokens in different events (see stream.js).
 */
export function toUsage(usage) {
  const out = {};
  if (usage.input_tokens !== undefined) {
    out.inputTokens =
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
  }
  if (usage.output_tokens !== undefined) out.outputTokens = usage.output_tokens;
  return out;
}

/**
 * @param {unknown} json
 * @returns {import("../adapter.js").ParsedResponse}
 */
export function parseAnthropicResponse(json) {
  const result = AnthropicResponseSchema.safeParse(json);
  if (!result.success || json === null || typeof json !== "object") {
    throw unreadable(result.error);
  }
  const { content, stop_reason: stopReason, usage } = result.data;

  const counted = toUsage(usage ?? {});
  const inputTokens = counted.inputTokens ?? 0;
  const outputTokens = counted.outputTokens ?? 0;
  const usageOut = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  const usageEstimated = counted.inputTokens === undefined || counted.outputTokens === undefined;

  const finishReason = FINISH_REASONS[stopReason ?? "end_turn"] ?? "error";
  if (finishReason === "content_filter") {
    // A refusal can arrive after part of an answer; that part isn't an answer either.
    return { content: "", finishReason, usage: usageOut, usageEstimated };
  }

  return {
    content: content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join(""),
    finishReason,
    usage: usageOut,
    usageEstimated,
  };
}
