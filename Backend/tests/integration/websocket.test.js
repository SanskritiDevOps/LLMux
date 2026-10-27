import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../../src/app.js";
import { createGateway } from "../../src/gateway/gateway.service.js";
import { StreamEventSchema } from "../../src/gateway/schemas.js";
import { createKeyLookup } from "../../src/modules/keys/keyLookup.js";
import { CLOSE_CODES, attachWebSocket } from "../../src/transports/websocket.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeKeys } from "../helpers/fakeKeys.js";
import { fakeRedis } from "../helpers/fakeRedis.js";
import { seedKey } from "../helpers/testKeys.js";
import { startMockProvider } from "../mockProvider.js";

// /v1/ws end to end: a real HTTP server with the WebSocket attached, the real gateway and
// key check, a real `ws` client, and the mock provider standing in for Gemini and Ollama.
//
// Timing rule (Testing doc): the defaults below are generous, so a busy machine never
// makes an unrelated test fail. Only the tests about the auth timeout and the heartbeat
// restart the server with short values.
const DEFAULTS = { authTimeoutMs: 5000, heartbeatMs: 60_000 };
const SHORT_AUTH_TIMEOUT_MS = 300;
const SHORT_HEARTBEAT_MS = 500;

let mock;
let server;
let websocket;
let url;
let logs;
let keys;
let apiKey;
let keyRow;
let redis;
let gateway;
const clients = [];

beforeAll(async () => {
  mock = await startMockProvider();
});

afterAll(async () => {
  await mock.close();
});

