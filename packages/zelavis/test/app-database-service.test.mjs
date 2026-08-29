import assert from "node:assert/strict";
import test from "node:test";
import { createServiceRuntime } from "../dist/core/index.js";
import { createDatabase, defineDatabaseService } from "../dist/app/db/index.js";

test("databaseService exposes database routes through the existing service contract", async () => {
  const database = await createDatabase();

  const runtime = await createServiceRuntime({
    services: [defineDatabaseService(database)],
    prefix: "/api",
  });

  assert.equal(runtime.services["@zelavis/db"].service, database);
  assert.equal(runtime.services["@zelavis/db"].services[0].name, "documents");
  assert.equal(runtime.services["@zelavis/db"].services[1].name, "schemas");
  assert.equal(runtime.services["@zelavis/db"].services[2].name, "timeseries");
  assert.equal(runtime.services["@zelavis/db"].services[3].name, "maintenance");
  assert.equal(runtime.routes.length, 21);
  assert.deepEqual(
    runtime.routes.map((route) => route.fullPath),
    [
      "/api/database/menu/tables",
      "/api/database/health",
      "/api/database/documents/collections",
      "/api/database/documents/collections",
      "/api/database/documents/:collection",
      "/api/database/documents/:collection/:id",
      "/api/database/documents/:collection/query",
      "/api/database/documents/:collection/:id",
      "/api/database/documents/:collection/:id",
      "/api/database/schemas/collections",
      "/api/database/schemas/:collection",
      "/api/database/schemas/:collection",
      "/api/database/schemas/:collection/activate",
      "/api/database/schemas/:collection/validate",
      "/api/database/timeseries/series",
      "/api/database/timeseries/:series/range",
      "/api/database/timeseries/:series/aggregate",
      "/api/database/maintenance/system/views",
      "/api/database/maintenance/system/views/:view",
      "/api/database/maintenance/backups/export",
      "/api/database/maintenance/backups/restore",
    ],
  );
});

test("databaseService exposes database table rows through the service menu endpoint", async () => {
  const database = await createDatabase();
  const service = defineDatabaseService(database);
  const menuTables = service.api.v1.find(
    (route) => route.id === "database.menu.tables",
  );

  assert.ok(menuTables);
  await database.forTenant("default").documents.createCollection({ name: "products" });

  const response = await menuTables.handler({
    service: database,
    params: {},
    query: new URLSearchParams("tenantId=default"),
    body: undefined,
    headers: {},
    request: undefined,
  });

  assert.deepEqual(response.body, {
    items: [
      {
        title: "products",
        path: "/database",
        pageLabel: "Database",
        search: { databaseTable: "products" },
      },
      {
        title: "System · Collections",
        path: "/database",
        pageLabel: "Database",
        search: { databaseSystemView: "collections" },
      },
      {
        title: "System · Events",
        path: "/database",
        pageLabel: "Database",
        search: { databaseSystemView: "events" },
      },
      {
        title: "System · Schemas",
        path: "/database",
        pageLabel: "Database",
        search: { databaseSystemView: "schemas" },
      },
      {
        title: "System · Projections",
        path: "/database",
        pageLabel: "Database",
        search: { databaseSystemView: "projections" },
      },
      {
        title: "System · Time series",
        path: "/database",
        pageLabel: "Database",
        search: { databaseSystemView: "time-series" },
      },
    ],
  });
});

test("database maintenance exposes logical system views without physical tables", async () => {
  const database = await createDatabase();
  await database.forTenant("default").documents.createCollection({ name: "products" });
  await database.forTenant("default").documents.insert({
    collection: "products",
    id: "product-1",
    data: { name: "Coffee" },
  });

  const collections = await database.systemViews.query({
    name: "collections",
    tenantId: "default",
  });
  const events = await database.systemViews.query({
    name: "events",
    tenantId: "default",
  });

  assert.deepEqual(collections.rows.map((row) => row.id), ["products"]);
  assert.deepEqual(events.rows.map((row) => row.data.type), [
    "collection.created",
    "document.upserted",
  ]);
  assert.equal(JSON.stringify({ collections, events }).includes("zv_events"), false);
});

