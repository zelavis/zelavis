import { createFileRoute } from '@tanstack/react-router'
import { Boxes } from 'lucide-react'

import {
  DataRow,
  PageHeader,
  StatusBadge,
} from '#/components/DashboardPage'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { serviceRows } from '#/lib/dashboard-data'

export const Route = createFileRoute('/services')({ component: Services })

function Services() {
  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6">
      <PageHeader
        eyebrow="Services"
        title="Runtime services"
        description="Core services and official packages share the same service contract."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Boxes className="size-4" />
            Mounted and Available
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {serviceRows.map((service) => (
            <DataRow
              key={service.name}
              label={service.name}
              detail={`${service.scope} · ${service.path}`}
              meta={<StatusBadge state={service.state} />}
            />
          ))}
        </CardContent>
      </Card>
    </main>
  )
}
