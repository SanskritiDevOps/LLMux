import { GatewayError } from "../../utils/errors.js";
import { errorFromStatus } from "../adapter.js";

const PROVIDER = "ollama";

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