test("database tenant backups restore exact logical events idempotently", async () => {
  const source = await createDatabase();
  await source.schemas.save({
    collection: "products",
    version: 1,
    activate: true,
    fields: [
      { name: "name", field: { _tag: "TextField", label: "Name", required: true } },
    ],
  });
  await source.forTenant("default").documents.createCollection({ name: "products" });
  await source.forTenant("default").documents.insert({
    collection: "products",
    id: "product-1",
    data: { name: "Coffee" },
  });

  const backup = await source.backups.exportTenant("default");
  const restored = await createDatabase();
  assert.deepEqual(await restored.backups.restoreTenant(backup), {
    tenantId: "default",
    schemas: 1,
    events: 2,
  });
  await restored.backups.restoreTenant(backup);

  assert.deepEqual(
    await restored.forTenant("default").documents.findById({
      collection: "products",
      id: "product-1",
    }),
    await source.forTenant("default").documents.findById({
      collection: "products",
      id: "product-1",
    }),
  );
  assert.deepEqual(
    (await restored.forTenant("default").events.read()).map((event) => ({
      eventId: event.eventId,
      revision: event.revision,
      timestamp: event.timestamp,
    })),
    backup.events.map((event) => ({
      eventId: event.eventId,
      revision: event.revision,
      timestamp: event.timestamp,
    })),
  );
});

test("databaseService returns API errors for duplicate collections", async () => {
  const database = await createDatabase();
  const service = defineDatabaseService(database);
  const documents = await service.services[0];
  const createCollection = documents.api.v1.find(
    (route) => route.id === "database.collections.create",
  );

  const first = await createCollection.handler({
    service: database,
    params: {},
    query: new URLSearchParams(),
    body: { tenantId: "default", name: "products" },
    headers: {},
    request: undefined,
  });
  const duplicate = await createCollection.handler({
    service: database,
    params: {},
    query: new URLSearchParams(),
    body: { tenantId: "default", name: "products" },
    headers: {},
    request: undefined,
  });

  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /already exists/);
});

