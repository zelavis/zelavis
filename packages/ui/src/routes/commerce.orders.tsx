import { createFileRoute } from '@tanstack/react-router'

import { EmptyPanel, PageHeader } from '#/components/DashboardPage'

export const Route = createFileRoute('/commerce/orders')({
  component: CommerceOrders,
})

function CommerceOrders() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Commerce"
        title="Orders"
        description="Order flow, payment state, fulfillment, refunds, and operational review for the ecommerce plugin area."
      />
      <EmptyPanel
        title="Orders surface is still a scaffold"
        description="The dashboard route is live so we can validate the plugin menu tree and nested Workspace navigation."
      />
    </section>
  )
}
