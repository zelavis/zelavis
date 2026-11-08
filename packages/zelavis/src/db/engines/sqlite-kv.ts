import { Effect, Option, Stream } from "effect";
import { ReadBudgetExceeded, StoreError } from "../errors.js";
import {
  equalBytes, scanRange, type KvCondition, type KvDurability, type KvEngine, type KvEntry, type KvReadBudget, type KvReader, type KvScanOptions, type KvWrite,
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
const kvSchema = `
  PRAGMA page_size = 8192;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA mmap_size = 268435456;
  PRAGMA cache_size = -65536;
  PRAGMA temp_store = MEMORY;
  PRAGMA wal_autocheckpoint = 4000;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS kv (
    key BLOB PRIMARY KEY,
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

/** Rows a bounded scan looks at per step: sizes first, then only the rows the budget admits are copied. */
const BOUNDED_PAGE_ROWS = 256;

/** `length(value)` reads a blob's header, not its content, so a value too large for the budget is refused unread. */
const BOUNDED_GET = "SELECT length(value) AS size, CASE WHEN length(value) <= ? THEN value END AS value FROM kv WHERE key = ?";

const boundedScanSql = (columns: "sizes" | "rows", bounded: boolean, reverse: boolean): string =>
  `SELECT ${columns === "sizes" ? "length(key) AS keyBytes, length(value) AS valueBytes" : "key, value"} FROM kv WHERE key >= ?` +
  `${bounded ? " AND key < ?" : ""} ORDER BY key${reverse ? " DESC" : ""} LIMIT ?`;

/** Bindings disagree on blob representation; the store sees one shape. */
const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("A stored key or value is not binary data.");
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
  options: { readonly openReader: () => SqliteHandle; readonly durability?: KvDurability },
): KvEngine => {
  try {
    db.exec(kvSchema);
    // WAL with synchronous=NORMAL survives a crash; FULL also syncs the log at every commit.
    if (options.durability === "power") db.exec("PRAGMA synchronous = FULL;");
    const columns = [...db.prepare("PRAGMA table_info(kv)").iterate()];
    const key = columns.find(column => typeof column === "object" && column !== null && "name" in column && column.name === "key");
    if (typeof key !== "object" || key === null || !("type" in key) || key.type !== "BLOB") {
      throw new TypeError("The database uses an incompatible key encoding; recreate the pre-release development database. No data was converted.");
    }
  } catch (cause) {
    try { db.close(); } catch (cleanup) { throw new AggregateError([cause, cleanup], "Database initialization and cleanup failed."); }
    throw cause;
  }

  const toKey = (bytes: Uint8Array): unknown =>
    Buffer.from(bytes);

  const fromKey = (value: unknown): Uint8Array =>
    toBytes(value);

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

  /**
   * A thunk run as one engine step. A refusal by a read budget is the read's own verdict,
   * a defect carrying `ReadBudgetExceeded`; anything else a binding throws is a store failure.
   */
  const attempt = <A>(op: string, thunk: () => A): Effect.Effect<A, StoreError> =>
    Effect.try({ try: thunk, catch: (cause) => cause instanceof ReadBudgetExceeded ? cause : fail(op)(cause) }).pipe(
      Effect.catchTag("ReadBudgetExceeded", (refusal) => Effect.die(refusal)),
    );

  /** The successor of a key in scan order, for resuming just after it. */
  const after = (key: Uint8Array): Uint8Array => {
    const next = new Uint8Array(key.length + 1);
    next.set(key);
    return next;
  };

  /**
   * Reads that spend a budget before they copy. A value is sized inside the same statement that would
   * return it and handed back only when it fits what is left, so one oversized value is never copied.
   * A scan takes a page of sizes (no content), admits the rows that fit, and copies exactly those,
   * in the same read transaction, so the page is the one the sizes described. That needs a snapshot:
   * on the writer's own connection two statements are not one view, so a scan there is refused.
   */
  const boundedOn = (handle: SqliteHandle, budget: KvReadBudget, snapshot: boolean): KvReader => {
    const get = handle.prepare(BOUNDED_GET);
    return {
      get: (key) => attempt("sqlite-kv.get", () => {
        budget.spend(1, key.length);
        const row = get.get(budget.remainingBytes(), toKey(key)) as { size: number; value: unknown } | undefined;
        if (row === undefined) return undefined;
        budget.spend(0, row.size);
        return toBytes(row.value);
      }),

      scan: (prefix, scanOptions) => {
        if (!snapshot) return Stream.fail(fail("sqlite-kv.scan")("a bounded scan needs a snapshot"));
        const { lo, hi, empty } = scanRange(prefix, scanOptions);
        if (empty) return Stream.empty;
        const reverse = scanOptions?.reverse === true;
        interface Step { readonly lo: Uint8Array; readonly hi: Uint8Array | undefined; readonly left: number }
        return Stream.paginate({ lo, hi, left: scanOptions?.limit ?? Number.POSITIVE_INFINITY } as Step, (step: Step) =>
          attempt("sqlite-kv.scan", () => {
            const rows = Math.min(BOUNDED_PAGE_ROWS, step.left);
            if (rows < 1) return [[], Option.none<Step>()] as const;
            const bounds = step.hi === undefined ? [toKey(step.lo), rows] : [toKey(step.lo), toKey(step.hi), rows];
            const sizes: number[] = [];
            for (const row of handle.prepare(boundedScanSql("sizes", step.hi !== undefined, reverse)).iterate(...bounds) as Iterable<{ keyBytes: number; valueBytes: number }>) {
              sizes.push(row.keyBytes + row.valueBytes);
            }
            if (sizes.length === 0) return [[], Option.none<Step>()] as const;
            const entriesLeft = budget.remainingEntries(), bytesLeft = budget.remainingBytes();
            let admitted = 0, bytes = 0;
            while (admitted < sizes.length && admitted < entriesLeft && bytes + sizes[admitted]! <= bytesLeft) bytes += sizes[admitted++]!;
            // Nothing fits: this refuses by the limit that stopped it.
            if (admitted === 0) budget.spend(1, sizes[0]!);
            budget.spend(admitted, bytes);
            const entries: KvEntry[] = [];
            const copy = [...bounds.slice(0, -1), admitted];
            for (const row of handle.prepare(boundedScanSql("rows", step.hi !== undefined, reverse)).iterate(...copy) as Iterable<{ key: unknown; value: unknown }>) {
              entries.push({ key: fromKey(row.key), value: toBytes(row.value) });
            }
            const left = step.left - entries.length;
            const last = entries.at(-1);
            if (last === undefined || left < 1 || (sizes.length < rows && admitted === sizes.length)) return [entries, Option.none<Step>()] as const;
            return [entries, Option.some(reverse ? { lo: step.lo, hi: last.key, left } : { lo: after(last.key), hi: step.hi, left })] as const;
          }));
      },
    };
  };

  /** Point and range reads over one connection: the writer's, or a reader's. */
  const readerOn = (handle: SqliteHandle, get: ReturnType<SqliteHandle["prepare"]>, snapshot: boolean): KvReader => ({
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
            // one statement; bindings may otherwise answer by
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

    bounded: (budget) => boundedOn(handle, budget, snapshot),
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
      reader: readerOn(handle, handle.prepare(GET), true),
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
    ...readerOn(db, statements.get, false),

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
