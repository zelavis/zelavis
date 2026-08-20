import * as React from "react"
import { useLoaderData, useNavigate, useRevalidator } from "react-router"

import { AssistantChat } from "#/components/assistant/AssistantChat"
import {
  getAssistantThread,
  getRuntimeConfig,
  listAssistantThreads,
  listProjects,
} from "#/lib/runtime-api"
import type { Route } from "./+types/assistant"

export const handle = {
  pageLabel: "Assistant",
  slots: [{ id: "main", label: "Chat" }],
} as const

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const config = await getRuntimeConfig()
  const url = new URL(request.url)
  const requestedThreadId = url.searchParams.get("thread") ?? undefined
  const requestedProjectId = url.searchParams.get("project") ?? undefined
  const projects = requestedProjectId ? undefined : await listProjects(config)
  const projectId = requestedProjectId ?? projects?.projects[0]?.id
  const result = await listAssistantThreads(config, projectId)
  const selectedId = requestedThreadId ?? result.threads[0]?.id
  const thread = selectedId
    ? await getAssistantThread(config, selectedId).catch(() => undefined)
    : undefined

  return { config, projectId, responder: result.responder, thread }
}

clientLoader.hydrate = true as const

function AssistantRoute() {
  const { config, projectId, thread } = useLoaderData<typeof clientLoader>()
  const navigate = useNavigate()
  const revalidator = useRevalidator()
  const handleThreadCreated = React.useCallback(
    (created: { id: string }) => {
      const search = new URLSearchParams({ thread: created.id })
      if (projectId) search.set("project", projectId)
      navigate(`/assistant?${search.toString()}`, {
        replace: true,
        preventScrollReset: true,
      })
      revalidator.revalidate()
    },
    [navigate, projectId, revalidator],
  )

  return (
    <section
      data-dashboard-slot-layout
      className="mx-auto flex h-[calc(100svh-11.5rem)] min-h-0 w-full max-w-5xl flex-none flex-col"
    >
      <div data-dashboard-slot="main" className="flex min-h-0 flex-1 flex-col">
        <AssistantChat
          key={thread?.id ?? `new-${projectId ?? "platform"}`}
          config={config}
          projectId={projectId}
          thread={thread}
          onThreadCreated={handleThreadCreated}
        />
      </div>
    </section>
  )
}

export default AssistantRoute
