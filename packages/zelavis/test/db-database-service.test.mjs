import assert from "node:assert/strict";
import test from "node:test";
import { createServiceRuntime } from "../dist/core/index.js";
import { defineDatabaseService } from "../dist/db/index.js";
import { openTemporaryDatabase } from "./_database.mjs";

const call = (route, { service, params = {}, query = "", body } = {}) =>
  route.handler({
    service,
    params,
    query: new URLSearchParams(query),
    body,
    headers: {},
    request: undefined,
  });

const routeOf = (service, id) => {
  const routes = [
    ...service.api.v1,
    ...service.services.flatMap((nested) => nested.api.v1),
  ];
  const found = routes.find((route) => route.id === id);
  assert.ok(found, `route ${id} should exist`);
  return found;
};

test("the database service mounts the same routes on the db runtime API", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const runtime = await createServiceRuntime({
    services: [defineDatabaseService(api)],
    prefix: "/api",
  });

  assert.equal(runtime.services["@zelavis/db"].service, api);
  assert.deepEqual(
    runtime.services["@zelavis/db"].services.map((nested) => nested.name),
    ["documents", "schemas", "timeseries", "maintenance"],
  );
  assert.deepEqual(
    runtime.routes.map((route) => route.fullPath),
    [
      "/api/database/menu/tables",
      "/api/database/health",
      "/api/database/documents/collections",
      "/api/database/documents/collections",
      "/api/database/documents/:collection",
      "/api/database/documents/:collection/:id",
      "/api/database/documents/:collection/query",
      "/api/database/documents/:collection/page",
      "/api/database/documents/:collection/indexes",
      "/api/database/documents/:collection/indexes/:name",
      "/api/database/documents/:collection/:id",
      "/api/database/documents/:collection/:id",
      "/api/database/schemas/collections",
      "/api/database/schemas/:collection",
      "/api/database/schemas/:collection",
      "/api/database/schemas/:collection/activate",
      "/api/database/schemas/:collection/validate",
      "/api/database/timeseries/series",
      "/api/database/timeseries/:series/range",
      "/api/database/timeseries/:series/aggregate",
      "/api/database/maintenance/system/views",
      "/api/database/maintenance/system/views/:view",
      "/api/database/maintenance/backups/export",
      "/api/database/maintenance/backups/restore",
    ],
  );
});

test("health reports the topology now that a sharded database answers it", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const service = defineDatabaseService(api);

  const response = await call(routeOf(service, "database.health"), { service: api });

  assert.equal(response.body.status, "ok");
  assert.equal(response.body.shards, 2);
  assert.equal(response.body.partitionMapVersion, 1);
  assert.ok(response.body.virtualRanges > 0);
});

test("the tables menu lists a Tenant's collections and its system views", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const service = defineDatabaseService(api);
  await api.forTenant("acme").documents.createCollection({ name: "products" });

  const response = await call(routeOf(service, "database.menu.tables"), {
    service: api,
    query: "tenantId=acme",
  });

  assert.deepEqual(
    response.body.items.map((item) => item.title),
    [
      "products",
      "System · Collections",
      "System · Events",
      "System · Schemas",
      "System · Projections",
      "System · Time series",
    ],
  );
});

test("tagged failures choose their own status code", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const service = defineDatabaseService(api);
  const createCollection = routeOf(service, "database.collections.create");
  const insert = routeOf(service, "database.documents.insert");
  const queryView = routeOf(service, "database.system-views.query");

  const created = await call(createCollection, {
    service: api,
    body: { tenantId: "acme", name: "products" },
  });
  const duplicate = await call(createCollection, {
    service: api,
    body: { tenantId: "acme", name: "products" },
  });
  const reserved = await call(createCollection, {
    service: api,
    body: { tenantId: "acme", name: "zv_secret" },
  });
  const missingCollection = await call(insert, {
    service: api,
    params: { collection: "absent" },
    body: { tenantId: "acme", data: {} },
  });
  const missingTenant = await call(createCollection, {
    service: api,
    body: { name: "products" },
  });
  const unknownView = await call(queryView, {
    service: api,
    params: { view: "nonsense" },
    query: "tenantId=acme",
  });

  assert.equal(created.status, 201);
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /already exists/);
  assert.equal(reserved.status, 400);
  assert.match(reserved.body.error, /reserved/);
  assert.equal(missingCollection.status, 404);
  assert.match(missingCollection.body.error, /does not exist/);
  assert.equal(missingTenant.status, 400);
  assert.match(missingTenant.body.error, /Tenant ID/);
  assert.equal(unknownView.status, 404);
  assert.match(unknownView.body.error, /Unknown logical database system view/);
});

