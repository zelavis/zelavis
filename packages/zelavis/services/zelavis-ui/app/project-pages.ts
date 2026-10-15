import { Effect } from "effect";
import { ApiError, array, label, object, request, type Config, type Project } from "./api.ts";
import { button, empty, field, link, node } from "./dom.ts";
import { badge, card, columns, dataRow, flashNotice, page, resourceNotice, rowsCard, setFlash, statCard } from "./page-kit.ts";
import { notRunning, projectContext } from "./project-context.ts";
import { siteUrl } from "./projects-pages.ts";
import { providerCard } from "./settings-pages.ts";
import { servicePageScreen } from "./service-pages.ts";
import { mediaScreen, storageScreen } from "./storage-pages.ts";
import type { ScreenContext } from "./screens.ts";

/** The Project's own pages that are not a database, content, storage or workload editor. */

const managed = (project: Project) => { const value = object(object(project.recipe).managed); return Object.keys(value).length ? value : undefined; };

const MANAGED_SECTIONS: Record<string, readonly [title: string, detail: string]> = {
  domains: ["Domains", "Project hostnames and TLS bindings will be managed here."],
  files: ["Files", "A project file manager and deployment file view will live here."],
  "app-database": ["App database", "Managed app database access belongs here, separate from Zelavis-native collections."],
  setup: ["Setup", "Values the application's own installer asks for."],
  backups: ["Backups", "Project restore points and backup policy overrides will live here."],
  logs: ["Logs", "Application and web server logs for this managed project will live here."],
  updates: ["Updates", "Managed app core, theme, plugin, or runtime update controls will live here."],
  admin: ["App Admin", "This opens or proxies the app's own admin area, such as the admin area a recipe declares."]
};

/** Sections that are still the React workspace. A page leaves this list when it is rebuilt natively. */
const LEGACY_SECTIONS = new Set(["database", "content", "workloads"]);

const usable = (scoped: Config, name: string, hosted: boolean) => { const entry = object(object(scoped.capabilities)[name]); return entry.available === true && (!hosted || entry.used === true); };

export const handlesProjectPath = (context: ScreenContext) => {
  if (!context.projectId) return false;
  const section = context.path.split("/")[3];
  return !section || !LEGACY_SECTIONS.has(section);
};

export const projectPagesScreen = Effect.fn("ui.projectPages")(function*(context: ScreenContext) {
  const entered = yield* projectContext(context);
  if (entered.missing) return entered.missing;
  const { project, scoped } = entered;
  const section = context.path.split("/")[3] ?? "";
  const hosted = managed(project);
  const base = `/projects/${encodeURIComponent(project.id)}`;
  if (section === "") return yield* overviewScreen(context, project, scoped, hosted);
  if (section === "settings") return yield* settingsScreen(context, project);
  if (section === "extensions") return extensionsScreen(base);
  if (section === "agents") return empty("No agents connected", "The dashboard shell is ready for the agent service boundary.");
  if (section === "frontend") return empty("No frontend selected", "This Project serves a placeholder to visitors. A frontend can be a static site or an application that brings its own server.");
  if (section === "backend") return scoped ? backendScreen(base, scoped, hosted !== undefined) : notRunning();
  if (hosted && MANAGED_SECTIONS[section]) return yield* managedScreen(context, project, section, hosted);
  if (!scoped) return notRunning();
  context.projectNavigation(project, scoped);
  if (section === "auth") return yield* authScreen(context, scoped);
  if (section === "users") return yield* usersScreen(context, scoped);
  if (section === "storage") return yield* storageScreen(context, scoped);
  if (section === "media") return yield* mediaScreen(context, scoped);
  const servicePage = yield* servicePageScreen(scoped, context.path, project.id);
  return servicePage ?? empty("Page not found", "Choose a section from the sidebar to continue.");
});

