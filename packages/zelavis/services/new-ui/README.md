# Zelavis dashboard in Fuzor

A private, opt-in experiment rebuilding the Zelavis dashboard with our HTML-first Fuzor framework and vanilla islands. Most dashboard controls use native HTML and Fuzor state; Glide runs in an isolated React island. The service definition is [src/new-ui-service.ts](src/new-ui-service.ts); [src/frontend.ts](src/frontend.ts) supplies it through Zelavis’s existing frontend factory contract.

All experiment code and launch tooling live here. The existing Zelavis runtime, React dashboard, root dev script, and workspace lockfile are unchanged. The package has deliberately named opt-in validation scripts so normal recursive builds do not require a sibling Fuzor checkout. Local dependencies are linked by `prepare:local` from the already installed Zelavis and Fuzor dependencies; this package is not publishable or a standalone npm installation.

## Run

Build the local framework first, from `~/Projects/fuzor`:

```sh
pnpm --filter fuzor build
```

From the Zelavis repository:

```sh
cd packages/zelavis/services/new-ui
node scripts/link-local.mjs
node scripts/dev.mjs                       # Fuzor is the default
node scripts/dev.mjs --frontend=react      # existing React dashboard
```

Use these package-local Node launchers to avoid pnpm’s automatic workspace installation when starting an experiment.

The launcher starts a real Platform and the chosen dashboard. It prints their addresses and the first-owner token. Defaults are ports 3200/3201; busy ports advance within a bounded range. It never kills existing listeners. Both frontend choices use this package’s own `.zelavis` test data directory, so you can switch dashboards over the same test projects without touching the ordinary development Platform. Ctrl-C stops only processes this launcher owns.

To attach to an already running Platform, or verify the built frontend:

```sh
node scripts/dev.mjs --runtime-url=http://127.0.0.1:3000
node scripts/build.mjs
node scripts/dev.mjs --embedded
```

`--embedded` serves the built Fuzor assets directly through Zelavis, with no UI dev server. It also works with `--frontend=react` when the existing React dashboard is built. Optional flags: `--port=3200`, `--ui-port=3201`, `--data-dir=/absolute/test/data`. `FUZOR_DIR` overrides the default sibling Fuzor checkout. The experiment currently supports the `/zelavis` mount only.

## Current coverage

- Owner bootstrap and cookie-based password login/logout over the existing auth API; optional hostname onboarding through the existing Edge API.
- Projects overview, URL-backed search/status filters, native project creation, start/stop/restart and confirmed deletion/retry with persisted tombstones.
- Real project IDs and deep links; every project data request resolves through that exact project’s proxy.
- Database table menu, separate logical System Table views, explicit Tenant selection, collection/table creation, three lazy-loaded MIT grids (Glide, Tabulator and VTable), server paging, shared page filters/sort, version-checked staged JSON edits and record insertion. Content collection creation uses `surface: "content-studio"` and its list filters that surface.
- Read views for auth users, storage files, workloads, global/project service catalogue, assistant threads, Fabric, ingress and deployment backends.
- Separate, read-only, paginated Platform System Store inspection.
- Persistent Swiper Element sidebar panels with route-backed parent landing pages, synchronized Back navigation, URL-restored depth, Tenant-specific table entries and grouped logical System Tables.
- Below 1024px, the workspace is a mobile content slide. Touch swipes, menu buttons and browser history keep `sidebar`/`sidebarView` in the URL; presentation-only changes preserve the page and unsaved inputs. Inactive slides are inert, and reduced-motion preferences disable animation.
- Responsive shell, keyboard controls, loading/error states, request deadlines, response byte limits and cancellation on shell disposal.

This is a working first port, not feature parity with `@zelavis/ui`. The React dashboard still owns advanced editors, uploads, provider configuration, marketplace installation, assistant conversations/approvals, exact engine/recipe upgrades, host-package approval, managed application admin links, backups/logs, service-page embedding and multiple named mobile content slots. The experimental sidebar currently exposes one main content slot. Those surfaces must be ported and tested before switching the product’s default frontend. Unsupported sections show a clear porting notice. Project planning and collaboration remain product roadmap items.

## Fuzor changes this experiment required

Fuzor now accepts static SPA `clientRoutes` that map runtime patterns such as `/projects/:projectId` and `/projects/:projectId/:section*` to compiled templates. Static pages take priority; Fuzor owns navigation, history, route parameters, mounted paths, island cleanup and not-found boundaries. Runtime project IDs are never enumerated at build time. Static template mappings also work alongside explicitly configured server views in SPA builds; MPA builds refuse the mapping option. Data flows are cancellable Effect v4 operations in [app/api.ts](app/api.ts) and [app/screens.ts](app/screens.ts), rather than a second application router.

