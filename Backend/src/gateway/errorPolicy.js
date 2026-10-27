import { GatewayError } from "../utils/errors.js";

/**
 * What to do after one attempt fails (README section 14):
 *
 *   error                                   retry same target?   fall back?
 *   TIMEOUT, PROVIDER_UNAVAILABLE (network) yes                  yes
 *   PROVIDER_RATE_LIMITED (429)             yes (Retry-After)    yes
 *   PROVIDER_ERROR, 5xx                     yes                  yes
 *   PROVIDER_ERROR, 401/402/403/404         no                   yes (401/403 also alert)
 *   INVALID_REQUEST (400)                   no                   no: the next provider would fail too
 *   anything else                           no                   no
 *
 * "Anything else" covers errors that aren't about the provider at all: UNKNOWN_MODEL, our
 * own UNAUTHORIZED or RATE_LIMITED, a bug (INTERNAL_ERROR or a plain Error), and the
 * client's own abort. None of those would be fixed by asking again or asking elsewhere.
 *
 * @typedef {Object} ErrorDecision
 * @property {boolean} retry     try the same target again (after a backoff)
 * @property {boolean} fallback  move on to the next target in the chain
 * @property {boolean} alert     our credentials for this provider were rejected
 */

// Failures of the provider or the path to it; another attempt or provider may succeed.
const PROVIDER_FAILURES = new Set([
  "TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_ERROR",
]);

const STOP = Object.freeze({ retry: false, fallback: false, alert: false });

/**
 * @param {unknown} err  whatever one attempt threw
 * @returns {ErrorDecision}
 */
export function classifyError(err) {
  if (!(err instanceof GatewayError) || !PROVIDER_FAILURES.has(err.code)) return STOP;

  return {
    // Each error already says whether the same call might succeed: a 503 or a timeout
    // might, a rejected key or a missing model won't (errorFromStatus and the adapters).
    retry: err.retryable,
    fallback: true,
    alert: err.providerStatus === 401 || err.providerStatus === 403,
  };
}
