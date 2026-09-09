import { createHash } from "node:crypto";
import { Effect, Stream } from "effect";
import type { Json, JsonObject } from "./json.js";
import {
  COLLECTION_NAME_PATTERN,
  isReservedCollectionName,
  RESERVED_COLLECTION_PREFIX,
} from "./naming.js";
import {
  IDEMPOTENCY_NAMESPACE_PREFIX, MOVE_FENCE_NAMESPACE, TENANT_COLUMN, TENANT_MARKER,
  TENANT_NAMESPACE,
} from "./tenancy.js";
import {
  CollectionExists,
  SchemaViolation,
  CollectionNotFound,
  DocumentConflict,
  DocumentNotFound,
  IdempotencyKeyReused,
  InvalidCollectionName,
  TenantMoving,
} from "./errors.js";
import type { DbError } from "./errors.js";
import type { Seq } from "./model.js";
import { and, equals, or, type Query } from "./query.js";
import type { SchemasApi } from "./schemas.js";
import type { ObjectStoreApi, Txn } from "./store.js";
import type { TenantId } from "./topology.js";

export type { Json, JsonObject } from "./json.js";

export type CollectionSurface = "content-studio" | "database";

export interface Collection {
  readonly name: string;
  readonly createdAt: string;
  readonly surface: CollectionSurface;
  readonly metadata?: Record<string, unknown>;
}

export interface Document<TData extends JsonObject = JsonObject> {
  readonly id: string;
  readonly collection: string;
  readonly data: TData;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export type FilterOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in";

export interface DocumentFilter {
  readonly path: string;
  readonly op?: FilterOperator;
  readonly value: Json | ReadonlyArray<Json>;
}

export interface DocumentSort {
  readonly path: string;
  readonly direction?: "asc" | "desc";
}

export interface FindDocumentsInput {
  readonly collection: string;
  readonly where?: ReadonlyArray<DocumentFilter>;
  readonly orderBy?: ReadonlyArray<DocumentSort>;
  readonly limit?: number;
  readonly offset?: number;
}

/** Marks a stored collection record, distinct from any collection name. */
const COLLECTION_MARKER = "\u0000collection";

/**
 * What a keyed write did, so a retry can be answered instead of repeated.
 *
 * The fingerprint is of the request rather than of the result: two callers
 * asking for the same thing should share an outcome, and one caller reusing a
 * key for something else should be told so.
 */
interface Receipt {
  readonly key: string;
  readonly fingerprint: string;
  /** The request in words, so a reuse can say what the key was first spent on. */
  readonly request: string;
  readonly result: unknown;
  readonly at: string;
}

const idempotencyNs = (tenant: TenantId) => `${IDEMPOTENCY_NAMESPACE_PREFIX}${tenant}`;

/** Marks a receipt, so this tenant's can be found without reading the shard. */
const idempotencyColumn = (tenant: TenantId) => `${IDEMPOTENCY_NAMESPACE_PREFIX}${tenant}`;
const RECEIPT_MARKER = "\u0000receipt";

/**
 * A stable fingerprint of a request.
 *
 * Keys are sorted at every level, because two callers writing the same fields
 * in a different order are making the same request and a retry that reordered
 * them would otherwise look like a different one.
 */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
};

const fingerprintOf = (request: unknown): string =>
  createHash("sha256").update(canonical(request)).digest("hex");


/**
 * Tenant scoping is structural, not a filter.
 *
 * Several tenants share a physical shard, so their records share one `Seq`
 * space. Rather than appending a tenant predicate to every query — which is a
 * thing a caller can forget, and which silently returns another tenant's rows
 * when they do — the tenant is part of every namespace and every lens key. A
 * query built for one tenant addresses a key space the others are not in.
 */
const collectionNs = (tenant: TenantId) => `zv.collection/${tenant}`;
const documentNs = (tenant: TenantId, collection: string) => `doc/${tenant}/${collection}`;
const collectionColumn = (tenant: TenantId) => `zv.collection/${tenant}`;
const columnFor = (tenant: TenantId, collection: string, path: string) =>
  `${tenant}/${collection}.${path}`;

