import { Link, Outlet, createFileRoute, useLocation } from '@tanstack/react-router'
import type * as React from 'react'
import { useEffect, useState } from 'react'
import { Boxes, Paintbrush, Save } from 'lucide-react'

import { DataRow, PageHeader, ResourceNotice } from '#/components/DashboardPage'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { Input } from '#/components/ui/input'
import { createDashboardSettings } from '#/lib/dashboard-settings'
import {
  getDashboardSettings,
  getRuntimeConfig,
  updateDashboardSettings,
} from '#/lib/runtime-api'
import { useThemeMode } from '#/lib/theme'
import { useRuntimeResource } from '#/lib/use-runtime-resource'

export const Route = createFileRoute('/settings')({ component: Settings })

function Settings() {
  const location = useLocation()
  const runtime = useRuntimeResource(getRuntimeConfig)
  const config = runtime.data
  const remoteSettings = useRuntimeResource(
    async () => (config ? getDashboardSettings(config) : undefined),
    [config],
  )
  const [theme] = useThemeMode()
  const settings = createDashboardSettings(config, theme, remoteSettings.data)
  const rootPathValue = settings.pendingRootPath ?? settings.rootPath
  const [draftRootPath, setDraftRootPath] = useState(rootPathValue)
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const canEditRootPath = settings.editable.rootPath && Boolean(config)
  const rootPathChanged = draftRootPath.trim() !== rootPathValue

  useEffect(() => {
    setDraftRootPath(rootPathValue)
  }, [rootPathValue])

  if (location.pathname.endsWith('/settings/appearance')) {
    return <Outlet />
  }

  async function handleRootPathSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!config || !canEditRootPath || !rootPathChanged) {
      return
    }

    setSaving(true)
    setMessage(undefined)
    setError(undefined)

    try {
      const nextSettings = await updateDashboardSettings(config, {
        rootPath: draftRootPath,
      })
      remoteSettings.reload()
      setMessage(
        nextSettings.restartRequired
          ? `Saved ${nextSettings.pendingRootPath}. Restart the runtime to apply the new root path.`
          : 'Root path saved.',
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Runtime Settings"
        description="Root path, API version, and enabled core plugins."
        actions={
          <Button
            type="submit"
            size="sm"
            form="dashboard-root-path-form"
            disabled={!canEditRootPath || !rootPathChanged || saving}
          >
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
          <DataRow label="Root path" detail={settings.rootPath} />
          <DataRow label="API prefix" detail={settings.apiBasePath} />
          <DataRow
            label="Runtime config"
            detail={config?.configSource ?? 'checking'}
          />
          <DataRow
            label="Core plugins"
            detail={
              config?.services
                .filter((service) => service.core)
                .map((service) => service.name)
                .join(', ') ?? 'dashboard, auth, database'
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Root Path</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 p-4">
          <form
            id="dashboard-root-path-form"
            className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
            onSubmit={handleRootPathSubmit}
          >
            <label className="grid gap-2 text-sm font-medium text-foreground">
              Path
              <Input
                value={draftRootPath}
                onChange={(event) => setDraftRootPath(event.target.value)}
                readOnly={!canEditRootPath}
                disabled={saving}
              />
            </label>
            <Button
              type="submit"
              size="sm"
              disabled={!canEditRootPath || !rootPathChanged || saving}
              className="self-end"
            >
              <Save className="size-4" />
              Save
            </Button>
          </form>
          {settings.restartRequired ? (
            <ResourceNotice
              title="Restart required"
              description={`The active dashboard is still served from ${settings.rootPath}. The pending root path is ${settings.pendingRootPath}.`}
            />
          ) : null}
          {message ? <ResourceNotice title="Saved" description={message} /> : null}
          {error ? <ResourceNotice title="Action failed" description={error} /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Paintbrush className="size-4" />
            Appearance
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="Persistence"
            detail={
              settings.persistence === 'read-only'
                ? 'Read-only until runtime settings storage is available.'
                : 'Runtime settings storage is available. Root path changes apply after restart.'
            }
          />
          <DataRow
            label="Theme"
            detail="Configure dashboard light, dark, or system mode."
            meta={
              <Link
                to="/settings/appearance"
                className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground no-underline shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                Open
              </Link>
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Boxes className="size-4" />
            Runtime Plugins
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="Mounted plugins"
            detail="Inspect core plugins and plugin-provided runtime pieces registered in this runtime."
            meta={
              <Link
                to="/services"
                className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground no-underline shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                Open
              </Link>
            }
          />
        </CardContent>
      </Card>
    </section>
  )
}
