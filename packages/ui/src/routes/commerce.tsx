import { createFileRoute } from '@tanstack/react-router'

import { EmptyPanel, PageHeader } from '#/components/DashboardPage'

export const Route = createFileRoute('/commerce')({ component: Commerce })

function Commerce() {
  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6">
      <PageHeader
        eyebrow="Commerce"
        title="Commerce"
        description="Products, orders, coupons, payments, and provider plugins."
      />
      <EmptyPanel
        title="Commerce package not installed"
        description="Zelavis Ecommerce remains an official installable service."
      />
    </main>
  )
}
