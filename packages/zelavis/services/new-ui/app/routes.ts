import type { RouteDefinition } from "fuzor/runtime";
export type DashboardHandle = { pageLabel: string; sidebarTrail: readonly string[] };
const handle = (pageLabel: string, ...sidebarTrail: string[]): DashboardHandle => ({ pageLabel, sidebarTrail });
export const clientRoutes = { "/projects/:projectId": "/project/", "/projects/:projectId/:section*": "/project-section/", "/server/:section*": "/server-section/", "/settings/:section*": "/settings/" };
export const routeTree: readonly RouteDefinition[] = [{ id: "platform", path: "/", handle: handle("Projects"), children: [
  { id: "projects", path: "/projects", handle: handle("Projects", "projects"), children: [
    { id: "create-project", path: "/projects/create", handle: handle("Create project", "projects") },
    { id: "project", path: "/projects/:projectId", handle: handle("Project overview", "projects", "project"), children: [
      ...["database", "auth", "content", "storage", "workloads", "marketplace"].map(section => ({ id: `project-${section}`, path: `/projects/:projectId/${section}`, handle: handle(section[0].toUpperCase() + section.slice(1), "projects", "project", section), children: [{ id: `project-${section}-detail`, path: `/projects/:projectId/${section}/:detail*`, handle: handle(section[0].toUpperCase() + section.slice(1), "projects", "project", section) }] })),
      { id: "project-section", path: "/projects/:projectId/:section*", handle: handle("Project", "projects", "project") }
    ] }
  ] },
  { id: "server", path: "/server", handle: handle("Server overview", "server"), children: [{ id: "server-section", path: "/server/:section*", handle: handle("Server", "server") }] },
  { id: "settings", path: "/settings", handle: handle("Settings", "settings"), children: [{ id: "settings-section", path: "/settings/:section*", handle: handle("Settings", "settings") }] },
  ...["marketplace", "assistant", "setup", "login"].map(name => ({ id: name, path: `/${name}`, handle: handle(name[0].toUpperCase() + name.slice(1)) }))
] }];

export const databaseRoutes = ["/projects/:projectId/database", "/projects/:projectId/database/:detail*", "/projects/:projectId/content", "/projects/:projectId/content/:detail*"];
