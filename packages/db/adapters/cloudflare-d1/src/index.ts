import {
  applySqliteCompatibleSchema,
  createDatabase,
  createSqliteCompatibleDriver,
  type CreateDatabaseOptions,
  type DatabaseDriver,
  type GatewayRunResult,
  type SqliteGateway,
  type SqlParameter,
} from "@zelavis/db";

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<{
    results?: T[];
    success: boolean;
    meta?: {
      changes?: number;
      last_row_id?: number | string;
    };
  }>;
  run(): Promise<{
    success: boolean;
    meta?: {
      changes?: number;
      last_row_id?: number | string;
    };
  }>;
}

export interface CloudflareD1Database {
  prepare(statement: string): D1PreparedStatement;
  batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<T[]>;
  exec?(statement: string): Promise<unknown>;
}

export interface CloudflareD1DriverOptions {
  database: CloudflareD1Database;
}

export interface CloudflareD1DatabaseOptions
  extends Omit<CreateDatabaseOptions, "driver">,
    CloudflareD1DriverOptions {}

function normalizeParameter(value: unknown): unknown {
  return value === undefined ? null : value;
}

function buildStatement(
  database: CloudflareD1Database,
  sql: string,
  params?: readonly unknown[],
): D1PreparedStatement {
  const prepared = database.prepare(sql);
  if (params && params.length > 0) {
    return prepared.bind(...params.map(normalizeParameter));
  }
  return prepared.bind();
}

/**
 * Cloudflare D1 does not support interactive transactions; the closest
 * primitive is `database.batch()`, which runs an array of prepared
 * statements atomically. We capture statements issued inside a transaction
 * body and commit them through `batch` at the end.
 *
 * This means transactions cannot read mid-flight — calls to `all`, `get`,
 * or `run` inside the transaction body actually execute eagerly against
 * the live database (so reads still work). Writes are deferred until
 * commit, and rollback simply drops the queued writes without sending them.
 *
 * The shared driver's existing logic does reads before writes inside its
 * transactions (e.g. checking whether a document exists before deciding
 * INSERT vs UPDATE), so this model preserves correctness.
 */
function createGateway(database: CloudflareD1Database): SqliteGateway {
  function makeBaseGateway(): SqliteGateway {
    const base: SqliteGateway = {
      async all<T = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ): Promise<T[]> {
        const result = await buildStatement(database, sql, params).all<
          Record<string, unknown>
        >();
        return (result.results ?? []) as T[];
      },

      async get<T = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ): Promise<T | undefined> {
        const rows = await base.all<T>(sql, params);
        return rows[0];
      },

      async run(
        sql: string,
        params?: readonly unknown[],
      ): Promise<GatewayRunResult> {
        const result = await buildStatement(database, sql, params).run();
        return {
          changes: Number(result.meta?.changes ?? 0),
          lastInsertRowid: Number(result.meta?.last_row_id ?? 0),
        };
      },

      async exec(sql: string): Promise<void> {
        await buildStatement(database, sql).run();
      },

      async transaction<T>(fn: (tx: SqliteGateway) => Promise<T>): Promise<T> {
        // Collect writes; reads pass through eagerly.
        const queued: { sql: string; params: unknown[] }[] = [];

        const tx: SqliteGateway = {
          all: base.all,
          get: base.get,
          async run(
            sql: string,
            params?: readonly unknown[],
          ): Promise<GatewayRunResult> {
            queued.push({ sql, params: [...(params ?? [])] });
            // We can't know the result of a deferred write up front. Return
            // a zeroed result; callers that rely on `lastInsertRowid` for the
            // events table are handled in the shared driver by re-reading
            // the sequence separately when needed.
            return { changes: 1, lastInsertRowid: 0 };
          },
          async exec(sql: string): Promise<void> {
            queued.push({ sql, params: [] });
          },
          async transaction<U>(
            inner: (innerTx: SqliteGateway) => Promise<U>,
          ): Promise<U> {
            return inner(tx);
          },
        };

        const result = await fn(tx);

        if (queued.length > 0) {
          await database.batch(
            queued.map(({ sql, params }) =>
              buildStatement(database, sql, params),
            ),
          );
        }

        return result;
      },

      async batch(
        statements: readonly { sql: string; params?: readonly unknown[] }[],
      ): Promise<void> {
        if (statements.length === 0) {
          return;
        }
        await database.batch(
          statements.map((entry) =>
            buildStatement(database, entry.sql, entry.params),
          ),
        );
      },
    };

    return base;
  }

  return makeBaseGateway();
}

export function createCloudflareD1DatabaseDriver(
  options: CloudflareD1DriverOptions,
): DatabaseDriver {
  const gateway = createGateway(options.database);
  const schemaReady = applySqliteCompatibleSchema(gateway);

  return createSqliteCompatibleDriver({
    name: "cloudflare-d1",
    defaultNodeId: "cloudflare",
    gateway,
    toSqlParameter: (parameter: SqlParameter) => normalizeParameter(parameter),
    fromSqlValue: (value: unknown) => value,
    ready: () => schemaReady,
  });
}

export async function createCloudflareD1Database(
  options: CloudflareD1DatabaseOptions,
) {
  return createDatabase({
    ...options,
    defaultTenantId: options.defaultTenantId,
    driver: createCloudflareD1DatabaseDriver(options),
  });
}
