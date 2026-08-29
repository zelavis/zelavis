import type * as React from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  redirect,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "react-router";

import { DashboardNotFound } from "#/components/DashboardNotFound";
import { DashboardShell } from "#/components/DashboardShell";
import { DirectionProvider } from "#/components/ui/direction";
import {
  beginNavigationRuntimeResolve,
  commitNavigationRuntime,
  getDashboardSettings,
  getDashboardAccess,
  getProjectRuntimeConfig,
  getRuntimeConfig,
  listDatabaseCollections,
  listDatabaseSchemaCollections,
  listAssistantThreads,
  listProjects,
  rejectNavigationRuntime,
  resolveRuntimeDynamicMenus,
  RuntimeApiError,
  ZELAVIS_APP_ADMIN_TENANT_ID,
} from "#/lib/runtime-api";
import { stripRouterBasename } from "#/lib/router-basename";
import type { Route } from "./+types/root";
import "@glideapps/glide-data-grid/dist/index.css";
import "./styles.css";

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;
const DEFAULT_DIRECTION = "ltr";

export function meta() {
  return [{ title: "Zelavis Dashboard" }];
}

function inferProjectIdFromRequestUrl(requestUrl: string) {
  const pathname = new URL(requestUrl).pathname;
  const match = pathname.match(/(?:^|\/)projects\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function hasRuntimeService(
  runtime: { services?: readonly { name: string }[] },
  serviceName: string,
) {
  return runtime.services?.some((service) => service.name === serviceName) ?? false;
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const projectId = inferProjectIdFromRequestUrl(request.url);
  const requestUrl = new URL(request.url);
  const isLoginRoute = /\/login\/?$/u.test(requestUrl.pathname);

  // Set up the deferred promise SYNCHRONOUSLY (before any await) so that
  // child loaders running in parallel can find and await it.
  beginNavigationRuntimeResolve(projectId);

  const controlRuntime = await getRuntimeConfig();
  if (isLoginRoute) {
    commitNavigationRuntime(controlRuntime);
    const settings = await getDashboardSettings(controlRuntime);
    return {
      controlRuntime,
      runtime: controlRuntime,
      settings,
      databaseCollections: [],
      schemaCollections: [],
      projects: [],
      projectRuntime: undefined,
      assistantThreads: [],
      assistantResponder: "unavailable",
    };
  }

  let access: Awaited<ReturnType<typeof getDashboardAccess>>;
  try {
    access = await getDashboardAccess(controlRuntime);
  } catch (error) {
    if (error instanceof RuntimeApiError && error.status === 401) {
      // `requestUrl.pathname` is the browser path and includes the router
      // basename, but the login form resolves `returnTo` through `navigate()`,
      // which prepends the basename itself. Store a router-relative path so a
      // mounted dashboard does not redirect to `/zelavis/zelavis/`.
      throw redirect(
        `/login?returnTo=${encodeURIComponent(
          `${stripRouterBasename(requestUrl.pathname)}${requestUrl.search}`,
        )}`,
      );
    }
    throw error;
  }

  const [projectResult, assistantResult] = await Promise.all([
    listProjects(controlRuntime).catch(() => ({ runtime: undefined, projects: [] })),
    listAssistantThreads(controlRuntime).catch(() => ({
      responder: "unavailable",
      threads: [],
    })),
  ]);
  const selectedProject = projectId
    ? projectResult.projects.find((project) => project.id === projectId)
    : undefined;
  if (projectId && !selectedProject) {
    const error = new Response(`Project "${projectId}" was not found.`, { status: 404 });
    rejectNavigationRuntime(error);
    throw error;
  }
  if (selectedProject && selectedProject.runtime.status !== "running") {
    const error = new Response(`Project "${selectedProject.id}" is not running.`, {
      status: 409,
    });
    rejectNavigationRuntime(error);
    throw error;
  }
  let runtimeConfig = controlRuntime;
  if (selectedProject) {
    try {
      runtimeConfig = await getProjectRuntimeConfig(controlRuntime, selectedProject.id);
    } catch (error) {
      rejectNavigationRuntime(error);
      throw error;
    }
  }

  // Resolve the deferred so child loaders waiting on getActiveRuntimeConfig
  // proceed with the correctly-scoped config.
  commitNavigationRuntime(runtimeConfig);

  const runtime = await resolveRuntimeDynamicMenus(runtimeConfig);
  const hasDatabaseService = hasRuntimeService(runtime, "@zelavis/db");
  const [settings, databaseCollections, schemaCollections] = await Promise.all([
    getDashboardSettings(runtime),
    hasDatabaseService
      ? listDatabaseCollections(runtime, ZELAVIS_APP_ADMIN_TENANT_ID)
      : [],
    hasDatabaseService ? listDatabaseSchemaCollections(runtime) : [],
  ]);

  return {
    controlRuntime,
    runtime: {
      ...runtime,
      access,
    },
    settings,
    databaseCollections,
    schemaCollections,
    projects: projectResult.projects,
    projectRuntime: projectResult.runtime,
    assistantThreads: assistantResult.threads,
    assistantResponder: assistantResult.responder,
  };
}

clientLoader.hydrate = true as const;

export function HydrateFallback() {
  return (
    <main className="grid h-svh place-items-center bg-background text-foreground">
      <div role="status" className="grid place-items-center gap-3">
        <span
          aria-hidden="true"
          className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary"
        />
        <span className="sr-only">Loading Zelavis dashboard</span>
      </div>
    </main>
  );
}

export function shouldRevalidate() {
  return true;
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir={DEFAULT_DIRECTION} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body
        suppressHydrationWarning
        className="h-svh overflow-hidden font-sans antialiased [overflow-wrap:anywhere] selection:bg-accent"
      >
        <DirectionProvider direction={DEFAULT_DIRECTION}>
          {children}
        </DirectionProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const loaderData = useLoaderData<typeof clientLoader>();

  return (
    <DashboardShell dashboardData={loaderData}>
      <Outlet />
    </DashboardShell>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <DashboardShell>
        <DashboardNotFound />
      </DashboardShell>
    );
  }

  const details =
    import.meta.env.DEV && error instanceof Error
      ? error.message
      : "An unexpected dashboard error occurred.";

  return (
    <DashboardShell>
      <section className="mx-auto grid w-full max-w-7xl gap-4">
        <h1 className="text-2xl font-semibold">Dashboard error</h1>
        <p className="text-sm text-muted-foreground">{details}</p>
      </section>
    </DashboardShell>
  );
}
