import { describe, expect, it, vi } from "vitest";
import { checkPassword } from "../../src/modules/auth/passwords.js";
import { RegisterSchema, registerUser, toPublicUser } from "../../src/modules/auth/registration.js";
import { GatewayError } from "../../src/utils/errors.js";

// An in-memory stand-in for the users table; the real repository is tested against
// Postgres in the auth integration tests.
function fakeUsers() {
  const rows = [];
  return {
    rows,
    create: vi.fn(async ({ email, name, passwordHash }) => {
      if (rows.some((row) => row.email === email)) return null;
      const user = {
        id: `user-${rows.length + 1}`,
        email,
        name,
        passwordHash,
        createdAt: new Date(),
      };
      rows.push(user);
      return user;
    }),
  };
}

const valid = { email: "  Asha@Example.COM ", password: "correct horse", name: " Asha " };

describe("RegisterSchema", () => {
  it("trims and lower-cases the email and trims the name", () => {
    expect(RegisterSchema.parse(valid)).toEqual({
      email: "asha@example.com",
      password: "correct horse",
      name: "Asha",
    });
  });

  it("does not trim the password", () => {
    expect(RegisterSchema.parse({ ...valid, password: "  spaced  " }).password).toBe("  spaced  ");
  });

  it.each([
    ["an invalid email", { ...valid, email: "not-an-email" }, "email"],
    ["a short password", { ...valid, password: "short" }, "password"],
    ["a password over 72 bytes", { ...valid, password: "a".repeat(73) }, "password"],
    ["multi-byte characters over 72 bytes", { ...valid, password: "é".repeat(37) }, "password"],
    ["an empty name", { ...valid, name: "   " }, "name"],
    ["an unknown field", { ...valid, role: "admin" }, ""],
  ])("rejects %s", (_label, body, path) => {
    const result = RegisterSchema.safeParse(body);

    expect(result.success).toBe(false);
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(path);
  });

  it("accepts a password of exactly 72 bytes", () => {
    expect(RegisterSchema.safeParse({ ...valid, password: "a".repeat(72) }).success).toBe(true);
  });
});

describe("registerUser", () => {
  const input = RegisterSchema.parse(valid);

  it("stores a bcrypt hash and returns the public user only", async () => {
    const users = fakeUsers();

    const user = await registerUser(input, { users });

    expect(user).toEqual({
      id: "user-1",
      email: "asha@example.com",
      name: "Asha",
      createdAt: expect.any(Date),
    });
    expect(user).not.toHaveProperty("passwordHash");
    const stored = users.rows[0].passwordHash;
    expect(stored).not.toBe("correct horse");
    expect(await checkPassword("correct horse", stored)).toBe(true);
  });

  it("refuses a taken email with a vague message that does not confirm the account exists", async () => {
    const users = fakeUsers();
    await registerUser(input, { users });

    const error = await registerUser(input, { users }).catch((err) => err);

    expect(error).toBeInstanceOf(GatewayError);
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).not.toMatch(/exists|taken|registered/i);
  });
});

describe("toPublicUser", () => {
  it("drops the password hash and anything else not meant for clients", () => {
    const row = {
      id: "u1",
      email: "a@b.c",
      name: "A",
      passwordHash: "$2b$...",
      createdAt: new Date(0),
      extra: 1,
    };

    expect(toPublicUser(row)).toEqual({
      id: "u1",
      email: "a@b.c",
      name: "A",
      createdAt: new Date(0),
    });
  });
});
