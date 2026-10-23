import { Effect, Stream } from "effect";
import { StoreError } from "../errors.js";
import {
  equalBytes, scanRange, type KvCondition, type KvEngine, type KvEntry, type KvReader, type KvScanOptions, type KvWrite,
} from "../kv.js";

/**
 * The handle a SQLite-shaped binding provides.
 *
 * Structural rather than imported, so this file depends on neither binding and
 * an optional one stays optional.
 */
export interface SqliteHandle {
  prepare(sql: string): {
    get(...params: ReadonlyArray<unknown>): unknown;
    run(...params: ReadonlyArray<unknown>): unknown;
    iterate(...params: ReadonlyArray<unknown>): Iterable<unknown>;
  };
  exec(sql: string): void;
  close(): void;
}

/**
 * How keys reach the binding.
 *
 * `blob` is the natural choice and what the default engine uses. `hex` exists
 * because libsql 0.5.29 panics in its native layer when a Buffer is bound as a
 * query parameter, so its keys travel as text. Hex preserves order — every byte
 * becomes exactly two digits from an ordered alphabet — so range scans behave
 * identically under SQLite's default BINARY collation.
 *
 * A rowid table either way: the primary key still gets the unique index that
 * range scans read, while payload bytes stay out of the pages they walk.
 */
export type KeyEncoding = "blob" | "hex";

/**
 * SQLite ships conservative defaults for a shared machine, not for a database
 * that owns its file. Each of these is a deliberate departure.
 *
 * `page_size` is set before the table exists, because changing it afterwards
 * needs a VACUUM. Larger pages mean fewer of them per range scan, and posting
 * scans are the hot path.
 *
 * `mmap_size` is the significant one. Without it every read copies through the
 * page cache into a buffer; with it SQLite reads straight from a mapped file,
 * which is the same mechanism that makes a memory-mapped engine fast. Two
 * hundred and fifty-six megabytes is a ceiling rather than an allocation.
 *
 * `cache_size` is negative, which SQLite reads as kibibytes rather than pages,
 * so this is 64 MiB regardless of page size. The default is two.
 *
 * `wal_autocheckpoint` is raised because the default checkpoints every thousand
 * pages, which interrupts bulk ingest to fold the log back into the file.
 */
const kvSchema = (encoding: KeyEncoding) => `
  PRAGMA page_size = 8192;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA mmap_size = 268435456;
  PRAGMA cache_size = -65536;
  PRAGMA temp_store = MEMORY;
  PRAGMA wal_autocheckpoint = 4000;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS kv (
    key ${encoding === "hex" ? "TEXT" : "BLOB"} PRIMARY KEY,
    value BLOB NOT NULL
  );
`;

/**
 * How a read-only connection is set up: the same reading pragmas as the
 * writer's, and `query_only` so nothing can write through it by mistake.
 */
const READER_SETUP = `
  PRAGMA query_only = 1;
  PRAGMA mmap_size = 268435456;
  PRAGMA cache_size = -65536;
  PRAGMA busy_timeout = 5000;
`;

/** Read-only connections kept open between snapshots; more are opened when needed. */
const IDLE_READERS = 4;

/** Bindings disagree on blob representation; the store sees one shape. */
const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(0);
};

/**
 * An ordered key-value engine over a SQLite-shaped handle.
 *
 * Shared by every SQLite-family binding, so an engine is the handle plus the
 * quirks of its own driver, never a second copy of this.
 *
 * A snapshot is a read transaction on a second, read-only connection to the
 * same file: in WAL mode a reader sees the database as of its first read and
 * never blocks the writer. `openReader` opens one; a few are kept between
 * snapshots. A database with no file of its own has no second connection to
 * offer, which is why every SQLite engine here is a file.
 */
