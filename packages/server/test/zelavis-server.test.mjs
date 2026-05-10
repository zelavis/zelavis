import assert from "node:assert/strict";
import test from "node:test";
import { defineService, zelavisServer } from "../dist/index.js";

test("zelavisServer resolves promised services and returns service map plus routes", async () => {
  const serviceApi = { version: "test" };
  const service = Promise.resolve(
    defineService({
      name: "orders",
      service: serviceApi,
      api: {
        v1: [
          {
            id: "orders.list",
            method: "GET",
            path: "/",
            handler: () => ({ body: [] }),
          },
        ],
      },
    }),
  );
  const onError = () => ({ status: 500 });

  const runtime = await zelavisServer({
    services: [service],
    prefix: "/api",
    servicePrefixes: {
      orders: "commerce/orders",
    },
    pathOverrides: {
      "orders.list": "/all",
    },
    onError,
  });

  assert.equal(runtime.services.orders.service, serviceApi);
  assert.equal(runtime.routes.length, 1);
  assert.equal(runtime.routes[0].fullPath, "/api/commerce/orders/all");
  assert.equal(runtime.routes[0].service.name, "orders");
  assert.equal(runtime.dispatch, runtime.dispatch);
});

test("zelavisServer resolves promised nested services without adding them to the top-level service map", async () => {
  const child = Promise.resolve(
    defineService({
      name: "child",
      service: { nested: true },
      api: {
        v1: [
          {
            id: "parent.child",
            method: "GET",
            path: "/",
            handler: () => ({ status: 204 }),
          },
        ],
      },
    }),
  );
  const parent = defineService({
    name: "parent",
    service: { root: true },
    api: {},
    services: [child],
  });
  const runtime = await zelavisServer({
    services: [parent],
  });

  assert.deepEqual(Object.keys(runtime.services), ["parent"]);
  assert.equal(runtime.services.parent.services[0].name, "child");
  assert.equal(runtime.routes.length, 1);
  assert.equal(runtime.routes[0].fullPath, "/parent/child");
  assert.equal(runtime.routes[0].service.name, "child");
});

test("zelavisServer exposes fetch and plain handlers without requiring a mount adapter", async () => {
  const runtime = await zelavisServer({
    services: [
      defineService({
        name: "demo",
        service: { label: "plain" },
        api: {
          v1: [
            {
              id: "demo.show",
              method: "POST",
              path: "/items/:id",
              handler: ({ service, params, body, request }) => ({
                status: 201,
                body: {
                  service,
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
    prefix: "/api",
  });

  const fetchResponse = await runtime.fetch(
    new Request("http://localhost/api/demo/items/42", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ ok: true }),
    }),
  );

  assert.equal(fetchResponse.status, 201);
  assert.deepEqual(await fetchResponse.json(), {
    service: { label: "plain" },
    id: "42",
    body: { ok: true },
    requestUrl: "http://localhost/api/demo/items/42",
  });

  const plainResponse = await runtime.plain({
    url: "/api/demo/items/99",
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: { ok: false },
  });

  assert.equal(plainResponse.matched, true);
  assert.equal(plainResponse.status, 201);
  assert.equal(
    plainResponse.responseHeaders.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.deepEqual(plainResponse.body, {
    service: { label: "plain" },
    id: "99",
    body: { ok: false },
    requestUrl: "http://localhost/api/demo/items/99",
  });
});

test("zelavisServer parses multipart payloads and preserves repeated response headers", async () => {
  const runtime = await zelavisServer({
    services: [
      defineService({
        name: "demo",
        service: {},
        api: {
          v1: [
            {
              id: "demo.upload",
              method: "POST",
              path: "/upload",
              handler: ({ body }) => ({
                headers: new Headers([
                  ["set-cookie", "a=1; Path=/"],
                  ["set-cookie", "b=2; Path=/"],
                ]),
                body: {
                  title: body.title,
                  tags: body.tag,
                  fileName:
                    typeof body.file === "object" && body.file
                      ? body.file.name
                      : undefined,
                },
              }),
            },
          ],
        },
      }),
    ],
  });

  const formData = new FormData();
  formData.append("title", "demo");
  formData.append("tag", "one");
  formData.append("tag", "two");
  formData.append(
    "file",
    new File(["hello"], "hello.txt", { type: "text/plain" }),
  );

  const response = await runtime.plain({
    url: "/demo/upload",
    method: "POST",
    body: formData,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    title: "demo",
    tags: ["one", "two"],
    fileName: "hello.txt",
  });
  assert.deepEqual(
    response.headerEntries.filter(([key]) => key === "set-cookie"),
    [
      ["set-cookie", "a=1; Path=/"],
      ["set-cookie", "b=2; Path=/"],
    ],
  );
});

test("zelavisServer prefers an exact route over a wildcard sibling", async () => {
  const runtime = await zelavisServer({
    services: [
      defineService({
        name: "demo",
        service: {},
        api: {
          v1: [
            {
              id: "demo.list",
              method: "GET",
              path: "/files",
              handler: () => ({
                status: 200,
                body: { route: "list" },
              }),
            },
            {
              id: "demo.read",
              method: "GET",
              path: "/files/*path",
              handler: ({ params }) => ({
                status: 200,
                body: { route: "read", path: params.path },
              }),
            },
          ],
        },
      }),
    ],
  });

  const listResponse = await runtime.fetch(
    new Request("http://localhost/demo/files"),
  );
  const readResponse = await runtime.fetch(
    new Request("http://localhost/demo/files/hello.txt"),
  );

  assert.deepEqual(await listResponse.json(), { route: "list" });
  assert.deepEqual(await readResponse.json(), {
    route: "read",
    path: "hello.txt",
  });
});
