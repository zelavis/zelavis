import { Clock, Effect, Encoding, Layer, Result, Schema } from "effect";
import * as EffectKeyValueStore from "effect/unstable/persistence/KeyValueStore";
import type {
  Document,
  DocumentsApi,
  DocumentWrite,
  JsonObject,
} from "./documents.js";
import type { DomainEvent, DomainEventsApi } from "./domain-events.js";
import type { EventCursor } from "./events.js";
import type { ObjectStoreApi } from "./store.js";
import type { TenantId } from "./topology.js";

declare const KvCursorBrand: unique symbol;

/** Opaque continuation for a scan of one namespace. */
export type KvCursor = string & { readonly [KvCursorBrand]: true };

export interface KeyValueEntry<Value = JsonObject> {
  readonly key: string;
  readonly value: Value;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}

export interface KvSetOptions {
  /** Refuse unless this is still the stored version. */
  readonly expectedVersion?: number;
  /** Refuse when the key already exists. */
  readonly ifAbsent?: boolean;
  /** Apply a retried request at most once. */
  readonly idempotencyKey?: string;
  /** Absolute expiry as an ISO-8601 timestamp. Mutually exclusive with `ttlMs`. */
  readonly expiresAt?: string;
  /** Lifetime from the database clock, in milliseconds. Mutually exclusive with `expiresAt`. */
  readonly ttlMs?: number;
}

export type KeyValueWrite<Value extends JsonObject = JsonObject> =
  | {
    readonly _tag: "Set";
    readonly key: string;
    readonly value: Value;
    readonly expectedVersion?: number;
    readonly ifAbsent?: boolean;
    readonly expiresAt?: string;
    readonly ttlMs?: number;
  }
  | {
    readonly _tag: "Remove";
    readonly key: string;
    readonly expectedVersion?: number;
  };

export interface KvPage<Value extends JsonObject = JsonObject> {
  readonly entries: ReadonlyArray<KeyValueEntry<Value>>;
  readonly next?: KvCursor;
}

export interface KeyValueChange<Value = JsonObject> {
  readonly cursor: EventCursor;
  readonly eventId: string;
  readonly key: string;
  readonly type: "set" | "remove";
  readonly revision: number;
  readonly timestamp: string;
  readonly value?: Value;
}

export class InvalidKeyValueExpiration extends Schema.TaggedError<InvalidKeyValueExpiration>()(
  "InvalidKeyValueExpiration",
  { reason: Schema.String },
) {}

export class KeyValueCursorMismatch extends Schema.TaggedError<KeyValueCursorMismatch>()(
  "KeyValueCursorMismatch",
  { reason: Schema.String },
) {}

export class InvalidKeyValueEncoding extends Schema.TaggedError<InvalidKeyValueEncoding>()(
  "InvalidKeyValueEncoding",
  { reason: Schema.String },
) {}

export interface SchemaKeyValueNamespaceApi<S extends Schema.Constraint> {
  readonly get: (key: string) => Effect.Effect<
    KeyValueEntry<S["Type"]> | undefined,
    KeyValueError | Schema.SchemaError,
    S["DecodingServices"]
  >;
  readonly set: (key: string, value: S["Type"], options?: KvSetOptions) => Effect.Effect<
    KeyValueEntry<S["Type"]>,
    KeyValueError | Schema.SchemaError | InvalidKeyValueEncoding,
    S["EncodingServices"] | S["DecodingServices"]
  >;
  readonly scan: (options?: KeyValueScanOptions) => Effect.Effect<
    { readonly entries: ReadonlyArray<KeyValueEntry<S["Type"]>>; readonly next?: KvCursor },
    KeyValueError | Schema.SchemaError,
    S["DecodingServices"]
  >;
  readonly changes: (options?: KvChangesOptions) => Effect.Effect<
    ReadonlyArray<KeyValueChange<S["Type"]>>,
    KeyValueError | Schema.SchemaError,
    S["DecodingServices"]
  >;
}

