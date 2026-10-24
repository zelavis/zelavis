---
name: zelavis-dashboard-ui
description: Use when working on the native Fuzor dashboard in packages/zelavis/services/zelavis-ui, its slide-based sidebar, mounted development behavior, and embedded production bundle.
---

# Zelavis Dashboard UI

Read `AGENTS.md` first; it is the canonical architecture and workflow guidance.
The dashboard is `@zelavis/ui` in `packages/zelavis/services/zelavis-ui`.
The private `zelavis-ui-legacy` package is reference material only.

## Rendering and lifecycle

- Fuzor owns routing and compiled server views. Pages are native screens in
  `app/screens.ts` and its modules, built with `app/dom.ts` and `app/page-kit.ts`.
- Use `Effect.fn`/`Effect.gen` for asynchronous loading and orchestration. A screen
  loads its data when drawn; actions use `context.run` to report errors and refresh.
- Live views own their state and cleanup in a `fuzor-island`. Use plain DOM for
  Lexical and CodeMirror. React is needed only by the Glide Data Grid adapter.
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
- Trust is runtime `scope`. Only `system` services may choose privileged menu
  surfaces. A folder-discovered, installed or unscoped service is an extension.
  Config and registry listing must agree about scope.
- Every extension page, on the Platform or in a Project, is framed without
  `allow-same-origin`. Mint its page-capability URL for the signed-in viewer;
  only the claims' service, bundle and optional Project authorize its files.
- Disk reads stay within the named bundle after symlink resolution, with no
  package-root fallback. Public service-page UI assets are static build code
  and styles and contain no installation state.
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

Run from the repository root. `pnpm run verify` checks the whole workspace;
`pnpm run ci:ui:local` builds and exercises the production dashboard, isolated
Platform, first-owner/login gates, desktop/mobile routes and representative
mutations. Follow any more specific checks the user requests.

Browser tests choose free ports and stop only processes they started. Never
kill by port or command line. A development server is not evidence that the
packaged bundle hydrates and navigates correctly. Preserve generated asset URLs,
mount rewriting, scoped cleanup and failure/cancellation handling.
