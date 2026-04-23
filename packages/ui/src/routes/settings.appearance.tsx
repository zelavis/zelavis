import { createFileRoute } from '@tanstack/react-router'
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
import { useResolvedThemeMode, useThemeMode } from '#/lib/theme'

export const Route = createFileRoute('/settings/appearance')({
  component: AppearanceSettings,
})

function AppearanceSettings() {
  const [theme, setTheme] = useThemeMode()
  const settings = createDashboardSettings(undefined, theme)
  const resolvedTheme = useResolvedThemeMode(settings.theme)
  const themeLabel =
    settings.theme === 'auto'
      ? `System: ${resolvedTheme}`
      : settings.theme

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
            <ThemeSelect value={settings.theme} onValueChange={setTheme} />
          </label>
          <p className="text-sm text-muted-foreground">
            The setting is stored locally and can follow your system preference.
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
