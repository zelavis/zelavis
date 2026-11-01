import { Effect } from "effect";
import { parseJson } from "../core/json-validation.js";
import { StoreError } from "../db/errors.js";
import { isWriterLease, type LeaseRead, type LeaseStore } from "../db/writer-lease.js";
import { integration } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";

/**
 * Writer leases kept in the System Store: the authority writer leases are conditional against. Every change is the
 * store's own `setIfAbsent` or `compareAndSet` with the observed record's `updatedAt` and value, so a stale writer or
 * a second promoter is refused by the store, not by a check made first.
 *
 * One System Store is one authority: leases between two hosts are only as shared as the store they are both given.
 */
const NAMESPACE = "zelavis.db.writer-leases";


interface Version { readonly updatedAt: string; readonly value: ZelavisSystemStoreValue }

export const systemStoreLeaseStore = (store: ZelavisSystemStore): LeaseStore => {
  const failure = (op: string) => (cause: unknown) => new StoreError({ op, cause: cause instanceof Error ? cause.message : String(cause) });
  return {
    read: (partition) => Effect.gen(function* () {
      const record = yield* integration(() => store.get(NAMESPACE, partition)).pipe(Effect.mapError(failure("lease.read")));
      if (record === undefined) return undefined;
      const lease = yield* Effect.try({
        try: () => parseJson(JSON.stringify(record.value), isWriterLease, "writer lease"),
        catch: failure("lease.read"),
      });
      return { lease, version: { updatedAt: record.updatedAt, value: record.value } satisfies Version } satisfies LeaseRead;
    }),
    create: (lease) => integration(() => store.setIfAbsent(NAMESPACE, lease.partition, lease as unknown as ZelavisSystemStoreValue)).pipe(
      Effect.map((result) => result.created),
      Effect.mapError(failure("lease.create")),
    ),
    replace: (observed, lease) => {
      const version = observed.version as Version;
      return integration(() => store.compareAndSet(NAMESPACE, lease.partition, version.updatedAt, lease as unknown as ZelavisSystemStoreValue, version.value)).pipe(
        Effect.map((record) => record !== undefined),
        Effect.mapError(failure("lease.replace")),
      );
    },
  };
};

/** A change of writer, as the authority recorded it. */
export interface WriterLeaseAuditEntry {
  readonly at: number;
  /** Who asked: the service account or principal that made the call. */
  readonly principal: string;
  readonly partition: string;
  readonly from?: { readonly owner: string; readonly epoch: number };
  readonly to: { readonly owner: string; readonly epoch: number };
  /** A promotion that accepted data loss: the acknowledged positions its copy was missing. */
  readonly lostPositions?: number;
}

export interface WriterLeaseAudit {
  readonly record: (entry: WriterLeaseAuditEntry) => Effect.Effect<void, StoreError>;
  /** The newest entries first, at most `limit`. */
  readonly list: (limit: number) => Effect.Effect<readonly WriterLeaseAuditEntry[], StoreError>;
}

const AUDIT_NAMESPACE = "fabric.writer-lease-audit.v1";
/** Entries kept; older ones are removed as new ones are written. */
const AUDIT_RETAINED = 500;

/** The audit trail of changes of writer, in the System Store. Never holds a credential or a lease's contents beyond owner and epoch. */
export const systemStoreLeaseAudit = (store: ZelavisSystemStore): WriterLeaseAudit => {
  const failure = (op: string) => (cause: unknown) => new StoreError({ op, cause: cause instanceof Error ? cause.message : String(cause) });
  const ordered = <T extends { readonly key: string }>(entries: readonly T[]) => [...entries].sort((a, b) => (a.key < b.key ? 1 : -1));
  return {
    record: (entry) => Effect.gen(function* () {
      const key = `${String(entry.at).padStart(15, "0")}-${crypto.randomUUID()}`;
      yield* integration(() => store.set(AUDIT_NAMESPACE, key, entry as unknown as ZelavisSystemStoreValue));
      const all = ordered(yield* integration(() => store.list(AUDIT_NAMESPACE)));
      for (const old of all.slice(AUDIT_RETAINED)) yield* integration(() => store.delete(AUDIT_NAMESPACE, old.key));
    }).pipe(Effect.mapError(failure("lease.audit"))),
    list: (limit) => integration(() => store.list(AUDIT_NAMESPACE)).pipe(
      Effect.map((records) => ordered(records).slice(0, limit).map((record) => record.value as unknown as WriterLeaseAuditEntry)),
      Effect.mapError(failure("lease.audit")),
    ),
  };
};
