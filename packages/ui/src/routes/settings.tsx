import { createFileRoute } from '@tanstack/react-router'
import { Save } from 'lucide-react'

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
    </main>
  )
}