test("a missing document is 404 even though the store answers with undefined", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const service = defineDatabaseService(api);
  await api.forTenant("acme").documents.createCollection({ name: "products" });

  const response = await call(routeOf(service, "database.documents.get"), {
    service: api,
    params: { collection: "products", id: "absent" },
    query: "tenantId=acme",
  });

  assert.equal(response.status, 404);
});

test("schemas are saved, activated and listed per Tenant", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const service = defineDatabaseService(api);
  const save = routeOf(service, "database.schemas.save");
  const field = (name) => ({
    name,
    field: { _tag: "TextField", label: name, required: true },
  });

  const first = await call(save, {
    service: api,
    params: { collection: "products" },
    body: { tenantId: "acme", version: 1, activate: true, fields: [field("name")] },
  });
  await call(save, {
    service: api,
    params: { collection: "products" },
    body: { tenantId: "acme", version: 2, fields: [field("name"), field("status")] },
  });
  const activated = await call(routeOf(service, "database.schemas.activate"), {
    service: api,
    params: { collection: "products" },
    body: { tenantId: "acme", version: 2 },
  });
  const listed = await call(routeOf(service, "database.schemas.versions.list"), {
    service: api,
    params: { collection: "products" },
    query: "tenantId=acme",
  });
  const otherTenant = await call(routeOf(service, "database.schemas.list"), {
    service: api,
    query: "tenantId=globex",
  });

  assert.equal(first.status, 201);
  assert.equal(activated.body.version, 2);
  assert.deepEqual(
    listed.body.schemas.map((schema) => ({
      version: schema.version,
      active: schema.active,
    })),
    [
      { version: 1, active: false },
      { version: 2, active: true },
    ],
  );
  assert.deepEqual(otherTenant.body.collections, []);
});

test("a write that violates the active schema is a 400 naming the field", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const service = defineDatabaseService(api);
  const tenant = api.forTenant("acme");
  await tenant.documents.createCollection({ name: "products" });
  await tenant.schemas.save({
    collection: "products",
    version: 1,
    activate: true,
    fields: [
      { name: "name", field: { _tag: "TextField", label: "Name", required: true } },
    ],
  });

  const response = await call(routeOf(service, "database.documents.insert"), {
    service: api,
    params: { collection: "products" },
    body: { tenantId: "acme", data: { name: 42 } },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /name/);
});

test("backups are exported and restored through the Tenant", async (t) => {
  const source = await openTemporaryDatabase(t);
  const target = await openTemporaryDatabase(t);
  const service = defineDatabaseService(source.api);
  await source.api.forTenant("acme").documents.createCollection({ name: "products" });
  await source.api.forTenant("acme").documents.insert({
    collection: "products",
    id: "p1",
    data: { name: "Coffee" },
  });

  const exported = await call(routeOf(service, "database.backups.export"), {
    service: source.api,
    body: { tenantId: "acme" },
  });
  const restored = await call(routeOf(service, "database.backups.restore"), {
    service: target.api,
    body: { tenantId: "acme", backup: exported.body },
  });
  const mismatched = await call(routeOf(service, "database.backups.restore"), {
    service: target.api,
    body: { tenantId: "globex", backup: exported.body },
  });

  assert.equal(exported.body.tenantId, "acme");
  assert.ok(restored.body.events > 0);
  assert.equal(
    (
      await target.api
        .forTenant("acme")
        .documents.findById({ collection: "products", id: "p1" })
    ).data.name,
    "Coffee",
  );
  assert.equal(mismatched.status, 400);
});

test("listing time series names the Tenant that owns them", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const service = defineDatabaseService(api);
  const list = routeOf(service, "database.timeseries.list");

  const scoped = await call(list, { service: api, query: "tenantId=acme" });
  const unscoped = await call(list, { service: api });

  assert.deepEqual(scoped.body.series, []);
  assert.equal(unscoped.status, 400);
  assert.match(unscoped.body.error, /Tenant ID/);
});

