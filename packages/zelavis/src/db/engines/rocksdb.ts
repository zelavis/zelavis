import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Stream, type Scope } from "effect";
import { StoreError } from "../errors.js";
import { scanRange, type KvEngine, type KvEntry, type KvWrite } from "../kv.js";
import { claimGeneration, storeOverKv } from "../kv-store.js";
import type { PartitionKey } from "../model.js";
import type { ObjectStoreApi } from "../store.js";

/**
 * The slice of the `rocksdb` binding this engine uses.
 *
 * Declared rather than imported as a type so the package stays an optional
 * peer: an installation that never asks for RocksDB should not need it present
 * for `zelavis` to typecheck or run.
 */
interface RocksIterator {
  next(callback: (error: Error | undefined, key?: Uint8Array, value?: Uint8Array) => void): void;
  end(callback: (error?: Error) => void): void;
}

interface RocksDatabase {
  open(options: Record<string, unknown>, callback: (error?: Error) => void): void;
  close(callback: (error?: Error) => void): void;
  get(
    key: Uint8Array,
    options: { asBuffer: boolean },
    callback: (error: (Error & { notFound?: boolean }) | undefined, value?: Uint8Array) => void,
  ): void;
  batch(
    operations: ReadonlyArray<{ type: "put" | "del"; key: Uint8Array; value?: Uint8Array }>,
    callback: (error?: Error) => void,
  ): void;
  iterator(options: Record<string, unknown>): RocksIterator;
}

const promisify = <A>(run: (done: (error: Error | undefined, value?: A) => void) => void) =>
  new Promise<A | undefined>((resolve, reject) => {
    run((error, value) => (error ? reject(error) : resolve(value)));
  });

const loadRocksdb = Effect.tryPromise({
  try: async () => {
    // Imported by specifier rather than typed, because the package ships no
    // declarations and adding one would assert a shape this file already
    // describes in the interfaces above.
    const specifier = "rocksdb";
    const mod = (await import(specifier)) as {
      default: (location: string) => RocksDatabase;
    };
    return mod.default;
  },
  catch: (cause) =>
    new StoreError({
      op: "rocksdb.load",
      cause: new Error(
        "The RocksDB engine needs the optional `rocksdb` package installed. " +
          `Install it alongside zelavis to use this engine. Cause: ${String(cause)}`,
      ),
    }),
});

/**
 * RocksDB as an ordered key-value engine.
 *
 * This is the engine the lens design was originally drawn for, and it needs no
 * accommodation above it: `get`, a bounded iterator, and an atomic write batch
 * are exactly the interface. It is also the first asynchronous engine, which is
 * only safe because a transaction here is one batch rather than an open window
 * another caller could write into.
 *
 * The binding exposes a single keyspace and no column families. That costs
 * nothing: the key tags already give each lens a disjoint range, which is what
 * column families would have provided.
 */
export const makeRocksdbEngine = (
  partition: PartitionKey,
  directory: string,
): Effect.Effect<KvEngine, StoreError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.flatMap(loadRocksdb, (open) =>
      Effect.tryPromise({
        try: async () => {
          mkdirSync(directory, { recursive: true });
          const db = open(join(directory, partition));
          // Only the block cache is raised. Larger blocks were tried and made
          // everything slower: a posting is a key with an empty value, so a
          // bigger block means decompressing more bytes to read nothing, and
          // point reads suffered worst. The cache is what keeps a repeated scan
          // off disk and costs nothing per read. The binding exposes no
          // memtable size, so the write path stays where it is.
          await promisify<void>((done) =>
            db.open(
              {
                createIfMissing: true,
                cacheSize: 64 * 1024 * 1024,
                maxOpenFiles: 1000,
              },
              (error) => done(error),
            ),
          );
          return db;
        },
        catch: (cause) => new StoreError({ op: "rocksdb.open", cause }),
      }),
    ),
    (db) =>
      Effect.orDie(
        Effect.promise(() => promisify<void>((done) => db.close((error) => done(error)))),
      ),
  ).pipe(
    Effect.map((db): KvEngine => {
      const fail = (op: string) => (cause: unknown) => new StoreError({ op, cause });

      // The binding stringifies anything that is not a Buffer, so a plain
      // Uint8Array key arrives as the text of its digits. Everything crossing
      // into it is converted here rather than at each call site.
      const buf = (bytes: Uint8Array) =>
        Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

      return {
        get: (key) =>
          Effect.tryPromise({
            try: () =>
              new Promise<Uint8Array | undefined>((resolve, reject) => {
                db.get(buf(key), { asBuffer: true }, (error, value) => {
                  // A missing key is an error in this binding, not an empty
                  // result, so it is translated back into one here.
                  if (error) {
                    if (error.notFound || /notfound/i.test(error.message)) resolve(undefined);
                    else reject(error);
                    return;
                  }
                  resolve(value);
                });
              }),
            catch: fail("rocksdb.get"),
          }),

        scan: (prefix, options) =>
          Stream.fromAsyncIterable(
            (async function* (): AsyncGenerator<KvEntry> {
              const { lo, hi, empty } = scanRange(prefix, options);
              if (empty) return;
              const iterator = db.iterator({
                gte: buf(lo),
                ...(hi === undefined ? {} : { lt: buf(hi) }),
                // This binding keeps `gte` and `lt` as the bounds in either
                // direction; `reverse` only changes the way it walks them.
                reverse: options?.reverse === true,
                keyAsBuffer: true,
                valueAsBuffer: true,
                // A modest prefetch. Four megabytes was tried and cost more in
                // buffering than it saved in boundary crossings.
                highWaterMark: 256 * 1024,
                fillCache: true,
              });
              try {
                for (;;) {
                  const entry = await new Promise<KvEntry | undefined>((resolve, reject) => {
                    iterator.next((error, key, value) => {
                      if (error) reject(error);
                      else if (key === undefined) resolve(undefined);
                      else resolve({ key, value: value ?? new Uint8Array(0) });
                    });
                  });
                  if (entry === undefined) break;
                  yield entry;
                }
              } finally {
                // Released whether the scan finished or the consumer stopped
                // early; an iterator left open pins a RocksDB snapshot.
                await promisify<void>((done) => iterator.end((error) => done(error)));
              }
            })(),
            (cause) => new StoreError({ op: "rocksdb.scan", cause }),
          ),

        write: (writes: ReadonlyArray<KvWrite>) =>
          Effect.tryPromise({
            try: () =>
              promisify<void>((done) =>
                db.batch(
                  writes.map((write) =>
                    write.op === "put"
                      ? { type: "put" as const, key: buf(write.key), value: buf(write.value) }
                      : { type: "del" as const, key: buf(write.key) },
                  ),
                  (error) => done(error),
                ),
              ),
            catch: fail("rocksdb.write"),
          }).pipe(Effect.asVoid),

        close: Effect.orDie(
          Effect.promise(() => promisify<void>((done) => db.close((error) => done(error)))),
        ),
      };
    }),
  );

export const makeRocksdbStore = (
  partition: PartitionKey,
  directory: string,
): Effect.Effect<ObjectStoreApi, StoreError, Scope.Scope> =>
  Effect.gen(function* () {
    const engine = yield* makeRocksdbEngine(partition, directory);
    return storeOverKv(partition, engine, yield* claimGeneration(engine));
  });
