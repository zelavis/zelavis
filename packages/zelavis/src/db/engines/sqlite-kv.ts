import { Deferred, Effect, Option, Stream } from "effect";
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
 * needs a VACUUM, so it applies to new files and an existing file keeps its own.
 * It is SQLite's default, 4 KiB. The log holds every page a commit touched,
 * whole, and a commit touches about a dozen (record, event, postings, counters),
 * so the page is what a commit costs: at 8 KiB a 445-byte document wrote 94 KiB
 * of log, at 4 KiB 49 KiB, with 13 to 20% more commits a second and a file 40%
 * smaller for 4 KB documents. Scans and point reads measured the same within a
 * few percent; sealed wide terms about 8% and a first seal about 15% slower.
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
 * pages, which interrupts bulk ingest to fold the log back into the file. That
 * checkpoint runs inside whichever commit crosses the threshold, on the caller's
 * thread; with `checkpoints: "background"` a checkpoint thread does the work
 * instead (`sqlite-checkpointer.ts`), and the threshold rises to a backstop that
 * only a stalled checkpointer reaches, so the log stays bounded either way.
 */
const kvSchema = `
  PRAGMA page_size = 4096;
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

/**
 * With checkpoints in the background, the commit path checkpoints only past this many pages of log (64 MiB at 4 KiB
 * pages, about as many commits as 128 MiB held at 8 KiB pages). The log is never trimmed when it is reset (no `journal_size_limit`): a reset log is written again from its
 * start, over space the file already has, and a trimmed one has to grow back. Growing a file is where a commit waits on
 * the filesystem (up to 85 ms measured on macOS, 46 ms on a VM disk), and trimming made the log grow on about half of
 * all commits under steady writes. So a busy shard's log keeps the size it reached, at most about the backstop, until
 * its last connection closes and SQLite removes it.
 */
const BACKGROUND_CHECKPOINT_SETUP = `
  PRAGMA wal_autocheckpoint = 16000;
