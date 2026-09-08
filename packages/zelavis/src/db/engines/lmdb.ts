import { Effect, Stream, type Scope } from "effect";
import { StoreError } from "../errors.js";
import { prefixEnd } from "../keys.js";
import type { KvEngine, KvEntry, KvWrite } from "../kv.js";
import { claimGeneration, storeOverKv } from "../kv-store.js";
import type { PartitionKey } from "../model.js";
import type { ObjectStoreApi } from "../store.js";

/**
 * The slice of the `lmdb` package this engine uses.
 *
 * Declared rather than imported as a type so the package stays an optional
 * peer: an installation that never asks for LMDB should not need it present for
 * `zelavis` to typecheck or run.
 */
interface LmdbDatabase {
  get(key: Uint8Array): Uint8Array | undefined;
  put(key: Uint8Array, value: Uint8Array): unknown;
  remove(key: Uint8Array): unknown;
  transaction<A>(run: () => A): Promise<A>;
  getRange(options: {
    start?: Uint8Array;
    end?: Uint8Array;
  }): Iterable<{ key: Uint8Array; value: Uint8Array }>;
  close(): Promise<void>;
}

const loadLmdb = Effect.tryPromise({
  try: async () => {
    const specifier = "lmdb";
    const mod = (await import(specifier)) as {
      open: (options: Record<string, unknown>) => LmdbDatabase;
    };
    return mod.open;
  },
  catch: (cause) =>
    new StoreError({
      op: "lmdb.load",
      cause: new Error(
        "The LMDB engine needs the optional `lmdb` package installed. " +
          `Install it alongside zelavis to use this engine. Cause: ${String(cause)}`,
      ),
    }),
});

/**
 * LMDB as an ordered key-value engine.
 *
 * A memory-mapped B+tree rather than an LSM tree or a SQL b-tree, which makes
 * it the read-side counterweight: a read is a pointer into a mapped page, so it
 * is synchronous and copies nothing. It writes through a single writer, so a
 * transaction is genuinely serialized by the engine rather than by convention.
 *
 * Its default comparator is bytewise, which is what the key encoding already
 * assumes; the conformance suite is what confirms that rather than the docs.
 */
export const makeLmdbEngine = (
  partition: PartitionKey,
  directory: string,
): Effect.Effect<KvEngine, StoreError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.flatMap(loadLmdb, (open) =>
      Effect.try({
        try: () =>
          open({
            path: `${directory}/${partition}`,
            keyEncoding: "binary",
            encoding: "binary",
          }),
        catch: (cause) => new StoreError({ op: "lmdb.open", cause }),
      }),
    ),
    (db) => Effect.orDie(Effect.promise(() => db.close())),
  ).pipe(
    Effect.map((db): KvEngine => {
      const fail = (op: string) => (cause: unknown) => new StoreError({ op, cause });

      return {
        // Synchronous, and the only engine here that can be: the value is a
        // pointer into a mapped page rather than a row to decode.
        get: (key) =>
          Effect.try({ try: () => db.get(key), catch: fail("lmdb.get") }),

        scan: (prefix) =>
          Stream.fromIterableEffect(
            Effect.try({
              try: () => {
                const end = prefixEnd(prefix);
                const range = db.getRange(
                  end === undefined ? { start: prefix } : { start: prefix, end },
                );
                return (function* (): Generator<KvEntry> {
                  for (const entry of range) yield { key: entry.key, value: entry.value };
                })();
              },
              catch: fail("lmdb.scan"),
            }),
          ),

        write: (writes: ReadonlyArray<KvWrite>) =>
          Effect.tryPromise({
            try: () =>
              // One LMDB transaction per batch. The single-writer design means
              // nothing else is inside it, which is the atomicity the store
              // depends on rather than a property it has to arrange.
              db.transaction(() => {
                for (const write of writes) {
                  if (write.op === "put") db.put(write.key, write.value);
                  else db.remove(write.key);
                }
              }),
            catch: fail("lmdb.write"),
          }).pipe(Effect.asVoid),

        close: Effect.orDie(Effect.promise(() => db.close())),
      };
    }),
  );

export const makeLmdbStore = (
  partition: PartitionKey,
  directory: string,
): Effect.Effect<ObjectStoreApi, StoreError, Scope.Scope> =>
  Effect.gen(function* () {
    const engine = yield* makeLmdbEngine(partition, directory);
    return storeOverKv(partition, engine, yield* claimGeneration(engine));
  });