const validateName = (name: string): Effect.Effect<void, InvalidCollectionName> => {
  if (!COLLECTION_NAME_PATTERN.test(name)) {
    return Effect.fail(
      new InvalidCollectionName({
        name,
        reason:
          "must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens",
      }),
    );
  }
  if (isReservedCollectionName(name)) {
    return Effect.fail(
      new InvalidCollectionName({
        name,
        reason: `the "${RESERVED_COLLECTION_PREFIX}" prefix is reserved`,
      }),
    );
  }
  return Effect.void;
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const encode = (value: unknown) => enc.encode(JSON.stringify(value));
const decode = <A>(bytes: Uint8Array) => JSON.parse(dec.decode(bytes)) as A;

const readPath = (data: JsonObject, path: string): Json | undefined => {
  let cursor: Json | undefined = data;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as JsonObject)[segment];
  }
  return cursor;
};

/** Only scalars are indexable; a term for an object or array would not be equatable. */
const isScalar = (value: Json | undefined): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/**
 * Flatten a document into column postings.
 *
 * Every scalar reachable by a dotted path becomes an equality posting, which is
 * what lets `eq` and `in` filters be answered from the lens rather than by
 * reading payloads. Non-scalars are skipped rather than stringified: a posting
 * for `{"a":1}` would only ever match a query that happened to serialize it
 * identically, which is a match nobody intends.
 */
const columnsFor = (
  tenant: TenantId,
  collection: string,
  data: JsonObject,
): Array<readonly [string, string]> => {
  const out: Array<readonly [string, string]> = [[collectionColumn(tenant), collection]];
  const walk = (value: Json, path: string): void => {
    if (isScalar(value)) {
      out.push([columnFor(tenant, collection, path), String(value)]);
      return;
    }
    if (value === null || Array.isArray(value)) return;
    for (const [k, v] of Object.entries(value)) walk(v, path === "" ? k : `${path}.${k}`);
  };
  walk(data, "");
  return out;
};

const compare = (left: Json | undefined, right: Json): number => {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
};

const matches = (data: JsonObject, filter: DocumentFilter): boolean => {
  const actual = readPath(data, filter.path);
  const op = filter.op ?? "eq";
  if (op === "in") {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    return values.some((v) => actual === v);
  }
  const expected = filter.value as Json;
  switch (op) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "gt":
      return compare(actual, expected) > 0;
    case "gte":
      return compare(actual, expected) >= 0;
    case "lt":
      return compare(actual, expected) < 0;
    case "lte":
      return compare(actual, expected) <= 0;
  }
};

/**
 * Build the lens query for the filters that lenses can answer.
 *
 * `eq` and `in` become postings intersected against the collection. Ordering
 * comparisons cannot, so they are applied to the candidates afterwards; the
 * split is deliberate and visible rather than a silent full scan.
 */
const planQuery = (
  tenant: TenantId,
  collection: string,
  where: ReadonlyArray<DocumentFilter>,
): { readonly query: Query; readonly residual: ReadonlyArray<DocumentFilter> } => {
  const clauses: Query[] = [equals(collectionColumn(tenant), collection)];
  const residual: DocumentFilter[] = [];
  for (const filter of where) {
    const op = filter.op ?? "eq";
    if (op === "eq" && isScalar(filter.value as Json)) {
      clauses.push(equals(columnFor(tenant, collection, filter.path), String(filter.value)));
    } else if (op === "in" && Array.isArray(filter.value) && filter.value.length > 0) {
      const members = filter.value.filter(isScalar);
      if (members.length !== filter.value.length) {
        residual.push(filter);
        continue;
      }
      clauses.push(
        or(...members.map((v) => equals(columnFor(tenant, collection, filter.path), String(v)))),
      );
    } else {
      residual.push(filter);
    }
  }
  return { query: clauses.length === 1 ? clauses[0]! : and(...clauses), residual };
};

