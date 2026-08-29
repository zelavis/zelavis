import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DatabaseConflictError,
  DatabaseDomainError,
  DatabaseRevisionMismatchError,
  createDatabase,
} from "../dist/app/db/index.js";
import {
  createBetterSqlite3Database,
  createBetterSqlite3DatabaseDriver,
} from "../dist/app/db/adapters/node-sqlite.js";

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
    assert.equal(found?.data.name, "T-shirt");

    const published = await standard.documents.findMany({
      collection: "products",
      where: [{ path: "status", value: "published" }],
    });
    assert.equal(published.length, 1);

    const updated = await standard.documents.update({
      collection: "products",
      id: product.id,
      data: { status: "archived" },
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.data.status, "archived");

    assert.equal(
      await standard.documents.delete({
        collection: "products",
        id: product.id,
      }),
      true,
    );
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("better-sqlite3 persists logical data while SQL stays on the physical driver", async () => {
  const temp = createTempDatabasePath();

  try {
    const firstDriver = createBetterSqlite3DatabaseDriver({ filename: temp.filename });
    const first = await createDatabase({ driver: firstDriver });
    await first.forTenant("default").documents.createCollection({ name: "products" });
    await first.forTenant("default").documents.insert({
      collection: "products",
      id: "shirt_1",
      data: {
        name: "Persisted shirt",
        price: 30,
      },
    });

    const reopenedDriver = createBetterSqlite3DatabaseDriver({ filename: temp.filename });
    const reopened = await createDatabase({ driver: reopenedDriver });
    const found = await reopened.forTenant("default").documents.findById({
      collection: "products",
      id: "shirt_1",
    });

    assert.equal(found?.data.name, "Persisted shirt");
    assert.equal(reopened.sql, undefined);
    assert.ok(reopenedDriver.sql);

    const tables = await reopenedDriver.sql.query({
      statement: "SELECT name FROM sqlite_master WHERE type = 'table'",
    });
    const tableNames = new Set(tables?.rows.map((row) => row.name));
    assert.equal(tableNames.has("products"), true);
    assert.equal(tableNames.has("documents"), false);

    const query = await reopenedDriver.sql.query({
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
      reopened.schemas.listVersions("products").map((schema) => ({
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

    const reopened = await createBetterSqlite3Database({
      filename: temp.filename,
    });
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

    await database.forTenant("default").events.append({
      collection: "products",
      type: "collection.created",
      expectedRevision: 0,
      payload: { metadata: { source: "test" } },
    });

    await assert.rejects(
      () =>
        database.forTenant("default").events.append({
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

    await database.forTenant("default").documents.insert({
      collection: "products",
      id: "product_1",
      data: { name: "Demo" },
    });

    await assert.rejects(
      () =>
        database.forTenant("default").events.append({
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

test("better-sqlite3 serializes competing writes to one event stream", async () => {
  const temp = createTempDatabasePath();
  try {
    const database = await createBetterSqlite3Database({ filename: temp.filename });
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

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected);
    assert.ok(rejected.reason instanceof DatabaseRevisionMismatchError);
    const events = await tenant.events.read({
      collection: "products",
      documentId: "product_1",
    });
    assert.deepEqual(events.map((event) => event.revision), [1, 2]);
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("better-sqlite3 deduplicates concurrent idempotent appends", async () => {
  const temp = createTempDatabasePath();
  try {
    const database = await createBetterSqlite3Database({ filename: temp.filename });
    const tenant = database.forTenant("default");
    const append = () =>
      tenant.events.append({
        collection: "products",
        type: "collection.created",
        expectedRevision: 0,
        idempotencyKey: "create-products",
        payload: { metadata: { source: "concurrent-test" } },
      });
    const [first, second] = await Promise.all([append(), append()]);
    assert.equal(second.eventId, first.eventId);
    assert.equal(
      (await tenant.events.read({ collection: "products" })).length,
      1,
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

        const payload = event.payload;

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

    assert.deepEqual(
      (await first.forTenant("default").timeseries.get("metrics").range()).map(
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

    await reopened.forTenant("default").documents.insert({
      collection: "metrics",
      id: "m3",
      data: { timestamp: "2026-01-01T00:02:00.000Z", value: 30 },
    });

    assert.deepEqual(
      (await reopened.forTenant("default").timeseries.get("metrics").range()).map(
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
      (await rebuilt.forTenant("default").timeseries.get("metrics").range()).map(
        (point) => point.value,
      ),
      [20, 40, 60],
    );
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("physical sql.execute() blocks direct writes to registered collection tables", async () => {
  const temp = createTempDatabasePath();

  try {
    const driver = createBetterSqlite3DatabaseDriver({ filename: temp.filename });
    const database = await createDatabase({ driver });
    assert.ok(driver.sql);

    await database.forTenant("default").documents.createCollection({ name: "fruits" });

    // INSERT is blocked.
    await assert.rejects(
      () =>
        driver.sql.execute({
          statement:
            'INSERT INTO "fruits" (tenant_id, id, data_json, created_at, updated_at, version, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)',
          parameters: ["default", "x", "{}", "2026-01-01", "2026-01-01", 1, 1],
        }),
      (err) => {
        assert.ok(err instanceof DatabaseDomainError);
        assert.match(err.message, /fruits/);
        assert.match(err.message, /documents API/i);
        return true;
      },
    );

    // UPDATE is blocked.
    await assert.rejects(
      () =>
        driver.sql.execute({
          statement: 'UPDATE "fruits" SET data_json = ? WHERE id = ?',
          parameters: ["{}", "x"],
        }),
      DatabaseDomainError,
    );

    // DELETE is blocked.
    await assert.rejects(
      () =>
        driver.sql.execute({
          statement: 'DELETE FROM "fruits" WHERE id = ?',
          parameters: ["x"],
        }),
      DatabaseDomainError,
    );

    // CTE column lists and comments cannot hide a protected write.
    await assert.rejects(
      () =>
        driver.sql.execute({
          statement:
            '/* prefix */ WITH cte(x) AS (SELECT 1) DELETE FROM "fruits" WHERE tenant_id = ?',
          parameters: ["default"],
        }),
      DatabaseDomainError,
    );

    // sql.execute is deliberately single-statement, so a harmless prefix
    // cannot hide a later mutation even on gateways that accept batches.
    await assert.rejects(
      () =>
        driver.sql.execute({
          statement: "UPDATE zv_collections SET document_count = document_count; DELETE FROM fruits",
        }),
      /exactly one SQL statement/,
    );

    // A trigger on a raw table could otherwise mutate a collection indirectly.
    await driver.sql.execute({
      statement: "CREATE TABLE raw_imports (id TEXT)",
    });
    await assert.rejects(
      () =>
        driver.sql.execute({
          statement:
            'CREATE TEMP TRIGGER raw_import_cleanup AFTER INSERT ON raw_imports BEGIN DELETE FROM "fruits"; END',
        }),
      /trigger definitions are not permitted/i,
    );

    // Writes to system tables are still allowed (they are not registered user collections).
    await assert.doesNotReject(() =>
      driver.sql.execute({
        statement:
          "INSERT OR IGNORE INTO zv_collections (tenant_id, name, created_at, document_count) VALUES (?, ?, ?, ?)",
        parameters: ["default", "canary", new Date().toISOString(), 0],
      }),
    );

    // Reads against collection tables are unaffected.
    const result = await driver.sql.query({
      statement: 'SELECT COUNT(*) AS c FROM "fruits"',
    });
    assert.equal(result.rows[0].c, 0);
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});
