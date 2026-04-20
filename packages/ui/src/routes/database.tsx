import { createFileRoute } from '@tanstack/react-router'
import { Braces, Database, Table2 } from 'lucide-react'

import { PageHeader, StatCard } from '#/components/DashboardPage'

export const Route = createFileRoute('/database')({ component: DatabaseRoute })

function DatabaseRoute() {
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
          value="enabled"
          detail="tenant-aware CRUD routes"
          icon={Braces}
        />
        <StatCard
          label="SQL"
          value="capability"
          detail="available when the integration supports it"
          icon={Table2}
        />
        <StatCard
          label="Driver"
          value="integration-owned"
          detail="Node, Cloudflare, Turso, Bun"
          icon={Database}
        />
      </section>
    </main>
  )
}
