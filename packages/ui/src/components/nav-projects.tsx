"use client"

import { Link, useRouterState } from "@tanstack/react-router"
import { MoreHorizontal, type LucideIcon } from "lucide-react"

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar"

export function NavProjects({
  projects,
}: {
  projects: {
    name: string
    url: string
    icon: LucideIcon
  }[]
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Packages</SidebarGroupLabel>
      <SidebarMenu>
        {projects.slice(0, 5).map((item) => (
          <SidebarMenuItem key={item.name}>
            <SidebarMenuButton asChild isActive={pathname === item.url}>
              <Link to={item.url}>
                <item.icon />
                <span>{item.name}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
        <SidebarMenuItem>
          <SidebarMenuButton asChild isActive={pathname === "/services"}>
            <Link to="/services">
              <MoreHorizontal />
              <span>More</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  )
}
