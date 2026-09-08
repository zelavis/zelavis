import { Effect, type Scope } from "effect";
import { claimGeneration, storeOverKv } from "../kv-store.js";
import type { StoreError } from "../errors.js";
import type { PartitionKey } from "../model.js";
import type { ObjectStoreApi } from "../store.js";
import { makeSqliteKvEngine } from "./sqlite-kv.js";
import { memoryKvEngine } from "./memory-kv.js";

/**
 * A store on the key-value path, backed by SQLite.
 *
 * The engine is a detail here: the same call over a RocksDB or LevelDB engine
 * produces the same store, because the logic above it only knows about ordered
 * keys and atomic batches.
 */
export const makeKvStore = (
  partition: PartitionKey,
  directory: string,
): Effect.Effect<ObjectStoreApi, StoreError, Scope.Scope> =>
  Effect.gen(function* () {
    const engine = yield* makeSqliteKvEngine(partition, directory);
    return storeOverKv(partition, engine, yield* claimGeneration(engine));
  });

/** The same store with nothing on disk, for tests and ephemeral workloads. */
export const makeMemoryStore = (
  partition: PartitionKey,
): Effect.Effect<ObjectStoreApi, StoreError> =>
  Effect.gen(function* () {
    const engine = memoryKvEngine();
    return storeOverKv(partition, engine, yield* claimGeneration(engine));
  });
