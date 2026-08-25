import { EmptyPanel } from '#/components/DashboardPage'

export const handle = {
  pageLabel: "Agents",
  sidebarTrail: ["Extensions"],
} as const;

function Agents() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <EmptyPanel
        title="No agents connected"
        description="The dashboard shell is ready for the agent service boundary."
      />
    </section>
  )
}

export default Agents;
