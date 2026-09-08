import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Stream, type Scope } from "effect";
import { StoreError } from "../errors.js";
import { prefixEnd } from "../keys.js";
import type { KvEngine, KvEntry, KvWrite } from "../kv.js";

/**
 * SQLite as an ordered key-value engine.
 *
 * A rowid table rather than `WITHOUT ROWID`: the primary key still gets a
 * unique index that range scans use, but payload bytes stay out of that index
 * instead of bloating the pages the scans read. SQLite compares BLOBs
 * bytewise, which is exactly the ordering the key encoding assumes.
 */
const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS kv (
    key BLOB PRIMARY KEY,
    value BLOB NOT NULL
  );
`;

const toBuffer = (bytes: Uint8Array) => Buffer.from(bytes);

export const makeSqliteKvEngine = (
  name: string,
  directory: string,
): Effect.Effect<KvEngine, StoreError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        if (directory !== ":memory:") mkdirSync(directory, { recursive: true });
        const db = new DatabaseSync(
          directory === ":memory:" ? ":memory:" : join(directory, `${name}.sqlite`),
        );
        db.exec(SCHEMA);
        return db;
      },
      catch: (cause) => new StoreError({ op: "sqlite-kv.open", cause }),
    }),
    (db) => Effect.sync(() => db.close()),
  ).pipe(
    Effect.map((db): KvEngine => {
      const statements = {
        get: db.prepare("SELECT value FROM kv WHERE key = ?"),
        put: db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)"),
        del: db.prepare("DELETE FROM kv WHERE key = ?"),
        scanTo: db.prepare("SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key"),
        scanFrom: db.prepare("SELECT key, value FROM kv WHERE key >= ? ORDER BY key"),
      };

      const fail = (op: string) => (cause: unknown) => new StoreError({ op, cause });

      return {
        get: (key) =>
          Effect.try({
            try: () => {
              const row = statements.get.get(toBuffer(key)) as { value: Uint8Array } | undefined;
              return row === undefined ? undefined : new Uint8Array(row.value);
            },
            catch: fail("sqlite-kv.get"),
          }),

        scan: (prefix) =>
          Stream.fromIterableEffect(
            Effect.try({
              try: () => {
                const end = prefixEnd(prefix);
                // Rows stream rather than materialize, so a wide posting scan
                // never becomes an array on the way to a bitmap.
                const rows =
                  end === undefined
                    ? statements.scanFrom.iterate(toBuffer(prefix))
                    : statements.scanTo.iterate(toBuffer(prefix), toBuffer(end));
                return (function* (): Generator<KvEntry> {
                  for (const row of rows as Iterable<{ key: Uint8Array; value: Uint8Array }>) {
                    yield { key: new Uint8Array(row.key), value: new Uint8Array(row.value) };
                  }
                })();
              },
              catch: fail("sqlite-kv.scan"),
            }),
          ),

        write: (writes: ReadonlyArray<KvWrite>) =>
          Effect.try({
            try: () => {
              // One transaction per batch is the atomicity the store relies on,
              // and it opens and closes inside this call rather than spanning
              // anything a concurrent caller could write into.
              db.exec("BEGIN");
              try {
                for (const write of writes) {
                  if (write.op === "put") {
                    statements.put.run(toBuffer(write.key), toBuffer(write.value));
                  } else {
                    statements.del.run(toBuffer(write.key));
                  }
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
    }),
  );