export interface KeyValueScanOptions {
  readonly prefix?: string;
  /** Inclusive lower key bound. */
  readonly lower?: string;
  /** Exclusive upper key bound. */
  readonly upper?: string;
  readonly direction?: "asc" | "desc";
  readonly limit?: number;
  readonly after?: KvCursor;
}

export interface KvChangesOptions {
  readonly after?: EventCursor;
  readonly limit?: number;
}

/**
 * A key/value view of one document collection.
 *
 * The key is the document id and the value is the document payload. This is a
 * lens, not another source of truth: writes emit the same events and populate
 * the same column, search, measure, graph, spatial and vector projections as a
 * document write.
 */
export interface KvNamespaceApi<Value extends JsonObject = JsonObject> {
  readonly name: string;
  readonly get: (key: string) => Effect.Effect<KeyValueEntry<Value> | undefined, KeyValueError>;
  readonly has: (key: string) => Effect.Effect<boolean, KeyValueError>;
  readonly set: (
    key: string,
    value: Value,
    options?: KvSetOptions,
  ) => Effect.Effect<KeyValueEntry<Value>, KeyValueError>;
  readonly remove: (
    key: string,
    options?: Pick<KvSetOptions, "expectedVersion" | "idempotencyKey">,
  ) => Effect.Effect<boolean, KeyValueError>;
  /** Stable opaque-cursor order. A prefix narrows the returned keys. */
  readonly scan: (options?: KeyValueScanOptions) => Effect.Effect<KvPage<Value>, KeyValueError>;
  /** Document events for this namespace; continuation uses the returned event cursor. */
  readonly changes: (options?: KvChangesOptions) => Effect.Effect<ReadonlyArray<KeyValueChange<Value>>, KeyValueError>;
  readonly write: (
    operations: ReadonlyArray<KeyValueWrite<Value>>,
    options?: { readonly idempotencyKey?: string },
  ) => Effect.Effect<ReadonlyArray<KeyValueEntry<Value> | { readonly key: string; readonly deleted: boolean }>, KeyValueError>;
  readonly size: Effect.Effect<number, KeyValueError>;
  readonly clear: Effect.Effect<number, KeyValueError>;
  /** Decode and encode values through an Effect Schema while preserving the same KV namespace. */
  readonly schema: <S extends Schema.Constraint>(schema: S) => SchemaKeyValueNamespaceApi<S>;
}

export interface KeyValueApi {
  /** Address any collection as key/value data without copying its payloads. */
  readonly namespace: <Value extends JsonObject = JsonObject>(name: string) => KvNamespaceApi<Value>;
}

type EffectFailure<Value> = Value extends Effect.Effect<unknown, infer Error, unknown> ? Error : never;
type MethodEffect<Method> = Method extends (...args: ReadonlyArray<never>) => infer Value ? Value : never;

/** Failures inherited from the one document write/read path KV uses. */
export type KeyValueError =
  | EffectFailure<MethodEffect<DocumentsApi["findById"]>>
  | EffectFailure<MethodEffect<DocumentsApi["findPage"]>>
  | EffectFailure<MethodEffect<DocumentsApi["findMany"]>>
  | EffectFailure<MethodEffect<DocumentsApi["write"]>>
  | EffectFailure<MethodEffect<DocumentsApi["delete"]>>
  | EffectFailure<MethodEffect<ObjectStoreApi["scanIdentities"]>>
  | InvalidKeyValueExpiration
  | KeyValueCursorMismatch;

const entryOf = <Value extends JsonObject>(document: Document): KeyValueEntry<Value> => ({
  key: document.id,
  value: document.data as Value,
  version: document.version,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  ...(document.expiresAt === undefined ? {} : { expiresAt: document.expiresAt }),
});

const pageLimit = (value: number | undefined): number => {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError(`A key/value scan takes 1 to 1000 entries, not ${String(limit)}.`);
  }
  return limit;
};

