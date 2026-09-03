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
  bootstrapPlatformOwner,
  getAuthBootstrapStatus,
  getRuntimeConfig,
  type RuntimeAuthBootstrapStatus,
} from "#/lib/runtime-api"

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [status, setStatus] = React.useState<RuntimeAuthBootstrapStatus>()
  const [identifier, setIdentifier] = React.useState("")
  const [displayName, setDisplayName] = React.useState("")
  const [bootstrapToken, setBootstrapToken] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string>()
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    let active = true
    void getRuntimeConfig()
      .then(getAuthBootstrapStatus)
      .then((next) => {
        if (active) setStatus(next)
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      active = false
    }
  }, [])

  const providers = status?.required
    ? status.enrollmentProviders
    : status?.providers
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
    if (!status || !provider) return
    setSubmitting(true)
    setError(undefined)
    try {
      const config = await getRuntimeConfig()
      if (status.required) {
        await bootstrapPlatformOwner(config, {
          bootstrapToken,
          provider,
          account: {
            // The Platform derives the identity from the identifier, so the
            // form does not have to guess which field it belongs in.
            ...(acceptsEither
              ? {}
              : { email: identifier }),
            displayName,
          },
          credential: { identifier, password },
        })
      } else {
        await authenticatePlatform(config, provider, { identifier, password })
      }
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
            {status?.required ? "Create the first owner" : "Login to Zelavis"}
          </CardTitle>
          <CardDescription>
            {status?.required
              ? "Bootstrap this installation with its first Platform owner."
              : "Authenticate with an installed Zelavis auth provider."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <div className="flex flex-col gap-6">
              {status?.required ? (
                <>
                  <div className="grid gap-2">
                    <label htmlFor="bootstrapToken" className="text-sm font-medium leading-none">
                      Bootstrap token
                    </label>
                    <Input
                      id="bootstrapToken"
                      type="password"
                      value={bootstrapToken}
                      onChange={(event) => setBootstrapToken(event.target.value)}
                      autoComplete="off"
                      minLength={32}
                      required
                    />
                  </div>
                  <div className="grid gap-2">
                    <label htmlFor="displayName" className="text-sm font-medium leading-none">
                      Display name
                    </label>
                    <Input
                      id="displayName"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      autoComplete="name"
                    />
                  </div>
                </>
              ) : null}
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
                  autoComplete={status?.required ? "new-password" : "current-password"}
                  minLength={status?.required ? 15 : undefined}
                  required
                />
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {status && providers?.length === 0 ? (
                <p role="alert" className="text-sm text-destructive">
                  {status.required
                    ? "No credential-enrollment auth provider is available on this installation."
                    : "No interactive authentication provider is installed."}
                </p>
              ) : null}
              {status?.required && !status.available ? (
                <p role="alert" className="text-sm text-destructive">
                  Bootstrap is disabled. Configure ZELAVIS_BOOTSTRAP_TOKEN or
                  bootstrap.token and restart the Platform.
                </p>
              ) : null}
              <div className="flex flex-col gap-3">
                <Button
                  type="submit"
                  className="w-full"
                  disabled={
                    !status ||
                    !provider ||
                    submitting ||
                    (status.required && (!status.available || bootstrapToken.length < 32))
                  }
                >
                  {submitting
                    ? "Please wait…"
                    : status?.required
                      ? "Create owner"
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
