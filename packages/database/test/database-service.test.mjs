import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase, defineDatabaseService } from "../dist/index.js";
import { zelavisServer } from "../../server/dist/index.js";

test("databaseService exposes database routes through the existing service contract", async () => {
  const database = await createDatabase();

  const runtime = await zelavisServer({
    services: [defineDatabaseService(database)],
    prefix: "/api",
  });

  assert.equal(runtime.services.database.service, database);
  assert.equal(runtime.services.database.services[0].name, "documents");
  assert.equal(runtime.services.database.services[1].name, "schemas");
  assert.equal(runtime.services.database.services[2].name, "timeseries");
  assert.equal(runtime.routes.length, 18);
  assert.deepEqual(
    runtime.routes.map((route) => route.fullPath),
    [
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
      "/api/database/sql/system/tables",
      "/api/database/sql/system/:table",
    ],
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
    body: { name: "products" },
    headers: {},
    request: undefined,
  });
  const duplicate = await createCollection.handler({
    service: database,
    params: {},
    query: new URLSearchParams(),
    body: { name: "products" },
    headers: {},
    request: undefined,
  });

  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /already exists/);
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

test("databaseService can register and activate collection schemas", async () => {
  const database = await createDatabase();
  const service = defineDatabaseService(database);
  const schemas = await service.services[1];
  const registerSchema = schemas.api.v1.find(
    (route) => route.id === "database.schemas.register",
  );
  const activateSchema = schemas.api.v1.find(
    (route) => route.id === "database.schemas.activate",
  );
  const listVersions = schemas.api.v1.find(
    (route) => route.id === "database.schemas.versions.list",
  );

  const created = await registerSchema.handler({
    service: database,
    params: { collection: "products" },
    query: new URLSearchParams(),
    body: {
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
    },
    headers: {},
    request: undefined,
  });

  const updated = await registerSchema.handler({
    service: database,
    params: { collection: "products" },
    query: new URLSearchParams(),
    body: {
      version: 2,
      document: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["draft", "published"] },
        },
      },
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
  await database.documents.createCollection({ name: "products" });
  await database.schemas.register({
    collection: "products",
    version: 1,
    activate: true,
    document: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 3 },
      },
    },
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
  await database.documents.createCollection({ name: "metrics" });
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

  await database.documents.insert({
    collection: "metrics",
    id: "m1",
    data: { timestamp: "2026-01-01T00:00:00.000Z", value: 10 },
  });
  await database.documents.insert({
    collection: "metrics",
    id: "m2",
    data: { timestamp: "2026-01-01T00:01:00.000Z", value: 20 },
  });
  await database.documents.insert({
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
