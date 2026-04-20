import { createFileRoute } from '@tanstack/react-router'

import { EmptyPanel, PageHeader } from '#/components/DashboardPage'

export const Route = createFileRoute('/builder')({ component: Builder })

function Builder() {
  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6">
      <PageHeader
        eyebrow="Builder"
        title="Website Builder"
        description="Visual building blocks and drag-and-drop editing will land here."
      />
      <EmptyPanel
        title="Canvas not mounted"
        description="This route is reserved for the builder service UI."
      />
    </main>
  )
}
