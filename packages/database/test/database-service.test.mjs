import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase, databaseService } from "../dist/index.js";
import { zelavisServer } from "../../server/dist/index.js";

test("databaseService exposes database routes through the existing service contract", async () => {
  const database = await createDatabase();
  const mounted = {};

  const runtime = await zelavisServer({
    services: [databaseService(database)],
    prefix: "/api",
    integration: {
      mount(routes) {
        mounted.routes = routes;
        return { routeCount: routes.length };
      },
    },
  });

  assert.equal(runtime.services.database.service, database);
  assert.equal(runtime.server.routeCount, 8);
  assert.deepEqual(
    mounted.routes.map((route) => route.fullPath),
    [
      "/api/database/health",
      "/api/database/collections",
      "/api/database/collections",
      "/api/database/documents/:collection",
      "/api/database/documents/:collection/:id",
      "/api/database/documents/:collection/query",
      "/api/database/documents/:collection/:id",
      "/api/database/documents/:collection/:id",
    ],
  );
});
