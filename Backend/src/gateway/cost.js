const TOKENS_PER_PRICE_UNIT = 1_000_000;
const MICRO_DOLLARS_PER_USD = 1_000_000;

function assertTokenCount(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Cost of one request in integer micro-dollars (1 USD = 1,000,000).
 *
 *   cost = (inputTokens × inputPerMTok + outputTokens × outputPerMTok) / 1,000,000
 *
 * Prices are micro-dollars per million tokens (see config/models.js), so the product is
 * an exact integer and only the final division can produce a fraction. That fraction is
 * rounded once, half up, per request, which keeps every stored value an integer and
 * makes the total for N requests exact to within N × 0.5 micro-dollars.
 * Largest product: 10M tokens × $100/MTok ≈ 1e15, safely below 2^53.
 *
 * @param {{ inputTokens: number, outputTokens: number }} usage
 * @param {{ inputPerMTok: number, outputPerMTok: number }} pricing
 */
export function calculateCostMicroUsd({ inputTokens, outputTokens }, pricing) {
  assertTokenCount("inputTokens", inputTokens);
  assertTokenCount("outputTokens", outputTokens);

  const scaled = inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok;
  return Math.round(scaled / TOKENS_PER_PRICE_UNIT);
}

/**
 * What a request costs and what the cache saved, for the usage log.
 * A cache hit costs nothing; the provider cost it avoided is recorded as saved,
 * so the dashboard can show money saved by caching.
 */
export function costBreakdown(usage, pricing, { cached = false } = {}) {
  const providerCost = calculateCostMicroUsd(usage, pricing);
  return cached
    ? { costMicroUsd: 0, savedMicroUsd: providerCost }
    : { costMicroUsd: providerCost, savedMicroUsd: 0 };
}

/** Micro-dollars to the `costUsd` number in API responses. Display only; never sum these. */
export function microUsdToUsd(microUsd) {
  return microUsd / MICRO_DOLLARS_PER_USD;
}
