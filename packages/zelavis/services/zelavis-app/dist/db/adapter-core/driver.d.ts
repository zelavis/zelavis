import type { DatabaseDriver } from "../contracts/driver.js";
import type { SqlParameter } from "../contracts/sql.js";
import type { SqliteGateway } from "./gateway.js";
export interface CreateSqliteCompatibleDriverOptions {
    /** Reported as `DatabaseDriver.name` (e.g. "better-sqlite3"). */
    name: string;
    /** Default node id stamped on events when callers don't supply one. */
    defaultNodeId?: string;
    /** Gateway translating to the underlying SQLite-compatible client. */
    gateway: SqliteGateway;
    /**
     * Adapter-specific coercion for raw SQL parameters. Used by the
     * `SqlDatabase` pass-through (`driver.sql.query` / `driver.sql.execute`).
     * Defaults to a pass-through.
     */
    toSqlParameter?: (parameter: SqlParameter) => unknown;
    /**
     * Adapter-specific coercion for raw SQL row values. Used by the
     * `SqlDatabase` pass-through. Defaults to returning the value unchanged.
     */
    fromSqlValue?: (value: unknown) => unknown;
    /**
     * Optional async hook the driver awaits before each operation. Useful for
     * adapters such as libSQL that initialise their schema lazily.
     */
    ready?: () => Promise<void>;
}
/**
 * Extracts the target table name from a SQL write statement (DML + destructive
 * DDL). Returns null for read-only statements or unrecognised syntax.
 *
 * Handles both double-quoted identifiers ("My Table") and bare identifiers,
 * and optional schema prefixes (schema.table / "schema"."table").
 */
export declare function parseWriteTargetTable(statement: string): string | null;
/**
 * Applies the shared DDL to a gateway. Uses `gateway.batch` when available
 * (for example libSQL) and falls back to per-statement `exec` otherwise.
 */
export declare function applySqliteCompatibleSchema(gateway: SqliteGateway): Promise<void>;
/**
 * Builds a complete `DatabaseDriver` on top of any `SqliteGateway`.
 *
 * All event, projection, schema, and time-series logic lives here so that
 * every SQLite-compatible adapter (better-sqlite3, bun:sqlite, libSQL) gets
 * identical behaviour with only ~50 lines of glue code.
 */
export declare function createSqliteCompatibleDriver(options: CreateSqliteCompatibleDriverOptions): DatabaseDriver;
