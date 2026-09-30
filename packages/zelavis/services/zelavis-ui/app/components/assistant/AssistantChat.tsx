import * as React from "react"
import {
  AssistantRuntimeProvider,
  useAuiState,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import { Ban, Check, Loader2 } from "lucide-react"
import { Link } from "react-router"

import {
  AssistantMessage as AssistantUiMessage,
  Thread,
  type ThreadComponents,
} from "#/components/assistant-ui/thread"
import { Button } from "#/components/ui/button"
import {
  createAssistantThread,
  streamAssistantMessage,
  type RuntimeAssistantAction,
  type RuntimeAssistantActivity,
  type RuntimeAssistantThread,
  type RuntimeConfig,
} from "#/lib/runtime-api"
import { cn } from "#/lib/utils"

function toInitialMessages(
  thread: RuntimeAssistantThread | undefined,
): readonly ThreadMessageLike[] {
  return (thread?.messages ?? []).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: new Date(message.createdAt),
    metadata: {
      custom: {
        ...(message.actions ? { actions: message.actions } : {}),
        ...(message.activity ? { activity: message.activity } : {}),
      },
    },
  }))
}

function readLatestUserPrompt(
  messages: Parameters<ChatModelAdapter["run"]>[0]["messages"],
): string {
  const userMessage = [...messages].reverse().find((message) => message.role === "user")
  if (!userMessage) return ""
  return userMessage.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function AssistantActions() {
  const actions = useAuiState(
    (state) => state.message.metadata.custom.actions,
  ) as readonly RuntimeAssistantAction[] | undefined

  if (!actions?.length) return null

  return (
    <div className="mt-1 flex flex-wrap gap-2 px-2">
      {actions.map((action) => (
        <Button
          key={`${action.label}-${action.to}`}
          nativeButton={false}
          variant="outline"
          render={<Link to={action.to} viewTransition />}
        >
          {action.label}
        </Button>
      ))}
    </div>
  )
}

/** What the Assistant is looking up, or looked up, in the operator's words. */
function AssistantActivity() {
  const activity = useAuiState(
    (state) => state.message.metadata.custom.activity,
  ) as readonly RuntimeAssistantActivity[] | undefined

  if (!activity?.length) return null

  return (
    <ul aria-label="What the Assistant checked" className="mb-1 grid gap-1 px-2 text-xs text-muted-foreground">
      {activity.map((entry, index) => (
        <li key={`${index}-${entry.label}`} className="flex items-center gap-1.5">
          {entry.status === "running" ? (
            <Loader2 className="size-3 animate-spin" aria-label="In progress" />
          ) : entry.status === "done" ? (
            <Check className="size-3" aria-label="Done" />
          ) : (
            <Ban className="size-3 text-destructive" aria-label="Not allowed" />
          )}
          <span className={entry.status === "refused" ? "text-destructive" : undefined}>
            {entry.status === "refused" ? `Not allowed: ${entry.label}` : entry.label}
          </span>
        </li>
      ))}
    </ul>
  )
}

function ZelavisAssistantMessage() {
  return (
    <>
      <AssistantActivity />
      <AssistantUiMessage />
      <AssistantActions />
    </>
  )
}

const THREAD_COMPONENTS = {
  AssistantMessage: ZelavisAssistantMessage,
} satisfies ThreadComponents

export function AssistantChat({
  className,
  compact = false,
  config,
  projectId,
  thread,
  onThreadCreated,
}: {
  className?: string
  compact?: boolean
  config: RuntimeConfig
  projectId?: string
  thread?: RuntimeAssistantThread
  onThreadCreated?: (thread: RuntimeAssistantThread) => void
}) {
  const threadIdRef = React.useRef(thread?.id)
  const adapter = React.useMemo<ChatModelAdapter>(
    () => ({
      async *run({ messages, abortSignal }) {
        const prompt = readLatestUserPrompt(messages)
        let threadId = threadIdRef.current
        if (!threadId) {
          const created = await createAssistantThread(config, { projectId })
          threadId = created.id
          threadIdRef.current = created.id
          onThreadCreated?.(created)
        }
        let text = ""
        const activity = new Map<string, RuntimeAssistantActivity>()
        const view = (actions?: readonly RuntimeAssistantAction[]) => ({
          content: [{ type: "text" as const, text }],
          metadata: {
            custom: {
              ...(activity.size ? { activity: [...activity.values()] } : {}),
              ...(actions ? { actions } : {}),
            },
          },
        })
        for await (const event of streamAssistantMessage(config, threadId, prompt, abortSignal)) {
          if (event.type === "text") {
            text += event.delta
            yield view()
          } else if (event.type === "tool") {
            activity.set(event.id, { label: event.label, status: event.status })
            yield view()
          } else if (event.type === "error") {
            throw new Error(event.message)
          } else {
            // The saved message is authoritative over what was streamed.
            text = event.assistantMessage.content
            yield {
              ...view(event.assistantMessage.actions),
              metadata: {
                custom: {
                  ...(event.assistantMessage.activity
                    ? { activity: event.assistantMessage.activity }
                    : {}),
                  ...(event.assistantMessage.actions
                    ? { actions: event.assistantMessage.actions }
                    : {}),
                },
              },
            }
          }
        }
      },
    }),
    [config, onThreadCreated, projectId],
  )
  const runtime = useLocalRuntime(adapter, {
    initialMessages: toInitialMessages(thread),
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div
        className={cn(
          "flex min-h-0 flex-col overflow-hidden bg-background",
          compact ? "h-[28rem]" : "h-full min-h-0",
          className,
        )}
      >
        <Thread components={THREAD_COMPONENTS} />
      </div>
    </AssistantRuntimeProvider>
  )
}
