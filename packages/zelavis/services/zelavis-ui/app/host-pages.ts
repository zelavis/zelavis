import { Effect } from "effect";
import { array, label, object, request } from "./api.ts";
import { button, empty, field, link, node } from "./dom.ts";
import { badge, card, columns, dataRow, facts, page, resourceNotice, rowsCard, statCard } from "./page-kit.ts";
import { API_KEY_PRESETS } from "./api-key-presets.ts";
import type { ScreenContext } from "./screens.ts";

type HostPath = "/server" | "/server/resources" | "/server/backups" | "/server/runtimes" | "/server/domains" | "/server/database" | "/server/security" | "/server/access" | "/server/access/users" | "/server/access/permissions";

/** Server pages about the host itself: the overview, backends, domains, the System Store, security and access. */

const sections = [
  ["Platform Database", "/server/database", "Read-only Platform backend tables and records."],
  ["Deployment backends", "/server/runtimes", "Native, Docker, and future isolation backend detection and default policy."],
  ["Resources", "/server/resources", "Processes, host CPU and memory usage, storage, and limits."],
  ["Security", "/server/security", "Host security posture, checklist, and platform hardening."],
  ["Fabric", "/server/fabric", "Nodes, placement, routing, balancing, data distribution, and infrastructure providers."],
  ["Domains", "/server/domains", "Hostnames, TLS, and project bindings."],
  ["Access", "/server/access", "Principals, grants, users, and permissions."],
  ["Backups", "/server/backups", "Snapshots, retention, and restore points."],
  ["Logs", "/server/logs", "The Platform's recent log and the cause behind an error reference."],
  ["Terminal", "/server/terminal", "A shell on this server, inside tmux."]
] as const;

export const serverHomeScreen = Effect.fn("ui.serverHomeScreen")(function*(_context: ScreenContext) {
  return page(
    columns(3,
      statCard("Deployment", "native default", "Backend policy is explicit and existing Projects keep their assignment."),
      statCard("Resources", "monitoring", "Host CPU, memory, storage, and processes."),
      statCard("Security", "checklist", "Host security posture and guidance."),
      statCard("Fabric", "single-node", "The control plane is mounted and ready to grow into a cluster."),
      statCard("Domains", "planned", "Bind hostnames to projects and system services."),
      statCard("Access", "draft", "Manage system principals, grants, and permission scopes.")),
    rowsCard("Host management", ...sections.map(([title, path, detail]) => dataRow(title, detail, link("Open", path)))),
    resourceNotice("Server layer placeholder", "These screens establish the cPanel/Plesk-style host boundary. Live domain, backup, and log providers can plug in here later without becoming project features."));
});

export const backupsScreen = Effect.fn("ui.backupsScreen")(function*(_context: ScreenContext) {
  return page(
    rowsCard("Backup policies", dataRow("Default retention", "No automatic backup provider is configured yet.", badge("draft"))),
    resourceNotice("Restore first", "This area should model both scheduled backups and restore drills. A backup feature is not real until restore is first-class."));
});

type BackendAction = "detect" | "enable" | "disable" | "default";

