import assert from "node:assert/strict";
import test from "node:test";

import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";

const APP_SERVICES = [
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

function testDriver() {
  const destroyed = [];
  return {
    destroyed,
    driver: {
      name: "test-driver",
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
      async prepare() {},
      async start() {
        return { status: "running", url: "http://127.0.0.1:1" };
      },
      async stop() {
        return { status: "stopped" };
      },
      async status() {
        return { status: "stopped" };
      },
      async logs() {
        return [];
      },
      async destroy(projectId) {
        destroyed.push(projectId);
      },
      async close() {},
    },
  };
}

async function manager(store, driver) {
  return createProjectManager({ appServices: APP_SERVICES, store, runtime: driver });
}

test("an owned Project is hidden from the Platform list but still addressable", async () => {
  const store = createMemorySystemStore();
  const { driver } = testDriver();
  const projects = await manager(store, driver);

  try {
    await projects.create({ id: "site", name: "Site", start: false });
    await projects.create({
      id: "site-frontend",
      name: "Site Frontend",
      start: false,
      ownerProjectId: "site",
    });

    // The Platform owns one Project; the frontend belongs to that Project.
    assert.deepEqual((await projects.list()).map((p) => p.id), ["site"]);

    // It is not hidden data — deletion and reconciliation need the full set.
    const all = (await projects.list({ includeOwned: true })).map((p) => p.id).sort();
    assert.deepEqual(all, ["site", "site-frontend"]);

    assert.deepEqual(
      (await projects.listOwned("site")).map((p) => p.id),
      ["site-frontend"],
    );
    assert.equal((await projects.get("site-frontend"))?.ownerProjectId, "site");
  } finally {
    await projects.close();
  }
});

test("deleting a Project deletes what it owns", async () => {
  const store = createMemorySystemStore();
  const { driver, destroyed } = testDriver();
  const projects = await manager(store, driver);

  try {
    await projects.create({ id: "site", name: "Site", start: false });
    await projects.create({
      id: "site-frontend",
      name: "Site Frontend",
      start: false,
      ownerProjectId: "site",
    });

    await projects.remove("site");

    assert.equal(await projects.get("site"), undefined);
    assert.equal(
      await projects.get("site-frontend"),
      undefined,
      "an owned runtime must not outlive its owner",
    );
    assert.deepEqual(destroyed.sort(), ["site", "site-frontend"]);
  } finally {
    await projects.close();
  }
});

test("ownership survives a restart", async () => {
  const store = createMemorySystemStore();
  const { driver } = testDriver();

  const first = await manager(store, driver);
  await first.create({ id: "site", name: "Site", start: false });
  await first.create({
    id: "site-frontend",
    name: "Site Frontend",
    start: false,
    ownerProjectId: "site",
  });
  await first.close();

  // Ownership is how deletion reaches an owned runtime. If it did not survive
  // a restart, every owned runtime would orphan on the next boot.
  const restarted = await manager(store, driver);
  try {
    assert.equal((await restarted.get("site-frontend"))?.ownerProjectId, "site");
    assert.deepEqual((await restarted.list()).map((p) => p.id), ["site"]);
  } finally {
    await restarted.close();
  }
});

test("ownership is validated before it is persisted", async () => {
  const store = createMemorySystemStore();
  const { driver } = testDriver();
  const projects = await manager(store, driver);

  try {
    await assert.rejects(
      () => projects.create({ id: "orphan", name: "Orphan", start: false, ownerProjectId: "missing" }),
      /Owner Project "missing" was not found/,
      "an owner that does not exist would leave an unreachable runtime",
    );

    await projects.create({ id: "site", name: "Site", start: false });
    // Self-ownership is refused before the identifier claim: it is invalid
    // regardless of whether the id is free, and the clearer message wins.
    await assert.rejects(
      () => projects.create({ id: "site", name: "Site", ownerProjectId: "site" }),
      /cannot own itself/,
    );

    await projects.create({
      id: "site-frontend",
      name: "Frontend",
      start: false,
      ownerProjectId: "site",
    });
    await assert.rejects(
      () =>
        projects.create({
          id: "deep",
          name: "Deep",
          start: false,
          ownerProjectId: "site-frontend",
        }),
      /nested ownership is not supported yet/,
    );
  } finally {
    await projects.close();
  }
});
