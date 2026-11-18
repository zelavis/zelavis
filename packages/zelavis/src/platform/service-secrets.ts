import { Effect, Schema, Semaphore } from "effect";
import { decryptSecret, encryptSecret } from "../edge/acme-crypto.js";
import { evaluate, integration, present } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";

/** Sealed credentials scoped to the service receiving this object. */
export interface ZelavisServiceSecrets {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
  list(): Promise<readonly string[]>;
}

const storedSecret = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sealed: Schema.Struct({ algorithm: Schema.Literal("AES-256-GCM"), ciphertext: Schema.String.check(Schema.isMaxLength(5462), Schema.isPattern(/^[A-Za-z0-9_-]*$/u)), iv: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16}$/u)), tag: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/u)) }),
  updatedAt: Schema.String,
});
const permits = new WeakMap<ZelavisSystemStore, Map<string, Semaphore.Semaphore>>();

export function createServiceSecrets(store: ZelavisSystemStore, serviceName: string, masterSecret: string): ZelavisServiceSecrets {
  if (!serviceName.trim() || !masterSecret) throw new TypeError("Service secrets require a service name and master secret.");
  const namespace = `zelavis.service-secrets:${serviceName}`;
  const scopes = permits.get(store) ?? new Map<string, Semaphore.Semaphore>();
  permits.set(store, scopes);
  const permit = scopes.get(namespace) ?? Semaphore.makeUnsafe(1);
  scopes.set(namespace, permit);
  const validateName = (name: string) => evaluate(() => {
    if (typeof name !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(name)) throw new TypeError("Invalid service secret name.");
    return name;
  });
  const key = (name: string) => `${masterSecret}\u0000service-secret:${serviceName}:${name}`;
  const names = Effect.fn(function* () {
    const page = yield* integration(() => store.page(namespace, { limit: 33 }));
    if (page.records.length > 32 || page.next) return yield* evaluate(() => { throw new TypeError("Service secret limit exceeded."); });
    return Object.freeze(page.records.map(record => record.key));
  });
  return Object.freeze({
    get: (name: string) => present(Effect.gen(function* () {
      yield* validateName(name);
      const record = yield* integration(() => store.get(namespace, name));
      if (!record) return undefined;
      return yield* evaluate(() => {
        const value = Schema.decodeUnknownSync(storedSecret)(record.value);
        if (!Number.isFinite(Date.parse(value.updatedAt))) throw new TypeError("Invalid service secret record.");
        return decryptSecret(value.sealed, key(name));
      });
    })),
    set: (name: string, value: string) => present(permit.withPermit(Effect.gen(function* () {
      yield* validateName(name);
      yield* evaluate(() => {
        if (typeof value !== "string" || new TextEncoder().encode(value).length > 4096) throw new TypeError("Service secrets must contain at most 4096 bytes.");
      });
      const existing = yield* names();
      if (!existing.includes(name) && existing.length >= 32) return yield* evaluate(() => { throw new TypeError("A service may keep at most 32 secrets."); });
      const sealed = yield* evaluate(() => encryptSecret(value, key(name)));
      yield* integration(() => store.set(namespace, name, { schemaVersion: 1, sealed: { ...sealed }, updatedAt: new Date().toISOString() } satisfies ZelavisSystemStoreValue));
    }))),
    delete: (name: string) => present(permit.withPermit(Effect.gen(function* () {
      yield* validateName(name);
      return yield* integration(() => store.delete(namespace, name));
    }))),
    list: () => present(names()),
  });
}
