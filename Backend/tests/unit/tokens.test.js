import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import {
  SESSION_TTL_SECONDS,
  readCookie,
  sessionCookieOptions,
  signSession,
  verifySession,
} from "../../src/modules/auth/tokens.js";

const secret = "s".repeat(40);

describe("signSession / verifySession", () => {
  it("round-trips the user ID", () => {
    expect(verifySession(signSession("user-1", { secret }), { secret })).toEqual({
      userId: "user-1",
    });
  });

  it("expires after seven days", () => {
    const { exp, iat } = jwt.decode(signSession("user-1", { secret }));

    expect(exp - iat).toBe(SESSION_TTL_SECONDS);
    expect(SESSION_TTL_SECONDS).toBe(604_800);
  });

  it.each([
    ["no token", undefined],
    ["garbage", "not-a-jwt"],
    [
      "a token signed with another secret",
      jwt.sign({}, "x".repeat(40), { subject: "u", issuer: "llmux", audience: "llmux-dashboard" }),
    ],
    [
      "an expired token",
      jwt.sign({}, secret, {
        subject: "u",
        issuer: "llmux",
        audience: "llmux-dashboard",
        expiresIn: -10,
      }),
    ],
    [
      "a token for another audience",
      jwt.sign({}, secret, { subject: "u", issuer: "llmux", audience: "something-else" }),
    ],
    [
      "a token from another issuer",
      jwt.sign({}, secret, { subject: "u", issuer: "evil", audience: "llmux-dashboard" }),
    ],
    [
      "a token without a subject",
      jwt.sign({}, secret, { issuer: "llmux", audience: "llmux-dashboard" }),
    ],
  ])("rejects %s", (_label, token) => {
    expect(verifySession(token, { secret })).toBeNull();
  });

  it('rejects an unsigned token (alg "none")', () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "admin", iss: "llmux", aud: "llmux-dashboard", exp: 9_999_999_999 }),
    ).toString("base64url");

    expect(verifySession(`${header}.${payload}.`, { secret })).toBeNull();
  });
});

describe("sessionCookieOptions", () => {
  it("is httpOnly and scoped to /api everywhere", () => {
    for (const production of [true, false]) {
      expect(sessionCookieOptions({ production })).toMatchObject({ httpOnly: true, path: "/api" });
    }
  });

  it("uses SameSite=None with Secure in production, for a dashboard on another site", () => {
    expect(sessionCookieOptions({ production: true })).toMatchObject({
      secure: true,
      sameSite: "none",
    });
  });

  it("uses SameSite=Lax without Secure locally, where everything is on localhost over HTTP", () => {
    expect(sessionCookieOptions({ production: false })).toMatchObject({
      secure: false,
      sameSite: "lax",
    });
  });
});

describe("readCookie", () => {
  it("finds one cookie among several", () => {
    expect(readCookie("theme=dark; llmux_session=abc.def.ghi; other=1", "llmux_session")).toBe(
      "abc.def.ghi",
    );
  });

  it("returns undefined when the cookie or header is missing", () => {
    expect(readCookie("theme=dark", "llmux_session")).toBeUndefined();
    expect(readCookie(undefined, "llmux_session")).toBeUndefined();
  });

  it("does not match a cookie whose name merely ends the same way", () => {
    expect(readCookie("not_llmux_session=x", "llmux_session")).toBeUndefined();
  });

  it("ignores malformed encoding instead of throwing", () => {
    expect(readCookie("llmux_session=%E0%A4%A", "llmux_session")).toBeUndefined();
  });
});
