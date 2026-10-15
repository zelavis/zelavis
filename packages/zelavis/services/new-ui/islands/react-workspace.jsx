/** @jsxRuntime classic */
import React from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider, Outlet, Link, useLoaderData, useActionData, useParams, useRouteError, useLocation, isRouteErrorResponse } from "react-router";
import { Effect } from "effect";
import { clientLoader as rootLoader } from "../../zelavis-ui/app/root.tsx";
import { DirectionProvider } from "../../zelavis-ui/app/components/ui/direction.tsx";
import { TooltipProvider } from "../../zelavis-ui/app/components/ui/tooltip.tsx";
import { UpdateBanner } from "../../zelavis-ui/app/components/update-banner.tsx";
import { workspaceRouteManifest } from "../app/workspace-route-manifest.ts";
import { workspaceFlag, workspacePath } from "../app/workspace-island.ts";
import { clearDraftJournals } from "../app/grids/drafts.ts";

import { buildProjectManagementNavItems, buildManagedProjectNavItems, buildPlatformNavItems, filterDashboardNavItemsForAccess } from "../../zelavis-ui/app/lib/dashboard-data.ts";
import { buildContentTypeRows } from "../../zelavis-ui/app/lib/content-studio.ts";
import { filterUserDatabaseCollections } from "../../zelavis-ui/app/lib/database-collections.ts";
import { getResolvedDashboardPreferences } from "../../zelavis-ui/app/lib/runtime-api.ts";
import { getRuntimeConfig, getProjectSetup, getProjectSetupReveals } from "../../zelavis-ui/app/lib/runtime-api.ts";

