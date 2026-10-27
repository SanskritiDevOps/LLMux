import { PROVIDERS } from "../config/models.js";
import { GatewayError } from "../utils/errors.js";
import { STREAM_FORMATS } from "./streamReader.js";

/**
 * The contract every provider adapter implements. Adapters are pure translation code:
 * they never read env, call the network, log, or know about keys, users or caching.
 * The gateway passes everything they need in, and the shared HTTP client does the I/O.
 *
 * @typedef {import("zod").infer<typeof import("../gateway/schemas.js").ChatRequestSchema>} UnifiedRequest
 *
 * @typedef {Object} Target  one entry from resolveModel().targets
 * @property {string} provider
 * @property {string} model
 *
 * @typedef {Object} RequestContext
 * @property {number} maxTokens  already capped for this target (see maxTokensFor)
 * @property {string} [apiKey]
 * @property {string} [baseUrl]  overrides the adapter's defaultBaseUrl (tests, proxies)
 *
 * @typedef {Object} ProviderRequest
 * @property {string} url
 * @property {"POST"} method
 * @property {Record<string, string>} headers
 * @property {object} body  JSON-serialisable
 *
 * @typedef {Object} ParsedResponse  the provider-specific part of a unified response;
 *   the gateway adds id, model, provider, latency and cost
 * @property {string} content
 * @property {"stop" | "length" | "content_filter" | "error"} finishReason
 * @property {{ inputTokens: number, outputTokens: number, totalTokens: number }} usage
 * @property {boolean} usageEstimated
 *
 * @typedef {Object} ProviderErrorResponse
 * @property {number} status
 * @property {unknown} body  parsed JSON when possible, otherwise text
 *
 * @typedef {Object} ProviderStreamEvent  what parseStreamChunk returns; the gateway turns
 *   these into the client's start / delta / end events
 * @property {"delta" | "usage" | "finish"} type
 * @property {string} [text]  delta: the next piece of the answer (never empty)
 * @property {ParsedResponse["usage"]} [usage]  usage: the latest totals (the last one wins)
 * @property {ParsedResponse["finishReason"]} [finishReason]  finish: why the answer ended
 *
 * @typedef {Object} ProviderAdapter
 * @property {string} name  one of PROVIDERS
 * @property {string} defaultBaseUrl
 * @property {(request: UnifiedRequest, target: Target, context: RequestContext) => ProviderRequest} buildRequest
 * @property {(json: unknown) => ParsedResponse} parseResponse
 * @property {(response: ProviderErrorResponse) => GatewayError} mapError
 * @property {"sse" | "ndjson"} [streamFormat]  how the provider frames its stream
 * @property {(raw: string) => ProviderStreamEvent[]} [parseStreamChunk]  one complete
 *   payload (an SSE event's data, or one NDJSON line) → events; throws a GatewayError when
 *   the provider reports an error mid-stream
 */

const REQUIRED_FUNCTIONS = ["buildRequest", "parseResponse", "mapError"];

/**
 * Checks an adapter has the required shape and freezes it, so a missing function
 * fails when the module loads instead of in the middle of a request.
 *
 * @param {ProviderAdapter} adapter
 * @returns {Readonly<ProviderAdapter>}
 */
export function defineAdapter(adapter) {
  if (!PROVIDERS.includes(adapter?.name)) {
    throw new TypeError(
      `Adapter name must be one of ${PROVIDERS.join(", ")}, got ${adapter?.name}`,
    );
  }
  if (typeof adapter.defaultBaseUrl !== "string" || !URL.canParse(adapter.defaultBaseUrl)) {
    throw new TypeError(`Adapter "${adapter.name}" needs a valid defaultBaseUrl`);
  }
  for (const fn of REQUIRED_FUNCTIONS) {
    if (typeof adapter[fn] !== "function") {
      throw new TypeError(`Adapter "${adapter.name}" is missing ${fn}()`);
    }
  }
  if (adapter.parseStreamChunk !== undefined && typeof adapter.parseStreamChunk !== "function") {
    throw new TypeError(`Adapter "${adapter.name}": parseStreamChunk must be a function`);
  }
  if (adapter.parseStreamChunk && !STREAM_FORMATS.includes(adapter.streamFormat)) {
    throw new TypeError(
      `Adapter "${adapter.name}" streams, so streamFormat must be one of ${STREAM_FORMATS.join(", ")}`,
    );
  }
  return Object.freeze({ ...adapter });
}

/**
 * The default mapping from a provider's HTTP status to a unified error, shared by all
 * adapters. Adapters call it after handling their own quirks. Messages are generic on
 * purpose: raw provider bodies can contain internal details and are only logged.
 *
 * Retry and fallback follow README section 14:
 *   400          INVALID_REQUEST        no retry, no fallback (the next provider would fail too)
 *   401/402/403  PROVIDER_ERROR         no retry, fallback (our key or account is the problem)
 *   404          PROVIDER_ERROR         no retry, fallback (model missing at this provider)
 *   408/504      TIMEOUT                retry
 *   429          PROVIDER_RATE_LIMITED  retry
 *   503          PROVIDER_UNAVAILABLE   retry
 *   other 5xx    PROVIDER_ERROR         retry
 *   other 4xx    PROVIDER_ERROR         no retry, fallback
 *
 * The provider's own status is kept as `providerStatus`, so the gateway can tell, for
 * example, a rejected API key (401/403, worth an alert) from other provider errors.
 *
 * @param {string} provider
 * @param {number} status
 */
export function errorFromStatus(provider, status) {
  const make = (code, message, retryable) =>
    Object.assign(new GatewayError(code, message, { provider, retryable }), {
      providerStatus: status,
    });

  if (status === 400) {
    return make("INVALID_REQUEST", `${provider} rejected the request as invalid`, false);
  }
  if (status === 401 || status === 403) {
    return make("PROVIDER_ERROR", `${provider} rejected the server's credentials`, false);
  }
  if (status === 402) {
    return make("PROVIDER_ERROR", `${provider} account has no remaining credit`, false);
  }
  if (status === 404) {
    return make("PROVIDER_ERROR", `${provider} does not have the requested model`, false);
  }
  if (status === 408 || status === 504) {
    return make("TIMEOUT", `${provider} timed out`, true);
  }
  if (status === 429) {
    return make("PROVIDER_RATE_LIMITED", `${provider} rate limit reached`, true);
  }
  if (status === 503) {
    return make("PROVIDER_UNAVAILABLE", `${provider} is temporarily unavailable`, true);
  }
  if (status >= 500) {
    return make("PROVIDER_ERROR", `${provider} returned a server error (${status})`, true);
  }
  return make("PROVIDER_ERROR", `${provider} returned an unexpected error (${status})`, false);
}
