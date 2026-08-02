import { Link, useLoaderData, useParams, useRouteLoaderData } from 'react-router'
import { Activity, Boxes, Database, Globe2, ReceiptText, RotateCcw, ShieldCheck } from 'lucide-react'

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
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import { buttonVariants } from '#/components/ui/button'
import { cn } from '#/lib/utils'
import type { clientLoader as rootClientLoader } from '../root'

export const handle = {
  pageLabel: "Overview",
} as const;

export async function clientLoader() {
  const runtime = await getRuntimeConfig()
  const [databaseHealth, providers] = await Promise.all([
    getDatabaseHealth(runtime).catch(() => undefined),
    listAuthProviders(runtime).catch(() => [] as string[]),
  ])
  return { databaseHealth, providers }
}

function getManagedProjectKind(projectId: string | undefined) {
  if (projectId?.startsWith("wordpress-")) {
    return "WordPress";
  }

  if (projectId?.startsWith("static-")) {
    return "Static website";
  }

  if (projectId?.startsWith("generic-")) {
    return "Generic app";
  }

  return undefined;
}

function ManagedProjectOverview({ kind }: { kind: string }) {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Managed Project"
        title={kind}
        description="This project is operated by Zelavis, but it does not use the Zelavis-native app dashboard."
        actions={
          <Link
            to="/server/domains"
            className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
          >
            <Globe2 className="size-4" />
            Domains
          </Link>
        }
      />

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="App"
          value={kind}
          detail="Managed through hosting-style controls."
          icon={Boxes}
        />
        <StatCard
          label="Domains"
          value="planned"
          detail="Server-level bindings will attach here."
          icon={Globe2}
        />
        <StatCard
          label="Backups"
          value="planned"
          detail="Project snapshots come from the host backup layer."
          icon={RotateCcw}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Hosting controls</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="Application admin"
            detail={
              kind === "WordPress"
                ? "WordPress Admin will open the app's own dashboard."
                : "The app keeps its own runtime/admin surface."
            }
            meta={<StatusBadge state="draft" />}
          />
          <DataRow
            label="Files"
            detail="Future file manager and deploy controls."
            meta={<StatusBadge state="draft" />}
          />
          <DataRow
            label="Logs"
            detail="Future project log stream from the server layer."
            meta={<ReceiptText className="size-4 text-muted-foreground" />}
          />
        </CardContent>
      </Card>

      <ResourceNotice
        title="Different project surface"
        description="Zelavis-native projects show auth, database, content, media, and plugins. Managed app projects show hosting controls because the application itself is not built on Zelavis primitives."
      />
    </section>
  );
}

function Overview() {
  const params = useParams();
  const { databaseHealth, providers } = useLoaderData<typeof clientLoader>()
  const { runtime } = useRouteLoaderData<typeof rootClientLoader>('root')!
  const services = runtime.services
  const managedProjectKind = getManagedProjectKind(params.projectId);

  if (managedProjectKind) {
    return <ManagedProjectOverview kind={managedProjectKind} />;
  }

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
          value={`${providers.length} providers`}
          detail={
            providers.length > 0
              ? providers.join(', ')
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
                detail: runtime.api.basePath ?? '/api/v1/runtime/config',
                time: 'ready',
              },
              {
                label: 'Database health',
                detail: databaseHealth
                  ? `${databaseHealth.status} · ${databaseHealth.driver}`
                  : '/database/health',
                time: databaseHealth ? 'ready' : 'offline',
              },
              {
                label: 'Auth providers',
                detail:
                  providers.length > 0
                    ? providers.join(', ')
                    : '/auth/providers',
                time: providers.length > 0 ? 'ready' : 'offline',
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
