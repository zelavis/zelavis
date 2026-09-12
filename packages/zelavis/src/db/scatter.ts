import { Effect, Stream } from "effect";
import {
  CrossPartitionQuery, CursorMismatch, UnanalyzedCollection, UnindexedGeometry, UnknownReference,
  UnknownShard, UnsupportedOrdering,
} from "./errors.js";
import type { DbError } from "./errors.js";
import {
  compareDocuments,
  type Document,
  type RelatedFilter,
  type DocumentCursor,
  type DocumentFilter,
  type DocumentSort,
  type DocumentsApi,
} from "./documents.js";
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
 * partition it touches and it cannot intersect across them. What it can do
 * across them is order: asked for one, it merges every partition's run by
 * value; otherwise its rows come in a stable order that means nothing more. A
 * caller should have to mean it, and should be able to see what it cost.
 */

/** What a fan-out returned from one place, so the cost is visible per part. */
export interface ScatterLeg {
  readonly shard: ShardId;
  readonly tenant?: TenantId;
  readonly rows: number;
  /** A per-leg limit cut this one short; there were more rows behind it. */
  readonly truncated: boolean;
  /** Documents read from the leg, which a merge can take fewer of than it read. */
  readonly read?: number;
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
  /** Joins, answered inside each tenant: a reference never leaves one. */
  readonly related?: ReadonlyArray<RelatedFilter>;
  /**
   * Merged across tenants by these fields, exactly as one tenant's `findMany`
   * orders them, and tenant by tenant among equals. Without an order, rows go
   * by tenant and then by document id.
   */
  readonly orderBy?: ReadonlyArray<DocumentSort>;
  /** Documents to take from each tenant before merging; with an order and no per-tenant limit, `limit`. */
  readonly perTenantLimit?: number;
  readonly limit?: number;
  readonly concurrency?: number;
}

declare const ScatterCursorBrand: unique symbol;

/**
 * Where a scatter page stopped, in every tenant it reads.
 *
 * Opaque, and bound to its collection, its order and its tenants. It holds a
 * document cursor per tenant rather than one position overall, because no
 * position is shared across partitions: each tenant resumes just after the
 * last of its documents the merge took, whatever it had read beyond that.
 */
export type ScatterCursor = string & { readonly [ScatterCursorBrand]: true };

export interface ScatterPageInput {
  readonly collection: string;
  /** Tenants to ask. Omit for every tenant the shards report holding data; a continued read keeps its own. */
  readonly tenants?: ReadonlyArray<TenantId>;
  readonly where?: ReadonlyArray<DocumentFilter>;
  /** Joins, answered inside each tenant: a reference never leaves one. */
  readonly related?: ReadonlyArray<RelatedFilter>;
  /** As `findPage` orders one tenant. Without one, tenant after tenant, each in identifier order. */
  readonly orderBy?: ReadonlyArray<DocumentSort>;
  /** Documents per page: 50 unless given, and at most 1000. */
  readonly limit?: number;
  readonly after?: ScatterCursor;
  readonly concurrency?: number;
}

export interface ScatterPage {
  readonly rows: ReadonlyArray<ScatteredDocument>;
  /** Present only when another matching document follows, in some tenant. */
  readonly next?: ScatterCursor;
  /**
   * Each tenant this page read: `rows` it contributed, `read` documents it was
   * asked for, and `truncated` when it has more after them.
   */
  readonly legs: ReadonlyArray<ScatterLeg>;
  readonly shards: number;
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
  ) => Effect.Effect<
    ScatterResult<ScatteredDocument>,
    DbError | UnknownReference | UnanalyzedCollection | UnindexedGeometry
  >;

  /**
   * One page of documents from several tenants, merged into one order.
   *
   * Each tenant is read with its own `findPage` in the same order, and the
   * runs are merged by value, tenant by tenant among equals — so a page is the
   * next `limit` documents of the order across all of them, not a page from
   * each. A page starts with a share of `limit` from every tenant and tops up
   * whichever the merge drains, so what it reads grows with the page and the
   * number of tenants, not with what they hold. An order some tenant cannot
   * page — several fields and no composite index there — is refused, naming
   * the tenant.
   */
  readonly findPage: (
    input: ScatterPageInput,
  ) => Effect.Effect<
    ScatterPage,
    | DbError | CursorMismatch | UnsupportedOrdering | UnknownReference | UnanalyzedCollection
    | UnindexedGeometry
  >;
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

