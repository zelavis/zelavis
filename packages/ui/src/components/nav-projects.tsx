"use client";

import { Link, useRouterState } from "@tanstack/react-router";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar";
import type { DashboardPackageItem } from "#/lib/dashboard-data";

export function NavProjects({
  projects,
  nested = false,
}: {
  projects: readonly DashboardPackageItem[];
  nested?: boolean;
}) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  const content = (
    <>
      <SidebarGroupLabel>Community</SidebarGroupLabel>
      <SidebarMenu>
        {projects.map((item) => {
          if (!item.url) {
            return (
              <SidebarMenuItem key={item.name}>
                <SidebarMenuButton
                  disabled
                  className="cursor-default opacity-70"
                >
                  <item.icon />
                  <span>{item.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          }

          return (
            <SidebarMenuItem key={item.name}>
              <SidebarMenuButton
                render={<Link to={item.url} />}
                isActive={pathname === item.url}
              >
                <item.icon />
                <span>{item.name}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </>
  );

  if (nested) {
    return (
      <div className="group-data-[collapsible=icon]:hidden">{content}</div>
    );
  }

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      {content}
    </SidebarGroup>
  );
}
