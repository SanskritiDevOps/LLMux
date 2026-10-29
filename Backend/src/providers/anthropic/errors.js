import { GatewayError } from "../../utils/errors.js";
import { errorFromStatus } from "../adapter.js";

/**
 * Anthropic errors → GatewayError.
 * Reference: https://platform.claude.com/docs/en/api/errors
 *
 * Anthropic's error body is { type: "error", error: { type, message }, request_id }. The
 * status decides every case (errorFromStatus) except one Anthropic-only status:
 *
 *   529 overloaded_error    Anthropic is temporarily overloaded: the same meaning as a
 *                           503, so it is retried and counted as unavailable
 *
 * Anthropic's own message is never forwarded; the gateway logs it.
 *
 * @param {import("../adapter.js").ProviderErrorResponse} response
 */
export function mapAnthropicError({ status }) {
  if (status === 529) {
    return Object.assign(
      new GatewayError("PROVIDER_UNAVAILABLE", "anthropic is temporarily overloaded", {
        provider: "anthropic",
        retryable: true,
      }),
      { providerStatus: status },
    );
  }
  return errorFromStatus("anthropic", status);
}

// An error event mid-stream carries no HTTP status, only the error type. These are the
// statuses Anthropic uses for each type; anything else is treated as a server error.
const STATUS_BY_TYPE = {
  overloaded_error: 529,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
};

/** The HTTP status matching an error event's type, for mapAnthropicError. */
export function statusForErrorType(type) {
  return STATUS_BY_TYPE[type] ?? 500;
}
