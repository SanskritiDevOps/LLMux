import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { generateRequestId, requestId } from "../../src/middleware/requestId.js";

function appEchoingId() {
  const app = express();
  app.use(requestId());
  app.get("/", (req, res) => res.json({ id: req.id }));
  return app;
}

describe("generateRequestId", () => {
  it("returns a req_ prefixed hex ID", () => {
    expect(generateRequestId()).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it("returns a different ID each time", () => {
    expect(generateRequestId()).not.toBe(generateRequestId());
  });
});

describe("requestId middleware", () => {
  const app = appEchoingId();

  it("generates an ID, exposes it as req.id and echoes it in the header", async () => {
    const res = await request(app).get("/");

    expect(res.headers["x-request-id"]).toMatch(/^req_[0-9a-f]{24}$/);
    expect(res.body.id).toBe(res.headers["x-request-id"]);
  });

  it("reuses a safe client-supplied ID", async () => {
    const res = await request(app).get("/").set("X-Request-Id", "trip-planner:abc-123");

    expect(res.headers["x-request-id"]).toBe("trip-planner:abc-123");
    expect(res.body.id).toBe("trip-planner:abc-123");
  });

  it.each([
    ["too long", "a".repeat(129)],
    ["unsafe characters", "abc<script>"],
    ["spaces", "abc def"],
  ])("replaces a client ID that is %s", async (_label, unsafe) => {
    const res = await request(app).get("/").set("X-Request-Id", unsafe);

    expect(res.headers["x-request-id"]).toMatch(/^req_[0-9a-f]{24}$/);
  });
});
