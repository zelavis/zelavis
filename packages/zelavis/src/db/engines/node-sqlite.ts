import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer, LayerMap, type Scope } from "effect";
import { StoreError } from "../errors.js";
import type { PartitionKey } from "../model.js";
import { ObjectStore, type ObjectStoreApi } from "../store.js";
import { storeOverGateway } from "../sqlite-store.js";
import type { StoreGateway } from "../gateway.js";

/** Where partition files live. Supplied by the host runtime. */
export class DbRoot extends Context.Service<DbRoot, { readonly directory: string }>()(
  "zelavis/db/DbRoot",
) {
  static readonly layer = (directory: string) =>
    Layer.effect(DbRoot, Effect.succeed({ directory }));
}

/** The built-in driver. Node's own SQLite, so it needs nothing installed. */
export const makeNodeSqliteStore = (
  partition: PartitionKey,
  directory: string,
): Effect.Effect<ObjectStoreApi, StoreError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: (): StoreGateway => {
        mkdirSync(directory, { recursive: true });
        const db = new DatabaseSync(join(directory, `${partition}.sqlite`));
        return {
          prepare: (sql: string) => db.prepare(sql),
          exec: (sql: string) => void db.exec(sql),
          close: () => db.close(),
        };
      },
      catch: (cause) => new StoreError({ op: "open", cause }),
    }),
    (gateway) => Effect.sync(() => gateway.close()),
  ).pipe(Effect.map((gateway) => storeOverGateway(partition, gateway)));

export const nodeSqliteStoreLayer = (partition: PartitionKey) =>
  Layer.effect(
    ObjectStore,
    Effect.gen(function* () {
      const root = yield* DbRoot;
      return yield* makeNodeSqliteStore(partition, root.directory);
    }),
  );

/**
 * One store per partition, opened on demand and released when idle.
 *
 * A plain cache is the wrong tool here: evicting an entry drops the handle
 * without closing it, which leaks file descriptors and, on a WAL database, is a
 * corruption risk rather than merely a leak. `LayerMap` ties each entry to a
 * scope, so eviction runs the release that actually closes the file.
 */
export class Partitions extends LayerMap.Service<Partitions>()("zelavis/db/Partitions", {
  lookup: (partition: PartitionKey) => nodeSqliteStoreLayer(partition),
  idleTimeToLive: "5 minutes",
}) {}