interface CursorPayload {
  readonly v: 1;
  readonly namespace: string;
  readonly key: string;
  readonly prefix?: string;
  readonly lower?: string;
  readonly upper?: string;
  readonly direction: "asc" | "desc";
}

const encodeCursor = (payload: CursorPayload): KvCursor =>
  Encoding.encodeBase64Url(JSON.stringify(payload)) as KvCursor;

const decodeCursor = (cursor: KvCursor): Effect.Effect<CursorPayload, KeyValueCursorMismatch> =>
  Effect.try({
    try: () => {
      const decoded = Encoding.decodeBase64UrlString(cursor);
      if (Result.isFailure(decoded)) throw decoded.failure;
      const value = JSON.parse(decoded.success) as Partial<CursorPayload>;
      if (value.v !== 1 || typeof value.namespace !== "string" || typeof value.key !== "string"
        || (value.direction !== "asc" && value.direction !== "desc")) throw new Error("invalid cursor payload");
      return value as CursorPayload;
    },
    catch: (cause) => new KeyValueCursorMismatch({ reason: `invalid key/value cursor: ${String(cause)}` }),
  });

const documentNamespace = (tenant: TenantId, collection: string): string =>
  `doc/${tenant}/${collection}`;

const expirationOptions = (options: Pick<KvSetOptions, "expiresAt" | "ttlMs"> | undefined) =>
  Effect.gen(function* () {
    if (options?.expiresAt !== undefined && options.ttlMs !== undefined) {
      return yield* new InvalidKeyValueExpiration({ reason: "expiresAt and ttlMs are mutually exclusive" });
    }
    if (options?.ttlMs !== undefined) {
      if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 0) {
        return yield* new InvalidKeyValueExpiration({ reason: "ttlMs must be a non-negative safe integer" });
      }
      return { ttlMs: options.ttlMs } as const;
    }
    if (options?.expiresAt !== undefined) {
      const millis = Date.parse(options.expiresAt);
      if (!Number.isFinite(millis)) {
        return yield* new InvalidKeyValueExpiration({ reason: "expiresAt must be a valid ISO-8601 timestamp" });
      }
      return { expiresAt: new Date(millis).toISOString() } as const;
    }
    return {};
  });

const sameScan = (cursor: CursorPayload, namespace: string, options: KeyValueScanOptions | undefined) =>
  cursor.namespace === namespace
  && cursor.prefix === options?.prefix
  && cursor.lower === options?.lower
  && cursor.upper === options?.upper
  && cursor.direction === (options?.direction ?? "asc");

const valueFromEvent = <Value>(event: DomainEvent): Value | undefined =>
  event.type === "document.upserted" ? event.payload.data as Value : undefined;

