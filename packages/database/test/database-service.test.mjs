import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase, databaseService } from "../dist/index.js";
import { zelavisServer } from "../../server/dist/index.js";

test("databaseService exposes database routes through the existing service contract", async () => {
  const database = await createDatabase();

  const runtime = await zelavisServer({
    services: [databaseService(database)],
    prefix: "/api",
  });

  assert.equal(runtime.services.database.service, database);
  assert.equal(runtime.services.database.services[0].name, "documents");
  assert.equal(runtime.routes.length, 8);
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
    ],
  );
});

test("databaseService returns API errors for duplicate collections", async () => {
  const database = await createDatabase();
  const service = databaseService(database);
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
