"use client";

import * as React from "react";
import { useLocation, useMatches, useNavigate } from "react-router";

import { NavMain } from "#/components/nav-main";
import {
  NavUser,
  NavUserScreen,
  type SidebarUtilityScreen,
} from "#/components/nav-user";
import { ProjectSwitcher } from "#/components/project-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "#/components/ui/sidebar";
import {
  buildContentTypeRows,
} from "#/lib/content-studio";
import {
  buildProjectManagementNavItems,
  buildManagedProjectNavItems,
  buildPlatformNavItems,
  dashboardProjects,
  filterDashboardNavItemsForAccess,
  getDashboardProjectsForAccess,
  platformNavItems,
} from "#/lib/dashboard-data";
import { filterUserDatabaseCollections } from "#/lib/database-collections";
import {
  getManagedProjectKindFromId,
  getProjectIdFromPathname,
  isProjectManagementPath,
  readSearchParams,
} from "#/lib/routing";
import { getDashboardSidebarTrailFromMatches } from "#/lib/dashboard-route-handles";
import { cn } from "#/lib/utils";
import {
  type DashboardSettings,
  getResolvedDashboardPreferences,
  type DatabaseCollection,
  type DatabaseSchemaCollectionSummary,
  type RuntimeConfig,
} from "#/lib/runtime-api";

export function AppSidebar({
  runtime,
  settings,
  databaseCollections,
  schemaCollections,
  mobileSlotContent,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  runtime?: RuntimeConfig;
  settings?: DashboardSettings;
  databaseCollections?: readonly DatabaseCollection[];
  schemaCollections?: readonly DatabaseSchemaCollectionSummary[];
  mobileSlotContent?: React.ReactNode;
}) {
  const location = useLocation();
  const matches = useMatches();
  const navigate = useNavigate();
  const [isProjectSwitcherOpen, setIsProjectSwitcherOpen] =
    React.useState(false);
  const [activeUtilityScreen, setActiveUtilityScreen] =
    React.useState<SidebarUtilityScreen | null>(null);
  const [utilityScreenOpenedFromNested, setUtilityScreenOpenedFromNested] =
    React.useState(false);
  const [homeResetKey, setHomeResetKey] = React.useState(0);
  const isSidebarPopoverOpen = isProjectSwitcherOpen;
  const sidebarChromeClassName = cn(
    "transition-[filter,opacity] duration-200 ease-out motion-reduce:transition-none",
    isSidebarPopoverOpen && "pointer-events-none blur-[2px] opacity-70",
  );
  const sidebarChromeInertProps = isSidebarPopoverOpen
    ? { inert: true }
    : undefined;
  const isProjectManagementRoute = isProjectManagementPath(location.pathname);
  const routeSidebarTrail = getDashboardSidebarTrailFromMatches(matches) ?? [];
  const currentSidebarSearch = readSearchParams(location.search).sidebar;
  const hasNestedSidebarContext =
    (typeof currentSidebarSearch === "string" &&
      currentSidebarSearch.length > 0) ||
    routeSidebarTrail.length > 0;
  const projectId = getProjectIdFromPathname(location.pathname);
  const isProjectDashboardRoute = Boolean(projectId) && !isProjectManagementRoute;
  const managedProjectKind = getManagedProjectKindFromId(projectId);
  const accessibleProjects = React.useMemo(
    () => getDashboardProjectsForAccess(dashboardProjects, runtime?.access),
    [runtime?.access],
  );
  const dashboardUser = React.useMemo(
    () => ({
      name: runtime?.access?.label
        ? `${runtime.access.label} dashboard`
        : "Runtime dashboard",
      email: runtime?.access?.principal.id ?? "local project",
      avatar: "",
    }),
    [runtime?.access],
  );
  const selectedDatabaseTable = React.useMemo(() => {
    const search = readSearchParams(location.search);
    return typeof search.databaseTable === "string" && search.databaseTable.length > 0
      ? search.databaseTable
      : undefined;
  }, [location.search]);
  const effectiveDatabaseCollections = React.useMemo(() => {
    const collections = [...(databaseCollections ?? [])];
    if (
      selectedDatabaseTable &&
      !collections.some((collection) => collection.name === selectedDatabaseTable)
    ) {
      collections.push({
        name: selectedDatabaseTable,
        tenantId: "default",
        createdAt: new Date().toISOString(),
        documentCount: 0,
        metadata: {
          surface: "database",
          kind: "table",
        },
      });
    }

    return collections;
  }, [databaseCollections, selectedDatabaseTable]);
  const contentTypes = React.useMemo(
    () =>
      buildContentTypeRows(
        filterUserDatabaseCollections(effectiveDatabaseCollections),
        schemaCollections ?? [],
        getResolvedDashboardPreferences(settings).content,
      ),
    [effectiveDatabaseCollections, schemaCollections, settings],
  );
  const items = React.useMemo(
    () =>
      isProjectManagementRoute
        ? filterDashboardNavItemsForAccess(
            buildProjectManagementNavItems(runtime?.services),
            runtime?.access,
          )
        : projectId && managedProjectKind
        ? buildManagedProjectNavItems(projectId, managedProjectKind)
        : runtime
        ? filterDashboardNavItemsForAccess(
            buildPlatformNavItems(
              runtime.services,
              runtime.serviceRegistry,
              contentTypes,
              filterUserDatabaseCollections(effectiveDatabaseCollections),
              projectId ?? "default",
            ),
            runtime.access,
          )
        : platformNavItems,
    [
      contentTypes,
      effectiveDatabaseCollections,
      isProjectManagementRoute,
      managedProjectKind,
      projectId,
      runtime?.access,
      runtime?.serviceRegistry,
      runtime?.services,
    ],
  );

  return (
    <Sidebar variant="inset" collapsible="icon" {...props}>
      <SidebarHeader
        className={sidebarChromeClassName}
        {...sidebarChromeInertProps}
      >
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <ProjectSwitcher
              projects={accessibleProjects}
              homeIconLinksToProjects={isProjectDashboardRoute}
              onOpenChange={setIsProjectSwitcherOpen}
            />
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent
        className={cn("overflow-hidden", sidebarChromeClassName)}
        {...sidebarChromeInertProps}
      >
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col",
            activeUtilityScreen && "hidden",
          )}
        >
          <NavMain
            homeResetKey={homeResetKey}
            items={items}
            mobileSlotContent={mobileSlotContent}
          />
        </div>
        {activeUtilityScreen ? (
          <NavUserScreen
            screen={activeUtilityScreen}
            openedFromNested={utilityScreenOpenedFromNested}
            user={dashboardUser}
            onClose={() => setActiveUtilityScreen(null)}
          />
        ) : null}
      </SidebarContent>
      <SidebarFooter
        className={cn(
          "transition-[filter,opacity] duration-200 ease-out motion-reduce:transition-none",
          isSidebarPopoverOpen && "pointer-events-none blur-[2px] opacity-70",
        )}
        {...sidebarChromeInertProps}
      >
        <NavUser
          activeScreen={activeUtilityScreen}
          user={dashboardUser}
          onHome={() => {
            setActiveUtilityScreen(null);
            setUtilityScreenOpenedFromNested(false);
            setHomeResetKey((key) => key + 1);
          }}
          onScreenChange={(screen) => {
            if (!activeUtilityScreen) {
              setUtilityScreenOpenedFromNested(hasNestedSidebarContext);
            }

            if (screen === "assistant" && location.pathname !== "/assistant") {
              navigate("/assistant", { viewTransition: true });
            }

            setActiveUtilityScreen(screen);
          }}
        />
      </SidebarFooter>
    </Sidebar>
  );
}
