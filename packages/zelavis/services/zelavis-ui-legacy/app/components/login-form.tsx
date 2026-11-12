import * as React from "react"
import { useNavigate, useSearchParams } from "react-router"

import { Button } from "#/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card"
import { Input } from "#/components/ui/input"
import { resolveReturnTo } from "#/lib/router-basename"
import { cn } from "#/lib/utils"
import {
  authenticatePlatform,
  type RuntimeConfig,
  type RuntimeAuthBootstrapStatus,
} from "#/lib/runtime-api"

export function LoginForm({
  className,
  runtime,
  status,
  ...props
}: React.ComponentProps<"div"> & {
  runtime: RuntimeConfig
  status: RuntimeAuthBootstrapStatus
}) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [identifier, setIdentifier] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string>()
  const [submitting, setSubmitting] = React.useState(false)

  const providers = status.providers
  // `password` is built into Zelavis and covers both identifier kinds, so it
  // is preferred when present; an installation that replaced it falls through
  // to whatever it does offer.
  const provider = providers?.includes("password")
    ? "password"
    : providers?.[0]
  // The built-in provider takes either kind, so the field must not be typed
  // `email` — that markup refuses a username before the request is made.
  const acceptsEither = provider === "password"
  const destination = resolveReturnTo(searchParams.get("returnTo"))

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!provider) return
    setSubmitting(true)
    setError(undefined)
    try {
      await authenticatePlatform(runtime, provider, { identifier, password })
      navigate(destination, { replace: true, viewTransition: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">
            Login to Zelavis
          </CardTitle>
          <CardDescription>
            Authenticate with an installed Zelavis auth provider.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <div className="flex flex-col gap-6">
              <div className="grid gap-2">
                <label
                  htmlFor="identifier"
                  className="text-sm font-medium leading-none select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  {acceptsEither ? "Email or username" : "Email"}
                </label>
                <Input
                  id="identifier"
                  type={acceptsEither ? "text" : "email"}
                  placeholder="owner@example.com"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
              <div className="grid gap-2">
                <div className="flex items-center">
                  <label
                    htmlFor="password"
                    className="text-sm font-medium leading-none select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Password
                  </label>
                </div>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {providers.length === 0 ? (
                <p role="alert" className="text-sm text-destructive">
                  No interactive authentication provider is installed.
                </p>
              ) : null}
              <div className="flex flex-col gap-3">
                <Button
                  type="submit"
                  className="w-full"
                  disabled={
                    !provider ||
                    submitting
                  }
                >
                  {submitting
                    ? "Please wait…"
                    : "Login"}
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
