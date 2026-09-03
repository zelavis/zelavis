import assert from "node:assert/strict";
import test from "node:test";
import {
  createServiceRuntime,
  generateOpenApiSpec,
} from "../dist/core/index.js";
import { createDatabase, defineDatabaseService } from "../dist/app/db/index.js";
import { zelavis } from "../dist/index.js";
import { zelavisUiFrontend } from "@zelavis/ui/frontend";

test("generateOpenApiSpec produces valid OpenAPI 3.1 skeleton for empty routes", () => {
  const spec = generateOpenApiSpec([], {
    title: "Test API",
    version: "2.0.0",
    description: "A test API specification",
    servers: [{ url: "https://api.example.com", description: "Production" }],
  });

  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.info.title, "Test API");
  assert.equal(spec.info.version, "2.0.0");
  assert.equal(spec.info.description, "A test API specification");
  assert.deepEqual(spec.servers, [
    { url: "https://api.example.com", description: "Production" },
  ]);
  assert.deepEqual(spec.paths, {});
});

test("generateOpenApiSpec converts routes with spec into OpenAPI paths and operations", () => {
  const routes = [
    {
      fullPath: "/api/v1/items/:itemId",
      route: {
        id: "items.get",
        method: "GET",
        path: "/:itemId",
        spec: {
          operationId: "getItem",
          summary: "Get an item by ID",
          description: "Returns the item details.",
          tags: ["items"],
          pathParams: {
            itemId: {
              type: "string",
              description: "The unique item ID",
            },
          },
          queryParams: {
            includeDetails: {
              type: "boolean",
              required: false,
              description: "Whether to include full details",
            },
          },
          responses: {
            200: {
              description: "Item details",
              schema: {
                type: "object",
                properties: { id: { type: "string" }, name: { type: "string" } },
              },
            },
            404: {
              description: "Item not found",
            },
          },
        },
        handler: () => ({ status: 200, body: {} }),
      },
      service: { name: "items", api: {} },
    },
    {
      fullPath: "/api/v1/internal/health",
      route: {
        id: "internal.health",
        method: "GET",
        path: "/health",
        // No spec field — described anyway, and marked as undocumented
        handler: () => ({ status: 200, body: { ok: true } }),
      },
      service: { name: "internal", api: {} },
    },
  ];

  const spec = generateOpenApiSpec(routes);

  // A route with no spec is still described. Omitting it left the document
  // looking complete while most of the API was missing from it; marking it
  // says which endpoints exist but have no inputs or responses written down.
  const health = spec.paths["/api/v1/internal/health"].get;
  assert.equal(health["x-zelavis-undocumented"], true);
  assert.equal(health.operationId, "internal.health");
  assert.deepEqual(health.tags, ["internal"]);

  // Path with :itemId should be transformed to {itemId}
  const itemPath = spec.paths["/api/v1/items/{itemId}"];
  assert.ok(itemPath);
  assert.ok(itemPath.get);

  const getOp = itemPath.get;
  assert.equal(getOp.operationId, "getItem");
  assert.equal(getOp.summary, "Get an item by ID");
  assert.equal(getOp.description, "Returns the item details.");
  assert.deepEqual(getOp.tags, ["items"]);

  // Verify parameters
  assert.equal(getOp.parameters.length, 2);
  const pathParam = getOp.parameters.find((p) => p.in === "path");
  assert.deepEqual(pathParam, {
    name: "itemId",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "The unique item ID",
  });

  const queryParam = getOp.parameters.find((p) => p.in === "query");
  assert.deepEqual(queryParam, {
    name: "includeDetails",
    in: "query",
    schema: { type: "boolean" },
    description: "Whether to include full details",
  });

  // Verify responses
  assert.ok(getOp.responses["200"]);
  assert.equal(getOp.responses["200"].description, "Item details");
  assert.deepEqual(getOp.responses["200"].content["application/json"].schema, {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" } },
  });
  assert.ok(getOp.responses["404"]);
  assert.equal(getOp.responses["404"].description, "Item not found");
});

test("database service generates complete OpenAPI spec with typed operations", async () => {
  const database = await createDatabase();
  const runtime = await createServiceRuntime({
    services: [defineDatabaseService(database)],
    prefix: "/api",
  });

  const spec = generateOpenApiSpec(runtime.routes, {
    title: "Zelavis Database API",
    version: "1.0.0",
  });

  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.info.title, "Zelavis Database API");

  // Verify key database operations are documented
  const collectionsPath = spec.paths["/api/database/documents/collections"];
  assert.ok(collectionsPath, "collections path should exist");
  assert.ok(collectionsPath.get, "GET collections should exist");
  assert.equal(collectionsPath.get.operationId, "listCollections");
  assert.ok(collectionsPath.post, "POST collections should exist");
  assert.equal(collectionsPath.post.operationId, "createCollection");

  const docInsertPath = spec.paths["/api/database/documents/{collection}"];
  assert.ok(docInsertPath, "document insert path should exist");
  assert.ok(docInsertPath.post, "POST document insert should exist");
  assert.equal(docInsertPath.post.operationId, "insertDocument");
  assert.deepEqual(docInsertPath.post.tags, ["documents"]);

  const docPath = spec.paths["/api/database/documents/{collection}/{id}"];
  assert.ok(docPath, "document get/update/delete path should exist");
  assert.ok(docPath.get, "GET document should exist");
  assert.equal(docPath.get.operationId, "getDocument");
  assert.ok(docPath.patch, "PATCH document should exist");
  assert.equal(docPath.patch.operationId, "updateDocument");
  assert.ok(docPath.delete, "DELETE document should exist");
  assert.equal(docPath.delete.operationId, "deleteDocument");

  const queryPath = spec.paths["/api/database/documents/{collection}/query"];
  assert.ok(queryPath, "document query path should exist");
  assert.ok(queryPath.post, "POST document query should exist");
  assert.equal(queryPath.post.operationId, "queryDocuments");

  const timeseriesRangePath = spec.paths["/api/database/timeseries/{series}/range"];
  assert.ok(timeseriesRangePath, "timeseries range path should exist");
  assert.ok(timeseriesRangePath.post, "POST timeseries range should exist");
  assert.equal(timeseriesRangePath.post.operationId, "queryTimeSeriesRange");
});

test("Zelavis runtime exposes /zelavis/api/v1/runtime/openapi.json", async () => {
  const app = await zelavis({
    frontend: zelavisUiFrontend,
  });

  try {
    const response = await app.plain({
      url: "/zelavis/api/v1/runtime/openapi.json",
      method: "GET",
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "application/json");

    const spec = response.body;
    assert.equal(spec.openapi, "3.1.0");
    assert.equal(spec.info.title, "Zelavis API");
    assert.ok(spec.paths);

    // Should include database and auth paths from mounted core services
    const pathKeys = Object.keys(spec.paths);
    assert.ok(pathKeys.length > 0, "OpenAPI spec should contain registered paths");
    const hasDatabasePath = pathKeys.some((p) => p.includes("database"));
    assert.ok(hasDatabasePath, "OpenAPI spec should contain database endpoints");
  } finally {
    await app.close();
  }
});
