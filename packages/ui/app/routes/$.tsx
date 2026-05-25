import { DashboardNotFound } from '#/components/DashboardNotFound'
import { ServicePageMount } from '#/components/ServicePageMount'

export const handle = {
  pageLabel: "Not Found",
} as const;

function ServiceFallbackRoute() {
  return <ServicePageMount fallback={<DashboardNotFound />} />
}

export default ServiceFallbackRoute;
