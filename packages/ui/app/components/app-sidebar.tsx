"use client";

import * as React from "react";
import { useLocation } from "react-router";

import { NavMain } from "#/components/nav-main";
import { NavUser } from "#/components/nav-user";
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
  buildManagedProjectNavItems,
  buildPlatformNavItems,
  dashboardProjects,
  platformNavItems,
  projectManagementNavItems,
} from "#/lib/dashboard-data";
import { filterUserDatabaseCollections } from "#/lib/database-collections";
import {
  getManagedProjectKindFromId,
  getProjectIdFromPathname,
  isProjectManagementPath,
  readSearchParams,
} from "#/lib/routing";
import { cn } from "#/lib/utils";
import {
  type DashboardSettings,
  getResolvedDashboardPreferences,
  type DatabaseCollection,
  type DatabaseSchemaCollectionSummary,
  type RuntimeConfig,
} from "#/lib/runtime-api";

const data = {
  user: {
    name: "Runtime dashboard",
    email: "local workspace",
    avatar: "",
  },
};

export function AppSidebar({
  runtime,
  settings,
  databaseCollections,
  schemaCollections,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  runtime?: RuntimeConfig;
  settings?: DashboardSettings;
  databaseCollections?: readonly DatabaseCollection[];
  schemaCollections?: readonly DatabaseSchemaCollectionSummary[];
}) {
  const location = useLocation();
  const [openSidebarPopover, setOpenSidebarPopover] = React.useState<
    "project" | "user" | null
  >(null);
  const setSidebarPopoverOpen = React.useCallback(
    (popover: "project" | "user", open: boolean) => {
      setOpenSidebarPopover((current) => {
        if (open) {
          return popover;
        }

        return current === popover ? null : current;
      });
    },
    [],
  );
  const isSidebarPopoverOpen = openSidebarPopover !== null;
  const sidebarChromeClassName = cn(
    "transition-[filter,opacity] duration-200 ease-out motion-reduce:transition-none",
    isSidebarPopoverOpen && "pointer-events-none blur-[2px] opacity-70",
  );
  const sidebarChromeInertProps = isSidebarPopoverOpen
    ? { inert: true }
    : undefined;
  const isProjectManagementRoute = isProjectManagementPath(location.pathname);
  const projectId = getProjectIdFromPathname(location.pathname);
  const isProjectDashboardRoute = Boolean(projectId) && !isProjectManagementRoute;
  const managedProjectKind = getManagedProjectKindFromId(projectId);
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
        ? projectManagementNavItems
        : projectId && managedProjectKind
        ? buildManagedProjectNavItems(projectId, managedProjectKind)
        : runtime
        ? buildPlatformNavItems(
            runtime.services,
            runtime.serviceRegistry,
            contentTypes,
            filterUserDatabaseCollections(effectiveDatabaseCollections),
          )
        : platformNavItems,
    [
      contentTypes,
      effectiveDatabaseCollections,
      isProjectManagementRoute,
      managedProjectKind,
      projectId,
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
              projects={dashboardProjects}
              homeIconLinksToProjects={isProjectDashboardRoute}
              onOpenChange={(open) => setSidebarPopoverOpen("project", open)}
            />
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent
        className={cn("overflow-hidden", sidebarChromeClassName)}
        {...sidebarChromeInertProps}
      >
        <NavMain items={items} />
      </SidebarContent>
      <SidebarFooter
        className={sidebarChromeClassName}
        {...sidebarChromeInertProps}
      >
        <NavUser
          user={data.user}
          onOpenChange={(open) => setSidebarPopoverOpen("user", open)}
        />
      </SidebarFooter>
    </Sidebar>
  );
}
