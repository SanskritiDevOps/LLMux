import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createUsersRepository } from "../../src/modules/auth/users.repository.js";
import { prisma, resetDatabase } from "../helpers/db.js";
import { captureLogs } from "../helpers/captureLogs.js";
import { realDependencies } from "../setup/testDatabase.js";

// The auth flow against a real Postgres (the llmux_test database), with the real
// repository. Runs in CI and with TEST_REAL_DEPS=1 locally.
describe.runIf(realDependencies)("auth against a real database", () => {
  let app;
  const users = createUsersRepository();
  const asha = { email: "Asha@Example.com", password: "correct horse", name: "Asha" };

  beforeEach(async () => {
    await resetDatabase();
    app = createApp({ logger: captureLogs().logger, gateway: { chat: async () => ({}) } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("users repository", () => {
    it("creates and finds a user by email and by id", async () => {
      const created = await users.create({ email: "a@b.co", name: "A", passwordHash: "hash" });

      expect(created).toMatchObject({ id: expect.any(String), email: "a@b.co", name: "A" });
      expect(await users.findByEmail("a@b.co")).toMatchObject({ id: created.id });
      expect(await users.findById(created.id)).toMatchObject({ email: "a@b.co" });
    });

    it("returns null for a duplicate email, because the unique index decides", async () => {
      await users.create({ email: "a@b.co", name: "A", passwordHash: "hash" });

      expect(await users.create({ email: "a@b.co", name: "B", passwordHash: "hash" })).toBeNull();
    });

    it("returns null for unknown users", async () => {
      expect(await users.findByEmail("nobody@b.co")).toBeNull();
      expect(await users.findById("00000000-0000-0000-0000-000000000000")).toBeNull();
    });
  });

  it("stores a lower-cased email and a bcrypt hash, never the password", async () => {
    const res = await request(app).post("/api/auth/register").send(asha);

    expect(res.status).toBe(201);
    const row = await prisma.user.findUnique({ where: { email: "asha@example.com" } });
    expect(row.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(row.passwordHash).not.toContain("correct horse");
  });

  it("registers, reads /me, logs out and logs back in", async () => {
    const agent = request.agent(app);

    const registered = await agent.post("/api/auth/register").send(asha);
    const me = await agent.get("/api/auth/me");
    await agent.post("/api/auth/logout");
    const afterLogout = await agent.get("/api/auth/me");
    const login = await agent
      .post("/api/auth/login")
      .send({ email: "asha@example.com", password: "correct horse" });
    const meAgain = await agent.get("/api/auth/me");

    expect(registered.status).toBe(201);
    expect(me.body.user.id).toBe(registered.body.user.id);
    expect(afterLogout.status).toBe(401);
    expect(login.status).toBe(200);
    expect(meAgain.body.user.id).toBe(registered.body.user.id);
  });

  it("lets only one of two simultaneous registrations for the same email succeed", async () => {
    const [first, second] = await Promise.all([
      request(app).post("/api/auth/register").send(asha),
      request(app).post("/api/auth/register").send(asha),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 400]);
    expect(await prisma.user.count()).toBe(1);
  });

  it("rejects a wrong password against the stored hash", async () => {
    await request(app).post("/api/auth/register").send(asha);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: asha.email, password: "wrong one" });

    expect(res.status).toBe(401);
  });

  it("ends access as soon as the account is deleted, even with a valid token", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send(asha);

    await prisma.user.deleteMany();

    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });
});

describe("resetDatabase safety", () => {
  it("refuses to wipe a database whose name does not end in _test", async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://llmux:llmux@localhost:5432/llmux";
    try {
      await expect(resetDatabase()).rejects.toThrow(/Refusing to wipe database "llmux"/);
    } finally {
      process.env.DATABASE_URL = original;
    }
  });
});