/** An order as a cursor records it: every default filled in, so equal orders match. */
const orderOf = (orderBy: ReadonlyArray<DocumentSort> | undefined) =>
  (orderBy ?? []).map((sort) => [
    sort.path,
    sort.direction === "desc" ? "desc" : "asc",
    sort.nulls === "first" ? "first" : "last",
  ]);

/** Where one tenant stands in a scatter page read. */
interface LegPosition {
  readonly tenant: TenantId;
  /** Just after the last document the merge took from it; undefined before the first. */
  position: DocumentCursor | undefined;
  /** Nothing is left to take. */
  done: boolean;
}

const encodeScatterCursor = (
  collection: string,
  order: ReturnType<typeof orderOf>,
  legs: ReadonlyArray<LegPosition>,
): ScatterCursor =>
  Buffer.from(
    JSON.stringify({
      v: 1, c: collection, o: order,
      t: legs.map((leg) => [leg.tenant, leg.done ? 0 : leg.position ?? null]),
    }),
    "utf8",
  ).toString("base64url") as ScatterCursor;

const decodeScatterCursor = (
  cursor: ScatterCursor,
  collection: string,
  order: ReturnType<typeof orderOf>,
  tenants: ReadonlyArray<TenantId> | undefined,
): Effect.Effect<Array<LegPosition>, CursorMismatch> =>
  Effect.gen(function* () {
    const malformed = new CursorMismatch({ reason: "the cursor is not one a scatter page produced" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
      return yield* malformed;
    }
    if (typeof parsed !== "object" || parsed === null) return yield* malformed;
    const { v, c, o, t } = parsed as Record<string, unknown>;
    if (v !== 1 || !Array.isArray(t)) return yield* malformed;
    if (c !== collection || JSON.stringify(o) !== JSON.stringify(order)) {
      return yield* new CursorMismatch({
        reason: `the cursor continues a different scatter: another order, or over "${String(c)}"`,
      });
    }
    const legs: Array<LegPosition> = [];
    for (const entry of t as ReadonlyArray<unknown>) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") return yield* malformed;
      const at: unknown = entry[1];
      if (at !== 0 && at !== null && typeof at !== "string") return yield* malformed;
      legs.push({
        tenant: entry[0] as TenantId,
        position: typeof at === "string" ? (at as DocumentCursor) : undefined,
        done: at === 0,
      });
    }
    if (tenants !== undefined &&
      [...new Set(tenants)].sort().join("\n") !== legs.map((leg) => leg.tenant).join("\n")) {
      return yield* new CursorMismatch({
        reason: "the cursor continues a read of other tenants; a continued scatter keeps the tenants it began with",
      });
    }
    return legs;
  });

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
        const byValue = input.orderBy === undefined || input.orderBy.length === 0
          ? undefined
          : compareDocuments(input.orderBy);
        // Ordered, a tenant's first `limit` are all the merge can take from it.
        const legLimit = input.perTenantLimit ?? (byValue === undefined ? undefined : input.limit);

        const legs = yield* Effect.forEach(
          reach,
          ({ tenant, shard }) =>
            Effect.gen(function* () {
              const found = yield* options.documentsFor(tenant).findMany({
                collection: input.collection,
                ...(input.where === undefined ? {} : { where: input.where }),
                ...(input.related === undefined ? {} : { related: input.related }),
                ...(input.orderBy === undefined ? {} : { orderBy: input.orderBy }),
                // A per-tenant limit is asked for one row wider than the
                // caller wants, so the leg can say whether anything was left
                // behind rather than leaving the caller to guess from a count
                // that happens to equal the limit.
                ...(legLimit === undefined ? {} : { limit: legLimit + 1 }),
              }).pipe(Effect.catchTags({
            UnembeddedCollection: Effect.die,
            InvalidVectorQuery: Effect.die,
            UnknownEdge: Effect.die,
          }));
              const capped = take(found, legLimit);
              return {
                leg: { shard, tenant, rows: capped.rows.length, truncated: capped.truncated },
                rows: capped.rows.map((document) => ({ tenant, shard, document })),
              };
            }),
          { concurrency: input.concurrency ?? DEFAULT_CONCURRENCY },
        );

        const rows = legs.flatMap((leg) => leg.rows);
        const merged = byValue === undefined
          // By tenant and then by document id: an ordering that exists on every
          // partition, and nothing more than a stable one.
          ? rows.sort((a, b) =>
            a.tenant === b.tenant
              ? a.document.id < b.document.id ? -1 : a.document.id > b.document.id ? 1 : 0
              : a.tenant < b.tenant ? -1 : 1)
          // By value, as each tenant ordered its own, then by tenant. The legs
          // arrive in tenant order and the sort is stable, so documents equal
          // within one tenant keep the order that tenant gave them.
          : rows.sort((a, b) =>
            byValue(a.document, b.document) || (a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : 0));
        const capped = take(merged, input.limit);

        return {
          rows: capped.rows,
          legs: legs.map((leg) => leg.leg),
          shards: new Set(reach.map((target) => target.shard)).size,
          truncated: capped.truncated || legs.some((leg) => leg.leg.truncated),
        };
      }),

    findPage: (input) =>
      Effect.gen(function* () {
        const limit = input.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
          return yield* Effect.die(new RangeError(`A scatter page takes 1 to 1000 documents, not ${limit}.`));
        }
        const order = orderOf(input.orderBy);
        const positions: Array<LegPosition> = input.after === undefined
          ? (yield* targets(input.tenants)).map(({ tenant }) => ({ tenant, position: undefined, done: false }))
          : yield* decodeScatterCursor(input.after, input.collection, order, input.tenants);

        interface Leg {
          readonly at: LegPosition;
          readonly shard: ShardId;
          /** Documents read and not yet taken, each with the cursor just after it. */
          buffer: Array<{ readonly document: Document; readonly cursor: DocumentCursor }>;
          next: number;
          more: boolean;
          read: number;
          took: number;
        }
        const legs: Array<Leg> = positions
          .filter((at) => !at.done)
          .map((at) => ({ at, shard: options.shardOf(at.tenant), buffer: [], next: 0, more: true, read: 0, took: 0 }));
        const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY;

        const fill = (leg: Leg, count: number) =>
          Effect.gen(function* () {
            const page = yield* options.documentsFor(leg.at.tenant).findPage({
              collection: input.collection,
              ...(input.where === undefined ? {} : { where: input.where }),
              ...(input.related === undefined ? {} : { related: input.related }),
              ...(input.orderBy === undefined ? {} : { orderBy: input.orderBy }),
              limit: count,
              ...(leg.at.position === undefined ? {} : { after: leg.at.position }),
              cursors: true,
            }).pipe(Effect.catchTags({ UnknownEdge: Effect.die })).pipe(Effect.mapError((error) =>
              error._tag === "UnsupportedOrdering"
                ? new UnsupportedOrdering({ reason: `tenant "${leg.at.tenant}" cannot page it: ${error.reason}` })
                : error));
            leg.buffer = page.documents.map((document, i) => ({ document, cursor: page.cursors![i]! }));
            leg.next = 0;
            leg.more = page.next !== undefined;
            leg.read += leg.buffer.length;
          });
        const drained = (leg: Leg) => leg.next >= leg.buffer.length;

        // A share of the page from every tenant to start with, not a page from
        // each; whichever the merge drains is topped up as it goes.
        yield* Effect.forEach(
          legs,
          (leg) => fill(leg, Math.min(limit, Math.ceil(limit / legs.length) + 1)),
          { concurrency },
        );
        const byValue = compareDocuments(input.orderBy ?? []);
        const rows: Array<ScatteredDocument> = [];
        while (rows.length < limit) {
          // The smallest head can only be chosen once every tenant with more
          // to give is showing one.
          yield* Effect.forEach(
            legs.filter((leg) => drained(leg) && leg.more),
            (leg) => fill(leg, limit - rows.length),
            { concurrency },
          );
          let chosen: Leg | undefined;
          for (const leg of legs) {
            if (drained(leg)) continue;
            // Strictly smaller only, so among equals the earlier tenant goes first.
            if (chosen === undefined ||
              byValue(leg.buffer[leg.next]!.document, chosen.buffer[chosen.next]!.document) < 0) {
              chosen = leg;
            }
          }
          if (chosen === undefined) break;
          const row = chosen.buffer[chosen.next]!;
          chosen.next += 1;
          chosen.took += 1;
          chosen.at.position = row.cursor;
          rows.push({ tenant: chosen.at.tenant, shard: chosen.shard, document: row.document });
        }
        for (const leg of legs) leg.at.done = drained(leg) && !leg.more;

        return {
          rows,
          ...(positions.some((at) => !at.done)
            ? { next: encodeScatterCursor(input.collection, order, positions) }
            : {}),
          legs: legs.map((leg) => ({
            shard: leg.shard, tenant: leg.at.tenant, rows: leg.took, truncated: !leg.at.done, read: leg.read,
          })),
          shards: new Set(legs.map((leg) => leg.shard)).size,
        };
      }),
  };
};
