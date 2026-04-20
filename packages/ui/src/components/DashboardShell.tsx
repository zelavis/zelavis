import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Github, PanelLeft, Server, Settings } from 'lucide-react'

import Footer from './Footer'
import ThemeToggle from './ThemeToggle'
import { Button } from '#/components/ui/button'
import { useDirection } from '#/components/ui/direction'
import { dashboardNavItems } from '#/lib/dashboard-data'
import { cn } from '#/lib/utils'

const SidebarContext = React.createContext<{
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
}>({
  open: true,
  setOpen: () => undefined,
})

function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)

  return (
    <SidebarContext.Provider value={{ open, setOpen }}>
      {children}
    </SidebarContext.Provider>
  )
}

function useSidebar() {
  return React.useContext(SidebarContext)
}

function SidebarTrigger() {
  const { setOpen } = useSidebar()

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Toggle Sidebar"
      onClick={() => setOpen((value) => !value)}
    >
      <PanelLeft className="size-4 rtl:rotate-180" />
    </Button>
  )
}

function SidebarLink({
  icon: Icon,
  label,
  to,
  onNavigate,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  to: string
  onNavigate?: () => void
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      activeOptions={{ exact: true }}
      className="flex min-h-9 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground no-underline transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      activeProps={{
        className: cn(
          'flex min-h-9 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium no-underline transition-colors',
          'bg-sidebar-accent text-sidebar-accent-foreground',
        ),
      }}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </Link>
  )
}

function AppSidebar() {
  const { open, setOpen } = useSidebar()
  const direction = useDirection()
  const sideClass =
    direction === 'rtl'
      ? 'end-0 border-s data-[open=false]:translate-x-full'
      : 'start-0 border-e data-[open=false]:-translate-x-full'
  const close = () => setOpen(false)

  return (
    <>
      <div
        aria-hidden="true"
        data-open={open}
        className="pointer-events-none fixed inset-0 z-40 bg-background/80 opacity-0 backdrop-blur-sm transition-opacity data-[open=true]:pointer-events-auto data-[open=true]:opacity-100 lg:hidden"
        onClick={close}
      />
      <aside
        aria-label="Dashboard navigation"
        data-open={open}
        className={cn(
          'fixed inset-y-0 z-50 flex w-[var(--sidebar-width)] flex-col bg-sidebar text-sidebar-foreground transition-transform lg:translate-x-0',
          sideClass,
        )}
      >
        <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-4">
          <Link
            to="/"
            onClick={close}
            className="flex min-w-0 items-center gap-3 text-sm font-semibold text-sidebar-foreground no-underline"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <Server className="size-4" />
            </span>
            <span className="truncate">Zelavis</span>
          </Link>
        </div>

        <nav className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
          <div className="grid gap-1">
            {dashboardNavItems.map((item) => (
              <SidebarLink key={item.to} {...item} onNavigate={close} />
            ))}
          </div>

          <div className="mt-auto grid gap-1 border-t border-sidebar-border pt-4">
            <SidebarLink
              to="/settings"
              label="Settings"
              icon={Settings}
              onNavigate={close}
            />
            <Link
              to="/services"
              onClick={close}
              className="flex min-h-9 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground no-underline transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              activeProps={{
                className:
                  'flex min-h-9 items-center gap-3 rounded-md bg-sidebar-accent px-3 py-2 text-sm font-medium text-sidebar-accent-foreground no-underline transition-colors',
              }}
            >
              <Server className="size-4 shrink-0" />
              <span className="truncate">Services</span>
            </Link>
          </div>
        </nav>
      </aside>
    </>
  )
}

function UtilityHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background/90 px-4 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger />
        <span className="truncate text-sm font-medium text-muted-foreground">
          Runtime dashboard
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <a
          href="https://github.com/zelavis/zelavis"
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center justify-center gap-2 rounded-md border bg-background px-3 text-xs font-medium text-foreground no-underline shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Github className="size-4" />
          GitHub
        </a>
        <ThemeToggle />
      </div>
    </header>
  )
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <div className="min-h-svh [--sidebar-width:16rem]">
        <AppSidebar />
        <div className="flex min-h-svh min-w-0 flex-col lg:ps-[var(--sidebar-width)]">
          <UtilityHeader />
          <div className="flex min-h-0 flex-1 flex-col">
            {children}
            <Footer />
          </div>
        </div>
      </div>
    </SidebarProvider>
  )
}
