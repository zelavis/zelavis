import test from "node:test";
import assert from "node:assert/strict";
import { panelsFor, resolveTrail } from "../app/navigation-model.ts";
const project = { id: "customer café", name: "Customer", recipe: {} };
test("reconstructs Project domain ancestry and validates explicit URL trails", () => {
  const panels = panelsFor(project.id, project);
  assert.deepEqual(resolveTrail(panels, ["projects", "project", "database"], null).map(p => p.id), ["platform", "projects", "project", "database"]);
  assert.deepEqual(resolveTrail(panels, ["server"], "projects/project").map(p => p.id), ["platform", "projects", "project"]);
  assert.deepEqual(resolveTrail(panels, ["server"], "").map(p => p.id), ["platform"]);
  assert.deepEqual(resolveTrail(panels, [], "server/project/database").map(p => p.id), ["platform", "server"]);
});
test("parent landing URLs always identify the corresponding page and encoded Project", () => {
  const panels = panelsFor(project.id, project);
  assert.equal(panels.find(p => p.id === "project").path, "/projects/customer%20caf%C3%A9");
  assert.equal(panels.find(p => p.id === "server").path, "/server");
  for (const panel of panels) for (const item of panel.items) assert.ok(item.path.startsWith("/"));
});
test("managed Project menus expose only used native capabilities", () => {
  const managed = { ...project, recipe: { managed: true } };
  const panels = panelsFor(project.id, managed, { capabilities: { database: { available: true, used: false }, auth: { available: true, used: true } } });
  assert.deepEqual(panels.find(p => p.id === "project").items.map(i => i.label), ["Overview", "Auth", "Marketplace"]);
});
test("dynamic tables preserve tenant selection and group read-only system views", () => {
  const menu = { items: [{ title: "Orders", search: { databaseTenant: "tenant/a", databaseTable: "orders" } }, { title: "System · Events", search: { databaseTenant: "tenant/a", databaseSystemView: "events" } }] };
  const panels = panelsFor(project.id, project, undefined, menu);
  const database = panels.find(p => p.id === "database");
  const table = database.items.find(i => i.label === "Orders");
  assert.equal(new URL(table.path, "http://test").searchParams.get("databaseTenant"), "tenant/a");
  assert.equal(new URL(table.path, "http://test").searchParams.get("databaseTable"), "orders");
  const trail = resolveTrail(panels, [], "projects/project/database/system-tables");
  assert.equal(trail.at(-1).id, "system-tables");
  assert.equal(new URL(trail.at(-1).path, "http://test").searchParams.get("databaseSystemView"), "events");
});
test("Projects panel uses the complete runtime list without duplicating the current Project", () => {
  const panels = panelsFor(project.id, project, undefined, undefined, [project, { ...project, id: "other", name: "Other" }]);
  assert.deepEqual(panels.find(p => p.id === "projects").items.map(i => i.label), ["Overview", "Create project", "Customer", "Other"]);
});
