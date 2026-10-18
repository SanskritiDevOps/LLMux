import { Writable } from "node:stream";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/utils/logger.js";

/** A destination that keeps every log line in memory as parsed JSON. */
function captureStream() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(
        ...chunk
          .toString()
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
      callback();
    },
  });
  return { stream, lines };
}

describe("request logging", () => {
  let capture;
  let app;

  beforeEach(() => {
    capture = captureStream();
    const logger = createLogger({ level: "info", pretty: false }, capture.stream);
    app = createApp({ logger });
    app.get("/boom", (_req, res) => res.status(500).json({}));
    app.get("/missing", (_req, res) => res.status(404).json({}));
    app.get("/ok", (_req, res) => res.json({}));
  });

  // pino-http ends each request with "request completed", or "request errored" for 5xx.
  const completed = () => capture.lines.filter((line) => line.res);

  it("writes one JSON line per request tagged with the response's request ID", async () => {
    const res = await request(app).get("/ok");

    expect(completed()).toHaveLength(1);
    expect(completed()[0]).toMatchObject({
      service: "llmux",
      reqId: res.headers["x-request-id"],
      req: { method: "GET", url: "/ok" },
      res: { statusCode: 200 },
    });
    expect(completed()[0].responseTime).toBeTypeOf("number");
  });

  it("tags logs written inside handlers with the request ID only", async () => {
    app.get("/step", (req, res) => {
      req.log.info({ step: 1 }, "inside handler");
      res.json({});
    });

    const res = await request(app).get("/step");

    const handlerLine = capture.lines.find((line) => line.msg === "inside handler");
    expect(handlerLine.reqId).toBe(res.headers["x-request-id"]);
    expect(handlerLine.req).toBeUndefined();
  });

  it("logs the response status but not response headers", async () => {
    await request(app).get("/ok");

    expect(completed()[0].res).toEqual({ statusCode: 200 });
  });

  it("redacts the Authorization and Cookie headers", async () => {
    await request(app)
      .get("/ok")
      .set("Authorization", "Bearer llmux_sk_supersecret")
      .set("Cookie", "session=topsecret");

    const raw = JSON.stringify(capture.lines);
    expect(raw).not.toContain("llmux_sk_supersecret");
    expect(raw).not.toContain("topsecret");
    expect(completed()[0].req.headers.authorization).toBe("[REDACTED]");
    expect(completed()[0].req.headers.cookie).toBe("[REDACTED]");
  });

  it("logs 4xx as warn and 5xx as error", async () => {
    await request(app).get("/missing");
    await request(app).get("/boom");

    const levels = completed().map((line) => [line.res.statusCode, line.level]);
    expect(levels).toEqual([
      [404, 40],
      [500, 50],
    ]);
  });

  it("does not log /health checks", async () => {
    await request(app).get("/health");

    expect(completed()).toHaveLength(0);
  });
});

describe("createLogger", () => {
  it("redacts nested apiKey and password fields in any log call", () => {
    const capture = captureStream();
    const logger = createLogger({ level: "info", pretty: false }, capture.stream);

    logger.info({ body: { apiKey: "sk-live-123", password: "hunter2" } }, "attempt");

    expect(capture.lines[0].body).toEqual({ apiKey: "[REDACTED]", password: "[REDACTED]" });
  });
});