test("documents page through a collection in order, and a misused cursor is a 400", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const service = defineDatabaseService(api);
  const createCollection = routeOf(service, "database.collections.create");
  const insert = routeOf(service, "database.documents.insert");
  const page = routeOf(service, "database.documents.page");
  const params = { collection: "products" };

  await call(createCollection, { service: api, body: { tenantId: "acme", name: "products" } });
  for (const [id, price] of [["a", 30], ["b", 10], ["c", 20], ["d", 40], ["e", 10]]) {
    await call(insert, { service: api, params, body: { tenantId: "acme", id, data: { price } } });
  }

  const seen = [];
  let after;
  for (let pages = 0; pages < 10; pages++) {
    const response = await call(page, {
      service: api, params,
      body: { tenantId: "acme", orderBy: [{ path: "price" }], limit: 2, ...(after === undefined ? {} : { after }) },
    });
    assert.ok(Array.isArray(response.body.documents), "a page carries its documents");
    assert.ok(response.body.documents.length > 0, "no empty page");
    seen.push(...response.body.documents.map((document) => document.id));
    after = response.body.next;
    if (after === undefined) break;
  }
  // Ties keep insertion order, so b before e.
  assert.deepEqual(seen, ["b", "e", "c", "a", "d"]);

  const first = await call(page, {
    service: api, params, body: { tenantId: "acme", orderBy: [{ path: "price" }], limit: 2 },
  });
  const otherRead = await call(page, {
    service: api, params,
    body: { tenantId: "acme", orderBy: [{ path: "price", direction: "desc" }], after: first.body.next },
  });
  const twoSorts = await call(page, {
    service: api, params, body: { tenantId: "acme", orderBy: [{ path: "price" }, { path: "id" }] },
  });
  const tooMany = await call(page, { service: api, params, body: { tenantId: "acme", limit: 5000 } });

  assert.equal(otherRead.status, 400);
  assert.equal(typeof otherRead.body.error, "string");
  assert.equal(twoSorts.status, 400);
  assert.match(twoSorts.body.error, /composite index/);
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /limit/);
});

test("an index created through the service lets a page order by two fields", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const service = defineDatabaseService(api);
  const params = { collection: "products" };
  const createIndex = routeOf(service, "database.indexes.create");
  const page = routeOf(service, "database.documents.page");

  await call(routeOf(service, "database.collections.create"), { service: api, body: { tenantId: "acme", name: "products" } });
  for (const [id, category, price] of [["a", "tea", 3], ["b", "coffee", 5], ["c", "tea", 1]]) {
    await call(routeOf(service, "database.documents.insert"), {
      service: api, params, body: { tenantId: "acme", id, data: { category, price } },
    });
  }
  const orderBy = [{ path: "category" }, { path: "price", direction: "desc" }];

  const refused = await call(page, { service: api, params, body: { tenantId: "acme", orderBy } });
  const created = await call(createIndex, {
    service: api, params, body: { tenantId: "acme", name: "by_category_price", fields: orderBy },
  });
  const invalid = await call(createIndex, { service: api, params, body: { tenantId: "acme", name: "none", fields: [] } });
  const taken = await call(createIndex, {
    service: api, params, body: { tenantId: "acme", name: "by_category_price", fields: [{ path: "price" }] },
  });
  const ordered = await call(page, { service: api, params, body: { tenantId: "acme", orderBy } });
  const dropped = await call(routeOf(service, "database.indexes.drop"), {
    service: api, params: { ...params, name: "by_category_price" }, query: "tenantId=acme",
  });

  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /composite index/);
  assert.equal(created.status, 201);
  assert.equal(created.body.state, "ready");
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /1 to 8 fields/);
  assert.equal(taken.status, 409);
  assert.deepEqual(ordered.body.documents.map((document) => document.id), ["b", "a", "c"]);
  assert.deepEqual(dropped.body, { dropped: true });
});

test("constraints refuse through the service with the status each deserves", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const service = defineDatabaseService(api);
  const create = routeOf(service, "database.collections.create");
  const insert = routeOf(service, "database.documents.insert");
  const update = routeOf(service, "database.documents.update");

  await call(create, { service: api, body: { tenantId: "acme", name: "authors" } });
  const made = await call(create, {
    service: api,
    body: {
      tenantId: "acme", name: "posts",
      indexes: [{ name: "by_slug", fields: [{ path: "slug" }], unique: true }],
      checks: [{ name: "rated", where: [{ path: "stars", op: "lte", value: 5 }] }],
      references: [{ name: "author", path: "authorId", collection: "authors" }],
    },
  });
  const put = (id, data) => call(insert, { service: api, params: { collection: "posts" }, body: { tenantId: "acme", id, data } });
  const first = await put("p1", { slug: "a", stars: 3 });
  const taken = await put("p2", { slug: "a" });
  const unrated = await put("p3", { stars: 9 });
  const orphan = await put("p4", { authorId: "ghost" });
  const change = (body) => call(update, {
    service: api, params: { collection: "posts", id: "p1" }, body: { tenantId: "acme", data: { stars: 4 }, ...body },
  });
  const stale = await change({ precondition: [{ path: "stars", value: 2 }] });
  const outdated = await change({ expectedVersion: 7 });
  const current = await change({ expectedVersion: 1, precondition: [{ path: "stars", value: 3 }] });

  assert.equal(made.status, 201);
  assert.ok((first.status ?? 200) < 300);
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /by_slug/);
  assert.equal(unrated.status, 400);
  assert.match(unrated.body.error, /rated/);
  assert.equal(orphan.status, 409);
  assert.match(orphan.body.error, /ghost/);
  assert.equal(stale.status, 409);
  assert.equal(outdated.status, 409);
  assert.equal(current.body.version, 2);
});