async function startServer(options = DEFAULTS) {
  server = http.createServer(createApp({ logger: logs.logger, gateway, keys, redis }));
  websocket = attachWebSocket(server, {
    gateway,
    keyLookup: createKeyLookup({ keys, redis }),
    logger: logs.logger,
    ...DEFAULTS,
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${server.address().port}/v1/ws`;
}

async function stopServer() {
  for (const client of clients.splice(0)) client.ws.terminate();
  await websocket.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/** For the timing tests: the same setup, with a shorter auth timeout or heartbeat. */
async function restartServer(options) {
  await stopServer();
  await startServer(options);
}

beforeEach(async () => {
  mock.reset();
  logs = captureLogs();
  keys = fakeKeys();
  ({ apiKey, row: keyRow } = await seedKey(keys));
  redis = fakeRedis();
  gateway = createGateway({
    enabledProviders: new Set(["gemini", "ollama"]),
    providerSettings: {
      gemini: { apiKey: "mock-gemini-key", baseUrl: mock.url },
      ollama: { baseUrl: mock.url },
    },
    // Generous, so a busy machine never times out a normal mock answer (and falls back to
    // another provider mid-test). This suite isn't about timeouts.
    timeoutMs: 5000,
    // Retries and fallback have their own suite (fallback.test.js).
    maxRetries: 0,
  });
  await startServer();
});

afterEach(async () => {
  await stopServer();
  // Cancelled streams close on the mock a moment later; wait, so they aren't counted in
  // the next test's mock.aborted.
  await expect.poll(() => mock.open, { timeout: 3000 }).toBe(0);
});

/**
 * A test client that records every message, so tests can wait for the one they expect
 * (several chats on one socket interleave in any order).
 */
async function connect(options) {
  const ws = new WebSocket(url, options);
  const messages = [];
  const waiters = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const closed = new Promise((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const client = {
    ws,
    messages,
    closed,
    send: (message) => ws.send(typeof message === "string" ? message : JSON.stringify(message)),
    /** The first message (already received or still to come) matching the fields given. */
    next(fields, timeoutMs = 3000) {
      const match = (message) =>
        Object.entries(fields).every(([key, value]) => message[key] === value);
      const seen = messages.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`No message matching ${JSON.stringify(fields)} within ${timeoutMs} ms`));
        }, timeoutMs);
      });
    },
    of: (requestId) => messages.filter((message) => message.requestId === requestId),
  };
  clients.push(client);
  return client;
}

async function authenticated() {
  const client = await connect();
  client.send({ type: "auth", apiKey });
  await client.next({ type: "auth_ok" });
  return client;
}

const chat = (requestId, fields) => ({
  type: "chat",
  requestId,
  model: "fast",
  messages: [{ role: "user", content: "Plan one day in Jaipur." }],
  ...fields,
});

const textOf = (messages) =>
  messages
    .filter((message) => message.type === "delta")
    .map((message) => message.text)
    .join("");

// A slow Gemini stream that runs far longer than any test waits for it.
const slowStream = {
  type: "stream",
  chunks: Array.from({ length: 100 }, (_, i) => `w${i} `),
  gapMs: 50,
};

describe("the auth handshake", () => {
  it("answers auth_ok for a valid key", async () => {
    const client = await connect();
    client.send({ type: "auth", apiKey });

    expect(await client.next({ type: "auth_ok" })).toEqual({ type: "auth_ok" });
    expect(logs.lines.some((line) => line.msg === "WebSocket authenticated")).toBe(true);
  });

  it("closes with 4408 when no auth message arrives within the timeout", async () => {
    await restartServer({ authTimeoutMs: SHORT_AUTH_TIMEOUT_MS });
    const client = await connect();

    const error = await client.next({ type: "error" });
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.message).toContain("within 0.3 seconds");
    expect(await client.closed).toEqual({
      code: CLOSE_CODES.AUTH_TIMEOUT,
      reason: "Authentication timeout",
    });
  });

  it.each([
    ["an unknown key", () => `llmux_sk_${"A".repeat(43)}`, "UNAUTHORIZED", "Invalid gateway key"],
    ["a malformed key", () => "not-a-key", "UNAUTHORIZED", "Invalid gateway key"],
  ])("closes with 4401 for %s", async (_label, key, code, message) => {
    const client = await connect();
    client.send({ type: "auth", apiKey: key() });

    expect(await client.next({ type: "error" })).toEqual({ type: "error", code, message });
    expect((await client.closed).code).toBe(CLOSE_CODES.AUTH_FAILED);
  });

  it("closes with KEY_REVOKED for a revoked key", async () => {
    await keys.revoke(keyRow.id, keyRow.userId);
    const client = await connect();
    client.send({ type: "auth", apiKey });

    expect((await client.next({ type: "error" })).code).toBe("KEY_REVOKED");
    expect((await client.closed).code).toBe(CLOSE_CODES.AUTH_FAILED);
  });

  it.each([
    ["a chat", chat("c1")],
    ["a ping", { type: "ping" }],
    ["broken JSON", "{nope"],
  ])("closes the socket when the first message is %s", async (_label, message) => {
    const client = await connect();
    client.send(message);

    await client.next({ type: "error" });
    expect((await client.closed).code).toBe(CLOSE_CODES.AUTH_FAILED);
    expect(mock.requests).toHaveLength(0);
  });

  it("handles a chat sent straight after auth, without waiting for auth_ok", async () => {
    mock.behave("gemini", { type: "ok", text: "Amber Fort." });
    const client = await connect();
    client.send({ type: "auth", apiKey });
    client.send(chat("c1"));

    await client.next({ type: "end", requestId: "c1" });
    expect(client.messages.map((message) => message.type)).toEqual([
      "auth_ok",
      "start",
      "delta",
      "delta",
      "end",
    ]);
  });

  it("never logs the key", async () => {
    await authenticated();

    expect(JSON.stringify(logs.lines)).not.toContain(apiKey);
  });

  it("refuses upgrades on any other path with 404", async () => {
    const ws = new WebSocket(url.replace("/v1/ws", "/v1/other"));

    const status = await new Promise((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.on("error", () => {});
    });
    expect(status).toBe(404);
  });
});

describe("chat", () => {
  it("streams start, deltas and end, each tagged with the requestId", async () => {
    mock.behave("gemini", { type: "stream", chunks: ["Morning: ", "Amber Fort."] });
    const client = await authenticated();
    client.send(chat("trip-1"));

    await client.next({ type: "end", requestId: "trip-1" });
    const messages = client.of("trip-1");
    expect(messages.map((message) => message.type)).toEqual(["start", "delta", "delta", "end"]);
    expect(messages[0]).toEqual({
      type: "start",
      requestId: "trip-1",
      id: expect.stringMatching(/^req_[0-9a-f]{24}$/),
      model: "fast",
      provider: "gemini",
    });
    expect(textOf(messages)).toBe("Morning: Amber Fort.");
    expect(messages.at(-1)).toMatchObject({
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
    // Apart from requestId, the payloads are exactly the SSE events.
    for (const message of messages) {
      const event = { ...message };
      delete event.requestId;
      StreamEventSchema.parse(event);
    }
    expect(mock.requests[0].path).toBe(
      "/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent",
    );
  });

  it("streams two chats at once on one socket, with their messages interleaved", async () => {
    mock.behave("gemini", { type: "stream", chunks: ["a1 ", "a2 ", "a3"], gapMs: 30 });
    mock.behave("ollama", { type: "stream", chunks: ["b1 ", "b2 ", "b3"], gapMs: 30 });
    const client = await authenticated();
    client.send(chat("a"));
    client.send(chat("b", { model: "local" }));

    await Promise.all([
      client.next({ type: "end", requestId: "a" }),
      client.next({ type: "end", requestId: "b" }),
    ]);
    expect(textOf(client.of("a"))).toBe("a1 a2 a3");
    expect(textOf(client.of("b"))).toBe("b1 b2 b3");
    expect(client.of("b")[0].provider).toBe("ollama");
    // Interleaved: b started before a had finished.
    const order = client.messages.map((message) => `${message.requestId}:${message.type}`);
    expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("a:end"));
  });

  it("reports provider errors before the stream as an error for that request only", async () => {
    mock.behave("gemini", { type: "status", status: 429, body: { error: { code: 429 } } });
    const client = await authenticated();
    client.send(chat("c1", { model: "gemini:gemini-3.5-flash-lite" }));

    expect(await client.next({ type: "error", requestId: "c1" })).toEqual({
      type: "error",
      requestId: "c1",
      code: "PROVIDER_RATE_LIMITED",
      message: "gemini rate limit reached",
    });
    client.send({ type: "ping" });
    await client.next({ type: "pong" });
  });

  it("ends with an error after the deltas when the provider fails mid-stream", async () => {
    mock.behave("gemini", { type: "stream", chunks: ["Morning: "], then: "drop" });
    const client = await authenticated();
    client.send(chat("c1"));

    await client.next({ type: "error", requestId: "c1" });
    expect(client.of("c1").map((message) => message.type)).toEqual(["start", "delta", "error"]);
    expect(client.of("c1").at(-1).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("rejects an unknown model for that requestId", async () => {
    const client = await authenticated();
    client.send(chat("c1", { model: "fastest" }));

    expect((await client.next({ type: "error", requestId: "c1" })).code).toBe("UNKNOWN_MODEL");
  });

  it("rejects an invalid chat with its requestId and keeps the socket open", async () => {
    const client = await authenticated();
    client.send(chat("c1", { temperature: 9 }));

    const error = await client.next({ type: "error", requestId: "c1" });
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toContain("temperature");
    client.send({ type: "ping" });
    await client.next({ type: "pong" });
  });

  it("answers broken JSON after auth with an error, without closing", async () => {
    const client = await authenticated();
    client.send("{nope");

    expect(await client.next({ type: "error" })).toEqual({
      type: "error",
      code: "INVALID_REQUEST",
      message: "Message is not valid JSON",
    });
    client.send({ type: "ping" });
    await client.next({ type: "pong" });
  });

  it("refuses a requestId that is already in progress", async () => {
    mock.behave("gemini", slowStream);
    const client = await authenticated();
    client.send(chat("c1"));
    await client.next({ type: "start", requestId: "c1" });
    client.send(chat("c1"));

    const error = await client.next({ type: "error", requestId: "c1" });
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(error.message).toContain("already in progress");
    expect(mock.requests).toHaveLength(1);
  });
});

describe("cancel, ping and auth again", () => {
  it("cancels one chat, stops its provider call, and leaves the other running", async () => {
    mock.behave("gemini", slowStream);
    mock.behave("ollama", { type: "stream", chunks: ["b1 ", "b2"], gapMs: 100 });
    const client = await authenticated();
    client.send(chat("a"));
    client.send(chat("b", { model: "local" }));
    await client.next({ type: "delta", requestId: "a" });

    client.send({ type: "cancel", requestId: "a" });

    expect(await client.next({ type: "cancelled", requestId: "a" })).toEqual({
      type: "cancelled",
      requestId: "a",
    });
    await expect.poll(() => mock.aborted).toBe(1);
    await client.next({ type: "end", requestId: "b" });
    expect(textOf(client.of("b"))).toBe("b1 b2");
    expect(client.of("a").some((message) => message.type === "end")).toBe(false);
    expect(
      logs.lines.some((line) => line.msg === "Client cancelled; provider call cancelled"),
    ).toBe(true);
  });

  it("answers a cancel for a requestId that isn't in progress with NOT_FOUND", async () => {
    const client = await authenticated();
    client.send({ type: "cancel", requestId: "nothing" });

    expect((await client.next({ type: "error", requestId: "nothing" })).code).toBe("NOT_FOUND");
  });

  it("answers ping with pong", async () => {
    const client = await authenticated();
    client.send({ type: "ping" });

    expect(await client.next({ type: "pong" })).toEqual({ type: "pong" });
  });

  it("refuses a second auth without closing", async () => {
    const client = await authenticated();
    client.send({ type: "auth", apiKey });

    expect((await client.next({ type: "error" })).message).toBe("Already authenticated");
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("limits and closing", () => {
  it("allows 3 chats in progress per socket and refuses a 4th until one ends", async () => {
    mock.behave("gemini", slowStream);
    const client = await authenticated();
    for (const id of ["c1", "c2", "c3"]) client.send(chat(id));
    await Promise.all(
      ["c1", "c2", "c3"].map((id) => client.next({ type: "start", requestId: id })),
    );

    client.send(chat("c4"));
    const error = await client.next({ type: "error", requestId: "c4" });
    expect(error).toMatchObject({ code: "RATE_LIMITED" });
    expect(error.message).toContain("At most 3 requests");

    client.send({ type: "cancel", requestId: "c1" });
    await client.next({ type: "cancelled", requestId: "c1" });
    client.send(chat("c5"));
    await client.next({ type: "start", requestId: "c5" });
  });

  it("cancels every chat in progress when the client closes the socket", async () => {
    mock.behave("gemini", slowStream);
    const client = await authenticated();
    client.send(chat("c1"));
    client.send(chat("c2"));
    await Promise.all(["c1", "c2"].map((id) => client.next({ type: "delta", requestId: id })));

    client.ws.close();

    await expect.poll(() => mock.aborted).toBe(2);
    await expect
      .poll(() =>
        logs.lines.find((line) => line.msg === "WebSocket closed; provider calls cancelled"),
      )
      .toMatchObject({ cancelled: 2, requests: 2 });
  });

  it("terminates a client that stops answering heartbeat pings, cancelling its chats", async () => {
    mock.behave("gemini", slowStream);
    await restartServer({ heartbeatMs: SHORT_HEARTBEAT_MS });
    // autoPong: false plays a peer that vanished without closing the connection.
    const client = await connect({ autoPong: false });
    client.send({ type: "auth", apiKey });
    await client.next({ type: "auth_ok" });
    client.send(chat("c1"));
    await client.next({ type: "start", requestId: "c1" });

    expect((await client.closed).code).toBe(1006);
    await expect.poll(() => mock.aborted).toBe(1);
  });

  it("keeps a client that answers heartbeat pings connected", async () => {
    await restartServer({ heartbeatMs: SHORT_HEARTBEAT_MS });
    const client = await authenticated();

    await new Promise((resolve) => setTimeout(resolve, SHORT_HEARTBEAT_MS * 4));
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes every socket with 1001 on shutdown and cancels their chats", async () => {
    mock.behave("gemini", slowStream);
    const client = await authenticated();
    client.send(chat("c1"));
    await client.next({ type: "delta", requestId: "c1" });

    await websocket.close();

    expect(await client.closed).toEqual({
      code: CLOSE_CODES.GOING_AWAY,
      reason: "Server shutting down",
    });
    await expect.poll(() => mock.aborted).toBe(1);
  });
});
