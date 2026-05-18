import { KeyRound, ShieldCheck, UserRoundCog } from 'lucide-react'

import {
  DataRow,
  PageHeader,
  ResourceNotice,
  StatCard,
} from '#/components/DashboardPage'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { getRuntimeConfig, listAuthProviders } from '#/lib/runtime-api'
import { useRuntimeResource } from '#/lib/use-runtime-resource'

export const handle = {
  pageLabel: "Auth",
  sidebarTrail: ["Core"],
} as const;

function Auth() {
  const runtime = useRuntimeResource(getRuntimeConfig)
  const providers = useRuntimeResource(
    async () => (runtime.data ? listAuthProviders(runtime.data) : []),
    [runtime.data],
  )
  const providerNames = providers.data ?? []

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Auth"
        title="Authentication"
        description="Core auth service with provider plugins mounted through the runtime."
      />

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Service"
          value="enabled"
          detail="/api/v1/auth"
          icon={ShieldCheck}
        />
        <StatCard
          label="Providers"
          value={`${providerNames.length} registered`}
          detail={
            providerNames.length > 0
              ? providerNames.join(', ')
              : 'no credential providers registered yet'
          }
          icon={UserRoundCog}
        />
        <StatCard
          label="Sessions"
          value="contract-first"
          detail="storage stays behind service boundaries"
          icon={KeyRound}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Credential Providers</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {providerNames.map((provider) => (
            <DataRow
              key={provider}
              label={provider}
              detail={`${runtime.data?.api.basePath ?? '/api/v1'}/auth/authenticate/${provider}`}
            />
          ))}
          {providerNames.length === 0 ? (
            <div className="p-4">
              <ResourceNotice
                title={providers.loading ? 'Loading providers' : 'No providers registered'}
                description={
                  providers.error
                    ? 'The auth endpoint is not reachable from this dashboard session.'
                    : 'Install an auth provider plugin to expose a credential method.'
                }
              />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  )
}

export default Auth;
