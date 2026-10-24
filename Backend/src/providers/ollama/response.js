import { z } from "zod";
import { GatewayError } from "../../utils/errors.js";
import { errorFromStatus } from "../adapter.js";

/**
 * Ollama /api/chat response (stream: false) → unified result, and Ollama errors → GatewayError.
 * Fixtures in tests/fixtures/ollama were recorded from a real Ollama 0.40.6.
 */

const PROVIDER = "ollama";

const OllamaResponseSchema = z.object({
  message: z.object({ content: z.string() }),
  done: z.boolean(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.int().nonnegative().optional(),
  eval_count: z.int().nonnegative().optional(),
});

export const FINISH_REASONS = { stop: "stop", length: "length" };

/**
 * @param {unknown} json
 * @returns {import("../adapter.js").ParsedResponse}
 */
export function parseOllamaResponse(json) {
  const result = OllamaResponseSchema.safeParse(json);
  if (!result.success || !result.data.done) {
    // done: false only happens mid-stream; a non-streaming answer must be complete.
    throw new GatewayError(
      "PROVIDER_ERROR",
      `${PROVIDER} returned a response LLMux could not read`,
      {
        provider: PROVIDER,
        cause: result.error ?? new Error("Response has done: false"),
      },
    );
  }
  const { message, done_reason, prompt_eval_count, eval_count } = result.data;

  // Ollama can omit the counts (older versions skip prompt_eval_count when the prompt was
  // cached). Local models are free, so the cost is right either way; only flag the estimate.
  const inputTokens = prompt_eval_count ?? 0;
  const outputTokens = eval_count ?? 0;

  return {
    content: message.content,
    finishReason: FINISH_REASONS[done_reason ?? "stop"] ?? "error",
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    usageEstimated: prompt_eval_count === undefined || eval_count === undefined,
  };
}

/**
 * Ollama errors are { "error": "<text>" }, for example a 404 for a model that has not
 * been pulled. The text is never forwarded; the status decides the unified error.
 *
 * @param {import("../adapter.js").ProviderErrorResponse} response
 */
export function mapOllamaError({ status }) {
  if (status === 404) {
    return new GatewayError(
      "PROVIDER_ERROR",
      `${PROVIDER} does not have the requested model (it may need "ollama pull")`,
      { provider: PROVIDER, retryable: false },
    );
  }
  return errorFromStatus(PROVIDER, status);
}
