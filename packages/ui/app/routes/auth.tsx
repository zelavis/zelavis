import { useLoaderData, useRouteLoaderData } from 'react-router'
import { KeyRound, ShieldCheck, UserRoundCog } from 'lucide-react'

import {
  DataRow,
  ResourceNotice,
  StatCard,
} from '#/components/DashboardPage'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { getActiveRuntimeConfig, listAuthProviders } from '#/lib/runtime-api'
import type { clientLoader as rootClientLoader } from '../root'
import type { Route } from './+types/auth'

export const handle = {
  pageLabel: "Auth",
  sidebarTrail: ["Backend"],
} as const;

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request)
  const providers = await listAuthProviders(runtime)
  return { providers }
}

function Auth() {
  const { providers } = useLoaderData<typeof clientLoader>()
  const { runtime } = useRouteLoaderData<typeof rootClientLoader>('root')!

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Service"
          value="enabled"
          detail="/api/v1/auth"
          icon={ShieldCheck}
        />
        <StatCard
          label="Providers"
          value={`${providers.length} registered`}
          detail={
            providers.length > 0
              ? providers.join(', ')
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
          {providers.map((provider) => (
            <DataRow
              key={provider}
              label={provider}
              detail={`${runtime.api.basePath}/auth/authenticate/${provider}`}
            />
          ))}
          {providers.length === 0 ? (
            <div className="p-4">
              <ResourceNotice
                title="No providers registered"
                description="Install an auth provider service to expose a credential method."
              />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  )
}

export default Auth;
