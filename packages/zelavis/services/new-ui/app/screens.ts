import { pageNumber } from "./grids/model.ts";
import { Effect } from "effect";
import { ApiError, array, bootstrap, label, object, projectConfig, projects, request, type Config, type Project } from "./api.ts";
import { button, empty, field, json, link, message, node, table } from "./dom.ts";

export interface ScreenContext {
  config: Config;
  url: URL;
  path: string;
  projectId?: string;
  section?: string;
  projectsNavigation(projects: readonly Project[]): void;
  projectNavigation(project: Project, runtime?: Config, menu?: unknown): void;
  navigate(path: string): void;
  run<A>(effect: Effect.Effect<A, ApiError>, success?: (value: A) => void): void;
  refresh(): void;
  setSearch(values: Record<string, string | undefined>): void;
}
function form(context: ScreenContext, fields: HTMLElement[], submitLabel: string, submit: (values: FormData) => Effect.Effect<unknown, ApiError>, success?: (value: unknown) => void) {
  const result = node("form", { class: "form" }, ...fields);
  const submitter = node("button", { type: "submit", class: "primary" }, submitLabel);
  result.append(submitter);
  result.addEventListener("submit", event => {
    event.preventDefault();
    if (submitter.disabled) return;
    submitter.disabled = true;
    context.run(submit(new FormData(result)).pipe(Effect.ensuring(Effect.sync(() => { submitter.disabled = false; }))), success ?? (() => context.refresh()));
  });
  return result;
}
function value(data: FormData, name: string) { return String(data.get(name) ?? ""); }
function heading(text: string, action?: HTMLElement) { return node("div", { class: "toolbar" }, node("h1", {}, text), action); }
function mutation(context: ScreenContext, path: string, body: unknown, method = "POST") { return request(`${context.config.api.basePath}${path}`, method, body); }
function rows(data: unknown, key?: string) { return key ? array(object(data)[key]) : array(data); }
function readPanel(title: string, data: unknown, key?: string, columns?: string[]) {
  const records = rows(data, key);
  const body = columns ? records.length ? table(records, columns) : empty(`No ${title.toLowerCase()} yet`, "This view reads the selected runtime’s existing API.") : json(data);
  return node("section", { class: "panel" }, heading(title), body);
}

export const authScreen = Effect.fn("new-ui.authScreen")(function*(context: ScreenContext, setup: boolean) {
  const status = yield* bootstrap(context.config);
  if (setup && !status.required) { context.navigate("/login"); return message("Owner setup is complete. Opening sign in…"); }
  const providers = setup ? status.enrollmentProviders : status.providers;
  const select = node("select", { name: "provider", required: "" }, ...providers.map(provider => node("option", { value: provider }, provider)));
  const panel = node("section", { class: "auth-card" }, node("div", { class: "brand" }, "◈ Zelavis"), node("h1", {}, setup ? "Set up your Platform" : "Welcome back"), node("p", {}, setup ? "Claim the first owner using this installation’s one-time bootstrap token." : "Sign in to plan, build, and manage your apps."));
  if (providers.length === 0) { panel.append(message("No supported authentication providers are configured.", true)); return panel; }
  panel.append(form(context, [
    ...(setup ? [field("bootstrapToken", "One-time bootstrap token", "password"), field("displayName", "Display name")] : []),
    node("label", {}, node("span", {}, "Authentication provider"), select),
    field("identifier", setup ? "Email or username" : "Email or username"),
    field("password", "Password", "password"),
  ], setup ? "Create owner account" : "Sign in", data => {
    const identifier = value(data, "identifier");
    const account = identifier.includes("@") ? { email: identifier, displayName: value(data, "displayName") } : { username: identifier, displayName: value(data, "displayName") };
    return request(`${context.config.api.basePath}${setup ? "/auth/bootstrap" : `/auth/authenticate/${encodeURIComponent(value(data, "provider"))}`}`, "POST", setup ? { bootstrapToken: value(data, "bootstrapToken"), provider: value(data, "provider"), account, credential: { identifier, password: value(data, "password") } } : { identifier, password: value(data, "password") });
  }, () => context.navigate(setup ? "/settings?onboarding=hostname" : "/")));
  return panel;
});

