import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer, LayerMap, Stream } from "effect";
import { ForeignCursor, StoreError, WriterFenced } from "../errors.js";
import type { DbEvent, EventCursor, ReadEventsOptions } from "../events.js";
import {
  asSeq,
  type IndexManifest,
  type ObjectIdentity,
  type PartitionKey,
  type Seq,
} from "../model.js";
import * as Postings from "../postings.js";
import type { Query } from "../query.js";
import { ObjectStore, type EventsApi, type ObjectStoreApi, type Txn } from "../store.js";

/**
 * Physical layout for one partition.
 *
 * Two details are load-bearing. `objects` is a rowid table because SQLite
 * inlines large values into b-tree leaf pages, so a `WITHOUT ROWID` table
 * holding payload blobs bloats the index it is supposed to accelerate. The lens
 * tables are the opposite case — narrow rows, no payload — where `WITHOUT
 * ROWID` removes an indirection and makes the primary-key b-tree itself the
 * posting list, so a range scan yields identifiers already in sorted order.
 */
const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS objects (
    seq INTEGER PRIMARY KEY,
    version INTEGER NOT NULL,
    body BLOB NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lens_term (
    field TEXT NOT NULL, term TEXT NOT NULL, seq INTEGER NOT NULL,
    PRIMARY KEY (field, term, seq)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS lens_column (
    column_name TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
    PRIMARY KEY (column_name, value, seq)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS lens_measure (
    column_name TEXT NOT NULL, seq INTEGER NOT NULL, value REAL NOT NULL,
    PRIMARY KEY (column_name, seq)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS lens_edge (
    edge_type TEXT NOT NULL, src INTEGER NOT NULL, dst INTEGER NOT NULL,
    PRIMARY KEY (edge_type, src, dst)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS keys (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (namespace, key)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS keys_by_seq ON keys (seq);

  CREATE TABLE IF NOT EXISTS manifests (
    seq INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    position INTEGER PRIMARY KEY AUTOINCREMENT,
    generation INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    version INTEGER NOT NULL,
    body BLOB,
    manifest TEXT,
    at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
`;

/** Where partition files live. Supplied by the host runtime. */
export class DbRoot extends Context.Service<DbRoot, { readonly directory: string }>()(
  "zelavis/dbnew/DbRoot",
) {
  static readonly layer = (directory: string) =>
    Layer.effect(DbRoot, Effect.succeed({ directory }));
}

// Domain failures pass through unchanged; only genuinely unexpected causes are
// wrapped. Flattening a fencing failure into a generic store error would leave
// callers unable to distinguish "this write is not yours to make" from "the
// disk is broken".
const fail = (op: string) => (cause: unknown): StoreError | WriterFenced | ForeignCursor =>
  cause instanceof WriterFenced || cause instanceof ForeignCursor
    ? cause
    : new StoreError({ op, cause });

/**
 * Cursor encoding is private to this driver.
 *
 * It carries the partition so a cursor cannot be replayed against the wrong
 * shard, and the physical position so continuation is exact.
 */
const encodeCursor = (partition: PartitionKey, position: number): EventCursor =>
  Buffer.from(`${partition}\u0000${position}`, "utf8").toString("base64url") as EventCursor;

const decodeCursor = (
  partition: PartitionKey,
  cursor: EventCursor,
): { readonly position: number } => {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const at = raw.lastIndexOf("\u0000");
  const owner = raw.slice(0, at);
  if (owner !== partition) {
    throw new ForeignCursor({ expected: partition, received: owner });
  }
  return { position: Number(raw.slice(at + 1)) };
};

export const makeNodeSqliteStore = (partition: PartitionKey, directory: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        mkdirSync(directory, { recursive: true });
        const db = new DatabaseSync(join(directory, `${partition}.sqlite`));
        db.exec(SCHEMA);
        return db;
      },
      catch: fail("open"),
    }),
    (db) => Effect.sync(() => db.close()),
  ).pipe(
    Effect.map((db) => {
      const st = {
        putObject: db.prepare("INSERT OR REPLACE INTO objects VALUES (?, ?, ?)"),
        getObject: db.prepare("SELECT seq, version, body FROM objects WHERE seq = ?"),
        delObject: db.prepare("DELETE FROM objects WHERE seq = ?"),
        putTerm: db.prepare("INSERT OR IGNORE INTO lens_term VALUES (?, ?, ?)"),
        putColumn: db.prepare("INSERT OR IGNORE INTO lens_column VALUES (?, ?, ?)"),
        putMeasure: db.prepare("INSERT OR REPLACE INTO lens_measure VALUES (?, ?, ?)"),
        putEdge: db.prepare("INSERT OR IGNORE INTO lens_edge VALUES (?, ?, ?)"),
        delTerm: db.prepare("DELETE FROM lens_term WHERE field = ? AND term = ? AND seq = ?"),
        delColumn: db.prepare(
          "DELETE FROM lens_column WHERE column_name = ? AND value = ? AND seq = ?",
        ),
        delMeasure: db.prepare("DELETE FROM lens_measure WHERE column_name = ? AND seq = ?"),
        delEdge: db.prepare("DELETE FROM lens_edge WHERE edge_type = ? AND src = ? AND dst = ?"),
        putKey: db.prepare("INSERT OR REPLACE INTO keys VALUES (?, ?, ?)"),
        getKey: db.prepare("SELECT seq FROM keys WHERE namespace = ? AND key = ?"),
        delKeyBySeq: db.prepare("DELETE FROM keys WHERE seq = ?"),
        putManifest: db.prepare("INSERT OR REPLACE INTO manifests VALUES (?, ?)"),
        getManifest: db.prepare("SELECT data FROM manifests WHERE seq = ?"),
        delManifest: db.prepare("DELETE FROM manifests WHERE seq = ?"),
        scanTerm: db.prepare(
          "SELECT seq FROM lens_term WHERE field = ? AND term = ? ORDER BY seq",
        ),
        scanColumn: db.prepare(
          "SELECT seq FROM lens_column WHERE column_name = ? AND value = ? ORDER BY seq",
        ),
        scanEdge: db.prepare(
          "SELECT dst FROM lens_edge WHERE edge_type = ? AND src = ? ORDER BY dst",
        ),
        scanMeasure: db.prepare(
          "SELECT seq, value FROM lens_measure WHERE column_name = ? ORDER BY seq",
        ),
        maxMeasureSeq: db.prepare(
          "SELECT MAX(seq) AS max_seq FROM lens_measure WHERE column_name = ?",
        ),
        appendEvent: db.prepare(
          "INSERT INTO events (generation, seq, kind, version, body, manifest, at)" +
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
        ),
        readEvents: db.prepare(
          "SELECT position, generation, seq, kind, version, body, manifest, at FROM events" +
            " WHERE position > ? ORDER BY position LIMIT ?",
        ),
        headEvent: db.prepare("SELECT MAX(position) AS position FROM events"),
        versionOf: db.prepare("SELECT version FROM objects WHERE seq = ?"),
        lastApplied: db.prepare(
          "SELECT MAX(version) AS version FROM events WHERE seq = ?",
        ),
        readGeneration: db.prepare("SELECT value FROM meta WHERE key = 'generation'"),
        claimGeneration: db.prepare(
          "INSERT INTO meta (key, value) VALUES ('generation', ?)" +
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ),
        truncateLenses: [
          db.prepare("DELETE FROM lens_term"),
          db.prepare("DELETE FROM lens_column"),
          db.prepare("DELETE FROM lens_measure"),
          db.prepare("DELETE FROM lens_edge"),
          db.prepare("DELETE FROM manifests"),
          db.prepare("DELETE FROM keys"),
          db.prepare("DELETE FROM objects"),
        ],
        readSeq: db.prepare("SELECT value FROM meta WHERE key = 'next_seq'"),
        bumpSeq: db.prepare(
          "INSERT INTO meta (key, value) VALUES ('next_seq', ?)" +
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ),
      };

      // Claim the next writer generation. Opening a second handle to the same
      // partition fences the first one, which is what makes a stale placement
      // safe even when both owners sit on one Node.
      const prior = (st.readGeneration.get() as { value: number } | undefined)?.value ?? 0;
      const generation = prior + 1;
      st.claimGeneration.run(generation);

      const assertCurrent = (): void => {
        const current =
          (st.readGeneration.get() as { value: number } | undefined)?.value ?? 0;
        if (current !== generation) {
          throw new WriterFenced({ partition, claimed: generation, current });
        }
      };

      const unproject = (seq: Seq): void => {
        const row = st.getManifest.get(seq) as { data: string } | undefined;
        if (row === undefined) return;
        const man = JSON.parse(row.data) as IndexManifest;
        for (const [field, t] of man.terms) st.delTerm.run(field, t, seq);
        for (const [column, value] of man.columns) st.delColumn.run(column, value, seq);
        for (const [column] of man.measures) st.delMeasure.run(column, seq);
        for (const [edgeType, to] of man.edges) st.delEdge.run(edgeType, seq, to);
        st.delManifest.run(seq);
      };

      const project = (
        seq: Seq,
        version: number,
        bytes: Uint8Array,
        manifest: IndexManifest,
        identity?: ObjectIdentity,
      ): void => {
        unproject(seq);
        st.putObject.run(seq, version, bytes);
        if (identity !== undefined) {
          st.putKey.run(identity.namespace, identity.key, seq);
        }
        for (const [field, t] of manifest.terms) st.putTerm.run(field, t, seq);
        for (const [column, value] of manifest.columns) st.putColumn.run(column, value, seq);
        for (const [column, value] of manifest.measures) st.putMeasure.run(column, seq, value);
        for (const [edgeType, to] of manifest.edges) st.putEdge.run(edgeType, seq, to);
        st.putManifest.run(seq, JSON.stringify(manifest));
      };

      const rowToEvent = (row: {
        position: number;
        generation: number;
        seq: number;
        kind: string;
        version: number;
        body: Uint8Array | null;
        manifest: string | null;
        at: number;
      }): DbEvent => {
        const common = {
          cursor: encodeCursor(partition, row.position),
          partition,
          generation: row.generation,
          at: row.at,
          seq: asSeq(row.seq),
          version: row.version,
        };
        if (row.kind !== "put") return { _tag: "ObjectRetracted", ...common };
        const stored = JSON.parse(row.manifest ?? "{}") as IndexManifest & {
          identity?: ObjectIdentity;
        };
        const { identity, ...manifest } = stored;
        return {
          _tag: "ObjectPut",
          ...common,
          bytes: row.body ?? new Uint8Array(),
          manifest: manifest as IndexManifest,
          ...(identity === undefined ? {} : { identity }),
        };
      };

      // Rows stream straight into a bitmap. Nothing accumulates a JavaScript
      // array of postings, which is what made a wide predicate expensive
      // regardless of how selective the query as a whole turned out to be.
      const collect = (
        rows: Iterable<Record<string, number>>,
        field: string,
      ): Postings.Postings => {
        const builder = new Postings.PostingsBuilder();
        for (const row of rows) builder.add(row[field]!);
        return builder.build();
      };

      const evaluate = (query: Query): Postings.Postings => {
        switch (query._tag) {
          case "Term":
            return collect(
              st.scanTerm.iterate(query.field, query.term) as Iterable<Record<string, number>>,
              "seq",
            );
          case "Equals":
            return collect(
              st.scanColumn.iterate(query.column, query.value) as Iterable<
                Record<string, number>
              >,
              "seq",
            );
          case "Edge":
            return collect(
              st.scanEdge.iterate(query.edgeType, query.from) as Iterable<
                Record<string, number>
              >,
              "dst",
            );
          case "And":
            return Postings.andAll(query.of.map(evaluate));
          case "Or":
            return Postings.orAll(query.of.map(evaluate));
        }
      };

      const exec = (sql: string) =>
        Effect.try({ try: () => void db.exec(sql), catch: fail(sql) });

      const txn: Txn = {
        put: (seq, bytes, manifest, identity) =>
          Effect.try({
            try: () => {
              assertCurrent();
              const existing = st.versionOf.get(seq) as { version: number } | undefined;
              const version = (existing?.version ?? 0) + 1;
              // The log is the source of truth, so it is appended before the
              // lenses are touched. A crash between the two leaves an event
              // whose projection can be replayed, never a lens row with no
              // event behind it.
              st.appendEvent.run(
                generation,
                seq,
                "put",
                version,
                bytes,
                JSON.stringify(identity === undefined ? manifest : { ...manifest, identity }),
                Date.now(),
              );
              project(seq, version, bytes, manifest, identity);
            },
            catch: fail("txn.put"),
          }),

        retract: (seq) =>
          Effect.try({
            try: () => {
              assertCurrent();
              const existing = st.versionOf.get(seq) as { version: number } | undefined;
              if (existing === undefined) return;
              st.appendEvent.run(
                generation,
                seq,
                "retract",
                existing.version + 1,
                null,
                null,
                Date.now(),
              );
              unproject(seq);
              st.delKeyBySeq.run(seq);
              st.delObject.run(seq);
            },
            catch: fail("txn.retract"),
          }),
      };

      const events: EventsApi = {
        read: (options?: ReadEventsOptions) =>
          Stream.fromIterableEffect(
            Effect.try({
              try: () => {
                const after =
                  options?.after === undefined
                    ? 0
                    : decodeCursor(partition, options.after).position;
                const limit = options?.limit ?? 1024;
                return (st.readEvents.all(after, limit) as Array<never>).map(rowToEvent);
              },
              catch: fail("events.read"),
            }),
          ),

        head: Effect.try({
          try: () => {
            const row = st.headEvent.get() as { position: number | null } | undefined;
            return row?.position == null ? undefined : encodeCursor(partition, row.position);
          },
          catch: fail("events.head"),
        }),

        apply: (event: DbEvent) =>
          Effect.try({
            try: () => {
              // Idempotent by (seq, version): a follower may safely re-consume
              // an overlapping range after an interruption.
              const seen = (st.lastApplied.get(event.seq) as { version: number | null })
                ?.version;
              if (seen != null && seen >= event.version) return;
              st.appendEvent.run(
                event.generation,
                event.seq,
                event._tag === "ObjectPut" ? "put" : "retract",
                event.version,
                event._tag === "ObjectPut" ? event.bytes : null,
                event._tag === "ObjectPut"
                  ? JSON.stringify(
                      event.identity === undefined
                        ? event.manifest
                        : { ...event.manifest, identity: event.identity },
                    )
                  : null,
                event.at,
              );
              if (event._tag === "ObjectPut") {
                project(event.seq, event.version, event.bytes, event.manifest, event.identity);
              } else {
                unproject(event.seq);
                st.delKeyBySeq.run(event.seq);
                st.delObject.run(event.seq);
              }
            },
            catch: fail("events.apply"),
          }),
      };

      return {
        partition,
        generation,
        events,

        rebuildLenses: Effect.try({
          try: () => {
            db.exec("BEGIN");
            try {
              for (const stmt of st.truncateLenses) stmt.run();
              let after = 0;
              let applied = 0;
              for (;;) {
                const rows = st.readEvents.all(after, 1024) as Array<{
                  position: number;
                  seq: number;
                  kind: string;
                  version: number;
                  body: Uint8Array | null;
                  manifest: string | null;
                }>;
                if (rows.length === 0) break;
                for (const row of rows) {
                  if (row.kind === "put") {
                    const stored = JSON.parse(row.manifest ?? "{}") as IndexManifest & {
                      identity?: ObjectIdentity;
                    };
                    const { identity, ...manifest } = stored;
                    project(
                      asSeq(row.seq),
                      row.version,
                      row.body ?? new Uint8Array(),
                      manifest as IndexManifest,
                      identity,
                    );
                  } else {
                    unproject(asSeq(row.seq));
                    st.delKeyBySeq.run(asSeq(row.seq));
                    st.delObject.run(row.seq);
                  }
                  after = row.position;
                  applied++;
                }
              }
              db.exec("COMMIT");
              return applied;
            } catch (cause) {
              db.exec("ROLLBACK");
              throw cause;
            }
          },
          catch: fail("rebuildLenses"),
        }),

        lookup: Effect.fn("ObjectStore.lookup")(function* (
          namespace: string,
          key: string,
        ) {
          return yield* Effect.try({
            try: () => {
              const row = st.getKey.get(namespace, key) as { seq: number } | undefined;
              return row === undefined ? undefined : asSeq(row.seq);
            },
            catch: fail("lookup"),
          });
        }),

        nextSeq: Effect.try({
          try: () => {
            const row = st.readSeq.get() as { value: number } | undefined;
            const next = (row?.value ?? 0) + 1;
            st.bumpSeq.run(next);
            return asSeq(next);
          },
          catch: fail("nextSeq"),
        }),

        transact: (f) =>
          Effect.gen(function* () {
            yield* exec("BEGIN");
            return yield* f(txn).pipe(
              Effect.tap(() => exec("COMMIT")),
              Effect.catchCause((cause) =>
                exec("ROLLBACK").pipe(Effect.andThen(Effect.failCause(cause))),
              ),
            );
          }),

        read: Effect.fn("ObjectStore.read")(function* (seq: Seq) {
          return yield* Effect.try({
            try: () => {
              const row = st.getObject.get(seq) as
                | { seq: number; version: number; body: Uint8Array }
                | undefined;
              return row === undefined
                ? undefined
                : { seq: asSeq(row.seq), version: row.version, bytes: row.body };
            },
            catch: fail("read"),
          });
        }),

        resolve: (query) =>
          Stream.fromIterableEffect(
            Effect.try({
              try: () => Postings.iterate(evaluate(query)),
              catch: fail("resolve"),
            }),
          ),

        measure: Effect.fn("ObjectStore.measure")(function* (column: string) {
          return yield* Effect.try({
            try: () => {
              const bound = st.maxMeasureSeq.get(column) as { max_seq: number | null } | undefined;
              const vec = new Float64Array((bound?.max_seq ?? 0) + 1);
              for (const r of st.scanMeasure.iterate(column) as Iterable<{
                seq: number;
                value: number;
              }>) {
                vec[r.seq] = r.value;
              }
              return vec;
            },
            catch: fail("measure"),
          });
        }),
      } satisfies ObjectStoreApi;
    }),
  );

export const nodeSqliteStoreLayer = (partition: PartitionKey) =>
  Layer.effect(
    ObjectStore,
    Effect.gen(function* () {
      const root = yield* DbRoot;
      return yield* makeNodeSqliteStore(partition, root.directory);
    }),
  );

/**
 * One store per partition, opened on demand and released when idle.
 *
 * A plain cache is the wrong tool here: evicting an entry drops the handle
 * without closing it, which leaks file descriptors and, on a WAL database, is a
 * corruption risk rather than merely a leak. `LayerMap` ties each entry to a
 * scope, so eviction runs the release that actually closes the file.
 */
export class Partitions extends LayerMap.Service<Partitions>()("zelavis/dbnew/Partitions", {
  lookup: (partition: PartitionKey) => nodeSqliteStoreLayer(partition),
  idleTimeToLive: "5 minutes",
}) {}
