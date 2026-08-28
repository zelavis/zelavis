import type {
  DatabaseDriver,
  DatabaseSchemaStorageDriver,
  DatabaseTimeSeriesStorageDriver,
} from "../contracts/driver.js";
import type { StoredCollectionSchema } from "../schema/index.js";
import {
  decodeDatabaseEventCursor,
  encodeDatabaseEventCursor,
} from "../contracts/events.js";
import { defineDatabaseDriver } from "../core/define-database-driver.js";
import {
  DatabaseTopologyError,
  type DatabaseTopologySnapshot,
  type PhysicalShardId,
} from "./contracts.js";
import { createDatabaseTopologyRouter } from "./router.js";

export interface CreateShardedDatabaseDriverOptions {
  readonly topology: DatabaseTopologySnapshot;
  readonly physicalDrivers:
    | ReadonlyMap<PhysicalShardId, DatabaseDriver>
    | Readonly<Record<string, DatabaseDriver>>;
}

function driverEntries(
  input: CreateShardedDatabaseDriverOptions["physicalDrivers"],
): readonly (readonly [string, DatabaseDriver])[] {
  return input instanceof Map
    ? [...input.entries()]
    : Object.entries(input);
}

function schemaKey(schema: StoredCollectionSchema): string {
  return `${schema.collection}\u001f${schema.version}`;
}

function sameSchema(
  left: StoredCollectionSchema,
  right: StoredCollectionSchema,
): boolean {
  return (
    left.collection === right.collection &&
    left.version === right.version &&
    left.active === right.active &&
    JSON.stringify(left.fields) === JSON.stringify(right.fields)
  );
}

/**
 * Builds one logical database driver over explicitly placed physical drivers.
 *
 * Tenant-scoped operations always pass through the topology router. The
 * physical driver map is captured privately and is never exposed through the
 * returned `DatabaseDriver`.
 */