export const projectsScreen = Effect.fn("new-ui.projectsScreen")(function*(context: ScreenContext) {
  const list = yield* projects(context.config);
  context.projectsNavigation(list);
  const query = context.url.searchParams.get("q") ?? "";
  const status = context.url.searchParams.get("status") ?? "all";
  const search = field("q", "Search projects", "search", query, false);
  const filter = node("select", { name: "status", "aria-label": "Project status" }, ...["all", "running", "stopped", "failed"].map(option => node("option", { value: option, ...(status === option ? { selected: "" } : {}) }, option)));
  const filters = node("form", { class: "filters", role: "search" }, search, filter, node("button", { type: "submit" }, "Filter"));
  filters.addEventListener("submit", event => { event.preventDefault(); const data = new FormData(filters); context.setSearch({ q: value(data, "q") || undefined, status: value(data, "status") === "all" ? undefined : value(data, "status") }); });
  const visible = list.filter(project => (status === "all" || project.status === status) && `${project.name} ${project.id}`.toLowerCase().includes(query.toLowerCase()));
  const grid = node("div", { class: "project-grid" });
  for (const project of visible) {
    const recipe = object(project.recipe);
    grid.append(node("article", { class: "project-card" }, node("div", { class: "project-symbol", "aria-hidden": "true" }, project.name.slice(0, 1).toUpperCase()), node("div", { class: "project-card-heading" }, link(project.name, `/projects/${encodeURIComponent(project.id)}`), node("span", { class: `badge ${project.status}` }, project.status)), node("p", {}, label(recipe.name, "Zelavis App")), node("code", {}, project.id), ...(project.deletion ? [message("Deletion in progress. Open the project to retry cleanup.", true)] : [])));
  }
  const running = list.filter(project => project.status === "running").length;
  return node("section", {}, heading("Projects", link("+ Create project", "/projects/create", { class: "primary" })), node("div", { class: "stats" }, stat("Projects", list.length), stat("Running", running), stat("Needs attention", list.filter(project => project.status === "failed" || project.deletion).length)), filters, visible.length ? grid : empty("No projects found", list.length ? "Try a different search or status." : "Create a project to start building."));
});
function stat(title: string, count: number) { return node("div", { class: "stat" }, node("span", {}, title), node("strong", {}, String(count))); }

export const createProjectScreen = Effect.fn("new-ui.createProjectScreen")(function*(context: ScreenContext) {
  const response = yield* request(`${context.config.api.basePath}/runtime/project-recipes`);
  const recipes = rows(response, "projectRecipes");
  const select = node("select", { name: "recipeName", required: "" }, ...recipes.map(recipe => {
    const entry = object(recipe); return node("option", { value: label(entry.name, "") }, label(entry.title, label(entry.name)));
  }));
  return node("section", { class: "panel narrow" }, heading("Create project", link("Back to projects", "/")), form(context, [field("name", "Project name"), field("id", "Project ID (optional)", "text", "", false), node("label", {}, node("span", {}, "Project recipe"), select)], "Create project", data => mutation(context, "/runtime/projects", { name: value(data, "name"), ...(value(data, "id") ? { id: value(data, "id") } : {}), recipeName: value(data, "recipeName"), start: false }), result => {
    const id = object(object(result).project).id;
    if (typeof id === "string") context.navigate(`/projects/${encodeURIComponent(id)}`); else context.refresh();
  }), message("Projects are created stopped. Host package approval and exact engine selection are available in the React dashboard while those controls are ported."));
});

