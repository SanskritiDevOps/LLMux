import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";

const app = createApp();

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("security headers", () => {
  it("sets helmet headers and hides the framework", async () => {
    const res = await request(app).get("/health");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("trust proxy", () => {
  const ipApp = (trustProxy) =>
    createApp({
      trustProxy,
      extraRoutes: (a) => a.get("/test/ip", (req, res) => res.json({ ip: req.ip })),
    });

  it("uses the client address from X-Forwarded-For behind one proxy", async () => {
    const res = await request(ipApp(1)).get("/test/ip").set("X-Forwarded-For", "203.0.113.7");

    expect(res.body.ip).toBe("203.0.113.7");
  });

  it("ignores X-Forwarded-For by default, so clients can't pick their own address", async () => {
    const res = await request(ipApp(0)).get("/test/ip").set("X-Forwarded-For", "203.0.113.7");

    expect(res.body.ip).not.toBe("203.0.113.7");
  });

  it("trusts only the last hop, so a forged earlier address doesn't win", async () => {
    const res = await request(ipApp(1))
      .get("/test/ip")
      .set("X-Forwarded-For", "198.51.100.1, 203.0.113.7");

    expect(res.body.ip).toBe("203.0.113.7");
  });
});

describe("CORS", () => {
  it("allows the dashboard origin", async () => {
    const res = await request(app).get("/health").set("Origin", env.DASHBOARD_URL);

    expect(res.headers["access-control-allow-origin"]).toBe(env.DASHBOARD_URL);
  });

  it("does not allow other origins", async () => {
    const res = await request(app).get("/health").set("Origin", "https://evil.example");

    expect(res.headers["access-control-allow-origin"]).not.toBe("https://evil.example");
  });
});

describe("body limit", () => {
  it("rejects JSON bodies larger than MAX_BODY_SIZE with 413", async () => {
    const oversized = { text: "x".repeat(1024 * 1024 + 1) };

    const res = await request(app).post("/health").send(oversized);

    expect(res.status).toBe(413);
  });
});
