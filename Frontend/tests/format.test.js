import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatBucket,
  formatMs,
  formatPercent,
  formatRelative,
  formatUsd,
} from "../src/lib/format.js";

describe("formatUsd", () => {
  it.each([
    [0, "$0.00"],
    [null, "$0.00"],
    // A cheap request costs a fraction of a cent; rounding it to $0.00 would hide it.
    [0.000053, "$0.000053"],
    [0.0012345, "$0.00123"],
    [4.202, "$4.20"],
    [1234.5, "$1,234.50"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatUsd(value)).toBe(expected);
  });
});

describe("formatMs", () => {
  it.each([
    [null, "—"],
    [undefined, "—"],
    [5.4, "5 ms"],
    [999.4, "999 ms"],
    [1830, "1.83 s"],
    [60_000, "60 s"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatMs(value)).toBe(expected);
  });
});

describe("formatPercent", () => {
  it.each([
    [0, "0%"],
    [0.25, "25%"],
    [1 / 3, "33.3%"],
    [1, "100%"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatPercent(value)).toBe(expected);
  });
});

describe("formatRelative", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [null, "Never"],
    [-20_000, "just now"],
    [-3 * 60_000, "3 minutes ago"],
    [-60 * 60_000, "1 hour ago"],
    [-24 * 60 * 60_000, "yesterday"],
    [-3 * 24 * 60 * 60_000, "3 days ago"],
  ])("formats %s ms from now as %s", (offset, expected) => {
    vi.useFakeTimers({ now: new Date("2026-10-30T12:00:00Z") });
    const value = offset === null ? null : new Date(Date.now() + offset).toISOString();

    expect(formatRelative(value)).toBe(expected);
  });
});

describe("formatBucket", () => {
  it("labels a daily bucket by its UTC date, whatever the local time zone", () => {
    // Midnight UTC is still the 26th in America, so a local date would be a day early.
    expect(formatBucket("2026-10-27T00:00:00Z", "day")).toBe("Oct 27");
  });

  it("labels an hourly bucket with its time", () => {
    expect(formatBucket("2026-10-27T09:00:00Z", "hour")).toMatch(/^Oct 2[67], \d{2}:\d{2} [AP]M$/);
  });
});
