import { dashboardRoutes } from "./dashboard-routes.ts";
import type { RouteDefinition } from "fuzor/runtime";
export type DashboardHandle = { pageLabel: string; sidebarTrail: readonly string[] };
const handle = (pageLabel: string, ...sidebarTrail: string[]): DashboardHandle => ({ pageLabel, sidebarTrail });
const declared = dashboardRoutes.map(path => ({ path, id: path === "/" ? "projects" : path.slice(1).replace(/[^a-z0-9]+/gi, "-") }));
export const clientRoutes: Record<string, string> = Object.fromEntries(declared.map(route => [route.path, route.path.startsWith("/projects/:projectId/") ? "/project-section/" : route.path === "/projects/:projectId" ? "/project/" : route.path.startsWith("/server/") ? "/server-section/" : route.path.startsWith("/settings/") ? "/settings/" : "/"]));
Object.assign(clientRoutes, { "/:section*": "/", "/projects/:projectId/:section*": "/project-section/", "/server/:section*": "/server-section/", "/settings/:section*": "/settings/" });
const routeHandle = (path: string): DashboardHandle => {
  if (path.startsWith("/projects/:projectId")) { const section = path.split("/")[3]; return handle(section ? section[0].toUpperCase() + section.slice(1) : "Project overview", "projects", "project", ...(section && !section.startsWith(":") ? [section] : [])); }
  if (path.startsWith("/server")) return handle(path.split("/")[2] ?? "Server", "server");
  if (path.startsWith("/settings")) return handle("Settings", "settings");
  return handle(path === "/" ? "Projects" : path.slice(1));
};
export const routeTree: readonly RouteDefinition[] = [{ id: "platform", path: "/", handle: handle("Projects"), children: [
  ...[...new Map(declared.map(route => [route.path, route])).values()].filter(route => route.path !== "/").map(route => ({ id: route.id, path: route.path, handle: routeHandle(route.path) })),
  { id: "project-section", path: "/projects/:projectId/:section*", handle: handle("Project", "projects", "project") },
  { id: "service-page", path: "/:section*", handle: handle("Service page") }
] }];

export const databaseRoutes = ["/projects/:projectId/database"];

/** Explicit domain routes carry projectId but have no dynamic :section parameter. */
export function dashboardSection(path: string, params: Readonly<Record<string, string | undefined>>): string | undefined {
  if (params.section !== undefined) return params.section;
  if (!params.projectId || !path.startsWith("/projects/")) return undefined;
  return path.split("/").slice(3).join("/") || undefined;
}
