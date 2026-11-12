/// <reference types="node" />

import type { LeaseStore } from "./writer-lease.js";
import type { DatabaseLeaseStandby, DatabaseLeaseStart } from "./database.js";
import { present, integrationValue, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Duration, Effect, Exit, Scope } from "effect";
import { arrayOf, isString, objectFields, parseJson } from "../core/json-validation.js";
import { makeRemoteKvEngine, remoteShardAccess } from "./engines/remote-kv.js";
import { makeRemoteTenantReads } from "./engines/remote-reads.js";
import type { RemoteTenantReads } from "./tenant-reads.js";
import { openShardOverKv } from "./kv-store.js";
import { httpShardChannel, type ShardChannel } from "./shard-authority-http.js";
import type { ShardPlacementHost, ShardReplicaLocation } from "./shard-placement.js";
import { makeDatabase, type DatabaseApi, type MakeDatabaseOptions } from "./database.js";
import { StoreError } from "./errors.js";
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
  GLOBAL_SHARD,
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
  /** Where writer leases are kept, so the runtime API can show, take over and give up a partition's lease (`followers.lease|promote|demote`). */
  readonly leases?: LeaseStore;
  /**
   * Take the Project's whole-database writer lease before the database is handed out, and refuse to open when it cannot
   * be taken: a node told to start a Project whose lease another live writer holds does not serve it. Held until the
   * database closes, which releases it (see `startWriter`).
   */
  readonly lease?: NodeDatabaseLease;
  /**
   * How this host reaches the Platform for the Project's shards on other Nodes (the Project channel). Without it a
   * shard listed in `shard-locations.json` cannot be opened, and placing shards is unavailable.
   */
  readonly appShards?: { readonly apiRoot: string; readonly token: string; readonly projectId: string };
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

type ShardOpener = (shard: ShardId, context: { readonly origin: string }) => Effect.Effect<ShardStoreApi, StoreError, Scope.Scope>;

