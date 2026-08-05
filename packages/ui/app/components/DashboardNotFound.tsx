import { Link } from 'react-router'

import { PageHeader } from '#/components/DashboardPage'
import { Button } from '#/components/ui/button'
import { toProjectPath } from '#/lib/routing'

export function DashboardNotFound() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Not Found"
        title="Dashboard route not found"
        description="The requested dashboard path is not registered in this runtime."
        actions={
          <>
            <Button
              nativeButton={false}
              render={<Link to={toProjectPath("/")} />}
            >
              Overview
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to={toProjectPath("/settings")} />}
            >
              Settings
            </Button>
          </>
        }
      />
    </section>
  )
}
