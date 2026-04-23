import * as React from "react"
import { Link } from "@tanstack/react-router"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar"
import type { DashboardSecondaryItem } from "#/lib/dashboard-data"

export function NavSecondary({
  items,
  title = "Help",
  ...props
}: {
  items: readonly DashboardSecondaryItem[]
  title?: string
} & React.ComponentPropsWithoutRef<typeof SidebarGroup>) {
  return (
    <SidebarGroup {...props}>
      <SidebarGroupLabel>{title}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                render={
                  item.external ? (
                    <a href={item.url} target="_blank" rel="noreferrer" />
                  ) : (
                    <Link to={item.url} />
                  )
                }
                size="sm"
              >
                <item.icon />
                <span>{item.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
