import * as React from "react"
import { useNavigate } from "react-router"

import { getRuntimeConfig, logoutPlatform } from "#/lib/runtime-api"

export const handle = {
  pageLabel: "Logout",
} as const

export default function LogoutPage() {
  const navigate = useNavigate()

  React.useEffect(() => {
    let active = true
    void getRuntimeConfig()
      .then(logoutPlatform)
      .catch(() => undefined)
      .finally(() => {
        if (active) navigate("/login", { replace: true })
      })
    return () => {
      active = false
    }
  }, [navigate])

  return (
    <main className="grid min-h-[50vh] place-items-center">
      <p role="status" className="text-sm text-muted-foreground">
        Signing out…
      </p>
    </main>
  )
}
