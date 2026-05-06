import { createFileRoute } from '@tanstack/react-router'

import { EmptyPanel, PageHeader } from '#/components/DashboardPage'

export const Route = createFileRoute('/commerce/coupons')({
  component: CommerceCoupons,
})

function CommerceCoupons() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Commerce"
        title="Coupons"
        description="Discount rules, promotion codes, and redemption flow for the ecommerce plugin area."
      />
      <EmptyPanel
        title="Coupons surface is still a scaffold"
        description="This nested route keeps the plugin menu contract flexible while the real commerce model grows."
      />
    </section>
  )
}