export function createShardedDatabaseDriver(
  options: CreateShardedDatabaseDriverOptions,
): DatabaseDriver {
  const router = createDatabaseTopologyRouter(options.topology);
  const drivers = new Map<string, DatabaseDriver>(
    driverEntries(options.physicalDrivers),
  );

  for (const shard of router.topology.desired.physicalShards) {
    if (!drivers.has(shard.id)) {
      throw new DatabaseTopologyError(
        `Physical shard ${shard.id} has no database engine driver.`,
      );
    }
  }
  for (const shardId of drivers.keys()) {
    if (
      !router.topology.desired.physicalShards.some(
        (shard) => shard.id === shardId,
      )
    ) {
      throw new DatabaseTopologyError(
        `Database engine driver ${shardId} has no physical shard definition.`,
      );
    }
  }

  function physicalDriver(
    tenantId: string,
    intent: "read" | "write",
  ): DatabaseDriver {
    const route = router.route({ tenantId, intent });
    const driver = drivers.get(route.physicalShardId);
    if (!driver) {
      throw new DatabaseTopologyError(
        `Physical shard ${route.physicalShardId} has no database engine driver.`,
      );
    }
    return driver;
  }

  const allDrivers = [...drivers.values()];
  const allSchemaDrivers = allDrivers.map((driver) => driver.schemas);
  const schemas: DatabaseSchemaStorageDriver | undefined = allSchemaDrivers.every(
    (driver): driver is DatabaseSchemaStorageDriver => driver !== undefined,
  )
    ? {
        async list() {
          const merged = new Map<string, StoredCollectionSchema>();
          for (const storage of allSchemaDrivers) {
            for (const schema of await storage.list()) {
              const key = schemaKey(schema);
              const current = merged.get(key);
              if (current && !sameSchema(current, schema)) {
                throw new DatabaseTopologyError(
                  `Schema ${schema.collection}@${schema.version} differs across physical shards.`,
                );
              }
              merged.set(key, schema);
            }
          }
          return [...merged.values()].sort((left, right) => {
            const collection = left.collection.localeCompare(right.collection);
            return collection === 0 ? left.version - right.version : collection;
          });
        },
        async save(schema) {
          for (const storage of allSchemaDrivers) {
            await storage.save(schema);
          }
        },
        async activate(collection, version) {
          for (const storage of allSchemaDrivers) {
            await storage.activate(collection, version);
          }
        },
      }
    : undefined;

  const allTimeSeriesDrivers = allDrivers.map((driver) => driver.timeseries);
  const hasTimeSeries = allTimeSeriesDrivers.every(
    (driver): driver is DatabaseTimeSeriesStorageDriver => driver !== undefined,
  );
  const timeseries: DatabaseTimeSeriesStorageDriver | undefined = hasTimeSeries
    ? {
        getState(input) {
          const driver = physicalDriver(input.tenantId, "read").timeseries;
          if (!driver) throw new DatabaseTopologyError("Time series driver is unavailable.");
          return driver.getState(input);
        },
        reset(input) {
          const driver = physicalDriver(input.tenantId, "write").timeseries;
          if (!driver) throw new DatabaseTopologyError("Time series driver is unavailable.");
          return driver.reset(input);
        },
        append(input) {
          const driver = physicalDriver(input.tenantId, "write").timeseries;
          if (!driver) throw new DatabaseTopologyError("Time series driver is unavailable.");
          return driver.append(input);
        },
        range(input) {
          const driver = physicalDriver(input.tenantId, "read").timeseries;
          if (!driver) throw new DatabaseTopologyError("Time series driver is unavailable.");
          return driver.range(input);
        },
        aggregate(input) {
          const driver = physicalDriver(input.tenantId, "read").timeseries;
          if (!driver) throw new DatabaseTopologyError("Time series driver is unavailable.");
          return driver.aggregate(input);
        },
      }
    : undefined;

  return defineDatabaseDriver({
    name: `zelavis-sharded(${[...new Set(allDrivers.map((driver) => driver.name))].join(",")})`,
    capabilities: {
      documents: true,
      events: true,
      transactions: allDrivers.every(
        (driver) => driver.capabilities.transactions,
      ),
      tenantRouting: true,
    },
    events: {
      async append(input) {
        const route = router.route({ tenantId: input.tenantId, intent: "write" });
        const driver = drivers.get(route.physicalShardId);
        if (!driver) {
          throw new DatabaseTopologyError(
            `Physical shard ${route.physicalShardId} has no database engine driver.`,
          );
        }
        const event = await driver.events.append(input);
        const position = decodeDatabaseEventCursor(event.cursor).position;
        return {
          ...event,
          cursor: encodeDatabaseEventCursor(position, route.virtualShardId),
        };
      },
      async restore(input) {
        const route = router.route({ tenantId: input.tenantId, intent: "write" });
        const driver = drivers.get(route.physicalShardId);
        if (!driver?.events.restore) {
          throw new DatabaseTopologyError(
            `Physical shard ${route.physicalShardId} cannot restore exact database events.`,
          );
        }
        const event = await driver.events.restore(input);
        const position = decodeDatabaseEventCursor(event.cursor).position;
        return {
          ...event,
          cursor: encodeDatabaseEventCursor(position, route.virtualShardId),
        };
      },
      async read(input) {
        const route = router.route({ tenantId: input.tenantId, intent: "read" });
        const driver = drivers.get(route.physicalShardId);
        if (!driver) {
          throw new DatabaseTopologyError(
            `Physical shard ${route.physicalShardId} has no database engine driver.`,
          );
        }

        const decodedAfter = input.after
          ? decodeDatabaseEventCursor(input.after)
          : undefined;
        if (
          decodedAfter?.virtualShardId &&
          decodedAfter.virtualShardId !== route.virtualShardId
        ) {
          throw new DatabaseTopologyError(
            `Event cursor belongs to virtual shard ${decodedAfter.virtualShardId}, not ${route.virtualShardId}.`,
          );
        }

        const events = await driver.events.read({
          ...input,
          after: decodedAfter
            ? encodeDatabaseEventCursor(decodedAfter.position)
            : undefined,
        });
        return events.map((event) => ({
          ...event,
          cursor: encodeDatabaseEventCursor(
            decodeDatabaseEventCursor(event.cursor).position,
            route.virtualShardId,
          ),
        }));
      },
    },
    projections: {
      getCollection(input) {
        return physicalDriver(input.tenantId, "read").projections.getCollection(
          input,
        );
      },
      listCollections(input) {
        return physicalDriver(input.tenantId, "read").projections.listCollections(
          input,
        );
      },
      collectionExists(input) {
        return physicalDriver(
          input.tenantId,
          "read",
        ).projections.collectionExists(input);
      },
      findDocumentById(input) {
        return physicalDriver(
          input.tenantId,
          "read",
        ).projections.findDocumentById(input);
      },
      findDocuments(input) {
        return physicalDriver(input.tenantId, "read").projections.findDocuments(
          input,
        );
      },
    },
    schemas,
    timeseries,
  });
}
