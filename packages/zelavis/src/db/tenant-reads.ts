/** Named, data-only Tenant reads that can run against a shard reader. */
import { Effect, Exit, Schema } from "effect";
import { aggregatesFor, type AggregatesApi } from "./aggregates.js";
import type { SharedDocumentsApi } from "./database.js";
import { documentsFor } from "./documents.js";
import type { DocumentsApi } from "./document-model.js";
import { domainEventsFor, type DomainEventsApi } from "./domain-events.js";
import { StoreError, PartitionUnavailable, CrossPartitionQuery, SchemaMigrationBlocked, MessageExists, InvalidMessage, IdempotencyKeyReused, TenantMoving, TenantRelocated, TenantDivided, UnknownPart, TenantMoveFailed, PlacementInUse, UnknownShard, WriterFenced, LeaseStillHeld, FollowerBehind, LeaseOwnedByAnother, NotDesignatedStandby, NoWriterLease, PartitionLeased, ForeignCursor, CursorMismatch, UnsupportedOrdering, InvalidIndex, IndexExists, UniqueViolation, CheckViolation, ReferenceViolation, InvalidConstraint, UnanalyzedCollection, UnindexedField, UnindexedGeometry, UnembeddedCollection, VectorShapeMismatch, InvalidVectorQuery, UnknownMeasure, UnknownEdge, UnknownReference, ConstraintExists, InvalidCollectionName, CollectionExists, CollectionNotFound, DocumentNotFound, DocumentConflict, CrossTenantIndexNotFound, CrossTenantIndexExists, CrossTenantIndexRefreshing, InvalidCrossTenantIndex, ProjectionNotFound, InvalidDocumentValue, SchemaVersionExists, SchemaTransferRefused, InvalidMeasureQuery, AggregateRefused, AggregateNotFound, AggregateChanged, SchemaNotFound, SchemaActivationRefused, SchemaViolation, TimeSeriesNotFound, TimeSeriesMapFailed, BackupTenantMismatch, TenantNotDroppable, BranchNotMergeable, TenantNotBranchable, InvalidExport, InvalidBackup, InvalidImport, DividedRestoreIncomplete, InvalidImage, TenantNotEmpty, InvalidRestoreMode, BackupFormatUnsupported, PartitionMapInvalid, RangeNotEmpty, PlacementCatalogInvalid, SubdivisionInvalid, PlacementImmutable, ReplicationUnsupported, UnknownSystemView, CursorCompacted, LogCompacted, PartitionExhausted, EventGap, ReplicaDiverged, FollowersNotAcknowledged, LensesRebuilding, TenantBranching, InvalidEntityMessage, MailboxFull, InvalidFollowerRequest, ShardPlacementUnavailable, ShardPlacementRefused, ShardOperationInProgress, ShardInUse, ShardOperationInvalid, ReadBudgetExceeded } from "./errors.js";
import type { Json } from "./json.js";
import { outboxFor, type OutboxApi } from "./outbox.js";
import { schemasFor } from "./schemas.js";
import type { ObjectStoreApi } from "./store.js";
import type { PartitionKey } from "./model.js";
import { GLOBAL_TENANT } from "./topology.js";

