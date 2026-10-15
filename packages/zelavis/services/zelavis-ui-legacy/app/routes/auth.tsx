import { useState } from 'react'
import { useLoaderData, useRevalidator, useRouteLoaderData } from 'react-router'
import { KeyRound, PlugZap, ShieldCheck, UserRoundCog } from 'lucide-react'

import {
  DataRow,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from '#/components/DashboardPage'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { Input } from '#/components/ui/input'
import {
  configureAuthOAuthConnection,
  getActiveRuntimeConfig,
  listAuthOAuthConnections,
  listAuthProviders,
  type AuthOAuthConnection,
} from '#/lib/runtime-api'
import type { clientLoader as rootClientLoader } from '../root'
import type { Route } from './+types/auth'

export const handle = {
  pageLabel: 'Auth',
  sidebarTrail: ['Backend'],
} as const

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request)
  const [providers, connections] = await Promise.all([
    listAuthProviders(runtime),
    listAuthOAuthConnections(runtime),
  ])
  return { providers, connections }
}

function connectionDetail(connection: AuthOAuthConnection) {
  if (!connection.configured) return 'Not configured'
  return `${connection.clientId} · ${connection.redirectUri}${connection.hasClientSecret ? ' · secret set' : ''}`
}

function Auth() {
  const { providers, connections } = useLoaderData<typeof clientLoader>()
  const { runtime } = useRouteLoaderData<typeof rootClientLoader>('root')!
  const revalidator = useRevalidator()
  const [provider, setProvider] = useState('github')
  const [issuer, setIssuer] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [redirectUri, setRedirectUri] = useState('')
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setStatus('')
    try {
      await configureAuthOAuthConnection(runtime, provider.trim(), {
        ...(issuer.trim() ? { issuer: issuer.trim() } : {}),
        clientId: clientId.trim(),
        ...(clientSecret ? { clientSecret } : {}),
        redirectUri: redirectUri.trim(),
        enabled: true,
      })
      setClientSecret('')
      setStatus(`${provider.trim()} is configured and active.`)
      await revalidator.revalidate()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (connection: AuthOAuthConnection) => {
    setSaving(true)
    setStatus('')
    try {
      await configureAuthOAuthConnection(runtime, connection.provider, {
        ...(connection.issuer ? { issuer: connection.issuer } : {}),
        clientId: connection.clientId,
        redirectUri: connection.redirectUri,
        enabled: !connection.enabled,
      })
      await revalidator.revalidate()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const choosePreset = (name: 'github' | 'google') => {
    setProvider(name)
    setIssuer(name === 'google' ? 'https://accounts.google.com' : '')
    setRedirectUri(`${window.location.origin}${runtime.api.basePath}/auth/oauth/${name}/callback`)
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Password"
          value={providers.includes('password') ? 'active' : 'unavailable'}
          detail="Email or username with the built-in password ceremony."
          icon={ShieldCheck}
        />
        <StatCard
          label="Active providers"
          value={String(providers.length)}
          detail={providers.join(', ') || 'No credential providers registered'}
          icon={UserRoundCog}
        />
        <StatCard
          label="OAuth connections"
          value={String(connections.filter((entry) => entry.configured).length)}
          detail="Project-owned, write-only provider credentials."
          icon={PlugZap}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" />
            Sign-in providers
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="Email / password"
            detail="Built into Zelavis Auth; passwords are hashed and sessions are Project-scoped."
            meta={<StatusBadge state={providers.includes('password') ? 'active' : 'unavailable'} />}
          />
          {connections.map((connection) => (
            <DataRow
              key={connection.provider}
              label={connection.title ?? connection.provider}
              detail={connectionDetail(connection)}
              meta={connection.configured ? (
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={() => void toggle(connection)}
                >
                  {connection.enabled ? 'Disable' : 'Enable'}
                </Button>
              ) : <StatusBadge state="available" />}
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PlugZap className="size-4" />
            Configure OAuth or OpenID Connect
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3" onSubmit={save}>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => choosePreset('github')}>GitHub</Button>
              <Button type="button" variant="outline" onClick={() => choosePreset('google')}>Google</Button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="Provider name" required />
              <Input value={issuer} onChange={(event) => setIssuer(event.target.value)} placeholder="OIDC issuer URL (optional for GitHub)" />
              <Input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Client ID" required />
              <Input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder="Client secret (write-only)" />
              <Input className="md:col-span-2" value={redirectUri} onChange={(event) => setRedirectUri(event.target.value)} placeholder="Redirect URI" required />
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save provider'}</Button>
              {status ? <p className="text-sm text-muted-foreground" role="status">{status}</p> : null}
            </div>
          </form>
        </CardContent>
      </Card>

      <ResourceNotice
        title="Provider credentials belong to this Project"
        description="Secrets are write-only and remain in the Project runtime. Platform login providers and other Projects use separate configuration."
      />
    </section>
  )
}

export default Auth
