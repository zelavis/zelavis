import * as React from "react";
import { Link, useLocation, useMatches } from "react-router";

import { AppSidebar } from "#/components/app-sidebar";
import Footer from "#/components/Footer";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "#/components/ui/breadcrumb";
import { useDirection } from "#/components/ui/direction";
import { Separator } from "#/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "#/components/ui/sidebar";
import { TooltipProvider } from "#/components/ui/tooltip";
import { getDashboardPageLabelFromMatches } from "#/lib/dashboard-route-handles";
import { getDashboardPageLabel } from "#/lib/dashboard-data";
import type {
  DashboardSettings,
  DatabaseCollection,
  DatabaseSchemaCollectionSummary,
  RuntimeConfig,
} from "#/lib/runtime-api";
import {
  DATABASE_COLLECTION_CREATED_EVENT,
} from "#/lib/runtime-api";

export type DashboardShellData = {
  runtime: RuntimeConfig;
  settings: DashboardSettings;
  databaseCollections: readonly DatabaseCollection[];
  schemaCollections: readonly DatabaseSchemaCollectionSummary[];
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

function UtilityHeader({ runtime }: { runtime?: RuntimeConfig }) {
  const { pathname } = useLocation();
  const matches = useMatches();
  const pageLabel =
    getDashboardPageLabelFromMatches(matches) ??
    getDashboardPageLabel(pathname, runtime?.services, runtime?.serviceRegistry);

  return (
    <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
        <SidebarTrigger className="-ms-1" />
        <Separator
          orientation="vertical"
          className="me-2 data-[orientation=vertical]:h-4"
        />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem className="hidden md:block">
              <BreadcrumbLink render={<Link to="/" />}>
                Zelavis
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block" />
            <BreadcrumbItem>
              <BreadcrumbPage>{pageLabel}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
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
  const direction = useDirection();
  const [activeDashboardData, setActiveDashboardData] = React.useState(dashboardData);

  React.useEffect(() => {
    document.documentElement.dataset.zelavisHydrated = "true";

    return () => {
      delete document.documentElement.dataset.zelavisHydrated;
    };
  }, []);

  React.useEffect(() => {
    setActiveDashboardData((current) => {
      if (!dashboardData) {
        return dashboardData;
      }

      if (!current) {
        return dashboardData;
      }

      return {
        ...dashboardData,
        databaseCollections: mergeDatabaseCollections(
          dashboardData.databaseCollections,
          current.databaseCollections,
        ),
      };
    });
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

        return {
          ...current,
          databaseCollections: mergeDatabaseCollections(
            current.databaseCollections,
            [collection],
          ),
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

  return (
    <TooltipProvider>
      <SidebarProvider className="h-svh overflow-hidden">
        <AppSidebar
          runtime={activeDashboardData?.runtime}
          settings={activeDashboardData?.settings}
          databaseCollections={activeDashboardData?.databaseCollections}
          schemaCollections={activeDashboardData?.schemaCollections}
          side={direction === "rtl" ? "right" : "left"}
          aria-label="Dashboard navigation"
          role="complementary"
        />
        <SidebarInset className="min-h-0 overflow-hidden">
          <UtilityHeader runtime={activeDashboardData?.runtime} />
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            <div className="flex min-h-full flex-1 flex-col gap-4 p-4 pt-0">
              <RestartRequiredBanner settings={activeDashboardData?.settings} />
              {children}
              <Footer />
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
