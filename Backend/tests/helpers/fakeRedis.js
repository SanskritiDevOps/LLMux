/**
 * The few ioredis commands LLMux uses (get, set with EX, del), kept in memory, so tests
 * do not need a Redis server. `failing: true` makes every command reject, to test how
 * code behaves when Redis is down. The real client is covered by the real-Redis tests.
 */
export function fakeRedis({ failing = false } = {}) {
  const store = new Map();
  const down = () => Promise.reject(new Error("Redis is down (fake)"));

  return {
    store,
    calls: [],
    async get(key) {
      this.calls.push(["get", key]);
      if (failing) return down();
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, mode, seconds) {
      this.calls.push(["set", key, value, mode, seconds]);
      if (failing) return down();
      const expiresAt = mode === "EX" ? Date.now() + seconds * 1000 : null;
      store.set(key, { value: String(value), expiresAt, ttlSeconds: seconds });
      return "OK";
    },
    async del(key) {
      this.calls.push(["del", key]);
      if (failing) return down();
      return store.delete(key) ? 1 : 0;
    },
  };
}
