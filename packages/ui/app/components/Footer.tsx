import { StatusBadge } from '#/components/DashboardPage'
import { getRuntimeConfig } from '#/lib/runtime-api'
import { useRuntimeResource } from '#/lib/use-runtime-resource'

export default function Footer() {
  const runtime = useRuntimeResource(getRuntimeConfig)
  const config = runtime.data
  const source = config?.configSource ?? (runtime.loading ? 'checking' : 'offline')

  return (
    <footer className="border-t px-4 py-4 text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-7xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span>Zelavis dashboard shell</span>
        <span className="flex flex-wrap items-center gap-2">
          <StatusBadge state={source} />
          <span>{config?.api.basePath ?? '/zelavis/api/v1'}</span>
        </span>
      </div>
    </footer>
  )
}
