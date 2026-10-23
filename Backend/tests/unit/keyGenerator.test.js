import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  KEY_PREFIX,
  VISIBLE_PREFIX_LENGTH,
  generateKey,
  hashKey,
  isWellFormedKey,
} from "../../src/modules/keys/keyGenerator.js";

describe("generateKey", () => {
  it("makes llmux_sk_ keys with 43 base64url characters (32 random bytes)", () => {
    const { key } = generateKey();

    expect(key).toMatch(/^llmux_sk_[A-Za-z0-9_-]{43}$/);
    expect(key).toHaveLength(KEY_PREFIX.length + 43);
    expect(Buffer.from(key.slice(KEY_PREFIX.length), "base64url")).toHaveLength(32);
  });

  it("returns a visible prefix like llmux_sk_9f3a, the start of the key", () => {
    const { key, prefix } = generateKey();

    expect(prefix).toHaveLength(VISIBLE_PREFIX_LENGTH);
    expect(prefix).toHaveLength(13);
    expect(key.startsWith(prefix)).toBe(true);
  });

  it("returns the SHA-256 hex digest of the key as its hash", () => {
    const { key, hash } = generateKey();

    expect(hash).toBe(createHash("sha256").update(key).digest("hex"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(key.slice(KEY_PREFIX.length));
  });

  it("never repeats a key", () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateKey().key));

    expect(keys.size).toBe(1000);
  });
});

describe("hashKey", () => {
  it("is stable, so the same key always finds the same row", () => {
    expect(hashKey("llmux_sk_abc")).toBe(hashKey("llmux_sk_abc"));
  });

  it("differs for keys that differ by one character", () => {
    expect(hashKey("llmux_sk_abc")).not.toBe(hashKey("llmux_sk_abd"));
  });
});

describe("isWellFormedKey", () => {
  it("accepts a generated key", () => {
    expect(isWellFormedKey(generateKey().key)).toBe(true);
  });

  it.each([
    ["the wrong prefix", `llmux_pk_${"a".repeat(43)}`],
    ["a key that is too short", `llmux_sk_${"a".repeat(42)}`],
    ["a key that is too long", `llmux_sk_${"a".repeat(44)}`],
    ["characters outside base64url", `llmux_sk_${"a".repeat(42)}=`],
    ["a dashboard JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig"],
    ["an empty string", ""],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(isWellFormedKey(value)).toBe(false);
  });
});
