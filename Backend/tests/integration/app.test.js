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
