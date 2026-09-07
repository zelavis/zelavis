import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DatabaseConflictError,
  DatabaseRevisionMismatchError,
  createDatabase,
} from "../dist/app/db/index.js";
import {
  createBunSqliteDatabase,
  createBunSqliteDatabaseDriver,
} from "../dist/app/db/adapters/bun-sqlite.js";
import { bunAdapter } from "../dist/adapters/bun.js";

function createTempDatabasePath() {
  const directory = mkdtempSync(join(tmpdir(), "zelavis-bun-sqlite-"));
  return {
    directory,
    filename: join(directory, "database.sqlite"),
  };
}

test("bun:sqlite driver supports persistent tenant-aware document CRUD", async () => {
  const temp = createTempDatabasePath();

  try {
    const database = await createDatabase({
      driver: createBunSqliteDatabaseDriver({ filename: temp.filename }),
    });
    const standard = database.forTenant("default");
    const enterprise = database.forTenant("enterprise");

    await standard.documents.createCollection({ name: "products" });
    await enterprise.documents.createCollection({ name: "products" });

    const product = await standard.documents.insert({
      collection: "products",
      data: {
        name: "T-shirt",
        status: "published",
        price: 25,
      },
    });

    await enterprise.documents.insert({
      collection: "products",
      data: {
        name: "Private catalog",
        status: "published",
        price: 50,
      },
    });

    const found = await standard.documents.findById({
      collection: "products",
      id: product.id,
    });
    expect(found?.data.name).toBe("T-shirt");

    const published = await standard.documents.findMany({
      collection: "products",
      where: [{ path: "status", value: "published" }],
    });
    expect(published).toHaveLength(1);

    const updated = await standard.documents.update({
      collection: "products",
      id: product.id,
      data: { status: "archived" },
    });
    expect(updated.version).toBe(2);
    expect(updated.data.status).toBe("archived");

    expect(
      await standard.documents.delete({
        collection: "products",
        id: product.id,
      }),
    ).toBe(true);
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("bun:sqlite serializes competing writes to one event stream", async () => {
  const temp = createTempDatabasePath();
  try {
    const database = await createBunSqliteDatabase({ filename: temp.filename });
    const tenant = database.forTenant("default");
    await tenant.documents.createCollection({ name: "products" });
    await tenant.documents.insert({
      collection: "products",
      id: "product_1",
      data: { name: "Initial" },
    });
    const results = await Promise.allSettled([
      tenant.events.append({
        collection: "products",
        documentId: "product_1",
        type: "document.upserted",
        expectedRevision: 1,
        payload: { data: { name: "First" } },
      }),
      tenant.events.append({
        collection: "products",
        documentId: "product_1",
        type: "document.upserted",
        expectedRevision: 1,
        payload: { data: { name: "Second" } },
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(DatabaseRevisionMismatchError);
    }
    const events = await tenant.events.read({
      collection: "products",
      documentId: "product_1",
    });
    expect(events.map((event) => event.revision)).toEqual([1, 2]);
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("Bun project adapter recovers a legacy App database into Tenant shards", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zelavis-bun-legacy-db-"));

  try {
    const legacy = await createBunSqliteDatabase({
      filename: join(directory, "zelavis.sqlite"),
    });
    await legacy.forTenant("default").documents.createCollection({ name: "pets" });
    await legacy.forTenant("default").documents.insert({
      collection: "pets",
      id: "pet-puffy",
      data: { name: "Puffy" },
    });

    const resolved = await bunAdapter({
      role: "project",
      dataDirectory: directory,
    }).resolve?.({});
    const databaseOption = resolved?.coreServices?.database;
    expect(databaseOption).toBeDefined();
    expect(typeof databaseOption).toBe("object");
    const migrated = await createDatabase(
      databaseOption as Parameters<typeof createDatabase>[0],
    );
    const recovered = await migrated.forTenant("zelavis-app").documents.findById({
      collection: "pets",
      id: "pet-puffy",
    });

    expect(recovered?.data).toEqual({ name: "Puffy" });
    const marker = await resolved?.resources?.systemStore?.get(
      "app-data-migrations",
      "legacy-single-sqlite-v1",
    );
    expect(marker?.value.status).toBe("completed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bun:sqlite database preserves schemas and active versions across reopen", async () => {
  const temp = createTempDatabasePath();

  try {
    const first = await createBunSqliteDatabase({ filename: temp.filename });

    await first.schemas.save({
      collection: "products",
      version: 1,
      activate: true,
      fields: [
        { name: "name", field: { _tag: "TextField", label: "Name", required: true } },
      ],
    });
    await first.schemas.save({
      collection: "products",
      version: 2,
      activate: true,
      fields: [
        { name: "name", field: { _tag: "TextField", label: "Name", required: true } },
        { name: "status", field: { _tag: "TextField", label: "Status", required: true } },
      ],
    });

    const reopened = await createBunSqliteDatabase({ filename: temp.filename });

    expect(reopened.schemas.listCollections()).toEqual([
      {
        collection: "products",
        activeVersion: 2,
        versions: [1, 2],
      },
    ]);
    expect(
      reopened.schemas.listVersions("products").map((schema) => ({
        version: schema.version,
        active: schema.active,
      })),
    ).toEqual([
      { version: 1, active: false },
      { version: 2, active: true },
    ]);
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("bun:sqlite database preserves idempotent event retries across reopen", async () => {
  const temp = createTempDatabasePath();

  try {
    const first = await createBunSqliteDatabase({ filename: temp.filename });

    const created = await first.forTenant("default").events.append({
      collection: "products",
      type: "collection.created",
      expectedRevision: 0,
      idempotencyKey: "create-products",
      payload: {
        metadata: {
          source: "test",
        },
      },
    });

    const reopened = await createBunSqliteDatabase({ filename: temp.filename });
    const retried = await reopened.forTenant("default").events.append({
      collection: "products",
      type: "collection.created",
      expectedRevision: 0,
      idempotencyKey: "create-products",
      payload: {
        metadata: {
          source: "test",
        },
      },
    });

    const events = await reopened.forTenant("default").events.read({ collection: "products" });

    expect(retried.eventId).toBe(created.eventId);
    expect(events).toHaveLength(1);
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("bun:sqlite database uses typed conflict and revision errors", async () => {
  const temp = createTempDatabasePath();

  try {
    const database = await createBunSqliteDatabase({ filename: temp.filename });

    await database.forTenant("default").events.append({
      collection: "products",
      type: "collection.created",
      expectedRevision: 0,
      payload: { metadata: { source: "test" } },
    });

    try {
      await database.forTenant("default").events.append({
        collection: "products",
        type: "collection.created",
        expectedRevision: 0,
        payload: { metadata: { source: "test" } },
      });
      throw new Error("Expected duplicate collection conflict.");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseConflictError);
      expect((error as Error).name).toBe("DatabaseConflictError");
    }

    await database.forTenant("default").documents.insert({
      collection: "products",
      id: "product_1",
      data: { name: "Demo" },
    });

    try {
      await database.forTenant("default").events.append({
        collection: "products",
        documentId: "product_1",
        type: "document.upserted",
        expectedRevision: 2,
        payload: { data: { name: "Outdated" } },
      });
      throw new Error("Expected revision mismatch.");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseRevisionMismatchError);
      expect((error as Error).name).toBe("DatabaseRevisionMismatchError");
    }
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("bun:sqlite database persists time-series samples across reopen and rebuilds on definition version changes", async () => {
  const temp = createTempDatabasePath();

  try {
    const first = await createBunSqliteDatabase({ filename: temp.filename });

    await first.forTenant("default").documents.createCollection({ name: "metrics" });
    await first.projections.register({
      name: "timeseries.metrics",
      source: {
        collections: ["metrics"],
        eventTypes: ["document.upserted"],
      },
    });
    await first.timeseries.define({
      name: "metrics",
      version: 1,
      projection: "timeseries.metrics",
      source: {
        collections: ["metrics"],
        eventTypes: ["document.upserted"],
      },
      map(event) {
        if (event.type !== "document.upserted") {
          return null;
        }

        const payload = event.payload as {
          data: { timestamp: string; value: number };
        };

        return {
          timestamp: payload.data.timestamp,
          value: payload.data.value,
        };
      },
    });

    await first.forTenant("default").documents.insert({
      collection: "metrics",
      id: "m1",
      data: { timestamp: "2026-01-01T00:00:00.000Z", value: 10 },
    });
    await first.forTenant("default").documents.insert({
      collection: "metrics",
      id: "m2",
      data: { timestamp: "2026-01-01T00:01:00.000Z", value: 20 },
    });

    expect(
      (await first.forTenant("default").timeseries.get("metrics").range()).map(
        (point) => point.value,
      ),
    ).toEqual([10, 20]);

    const reopened = await createBunSqliteDatabase({ filename: temp.filename });
    await reopened.projections.register({
      name: "timeseries.metrics",
      source: {
        collections: ["metrics"],
        eventTypes: ["document.upserted"],
      },
    });
    await reopened.timeseries.define({
      name: "metrics",
      version: 1,
      projection: "timeseries.metrics",
      source: {
        collections: ["metrics"],
        eventTypes: ["document.upserted"],
      },
      map(event) {
        if (event.type !== "document.upserted") {
          return null;
        }

        const payload = event.payload as {
          data: { timestamp: string; value: number };
        };

        return {
          timestamp: payload.data.timestamp,
          value: payload.data.value,
        };
      },
    });

    await reopened.forTenant("default").documents.insert({
      collection: "metrics",
      id: "m3",
      data: { timestamp: "2026-01-01T00:02:00.000Z", value: 30 },
    });

    expect(
      (await reopened.forTenant("default").timeseries.get("metrics").range()).map(
        (point) => point.value,
      ),
    ).toEqual([10, 20, 30]);

    const rebuilt = await createBunSqliteDatabase({ filename: temp.filename });
    await rebuilt.projections.register({
      name: "timeseries.metrics",
      source: {
        collections: ["metrics"],
        eventTypes: ["document.upserted"],
      },
    });
    await rebuilt.timeseries.define({
      name: "metrics",
      version: 2,
      projection: "timeseries.metrics",
      source: {
        collections: ["metrics"],
        eventTypes: ["document.upserted"],
      },
      map(event) {
        if (event.type !== "document.upserted") {
          return null;
        }

        const payload = event.payload as {
          data: { timestamp: string; value: number };
        };

        return {
          timestamp: payload.data.timestamp,
          value: payload.data.value * 2,
        };
      },
    });

    expect(
      (await rebuilt.forTenant("default").timeseries.get("metrics").range()).map(
        (point) => point.value,
      ),
    ).toEqual([20, 40, 60]);
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});
