/**
 * Looks adapters up by provider name. The gateway only ever talks to adapters through
 * a registry, so adding a provider means adding it to the list in providers/index.js.
 *
 * @param {Readonly<import("./adapter.js").ProviderAdapter>[]} adapters
 */
export function createAdapterRegistry(adapters) {
  const byName = new Map();
  for (const adapter of adapters) {
    if (byName.has(adapter.name)) {
      throw new TypeError(`Adapter "${adapter.name}" is registered twice`);
    }
    byName.set(adapter.name, adapter);
  }

  return Object.freeze({
    has: (name) => byName.has(name),
    names: () => [...byName.keys()],
    /** Throws if missing: the router only returns configured providers, so this is a bug. */
    get(name) {
      const adapter = byName.get(name);
      if (!adapter) {
        throw new Error(`No adapter registered for provider "${name}"`);
      }
      return adapter;
    },
  });
}
