import assert from "node:assert/strict";
import test from "node:test";

import { ZELAVIS_DEFAULT_MAX_REQUEST_BODY_BYTES } from "../dist/core/runtime/request-dispatcher.js";
import { createServiceRuntime } from "../dist/core/index.js";
import { createFabricService } from "../dist/core/fabric/index.js";

async function echoRuntime() {
  return createServiceRuntime({
    prefix: "/api/v1",
    version: "v1",
    services: [
      {
        name: "limits",
        basePath: "/limits",
        service: {},
        api: {
          v1: [
            {
              id: "limits.echo",
              method: "POST",
              path: "/echo",
              handler: ({ body }) => ({
                status: 200,
                body: { size: typeof body === "string" ? body.length : 0 },
              }),
            },
          ],
        },
      },
    ],
  });
}

async function post(runtime, bytes) {
  return runtime.fetch(
    new Request("http://localhost/api/v1/limits/echo", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "a".repeat(bytes),
    }),
  );
}

test("request bodies are accepted up to the limit and refused past it", async () => {
  const runtime = await echoRuntime();
  const limit = ZELAVIS_DEFAULT_MAX_REQUEST_BODY_BYTES;

  assert.equal((await post(runtime, 1024)).status, 200, "a small body is fine");
  assert.equal(
    (await post(runtime, limit)).status,
    200,
    "a body exactly at the limit is accepted",
  );

  const over = await post(runtime, limit + 1);
  assert.equal(over.status, 413, "a body past the limit is refused");
  assert.match((await over.json()).error, /exceeds the \d+ byte limit/);
});

test("a lying content-length cannot bypass the body limit", async () => {
  const runtime = await echoRuntime();
  const limit = ZELAVIS_DEFAULT_MAX_REQUEST_BODY_BYTES;

  // Understate the size: the stream itself must still be measured.
  const response = await runtime.fetch(
    new Request("http://localhost/api/v1/limits/echo", {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": "10" },
      body: "a".repeat(limit + 1),
    }),
  );
  assert.equal(response.status, 413);
});

test("Fabric placement planning rejects oversized input", async () => {
  const runtime = await createServiceRuntime({
    prefix: "/zelavis/api/v1",
    version: "v1",
    services: [
      createFabricService({
        localNode: {
          id: "node-a",
          status: "ready",
          roles: ["worker"],
          runtimeDriver: "node-process",
        },
      }),
    ],
  });
  const principal = { id: "manager", type: "system", permissions: ["fabric.manage"] };
  const plan = (requests) =>
    runtime.plain({
      url: "/zelavis/api/v1/fabric/placements/projects/plan",
      method: "POST",
      principal,
      body: { requests },
    });

  const request = (id) => ({
    identity: { type: "project", scopeId: "local", workloadId: id },
    projectKind: "zelavis",
    capabilities: { statelessRuntimeReplicas: false },
  });

  const ok = await plan([request("a")]);
  assert.ok(ok.status < 400, `a single request should plan: ${ok.status}`);

  const tooMany = await plan(
    Array.from({ length: 1001 }, (_, index) => request(`p${index}`)),
  );
  assert.equal(tooMany.status, 400, "an oversized batch must be refused");

  const longId = await plan([
    {
      identity: { type: "project", scopeId: "local", workloadId: "x".repeat(513) },
      projectKind: "zelavis",
      capabilities: { statelessRuntimeReplicas: false },
    },
  ]);
  assert.equal(longId.status, 400, "an over-long identifier must be refused");

  const hugeReplicas = await plan([
    {
      ...request("a"),
      replicaPolicy: { mode: "fixed", replicas: 100_000 },
    },
  ]);
  assert.equal(hugeReplicas.status, 400, "an absurd replica count must be refused");

});