const overviewScreen = Effect.fn("ui.projectOverview")(function*(_context: ScreenContext, project: Project, scoped: Config | undefined, hosted: Record<string, unknown> | undefined) {
  if (hosted) {
    return page(
      node("div", { class: "actions" }, link("Domains", "/server/domains")),
      columns(3,
        statCard("App", label(object(project.recipe).title, label(object(project.recipe).name)), "Managed through hosting-style controls."),
        statCard("Domains", "planned", "Server-level bindings will attach here."),
        statCard("Backups", "planned", "Project snapshots come from the host backup layer.")),
      rowsCard("Hosting controls",
        dataRow("Application admin", typeof hosted.adminPath === "string" ? `${label(hosted.adminTitle, "App Admin")} will open the app's own dashboard.` : "The app keeps its own runtime/admin surface.", badge("draft")),
        dataRow("Files", "Future file manager and deploy controls.", badge("draft")),
        dataRow("Logs", "Future project log stream from the server layer.")),
      resourceNotice("Different project surface", "Manage the application through hosting controls. Zelavis API sections appear automatically when its integration uses them."));
  }
  if (!scoped) return notRunning();
  const api = scoped.api.basePath;
  const capabilities = object(scoped.capabilities);
  const services = array(scoped.services).map(object);
  const health = object(yield* (object(capabilities.database).available === true ? request(`${api}/database/health`).pipe(Effect.catch(() => Effect.succeed(undefined))) : Effect.succeed(undefined)));
  const providers = array(yield* (object(capabilities.identity).available === true ? request(`${api}/auth/providers`).pipe(Effect.catch(() => Effect.succeed([]))) : Effect.succeed([]))).map(String);
  const ready = health.status !== undefined;
  return page(
    columns(3,
      statCard("Mounted core", `${services.length || 3} services`, services.map(service => label(service.name)).join(", ") || "dashboard, auth, database"),
      statCard("Database", label(health.nodeId, "checking"), ready ? label(health.status) : "waiting for /database/health"),
      statCard("Auth", `${providers.length} providers`, providers.length ? providers.join(", ") : "no credential providers registered yet")),
    columns(2,
      rowsCard("Service Map", ...(services.length
        ? services.map(service => dataRow(label(service.name), `${label(service.scope, "extension")} ${label(service.kind, "plugin")} · ${label(service.apiPath)}`, badge("ready")))
        : [resourceNotice("Runtime config unavailable", "Start Zelavis through the Node example to load live service metadata.")])),
      rowsCard("Activity",
        dataRow("Runtime config", api, "ready"),
        dataRow("Database health", ready ? `${label(health.status)} · ${label(health.nodeId)}` : "/database/health", ready ? "ready" : "offline"),
        dataRow("Auth providers", providers.length ? providers.join(", ") : "/auth/providers", providers.length ? "ready" : "offline"))));
});

function backendScreen(base: string, scoped: Config, hosted: boolean) {
  const sections = [
    ["Database", "database", "database", "Tables, document collections, queries, and schemas."],
    ["Auth", "auth", "identity", "Authentication providers, sessions, and credentials."],
    ["Storage", "storage", "storage", "Buckets, media assets, uploads, and file storage."],
    ["Workloads", "workloads", "workloads", "Functions, jobs, schedules, and webhooks."]
  ].map(([title, path, capability, detail]) => ({ title, path, detail, active: usable(scoped, capability, hosted) })).filter(section => !hosted || section.active);
  return page(
    columns(3, ...sections.map(section => statCard(section.title, section.active ? "ready" : "planned", section.detail))),
    card("Backend APIs", ...sections.map(section => node("div", { class: "k-row" },
      node("div", {}, node("p", { class: "k-row-label" }, section.title), node("p", { class: "k-row-detail" }, section.detail)),
      node("div", { class: "k-row-meta" }, badge(section.active ? "ready" : "planned"), link(`Open ${section.title}`, `${base}/${section.path}`))))),
    resourceNotice("Project data", "Zelavis data belongs to this Project. For managed apps, the application’s own data remains separate."));
}

function extensionsScreen(base: string) {
  return page(
    columns(3, statCard("Agents", "ready", "AI agents, assistants, and automated workflows.")),
    card("Project Extensions", node("div", { class: "k-row" }, node("div", {}, node("p", { class: "k-row-label" }, "Agents"), node("p", { class: "k-row-detail" }, "AI agents, assistants, and automated workflows.")), node("div", { class: "k-row-meta" }, badge("ready"), link("Open Agents", `${base}/agents`)))),
    resourceNotice("Project Extensions", "Extend this project with official plugins, AI assistants, and domain capabilities installed from the marketplace."));
}

const settingsScreen = Effect.fn("ui.projectSettings")(function*(context: ScreenContext, project: Project) {
  const provider = yield* providerCard(context, project.id);
  return page(
    flashNotice("Saved"),
    provider,
    rowsCard("Project identity", dataRow("Project ID", project.id, badge("draft")), dataRow("Project type", "Zelavis-native app", badge("ready"))),
    rowsCard("Project bindings", dataRow("Primary domain", "Managed from the global Domains area.", badge("planned")), dataRow("Database tenant", "Project-scoped data is isolated by tenant-aware storage.")),
    resourceNotice("Global settings moved", "Appearance, runtime services, root path, and server-wide preferences are available from the footer dropdown."));
});

