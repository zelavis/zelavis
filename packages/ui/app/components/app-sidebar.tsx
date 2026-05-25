"use client";

import * as React from "react";

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
import {
  getDashboardSettings,
  getResolvedDashboardPreferences,
  getRuntimeConfig,
  listDatabaseCollections,
  listDatabaseSchemaCollections,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";

const data = {
  user: {
    name: "Runtime dashboard",
    email: "local workspace",
    avatar: "",
  },
};

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const runtime = useRuntimeResource(getRuntimeConfig);
  const settings = useRuntimeResource(
    async () => (runtime.data ? getDashboardSettings(runtime.data) : undefined),
    [runtime.data],
  );
  const databaseCollections = useRuntimeResource(
    async () => (runtime.data ? listDatabaseCollections(runtime.data) : []),
    [runtime.data],
  );
  const schemaCollections = useRuntimeResource(
    async () => (runtime.data ? listDatabaseSchemaCollections(runtime.data) : []),
    [runtime.data],
  );
  const contentTypes = React.useMemo(
    () =>
      buildContentTypeRows(
        databaseCollections.data ?? [],
        schemaCollections.data ?? [],
        getResolvedDashboardPreferences(settings.data).content,
      ),
    [databaseCollections.data, schemaCollections.data, settings.data],
  );
  const items = React.useMemo(
    () =>
      runtime.data
        ? buildPlatformNavItems(
            runtime.data.services,
            runtime.data.serviceRegistry,
            databaseCollections.data,
            contentTypes,
          )
        : platformNavItems,
    [contentTypes, databaseCollections.data, runtime.data?.serviceRegistry, runtime.data?.services],
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
