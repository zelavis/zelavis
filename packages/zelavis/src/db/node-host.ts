/// <reference types="node" />

import { present, integrationValue, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { makeDatabase, type DatabaseApi, type MakeDatabaseOptions } from "./database.js";
import type { StoreError } from "./errors.js";
import { makeLmdbStore } from "./engines/lmdb.js";
import { makeNodeSqliteStore } from "./engines/node-sqlite.js";
import { makeRocksdbJsStore } from "./engines/rocksdb-js.js";
import { imagesHost } from "./node-images.js";
import { backupsHost, databaseComponent, type BackupComponent } from "./node-backups.js";
import { runtimeApiFor, type DatabaseRuntimeApi, type StorageChoiceHost } from "./runtime-api.js";
import type { KvDurability } from "./kv.js";
import type { ShardStoreApi } from "./store.js";
import {
  DEFAULT_LOCAL_SHARDS,
  partitionMapFor,
  TOPOLOGY_SHARD,
  type PartitionMap,
  type ShardId,
} from "./topology.js";

export type EngineName = "sqlite" | "rocksdb" | "lmdb";

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
 * working as the data outgrows the machine.
 */
export interface EngineOptions {
  readonly name?: EngineName;
  /** What a returned commit survives; see `KvDurability`. `rocksdb` offers only `crash`. */
  readonly durability?: KvDurability;
}

export interface OpenNodeDatabaseOptions {
  /** Directory holding one store per shard. */
  readonly directory: string;
  readonly engine?: EngineOptions;
  /** Adopted only the first time an App opens; the stored map wins afterwards. */
  readonly shards?: ReadonlyArray<ShardId>;
  readonly virtualRanges?: number;
  readonly nodeId?: string;
  /** What scheduled backups capture besides the database: the host adds a Project's runtime store and media. */
  readonly backupComponents?: ReadonlyArray<BackupComponent>;
  /** How cross-Tenant indexes are kept current; see `MakeDatabaseOptions.crossTenantRefresh`. */
  readonly crossTenantRefresh?: MakeDatabaseOptions["crossTenantRefresh"];
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
): ((shard: ShardId, context: { readonly origin: string }) => Effect.Effect<ShardStoreApi, StoreError, Scope.Scope>) => {
  const durability = engine?.durability ?? "crash";
  switch (engine?.name ?? "sqlite") {
    case "rocksdb":
      return (shard, { origin }) => makeRocksdbJsStore(shard, directory, { origin, durability });
    case "lmdb":
      return (shard, { origin }) => makeLmdbStore(shard, directory, { origin, durability });
    case "sqlite":
      return (shard, { origin }) => makeNodeSqliteStore(shard, directory, { origin, durability });
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
export const openNodeDatabase = (
  options: OpenNodeDatabaseOptions,
): Promise<OpenNodeDatabase> => present(Effect.gen(function* (): Effect.fn.Return<OpenNodeDatabase, IntegrationFailure> {
  const engine = options.engine?.name ?? "sqlite";
  if (!["sqlite", "lmdb", "rocksdb"].includes(engine)) {
    throw new TypeError(`Unsupported storage engine "${engine}". Choose sqlite, lmdb or rocksdb.`);
  }
  if (options.engine && Object.keys(options.engine).some(key => key !== "name" && key !== "durability")) {
    throw new TypeError("Unknown storage engine option; this host accepts name and durability.");
  }
  // A Project's chosen durability, recorded beside its shards (`setStorage`); an explicit host option wins.
  const recorded = options.engine?.durability === undefined ? readStorageChoice(options.directory) : undefined;
  const durability = options.engine?.durability ?? recorded ?? "crash";
  if (durability !== "crash" && durability !== "power") {
    throw new TypeError(`Unsupported durability "${String(durability)}". Choose crash or power.`);
  }
  if (durability === "power" && engine === "rocksdb" && recorded === undefined) {
    throw new TypeError("The rocksdb engine cannot flush every commit; choose sqlite or lmdb for durability \"power\".");
  }
  // A recorded `power` on an engine that cannot keep it opens as `crash`, and health says so.
  const effectiveDurability: KvDurability = durability === "power" && engine === "rocksdb" ? "crash" : durability;
  const scope = (yield* integrationValue(Effect.runPromise(Scope.make())));
  const fallback = partitionMapFor(options.shards ?? DEFAULT_LOCAL_SHARDS, {
    ...(options.virtualRanges === undefined ? {} : { virtualRanges: options.virtualRanges }),
  });

  const database = (yield* integrationValue(Effect.runPromise(
    Scope.provide(
      makeDatabase({
        partitionMap: fallback,
        ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
        ...(options.crossTenantRefresh === undefined ? {} : { crossTenantRefresh: options.crossTenantRefresh }),
        openShard: openShardWith({ ...options.engine, durability: effectiveDurability }, options.directory),
      }),
      scope,
    ),
  )));

  // Beside the shards and the images, so a database moved with its directory takes its schedules along.
  const backups = (yield* integrationValue(Effect.runPromise(backupsHost({
    directory: join(options.directory, "..", "backups"),
    components: [databaseComponent(database, engine), ...(options.backupComponents ?? [])],
    scope,
  }))));
  return {
    database,
    api: runtimeApiFor(database, {
      backups,
      ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
      storage: { engine, durability: effectiveDurability },
      storageChoice: storageChoiceFor(options.directory, engine, effectiveDurability),
      // Beside the shards, so a database moved with its directory takes its images along.
      images: imagesHost(database, { directory: join(options.directory, "..", "images"), engine }),
    }),
    partitionMap: database.partitionMap,
    engine,
    close: () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))),
  };
}));

const STORAGE_CHOICE = "storage.json";
const storageChoiceFile = (directory: string) => join(directory, "..", STORAGE_CHOICE);

/** The durability a database recorded for itself, if it did. */
const readStorageChoice = (directory: string): KvDurability | undefined => {
  try {
    const value: unknown = JSON.parse(readFileSync(storageChoiceFile(directory), "utf8"));
    const durability = value !== null && typeof value === "object" ? (value as { durability?: unknown }).durability : undefined;
    return durability === "crash" || durability === "power" ? durability : undefined;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`The recorded storage choice at ${storageChoiceFile(directory)} is unreadable`, { cause });
  }
};

/** Reading and recording the durability this database opens with next. */
const storageChoiceFor = (directory: string, engine: EngineName, running: KvDurability): StorageChoiceHost => ({
  get: () => {
    const next = readStorageChoice(directory) ?? running;
    return { engine, durability: running, ...(next !== running ? { pending: next } : {}) };
  },
  set: (durability) => {
    if (durability !== "crash" && durability !== "power") throw new TypeError(`Durability is crash or power, not "${String(durability)}".`);
    if (durability === "power" && engine === "rocksdb") throw new TypeError("The rocksdb engine cannot flush every commit; this database can only use crash.");
    const file = storageChoiceFile(directory);
    const temporary = `${file}.${process.pid}`;
    writeFileSync(temporary, JSON.stringify({ durability }), { mode: 0o600 });
    renameSync(temporary, file);
    return { engine, durability: running, ...(durability !== running ? { pending: durability } : {}) };
  },
});

/** The file a SQLite-family shard occupies, for hosts that report storage. */
export const shardFilePath = (directory: string, shard: ShardId): string =>
  join(directory, `${shard}.sqlite`);

export { DEFAULT_LOCAL_SHARDS, TOPOLOGY_SHARD };
