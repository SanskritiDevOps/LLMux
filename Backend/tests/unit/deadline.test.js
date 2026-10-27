import { describe, expect, it } from "vitest";
import { createDeadline } from "../../src/gateway/deadline.js";
import { GatewayError } from "../../src/utils/errors.js";

/** A clock the test moves by hand. */
function clock(start = 1_000) {
  let time = start;
  return { now: () => time, advance: (ms) => (time += ms) };
}

describe("createDeadline", () => {
  it("counts down from the budget", () => {
    const time = clock();
    const deadline = createDeadline(60_000, { now: time.now });

    expect(deadline.remaining()).toBe(60_000);
    time.advance(15_000);
    expect(deadline.remaining()).toBe(45_000);
    expect(deadline.expired()).toBe(false);
  });

  it("expires at zero and never goes negative", () => {
    const time = clock();
    const deadline = createDeadline(1_000, { now: time.now });

    time.advance(5_000);

    expect(deadline.remaining()).toBe(0);
    expect(deadline.expired()).toBe(true);
  });

  it("shortens an attempt's timeout to the time left", () => {
    const time = clock();
    const deadline = createDeadline(60_000, { now: time.now });

    expect(deadline.timeoutFor(30_000)).toBe(30_000);
    time.advance(45_000);
    expect(deadline.timeoutFor(30_000)).toBe(15_000);
  });

  it("only allows a wait that leaves time for another attempt", () => {
    const time = clock();
    const deadline = createDeadline(1_000, { now: time.now });
    time.advance(700);

    expect(deadline.allowsWait(250)).toBe(true);
    expect(deadline.allowsWait(300)).toBe(false);
    expect(deadline.allowsWait(5_000)).toBe(false);
  });

  it("builds a retryable TIMEOUT that keeps the last attempt's error", () => {
    const lastError = new GatewayError("PROVIDER_UNAVAILABLE", "Could not reach ollama", {
      provider: "ollama",
    });
    const error = createDeadline(60_000).error({ attempts: 4, lastError });

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({
      code: "TIMEOUT",
      status: 504,
      retryable: true,
      provider: "ollama",
      message: "No provider answered within the 60000 ms deadline (4 attempts)",
    });
    expect(error.cause).toBe(lastError);
  });

  it("says '1 attempt', and works without a last error", () => {
    const error = createDeadline(500).error({ attempts: 1 });

    expect(error.message).toBe("No provider answered within the 500 ms deadline (1 attempt)");
    expect(error.provider).toBeNull();
  });

  it("uses the real clock by default", async () => {
    const deadline = createDeadline(10_000);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(deadline.remaining()).toBeLessThan(10_000);
    expect(deadline.remaining()).toBeGreaterThan(5_000);
  });
});
