import { createFileRoute } from '@tanstack/react-router'

import { EmptyPanel, PageHeader } from '#/components/DashboardPage'

export const Route = createFileRoute('/commerce/products')({
  component: CommerceProducts,
})

function CommerceProducts() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Commerce"
        title="Products"
        description="Catalog structure, pricing, variants, media, and publishing for the ecommerce plugin area."
      />
      <EmptyPanel
        title="Products surface is still a scaffold"
        description="This route exists to prove nested plugin-owned dashboard panels before the full ecommerce feature set lands."
      />
    </section>
  )
}
