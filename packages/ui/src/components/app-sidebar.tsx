"use client"

import * as React from "react"
import {
  Bot,
  Database,
  Github,
  LayoutDashboard,
  LifeBuoy,
  MonitorCog,
  Send,
  Server,
  Settings2,
  Store,
} from "lucide-react"

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

const data = {
  user: {
    name: "Runtime dashboard",
    email: "local workspace",
    avatar: "",
  },
  teams: [
    {
      name: "Zelavis",
      logo: Server,
      plan: "Runtime",
    },
    {
      name: "Local",
      logo: MonitorCog,
      plan: "Development",
    },
    {
      name: "Core",
      logo: Database,
      plan: "Services",
    },
  ],
  navMain: [
    {
      title: "Overview",
      url: "/",
      icon: LayoutDashboard,
    },
    {
      title: "Core",
      icon: Server,
      items: [
        {
          title: "Auth",
          url: "/auth",
        },
        {
          title: "Database",
          url: "/database",
        },
      ],
    },
    {
      title: "Workspace",
      icon: Bot,
      items: [
        {
          title: "Agents",
          url: "/agents",
        },
        {
          title: "Builder",
          url: "/builder",
        },
        {
          title: "Content",
          url: "/content",
        },
      ],
    },
    {
      title: "Settings",
      icon: Settings2,
      items: [
        {
          title: "Runtime",
          url: "/settings",
        },
        {
          title: "Services",
          url: "/services",
        },
      ],
    },
  ],
  navSecondary: [
    {
      title: "GitHub",
      url: "https://github.com/zelavis/zelavis",
      icon: Github,
      external: true,
    },
    {
      title: "Support",
      url: "https://github.com/zelavis/zelavis/discussions",
      icon: LifeBuoy,
      external: true,
    },
    {
      title: "Feedback",
      url: "https://github.com/zelavis/zelavis/issues/new",
      icon: Send,
      external: true,
    },
  ],
  projects: [
    {
      name: "Zelavis Ecommerce",
      url: "/commerce",
      icon: Store,
    },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar variant="inset" collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher teams={data.teams} />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} />
        <NavProjects projects={data.projects} />
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
    </Sidebar>
  )
}
