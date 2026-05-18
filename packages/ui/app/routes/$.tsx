import { DashboardNotFound } from '#/components/DashboardNotFound'
import { PluginPageMount } from '#/components/PluginPageMount'

export const handle = {
  pageLabel: "Not Found",
} as const;

function PluginFallbackRoute() {
  return <PluginPageMount fallback={<DashboardNotFound />} />
}

export default PluginFallbackRoute;
