import * as React from "react"
import {
  AssistantRuntimeProvider,
  useAuiState,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import { Link } from "react-router"

import {
  AssistantMessage as AssistantUiMessage,
  Thread,
  type ThreadComponents,
} from "#/components/assistant-ui/thread"
import { Button } from "#/components/ui/button"
import {
  createAssistantThread,
  sendAssistantMessage,
  type RuntimeAssistantAction,
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

function ZelavisAssistantMessage() {
  return (
    <>
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
      async run({ messages }) {
        const prompt = readLatestUserPrompt(messages)
        let threadId = threadIdRef.current
        if (!threadId) {
          const created = await createAssistantThread(config, { projectId })
          threadId = created.id
          threadIdRef.current = created.id
          onThreadCreated?.(created)
        }
        const result = await sendAssistantMessage(config, threadId, prompt)
        return {
          content: [{ type: "text", text: result.assistantMessage.content }],
          metadata: {
            custom: {
              ...(result.assistantMessage.actions
                ? { actions: result.assistantMessage.actions }
                : {}),
            },
          },
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
