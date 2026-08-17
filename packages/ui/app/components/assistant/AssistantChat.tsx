import * as React from "react"
import { useFetcher, useNavigate } from "react-router"

import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"

type AssistantAction = {
  label: string
  to: string
}

type AssistantEndpointResponse = {
  actions?: AssistantAction[]
  message: string
}

type AssistantMessage = {
  actions?: AssistantAction[]
  content: string
  id: string
  role: "assistant" | "user"
}

export function AssistantChat({
  className,
  compact = false,
  onNavigate,
}: {
  className?: string
  compact?: boolean
  onNavigate?: () => void
}) {
  const navigate = useNavigate()
  const fetcher = useFetcher<AssistantEndpointResponse>()
  const [draft, setDraft] = React.useState("")
  const [pendingPrompt, setPendingPrompt] = React.useState<string>()
  const [messages, setMessages] = React.useState<AssistantMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Tell me what you want to do in Zelavis. I can already help route you into project creation, security, resources, logs, domains, marketplace, database, and content.",
    },
  ])
  const messagesRef = React.useRef<HTMLDivElement>(null)
  const isSubmitting = fetcher.state !== "idle"

  React.useEffect(() => {
    if (!pendingPrompt || fetcher.state !== "idle" || !fetcher.data) {
      return
    }

    const response = fetcher.data

    setMessages((current) => [
      ...current,
      {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: response.message,
        actions: response.actions,
      },
    ])
    setPendingPrompt(undefined)
  }, [fetcher.data, fetcher.state, pendingPrompt])

  React.useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: "smooth",
    })
  }, [messages, isSubmitting])

  function submitPrompt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const prompt = draft.trim()
    if (!prompt || isSubmitting) {
      return
    }

    const formData = new FormData()
    formData.set("prompt", prompt)

    setMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: prompt,
      },
    ])
    setDraft("")
    setPendingPrompt(prompt)
    fetcher.submit(formData, {
      action: "/_api/assistant",
      method: "post",
    })
  }

  function openAction(action: AssistantAction) {
    navigate(action.to, { viewTransition: true })
    onNavigate?.()
  }

  return (
    <div
      className={[
        "flex min-h-0 flex-col overflow-hidden rounded-md border bg-background",
        compact ? "min-h-[24rem]" : "h-full",
        className ?? "",
      ].join(" ")}
    >
      <div
        ref={messagesRef}
        className={[
          "grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-3",
          compact ? "max-h-[28rem]" : "",
        ].join(" ")}
      >
        {messages.map((message) => (
          <div
            key={message.id}
            className={[
              "grid gap-2 rounded-md px-3 py-2 text-sm",
              message.role === "user"
                ? "justify-self-end bg-primary text-primary-foreground"
                : "justify-self-start bg-muted text-foreground",
            ].join(" ")}
          >
            <p
              className={[
                "whitespace-pre-wrap leading-5",
                compact ? "max-w-[13rem]" : "max-w-2xl",
              ].join(" ")}
            >
              {message.content}
            </p>
            {message.actions?.length ? (
              <div className="flex flex-wrap gap-2">
                {message.actions.map((action) => (
                  <Button
                    key={`${message.id}-${action.to}`}
                    type="button"
                    variant={message.role === "user" ? "secondary" : "outline"}
                    onClick={() => openAction(action)}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {isSubmitting ? (
          <div className="justify-self-start rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            Thinking...
          </div>
        ) : null}
      </div>
      <form
        className={[
          "grid gap-2 border-t p-2",
          compact ? "" : "sm:grid-cols-[1fr_auto]",
        ].join(" ")}
        onSubmit={submitPrompt}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask Zelavis"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          disabled={isSubmitting}
        />
        <Button type="submit" disabled={!draft.trim() || isSubmitting}>
          Send
        </Button>
      </form>
    </div>
  )
}
