"use client";

import { Link, useLocation } from "react-router";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "#/components/ui/sidebar";
import type { DashboardPackageItem } from "#/lib/dashboard-data";

export function NavProjects({
  projects,
  nested = false,
}: {
  projects: readonly DashboardPackageItem[];
  nested?: boolean;
}) {
  const { pathname } = useLocation();

  const content = (
    <>
      <SidebarSeparator className="my-1" />
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
                render={
                  <Link
                    to={item.url}
                    aria-current={pathname === item.url ? "page" : undefined}
                  />
                }
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
      <div className="w-full shrink-0 group-data-[collapsible=icon]:hidden">
        {content}
      </div>
    );
  }

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      {content}
    </SidebarGroup>
  );
}