export const TENANT_READ_OPS = [
  "documents.count", "documents.modalities", "documents.listCollections", "documents.collectionExists",
  "documents.findById", "documents.findMany", "documents.findPage", "documents.searchStatistics",
  "documents.withRelated", "documents.traverse", "documents.summarize", "documents.covariance",
  "documents.histogram", "documents.summarizeBy",
  "shared.listCollections", "shared.collectionExists", "shared.findById", "shared.findMany", "shared.findPage",
  "events.read", "aggregates.list", "aggregates.get", "outbox.read",
] as const;
export type TenantReadOp = (typeof TENANT_READ_OPS)[number];
/** Similarity queries depend on the writer's mutable projection index. */
export const isShardTenantRead = (op: TenantReadOp, input: unknown): boolean => {
  const query = op === "documents.findMany" || op === "documents.findPage" || op === "shared.findMany" || op === "shared.findPage";
  return !query || typeof input !== "object" || input === null || !Object.hasOwn(input, "similar");
};
export interface TenantReadRequest {
  readonly protocol: 1;
  readonly partition: PartitionKey;
  readonly routedBy: number;
  readonly op: TenantReadOp;
  readonly input: Json | null;
}
export interface RemoteTenantReads {
  readonly run: (request: Omit<TenantReadRequest, "protocol">) => Effect.Effect<unknown, unknown>;
}
export interface TenantReads {
  readonly documents: Pick<DocumentsApi, "count" | "modalities" | "listCollections" | "collectionExists" | "findById" |
    "findMany" | "findPage" | "searchStatistics" | "withRelated" | "traverse" | "summarize" | "covariance" | "histogram" |
    "summarizeBy">;
  readonly shared: SharedDocumentsApi;
  readonly events: Pick<DomainEventsApi, "read">;
  readonly aggregates: Pick<AggregatesApi, "list" | "get">;
  readonly outbox: Pick<OutboxApi, "read">;
}
export const TENANT_READ_MEMBERS = Object.fromEntries(TENANT_READ_OPS.map((op) => [op, op.split(".")])) as unknown as
  Readonly<Record<TenantReadOp, readonly [keyof TenantReads, string]>>;

const stores = new WeakMap<TenantReads, ObjectStoreApi>();
export const tenantReadsOver = (store: ObjectStoreApi, shared: ObjectStoreApi, tenant: PartitionKey): TenantReads => {
  const records = schemasFor(store, tenant);
  const documents = documentsFor(store, tenant, records);
  const api: TenantReads = {
    documents, events: domainEventsFor(store, tenant), aggregates: aggregatesFor(store, documents, tenant),
    outbox: outboxFor(store, documents),
    shared: documentsFor(shared, GLOBAL_TENANT, schemasFor(shared, GLOBAL_TENANT)),
  };
  stores.set(api, store);
  return api;
};
export const runTenantRead = (api: TenantReads, op: TenantReadOp, input: Json | null): Effect.Effect<unknown, unknown> =>
  Effect.suspend(() => {
    if (!isShardTenantRead(op, input)) return Effect.die(new TypeError("a similarity read must run on the writer"));
    const store = stores.get(api);
    if (store === undefined) return Effect.die(new TypeError("Tenant reads require a store"));
    const [group, name] = TENANT_READ_MEMBERS[op];
    const member: unknown = (api[group] as unknown as Record<string, unknown>)[name];
    if (Effect.isEffect(member)) {
      return input === null ? store.reading(member as Effect.Effect<unknown, unknown>) : Effect.die(new TypeError(`${op} takes no input`));
    }
    if (typeof member !== "function") return Effect.die(new TypeError(`Unknown Tenant read: ${op}`));
    const effect = (member as (input: Json | null) => Effect.Effect<unknown, unknown>)(input);
    return store.reading(effect);
  });

