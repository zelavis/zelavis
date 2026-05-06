import { createFileRoute } from '@tanstack/react-router'

import { EmptyPanel, PageHeader } from '#/components/DashboardPage'

export const Route = createFileRoute('/commerce/customers')({
  component: CommerceCustomers,
})

function CommerceCustomers() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Commerce"
        title="Customers"
        description="Customer records, lifecycle, and support-facing identity context for the ecommerce plugin area."
      />
      <EmptyPanel
        title="Customers surface is still a scaffold"
        description="This sits under Ecommerce > More to prove deeper plugin-owned sidebar slides."
      />
    </section>
  )
}
