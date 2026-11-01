import { GatewayError } from "../../utils/errors.js";
import { errorFromStatus } from "../adapter.js";

// Reference: https://console.groq.com/docs/errors

const PROVIDER = "groq";

/**
 * Groq's error body is { error: { message, type } }. The status decides the error, as for
 * every provider, except Groq's own 498 "Flex Tier Capacity Exceeded": Groq is busy, and
 * says to try again later, so it's treated like a 503. Groq's message is never forwarded.
 *
 * @param {import("../adapter.js").ProviderErrorResponse} response
 */
export function mapGroqError({ status }) {
  if (status === 498) {
    return Object.assign(
      new GatewayError("PROVIDER_UNAVAILABLE", "groq is temporarily over capacity", {
        provider: PROVIDER,
        retryable: true,
      }),
      { providerStatus: status },
    );
  }
  return errorFromStatus(PROVIDER, status);
}
