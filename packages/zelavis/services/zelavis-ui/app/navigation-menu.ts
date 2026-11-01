import { Effect } from "effect";
import { array, label, object, request, type Config, type Project } from "./api.ts";
import { buildContentTypeRows, type ContentTypeRow } from "./content-studio.ts";

/**
 * The sidebar's menus, built from what the Platform reports: the menus services register, the capabilities a Project
 * has, its content types and tables, and what the signed-in principal may see. An item is `{ title, path, search?, items? }`
 * (the sidebar turns nested items into slides), and an item the principal may not use is not shown.
 */
export interface MenuItem { title: string; path: string; search?: Record<string, string>; items?: MenuItem[]; access?: unknown }

type Requirement = { authenticated?: boolean; roles?: readonly string[]; permissions?: readonly string[]; scope?: { type?: string; projectId?: string; projectIdParam?: string; serviceName?: string } };

function scopesMatch(requirement: Requirement, grant: Record<string, unknown>, projectId?: string) {
  const required = requirement.scope;
  const granted = object(grant.scope);
  if (!required) return true;
  if (!grant.scope) return required.type === "system";
  if (required.type !== granted.type) return false;
  if (required.type === "project") { const id = required.projectId ?? (required.projectIdParam ? projectId : undefined); return id === undefined || granted.projectId === undefined || id === granted.projectId; }
  if (required.type === "service") return required.serviceName === undefined || granted.serviceName === undefined || required.serviceName === granted.serviceName;
  return true;
}

function allows(access: unknown, requirement: Requirement, projectId?: string) {
  const principal = object(object(access).principal);
  const permissions = array(principal.permissions).map(String);
  const needsLogin = requirement.authenticated === true || Boolean(requirement.roles?.length) || Boolean(requirement.permissions?.length);
  if (needsLogin && principal.type === "anonymous") return false;
  if (requirement.roles?.length && !requirement.roles.some(role => array(principal.roles).includes(role))) return false;
  return (requirement.permissions ?? []).every(permission => permissions.includes("*") || permissions.includes(permission) || array(principal.grants).map(object).some(grant => (grant.permission === "*" || grant.permission === permission) && scopesMatch(requirement, grant, projectId)));
}

/** True when the principal satisfies any requirement of the item; no access declared means everyone. */
export function canAccess(access: unknown, requirement: unknown, projectId?: string): boolean {
  if (!requirement || !access) return true;
  const requirements = (Array.isArray(requirement) ? requirement : [requirement]) as Requirement[];
  return requirements.some(entry => allows(access, entry, projectId));
}

export function filterMenu(items: readonly MenuItem[], access: unknown, projectId?: string): MenuItem[] {
  return items.filter(item => canAccess(access, item.access, projectId)).map(({ access: _, ...item }) => ({ ...item, ...(item.items ? { items: filterMenu(item.items, access, projectId) } : {}) }));
}

