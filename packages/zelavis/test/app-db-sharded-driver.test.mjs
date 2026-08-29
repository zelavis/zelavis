import assert from "node:assert/strict";
import test from "node:test";

import {
  createDatabase,
  createInMemoryDatabaseDriver,
  createOfficialLocalDatabaseTopology,
  createShardedDatabaseDriver,
  decodeDatabaseEventCursor,
  routeDatabaseTenant,
} from "../dist/app/db/index.js";

function createShardedMemoryDatabase() {
  const topology = createOfficialLocalDatabaseTopology({
    logicalDatabaseId: "test-primary",
  });
  const physicalDrivers = new Map(
    topology.desired.physicalShards.map((shard) => [
      shard.id,
      createInMemoryDatabaseDriver(),
    ]),
  );
  const driver = createShardedDatabaseDriver({ topology, physicalDrivers });
  return { topology, physicalDrivers, driver };
}

test("sharded driver routes Tenant data to its physical driver", async () => {
  const { topology, physicalDrivers, driver } = createShardedMemoryDatabase();
  const database = await createDatabase({ driver });
  const tenantIds = [];
  const physicalIds = new Set();
  for (let index = 0; index < 10_000 && physicalIds.size < 4; index += 1) {
    const tenantId = `tenant-${index}`;
    const route = routeDatabaseTenant(topology, { tenantId });
    if (!physicalIds.has(route.physicalShardId)) {
      physicalIds.add(route.physicalShardId);
      tenantIds.push(tenantId);
    }
  }
  assert.equal(tenantIds.length, 4);

  for (const tenantId of tenantIds) {
    const documents = database.forTenant(tenantId).documents;
    await documents.createCollection({ name: "notes" });
    await documents.insert({
      collection: "notes",
      id: `note-${tenantId}`,
      data: { tenantId },
    });
    const events = await database.forTenant(tenantId).events.read();
    const route = routeDatabaseTenant(topology, { tenantId });
    assert.match(events.at(-1).cursor, /^zv1:/);
    assert.equal(
      decodeDatabaseEventCursor(events.at(-1).cursor).virtualShardId,
      route.virtualShardId,
    );
  }

  for (const tenantId of tenantIds) {
    const route = routeDatabaseTenant(topology, { tenantId });
    const physical = physicalDrivers.get(route.physicalShardId);
    assert.ok(physical);
    assert.equal(
      (await physical.projections.findDocuments({
        tenantId,
        collection: "notes",
        where: [],
        orderBy: [],
        limit: 100,
        offset: 0,
      })).length,
      1,
    );
    for (const [otherShardId, otherDriver] of physicalDrivers) {
      if (otherShardId === route.physicalShardId) continue;
      assert.equal(
        await otherDriver.projections.collectionExists({
          tenantId,
          name: "notes",
        }),
        false,
      );
    }
  }

  assert.equal(Object.hasOwn(database.capabilities, "sql"), false);
  assert.equal(database.sql, undefined);
});

test("sharded driver applies logical schemas to every physical shard", async () => {
  const { physicalDrivers, driver } = createShardedMemoryDatabase();
  const database = await createDatabase({
    driver,
    schemas: [
      {
        collection: "notes",
        version: 1,
        activate: true,
        fields: [
          {
            name: "title",
            field: { _tag: "TextField", label: "Title", required: true },
          },
        ],
      },
    ],
  });

  assert.equal(database.schemas.getActive("notes")?.version, 1);
  for (const physical of physicalDrivers.values()) {
    assert.equal((await physical.schemas?.list())?.[0]?.active, true);
  }
});

test("sharded driver keeps time-series materialization Tenant-routed", async () => {
  const { topology, physicalDrivers, driver } = createShardedMemoryDatabase();
  const database = await createDatabase({ driver });
  await database.projections.register({
    name: "timeseries.metrics",
    source: { collections: ["metrics"], eventTypes: ["document.upserted"] },
  });
  await database.timeseries.define({
    name: "metrics",
    projection: "timeseries.metrics",
    source: { collections: ["metrics"], eventTypes: ["document.upserted"] },
    map(event) {
      return event.type === "document.upserted"
        ? { timestamp: event.payload.data.timestamp, value: event.payload.data.value }
        : null;
    },
  });

  const tenants = [];
  const shards = new Set();
  for (let index = 0; index < 10_000 && shards.size < 4; index += 1) {
    const tenantId = `metrics-tenant-${index}`;
    const route = routeDatabaseTenant(topology, { tenantId });
    if (!shards.has(route.physicalShardId)) {
      shards.add(route.physicalShardId);
      tenants.push({ tenantId, route });
    }
  }

  for (const [index, { tenantId }] of tenants.entries()) {
    await database.forTenant(tenantId).documents.createCollection({ name: "metrics" });
    await database.forTenant(tenantId).documents.insert({
      collection: "metrics",
      id: `metric-${index}`,
      data: { timestamp: "2026-01-01T00:00:00.000Z", value: index + 1 },
    });
    assert.equal(
      await database.forTenant(tenantId).timeseries.get("metrics").aggregate({ op: "sum" }),
      index + 1,
    );
  }

  assert.equal(new Set(tenants.map(({ route }) => route.physicalShardId)).size, 4);
});
