import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { captureLogs } from "../helpers/captureLogs.js";

describe("request logging", () => {
  let logs;
  let app;

  beforeEach(() => {
    logs = captureLogs();
    app = createApp({
      logger: logs.logger,
      extraRoutes: (app) => {
        app.get("/ok", (_req, res) => res.json({}));
        app.get("/step", (req, res) => {
          req.log.info({ step: 1 }, "inside handler");
          res.json({});
        });
      },
    });
  });

  it("writes one JSON line per request tagged with the response's request ID", async () => {
    const res = await request(app).get("/ok");

    expect(logs.requestLines()).toHaveLength(1);
    expect(logs.requestLines()[0]).toMatchObject({
      service: "llmux",
      reqId: res.headers["x-request-id"],
      req: { method: "GET", url: "/ok" },
      res: { statusCode: 200 },
    });
    expect(logs.requestLines()[0].responseTime).toBeTypeOf("number");
  });

  it("tags logs written inside handlers with the request ID only", async () => {
    const res = await request(app).get("/step");

    const handlerLine = logs.lines.find((line) => line.msg === "inside handler");
    expect(handlerLine.reqId).toBe(res.headers["x-request-id"]);
    expect(handlerLine.req).toBeUndefined();
  });

  it("logs the response status but not response headers", async () => {
    await request(app).get("/ok");

    expect(logs.requestLines()[0].res).toEqual({ statusCode: 200 });
  });

  it("redacts the Authorization and Cookie headers", async () => {
    await request(app)
      .get("/ok")
      .set("Authorization", "Bearer llmux_sk_supersecret")
      .set("Cookie", "session=topsecret");

    const raw = JSON.stringify(logs.lines);
    expect(raw).not.toContain("llmux_sk_supersecret");
    expect(raw).not.toContain("topsecret");
    expect(logs.requestLines()[0].req.headers.authorization).toBe("[REDACTED]");
    expect(logs.requestLines()[0].req.headers.cookie).toBe("[REDACTED]");
  });

  it("does not log /health checks", async () => {
    await request(app).get("/health");

    expect(logs.requestLines()).toHaveLength(0);
  });
});

describe("createLogger", () => {
  it("redacts nested apiKey and password fields in any log call", () => {
    const logs = captureLogs();

    logs.logger.info({ body: { apiKey: "sk-live-123", password: "hunter2" } }, "attempt");

    expect(logs.lines[0].body).toEqual({ apiKey: "[REDACTED]", password: "[REDACTED]" });
  });
});
