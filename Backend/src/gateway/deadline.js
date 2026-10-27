import { GatewayError } from "../utils/errors.js";

/**
 * One request's overall time budget across every attempt: retries, their waits and
 * fallbacks together (REQUEST_DEADLINE_MS, 60 s by default). README section 14: "an
 * overall request deadline caps total time across retries and fallbacks".
 *
 * Each attempt still has its own limit (REQUEST_TIMEOUT_MS); timeoutFor() lowers it to
 * whatever is left, so the last attempt can't run past the deadline.
 *
 * @param {number} ms
 * @param {{ now?: () => number }} [options]  now is performance.now by default; tests pass a clock
 */
export function createDeadline(ms, { now = () => performance.now() } = {}) {
  const started = now();

  const remaining = () => Math.max(0, Math.round(ms - (now() - started)));

  return {
    ms,
    /** Milliseconds left, never negative. */
    remaining,
    expired: () => remaining() === 0,
    /** An attempt's timeout, never longer than the time left. */
    timeoutFor: (attemptTimeoutMs) => Math.min(attemptTimeoutMs, remaining()),
    /** Whether waiting `waitMs` and then trying again still leaves time to try. */
    allowsWait: (waitMs) => waitMs < remaining(),

    /**
     * The error for a request that ran out of time. Retryable: the client may well
     * succeed if it tries again later. The last attempt's error is kept as the cause,
     * for the logs.
     *
     * @param {{ attempts: number, lastError?: unknown }} details
     */
    error({ attempts, lastError }) {
      const tries = attempts === 1 ? "1 attempt" : `${attempts} attempts`;
      return new GatewayError(
        "TIMEOUT",
        `No provider answered within the ${ms} ms deadline (${tries})`,
        { provider: lastError?.provider ?? null, retryable: true, cause: lastError },
      );
    },
  };
}