export const sqliteKvEngineOver = (
  db: SqliteHandle,
  options: { readonly encoding?: KeyEncoding; readonly openReader: () => SqliteHandle },
): KvEngine => {
  const encoding = options.encoding ?? "blob";
  db.exec(kvSchema(encoding));

  const toKey = (bytes: Uint8Array): unknown =>
    encoding === "hex" ? Buffer.from(bytes).toString("hex") : Buffer.from(bytes);

  const fromKey = (value: unknown): Uint8Array =>
    typeof value === "string" ? new Uint8Array(Buffer.from(value, "hex")) : toBytes(value);

  const statements = {
    get: db.prepare("SELECT value FROM kv WHERE key = ?"),
    put: db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)"),
    del: db.prepare("DELETE FROM kv WHERE key = ?"),
  };

  const GET = "SELECT value FROM kv WHERE key = ?";
  const SCAN_TO = "SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key LIMIT ?";
  const SCAN_FROM = "SELECT key, value FROM kv WHERE key >= ? ORDER BY key LIMIT ?";
  const SCAN_TO_DESC = "SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key DESC LIMIT ?";
  const SCAN_FROM_DESC = "SELECT key, value FROM kv WHERE key >= ? ORDER BY key DESC LIMIT ?";

  const fail = (op: string) => (cause: unknown) => new StoreError({ op, cause });

  /** Point and range reads over one connection: the writer's, or a reader's. */
  const readerOn = (handle: SqliteHandle, get: ReturnType<SqliteHandle["prepare"]>): KvReader => ({
    get: (key) =>
      Effect.try({
        try: () => {
          const row = get.get(toKey(key)) as { value: unknown } | undefined;
          return row === undefined ? undefined : toBytes(row.value);
        },
        catch: fail("sqlite-kv.get"),
      }),

    scan: (prefix: Uint8Array, scanOptions?: KvScanOptions) =>
      Stream.fromIterableEffect(
        Effect.try({
          try: () => {
            const { lo, hi, empty } = scanRange(prefix, scanOptions);
            if (empty) return [];
            // Rows stream rather than materialize, so a wide posting scan never
            // becomes an array on its way into a bitmap.
            // A fresh statement per scan, not a cached one. A scan hands back a
            // lazy iterator, so two overlapping scans would share the cursor of
            // one statement — which node:sqlite tolerates and libsql answers by
            // panicking inside its native layer. Single-shot statements stay
            // cached; only the iterating ones are rebuilt.
            const reverse = scanOptions?.reverse === true;
            // SQLite reads a negative limit as none.
            const limit = scanOptions?.limit ?? -1;
            const rows =
              hi === undefined
                ? handle.prepare(reverse ? SCAN_FROM_DESC : SCAN_FROM).iterate(toKey(lo), limit)
                : handle.prepare(reverse ? SCAN_TO_DESC : SCAN_TO).iterate(toKey(lo), toKey(hi), limit);
            return (function* (): Generator<KvEntry> {
              for (const row of rows as Iterable<{ key: unknown; value: unknown }>) {
                yield { key: fromKey(row.key), value: toBytes(row.value) };
              }
            })();
          },
          catch: fail("sqlite-kv.scan"),
        }),
      ),
  });

  interface Reader {
    readonly handle: SqliteHandle;
    readonly reader: KvReader;
    readonly probe: ReturnType<SqliteHandle["prepare"]>;
  }
  const idle: Reader[] = [];
  let closed = false;

  const openReader = (): Reader => {
    const handle = options.openReader();
    handle.exec(READER_SETUP);
    return {
      handle,
      reader: readerOn(handle, handle.prepare(GET)),
      probe: handle.prepare("SELECT 1 FROM kv LIMIT 1"),
    };
  };

  /** Back to the pool after its transaction ends, or closed if it cannot be reused. */
  const release = (taken: Reader) =>
    Effect.match(Effect.try({ try: () => taken.handle.exec("ROLLBACK"), catch: fail("sqlite-kv.snapshot") }), {
      onFailure: () => taken.handle.close(),
      onSuccess: () => {
        if (closed || idle.length >= IDLE_READERS) taken.handle.close();
        else idle.push(taken);
      },
    });

  const snapshot = Effect.map(
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          const taken = idle.pop() ?? openReader();
          taken.handle.exec("BEGIN");
          // The snapshot is taken at the transaction's first read, so it is
          // taken here rather than whenever the first caller happens to read.
          taken.probe.get();
          return taken;
        },
        catch: fail("sqlite-kv.snapshot"),
      }),
      release,
    ),
    (taken) => taken.reader,
  );

  const batch = (writes: ReadonlyArray<KvWrite>, conditions: ReadonlyArray<KvCondition>) =>
    Effect.try({
      try: () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const condition of conditions) {
            const row = statements.get.get(toKey(condition.key)) as { value: unknown } | undefined;
            if (!equalBytes(row === undefined ? undefined : toBytes(row.value), condition.value)) {
              db.exec("ROLLBACK");
              return false;
            }
          }
          for (const write of writes) {
            if (write.op === "put") statements.put.run(toKey(write.key), Buffer.from(write.value));
            else statements.del.run(toKey(write.key));
          }
          db.exec("COMMIT");
          return true;
        } catch (cause) {
          db.exec("ROLLBACK");
          throw cause;
        }
      },
      catch: fail("sqlite-kv.write"),
    });

  return {
    ...readerOn(db, statements.get),

    write: (writes) => batch(writes, []).pipe(Effect.asVoid),
    conditionalWrite: batch,
    coordination: "host",
    snapshot,

    close: Effect.sync(() => {
      closed = true;
      for (const taken of idle.splice(0)) taken.handle.close();
      db.close();
    }),
  };
};
