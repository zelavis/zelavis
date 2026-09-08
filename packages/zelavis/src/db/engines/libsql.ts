import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { StoreError } from "../errors.js";
import type { KvEngine } from "../kv.js";
import { claimGeneration, storeOverKv } from "../kv-store.js";
import { sqliteKvEngineOver, type SqliteHandle } from "./sqlite-kv.js";
import type { PartitionKey } from "../model.js";
import type { ObjectStoreApi } from "../store.js";
import { makeDatabase, TOPOLOGY_SHARD, type DatabaseApi } from "../database.js";
import { runtimeApiFor, type DatabaseRuntimeApi } from "../runtime-api.js";
import { partitionMapFor, type PartitionMap, type ShardId } from "../topology.js";
import { DEFAULT_LOCAL_SHARDS } from "../node-host.js";

/**
 * The subset of `libsql`'s Database this driver uses.
 *
 * Declared rather than imported as a type so the package stays an optional
 * peer: an installation that never asks for libSQL should not have to have it
 * present for `zelavis` to typecheck or run.
 */
interface LibsqlDatabase extends SqliteHandle {
  sync?: () => Promise<void>;
}

export interface LibsqlStoreOptions {
  /** Local file, or `:memory:`. Embedded replicas keep a local file too. */
  readonly directory: string;
  /**
   * A remote primary to replicate from.
   *
   * With this set the local file is an embedded replica: reads are local and
   * synchronous, which is what lets the shared store logic run unchanged.
   */
  readonly syncUrl?: string;
  readonly authToken?: string;
  /** Seconds between background syncs, when replicating. */
  readonly syncInterval?: number;
}

const toBindable = (value: unknown): unknown =>
  value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value;

const loadLibsql = Effect.tryPromise({
  try: async () => {
    const mod = (await import("libsql")) as unknown as {
      default: new (path: string, options?: Record<string, unknown>) => LibsqlDatabase;
    };
    return mod.default;
  },
  catch: (cause) =>
    new StoreError({
      op: "libsql.load",
      cause: new Error(
        "The libsql driver needs the optional `libsql` package installed. " +
          `Install it alongside zelavis to use this engine. Cause: ${String(cause)}`,
      ),
    }),
});

/**
 * A store on libSQL, over the same logic the built-in driver runs.
 *
 * Uses libSQL's synchronous binding rather than `@libsql/client`. The
 * asynchronous client would make every statement a promise, and a transaction
 * built from promises on one connection is one another caller can write inside.
 * The synchronous binding covers local files and embedded replicas; a
 * remote-only database needs that serialization designed first.
 */
export const makeLibsqlEngine = (
  partition: PartitionKey,
  options: LibsqlStoreOptions,
): Effect.Effect<KvEngine, StoreError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.flatMap(loadLibsql, (Database) =>
      Effect.try({
        try: () => {
          if (options.directory !== ":memory:") {
            mkdirSync(options.directory, { recursive: true });
          }
          const path =
            options.directory === ":memory:"
              ? ":memory:"
              : join(options.directory, `${partition}.sqlite`);
          const db = new Database(path, {
            ...(options.syncUrl === undefined ? {} : { syncUrl: options.syncUrl }),
            ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
            ...(options.syncInterval === undefined ? {} : { syncPeriod: options.syncInterval }),
          });
          // libSQL binds Buffers but not bare Uint8Arrays, where node:sqlite
          // takes either. The difference stays in the driver.
          return sqliteKvEngineOver({
            prepare: (sql: string) => {
              const statement = db.prepare(sql);
              return {
                get: (...params) => statement.get(...params.map(toBindable)),
                run: (...params) => statement.run(...params.map(toBindable)),
                iterate: (...params) => statement.iterate(...params.map(toBindable)),
              };
            },
            exec: (sql: string) => db.exec(sql),
            close: () => db.close(),
          // Hex keys: binding a Buffer to a SELECT panics inside this binding.
          }, "hex");
        },
        catch: (cause) => new StoreError({ op: "libsql.open", cause }),
      }),
    ),
    (engine) => Effect.orDie(engine.close),
  );

/**
 * A store on libSQL, over the same logic every engine runs.
 *
 * Uses libSQL's synchronous binding rather than `@libsql/client`, which covers
 * local files and embedded replicas. A remote-only database needs the
 * asynchronous client, which the key-value interface can now express.
 */
export const makeLibsqlStore = (
  partition: PartitionKey,
  options: LibsqlStoreOptions,
): Effect.Effect<ObjectStoreApi, StoreError, Scope.Scope> =>
  Effect.gen(function* () {
    const engine = yield* makeLibsqlEngine(partition, options);
    return storeOverKv(partition, engine, yield* claimGeneration(engine));
  });

export interface OpenLibsqlDatabaseOptions extends LibsqlStoreOptions {
  readonly shards?: ReadonlyArray<ShardId>;
  readonly virtualRanges?: number;
  readonly nodeId?: string;
}

export interface OpenLibsqlDatabase {
  readonly database: DatabaseApi;
  readonly api: DatabaseRuntimeApi;
  readonly partitionMap: PartitionMap;
  readonly close: () => Promise<void>;
}

/** The libSQL counterpart of `openNodeDatabase`, with the same lifetime rules. */
export const makeLibsqlDatabase = Effect.fn("makeLibsqlDatabase")(function* (
  options: OpenLibsqlDatabaseOptions,
) {
  const fallback = partitionMapFor(options.shards ?? DEFAULT_LOCAL_SHARDS, {
    ...(options.virtualRanges === undefined ? {} : { virtualRanges: options.virtualRanges }),
  });
  return yield* makeDatabase({
    partitionMap: fallback,
    ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
    openShard: (shard) => makeLibsqlStore(shard, options),
  });
});

/**
 * The libSQL counterpart of `openNodeDatabase`.
 *
 * Same lifetime rules: the scope is created here and closed by the host's
 * shutdown hook, because the platform holds databases through `close()` rather
 * than from inside a scoped effect.
 */
export const openLibsqlDatabase = async (
  options: OpenLibsqlDatabaseOptions,
): Promise<OpenLibsqlDatabase> => {
  const scope = await Effect.runPromise(Scope.make());
  const database = await Effect.runPromise(
    Scope.provide(makeLibsqlDatabase(options), scope),
  );
  return {
    database,
    api: runtimeApiFor(database, {
      ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
    }),
    partitionMap: database.partitionMap,
    close: () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))),
  };
};

export { TOPOLOGY_SHARD };
