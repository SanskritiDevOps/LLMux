import { randomUUID } from "node:crypto";
import { generateKey } from "../../src/modules/keys/keyGenerator.js";

/**
 * Creates a real gateway key in a keys repository (fake or real) and returns what a client
 * would send, so tests of /v1 can authenticate the same way an app does.
 */
export async function seedKey(keys, { userId = randomUUID(), name = "test-key" } = {}) {
  const { key, prefix, hash } = generateKey();
  const row = await keys.create({
    userId,
    name,
    keyPrefix: prefix,
    keyHash: hash,
    rateLimitPerMin: null,
  });
  return { apiKey: key, row, authorization: `Bearer ${key}` };
}
