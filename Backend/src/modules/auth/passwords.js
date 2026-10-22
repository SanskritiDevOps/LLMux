import bcrypt from "bcryptjs";
import { env } from "../../config/env.js";

/**
 * Passwords are short and chosen by people, so they are hashed with bcrypt, which is slow
 * on purpose. (Gateway keys are long random strings and use SHA-256 instead; see Day 6.)
 *
 * Cost 12 takes about 0.25 s per hash on a laptop: unnoticeable for one login, expensive
 * for anyone guessing at scale. Tests use cost 4 so the suite stays fast; the algorithm
 * and code path are identical.
 */
export const BCRYPT_ROUNDS = env.NODE_ENV === "test" ? 4 : 12;

export function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

// Compared against when the email does not exist, so a login for an unknown email takes
// as long as one with a wrong password and the response time reveals nothing.
const dummyHash = bcrypt.hashSync("llmux-timing-equaliser", BCRYPT_ROUNDS);

/**
 * @param {string} plain
 * @param {string | null | undefined} hash  null when no such user exists
 * @returns {Promise<boolean>}
 */
export async function checkPassword(plain, hash) {
  const matches = await bcrypt.compare(plain, hash ?? dummyHash);
  return Boolean(hash) && matches;
}
