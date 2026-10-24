import { env } from "../config/env.js";
import { GatewayError } from "../utils/errors.js";

/**
 * The one place LLMux calls providers over HTTP. Adapters build the request and parse
 * the result; this module only moves bytes, enforces the timeout and turns transport
 * failures into GatewayErrors. sendRequest() reads a whole answer; openStream() hands back
 * a streamed one as it arrives.
 *
 * Outcomes (both functions):
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

/**
 * Opens a streamed request. A 2xx resolves as soon as the headers arrive, with `chunks`:
 * the body as an async iterable of bytes. Anything else is read whole, exactly like
 * sendRequest(), so adapter.mapError sees the same { status, body }.
 *
 * `timeoutMs` is an idle limit, not a total one: it covers waiting for the headers and
 * then each gap between chunks. A long answer that keeps arriving is never cut off; a
 * provider that goes silent mid-stream is. Errors while reading the chunks follow the
 * same outcomes as above (TIMEOUT, PROVIDER_UNAVAILABLE, or the caller's AbortError).
 * Stopping early (break, or return() on the iterator) cancels the upstream request.
 *
 * @param {import("./adapter.js").ProviderRequest} request
 * @param {{ provider: string, timeoutMs?: number, signal?: AbortSignal }} options
 */
export async function openStream(
  { url, method = "POST", headers = {}, body },
  { provider, timeoutMs = env.REQUEST_TIMEOUT_MS, signal },
) {
  const upstream = new AbortController();
  const combined = signal ? AbortSignal.any([signal, upstream.signal]) : upstream.signal;
  let timedOut = false;
  let timer;
  const restartIdleTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      upstream.abort();
    }, timeoutMs);
  };

  const toGatewayError = (err) => {
    if (signal?.aborted) return err;
    if (timedOut) {
      return new GatewayError("TIMEOUT", `${provider} went silent for ${timeoutMs} ms`, {
        provider,
        cause: err,
      });
    }
    return new GatewayError("PROVIDER_UNAVAILABLE", `Lost the connection to ${provider}`, {
      provider,
      cause: err,
    });
  };

  const started = performance.now();
  restartIdleTimer();
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    clearTimeout(timer);
    if (signal?.aborted) throw err;
    if (timedOut) {
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

  const result = {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    durationMs: Math.round(performance.now() - started),
  };

  if (!response.ok) {
    try {
      const text = await response.text();
      return { ...result, body: parseBody(text, response.headers.get("content-type")) };
    } catch (err) {
      throw toGatewayError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  async function* chunks() {
    const reader = response.body.getReader();
    let finished = false;
    try {
      while (true) {
        let next;
        try {
          next = await reader.read();
        } catch (err) {
          throw toGatewayError(err);
        }
        if (next.done) {
          finished = true;
          return;
        }
        restartIdleTimer();
        yield next.value;
      }
    } finally {
      clearTimeout(timer);
      if (!finished) {
        // The consumer stopped early or reading failed: close the upstream connection
        // so the provider stops generating tokens nobody will read.
        upstream.abort();
        reader.releaseLock();
      }
    }
  }

  return { ...result, body: null, chunks: chunks() };
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
