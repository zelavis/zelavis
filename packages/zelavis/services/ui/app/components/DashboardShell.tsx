import * as React from "react";
import { Plus, Search } from "lucide-react";
import { Link, useLocation, useMatches } from "react-router";

import { AppSidebar } from "#/components/app-sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "#/components/ui/breadcrumb";
import { Button } from "#/components/ui/button";
import { useDirection } from "#/components/ui/direction";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "#/components/ui/input-group";
import { Kbd } from "#/components/ui/kbd";
import { Separator } from "#/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "#/components/ui/sidebar";
import { TooltipProvider } from "#/components/ui/tooltip";
import { useIsMobile } from "#/hooks/use-mobile";
import {
  getDashboardPageLabelFromMatches,
  getDashboardSidebarTrailFromMatches,
} from "#/lib/dashboard-route-handles";
import type {
  DashboardSettings,
  DatabaseCollection,
  DatabaseSchemaCollectionSummary,
  RuntimeConfig,
  RuntimeAssistantThread,
  RuntimeProject,
  RuntimeProjectDriverInfo,
} from "#/lib/runtime-api";
import {
  DATABASE_COLLECTION_CREATED_EVENT,
} from "#/lib/runtime-api";
import { toProjectPath } from "#/lib/routing";
import {
  parseAsString,
  useTypedSearchParams,
} from "#/lib/use-typed-search-params";

export type DashboardShellData = {
  controlRuntime: RuntimeConfig;
  runtime: RuntimeConfig;
  settings: DashboardSettings;
  databaseCollections: readonly DatabaseCollection[];
  schemaCollections: readonly DatabaseSchemaCollectionSummary[];
  projects: readonly RuntimeProject[];
  projectRuntime?: RuntimeProjectDriverInfo;
  assistantThreads: readonly RuntimeAssistantThread[];
  assistantResponder: string;
};

function mergeDatabaseCollections(
  left: readonly DatabaseCollection[],
  right: readonly DatabaseCollection[],
) {
  const collectionsByKey = new Map(
    left.map((item) => [`${item.tenantId}:${item.name}`, item]),
  );

  for (const collection of right) {
    collectionsByKey.set(`${collection.tenantId}:${collection.name}`, collection);
  }

  return [...collectionsByKey.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

const projectHeaderSearchSchema = {
  q: parseAsString.withDefault(""),
  new: parseAsString.withDefault(""),
} as const;

function UtilityHeader({ runtime }: { runtime?: RuntimeConfig }) {
  const { pathname } = useLocation();
  const matches = useMatches();
  const [{ q }, setParams] = useTypedSearchParams(projectHeaderSearchSchema);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const isProjectsOverview = pathname === "/" || pathname === "/projects";
  const canCreateProjects =
    runtime?.access?.principal.permissions?.includes("*") ?? true;

  const pageLabel = getDashboardPageLabelFromMatches(matches);
  const sidebarTrail = getDashboardSidebarTrailFromMatches(matches);

  React.useEffect(() => {
    if (!isProjectsOverview) return;

    function focusProjectSearch(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "f"
      ) {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest(
            "input, textarea, select, [contenteditable='true'], [role='textbox']",
          ))
      ) {
        return;
      }

      event.preventDefault();
      searchInputRef.current?.focus();
    }

    window.addEventListener("keydown", focusProjectSearch);
    return () => window.removeEventListener("keydown", focusProjectSearch);
  }, [isProjectsOverview]);

  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mr-2 data-[orientation=vertical]:h-4"
        />
        {isProjectsOverview ? (
          <>
            <Breadcrumb className="mr-auto hidden sm:block">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage>Projects</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <InputGroup className="max-w-xs flex-1 sm:max-w-sm">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                ref={searchInputRef}
                type="search"
                value={q}
                onChange={(event) =>
                  setParams({ q: event.target.value || null })
                }
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.currentTarget.blur();
                  }
                }}
                placeholder="Search projects"
                aria-label="Search projects"
                autoComplete="off"
              />
              <InputGroupAddon align="inline-end">
                <Kbd className="group-focus-within/input-group:hidden">F</Kbd>
                <Kbd className="hidden group-focus-within/input-group:inline-flex">
                  Esc
                </Kbd>
              </InputGroupAddon>
            </InputGroup>
            {canCreateProjects ? (
              <Button
                type="button"
                onClick={() => setParams({ new: "1" }, { replace: false })}
              >
                <Plus data-icon="inline-start" />
                New project
              </Button>
            ) : null}
          </>
        ) : (
          <Breadcrumb>
            <BreadcrumbList>
              {sidebarTrail?.map((trailItem, index) => (
                <React.Fragment key={`${trailItem}-${index}`}>
                  <BreadcrumbItem className="hidden md:block">
                    <BreadcrumbLink href="#">{trailItem}</BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden md:block" />
                </React.Fragment>
              ))}
              {pageLabel ? (
                <BreadcrumbItem>
                  <BreadcrumbPage>{pageLabel}</BreadcrumbPage>
                </BreadcrumbItem>
              ) : null}
            </BreadcrumbList>
          </Breadcrumb>
        )}
      </div>
    </header>
  );
}

