import { present, integrationValue, type IntegrationFailure } from "../../core/runtime/effect-boundary.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, type Scope } from "effect";
import { StoreError } from "../errors.js";
import type { KvDurability, KvEngine } from "../kv.js";
import { openShardOverKv, type OpenShardOptions } from "../kv-store.js";
import type { PartitionKey } from "../model.js";
import type { ShardStoreApi } from "../store.js";
import type { ShardId } from "../topology.js";
import { sqliteKvEngineOver, type SqliteHandle } from "./sqlite-kv.js";

/**
 * The host's own SQLite binding, as an opener of files.
 *
 * Node provides `node:sqlite`; Bun provides `bun:sqlite` instead and has no
 * `node:sqlite`. Both read and write the same file format, so the store above
 * is unchanged: only the handle differs. Loaded lazily, by specifier, because
 * a static import of the other host's module fails to resolve on load.
 */
export const loadSqliteOpener = (): Promise<(file: string, readOnly: boolean) => SqliteHandle> => present(Effect.gen(function* (): Effect.fn.Return<(file: string, readOnly: boolean) => SqliteHandle, IntegrationFailure> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const specifier = "bun:sqlite";
    const { Database } = ((yield* integrationValue(import(specifier)))) as {
      Database: new (file: string, options?: { readonly?: boolean }) => {
        prepare(sql: string): {
          get(...params: ReadonlyArray<unknown>): unknown;
          run(...params: ReadonlyArray<unknown>): unknown;
          iterate(...params: ReadonlyArray<unknown>): Iterable<unknown>;
        };
        run(sql: string): unknown;
        close(): void;
      };
    };
    return (file, readOnly) => {
      const db = new Database(file, readOnly ? { readonly: true } : undefined);
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
    };
  }
  const { DatabaseSync } = (yield* integrationValue(import("node:sqlite")));
  return (file, readOnly) => new DatabaseSync(file, { readOnly });
}));

/**
 * The default engine: the host's own SQLite, so nothing has to be installed.
 *
 * Always a file: a snapshot reads through a second connection to it, which an
 * in-memory database cannot offer. For nothing on disk, use the memory engine.
 */
export const makeNodeSqliteEngine = (
  partition: PartitionKey,
  directory: string,
  durability: KvDurability = "crash",
): Effect.Effect<KvEngine, StoreError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => present(Effect.gen(function* () {
        if (directory === ":memory:") {
          throw new Error("a SQLite engine needs a directory for its file; the memory engine keeps nothing on disk");
        }
        mkdirSync(directory, { recursive: true });
        const open = (yield* integrationValue(loadSqliteOpener()));
        const file = join(directory, `${partition}.sqlite`);
        return sqliteKvEngineOver(open(file, false), { openReader: () => open(file, true), durability });
      })),
      catch: (cause) => new StoreError({ op: "node-sqlite.open", cause }),
    }),
    (engine) => Effect.orDie(engine.close),
  );

export const makeNodeSqliteStore = (
  shard: ShardId,
  directory: string,
  options?: OpenShardOptions & { readonly durability?: KvDurability },
): Effect.Effect<ShardStoreApi, StoreError, Scope.Scope> =>
  Effect.gen(function* () {
    const engine = yield* makeNodeSqliteEngine(shard, directory, options?.durability);
    return yield* openShardOverKv(shard, engine, options);
  });
