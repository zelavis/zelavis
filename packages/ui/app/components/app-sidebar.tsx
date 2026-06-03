"use client";

import * as React from "react";
import { useLocation } from "react-router";

import { NavMain } from "#/components/nav-main";
import { NavSecondary } from "#/components/nav-secondary";
import { NavUser } from "#/components/nav-user";
import { TeamSwitcher } from "#/components/team-switcher";
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
  buildPlatformNavItems,
  platformNavItems,
  secondaryNavItems,
  sidebarTeams,
} from "#/lib/dashboard-data";
import { filterUserDatabaseCollections } from "#/lib/database-collections";
import { readSearchParams } from "#/lib/routing";
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
      runtime
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
      runtime?.serviceRegistry,
      runtime?.services,
    ],
  );

  return (
    <Sidebar variant="inset" collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher teams={sidebarTeams} />
      </SidebarHeader>
      <SidebarContent className="overflow-hidden">
        <NavMain items={items} />
        <NavSecondary
          title="Help"
          items={secondaryNavItems}
          className="mt-auto"
        />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
    </Sidebar>
  );
}
