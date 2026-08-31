import { EmptyPanel } from '#/components/DashboardPage'

export const handle = {
  pageLabel: "Frontend",
  sidebarTrail: ["Frontend"],
} as const;

/**
 * Placeholder for choosing what this Project serves at `/`.
 *
 * The retired website service owned a fixed page shape and a single built-in
 * template. A Frontend is the replacement: a static site, or an application
 * that brings its own server. Until the Frontend contract and its marketplace
 * category exist, this page states the position rather than offering a picker
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