function projectActions(context: ScreenContext, project: Project) {
  const path = `/runtime/projects/${encodeURIComponent(project.id)}`;
  const busy = ["provisioning", "starting", "stopping"].includes(project.status);
  const actions = node("div", { class: "actions" });
  if (!project.deletion) {
    actions.append(button(project.status === "running" ? "Stop" : "Start", () => context.run(mutation(context, `${path}/${project.status === "running" ? "stop" : "start"}`, {})), busy ? { disabled: "" } : {}));
    actions.append(button("Restart", () => context.run(mutation(context, `${path}/restart`, {})), busy || project.status !== "running" ? { disabled: "" } : {}));
  }
  actions.append(button(project.deletion ? "Retry deletion" : "Delete project", () => {
    if (window.confirm(`Delete ${project.name} and its project data?`)) context.run(mutation(context, path, undefined, "DELETE"), () => context.navigate("/"));
  }, { class: "danger", ...(busy ? { disabled: "" } : {}) }));
  return actions;
}
export const projectScreen = Effect.fn("new-ui.projectScreen")(function*(context: ScreenContext) {
  const list = yield* projects(context.config);
  context.projectsNavigation(list);
  const project = list.find(entry => entry.id === context.projectId);
  if (!project) return empty("Project not found", "This URL does not identify a project in this installation.");
  context.projectNavigation(project);
  const overview = node("section", {}, heading(project.name, projectActions(context, project)), node("div", { class: "stats" }, node("div", { class: "stat" }, node("span", {}, "Status"), node("strong", {}, project.status)), node("div", { class: "stat" }, node("span", {}, "Recipe"), node("strong", {}, label(object(project.recipe).name, "Zelavis App")))));
  if (project.error) overview.append(message(project.error, true));
  if (project.deletion) overview.append(message("Project cleanup is pending. Start and restart are disabled.", true), json(project.deletion));
  if (!context.section && object(project.recipe).managed) {
    overview.append(message("This managed application uses hosting controls. Its own administration and advanced hosting controls are available in the React dashboard while they are ported."));
    return overview;
  }
  if (!context.section) {
    overview.append(node("div", { class: "panel" }, node("h2", {}, "Project workspace"), node("div", { class: "workspace-links" }, ...[["Database", "database"], ["Authentication", "auth"], ["Content", "content"], ["Storage", "storage"], ["Workloads", "workloads"], ["Marketplace", "marketplace"]].map(([title, path]) => link(title, `/projects/${encodeURIComponent(project.id)}/${path}`)))));
    return overview;
  }
  if (project.status !== "running") { overview.append(empty("Project runtime is stopped", "Start the project to access its own database, authentication, storage, and workloads.")); return overview; }
  const scoped = yield* projectConfig(context.config, project.id);
  context.projectNavigation(project, scoped);
  const capabilities = object(scoped.capabilities);
  const api = scoped.api.basePath;
  const section = context.section.split("/")[0];
  if (["database", "content"].includes(section)) {
    if (object(capabilities.database).available !== true) return empty("Database unavailable", "This project does not expose a Zelavis database.");
    const menu = yield* request(`${api}/database/menu/tables`);
    context.projectNavigation(project, scoped, menu);
    const items = rows(menu, "items");
    const panel = node("section", { class: "panel" }, heading(section === "content" ? "Content collections" : "Database tables"));
    const tenant = context.url.searchParams.get("databaseTenant") ?? "";
    const collection = context.url.searchParams.get("databaseTable") ?? "";
    const systemView = context.url.searchParams.get("databaseSystemView");
    const selector = node("form", { class: "filters" }, field("tenantId", "Tenant ID", "text", tenant), field("collection", "Collection / table", "text", collection), node("button", { type: "submit" }, "Open records"));
    selector.addEventListener("submit", event => { event.preventDefault(); const data = new FormData(selector); context.setSearch({ databaseTenant: value(data, "tenantId"), databaseTable: value(data, "collection"), databaseSystemView: undefined, databaseOffset: undefined, databaseRow: undefined }); });
    panel.append(selector);
    if (section === "database") {
      const choices = node("div", { class: "workspace-links" });
      for (const item of items) {
        const entry = object(item);
        const search = new URLSearchParams();
        for (const [key, val] of Object.entries(object(entry.search))) if (typeof val === "string") search.set(key, val);
        choices.append(link(label(entry.title), `/projects/${encodeURIComponent(project.id)}/database?${search}`));
      }
      panel.append(choices);
    } else if (tenant) {
      const collections = yield* request(`${api}/database/documents/collections?tenantId=${encodeURIComponent(tenant)}`);
      const choices = node("div", { class: "workspace-links" });
      for (const item of rows(collections, "collections")) {
        const entry = object(item);
        if (entry.surface !== "content-studio") continue;
        choices.append(link(label(entry.name), `/projects/${encodeURIComponent(project.id)}/content?databaseTenant=${encodeURIComponent(tenant)}&databaseTable=${encodeURIComponent(label(entry.name))}`));
      }
      panel.append(choices);
    }
    const grid = (records: unknown[], readonly: boolean) => {
      const host = document.createElement("fuzor-island"); host.setAttribute("src", "database-grid");
      host.setAttribute("props", JSON.stringify({ records, readonly, apiBase: api, tenant, collection }));
      return host;
    };
    if (tenant && systemView) {
      const result = yield* request(`${api}/database/maintenance/system/views/${encodeURIComponent(systemView)}?tenantId=${encodeURIComponent(tenant)}&limit=50`);
      panel.append(node("p", { class: "muted" }, "System records · first 50"), grid(rows(result, "rows"), true));
    } else if (tenant && collection) {
      const offset = pageNumber(context.url.searchParams.get("databaseOffset"), 0, 1000000);
      const limit = Math.max(1, pageNumber(context.url.searchParams.get("databaseLimit"), 25, 250));
      const result = yield* request(`${api}/database/documents/${encodeURIComponent(collection)}/query`, "POST", { tenantId: tenant, limit, offset });
      const records = rows(result, "documents");
      const previous = button("Previous page", () => context.setSearch({ databaseOffset: String(Math.max(0, offset - limit)), databaseRow: undefined })); previous.disabled = offset === 0;
      const next = button("Next page", () => context.setSearch({ databaseOffset: String(offset + limit), databaseRow: undefined })); next.disabled = records.length < limit;
      const size = node("select", { "aria-label": "Records per page" });
      for (const count of [...new Set([25, 100, 250, limit])]) { const option = node("option", { value: String(count) }, String(count)); option.selected = count === limit; size.append(option); }
      size.addEventListener("change", () => context.setSearch({ databaseLimit: size.value, databaseOffset: undefined, databaseRow: undefined }));
      panel.append(node("div", { class: "grid-controls" }, previous, node("span", {}, records.length ? `Records ${offset + 1}–${offset + records.length}` : "No records on this page"), next, node("label", {}, "Page size ", size)), grid(records, false));
      panel.append(node("details", {}, node("summary", {}, "Add record"), form(context, [field("recordId", "Record ID (optional)", "text", "", false), node("label", {}, node("span", {}, "Record data (JSON object)"), node("textarea", { name: "data", required: "", rows: "8", maxlength: "1048576" }, "{}"))], "Add record", data => Effect.try({
        try: () => { const parsed: unknown = JSON.parse(value(data, "data")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Record data must be a JSON object."); return parsed; },
        catch: cause => new ApiError({ message: cause instanceof Error ? cause.message : "Invalid JSON record." })
      }).pipe(Effect.flatMap(record => request(`${api}/database/documents/${encodeURIComponent(collection)}`, "POST", { tenantId: tenant, data: record, ...(value(data, "recordId") ? { id: value(data, "recordId") } : {}) }))))));
    }
    panel.append(node("details", {}, node("summary", {}, section === "content" ? "Create content collection" : "Create table"), form(context, [field("tenantId", "Tenant ID", "text", tenant), field("name", section === "content" ? "Collection name" : "Table name")], "Create", data => request(`${api}/database/documents/collections`, "POST", { tenantId: value(data, "tenantId"), name: value(data, "name"), surface: section === "content" ? "content-studio" : "database" }), () => context.refresh())));
    return panel;
  }
  if (section === "auth") return readPanel("Users", yield* request(`${api}/auth/accounts`), undefined, ["id", "displayName", "email", "username", "verified"]);
  if (section === "storage") return readPanel("Files", yield* request(`${api}/storage/files?prefix=${encodeURIComponent(context.url.searchParams.get("prefix") ?? "")}`), "files", ["path", "size", "contentType", "updatedAt"]);
  if (section === "workloads") return readPanel("Workloads", yield* request(`${api}/workloads?projectId=${encodeURIComponent(project.id)}`), "workloads", ["id", "name", "type", "enabled"]);
  if (section === "marketplace") return readPanel("Project services", yield* request(`${api}/runtime/services`), "services", ["name", "version", "kind", "status"]);
  return empty("Page being ported", "This project section has not been implemented in Fuzor yet. Use the React dashboard for its full controls.");
});

export const serverScreen = Effect.fn("new-ui.serverScreen")(function*(context: ScreenContext) {
  const api = context.config.api.basePath;
  const section = context.section?.split("/")[0];
  if (!section) return node("section", {}, heading("Server"), node("div", { class: "workspace-links panel" }, ...[["Fabric & nodes", "nodes"], ["Domains & ingress", "domains"], ["System Store", "database"], ["Deployment backends", "backends"]].map(([title, path]) => link(title, `/server/${path}`))));
  if (section === "nodes" || section === "fabric") return readPanel("Fabric", yield* request(`${api}/fabric/snapshot`));
  if (section === "domains") return readPanel("Domains & ingress", yield* request(`${api}/runtime/edge`));
  if (section === "backends") return readPanel("Deployment backends", yield* request(`${api}/runtime/deployment-backends`), "backends", ["id", "title", "enabled", "executable"]);
  if (section === "database") {
    const data = yield* request(`${api}/runtime/system-store/namespaces`);
    const namespace = context.url.searchParams.get("namespace");
    const panel = node("section", { class: "panel" }, heading("System Store"), message("Read-only Platform persistence. Project data lives in each project’s Database."));
    const list = node("div", { class: "workspace-links" });
    for (const entry of rows(data, "namespaces")) { const name = label(object(entry).namespace); list.append(link(name, `/server/database?namespace=${encodeURIComponent(name)}`)); }
    panel.append(list);
    if (namespace) {
      const query = new URLSearchParams({ limit: "50", ...(context.url.searchParams.has("after") ? { after: context.url.searchParams.get("after")! } : {}) });
      const records = yield* request(`${api}/runtime/system-store/namespaces/${encodeURIComponent(namespace)}/records?${query}`);
      panel.append(table(rows(records, "records"), ["key", "value", "updatedAt"]));
      const next = object(records).next;
      if (typeof next === "string") panel.append(link("Next page →", `/server/database?namespace=${encodeURIComponent(namespace)}&after=${encodeURIComponent(next)}`));
    }
    return panel;
  }
  return empty("Page being ported", "This server surface is available in the React dashboard. The Fuzor port currently covers nodes, ingress, backends, and read-only System Store inspection.");
});

export const settingsScreen = Effect.fn("new-ui.settingsScreen")(function*(context: ScreenContext) {
  const panel = node("section", { class: "panel narrow" }, heading("Settings"), node("p", {}, "Experimental dashboard · Fuzor"));
  if (context.url.searchParams.get("onboarding") === "hostname") panel.append(message("Your owner account is active. Configure a Platform hostname now, or continue and configure it later."));
  panel.append(form(context, [field("hostname", "Platform hostname", "text", "", false), node("label", {}, node("span", {}, "HTTPS configuration"), node("select", { name: "mode" }, node("option", { value: "managed" }, "Verify DNS & enable HTTPS"), node("option", { value: "external" }, "Externally terminated TLS"), node("option", { value: "later" }, "Configure later")))], "Save hostname configuration", data => mutation(context, "/runtime/edge/onboard", { mode: value(data, "mode"), ...(value(data, "hostname") ? { hostname: value(data, "hostname") } : {}) }), result => panel.append(json(result))));
  return panel;
});

export const assistantScreen = Effect.fn("new-ui.assistantScreen")(function*(context: ScreenContext) {
  return readPanel("Assistant threads", yield* request(`${context.config.api.basePath}/runtime/assistant/threads`), "threads", ["id", "title", "updatedAt"]);
});
export const marketplaceScreen = Effect.fn("new-ui.marketplaceScreen")(function*(context: ScreenContext) {
  return readPanel("Apps, starters & services", yield* request(`${context.config.api.basePath}/runtime/services`), "services", ["name", "version", "kind", "status"]);
});

export function loadScreen(context: ScreenContext): Effect.Effect<HTMLElement, ApiError> {
  if (context.path === "/setup") return authScreen(context, true);
  if (context.path === "/login") return authScreen(context, false);
  if (context.path === "/" || context.path === "/projects") return projectsScreen(context);
  if (context.path === "/projects/create") return createProjectScreen(context);
  if (context.projectId) return projectScreen(context);
  if (context.path.startsWith("/server")) return serverScreen(context);
  if (context.path === "/marketplace") return marketplaceScreen(context);
  if (context.path.startsWith("/settings")) return settingsScreen(context);
  if (context.path === "/assistant") return assistantScreen(context);
  return Effect.succeed(empty("Page not found", "Choose a section from the sidebar to continue."));
}
