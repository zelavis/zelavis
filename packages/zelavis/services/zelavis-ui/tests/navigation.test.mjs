import test from "node:test";
import assert from "node:assert/strict";
import { panelsFor, resolveTrail, workspacePanels, trailForLocation, itemIsActive, createMenuStore } from "../app/navigation-model.ts";
import { platformMenu, projectMenu } from "../app/navigation-menu.ts";
const project = { id: "customer café", name: "Customer", recipe: {} };
test("Platform extensions appear only in their own slide regardless of claimed surface", () => {
  const services = ["extension", undefined].map((scope, index) => ({ name: `@example/ext${index}`, scope, menus: [{ title: `Extension ${index}`, path: `/ext${index}`, surface: "platform" }] }));
  const menu = platformMenu({ services }, []);
  assert.deepEqual(menu.map(item => item.title), ["Projects", "Extensions"]);
  assert.deepEqual(menu[1].items.map(item => item.path), ["/ext0", "/ext1"]);
});
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
  assert.deepEqual(database.items.map(item => item.title), ["Create Table", "Tenants", "orders", "Plugin Tables", "System Tables"]);
  assert.deepEqual(database.items[0], { title: "Create Table", path: `/projects/${encodeURIComponent(project.id)}/database`, search: { databaseDialog: "create-table" } });
  const plugin = database.items.find(item => item.title === "Plugin Tables");
  assert.deepEqual(plugin.items.map(item => item.title), ["auth · settings"]);
  assert.deepEqual(plugin.items[0].search, { databaseTenant: "service:auth", databaseTable: "settings" });
  const system = database.items.find(item => item.title === "System Tables");
  assert.deepEqual(system.items.map(item => item.search), [{ databaseSystemView: "events" }, { databaseSystemView: "schemas" }]);
  assert.deepEqual(system.search, { databaseSystemView: "events" });
  const panels = workspacePanels(panelsFor(project.id, project, runtime, { items: tables }), menu, project.id);
  const trail = search => trailForLocation(panels, new URL(`http://test/projects/${encodeURIComponent(project.id)}/database?${search}`));
  const last = ids => ids.at(-1);
  assert.match(last(trail("databaseTenant=zelavis-app&databaseTable=orders")), /database$/);
  assert.match(last(trail("databaseTenant=zelavis-app&databaseSystemView=events")), /system-tables$/);
  assert.match(last(trail("databaseTenant=service%3Aauth&databaseTable=settings")), /plugin-tables$/);
  assert.match(last(trail("databaseTenant=service%3Aauth&databaseSystemView=schemas")), /system-tables$/);
});

test("only the slide a page belongs to is active, not every item sharing its path", () => {
  const tables = [
    { title: "zelavis-app · orders", search: { databaseTenant: "zelavis-app", databaseTable: "orders" } },
    { title: "service:auth · settings", search: { databaseTenant: "service:auth", databaseTable: "settings" } },
    { title: "System · Events", search: { databaseTenant: "zelavis-app", databaseSystemView: "events" } },
  ];
  const runtime = { capabilities: { database: { available: true } }, services: [] };
  const menu = projectMenu({ control: { services: [] }, project, runtime, content: [], tables, workloads: {} });
  const panels = workspacePanels(panelsFor(project.id, project, runtime, { items: tables }), menu, project.id);
  const base = `/projects/${encodeURIComponent(project.id)}/database`;
  const branches = panels.find(panel => panel.items.some(item => item.label === "Plugin Tables")).items.filter(item => item.branch);
  const active = (pathname, search = "") => {
    const url = new URL(`http://test${base}${pathname}${search}`);
    const trail = trailForLocation(panels, url);
    return branches.map(item => [item.label, itemIsActive({ current: url.pathname, itemPath: new URL(item.path, "http://test").pathname, matchesSearch: false, branch: item.branch, trail })]);
  };
  // The Tenants page belongs to the Database slide alone: neither of the slides beside its tables lights up.
  assert.deepEqual(active("/tenants"), [["Plugin Tables", false], ["System Tables", false]]);
  assert.deepEqual(active("", "?databaseTenant=zelavis-app&databaseTable=orders"), [["Plugin Tables", false], ["System Tables", false]]);
  assert.deepEqual(active("", "?databaseSystemView=events"), [["Plugin Tables", false], ["System Tables", true]]);
  assert.deepEqual(active("", "?databaseTenant=service%3Aauth&databaseTable=settings"), [["Plugin Tables", true], ["System Tables", false]]);
  // The slide that holds a page stays active: the Database item itself is on the trail of the Tenants page.
  assert.equal(itemIsActive({ current: `${base}/tenants`, itemPath: base, matchesSearch: false, branch: "database", trail: ["database"] }), true);
});

