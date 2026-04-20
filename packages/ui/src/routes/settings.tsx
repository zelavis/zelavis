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
          <Button type="button" size="sm">
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
