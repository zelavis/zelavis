import assert from "node:assert/strict";
import test from "node:test";
import { defineServerService, zelavisServer } from "../dist/index.js";
import { nodeIntegration } from "../dist/integrations/node.js";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.equal(typeof address, "object");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

test("nodeIntegration creates a native HTTP server and passes normalized request context", async () => {
  const serviceApi = { label: "demo-service" };
  const runtime = await zelavisServer({
    services: [
      defineServerService({
        name: "demo",
        service: serviceApi,
        api: {
          v1: [
            {
              id: "demo.show",
              method: "POST",
              path: "/items/:id",
              handler: ({ service, params, query, body, headers, request }) => ({
                status: 201,
                headers: {
                  "x-route": "demo.show",
                },
                body: {
                  service,
                  id: params.id,
                  tag: query.get("tag"),
                  tags: query.getAll("tag"),
                  body,
                  header: headers["x-test-header"],
                  requestUrl: request.url,
                },
              }),
            },
          ],
        },
      }),
    ],
    prefix: "/api",
    integration: nodeIntegration(),
  });

  const baseUrl = await listen(runtime.server);

  try {
    const response = await fetch(`${baseUrl}/api/demo/items/42?tag=one&tag=two`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-header": "present",
      },
      body: JSON.stringify({ ok: true }),
    });

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-route"), "demo.show");
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");

    const payload = await response.json();
    assert.deepEqual(payload, {
      service: serviceApi,
      id: "42",
      tag: "one",
      tags: ["one", "two"],
      body: { ok: true },
      header: "present",
      requestUrl: "/api/demo/items/42?tag=one&tag=two",
    });
  } finally {
    await close(runtime.server);
  }
});

test("nodeIntegration returns 404 for unmatched routes", async () => {
  const runtime = await zelavisServer({
    services: [],
    integration: nodeIntegration(),
  });
  const baseUrl = await listen(runtime.server);

  try {
    const response = await fetch(`${baseUrl}/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Not found",
    });
  } finally {
    await close(runtime.server);
  }
});

test("nodeIntegration supports trailing wildcard route params", async () => {
  const runtime = await zelavisServer({
    services: [
      defineServerService({
        name: "demo",
        service: {},
        api: {
          v1: [
            {
              id: "demo.fallback",
              method: "GET",
              path: "/*path",
              handler: ({ params }) => ({
                body: {
                  path: params.path,
                },
              }),
            },
          ],
        },
      }),
    ],
    prefix: "/api",
    integration: nodeIntegration(),
  });
  const baseUrl = await listen(runtime.server);

  try {
    const response = await fetch(`${baseUrl}/api/demo/one/two/three`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      path: "one/two/three",
    });
  } finally {
    await close(runtime.server);
  }
});

test("nodeIntegration uses the configured error handler", async () => {
  const runtime = await zelavisServer({
    services: [
      defineServerService({
        name: "demo",
        service: {},
        api: {
          v1: [
            {
              id: "demo.error",
              method: "GET",
              path: "/error",
              handler: () => {
                throw new Error("boom");
              },
            },
          ],
        },
      }),
    ],
    integration: nodeIntegration(),
    onError: ({ error, resolvedRoute }) => ({
      status: 418,
      body: {
        route: resolvedRoute.route.id,
        message: error instanceof Error ? error.message : "unknown",
      },
    }),
  });
  const baseUrl = await listen(runtime.server);

  try {
    const response = await fetch(`${baseUrl}/demo/error`);
    assert.equal(response.status, 418);
    assert.deepEqual(await response.json(), {
      route: "demo.error",
      message: "boom",
    });
  } finally {
    await close(runtime.server);
  }
});
