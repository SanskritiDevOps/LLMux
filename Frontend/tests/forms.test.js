import { describe, expect, it } from "vitest";
import { byteLength, fieldErrorsFrom, isEmail } from "../src/lib/forms.js";

const invalid = (message) => ({ code: "INVALID_REQUEST", message });

describe("fieldErrorsFrom", () => {
  it("puts each of the API's validation messages under its field", () => {
    const error = invalid(
      "Invalid request: email: Invalid email address; password: Too small: expected string to have >=8 characters",
    );

    expect(fieldErrorsFrom(error, ["email", "password"])).toEqual({
      email: "Invalid email address",
      password: "Too small: expected string to have >=8 characters",
    });
  });

  it("starts each message with a capital letter", () => {
    expect(fieldErrorsFrom(invalid("Invalid request: name: must not be empty"), ["name"])).toEqual({
      name: "Must not be empty",
    });
  });

  it("leaves out fields the form doesn't have, so they become a form-level error", () => {
    const error = invalid("Invalid request: rateLimitPerMin: too big; colour: unknown");

    expect(fieldErrorsFrom(error, ["name", "rateLimitPerMin"])).toEqual({
      rateLimitPerMin: "Too big",
    });
  });

  it("ignores errors that aren't validation errors", () => {
    const error = { code: "UNAUTHORIZED", message: "Invalid email or password" };

    expect(fieldErrorsFrom(error, ["email"])).toEqual({});
    expect(fieldErrorsFrom(null, ["email"])).toEqual({});
  });
});

describe("isEmail", () => {
  it.each(["asha@example.com", "  asha@example.co.in  "])("accepts %s", (value) => {
    expect(isEmail(value)).toBe(true);
  });

  it.each(["asha", "asha@", "asha@example", "a sha@example.com"])("rejects %s", (value) => {
    expect(isEmail(value)).toBe(false);
  });
});

describe("byteLength", () => {
  // bcrypt reads at most 72 bytes, so the register form counts bytes, not characters.
  it.each([
    ["password", 8],
    ["é", 2],
    ["🙂", 4],
  ])("counts %s as %i bytes", (value, bytes) => {
    expect(byteLength(value)).toBe(bytes);
  });
});
