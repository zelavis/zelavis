import { useRouteLoaderData } from "react-router"

import { SetupWizard } from "#/components/setup-wizard"
import type { clientLoader as rootClientLoader } from "../root"

export const handle = {
  pageLabel: "Setup",
} as const

export default function SetupPage() {
  const { controlRuntime, bootstrapStatus } = useRouteLoaderData<typeof rootClientLoader>("root")!
  return <SetupWizard runtime={controlRuntime} status={bootstrapStatus} />
}