Fuzor also exposes declared `routeTree` metadata through `matches()` and `subscribeMatches()`, inspired by React Router’s active match hierarchy. Matches carry `id`, app-relative `pathname`, `pattern`, ancestor-specific `params` and application-owned `handle`; they do not claim loader data. The generated SPA client exports `ready`/`router`, allowing [app/client.ts](app/client.ts) to mount one persistent shell outside the route outlet. [app/routes.ts](app/routes.ts) declares dashboard handles and [app/sidebar.ts](app/sidebar.ts) connects those handles to Swiper Element. Swiper is linked from the existing UI installation and bundled locally, with no CDN.

Fuzor’s framework and server examples were upgraded to stable Effect 4.0.1, verified against npm on 2026-10-07. Reactivity/HTTP imports and Vite’s dependency optimizer use the stable APIs. Zelavis’s own Effect pin stays unchanged.

## Compiled server views

Database and Content now stream through keyed Fuzor async boundaries and server components in [app/views/dashboard.server.ts](app/views/dashboard.server.ts). A bounded, cancellable server read forwards the current session to the existing authenticated Platform/project APIs, including the exact Project proxy. It cannot choose an upstream from the caller's Host header. Zelavis remains the authority for bootstrap, authentication, permissions and database mutations.

The Vite plugin discovers `*.fragment.html`, `*.view-client.ts` and named `*.handlers.ts` exports under `app/views`. It generates template/client/handler registries and one shared deployment identity. No application manifest is hand-maintained. Inline handlers in the server module are extracted into lazy browser chunks with detached JSON captures; Refresh captures the real Project ID and requests a persistent route revalidation. Client/handler imports become references in the server graph, so their setup does not execute during SSR; lazy browser modules still own grid interaction.

The compiled fallback arrives before database reads finish, then validated frames reveal the workspace. The living shell synchronizes sidebar metadata after each committed frame. The compiled HTML fragment supplies the stable workspace frame. The persistent client leaf retains the inspector, staged records and grid owner during fresh server props. Glide updates its existing React root; Tabulator replaces data on its existing table; VTable updates the existing canvas table. Dirty records retain their original expected versions, so a server refresh cannot silently turn a stale edit into an overwrite. Selection/filter/sort/sidebar state remains in the URL. Changing Project/Tenant/table deliberately creates a different workspace identity; navigating out of the Database/Content branch releases it. An in-progress vendor cell editor is not claimed to be resumable.

`node scripts/build.mjs` now writes `dist-spa-server/client` and `dist-spa-server/server`. Embedded serving passes the generated Fuzor handler's `Response.body` stream through this package's existing frontend shell registration, retaining cancellation and backpressure. The ordinary React dashboard and Zelavis core do not need changes. `ZELAVIS_DEV_SERVER` identifies the operator-controlled Platform origin for server reads; the launcher supplies it for both dev and embedded modes.

## Validate

```sh
node scripts/typecheck.mjs
node scripts/build.mjs
node --test tests/*.test.mjs
node scripts/test-server-views.mjs
node scripts/test-embedded-server-views.mjs
node scripts/test-embedded-server-views.mjs --dev
```

The tests also validate explicit sidebar ancestry, parent landing URLs, encoded Project IDs, managed capability visibility, Tenant table selection and the complete Projects list.

The tests validate the real frontend registration and built assets, malformed API responses, persisted deletion state, exact project proxy routing, permission failures and request cancellation. Browser verification should cover setup/login, project creation and start/stop, query filters with Back/Forward, deep-link reloads, mobile navigation and both dev/embedded serving. Use disposable data for lifecycle testing.

## Database grid comparison

The Database and Content workspaces offer Glide, Tabulator and VTable over the same Project records. Choose a library above the grid or share `grid=glide|tabulator|vtable` in the URL. Glide uses a Fuzor React island; Tabulator and VTable mount directly. All three require MIT licenses at their exact pinned releases. See [the experiment notes](docs/grid-comparison.md) for setup, supported operations and limitations.

Before linking local dependencies on a fresh checkout, run `npm ci --prefix grid-dependencies --ignore-scripts --legacy-peer-deps --no-audit --no-fund` from this directory. This installs only the isolated grid dependencies and does not alter the parent workspace lockfile.

The server-view browser test uses an isolated authenticated API fixture to exercise all three MIT grids, refreshed server data, retained drafts/DOM/sidebar identity, failed-save retention, retry, prototype-named database fields, mobile Back navigation and permission failures. The embedded and dev tests create a real disposable Platform and native App, qualify setup/login gates, render actual records, refresh a staged edit and verify its persisted database value. They choose free ports and release their own servers, browser and temporary data.
