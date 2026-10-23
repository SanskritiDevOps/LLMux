import { createHash, randomBytes } from "node:crypto";

/**
 * Gateway keys look like llmux_sk_<43 base64url characters>: 32 random bytes, so 256 bits
 * that cannot be guessed. The fixed prefix makes a leaked key easy to recognise in a
 * secret scanner or a log, and tells a key apart from a dashboard session token.
 */
export const KEY_PREFIX = "llmux_sk_";
const RANDOM_BYTES = 32;

// The part shown in the dashboard so people can tell their keys apart, e.g. llmux_sk_9f3a.
export const VISIBLE_PREFIX_LENGTH = KEY_PREFIX.length + 4;

const KEY_PATTERN = /^llmux_sk_[A-Za-z0-9_-]{43}$/;

/**
 * SHA-256, not bcrypt: the key is long and random, so it cannot be brute-forced, and it is
 * checked on every /v1 request, where bcrypt's deliberate slowness would add ~0.25 s.
 * (Passwords are short and human-chosen, which is why they use bcrypt.)
 */
export function hashKey(key) {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Cheap shape check before any lookup, so junk never reaches Redis or Postgres. */
export function isWellFormedKey(value) {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

/**
 * @returns {{ key: string, prefix: string, hash: string }}  `key` is shown to the user
 *   exactly once; only `prefix` and `hash` are stored
 */
export function generateKey() {
  const key = KEY_PREFIX + randomBytes(RANDOM_BYTES).toString("base64url");
  return { key, prefix: key.slice(0, VISIBLE_PREFIX_LENGTH), hash: hashKey(key) };
}
