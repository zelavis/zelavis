import { Activity, Boxes, Database, ShieldCheck } from 'lucide-react'

import {
  DataRow,
  PageHeader,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from '#/components/DashboardPage'
import {
  capabilityCards,
} from '#/lib/dashboard-data'
import {
  getDatabaseHealth,
  getRuntimeConfig,
  listAuthProviders,
} from '#/lib/runtime-api'
import { useRuntimeResource } from '#/lib/use-runtime-resource'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'

export const handle = {
  pageLabel: "Overview",
} as const;

function Overview() {
  const runtime = useRuntimeResource(getRuntimeConfig)
  const config = runtime.data
  const database = useRuntimeResource(
    async () => (config ? getDatabaseHealth(config) : undefined),
    [config],
  )
  const providers = useRuntimeResource(
    async () => (config ? listAuthProviders(config) : undefined),
    [config],
  )
  const databaseHealth = database.data
  const authProviders = providers.data ?? []
  const services = config?.services ?? []

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Overview"
        title="Zelavis runtime"
        description="Core services, active paths, and package boundaries in one place."
      />

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Mounted core"
          value={`${services.length || 3} services`}
          detail={services.map((service) => service.name).join(', ') || 'dashboard, auth, database'}
          icon={Boxes}
        />
        <StatCard
          label="Database"
          value={databaseHealth?.driver ?? 'checking'}
          detail={
            databaseHealth
              ? `documents ${databaseHealth.capabilities.documents ? 'on' : 'off'}, SQL ${databaseHealth.capabilities.sql ? 'on' : 'off'}`
              : 'waiting for /database/health'
          }
          icon={Database}
        />
        <StatCard
          label="Auth"
          value={`${authProviders.length} providers`}
          detail={
            authProviders.length > 0
              ? authProviders.join(', ')
              : 'no credential providers registered yet'
          }
          icon={ShieldCheck}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Service Map</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {services.map((service) => (
              <DataRow
                key={service.name}
                label={service.name}
                detail={`${service.core ? 'core' : 'custom'} · ${service.apiPath}`}
                meta={<StatusBadge state="ready" />}
              />
            ))}
            {services.length === 0 ? (
              <div className="p-4">
                <ResourceNotice
                  title="Runtime config unavailable"
                  description="Start Zelavis through the Node or Express example to load live service metadata."
                />
              </div>
            ) : null}
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
            {[
              {
                label: 'Runtime config',
                detail: config?.api.basePath ?? '/api/v1/runtime/config',
                time: runtime.loading ? 'loading' : runtime.error ? 'offline' : 'ready',
              },
              {
                label: 'Database health',
                detail: databaseHealth
                  ? `${databaseHealth.status} · ${databaseHealth.driver}`
                  : '/database/health',
                time: database.loading ? 'loading' : database.error ? 'offline' : 'ready',
              },
              {
                label: 'Auth providers',
                detail:
                  authProviders.length > 0
                    ? authProviders.join(', ')
                    : '/auth/providers',
                time: providers.loading ? 'loading' : providers.error ? 'offline' : 'ready',
              },
            ].map((item) => (
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
    </section>
  )
}

export default Overview;
