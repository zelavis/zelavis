"use client"

import * as React from "react"
import { Check, ChevronsUpDown, House, LayoutDashboard, Plus } from "lucide-react"
import { Link, useNavigate } from "react-router"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar"
import type { DashboardProjectItem } from "#/lib/dashboard-data"
import { toProjectPath } from "#/lib/routing"

export function ProjectSwitcher({
  homeIconLinksToProjects = false,
  onOpenChange,
  projects,
}: {
  homeIconLinksToProjects?: boolean
  onOpenChange?: (open: boolean) => void
  projects: readonly DashboardProjectItem[]
}) {
  const navigate = useNavigate()
  const [activeProject, setActiveProject] = React.useState(projects[0])

  if (!activeProject) {
    return null
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem className="flex min-w-0 gap-1">
        <SidebarMenuButton
          render={<Link to="/projects" viewTransition />}
          size="lg"
          tooltip="Projects"
          className="w-12 shrink-0 justify-center px-0 group-data-[collapsible=icon]:w-full"
        >
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            {homeIconLinksToProjects ? (
              <House className="size-4" />
            ) : (
              <activeProject.logo className="size-4" />
            )}
          </div>
          <span className="sr-only">Projects</span>
        </SidebarMenuButton>
        <DropdownMenu onOpenChange={onOpenChange}>
          <SidebarMenuButton
            render={<DropdownMenuTrigger />}
            size="lg"
            className="min-w-0 flex-1 data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden"
          >
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-semibold">{activeProject.name}</span>
              <span className="truncate text-xs">{activeProject.domain}</span>
            </div>
            <ChevronsUpDown className="ms-auto" />
          </SidebarMenuButton>
          <DropdownMenuContent
            className="w-[calc(var(--anchor-width)+3.25rem)] min-w-0 rounded-lg"
            align="start"
            alignOffset={-52}
            side="bottom"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Projects
              </DropdownMenuLabel>
              {projects.map((project) => {
                const isActive = project.id === activeProject.id

                return (
                  <DropdownMenuItem
                    key={project.id}
                    onClick={() => {
                      setActiveProject(project)
                      navigate(toProjectPath("/", project.id), {
                        viewTransition: true,
                      })
                    }}
                    className="gap-2 p-2"
                  >
                    <div className="flex size-6 items-center justify-center rounded-sm border">
                      <project.logo className="size-4 shrink-0" />
                    </div>
                    <div className="grid min-w-0 flex-1">
                      <span className="truncate">{project.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {project.domain}
                      </span>
                    </div>
                    {isActive ? <Check className="ms-auto size-4" /> : null}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-2 p-2"
              onClick={() => navigate("/projects", { viewTransition: true })}
            >
              <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                <LayoutDashboard className="size-4" />
              </div>
              <div className="font-medium">All projects</div>
              <DropdownMenuShortcut>⌘P</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="gap-2 p-2"
              onClick={() =>
                navigate("/projects?new=1", { viewTransition: true })
              }
            >
              <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                <Plus className="size-4" />
              </div>
              <div className="font-medium">New project</div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