`;

/** Read-only connections kept open between snapshots; more are opened when needed. */
const IDLE_READERS = 4;

/** At most this many batches share one commit. A group always takes at least one batch. */
const GROUP_BATCHES = 64;

/** At most this many key and value bytes share one commit, unless a single batch is larger alone. */
const GROUP_BYTES = 16 * 1024 * 1024;

/**
 * The priority a commit's leader yields with. The scheduler runs a pass in ascending priority, so
 * the leader resumes after every fiber already scheduled, and those that reach a commit join it.
 */
const AFTER_READY_FIBERS = Number.MAX_SAFE_INTEGER;

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
  options: {
    readonly openReader: () => SqliteHandle;
    readonly durability?: KvDurability;
    /**
     * Who folds the log back into the file: SQLite, inside a commit (`engine`, the default), or a checkpoint thread the
     * caller runs (`background`), with SQLite's own kept only as a backstop.
     */
    readonly checkpoints?: "engine" | "background";
  },
): KvEngine => {
  try {
    db.exec(kvSchema);
    // WAL with synchronous=NORMAL survives a crash; FULL also syncs the log at every commit.
    // On macOS `fsync` leaves the data in the drive's cache, so a commit survives a power cut
    // only with F_FULLFSYNC, which SQLite uses for every sync (checkpoints included) once
    // `fullfsync` is on. Elsewhere the pragma changes nothing. Measured on a Mac: about 12,000
    // commits a second without it, about 240 with it, which is the drive actually flushing.
    if (options.durability === "power") db.exec("PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;");
    if (options.checkpoints === "background") db.exec(BACKGROUND_CHECKPOINT_SETUP);
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

  /**
   * Group commit: batches that are ready together commit in one transaction, so they share one
   * flush of the log rather than paying one each.
   *
   * Each batch is still its own atomic unit with its own conditions, checked inside the shared
   * transaction after the batches ahead of it: the group's outcome is exactly the batches run one
   * after another, in arrival order, with one commit at the end. A refused batch writes nothing, so
   * it needs no undo. A batch whose writes throw leaves the transaction in a state not worth
   * trusting, so the whole transaction is rolled back, that batch fails alone, and the others run
   * again from the start; each retry holds one batch fewer, so it ends. No batch is answered until
   * the commit has returned, which keeps each caller's durability exactly what it was alone.
   *
   * The first batch to arrive leads: it yields once, after every fiber already scheduled, so writers
   * ready at the same moment can join, then commits whatever has queued, a bounded group at a time.
   * Leading and waiting are uninterruptible: a queued batch is always committed or refused, so an
   * interrupted caller never leaves an outcome it cannot know. The wait is bounded by the commit
   * itself, which runs synchronously once it starts.
   */
  interface Queued {
    readonly writes: ReadonlyArray<KvWrite>;
    readonly conditions: ReadonlyArray<KvCondition>;
    readonly done: Deferred.Deferred<boolean, StoreError>;
  }
  const queue: Queued[] = [];
  let leading = false;

  const bytesOf = (entry: Queued): number => {
    let bytes = 0;
    for (const write of entry.writes) bytes += write.key.length + (write.op === "put" ? write.value.length : 0);
    return bytes;
  };

  /** The next group: at least one batch, then as many as fit both limits. */
  const nextGroup = (): Queued[] => {
    // Measured before anything leaves the queue, so a batch that cannot be measured leaves every
    // batch still queued, and so still answered.
    let count = 1;
    let bytes = bytesOf(queue[0]!);
    while (count < queue.length && count < GROUP_BATCHES) {
      const size = bytesOf(queue[count]!);
      if (bytes + size > GROUP_BYTES) break;
      bytes += size;
      count += 1;
    }
    return queue.splice(0, count);
  };

  /** One batch inside the open transaction: false, having written nothing, when a condition does not hold. */
  const apply = (entry: Queued): boolean => {
    for (const condition of entry.conditions) {
      const row = statements.get.get(toKey(condition.key)) as { value: unknown } | undefined;
      if (!equalBytes(row === undefined ? undefined : toBytes(row.value), condition.value)) return false;
    }
    for (const write of entry.writes) {
      if (write.op === "put") statements.put.run(toKey(write.key), Buffer.from(write.value));
      else statements.del.run(toKey(write.key));
    }
    return true;
  };

  /** The failure a rollback adds to the one that caused it, so neither is lost. */
  const rollback = (cause: unknown): unknown => {
    try {
      db.exec("ROLLBACK");
      return cause;
    } catch (cleanup) {
      return new AggregateError([cause, cleanup], "A write and its rollback both failed.");
    }
  };

  type Answer = readonly [Queued, Effect.Effect<boolean, StoreError>];

  /** Commit one group and decide every batch in it, whatever happens. */
  const commitGroup = (group: ReadonlyArray<Queued>, answers: Answer[]): void => {
    const settle = (entry: Queued, outcome: Effect.Effect<boolean, StoreError>) => { answers.push([entry, outcome]); };
    let members = group;
    while (members.length > 0) {
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch (cause) {
        for (const member of members) settle(member, Effect.fail(fail("sqlite-kv.write")(cause)));
        return;
      }
      const outcomes: boolean[] = [];
      let broken: { readonly index: number; readonly cause: unknown } | undefined;
      for (let index = 0; index < members.length && broken === undefined; index++) {
        try {
          outcomes.push(apply(members[index]!));
        } catch (cause) {
          broken = { index, cause };
        }
      }
      if (broken !== undefined) {
        const { index, cause } = broken;
        settle(members[index]!, Effect.fail(fail("sqlite-kv.write")(rollback(cause))));
        members = members.filter((_, at) => at !== index);
        continue;
      }
      try {
        db.exec("COMMIT");
      } catch (cause) {
        const failure = fail("sqlite-kv.write")(rollback(cause));
        for (const member of members) settle(member, Effect.fail(failure));
        return;
      }
      members.forEach((member, index) => settle(member, Effect.succeed(outcomes[index]!)));
      return;
    }
  };

  const batch = (writes: ReadonlyArray<KvWrite>, conditions: ReadonlyArray<KvCondition>): Effect.Effect<boolean, StoreError> =>
    Effect.uninterruptible(Effect.suspend(() => {
      const done = Deferred.makeUnsafe<boolean, StoreError>();
      queue.push({ writes, conditions, done });
      if (leading) return Deferred.await(done);
      leading = true;
      return Effect.yieldNowWith(AFTER_READY_FIBERS).pipe(
        Effect.andThen(Effect.sync(() => {
          // Everything queued now, and nothing more: commits are synchronous, so nothing joins
          // while they run. Answering resumes the waiting fibers on this stack, and they commit
          // again at once, so the answers wait until this leader has stepped down: whoever queues
          // next leads the next group, and no leader ends up committing everyone else's work.
          // The flag is cleared here and nowhere later: once answers go out, a new leader may
          // already hold it.
          const answers: Answer[] = [];
          let taken: ReadonlyArray<Queued> = [];
          try {
            while (queue.length > 0) {
              taken = nextGroup();
              commitGroup(taken, answers);
              taken = [];
            }
          } catch (cause) {
            // Only a defect gets here (a malformed batch): every statement failure is decided inside
            // `commitGroup`. Even so, no batch may be left waiting for an answer that never comes.
            const failure = fail("sqlite-kv.write")(cause);
            const answered = new Set(answers.map(([entry]) => entry));
            for (const entry of [...taken, ...queue.splice(0)]) {
              if (!answered.has(entry)) answers.push([entry, Effect.fail(failure)]);
            }
          } finally {
            leading = false;
          }
          for (const [entry, outcome] of answers) Deferred.doneUnsafe(entry.done, outcome);
        })),
        Effect.andThen(Deferred.await(done)),
      );
    }));

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
