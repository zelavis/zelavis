import { Outlet, createFileRoute } from '@tanstack/react-router'

import { DataRow, EmptyPanel, PageHeader, StatusBadge } from '#/components/DashboardPage'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'

export const Route = createFileRoute('/commerce')({ component: Commerce })

function Commerce() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Commerce"
        title="Commerce"
        description="Products, orders, customers, coupons, payments, and provider plugins."
      />
      <Card>
        <CardHeader>
          <CardTitle>Plugin workspace tree</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="Products"
            detail="Catalog, pricing, variants, inventory, and publishing workflows."
            meta={<StatusBadge state="ready" />}
          />
          <DataRow
            label="Orders"
            detail="Checkout outcomes, fulfillment flow, refunds, and status transitions."
            meta={<StatusBadge state="ready" />}
          />
          <DataRow
            label="More"
            detail="A nested plugin-owned slide for deeper surfaces such as customers and coupons."
            meta={<StatusBadge state="ready" />}
          />
        </CardContent>
      </Card>
      <EmptyPanel
        title="Official plugin workspace scaffold"
        description="This area now proves the plugin menu contract with nested Workspace panels while the full ecommerce runtime stays in progress."
      />
      <Outlet />
    </section>
  )
}
