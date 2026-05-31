import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatRuntimeServiceList,
  listRuntimeServices,
  registerRuntimeService,
  resolveRuntimeApiBase,
  updateRuntimeService,
} from "../dist/services.js";

function createJsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

test("resolveRuntimeApiBase derives the v1 API path from a Zelavis root URL", () => {
  assert.equal(
    resolveRuntimeApiBase("http://localhost:3000/zelavis/"),
    "http://localhost:3000/zelavis/api/v1",
  );
  assert.equal(
    resolveRuntimeApiBase("http://localhost:3000/zelavis/api/v1"),
    "http://localhost:3000/zelavis/api/v1",
  );
});

test("listRuntimeServices reads runtime service registry entries", async () => {
  const seen = [];
  const services = await listRuntimeServices({
    url: "http://example.test/zelavis",
    fetch: async (url, init) => {
      seen.push({ url, init });
      return createJsonResponse({
        services: [
          {
            name: "@zelavis/ecommerce",
            version: "1.0.0",
            status: "installed",
            source: "official",
          },
        ],
      });
    },
  });

  assert.equal(seen[0].url, "http://example.test/zelavis/api/v1/runtime/services");
  assert.equal(seen[0].init.method, undefined);
  assert.equal(services[0].name, "@zelavis/ecommerce");
  assert.equal(
    formatRuntimeServiceList(services),
    "installed @zelavis/ecommerce@1.0.0 official",
  );
});

test("registerRuntimeService posts a service specifier", async () => {
  const seen = [];
  const result = await registerRuntimeService(
    {
      specifier: "https://example.test/service.mjs",
      status: "installed",
      source: "community",
      order: 2,
    },
    {
      url: "http://example.test/zelavis",
      fetch: async (url, init) => {
        seen.push({ url, init });
        return createJsonResponse({
          services: [{ name: "example", status: "installed" }],
          activation: { status: "active" },
        });
      },
    },
  );

  assert.equal(seen[0].url, "http://example.test/zelavis/api/v1/runtime/services");
  assert.equal(seen[0].init.method, "POST");
  assert.deepEqual(JSON.parse(seen[0].init.body), {
    specifier: "https://example.test/service.mjs",
    status: "installed",
    source: "community",
    order: 2,
  });
  assert.equal(result.activation.status, "active");
});

test("updateRuntimeService patches a service status by name", async () => {
  const seen = [];
  await updateRuntimeService(
    "@zelavis/ecommerce",
    { status: "available" },
    {
      url: "http://example.test/zelavis",
      fetch: async (url, init) => {
        seen.push({ url, init });
        return createJsonResponse({
          services: [{ name: "@zelavis/ecommerce", status: "available" }],
          activation: {
            status: "pending",
            message: "Restart required.",
          },
        });
      },
    },
  );

  assert.equal(
    seen[0].url,
    "http://example.test/zelavis/api/v1/runtime/services/%40zelavis%2Fecommerce",
  );
  assert.equal(seen[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(seen[0].init.body), {
    status: "available",
  });
});

test("runtime service client surfaces JSON error responses", async () => {
  await assert.rejects(
    () =>
      listRuntimeServices({
        fetch: async () =>
          createJsonResponse(
            {
              error: "No service activation controller is configured.",
            },
            { status: 400 },
          ),
      }),
    /No service activation controller is configured/,
  );
});