export const keyValueFor = (
  store: ObjectStoreApi,
  tenant: TenantId,
  documents: DocumentsApi,
  events: DomainEventsApi,
): KeyValueApi => ({
  namespace: <Value extends JsonObject = JsonObject>(name: string): KvNamespaceApi<Value> => {
    const identityNamespace = documentNamespace(tenant, name);
    const get: KvNamespaceApi<Value>["get"] = (key) => Effect.gen(function* () {
      for (let retries = 0; retries < 8; retries += 1) {
        const document = yield* documents.findById({ collection: name, id: key });
        if (document === undefined) return undefined;
        if (document.expiresAt === undefined || Date.parse(document.expiresAt) > (yield* Clock.currentTimeMillis)) {
          return entryOf<Value>(document);
        }
        const deleted = yield* Effect.result(documents.delete({
          collection: name, id: key, expectedVersion: document.version,
        }));
        if (Result.isSuccess(deleted)) return undefined;
        if ((deleted.failure as { readonly _tag?: string })._tag !== "DocumentConflict") {
          return yield* deleted.failure;
        }
      }
      return yield* new InvalidKeyValueExpiration({ reason: `expiry cleanup for ${key} did not converge` });
    });

    const scan: KvNamespaceApi<Value>["scan"] = (options) =>
      Effect.gen(function* () {
        const limit = pageLimit(options?.limit);
        const cursor = options?.after === undefined ? undefined : yield* decodeCursor(options.after);
        if (cursor !== undefined && !sameScan(cursor, name, options)) {
          return yield* new KeyValueCursorMismatch({ reason: "the cursor belongs to a different namespace or range" });
        }
        const found: Array<KeyValueEntry<Value>> = [];
        let after = cursor?.key;
        for (;;) {
          const identities = yield* store.scanIdentities({
            namespace: identityNamespace,
            ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
            ...(options?.lower === undefined ? {} : { lower: options.lower }),
            ...(options?.upper === undefined ? {} : { upper: options.upper }),
            ...(options?.direction === undefined ? {} : { direction: options.direction }),
            ...(after === undefined ? {} : { after }),
            limit: Math.min(1000, Math.max(32, limit + 1 - found.length)),
          });
          if (identities.length === 0) break;
          for (const identity of identities) {
            after = identity.key;
            const entry = yield* get(identity.key);
            if (entry !== undefined) found.push(entry);
            if (found.length > limit) break;
          }
          if (found.length > limit || identities.length < Math.min(1000, Math.max(32, limit + 1 - found.length))) break;
        }

        return {
          entries: found.slice(0, limit),
          ...(found.length > limit
            ? { next: encodeCursor({
                v: 1, namespace: name, key: found[limit - 1]!.key,
                ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
                ...(options?.lower === undefined ? {} : { lower: options.lower }),
                ...(options?.upper === undefined ? {} : { upper: options.upper }),
                direction: options?.direction ?? "asc",
              }) }
            : {}),
        };
      });

    const changes: KvNamespaceApi<Value>["changes"] = (options) => Effect.map(
      events.read({ collection: name, ...options }),
      (read) => read.flatMap((event): ReadonlyArray<KeyValueChange<Value>> =>
        event.documentId === undefined || event.type === "collection.created" ? [] : [{
          cursor: event.cursor,
          eventId: event.eventId,
          key: event.documentId,
          type: event.type === "document.deleted" ? "remove" : "set",
          revision: event.revision,
          timestamp: event.timestamp,
          ...(event.type === "document.upserted" ? { value: valueFromEvent<Value>(event)! } : {}),
        }]),
    );

    const schema = <S extends Schema.Constraint>(codec: S): SchemaKeyValueNamespaceApi<S> => {
      const decode = Schema.decodeUnknownEffect(codec);
      const encode = Schema.encodeUnknownEffect(codec);
      const decodeEntry = (entry: KeyValueEntry<Value>) =>
        Effect.map(decode(entry.value), (value) => ({ ...entry, value }));
      const encodedObject = (value: S["Type"]) => Effect.flatMap(encode(value), (encoded) =>
        typeof encoded === "object" && encoded !== null && !Array.isArray(encoded)
          ? Effect.succeed(encoded as JsonObject)
          : new InvalidKeyValueEncoding({ reason: "a KV Effect Schema must encode to a JSON object" }));
      return {
        get: (key) => Effect.flatMap(get(key), (entry) =>
          entry === undefined ? Effect.succeed(undefined) : decodeEntry(entry)),
        set: (key, value, options) => Effect.gen(function* () {
          const encoded = yield* encodedObject(value);
          return yield* Effect.flatMap(api.set(key, encoded as Value, options), decodeEntry);
        }),
        scan: (options) => Effect.flatMap(scan(options), (page) =>
          Effect.map(Effect.forEach(page.entries, decodeEntry), (entries) => ({
            entries, ...(page.next === undefined ? {} : { next: page.next }),
          }))),
        changes: (options) => Effect.flatMap(changes(options), (items) => Effect.forEach(items, (item) =>
          item.value === undefined
            ? Effect.succeed(item as KeyValueChange<S["Type"]>)
            : Effect.map(decode(item.value), (value) => ({ ...item, value })))),
      };
    };

    const api: KvNamespaceApi<Value> = {

      name,
      get,
      has: (key) => Effect.map(get(key), (entry) => entry !== undefined),
      set: (key, value, options) => Effect.gen(function* () {
          const expiry = yield* expirationOptions(options);
          const operation: DocumentWrite = options?.ifAbsent === true
            ? {
                _tag: "Insert", collection: name, id: key, data: value,
                ...expiry,
              }
            : {
                _tag: "Upsert", collection: name, id: key, data: value,
                ...(Object.keys(expiry).length === 0 ? { expiresAt: null } : expiry),
                ...(options?.expectedVersion === undefined ? {} : { expectedVersion: options.expectedVersion }),
              };
          const written = yield* documents.write({
            operations: [operation],
            ...(options?.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: options.idempotencyKey }),
          });
          return entryOf<Value>((written[0] as Exclude<(typeof written)[number], { _tag: "Deleted" }>).document);
        }),
      remove: (key, options) => documents.delete({ collection: name, id: key, ...options }),
      scan,
      changes,
      write: (operations, options) => Effect.gen(function* () {
        const documentChanges: DocumentWrite[] = [];
        for (const operation of operations) {
          if (operation._tag === "Remove") {
            documentChanges.push({
                _tag: "Delete", collection: name, id: operation.key,
                ...(operation.expectedVersion === undefined ? {} : { expectedVersion: operation.expectedVersion }),
              });
          } else {
            const expiry = yield* expirationOptions(operation);
            documentChanges.push({
                _tag: operation.ifAbsent === true ? "Insert" : "Upsert",
                collection: name, id: operation.key, data: operation.value,
                ...(operation.ifAbsent === true
                  ? expiry
                  : Object.keys(expiry).length === 0 ? { expiresAt: null } : expiry),
                ...(operation.expectedVersion === undefined ? {} : { expectedVersion: operation.expectedVersion }),
              } as DocumentWrite);
          }
        }
        return yield* Effect.map(
          documents.write({ operations: documentChanges, ...options }),
          (written) => written.map((result) =>
            result._tag === "Deleted"
              ? { key: result.id, deleted: result.deleted }
              : entryOf<Value>(result.document)),
        );
      }),
      size: Effect.gen(function* () {
        let total = 0;
        let after: KvCursor | undefined;
        do {
          const page = yield* scan({ limit: 1000, ...(after === undefined ? {} : { after }) });
          total += page.entries.length;
          after = page.next;
        } while (after !== undefined);
        return total;
      }),
      clear: Effect.gen(function* () {
        let removed = 0;
        let after: string | undefined;
        for (;;) {
          const identities = yield* store.scanIdentities({ namespace: identityNamespace, limit: 1000, ...(after === undefined ? {} : { after }) });
          if (identities.length === 0) return removed;
          yield* documents.write({
            operations: identities.map((identity) => ({
              _tag: "Delete" as const,
              collection: name,
              id: identity.key,
            })),
          });
          removed += identities.length;
          after = undefined;
        }
      }),
      schema,
    };
    return api;
  },
});

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
          : Encoding.decodeBase64(entry.value.value).pipe((result) => {
              if (result._tag === "Failure") throw result.failure;
              return result.success;
            })),
    set: (key, value) => attempt(
      "set",
      namespace.set(key, typeof value === "string"
        ? { encoding: "utf8", value }
        : { encoding: "base64", value: Encoding.encodeBase64(value) }),
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
          : Encoding.decodeBase64(held.value).pipe((result) => {
              if (result._tag === "Failure") throw result.failure;
              return result.success;
            });
        return { encoding: "base64", value: Encoding.encodeBase64(f(bytes)) };
      }),
      (value) => value === undefined ? undefined : Encoding.decodeBase64(value.value).pipe((result) => {
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
