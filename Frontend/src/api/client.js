/**
 * The one way the dashboard talks to the LLMux API.
 *
 * - Every call sends the session cookie (credentials: "include"); the API allows the
 *   dashboard's origin with credentials.
 * - Every failure becomes an ApiError with the API's own code, message and requestId, so
 *   any error shown on screen can be traced in the server logs.
 */

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:5000";

export class ApiError extends Error {
  constructor({ status, code, message, requestId = null }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** Query values that are undefined, null or "" are left out, so filters can be optional. */
export function apiUrl(path, query = {}) {
  const url = new URL(path, API_URL);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(name, String(value));
    }
  }
  return url;
}

/**
 * @param {string} path  e.g. "/api/keys"
 * @param {{ method?: string, body?: unknown, query?: Record<string, unknown>,
 *   signal?: AbortSignal }} [options]
 * @returns {Promise<any>} the parsed JSON body, or null for 204
 */
export async function api(path, { method = "GET", body, query, signal } = {}) {
  let res;
  try {
    res = await fetch(apiUrl(path, query), {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: "Can't reach the LLMux server. Check that it is running.",
    });
  }
  return readResponse(res);
}

/** Turns a fetch Response into its JSON body, or throws the API's error as an ApiError. */
export async function readResponse(res) {
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError({
      status: res.status,
      code: data?.error?.code ?? "HTTP_ERROR",
      message: data?.error?.message ?? `The server answered ${res.status}`,
      requestId: data?.error?.requestId ?? res.headers.get("X-Request-Id"),
    });
  }
  return data;
}
