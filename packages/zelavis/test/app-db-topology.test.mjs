import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DATABASE_PARTITION_SPACE_SIZE,
  DatabaseTopologyRouteError,
  DatabaseTopologyValidationError,
  createDatabaseTopologyRouter,
  createOfficialLocalDatabaseTopology,
  databasePlacementId,
  databaseReplicaId,
  hashDatabasePartitionKey,
  validateDatabaseTopology,
} from "../dist/app/db/index.js";
import {
  createBetterSqlite3Database,
} from "../dist/app/db/adapters/node-sqlite.js";

test("database topology has a narrow public package subpath", async () => {
  const topology = await import("zelavis/app/db/topology");
  assert.equal(typeof topology.createDatabaseTopologyRouter, "function");
  assert.equal(typeof topology.createOfficialLocalDatabaseTopology, "function");
});

test("database partition hashing has stable protocol test vectors", () => {
  assert.equal(hashDatabasePartitionKey(""), 2166136261);
  assert.equal(hashDatabasePartitionKey("a"), 3826002220);
  assert.equal(hashDatabasePartitionKey("hello"), 1335831723);
  assert.equal(hashDatabasePartitionKey("Zelavis 🧵"), 3356766544);
});

test("official local App topology uses many virtual ranges and four physical shards", () => {
  const topology = createOfficialLocalDatabaseTopology({
    logicalDatabaseId: "project-alpha-primary",
    nodeId: "node-a",
  });

  assert.equal(topology.desired.virtualShards.length, 1024);
  assert.equal(topology.desired.physicalShards.length, 4);
  assert.equal(topology.desired.policy.minPhysicalShards, 4);
  assert.equal(topology.observed.placements.length, 4);
  assert.equal(topology.desired.virtualShards[0].startInclusive, 0);
  assert.equal(
    topology.desired.virtualShards.at(-1).endExclusive,
    DATABASE_PARTITION_SPACE_SIZE,
  );
  assert.ok(
    topology.observed.placements.every(
      (placement) =>
        placement.nodeId === "node-a" &&
        placement.role === "writer" &&
        placement.generation === 1,
    ),
  );
});

test("tenant routing is deterministic and exercises all local physical shards", () => {
  const topology = createOfficialLocalDatabaseTopology({
    logicalDatabaseId: "project-alpha-primary",
  });
  const router = createDatabaseTopologyRouter(topology);
  const first = router.route({ tenantId: "tenant-a", intent: "write" });
  const second = router.route({ tenantId: "tenant-a", intent: "write" });

  assert.deepEqual(second, first);
  assert.equal(first.placement.role, "writer");

  const physicalShards = new Set();
  for (let index = 0; index < 10_000 && physicalShards.size < 4; index += 1) {
    physicalShards.add(
      router.route({ tenantId: `tenant-${index}` }).physicalShardId,
    );
  }
  assert.equal(physicalShards.size, 4);
});

test("moving a virtual range changes placement without changing logical routing identity", () => {
  const topology = createOfficialLocalDatabaseTopology({
    logicalDatabaseId: "project-alpha-primary",
  });
  const router = createDatabaseTopologyRouter(topology);
  const before = router.route({ tenantId: "tenant-a" });
  const nextPhysicalShard = topology.desired.physicalShards.find(
    (shard) => shard.id !== before.physicalShardId,
  );
  assert.ok(nextPhysicalShard);

  const moved = {
    desired: {
      ...topology.desired,
      generation: 2,
      virtualShards: topology.desired.virtualShards.map((shard) =>
        shard.id === before.virtualShardId
          ? { ...shard, physicalShardId: nextPhysicalShard.id }
          : shard,
      ),
    },
    observed: topology.observed,
  };
  const after = createDatabaseTopologyRouter(moved).route({
    tenantId: "tenant-a",
  });

  assert.equal(after.partitionHash, before.partitionHash);
  assert.equal(after.virtualShardId, before.virtualShardId);
  assert.equal(after.physicalShardId, nextPhysicalShard.id);
  assert.notEqual(after.physicalShardId, before.physicalShardId);
  assert.equal(after.topologyGeneration, 2);
});

test("eventual reads can use an explicit eligible replica while writes use the writer", () => {
  const topology = createOfficialLocalDatabaseTopology({
    logicalDatabaseId: "project-alpha-primary",
  });
  const writerRoute = createDatabaseTopologyRouter(topology).route({
    tenantId: "tenant-a",
    intent: "write",
  });
  const replica = {
    id: databasePlacementId(`placement-${writerRoute.physicalShardId}-replica`),
    replicaId: databaseReplicaId(`replica-${writerRoute.physicalShardId}-1`),
    physicalShardId: writerRoute.physicalShardId,
    nodeId: "node-b",
    role: "replica",
    generation: writerRoute.placement.generation,
    state: "active",
    health: "ready",
    target: "https://node-b.invalid/shard",
  };
  const withReplica = {
    desired: {
      ...topology.desired,
      policy: { ...topology.desired.policy, replicas: 1 },
    },
    observed: {
      ...topology.observed,
      placements: [...topology.observed.placements, replica],
    },
  };
  const router = createDatabaseTopologyRouter(withReplica);

  assert.equal(
    router.route({
      tenantId: "tenant-a",
      intent: "read",
      consistency: "eventual",
    }).placement.role,
    "replica",
  );
  assert.equal(
    router.route({
      tenantId: "tenant-a",
      intent: "read",
      consistency: "strong",
    }).placement.role,
    "writer",
  );
  assert.equal(
    router.route({
      tenantId: "tenant-a",
      intent: "write",
      consistency: "eventual",
    }).placement.role,
    "writer",
  );
});

