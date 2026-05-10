import assert from "node:assert/strict";
import test from "node:test";
import { Elysia } from "elysia";
import { defineService, zelavisServer } from "../dist/index.js";
import { elysiaAdapter } from "../dist/adapters/elysia.js";

test("elysiaAdapter mounts Zelavis as an Elysia plugin and preserves normalized request context", async () => {
  const serviceApi = { label: "demo-service" };
  const runtime = await zelavisServer({
    services: [
      defineService({
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
                  requestIsRequest: request instanceof Request,
                },
              }),
            },
          ],
        },
      }),
    ],
    prefix: "/api",
  });

  const app = new Elysia()
    .get("/hello", () => "Hello Elysia")
    .use(elysiaAdapter(runtime));

  const hostResponse = await app.handle(new Request("http://localhost/hello"));
  assert.equal(hostResponse.status, 200);
  assert.equal(await hostResponse.text(), "Hello Elysia");

  const response = await app.handle(
    new Request("http://localhost/api/demo/items/42?tag=one&tag=two", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-header": "present",
      },
      body: JSON.stringify({ ok: true }),
    }),
  );

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-route"), "demo.show");
  assert.deepEqual(await response.json(), {
    service: serviceApi,
    id: "42",
    tag: "one",
    tags: ["one", "two"],
    body: { ok: true },
    header: "present",
    requestIsRequest: true,
  });
});

test("elysiaAdapter preserves binary bodies, repeated headers, and HEAD fallback", async () => {
  const runtime = await zelavisServer({
    services: [
      defineService({
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
  });

  const app = new Elysia().use(elysiaAdapter(runtime));

  const binaryResponse = await app.handle(
    new Request("http://localhost/demo/binary", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
      },
      body: Buffer.from([5, 6, 7]),
    }),
  );

  assert.deepEqual(
    Buffer.from(await binaryResponse.arrayBuffer()),
    Buffer.from([5, 6, 7]),
  );
  assert.deepEqual(binaryResponse.headers.getSetCookie(), [
    "a=1; Path=/",
    "b=2; Path=/",
  ]);

  const headResponse = await app.handle(
    new Request("http://localhost/demo/head", {
      method: "HEAD",
    }),
  );

  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get("x-head"), "ok");
  assert.equal(await headResponse.text(), "");
});

test("elysiaAdapter uses the configured error handler", async () => {
  const runtime = await zelavisServer({
    services: [
      defineService({
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
    onError: ({ error, resolvedRoute }) => ({
      status: 418,
      body: {
        route: resolvedRoute.route.id,
        message: error instanceof Error ? error.message : "unknown",
      },
    }),
  });

  const app = new Elysia().use(elysiaAdapter(runtime));
  const response = await app.handle(new Request("http://localhost/demo/error"));

  assert.equal(response.status, 418);
  assert.deepEqual(await response.json(), {
    route: "demo.error",
    message: "boom",
  });
});
