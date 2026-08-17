import { AssistantChat } from "#/components/assistant/AssistantChat"

export const handle = {
  pageLabel: "Assistant",
  slots: [
    {
      id: "main",
      label: "Chat",
    },
  ],
} as const

function AssistantRoute() {
  return (
    <section
      data-dashboard-slot-layout
      className="mx-auto flex min-h-[calc(100svh-8rem)] w-full max-w-5xl flex-col"
    >
      <div data-dashboard-slot="main" className="flex min-h-0 flex-1 flex-col">
        <AssistantChat className="min-h-[36rem]" />
      </div>
    </section>
  )
}

export default AssistantRoute
