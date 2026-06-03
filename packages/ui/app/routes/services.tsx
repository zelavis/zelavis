import { useRouteLoaderData } from 'react-router'
import { Boxes } from 'lucide-react'

import {
  DataRow,
  PageHeader,
  ResourceNotice,
  StatusBadge,
} from '#/components/DashboardPage'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import type { clientLoader as rootClientLoader } from '../root'

export const handle = {
  pageLabel: "Services",
  sidebarTrail: ["Settings"],
} as const;

function Services() {
  const { runtime } = useRouteLoaderData<typeof rootClientLoader>('root')!
  const services = runtime.services

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Services"
        title="Runtime services"
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Boxes className="size-4" />
            Mounted runtime pieces
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {services.map((service) => (
            <DataRow
              key={service.name}
              label={service.name}
              detail={`${service.core ? 'core service' : 'service/custom runtime'} · ${service.apiPath}`}
              meta={<StatusBadge state="ready" />}
            />
          ))}
          {services.length === 0 ? (
            <div className="p-4">
              <ResourceNotice
                title="Runtime config unavailable"
                description="The dashboard config endpoint could not be loaded."
              />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  )
}

export default Services;
