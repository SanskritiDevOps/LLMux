/**
 * The ioredis commands LLMux uses, kept in memory, so tests do not need a Redis server:
 * get, set (with EX or PX, and NX), del, incr and pexpire. Expiry follows Date.now(), so
 * vi.useFakeTimers() moves it. `failing: true` makes every command reject, to test how
 * code behaves when Redis is down. The real client is covered by the real-Redis tests.
 */
export function fakeRedis({ failing = false } = {}) {
  const store = new Map();
  const down = () => Promise.reject(new Error("Redis is down (fake)"));

  /** The live entry for a key, removing it first if it has expired. */
  function entry(key) {
    const found = store.get(key);
    if (found?.expiresAt && found.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return found;
  }

  return {
    store,
    calls: [],
    async get(key) {
      this.calls.push(["get", key]);
      if (failing) return down();
      return entry(key)?.value ?? null;
    },
    /** set(key, value) plus any of "EX", seconds / "PX", ms / "NX", like ioredis. */
    async set(key, value, ...options) {
      this.calls.push(["set", key, value, ...options]);
      if (failing) return down();
      const upper = options.map((option) =>
        typeof option === "string" ? option.toUpperCase() : option,
      );
      if (upper.includes("NX") && entry(key)) return null;
      let expiresAt = null;
      let ttlSeconds;
      const ex = upper.indexOf("EX");
      const px = upper.indexOf("PX");
      if (ex !== -1) {
        ttlSeconds = upper[ex + 1];
        expiresAt = Date.now() + ttlSeconds * 1000;
      } else if (px !== -1) {
        expiresAt = Date.now() + upper[px + 1];
      }
      store.set(key, { value: String(value), expiresAt, ttlSeconds });
      return "OK";
    },
    async del(...keys) {
      this.calls.push(["del", ...keys]);
      if (failing) return down();
      let removed = 0;
      for (const key of keys) if (entry(key) && store.delete(key)) removed += 1;
      return removed;
    },
    async incr(key) {
      this.calls.push(["incr", key]);
      if (failing) return down();
      const current = entry(key);
      const next = Number(current?.value ?? 0) + 1;
      store.set(key, { value: String(next), expiresAt: current?.expiresAt ?? null });
      return next;
    },
    async pexpire(key, ms) {
      this.calls.push(["pexpire", key, ms]);
      if (failing) return down();
      const current = entry(key);
      if (!current) return 0;
      current.expiresAt = Date.now() + ms;
      return 1;
    },
  };
}
