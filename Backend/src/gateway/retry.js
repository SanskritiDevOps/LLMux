/**
 * Timing for retries (README section 14): "wait about 250 ms, then 500 ms, each with a
 * random offset so many clients don't retry at the same instant".
 */

export const BASE_DELAY_MS = 250;
// A ceiling for the exponential growth, if MAX_RETRIES is ever raised well above 2.
export const MAX_DELAY_MS = 4_000;

/**
 * The wait before retry number `retry` (1 for the first retry): BASE × 2^(retry − 1),
 * spread randomly over half to one and a half times that, then capped.
 *
 *   retry 1  →  125–375 ms (about 250)
 *   retry 2  →  250–750 ms (about 500)
 *
 * The spread ("jitter") matters when a provider has a hiccup: every client that failed at
 * the same moment would otherwise retry at the same moment, and fail together again.
 *
 * @param {number} retry  1-based
 * @param {{ baseMs?: number, maxMs?: number, random?: () => number }} [options]
 *   random is Math.random by default; tests pass a fixed value
 */
export function backoffDelay(
  retry,
  { baseMs = BASE_DELAY_MS, maxMs = MAX_DELAY_MS, random = Math.random } = {},
) {
  if (!Number.isInteger(retry) || retry < 1) {
    throw new RangeError(`retry must be a whole number from 1, got ${retry}`);
  }
  const exponential = baseMs * 2 ** (retry - 1);
  return Math.round(Math.min(maxMs, exponential * (0.5 + random())));
}

/**
 * Reads a provider's Retry-After header (RFC 9110 section 10.2.3): either seconds, or an
 * HTTP date. Returns milliseconds to wait, or null when the header is missing or unreadable.
 *
 * @param {Headers | undefined} headers
 * @param {number} [now]  Date.now(), for tests
 */
export function retryAfterMs(headers, now = Date.now()) {
  const value = headers?.get?.("retry-after")?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  // An HTTP date always names its day and month ("Mon, 26 Oct 2026 …"). Without this
  // check, Date.parse would read values like "-5" or "1.5" as years.
  if (!/[a-z]{3}/i.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * Waits `ms`, unless `signal` aborts first (the client left), in which case it rejects
 * with the signal's reason straight away instead of finishing the wait.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
