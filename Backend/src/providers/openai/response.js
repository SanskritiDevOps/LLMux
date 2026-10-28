import { z } from "zod";
import { GatewayError } from "../../utils/errors.js";

/**
 * OpenAI Chat Completions response → unified result.
 * Reference: https://platform.openai.com/docs/api-reference/chat/object
 *
 *   choices[0].message.content   → content
 *   choices[0].message.refusal   → content "" and finishReason content_filter (the model
 *                                  declined; its refusal text is a reply, not an answer)
 *   choices[0].finish_reason     → finishReason
 *   usage.prompt_tokens          → inputTokens
 *   usage.completion_tokens      → outputTokens (reasoning tokens are already included, and
 *                                  billed as output)
 */

const PROVIDER = "openai";

// Only the fields LLMux reads; everything else OpenAI sends is ignored. Each streamed
// chunk has a similar shape, so stream.js shares the finish reasons and usage helper.
export const OpenAIResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().nullable().optional(),
            refusal: z.string().nullable().optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.int().nonnegative(),
      completion_tokens: z.int().nonnegative(),
    })
    .nullable()
    .optional(),
});

// OpenAI's finish_reason → the four unified reasons. Tool calls aren't supported by the
// unified format yet, so a reply that wants to call a tool can't be shown as an answer.
export const FINISH_REASONS = {
  stop: "stop",
  length: "length",
  content_filter: "content_filter",
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

export function toUsage(usage) {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/**
 * @param {unknown} json
 * @returns {import("../adapter.js").ParsedResponse}
 */
export function parseOpenAIResponse(json) {
  const result = OpenAIResponseSchema.safeParse(json);
  if (!result.success || json === null || typeof json !== "object") {
    throw unreadable(result.error);
  }
  const { choices, usage } = result.data;
  const choice = choices?.[0];
  if (!choice?.message) {
    throw unreadable(new Error("Response has no choices"));
  }

  const usageOut = toUsage(usage);
  const usageEstimated = usage == null;

  if (choice.message.refusal) {
    return { content: "", finishReason: "content_filter", usage: usageOut, usageEstimated };
  }

  return {
    content: choice.message.content ?? "",
    finishReason: FINISH_REASONS[choice.finish_reason ?? "stop"] ?? "error",
    usage: usageOut,
    usageEstimated,
  };
}
