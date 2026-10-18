import { afterAll, describe, expect, it } from "vitest";
import { checkDatabase, prisma } from "../../src/config/db.js";
import { checkRedis, redis } from "../../src/config/redis.js";

// Talks to the real Postgres and Redis from docker-compose. Off by default because CI
// has no Postgres service yet (added on Day 15). Run locally with:
//   PowerShell: $env:TEST_REAL_DEPS="1"; npm test
//   bash:       TEST_REAL_DEPS=1 npm test
describe.runIf(process.env.TEST_REAL_DEPS === "1")("real dependencies", () => {
  afterAll(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });

  it("reaches Postgres", async () => {
    await expect(checkDatabase()).resolves.toBeUndefined();
  });

  it("reaches Redis", async () => {
    await expect(checkRedis()).resolves.toBeUndefined();
  });

  it("can read the tables created by the init migration", async () => {
    await expect(prisma.user.count()).resolves.toBeTypeOf("number");
  });
});
