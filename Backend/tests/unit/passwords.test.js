import { describe, expect, it } from "vitest";
import { BCRYPT_ROUNDS, checkPassword, hashPassword } from "../../src/modules/auth/passwords.js";

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
