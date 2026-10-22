import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import { requireSession } from "../../src/middleware/jwtAuth.js";
import { requireSameOrigin } from "../../src/middleware/originCheck.js";
import { SESSION_COOKIE, signSession } from "../../src/modules/auth/tokens.js";

const asha = {
  id: "user-1",
  email: "asha@example.com",
  name: "Asha",
  passwordHash: "$2b$04$secret-hash",
  createdAt: new Date("2026-10-21T00:00:00Z"),
};

function appWith(users) {
  const app = express();
  app.get("/api/private", requireSession({ users }), (req, res) => res.json({ user: req.user }));
  app.post(
    "/api/action",
    requireSameOrigin({ allowedOrigin: "http://localhost:5173" }),
    (_req, res) => res.json({ ok: true }),
  );
  app.use(errorHandler());
  return app;
}

const withSession = (userId) => `${SESSION_COOKIE}=${signSession(userId)}`;

describe("requireSession", () => {
  it("lets a valid session through and exposes the public user", async () => {
    const users = { findById: vi.fn(async (id) => (id === asha.id ? asha : null)) };

    const res = await request(appWith(users))
      .get("/api/private")
      .set("Cookie", withSession(asha.id));

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: "user-1",
      email: "asha@example.com",
      name: "Asha",
      createdAt: "2026-10-21T00:00:00.000Z",
    });
    expect(JSON.stringify(res.body)).not.toContain("secret-hash");
  });

  it("rejects a request without a session cookie with 401 UNAUTHORIZED", async () => {
    const users = { findById: vi.fn() };

    const res = await request(appWith(users)).get("/api/private");

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: "UNAUTHORIZED", message: "Log in to continue" });
    expect(users.findById).not.toHaveBeenCalled();
  });

  it("rejects a tampered token without looking the user up", async () => {
    const users = { findById: vi.fn() };
    const token = signSession(asha.id);
    const tampered = `${token.slice(0, -2)}xx`;

    const res = await request(appWith(users))
      .get("/api/private")
      .set("Cookie", `${SESSION_COOKIE}=${tampered}`);

    expect(res.status).toBe(401);
    expect(users.findById).not.toHaveBeenCalled();
  });

  it("rejects a valid token whose user no longer exists", async () => {
    const users = { findById: vi.fn(async () => null) };

    const res = await request(appWith(users))
      .get("/api/private")
      .set("Cookie", withSession("deleted-user"));

    expect(res.status).toBe(401);
  });

  it("does not accept the token as a Bearer header, only as the cookie", async () => {
    const users = { findById: vi.fn(async () => asha) };

    const res = await request(appWith(users))
      .get("/api/private")
      .set("Authorization", `Bearer ${signSession(asha.id)}`);

    expect(res.status).toBe(401);
  });
});

describe("requireSameOrigin", () => {
  const users = { findById: vi.fn() };

  it("allows the dashboard's own origin", async () => {
    const res = await request(appWith(users))
      .post("/api/action")
      .set("Origin", "http://localhost:5173");

    expect(res.status).toBe(200);
  });

  it("blocks a state-changing request from another site with 403 FORBIDDEN", async () => {
    const res = await request(appWith(users))
      .post("/api/action")
      .set("Origin", "https://evil.example");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: "FORBIDDEN",
      message: "Cross-site request blocked",
    });
  });

  it("allows clients that send no Origin header, such as curl", async () => {
    expect((await request(appWith(users)).post("/api/action")).status).toBe(200);
  });
});
