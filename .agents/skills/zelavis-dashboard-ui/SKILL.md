---
name: zelavis-dashboard-ui
description: Use when working on the native Fuzor dashboard in packages/zelavis/services/zelavis-ui, its slide-based sidebar, mounted development behavior, and embedded production bundle.
---

# Zelavis Dashboard UI

Read `AGENTS.md` first; it is the canonical architecture and workflow guidance.
The dashboard is `@zelavis/ui` in `packages/zelavis/services/zelavis-ui`.
The private `zelavis-ui-legacy` package is reference material only.

## Rendering and lifecycle

- `index.html` owns the static shell (header, sidebar, workspace and footer).
  Startup adopts it; loading and errors stay inside its content slots. Preserve
  desktop/mobile frame geometry and apply saved appearance before first paint.
  Browser qualification must hold scripts and startup data across native refresh
  and verify the same frame nodes survive.

- Fuzor owns routing and compiled server views. Pages are native screens in
  `app/screens.ts` (`loadScreen`) and the modules it calls, built with `app/dom.ts`
  and `app/page-kit.ts`. `behaviors/dashboard.ts` is the client entry that draws them;
  `pages/` holds Fuzor's route documents, and `app/routes.ts` maps runtime patterns
  (`/projects/:projectId/...`) to them. The package README explains how they fit.
- The Project Database workspace is a Fuzor HTML server component
  (`components/database-workspace.html`, used by `pages/projects/[projectId]/database`).
  Its server loader (`app/database-reads.ts`) is a bounded, cancellable read through the
  caller's own session and the exact Project proxy, never an upstream chosen from the
  Host header. It declares no server action: the Platform routes only GET to the shell,
  and every change goes through the ordinary APIs from `app/database-workspace.ts`.
- Use `Effect.fn`/`Effect.gen` for asynchronous loading and orchestration. A screen
  loads its data when drawn; actions use `context.run` to report errors and refresh.
- Live views own their state and cleanup in a `fuzor-island`. Use plain DOM for
  Lexical and CodeMirror. React is needed only by the Glide Data Grid adapter
  (`app/grids/glide.ts`, loaded lazily), the one grid the dashboard ships.
- Add new route patterns to `app/dashboard-routes.ts`; parity visits each at
  desktop and mobile sizes. Wildcard routes leave script, stylesheet and asset
  requests to asset serving.
- The build uses `/__zelavis__` from `app/mount.ts`; the frontend adapter rewrites
  it for the actual mount. Never write `/zelavis` or `/api/v1` in dashboard code.
- The bundled server entry imports only host-provided `effect` and Node. Server
  views use frontend-context `fetch` to reach the Platform in process.
- Builds use the owner's Fuzor checkout (`FUZOR_DIR`, otherwise `../fuzor`) when
  available, rebuilding it when stale and recording provenance. The npm pin
  moves only to a published version. Add required framework features to Fuzor.

## Authority and service pages

- The dashboard consumes public capabilities; authorization, lifecycle and
  persistence belong to the runtime. Public changes need JS SDK, HTTP and CLI
  parity. Use a real Project ID and its exact Gateway proxy for Project data.
- Read caller authority from authenticated `runtime/access`. Public
  `runtime/config` carries runtime configuration. Keep browser and server-view
  navigation on the same caller's grants, and clear cached navigation when the
  caller changes.
- Trust is runtime `scope`. Only `system` services may choose privileged menu
  surfaces. A folder-discovered, installed or unscoped service is an extension.
  Config and registry listing must agree about scope.
- Every extension page, on the Platform or in a Project, is framed without
  `allow-same-origin`; only `system` service pages keep the dashboard's origin. Mint its page-capability URL for the signed-in viewer;
  only the claims' service, bundle and optional Project authorize its files.
- Disk reads stay within the named bundle after symlink resolution, with no
  package-root fallback. Public service-page UI assets are static build code
  and styles and contain no installation state. The component entry discovers initial and late-added tags and
  imports their families on demand. Its public module route reads only exact own keys from the frontend's static
  `serviceUi.modules` map. Wait for `customElements.whenDefined` before component methods or form reads.
- Broker messages require the frame's source window and only its owning service
  namespace through the exact Project proxy. Bound requests and clean up with
  the page scope. A new iframe document cannot inherit the previous grant.
- Bundled and installed packages use the same manifest/SDK registration path.
  Menus come from `zelavis.plugins.ui.menus.create`; runtime `menus` is the full
  list and `menu` is its primary catalogue entry, never another registration.

## Navigation and editing

- Preserve the slide-based sidebar and existing visual language. Each item,
  including parents, navigates to a dedicated content page. Back changes both
  slide and content. Placeholders still need meaningful content.
- For locally rendered URL-backed views, use Fuzor’s `data-fuzor-view-query` root,
  `data-fuzor-view-value` controls and `data-fuzor-view-values` panels. The router
  owns projection and cleanup; `router.isViewNavigation` recognizes their query
  ownership. Do not add per-page query exceptions or full-screen loading/rebuilds
  for these view changes. Data-bearing filters still need their normal loader.
- Put reconstructable state in the URL through `context.setSearch`: sidebar
  depth, tabs, filters, selected records and panels. Reload/share must restore it.
- Below the desktop breakpoint the sidebar is the app shell. Compose reusable
  workspace/panel modules that work at every size.
- Avoid title blocks repeating breadcrumbs or active navigation labels. Start
  dense workspaces with their controls or data.
- Content Studio creates collections with top-level `surface: "content-studio"`;
  Database creates raw tables with `surface: "database"`. Keep logical system
  views separate. Server Database inspects the read-only Platform System Store.
- Managed apps reveal native sections only after that API reports `used: true`.
  Do not probe unused APIs on entry. Their own database remains distinct from
  the bound Zelavis database that supports service/extension features.
- Draft recovery uses bounded tab-local sessionStorage partitioned by opaque
  session, Project, Tenant and table. Keep original optimistic versions and dirty
  inspector text, surface storage errors, clear saved/discarded entries and
  sign-out journals, and never journal authentication/provider credentials.
  Schema journals retain source versions and stay distinct from record journals.
- Setup presents the one `/auth/bootstrap` first-owner authority; it owns no
  second setup flag or owner-creation path. Hostname/TLS is resumable Edge work
  after owner creation, and failure never reopens bootstrap.
- Refresh persisted lifecycle state after failed mutations. A deletion tombstone
  disables start/restart/upgrade and offers Retry deletion; never clear it.
- Site/Admin links use the Project's preview descriptor and dashboard hostname,
  never the runtime driver's private URL. Keep exact App engine selection and
  recipe-update controls on their existing runtime/SDK/HTTP/CLI capabilities.

## Verification

While iterating, `pnpm --filter @zelavis/ui typecheck` and `test` (unit tests) are the
quick checks, and `node scripts/dev.mjs` in the package starts an isolated Platform
with the dev server (`--embedded` serves the built bundle instead); `pnpm dev` from the
root runs the everyday Platform.

Before calling it done, from the repository root: `pnpm run verify` checks the whole
workspace, and `pnpm run ci:ui` (the same command as `ci:ui:local`) builds the bundle and
runs the browser suites: service UI, server views, route parity at desktop and mobile
sizes, and the embedded production bundle with first-owner/login gates and real
mutations. `PARITY_SHOTS=<dir>` saves screenshots of the main pages. Follow any more
specific checks the user requests.

Browser tests choose free ports and stop only processes they started. Never
kill by port or command line. A development server is not evidence that the
packaged bundle hydrates and navigates correctly. Preserve generated asset URLs,
mount rewriting, scoped cleanup and failure/cancellation handling.
