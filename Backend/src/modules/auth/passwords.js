import bcrypt from "bcryptjs";
import { env } from "../../config/env.js";

/**
 * Passwords are short and chosen by people, so they are hashed with bcrypt, which is slow
 * on purpose. (Gateway keys use SHA-256 instead: see keyGenerator.js.)
 *
 * Cost 12 takes about 0.25 s per hash on a laptop: unnoticeable for one login, expensive
 * for anyone guessing at scale. Tests use cost 4 so the suite stays fast; the algorithm
 * and code path are identical.
 */
export const BCRYPT_ROUNDS = env.NODE_ENV === "test" ? 4 : 12;

/**
 * Runs at most `max` of the given tasks at once; the rest wait their turn, in order.
 *
 * bcryptjs is plain JavaScript on the one main thread. On a small CPU (Render's free plan),
 * ten logins at once kept it so busy that opening a Postgres connection passed its 5 s
 * timeout and two logins failed with 500. Queued hashes take as long in total, but leave
 * the CPU room for everything else.
 *
 * @param {number} max
 */
export function createTaskQueue(max) {
  let running = 0;
  const waiting = [];
  return async function run(task) {
    if (running >= max) await new Promise((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

const hashing = createTaskQueue(2);

export function hashPassword(plain) {
  return hashing(() => bcrypt.hash(plain, BCRYPT_ROUNDS));
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
  const matches = await hashing(() => bcrypt.compare(plain, hash ?? dummyHash));
  return Boolean(hash) && matches;
}
