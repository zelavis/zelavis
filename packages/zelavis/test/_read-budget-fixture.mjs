import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { Effect } from "effect";
import { loadSqliteOpener } from "../dist/db/engines/node-sqlite.js";
import { sqliteKvEngineOver } from "../dist/db/engines/sqlite-kv.js";

/** What the SQLite binding was asked for and handed back: the work underneath a read, counted where it happens. */
export const newStats = () => ({
  /** Rows of content (key and value) copied out by iterating statements. */
  rowsCopied: 0,
  /** Bytes of those rows. */
  bytesCopied: 0,
  /** Rows whose sizes alone were looked at. */
  rowsSized: 0,
  /** Single-value reads that copied the value. */
  getsCopied: 0,
  /** Single-value reads that found the value too large and did not copy it. */
  getsRefused: 0,
  /** Bytes of the values those gets copied. */
  getBytesCopied: 0,
  begins: 0,
  rollbacks: 0,
});

const sizeOf = (value) => value === null || value === undefined ? 0 : value.byteLength ?? value.length ?? 0;

/** A SQLite engine on its own file whose binding counts into `stats`. */
export const instrumentedSqliteEngine = (stats) => Effect.gen(function* () {
  const open = yield* Effect.promise(() => loadSqliteOpener());
  const directory = mkdtempSync(join(tmpdir(), "zv-budget-"));
  after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "shard.sqlite");
  const counted = (readOnly) => {
    const handle = open(file, readOnly);
    return {
      prepare: (sql) => {
        const statement = handle.prepare(sql);
        return {
          run: (...params) => statement.run(...params),
          get: (...params) => {
            const row = statement.get(...params);
            if (sql.includes("CASE WHEN length(value)")) {
              if (row !== undefined && row.value !== null) { stats.getsCopied += 1; stats.getBytesCopied += sizeOf(row.value); }
              else if (row !== undefined) stats.getsRefused += 1;
            }
            return row;
          },
          iterate: (...params) => {
            const rows = statement.iterate(...params);
            return (function* () {
              for (const row of rows) {
                if (sql.includes("length(key) AS keyBytes")) stats.rowsSized += 1;
                else if (sql.startsWith("SELECT key, value")) { stats.rowsCopied += 1; stats.bytesCopied += sizeOf(row.key) + sizeOf(row.value); }
                yield row;
              }
            })();
          },
        };
      },
      exec: (sql) => {
        if (sql === "BEGIN") stats.begins += 1;
        if (sql === "ROLLBACK") stats.rollbacks += 1;
        handle.exec(sql);
      },
      close: () => handle.close(),
    };
  };
  return sqliteKvEngineOver(counted(false), { openReader: () => counted(true) });
});