export interface DocumentsApi {
  readonly createCollection: (input: {
    readonly name: string;
    readonly surface?: CollectionSurface;
    readonly metadata?: Record<string, unknown>;
  }) => Effect.Effect<Collection, InvalidCollectionName | CollectionExists | TenantMoving>;
  readonly listCollections: Effect.Effect<ReadonlyArray<Collection>>;
  readonly collectionExists: (name: string) => Effect.Effect<boolean>;
  readonly insert: (input: {
    readonly collection: string;
    /**
     * Do this at most once.
     *
     * A retry carrying the same key is answered with what the first attempt
     * returned instead of being applied again. Supply `id` alongside it: a
     * generated one differs on every attempt, which is a different request.
     */
    readonly idempotencyKey?: string;
    readonly id?: string;
    readonly data: JsonObject;
  }) => Effect.Effect<
    Document,
    CollectionNotFound | DocumentConflict | SchemaViolation | TenantMoving | IdempotencyKeyReused
  >;
  readonly findById: (input: {
    readonly collection: string;
    readonly id: string;
  }) => Effect.Effect<Document | undefined>;
  readonly findMany: (input: FindDocumentsInput) => Effect.Effect<ReadonlyArray<Document>>;
  readonly update: (input: {
    readonly collection: string;
    /** Do this at most once; see `insert`. */
    readonly idempotencyKey?: string;
    readonly id: string;
    readonly data: JsonObject;
    readonly mode?: "merge" | "replace";
    readonly expectedVersion?: number;
  }) => Effect.Effect<
    Document,
    DocumentNotFound | DocumentConflict | SchemaViolation | TenantMoving | IdempotencyKeyReused
  >;
  readonly delete: (input: {
    readonly collection: string;
    /** Do this at most once; see `insert`. */
    readonly idempotencyKey?: string;
    readonly id: string;
    readonly expectedVersion?: number;
  }) => Effect.Effect<boolean, DocumentConflict | TenantMoving | IdempotencyKeyReused>;

  /**
   * Forget completed idempotency keys, returning how many were dropped.
   *
   * Receipts grow with requests rather than with data, and nothing expires them
   * on its own: how long a retry may arrive is the caller's question, not the
   * database's. Forgetting a key makes a retry carrying it an ordinary write
   * again — which for an insert means a duplicate-id conflict rather than a
   * duplicate document, so the cost of pruning too early is a refusal, not a
   * repeat.
   */
  readonly forgetIdempotencyKeys: (input?: {
    /** Keep receipts recorded at or after this instant. Omit to forget all. */
    readonly before?: string;
  }) => Effect.Effect<number>;
}

/**
 * The document API for one tenant on one shard.
 *
 * Takes the store directly rather than from context because a tenant's shard is
 * chosen by the partition map at call time, not by what happens to be provided.
 */