test("a Project's menu survives the Platform's menu being reported after it", () => {
  const store = createMenuStore();
  const projectMenuItems = [{ title: "Backend" }];
  const platformMenuItems = [{ title: "Server" }];
  store.set("trellix", projectMenuItems);
  store.set(undefined, platformMenuItems);
  // The dashboard leaves an unchanged menu alone, so nothing sets the Project's again when it is visited next.
  assert.equal(store.get("trellix"), projectMenuItems);
  assert.equal(store.get(undefined), platformMenuItems);
  assert.equal(store.get("other"), undefined, "a scope with no reported menu has none, and falls back to the basic one");
});

test("a Project is offered the menus of trusted Platform services, never an extension's", () => {
  const service = (name, scope, surface, title) => ({ name, scope, menu: { title, path: `/${name.split("/")[1]}`, surface, page: { id: "main", title, file: "page.html", src: "/x" } } });
  const control = { services: [
    service("@zelavis/core-thing", "system", "core", "Core Thing"),
    service("@example/ext-thing", "extension", "core", "Extension Thing"),
    // The Platform's own `platform` surface menus never cross into a Project, whoever ships them.
    service("@zelavis/shell-thing", "system", "platform", "Shell Thing"),
  ] };
  const runtime = { capabilities: {}, services: [service("@example/own-ext", "extension", undefined, "Own Extension")] };
  const menu = projectMenu({ control, project, runtime, content: [], tables: [], workloads: {} });
  const titles = items => items.flatMap(item => [item.title, ...(item.items ? titles(item.items) : [])]);
  const all = titles(menu);
  assert.ok(all.includes("Core Thing"), "a trusted Platform service's Project-surface menu is offered");
  assert.ok(!all.includes("Extension Thing"), "an extension installed on the Platform is not offered to every Project");
  assert.ok(!all.includes("Shell Thing"), "platform-surface menus never cross into a Project");
  // A Project's own extension lands in the Extensions slide, not in a trusted slide.
  const extensions = menu.find(item => item.title === "Extensions");
  assert.ok(titles(extensions.items).includes("Own Extension"));
  assert.ok(!titles(menu.filter(item => item.title !== "Extensions")).includes("Own Extension"));
});

test("the Marketplace lists an extension under Plugins and keeps trusted services out of that tab", async () => {
  const { selectItems } = await import("../app/marketplace-pages.ts");
  const registry = [
    { name: "@zelavis/auth", kind: "plugin", scope: "system", status: "installed" },
    { name: "@example/ext-page", kind: "plugin", scope: "extension", status: "installed" },
    { name: "@example/available", kind: "plugin", scope: "extension", status: "available" },
    { name: "@zelavis/app", kind: "app", scope: "system", status: "installed" },
  ];
  assert.deepEqual(selectItems(registry, "plugins").map(item => item.name), ["@example/ext-page", "@example/available"]);
  assert.deepEqual(selectItems(registry, "apps").map(item => item.name), ["@zelavis/app"], "apps keep their own tab, trusted or not");
});
