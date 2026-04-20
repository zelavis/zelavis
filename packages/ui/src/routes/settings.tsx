import { Link, createFileRoute } from '@tanstack/react-router'
import { Boxes, Save } from 'lucide-react'

import { DataRow, PageHeader } from '#/components/DashboardPage'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { getRuntimeConfig } from '#/lib/runtime-api'
import { useRuntimeResource } from '#/lib/use-runtime-resource'

export const Route = createFileRoute('/settings')({ component: Settings })

function Settings() {
  const runtime = useRuntimeResource(getRuntimeConfig)
  const config = runtime.data

  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6">
      <PageHeader
        eyebrow="Settings"
        title="Runtime Settings"
        description="Root path, API version, and enabled core services."
        actions={
          <Button type="button" size="sm" disabled>
            <Save className="size-4" />
            Save
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow label="Root path" detail={config?.rootPath || '/'} />
          <DataRow label="API prefix" detail={config?.api.basePath ?? '/api/v1'} />
          <DataRow
            label="Runtime config"
            detail={config?.configSource ?? 'checking'}
          />
          <DataRow
            label="Core services"
            detail={
              config?.services
                .filter((service) => service.core)
                .map((service) => service.name)
                .join(', ') ?? 'dashboard, auth, database'
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Root Path</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 p-4">
          <form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label className="grid gap-2 text-sm font-medium text-foreground">
              Path
              <input
                value={config?.rootPath ?? '/zelavis'}
                readOnly
                className="min-w-0 rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground"
              />
            </label>
            <Button
              type="button"
              size="sm"
              disabled
              className="self-end"
            >
              <Save className="size-4" />
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Boxes className="size-4" />
            Runtime Services
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="Mounted services"
            detail="Inspect core and custom services registered in this runtime."
            meta={
              <Link
                to="/services"
                className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground no-underline shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                Open
              </Link>
            }
          />
        </CardContent>
      </Card>
    </main>
  )
}
