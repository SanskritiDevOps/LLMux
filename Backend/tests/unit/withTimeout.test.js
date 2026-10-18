import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimeoutError, withTimeout } from "../../src/utils/withTimeout.js";

describe("withTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves with the value when the promise settles in time", async () => {
    const result = withTimeout(Promise.resolve("PONG"), 1000);

    await expect(result).resolves.toBe("PONG");
  });

  it("passes the original rejection through", async () => {
    const result = withTimeout(Promise.reject(new Error("refused")), 1000);

    await expect(result).rejects.toThrow("refused");
  });

  it("rejects with TimeoutError when the promise is too slow", async () => {
    const result = withTimeout(new Promise(() => {}), 1000);
    const assertion = expect(result).rejects.toBeInstanceOf(TimeoutError);

    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
  });

  it("clears its timer once the promise settles", async () => {
    await withTimeout(Promise.resolve(), 1000);

    expect(vi.getTimerCount()).toBe(0);
  });
});
