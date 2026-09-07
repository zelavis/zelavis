import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { makeDatabase, TOPOLOGY_SHARD, type DatabaseApi } from "../database.js";
import { runtimeApiFor, type DatabaseRuntimeApi } from "../runtime-api.js";
import { partitionMapFor, type PartitionMap, type ShardId } from "../topology.js";
import { makeNodeSqliteStore } from "./node-sqlite.js";

/** Matches the physical shard count the official local App topology uses. */
export const DEFAULT_LOCAL_SHARDS: ReadonlyArray<ShardId> = Object.freeze([
  "shard-0",
  "shard-1",
  "shard-2",
  "shard-3",
]);

export interface OpenNodeDatabaseOptions {
  /** Directory holding one SQLite file per shard. */
  readonly directory: string;
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
  /** Closes every shard. Registered with the host runtime's shutdown. */
  readonly close: () => Promise<void>;
}

/**
 * Open a database for a host that is not written in Effect.
 *
 * The shards are resources with a lifetime, and the platform that owns them
 * runs on promises and a `close()` hook. So a scope is created explicitly here
 * and closed by that hook, rather than wrapping the whole platform in a scoped
 * effect it has no way to express.
 */
export const openNodeDatabase = async (
  options: OpenNodeDatabaseOptions,
): Promise<OpenNodeDatabase> => {
  const scope = await Effect.runPromise(Scope.make());
  const fallback = partitionMapFor(options.shards ?? DEFAULT_LOCAL_SHARDS, {
    ...(options.virtualRanges === undefined ? {} : { virtualRanges: options.virtualRanges }),
  });

  const database = await Effect.runPromise(
    Scope.provide(
      makeDatabase({
        partitionMap: fallback,
        ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
        openShard: (shard) => makeNodeSqliteStore(shard, options.directory),
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
    close: () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))),
  };
};

/** The file a shard occupies, for hosts that report or back up storage. */
export const shardFilePath = (directory: string, shard: ShardId): string =>
  join(directory, `${shard}.sqlite`);

export { TOPOLOGY_SHARD };
