import * as React from "react"
import { Bot, KeyRound, Trash2 } from "lucide-react"

import { ResourceNotice } from "#/components/DashboardPage"
import { Button } from "#/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card"
import { Input } from "#/components/ui/input"
import {
  ASSISTANT_PROVIDERS,
  RuntimeApiError,
  clearAssistantProvider,
  getAssistantProvider,
  setAssistantProvider,
  type AssistantProviderName,
  type AssistantProviderStatus,
  type RuntimeConfig,
} from "#/lib/runtime-api"

const PROVIDER_LABEL: Record<AssistantProviderName, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
}

const MODEL_EXAMPLE: Record<AssistantProviderName, string> = {
  openrouter: "vendor/model-name",
  openai: "gpt-…",
  anthropic: "claude-…",
}

const SOURCE_LABEL = {
  environment: "Set by the server environment",
  stored: "Saved in this dashboard",
  project: "This Project's own provider",
  platform: "Using the installation's provider",
  none: "Not configured",
} as const

/**
 * The Assistant's model provider, for the installation or (with `projectId`) for
 * one Project's own chats. The key is write-only here: it is sent once, the
 * field is emptied straight after, and the server only ever reports that a key
 * exists.
 */
export function AssistantProviderCard({
  runtime,
  projectId,
}: {
  runtime: RuntimeConfig
  projectId?: string
}) {
  const [status, setStatus] = React.useState<AssistantProviderStatus>()
  const [forbidden, setForbidden] = React.useState(false)
  const [provider, setProvider] = React.useState<AssistantProviderName>("openrouter")
  const [model, setModel] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string>()
  const [error, setError] = React.useState<string>()

  function adopt(next: AssistantProviderStatus) {
    setStatus(next)
    if (next.model && next.provider) {
      setProvider(next.provider)
      setModel(next.model)
    }
  }

  React.useEffect(() => {
    let cancelled = false
    getAssistantProvider(runtime, projectId)
      .then((next) => {
        if (!cancelled) adopt(next)
      })
      .catch((cause) => {
        if (cancelled) return
        // Only those who may manage this see it; everyone else simply does not.
        if (cause instanceof RuntimeApiError && (cause.status === 401 || cause.status === 403)) {
          setForbidden(true)
          return
        }
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [runtime, projectId])

  if (forbidden) return null

  const managedByEnvironment = !projectId && status?.source === "environment"
  const ownsKey = status?.source === "stored" || status?.source === "project"

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setMessage(undefined)
    setError(undefined)
    try {
      adopt(await setAssistantProvider(runtime, { provider, model: model.trim(), apiKey }, projectId))
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
      setStatus(await clearAssistantProvider(runtime, projectId))
      setModel("")
      setMessage(
        projectId
          ? "This Project's provider was removed. Its chats use the installation's again."
          : "Provider removed. The built-in navigation helper answers again.",
      )
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
          {projectId ? "Assistant model for this Project" : "Assistant model"}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          {status
            ? `${SOURCE_LABEL[status.source]}${
                status.model && status.provider
                  ? ` · ${status.model} via ${PROVIDER_LABEL[status.provider]}`
                  : ""
              }. `
            : "Checking. "}
          {status?.mode === "local-router"
            ? "Without a model the Assistant only helps you navigate. "
            : ""}
          {projectId
            ? "A key saved here answers only this Project's chats. "
            : ""}
          The key is stored encrypted and is never shown again.
        </p>

        {managedByEnvironment ? (
          <ResourceNotice
            title="Managed by the environment"
            description="Unset ZELAVIS_ASSISTANT_API_KEY and restart to manage the provider here."
          />
        ) : (
          <form className="grid gap-3" onSubmit={save} autoComplete="off">
            <label className="grid gap-2 text-sm font-medium text-foreground">
              Provider
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value as AssistantProviderName)}
                disabled={busy}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {ASSISTANT_PROVIDERS.map((name) => (
                  <option key={name} value={name}>
                    {PROVIDER_LABEL[name]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-sm font-medium text-foreground">
              Model
              <Input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={MODEL_EXAMPLE[provider]}
                disabled={busy}
                required
              />
            </label>
            <label className="grid gap-2 text-sm font-medium text-foreground">
              API key
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={ownsKey ? "Enter a new key to replace the saved one" : "Paste the key"}
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
              {ownsKey ? (
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
