import { createFileRoute } from '@tanstack/react-router'

import { EmptyPanel, PageHeader } from '#/components/DashboardPage'

export const Route = createFileRoute('/content')({ component: Content })

function Content() {
  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6">
      <PageHeader
        eyebrow="Content"
        title="Content Studio"
        description="Collections, entries, media, and publishing tools will land here."
      />
      <EmptyPanel
        title="No collections"
        description="The content surface is ready for the first schema."
      />
    </main>
  )
}
