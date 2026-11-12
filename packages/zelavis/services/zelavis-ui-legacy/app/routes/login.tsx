import { useRouteLoaderData } from "react-router"

import { LoginForm } from "#/components/login-form"
import type { clientLoader as rootClientLoader } from "../root"

export const handle = {
  pageLabel: "Login",
} as const

export default function LoginPage() {
  const { controlRuntime, bootstrapStatus } = useRouteLoaderData<typeof rootClientLoader>("root")!
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <LoginForm runtime={controlRuntime} status={bootstrapStatus} />
      </div>
    </div>
  )
}
