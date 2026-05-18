import { Moon, Paintbrush, Sun } from 'lucide-react'

import { PageHeader } from '#/components/DashboardPage'
import { ThemeSelect } from '#/components/ThemeSelect'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import { createDashboardSettings } from '#/lib/dashboard-settings'
import {
  getDashboardSettings,
  getRuntimeConfig,
  updateDashboardSettings,
} from '#/lib/runtime-api'
import { useResolvedThemeMode, useThemeMode } from '#/lib/theme'
import { useRuntimeResource } from '#/lib/use-runtime-resource'

export const handle = {
  pageLabel: "Settings",
  sidebarTrail: ["Settings"],
} as const;

function AppearanceSettings() {
  const runtime = useRuntimeResource(getRuntimeConfig)
  const config = runtime.data
  const remoteSettings = useRuntimeResource(
    async () => (config ? getDashboardSettings(config) : undefined),
    [config],
  )
  const [theme, setTheme] = useThemeMode(remoteSettings.data?.theme ?? 'auto')
  const settings = createDashboardSettings(config, theme, remoteSettings.data)
  const resolvedTheme = useResolvedThemeMode(settings.theme)
  const themeLabel =
    settings.theme === 'auto'
      ? `System: ${resolvedTheme}`
      : settings.theme
  const themeDescription =
    settings.persistence === 'runtime'
      ? 'The workspace default comes from the runtime. This browser can still override it locally.'
      : 'The setting is stored locally and can follow your system preference.'

  async function handleThemeChange(nextTheme: typeof theme) {
    setTheme(nextTheme)

    if (!config || !settings.editable.theme) {
      return
    }

    await updateDashboardSettings(config, {
      theme: nextTheme,
    })
    remoteSettings.reload()
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Appearance"
        description="Dashboard theme preferences for this browser."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Paintbrush className="size-4" />
            Theme
          </CardTitle>
          <CardDescription>
            Choose how the Zelavis dashboard should render for this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <label className="grid gap-2 text-sm font-medium text-foreground">
            Mode
            <ThemeSelect value={settings.theme} onValueChange={handleThemeChange} />
          </label>
          <p className="text-sm text-muted-foreground">
            {themeDescription}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preview</CardTitle>
          <CardDescription>
            The preview uses the active dashboard tokens.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 rounded-lg border bg-background p-4 sm:grid-cols-[1fr_auto] sm:items-center">
            <div className="grid gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                {resolvedTheme === 'dark' ? (
                  <Moon className="size-4" />
                ) : (
                  <Sun className="size-4" />
                )}
                Current theme: {themeLabel}
              </div>
              <p className="text-sm text-muted-foreground">
                Surface, border, accent, and text colors should stay neutral in
                both light and dark mode.
              </p>
            </div>
            <div className="flex min-w-44 items-center justify-between gap-3 rounded-md border bg-muted px-3 py-2">
              <span className="size-3 rounded-full bg-primary" />
              <span className="text-sm font-medium">Dashboard control</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}

export default AppearanceSettings;
