import * as React from 'react'
import { Link } from '@tanstack/react-router'
import {
  ChevronsUpDown,
  Github,
  PanelLeft,
  Server,
  Settings,
} from 'lucide-react'

import Footer from './Footer'
import ThemeToggle from './ThemeToggle'
import { Button } from '#/components/ui/button'
import { useDirection } from '#/components/ui/direction'
import { dashboardNavItems } from '#/lib/dashboard-data'
import { cn } from '#/lib/utils'

const SidebarContext = React.createContext<{
  open: boolean
  openMobile: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  setOpenMobile: React.Dispatch<React.SetStateAction<boolean>>
  isMobile: boolean
  toggleSidebar: () => void
}>({
  open: true,
  openMobile: false,
  setOpen: () => undefined,
  setOpenMobile: () => undefined,
  isMobile: false,
  toggleSidebar: () => undefined,
})

function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(true)
  const [openMobile, setOpenMobile] = React.useState(false)
  const isMobile = useMediaQuery('(max-width: 1023px)')
  const toggleSidebar = React.useCallback(() => {
    if (isMobile) {
      setOpenMobile((value) => !value)
      return
    }

    setOpen((value) => !value)
  }, [isMobile])

  return (
    <SidebarContext.Provider
      value={{
        open,
        openMobile,
        setOpen,
        setOpenMobile,
        isMobile,
        toggleSidebar,
      }}
    >
      {children}
    </SidebarContext.Provider>
  )
}

function useSidebar() {
  return React.useContext(SidebarContext)
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = React.useState(false)

  React.useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)

    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])

  return matches
}

function SidebarTrigger() {
  const { toggleSidebar } = useSidebar()

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Toggle Sidebar"
      onClick={toggleSidebar}
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
      title={label}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate group-data-[state=collapsed]/sidebar:hidden">
        {label}
      </span>
    </Link>
  )
}

function TeamSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <button
      type="button"
      className="flex h-12 w-full items-center gap-3 rounded-md px-2 text-start text-sm font-medium text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      aria-label="Select workspace"
      title="Zelavis Runtime"
      onClick={onNavigate}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
        <Server className="size-4" />
      </span>
      <span className="min-w-0 flex-1 group-data-[state=collapsed]/sidebar:hidden">
        <span className="block truncate font-semibold">Zelavis</span>
        <span className="block truncate text-xs text-muted-foreground">Runtime</span>
      </span>
      <ChevronsUpDown className="ms-auto size-4 text-muted-foreground group-data-[state=collapsed]/sidebar:hidden" />
    </button>
  )
}

function AppSidebar() {
  const { open, openMobile, setOpenMobile, isMobile } = useSidebar()
  const direction = useDirection()
  const sideClass =
    direction === 'rtl'
      ? 'end-0 border-s lg:border-s'
      : 'start-0 border-e lg:border-e'
  const mobileTranslateClass =
    direction === 'rtl'
      ? 'data-[mobile-open=false]:translate-x-full'
      : 'data-[mobile-open=false]:-translate-x-full'
  const closeMobile = () => setOpenMobile(false)
  const state = open ? 'expanded' : 'collapsed'
  const shouldShowMobileOverlay = isMobile && openMobile

  return (
    <>
      <div
        aria-hidden="true"
        data-open={shouldShowMobileOverlay}
        className="pointer-events-none fixed inset-0 z-40 bg-background/80 opacity-0 backdrop-blur-sm transition-opacity data-[open=true]:pointer-events-auto data-[open=true]:opacity-100 lg:hidden"
        onClick={closeMobile}
      />
      <aside
        aria-label="Dashboard navigation"
        data-sidebar="sidebar"
        data-state={state}
        data-mobile-open={openMobile}
        className={cn(
          'group/sidebar fixed inset-y-0 z-50 flex w-[var(--sidebar-width-mobile)] flex-col bg-sidebar text-sidebar-foreground transition-[transform,width] duration-200 ease-linear lg:sticky lg:top-0 lg:z-20 lg:h-svh lg:w-[var(--sidebar-width-current)] lg:translate-x-0',
          sideClass,
          mobileTranslateClass,
        )}
      >
        <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-2">
          <TeamSwitcher onNavigate={closeMobile} />
        </div>

        <nav className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 py-4 group-data-[state=collapsed]/sidebar:px-2">
          <div className="grid gap-1">
            {dashboardNavItems.map((item) => (
              <SidebarLink key={item.to} {...item} onNavigate={closeMobile} />
            ))}
          </div>

          <div className="mt-auto grid gap-1 border-t border-sidebar-border pt-4">
            <SidebarLink
              to="/settings"
              label="Settings"
              icon={Settings}
              onNavigate={closeMobile}
            />
            <Link
              to="/services"
              onClick={closeMobile}
              className="flex min-h-9 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground no-underline transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              activeProps={{
                className:
                  'flex min-h-9 items-center gap-3 rounded-md bg-sidebar-accent px-3 py-2 text-sm font-medium text-sidebar-accent-foreground no-underline transition-colors',
              }}
              title="Services"
            >
              <Server className="size-4 shrink-0" />
              <span className="truncate group-data-[state=collapsed]/sidebar:hidden">
                Services
              </span>
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

function DashboardFrame({ children }: { children: React.ReactNode }) {
  const { open } = useSidebar()
  const state = open ? 'expanded' : 'collapsed'
  const sidebarWidth = open ? '16rem' : '4.5rem'

  return (
    <div
      data-state={state}
      style={
        {
          '--sidebar-width-current': sidebarWidth,
        } as React.CSSProperties
      }
      className="grid min-h-svh [--sidebar-width-mobile:18rem] lg:grid-cols-[var(--sidebar-width-current)_minmax(0,1fr)]"
    >
      <AppSidebar />
      <div className="flex min-h-svh min-w-0 flex-col">
        <UtilityHeader />
        <div className="flex min-h-0 flex-1 flex-col">
          {children}
          <Footer />
        </div>
      </div>
    </div>
  )
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <DashboardFrame>{children}</DashboardFrame>
    </SidebarProvider>
  )
}
