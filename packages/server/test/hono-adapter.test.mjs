import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { defineService, zelavisServer } from "../dist/index.js";
import { honoAdapter } from "../dist/adapters/hono.js";

test("honoAdapter mounts routes and passes normalized request context", async () => {
  const serviceApi = { label: "demo-service" };
  const app = new Hono();

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

  app.use(honoAdapter(runtime));

  const response = await app.request("/api/demo/items/42?tag=one&tag=two", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-header": "present",
    },
    body: JSON.stringify({ ok: true }),
  });

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
    requestIsRequest: true,
  });
});

test("honoAdapter uses the configured error handler", async () => {
  const app = new Hono();

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

  app.use(honoAdapter(runtime));

  const response = await app.request("/demo/error");
  assert.equal(response.status, 418);
  assert.deepEqual(await response.json(), {
    route: "demo.error",
    message: "boom",
  });
});
