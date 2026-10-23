import test from "node:test";
import assert from "node:assert/strict";
import { panelsFor, resolveTrail, workspacePanels, trailForLocation } from "../app/navigation-model.ts";
import { projectMenu } from "../app/navigation-menu.ts";
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


test("explicit Project routes recover their domain without an invented section parameter", async () => {
  const { dashboardSection } = await import("../app/routes.ts");
  assert.equal(dashboardSection("/projects/project/storage", { projectId: "project" }), "storage");
  assert.equal(dashboardSection("/projects/project/marketplace", { projectId: "project" }), "marketplace");
  assert.equal(dashboardSection("/projects/p%2Fx/auth/users", { projectId: "p/x" }), "auth/users");
  assert.equal(dashboardSection("/projects/project", { projectId: "project" }), undefined);
  assert.equal(dashboardSection("/server/domains", { section: "domains" }), "domains");
  assert.equal(dashboardSection("/projects/project/storage", {}), undefined);
});

test("workspace menu descendants survive URL serialization and restore their deepest search view", async () => {
  const { workspacePanels, trailForLocation } = await import("../app/navigation-model.ts");
  const panels = workspacePanels(panelsFor("p", { id: "p", name: "P", recipe: {} }), [
    { title: "Backend", path: "/projects/p/backend", items: [{ title: "Workloads", path: "/projects/p/workloads", items: [{ title: "Functions", path: "/projects/p/workloads/functions" }] }] },
    { title: "Content", path: "/projects/p/content", items: [{ title: "Articles", path: "/projects/p/content/articles", items: [{ title: "Fields", path: "/projects/p/content/articles/fields" }] }] }
  ], "p");
  const trail = trailForLocation(panels, new URL("http://test/zelavis/projects/p/workloads/functions"));
  assert.deepEqual(resolveTrail(panels, [], trail.join("/")).map(panel => panel.id), ["platform", ...trail]);
  assert.equal(resolveTrail(panels, [], trail.join("/")).at(-1).label, "Workloads");
  assert.ok(panels.every(panel => !panel.id.includes("/")));
  assert.ok(panels.find(panel => panel.id === "server"), "Platform branch remains available in Project workspaces");
});

test("a table URL opens the Database slide and a system view URL the System Tables slide", () => {
  const tables = [
    { title: "zelavis-app · orders", search: { databaseTenant: "zelavis-app", databaseTable: "orders" } },
    { title: "service:auth · settings", search: { databaseTenant: "service:auth", databaseTable: "settings" } },
    { title: "System · Events", search: { databaseTenant: "zelavis-app", databaseSystemView: "events" } },
    { title: "System · Schemas", search: { databaseTenant: "zelavis-app", databaseSystemView: "schemas" } },
  ];
  const runtime = { capabilities: { database: { available: true } }, services: [] };
  const menu = projectMenu({ control: { services: [] }, project, runtime, content: [], tables, workloads: {} });
  const database = menu.find(item => item.title === "Backend").items.find(item => item.title === "Database");
  assert.deepEqual(database.items.map(item => item.title), ["Create Table", "orders", "service:auth · settings", "System Tables"]);
  assert.deepEqual(database.items[0], { title: "Create Table", path: `/projects/${encodeURIComponent(project.id)}/database`, search: { databaseDialog: "create-table" } });
  const system = database.items.find(item => item.title === "System Tables");
  assert.deepEqual(system.items.map(item => item.search), [{ databaseSystemView: "events" }, { databaseSystemView: "schemas" }]);
  assert.deepEqual(system.search, { databaseSystemView: "events" });
  const panels = workspacePanels(panelsFor(project.id, project, runtime, { items: tables }), menu, project.id);
  const trail = search => trailForLocation(panels, new URL(`http://test/projects/${encodeURIComponent(project.id)}/database?${search}`));
  const last = ids => ids.at(-1);
  assert.match(last(trail("databaseTenant=zelavis-app&databaseTable=orders")), /database$/);
  assert.match(last(trail("databaseTenant=zelavis-app&databaseSystemView=events")), /system-tables$/);
  assert.match(last(trail("databaseTenant=service%3Aauth&databaseSystemView=schemas")), /system-tables$/);
});
