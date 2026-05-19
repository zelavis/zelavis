import type { SqliteGateway } from "./gateway.js";

/**
 * Columns that older Zelavis releases didn't have on the SQLite-compatible
 * tables. New deployments get them through the DDL in `schema.ts`, but
 * existing databases need an additive ALTER TABLE pass so they keep working
 * after upgrading.
 */
const LEGACY_COLUMN_MIGRATIONS: ReadonlyArray<{
  table: string;
  column: string;
  definition: string;
}> = [
  {
    table: "collections",
    column: "document_count",
    definition: "INTEGER NOT NULL DEFAULT 0",
  },
  { table: "collections", column: "metadata_json", definition: "TEXT" },
  {
    table: "documents",
    column: "schema_version",
    definition: "INTEGER NOT NULL DEFAULT 1",
  },
  { table: "events", column: "idempotency_key", definition: "TEXT" },
  {
    table: "events",
    column: "schema_version",
    definition: "INTEGER NOT NULL DEFAULT 1",
  },
  { table: "schemas", column: "metadata_json", definition: "TEXT" },
  {
    table: "schemas",
    column: "is_active",
    definition: "INTEGER NOT NULL DEFAULT 0",
  },
];

interface PragmaColumnInfoRow {
  name: string;
}

/**
 * Walks every legacy column migration and adds any missing column.
 *
 * Safe to call repeatedly. Skips quietly if the host table is also missing
 * (i.e. brand-new install where the DDL is still about to be applied).
 *
 * Works against any `SqliteGateway` that speaks `PRAGMA table_info(...)`,
 * which covers better-sqlite3, bun:sqlite, Cloudflare D1, and libSQL.
 */
export async function applyLegacyColumnMigrations(
  gateway: SqliteGateway,
): Promise<void> {
  for (const migration of LEGACY_COLUMN_MIGRATIONS) {
    const columns = await gateway
      .all<PragmaColumnInfoRow>(`PRAGMA table_info(${migration.table})`)
      .catch(() => [] as PragmaColumnInfoRow[]);

    if (columns.length === 0) {
      // Table doesn't exist yet (fresh install). Nothing to migrate; the
      // DDL pass will create the table with all current columns.
      continue;
    }

    if (columns.some((current) => current.name === migration.column)) {
      continue;
    }

    await gateway.exec(
      `ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.definition}`,
    );
  }
}
