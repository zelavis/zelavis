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
  buildPlatformNavItems,
  platformNavItems,
  secondaryNavItems,
  sidebarTeams,
} from "#/lib/dashboard-data";
import { getRuntimeConfig } from "#/lib/runtime-api";
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
  const items = React.useMemo(
    () =>
      runtime.data
        ? buildPlatformNavItems(runtime.data.plugins)
        : platformNavItems,
    [runtime.data?.plugins],
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
