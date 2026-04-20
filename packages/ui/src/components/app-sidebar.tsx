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
import { Link } from "@tanstack/react-router"

import { NavMain } from "#/components/nav-main"
import { NavProjects } from "#/components/nav-projects"
import { NavSecondary } from "#/components/nav-secondary"
import { NavUser } from "#/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar"

const data = {
  user: {
    name: "Runtime dashboard",
    email: "local workspace",
    avatar: "",
  },
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
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <Server className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">Zelavis</span>
                  <span className="truncate text-xs">Runtime</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
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
