import { describe, expect, it } from "vitest";
import { classifyError } from "../../src/gateway/errorPolicy.js";
import { errorFromStatus } from "../../src/providers/adapter.js";
import { mapGeminiError } from "../../src/providers/gemini/response.js";
import { mapOllamaError } from "../../src/providers/ollama/response.js";
import { GatewayError } from "../../src/utils/errors.js";

// Real errors, built the way the adapters and the HTTP client build them, so the table in
// README section 14 is checked against what actually reaches the gateway.
const fromStatus = (status) => errorFromStatus("gemini", status);

describe("classifyError", () => {
  it.each([
    ["a timeout", new GatewayError("TIMEOUT", "gemini did not respond", { provider: "gemini" })],
    [
      "an unreachable provider",
      new GatewayError("PROVIDER_UNAVAILABLE", "Could not reach gemini", { provider: "gemini" }),
    ],
    ["a 429", fromStatus(429)],
    ["a 500", fromStatus(500)],
    ["a 502", fromStatus(502)],
    ["a 503", fromStatus(503)],
    ["a 504", fromStatus(504)],
    ["a 408", fromStatus(408)],
  ])("retries and may fall back after %s", (_label, error) => {
    expect(classifyError(error)).toEqual({ retry: true, fallback: true, alert: false });
  });

  it.each([
    ["a 401", fromStatus(401)],
    ["a 403", fromStatus(403)],
  ])("falls back without retrying, and raises an alert, after %s (our key)", (_label, error) => {
    expect(classifyError(error)).toEqual({ retry: false, fallback: true, alert: true });
  });

  it("treats Gemini's legacy bad-key 400 as a key problem, not a bad request", () => {
    const error = mapGeminiError({
      status: 400,
      body: { error: { code: 400, details: [{ reason: "API_KEY_INVALID" }] } },
    });

    expect(classifyError(error)).toEqual({ retry: false, fallback: true, alert: true });
  });

  it.each([
    ["a 402 (no credit)", fromStatus(402)],
    ["a 404 (model missing there)", fromStatus(404)],
    ["an Ollama model that isn't pulled", mapOllamaError({ status: 404 })],
    [
      "a Gemini account precondition",
      mapGeminiError({ status: 400, body: { error: { code: "failed_precondition" } } }),
    ],
  ])("falls back without retrying after %s", (_label, error) => {
    expect(classifyError(error)).toEqual({ retry: false, fallback: true, alert: false });
  });

  it("stops after a 400: the request itself is bad, so every provider would refuse it", () => {
    expect(classifyError(fromStatus(400))).toEqual({ retry: false, fallback: false, alert: false });
  });

  it.each([
    ["an unknown model", new GatewayError("UNKNOWN_MODEL", "Unknown model")],
    ["our own rate limit", new GatewayError("RATE_LIMITED", "Slow down")],
    ["a bad gateway key", new GatewayError("UNAUTHORIZED", "Invalid gateway key")],
    ["an internal error", new GatewayError("INTERNAL_ERROR", "Internal server error")],
    ["a plain bug", new TypeError("cannot read properties of undefined")],
    ["the client's abort", Object.assign(new Error("aborted"), { name: "AbortError" })],
    ["nothing at all", undefined],
  ])("stops after %s", (_label, error) => {
    expect(classifyError(error)).toEqual({ retry: false, fallback: false, alert: false });
  });
});

describe("errorFromStatus", () => {
  it("keeps the provider's own status on the error", () => {
    expect(fromStatus(403)).toMatchObject({
      code: "PROVIDER_ERROR",
      status: 502,
      providerStatus: 403,
    });
  });
});