export const runtimesScreen = Effect.fn("ui.runtimesScreen")(function*(context: ScreenContext) {
  const api = `${context.config.api.basePath}/runtime/deployment-backends`;
  const data = object(yield* request(api));
  const defaultBackend = label(object(data.policy).defaultBackend);
  const act = (id: string, action: BackendAction) => context.run(
    action === "detect" ? request(`${api}/detect`, "POST", { id }) : request(`${api}/${encodeURIComponent(id)}/${action}`, "POST", {}),
    () => context.refresh());
  const cards = array(data.backends).map(object).map(backend => {
    const id = label(backend.id, "");
    const detection = object(backend.detection);
    const capabilities = object(backend.capabilities);
    const enabled = backend.enabled === true;
    const isDefault = backend.isDefault === true;
    const executable = backend.executable === true;
    const state = label(detection.state, "unknown");
    const actions = [button("Detect", () => act(id, "detect"))];
    if (!enabled && executable && state === "ready") actions.push(button("Enable", () => act(id, "enable"), { class: "primary" }));
    if (enabled && !isDefault) actions.push(button("Make default", () => act(id, "default")));
    if (enabled && !isDefault && id !== "native") actions.push(button("Disable", () => act(id, "disable"), { class: "danger" }));
    return card(undefined,
      node("div", { class: "toolbar" }, node("div", {}, node("h2", {}, label(backend.title)), node("p", {}, label(capabilities.description, ""))), badge(state)),
      facts([
        ["Policy", isDefault ? "Enabled · Default" : enabled ? "Enabled" : "Disabled"],
        ["Project driver", executable ? "Registered" : "Not registered"],
        ["Isolation boundary", label(capabilities.isolationBoundary, "").replace("-", " ")],
        ...(typeof detection.version === "string" ? [["Version", detection.version] as const] : [])]),
      ...(typeof detection.error === "string" ? [node("p", { class: "danger" }, detection.error)] : []),
      node("div", { class: "actions" }, ...actions));
  });
  return page(
    rowsCard("Deployment policy", dataRow("Default for new Projects", "Changing this policy never migrates an existing Project. Every Project keeps its stored backend assignment.", defaultBackend)),
    columns(2, ...cards),
    resourceNotice("Detection is read-only", "This phase does not install Docker, access its control socket, migrate Projects, or claim that the current native process driver provides a hardened Linux jail. Those require the privileged Agent and native-isolation implementation described in the architecture plan."));
});

const DOMAIN_ACTIONS = {
  add: ["Add Domain", "Connect an existing domain to Zelavis and verify ownership."],
  buy: ["Buy Domain", "Search and register a new domain through a future registrar provider adapter."],
  transfer: ["Transfer Domain", "Move an existing domain registration into a future Zelavis-managed registrar flow."]
} as const;

export const domainsScreen = Effect.fn("ui.domainsScreen")(function*(context: ScreenContext) {
  const requested = context.url.searchParams.get("domainAction");
  const action = requested === "add" || requested === "buy" || requested === "transfer" ? DOMAIN_ACTIONS[requested] : undefined;
  return page(
    rowsCard("Domain inventory", dataRow(action?.[0] ?? "Server-wide domains", action?.[1] ?? "Hostnames will bind to projects, apps, and system services from this global layer.", badge(action ? "draft" : "planned"))),
    ...(action ? [rowsCard(action[0], dataRow("Workflow", "The dashboard route and sidebar state are ready; provider-backed domain actions come next.", badge("draft")))] : []),
    rowsCard("Domain bindings", dataRow("localhost", "Development host reserved for a local project.", badge("draft"))),
    resourceNotice("Provider boundary", "DNS, TLS, and verification providers belong here as host-level provider adapters. Projects should consume bindings, not own the provider."));
});

export const systemStoreScreen = Effect.fn("ui.systemStoreScreen")(function*(context: ScreenContext) {
  const api = `${context.config.api.basePath}/runtime/system-store/namespaces`;
  const namespace = context.url.searchParams.get("namespace") ?? "";
  const after = context.url.searchParams.get("after") ?? undefined;
  const notice = resourceNotice("Platform backend", "Read-only System Store tables. Credentials and secrets are redacted. Project databases are managed inside each Project.");
  const tableLink = (name: string, cursor?: string) => `/server/database?${new URLSearchParams({ namespace: name, ...(cursor === undefined ? {} : { after: cursor }) })}`;

  if (!namespace) {
    const namespaces = array(object(yield* request(api)).namespaces).map(object);
    const body = namespaces.length
      ? node("div", { class: "table-wrap" }, node("table", {},
        node("thead", {}, node("tr", {}, node("th", { scope: "col" }, "Table"), node("th", { scope: "col" }, "Records"))),
        node("tbody", {}, ...namespaces.map(entry => node("tr", {}, node("td", {}, link(label(entry.namespace), tableLink(label(entry.namespace, "")))), node("td", {}, label(entry.recordCount)))))))
      : empty("No backend tables", "Nothing is stored yet.");
    return page(notice, card(undefined, body));
  }

  const query = new URLSearchParams({ limit: "50", ...(after === undefined ? {} : { after }) });
  const result = object(yield* request(`${api}/${encodeURIComponent(namespace)}/records?${query}`));
  const records = array(result.records).map(object);
  const next = typeof result.next === "string" ? result.next : undefined;
  const body = records.length
    ? node("div", { class: "table-wrap" }, node("table", {},
      node("thead", {}, node("tr", {}, ...["Key", "Value", "Updated"].map(title => node("th", { scope: "col" }, title)))),
      node("tbody", {}, ...records.map(record => node("tr", {}, node("td", { class: "k-secret" }, label(record.key)), node("td", {}, node("pre", {}, JSON.stringify(record.value, null, 2))), node("td", {}, label(record.updatedAt)))))))
    : empty("No records on this page", "This table has nothing here.");
  return page(notice,
    node("div", { class: "toolbar" }, node("strong", {}, namespace), link("All tables", "/server/database")),
    card(undefined, body),
    node("div", { class: "actions" },
      ...(after === undefined ? [] : [link("First page", tableLink(namespace))]),
      ...(next === undefined ? [] : [link("Next page", tableLink(namespace, next))])));
});

