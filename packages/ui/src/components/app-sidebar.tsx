"use client"

import * as React from "react"
import {
  Bot,
  Database,
  FileText,
  Fingerprint,
  Github,
  LayoutDashboard,
  LifeBuoy,
  MonitorCog,
  PanelsTopLeft,
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
      url: "/database",
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
      url: "/agents",
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
      title: "Commerce",
      url: "/commerce",
      icon: Store,
    },
    {
      title: "Settings",
      url: "/settings",
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
      url: "/settings",
      icon: LifeBuoy,
    },
    {
      title: "Feedback",
      url: "/settings",
      icon: Send,
    },
  ],
  projects: [
    {
      name: "Auth",
      url: "/auth",
      icon: Fingerprint,
    },
    {
      name: "Database",
      url: "/database",
      icon: Database,
    },
    {
      name: "Content",
      url: "/content",
      icon: FileText,
    },
    {
      name: "Builder",
      url: "/builder",
      icon: PanelsTopLeft,
    },
    {
      name: "Commerce",
      url: "/commerce",
      icon: Store,
    },
    {
      name: "Runtime",
      url: "/settings",
      icon: MonitorCog,
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