function RestartRequiredBanner({
  settings,
}: {
  settings?: DashboardSettings;
}) {
  if (!settings?.restartRequired) {
    return null;
  }

  return (
    <div
      role="status"
      className="rounded-md border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span>
          Restart required to apply pending root path{" "}
          {settings.pendingRootPath}.
        </span>
        <Link
          to="/settings"
          className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
        >
          Review settings
        </Link>
      </div>
    </div>
  );
}

export function DashboardShell({
  children,
  dashboardData,
}: {
  children: React.ReactNode;
  dashboardData?: DashboardShellData;
}) {
  const { pathname } = useLocation();
  const direction = useDirection();
  const isMobile = useIsMobile();
  const [activeDashboardData, setActiveDashboardData] = React.useState(dashboardData);
  const isLoginRoute = pathname === "/login" || pathname === "/login/";

  React.useEffect(() => {
    document.documentElement.dataset.zelavisHydrated = "true";

    return () => {
      delete document.documentElement.dataset.zelavisHydrated;
    };
  }, []);

  React.useEffect(() => {
    setActiveDashboardData(dashboardData);
  }, [dashboardData]);

  React.useEffect(() => {
    function applyCreatedCollection(event: Event) {
      if (!(event instanceof CustomEvent) || !event.detail) {
        return;
      }

      const collection = event.detail as DatabaseCollection;
      setActiveDashboardData((current) => {
        if (!current) {
          return current;
        }

        const nextDatabaseCollections = mergeDatabaseCollections(
          current.databaseCollections,
          [collection],
        );

        const nextServices = current.runtime?.services?.map((service) => {
          if (service.name !== "database" || !service.menu) {
            return service;
          }

          const existingItems = service.menu.items ?? [];
          const hasExisting = existingItems.some(
            (item) => item.search?.databaseTable === collection.name,
          );

          if (hasExisting) {
            return service;
          }

          const newTableItem = {
            title: collection.name,
            path: "/database",
            pageLabel: "Database",
            search: { databaseTable: collection.name },
          };

          const nonDisabledItems = existingItems.filter(
            (item) => item.title !== service.menu?.dynamicItems?.emptyTitle && !item.disabled,
          );

          return {
            ...service,
            menu: {
              ...service.menu,
              items: [...nonDisabledItems, newTableItem],
            },
          };
        });

        return {
          ...current,
          runtime: nextServices
            ? { ...current.runtime, services: nextServices }
            : current.runtime,
          databaseCollections: nextDatabaseCollections,
        };
      });
    }

    window.addEventListener(
      DATABASE_COLLECTION_CREATED_EVENT,
      applyCreatedCollection,
    );

    return () => {
      window.removeEventListener(
        DATABASE_COLLECTION_CREATED_EVENT,
        applyCreatedCollection,
      );
    };
  }, []);

  if (isLoginRoute) {
    return (
      <TooltipProvider>
        <div className="h-svh w-full overflow-y-auto bg-background">
          {children}
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <SidebarProvider className="h-svh overflow-hidden">
        <AppSidebar
          runtime={activeDashboardData?.runtime}
          assistantConfig={activeDashboardData?.controlRuntime}
          settings={activeDashboardData?.settings}
          databaseCollections={activeDashboardData?.databaseCollections}
          schemaCollections={activeDashboardData?.schemaCollections}
          projects={activeDashboardData?.projects}
          assistantThreads={activeDashboardData?.assistantThreads}
          mobileSlotContent={isMobile ? children : undefined}
          side={direction === "rtl" ? "right" : "left"}
          aria-label="Dashboard navigation"
          role="navigation"
        />
        {!isMobile ? (
          <SidebarInset className="hidden min-h-0 min-w-0 overflow-hidden lg:flex">
            <UtilityHeader runtime={activeDashboardData?.runtime} />
            <div
              data-dashboard-scroll="content"
              className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
            >
              <div
                className="dashboard-view-transition flex min-h-full min-w-0 flex-col gap-4 p-4"
              >
                <RestartRequiredBanner settings={activeDashboardData?.settings} />
                {children}
              </div>
            </div>
          </SidebarInset>
        ) : null}
      </SidebarProvider>
    </TooltipProvider>
  );
}
