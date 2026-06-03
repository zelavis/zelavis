import { useRouteLoaderData } from 'react-router'
import { StatusBadge } from '#/components/DashboardPage'
import type { clientLoader as rootClientLoader } from '../root'

export default function Footer() {
  const { runtime } = useRouteLoaderData<typeof rootClientLoader>('root')!
  const source = runtime.configSource ?? 'checking'

  return (
    <footer className="border-t px-4 py-4 text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-7xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span>Zelavis dashboard shell</span>
        <span className="flex flex-wrap items-center gap-2">
          <StatusBadge state={source} />
          <span>{runtime.api.basePath}</span>
        </span>
      </div>
    </footer>
  )
}
