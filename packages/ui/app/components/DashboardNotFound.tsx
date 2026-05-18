import { Link } from 'react-router'

import { PageHeader } from '#/components/DashboardPage'

export function DashboardNotFound() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Not Found"
        title="Dashboard route not found"
        description="The requested dashboard path is not registered in this runtime."
        actions={
          <>
            <Link
              to="/"
              className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground no-underline shadow transition-colors hover:bg-primary/90"
            >
              Overview
            </Link>
            <Link
              to="/settings"
              className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground no-underline shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              Settings
            </Link>
          </>
        }
      />
    </section>
  )
}
