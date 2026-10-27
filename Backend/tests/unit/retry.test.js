import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, retryAfterMs, sleep } from "../../src/gateway/retry.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("backoffDelay", () => {
  it("is about 250 ms, then about 500 ms (README section 14)", () => {
    const middle = () => 0.5;

    expect(backoffDelay(1, { random: middle })).toBe(250);
    expect(backoffDelay(2, { random: middle })).toBe(500);
    expect(backoffDelay(3, { random: middle })).toBe(1000);
  });

  it("spreads each wait over half to one and a half times its base", () => {
    expect(backoffDelay(1, { random: () => 0 })).toBe(125);
    expect(backoffDelay(1, { random: () => 0.999999 })).toBe(375);
    expect(backoffDelay(2, { random: () => 0 })).toBe(250);
    expect(backoffDelay(2, { random: () => 0.999999 })).toBe(750);
  });

  it("gives different waits to clients that fail at the same moment", () => {
    const waits = new Set(Array.from({ length: 50 }, () => backoffDelay(1)));

    expect(waits.size).toBeGreaterThan(10);
    for (const wait of waits) {
      expect(wait).toBeGreaterThanOrEqual(125);
      expect(wait).toBeLessThanOrEqual(375);
    }
  });

  it("never waits longer than the ceiling", () => {
    expect(backoffDelay(10, { random: () => 0.999999 })).toBe(4000);
    expect(backoffDelay(3, { maxMs: 600, random: () => 0.5 })).toBe(600);
  });

  it.each([0, -1, 1.5, "1"])("rejects retry number %s", (retry) => {
    expect(() => backoffDelay(retry)).toThrow(RangeError);
  });
});

describe("retryAfterMs", () => {
  const headers = (value) => new Headers(value === undefined ? {} : { "retry-after": value });
  const now = Date.parse("2026-10-26T10:00:00Z");

  it("reads seconds", () => {
    expect(retryAfterMs(headers("7"), now)).toBe(7000);
    expect(retryAfterMs(headers(" 0 "), now)).toBe(0);
  });

  it("reads an HTTP date", () => {
    expect(retryAfterMs(headers("Mon, 26 Oct 2026 10:00:30 GMT"), now)).toBe(30_000);
  });

  it("never returns a negative wait for a date in the past", () => {
    expect(retryAfterMs(headers("Mon, 26 Oct 2026 09:00:00 GMT"), now)).toBe(0);
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["nonsense", "soon"],
    ["a negative number", "-5"],
    ["a fraction", "1.5"],
  ])("returns null for %s", (_label, value) => {
    expect(retryAfterMs(headers(value), now)).toBeNull();
  });

  it("returns null without headers at all", () => {
    expect(retryAfterMs(undefined)).toBeNull();
  });
});

describe("sleep", () => {
  it("resolves after the wait", async () => {
    vi.useFakeTimers();
    let done = false;
    const waiting = sleep(250).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
  });

  it("stops waiting as soon as the client leaves, with the abort's reason", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = sleep(10_000, controller.signal);

    controller.abort(new Error("client left"));

    await expect(waiting).rejects.toThrow("client left");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects at once if the client has already left", async () => {
    await expect(sleep(10_000, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  });
});
