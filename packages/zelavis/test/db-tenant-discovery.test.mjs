import assert from "node:assert/strict";
import test from "node:test";

import { defineDatabaseService } from "../dist/db/index.js";
import { openTemporaryDatabase } from "./_database.mjs";

const operator = {
  id: "operator",
  type: "user",
  permissions: ["database.inspect", "database.read", "database.write"],
};

const routeOf = (service, id) => {
  const routes = [...service.api.v1, ...service.services.flatMap((nested) => nested.api.v1)];
  const found = routes.find((route) => route.id === id);
  assert.ok(found, `route ${id} should exist`);
  return found;
};

const call = (route, { service, params = {}, query = "", body, principal = operator } = {}) =>
  route.handler({
    service, params, query: new URLSearchParams(query), body, principal,
    headers: {}, request: undefined,
  });

test("tenants are discovered from the shards holding them", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  assert.deepEqual(await api.tenants(), [], "a fresh database has no tenants");

  await api.forTenant("fluxgent").documents.createCollection({ name: "boards" });
  await api.forTenant("acme").documents.createCollection({ name: "invoices" });

  // Sorted and deduplicated, across every shard.
  assert.deepEqual(await api.tenants(), ["acme", "fluxgent"]);

  const service = defineDatabaseService(api);
  const listed = await call(routeOf(service, "database.tenants.list"), { service: api });
  assert.deepEqual(listed.body.tenants, ["acme", "fluxgent"]);
});

test("the tables menu shows every tenant's tables, and says which is whose", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const service = defineDatabaseService(api);
  await api.forTenant("fluxgent").documents.createCollection({ name: "fluxgent_lanes" });
  await api.forTenant("acme").documents.createCollection({ name: "invoices" });

  const all = await call(routeOf(service, "database.menu.tables"), { service: api });
  const tables = all.body.items.filter((item) => item.search.databaseTable);
  assert.deepEqual(
    tables.map((item) => item.title),
    ["acme · invoices", "fluxgent · fluxgent_lanes"],
    "with several tenants, a table says which tenant it belongs to",
  );
  // The tenant travels in route state, so opening a table opens the right one.
  assert.deepEqual(
    tables.map((item) => item.search.databaseTenant),
    ["acme", "fluxgent"],
  );

  // Naming a tenant still scopes the menu to it, unprefixed.
  const one = await call(routeOf(service, "database.menu.tables"), {
    service: api, query: "tenantId=fluxgent",
  });
  const scoped = one.body.items.filter((item) => item.search.databaseTable);
  assert.deepEqual(scoped.map((item) => item.title), ["fluxgent_lanes"]);
  assert.equal(scoped[0].search.databaseTenant, "fluxgent");
});
