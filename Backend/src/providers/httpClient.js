import { env } from "../config/env.js";
import { GatewayError } from "../utils/errors.js";

/**
 * The one place LLMux calls providers over HTTP. Adapters build the request and parse
 * the result; this module only moves bytes, enforces the timeout and turns transport
 * failures into GatewayErrors. Streaming reads are added with SSE (Day 7).
 *
 * Outcomes:
 *   - any HTTP response (2xx or not) → resolved { ok, status, headers, body, durationMs };
 *     non-2xx bodies are handed to adapter.mapError, which knows the provider's format
 *   - the timeout fires              → GatewayError TIMEOUT (retryable)
 *   - provider unreachable           → GatewayError PROVIDER_UNAVAILABLE (retryable)
 *   - the caller aborts (client left) → the AbortError is rethrown unchanged, because it
 *     is not a provider failure and must not trigger retries or fallback
 */

/**
 * @param {import("./adapter.js").ProviderRequest} request
 * @param {{ provider: string, timeoutMs?: number, signal?: AbortSignal }} options
 */
export async function sendRequest(
  { url, method = "POST", headers = {}, body },
  { provider, timeoutMs = env.REQUEST_TIMEOUT_MS, signal },
) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const started = performance.now();

  try {
    // The signal also covers reading the body, so a provider that sends headers and then
    // stalls still hits the timeout.
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
    });
    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      body: parseBody(text, response.headers.get("content-type")),
      durationMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    if (signal?.aborted) throw err;

    if (timeout.aborted) {
      throw new GatewayError("TIMEOUT", `${provider} did not respond within ${timeoutMs} ms`, {
        provider,
        cause: err,
      });
    }
    throw new GatewayError("PROVIDER_UNAVAILABLE", `Could not reach ${provider}`, {
      provider,
      cause: err,
    });
  }
}

/** JSON when it parses, otherwise the raw text (error pages are often HTML or plain text). */
function parseBody(text, contentType) {
  if (text === "") return null;
  if (contentType?.includes("json") || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      // Fall through: a body that claims JSON but is truncated is returned as text,
      // and the adapter treats it as an unexpected response.
    }
  }
  return text;
}