const READ_ERRORS = { StoreError, PartitionUnavailable, CrossPartitionQuery, SchemaMigrationBlocked, MessageExists, InvalidMessage, IdempotencyKeyReused, TenantMoving, TenantRelocated, TenantDivided, UnknownPart, TenantMoveFailed, PlacementInUse, UnknownShard, WriterFenced, LeaseStillHeld, FollowerBehind, LeaseOwnedByAnother, NotDesignatedStandby, NoWriterLease, PartitionLeased, ForeignCursor, CursorMismatch, UnsupportedOrdering, InvalidIndex, IndexExists, UniqueViolation, CheckViolation, ReferenceViolation, InvalidConstraint, UnanalyzedCollection, UnindexedField, UnindexedGeometry, UnembeddedCollection, VectorShapeMismatch, InvalidVectorQuery, UnknownMeasure, UnknownEdge, UnknownReference, ConstraintExists, InvalidCollectionName, CollectionExists, CollectionNotFound, DocumentNotFound, DocumentConflict, CrossTenantIndexNotFound, CrossTenantIndexExists, CrossTenantIndexRefreshing, InvalidCrossTenantIndex, ProjectionNotFound, InvalidDocumentValue, SchemaVersionExists, SchemaTransferRefused, InvalidMeasureQuery, AggregateRefused, AggregateNotFound, AggregateChanged, SchemaNotFound, SchemaActivationRefused, SchemaViolation, TimeSeriesNotFound, TimeSeriesMapFailed, BackupTenantMismatch, TenantNotDroppable, BranchNotMergeable, TenantNotBranchable, InvalidExport, InvalidBackup, InvalidImport, DividedRestoreIncomplete, InvalidImage, TenantNotEmpty, InvalidRestoreMode, BackupFormatUnsupported, PartitionMapInvalid, RangeNotEmpty, PlacementCatalogInvalid, SubdivisionInvalid, PlacementImmutable, ReplicationUnsupported, UnknownSystemView, CursorCompacted, LogCompacted, PartitionExhausted, EventGap, ReplicaDiverged, FollowersNotAcknowledged, LensesRebuilding, TenantBranching, InvalidEntityMessage, MailboxFull, InvalidFollowerRequest, ShardPlacementUnavailable, ShardPlacementRefused, ShardOperationInProgress, ShardInUse, ShardOperationInvalid, ReadBudgetExceeded } as const;
export const READ_ERROR_TAGS = Object.keys(READ_ERRORS);

export interface TaggedJson { readonly _tag: string; readonly [field: string]: Json }
export type TenantReadExit =
  | { readonly value?: Json }
  | { readonly failure: TaggedJson }
  | { readonly defect: TaggedJson | { readonly message: string } };

