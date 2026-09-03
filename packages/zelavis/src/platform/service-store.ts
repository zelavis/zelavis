import type {
  ZelavisSystemStore,
  ZelavisSystemStoreValue,
} from "../system-store.js";

/**
 * Durable storage an installed service may use.
 *
 * Services were told whether the host had a key-value store but never given
 * one, so anything a plugin needed to remember — which connections an operator
 * configured, what a provider was issued — had no home. With services no longer
 * composed in code, there was no way to hand them one either.
 *
 * The namespace is fixed to the service that asked, so a plugin cannot read or
 * overwrite another one's records, and the Platform's own namespaces stay out
 * of reach. It is deliberately small: enough to keep a service's own state,
 * not a general database.
 */
export interface ZelavisServiceStore {
  get(key: string): Promise<ZelavisSystemStoreValue | undefined>;
  set(key: string, value: ZelavisSystemStoreValue): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(): Promise<readonly { key: string; value: ZelavisSystemStoreValue }[]>;
}

/** Namespace prefix separating service state from the Platform's own. */
const SERVICE_NAMESPACE_PREFIX = "zelavis.service";

export function serviceStoreNamespace(serviceName: string): string {
  const normalized = serviceName.trim();
  if (!normalized) {
    throw new TypeError("A service name is required to scope its store.");
  }
  // The service name goes in whole rather than being sanitized into something
  // shorter: two services whose names collapsed to the same namespace would
  // silently share state.
  return `${SERVICE_NAMESPACE_PREFIX}:${normalized}`;
}

export function createServiceStore(
  systemStore: ZelavisSystemStore,
  serviceName: string,
): ZelavisServiceStore {
  const namespace = serviceStoreNamespace(serviceName);

  const store: ZelavisServiceStore = {
    async get(key: string) {
      return (await systemStore.get(namespace, key))?.value;
    },
    async set(key: string, value: ZelavisSystemStoreValue) {
      await systemStore.set(namespace, key, value);
    },
    async delete(key: string) {
      return systemStore.delete(namespace, key);
    },
    async list() {
      return Object.freeze(
        (await systemStore.list(namespace)).map((record) =>
          Object.freeze({ key: record.key, value: record.value }),
        ),
      );
    },
  };
  return Object.freeze(store);
}
