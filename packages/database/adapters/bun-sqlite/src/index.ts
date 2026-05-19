import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  applySqliteCompatibleSchema,
  createDatabase,
  createSqliteCompatibleDriver,
  type CreateDatabaseOptions,
  type DatabaseDriver,
  type GatewayRunResult,
  type SqliteGateway,
  type SqlParameter,
} from "@zelavis/database";

type BunSqliteDatabase = Database;

export interface BunSqliteDriverOptions {
  filename: string;
  readonly?: boolean;
  create?: boolean;
  readwrite?: boolean;
  safeIntegers?: boolean;
  strict?: boolean;
  defaultTenantId?: string;
  pragma?: readonly string[];
}

export interface BunSqliteDatabaseOptions
  extends Omit<CreateDatabaseOptions, "driver" | "defaultTenantId">,
    BunSqliteDriverOptions {}

function normalizeFilename(filename: string): string {
  return filename === ":memory:" ? filename : resolve(filename);
}

function ensureParentDirectory(filename: string): void {
  if (filename === ":memory:") {
    return;
  }
  mkdirSync(dirname(filename), { recursive: true });
}

function buildDatabaseOptions(
  options: BunSqliteDriverOptions,
): ConstructorParameters<typeof Database>[1] | undefined {
  // bun:sqlite requires at least one mode flag (SQLITE_OPEN_READONLY or
  // SQLITE_OPEN_READWRITE) when an options object is provided. If the caller
  // did not opt into any flags, drop the second argument entirely so
  // bun:sqlite falls back to its defaults (readwrite + create).
  const flags: Record<string, unknown> = {};
  if (options.readonly !== undefined) flags.readonly = options.readonly;
  if (options.create !== undefined) flags.create = options.create;
  if (options.readwrite !== undefined) flags.readwrite = options.readwrite;
  if (options.safeIntegers !== undefined)
    flags.safeIntegers = options.safeIntegers;
  if (options.strict !== undefined) flags.strict = options.strict;
  return Object.keys(flags).length === 0
    ? undefined
    : (flags as ConstructorParameters<typeof Database>[1]);
}

function applyPragmas(
  database: BunSqliteDatabase,
  options: BunSqliteDriverOptions,
): void {
  const pragmas = options.pragma ?? ["journal_mode = WAL", "foreign_keys = ON"];
  for (const pragma of pragmas) {
    database.exec(`PRAGMA ${pragma}`);
  }
}

function toBindParameter(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  return value;
}

function fromRowValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value;
}

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, fromRowValue(value)]),
  );
}

/**
 * bun:sqlite is synchronous like better-sqlite3, but its sync `db.transaction`
 * wrapper can't host async user code. We use explicit BEGIN/COMMIT statements
 * so the shared driver's async transaction contract composes naturally.
 */
function createGateway(database: BunSqliteDatabase): SqliteGateway {
  let inTransaction = false;

  const gateway: SqliteGateway = {
    async all<T = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      const statement = database.query(sql);
      const rows = statement.all(
        ...(params ?? []).map(toBindParameter),
      ) as Record<string, unknown>[];
      return rows.map((row) => mapRow(row)) as T[];
    },

    async get<T = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T | undefined> {
      const statement = database.query(sql);
      const row = statement.get(
        ...(params ?? []).map(toBindParameter),
      ) as Record<string, unknown> | null;
      return row ? (mapRow(row) as T) : undefined;
    },

    async run(
      sql: string,
      params?: readonly unknown[],
    ): Promise<GatewayRunResult> {
      const statement = database.query(sql);
      const result = statement.run(...(params ?? []).map(toBindParameter));
      return {
        changes: result.changes,
        lastInsertRowid:
          typeof result.lastInsertRowid === "bigint"
            ? Number(result.lastInsertRowid)
            : result.lastInsertRowid,
      };
    },

    async exec(sql: string): Promise<void> {
      database.exec(sql);
    },

    async transaction<T>(fn: (tx: SqliteGateway) => Promise<T>): Promise<T> {
      if (inTransaction) {
        return fn(gateway);
      }

      inTransaction = true;
      database.exec("BEGIN");
      try {
        const result = await fn(gateway);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Surface the original error if ROLLBACK fails.
        }
        throw error;
      } finally {
        inTransaction = false;
      }
    },
  };

  return gateway;
}

export function createBunSqliteDatabaseDriver(
  options: BunSqliteDriverOptions,
): DatabaseDriver {
  const filename = normalizeFilename(options.filename);
  ensureParentDirectory(filename);

  const database = new Database(filename, buildDatabaseOptions(options));
  applyPragmas(database, options);

  const gateway = createGateway(database);
  const schemaReady = applySqliteCompatibleSchema(gateway);

  return createSqliteCompatibleDriver({
    name: "bun-sqlite",
    gateway,
    toSqlParameter: (parameter: SqlParameter) => toBindParameter(parameter),
    fromSqlValue: fromRowValue,
    ready: () => schemaReady,
  });
}

export async function createBunSqliteDatabase(
  options: BunSqliteDatabaseOptions,
) {
  return createDatabase({
    ...options,
    defaultTenantId: options.defaultTenantId,
    driver: createBunSqliteDatabaseDriver(options),
  });
}