test("databaseService rejects ordinary data access without a Tenant", async () => {
  const database = await createDatabase();
  const service = defineDatabaseService(database);
  const documents = await service.services[0];
  const createCollection = documents.api.v1.find(
    (route) => route.id === "database.collections.create",
  );

  const response = await createCollection.handler({
    service: database,
    params: {},
    query: new URLSearchParams(),
    body: { name: "products" },
    headers: {},
    request: undefined,
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Tenant ID/);
});

test("database projection registration surfaces domain conflicts", async () => {
  const database = await createDatabase();

  await database.projections.register({
    name: "timeseries.metrics",
  });

  await assert.rejects(
    () =>
      database.projections.register({
        name: "timeseries.metrics",
      }),
    (error) => {
      assert.equal(error.name, "DatabaseConflictError");
      assert.match(error.message, /already registered/);
      return true;
    },
  );
});

test("databaseService can save and activate collection schemas", async () => {
  const database = await createDatabase();
  const service = defineDatabaseService(database);
  const schemas = await service.services[1];
  const saveSchema = schemas.api.v1.find(
    (route) => route.id === "database.schemas.save",
  );
  const activateSchema = schemas.api.v1.find(
    (route) => route.id === "database.schemas.activate",
  );
  const listVersions = schemas.api.v1.find(
    (route) => route.id === "database.schemas.versions.list",
  );

  const created = await saveSchema.handler({
    service: database,
    params: { collection: "products" },
    query: new URLSearchParams(),
    body: {
      version: 1,
      activate: true,
      fields: [
        { name: "name", field: { _tag: "TextField", label: "Name", required: true } },
      ],
    },
    headers: {},
    request: undefined,
  });

  const updated = await saveSchema.handler({
    service: database,
    params: { collection: "products" },
    query: new URLSearchParams(),
    body: {
      version: 2,
      fields: [
        { name: "name", field: { _tag: "TextField", label: "Name", required: true } },
        { name: "status", field: { _tag: "TextField", label: "Status", required: true } },
      ],
    },
    headers: {},
    request: undefined,
  });

  const activated = await activateSchema.handler({
    service: database,
    params: { collection: "products" },
    query: new URLSearchParams(),
    body: { version: 2 },
    headers: {},
    request: undefined,
  });

  const listed = await listVersions.handler({
    service: database,
    params: { collection: "products" },
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });

  assert.equal(created.status, 201);
  assert.equal(updated.status, 201);
  assert.equal(activated.body.version, 2);
  assert.deepEqual(
    listed.body.schemas.map((schema) => ({
      version: schema.version,
      active: schema.active,
    })),
    [
      { version: 1, active: false },
      { version: 2, active: true },
    ],
  );
});

test("databaseService returns 400 for schema validation failures", async () => {
  const database = await createDatabase();
  await database.forTenant("default").documents.createCollection({ name: "products" });
  await database.schemas.save({
    collection: "products",
    version: 1,
    activate: true,
    fields: [
      { name: "name", field: { _tag: "TextField", label: "Name", required: true } },
      { name: "price", field: { _tag: "NumberField", label: "Price", required: true, min: 0 } },
    ],
  });

  const service = defineDatabaseService(database);
  const documents = await service.services[0];
  const insertDocument = documents.api.v1.find(
    (route) => route.id === "database.documents.insert",
  );

  const response = await insertDocument.handler({
    service: database,
    params: { collection: "products" },
    query: new URLSearchParams(),
    body: {
      tenantId: "default",
      data: {
        name: "x",
      },
    },
    headers: {},
    request: undefined,
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Schema validation failed/);
});

test("databaseService exposes time-series list, range, and aggregate routes", async () => {
  const database = await createDatabase();
  await database.forTenant("default").documents.createCollection({ name: "metrics" });
  await database.projections.register({
    name: "timeseries.metrics",
    source: {
      collections: ["metrics"],
      eventTypes: ["document.upserted"],
    },
  });
  await database.timeseries.define({
    name: "metrics",
    description: "Application metrics.",
    projection: "timeseries.metrics",
    source: {
      collections: ["metrics"],
      eventTypes: ["document.upserted"],
    },
    map(event) {
      if (event.type !== "document.upserted") {
        return null;
      }

      return {
        timestamp: event.payload.data.timestamp,
        value: event.payload.data.value,
      };
    },
  });

  await database.forTenant("default").documents.insert({
    collection: "metrics",
    id: "m1",
    data: { timestamp: "2026-01-01T00:00:00.000Z", value: 10 },
  });
  await database.forTenant("default").documents.insert({
    collection: "metrics",
    id: "m2",
    data: { timestamp: "2026-01-01T00:01:00.000Z", value: 20 },
  });
  await database.forTenant("default").documents.insert({
    collection: "metrics",
    id: "m3",
    data: { timestamp: "2026-01-01T00:02:00.000Z", value: 30 },
  });

  const service = defineDatabaseService(database);
  const timeseries = await service.services[2];
  const listSeries = timeseries.api.v1.find(
    (route) => route.id === "database.timeseries.list",
  );
  const readRange = timeseries.api.v1.find(
    (route) => route.id === "database.timeseries.range",
  );
  const readAggregate = timeseries.api.v1.find(
    (route) => route.id === "database.timeseries.aggregate",
  );

  const listed = await listSeries.handler({
    service: database,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });
  const ranged = await readRange.handler({
    service: database,
    params: { series: "metrics" },
    query: new URLSearchParams(),
    body: {
      tenantId: "default",
      start: "2026-01-01T00:01:00.000Z",
      order: "desc",
    },
    headers: {},
    request: undefined,
  });
  const aggregated = await readAggregate.handler({
    service: database,
    params: { series: "metrics" },
    query: new URLSearchParams(),
    body: {
      tenantId: "default",
      op: "sum",
      start: "2026-01-01T00:01:00.000Z",
    },
    headers: {},
    request: undefined,
  });

  assert.deepEqual(listed.body.series, [
    {
      name: "metrics",
      description: "Application metrics.",
      projection: "timeseries.metrics",
    },
  ]);
  assert.deepEqual(
    ranged.body.points.map((point) => point.value),
    [30, 20],
  );
  assert.equal(aggregated.body.value, 50);
});
