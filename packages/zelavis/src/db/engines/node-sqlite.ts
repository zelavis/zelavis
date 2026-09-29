import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Layer, LayerMap, type Scope } from "effect";
import { StoreError } from "../errors.js";
import type { KvEngine } from "../kv.js";
import { openStoreOverKv } from "../kv-store.js";
import type { PartitionKey } from "../model.js";
import { ObjectStore, type ObjectStoreApi } from "../store.js";
import { sqliteKvEngineOver, type SqliteHandle } from "./sqlite-kv.js";

/** Where partition files live. Supplied by the host runtime. */
export class DbRoot extends Context.Service<DbRoot, { readonly directory: string }>()(
  "zelavis/db/DbRoot",
) {
  static readonly layer = (directory: string) =>
    Layer.effect(DbRoot, Effect.succeed({ directory }));
}

/**
 * Opens the SQLite file with the host's own binding.
 *
 * Node provides `node:sqlite`; Bun provides `bun:sqlite` instead and has no
 * `node:sqlite`. Both read and write the same file format, so the store above
 * is unchanged: only the handle differs. Loaded lazily, by specifier, because
 * a static import of the other host's module fails to resolve on load.
 */
const openSqliteHandle = async (file: string): Promise<SqliteHandle> => {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const specifier = "bun:sqlite";
    const { Database } = (await import(specifier)) as {
      Database: new (file: string) => {
        prepare(sql: string): {
          get(...params: ReadonlyArray<unknown>): unknown;
          run(...params: ReadonlyArray<unknown>): unknown;
          iterate(...params: ReadonlyArray<unknown>): Iterable<unknown>;
        };
        run(sql: string): unknown;
        close(): void;
      };
    };
    const db = new Database(file);
    return {
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          // Bun answers `null` for no row; the store reads `undefined`.
          get: (...params) => statement.get(...params) ?? undefined,
          run: (...params) => statement.run(...params),
          iterate: (...params) => statement.iterate(...params),
        };
      },
      exec: (sql) => void db.run(sql),
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(file);
};

/** The default engine: the host's own SQLite, so nothing has to be installed. */
export const makeNodeSqliteEngine = (
  partition: PartitionKey,
  directory: string,
): Effect.Effect<KvEngine, StoreError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        if (directory !== ":memory:") mkdirSync(directory, { recursive: true });
        const db = await openSqliteHandle(
          directory === ":memory:" ? ":memory:" : join(directory, `${partition}.sqlite`),
        );
        return sqliteKvEngineOver(db);
      },
      catch: (cause) => new StoreError({ op: "node-sqlite.open", cause }),
    }),
    (engine) => Effect.orDie(engine.close),
  );

export const makeNodeSqliteStore = (
  partition: PartitionKey,
  directory: string,
): Effect.Effect<ObjectStoreApi, StoreError, Scope.Scope> =>
  Effect.gen(function* () {
    const engine = yield* makeNodeSqliteEngine(partition, directory);
    return yield* openStoreOverKv(partition, engine);
  });

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
 * A plain cache is the wrong tool: evicting an entry drops the handle without
 * closing it, which leaks descriptors and, on a WAL database, risks corruption
 * rather than merely leaking. `LayerMap` ties each entry to a scope, so
 * eviction runs the release that closes the file.
 */
export class Partitions extends LayerMap.Service<Partitions>()("zelavis/db/Partitions", {
  lookup: (partition: PartitionKey) => nodeSqliteStoreLayer(partition),
  idleTimeToLive: "5 minutes",
}) {}
