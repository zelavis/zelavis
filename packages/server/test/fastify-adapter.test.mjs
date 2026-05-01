import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { defineServerService, zelavisServer } from "../dist/index.js";
import { fastifyAdapter } from "../dist/adapters/fastify.js";

test("fastifyAdapter mounts Zelavis as a Fastify plugin and preserves normalized request context", async () => {
  const serviceApi = { label: "demo-service" };
  const app = Fastify();

  app.get("/hello", async () => "Hello Fastify");

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

  await app.register(fastifyAdapter(runtime));

  const hostResponse = await app.inject({
    method: "GET",
    url: "/hello",
  });
  assert.equal(hostResponse.statusCode, 200);
  assert.equal(hostResponse.body, "Hello Fastify");

  const response = await app.inject({
    method: "POST",
    url: "/api/demo/items/42?tag=one&tag=two",
    headers: {
      "content-type": "application/json",
      "x-test-header": "present",
    },
    payload: JSON.stringify({ ok: true }),
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.headers["x-route"], "demo.show");

  assert.deepEqual(JSON.parse(response.body), {
    service: serviceApi,
    id: "42",
    tag: "one",
    tags: ["one", "two"],
    body: { ok: true },
    header: "present",
    requestIsRequest: true,
  });

  await app.close();
});

test("fastifyAdapter preserves binary bodies, repeated headers, and HEAD fallback", async () => {
  const app = Fastify();
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
  });

  await app.register(fastifyAdapter(runtime));

  const binaryResponse = await app.inject({
    method: "POST",
    url: "/demo/binary",
    headers: {
      "content-type": "application/octet-stream",
    },
    payload: Buffer.from([5, 6, 7]),
  });

  assert.deepEqual(binaryResponse.rawPayload, Buffer.from([5, 6, 7]));
  assert.deepEqual(binaryResponse.headers["set-cookie"], [
    "a=1; Path=/",
    "b=2; Path=/",
  ]);

  const headResponse = await app.inject({
    method: "HEAD",
    url: "/demo/head",
  });

  assert.equal(headResponse.statusCode, 200);
  assert.equal(headResponse.headers["x-head"], "ok");
  assert.equal(headResponse.body, "");

  await app.close();
});

test("fastifyAdapter uses the configured error handler", async () => {
  const app = Fastify();
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
    onError: ({ error, resolvedRoute }) => ({
      status: 418,
      body: {
        route: resolvedRoute.route.id,
        message: error instanceof Error ? error.message : "unknown",
      },
    }),
  });

  await app.register(fastifyAdapter(runtime));

  const response = await app.inject({
    method: "GET",
    url: "/demo/error",
  });

  assert.equal(response.statusCode, 418);
  assert.deepEqual(JSON.parse(response.body), {
    route: "demo.error",
    message: "boom",
  });

  await app.close();
});
