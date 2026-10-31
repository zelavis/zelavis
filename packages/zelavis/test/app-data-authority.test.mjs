import assert from "node:assert/strict";
import test from "node:test";
import { createServiceRuntime } from "../dist/core/index.js";
import { defineDatabaseService } from "../dist/db/index.js";
import { createProjectGatewayRoutes } from "../dist/platform/project-gateway.js";
import { openTemporaryDatabase } from "./_database.mjs";

test("the Gateway delegates exact data authority and the child enforces reads, writes and definitions, including POST reads", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  await api.forTenant("acme").documents.createCollection({ name: "posts", analyzer: { fields: ["body"], version: 1 } });
  await api.forTenant("acme").documents.insert({ collection: "posts", id: "a", data: { body: "hello" } });
  const principals = Object.fromEntries(["read", "write", "define"].map(action => [action, {
    id: action, type: "service", metadata: { tenantId: "acme" },
    grants: [{ permission: `project.data.${action}`, scope: { type: "project", projectId: "p1" } }],
  }]));
  principals.none = { id: "none", type: "service" };
  let forwarded;
  const child = await createServiceRuntime({ prefix: "/zelavis/api/v1", services: [defineDatabaseService(api)],
    resolvePrincipal: () => forwarded ? { id: forwarded.subject, type: "service", permissions: forwarded.permissions, metadata: { tenantId: forwarded.tenantId } } : undefined,
  });
  const gateway = await createServiceRuntime({ prefix: "/api", resolvePrincipal: ({ request }) => principals[request.headers.get("x-principal")], services: [{ name: "runtime", service: {}, api: { v1: createProjectGatewayRoutes({
    projects: {
      view: async () => ({ id: "p1", recipe: {}, runtime: { status: "running", url: "http://child.test" } }),
      signGatewayAuthority: async (_id, claims) => { forwarded = claims; return "test-authority"; },
    },
    fabric: { getProjectPlacement: async () => ({ identity: { type: "project", workloadId: "p1", scopeId: "p1" }, state: "active", generation: 1, runtimeNodeId: "n1" }), getNode: async () => ({ status: "ready" }) },
    unavailableProjectsResponse: () => ({ status: 503, body: {} }),
    projectErrorResponse: error => ({ status: 500, body: { error: String(error) } }),
  }) } }] });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(String(url)).origin, "http://child.test");
    return child.fetch(new Request(url, init));
  };
  t.after(() => { globalThis.fetch = original; });
  const call = async (who, path, body = {}, project = "p1") => {
    forwarded = undefined;
    const response = await gateway.fetch(new Request(`http://platform.test/api/runtime/projects/${project}/data/${path}`, {
      method: "POST", headers: { "x-principal": who, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() };
  };
  for (const path of ["documents/posts/query", "documents/posts/search-statistics", "events/read", "schemas/collections/export", "schemas/collections/types"]) {
    const answer = await call("read", path, { search: "hello", limit: 1 });
    assert.equal(answer.status, 200, `${path}: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(forwarded.permissions, ["database.read"]);
  }
  assert.equal((await call("write", "documents/posts", { data: { body: "world" } })).status, 201);
  assert.equal((await call("read", "documents/posts", { data: {} })).status, 403);
  const imported = { bundle: { format: "zelavis.logical-schema", version: 1, schemas: [] } };
  assert.equal((await call("read", "schemas/collections/import", imported)).status, 403);
  assert.equal((await call("write", "schemas/collections/import", imported)).status, 403);
  assert.equal((await call("define", "schemas/collections/import", imported)).status, 200);
  assert.equal((await call("read", "schemas/collections/export", { tenantId: "other" })).status, 403);
  const schema = { version: 1, fields: [] };
  assert.equal((await call("write", "schemas/posts", schema)).status, 403);
  assert.equal((await call("define", "schemas/posts", schema)).status, 201);
  assert.deepEqual(forwarded.permissions, ["database.define"]);
  assert.equal((await call("define", "documents/posts", { data: {} })).status, 403);
  assert.equal((await call("read", "documents/posts/scatter", {})).status, 403);
  assert.equal((await call("read", "events/read", { tenantId: "other" })).status, 403);
  assert.equal((await call("read", "events/read", {}, "p2")).status, 403);
  assert.equal(forwarded, undefined, "foreign Project requests stop before forwarding");
  assert.equal((await call("none", "events/read")).status, 403);
  assert.equal(forwarded, undefined);
});
