import * as React from "react"
import { Bot, KeyRound, Trash2 } from "lucide-react"

import { ResourceNotice } from "#/components/DashboardPage"
import { Button } from "#/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card"
import { Input } from "#/components/ui/input"
import {
  RuntimeApiError,
  clearAssistantProvider,
  getAssistantProvider,
  setAssistantProvider,
  type AssistantProviderStatus,
  type RuntimeConfig,
} from "#/lib/runtime-api"

const SOURCE_LABEL = {
  environment: "Set by the server environment",
  stored: "Saved in this dashboard",
  none: "Not configured",
} as const

/**
 * The Assistant's model provider. The key is write-only here: it is sent once,
 * the field is emptied straight after, and the server only ever reports that a
 * key exists.
 */
export function AssistantProviderCard({ runtime }: { runtime: RuntimeConfig }) {
  const [status, setStatus] = React.useState<AssistantProviderStatus>()
  const [forbidden, setForbidden] = React.useState(false)
  const [model, setModel] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string>()
  const [error, setError] = React.useState<string>()

  React.useEffect(() => {
    let cancelled = false
    getAssistantProvider(runtime)
      .then((next) => {
        if (cancelled) return
        setStatus(next)
        if (next.model) setModel(next.model)
      })
      .catch((cause) => {
        if (cancelled) return
        // Only settings managers may read this; everyone else simply does not see it.
        if (cause instanceof RuntimeApiError && (cause.status === 401 || cause.status === 403)) {
          setForbidden(true)
          return
        }
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [runtime])

  if (forbidden) return null

  const managedByEnvironment = status?.source === "environment"

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setMessage(undefined)
    setError(undefined)
    try {
      setStatus(await setAssistantProvider(runtime, { model: model.trim(), apiKey }))
      setMessage("Provider saved. It applies to the next message.")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setApiKey("")
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setMessage(undefined)
    setError(undefined)
    try {
      setStatus(await clearAssistantProvider(runtime))
      setModel("")
      setMessage("Provider removed. The built-in navigation helper answers again.")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4" />
          Assistant model
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          {status
            ? `${SOURCE_LABEL[status.source]}${status.model ? ` · ${status.model} via OpenRouter` : ""}. `
            : "Checking. "}
          {status?.mode === "local-router"
            ? "Without a model the Assistant only helps you navigate. "
            : ""}
          The key is stored encrypted and is never shown again.
        </p>

        {managedByEnvironment ? (
          <ResourceNotice
            title="Managed by the environment"
            description="Unset ZELAVIS_ASSISTANT_OPENROUTER_API_KEY and restart to manage the provider here."
          />
        ) : (
          <form className="grid gap-3" onSubmit={save} autoComplete="off">
            <label className="grid gap-2 text-sm font-medium text-foreground">
              Model
              <Input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="vendor/model-name"
                disabled={busy}
                required
              />
            </label>
            <label className="grid gap-2 text-sm font-medium text-foreground">
              OpenRouter API key
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={status?.hasApiKey ? "Enter a new key to replace the saved one" : "sk-or-…"}
                autoComplete="new-password"
                disabled={busy}
                required
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || !model.trim() || apiKey.length < 8}>
                <KeyRound className="size-4" />
                Save
              </Button>
              {status?.source === "stored" ? (
                <Button type="button" variant="outline" disabled={busy} onClick={remove}>
                  <Trash2 className="size-4" />
                  Remove
                </Button>
              ) : null}
            </div>
          </form>
        )}

        {message ? <ResourceNotice title="Saved" description={message} /> : null}
        {error ? <ResourceNotice title="Action failed" description={error} /> : null}
      </CardContent>
    </Card>
  )
}
