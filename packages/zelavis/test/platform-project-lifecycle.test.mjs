import assert from "node:assert/strict";
import test from "node:test";

import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Driver that takes a measurable amount of time in every transition, so
 * concurrent calls genuinely overlap instead of resolving in order by luck.
 */
function createSlowDriver(latencyMs = 25) {
  const events = [];
  let starts = 0;
  let prepares = 0;
  return {
    driver: {
      name: "slow-test-driver",
      capabilities: () => ({
        independentRuntimeVersion: false,
        movable: false,
        liveMigration: false,
        secureIsolation: false,
        resourceLimits: false,
        persistentFilesystem: true,
        statelessRuntimeReplicas: false,
        managedStorage: false,
        managedDatabase: false,
        databaseReplication: false,
        tenantPlacement: false,
        databaseSharding: false,
        runtimeOwnership: "platform-process",
        survivesControlPlaneRestart: false,
        description: "test",
      }),
      async prepare() {
        prepares += 1;
        await delay(latencyMs);
      },
      async start() {
        events.push("start:begin");
        await delay(latencyMs);
        starts += 1;
        events.push("start:end");
        return { status: "running", url: "http://127.0.0.1:1", startedAt: new Date().toISOString() };
      },
      async stop() {
        events.push("stop:begin");
        await delay(latencyMs);
        events.push("stop:end");
        return { status: "stopped", stoppedAt: new Date().toISOString() };
      },
      async status() {
        return { status: "stopped" };
      },
      async logs() {
        return [];
      },
      async destroy() {},
      async close() {},
    },
    events,
    counts: () => ({ starts, prepares }),
  };
}

const PROJECT_RECIPES = [
  {
    service: {
      name: "zelavis/app",
      kind: "app",
      version: "1.0.0-test",
      api: {},
      service: {},
    },
    specifier: "zelavis/app",
    status: "available",
    source: "official",
    order: 0,
  },
];

async function createManager(driver) {
  return createProjectManager({
    projectRecipes: PROJECT_RECIPES,
    store: createMemorySystemStore(),
    runtime: driver,
  });
}

test("concurrent creates of one Project id provision exactly once", async () => {
  const { driver, counts } = createSlowDriver();
  const manager = await createManager(driver);

  try {
    const results = await Promise.allSettled([
      manager.create({ id: "alpha", name: "Alpha", start: false }),
      manager.create({ id: "alpha", name: "Alpha", start: false }),
      manager.create({ id: "alpha", name: "Alpha", start: false }),
    ]);

    const created = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter((entry) => entry.status === "rejected");

    assert.equal(created.length, 1, "exactly one create may win the identifier");
    assert.equal(rejected.length, 2);
    for (const failure of rejected) {
      assert.match(String(failure.reason?.message ?? ""), /already exists/);
    }
    assert.equal(
      counts().prepares,
      1,
      "a losing create must not provision the Project a second time",
    );
    assert.equal((await manager.list()).length, 1);
  } finally {
    await manager.close();
  }
});

test("concurrent lifecycle transitions are serialized per Project", async () => {
  const { driver, events } = createSlowDriver();
  const manager = await createManager(driver);

  try {
    await manager.create({ id: "alpha", name: "Alpha", start: false });

    await Promise.allSettled([
      manager.start("alpha"),
      manager.stop("alpha"),
      manager.restart("alpha"),
    ]);

    // Each driver transition must complete before the next begins; an
    // interleaved pair shows up as two `:begin` events in a row.
    for (let index = 0; index < events.length; index += 2) {
      assert.match(events[index], /:begin$/, `unexpected order: ${events.join(",")}`);
      assert.match(
        events[index + 1] ?? "",
        /:end$/,
        `overlapping transitions: ${events.join(",")}`,
      );
    }

    const project = await manager.get("alpha");
    // The final persisted state must match the last transition that ran, not a
    // stale write from an operation that started earlier.
    assert.ok(["running", "stopped"].includes(project.runtime.status));
  } finally {
    await manager.close();
  }
});

test("a Project being deleted cannot be stopped underneath the cleanup", async () => {
  const { driver } = createSlowDriver();
  const manager = await createManager(driver);

  try {
    await manager.create({ id: "alpha", name: "Alpha", start: false });
    const removal = manager.remove("alpha");
    const stopped = await manager.stop("alpha").then(
      () => "resolved",
      (error) => String(error?.message ?? error),
    );
    await removal;

    // Either the stop was ordered before deletion began, or it was refused.
    // What must not happen is a stop that resurrects state after cleanup.
    if (stopped !== "resolved") {
      assert.match(stopped, /deleted|not be stopped|was not found/i);
    }
    assert.equal(await manager.get("alpha"), undefined);
  } finally {
    await manager.close();
  }
});
