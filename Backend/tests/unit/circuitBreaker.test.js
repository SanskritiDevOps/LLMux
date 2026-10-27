import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILURE_WINDOW_MS,
  OPEN_MS,
  STATES,
  countsAsFailure,
  createCircuitBreaker,
  noCircuitBreaker,
} from "../../src/gateway/circuitBreaker.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeRedis } from "../helpers/fakeRedis.js";

// The breaker against an in-memory Redis whose expiry follows Date.now(), so fake timers
// move it: closed → open → half-open → closed, as in README section 14.
let redis;
let logs;
let breaker;

beforeEach(() => {
  vi.useFakeTimers();
  redis = fakeRedis();
  logs = captureLogs();
  breaker = createCircuitBreaker({ redis, logger: logs.logger });
});

afterEach(() => {
  vi.useRealTimers();
});

async function fail(times, provider = "gemini") {
  for (let i = 0; i < times; i += 1) await breaker.recordFailure(provider, STATES.CLOSED);
}

describe("createCircuitBreaker", () => {
  it("starts closed: requests are allowed", async () => {
    expect(await breaker.allow("gemini")).toEqual({ allowed: true, state: "closed" });
    expect(await breaker.state("gemini")).toEqual({ state: "closed", recentFailures: 0 });
  });

  it("stays closed after 4 failures, and opens on the 5th", async () => {
    await fail(4);
    expect(await breaker.allow("gemini")).toEqual({ allowed: true, state: "closed" });

    await fail(1);

    expect(await breaker.allow("gemini")).toEqual({ allowed: false, state: "open" });
    expect(logs.lines.find((line) => line.msg.startsWith("Circuit opened"))).toMatchObject({
      provider: "gemini",
      reason: "5 failures in 30 s",
    });
  });

  it("only counts failures within 30 seconds of the first", async () => {
    await fail(4);
    vi.advanceTimersByTime(FAILURE_WINDOW_MS + 1);
    await fail(4);

    expect(await breaker.allow("gemini")).toEqual({ allowed: true, state: "closed" });
    expect((await breaker.state("gemini")).recentFailures).toBe(4);
  });

  it("keeps each provider's circuit separate", async () => {
    await fail(5, "gemini");

    expect((await breaker.allow("gemini")).allowed).toBe(false);
    expect((await breaker.allow("ollama")).allowed).toBe(true);
  });

  it("goes half-open after 30 seconds and lets exactly one test request through", async () => {
    await fail(5);
    vi.advanceTimersByTime(OPEN_MS + 1);

    const first = await breaker.allow("gemini");
    const second = await breaker.allow("gemini");

    expect(first).toEqual({ allowed: true, state: "half-open" });
    expect(second).toEqual({ allowed: false, state: "half-open" });
    expect((await breaker.state("gemini")).state).toBe("half-open");
  });

  it("closes when the test request succeeds", async () => {
    await fail(5);
    vi.advanceTimersByTime(OPEN_MS + 1);
    const probe = await breaker.allow("gemini");

    await breaker.recordSuccess("gemini", probe.state);

    expect(await breaker.allow("gemini")).toEqual({ allowed: true, state: "closed" });
    expect(await breaker.state("gemini")).toEqual({ state: "closed", recentFailures: 0 });
    expect(logs.lines.some((line) => line.msg === "Circuit closed; provider recovered")).toBe(true);
  });

  it("re-opens for another 30 seconds when the test request fails", async () => {
    await fail(5);
    vi.advanceTimersByTime(OPEN_MS + 1);
    const probe = await breaker.allow("gemini");

    await breaker.recordFailure("gemini", probe.state);

    expect(await breaker.allow("gemini")).toEqual({ allowed: false, state: "open" });
    expect(logs.lines.find((line) => line.reason === "test request failed")).toBeTruthy();
    vi.advanceTimersByTime(OPEN_MS + 1);
    expect(await breaker.allow("gemini")).toEqual({ allowed: true, state: "half-open" });
  });

  it("lets another request test the provider if the first test request never reported back", async () => {
    await fail(5);
    vi.advanceTimersByTime(OPEN_MS + 1);
    await breaker.allow("gemini");

    vi.advanceTimersByTime(60_001);

    expect(await breaker.allow("gemini")).toEqual({ allowed: true, state: "half-open" });
  });

  it("does not reset the failure count on an ordinary success", async () => {
    await fail(4);
    await breaker.recordSuccess("gemini", STATES.CLOSED);
    await fail(1);

    expect((await breaker.allow("gemini")).allowed).toBe(false);
  });

  it("never blocks requests when Redis is down: every provider counts as closed", async () => {
    const broken = createCircuitBreaker({
      redis: fakeRedis({ failing: true }),
      logger: logs.logger,
    });

    expect(await broken.allow("gemini")).toEqual({ allowed: true, state: "closed" });
    await expect(broken.recordFailure("gemini", STATES.CLOSED)).resolves.toBeUndefined();
    await expect(broken.recordSuccess("gemini", STATES.HALF_OPEN)).resolves.toBeUndefined();
    expect(await broken.state("gemini")).toEqual({ state: "closed", recentFailures: 0 });
  });

  it("uses one set of keys per provider, all with an expiry", async () => {
    await fail(5);
    vi.advanceTimersByTime(OPEN_MS + 1);
    await breaker.allow("gemini");

    const keys = [...redis.store.keys()].sort();
    expect(keys).toEqual(["cb:gemini:probe", "cb:gemini:tripped"]);
    for (const key of keys) expect(redis.store.get(key).expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("countsAsFailure", () => {
  it("counts only the failures that say the provider itself is unhealthy", () => {
    expect(countsAsFailure({ retry: true, fallback: true })).toBe(true);
    expect(countsAsFailure({ retry: false, fallback: true, alert: true })).toBe(false);
    expect(countsAsFailure({ retry: false, fallback: false })).toBe(false);
  });
});

describe("noCircuitBreaker", () => {
  it("always allows, and ignores what it is told", async () => {
    await noCircuitBreaker.recordFailure("gemini", STATES.CLOSED);

    expect(await noCircuitBreaker.allow("gemini")).toEqual({ allowed: true, state: "closed" });
  });
});
