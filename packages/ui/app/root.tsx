import type * as React from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
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
} from "#/lib/runtime-api";
import type { Route } from "./+types/root";
import type { RuntimeDashboardAccess } from "#/lib/runtime-api";
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

function resolveDemoDashboardAccess(requestUrl: string): RuntimeDashboardAccess {
  const mode = new URL(requestUrl).searchParams.get("as");
  const projectId = inferProjectIdFromRequestUrl(requestUrl);

  if (mode === "customer") {
    return {
      mode: "customer",
      label: "Customer",
      principal: {
        id: "customer_demo",
        type: "user",
        roles: ["customer"],
        grants: [
          {
            permission: "projects.list",
            scope: { type: "system" },
          },
          ...(projectId
            ? ([
                {
                  permission: "project.view",
                  scope: { type: "project", projectId },
                },
                {
                  permission: "project.content.read",
                  scope: { type: "project", projectId },
                },
                {
                  permission: "project.website.manage",
                  scope: { type: "project", projectId },
                },
              ] as const)
            : []),
        ],
      },
      projects: projectId
        ? [
            {
              id: projectId,
              permissions: [
                "project.view",
                "project.content.read",
                "project.website.manage",
              ],
            },
          ]
        : [],
    };
  }

  return {
    mode: "owner",
    label: "Owner",
    principal: {
      id: "owner_demo",
      type: "user",
      roles: ["owner"],
      permissions: ["*"],
    },
  };
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const projectId = inferProjectIdFromRequestUrl(request.url);

  // Set up the deferred promise SYNCHRONOUSLY (before any await) so that
  // child loaders running in parallel can find and await it.
  beginNavigationRuntimeResolve(projectId);

  const controlRuntime = await getRuntimeConfig();
  const accessMode = new URL(request.url).searchParams.get("as") ?? undefined;
  const [access, projectResult, assistantResult] = await Promise.all([
    getDashboardAccess(controlRuntime, accessMode).catch(() =>
      resolveDemoDashboardAccess(request.url),
    ),
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
  const [settings, databaseCollections, schemaCollections] = await Promise.all([
    getDashboardSettings(runtime),
    listDatabaseCollections(runtime),
    listDatabaseSchemaCollections(runtime),
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
      <body className="h-svh overflow-hidden font-sans antialiased [overflow-wrap:anywhere] selection:bg-accent">
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
