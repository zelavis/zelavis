import { createFileRoute } from '@tanstack/react-router'
import { KeyRound, ShieldCheck, UserRoundCog } from 'lucide-react'

import { PageHeader, StatCard } from '#/components/DashboardPage'

export const Route = createFileRoute('/auth')({ component: Auth })

function Auth() {
  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6">
      <PageHeader
        eyebrow="Auth"
        title="Authentication"
        description="Core auth service with provider plugins mounted through the runtime."
      />

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Service"
          value="enabled"
          detail="/api/v1/auth"
          icon={ShieldCheck}
        />
        <StatCard
          label="Providers"
          value="plugin-based"
          detail="email, username, and future methods"
          icon={UserRoundCog}
        />
        <StatCard
          label="Sessions"
          value="contract-first"
          detail="storage stays behind service boundaries"
          icon={KeyRound}
        />
      </section>
    </main>
  )
}
