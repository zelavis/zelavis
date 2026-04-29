import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { defineServerService, zelavisServer } from "../dist/index.js";
import { nextjsPagesRouterIntegration } from "../dist/integrations/nextjs-pages-router.js";

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

test("nextjsPagesRouterIntegration rewrites the API route path back to the mounted path", async () => {
  const runtime = await zelavisServer({
    services: [
      defineServerService({
        name: "demo",
        service: {},
        api: {
          v1: [
            {
              id: "demo.show",
              method: "POST",
              path: "/items/:id",
              handler: ({ params, request, body }) => ({
                status: 201,
                body: {
                  id: params.id,
                  body,
                  requestUrl: request.url,
                },
              }),
            },
          ],
        },
      }),
    ],
    prefix: "/zelavis",
  });

  const handler = nextjsPagesRouterIntegration(runtime, {
    routePrefix: "/api/zelavis",
    mountPath: "/zelavis",
  });
  const server = createServer((request, response) => {
    void handler(request, response).catch((error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/zelavis/demo/items/42`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ ok: true }),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      id: "42",
      body: { ok: true },
      requestUrl: `${baseUrl}/zelavis/demo/items/42`,
    });
  } finally {
    await close(server);
  }
});

test("nextjsPagesRouterIntegration preserves repeated headers and HEAD fallback", async () => {
  const runtime = await zelavisServer({
    services: [
      defineServerService({
        name: "demo",
        service: {},
        api: {
          v1: [
            {
              id: "demo.binary",
              method: "POST",
              path: "/binary",
              handler: ({ body }) => ({
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
          ],
        },
      }),
    ],
    prefix: "/zelavis",
  });

  const handler = nextjsPagesRouterIntegration(runtime, {
    routePrefix: "/api/zelavis",
    mountPath: "/zelavis",
  });
  const server = createServer((request, response) => {
    void handler(request, response).catch((error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  const baseUrl = await listen(server);

  try {
    const binaryResponse = await fetch(`${baseUrl}/api/zelavis/demo/binary`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
      },
      body: new Uint8Array([4, 5, 6]),
    });

    assert.deepEqual(
      new Uint8Array(await binaryResponse.arrayBuffer()),
      new Uint8Array([4, 5, 6]),
    );
    assert.deepEqual(binaryResponse.headers.getSetCookie(), [
      "a=1; Path=/",
      "b=2; Path=/",
    ]);

    const headResponse = await fetch(`${baseUrl}/api/zelavis/demo/head`, {
      method: "HEAD",
    });

    assert.equal(headResponse.status, 200);
    assert.equal(headResponse.headers.get("x-head"), "ok");
    assert.equal(await headResponse.text(), "");
  } finally {
    await close(server);
  }
});
