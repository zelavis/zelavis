import { Effect, Stream } from "effect";
import { CrossPartitionQuery, UnknownShard } from "./errors.js";
import type { DbError } from "./errors.js";
import type { Document, DocumentFilter, DocumentSort, DocumentsApi } from "./documents.js";
import type { Query } from "./query.js";
import type { ObjectStoreApi } from "./store.js";
import { tenantOf } from "./tenancy.js";
import type { ShardId, TenantId } from "./topology.js";

/**
 * Answering one question from more than one partition.
 *
 * Everything else in this database is deliberately partition-local: a
 * `PartitionKey` decides where a record lives, identifiers are dense within a
 * partition, and a predicate spanning several data models is one set
 * intersection because all of it is on one node. That is what makes the common
 * case cheap, and it is exactly what a question spanning partitions gives up.
 *
 * So this is a separate, explicitly asked-for surface rather than something the
 * ordinary APIs fall back to. A scatter costs the widest predicate on every
 * partition it touches, it cannot intersect across them, and it returns a
 * result with no single ordering worth trusting. A caller should have to mean
 * it, and should be able to see what it cost.
 */

/** What a fan-out returned from one place, so the cost is visible per part. */
export interface ScatterLeg {
  readonly shard: ShardId;
  readonly tenant?: TenantId;
  readonly rows: number;
  /** A per-leg limit cut this one short; there were more rows behind it. */
  readonly truncated: boolean;
}

export interface ScatterResult<A> {
  readonly rows: ReadonlyArray<A>;
  readonly legs: ReadonlyArray<ScatterLeg>;
  /** Distinct shards the fan-out actually read from. */
  readonly shards: number;
  /** Any leg was cut short, or the merged result was. */
  readonly truncated: boolean;
}

/** A match, named the way a caller looking at several partitions can use. */
export interface ScatterMatch {
  readonly shard: ShardId;
  /**
   * The identifier within its shard.
   *
   * Only meaningful together with the shard: the same number names a different
   * object in every other partition.
   */
  readonly seq: number;
  readonly namespace: string;
  readonly key: string;
  /** Present when the record carries tenancy; derived state does not. */
  readonly tenant?: TenantId;
}

export interface ScatteredDocument {
  readonly tenant: TenantId;
  readonly shard: ShardId;
  readonly document: Document;
}

export interface ScatterResolveInput {
  readonly query: Query;
  /** Shards to read. Omit for every shard in the partition map. */
  readonly shards?: ReadonlyArray<ShardId>;
  /** Matches to take from each shard before merging. */
  readonly perShardLimit?: number;
  readonly limit?: number;
  readonly concurrency?: number;
}

export interface ScatterFindInput {
  readonly collection: string;
  /** Tenants to ask. Omit for every tenant the shards report holding data. */
  readonly tenants?: ReadonlyArray<TenantId>;
  readonly where?: ReadonlyArray<DocumentFilter>;
  readonly orderBy?: ReadonlyArray<DocumentSort>;
  /** Documents to take from each tenant before merging. */
  readonly perTenantLimit?: number;
  readonly limit?: number;
  readonly concurrency?: number;
}

export interface ScatterApi {
  /** Which tenants a document scatter would reach, and where each one lives. */
  readonly targets: (
    tenants?: ReadonlyArray<TenantId>,
  ) => Effect.Effect<ReadonlyArray<{ readonly tenant: TenantId; readonly shard: ShardId }>, DbError>;

  /**
   * Run one lens query on several shards and gather what matches.
   *
   * Shards rather than tenants, because a raw query is opaque: the store cannot
   * tenant-scope a predicate it did not build. Each match is named by shard and
   * identity so it stays meaningful once the results are mixed together.
   */
  readonly resolve: (
    input: ScatterResolveInput,
  ) => Effect.Effect<ScatterResult<ScatterMatch>, DbError | CrossPartitionQuery | UnknownShard>;

