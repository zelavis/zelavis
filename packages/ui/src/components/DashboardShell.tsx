import * as React from "react";
import { Link, useRouterState } from "@tanstack/react-router";

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
import { getDashboardPageLabel } from "#/lib/dashboard-data";
import { getDashboardSettings, getRuntimeConfig } from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";

function UtilityHeader() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const pageLabel = getDashboardPageLabel(pathname);

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

function RestartRequiredBanner() {
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const settings = useRuntimeResource(
    async () => (config ? getDashboardSettings(config) : undefined),
    [config],
  );
  const dashboardSettings = settings.data;

  if (!dashboardSettings?.restartRequired) {
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
          {dashboardSettings.pendingRootPath}.
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

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const direction = useDirection();

  React.useEffect(() => {
    document.documentElement.dataset.zelavisHydrated = "true";

    return () => {
      delete document.documentElement.dataset.zelavisHydrated;
    };
  }, []);

  return (
    <TooltipProvider>
      <SidebarProvider className="h-svh overflow-hidden">
        <AppSidebar
          side={direction === "rtl" ? "right" : "left"}
          aria-label="Dashboard navigation"
          role="complementary"
        />
        <SidebarInset className="min-h-0 overflow-hidden">
          <UtilityHeader />
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            <div className="flex min-h-full flex-1 flex-col gap-4 p-4 pt-0">
              <RestartRequiredBanner />
              {children}
              <Footer />
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
