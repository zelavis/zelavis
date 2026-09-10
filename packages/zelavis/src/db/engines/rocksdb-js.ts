import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Array as Arr, Effect, Stream, type Scope } from "effect";
import { StoreError } from "../errors.js";
import { prefixEnd } from "../keys.js";
import type { KvEngine, KvEntry, KvWrite } from "../kv.js";
import { claimGeneration, storeOverKv } from "../kv-store.js";
import type { PartitionKey } from "../model.js";
import type { ObjectStoreApi } from "../store.js";

/**
 * RocksDB through `@harperfast/rocksdb-js`, under evaluation.
 *
 * The engine this replaces runs on the `rocksdb` package, which npm now marks
 * Discontinued. That is not a label problem: it ships no prebuilt binary for
 * the Node this repository runs, so it compiles from source, and its bundled
 * C++ no longer builds against a current Linux toolchain. The build is denied
 * in `pnpm-workspace.yaml` and the engine skips itself on CI as a result, which
 * is a supported engine in name only.
 *
 * This binding ships prebuilt binaries for eight platforms as optional
 * dependencies, so it installs without a compiler on the hosts that matter.
 *
 * Two of its defaults have to be overridden rather than inherited. Keys default
 * to `ordered-binary` and values to MessagePack, both of which would re-encode
 * bytes this store has already encoded — and this store's correctness rests on
 * its own byte order, not on another library's idea of one. `binary` for both
 * hands the bytes through untouched, which `db-rocksdb-js.test.mjs` checks
 * against the exact shapes `keys.ts` produces: escaped `0x00` and `0x01`, shared
 * prefixes, high bytes, and the empty value a posting is.
 *
 * What a commit promises is RocksDB's default, stated rather than hidden: the
 * write-ahead log is written but not fsynced per commit. A process that dies
 * loses nothing, because the log is in the operating system's page cache; a
 * machine that loses power can lose a suffix of recent commits, never leave a
 * hole. `db-durability.test.mjs` checks both, the second by cutting the log.
 *
 * One gap is known and not closable here. The binding ends a range scan quietly
 * when RocksDB's iterator fails — a checksum mismatch in a block reads as the end
 * of the data, where a point read of the same block throws. The discontinued
 * binding threw. Until the binding reports iterator status, a scan over a
 * corrupted file returns a prefix and no error (HarperFast/rocksdb-js#846).
 */

/** The shape used here, declared rather than imported so the package stays optional. */
interface RocksdbJsDatabase {
  open: () => boolean;
  close: () => void;
  get: (key: Buffer) => Promise<Buffer | undefined>;
  getRange: (options: {
    start?: Buffer;
    end?: Buffer;
  }) => Iterable<{ key: Buffer; value: Buffer }>;
  transaction: <A>(run: (txn: RocksdbJsTransaction) => A) => Promise<A | void>;
}

interface RocksdbJsTransaction {
  putSync: (key: Buffer, value: Buffer) => void;
  removeSync: (key: Buffer) => void;
}

const loadRocksdbJs = Effect.tryPromise({
  try: async () =>
    (await import("@harperfast/rocksdb-js")) as unknown as {
      RocksDatabase: new (
        path: string,
        options: Record<string, unknown>,
      ) => RocksdbJsDatabase;
      /** The binding's version and the RocksDB it was built against. */
      versions: Readonly<Record<string, string>>;
    },
  catch: (cause) => new StoreError({ op: "rocksdb-js.load", cause }),
});

/**
 * How this engine lays data out, written beside the data and checked on open.
 *
 * RocksDB will open any RocksDB directory, and nothing in one says how its keys
 * and values were encoded. Opened with the wrong encodings, every key reads as
 * something else and every write lands where no read will find it — silently,
 * because both sides are valid RocksDB. So the directory carries this, and an
 * open refuses one that says otherwise, or says nothing at all.
 *
 * `format` changes when this engine changes what it stores, not when the
 * binding or RocksDB does: those are recorded as `createdWith` for diagnosis,
 * and RocksDB itself refuses files it cannot read.
 */
const FORMAT = {
  engine: "rocksdb-js",
  format: 1,
  keyEncoding: "binary",
  encoding: "binary",
} as const;

export const FORMAT_FILE = "ZELAVIS-FORMAT.json";

const claimFormat = (path: string, versions: Readonly<Record<string, string>>): void => {
  const marker = join(path, FORMAT_FILE);
  const expected = Object.keys(FORMAT) as Array<keyof typeof FORMAT>;
  if (existsSync(marker)) {
    const found = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
    if (expected.some((field) => found[field] !== FORMAT[field])) {
      const described = Object.fromEntries(expected.map((field) => [field, found[field]]));
      throw new Error(
        `${path} was written as ${JSON.stringify(described)}, and this engine reads ` +
          `${JSON.stringify(FORMAT)}. It was not opened, because reading it as the ` +
          "wrong format would misread every key rather than fail.",
      );
    }
    return;
  }
  if (existsSync(join(path, "CURRENT"))) {
    throw new Error(
      `${path} holds a RocksDB database with no ${FORMAT_FILE}, so nothing records how ` +
        "its keys and values were encoded, and it was not opened. A directory written " +
        "by Zelavis's earlier `rocksdb` engine stores the same raw bytes and reads " +
        `correctly; adopting one is writing ${FORMAT_FILE} into it deliberately.`,
    );
  }
  mkdirSync(path, { recursive: true });
  // Renamed into place, so a crash leaves either no marker or a whole one.
  const temporary = `${marker}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...FORMAT, createdWith: versions }, null, 2)}\n`, {
    flush: true,
  });
  renameSync(temporary, marker);
};

