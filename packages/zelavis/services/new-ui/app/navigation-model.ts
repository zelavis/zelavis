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
  if (!projectId) return [root, projects, server, settings];
  const path = `/projects/${encodeURIComponent(projectId)}`;
  if (!projects.items.some(item => item.path === path)) projects.items.push({ label: project?.name ?? "Project", path, branch: "project" });
  const tabs = project ? ["Database", "Auth", "Content", "Storage", "Workloads"].filter(label => !object(project.recipe).managed || object(object(runtime?.capabilities)[label === "Content" ? "database" : label.toLowerCase()]).used === true) : [];
  const projectPanel: Panel = { id: "project", label: project?.name ?? "Project", path, items: [{ label: "Overview", path }, ...tabs.map(label => ({ label, path: `${path}/${label.toLowerCase()}`, branch: label.toLowerCase() })), { label: "Marketplace", path: `${path}/marketplace`, branch: "marketplace" }] };
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

