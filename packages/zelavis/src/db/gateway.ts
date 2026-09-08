/**
 * A prepared statement, in the shape both SQLite bindings already expose.
 *
 * Deliberately structural rather than a wrapper: `node:sqlite` and `libsql`
 * agree on these four methods, so a driver hands over the handle itself instead
 * of an adapter object that has to be kept in step with two APIs.
 */
export interface GatewayStatement {
  get(...params: ReadonlyArray<unknown>): unknown;
  all(...params: ReadonlyArray<unknown>): ReadonlyArray<unknown>;
  run(...params: ReadonlyArray<unknown>): unknown;
  /**
   * Row-at-a-time.
   *
   * In the interface rather than left to `all` because postings stream into a
   * bitmap without ever becoming an array — which is what stopped a wide
   * predicate costing more than the answer it produced.
   */
  iterate(...params: ReadonlyArray<unknown>): Iterable<unknown>;
}

/**
 * The handle a store talks to.
 *
 * Synchronous on purpose. An asynchronous gateway would let two transactions
 * interleave on one connection, and a `BEGIN` another caller can write inside is
 * not a transaction. An engine whose only binding is asynchronous needs that
 * serialization solved first, and it is not solved by a flag.
 */
export interface StoreGateway {
  prepare(sql: string): GatewayStatement;
  exec(sql: string): void;
  close(): void;
}
