import { Effect } from "effect";
import { isNonNegativeInteger, isString, objectFields, parseJson } from "../core/json-validation.js";
import { StoreError } from "../db/errors.js";
import type { LeaseRead, LeaseStore, WriterLease } from "../db/writer-lease.js";
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

const isLease = objectFields<WriterLease>({
  partition: isString, owner: isString, epoch: isNonNegativeInteger, expiresAt: isNonNegativeInteger, acknowledgedHead: isNonNegativeInteger,
});

interface Version { readonly updatedAt: string; readonly value: ZelavisSystemStoreValue }

export const systemStoreLeaseStore = (store: ZelavisSystemStore): LeaseStore => {
  const failure = (op: string) => (cause: unknown) => new StoreError({ op, cause: cause instanceof Error ? cause.message : String(cause) });
  return {
    read: (partition) => Effect.gen(function* () {
      const record = yield* integration(() => store.get(NAMESPACE, partition)).pipe(Effect.mapError(failure("lease.read")));
      if (record === undefined) return undefined;
      const lease = yield* Effect.try({
        try: () => parseJson(JSON.stringify(record.value), isLease, "writer lease"),
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
