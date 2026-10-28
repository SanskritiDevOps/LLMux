import { GatewayError } from "../../utils/errors.js";
import { errorFromStatus } from "../adapter.js";

/**
 * OpenAI errors → GatewayError.
 * Reference: https://platform.openai.com/docs/guides/error-codes
 *
 * OpenAI's error body is { error: { message, type, param, code } }. The status decides
 * most cases (errorFromStatus), with two exceptions where the status says the wrong thing:
 *
 *   429 insufficient_quota          the account is out of credit: waiting won't help, so
 *                                   no retry, but another provider can still answer
 *   400 unsupported_parameter /     a setting this model doesn't take (for example a
 *       unsupported_value           temperature on a reasoning model): the client's request
 *                                   is valid, so another provider may answer it
 *
 * OpenAI's own message is never forwarded; the gateway logs it.
 *
 * @param {import("../adapter.js").ProviderErrorResponse} response
 */
export function mapOpenAIError({ status, body }) {
  const code = body && typeof body === "object" ? body.error?.code : undefined;

  if (status === 429 && code === "insufficient_quota") {
    return new GatewayError("PROVIDER_ERROR", "openai account has no remaining credit", {
      provider: "openai",
      retryable: false,
    });
  }
  if (status === 400 && (code === "unsupported_parameter" || code === "unsupported_value")) {
    return new GatewayError(
      "PROVIDER_ERROR",
      "openai does not support a setting in this request for this model",
      { provider: "openai", retryable: false },
    );
  }
  return errorFromStatus("openai", status);
}
