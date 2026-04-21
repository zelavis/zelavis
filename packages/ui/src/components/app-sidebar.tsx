"use client"

import * as React from "react"

import { NavMain } from "#/components/nav-main"
import { NavProjects } from "#/components/nav-projects"
import { NavSecondary } from "#/components/nav-secondary"
import { NavUser } from "#/components/nav-user"
import { TeamSwitcher } from "#/components/team-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "#/components/ui/sidebar"
import {
  packageNavItems,
  platformNavItems,
  secondaryNavItems,
  sidebarTeams,
} from "#/lib/dashboard-data"

const data = {
  user: {
    name: "Runtime dashboard",
    email: "local workspace",
    avatar: "",
  },
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar variant="inset" collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher teams={sidebarTeams} />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={platformNavItems} />
        <NavProjects projects={packageNavItems} />
        <NavSecondary items={secondaryNavItems} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
    </Sidebar>
  )
}
