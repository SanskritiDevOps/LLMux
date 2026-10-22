import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { SESSION_COOKIE } from "../../src/modules/auth/tokens.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { fakeUsers } from "../helpers/fakeUsers.js";

let users;
let app;

beforeEach(() => {
  users = fakeUsers();
  app = createApp({ logger: captureLogs().logger, users, gateway: { chat: async () => ({}) } });
});

const asha = { email: "asha@example.com", password: "correct horse", name: "Asha" };

const sessionCookie = (res) =>
  (res.headers["set-cookie"] ?? []).find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));

describe("POST /api/auth/register", () => {
  it("creates the account, returns the public user and starts a session", async () => {
    const res = await request(app).post("/api/auth/register").send(asha);

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({
      id: expect.any(String),
      email: "asha@example.com",
      name: "Asha",
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|correct horse/);
    expect(sessionCookie(res)).toBeDefined();
  });

  it("sets an httpOnly, SameSite, /api-scoped session cookie", async () => {
    const cookie = sessionCookie(await request(app).post("/api/auth/register").send(asha));

    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api/);
    expect(cookie).toMatch(/Max-Age=604800/);
  });

  it("rejects a second account for the same email, even with different capitals", async () => {
    await request(app).post("/api/auth/register").send(asha);

    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...asha, email: "ASHA@example.com" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
    expect(users.rows).toHaveLength(1);
  });

  it("validates the body", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...asha, password: "short" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("password");
    expect(res.body.error.message).not.toContain("short");
  });
});

describe("POST /api/auth/login", () => {
  beforeEach(async () => {
    await request(app).post("/api/auth/register").send(asha);
  });

  it("logs in with the right password and starts a session", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "Asha@Example.com", password: "correct horse" });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("asha@example.com");
    expect(sessionCookie(res)).toBeDefined();
  });

  it("gives the same 401 for a wrong password and an unknown email", async () => {
    const wrongPassword = await request(app)
      .post("/api/auth/login")
      .send({ email: asha.email, password: "wrong password" });
    const unknownEmail = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "wrong password" });

    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: "UNAUTHORIZED",
        message: "Invalid email or password",
      });
      expect(sessionCookie(res)).toBeUndefined();
    }
  });
});

describe("GET /api/auth/me and POST /api/auth/logout", () => {
  it("returns the logged-in user from the session cookie", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send(asha);

    const res = await agent.get("/api/auth/me");

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: "asha@example.com", name: "Asha" });
  });

  it("returns 401 without a session", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
  });

  it("clears the session cookie on logout, after which /me is 401", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send(asha);

    const logout = await agent.post("/api/auth/logout");

    expect(logout.status).toBe(204);
    expect(sessionCookie(logout)).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });
});

describe("cross-site protection and CORS", () => {
  it("refuses login from another website's origin", async () => {
    await request(app).post("/api/auth/register").send(asha);

    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "https://evil.example")
      .send({ email: asha.email, password: asha.password });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("lets the dashboard origin send credentials", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .set("Origin", "http://localhost:5173")
      .send(asha);

    expect(res.status).toBe(201);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});
