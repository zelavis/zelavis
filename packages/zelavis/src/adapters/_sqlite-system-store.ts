import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ZelavisSystemStore,
  type ZelavisSystemStoreRecord,
  type ZelavisSystemStoreValue,
} from "../system-store.js";

export interface LocalSqliteSystemStoreOptions {
  filename: string;
}

/**
 * Narrows a local state file to the owning user.
 *
 * Best-effort: `chmod` is meaningless on Windows and the file may not exist yet
 * (SQLite creates WAL sidecars lazily), so failure is not fatal. A symlinked
 * path is left alone rather than followed, since chmod would apply to whatever
 * it points at.
 */
function restrictFilePermissions(path: string): void {
  if (process.platform === "win32") return;
  try {
    if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) return;
    chmodSync(path, 0o600);
  } catch {
    // Nothing to restrict, or the host does not support it.
  }
}

export function createLocalSqliteSystemStore(
  options: LocalSqliteSystemStoreOptions,
): ZelavisSystemStore {
  const filename = resolve(options.filename);
  // Platform, Auth, and Project state live here. On a host with a permissive
  // umask, or a shared service account, process defaults would let other local
  // users read it. Packaged deployments should still run under a dedicated
  // service user; this is defence in depth, not a substitute.
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  chmodSync(dirname(filename), 0o700);
  // Node's own SQLite: nothing native to build or install on the host.
  const database = new DatabaseSync(filename);
  restrictFilePermissions(filename);
  // WAL keeps its own sidecar files, which hold the same data.
  restrictFilePermissions(`${filename}-wal`);
  restrictFilePermissions(`${filename}-shm`);

  // Wait for another process holding the file (the Platform, an Agent and the
  // CLI share this store) instead of failing at once: better-sqlite3's old default.
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS zelavis_system_records (
      namespace TEXT NOT NULL,
      record_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, record_key)
    )
  `);

  const namespacesStatement = database.prepare(
    "SELECT namespace, COUNT(*) AS recordCount FROM zelavis_system_records GROUP BY namespace ORDER BY namespace",
  );
  const pageStatement = database.prepare(
    "SELECT namespace, record_key, value_json, updated_at FROM zelavis_system_records WHERE namespace = ? AND (? IS NULL OR record_key > ?) ORDER BY record_key LIMIT ?",
  );

  const readStatement = database.prepare(
    "SELECT namespace, record_key, value_json, updated_at FROM zelavis_system_records WHERE namespace = ? AND record_key = ?",
  );
  const listStatement = database.prepare(
    "SELECT namespace, record_key, value_json, updated_at FROM zelavis_system_records WHERE namespace = ? ORDER BY record_key",
  );
  const writeStatement = database.prepare(`
    INSERT INTO zelavis_system_records (namespace, record_key, value_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(namespace, record_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `);
  const deleteStatement = database.prepare(
    "DELETE FROM zelavis_system_records WHERE namespace = ? AND record_key = ?",
  );
  const createStatement = database.prepare(`
    INSERT OR IGNORE INTO zelavis_system_records
      (namespace, record_key, value_json, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const compareAndSetStatement = database.prepare(`
    UPDATE zelavis_system_records
    SET value_json = ?, updated_at = ?
    WHERE namespace = ? AND record_key = ? AND updated_at = ?
      AND (? = 0 OR value_json = ?)
  `);
  const compareAndDeleteStatement = database.prepare(`
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

  let closed = false;

  return {
    namespaces() {
      return namespacesStatement.all().map(row => {
        const value = row as { namespace: string; recordCount: number };
        return { namespace: value.namespace, recordCount: Number(value.recordCount) };
      });
    },
    page(namespace, { limit, after }) {
      const rows = pageStatement.all(namespace, after ?? null, after ?? null, limit + 1).map(toRecord);
      return { records: rows.slice(0, limit),
        ...(rows.length > limit ? { next: rows[limit - 1]!.key } : {}) };
    },
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
    compareAndSet(namespace, key, expectedUpdatedAt, value, expectedValue) {
      const updatedAt = new Date(
        Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1),
      ).toISOString();
      const changed = compareAndSetStatement.run(
        JSON.stringify(value),
        updatedAt,
        namespace,
        key,
        expectedUpdatedAt,
        expectedValue === undefined ? 0 : 1,
        expectedValue === undefined ? null : JSON.stringify(expectedValue),
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
    close() {
      // Idempotent: shutdown paths may call this more than once.
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}
