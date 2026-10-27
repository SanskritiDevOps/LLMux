import { logger as defaultLogger } from "../utils/logger.js";

/**
 * One circuit breaker per provider, with its state in Redis so every LLMux instance sees
 * the same thing (README section 14):
 *
 *   CLOSED ──(5 failures in 30 s)──► OPEN ──(after 30 s)──► HALF-OPEN
 *      ▲                                                       │
 *      └──────────────(the test request succeeds)──────────────┘
 *                      (the test request fails) ──► back to OPEN
 *
 *   closed     requests flow normally; failures are counted in a 30 s window
 *   open       the provider is skipped at once, so the fallback answers fast instead of
 *              every request first waiting for this provider to time out
 *   half-open  exactly one request, across every instance, tests whether it recovered
 *
 * Redis keys (all with an expiry, so a forgotten provider goes back to closed):
 *   cb:<provider>:failures  failures in the current window      expires with the window
 *   cb:<provider>:open      present while the circuit is open    expires after OPEN_MS
 *   cb:<provider>:tripped   the circuit opened and hasn't closed expires after TRIPPED_MS
 *   cb:<provider>:probe     the one test request in half-open    expires after PROBE_MS
 *
 * "open" expiring is what moves the circuit to half-open: no timer runs anywhere.
 *
 * If Redis is down, every provider counts as closed. The breaker exists to make
 * requests faster, so it must never be the reason a request fails.
 */

export const FAILURE_THRESHOLD = 5;
export const FAILURE_WINDOW_MS = 30_000;
export const OPEN_MS = 30_000;
// Long enough for one full request (the 60 s deadline); if the instance running the test
// request dies, the next request after this becomes the test request.
export const PROBE_MS = 60_000;
// A circuit nobody has tried for an hour is simply forgotten (closed).
export const TRIPPED_MS = 60 * 60_000;

export const STATES = Object.freeze({ CLOSED: "closed", OPEN: "open", HALF_OPEN: "half-open" });

const keysFor = (provider) => ({
  failures: `cb:${provider}:failures`,
  open: `cb:${provider}:open`,
  tripped: `cb:${provider}:tripped`,
  probe: `cb:${provider}:probe`,
});

/**
 * @param {{
 *   redis: import("ioredis").Redis,
 *   logger?: import("pino").Logger,
 *   failureThreshold?: number, windowMs?: number, openMs?: number, probeMs?: number,
 * }} options  the limits can be lowered in tests
 */
export function createCircuitBreaker({
  redis,
  logger = defaultLogger,
  failureThreshold = FAILURE_THRESHOLD,
  windowMs = FAILURE_WINDOW_MS,
  openMs = OPEN_MS,
  probeMs = PROBE_MS,
}) {
  /** Runs a Redis step; if Redis fails, logs it and returns `fallback` instead. */
  async function safely(action, fallback, step) {
    try {
      return await action();
    } catch (err) {
      logger.debug({ err, step }, "Circuit breaker unavailable (Redis); treating as closed");
      return fallback;
    }
  }

  async function open(provider, reason) {
    const keys = keysFor(provider);
    await Promise.all([
      redis.set(keys.open, "1", "PX", openMs),
      redis.set(keys.tripped, "1", "PX", TRIPPED_MS),
      redis.del(keys.failures, keys.probe),
    ]);
    logger.warn({ provider, openMs, reason }, "Circuit opened; skipping provider for now");
  }

  return {
    /**
     * Whether a request may go to `provider` now. In half-open, only the caller that
     * wins the probe gets `allowed: true`; everyone else is told to skip it.
     *
     * @returns {Promise<{ allowed: boolean, state: "closed" | "open" | "half-open" }>}
     */
    async allow(provider) {
      const keys = keysFor(provider);
      return safely(
        async () => {
          const [isOpen, tripped] = await Promise.all([
            redis.get(keys.open),
            redis.get(keys.tripped),
          ]);
          if (isOpen) return { allowed: false, state: STATES.OPEN };
          if (!tripped) return { allowed: true, state: STATES.CLOSED };
          // SET NX is atomic, so only one request across every instance becomes the probe.
          const won = await redis.set(keys.probe, "1", "PX", probeMs, "NX");
          return { allowed: won === "OK", state: STATES.HALF_OPEN };
        },
        { allowed: true, state: STATES.CLOSED },
        "allow",
      );
    },

    /**
     * The provider answered. After a test request, this closes the circuit.
     *
     * @param {string} provider
     * @param {"closed" | "half-open"} state  what allow() returned for this request
     */
    async recordSuccess(provider, state) {
      if (state !== STATES.HALF_OPEN) return;
      const keys = keysFor(provider);
      await safely(
        async () => {
          await redis.del(keys.tripped, keys.probe, keys.failures);
          logger.info({ provider }, "Circuit closed; provider recovered");
        },
        undefined,
        "recordSuccess",
      );
    },

    /**
     * The provider failed in a way that says it is unhealthy (see countsAsFailure).
     *
     * @param {string} provider
     * @param {"closed" | "half-open"} state  what allow() returned for this request
     */
    async recordFailure(provider, state) {
      const keys = keysFor(provider);
      await safely(
        async () => {
          if (state === STATES.HALF_OPEN) {
            await open(provider, "test request failed");
            return;
          }
          const failures = await redis.incr(keys.failures);
          // The window starts at the first failure, so 5 failures must fall within 30 s.
          if (failures === 1) await redis.pexpire(keys.failures, windowMs);
          if (failures >= failureThreshold) {
            await open(provider, `${failures} failures in ${windowMs / 1000} s`);
          }
        },
        undefined,
        "recordFailure",
      );
    },

    /** For the dashboard's provider health page (Day 13). */
    async state(provider) {
      const keys = keysFor(provider);
      return safely(
        async () => {
          const [isOpen, tripped, failures] = await Promise.all([
            redis.get(keys.open),
            redis.get(keys.tripped),
            redis.get(keys.failures),
          ]);
          const state = isOpen ? STATES.OPEN : tripped ? STATES.HALF_OPEN : STATES.CLOSED;
          return { state, recentFailures: Number(failures ?? 0) };
        },
        { state: STATES.CLOSED, recentFailures: 0 },
        "state",
      );
    },
  };
}

/**
 * Which failed attempts count against a provider's health: the ones that say the provider
 * itself is in trouble (timeouts, network errors, 429, 5xx: the retryable ones). A 400 is
 * the client's request; a 401 or 404 is our configuration. Neither means the provider is
 * down, so neither opens its circuit.
 *
 * @param {import("./errorPolicy.js").ErrorDecision} decision
 */
export function countsAsFailure(decision) {
  return decision.retry;
}

/** For code paths that don't use a breaker (tests, and the default gateway): always closed. */
export const noCircuitBreaker = Object.freeze({
  allow: async () => ({ allowed: true, state: STATES.CLOSED }),
  recordSuccess: async () => {},
  recordFailure: async () => {},
  state: async () => ({ state: STATES.CLOSED, recentFailures: 0 }),
});
