import { Effect, Semaphore } from "effect";
import type { ZelavisSystemStore } from "../../system-store.js";
import type { ZelavisServerDispatchResult } from "./contracts.js";
import { integration } from "./effect-boundary.js";

const namespace = "zelavis.runtime.api-usage";

/** API availability never depends on usage. Usage only describes which native
 * surfaces a service has exercised, and belongs to this runtime's own store. */
export const createRuntimeApiUsage = Effect.fn("RuntimeApiUsage.create")(function* (store?: ZelavisSystemStore) {
  const used = new Set<string>();
  const persisted = new Set<string>();
  const writes = Semaphore.makeUnsafe(1);
  if (store) {
    const records = yield* integration(() => store.list(namespace));
    for (const record of records) if (record.value === true) {
      used.add(record.key);
      persisted.add(record.key);
    }
  }
  const flush = writes.withPermit(Effect.gen(function* () {
    if (!store) return;
    for (const capability of used) if (!persisted.has(capability)) {
      yield* integration(() => store.setIfAbsent(namespace, capability, true));
      persisted.add(capability);
    }
  }));
  const observe = <A>(api: A, capability: string): A => {
    if (!api || typeof api !== "object") return api;
    const wrappers = new WeakMap<object, object>();
    const wrap = (target: object): object => {
      const existing = wrappers.get(target);
      if (existing) return existing;
      // A facade also supports frozen API objects without violating Proxy
      // invariants. Calls retain the original receiver and return contract.
      const facade = new Proxy({}, {
        get(_facade, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value === "function") return (...args: unknown[]) => {
            used.add(capability);
            return Reflect.apply(value, target, args);
          };
          return value && typeof value === "object" ? wrap(value) : value;
        },
        has: (_facade, key) => Reflect.has(target, key),
        ownKeys: () => Reflect.ownKeys(target),
        getOwnPropertyDescriptor: (_facade, key) => Reflect.has(target, key)
          ? { enumerable: true, configurable: true, value: Reflect.get(target, key) } : undefined,
      });
      wrappers.set(target, facade);
      return facade;
    };
    return wrap(api) as A;
  };
  return {
    observe,
    flush,
    capabilities: (available: Readonly<Record<string, { available: boolean }>>) => Object.fromEntries(
      Object.entries(available).map(([name, value]) => [name, { ...value, get used() { return used.has(name); } }]),
    ),
    record: (result: ZelavisServerDispatchResult) => {
      const origin = result.resolvedRoute?.endpointGroup.origin;
      if (result.response.ok && origin?.type === "subsystem") used.add(origin.subsystem);
    },
  };
});
