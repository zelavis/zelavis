import { useState } from 'react'
import { useLoaderData, useRevalidator } from 'react-router'
import { KeyRound, UserRound, UsersRound } from 'lucide-react'

import { DataRow, ResourceNotice, StatCard, StatusBadge } from '#/components/DashboardPage'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { Input } from '#/components/ui/input'
import {
  createServiceAccount,
  getRuntimeConfig,
  listAuthAccounts,
  listServiceAccounts,
  revokeServiceAccount,
} from '#/lib/runtime-api'

export const handle = {
  pageLabel: 'Users',
  sidebarTrail: ['Access'],
} as const

export async function clientLoader() {
  const runtime = await getRuntimeConfig()
  const [accounts, serviceAccounts] = await Promise.all([
    listAuthAccounts(runtime),
    listServiceAccounts(runtime),
  ])
  return { accounts, serviceAccounts }
}

export default function AccessUsersRoute() {
  const { accounts, serviceAccounts } = useLoaderData<typeof clientLoader>()
  const revalidator = useRevalidator()
  const [name, setName] = useState('Fluxgent')
  const [projectId, setProjectId] = useState('')
  const [issuedToken, setIssuedToken] = useState('')
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const people = accounts.filter((account) => account.metadata?.principalType !== 'service')
  const ownerCount = people.filter((account) => account.roles?.includes('owner')).length

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setStatus('')
    setIssuedToken('')
    try {
      const runtime = await getRuntimeConfig()
      const grants = projectId.trim()
        ? ['project.view', 'project.runtime.manage', 'project.settings.manage', 'project.users.manage'].map((permission) => ({
            permission,
            scope: { type: 'project' as const, projectId: projectId.trim() },
          }))
        : []
      const result = await createServiceAccount(runtime, {
        name: name.trim(),
        permissions: ['projects.list', 'projects.create'],
        grants,
        expiresInDays: 365,
      })
      setIssuedToken(result.token)
      setStatus('Token issued. Copy it now; Zelavis will not show it again.')
      await revalidator.revalidate()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const revoke = async (accountId: string) => {
    setSaving(true)
    setStatus('')
    try {
      const runtime = await getRuntimeConfig()
      await revokeServiceAccount(runtime, accountId)
      await revalidator.revalidate()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-4">
      <section className="grid gap-4 md:grid-cols-3">
        <StatCard label="People" value={String(people.length)} detail={`${ownerCount} owner account${ownerCount === 1 ? '' : 's'}.`} icon={UserRound} />
        <StatCard label="Service accounts" value={String(serviceAccounts.length)} detail="Scoped machine identities for SDKs, CI, and agents." icon={KeyRound} />
        <StatCard label="Authority" value="core" detail="Users and clients share the same grants and endpoint enforcement." icon={UsersRound} />
      </section>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><UsersRound className="size-4" />Platform users</CardTitle></CardHeader>
        <CardContent className="p-0">
          {people.map((account) => (
            <DataRow
              key={account.id}
              label={account.displayName ?? account.email ?? account.username ?? account.id}
              detail={account.email ?? account.username ?? account.id}
              meta={<StatusBadge state={account.roles?.[0] ?? (account.verified ? 'verified' : 'unverified')} />}
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4" />Service accounts</CardTitle></CardHeader>
        <CardContent className="grid gap-4 p-4">
          <form className="grid gap-3 md:grid-cols-[1fr_1fr_auto]" onSubmit={create}>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Client name" required />
            <Input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="Project ID for scoped grants (optional)" />
            <Button type="submit" disabled={saving}>{saving ? 'Creating…' : 'Create client'}</Button>
          </form>
          {issuedToken ? (
            <div className="grid gap-2 rounded-2xl border border-border p-3">
              <p className="text-sm font-medium">One-time token</p>
              <Input value={issuedToken} readOnly aria-label="Issued service account token" />
            </div>
          ) : null}
          {status ? <p className="text-sm text-muted-foreground" role="status">{status}</p> : null}
        </CardContent>
        <CardContent className="p-0">
          {serviceAccounts.map((account) => (
            <DataRow
              key={account.id}
              label={account.displayName ?? account.id}
              detail={`${account.id} · ${account.grants?.length ?? 0} scoped grants`}
              meta={<Button variant="destructive" disabled={saving} onClick={() => void revoke(account.id)}>Revoke</Button>}
            />
          ))}
        </CardContent>
      </Card>

      <ResourceNotice
        title="Use service accounts for software"
        description="Fluxgent, CI, scripts, and agents should use revocable service tokens. They should never reuse an owner's browser session or an app user's credentials."
      />
    </section>
  )
}
