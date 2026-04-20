import { createFileRoute } from '@tanstack/react-router'

import { DashboardNotFound } from '#/components/DashboardNotFound'

export const Route = createFileRoute('/$')({
  component: DashboardNotFound,
})
