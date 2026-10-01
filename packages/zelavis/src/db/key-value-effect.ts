// @effect-diagnostics unstableApiUsage:off
// Effect's `KeyValueStore` is tagged `@stability unstable`: it can change in a
// minor release. This file is the one place it is used, so the acknowledgement is
// here and nowhere else, and a break upstream touches only this bridge: the
// native KV API in `key-value.ts` does not depend on it. Any other use of an
// unstable Effect API in this package is still flagged.
import { Effect, Layer, Result, Schema } from "effect";
import * as Base64 from "effect/encoding/Base64";
import * as EffectKeyValueStore from "effect/persistence/KeyValueStore";
import type { JsonObject } from "./documents.js";
import type { KeyValueEntry, KvNamespaceApi } from "./key-value.js";

/** JSON-visible representation used for Effect string and byte values. */
export interface EffectStoredValue extends JsonObject {
  readonly encoding: "utf8" | "base64";
  readonly value: string;
}

const EffectStoredValueSchema = Schema.Struct({
  encoding: Schema.Literals(["utf8", "base64"]),
  value: Schema.String,
});
const decodeEffectStoredValue = Schema.decodeUnknownEffect(EffectStoredValueSchema);

const effectError = (method: string, cause: unknown, key?: string) =>
  new EffectKeyValueStore.KeyValueStoreError({
    method,
    ...(key === undefined ? {} : { key }),
    message: key === undefined ? `Zelavis key/value ${method} failed` : `Zelavis key/value ${method} failed for ${key}`,
    cause,
  });

/** Effect v4's persistence service backed by one Zelavis KV/document lens. */
export const toEffectKeyValueStore = (
  namespace: KvNamespaceApi,
): EffectKeyValueStore.KeyValueStore => {
  const attempt = <A>(method: string, effect: Effect.Effect<A, unknown>, key?: string) =>
    Effect.mapError(effect, (cause) => effectError(method, cause, key));
  const read = (
    key: string,
  ): Effect.Effect<KeyValueEntry<EffectStoredValue> | undefined, EffectKeyValueStore.KeyValueStoreError> => Effect.flatMap(
    attempt("get", namespace.get(key), key),
    (entry) => entry === undefined
      ? Effect.as(Effect.void, undefined as KeyValueEntry<EffectStoredValue> | undefined)
      : Effect.mapError(
          Effect.map(
            decodeEffectStoredValue(entry.value),
            (value) => ({ ...entry, value }) as KeyValueEntry<EffectStoredValue>,
          ),
          (cause) => effectError("get", cause, key),
        ),
  );
  const modify = (
    method: string,
    key: string,
    transform: (value: EffectStoredValue) => EffectStoredValue,
  ): Effect.Effect<EffectStoredValue | undefined, EffectKeyValueStore.KeyValueStoreError> =>
    Effect.gen(function* () {
      for (let retries = 0; retries < 16; retries += 1) {
        const held = yield* read(key);
        if (held === undefined) return undefined;
        const value = transform(held.value);
        const result = yield* Effect.result(attempt(
          method,
          namespace.set(key, value, { expectedVersion: held.version }),
          key,
        ));
        if (Result.isSuccess(result)) return value;
        const cause = result.failure.cause as { readonly _tag?: string } | undefined;
        if (cause?._tag !== "DocumentConflict") return yield* result.failure;
      }
      return yield* effectError(
        method,
        new Error("atomic modification exceeded 16 compare-and-set retries"),
        key,
      );
    });

  return EffectKeyValueStore.make({
    get: (key) => Effect.map(read(key), (entry) =>
      entry === undefined
        ? undefined
        : entry.value.encoding === "utf8"
          ? entry.value.value
          : entry.value.value),
    getUint8Array: (key) => Effect.map(read(key), (entry) =>
      entry === undefined
        ? undefined
        : entry.value.encoding === "utf8"
          ? new TextEncoder().encode(entry.value.value)
          : Base64.decode(entry.value.value).pipe((result) => {
              if (result._tag === "Failure") throw result.failure;
              return result.success;
            })),
    set: (key, value) => attempt(
      "set",
      namespace.set(key, typeof value === "string"
        ? { encoding: "utf8", value }
        : { encoding: "base64", value: Base64.encode(value) }),
      key,
    ).pipe(Effect.asVoid),
    remove: (key) => attempt("remove", namespace.remove(key), key).pipe(Effect.asVoid),
    clear: attempt("clear", namespace.clear).pipe(Effect.asVoid),
    size: attempt("size", namespace.size),
    modify: (key, f) => Effect.map(
      modify("modify", key, (held) => ({ encoding: "utf8", value: f(
        held.encoding === "utf8" ? held.value : held.value,
      ) })),
      (value) => value?.value,
    ),
    modifyUint8Array: (key, f) => Effect.map(
      modify("modifyUint8Array", key, (held) => {
        const bytes = held.encoding === "utf8"
          ? new TextEncoder().encode(held.value)
          : Base64.decode(held.value).pipe((result) => {
              if (result._tag === "Failure") throw result.failure;
              return result.success;
            });
        return { encoding: "base64", value: Base64.encode(f(bytes)) };
      }),
      (value) => value === undefined ? undefined : Base64.decode(value.value).pipe((result) => {
        if (result._tag === "Failure") throw result.failure;
        return result.success;
      }),
    ),
  });
};

/** Provide Effect's service tag without exposing its unstable API as Zelavis's contract. */
export const effectKeyValueStoreLayer = (
  namespace: KvNamespaceApi,
): Layer.Layer<EffectKeyValueStore.KeyValueStore> =>
  Layer.succeed(EffectKeyValueStore.KeyValueStore, toEffectKeyValueStore(namespace));
