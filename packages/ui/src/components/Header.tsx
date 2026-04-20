import { Link } from '@tanstack/react-router'
import { Github, Server } from 'lucide-react'

import ThemeToggle from './ThemeToggle'
import { dashboardNavItems } from '#/lib/dashboard-data'
import { cn } from '#/lib/utils'

export default function Header() {
  return (
    <header className="sticky top-0 z-50 border-b bg-background/90 px-4 backdrop-blur">
      <nav className="mx-auto flex max-w-7xl flex-col gap-3 py-3 lg:flex-row lg:items-center">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm font-semibold text-foreground no-underline shadow-sm"
          >
            <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
              <Server className="size-4" />
            </span>
            Zelavis
          </Link>

          <div className="hidden h-8 border-l lg:block" />

          <p className="hidden text-sm text-muted-foreground lg:block">
            Runtime dashboard
          </p>
        </div>

        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto lg:justify-center">
          {dashboardNavItems.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground no-underline transition-colors hover:bg-accent hover:text-accent-foreground"
              activeProps={{
                className: cn(
                  'inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium no-underline transition-colors',
                  'bg-accent text-accent-foreground',
                ),
              }}
              activeOptions={{ exact: item.to === '/' }}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-2 lg:justify-end">
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
      </nav>
    </header>
  )
}
