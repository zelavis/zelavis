import { Effect, Stream } from "effect";
import { StoreError } from "../errors.js";
import { scanRange, type KvEngine, type KvEntry, type KvWrite } from "../kv.js";

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
 */
export const sqliteKvEngineOver = (
  db: SqliteHandle,
  encoding: KeyEncoding = "blob",
): KvEngine => {
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

  const SCAN_TO = "SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key";
  const SCAN_FROM = "SELECT key, value FROM kv WHERE key >= ? ORDER BY key";
  const SCAN_TO_DESC = "SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key DESC";
  const SCAN_FROM_DESC = "SELECT key, value FROM kv WHERE key >= ? ORDER BY key DESC";

  const fail = (op: string) => (cause: unknown) => new StoreError({ op, cause });

  return {
    get: (key) =>
      Effect.try({
        try: () => {
          const row = statements.get.get(toKey(key)) as { value: unknown } | undefined;
          return row === undefined ? undefined : toBytes(row.value);
        },
        catch: fail("sqlite-kv.get"),
      }),

    scan: (prefix, options) =>
      Stream.fromIterableEffect(
        Effect.try({
          try: () => {
            const { lo, hi, empty } = scanRange(prefix, options);
            if (empty) return [];
            // Rows stream rather than materialize, so a wide posting scan never
            // becomes an array on its way into a bitmap.
            // A fresh statement per scan, not a cached one. A scan hands back a
            // lazy iterator, so two overlapping scans would share the cursor of
            // one statement — which node:sqlite tolerates and libsql answers by
            // panicking inside its native layer. Single-shot statements stay
            // cached; only the iterating ones are rebuilt.
            const reverse = options?.reverse === true;
            const rows =
              hi === undefined
                ? db.prepare(reverse ? SCAN_FROM_DESC : SCAN_FROM).iterate(toKey(lo))
                : db.prepare(reverse ? SCAN_TO_DESC : SCAN_TO).iterate(toKey(lo), toKey(hi));
            return (function* (): Generator<KvEntry> {
              for (const row of rows as Iterable<{ key: unknown; value: unknown }>) {
                yield { key: fromKey(row.key), value: toBytes(row.value) };
              }
            })();
          },
          catch: fail("sqlite-kv.scan"),
        }),
      ),

    write: (writes: ReadonlyArray<KvWrite>) =>
      Effect.try({
        try: () => {
          // The transaction opens and closes inside this call, so nothing a
          // concurrent caller does can land inside it.
          db.exec("BEGIN");
          try {
            for (const write of writes) {
              if (write.op === "put") statements.put.run(toKey(write.key), Buffer.from(write.value));
              else statements.del.run(toKey(write.key));
            }
            db.exec("COMMIT");
          } catch (cause) {
            db.exec("ROLLBACK");
            throw cause;
          }
        },
        catch: fail("sqlite-kv.write"),
      }),

    close: Effect.sync(() => db.close()),
  };
};