const managedScreen = Effect.fn("ui.managedSection")(function*(context: ScreenContext, project: Project, section: string, hosted: Record<string, unknown>) {
  const [title, detail] = MANAGED_SECTIONS[section];
  if (section === "setup") return yield* setupScreen(context, project);
  const site = siteUrl(project as unknown as Record<string, unknown>, context.url);
  const admin = typeof hosted.adminPath === "string" && section === "admin" && site
    ? [node("a", { class: "primary", href: `${site.replace(/\/$/, "")}${hosted.adminPath}`, target: "_blank", rel: "noreferrer" }, `Open ${label(hosted.adminTitle, "App Admin")}`)]
    : [];
  return page(
    rowsCard(title, dataRow(project.id, "Project-specific host controls are scaffolded; provider-backed behavior comes next.", badge("draft")), node("p", { class: "muted" }, detail)),
    resourceNotice("Managed app boundary", "Hosting controls manage the application itself. When its services use Zelavis APIs, the existing Zelavis sections appear in this project."),
    ...admin);
});

/** What the application's own installer asks for; revealing the secrets is audited by the Platform. */
const setupScreen = Effect.fn("ui.projectSetup")(function*(context: ScreenContext, project: Project) {
  const path = `${context.config.api.basePath}/runtime/projects/${encodeURIComponent(project.id)}/setup`;
  const revealed = context.url.searchParams.get("reveal") === "1";
  const reveals = yield* request(`${path}/audit`).pipe(Effect.map(result => array(object(result).reveals).map(object)), Effect.catch(() => Effect.succeed([] as Record<string, unknown>[])));
  const outcome = yield* request(revealed ? `${path}/reveal` : path, revealed ? "POST" : "GET", revealed ? {} : undefined).pipe(Effect.map(result => ({ values: array(object(result).values).map(object) })), Effect.catch((error: ApiError) => Effect.succeed({ values: [] as Record<string, unknown>[], error: error.message })));
  const hasSecrets = outcome.values.some(value => value.secret === true);
  const rows = outcome.values.map(value => dataRow(label(value.label), label(value.value, "Hidden until revealed"), value.secret === true ? badge(revealed ? "active" : "draft") : undefined));
  return page(rowsCard("Setup",
    ...(rows.length || "error" in outcome ? rows : [dataRow("No setup values", "This application's own installer asks for nothing the Platform generated.")]),
    ...("error" in outcome && outcome.error ? [resourceNotice("Setup values", outcome.error)] : []),
    ...reveals.slice(0, 5).map(entry => dataRow(`Revealed by ${label(entry.principalType)}:${label(entry.principalId)}`, `${new Date(Number(entry.at)).toLocaleString()} (${array(entry.revealed).join(", ")})`)),
    ...(hasSecrets && !revealed ? [node("div", { class: "k-row" }, node("div", {}, button("Reveal secrets", () => context.setSearch({ reveal: "1" }), { class: "primary" }), node("p", { class: "muted" }, "Revealing is recorded in the audit trail and needs the project.setup.reveal permission.")))] : [])));
});

