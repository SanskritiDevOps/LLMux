import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { GatewayError } from "../../src/utils/errors.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeKeys } from "../helpers/fakeKeys.js";
import { fakeRedis } from "../helpers/fakeRedis.js";
import { seedKey } from "../helpers/testKeys.js";

// The route only validates, hands off to the gateway and writes JSON, so a fake gateway
// is enough here. The full path through real adapters is tested with the mock provider.
const answer = {
  id: "req_x",
  model: "fast",
  provider: "gemini",
  providerModel: "gemini-3.5-flash-lite",
  content: "Hello!",
  finishReason: "stop",
  usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  costUsd: 0.000006,
  latencyMs: 12,
  cached: false,
  fallbackUsed: false,
};

// /v1 needs a gateway key; every request below sends this one.
const keys = fakeKeys();
const { authorization } = await seedKey(keys);

function appWith(chat) {
  const logs = captureLogs();
  const gateway = { chat: vi.fn(chat) };
  const app = createApp({ logger: logs.logger, gateway, keys, redis: fakeRedis() });
  return { app, gateway, logs };
}

const body = { model: "fast", messages: [{ role: "user", content: "Hi" }] };

describe("POST /v1/chat", () => {
  it("returns the gateway's unified response as JSON", async () => {
    const { app } = appWith(async () => ({ response: answer, meta: {} }));

    const res = await request(app).post("/v1/chat").set("Authorization", authorization).send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(answer);
  });

  it("passes the validated request (with defaults) and the request ID to the gateway", async () => {
    const { app, gateway } = appWith(async () => ({ response: answer, meta: {} }));

    const res = await request(app).post("/v1/chat").set("Authorization", authorization).send(body);

    const [validated, context] = gateway.chat.mock.calls[0];
    expect(validated).toEqual({ ...body, temperature: 0.7, stream: false, cache: true });
    expect(context.requestId).toBe(res.headers["x-request-id"]);
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(context.log).toBeDefined();
  });

  it("rejects an invalid body before the gateway is called", async () => {
    const { app, gateway } = appWith(async () => ({ response: answer, meta: {} }));

    const res = await request(app)
      .post("/v1/chat")
      .set("Authorization", authorization)
      .send({ model: "fast", max_tokens: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
    expect(gateway.chat).not.toHaveBeenCalled();
  });

  it("turns a gateway error into the unified error body with its status", async () => {
    const { app } = appWith(async () => {
      throw new GatewayError("PROVIDER_RATE_LIMITED", "gemini rate limit reached", {
        provider: "gemini",
      });
    });

    const res = await request(app).post("/v1/chat").set("Authorization", authorization).send(body);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
      provider: "gemini",
      retryable: true,
      requestId: res.headers["x-request-id"],
    });
  });

  it("aborts the provider call when the client disconnects", async () => {
    let seenSignal;
    let finished;
    const settled = new Promise((resolve) => (finished = resolve));
    const { app, logs } = appWith(
      (_request, { signal }) =>
        new Promise((_resolve, reject) => {
          seenSignal = signal;
          signal.addEventListener("abort", () => {
            reject(new DOMException("This operation was aborted", "AbortError"));
            setTimeout(finished, 20);
          });
        }),
    );

    // Give up on the request after 100 ms, which closes the connection like a closed tab.
    await request(app)
      .post("/v1/chat")
      .set("Authorization", authorization)
      .send(body)
      .timeout(100)
      .catch(() => {});
    await settled;

    expect(seenSignal.aborted).toBe(true);
    expect(
      logs.lines.some((line) => line.msg === "Client disconnected; provider call cancelled"),
    ).toBe(true);
  });

  it("only accepts POST", async () => {
    const { app } = appWith(async () => ({ response: answer, meta: {} }));

    const res = await request(app).get("/v1/chat").set("Authorization", authorization);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
