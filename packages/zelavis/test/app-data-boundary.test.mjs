import assert from "node:assert/strict";
import test from "node:test";

import { defineDatabaseService } from "../dist/db/index.js";
import {
  projectDataPermissions,
  projectRuntimePermissions,
} from "../dist/platform/project-gateway.js";
import {
  createGatewayAuthoritySecret,
  signGatewayAuthority,
  verifyGatewayAuthority,
} from "../dist/platform/gateway-authority.js";
import { openTemporaryDatabase } from "./_database.mjs";

const routeOf = (service, id) => {
  const routes = [
    ...service.api.v1,
    ...service.services.flatMap((nested) => nested.api.v1),
  ];
  const found = routes.find((route) => route.id === id);
  assert.ok(found, `route ${id} should exist`);
  return found;
};

const call = (route, { service, params = {}, query = "", body, principal }) =>
  route.handler({
    service,
    params,
    query: new URLSearchParams(query),
    body,
    principal,
    headers: {},
    request: undefined,
  });

/** What the Gateway builds for an App client: its own Tenant, data authority only. */
const appClient = (tenantId, permissions) => ({
  id: `service-${tenantId}`,
  type: "service",
  permissions,
  metadata: { tenantId },
});

test("an App client reaches only its own Tenant's records", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const service = defineDatabaseService(api);
  const acme = appClient("acme", ["database.read", "database.write"]);
  const globex = appClient("globex", ["database.read", "database.write"]);

  const created = await call(routeOf(service, "database.collections.create"), {
    service: api,
    body: { name: "boards" },
    principal: acme,
  });
  assert.equal(created.status, 201);

  // The client never names a Tenant; the principal decides which one it is.
  const inserted = await call(routeOf(service, "database.documents.insert"), {
    service: api,
    params: { collection: "boards" },
    body: { data: { title: "Engineering" } },
    principal: acme,
  });
  assert.equal(inserted.status, 201);
  assert.equal(inserted.body.data.title, "Engineering");

  const read = await call(routeOf(service, "database.documents.get"), {
    service: api,
    params: { collection: "boards", id: inserted.body.id },
    principal: acme,
  });
  assert.equal(read.body.data.title, "Engineering");

  // Another Tenant's client does not see it, and is not told it exists.
  await call(routeOf(service, "database.collections.create"), {
    service: api,
    body: { name: "boards" },
    principal: globex,
  });
  const foreign = await call(routeOf(service, "database.documents.get"), {
    service: api,
    params: { collection: "boards", id: inserted.body.id },
    principal: globex,
  });
  assert.equal(foreign.status, 404);

  // Naming someone else's Tenant is refused rather than honoured.
  const impersonation = await call(routeOf(service, "database.documents.get"), {
    service: api,
    params: { collection: "boards", id: inserted.body.id },
    query: "tenantId=acme",
    principal: globex,
  });
  assert.equal(impersonation.status, 403);

  const forgedWrite = await call(routeOf(service, "database.documents.insert"), {
    service: api,
    params: { collection: "boards" },
    body: { tenantId: "acme", data: { title: "Injected" } },
    principal: globex,
  });
  assert.equal(forgedWrite.status, 403);
});

test("an operator may still name the Tenant it browses", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const service = defineDatabaseService(api);
  const operator = {
    id: "operator",
    type: "user",
    permissions: ["database.inspect", "database.read", "database.write"],
    metadata: { tenantId: "platform" },
  };

  await call(routeOf(service, "database.collections.create"), {
    service: api,
    body: { tenantId: "acme", name: "boards" },
    principal: operator,
  });
  const listed = await call(routeOf(service, "database.collections.list"), {
    service: api,
    query: "tenantId=acme",
    principal: operator,
  });
  assert.deepEqual(listed.body.collections.map((entry) => entry.name), ["boards"]);
});

test("every database route states the authority it requires", () => {
  const service = defineDatabaseService({ forTenant: () => ({}) });
  const routes = [
    ...service.api.v1,
    ...service.services.flatMap((nested) => nested.api.v1),
  ];
  const unguarded = routes.filter((route) => !route.access);
  assert.deepEqual(
    unguarded.map((route) => route.id),
    [],
    "a route with no access requirement is never authorized",
  );
});

test("a repeated write is applied once", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const service = defineDatabaseService(api);
  const client = appClient("acme", ["database.read", "database.write"]);

  await call(routeOf(service, "database.collections.create"), {
    service: api,
    body: { name: "lanes" },
    principal: client,
  });
  const insert = () =>
    call(routeOf(service, "database.documents.insert"), {
      service: api,
      params: { collection: "lanes" },
      body: { id: "lane-1", idempotencyKey: "start-lane-1", data: { status: "running" } },
      principal: client,
    });

  const first = await insert();
  const retry = await insert();
  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.version, first.body.version);

  const page = await call(routeOf(service, "database.documents.page"), {
    service: api,
    params: { collection: "lanes" },
    body: {},
    principal: client,
  });
  assert.equal(page.body.documents.length, 1);
});

test("App data authority carries no Platform authority into the Project", () => {
  const appPrincipal = {
    id: "fluxgent",
    type: "service",
    grants: [
      { permission: "project.data.write", scope: { type: "project", projectId: "app-1" } },
    ],
  };
  const runtime = projectRuntimePermissions(appPrincipal, "app-1");
  assert.deepEqual([...runtime].sort(), [
    "database.read",
    "database.write",
    "project.data.write",
  ]);
  // Nothing that manages the Project comes with the right to write its records.
  assert.ok(!runtime.includes("workloads.manage"));
  assert.ok(!runtime.includes("storage.write"));
  assert.ok(!runtime.includes("database.restore"));

  // And an App data request carries only its data implications, even when the
  // caller happens to hold Project authority as well.
  const operatorPrincipal = {
    id: "owner",
    type: "user",
    grants: [
      { permission: "project.runtime.manage", scope: { type: "project", projectId: "app-1" } },
    ],
  };
  assert.deepEqual(
    [...projectDataPermissions(operatorPrincipal, "app-1")].sort(),
    ["database.read", "database.write"],
  );
  assert.ok(
    projectRuntimePermissions(operatorPrincipal, "app-1").includes("workloads.manage"),
  );
  assert.deepEqual(projectDataPermissions(undefined, "app-1"), []);
});

test("the Tenant travels in the signed envelope, not the request", async () => {
  const secret = createGatewayAuthoritySecret();
  const claims = {
    projectId: "app-1",
    scopeId: "scope-1",
    generation: 3,
    runtimeNodeId: "node-1",
    subject: "fluxgent",
    subjectType: "service",
    tenantId: "acme",
    permissions: ["database.read", "database.write"],
    expiresAt: Date.now() + 10_000,
    nonce: "nonce-1",
  };
  const token = await signGatewayAuthority(secret, claims);
  const verified = await verifyGatewayAuthority(secret, token, {
    audienceProjectId: "app-1",
  });
  assert.equal(verified?.tenantId, "acme");

  // The Tenant is signed, so editing it invalidates the envelope rather than
  // changing which records the request reaches.
  const forged = await signGatewayAuthority(secret, { ...claims, tenantId: "globex" });
  assert.notEqual(forged, token);
  const [payload] = token.split(".");
  const [, signature] = forged.split(".");
  assert.equal(
    await verifyGatewayAuthority(secret, `${payload}.${signature}`, {
      audienceProjectId: "app-1",
    }),
    undefined,
  );
});
