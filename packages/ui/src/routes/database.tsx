import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Braces, Database, Table2 } from 'lucide-react'

import {
  DataRow,
  PageHeader,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from '#/components/DashboardPage'
import { Badge } from '#/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import {
  getDatabaseHealth,
  getRuntimeConfig,
  listDatabaseCollections,
  queryDatabaseDocuments,
} from '#/lib/runtime-api'
import { useRuntimeResource } from '#/lib/use-runtime-resource'

export const Route = createFileRoute('/database')({ component: DatabaseRoute })

function DatabaseRoute() {
  const [selectedCollection, setSelectedCollection] = useState<string>()
  const runtime = useRuntimeResource(getRuntimeConfig)
  const config = runtime.data
  const health = useRuntimeResource(
    async () => (config ? getDatabaseHealth(config) : undefined),
    [config],
  )
  const collections = useRuntimeResource(
    async () => (config ? listDatabaseCollections(config) : []),
    [config],
  )
  const selected = useMemo(
    () => selectedCollection ?? collections.data?.[0]?.name,
    [collections.data, selectedCollection],
  )
  const documents = useRuntimeResource(
    async () =>
      config && selected ? queryDatabaseDocuments(config, selected) : [],
    [config, selected],
  )
  const databaseHealth = health.data
  const collectionRows = collections.data ?? []
  const documentRows = documents.data ?? []

  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6">
      <PageHeader
        eyebrow="Database"
        title="Multi-model database"
        description="Document storage first, SQL capability preserved for adapters and integrations."
      />

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Documents"
          value={databaseHealth?.capabilities.documents ? 'enabled' : 'checking'}
          detail={`${collectionRows.length} collections visible`}
          icon={Braces}
        />
        <StatCard
          label="SQL"
          value={databaseHealth?.capabilities.sql ? 'enabled' : 'capability'}
          detail="available when the integration supports it"
          icon={Table2}
        />
        <StatCard
          label="Driver"
          value={databaseHealth?.driver ?? 'checking'}
          detail={`tenant ${databaseHealth?.defaultTenantId ?? 'default'}`}
          icon={Database}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(280px,0.45fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Collections</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {collectionRows.map((collection) => (
              <button
                key={`${collection.tenantId}:${collection.name}`}
                type="button"
                onClick={() => setSelectedCollection(collection.name)}
                className="block w-full border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-accent"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium">
                    {collection.name}
                  </span>
                  <StatusBadge
                    state={
                      selected === collection.name ? 'ready' : 'available'
                    }
                  />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {collection.documentCount} documents · {collection.tenantId}
                </p>
              </button>
            ))}
            {collectionRows.length === 0 ? (
              <div className="p-4">
                <ResourceNotice
                  title={
                    collections.loading ? 'Loading collections' : 'No collections yet'
                  }
                  description={
                    collections.error
                      ? 'The database collections endpoint is not reachable from this dashboard session.'
                      : 'Create a collection through the database API to browse documents here.'
                  }
                />
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-3">
              <span>{selected ?? 'Documents'}</span>
              {selected ? <Badge variant="outline">limit 25</Badge> : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {documentRows.map((document) => (
              <DataRow
                key={document.id}
                label={document.id}
                detail={JSON.stringify(document.data)}
                meta={<Badge variant="secondary">v{document.version}</Badge>}
              />
            ))}
            {documentRows.length === 0 ? (
              <div className="p-4">
                <ResourceNotice
                  title={
                    documents.loading && selected
                      ? 'Loading documents'
                      : 'No documents selected'
                  }
                  description={
                    selected
                      ? 'This collection is empty or the query endpoint returned no documents.'
                      : 'Select a collection to query documents.'
                  }
                />
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>
    </main>
  )
}
