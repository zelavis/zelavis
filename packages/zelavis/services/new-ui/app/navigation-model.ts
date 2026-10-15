import { servicePages } from "./service-pages.ts";
import { object, type Config, type Project } from "./api.ts";

export type Panel = { id: string; label: string; path: string; items: { label: string; path: string; branch?: string }[] };
export function panelsFor(projectId?: string, project?: Project, runtime?: Config, menu?: unknown, projectList: readonly Project[] = []): Panel[] {
  const root: Panel = { id: "platform", label: "Platform", path: "/", items: [
    { label: "Projects", path: "/", branch: "projects" }, { label: "Marketplace", path: "/marketplace" },
    { label: "Server", path: "/server", branch: "server" }, { label: "Assistant", path: "/assistant" }, { label: "Settings", path: "/settings", branch: "settings" }
  ] };
  const projects: Panel = { id: "projects", label: "Projects", path: "/", items: [{ label: "Overview", path: "/" }, { label: "Create project", path: "/projects/create" }] };
  const server: Panel = { id: "server", label: "Server", path: "/server", items: [{ label: "Overview", path: "/server" }, ...["Nodes", "Domains", "Database", "Backends", "Backups", "Logs"].map(label => ({ label, path: `/server/${label.toLowerCase()}` }))] };
  const settings: Panel = { id: "settings", label: "Settings", path: "/settings", items: [{ label: "Overview", path: "/settings" }] };
  for (const entry of projectList) projects.items.push({ label: entry.name, path: `/projects/${encodeURIComponent(entry.id)}`, branch: "project" });
  if (!projectId) {
    if (runtime) for (const page of servicePages(runtime)) {
      if (page.src && !root.items.some(item => item.path === page.path)) root.items.push({ label: page.title, path: page.path + (Object.keys(page.search).length ? `?${new URLSearchParams(page.search)}` : "") });
    }
    return [root, projects, server, settings];
  }
  const path = `/projects/${encodeURIComponent(projectId)}`;
  if (!projects.items.some(item => item.path === path)) projects.items.push({ label: project?.name ?? "Project", path, branch: "project" });
  const tabs = project ? ["Database", "Auth", "Content", "Storage", "Workloads"].filter(label => !object(project.recipe).managed || object(object(runtime?.capabilities)[label === "Content" ? "database" : label.toLowerCase()]).used === true) : [];
  const projectPanel: Panel = { id: "project", label: project?.name ?? "Project", path, items: [{ label: "Overview", path }, ...tabs.map(label => ({ label, path: `${path}/${label.toLowerCase()}`, branch: label.toLowerCase() })), { label: "Marketplace", path: `${path}/marketplace`, branch: "marketplace" }] };
  if (runtime) for (const page of servicePages(runtime, runtime.serviceRegistry, projectId)) {
    if (page.src && !projectPanel.items.some(item => item.path === page.path)) projectPanel.items.push({ label: page.title, path: page.path + (Object.keys(page.search).length ? `?${new URLSearchParams(page.search)}` : "") });
  }
  const domains: Panel[] = [...tabs, "Marketplace"].map(label => ({ id: label.toLowerCase(), label, path: `${path}/${label.toLowerCase()}`, items: [{ label: label === "Auth" ? "Users" : label === "Storage" ? "Files" : label === "Database" ? "Tables" : label === "Content" ? "Collections" : label === "Marketplace" ? "Project services" : "Overview", path: `${path}/${label.toLowerCase()}` }] }));
  const database = domains.find(panel => panel.id === "database");
  const groups: Panel[] = [];
  if (database && menu) {
    const system: Panel = { id: "system-tables", label: "System Tables", path: database.path, items: [] };
    for (const value of Array.isArray(object(menu).items) ? object(menu).items as unknown[] : []) {
      const entry = object(value);
      if (typeof entry.title !== "string") continue;
      const search = new URLSearchParams();
      for (const key of ["databaseTenant", "databaseTable", "databaseSystemView"]) { const value = object(entry.search)[key]; if (typeof value === "string") search.set(key, value); }
      const item = { label: entry.title, path: `${database.path}?${search}` };
      if (search.has("databaseSystemView")) system.items.push(item); else database.items.push(item);
    }
    if (system.items.length) { system.path = system.items[0].path; database.items.push({ label: "System Tables", path: system.path, branch: system.id }); groups.push(system); }
  }
  return [root, projects, projectPanel, ...domains, ...groups, server, settings];
}
export function resolveTrail(panels: readonly Panel[], fallback: readonly string[], explicit: string | null): Panel[] {
  const ids = explicit === null ? fallback : explicit.split("/").filter(Boolean);
  const trail = [panels[0]];
  for (const id of ids) {
    const panel = panels.find(panel => panel.id === id);
    if (!panel || !trail.at(-1)!.items.some(item => item.branch === id)) break;
    trail.push(panel);
  }
  return trail;
}


