import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { makeDatabase, TOPOLOGY_SHARD, type DatabaseApi } from "./database.js";
import type { StoreError } from "./errors.js";
import { makeLibsqlStore } from "./engines/libsql.js";
import { makeLmdbStore } from "./engines/lmdb.js";
import { makeNodeSqliteStore } from "./engines/node-sqlite.js";
import { makeRocksdbStore } from "./engines/rocksdb.js";
import type { PartitionKey } from "./model.js";
import { runtimeApiFor, type DatabaseRuntimeApi } from "./runtime-api.js";
import type { ObjectStoreApi } from "./store.js";
import {
  DEFAULT_LOCAL_SHARDS,
  partitionMapFor,
  type PartitionMap,
  type ShardId,
} from "./topology.js";

export type EngineName = "sqlite" | "libsql" | "rocksdb" | "lmdb";

/**
 * Which storage engine a database opens on.
 *
 * `sqlite` is the default because it is the only one that needs nothing
 * installed: it is Node's own SQLite, so a database opens on a fresh machine
 * with no native build. The others are optional peer dependencies and fail with
 * a message naming the package when they are asked for and absent.
 *
 * Which to choose is a question about the working set rather than about speed.
 * `lmdb` is the fastest engine while the data fits in memory and the slowest to
 * say so when it stops. `rocksdb` stores the same data in roughly a sixth of
 * the space and barely notices a cold cache, so it is the one that keeps
 * working as the data outgrows the machine. `libsql` exists for replicating
 * from a remote primary rather than for local performance.
 */
export interface EngineOptions {
  readonly name?: EngineName;
  /** libSQL only: a remote primary to replicate from, making this an embedded replica. */
  readonly syncUrl?: string;
  /** libSQL only. */
  readonly authToken?: string;
  /** libSQL only: seconds between background syncs. */
  readonly syncInterval?: number;
}

export interface OpenNodeDatabaseOptions {
  /** Directory holding one store per shard. */
  readonly directory: string;
  readonly engine?: EngineOptions;
  /** Adopted only the first time an App opens; the stored map wins afterwards. */
  readonly shards?: ReadonlyArray<ShardId>;
  readonly virtualRanges?: number;
  readonly nodeId?: string;
}

export interface OpenNodeDatabase {
  readonly database: DatabaseApi;
  /** The Promise-facing surface the HTTP runtime uses. */
  readonly api: DatabaseRuntimeApi;
  readonly partitionMap: PartitionMap;
  readonly engine: EngineName;
  /** Closes every shard. Registered with the host runtime's shutdown. */
  readonly close: () => Promise<void>;
}

const openShardWith = (
  engine: EngineOptions | undefined,
  directory: string,
): ((shard: PartitionKey) => Effect.Effect<ObjectStoreApi, StoreError, Scope.Scope>) => {
  switch (engine?.name ?? "sqlite") {
    case "libsql":
      return (shard) =>
        makeLibsqlStore(shard, {
          directory,
          ...(engine?.syncUrl === undefined ? {} : { syncUrl: engine.syncUrl }),
          ...(engine?.authToken === undefined ? {} : { authToken: engine.authToken }),
          ...(engine?.syncInterval === undefined ? {} : { syncInterval: engine.syncInterval }),
        });
    case "rocksdb":
      return (shard) => makeRocksdbStore(shard, directory);
    case "lmdb":
      return (shard) => makeLmdbStore(shard, directory);
    case "sqlite":
      return (shard) => makeNodeSqliteStore(shard, directory);
  }
};

/**
 * Open a database for a host that is not written in Effect.
 *
 * The shards are resources with a lifetime and the platform that owns them runs
 * on promises and a `close()` hook, so a scope is created explicitly here and
 * closed by that hook rather than wrapping the whole platform in a scoped
 * effect it has no way to express.
 */
export const openNodeDatabase = async (
  options: OpenNodeDatabaseOptions,
): Promise<OpenNodeDatabase> => {
  const engine = options.engine?.name ?? "sqlite";
  const scope = await Effect.runPromise(Scope.make());
  const fallback = partitionMapFor(options.shards ?? DEFAULT_LOCAL_SHARDS, {
    ...(options.virtualRanges === undefined ? {} : { virtualRanges: options.virtualRanges }),
  });

  const database = await Effect.runPromise(
    Scope.provide(
      makeDatabase({
        partitionMap: fallback,
        ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
        openShard: openShardWith(options.engine, options.directory),
      }),
      scope,
    ),
  );

  return {
    database,
    api: runtimeApiFor(database, {
      ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
    }),
    partitionMap: database.partitionMap,
    engine,
    close: () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))),
  };
};

/** The file a SQLite-family shard occupies, for hosts that report storage. */
export const shardFilePath = (directory: string, shard: ShardId): string =>
  join(directory, `${shard}.sqlite`);

export { DEFAULT_LOCAL_SHARDS, TOPOLOGY_SHARD };
