import { Link } from 'react-router'

import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'

/**
 * A Project's own pages are served by its runtime, so they need it running. That
 * is an ordinary state to land in (a link, a reload, a stopped Project), not an
 * error, and the way out is on the Projects overview.
 */
export function ProjectNotRunning({ message }: { message?: string }) {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle>This Project is not running</CardTitle>
          <CardDescription>
            {message ? `${message} ` : ''}
            Its pages are served by its own runtime, so start it from the Projects overview.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button nativeButton={false} render={<Link to="/projects" />}>
            Back to Projects
          </Button>
        </CardContent>
      </Card>
    </section>
  )
}
