import { Effect, Stream, type Scope } from "effect";
import { StoreError } from "../errors.js";
import { scanRange, type KvEngine, type KvEntry, type KvWrite } from "../kv.js";
import { openStoreOverKv } from "../kv-store.js";
import type { PartitionKey } from "../model.js";
import type { ObjectStoreApi } from "../store.js";

/**
 * The subset of `@libsql/client` this driver uses.
 *
 * Declared rather than imported, so the package stays an optional peer: an
 * installation that never talks to a remote database should not have to have
 * it present for `zelavis` to typecheck or run.
 */
interface RemoteClient {
  execute: (statement: { sql: string; args: ReadonlyArray<unknown> } | string) => Promise<{
    rows: ReadonlyArray<Record<string, unknown>>;
  }>;
  batch: (
    statements: ReadonlyArray<{ sql: string; args: ReadonlyArray<unknown> }>,
    mode?: "write" | "read" | "deferred",
  ) => Promise<unknown>;
  close: () => void;
}

export interface LibsqlRemoteStoreOptions {
  /**
   * The database's address. `turso://` is accepted for the address Turso
   * prints, and means the same as `libsql://`.
   */
  readonly url: string;
  readonly authToken?: string;
}

/** Blobs arrive as `ArrayBuffer` here, where the synchronous binding hands back a `Buffer`. */
const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new TypeError(`Expected a blob from libSQL, got ${typeof value}.`);
};

const loadClient = Effect.tryPromise({
  try: async () => {
    const mod = (await import("@libsql/client")) as unknown as {
      createClient: (options: { url: string; authToken?: string }) => RemoteClient;
    };
    return mod.createClient;
  },
  catch: (cause) =>
    new StoreError({
      op: "libsql-remote.load",
      cause: new Error(
        "The remote libSQL driver needs the optional `@libsql/client` package installed. " +
          `Install it alongside zelavis to use this engine. Cause: ${String(cause)}`,
      ),
    }),
});

/**
 * A key-value engine over a database reachable only across the network.
 *
 * Written against `KvEngine` directly rather than the shared SQLite layer,
 * which needs a synchronous handle a network client cannot give. Nothing above
 * it changes: the contract is already `Effect`-shaped, and it defines a write
 * as one atomic batch — which is exactly what the client's `batch` in write
 * mode is, so there is no open transaction for another caller to land inside.
 *
 * Every round trip is a network hop, so this engine is for a database that has
 * to live elsewhere, not for one that could live on the node. An embedded
 * replica — the `libsql` engine with a `syncUrl` — keeps reads local and is the
 * better answer whenever a local file is possible.
 */
export const makeLibsqlRemoteEngine = (
  partition: PartitionKey,
  options: LibsqlRemoteStoreOptions,
): Effect.Effect<KvEngine, StoreError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.flatMap(loadClient, (createClient) =>
      Effect.gen(function* () {
        const url = options.url.replace(/^turso:\/\//, "libsql://");
        const table = `kv_${partition.replace(/[^A-Za-z0-9_]/g, "_")}`;
        const client = yield* Effect.try({
          try: () =>
            createClient({ url, ...(options.authToken === undefined ? {} : { authToken: options.authToken }) }),
          catch: (cause) => new StoreError({ op: "libsql-remote.open", cause }),
        });
        const fail = (op: string) => (cause: unknown) => new StoreError({ op, cause });
        // One table per partition, because a remote database is one database
        // however many shards point at it.
        yield* Effect.tryPromise({
          try: () =>
            client.execute(
              `CREATE TABLE IF NOT EXISTS ${table} (key BLOB PRIMARY KEY, value BLOB NOT NULL)`,
            ),
          catch: fail("libsql-remote.open"),
        });

        const engine: KvEngine = {
          get: (key) =>
            Effect.map(
              Effect.tryPromise({
                try: () =>
                  client.execute({ sql: `SELECT value FROM ${table} WHERE key = ?`, args: [key] }),
                catch: fail("libsql-remote.get"),
              }),
              (result) => (result.rows[0] === undefined ? undefined : toBytes(result.rows[0].value)),
            ),

          scan: (prefix, scanOptions) =>
            Stream.fromIterableEffect(
              Effect.tryPromise({
                try: async () => {
                  const { lo, hi, empty } = scanRange(prefix, scanOptions);
                  const limit = scanOptions?.limit;
                  if (empty || limit === 0) return [] as Array<KvEntry>;
                  const order = scanOptions?.reverse === true ? "DESC" : "ASC";
                  // The bounds and the limit go into the statement: a page of a
                  // scan should cost one round trip and the rows it returns.
                  const sql = hi === undefined
                    ? `SELECT key, value FROM ${table} WHERE key >= ? ORDER BY key ${order} LIMIT ?`
                    : `SELECT key, value FROM ${table} WHERE key >= ? AND key < ? ORDER BY key ${order} LIMIT ?`;
                  const args = hi === undefined ? [lo, limit ?? -1] : [lo, hi, limit ?? -1];
                  const result = await client.execute({ sql, args });
                  return result.rows.map((row): KvEntry => ({
                    key: toBytes(row.key),
                    value: toBytes(row.value),
                  }));
                },
                catch: fail("libsql-remote.scan"),
              }),
            ),

          write: (writes: ReadonlyArray<KvWrite>) =>
            Effect.tryPromise({
              try: async () => {
                if (writes.length === 0) return;
                // One batch in write mode: every statement lands or none does,
                // which is the whole transaction mechanism this contract asks for.
                await client.batch(
                  writes.map((write) =>
                    write.op === "put"
                      ? {
                        sql: `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                        args: [write.key, write.value],
                      }
                      : { sql: `DELETE FROM ${table} WHERE key = ?`, args: [write.key] }),
                  "write",
                );
              },
              catch: fail("libsql-remote.write"),
            }),

          close: Effect.sync(() => client.close()),
        };
        return engine;
      })),
    (engine) => Effect.orDie(engine.close),
  );

/**
 * A store on a remote libSQL database, over the same logic every engine runs.
 *
 * Reads and writes cross the network, so the cost of a query is its round
 * trips rather than its keys. Sealing matters more here than anywhere else: a
 * wide posting list read as one blob is one hop, where the same list read as
 * keys is a hop per page.
 */
export const makeLibsqlRemoteStore = (
  partition: PartitionKey,
  options: LibsqlRemoteStoreOptions,
): Effect.Effect<ObjectStoreApi, StoreError, Scope.Scope> =>
  Effect.flatMap(makeLibsqlRemoteEngine(partition, options), (engine) =>
    openStoreOverKv(partition, engine));
