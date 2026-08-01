"use client"

import * as React from "react"
import { Check, ChevronsUpDown, LayoutDashboard, Plus } from "lucide-react"
import { useNavigate } from "react-router"

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
  useSidebar,
} from "#/components/ui/sidebar"
import type { DashboardProjectItem } from "#/lib/dashboard-data"
import { toProjectPath } from "#/lib/routing"

export function ProjectSwitcher({
  projects,
}: {
  projects: readonly DashboardProjectItem[]
}) {
  const { isMobile } = useSidebar()
  const navigate = useNavigate()
  const [activeProject, setActiveProject] = React.useState(projects[0])

  if (!activeProject) {
    return null
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <SidebarMenuButton
            render={<DropdownMenuTrigger />}
            size="lg"
            className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
          >
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              <activeProject.logo className="size-4" />
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-semibold">{activeProject.name}</span>
              <span className="truncate text-xs">{activeProject.domain}</span>
            </div>
            <ChevronsUpDown className="ms-auto" />
          </SidebarMenuButton>
          <DropdownMenuContent
            className="min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
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
                      navigate(toProjectPath("/", project.id))
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
              onClick={() => navigate("/projects")}
            >
              <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                <LayoutDashboard className="size-4" />
              </div>
              <div className="font-medium">All projects</div>
              <DropdownMenuShortcut>⌘P</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="gap-2 p-2"
              onClick={() => navigate("/projects?new=1")}
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
