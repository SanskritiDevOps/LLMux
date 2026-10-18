import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { READY_CHECK_TIMEOUT_MS } from "../../src/routes/system.routes.js";
import { captureLogs } from "../helpers/captureLogs.js";

const ok = async () => {};
const fails = async () => {
  throw new Error("connect ECONNREFUSED db.internal:5432");
};
const hangs = () => new Promise(() => {});

function appWith(readinessChecks) {
  const logs = captureLogs();
  return { app: createApp({ logger: logs.logger, readinessChecks }), logs };
}

describe("GET /ready", () => {
  it("returns 200 when every dependency answers", async () => {
    const { app } = appWith({ database: ok, redis: ok });

    const res = await request(app).get("/ready");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { database: "ok", redis: "ok" } });
  });

  it("returns 503 and names the dependency that failed", async () => {
    const { app } = appWith({ database: fails, redis: ok });

    const res = await request(app).get("/ready");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "not_ready", checks: { database: "error", redis: "ok" } });
  });

  it("does not leak connection details to the caller but logs them", async () => {
    const { app, logs } = appWith({ database: fails, redis: ok });

    const res = await request(app).get("/ready");

    expect(JSON.stringify(res.body)).not.toContain("db.internal");
    const warning = logs.lines.find((line) => line.msg === "Readiness check failed");
    expect(warning).toMatchObject({ check: "database", reqId: res.headers["x-request-id"] });
    expect(warning.err.message).toContain("db.internal");
  });

  it("reports a hanging dependency as timeout instead of hanging itself", async () => {
    const { app } = appWith({ database: ok, redis: hangs });

    const started = Date.now();
    const res = await request(app).get("/ready");

    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ database: "ok", redis: "timeout" });
    expect(Date.now() - started).toBeLessThan(READY_CHECK_TIMEOUT_MS + 500);
  });

  it("runs the checks in parallel", async () => {
    const slow = () => new Promise((resolve) => setTimeout(resolve, 300));
    const { app } = appWith({ database: slow, redis: slow });

    const started = Date.now();
    await request(app).get("/ready");

    expect(Date.now() - started).toBeLessThan(550);
  });

  it("is logged, unlike /health", async () => {
    const { app, logs } = appWith({ database: ok, redis: ok });

    await request(app).get("/ready");

    expect(logs.requestLines()).toHaveLength(1);
  });
});

describe("GET /health", () => {
  it("never runs the dependency checks", async () => {
    const database = vi.fn(ok);
    const { app } = appWith({ database, redis: ok });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(database).not.toHaveBeenCalled();
  });
});