test("topology validation rejects gaps and multiple active writers", () => {
  const topology = createOfficialLocalDatabaseTopology();
  const brokenRanges = topology.desired.virtualShards.map((shard, index) =>
    index === 1 ? { ...shard, startInclusive: shard.startInclusive + 1 } : shard,
  );
  assert.throws(
    () =>
      validateDatabaseTopology({
        desired: { ...topology.desired, virtualShards: brokenRanges },
        observed: topology.observed,
      }),
    DatabaseTopologyValidationError,
  );

  const writer = topology.observed.placements[0];
  assert.ok(writer);
  assert.throws(
    () =>
      validateDatabaseTopology({
        desired: topology.desired,
        observed: {
          ...topology.observed,
          placements: [
            ...topology.observed.placements,
            {
              ...writer,
              id: databasePlacementId("placement-duplicate-writer"),
              replicaId: databaseReplicaId("replica-duplicate-writer"),
              nodeId: "node-b",
            },
          ],
        },
      }),
    DatabaseTopologyValidationError,
  );
});

test("routing rejects missing Tenant identity and unavailable writers", () => {
  const topology = createOfficialLocalDatabaseTopology();
  const router = createDatabaseTopologyRouter(topology);
  assert.throws(() => router.route({ tenantId: "" }), DatabaseTopologyRouteError);

  const route = router.route({ tenantId: "tenant-a" });
  const unavailable = {
    desired: topology.desired,
    observed: {
      ...topology.observed,
      placements: topology.observed.placements.map((placement) =>
        placement.physicalShardId === route.physicalShardId
          ? { ...placement, health: "unavailable" }
          : placement,
      ),
    },
  };
  assert.throws(
    () => createDatabaseTopologyRouter(unavailable).route({ tenantId: "tenant-a" }),
    DatabaseTopologyRouteError,
  );
});

test("Node project adapter persists topology and refuses startup remapping", async () => {
  const { nodeAdapter } = await import("../dist/adapters/node.js");
  const directory = await mkdtemp(join(tmpdir(), "zelavis-topology-store-"));

  try {
    const first = await nodeAdapter({
      role: "project",
      dataDirectory: directory,
    }).resolve({});
    const record = await first.resources.systemStore.get(
      "app-data-topology",
      "primary",
    );
    assert.equal(record.value.desired.virtualShards.length, 1024);
    assert.equal(record.value.desired.physicalShards.length, 4);

    await Promise.all(
      record.value.desired.physicalShards.map((shard) =>
        access(
          join(
            directory,
            "data",
            "primary",
            "shards",
            `${shard.id}.sqlite`,
          ),
        ),
      ),
    );

    await assert.rejects(
      () =>
        nodeAdapter({
          role: "project",
          dataDirectory: directory,
          database: { physicalShardCount: 8 },
        }).resolve({}),
      /does not match the persisted App data topology/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node project adapter recovers a legacy single-file App database into Tenant shards", async () => {
  const { createDatabase } = await import("../dist/app/db/index.js");
  const { nodeAdapter } = await import("../dist/adapters/node.js");
  const directory = await mkdtemp(join(tmpdir(), "zelavis-legacy-db-"));

  try {
    const legacy = await createBetterSqlite3Database({
      filename: join(directory, "zelavis.sqlite"),
    });
    const legacyTenant = legacy.forTenant("default");
    await legacyTenant.documents.createCollection({
      name: "pets",
      surface: "database",
    });
    const legacyDocument = await legacyTenant.documents.insert({
      collection: "pets",
      id: "pet-puffy",
      data: { name: "Puffy" },
    });
    const legacyEvents = await legacyTenant.events.read();

    const resolved = await nodeAdapter({
      role: "project",
      dataDirectory: directory,
    }).resolve({});
    const migrated = await createDatabase({
      driver: resolved.subsystems.database.driver,
    });
    const appTenant = migrated.forTenant("zelavis-app");

    assert.deepEqual(
      (await appTenant.documents.listCollections()).map((collection) =>
        collection.name
      ),
      ["pets"],
    );
    const recoveredDocument = await appTenant.documents.findById({
        collection: "pets",
        id: "pet-puffy",
      });
    assert.deepEqual(recoveredDocument.data, { name: "Puffy" });
    assert.equal(
      recoveredDocument.createdAt.toISOString(),
      legacyDocument.createdAt.toISOString(),
    );
    assert.deepEqual(
      (await appTenant.events.read()).map((event) => ({
        eventId: event.eventId,
        timestamp: event.timestamp,
      })),
      legacyEvents.map((event) => ({
        eventId: event.eventId,
        timestamp: event.timestamp,
      })),
    );
    const marker = await resolved.resources.systemStore.get(
      "app-data-migrations",
      "legacy-single-sqlite-v1",
    );
    assert.equal(marker.value.status, "completed");
    assert.equal(marker.value.migratedEvents, 2);

    const second = await nodeAdapter({
      role: "project",
      dataDirectory: directory,
    }).resolve({});
    const reopened = await createDatabase({
      driver: second.subsystems.database.driver,
    });
    assert.equal(
      (await reopened.forTenant("zelavis-app").events.read()).length,
      2,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