const authScreen = Effect.fn("ui.projectAuth")(function*(context: ScreenContext, scoped: Config) {
  const api = scoped.api.basePath;
  const providers = array(yield* request(`${api}/auth/providers`)).map(String);
  const connections = array(object(yield* request(`${api}/auth/oauth/connections`)).providers).map(object);
  const configured = connections.filter(entry => entry.configured === true).length;
  const save = (name: string, body: Record<string, unknown>, text: string) => context.run(request(`${api}/auth/oauth/connections/${encodeURIComponent(name)}`, "PUT", body), () => { setFlash(text); context.refresh(); });

  const provider = field("provider", "Provider name", "text", "github");
  const issuer = field("issuer", "OIDC issuer URL (optional for GitHub)", "text", "", false);
  const redirect = field("redirectUri", "Redirect URI", "text", "");
  const preset = (name: "github" | "google") => {
    (provider.querySelector("input") as HTMLInputElement).value = name;
    (issuer.querySelector("input") as HTMLInputElement).value = name === "google" ? "https://accounts.google.com" : "";
    (redirect.querySelector("input") as HTMLInputElement).value = `${location.origin}${api}/auth/oauth/${name}/callback`;
  };
  const form = node("form", { class: "form" },
    node("div", { class: "actions" }, button("GitHub", () => preset("github")), button("Google", () => preset("google"))),
    provider, issuer, field("clientId", "Client ID"), field("clientSecret", "Client secret (write-only)", "password", "", false), redirect,
    node("button", { type: "submit", class: "primary" }, "Save provider"));
  form.addEventListener("submit", event => {
    event.preventDefault();
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    save(text("provider"), { ...(text("issuer") ? { issuer: text("issuer") } : {}), clientId: text("clientId"), ...(String(data.get("clientSecret") ?? "") ? { clientSecret: String(data.get("clientSecret")) } : {}), redirectUri: text("redirectUri"), enabled: true }, `${text("provider")} is configured and active.`);
  });

  return page(
    flashNotice("Saved"),
    columns(3,
      statCard("Password", providers.includes("password") ? "active" : "unavailable", "Email or username with the built-in password ceremony."),
      statCard("Active providers", String(providers.length), providers.join(", ") || "No credential providers registered"),
      statCard("OAuth connections", String(configured), "Project-owned, write-only provider credentials.")),
    rowsCard("Sign-in providers",
      dataRow("Email / password", "Built into Zelavis Auth; passwords are hashed and sessions are Project-scoped.", badge(providers.includes("password") ? "active" : "unavailable")),
      ...connections.map(connection => dataRow(label(connection.title ?? connection.provider), connection.configured === true ? `${label(connection.clientId)} · ${label(connection.redirectUri)}${connection.hasClientSecret === true ? " · secret set" : ""}` : "Not configured",
        connection.configured === true
          ? button(connection.enabled === true ? "Disable" : "Enable", () => save(label(connection.provider, ""), { ...(connection.issuer ? { issuer: label(connection.issuer) } : {}), clientId: label(connection.clientId, ""), redirectUri: label(connection.redirectUri, ""), enabled: connection.enabled !== true }, `${label(connection.provider)} ${connection.enabled === true ? "disabled" : "enabled"}.`))
          : badge("available")))),
    card("Configure OAuth or OpenID Connect", form),
    resourceNotice("Provider credentials belong to this Project", "Secrets are write-only and remain in the Project runtime. Platform login providers and other Projects use separate configuration."));
});

const usersScreen = Effect.fn("ui.projectUsers")(function*(context: ScreenContext, scoped: Config) {
  const accounts = array(yield* request(`${scoped.api.basePath}/auth/accounts`)).map(object);
  const filter = context.url.searchParams.get("filter") ?? "All";
  const query = (context.url.searchParams.get("q") ?? "").trim().toLowerCase();
  const nameOf = (account: Record<string, unknown>) => label(account.displayName ?? account.username ?? account.email ?? account.id);
  const visible = accounts.filter(account => (filter === "All" || (filter === "Verified") === (account.verified === true)) && (!query || [account.displayName, account.email, account.username, account.id].some(value => typeof value === "string" && value.toLowerCase().includes(query))));
  const search = node("input", { type: "search", name: "q", value: context.url.searchParams.get("q") ?? "", placeholder: "Search users", "aria-label": "Search users" });
  const form = node("form", { role: "search" }, search);
  form.addEventListener("submit", event => { event.preventDefault(); context.setSearch({ q: search.value.trim() || undefined }); });
  const rows = visible.map(account => {
    const name = nameOf(account);
    const secondary = account.email && account.email !== name ? label(account.email) : account.username && account.username !== name ? `@${label(account.username)}` : label(account.id);
    const created = new Date(label(account.createdAt, ""));
    return dataRow(name, `${secondary}${Number.isNaN(created.getTime()) ? "" : ` · ${created.toLocaleDateString()}`}`, badge(account.verified === true ? "verified" : "unverified"));
  });
  return page(
    node("div", { class: "toolbar" }, node("div", {}, node("h1", {}, "Users"), node("p", { class: "muted" }, `${visible.length} account${visible.length === 1 ? "" : "s"}`)),
      node("div", { class: "actions" }, ...["All", "Verified", "Unverified"].map(name => button(name, () => context.setSearch({ filter: name === "All" ? undefined : name }), { class: filter === name ? "primary" : "", "aria-pressed": String(filter === name) })))),
    form,
    rowsCard("", ...(rows.length ? rows : [dataRow("No users found", "")])));
});