const openLocalShardWith = (
  engine: EngineOptions | undefined,
  directory: string,
): ShardOpener => {
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

/** How long opening a shard on another Node may take before the open fails naming the shard. */
const REMOTE_OPEN_TIMEOUT = Duration.seconds(30);

/**
 * Opens a shard where `shard-locations.json` says it lives. A listed shard is only ever opened through the Project
 * channel as a remote key-value engine, never as a new local one: with no channel it fails, naming the shard.
 */
const openShardWith = (
  engine: EngineOptions | undefined,
  directory: string,
  channel: ShardChannel | undefined,
  readers: Map<ShardId, RemoteTenantReads>,
): ShardOpener => {
  const local = openLocalShardWith(engine, directory);
  return (shard, context) => {
    if (shard === TOPOLOGY_SHARD || shard === GLOBAL_SHARD) return local(shard, context);
    return Effect.gen(function* () {
      const listed = yield* Effect.try({
        try: () => readShardLocations(directory),
        catch: (cause) => new StoreError({ op: "shard.open", cause: cause instanceof Error ? cause.message : String(cause) }),
      });
      if (!listed.remote.includes(shard)) return yield* local(shard, context);
      return yield* openRemoteShard(shard, context.origin, channel, readers);
    });
  };
};

const openRemoteShard = (
  shard: ShardId,
  origin: string,
  channel: ShardChannel | undefined,
  readers?: Map<ShardId, RemoteTenantReads>,
) => Effect.gen(function* () {
  if (channel === undefined) {
    return yield* new StoreError({ op: "shard.open", cause: `Shard ${shard} is on another Node, and this host has no shard channel.` });
  }
  const first = yield* channel.access(shard);
  let primed: typeof first | undefined = first;
  const access = yield* remoteShardAccess(Effect.suspend(() => {
    const next = primed;
    primed = undefined;
    return next === undefined ? channel.access(shard) : Effect.succeed(next);
  }));
  const kv = yield* makeRemoteKvEngine({ destination: first.destination, access });
  const opened = yield* openShardOverKv(shard, kv, { origin });
  if (readers !== undefined) {
    const reader = yield* makeRemoteTenantReads({ destination: first.destination, access, shardId: shard });
    readers.set(shard, reader);
    yield* Effect.addFinalizer(() => Effect.sync(() => { if (readers.get(shard) === reader) readers.delete(shard); }));
  }
  return opened;
}).pipe(Effect.timeoutOrElse({
  duration: REMOTE_OPEN_TIMEOUT,
  orElse: () => Effect.fail(new StoreError({ op: "shard.open", cause: `Shard ${shard} on another Node did not open within 30 seconds.` })),
}), Effect.mapError((failure) => new StoreError({ op: "shard.open", cause: `Shard ${shard}: ${String(failure.cause)}` })));

/**
 * Open a database for a host that is not written in Effect.
 *
 * The shards are resources with a lifetime and the platform that owns them runs
 * on promises and a `close()` hook, so a scope is created explicitly here and
 * closed by that hook rather than wrapping the whole platform in a scoped
 * effect it has no way to express.
 */
/**
 * How a database takes its whole-database lease. A `writer` takes it now or opens nothing. A `standby` opens as a copy:
 * it follows its writer, and the database is handed out only once the standby holds the lease, because the lease lapsed
 * or was released and this copy held what the writer's followers acknowledged (`standbyDatabase`).
 */
export type NodeDatabaseLease =
  | (DatabaseLeaseStart & { readonly role: "writer" })
  | (DatabaseLeaseStandby & {
    readonly role: "standby";
    /** Ends the wait for promotion: the open is interrupted, its scope closed and nothing is handed out. */
    readonly signal?: AbortSignal;
  });

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
  if (options.lease !== undefined) {
    const locations = readShardLocations(options.directory);
    if (locations.remote.length > 0 || locations.replicas.length > 0) {
      throw new TypeError("A lease-guarded Project cannot hold shards on other Nodes.");
    }
  }
  const locations = Effect.try({
    try: () => readShardLocations(options.directory),
    catch: locationError,
  });
  const updateLocations = (change: (current: ShardLocations) => ShardLocations) => Effect.try({
    try: () => writeShardLocations(options.directory, change(readShardLocations(options.directory))),
    catch: locationError,
  });
  const channel = options.appShards === undefined ? undefined : httpShardChannel(options.appShards);
  const shardPlacement: ShardPlacementHost | undefined = channel === undefined ? undefined : {
    list: channel.list,
    request: (input) => channel.request({ ...input, durability: effectiveDurability }),
    activate: channel.activate,
    release: channel.release,
    remote: Effect.map(locations, (current) => current.remote),
    markRemote: (shard) => updateLocations((current) => ({ ...current, remote: [...current.remote, shard] })),
    forgetRemote: (shard) => updateLocations((current) => ({ ...current, remote: current.remote.filter((name) => name !== shard) })),
    replicas: Effect.map(locations, (current) => current.replicas),
    markReplica: (of, shard) => updateLocations((current) => ({
      ...current, replicas: [...current.replicas.filter((entry) => entry.of !== of), { of, shard }],
    })),
    forgetReplica: (of) => updateLocations((current) => ({
      ...current, replicas: current.replicas.filter((entry) => entry.of !== of),
    })),
  };
  const readers = new Map<ShardId, RemoteTenantReads>();
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
        openShard: openShardWith({ ...options.engine, durability: effectiveDurability }, options.directory, channel, readers),
        openReplica: (shard) => openRemoteShard(shard, options.nodeId ?? "local", channel),
        remoteReads: (shard) => readers.get(shard),
        ...(shardPlacement === undefined ? {} : { shardPlacement }),
      }),
      scope,
    ),
  )));

  // The lease is taken before anything is handed out: a node that cannot hold it opens nothing, and the scope it was
  // held in closes with the database (or at once, when taking it fails).
  if (options.lease !== undefined) {
    const lease = options.lease;
    const taking: Effect.Effect<void, unknown, Scope.Scope> = lease.role === "standby"
      ? Effect.asVoid(database.writerLeases.standbyDatabase(lease))
      : Effect.asVoid(database.writerLeases.startDatabase(lease));
    yield* integrationValue(Effect.runPromise(
      Scope.provide(taking, scope).pipe(
        // Failing, or interrupted by the signal of a standby that is told to stop waiting: either way nothing was handed out.
        Effect.onExit((exit) => exit._tag === "Success" ? Effect.void : Scope.close(scope, Exit.succeed(undefined))),
      ),
      lease.role === "standby" && lease.signal !== undefined ? { signal: lease.signal } : undefined,
    ));
  }

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
      ...(options.leases === undefined ? {} : { leases: options.leases }),
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

const SHARD_LOCATIONS = "shard-locations.json";
const shardLocationsFile = (directory: string) => join(directory, "..", SHARD_LOCATIONS);

interface ShardLocations {
  readonly remote: ReadonlyArray<ShardId>;
  readonly replicas: ReadonlyArray<ShardReplicaLocation>;
}

const locationError = (cause: unknown) =>
  new StoreError({ op: "shard.locations", cause: cause instanceof Error ? cause.message : String(cause) });

const isShardLocations = objectFields<ShardLocations>({
  remote: arrayOf(isString),
  replicas: arrayOf(objectFields<ShardReplicaLocation>({ of: isString, shard: isString })),
});

/** The shards and replicas that live on other Nodes. */
export const readShardLocations = (directory: string): ShardLocations => {
  const file = shardLocationsFile(directory);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { remote: [], replicas: [] };
    throw new Error(`The shard locations at ${file} are unreadable`, { cause });
  }
  try {
    return parseJson(text, isShardLocations, "shard locations");
  } catch (cause) {
    throw new Error(`The shard locations at ${file} are malformed`, { cause });
  }
};

/** Records which shards live on other Nodes, with a temporary file and a rename so a crash leaves one whole file. */
export const writeShardLocations = (directory: string, locations: ShardLocations): void => {
  const file = shardLocationsFile(directory);
  const temporary = `${file}.${process.pid}`;
  writeFileSync(temporary, JSON.stringify({ remote: [...new Set(locations.remote)].sort(), replicas: locations.replicas }), { mode: 0o600 });
  renameSync(temporary, file);
};

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
