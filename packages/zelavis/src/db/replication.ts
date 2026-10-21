import { Effect, Stream } from "effect";
import type { DbError } from "./errors.js";
import { ReplicationUnsupported } from "./errors.js";
import { asSeq, type IndexManifest, type ObjectIdentity } from "./model.js";
import type { ObjectStoreApi, RecordState, ShardStoreApi } from "./store.js";
import { COLLECTION_NAMESPACE, collectionOfIdentity, documentNamespace } from "./tenancy.js";
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
 * The copy is a snapshot rather than a log tail: what is live at the source is
 * what belongs on the shard, and whatever else is there is what gets removed.
 * Each copy keeps the source's identifiers — it lives in the App's own
 * partition on each shard, whose identifiers are the App's — so a record is
 * the same number everywhere, and an edge between two replicated records means
 * the same on every shard.
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

  /**
   * Carry one record to every shard, and report how many took it.
   *
   * What a write uses. A refresh compares whole states because it has to work
   * without being told what changed; a write knows exactly, so it pays for one
   * record per shard instead of the whole collection per shard. Absent at the
   * source means the copies are removed, which is how a delete travels — the
   * caller names the identity, so nothing has to reconstruct it from a log.
   *
   * A no-op for anything that is not a replicated collection's, which is what
   * lets a write path call it without first asking whether it should.
   */
  readonly propagate: (
    identity: ObjectIdentity,
  ) => Effect.Effect<number, DbError | ReplicationUnsupported>;

  /** The identity of a document in an App-scoped collection. */
  readonly documentIdentity: (collection: string, id: string) => ObjectIdentity;

  /** The identity of an App-scoped collection's own record. */
  readonly collectionIdentity: (collection: string) => ObjectIdentity;
}

/**
 * Which App-scoped collection a record belongs to, if any.
 *
 * The tenant marker is deliberately not one of these. It records that a tenant
 * holds data on a shard, and copying the App's onto a placed shard would make
 * `tenantsOn` name `zv.global` as an occupant — which would let a rebalance
 * believe a range is standing on data that is only ever a copy.
 */
const collectionOf = (identity: ObjectIdentity): string | undefined =>
  collectionOfIdentity(identity.namespace, identity.key);

export const replicationOver = (input: {
  readonly globalStore: ObjectStoreApi;
  readonly shards: ReadonlyMap<ShardId, ShardStoreApi>;
  readonly placement: PlacementApi;
}): ReplicationApi => {
  const replicatedNames = (): ReadonlySet<string> =>
    new Set(
      Object.entries(input.placement.current().collections)
        .filter(([, placement]) => placement === "replicated")
        .map(([collection]) => collection),
    );

  /**
   * An edge names a record by identifier, and a replica holds only the
   * replicated collections: an edge to a record outside them would name
   * nothing on a shard.
   */
  const outsideReplicas = (edges: IndexManifest["edges"], copied: ReadonlySet<number>) =>
    edges.find(([, to]) => !copied.has(Number(to)));

  const refresh = Effect.gen(function* () {
    const names = replicatedNames();
    const source = (yield* input.globalStore.liveRecords).filter((record) => {
      const collection = collectionOf(record.identity);
      return collection !== undefined && names.has(collection);
    });
    const copied = new Set(source.map((record) => Number(record.seq)));

    for (const record of source) {
      if (outsideReplicas(record.manifest.edges, copied) !== undefined) {
        return yield* new ReplicationUnsupported({
          collection: collectionOf(record.identity) ?? record.identity.namespace,
          reason: "an edge names a record outside the replicated collections, which no replica holds",
        });
      }
    }

    const out: ReplicaStatus[] = [];

    for (const [shard, holder] of input.shards) {
      // The copy lives in the App's own partition on each shard.
      const store = holder.partition(GLOBAL_TENANT);
      let applied = 0;
      let retracted = 0;

      // A copy holds the App's versions, never newer ones: a record ahead of
      // the App's, or retracted here while the App still has it, means the copy
      // was written behind replication's back. Applying by version could not
      // repair it — what is held outranks what the App would send — so the
      // copy is dropped and made again.
      const held = new Map<number, RecordState>();
      yield* Stream.runForEach(store.records, ({ seq, record }) =>
        Effect.sync(() => {
          held.set(Number(seq), record);
        }));
      const diverged = source.some((record) => {
        const state = held.get(Number(record.seq));
        return state !== undefined
          && (state.version > record.version || (!state.live && state.version >= record.version));
      });
      if (diverged) {
        yield* holder.drop(GLOBAL_TENANT);
        held.clear();
      }

      for (const record of source) {
        const existing = held.get(Number(record.seq));
        // A put that is not newer than what is stored is ignored downstream
        // anyway; skipping it here is what keeps a no-op pass free.
        if (existing?.live === true && existing.version >= record.version) continue;
        yield* store.events.apply({
          _tag: "ObjectPut",
          partition: store.partition,
          generation: store.generation,
          at: Date.now(),
          seq: record.seq,
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
        if (copied.has(Number(record.seq))) continue;
        yield* store.transact((txn) => txn.retract(asSeq(record.seq)));
        retracted += 1;
      }

      out.push({ shard, records: source.length, applied, retracted });
    }

    return out;
  });

  const propagate = (identity: ObjectIdentity) =>
    Effect.gen(function* () {
      const collection = collectionOf(identity);
      const names = replicatedNames();
      if (collection === undefined || !names.has(collection)) return 0;

      const sourceSeq = yield* input.globalStore.lookup(identity.namespace, identity.key);
      const record = sourceSeq === undefined
        ? undefined
        : yield* input.globalStore.read(sourceSeq);
      const manifest = sourceSeq === undefined || record === undefined
        ? undefined
        : yield* input.globalStore.manifestOf(sourceSeq);

      for (const [, to] of manifest?.edges ?? []) {
        const target = yield* input.globalStore.identityOf(to);
        const targetCollection = target === undefined ? undefined : collectionOf(target);
        if (targetCollection === undefined || !names.has(targetCollection)) {
          return yield* new ReplicationUnsupported({
            collection,
            reason: "an edge names a record outside the replicated collections, which no replica holds",
          });
        }
      }

      let touched = 0;
      for (const [, holder] of input.shards) {
        const store = holder.partition(GLOBAL_TENANT);
        // A name the source has since given to another record: the copy of the
        // record it used to name goes.
        const stale = yield* store.lookup(identity.namespace, identity.key);
        if (stale !== undefined && (sourceSeq === undefined || record === undefined || Number(stale) !== Number(sourceSeq))) {
          yield* store.transact((txn) => txn.retract(stale));
          touched += 1;
        }
        if (sourceSeq === undefined || record === undefined || manifest === undefined) continue;

        const existing = yield* store.read(sourceSeq);
        if (existing !== undefined && existing.version >= record.version) continue;
        yield* store.events.apply({
          _tag: "ObjectPut",
          partition: store.partition,
          generation: store.generation,
          at: Date.now(),
          seq: sourceSeq,
          version: record.version,
          bytes: record.bytes,
          manifest,
          identity,
        });
        touched += 1;
      }

      return touched;
    });

  return {
    refresh,
    propagate,
    documentIdentity: (collection, id) => ({ namespace: documentNamespace(collection), key: id }),
    collectionIdentity: (collection) => ({ namespace: COLLECTION_NAMESPACE, key: collection }),
  } satisfies ReplicationApi;
};
