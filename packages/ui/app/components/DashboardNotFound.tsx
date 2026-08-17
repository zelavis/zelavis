import { Link } from 'react-router'

import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
import { toProjectPath } from '#/lib/routing'

export function DashboardNotFound() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Dashboard route not found</CardTitle>
          <CardDescription>
            The requested dashboard path is not registered in this runtime.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
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
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
