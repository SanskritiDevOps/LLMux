import { GatewayError } from "../../utils/errors.js";
import { errorFromStatus } from "../adapter.js";

// Reference: https://ai.google.dev/gemini-api/docs/api-errors

const PROVIDER = "gemini";

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