export const documentsFor = (
  store: ObjectStoreApi,
  tenant: TenantId,
  schemas?: SchemasApi,
): DocumentsApi => {
  /**
   * Reject the whole write when the data does not satisfy the active schema.
   *
   * All-or-nothing rather than partial: a document that half-matched would put
   * the lenses in a state no schema describes, and every reader after it would
   * have to cope with a shape that was never valid.
   */
  const enforceSchema = (collection: string, data: JsonObject) =>
    Effect.gen(function* () {
      if (schemas === undefined) return;
      const result = yield* schemas.validate(collection, data);
      if (!result.valid) {
        return yield* new SchemaViolation({
          collection,
          schemaVersion: result.schemaVersion,
          issues: result.issues,
        });
      }
    });


  // A store failure is not something a caller can act on: a fenced writer or an
  // unreadable file is the runtime's problem, not a decision. Converting them to
  // defects here keeps the domain error channel to what a caller can actually
  // respond to — a duplicate id, a missing collection, a stale version.
  const lookup = (namespace: string, key: string) => Effect.orDie(store.lookup(namespace, key));
  const readObject = (seq: Seq) => Effect.orDie(store.read(seq));
  const nextSeq = Effect.orDie(store.nextSeq);
  const resolveQuery = (query: Query): Stream.Stream<Seq> => Stream.orDie(store.resolve(query));
  const write = (f: (txn: Txn) => Effect.Effect<void, DbError>): Effect.Effect<void> =>
    Effect.orDie(store.transact(f));

  /**
   * What a key was used for last time, if it has been used.
   *
   * A key that comes back attached to a different request is refused rather
   * than answered: replying with the stored outcome would tell a caller that
   * something happened which did not.
   */
  const receiptFor = (key: string, fingerprint: string, request: string) =>
    Effect.gen(function* () {
      const seq = yield* lookup(idempotencyNs(tenant), key);
      if (seq === undefined) return undefined;
      const object = yield* readObject(seq);
      if (object === undefined) return undefined;
      const receipt = decode<Receipt>(object.bytes);
      if (receipt.fingerprint !== fingerprint) {
        return yield* new IdempotencyKeyReused({
          tenant,
          key,
          detail: `first used for ${receipt.request}, now offered for ${request}`,
        });
      }
      return receipt;
    });

  /**
   * Apply a change and, if the caller gave a key, record what it did — together.
   *
   * One transaction for both. Recording the receipt afterwards would leave a
   * window in which the write had happened and the key had not been noted,
   * which is exactly the window a retry falls into and the one direction of
   * failure a key exists to prevent.
   */
  const commitOnce = <A>(
    key: string | undefined,
    fingerprint: string,
    request: string,
    result: A,
    change: (txn: Txn) => Effect.Effect<void, DbError>,
  ): Effect.Effect<A> =>
    Effect.gen(function* () {
      if (key === undefined) {
        yield* write(change);
        return result;
      }
      const seq = yield* nextSeq;
      yield* write((txn) =>
        Effect.gen(function* () {
          yield* change(txn);
          yield* rememberKey(txn, {
            key, fingerprint, request, result, at: new Date().toISOString(),
          }, seq);
        }));
      return result;
    });

  const loadCollection = (name: string) =>
    Effect.gen(function* () {
      const seq = yield* lookup(collectionNs(tenant), name);
      if (seq === undefined) return undefined;
      const object = yield* readObject(seq);
      return object === undefined ? undefined : decode<Collection>(object.bytes);
    });

  const requireCollection = (name: string) =>
    Effect.filterOrFail(
      loadCollection(name),
      (found): found is Collection => found !== undefined,
      () => new CollectionNotFound({ name }),
    );

  const readDocument = (seq: Seq) =>
    Effect.map(readObject(seq), (o) => (o === undefined ? undefined : decode<Document>(o.bytes)));

  /**
   * Refuse a write to a tenant that is being relocated off this shard.
   *
   * One point lookup ahead of each write. That is a real cost on a hot path for
   * an operation that happens rarely, and it is the price of the alternative
   * being a write that lands in records nobody will read again — a move would
   * otherwise have to take the tenant offline for reads as well, just to keep
   * the two copies from diverging.
   */
  const assertNotMoving = Effect.gen(function* () {
    const seq = yield* lookup(MOVE_FENCE_NAMESPACE, tenant);
    if (seq === undefined) return;
    const fence = yield* readObject(seq);
    if (fence === undefined) return;
    const { from, to } = decode<{ from: string; to: string }>(fence.bytes);
    return yield* new TenantMoving({ tenant, from, to });
  });

  const documentPut = (txn: Txn, doc: Document, seq: Seq) =>
    txn.put(seq, encode(doc), {
      terms: [],
      columns: columnsFor(tenant, doc.collection, doc.data),
      measures: [],
      edges: [],
    }, { namespace: documentNs(tenant, doc.collection), key: doc.id });

  /**
   * A completed write, remembered under the key the caller gave it.
   *
   * Written in the same transaction as the change it describes. Recording it
   * afterwards would leave a window where the write had happened and the key
   * had not been noted — precisely the window a retry falls into, and the one
   * direction of failure the key exists to prevent.
   */
  const rememberKey = (txn: Txn, receipt: Receipt, seq: Seq) =>
    txn.put(seq, encode(receipt), {
      terms: [],
      // Marked so a tenant's receipts can be swept without walking the shard;
      // they are the one thing here that accumulates with requests rather than
      // with data, so there has to be a way to let them go.
      columns: [[idempotencyColumn(tenant), RECEIPT_MARKER]],
      measures: [],
      edges: [],
    }, { namespace: idempotencyNs(tenant), key: receipt.key });

  return {
    createCollection: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        yield* validateName(input.name);
        const existing = yield* loadCollection(input.name);
        if (existing !== undefined) return yield* new CollectionExists({ name: input.name });
        const collection: Collection = {
          name: input.name,
          createdAt: new Date().toISOString(),
          surface: input.surface ?? "database",
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        };
        const seq = yield* nextSeq;
        yield* write((txn) =>
          txn.put(seq, encode(collection), {
            terms: [],
            columns: [[collectionColumn(tenant), COLLECTION_MARKER]],
            measures: [],
            edges: [],
          }, { namespace: collectionNs(tenant), key: input.name }),
        );
        // Record that this tenant occupies the shard. Placement decisions need
        // to know which tenants a shard actually holds, and deriving that by
        // scanning every namespace would mean reading the whole store.
        if ((yield* lookup(TENANT_NAMESPACE, tenant)) === undefined) {
          const markerSeq = yield* nextSeq;
          yield* write((txn) =>
            txn.put(markerSeq, encode({ tenant }), {
              terms: [],
              columns: [[TENANT_COLUMN, TENANT_MARKER]],
              measures: [],
              edges: [],
            }, { namespace: TENANT_NAMESPACE, key: tenant }),
          );
        }
        return collection;
      }),

    listCollections: Effect.gen(function* () {
      const seqs = yield* Stream.runCollect(
        resolveQuery(equals(collectionColumn(tenant), COLLECTION_MARKER)),
      );
      const out: Collection[] = [];
      for (const seq of seqs) {
        const object = yield* readObject(seq);
        if (object !== undefined) out.push(decode<Collection>(object.bytes));
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    }),

    collectionExists: (name) => Effect.map(loadCollection(name), (c) => c !== undefined),

    insert: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const request = `insert into "${input.collection}"`;
        const fingerprint = fingerprintOf({
          op: "insert", collection: input.collection, id: input.id, data: input.data,
        });
        if (input.idempotencyKey !== undefined) {
          const seen = yield* receiptFor(input.idempotencyKey, fingerprint, request);
          if (seen !== undefined) return seen.result as Document;
        }
        yield* requireCollection(input.collection);
        yield* enforceSchema(input.collection, input.data);
        // A generated id would differ on every retry, so a keyed insert without
        // one would store a second document and hand back the first.
        const id = input.id ?? crypto.randomUUID();
        const clash = yield* lookup(documentNs(tenant, input.collection), id);
        if (clash !== undefined) {
          return yield* new DocumentConflict({
            collection: input.collection,
            id,
            reason: "a document with this id already exists",
          });
        }
        const now = new Date().toISOString();
        const doc: Document = {
          id,
          collection: input.collection,
          data: input.data,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        const seq = yield* nextSeq;
        return yield* commitOnce(input.idempotencyKey, fingerprint, request, doc,
          (txn) => documentPut(txn, doc, seq));
      }),

    findById: (input) =>
      Effect.gen(function* () {
        const seq = yield* lookup(documentNs(tenant, input.collection), input.id);
        return seq === undefined ? undefined : yield* readDocument(seq);
      }),

    findMany: (input) =>
      Effect.gen(function* () {
        const { query, residual } = planQuery(tenant, input.collection, input.where ?? []);
        const seqs = yield* Stream.runCollect(resolveQuery(query));
        let docs: Document[] = [];
        for (const seq of seqs) {
          const doc = yield* readDocument(seq);
          if (doc !== undefined && residual.every((f) => matches(doc.data, f))) docs.push(doc);
        }
        for (const sort of [...(input.orderBy ?? [])].reverse()) {
          const dir = sort.direction === "desc" ? -1 : 1;
          docs = docs.sort(
            (a, b) => dir * compare(readPath(a.data, sort.path), readPath(b.data, sort.path) as Json),
          );
        }
        const offset = input.offset ?? 0;
        return input.limit === undefined
          ? docs.slice(offset)
          : docs.slice(offset, offset + input.limit);
      }),

    update: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const request = `update "${input.collection}/${input.id}"`;
        const fingerprint = fingerprintOf({
          op: "update", collection: input.collection, id: input.id, data: input.data,
          mode: input.mode, expectedVersion: input.expectedVersion,
        });
        if (input.idempotencyKey !== undefined) {
          const seen = yield* receiptFor(input.idempotencyKey, fingerprint, request);
          if (seen !== undefined) return seen.result as Document;
        }
        const seq = yield* lookup(documentNs(tenant, input.collection), input.id);
        const current = seq === undefined ? undefined : yield* readDocument(seq);
        if (seq === undefined || current === undefined) {
          return yield* new DocumentNotFound({ collection: input.collection, id: input.id });
        }
        if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
          return yield* new DocumentConflict({
            collection: input.collection,
            id: input.id,
            reason: `expected version ${input.expectedVersion}, found ${current.version}`,
          });
        }
        const data =
          (input.mode ?? "merge") === "replace"
            ? input.data
            : { ...current.data, ...input.data };
        yield* enforceSchema(input.collection, data);
        const next: Document = {
          ...current,
          data,
          updatedAt: new Date().toISOString(),
          version: current.version + 1,
        };
        return yield* commitOnce(input.idempotencyKey, fingerprint, request, next,
          (txn) => documentPut(txn, next, seq));
      }),

    delete: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const request = `delete "${input.collection}/${input.id}"`;
        const fingerprint = fingerprintOf({
          op: "delete", collection: input.collection, id: input.id,
          expectedVersion: input.expectedVersion,
        });
        if (input.idempotencyKey !== undefined) {
          const seen = yield* receiptFor(input.idempotencyKey, fingerprint, request);
          if (seen !== undefined) return seen.result as boolean;
        }
        const seq = yield* lookup(documentNs(tenant, input.collection), input.id);
        // Nothing happened, so there is nothing to remember: a later retry that
        // finds the document present should delete it rather than replay a
        // "no" from when it was already gone.
        if (seq === undefined) return false;
        if (input.expectedVersion !== undefined) {
          const current = yield* readDocument(seq);
          if (current !== undefined && current.version !== input.expectedVersion) {
            return yield* new DocumentConflict({
              collection: input.collection,
              id: input.id,
              reason: `expected version ${input.expectedVersion}, found ${current.version}`,
            });
          }
        }
        return yield* commitOnce(input.idempotencyKey, fingerprint, request, true,
          (txn) => txn.retract(seq));
      }),

    forgetIdempotencyKeys: (input) =>
      Effect.gen(function* () {
        const seqs = yield* Stream.runCollect(
          resolveQuery(equals(idempotencyColumn(tenant), RECEIPT_MARKER)),
        );
        let forgotten = 0;
        for (const seq of seqs) {
          if (input?.before !== undefined) {
            const object = yield* readObject(seq);
            if (object === undefined) continue;
            if (decode<Receipt>(object.bytes).at >= input.before) continue;
          }
          yield* write((txn) => txn.retract(seq));
          forgotten += 1;
        }
        return forgotten;
      }),
  } satisfies DocumentsApi;
};