const CHECKLIST = [
  ["SSH password login", "Detect whether password authentication is disabled for the server SSH daemon."],
  ["Firewall baseline", "Check that only expected public ports are open, starting with HTTP, HTTPS, and SSH."],
  ["Automatic updates", "Verify unattended security updates or an equivalent patch workflow."],
  ["Root login", "Warn when direct root SSH login is enabled on Linux hosts."]
] as const;

export const securityScreen = Effect.fn("ui.securityScreen")(function*(_context: ScreenContext) {
  return page(
    columns(3,
      statCard("Checklist", "planned", "Runnable checks will report clear pass, warning, and fix states."),
      statCard("Linux hardening", "first", "SSH, firewall, updates, users, and permissions are the first target."),
      statCard("Guidance", "plain", "Every warning should explain why it matters and how to fix it.")),
    rowsCard("Linux security checklist", ...CHECKLIST.map(([title, detail]) => dataRow(title, detail, badge("planned")))),
    resourceNotice("Designed for guided hardening", "The future runner should gather facts locally, avoid making changes without confirmation, and turn each check into a simple recommendation."),
    rowsCard("Future check groups",
      dataRow("TLS and domains", "Certificate health, expiry, redirects, and domain ownership checks.", badge("planned")),
      dataRow("Application secrets", "Secret presence, file permissions, and accidental public exposure checks.", badge("planned"))));
});

const PROCESSES = [
  ["zelavis-runtime", "Main dashboard and service runtime."],
  ["site-host", "Local website hosting worker for project domains."],
  ["database-writer", "Serialized local SQL writes and event-log append flow."],
  ["backup-scheduler", "Snapshot queue and backup windows."]
] as const;
const LIMITS = [
  ["Sustained CPU", "Warn above 70% for 10 minutes, mark critical above 90%."],
  ["Memory pressure", "Watch used RAM, cache pressure, and swap activity together."],
  ["Disk capacity", "Warn before local media, database files, and backups fill the volume."],
  ["Outbound traffic", "Track project traffic so small VPS plans do not surprise the user."]
] as const;

/** The host does not report CPU, memory, disk or traffic yet, so this page says what is planned and shows no numbers. */
export const resourcesScreen = Effect.fn("ui.resourcesScreen")(function*(context: ScreenContext) {
  const requested = context.url.searchParams.get("resourceView");
  const view = requested === "processes" || requested === "storage" || requested === "limits" ? requested : "";
  const tab = (name: string, title: string) => button(title, () => context.setSearch({ resourceView: name || undefined }), { class: view === name ? "primary" : "", "aria-pressed": String(view === name) });
  return page(
    node("div", { class: "actions" }, tab("", "Overview"), tab("processes", "Processes"), tab("storage", "Storage"), tab("limits", "Limits")),
    resourceNotice("Host metrics are not collected yet", "This Platform does not report CPU, memory, disk or network usage, so nothing is charted here rather than showing numbers that are not real. The rows below are what this page will cover."),
    ...(view === "" ? [columns(3, statCard("CPU and memory", "planned", "Host pressure over time."), statCard("Disk", "planned", "What is consuming local storage."), statCard("Network", "planned", "Traffic per project."))] : []),
    ...(view === "" || view === "processes" ? [rowsCard("Processes", ...PROCESSES.map(([title, detail]) => dataRow(title, detail, badge("planned"))))] : []),
    ...(view === "storage" ? [rowsCard("Storage", dataRow("Projects", "Project files and runtime state.", badge("planned")), dataRow("Databases", "Project databases and the System Store.", badge("planned")), dataRow("Backups and logs", "Retained snapshots and log files.", badge("planned")))] : []),
    ...(view === "" || view === "limits" ? [rowsCard("Limits", ...LIMITS.map(([title, detail]) => dataRow(title, detail, badge("planned"))))] : []));
});

