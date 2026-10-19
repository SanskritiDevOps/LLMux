import { describe, expect, it } from "vitest";
import { modelConfig } from "../../src/config/models.js";
import { calculateCostMicroUsd, costBreakdown, microUsdToUsd } from "../../src/gateway/cost.js";

// $0.30 input and $2.50 output per million tokens.
const flash = { inputPerMTok: 300_000, outputPerMTok: 2_500_000 };
const free = { inputPerMTok: 0, outputPerMTok: 0 };

describe("calculateCostMicroUsd", () => {
  it("prices one million tokens at exactly the per-MTok price", () => {
    expect(calculateCostMicroUsd({ inputTokens: 1_000_000, outputTokens: 0 }, flash)).toBe(300_000);
    expect(calculateCostMicroUsd({ inputTokens: 0, outputTokens: 1_000_000 }, flash)).toBe(
      2_500_000,
    );
  });

  it("adds input and output costs", () => {
    // 42 × 300,000 + 310 × 2,500,000 = 787,600,000 → 787.6 → 788 micro-dollars
    expect(calculateCostMicroUsd({ inputTokens: 42, outputTokens: 310 }, flash)).toBe(788);
  });

  it("always returns an integer", () => {
    for (const tokens of [1, 7, 333, 12_345]) {
      expect(
        Number.isInteger(
          calculateCostMicroUsd({ inputTokens: tokens, outputTokens: tokens }, flash),
        ),
      ).toBe(true);
    }
  });

  it("rounds half up once per request", () => {
    // 5 output tokens × $0.10/MTok = 0.5 micro-dollars → 1
    expect(
      calculateCostMicroUsd(
        { inputTokens: 0, outputTokens: 5 },
        { inputPerMTok: 0, outputPerMTok: 100_000 },
      ),
    ).toBe(1);
    // 4 tokens = 0.4 → 0
    expect(
      calculateCostMicroUsd(
        { inputTokens: 0, outputTokens: 4 },
        { inputPerMTok: 0, outputPerMTok: 100_000 },
      ),
    ).toBe(0);
  });

  it("avoids floating-point drift that dollar math would have", () => {
    // In dollars, 0.1 + 0.2 !== 0.3. In micro-dollar integers the sum is exact.
    const a = calculateCostMicroUsd(
      { inputTokens: 100_000, outputTokens: 0 },
      { inputPerMTok: 1_000_000, outputPerMTok: 0 },
    );
    const b = calculateCostMicroUsd(
      { inputTokens: 200_000, outputTokens: 0 },
      { inputPerMTok: 1_000_000, outputPerMTok: 0 },
    );

    expect(a + b).toBe(300_000);
  });

  it("costs nothing for local models", () => {
    expect(calculateCostMicroUsd({ inputTokens: 50_000, outputTokens: 50_000 }, free)).toBe(0);
  });

  it("handles very large requests without losing precision", () => {
    // 10M output tokens at $100/MTok = $1,000 exactly
    expect(
      calculateCostMicroUsd(
        { inputTokens: 0, outputTokens: 10_000_000 },
        { inputPerMTok: 0, outputPerMTok: 100_000_000 },
      ),
    ).toBe(1_000_000_000);
  });

  it.each([
    ["negative", { inputTokens: -1, outputTokens: 0 }],
    ["fractional", { inputTokens: 1.5, outputTokens: 0 }],
    ["missing", { outputTokens: 0 }],
  ])("rejects %s token counts", (_label, usage) => {
    expect(() => calculateCostMicroUsd(usage, flash)).toThrow(TypeError);
  });

  it("works with every price in the shipped catalog", () => {
    for (const price of Object.values(modelConfig.catalog)) {
      expect(
        Number.isInteger(calculateCostMicroUsd({ inputTokens: 1234, outputTokens: 567 }, price)),
      ).toBe(true);
    }
  });
});

describe("costBreakdown", () => {
  const usage = { inputTokens: 42, outputTokens: 310 };

  it("charges the provider cost for a normal request", () => {
    expect(costBreakdown(usage, flash)).toEqual({ costMicroUsd: 788, savedMicroUsd: 0 });
  });

  it("charges nothing for a cache hit and records what it saved", () => {
    expect(costBreakdown(usage, flash, { cached: true })).toEqual({
      costMicroUsd: 0,
      savedMicroUsd: 788,
    });
  });

  it("saves nothing when a cached answer came from a free local model", () => {
    expect(costBreakdown(usage, free, { cached: true })).toEqual({
      costMicroUsd: 0,
      savedMicroUsd: 0,
    });
  });
});

describe("microUsdToUsd", () => {
  it("converts to dollars for API responses", () => {
    expect(microUsdToUsd(788)).toBe(0.000788);
    expect(microUsdToUsd(1_500_000)).toBe(1.5);
    expect(microUsdToUsd(0)).toBe(0);
  });
});
