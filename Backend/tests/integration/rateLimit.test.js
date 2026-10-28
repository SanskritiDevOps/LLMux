import http from "node:http";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { LOGIN_LIMIT_PER_MIN } from "../../src/middleware/rateLimit.js";
import { createKeyLookup } from "../../src/modules/keys/keyLookup.js";
import { attachWebSocket } from "../../src/transports/websocket.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeKeys } from "../helpers/fakeKeys.js";
import { fakeLimiter } from "../helpers/fakeLimiter.js";
import { fakeRedis } from "../helpers/fakeRedis.js";
import { fakeUsers } from "../helpers/fakeUsers.js";
import { seedKey } from "../helpers/testKeys.js";
import { startMockProvider } from "../mockProvider.js";

// Rate limits on a real server: /v1 per gateway key (shared with WebSocket chats), and
// logins per IP. The token bucket is an in-memory stand-in that never refills, so tests
// can use a bucket up; the real Lua script is tested against real Redis elsewhere.
let mock;
let server;
let websocket;
let baseUrl;
let keys;
let limiter;
let logs;

beforeAll(async () => {
  mock = await startMockProvider();
});

afterAll(async () => {
  await mock.close();
});

async function start(limiterOptions) {
  limiter = fakeLimiter(limiterOptions);
  keys = fakeKeys();
  logs = captureLogs();
  const redis = fakeRedis();
  const gateway = createGateway({
    enabledProviders: new Set(["ollama"]),
    providerSettings: { ollama: { baseUrl: mock.url } },
    timeoutMs: 5000,
  });
  server = http.createServer(
    createApp({ logger: logs.logger, gateway, keys, redis, users: fakeUsers(), limiter }),
  );
  websocket = attachWebSocket(server, {
    gateway,
    keyLookup: createKeyLookup({ keys, redis }),
    logger: logs.logger,
    limiter,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

beforeEach(async () => {
  mock.reset();
  await start();
});

afterEach(async () => {
  await websocket.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await expect.poll(() => mock.open).toBe(0);
});

const chat = (authorization) =>
  request(server)
    .post("/v1/chat")
    .set("Authorization", authorization)
    .send({ model: "local", messages: [{ role: "user", content: "Hi" }] });

describe("per gateway key", () => {
  it("sends X-RateLimit-Limit and X-RateLimit-Remaining on every /v1 response", async () => {
    const { authorization } = await seedKey(keys);

    const first = await chat(authorization);
    const models = await request(server).get("/v1/models").set("Authorization", authorization);

    expect(first.status).toBe(200);
    expect(first.headers).toMatchObject({
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "59",
    });
    expect(models.headers["x-ratelimit-remaining"]).toBe("58");
    expect(first.headers["retry-after"]).toBeUndefined();
  });

  it("uses DEFAULT_RATE_LIMIT_PER_MIN, or the key's own rateLimitPerMin", async () => {
    const plain = await seedKey(keys);
    const custom = await seedKey(keys);
    await keys.update(custom.row.id, custom.row.userId, { rateLimitPerMin: 5 });

    expect((await chat(plain.authorization)).headers["x-ratelimit-limit"]).toBe(
      String(env.DEFAULT_RATE_LIMIT_PER_MIN),
    );
    expect((await chat(custom.authorization)).headers["x-ratelimit-limit"]).toBe("5");
  });

  it("refuses with 429 RATE_LIMITED and Retry-After once the bucket is empty, without calling the provider", async () => {
    const custom = await seedKey(keys);
    await keys.update(custom.row.id, custom.row.userId, { rateLimitPerMin: 2 });
    await chat(custom.authorization);
    await chat(custom.authorization);
    mock.reset();

    const refused = await chat(custom.authorization);

    expect(refused.status).toBe(429);
    expect(refused.headers).toMatchObject({
      "retry-after": "12",
      "x-ratelimit-limit": "2",
      "x-ratelimit-remaining": "0",
    });
    expect(refused.body.error).toMatchObject({
      code: "RATE_LIMITED",
      message: "Rate limit exceeded. Retry after 12 seconds.",
      retryable: true,
      requestId: refused.headers["x-request-id"],
    });
    expect(mock.requests).toHaveLength(0);
  });

  it("gives every key its own bucket", async () => {
    const a = await seedKey(keys);
    const b = await seedKey(keys);
    await keys.update(a.row.id, a.row.userId, { rateLimitPerMin: 1 });
    await chat(a.authorization);

    expect((await chat(a.authorization)).status).toBe(429);
    expect((await chat(b.authorization)).status).toBe(200);
    expect(limiter.calls.map((call) => call.key)).toContain(`rl:key:${b.row.id}`);
  });

  it("checks the key before the limit: a bad key gets 401 and uses no bucket", async () => {
    const res = await chat(`Bearer llmux_sk_${"A".repeat(43)}`);

    expect(res.status).toBe(401);
    expect(limiter.calls).toEqual([]);
  });

  it("lets the dashboard read the rate-limit headers through CORS", async () => {
    const { authorization } = await seedKey(keys);

    const res = await chat(authorization).set("Origin", env.DASHBOARD_URL);

    expect(res.headers["access-control-expose-headers"].split(",")).toEqual(
      expect.arrayContaining(["X-RateLimit-Limit", "X-RateLimit-Remaining", "Retry-After"]),
    );
  });

  it("allows requests, without rate-limit headers, when Redis can't be reached", async () => {
    await new Promise((resolve) => server.close(resolve));
    await websocket.close();
    await start({ unavailable: true });
    const { authorization } = await seedKey(keys);

    const res = await chat(authorization);

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
  });
});

describe("WebSocket chats", () => {
  it("take tokens from the same bucket as the key's HTTP requests", async () => {
    const custom = await seedKey(keys);
    await keys.update(custom.row.id, custom.row.userId, { rateLimitPerMin: 2 });
    // One HTTP request, then two WebSocket chats: the second chat is the third token.
    await chat(custom.authorization);

    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/v1/ws`);
    const messages = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ type: "auth", apiKey: custom.apiKey }));
    for (const requestId of ["c1", "c2"]) {
      ws.send(
        JSON.stringify({
          type: "chat",
          requestId,
          model: "local",
          messages: [{ role: "user", content: "Hi" }],
        }),
      );
    }

    await expect
      .poll(() => messages.find((m) => m.requestId === "c2" && m.type === "error"))
      .toMatchObject({
        code: "RATE_LIMITED",
        message: "Rate limit exceeded. Retry after 12 seconds.",
      });
    await expect
      .poll(() => messages.find((m) => m.requestId === "c1" && m.type === "end"))
      .toBeTruthy();
    ws.close();
  });
});

describe("logins per IP", () => {
  const login = () =>
    request(server)
      .post("/api/auth/login")
      .set("Origin", env.DASHBOARD_URL)
      .send({ email: "nobody@example.com", password: "wrong password" });

  it(`allows ${LOGIN_LIMIT_PER_MIN} tries a minute from one address, then answers 429`, async () => {
    const statuses = [];
    for (let i = 0; i < LOGIN_LIMIT_PER_MIN; i += 1) statuses.push((await login()).status);

    const refused = await login();

    expect(statuses.every((status) => status === 401)).toBe(true);
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe("RATE_LIMITED");
    expect(refused.headers["retry-after"]).toBe("12");
    expect(logs.lines.some((line) => line.msg === "Rate limit reached for this address")).toBe(
      true,
    );
  });

  it("doesn't put the login limit on other auth routes", async () => {
    for (let i = 0; i <= LOGIN_LIMIT_PER_MIN; i += 1) await login();

    const me = await request(server).get("/api/auth/me");

    expect(me.status).toBe(401);
    expect(me.headers["x-ratelimit-limit"]).toBeUndefined();
  });
});
