import { describe, expect, it } from "vitest";
import {
  BCRYPT_ROUNDS,
  checkPassword,
  createTaskQueue,
  hashPassword,
} from "../../src/modules/auth/passwords.js";

describe("passwords", () => {
  it("uses the fast cost in tests (12 everywhere else)", () => {
    expect(BCRYPT_ROUNDS).toBe(4);
  });

  it("stores a bcrypt hash, never the password itself", async () => {
    const hash = await hashPassword("correct horse battery");

    expect(hash).toMatch(/^\$2[aby]\$04\$/);
    expect(hash).not.toContain("correct horse battery");
  });

  it("salts every hash, so the same password hashes differently", async () => {
    expect(await hashPassword("same password")).not.toBe(await hashPassword("same password"));
  });

  it("accepts the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery");

    expect(await checkPassword("correct horse battery", hash)).toBe(true);
    expect(await checkPassword("Correct horse battery", hash)).toBe(false);
  });

  it("rejects any password when there is no user, without throwing", async () => {
    expect(await checkPassword("anything", null)).toBe(false);
    expect(await checkPassword("llmux-timing-equaliser", undefined)).toBe(false);
  });
});

describe("createTaskQueue", () => {
  it("runs at most max tasks at once, starts the rest in order, and returns each result", async () => {
    const run = createTaskQueue(2);
    let active = 0;
    let peak = 0;
    const started = [];
    const task = (n) => async () => {
      started.push(n);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return n * 10;
    };

    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => run(task(n))));

    expect(peak).toBe(2);
    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("frees the slot when a task fails", async () => {
    const run = createTaskQueue(1);

    await expect(run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await run(async () => "next")).toBe("next");
  });
});
