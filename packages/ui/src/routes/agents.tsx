import { createFileRoute } from '@tanstack/react-router'

import { EmptyPanel, PageHeader } from '#/components/DashboardPage'

export const Route = createFileRoute('/agents')({ component: Agents })

function Agents() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Agents"
        title="Agent Console"
        description="Chat, tasks, and automation surfaces will live here."
      />
      <EmptyPanel
        title="No agents connected"
        description="The dashboard shell is ready for the agent service boundary."
      />
    </section>
  )
}