const LEVELS = [
  ["Owner", "Full system grants for the Zelavis instance and every project."],
  ["Operator", "Delegated support and operations grants across selected resources."],
  ["Reseller", "Scoped customer and project grants under a reseller boundary."],
  ["Customer", "Project-scoped grants for the customer's own apps and sites."]
] as const;

function scopeText(scope: unknown) {
  const value = object(scope);
  if (value.type === "project") return `project:${label(value.projectId ?? value.projectIdParam, "*")}`;
  if (value.type === "service") return `service:${label(value.serviceName ?? value.serviceNameParam, "*")}`;
  return value.type === "system" ? "system" : "global";
}

export const accessScreen = Effect.fn("ui.accessScreen")(function*(context: ScreenContext) {
  const access = object(context.config.access);
  const principal = object(access.principal);
  const permissions = array(principal.permissions).map(String);
  const grants = array(principal.grants).map(object);
  const wildcard = permissions.includes("*");
  return page(
    columns(3,
      statCard("Current view", label(access.label, "Unknown"), "The dashboard filters projects, menus, and actions from this principal."),
      statCard("Roles", array(principal.roles).map(String).join(", ") || "none", "Roles describe broad shape; permissions authorize concrete actions."),
      statCard("Project grants", String(array(access.projects).length), "Customer and reseller dashboards are project-scope first.")),
    rowsCard("Authenticated access",
      dataRow("Principal", label(principal.id, "No principal"), badge(label(principal.type, "anonymous"))),
      dataRow("Mode", label(access.mode, "unknown"), badge(label(access.mode, "unknown"))),
      dataRow("Permissions", permissions.join(", ") || "grants only", badge(wildcard ? "ready" : "planned"))),
    columns(2,
      rowsCard("Current grants", ...(grants.length
        ? grants.map(grant => dataRow(label(grant.permission), scopeText(grant.scope), badge("active")))
        : [dataRow("Wildcard owner", wildcard ? "All permissions" : "No grants", badge(wildcard ? "ready" : "planned"))])),
      rowsCard("User levels", ...LEVELS.map(([title, detail]) => dataRow(title, detail, badge(title === access.label ? "active" : "planned"))))),
    resourceNotice("One access model", "This screen reflects the principal authenticated by the Platform. User creation, role editing, customer accounts, reseller boundaries, and Hosting Provider billing links remain endpoint-backed workflows to add next."));
});

const VOCABULARY = [
  ["System", "server.manage", "Server, domains, resources, security, backups, and logs."],
  ["Projects", "projects.list", "List projects visible to the current principal."],
  ["Project content", "project.content.read", "Read project content surfaces for a scoped project."],
  ["Project website", "project.website.manage", "Manage the website surface for a scoped project."]
] as const;

export const permissionsScreen = Effect.fn("ui.permissionsScreen")(function*(_context: ScreenContext) {
  return page(
    columns(3,
      statCard("Scopes", "system / project / service", "Permissions become useful only when paired with a scope."),
      statCard("Authority", "endpoint", "Dashboard filtering is presentation; endpoints enforce access."),
      statCard("Plugin rule", "shared", "Hosting Provider and other modules use the same permission model.")),
    rowsCard("Initial permission vocabulary", ...VOCABULARY.map(([group, permission, detail]) => dataRow(permission, detail, badge(group.toLowerCase())))),
    resourceNotice("Permission names are still early", "The important part is the core shape: explicit permissions, system/project/service scopes, and endpoint enforcement before dashboard controls."));
});