const slug = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const servicePart = (name: string) => slug(name.replace(/^@/, "").replace(/^zelavis\//, ""));

/** A registered menu as an item. A menu without a path gets the one the service-page router derives for it. */
function fromMenu(menu: Record<string, unknown>, serviceName: string | undefined, parents: string[] = []): MenuItem {
  const title = label(menu.title, "Service");
  const own = slug(title);
  const service = serviceName ? servicePart(serviceName) : undefined;
  const segments = [service && ((parents.length === 0 && service === own) || parents[0] === service) ? undefined : service, ...parents, parents.at(-1) === own ? undefined : own].filter(Boolean);
  const path = typeof menu.path === "string" ? menu.path : `/${segments.join("/")}`;
  const search = Object.fromEntries(Object.entries(object(menu.search)).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  const children = array(menu.items).map(object).filter(item => item.disabled !== true).map(item => fromMenu(item, serviceName, [...parents, own]));
  return { title, path, ...(Object.keys(search).length ? { search } : {}), ...(children.length ? { items: children } : {}), ...(menu.access ? { access: menu.access } : {}) };
}

const menusOf = (service: Record<string, unknown>) => (array(service.menus).length ? array(service.menus) : service.menu ? [service.menu] : []).map(object);
/** Where a menu belongs. Only a trusted service names its own surface; an extension (installed at runtime or dropped into a services folder) is always the Extensions slide, whatever its definition says. */
const surfaceOf = (menu: Record<string, unknown>, service: Record<string, unknown>) => service.scope === "system" ? label(menu.surface ?? object(service.menu).surface, "core") : "extensions";

/** The Platform's own menus: Projects, and what trusted services contribute to the global shell (Server, Marketplace...). */
export function platformMenu(config: Config, namespaces: readonly string[]): MenuItem[] {
  const contributed = array(config.services).map(object).filter(service => service.scope === "system").flatMap(service => menusOf(service).filter(menu => surfaceOf(menu, service) === "platform").map(menu => ({ order: Number(menu.order ?? Number.MAX_SAFE_INTEGER), item: fromMenu(menu, label(service.name, "")) })));
  contributed.sort((left, right) => left.order - right.order);
  const items = contributed.map(entry => entry.item.path === "/server" ? { ...entry.item, items: (entry.item.items ?? []).map(child => child.path === "/server/database" ? { ...child, items: namespaces.map(namespace => ({ title: namespace, path: "/server/database", search: { namespace } })) } : child) } : entry.item);
  const extensions = array(config.services).map(object).filter(service => service.scope !== "system").flatMap(service => menusOf(service).map(menu => fromMenu(menu, label(service.name, ""))));
  if (extensions.length) items.push({ title: "Extensions", path: "/services", items: extensions });
  return filterMenu([{ title: "Projects", path: "/projects", access: { permissions: ["projects.list"], scope: { type: "system" } } }, ...items], config.access);
}

/** Services the Platform composed whose Project-surface menus every Project offers; never their platform menus. */
function offeredByPlatform(control: Config, project: Record<string, unknown>[]) {
  const names = new Set(project.map(service => label(service.name, "")));
  return array(control.services).map(object).filter(service => service.scope === "system" && service.name !== "@zelavis/ui" && !names.has(label(service.name, "")));
}

export interface ProjectMenuInput {
  control: Config;
  project: Project;
  runtime: Config;
  content: readonly ContentTypeRow[];
  tables: readonly Record<string, unknown>[];
  workloads: Readonly<Record<string, readonly { id: string; name: string }[]>>;
}

export function projectMenu(input: ProjectMenuInput): MenuItem[] {
  const { project, runtime } = input;
  const id = encodeURIComponent(project.id);
  const base = `/projects/${id}`;
  const at = (path: string) => path === "/" ? base : `${base}${path}`;
  const capabilities = object(runtime.capabilities);
  const managed = Object.keys(object(object(project.recipe).managed)).length > 0;
  const available = (name: string) => object(capabilities[name]).available === true && (!managed || object(capabilities[name]).used === true);
  const projectAccess = (permission: string) => ({ permissions: [permission], scope: { type: "project", projectId: project.id } });
  const services = [...array(runtime.services).map(object), ...offeredByPlatform(input.control, array(runtime.services).map(object))];
  const bySurface = (surface: string) => services.filter(service => label(service.name, "") !== "@zelavis/ui").flatMap(service => menusOf(service).filter(menu => surfaceOf(menu, service) === surface && menu.path !== "/").map(menu => { const item = fromMenu(menu, label(service.name, "")); return prefixed(item); }));
  const prefixed = (item: MenuItem): MenuItem => ({ ...item, path: item.path.startsWith(base) ? item.path : at(item.path), ...(item.items ? { items: item.items.map(prefixed) } : {}) });

  // The default Tenant is implied, so its tables read as their own name; other Tenants (a plugin's `service:...`) keep theirs.
  const tableTitle = (entry: Record<string, unknown>) => { const search = object(entry.search); return search.databaseTenant === "zelavis-app" && typeof search.databaseTable === "string" ? search.databaseTable : label(entry.title); };
  // A plugin keeps its own data in a `service:<name>` Tenant; those tables get a slide of their own, beside System Tables, so the App's tables stay at the top.
  const pluginTable = (entry: Record<string, unknown>) => String(object(entry.search).databaseTenant ?? "").startsWith("service:");
  const asItem = (entry: Record<string, unknown>, title: string) => ({ title, path: at("/database"), search: Object.fromEntries(Object.entries(object(entry.search)).filter(([, value]) => typeof value === "string")) as Record<string, string> });
  const userTables = input.tables.filter(entry => !object(entry.search).databaseSystemView);
  const tableItems = userTables.filter(entry => !pluginTable(entry)).map(entry => asItem(entry, tableTitle(entry)));
  const pluginItems = userTables.filter(pluginTable).map(entry => asItem(entry, label(entry.title).replace(/^service:/u, "")));
  // A system view describes one Tenant, but the database lists them under an arbitrary one; the link names only the view and the page's Tenant picker chooses whose it shows.
  const systemItems = input.tables.filter(entry => object(entry.search).databaseSystemView).map(entry => ({ title: label(entry.title).replace(/^System · /u, ""), path: at("/database"), search: Object.fromEntries(Object.entries(object(entry.search)).filter(([key, value]) => key !== "databaseTenant" && typeof value === "string")) as Record<string, string> }));
  const workloadList = (kind: string) => (input.workloads[kind] ?? []).map(entry => ({ title: entry.name, path: at(`/workloads/${kind}/${encodeURIComponent(entry.id)}`) }));
  const native: MenuItem[] = [
    ...(available("identity") ? [{ title: "Auth", path: at("/auth") }] : []),
    ...(available("database") ? [{ title: "Database", path: at("/database"), items: [{ title: "Create Table", path: at("/database"), search: { databaseDialog: "create-table" } }, { title: "Tenants", path: at("/database/tenants") }, { title: "Cross-Tenant Indexes", path: at("/database/cross-tenant-indexes") }, { title: "Images", path: at("/database/images") }, ...tableItems, ...(pluginItems.length ? [{ title: "Plugin Tables", path: at("/database"), search: pluginItems[0].search, items: pluginItems }] : []), ...(systemItems.length ? [{ title: "System Tables", path: at("/database"), search: systemItems[0].search, items: systemItems }] : [])] }] : []),
    ...(available("storage") ? [{ title: "Storage", path: at("/storage") }] : []),
    ...(available("workloads") ? [{ title: "Workloads", path: at("/workloads"), items: [
      { title: "Functions", path: at("/workloads/functions"), items: [{ title: "Add Function", path: at("/workloads/new") }, ...workloadList("functions")] },
      { title: "Jobs", path: at("/workloads/jobs"), ...(workloadList("jobs").length ? { items: workloadList("jobs") } : {}) },
      { title: "Schedules", path: at("/workloads/schedules"), ...(workloadList("schedules").length ? { items: workloadList("schedules") } : {}) },
      { title: "Webhooks", path: at("/workloads/webhooks"), ...(workloadList("webhooks").length ? { items: workloadList("webhooks") } : {}) },
      { title: "Entities", path: at("/workloads/entities"), ...(workloadList("entities").length ? { items: workloadList("entities") } : {}) },
      { title: "Logs", path: at("/workloads/logs") }, { title: "Settings", path: at("/workloads/settings") }] }] : [])
  ];
  const contentItems: MenuItem[] = [{ title: "All Content Types", path: at("/content") }, { title: "Add Content Type", path: at("/content/new") },
    ...input.content.map(row => ({ title: row.label, path: at(`/content/${encodeURIComponent(row.name)}`), items: [{ title: "Entries", path: at(`/content/${encodeURIComponent(row.name)}`) }, { title: "Fields", path: at(`/content/${encodeURIComponent(row.name)}/fields`) }] }))];
  const nativeItems: MenuItem[] = [
    ...(available("identity") ? [{ title: "Users", path: at("/users"), access: projectAccess("project.users.manage") }] : []),
    ...(available("database") ? [{ title: "Content", path: at("/content"), items: contentItems, access: projectAccess("project.content.read") }] : []),
    ...(available("storage") ? [{ title: "Media", path: at("/media"), access: projectAccess("project.media.manage") }] : []),
    ...(native.length ? [{ title: "Backend", path: at("/backend"), items: native, access: projectAccess("project.backend.manage") }] : [])
  ];

  if (managed) {
    const admin = label(object(object(project.recipe).managed).adminTitle, "App Admin");
    return filterMenu([
      { title: "Overview", path: base }, { title: "Domains", path: at("/domains") }, { title: "Files", path: at("/files") }, { title: "App database", path: at("/app-database") }, { title: "Setup", path: at("/setup") },
      { title: "Backups", path: at("/backups") }, { title: "Logs", path: at("/logs") }, { title: "Updates", path: at("/updates") }, { title: admin, path: at("/admin") },
      ...nativeItems.filter(item => ["Users", "Content", "Media", "Backend"].includes(item.title)), ...services.flatMap(service => menusOf(service).filter(menu => surfaceOf(menu, service) !== "platform" && menu.path !== "/").map(menu => prefixed(fromMenu(menu, label(service.name, "")))))
    ], input.control.access, project.id);
  }
  const frontend = object(capabilities.site).available === true ? [{ title: "Frontend", path: at("/frontend"), access: projectAccess("project.website.manage") }] : [];
  return filterMenu([
    { title: "Overview", path: base, access: projectAccess("project.view") },
    ...nativeItems.filter(item => item.title !== "Backend"), ...frontend, ...bySurface("root"),
    { title: "Extensions", path: at("/extensions"), items: [{ title: "Agents", path: at("/agents") }, ...bySurface("extensions")], access: projectAccess("project.extensions.manage") },
    ...(native.length || bySurface("core").length ? [{ title: "Backend", path: at("/backend"), items: [...native, ...bySurface("core")], access: projectAccess("project.backend.manage") }] : []),
    { title: "Settings", path: at("/settings"), items: [{ title: "Project Settings", path: at("/settings") }, ...bySurface("settings")], access: projectAccess("project.settings.manage") }
  ], input.control.access, project.id);
}

/** Reads what the Project menu lists: its content types, tables and workloads. Each read that fails leaves its part out. */
export const loadProjectMenu = Effect.fn("ui.loadProjectMenu")(function*(control: Config, project: Project, runtime: Config) {
  const api = runtime.api.basePath;
  const capabilities = object(runtime.capabilities);
  const has = (name: string) => object(capabilities[name]).available === true;
  const soft = <A>(effect: Effect.Effect<A, unknown>, fallback: A) => effect.pipe(Effect.catch(() => Effect.succeed(fallback)));
  const [collections, schemas, settings, tables, workloads] = yield* Effect.all([
    has("database") ? soft(request(`${api}/database/documents/collections?tenantId=zelavis-app`), {}) : Effect.succeed({}),
    has("database") ? soft(request(`${api}/database/schemas/collections?tenantId=zelavis-app`), {}) : Effect.succeed({}),
    has("database") ? soft(request(`${api}/runtime/settings`), {}) : Effect.succeed({}),
    has("database") ? soft(request(`${api}/database/menu/tables`), {}) : Effect.succeed({}),
    has("workloads") ? soft(request(`${api}/workloads?projectId=${encodeURIComponent(project.id)}`), {}) : Effect.succeed({})
  ], { concurrency: 5 });
  const preferences = object(object(object(settings).preferences).content);
  const content = buildContentTypeRows(
    array(object(collections).collections).map(object).map(entry => ({ name: label(entry.name, ""), surface: typeof entry.surface === "string" ? entry.surface : undefined, documentCount: Number(entry.documentCount) || 0, tenantId: label(entry.tenantId, "zelavis-app") })),
    array(object(schemas).collections).map(object).map(entry => ({ collection: label(entry.collection, ""), activeVersion: typeof entry.activeVersion === "number" ? entry.activeVersion : null, versions: array(entry.versions).filter((value): value is number => typeof value === "number") })),
    { pinnedTypes: array(preferences.pinnedTypes).map(String), labels: Object.fromEntries(Object.entries(object(preferences.labels)).filter(([, value]) => typeof value === "string")) as Record<string, string> });
  const grouped: Record<string, { id: string; name: string }[]> = { functions: [], jobs: [], schedules: [], webhooks: [], entities: [] };
  const plural: Record<string, string> = { function: "functions", job: "jobs", schedule: "schedules", webhook: "webhooks", entity: "entities" };
  for (const entry of array(object(workloads).workloads).map(object)) grouped[plural[label(entry.type, "")] ?? "functions"]?.push({ id: label(entry.id, ""), name: label(entry.name) });
  return projectMenu({ control, project, runtime, content, tables: array(object(tables).items).map(object), workloads: grouped });
});

export const loadPlatformMenu = Effect.fn("ui.loadPlatformMenu")(function*(config: Config) {
  const namespaces = yield* request(`${config.api.basePath}/runtime/system-store/namespaces`).pipe(Effect.map(result => array(object(result).namespaces).map(object).map(entry => label(entry.namespace, ""))), Effect.catch(() => Effect.succeed([] as string[])));
  return platformMenu(config, namespaces);
});
