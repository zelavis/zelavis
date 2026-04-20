import { createFileRoute } from '@tanstack/react-router'
import { Activity, Boxes, Database, ShieldCheck } from 'lucide-react'

import {
  DataRow,
  PageHeader,
  StatCard,
  StatusBadge,
} from '#/components/DashboardPage'
import {
  activityRows,
  capabilityCards,
  serviceRows,
} from '#/lib/dashboard-data'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'

export const Route = createFileRoute('/')({ component: Overview })

function Overview() {
  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6">
      <PageHeader
        eyebrow="Overview"
        title="Zelavis runtime"
        description="Core services, active paths, and package boundaries in one place."
      />

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Mounted core"
          value="3 services"
          detail="dashboard, auth, database"
          icon={Boxes}
        />
        <StatCard
          label="Database"
          value="document mode"
          detail="SQL remains available as a capability"
          icon={Database}
        />
        <StatCard
          label="Auth"
          value="provider plugins"
          detail="core service with installable methods"
          icon={ShieldCheck}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Service Map</CardTitle>
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

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4" />
              Activity
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {activityRows.map((item) => (
              <DataRow
                key={item.label}
                label={item.label}
                detail={item.detail}
                meta={
                  <span className="text-xs text-muted-foreground">{item.time}</span>
                }
              />
            ))}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {capabilityCards.map((card) => (
          <StatCard
            key={card.title}
            label={card.title}
            value={card.value}
            detail={card.detail}
            icon={card.icon}
          />
        ))}
      </section>
    </main>
  )
}