export const accessUsersScreen = Effect.fn("ui.accessUsersScreen")(function*(context: ScreenContext) {
  const api = `${context.config.api.basePath}/auth`;
  const accounts = array(yield* request(`${api}/accounts`)).map(object);
  const serviceAccounts = array(object(yield* request(`${api}/service-accounts`)).serviceAccounts).map(object);
  const people = accounts.filter(account => object(account.metadata).principalType !== "service");
  const owners = people.filter(account => array(account.roles).includes("owner")).length;
  const status = node("p", { class: "muted", role: "status" });
  const token = node("div", { class: "k-notice", hidden: "" });

  const nameField = field("name", "Key name", "text", "", true);
  const projectField = field("projectId", "Project ID for a Project client's scoped grants (optional)", "text", "", false);
  const presetField = node("label", {}, node("span", {}, "What it can do"), node("select", { name: "preset" }, ...API_KEY_PRESETS.map(preset => node("option", { value: preset.id }, `${preset.title}: ${preset.detail}`))));
  const daysField = field("days", "Valid for (days)", "number", "90", true);
  const form = node("form", { class: "k-inline" }, nameField, presetField, daysField, projectField, node("button", { type: "submit", class: "primary" }, "Create API key"));
  const showToken = (issued: Record<string, unknown>) => {
    token.hidden = false;
    token.replaceChildren(node("p", { class: "k-row-label" }, "One-time API key"), node("input", { readonly: "", value: label(issued.token, ""), "aria-label": "Issued API key" }),
      node("p", { class: "k-row-detail" }, `Use it as a bearer token: zelavis debug processes --url ${location.origin}${context.config.api.basePath.replace(/\/api\/v1$/, "")} --token <key>`));
    status.textContent = "Key issued. Copy it now; Zelavis will not show it again.";
  };
  form.addEventListener("submit", event => {
    event.preventDefault();
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const projectId = String(data.get("projectId") ?? "").trim();
    const preset = API_KEY_PRESETS.find(candidate => candidate.id === data.get("preset")) ?? API_KEY_PRESETS[0];
    const days = Math.max(1, Math.min(3650, Number(data.get("days")) || 90));
    const grants = preset.id === "client" && projectId ? ["project.view", "project.runtime.manage", "project.settings.manage", "project.users.manage"].map(permission => ({ permission, scope: { type: "project", projectId } })) : [];
    context.run(request(`${api}/service-accounts`, "POST", { name, permissions: [...preset.permissions], grants, expiresInDays: days }), result => showToken(object(result)));
  });

  return page(
    columns(3,
      statCard("People", String(people.length), `${owners} owner account${owners === 1 ? "" : "s"}.`),
      statCard("Service accounts", String(serviceAccounts.length), "Scoped machine identities for SDKs, CI, and agents."),
      statCard("Authority", "core", "Users and clients share the same grants and endpoint enforcement.")),
    rowsCard("Platform users", ...people.map(account => dataRow(
      label(account.displayName ?? account.email ?? account.username ?? account.id), label(account.email ?? account.username ?? account.id),
      badge(label(array(account.roles)[0], account.verified === true ? "verified" : "unverified"))))),
    card("API keys", form, token, status),
    rowsCard("Keys", ...serviceAccounts.map(account => dataRow(
      label(account.displayName ?? account.id), `${label(account.id)} · ${array(account.permissions).length} permissions · ${array(account.grants).length} scoped grants`,
      node("span", {},
        button("Rotate", () => context.run(request(`${api}/service-accounts/${encodeURIComponent(label(account.id, ""))}/token`, "POST", { expiresInDays: 90 }), result => showToken(object(result)))),
        button("Revoke", () => context.run(request(`${api}/service-accounts/${encodeURIComponent(label(account.id, ""))}`, "DELETE"), () => context.refresh()), { class: "danger" }))))),
    resourceNotice("Use API keys for software", "Scripts, CI, agents and debugging sessions should use a revocable key with only what they need. They should never reuse an owner's browser session or an app user's credentials. Rotating a key revokes the old token at once."));
});

export const hostScreens = {
  "/server": serverHomeScreen,
  "/server/resources": resourcesScreen,
  "/server/backups": backupsScreen,
  "/server/runtimes": runtimesScreen,
  "/server/domains": domainsScreen,
  "/server/database": systemStoreScreen,
  "/server/security": securityScreen,
  "/server/access": accessScreen,
  "/server/access/users": accessUsersScreen,
  "/server/access/permissions": permissionsScreen
} as const satisfies Record<HostPath, (context: ScreenContext) => Effect.Effect<HTMLElement, unknown>>;
