import { createFileRoute } from '@tanstack/react-router'
import { Paintbrush } from 'lucide-react'

import { PageHeader } from '#/components/DashboardPage'
import { ThemeSelect } from '#/components/ThemeSelect'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'

export const Route = createFileRoute('/settings/appearance')({
  component: AppearanceSettings,
})

function AppearanceSettings() {
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
            <ThemeSelect />
          </label>
          <p className="text-sm text-muted-foreground">
            The setting is stored locally and can follow your system preference.
          </p>
        </CardContent>
      </Card>
    </section>
  )
}
