import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type ZelavisSystemStore,
  type ZelavisSystemStoreRecord,
  type ZelavisSystemStoreValue,
} from "../system-store.js";

type BunStatement = {
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
  run(...parameters: unknown[]): { changes: number };
};

type BunDatabase = {
  exec(statement: string): void;
  query(statement: string): BunStatement;
};

export async function createBunSqliteSystemStore(options: {
  filename: string;
}): Promise<ZelavisSystemStore> {
  const moduleName = "bun:sqlite";
  const { Database } = (await import(moduleName)) as {
    Database: new (filename: string, options?: { create?: boolean }) => BunDatabase;
  };
  const filename = resolve(options.filename);
  mkdirSync(dirname(filename), { recursive: true });
  const database = new Database(filename, { create: true });

  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS zelavis_system_records (
      namespace TEXT NOT NULL,
      record_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, record_key)
    );
  `);

  const readStatement = database.query(
    "SELECT namespace, record_key, value_json, updated_at FROM zelavis_system_records WHERE namespace = ? AND record_key = ?",
  );
  const listStatement = database.query(
    "SELECT namespace, record_key, value_json, updated_at FROM zelavis_system_records WHERE namespace = ? ORDER BY record_key",
  );
  const writeStatement = database.query(`
    INSERT INTO zelavis_system_records (namespace, record_key, value_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(namespace, record_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `);
  const deleteStatement = database.query(
    "DELETE FROM zelavis_system_records WHERE namespace = ? AND record_key = ?",
  );
  const createStatement = database.query(`
    INSERT OR IGNORE INTO zelavis_system_records
      (namespace, record_key, value_json, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const compareAndSetStatement = database.query(`
    UPDATE zelavis_system_records
    SET value_json = ?, updated_at = ?
    WHERE namespace = ? AND record_key = ? AND updated_at = ?
  `);
  const compareAndDeleteStatement = database.query(`
    DELETE FROM zelavis_system_records
    WHERE namespace = ? AND record_key = ? AND updated_at = ?
  `);

  function toRecord(row: unknown): ZelavisSystemStoreRecord {
    const value = row as {
      namespace: string;
      record_key: string;
      value_json: string;
      updated_at: string;
    };
    return {
      namespace: value.namespace,
      key: value.record_key,
      value: JSON.parse(value.value_json) as ZelavisSystemStoreValue,
      updatedAt: value.updated_at,
    };
  }

  return {
    get(namespace, key) {
      const row = readStatement.get(namespace, key);
      return row ? toRecord(row) : undefined;
    },
    set(namespace, key, value) {
      const updatedAt = new Date().toISOString();
      writeStatement.run(namespace, key, JSON.stringify(value), updatedAt);
      return { namespace, key, value, updatedAt };
    },
    setIfAbsent(namespace, key, value) {
      const updatedAt = new Date().toISOString();
      const created = createStatement.run(
        namespace,
        key,
        JSON.stringify(value),
        updatedAt,
      ).changes > 0;
      const row = readStatement.get(namespace, key);
      if (!row) throw new Error("System Store failed to read an atomic create.");
      return { created, record: toRecord(row) };
    },
    compareAndSet(namespace, key, expectedUpdatedAt, value) {
      const updatedAt = new Date(
        Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1),
      ).toISOString();
      const changed = compareAndSetStatement.run(
        JSON.stringify(value),
        updatedAt,
        namespace,
        key,
        expectedUpdatedAt,
      ).changes > 0;
      return changed ? { namespace, key, value, updatedAt } : undefined;
    },
    compareAndDelete(namespace, key, expectedUpdatedAt) {
      return compareAndDeleteStatement.run(
        namespace,
        key,
        expectedUpdatedAt,
      ).changes > 0;
    },
    delete(namespace, key) {
      return deleteStatement.run(namespace, key).changes > 0;
    },
    list(namespace) {
      return listStatement.all(namespace).map(toRecord);
    },
  };
}
