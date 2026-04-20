import type * as React from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { Github } from 'lucide-react'

import { AppSidebar } from '#/components/app-sidebar'
import Footer from '#/components/Footer'
import ThemeToggle from '#/components/ThemeToggle'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '#/components/ui/breadcrumb'
import { useDirection } from '#/components/ui/direction'
import { Separator } from '#/components/ui/separator'
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '#/components/ui/sidebar'
import { dashboardNavItems } from '#/lib/dashboard-data'

function currentPageLabel(pathname: string) {
  const current = dashboardNavItems.find((item) => item.to === pathname)

  if (current) {
    return current.label
  }

  if (pathname === '/settings') {
    return 'Settings'
  }

  if (pathname === '/services') {
    return 'Services'
  }

  return 'Not Found'
}

function UtilityHeader() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const pageLabel = currentPageLabel(pathname)

  return (
    <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
        <SidebarTrigger className="-ms-1" />
        <Separator
          orientation="vertical"
          className="me-2 data-[orientation=vertical]:h-4"
        />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem className="hidden md:block">
              <BreadcrumbLink asChild>
                <Link to="/">Zelavis</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block" />
            <BreadcrumbItem>
              <BreadcrumbPage>{pageLabel}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <div className="flex shrink-0 items-center gap-2 px-4">
        <a
          href="https://github.com/zelavis/zelavis"
          target="_blank"
          rel="noreferrer"
          className="inline-flex size-8 items-center justify-center rounded-md border bg-background text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="GitHub"
          title="GitHub"
        >
          <Github className="size-4" />
        </a>
        <ThemeToggle />
      </div>
    </header>
  )
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const direction = useDirection()

  return (
    <SidebarProvider>
      <AppSidebar
        side={direction === 'rtl' ? 'right' : 'left'}
        aria-label="Dashboard navigation"
        role="complementary"
      />
      <SidebarInset>
        <UtilityHeader />
        <div className="flex min-h-0 flex-1 flex-col">
          {children}
          <Footer />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
