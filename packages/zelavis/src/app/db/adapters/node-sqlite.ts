import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  applySqliteCompatibleSchema,
  createDatabase,
  createSqliteCompatibleDriver,
  type CreateDatabaseOptions,
  type DatabaseDriver,
  type GatewayRunResult,
  type SqliteGateway,
  type SqlParameter,
} from "../index.js";

type BetterSqlite3Database = InstanceType<typeof Database>;

export interface BetterSqlite3DriverOptions {
  filename: string;
  readonly?: boolean;
  fileMustExist?: boolean;
  pragma?: readonly string[];
}

export interface BetterSqlite3DatabaseOptions
  extends Omit<CreateDatabaseOptions, "driver">,
    BetterSqlite3DriverOptions {}

function normalizeFilename(filename: string): string {
  return filename === ":memory:" ? filename : resolve(filename);
}

function ensureParentDirectory(filename: string): void {
  if (filename === ":memory:") {
    return;
  }
  mkdirSync(dirname(filename), { recursive: true });
}

function applyPragmas(
  database: BetterSqlite3Database,
  options: BetterSqlite3DriverOptions,
): void {
  const pragmas = options.pragma ?? ["journal_mode = WAL", "foreign_keys = ON"];
  for (const pragma of pragmas) {
    database.pragma(pragma);
  }
}

function toBindParameter(value: unknown): unknown {
  return value instanceof Uint8Array ? Buffer.from(value) : value;
}

function fromRowValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
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
 * Better-sqlite3 ships a synchronous `db.transaction(fn)` helper that can
 * only call sync code, while our shared driver expects an async transaction
 * contract. We use plain BEGIN/COMMIT statements instead — they're regular
 * SQLite statements, so they compose cleanly with the async gateway API.
 *
 * Re-entrancy isn't supported (no SAVEPOINT nesting); the shared driver
 * never opens nested transactions.
 */
function createGateway(database: BetterSqlite3Database): SqliteGateway {
  let inTransaction = false;

  const gateway: SqliteGateway = {
    async all<T = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      const statement = database.prepare(sql);
      const rows = statement.all(
        ...(params ?? []).map(toBindParameter),
      ) as Record<string, unknown>[];
      return rows.map((row) => mapRow(row)) as T[];
    },

    async get<T = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T | undefined> {
      const statement = database.prepare(sql);
      const row = statement.get(
        ...(params ?? []).map(toBindParameter),
      ) as Record<string, unknown> | undefined;
      return row ? (mapRow(row) as T) : undefined;
    },

    async run(
      sql: string,
      params?: readonly unknown[],
    ): Promise<GatewayRunResult> {
      const statement = database.prepare(sql);
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
        // Already inside an outer transaction — just run the body sequentially.
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
          // Ignore rollback failures; surface the original error.
        }
        throw error;
      } finally {
        inTransaction = false;
      }
    },
  };

  return gateway;
}

export function createBetterSqlite3DatabaseDriver(
  options: BetterSqlite3DriverOptions,
): DatabaseDriver {
  const filename = normalizeFilename(options.filename);
  ensureParentDirectory(filename);

  const database = new Database(filename, {
    ...(options.readonly === undefined ? {} : { readonly: options.readonly }),
    ...(options.fileMustExist === undefined
      ? {}
      : { fileMustExist: options.fileMustExist }),
  });

  applyPragmas(database, options);

  const gateway = createGateway(database);
  const schemaReady = applySqliteCompatibleSchema(gateway);

  return createSqliteCompatibleDriver({
    name: "better-sqlite3",
    gateway,
    toSqlParameter: (parameter: SqlParameter) => toBindParameter(parameter),
    fromSqlValue: fromRowValue,
    ready: () => schemaReady,
  });
}

export async function createBetterSqlite3Database(
  options: BetterSqlite3DatabaseOptions,
) {
  return createDatabase({
    ...options,
    driver: createBetterSqlite3DatabaseDriver(options),
  });
}
