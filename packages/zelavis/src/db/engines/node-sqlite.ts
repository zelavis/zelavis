import { present, integrationValue, type IntegrationFailure } from "../../core/runtime/effect-boundary.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, type Scope } from "effect";
import { StoreError } from "../errors.js";
import type { KvEngine } from "../kv.js";
import { openShardOverKv, type OpenShardOptions } from "../kv-store.js";
import type { PartitionKey } from "../model.js";
import type { ShardStoreApi } from "../store.js";
import type { ShardId } from "../topology.js";
import { sqliteKvEngineOver, type SqliteHandle } from "./sqlite-kv.js";

/**
 * Opens the SQLite file with the host's own binding.
 *
 * Node provides `node:sqlite`; Bun provides `bun:sqlite` instead and has no
 * `node:sqlite`. Both read and write the same file format, so the store above
 * is unchanged: only the handle differs. Loaded lazily, by specifier, because
 * a static import of the other host's module fails to resolve on load.
 */
const openSqliteHandle = (file: string): Promise<SqliteHandle> => present(Effect.gen(function* (): Effect.fn.Return<SqliteHandle, IntegrationFailure> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const specifier = "bun:sqlite";
    const { Database } = ((yield* integrationValue(import(specifier)))) as {
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
  const { DatabaseSync } = (yield* integrationValue(import("node:sqlite")));
  return new DatabaseSync(file);
}));

/** The default engine: the host's own SQLite, so nothing has to be installed. */
export const makeNodeSqliteEngine = (
  partition: PartitionKey,
  directory: string,
): Effect.Effect<KvEngine, StoreError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => present(Effect.gen(function* () {
        if (directory !== ":memory:") mkdirSync(directory, { recursive: true });
        const db = (yield* integrationValue(openSqliteHandle(
          directory === ":memory:" ? ":memory:" : join(directory, `${partition}.sqlite`),
        )));
        return (yield* integrationValue(sqliteKvEngineOver(db)));
      })),
      catch: (cause) => new StoreError({ op: "node-sqlite.open", cause }),
    }),
    (engine) => Effect.orDie(engine.close),
  );

export const makeNodeSqliteStore = (
  shard: ShardId,
  directory: string,
  options?: OpenShardOptions,
): Effect.Effect<ShardStoreApi, StoreError, Scope.Scope> =>
  Effect.gen(function* () {
    const engine = yield* makeNodeSqliteEngine(shard, directory);
    return yield* openShardOverKv(shard, engine, options);
  });