/** Entries per step of a scan; see `scan`. */
const SCAN_BATCH = 1024;

const buf = (bytes: Uint8Array) =>
  Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

export const makeRocksdbJsEngine = (
  partition: PartitionKey,
  directory: string,
): Effect.Effect<KvEngine, StoreError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.flatMap(loadRocksdbJs, ({ RocksDatabase, versions }) =>
      Effect.try({
        try: () => {
          const path = join(directory, partition);
          claimFormat(path, versions);
          const db = new RocksDatabase(path, {
            // Both given explicitly. The defaults are `ordered-binary` keys and
            // MessagePack values, and either would re-encode bytes this store
            // has already encoded for its own ordering.
            keyEncoding: "binary",
            encoding: "binary",
          });
          // The constructor does not open; it only describes the database.
          db.open();
          return db;
        },
        catch: (cause) => new StoreError({ op: "rocksdb-js.open", cause }),
      }),
    ),
    (db) => Effect.orDie(Effect.sync(() => db.close())),
  ).pipe(
    Effect.map((db): KvEngine => {
      const fail = (op: string) => (cause: unknown) => new StoreError({ op, cause });

      return {
        get: (key) =>
          Effect.tryPromise({
            try: async () => {
              const value = await db.get(buf(key));
              return value === undefined ? undefined : new Uint8Array(value);
            },
            catch: fail("rocksdb-js.get"),
          }),

        scan: (prefix) =>
          Stream.fromAsyncIterable(
            (async function* (): AsyncGenerator<Arr.NonEmptyArray<KvEntry>> {
              const end = prefixEnd(prefix);
              // A half-open range, which is what `prefixEnd` already describes:
              // membership is the range, never a byte-prefix test.
              //
              // An empty bound is omitted rather than passed. The binding
              // rejects a zero-length key outright, and this store asks for
              // exactly that whenever it scans a whole tag — or, at the top,
              // the entire keyspace. Omitting the bound is what "from the
              // beginning" and "to the end" mean here.
              const entries = db
                .getRange({
                  ...(prefix.length === 0 ? {} : { start: buf(prefix) }),
                  ...(end === undefined || end.length === 0 ? {} : { end: buf(end) }),
                })
                [Symbol.iterator]();
              // Entries leave in batches, not one at a time. Each step of an
              // async generator is a promise and a trip through the stream, and
              // per entry that cost more than RocksDB did: a 100k-key scan took
              // half again as long as the binding's own iterator. The binding
              // reads synchronously anyway, so a batch costs one step.
              //
              // `return` runs when the consumer stops early too — the stream
              // calls it on scope close — and closes the native iterator, which
              // would otherwise hold its snapshot until garbage collection.
              try {
                for (;;) {
                  const batch: Array<KvEntry> = [];
                  let step: IteratorResult<{ key: Buffer; value: Buffer }>;
                  while (batch.length < SCAN_BATCH && !(step = entries.next()).done) {
                    batch.push({
                      key: new Uint8Array(step.value.key),
                      value: new Uint8Array(step.value.value),
                    });
                  }
                  if (Arr.isArrayNonEmpty(batch)) yield batch;
                  if (batch.length < SCAN_BATCH) return;
                }
              } finally {
                entries.return?.();
              }
            })(),
            (cause) => new StoreError({ op: "rocksdb-js.scan", cause }),
          ).pipe(Stream.flattenArray),

        write: (writes: ReadonlyArray<KvWrite>) =>
          Effect.tryPromise({
            try: () =>
              // One Zelavis batch is one RocksDB transaction. The store's whole
              // atomicity story is this call: a transaction that committed half
              // of a batch would leave a payload without its manifest, or a
              // posting with no event behind it.
              db.transaction((txn) => {
                for (const write of writes) {
                  if (write.op === "put") txn.putSync(buf(write.key), buf(write.value));
                  else txn.removeSync(buf(write.key));
                }
              }),
            catch: fail("rocksdb-js.write"),
          }).pipe(Effect.asVoid),

        close: Effect.orDie(Effect.sync(() => db.close())),
      };
    }),
  );

export const makeRocksdbJsStore = (
  partition: PartitionKey,
  directory: string,
): Effect.Effect<ObjectStoreApi, StoreError, Scope.Scope> =>
  Effect.gen(function* () {
    const engine = yield* makeRocksdbJsEngine(partition, directory);
    return storeOverKv(partition, engine, yield* claimGeneration(engine));
  });
