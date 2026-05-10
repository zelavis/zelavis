import assert from "node:assert/strict";
import test from "node:test";
import { defineService, resolveMountedEndpoints } from "../dist/index.js";

const noopHandler = () => ({ status: 204 });

function createService(overrides = {}) {
  return defineService({
    name: "catalog",
    basePath: "/commerce/",
    service: { id: "catalog-api" },
    api: {
      v1: [
        {
          id: "products.list",
          method: "GET",
          path: " /products/ ",
          handler: noopHandler,
        },
        {
          id: "products.root",
          method: "GET",
          path: "/",
          handler: noopHandler,
        },
      ],
      v2: [
        {
          id: "products.admin",
          method: "POST",
          path: "/admin/products",
          handler: noopHandler,
        },
      ],
    },
    ...overrides,
  });
}

test("resolveMountedEndpoints normalizes prefixes, service paths, and route paths", () => {
  const routes = resolveMountedEndpoints([createService()], {
    prefix: "/api/",
  });

  assert.deepEqual(
    routes.map((resolved) => resolved.fullPath),
    ["/api/commerce/products", "/api/commerce"],
  );
});

test("resolveMountedEndpoints applies service prefixes and endpoint path overrides", () => {
  const routes = resolveMountedEndpoints([createService()], {
    prefix: " api ",
    servicePrefixes: {
      catalog: "shop",
    },
    pathOverrides: {
      "products.list": "/items/:id/",
    },
  });

  assert.equal(routes[0].fullPath, "/api/shop/items/:id");
  assert.equal(routes[1].fullPath, "/api/shop");
});

test("resolveMountedEndpoints defaults to v1 and can select another API version", () => {
  const service = createService();

  const defaultRoutes = resolveMountedEndpoints([service]);
  assert.deepEqual(
    defaultRoutes.map((resolved) => resolved.route.id),
    ["products.list", "products.root"],
  );

  const v2Routes = resolveMountedEndpoints([service], { version: "v2" });
  assert.deepEqual(
    v2Routes.map((resolved) => resolved.route.id),
    ["products.admin"],
  );
  assert.equal(v2Routes[0].fullPath, "/commerce/admin/products");
});

test("resolveMountedEndpoints skips services without routes for the selected version", () => {
  const service = createService({
    name: "empty",
    basePath: undefined,
    api: {},
  });

  assert.deepEqual(resolveMountedEndpoints([service]), []);
});

test("resolveMountedEndpoints recursively mounts nested services", () => {
  const service = defineService({
    name: "database",
    basePath: "database",
    service: {},
    api: {
      v1: [
        {
          id: "database.health",
          method: "GET",
          path: "/health",
          handler: noopHandler,
        },
      ],
    },
    services: [
      defineService({
        name: "documents",
        basePath: "documents",
        service: {},
        api: {
          v1: [
            {
              id: "database.documents.list",
              method: "GET",
              path: "/:collection",
              handler: noopHandler,
            },
          ],
        },
      }),
    ],
  });

  const routes = resolveMountedEndpoints([service], {
    prefix: "/api",
    pathOverrides: {
      "database.documents.list": "/collections/:collection",
    },
  });

  assert.deepEqual(
    routes.map((resolved) => [resolved.route.id, resolved.fullPath]),
    [
      ["database.health", "/api/database/health"],
      ["database.documents.list", "/api/database/documents/collections/:collection"],
    ],
  );
});
