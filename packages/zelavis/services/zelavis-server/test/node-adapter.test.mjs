import assert from "node:assert/strict";
import test from "node:test";
import { zelavisServer } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";

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

test("nodeAdapter creates a native HTTP server and passes normalized request context", async () => {
  const serviceApi = { label: "demo-service" };
  const runtime = await zelavisServer({
    services: [
      {
        name: "demo",
        service: serviceApi,
        api: {
          v1: [
            {
              id: "demo.show",
              method: "POST",
              path: "/items/:id",
              handler: ({
                service,
                params,
                query,
                body,
                headers,
                request,
              }) => ({
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
      },
    ],
    prefix: "/api",
  });
  const server = nodeAdapter(runtime);

  const baseUrl = await listen(server);

  try {
    const response = await fetch(
      `${baseUrl}/api/demo/items/42?tag=one&tag=two`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-header": "present",
        },
        body: JSON.stringify({ ok: true }),
      },
    );

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-route"), "demo.show");
    assert.equal(
      response.headers.get("content-type"),
      "application/json; charset=utf-8",
    );

    const payload = await response.json();
    assert.deepEqual(payload, {
      service: serviceApi,
      id: "42",
      tag: "one",
      tags: ["one", "two"],
      body: { ok: true },
      header: "present",
      requestUrl: `${baseUrl}/api/demo/items/42?tag=one&tag=two`,
    });
  } finally {
    await close(server);
  }
});

test("nodeAdapter returns 404 for unmatched routes", async () => {
  const runtime = await zelavisServer({
    services: [],
  });
  const server = nodeAdapter(runtime);
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Not found",
    });
  } finally {
    await close(server);
  }
});

test("nodeAdapter supports HEAD fallback, binary bodies, and repeated set-cookie headers", async () => {
  const runtime = await zelavisServer({
    services: [
      {
        name: "demo",
        service: {},
        api: {
          v1: [
            {
              id: "demo.binary",
              method: "POST",
              path: "/binary",
              handler: ({ body }) => ({
                status: 200,
                headers: new Headers([
                  ["content-type", "application/octet-stream"],
                  ["set-cookie", "a=1; Path=/"],
                  ["set-cookie", "b=2; Path=/"],
                ]),
                body,
              }),
            },
            {
              id: "demo.head",
              method: "GET",
              path: "/head",
              handler: () => ({
                headers: {
                  "x-head": "ok",
                },
                body: "visible-on-get",
              }),
            },
            {
              id: "demo.empty",
              method: "GET",
              path: "/empty",
              handler: () => ({
                status: 204,
                headers: {
                  "content-type": "application/json",
                },
                body: { ignored: true },
              }),
            },
          ],
        },
      },
    ],
  });
  const server = nodeAdapter(runtime);
  const baseUrl = await listen(server);

  try {
    const binaryResponse = await fetch(`${baseUrl}/demo/binary`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
      },
      body: new Uint8Array([1, 2, 3, 4]),
    });

    assert.equal(binaryResponse.status, 200);
    assert.deepEqual(
      new Uint8Array(await binaryResponse.arrayBuffer()),
      new Uint8Array([1, 2, 3, 4]),
    );
    assert.deepEqual(binaryResponse.headers.getSetCookie(), [
      "a=1; Path=/",
      "b=2; Path=/",
    ]);

    const headResponse = await fetch(`${baseUrl}/demo/head`, {
      method: "HEAD",
    });

    assert.equal(headResponse.status, 200);
    assert.equal(headResponse.headers.get("x-head"), "ok");
    assert.equal(await headResponse.text(), "");

    const emptyResponse = await fetch(`${baseUrl}/demo/empty`);
    assert.equal(emptyResponse.status, 204);
    assert.equal(emptyResponse.headers.get("content-type"), null);
    assert.equal(await emptyResponse.text(), "");
  } finally {
    await close(server);
  }
});

test("nodeAdapter supports trailing wildcard route params", async () => {
  const runtime = await zelavisServer({
    services: [
      {
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
      },
    ],
    prefix: "/api",
  });
  const server = nodeAdapter(runtime);
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/demo/one/two/three`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      path: "one/two/three",
    });
  } finally {
    await close(server);
  }
});

test("nodeAdapter uses the configured error handler", async () => {
  const runtime = await zelavisServer({
    services: [
      {
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
      },
    ],
    onError: ({ error, resolvedRoute }) => ({
      status: 418,
      body: {
        route: resolvedRoute.route.id,
        message: error instanceof Error ? error.message : "unknown",
      },
    }),
  });
  const server = nodeAdapter(runtime);
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/demo/error`);
    assert.equal(response.status, 418);
    assert.deepEqual(await response.json(), {
      route: "demo.error",
      message: "boom",
    });
  } finally {
    await close(server);
  }
});
