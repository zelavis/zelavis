import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBetterSqlite3DatabaseDriver } from "../dist/app/db/adapters/node-sqlite.js";
import { DatabaseWriterFencedError } from "../dist/app/db/index.js";
import {
  createShardedDatabaseDriver,
  createOfficialLocalDatabaseTopology,
} from "../dist/app/db/topology/index.js";

async function shard(directory, name = "shard.db") {
  return createBetterSqlite3DatabaseDriver({ filename: join(directory, name) });
}

const appendCollection = (tenantId, collection) => ({
  type: "collection.created",
  tenantId,
  collection,
  payload: { name: collection },
});

test("an unfenced driver writes without claiming a generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-fence-"));
  try {
    const driver = await shard(directory);
    // No claim: the embedded single-process default stays unfenced.
    const event = await driver.events.append(appendCollection("t1", "notes"));
    assert.ok(event.cursor, "an unfenced write must still succeed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a superseded writer is rejected by the shard itself", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-fence-"));
  try {
    // Two independent drivers over one shard file: the old writer that has not
    // noticed it lost ownership, and the writer that took over.
    const oldWriter = await shard(directory);
    const newWriter = await shard(directory);

    await oldWriter.claimWriterGeneration(1);
    await oldWriter.events.append(appendCollection("t1", "before-takeover"));

    // Takeover advances the durable fence.
    await newWriter.claimWriterGeneration(2);

    await assert.rejects(
      () => oldWriter.events.append(appendCollection("t1", "after-takeover")),
      (error) => {
        assert.ok(
          error instanceof DatabaseWriterFencedError,
          `expected a fenced-writer error, received ${error?.name}: ${error?.message}`,
        );
        assert.match(error.message, /generation 1 no longer owns/);
        return true;
      },
      "the superseded writer must not be able to write",
    );

    // The new owner writes normally.
    const event = await newWriter.events.append(
      appendCollection("t1", "after-takeover"),
    );
    assert.ok(event.cursor);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a writer cannot claim a generation older than the current owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-fence-"));
  try {
    const current = await shard(directory);
    const stale = await shard(directory);

    await current.claimWriterGeneration(5);
    await assert.rejects(
      () => stale.claimWriterGeneration(4),
      /cannot claim this shard; generation 5 already owns it/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("re-claiming the same generation is allowed so a restart needs no new one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-fence-"));
  try {
    const first = await shard(directory);
    await first.claimWriterGeneration(3);
    await first.events.append(appendCollection("t1", "one"));

    // Same process restarting, or a reconnect, with the generation it still owns.
    const restarted = await shard(directory);
    await restarted.claimWriterGeneration(3);
    const event = await restarted.events.append(appendCollection("t1", "two"));
    assert.ok(event.cursor);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the fence survives reopening the shard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-fence-"));
  try {
    const owner = await shard(directory);
    await owner.claimWriterGeneration(7);

    // A fresh process with a stale generation must still be refused, which is
    // only possible because the fence is persisted rather than in memory.
    const reopened = await shard(directory);
    await assert.rejects(() => reopened.claimWriterGeneration(6), /already owns it/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writer fencing is advertised as a driver capability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-fence-"));
  try {
    const driver = await shard(directory);
    assert.equal(driver.capabilities.writerFencing, true);
    assert.equal(typeof driver.claimWriterGeneration, "function");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the sharded driver claims the generation the topology says owns each shard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-fence-topology-"));
  try {
    const topology = createOfficialLocalDatabaseTopology({
      logicalDatabaseId: "app",
    });

    const shards = new Map();
    for (const physical of topology.desired.physicalShards) {
      shards.set(physical.id, await shard(directory, `${physical.id}.db`));
    }

    const sharded = createShardedDatabaseDriver({ topology, physicalDrivers: shards });
    await sharded.events.append(appendCollection("tenant-a", "notes"));

    // A different process takes over every shard at a higher generation. These
    // must be separate driver instances over the same files — claiming on the
    // sharded driver's own drivers would just move its own fence.
    for (const physical of topology.desired.physicalShards) {
      const takeover = await shard(directory, `${physical.id}.db`);
      await takeover.claimWriterGeneration(99);
    }

    // The sharded driver already claimed at the topology's generation, so its
    // writes are now fenced out rather than silently racing the new owner.
    await assert.rejects(
      () => sharded.events.append(appendCollection("tenant-a", "after-takeover")),
      (error) => error instanceof DatabaseWriterFencedError,
      "a superseded sharded writer must be fenced",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