/** Use the same permission-filtered menu contributions as the current workspace. */
export function workspacePanels(base: readonly Panel[], values: unknown, projectId?: string): Panel[] {
  if (!Array.isArray(values)) return [...base];
  const root = { ...base[0], items: [...base[0].items] };
  const projects = base.find(panel => panel.id === "projects")!;
  const result: Panel[] = [root, projects, ...base.filter(panel => !["platform", "projects", "project"].includes(panel.id)).map(panel => ({ ...panel, items: [...panel.items] }))];
  const parent = projectId ? { ...base.find(panel => panel.id === "project")!, items: [] as Panel["items"] } : root;
  if (projectId) result.push(parent);
  const append = (panel: Panel, entries: unknown[], prefix: string) => {
    for (const raw of entries) {
      const entry = object(raw);
      if (typeof entry.title !== "string" || typeof entry.path !== "string" || !entry.path.startsWith("/") || entry.path.startsWith("//")) continue;
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(object(entry.search))) if (typeof value === "string") query.set(key, value);
      const path = entry.path + (query.size ? `?${query}` : "");
      const children = Array.isArray(entry.items) ? entry.items : [];
      const id = entry.path === "/server" ? "server" : `${prefix}-${entry.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const item = { label: entry.title, path, ...(children.length ? { branch: id } : {}) };
      const existing = panel.items.findIndex(value => value.label === item.label || value.path === item.path && !query.size);
      if (existing >= 0) { if (!children.length && panel.items[existing].branch) Object.assign(item, { branch: panel.items[existing].branch }); panel.items.splice(existing, 1, item); } else panel.items.push(item);
      if (children.length) { const child: Panel = { id, label: entry.title, path, items: [] }; const previous = result.findIndex(panel => panel.id === id); if (previous >= 0) result.splice(previous, 1, child); else result.push(child); append(child, children, id); }
    }
  };
  append(parent, values, projectId ? "project-menu" : "platform-menu");
  return result;
}

export function trailForLocation(panels: readonly Panel[], url: URL): string[] {
  let best: { score: number; ids: string[] } = { score: -1, ids: [] };
  const pathname = url.pathname.replace(/^\/zelavis(?=\/|$)/, "").replace(/\/+$/, "") || "/";
  const visit = (panel: Panel, ids: string[]) => {
    for (const item of panel.items) {
      const target = new URL(item.path, url.origin);
      const match = (target.pathname.replace(/\/+$/, "") || "/") === pathname && [...target.searchParams].every(([key, value]) => url.searchParams.get(key) === value);
      const trail = item.branch ? [...ids, item.branch] : ids;
      if (match && trail.length * 10 + target.searchParams.size > best.score) best = { score: trail.length * 10 + target.searchParams.size, ids: trail };
      if (item.branch) { const child = panels.find(value => value.id === item.branch); if (child && !ids.includes(child.id)) visit(child, trail); }
    }
  };
  visit(panels[0], []);
  return best.ids;
}
