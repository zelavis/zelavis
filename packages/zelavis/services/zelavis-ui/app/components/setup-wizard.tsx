import * as React from "react"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Globe,
  KeyRound,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
} from "lucide-react"
import { useNavigate } from "react-router"

import { ZelavisMark } from "#/components/zelavis-mark"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import {
  bootstrapPlatformOwner,
  getEdgeStatus,
  preflightEdgeHostname,
  onboardEdgeHostname,
  type RuntimeConfig,
  type RuntimeAuthBootstrapStatus,
  type RuntimeEdgeStatus,
} from "#/lib/runtime-api"
import {
  parseAsStringLiteral,
  useTypedSearchParam,
} from "#/lib/use-typed-search-params"
import { cn } from "#/lib/utils"

const setupStepParser = parseAsStringLiteral([
  "welcome",
  "owner",
  "security",
  "edge",
] as const).withDefault("welcome")

const steps = [
  { id: "welcome", label: "Welcome" },
  { id: "owner", label: "Owner" },
  { id: "security", label: "Security" },
  { id: "edge", label: "Edge" },
] as const

export function SetupWizard({
  runtime,
  status,
}: {
  runtime: RuntimeConfig
  status: RuntimeAuthBootstrapStatus
}) {
  const navigate = useNavigate()
  const [step, setStep] = useTypedSearchParam("step", setupStepParser)
  const [provider, setProvider] = React.useState(
    status.enrollmentProviders.includes("password")
      ? "password"
      : status.enrollmentProviders[0] ?? "",
  )
  const [identifier, setIdentifier] = React.useState("")
  const [displayName, setDisplayName] = React.useState("")
  const [bootstrapToken, setBootstrapToken] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [passwordConfirmation, setPasswordConfirmation] = React.useState("")
  const [error, setError] = React.useState<string>()
  const [submitting, setSubmitting] = React.useState(false)
  const [completed, setCompleted] = React.useState(false)
  const [edgeStatus, setEdgeStatus] = React.useState<RuntimeEdgeStatus>()
  const [edgeError, setEdgeError] = React.useState<string>()
  const [edgeLoading, setEdgeLoading] = React.useState(false)
  const [edgeMode, setEdgeMode] = React.useState<"managed" | "external" | "later">("managed")
  const [edgeHostname, setEdgeHostname] = React.useState("")
  const [edgePreflight, setEdgePreflight] = React.useState<{ valid: boolean; dnsResolved: boolean; error?: string }>()
  const [onboardingSubmitting, setOnboardingSubmitting] = React.useState(false)

  const acceptsUsername = provider === "password"
  const currentIndex = steps.findIndex((candidate) => candidate.id === step)
  const canBegin = status.available && status.enrollmentProviders.length > 0

  async function checkHostname(name: string) {
    const trimmed = name.trim()
    if (!trimmed) {
      setEdgePreflight(undefined)
      return
    }
    try {
      const res = await preflightEdgeHostname(runtime, trimmed)
      setEdgePreflight(res)
    } catch {
      setEdgePreflight(undefined)
    }
  }

  async function handleEdgeSubmit() {
    if (edgeMode === "later") {
      setCompleted(true)
      return
    }
    if (!edgeHostname.trim()) {
      setEdgeError("Please enter a platform hostname.")
      return
    }
    setOnboardingSubmitting(true)
    setEdgeError(undefined)
    try {
      const res = await onboardEdgeHostname(runtime, {
        mode: edgeMode,
        hostname: edgeHostname.trim(),
      })
      if (res.status === "failed") {
        setEdgeError(res.error ?? "Hostname onboarding failed.")
      } else {
        setCompleted(true)
      }
    } catch (cause) {
      setEdgeError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOnboardingSubmitting(false)
    }
  }

  function continueFromOwner() {
    if (!identifier.trim()) {
      setError(acceptsUsername ? "Enter an email or username." : "Enter an email address.")
      return
    }
    setError(undefined)
    setStep("security", { replace: false })
  }

  async function loadEdgeStatus() {
    setEdgeLoading(true)
    setEdgeError(undefined)
    try {
      setEdgeStatus(await getEdgeStatus(runtime))
    } catch (cause) {
      setEdgeStatus(undefined)
      setEdgeError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setEdgeLoading(false)
    }
  }

  async function createOwner(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(undefined)
    if (bootstrapToken.length < 32) {
      setError("The bootstrap token must contain at least 32 characters.")
      return
    }
    if (password.length < 15) {
      setError("Use an owner password with at least 15 characters.")
      return
    }
    if (password !== passwordConfirmation) {
      setError("The passwords do not match.")
      return
    }

    setSubmitting(true)
    try {
      const identity = identifier.trim()
      await bootstrapPlatformOwner(runtime, {
        bootstrapToken,
        provider,
        account: {
          ...(acceptsUsername && !identity.includes("@")
            ? { username: identity }
            : { email: identity }),
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        },
        credential: { identifier: identity, password },
      })
      setStep("edge", { replace: false })
      await loadEdgeStatus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="setup-canvas relative min-h-svh overflow-y-auto bg-background text-foreground">
      <div aria-hidden="true" className="setup-orb setup-orb-one" />
      <div aria-hidden="true" className="setup-orb setup-orb-two" />
      <div className="relative mx-auto grid min-h-svh w-full max-w-7xl lg:grid-cols-[0.9fr_1.1fr]">
        <section className="flex flex-col justify-between gap-12 px-6 py-8 sm:px-10 lg:px-14 lg:py-12">
          <div className="flex items-center gap-3 text-sm font-semibold tracking-tight">
            <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
              <ZelavisMark className="size-5" />
            </span>
            Zelavis
          </div>

          <div className="max-w-xl space-y-6 py-8 lg:py-16">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
              <Sparkles className="size-3.5" />
              First-run setup
            </div>
            <h1 className="font-heading text-4xl font-semibold tracking-[-0.04em] sm:text-5xl lg:text-6xl">
              Your App Platform is online.
            </h1>
            <p className="max-w-lg text-base leading-7 text-muted-foreground sm:text-lg">
              Create the first Platform owner, secure this installation, and start building. This wizard uses the same one-time bootstrap API as the CLI.
            </p>
            <div className="grid gap-3 pt-3 text-sm sm:grid-cols-2">
              <div className="rounded-2xl border bg-background/60 p-4 backdrop-blur">
                <Server className="mb-3 size-5 text-primary" />
                <div className="font-medium">Platform reachable</div>
                <div className="mt-1 text-muted-foreground">Runtime and dashboard are responding.</div>
              </div>
              <div className="rounded-2xl border bg-background/60 p-4 backdrop-blur">
                <ShieldCheck className="mb-3 size-5 text-primary" />
                <div className="font-medium">One-time claim</div>
                <div className="mt-1 text-muted-foreground">No second owner can use bootstrap.</div>
              </div>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Zelavis — The App Platform.
          </p>
        </section>

        <section className="flex items-center justify-center border-t bg-card/65 px-4 py-10 backdrop-blur-xl sm:px-8 lg:border-l lg:border-t-0">
          <div className="w-full max-w-xl">
            <ol aria-label="Setup progress" className="mb-8 grid grid-cols-4 gap-2">
              {steps.map((candidate, index) => {
                const active = candidate.id === step
                const passed = index < currentIndex || completed
                return (
                  <li key={candidate.id} className="grid gap-2 text-xs">
                    <div className={cn("h-1 rounded-full transition-colors duration-500", active || passed ? "bg-primary" : "bg-muted")} />
                    <span className={cn(active ? "font-medium text-foreground" : "text-muted-foreground")}>{candidate.label}</span>
                  </li>
                )
              })}
            </ol>

            <div key={completed ? "complete" : step} className="setup-panel rounded-3xl border bg-card p-6 shadow-2xl shadow-foreground/5 sm:p-8">
              {completed ? (
                <div className="grid min-h-96 place-items-center text-center">
                  <div>
                    <span className="mx-auto mb-6 grid size-16 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-xl shadow-primary/20">
                      <Check className="size-8" />
                    </span>
                    <h2 className="text-2xl font-semibold tracking-tight">Zelavis is ready</h2>
                    <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
                      The owner account is active and this bootstrap route is now permanently closed.
                    </p>
                    <Button className="mt-8" onClick={() => navigate("/", { replace: true, viewTransition: true })}>
                      Open dashboard
                      <ArrowRight data-icon="inline-end" />
                    </Button>
                  </div>
                </div>
              ) : step === "welcome" ? (
                <div className="flex min-h-96 flex-col">
                  <div className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
                    <ZelavisMark className="size-6" />
                  </div>
                  <h2 className="mt-8 text-2xl font-semibold tracking-tight">Let’s set up your Platform</h2>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    You’ll create one owner account. Keep the bootstrap token private; it is only used for this claim and never becomes your login credential.
                  </p>
                  <div className="mt-6 space-y-3 rounded-2xl bg-muted/60 p-4 text-sm">
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-muted-foreground">Bootstrap token</span>
                      <span className={cn("font-medium", status.available ? "text-foreground" : "text-destructive")}>{status.available ? "Configured" : "Missing"}</span>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-muted-foreground">Enrollment providers</span>
                      <span className="font-medium">{status.enrollmentProviders.length || "None"}</span>
                    </div>
                  </div>
                  {!canBegin ? (
                    <p role="alert" className="mt-5 rounded-2xl border border-destructive/20 bg-destructive/5 p-4 text-sm leading-6 text-destructive">
                      {!status.available
                        ? "Configure ZELAVIS_BOOTSTRAP_TOKEN with at least 32 characters and restart Zelavis."
                        : "Install a credential-enrollment auth provider and restart Zelavis."}
                    </p>
                  ) : null}
                  <div className="mt-auto flex justify-end pt-8">
                    <Button disabled={!canBegin} onClick={() => setStep("owner", { replace: false })}>
                      Get started
                      <ArrowRight data-icon="inline-end" />
                    </Button>
                  </div>
                </div>
              ) : step === "owner" ? (
                <div className="flex min-h-96 flex-col">
                  <div className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
                    <Sparkles className="size-6" />
                  </div>
                  <h2 className="mt-8 text-2xl font-semibold tracking-tight">Create the Platform owner</h2>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">This account receives full Platform authority. Additional users can be invited with narrower permissions later.</p>
                  <div className="mt-7 grid gap-5">
                    {status.enrollmentProviders.length > 1 ? (
                      <div className="grid gap-2">
                        <label htmlFor="setup-provider" className="text-sm font-medium">Credential provider</label>
                        <select id="setup-provider" value={provider} onChange={(event) => setProvider(event.target.value)} className="h-9 rounded-xl border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
                          {status.enrollmentProviders.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                      </div>
                    ) : null}
                    <div className="grid gap-2">
                      <label htmlFor="setup-identifier" className="text-sm font-medium">{acceptsUsername ? "Email or username" : "Email"}</label>
                      <Input id="setup-identifier" type={acceptsUsername ? "text" : "email"} value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="owner@example.com" autoComplete="username" autoFocus required />
                    </div>
                    <div className="grid gap-2">
                      <label htmlFor="setup-name" className="text-sm font-medium">Display name <span className="font-normal text-muted-foreground">Optional</span></label>
                      <Input id="setup-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Platform Owner" autoComplete="name" />
                    </div>
                  </div>
                  {error ? <p role="alert" className="mt-4 text-sm text-destructive">{error}</p> : null}
                  <div className="mt-auto flex items-center justify-between gap-3 pt-8">
                    <Button variant="ghost" onClick={() => { setError(undefined); setStep("welcome", { replace: false }) }}><ArrowLeft data-icon="inline-start" />Back</Button>
                    <Button onClick={continueFromOwner}>Continue<ArrowRight data-icon="inline-end" /></Button>
                  </div>
                </div>
              ) : step === "security" ? (
                <form className="flex min-h-96 flex-col" onSubmit={createOwner}>
                  <div className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
                    <KeyRound className="size-6" />
                  </div>
                  <h2 className="mt-8 text-2xl font-semibold tracking-tight">Secure the installation</h2>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">Prove you control this installation, then choose the password you’ll use to sign in.</p>
                  <div className="mt-7 grid gap-5">
                    <div className="grid gap-2">
                      <label htmlFor="setup-token" className="text-sm font-medium">One-time bootstrap token</label>
                      <Input id="setup-token" type="password" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} autoComplete="off" minLength={32} required autoFocus />
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="grid gap-2">
                        <label htmlFor="setup-password" className="text-sm font-medium">Owner password</label>
                        <Input id="setup-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={15} required />
                      </div>
                      <div className="grid gap-2">
                        <label htmlFor="setup-password-confirm" className="text-sm font-medium">Confirm password</label>
                        <Input id="setup-password-confirm" type="password" value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} autoComplete="new-password" minLength={15} required />
                      </div>
                    </div>
                  </div>
                  {error ? <p role="alert" className="mt-4 text-sm text-destructive">{error}</p> : null}
                  <div className="mt-auto flex items-center justify-between gap-3 pt-8">
                    <Button type="button" variant="ghost" onClick={() => { setError(undefined); setStep("owner", { replace: false }) }}><ArrowLeft data-icon="inline-start" />Back</Button>
                    <Button type="submit" disabled={submitting}>{submitting ? "Creating owner…" : "Finish setup"}<ShieldCheck data-icon="inline-end" /></Button>
                  </div>
                </form>
              ) : (
                <div className="flex min-h-96 flex-col">
                  <div className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
                    <Network className="size-6" />
                  </div>
                  <h2 className="mt-8 text-2xl font-semibold tracking-tight">Connect Zelavis Edge</h2>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    Edge owns public routing and TLS independently of Traefik, Caddy, or another reverse proxy. This check never makes an unverified proxy live.
                  </p>
                  <div className="mt-7 space-y-3">
                    {edgeStatus?.adapters.map((adapter) => (
                      <div key={adapter.id} className="flex items-start justify-between gap-4 rounded-2xl border p-4 text-sm">
                        <div>
                          <div className="font-medium">{adapter.title}</div>
                          <div className="mt-1 text-muted-foreground">
                            {adapter.detection.version ? `Version ${adapter.detection.version}` : adapter.detection.detail ?? "Version unavailable"}
                          </div>
                        </div>
                        <span className={cn(
                          "rounded-full px-2.5 py-1 text-xs font-medium",
                          adapter.detection.state === "available"
                            ? "bg-primary/10 text-primary"
                            : "bg-muted text-muted-foreground",
                        )}>
                          {adapter.active ? "Active" : adapter.detection.state}
                        </span>
                      </div>
                    ))}
                    {edgeLoading ? (
                      <div className="flex items-center gap-2 rounded-2xl bg-muted/60 p-4 text-sm text-muted-foreground">
                        <RefreshCw className="size-4 animate-spin" />
                        Checking installed reverse proxies…
                      </div>
                    ) : null}
                    {edgeError ? (
                      <p role="alert" className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm leading-6 text-amber-700 dark:text-amber-300">
                        Edge host integration is not ready yet: {edgeError} You can finish owner setup without publishing a hostname.
                      </p>
                    ) : null}
                    {!edgeLoading && !edgeError && edgeStatus?.adapters.length === 0 ? (
                      <p className="rounded-2xl bg-muted/60 p-4 text-sm leading-6 text-muted-foreground">
                        No reverse-proxy adapters are installed. Zelavis remains reachable on its private listener until one is provisioned.
                      </p>
                    ) : null}
                  </div>

                  {/* Hostname Onboarding Section */}
                  <div className="mt-6 space-y-3">
                    <div className="text-sm font-medium">Platform Hostname & Ingress</div>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <button
                        type="button"
                        onClick={() => setEdgeMode("managed")}
                        className={cn(
                          "flex flex-col items-start rounded-xl border p-3 text-left text-xs transition-colors",
                          edgeMode === "managed" ? "border-primary bg-primary/5 text-primary" : "border-border hover:bg-muted/50",
                        )}
                      >
                        <span className="font-semibold">Managed HTTPS</span>
                        <span className="mt-1 text-muted-foreground text-[11px]">Automatic TLS & reachability check</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setEdgeMode("external")}
                        className={cn(
                          "flex flex-col items-start rounded-xl border p-3 text-left text-xs transition-colors",
                          edgeMode === "external" ? "border-primary bg-primary/5 text-primary" : "border-border hover:bg-muted/50",
                        )}
                      >
                        <span className="font-semibold">External TLS</span>
                        <span className="mt-1 text-muted-foreground text-[11px]">Terminated by upstream proxy</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setEdgeMode("later")}
                        className={cn(
                          "flex flex-col items-start rounded-xl border p-3 text-left text-xs transition-colors",
                          edgeMode === "later" ? "border-primary bg-primary/5 text-primary" : "border-border hover:bg-muted/50",
                        )}
                      >
                        <span className="font-semibold">Configure later</span>
                        <span className="mt-1 text-muted-foreground text-[11px]">Private listener only</span>
                      </button>
                    </div>

                    {edgeMode !== "later" ? (
                      <div className="space-y-2 pt-2">
                        <label htmlFor="edgeHostname" className="text-xs font-medium text-foreground">
                          Platform Hostname (FQDN)
                        </label>
                        <Input
                          id="edgeHostname"
                          placeholder="e.g. panel.example.com"
                          value={edgeHostname}
                          onChange={(e) => {
                            setEdgeHostname(e.target.value)
                            void checkHostname(e.target.value)
                          }}
                          className="h-10"
                        />
                        {edgePreflight ? (
                          <p
                            className={cn(
                              "text-xs",
                              edgePreflight.valid && edgePreflight.dnsResolved
                                ? "text-green-600 dark:text-green-400"
                                : "text-amber-600 dark:text-amber-400",
                            )}
                          >
                            {edgePreflight.valid
                              ? edgePreflight.dnsResolved
                                ? "✓ DNS A/AAAA record detected"
                                : "⚠ DNS record not detected yet; ensure DNS points to this server"
                              : edgePreflight.error}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-auto flex items-center justify-between gap-3 pt-8">
                    <Button type="button" variant="ghost" disabled={edgeLoading} onClick={() => void loadEdgeStatus()}>
                      <RefreshCw data-icon="inline-start" />Check again
                    </Button>
                    <Button
                      type="button"
                      disabled={onboardingSubmitting || (edgeMode !== "later" && !edgeHostname.trim())}
                      onClick={() => void handleEdgeSubmit()}
                    >
                      {onboardingSubmitting ? (
                        <>Configuring…<RefreshCw className="size-4 animate-spin" data-icon="inline-end" /></>
                      ) : edgeMode === "managed" ? (
                        <>Verify DNS & enable HTTPS<ArrowRight data-icon="inline-end" /></>
                      ) : edgeMode === "external" ? (
                        <>Save hostname<ArrowRight data-icon="inline-end" /></>
                      ) : (
                        <>Finish setup<ArrowRight data-icon="inline-end" /></>
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
