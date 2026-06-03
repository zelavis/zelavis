import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DatabaseConflictError,
  DatabaseRevisionMismatchError,
  createDatabase,
} from "@zelavis/db";
import {
  createBetterSqlite3Database,
  createBetterSqlite3DatabaseDriver,
} from "../dist/index.js";

function createTempDatabasePath() {
  const directory = mkdtempSync(join(tmpdir(), "zelavis-node-sqlite-"));
  return {
    directory,
    filename: join(directory, "database.sqlite"),
  };
}

test("better-sqlite3 driver supports persistent tenant-aware document CRUD", async () => {
  const temp = createTempDatabasePath();

  try {
    const database = await createDatabase({
      driver: createBetterSqlite3DatabaseDriver({ filename: temp.filename }),
    });

    await database.documents.createCollection({ name: "products" });
    await database.documents.createCollection({
      tenantId: "enterprise",
      name: "products",
    });

    const product = await database.documents.insert({
      collection: "products",
      data: {
        name: "T-shirt",
        status: "published",
        price: 25,
      },
    });

    await database.documents.insert({
      tenantId: "enterprise",
      collection: "products",
      data: {
        name: "Private catalog",
        status: "published",
        price: 50,
      },
    });

    const found = await database.documents.findById({
      collection: "products",
      id: product.id,
    });
    assert.equal(found?.data.name, "T-shirt");

    const published = await database.documents.findMany({
      collection: "products",
      where: [{ path: "status", value: "published" }],
    });
    assert.equal(published.length, 1);

    const updated = await database.documents.update({
      collection: "products",
      id: product.id,
      data: { status: "archived" },
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.data.status, "archived");

    assert.equal(
      await database.documents.delete({
        collection: "products",
        id: product.id,
      }),
      true,
    );
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("better-sqlite3 database preserves data across reopen and exposes SQL capability", async () => {
  const temp = createTempDatabasePath();

  try {
    const first = await createBetterSqlite3Database({
      filename: temp.filename,
    });
    await first.documents.createCollection({ name: "products" });
    await first.documents.insert({
      collection: "products",
      id: "shirt_1",
      data: {
        name: "Persisted shirt",
        price: 30,
      },
    });

    const reopened = await createBetterSqlite3Database({
      filename: temp.filename,
    });
    const found = await reopened.documents.findById({
      collection: "products",
      id: "shirt_1",
    });

    assert.equal(found?.data.name, "Persisted shirt");
    assert.equal(reopened.capabilities.sql, true);

    const tables = await reopened.sql?.query({
      statement: "SELECT name FROM sqlite_master WHERE type = 'table'",
    });
    const tableNames = new Set(tables?.rows.map((row) => row.name));
    assert.equal(tableNames.has("products"), true);
    assert.equal(tableNames.has("documents"), false);

    const query = await reopened.sql?.query({
      statement: 'SELECT COUNT(*) AS count FROM "products" WHERE tenant_id = ?',
      parameters: ["default"],
    });

    assert.deepEqual(query?.rows, [{ count: 1 }]);
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("better-sqlite3 database preserves schemas and active versions across reopen", async () => {
  const temp = createTempDatabasePath();

  try {
    const first = await createBetterSqlite3Database({
      filename: temp.filename,
    });

    await first.schemas.register({
      collection: "products",
      version: 1,
      activate: true,
      document: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1 },
        },
      },
    });
    await first.schemas.register({
      collection: "products",
      version: 2,
      activate: true,
      document: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["draft", "published"] },
        },
      },
    });

    const reopened = await createBetterSqlite3Database({
      filename: temp.filename,
    });

    assert.deepEqual(reopened.schemas.listCollections(), [
      {
        collection: "products",
        activeVersion: 2,
        versions: [1, 2],
      },
    ]);
    assert.deepEqual(
      reopened.schemas.listVersionRecords("products").map((schema) => ({
        version: schema.version,
        active: schema.active,
      })),
      [
        { version: 1, active: false },
        { version: 2, active: true },
      ],
    );
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("better-sqlite3 database preserves idempotent event retries across reopen", async () => {
  const temp = createTempDatabasePath();

  try {
    const first = await createBetterSqlite3Database({
      filename: temp.filename,
    });

    const created = await first.events.append({
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

    const reopened = await createBetterSqlite3Database({
      filename: temp.filename,
    });
    const retried = await reopened.events.append({
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

    const events = await reopened.events.read({ collection: "products" });

    assert.equal(retried.eventId, created.eventId);
    assert.equal(events.length, 1);
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("better-sqlite3 database uses typed conflict and revision errors", async () => {
  const temp = createTempDatabasePath();

  try {
    const database = await createBetterSqlite3Database({
      filename: temp.filename,
    });

    await database.events.append({
      collection: "products",
      type: "collection.created",
      expectedRevision: 0,
      payload: { metadata: { source: "test" } },
    });

    await assert.rejects(
      () =>
        database.events.append({
          collection: "products",
          type: "collection.created",
          expectedRevision: 0,
          payload: { metadata: { source: "test" } },
        }),
      (error) => {
        assert.equal(error instanceof DatabaseConflictError, true);
        assert.equal(error.name, "DatabaseConflictError");
        return true;
      },
    );

    await database.documents.insert({
      collection: "products",
      id: "product_1",
      data: { name: "Demo" },
    });

    await assert.rejects(
      () =>
        database.events.append({
          collection: "products",
          documentId: "product_1",
          type: "document.upserted",
          expectedRevision: 2,
          payload: { data: { name: "Outdated" } },
        }),
      (error) => {
        assert.equal(error instanceof DatabaseRevisionMismatchError, true);
        assert.equal(error.name, "DatabaseRevisionMismatchError");
        return true;
      },
    );
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("better-sqlite3 database persists time-series samples across reopen and rebuilds on definition version changes", async () => {
  const temp = createTempDatabasePath();

  try {
    const first = await createBetterSqlite3Database({
      filename: temp.filename,
    });

    await first.documents.createCollection({ name: "metrics" });
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

        const payload = event.payload;

        return {
          timestamp: payload.data.timestamp,
          value: payload.data.value,
        };
      },
    });

    await first.documents.insert({
      collection: "metrics",
      id: "m1",
      data: { timestamp: "2026-01-01T00:00:00.000Z", value: 10 },
    });
    await first.documents.insert({
      collection: "metrics",
      id: "m2",
      data: { timestamp: "2026-01-01T00:01:00.000Z", value: 20 },
    });

    assert.deepEqual(
      (await first.timeseries.get("metrics").range()).map(
        (point) => point.value,
      ),
      [10, 20],
    );

    const reopened = await createBetterSqlite3Database({
      filename: temp.filename,
    });
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

        const payload = event.payload;

        return {
          timestamp: payload.data.timestamp,
          value: payload.data.value,
        };
      },
    });

    await reopened.documents.insert({
      collection: "metrics",
      id: "m3",
      data: { timestamp: "2026-01-01T00:02:00.000Z", value: 30 },
    });

    assert.deepEqual(
      (await reopened.timeseries.get("metrics").range()).map(
        (point) => point.value,
      ),
      [10, 20, 30],
    );

    const rebuilt = await createBetterSqlite3Database({
      filename: temp.filename,
    });
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

        const payload = event.payload;

        return {
          timestamp: payload.data.timestamp,
          value: payload.data.value * 2,
        };
      },
    });

    assert.deepEqual(
      (await rebuilt.timeseries.get("metrics").range()).map(
        (point) => point.value,
      ),
      [20, 40, 60],
    );
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});
