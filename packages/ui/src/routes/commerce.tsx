import { createFileRoute } from '@tanstack/react-router'

import { EmptyPanel, PageHeader } from '#/components/DashboardPage'

export const Route = createFileRoute('/commerce')({ component: Commerce })

function Commerce() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Commerce"
        title="Commerce"
        description="Products, orders, coupons, payments, and provider plugins."
      />
      <EmptyPanel
        title="Commerce plugin not installed"
        description="Zelavis Ecommerce remains an official installable plugin."
      />
    </section>
  )
}
