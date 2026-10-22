import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";

/**
 * Dashboard sessions are JWTs kept in an httpOnly cookie, so page JavaScript (and any
 * cross-site scripting bug) can never read them. Gateway keys for /v1 are a separate
 * system (Day 6); a session can never call /v1 and a gateway key can never call /api.
 */

export const SESSION_COOKIE = "llmux_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const ISSUER = "llmux";
const AUDIENCE = "llmux-dashboard";

/** @param {string} userId */
export function signSession(userId, { secret = env.JWT_SECRET } = {}) {
  return jwt.sign({}, secret, {
    algorithm: "HS256",
    subject: userId,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: SESSION_TTL_SECONDS,
  });
}

/**
 * @returns {{ userId: string } | null}  null for anything invalid: bad signature, expired,
 *   wrong issuer or audience, another algorithm, or not a JWT at all
 */
export function verifySession(token, { secret = env.JWT_SECRET } = {}) {
  if (!token) return null;
  try {
    // Pinning the algorithm stops a token signed with "none" or another scheme from passing.
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return typeof payload.sub === "string" ? { userId: payload.sub } : null;
  } catch {
    return null;
  }
}

/**
 * Cookie settings. In production the dashboard and API are on different sites (for example
 * Vercel and Render), which requires SameSite=None with Secure; that cross-site exposure is
 * why state-changing /api requests also pass an Origin check (middleware/originCheck.js).
 * Locally both run on localhost, which counts as the same site, so Lax works over plain HTTP.
 */
export function sessionCookieOptions({ production = env.NODE_ENV === "production" } = {}) {
  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? "none" : "lax",
    // Only sent to the dashboard API, never to /v1.
    path: "/api",
    maxAge: SESSION_TTL_SECONDS * 1000,
  };
}

/** Reads one cookie from a Cookie header, without a parsing dependency. */
export function readCookie(header, name) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
