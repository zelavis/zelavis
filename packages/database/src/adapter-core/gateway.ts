/**
 * Thin SQLite-flavored gateway every adapter implements. The shared driver
 * factory builds the full `DatabaseDriver` on top of this interface, so
 * adapters only have to translate their underlying client (better-sqlite3,
 * bun:sqlite, Cloudflare D1, libSQL, ...) into these four primitives.
 */
export interface SqliteGateway {
  /** Run a SELECT statement and return all rows. */
  all<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]>;

  /** Run a SELECT statement and return the first row (or undefined). */
  get<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T | undefined>;

  /** Run a mutating statement (INSERT/UPDATE/DELETE) and report changes. */
  run(
    sql: string,
    params?: readonly unknown[],
  ): Promise<GatewayRunResult>;

  /**
   * Execute one or more raw SQL statements without parameters. Used for
   * one-shot DDL during driver setup.
   */
  exec(sql: string): Promise<void>;

  /**
   * Run `fn` inside a transaction. The supplied `tx` gateway routes through
   * the open transaction so nested calls share atomicity. If the function
   * throws, the underlying driver must roll back.
   *
   * Implementations that cannot offer real transactions (e.g. Cloudflare D1
   * without `batch()`) should still preserve the call semantics — they just
   * fall back to sequential execution.
   */
  transaction<T>(fn: (tx: SqliteGateway) => Promise<T>): Promise<T>;

  /**
   * Optional bulk-statement entry point. When provided, the shared driver
   * uses it for performance-critical batch inserts (e.g. time-series append).
   * Drivers backed by Cloudflare D1's `batch()` or libSQL's `batch()` should
   * implement this.
   */
  batch?(
    statements: readonly { sql: string; params?: readonly unknown[] }[],
  ): Promise<void>;
}

export interface GatewayRunResult {
  changes: number;
  lastInsertRowid: number;
}
