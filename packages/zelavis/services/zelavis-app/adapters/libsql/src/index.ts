import {
  createClient,
  type Client as LibsqlClient,
  type Config as LibsqlConfig,
  type InArgs,
  type InValue,
  type ResultSet,
  type Transaction as LibsqlTransaction,
} from "@libsql/client";
import {
  applySqliteCompatibleSchema,
  createDatabase,
  createSqliteCompatibleDriver,
  type CreateDatabaseOptions,
  type DatabaseDriver,
  type GatewayRunResult,
  type SqliteGateway,
  type SqlParameter,
} from "@zelavis/app/db";

export interface LibsqlDriverOptions extends LibsqlConfig {
  defaultTenantId?: string;
}

export interface LibsqlDatabaseOptions
  extends Omit<CreateDatabaseOptions, "driver" | "defaultTenantId">,
    LibsqlDriverOptions {}

interface LibsqlExecutor {
  execute(
    statement: string | { sql: string; args?: InArgs },
    args?: InArgs,
  ): Promise<ResultSet>;
}

function normalizeArgs(params?: readonly unknown[]): InArgs | undefined {
  if (!params || params.length === 0) {
    return undefined;
  }
  const args: InValue[] = params.map((value) =>
    value === undefined ? null : (value as InValue),
  );
  return args;
}

function rowsFromResult(result: ResultSet): Record<string, unknown>[] {
  return result.rows.map((row) => {
    const entries: Record<string, unknown> = {};
    for (const column of result.columns) {
      entries[column] = (row as unknown as Record<string, unknown>)[column];
    }
    return entries;
  });
}

function runResultFromResult(result: ResultSet): GatewayRunResult {
  return {
    changes: Number(result.rowsAffected ?? 0),
    lastInsertRowid: result.lastInsertRowid
      ? Number(result.lastInsertRowid)
      : 0,
  };
}

function makeExecutorGateway(executor: LibsqlExecutor): SqliteGateway {
  const gateway: SqliteGateway = {
    async all<T = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      const args = normalizeArgs(params);
      const result = await (args
        ? executor.execute({ sql, args })
        : executor.execute(sql));
      return rowsFromResult(result) as T[];
    },

    async get<T = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T | undefined> {
      const rows = await gateway.all<T>(sql, params);
      return rows[0];
    },

    async run(
      sql: string,
      params?: readonly unknown[],
    ): Promise<GatewayRunResult> {
      const args = normalizeArgs(params);
      const result = await (args
        ? executor.execute({ sql, args })
        : executor.execute(sql));
      return runResultFromResult(result);
    },

    async exec(sql: string): Promise<void> {
      await executor.execute(sql);
    },

    async transaction<T>(fn: (tx: SqliteGateway) => Promise<T>): Promise<T> {
      // Inside an already-open libSQL transaction we just run the inner body
      // through the same executor — libSQL doesn't expose SAVEPOINT.
      return fn(gateway);
    },
  };

  return gateway;
}

function createGateway(client: LibsqlClient): SqliteGateway {
  const base = makeExecutorGateway(client);

  return {
    ...base,
    async transaction<T>(fn: (tx: SqliteGateway) => Promise<T>): Promise<T> {
      const transaction: LibsqlTransaction = await client.transaction("write");
      try {
        const innerGateway = makeExecutorGateway(transaction);
        const result = await fn(innerGateway);
        await transaction.commit();
        return result;
      } catch (error) {
        try {
          await transaction.rollback();
        } catch {
          // Surface the original error if rollback fails.
        }
        throw error;
      }
    },
    async batch(
      statements: readonly { sql: string; params?: readonly unknown[] }[],
    ): Promise<void> {
      if (statements.length === 0) {
        return;
      }
      await client.batch(
        statements.map((entry) => {
          const args = normalizeArgs(entry.params);
          return args ? { sql: entry.sql, args } : { sql: entry.sql };
        }),
        "write",
      );
    },
  };
}

export function createLibsqlDatabaseDriver(
  options: LibsqlDriverOptions,
): DatabaseDriver {
  const { defaultTenantId: _defaultTenantId, ...libsqlConfig } = options;
  const client = createClient(libsqlConfig);

  const gateway = createGateway(client);
  const schemaReady = applySqliteCompatibleSchema(gateway);

  return createSqliteCompatibleDriver({
    name: "libsql",
    defaultNodeId: "libsql",
    gateway,
    toSqlParameter: (parameter: SqlParameter) =>
      parameter === undefined ? null : parameter,
    fromSqlValue: (value: unknown) =>
      typeof value === "bigint" ? Number(value) : value,
    ready: () => schemaReady,
  });
}

export async function createLibsqlDatabase(options: LibsqlDatabaseOptions) {
  return createDatabase({
    ...options,
    defaultTenantId: options.defaultTenantId,
    driver: createLibsqlDatabaseDriver(options),
  });
}