function WorkspaceRoot() {
  const data = useLoaderData();
  const { pathname } = useLocation();
  React.useEffect(() => {
    if (!data?.runtime || pathname === "/setup" || pathname === "/login") return;
    const projectId = pathname.match(/^\/projects\/([^/]+)/)?.[1];
    const id = projectId ? decodeURIComponent(projectId) : undefined;
    const project = data.projects.find(item => item.id === id);
    const content = buildContentTypeRows(filterUserDatabaseCollections(data.databaseCollections), data.schemaCollections, getResolvedDashboardPreferences(data.settings).content);
    const items = filterDashboardNavItemsForAccess(id
      ? project?.recipe?.managed ? buildManagedProjectNavItems(id, project.recipe.managed, data.runtime.services, data.runtime.capabilities, content, data.databaseMenuItems) : buildPlatformNavItems(data.runtime.services, data.runtime.serviceRegistry, content, data.databaseMenuItems, id, data.runtime.capabilities)
      : buildProjectManagementNavItems(data.runtime.services, data.systemStoreNamespaces), data.runtime.access);
    const plain = entries => entries.map(item => ({ title: item.title, path: item.landingUrl ?? item.url, search: item.search, items: item.items ? plain(item.items) : undefined }));
    parent.postMessage({ type: "newui:workspace-context", projectId: id, items: plain(items), projects: data.projects, runtime: data.runtime }, location.origin);
  }, [data, pathname]);
  const auth = pathname === "/login" || pathname === "/setup";
  const projects = pathname === "/" || pathname === "/projects";
  return <DirectionProvider direction="ltr"><TooltipProvider>
    {!auth && data?.settings?.restartRequired ? <div role="status" className="mb-4 rounded-md border p-3">Restart required to apply saved runtime settings. <Link to="/settings">Review settings</Link></div> : null}
    {!auth ? <UpdateBanner runtime={data?.controlRuntime} /> : null}
    <div className={projects ? "workspace-projects" : undefined}><Outlet /></div>
  </TooltipProvider></DirectionProvider>;
}
import { DashboardNotFound } from "../../zelavis-ui/app/components/DashboardNotFound.tsx";
import { ProjectNotRunning } from "../../zelavis-ui/app/components/ProjectNotRunning.tsx";
import { applyThemeMode, getStoredThemeMode } from "../../zelavis-ui/app/lib/theme.ts";
const modules = import.meta.glob("../../zelavis-ui/app/routes/*.tsx");
const transport = (work, signal) => Effect.runPromise(Effect.tryPromise({ try: work, catch: cause => cause }), { signal });
function RouteError() { const error = useRouteError(); if (isRouteErrorResponse(error) && error.status === 404) return <DashboardNotFound />; if (isRouteErrorResponse(error) && error.status === 409) return <ProjectNotRunning message={String(error.data)} />; return <div role="alert">{error instanceof Error ? error.message : typeof error === "object" && error && "data" in error ? String(error.data) : "Could not open this workspace."}</div>; }
function route(entry) {
  const result = {
    id: entry.file.replace(/\.tsx$/, ""), ...(entry.index ? { index: true } : { path: entry.path }),
    lazy: () => transport(async () => {
      const mod = await modules[`../../zelavis-ui/app/${entry.file}`]();
      const Component = mod.default;
      const Loaded = () => <Component loaderData={useLoaderData()} actionData={useActionData()} params={useParams()} />;
      const Boundary = mod.ErrorBoundary ? () => <mod.ErrorBoundary error={useRouteError()} /> : RouteError;
      return { ...(Component ? { Component: Loaded } : {}), ErrorBoundary: Boundary, handle: mod.handle,
        ...(mod.clientLoader ? { loader: (args) => transport(() => {
          if (entry.file === "routes/project.managed.$managedSection.tsx" && args.params.managedSection === "setup") {
            return transport(async () => {
              const runtime = await getRuntimeConfig();
              const reveals = await getProjectSetupReveals(runtime, args.params.projectId).catch(() => []);
              try { return { setup: { runtime, reveals, values: await getProjectSetup(runtime, args.params.projectId) } }; }
              catch (error) { return { setup: { runtime, reveals, values: [], error: error instanceof Error ? error.message : String(error) } }; }
            }, args.request.signal);
          }
          if (entry.file === "routes/api.relations.$collection.tsx") {
            const projectId = location.pathname.match(/\/projects\/([^/]+)/)?.[1];
            if (!projectId) throw new Error("A relation picker needs an explicit Project.");
            const scoped = new URL(args.request.url); scoped.pathname = `/projects/${projectId}${scoped.pathname}`;
            return mod.clientLoader({ ...args, request: new Request(scoped, args.request) });
          }
          return mod.clientLoader(args);
        }, args.request.signal) } : {}),
        ...(mod.clientAction ? { action: (args) => transport(() => mod.clientAction(args), args.request.signal) } : {}),
        ...(mod.shouldRevalidate ? { shouldRevalidate: mod.shouldRevalidate } : {}) };
    }),
  };
  if (entry.children) result.children = entry.children.map(child => route(child));
  return result;
}
export function mount(host) {
  const path = workspacePath(new URL(location.href));
  const loadRoot = args => {
    const url = new URL(args.request.url);
    // The original loader recognizes /setup by suffix; a Project's hosting
    // setup page must still resolve its Project rather than the owner wizard.
    if (/^\/projects\/[^/]+\/setup\/?$/.test(url.pathname.replace(/^\/zelavis(?=\/|$)/, ""))) {
      url.pathname = url.pathname.replace(/\/setup\/?$/, "");
      return rootLoader({ ...args, request: new Request(url, args.request) });
    }
    return rootLoader(args);
  };
  const router = createMemoryRouter([{ id: "root", path: "/", loader: args => transport(() => loadRoot(args), args.request.signal), shouldRevalidate: () => true, Component: WorkspaceRoot, ErrorBoundary: RouteError, HydrateFallback: () => <div role="status">Loading workspace…</div>, children: workspaceRouteManifest.map(entry => route(entry)) }], { basename: "/zelavis", initialEntries: [`/zelavis${path}`] });
  const root = createRoot(host);
  host.className = "react-feature-workspace";
  let previous = path, reflecting;
  const canonical = (state) => workspacePath(new URL(state.location.pathname + state.location.search + state.location.hash, location.origin));
  const unsubscribe = router.subscribe(state => {
    if (!state.initialized || state.navigation.state !== "idle") return;
    host.dataset.workspaceReady = "true";
    host.dataset.workspaceRoute = canonical(state);
    const next = canonical(state);
    if (next === previous) return;
    previous = next;
    const local = new URL(`/zelavis${next === "/" ? "/" : next}`, location.origin); local.searchParams.set(workspaceFlag, "1");
    history.replaceState(null, "", local.pathname + local.search + local.hash);
    if (next === reflecting) { reflecting = undefined; return; }
    if (next.startsWith("/login")) Effect.runFork(clearDraftJournals(() => sessionStorage).pipe(Effect.catch(cause => Effect.logWarning("Could not clear workspace journals", cause))));
    parent.postMessage({ type: "newui:workspace-navigation", path: next, replace: state.historyAction === "REPLACE" }, location.origin);
  });
  const receive = (event) => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.type !== "newui:workspace-url") return;
    const next = event.data.path;
    if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next === previous) return;
    reflecting = next;
    Effect.runFork(Effect.tryPromise({ try: () => router.navigate(next, { replace: true }), catch: cause => cause }).pipe(Effect.catch(cause => Effect.logWarning("Could not restore workspace URL", cause))));
  };
  window.addEventListener("message", receive);
  // Touch events stop at a document boundary; mirror the shell's right swipe.
  let touchStart;
  const start = event => { const touch = event.touches[0]; touchStart = touch && { x: touch.clientX, y: touch.clientY }; };
  const end = event => { const touch = event.changedTouches[0]; if (touchStart && touch && matchMedia("(max-width: 1023px)").matches && touch.clientX - touchStart.x > 80 && touch.clientX - touchStart.x > Math.abs(touch.clientY - touchStart.y) * 1.5) parent.postMessage({ type: "newui:workspace-menu" }, location.origin); touchStart = undefined; };
  window.addEventListener("touchstart", start, { passive: true }); window.addEventListener("touchend", end, { passive: true });
  applyThemeMode(getStoredThemeMode());
  root.render(<RouterProvider router={router} />);
  return () => { unsubscribe(); window.removeEventListener("message", receive); window.removeEventListener("touchstart", start); window.removeEventListener("touchend", end); router.dispose(); root.unmount(); };
}
