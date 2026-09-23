import { Effect } from "effect";
import type { DbError } from "./errors.js";
import { ReplicationUnsupported } from "./errors.js";
import { asSeq, type ObjectIdentity } from "./model.js";
import type { ObjectStoreApi } from "./store.js";
import { COLLECTION_NAMESPACE_PREFIX, DOCUMENT_NAMESPACE_PREFIX } from "./tenancy.js";
import type { PlacementApi } from "./topology-store.js";
import { GLOBAL_TENANT, type ShardId } from "./topology.js";

/**
 * Putting App-scoped data on every shard, so a tenant can read it locally.
 *
 * A `global` collection lives in one store, which means a tenant that wants it
 * pays a second store's read to get it. `replicated` is the other bargain: the
 * same data materialized onto every placed shard, so the read a tenant makes is
 * on the shard it was already talking to. What that buys on the read side it
 * pays for on the write side, on every shard, every time.
 *
 * The copy is a snapshot rather than a log tail, and deliberately so. A tail
 * would be cheaper per write, but a retraction carries only a `Seq` — no
 * identity — so a follower has to remember which record every identifier stood
 * for in order to apply a delete. `movement` can hold that map in memory
 * because a move is one bounded operation; replication never ends and survives
 * restarts, so the same map would have to be persisted and would itself grow
 * with the data. A snapshot needs no such memory: what is live at the source is
 * what belongs on the shard, and whatever else is there is what gets removed.
 *
 * The cost is therefore the size of the replicated data on every refresh, not
 * the size of the change. That is the right trade only while replicated
 * collections stay what they are for — small, read-mostly, shared lookup data —
 * and it fails loudly rather than quietly when they do not: a refresh is an
 * operation someone runs and reads the cost of.
 *
 * Refreshing is explicit, and runs when a database opens. A write to a
 * replicated collection is therefore visible to tenant-local reads after the
 * next refresh rather than at the moment it commits. There is no cross-store
 * transaction here and pretending otherwise would be the kind of mechanism that
 * looks fine until it is interrupted.
 */

/** What one shard's copy cost, and what it holds now. */
export interface ReplicaStatus {
  readonly shard: ShardId;
  /** Replicated records the shard holds after this pass. */
  readonly records: number;
  /** Records written to this shard by this pass. */
  readonly applied: number;
  /** Records removed from this shard because the source no longer has them. */
  readonly retracted: number;
}

export interface ReplicationApi {
  /**
   * Bring every placed shard's copy level with the global store.
   *
   * Idempotent: a pass that has nothing to do writes nothing and reports zero.
   * Safe to interrupt — a partial pass leaves each shard at some mix of old and
   * new records, and the next pass finishes it, because what it applies is
   * decided by comparing state rather than by replaying a position.
   */
  readonly refresh: Effect.Effect<ReadonlyArray<ReplicaStatus>, DbError | ReplicationUnsupported>;
}

const COLLECTION_NS = `${COLLECTION_NAMESPACE_PREFIX}${GLOBAL_TENANT}`;
const DOCUMENT_NS = `${DOCUMENT_NAMESPACE_PREFIX}${GLOBAL_TENANT}/`;

/**
 * Which App-scoped collection a record belongs to, if any.
 *
 * The tenant marker is deliberately not one of these. It records that a tenant
 * holds data on a shard, and copying the App's onto a placed shard would make
 * `tenantsOn` name `zv.global` as an occupant — which would let a rebalance
 * believe a range is standing on data that is only ever a copy.
 */
const collectionOf = (identity: ObjectIdentity): string | undefined => {
  if (identity.namespace === COLLECTION_NS) return identity.key;
  if (identity.namespace.startsWith(DOCUMENT_NS)) {
    return identity.namespace.slice(DOCUMENT_NS.length);
  }
  return undefined;
};

const nameOf = (identity: ObjectIdentity): string =>
  `${identity.namespace}\u0000${identity.key}`;

export const replicationOver = (input: {
  readonly globalStore: ObjectStoreApi;
  readonly shards: ReadonlyMap<ShardId, ObjectStoreApi>;
  readonly placement: PlacementApi;
}): ReplicationApi => {
  const replicatedNames = (): ReadonlySet<string> =>
    new Set(
      Object.entries(input.placement.current().collections)
        .filter(([, placement]) => placement === "replicated")
        .map(([collection]) => collection),
    );

  const refresh = Effect.gen(function* () {
    const names = replicatedNames();
    const source = (yield* input.globalStore.liveRecords).filter((record) => {
      const collection = collectionOf(record.identity);
      return collection !== undefined && names.has(collection);
    });

    for (const record of source) {
      if (record.manifest.edges.length > 0) {
        return yield* new ReplicationUnsupported({
          collection: collectionOf(record.identity) ?? record.identity.namespace,
          reason: "an edge names a record by identifier, which a replica reallocates",
        });
      }
    }

    const wanted = new Set(source.map((record) => nameOf(record.identity)));
    const out: ReplicaStatus[] = [];

    for (const [shard, store] of input.shards) {
      let applied = 0;
      let retracted = 0;

      for (const record of source) {
        const seq =
          (yield* store.lookup(record.identity.namespace, record.identity.key))
          ?? (yield* store.nextSeq);
        const existing = yield* store.read(seq);
        // A put that is not newer than what is stored is ignored downstream
        // anyway; skipping it here is what keeps a no-op pass free.
        if (existing !== undefined && existing.version >= record.version) continue;
        yield* store.events.apply({
          _tag: "ObjectPut",
          partition: store.partition,
          generation: store.generation,
          at: Date.now(),
          seq,
          version: record.version,
          bytes: record.bytes,
          manifest: record.manifest,
          identity: record.identity,
        });
        applied += 1;
      }

      // Anything under an App-scoped namespace here that the source no longer
      // holds. A replica is never written directly, so every such record is one
      // this pass is responsible for having left behind.
      for (const record of yield* store.liveRecords) {
        if (collectionOf(record.identity) === undefined) continue;
        if (wanted.has(nameOf(record.identity))) continue;
        yield* store.transact((txn) => txn.retract(asSeq(record.seq)));
        retracted += 1;
      }

      out.push({ shard, records: source.length, applied, retracted });
    }

    return out;
  });

  return { refresh } satisfies ReplicationApi;
};
