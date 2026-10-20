import { z } from "zod";
import { GatewayError } from "../../utils/errors.js";
import { errorFromStatus } from "../adapter.js";

/**
 * Gemini generateContent response → unified result, and Gemini errors → GatewayError.
 * Reference: https://ai.google.dev/api/generate-content and
 *            https://ai.google.dev/gemini-api/docs/api-errors
 */

const PROVIDER = "gemini";

// Only the fields LLMux reads; everything else Gemini sends is ignored.
const GeminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(z.object({ text: z.string().optional(), thought: z.boolean().optional() }))
              .optional(),
          })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.int().nonnegative().optional(),
      candidatesTokenCount: z.int().nonnegative().optional(),
      thoughtsTokenCount: z.int().nonnegative().optional(),
    })
    .optional(),
});

// Gemini's FinishReason enum → the four unified reasons. Anything unlisted becomes "error".
const FINISH_REASONS = {
  STOP: "stop",
  MAX_TOKENS: "length",
  // Hit the per-request token limit with more to come: from the client's view, truncated.
  CONTINUATION: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  IMAGE_SAFETY: "content_filter",
  IMAGE_PROHIBITED_CONTENT: "content_filter",
  IMAGE_RECITATION: "content_filter",
  ESCALATION: "content_filter",
};

function unreadable(cause) {
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
 * @param {unknown} json
 * @returns {import("../adapter.js").ParsedResponse}
 */
export function parseGeminiResponse(json) {
  const result = GeminiResponseSchema.safeParse(json);
  if (!result.success || json === null || typeof json !== "object") {
    throw unreadable(result.error);
  }
  const { candidates, promptFeedback, usageMetadata } = result.data;

  // Thinking tokens are billed as output (Gemini pricing: "output price, including
  // thinking tokens"), so they count towards outputTokens for cost tracking.
  const inputTokens = usageMetadata?.promptTokenCount ?? 0;
  const outputTokens =
    (usageMetadata?.candidatesTokenCount ?? 0) + (usageMetadata?.thoughtsTokenCount ?? 0);
  const usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  const usageEstimated = usageMetadata === undefined;

  const candidate = candidates?.[0];
  if (!candidate) {
    // No candidate at all: either the prompt itself was blocked, or the response is broken.
    if (promptFeedback?.blockReason) {
      return { content: "", finishReason: "content_filter", usage, usageEstimated };
    }
    throw unreadable(new Error("Response has no candidates and no blockReason"));
  }

  // Parts flagged `thought` are the model's reasoning, not the answer.
  const content = (candidate.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("");

  const finishReason = FINISH_REASONS[candidate.finishReason ?? "STOP"] ?? "error";

  return { content, finishReason, usage, usageEstimated };
}

/**
 * Gemini's error body is { error: { code, message, ... } }. Newer responses use snake_case
 * string codes ("authentication", "failed_precondition"); older ones use a numeric code
 * with `status` ("INVALID_ARGUMENT") and `details[].reason` ("API_KEY_INVALID").
 * Both are handled.
 *
 * @param {import("../adapter.js").ProviderErrorResponse} response
 */
export function mapGeminiError({ status, body }) {
  const error = body && typeof body === "object" ? body.error : undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const reasons = Array.isArray(error?.details)
    ? error.details.map((detail) => detail?.reason)
    : [];

  if (status === 400) {
    // Gemini has reported a bad API key as 400. That is our configuration, not the client's
    // request, so it must not be INVALID_REQUEST: another provider could still answer.
    if (code === "authentication" || reasons.includes("API_KEY_INVALID")) {
      return errorFromStatus(PROVIDER, 401);
    }
    // Billing disabled, unsupported region and similar: an account problem, not the request.
    if (code === "failed_precondition" || error?.status === "FAILED_PRECONDITION") {
      return new GatewayError(
        "PROVIDER_ERROR",
        `${PROVIDER} cannot serve requests for this account right now (precondition failed)`,
        { provider: PROVIDER, retryable: false },
      );
    }
  }

  return errorFromStatus(PROVIDER, status);
}
