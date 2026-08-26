import { Link, Outlet, useLocation, useRevalidator, useRouteLoaderData } from 'react-router'
import type * as React from 'react'
import { useEffect, useState } from 'react'
import { Boxes, Cpu, Paintbrush, Save } from 'lucide-react'

import { DataRow, ResourceNotice } from '#/components/DashboardPage'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { Input } from '#/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { createDashboardSettings } from '#/lib/dashboard-settings'
import { updateDashboardSettings } from '#/lib/runtime-api'
import type { RuntimeEngine } from '#/lib/runtime-api'
import { useThemeMode } from '#/lib/theme'
import type { clientLoader as rootClientLoader } from '../root'

export const handle = {
  pageLabel: "Settings",
} as const;

function Settings() {
  const location = useLocation()
  const revalidator = useRevalidator()
  const { runtime, settings: remoteSettings } = useRouteLoaderData<typeof rootClientLoader>('root')!
  const [theme] = useThemeMode()
  const settings = createDashboardSettings(runtime, theme, remoteSettings)
  const rootPathValue = settings.pendingRootPath ?? settings.rootPath
  const runtimeEngineValue = settings.runtimeEngine.desired
  const [draftRootPath, setDraftRootPath] = useState(rootPathValue)
  const [draftRuntimeEngine, setDraftRuntimeEngine] =
    useState<RuntimeEngine>(runtimeEngineValue)
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [runtimeSaving, setRuntimeSaving] = useState(false)
  const canEditRootPath = settings.editable.rootPath
  const canEditRuntimeEngine = settings.editable.runtimeEngine
  const rootPathChanged = draftRootPath.trim() !== rootPathValue
  const runtimeEngineChanged = draftRuntimeEngine !== runtimeEngineValue

  useEffect(() => {
    setDraftRootPath(rootPathValue)
  }, [rootPathValue])

  useEffect(() => {
    setDraftRuntimeEngine(runtimeEngineValue)
  }, [runtimeEngineValue])

  if (location.pathname.endsWith('/settings/appearance')) {
    return <Outlet />
  }

  async function handleRootPathSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!canEditRootPath || !rootPathChanged) {
      return
    }

    setSaving(true)
    setMessage(undefined)
    setError(undefined)

    try {
      const nextSettings = await updateDashboardSettings(runtime, {
        rootPath: draftRootPath,
      })
      revalidator.revalidate()
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

  async function handleRuntimeEngineSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!canEditRuntimeEngine || !runtimeEngineChanged) {
      return
    }

    setRuntimeSaving(true)
    setMessage(undefined)
    setError(undefined)

    try {
      const nextSettings = await updateDashboardSettings(runtime, {
        runtimeEngine: draftRuntimeEngine,
      })
      revalidator.revalidate()
      setMessage(
        nextSettings.runtimeEngine.restartRequired
          ? `Saved ${nextSettings.runtimeEngine.desired}. Restart the runtime to switch engines.`
          : 'Runtime engine saved.',
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setRuntimeSaving(false)
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <div className="flex justify-end">
        <Button
          type="submit"
          form="dashboard-root-path-form"
          disabled={!canEditRootPath || !rootPathChanged || saving}
        >
          <Save className="size-4" />
          Save
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow label="Root path" detail={settings.rootPath} />
          <DataRow label="API prefix" detail={settings.apiBasePath} />
          <DataRow
            label="Runtime config"
            detail={runtime.configSource ?? 'checking'}
          />
          <DataRow
            label="Runtime engine"
            detail={
              settings.runtimeEngine.restartRequired
                ? `${settings.runtimeEngine.current} now, ${settings.runtimeEngine.desired} after restart`
                : settings.runtimeEngine.current
            }
          />
          <DataRow
            label="Core services"
            detail={
              runtime.services
                .filter((service) => service.core)
                .map((service) => service.name)
                .join(', ') || 'dashboard, auth, database'
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cpu className="size-4" />
            Runtime Engine
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 p-4">
          <form
            id="runtime-engine-form"
            className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
            onSubmit={handleRuntimeEngineSubmit}
          >
            <label className="grid gap-2 text-sm font-medium text-foreground">
              Engine
              <Select
                value={draftRuntimeEngine}
                onValueChange={(value) => setDraftRuntimeEngine(value as RuntimeEngine)}
                disabled={!canEditRuntimeEngine || runtimeSaving}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  {settings.runtimeEngine.available.map((engine) => (
                    <SelectItem key={engine} value={engine}>
                      {engine}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <Button
              type="submit"
              disabled={!canEditRuntimeEngine || !runtimeEngineChanged || runtimeSaving}
              className="self-end"
            >
              <Save className="size-4" />
              Save
            </Button>
          </form>
          {settings.runtimeEngine.restartRequired ? (
            <ResourceNotice
              title="Restart required"
              description={`The active runtime is ${settings.runtimeEngine.current}. The pending runtime engine is ${settings.runtimeEngine.desired}.`}
            />
          ) : null}
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
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link to="/settings/appearance" />}
              >
                Open
              </Button>
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Boxes className="size-4" />
            Runtime Services
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="Mounted services"
            detail="Inspect core services and service-provided runtime pieces registered in this runtime."
            meta={
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link to="/services" />}
              >
                Open
              </Button>
            }
          />
        </CardContent>
      </Card>
    </section>
  )
}

export default Settings;
