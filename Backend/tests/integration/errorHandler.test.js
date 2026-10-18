import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { GatewayError } from "../../src/utils/errors.js";
import { captureLogs } from "../helpers/captureLogs.js";

describe("central error handler", () => {
  let logs;
  let app;

  beforeEach(() => {
    logs = captureLogs();
    app = createApp({
      logger: logs.logger,
      extraRoutes: (app) => {
        app.get("/gateway-error", () => {
          throw new GatewayError("PROVIDER_UNAVAILABLE", "All providers failed", {
            provider: "gemini",
          });
        });
        app.get("/async-error", async () => {
          await Promise.resolve();
          throw new GatewayError("TIMEOUT", "Deadline exceeded");
        });
        app.get("/bug", () => {
          throw new Error("password=hunter2 leaked in a bug");
        });
        app.post("/echo", (req, res) => res.json(req.body));
        app.get("/fails-mid-response", (_req, res) => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.write("partial answer");
          throw new Error("provider dropped the stream");
        });
      },
    });
  });

  it("returns the unified 404 body for unknown routes", async () => {
    const res = await request(app).get("/nope");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Route GET /nope not found",
        requestId: res.headers["x-request-id"],
        provider: null,
        retryable: false,
      },
    });
  });

  it("sends a thrown GatewayError with its own status, code and provider", async () => {
    const res = await request(app).get("/gateway-error");

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: "All providers failed",
      provider: "gemini",
      retryable: true,
      requestId: res.headers["x-request-id"],
    });
  });

  it("catches errors from async route handlers", async () => {
    const res = await request(app).get("/async-error");

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe("TIMEOUT");
  });

  it("hides unexpected errors from the client but logs the real one", async () => {
    const res = await request(app).get("/bug");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    });
    expect(JSON.stringify(res.body)).not.toContain("hunter2");

    const line = logs.requestLines()[0];
    expect(line.level).toBe(50);
    expect(line.err.message).toBe("password=hunter2 leaked in a bug");
  });

  it("does not attach a stack to the log line for client errors", async () => {
    await request(app).get("/nope");

    const line = logs.requestLines()[0];
    expect(line.level).toBe(40);
    expect(line.err).toBeUndefined();
  });

  it("turns malformed JSON into INVALID_REQUEST", async () => {
    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .send('{"model": "fast",');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Request body is not valid JSON",
    });
  });

  it("turns an oversized body into PAYLOAD_TOO_LARGE", async () => {
    const res = await request(app)
      .post("/echo")
      .send({ text: "x".repeat(1024 * 1024 + 1) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("closes the connection when the error happens after the response started", async () => {
    // The 200 status is already sent, so a JSON error body would be a lie; the client
    // must instead see the response cut short.
    await expect(request(app).get("/fails-mid-response")).rejects.toThrow();
  });

  it("always responds with JSON, never an HTML error page", async () => {
    const res = await request(app).get("/bug");

    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});