/** Check JSON without trusting unbounded input, retaining the offending path. */
export const isPlainJson = (value: unknown): { readonly ok: true } | { readonly ok: false; readonly path: string } => {
  const pending: Array<{ value: unknown; path: string; depth: number }> = [{ value, path: "$", depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    nodes++;
    if (nodes > 100_000 || item.depth > 64) return { ok: false, path: `${item.path} (too large or too deep)` };
    const v = item.value;
    if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) continue;
    if (Array.isArray(v)) {
      if (v.length > 100_000 - nodes - pending.length) return { ok: false, path: `${item.path} (too large or too deep)` };
      for (let i = v.length - 1; i >= 0; i--) pending.push({ value: v[i], path: `${item.path}[${i}]`, depth: item.depth + 1 });
      continue;
    }
    if (typeof v !== "object" || v === null || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) return { ok: false, path: item.path };
    if (Object.getOwnPropertySymbols(v).length > 0) return { ok: false, path: item.path };
    for (const key in v) {
      if (!Object.hasOwn(v, key)) continue;
      if (pending.length + nodes >= 100_000) return { ok: false, path: `${item.path} (too large or too deep)` };
      const entry: unknown = (v as Record<string, unknown>)[key];
      if (entry === undefined) nodes++;
      else pending.push({ value: entry, path: `${item.path}.${key}`, depth: item.depth + 1 });
    }
  }
  return { ok: true };
};
/** The bytes `JSON.stringify` writes for a string, quotes included, counted without building it. */
const jsonStringBytes = (value: string): number => {
  let bytes = 2;
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && at + 1 < value.length && (value.charCodeAt(at + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      at += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6; // a lone surrogate is written as an escape
    else bytes += 3;
  }
  return bytes;
};

/**
 * The size in bytes of `value` as JSON, or `undefined` once it passes `limit`, counted without building the
 * text: an answer that is too large is refused before anything the size of it is allocated. `value` is plain
 * JSON (`isPlainJson`), so its depth is already bounded.
 */
export const jsonSizeWithin = (value: unknown, limit: number): number | undefined => {
  let total = 0;
  const add = (bytes: number): boolean => {
    total += bytes;
    return total <= limit;
  };
  const walk = (node: unknown): boolean => {
    if (node === null) return add(4);
    switch (typeof node) {
      case "string": return add(jsonStringBytes(node));
      case "boolean": return add(node ? 4 : 5);
      case "number": return add(String(node).length);
    }
    if (Array.isArray(node)) {
      if (!add(2 + Math.max(0, node.length - 1))) return false;
      for (const item of node) if (!walk(item === undefined ? null : item)) return false;
      return true;
    }
    if (!add(2)) return false;
    let first = true;
    for (const key of Object.keys(node as object)) {
      const entry = (node as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      if (!add((first ? 0 : 1) + jsonStringBytes(key) + 1)) return false;
      first = false;
      if (!walk(entry)) return false;
    }
    return true;
  };
  return walk(value) ? total : undefined;
};
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const tagged = (error: unknown): TaggedJson | undefined => {
  if (typeof error !== "object" || error === null || !("_tag" in error) || typeof error._tag !== "string" || !Object.hasOwn(READ_ERRORS, error._tag)) return undefined;
  const result: { _tag: string; [field: string]: Json } = { _tag: error._tag };
  for (const [key, value] of Object.entries(error)) {
    if (key === "_tag" || key === "message" || key === "stack" || (key === "cause" && !isPlainJson(value).ok)) continue;
    if (value !== undefined && isPlainJson(value).ok) result[key] = value as Json;
  }
  // Error.cause is non-enumerable, including StoreError's schema field.
  if ("cause" in error && error.cause !== undefined && isPlainJson(error.cause).ok) result.cause = error.cause as Json;
  return result;
};
export const encodeReadExit = (exit: Exit.Exit<unknown, unknown>): TenantReadExit => {
  if (Exit.isSuccess(exit)) {
    if (exit.value === undefined) return {};
    const check = isPlainJson(exit.value);
    return check.ok ? { value: exit.value as Json } : { defect: { message: `the answer is not JSON at ${check.path}` } };
  }
  const reason = exit.cause.reasons[0];
  if (reason?._tag === "Fail") {
    const carried = tagged(reason.error);
    return carried === undefined ? { defect: { message: messageOf(reason.error) } } : { failure: carried };
  }
  if (reason?._tag === "Die") return { defect: tagged(reason.defect) ?? { message: messageOf(reason.defect) } };
  return { defect: { message: "the read was interrupted" } };
};
export const decodeReadExit = (op: TenantReadOp, answer: unknown): Effect.Effect<unknown, unknown> => {
  const broken = () => Effect.die(new StoreError({ op: `remote-read.${op}`, cause: "invalid read exit" }));
  if (typeof answer !== "object" || answer === null || Array.isArray(answer) || !isPlainJson(answer).ok) return broken();
  const keys = Object.keys(answer);
  if (keys.length === 0) return Effect.succeed(undefined);
  if (keys.length !== 1) return broken();
  if ("value" in answer) return Effect.succeed(answer.value);
  const kind = "failure" in answer ? "failure" : "defect" in answer ? "defect" : undefined;
  if (kind === undefined) return broken();
  const detail = (answer as Record<string, unknown>)[kind];
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return broken();
  if ("_tag" in detail && typeof detail._tag === "string" && Object.hasOwn(READ_ERRORS, detail._tag)) {
    const tag = detail._tag as keyof typeof READ_ERRORS;
    return Schema.decodeUnknownEffect(READ_ERRORS[tag] as unknown as Schema.Decoder<unknown>)(detail).pipe(
      Effect.catch(() => broken()),
      Effect.flatMap((error) => kind === "failure" ? Effect.fail(error) : Effect.die(error)),
    );
  }
  if (kind === "defect" && !("_tag" in detail) && "message" in detail && typeof detail.message === "string") return Effect.die(new Error(detail.message));
  return broken();
};
