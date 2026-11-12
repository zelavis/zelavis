import { EmptyPanel } from '#/components/DashboardPage'

export const handle = {
  pageLabel: "Frontend",
  sidebarTrail: ["Frontend"],
} as const;

/**
 * Placeholder for choosing what this Project serves at `/`.
 *
 * A Frontend is a static site or an application that brings its own server.
 * Until a picker exists, this page states the position rather than offering one
 * that would do nothing.
 */
function Frontend() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <EmptyPanel
        title="No frontend selected"
        description="This Project serves a placeholder to visitors. A frontend can be a static site or an application that brings its own server."
      />
    </section>
  )
}

export default Frontend;
