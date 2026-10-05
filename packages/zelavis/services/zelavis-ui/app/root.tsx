import type * as React from "react";
import {
  data,
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
import { ProjectNotRunning } from "#/components/ProjectNotRunning";
import { DashboardShell } from "#/components/DashboardShell";
import { DirectionProvider } from "#/components/ui/direction";
import {
  beginNavigationRuntimeResolve,
  getAuthBootstrapStatus,
  getDashboardSettings,
  getDashboardAccess,
  getProjectRuntimeConfig,
  getRuntimeConfig,
  listDatabaseCollections,
  listDatabaseSchemaCollections,
  listAssistantThreads,
  listProjects,
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


export const SETUP_IN_PROGRESS_KEY = "zelavis.setup.in-progress";

function setupInProgress(): boolean {
  try {
    return window.sessionStorage.getItem(SETUP_IN_PROGRESS_KEY) === "1";
  } catch {
    return false;
  }
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const projectId = inferProjectIdFromRequestUrl(request.url);
  const requestUrl = new URL(request.url);
  const isLoginRoute = /\/login\/?$/u.test(requestUrl.pathname);
  const isSetupRoute = /\/setup\/?$/u.test(requestUrl.pathname);

  // Set up the deferred promise SYNCHRONOUSLY (before any await) so that
  // child loaders running in parallel can find and await it.
  const navigation = beginNavigationRuntimeResolve(projectId, request.signal);

  try {
    const controlRuntime = await getRuntimeConfig();
    const bootstrapStatus = await getAuthBootstrapStatus(controlRuntime);
    if (bootstrapStatus.required && !isSetupRoute) {
      throw redirect("/setup");
    }
    // Creating the owner is what ends "required", and the wizard still has its
    // Edge step to show. Only the tab that just claimed the Platform may stay on
    // /setup; every other visit to it is closed.
    if (!bootstrapStatus.required && isSetupRoute && !setupInProgress()) {
      throw redirect("/");
    }
    if (isLoginRoute || isSetupRoute) {
      navigation.commit(controlRuntime);
      const settings = await getDashboardSettings(controlRuntime);
      return {
        controlRuntime,
        runtime: controlRuntime,
        bootstrapStatus,
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
      // `data()`, not `new Response`: this is handed to every loader waiting on the
      // Project's runtime, and a thrown Response body can be read only once, so the
      // second reader failed with "body stream already read" and the operator saw a
      // "Dashboard error" instead of the reason.
      const error = data(`Project "${projectId}" was not found.`, { status: 404 });
      throw error;
    }
    if (selectedProject && selectedProject.runtime.status !== "running") {
      const error = data(`Project "${selectedProject.id}" is not running.`, {
        status: 409,
      });
      throw error;
    }
    let runtimeConfig = controlRuntime;
    if (selectedProject) {
      runtimeConfig = await getProjectRuntimeConfig(controlRuntime, selectedProject.id);
    }

    // Resolve the deferred so child loaders waiting on getActiveRuntimeConfig
    // proceed with the correctly-scoped config.
    navigation.commit(runtimeConfig, selectedProject);

    const runtime = await resolveRuntimeDynamicMenus(runtimeConfig);
    const hasDatabaseService = runtime.capabilities?.database?.available === true &&
      (!selectedProject?.recipe.managed || runtime.capabilities.database.used === true);
    const [settings, databaseCollections, schemaCollections] = await Promise.all([
      getDashboardSettings(runtime),
      hasDatabaseService
        ? listDatabaseCollections(runtime, ZELAVIS_APP_ADMIN_TENANT_ID)
        : [],
      hasDatabaseService ? listDatabaseSchemaCollections(runtime, ZELAVIS_APP_ADMIN_TENANT_ID) : [],
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
      bootstrapStatus,
    };
  } catch (error) {
    navigation.reject(error);
    throw error;
  }
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

  if (isRouteErrorResponse(error) && error.status === 409) {
    return (
      <DashboardShell>
        <ProjectNotRunning message={typeof error.data === "string" ? error.data : undefined} />
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