  /**
   * Run one document query on several tenants and gather the documents.
   *
   * Tenants rather than shards, because a document query is built per tenant —
   * tenancy is part of the lens keys, not a filter applied afterwards.
   */
  readonly findMany: (
    input: ScatterFindInput,
  ) => Effect.Effect<ScatterResult<ScatteredDocument>, DbError>;
}

/** How many legs run at once when a caller does not say. */
const DEFAULT_CONCURRENCY = 8;

/**
 * Refuse a query whose meaning does not survive the trip.
 *
 * An edge is stored against the identifier it points at, and identifiers are
 * dense and partition-local — so `edge("uses", 41)` asks about one object on
 * the shard it was written on and about an unrelated object everywhere else.
 * Running it on several shards would return rows that look like matches and are
 * not, which is the failure this database treats as the worst kind: nothing
 * looks broken.
 *
 * The same query against a single shard is fine, and that is the check rather
 * than a ban on edges.
 */
const assertPortable = (query: Query, shards: number): Effect.Effect<void, CrossPartitionQuery> => {
  if (shards <= 1) return Effect.void;
  const offending = (q: Query): string | undefined => {
    switch (q._tag) {
      case "Edge":
        return `edge("${q.edgeType}", ${q.from})`;
      case "And":
      case "Or":
        for (const inner of q.of) {
          const found = offending(inner);
          if (found !== undefined) return found;
        }
        return undefined;
      default:
        return undefined;
    }
  };
  const found = offending(query);
  return found === undefined
    ? Effect.void
    : new CrossPartitionQuery({
      detail:
        `${found} names an identifier local to one partition, so it means something ` +
        `different on each of the ${shards} shards this would read. Resolve it on the ` +
        `shard that issued the identifier, then scatter on what that returns.`,
    });
};

const take = <A>(rows: ReadonlyArray<A>, limit: number | undefined) =>
  limit === undefined || rows.length <= limit
    ? { rows, truncated: false }
    : { rows: rows.slice(0, limit), truncated: true };

