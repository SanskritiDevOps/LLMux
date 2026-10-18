import { describe, expect, it } from "vitest";
import { toGatewayError } from "../../src/middleware/errorHandler.js";
import { ERROR_CODES, GatewayError } from "../../src/utils/errors.js";

describe("GatewayError", () => {
  it("takes its HTTP status and default retryable flag from the code", () => {
    const error = new GatewayError("RATE_LIMITED", "Slow down");

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "GatewayError",
      code: "RATE_LIMITED",
      status: 429,
      retryable: true,
      provider: null,
      message: "Slow down",
    });
  });

  it("lets a specific error override retryable and name its provider", () => {
    const error = new GatewayError("PROVIDER_ERROR", "Upstream failed", {
      provider: "gemini",
      retryable: true,
    });

    expect(error.retryable).toBe(true);
    expect(error.provider).toBe("gemini");
  });

  it("keeps the original error as its cause", () => {
    const original = new Error("socket hang up");

    expect(new GatewayError("TIMEOUT", "Timed out", { cause: original }).cause).toBe(original);
  });

  it("refuses unknown codes so typos fail loudly", () => {
    expect(() => new GatewayError("RATE_LIMTED", "typo")).toThrow(TypeError);
  });

  it("serialises to the unified error body", () => {
    const body = new GatewayError("UNKNOWN_MODEL", "No model named fastest").toBody("req_1");

    expect(body).toEqual({
      error: {
        code: "UNKNOWN_MODEL",
        message: "No model named fastest",
        requestId: "req_1",
        provider: null,
        retryable: false,
      },
    });
  });

  it("matches the README status table for every code", () => {
    const statuses = Object.fromEntries(
      Object.entries(ERROR_CODES).map(([code, { status }]) => [code, status]),
    );

    expect(statuses).toEqual({
      INVALID_REQUEST: 400,
      UNKNOWN_MODEL: 400,
      UNAUTHORIZED: 401,
      KEY_REVOKED: 401,
      BUDGET_EXCEEDED: 402,
      NOT_FOUND: 404,
      PAYLOAD_TOO_LARGE: 413,
      RATE_LIMITED: 429,
      INTERNAL_ERROR: 500,
      PROVIDER_ERROR: 502,
      PROVIDER_UNAVAILABLE: 503,
      PROVIDER_RATE_LIMITED: 503,
      TIMEOUT: 504,
    });
  });
});

describe("toGatewayError", () => {
  it("passes GatewayErrors through unchanged", () => {
    const error = new GatewayError("UNAUTHORIZED", "Missing key");

    expect(toGatewayError(error)).toBe(error);
  });

  it("hides the message of unexpected errors behind INTERNAL_ERROR", () => {
    const result = toGatewayError(new Error("connect ECONNREFUSED 10.0.0.5:5432"));

    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.message).toBe("Internal server error");
    expect(result.cause.message).toContain("ECONNREFUSED");
  });

  it("handles non-Error values that were thrown", () => {
    expect(toGatewayError("oops").code).toBe("INTERNAL_ERROR");
    expect(toGatewayError(undefined).code).toBe("INTERNAL_ERROR");
  });
});