export const scatterOver = (options: {
  readonly shards: ReadonlyMap<ShardId, ObjectStoreApi>;
  readonly tenantsOn: (store: ObjectStoreApi) => Effect.Effect<ReadonlyArray<TenantId>>;
  readonly shardOf: (tenant: TenantId) => ShardId;
  readonly documentsFor: (tenant: TenantId) => DocumentsApi;
}): ScatterApi => {
  const storeFor = (shard: ShardId) => options.shards.get(shard);

  /**
   * The shards to read, refusing a name the map does not have.
   *
   * Quietly dropping an unrecognised shard would answer a narrower question
   * than the one asked and return it as though it were the answer — the same
   * failure as a wrong row, wearing the shape of a right one.
   */
  const chosenShards = (
    wanted: ReadonlyArray<ShardId> | undefined,
  ): Effect.Effect<ReadonlyArray<ShardId>, UnknownShard> => {
    if (wanted === undefined) return Effect.succeed([...options.shards.keys()]);
    for (const shard of wanted) {
      if (!options.shards.has(shard)) {
        return new UnknownShard({ shard, known: [...options.shards.keys()].sort() });
      }
    }
    return Effect.succeed([...new Set(wanted)]);
  };

  /**
   * Every tenant holding data, asked of the shards rather than of a registry.
   *
   * A shard records its own occupants, so this stays true after a placement
   * change without anything having to be kept in step.
   */
  const allTenants = Effect.gen(function* () {
    const found = new Set<TenantId>();
    for (const store of options.shards.values()) {
      for (const tenant of yield* options.tenantsOn(store)) found.add(tenant);
    }
    return [...found].sort();
  });

  const targets = (tenants?: ReadonlyArray<TenantId>) =>
    Effect.gen(function* () {
      const wanted = tenants ?? (yield* allTenants);
      // Sorted so a scatter and its merged result do not depend on the order a
      // caller happened to list its tenants in. Not filtered: every tenant name
      // hashes to a range and every range is placed, so a tenant that holds
      // nothing is an empty leg rather than one to leave out.
      return [...new Set(wanted)]
        .sort()
        .map((tenant) => ({ tenant, shard: options.shardOf(tenant) }));
    });

  return {
    targets,

    resolve: (input) =>
      Effect.gen(function* () {
        const shards = yield* chosenShards(input.shards);
        yield* assertPortable(input.query, shards.length);

        const legs = yield* Effect.forEach(
          shards,
          (shard) =>
            Effect.gen(function* () {
              const store = storeFor(shard)!;
              const seqs = yield* Stream.runCollect(store.resolve(input.query));
              const capped = take([...seqs], input.perShardLimit);
              const matches: ScatterMatch[] = [];
              for (const seq of capped.rows) {
                const identity = yield* store.identityOf(seq);
                // A match with no identity is derived state — a time series
                // point, a checkpoint — which has no name to hand back and
                // nothing a caller across partitions could do with it.
                if (identity === undefined) continue;
                const tenant = tenantOf(identity.namespace, identity.key);
                matches.push({
                  shard,
                  seq: Number(seq),
                  namespace: identity.namespace,
                  key: identity.key,
                  ...(tenant === undefined ? {} : { tenant }),
                });
              }
              return {
                leg: { shard, rows: matches.length, truncated: capped.truncated },
                matches,
              };
            }),
          { concurrency: input.concurrency ?? DEFAULT_CONCURRENCY },
        );

        // Ordered by shard and then by identifier, which is a stable order
        // rather than a meaningful one: there is no key comparable across
        // partitions, so nothing here says one row is more relevant than
        // another.
        const merged = legs
          .flatMap((leg) => leg.matches)
          .sort((a, b) => (a.shard === b.shard ? a.seq - b.seq : a.shard < b.shard ? -1 : 1));
        const capped = take(merged, input.limit);

        return {
          rows: capped.rows,
          legs: legs.map((leg) => leg.leg),
          shards: shards.length,
          truncated: capped.truncated || legs.some((leg) => leg.leg.truncated),
        };
      }),

    findMany: (input) =>
      Effect.gen(function* () {
        const reach = yield* targets(input.tenants);

        const legs = yield* Effect.forEach(
          reach,
          ({ tenant, shard }) =>
            Effect.gen(function* () {
              const found = yield* options.documentsFor(tenant).findMany({
                collection: input.collection,
                ...(input.where === undefined ? {} : { where: input.where }),
                ...(input.orderBy === undefined ? {} : { orderBy: input.orderBy }),
                // A per-tenant limit is asked for one row wider than the
                // caller wants, so the leg can say whether anything was left
                // behind rather than leaving the caller to guess from a count
                // that happens to equal the limit.
                ...(input.perTenantLimit === undefined
                  ? {}
                  : { limit: input.perTenantLimit + 1 }),
              });
              const capped = take(found, input.perTenantLimit);
              return {
                leg: { shard, tenant, rows: capped.rows.length, truncated: capped.truncated },
                rows: capped.rows.map((document) => ({ tenant, shard, document })),
              };
            }),
          { concurrency: input.concurrency ?? DEFAULT_CONCURRENCY },
        );

        // By tenant and then by document id: an ordering that exists on every
        // partition. A caller wanting newest-first across tenants has to gather
        // and sort, because "newest" compares clocks that no partition shares.
        const merged = legs
          .flatMap((leg) => leg.rows)
          .sort((a, b) =>
            a.tenant === b.tenant
              ? a.document.id < b.document.id ? -1 : a.document.id > b.document.id ? 1 : 0
              : a.tenant < b.tenant ? -1 : 1);
        const capped = take(merged, input.limit);

        return {
          rows: capped.rows,
          legs: legs.map((leg) => leg.leg),
          shards: new Set(reach.map((target) => target.shard)).size,
          truncated: capped.truncated || legs.some((leg) => leg.leg.truncated),
        };
      }),
  };
};
