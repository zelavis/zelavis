# @zelavis/ui, the Zelavis dashboard

The dashboard of every Platform, built with Fuzor: an HTML-first shell, a Swiper Element sidebar, compiled server views and a native database workspace with three MIT grid libraries. The pages not yet rebuilt natively are the former React dashboard's route modules, mounted as first-party React islands (see Route parity); that dashboard lives on in [`../zelavis-ui-legacy`](../zelavis-ui-legacy) as their source and as a reference. The repository rule is that all new dashboard UI is written here, natively.

The package ships its built output only (`dist`, `.fuzor/web/dist-spa`, `.fuzor/dist-backend`, `.fuzor/fuzor-build.json`). An installation never needs Fuzor: the server entry is bundled so it imports only `effect`, which the Platform provides.

## Build and run

```sh
pnpm --filter @zelavis/ui build        # Fuzor build, then the service and frontend in dist/
pnpm --filter @zelavis/ui typecheck
pnpm --filter @zelavis/ui test         # unit tests
pnpm run ci:ui                         # browser suites against throwaway Platforms (from the repository root)
```

**Which Fuzor.** On the owner's machine the build uses their own checkout (`FUZOR_DIR`, default `../fuzor` beside this repository), rebuilds it first when its sources are newer than its `dist`, and points `node_modules/fuzor`, `vite` and `typescript` at it. Without a checkout it uses the pinned `fuzor` from npm; `ZELAVIS_FUZOR=npm` forces that (after `pnpm install` restores the links). Either way `.fuzor/fuzor-build.json` records the version, and for a checkout its commit and a digest of its uncommitted changes. See [scripts/fuzor-source.mjs](scripts/fuzor-source.mjs).

**Mounting.** One build mounts at any root path. It is compiled against the placeholder root `/__zelavis__` ([app/mount.ts](app/mount.ts)) and [src/mount-rewrite.ts](src/mount-rewrite.ts) replaces it with the Platform's `rootPath` in the assets it serves and in what the server entry receives and answers. The dev server has no adapter in front of it and mounts at `/zelavis`.

**Development.** From the repository root, `pnpm dev` runs a Platform with this package's Fuzor dev server. In the package, a self-contained launcher starts its own isolated Platform:

```sh
cd packages/zelavis/services/zelavis-ui
node scripts/dev.mjs                  # Platform + Fuzor dev server, isolated test data
node scripts/dev.mjs --embedded       # the built dashboard served by the Platform, no dev server
node scripts/dev.mjs --runtime-url=http://127.0.0.1:3000   # attach to a running Platform
```

It prints the addresses and the first-owner token. Defaults are ports 3200/3201; busy ports advance within a bounded range, and it never kills existing listeners. Optional flags: `--port=3200`, `--ui-port=3201`, `--data-dir=/absolute/test/data`.

## Route parity

All 56 modules in the legacy React Router manifest are inventoried in [src/workspace-route-manifest.ts](src/workspace-route-manifest.ts). The build checks the original manifest and server menu against that snapshot and fails on drift. See [docs/route-parity.md](docs/route-parity.md) for the complete mapping and qualification limits.

Fuzor owns the canonical browser URL, mounted route matching, history, outer shell, footer utilities and persistent Swiper navigation. Original feature route components, loaders, actions and resource loaders run in a same-origin first-party iframe with a React memory router. The bridge authenticates the source window and origin and mirrors functional URLs in both directions. Sidebar/footer presentation parameters are excluded in both directions, preserving editor identity and preventing legacy sidebar URL loops. Touch swipe-back crosses the iframe boundary. Workspace styles stay inside that document so editor portals and dashboard styling do not interfere with the native shell.

Setup, login, Projects and lifecycle controls, rich Content Studio, workload editors, Auth, Storage/Media, Marketplace, Server/Fabric and Settings use the existing implementations and authority. Capability-dependent and planned pages keep their original limitations. These workspaces are React islands, not claimed to be native Fuzor rewrites or server components. No second bootstrap, permission, catalogue or Project authority is introduced.

The canonical Project Database route remains native Fuzor SSR with three MIT grids. **Full database tools** opens the original database workspace with `workspaceMode=full`; **Create table** uses its original action and returns to the native grid under the `zelavis-app` admin tenant. Content Studio uses its original schema, rich text, relation and media editors. Its relation resource loader is explicitly rebased through the current Project proxy.

Permission-filtered workspace menus feed the Fuzor sidebar, including nested Server/Fabric, Backend/Workloads and Content types. The footer retains Home, Notifications, Assistant, Search and Account → Settings → Language, with URL-restored mobile and desktop presentation state.

## Fuzor changes this experiment required

Fuzor now accepts static SPA `clientRoutes` that map runtime patterns such as `/projects/:projectId` and `/projects/:projectId/:section*` to compiled templates. Static pages take priority; wildcard runtime routes leave the Vite asset directory and script/style requests to asset serving; Fuzor owns navigation, history, route parameters, mounted paths, island cleanup and not-found boundaries. Runtime project IDs are never enumerated at build time. Static template mappings also work alongside explicitly configured server views in SPA builds; MPA builds refuse the mapping option. Data flows are cancellable Effect v4 operations in [app/api.ts](app/api.ts) and [app/screens.ts](app/screens.ts), rather than a second application router.

Fuzor also exposes declared `routeTree` metadata through `matches()` and `subscribeMatches()`, inspired by React Router’s active match hierarchy. Matches carry `id`, app-relative `pathname`, `pattern`, ancestor-specific `params` and application-owned `handle`; they do not claim loader data. The generated SPA client exports `ready`/`router`, allowing [app/client.ts](app/client.ts) to mount one persistent shell outside the route outlet. [app/routes.ts](app/routes.ts) declares dashboard handles and [app/sidebar.ts](app/sidebar.ts) connects those handles to Swiper Element. Swiper is linked from the existing UI installation and bundled locally, with no CDN. Mouse drag simulation is disabled so small trackpad movements do not cancel navigation clicks; actual touch swipes still control mobile panels.

Fuzor’s framework and server examples were upgraded to stable Effect 4.0.1, verified against npm on 2026-10-07. Reactivity/HTTP imports and Vite’s dependency optimizer use the stable APIs. Zelavis’s own Effect pin stays unchanged.

## Compiled server views

The native Database workspace streams through keyed Fuzor async boundaries and server components in [app/views/dashboard.server.ts](app/views/dashboard.server.ts). A bounded, cancellable server read forwards the current session to the existing authenticated Platform/project APIs, including the exact Project proxy. It cannot choose an upstream from the caller's Host header. Zelavis remains the authority for bootstrap, authentication, permissions and database mutations.

The Vite plugin discovers `*.fragment.html`, `*.view-client.ts` and named `*.handlers.ts` exports under `app/views`. It generates template/client/handler registries and one shared deployment identity. No application manifest is hand-maintained. Inline handlers in the server module are extracted into lazy browser chunks with detached JSON captures; Refresh captures the real Project ID and requests a persistent route revalidation. Client/handler imports become references in the server graph, so their setup does not execute during SSR; lazy browser modules still own grid interaction.

The compiled fallback arrives before database reads finish, then validated frames reveal the workspace. The living shell synchronizes sidebar metadata after each committed frame. The compiled HTML fragment supplies the stable workspace frame. The persistent client leaf retains the inspector, staged records and grid owner during fresh server props. Glide updates its existing React root; Tabulator replaces data on its existing table; VTable updates the existing canvas table. Dirty records retain their original expected versions, so a server refresh cannot silently turn a stale edit into an overwrite. Selection/filter/sort/sidebar state remains in the URL. Changing Project/Tenant/table deliberately creates a different workspace identity; navigating out of the Database/Content branch releases it. An in-progress vendor cell editor is not claimed to be resumable. Staged records and incomplete inspector text survive hard reloads in tab-local `sessionStorage`, partitioned by opaque session identity, Project, Tenant and table. Original record versions remain save preconditions. Recovery is bounded at 1 MB total, 250 records per table, 32 tables and 24 hours, and ends when the tab closes. Save/discard remove journaled entries; sign-out clears this tab's journals. Expired/malformed/full/denied storage produces visible recovery errors. URL selection remains separate from record contents; credentials are never journaled.

`node scripts/build.mjs` now writes `.fuzor/web/dist-spa` and `.fuzor/dist-backend`. Embedded serving passes the generated Fuzor handler's `Response.body` stream through this package's existing frontend shell registration, retaining cancellation and backpressure. The ordinary React dashboard and Zelavis core do not need changes. `ZELAVIS_DEV_SERVER` identifies the operator-controlled Platform origin for server reads; the launcher supplies it for both dev and embedded modes.

## Service pages and schema editing

Service menu HTML pages mount through the runtime's generated asset endpoint. Trust comes only from runtime `scope`: system pages retain same-origin behavior, while extension pages have an opaque iframe origin. The Effect-scoped broker authenticates the source window and confines calls to that service's namespace, rebased through the exact Project proxy where applicable. Requests allow five JSON API methods, refuse traversal, external targets and redirects, and are bounded at eight in flight, 1 MB per body/response and 30 seconds. Leaving the page releases the listener and aborts pending work. A subsequent iframe document navigation closes its grant; refreshing the dashboard opens the selected entry again. Broker responses never forward cookies or authentication headers. Registered service paths survive direct reloads and are represented in the sidebar; workspace menu contributions also preserve their nested routes and search values.

Native Database **Collection schema** opens the schema workspace (`databasePanel=schema`, with optional `schemaVersion` in the URL). It builds fields, reorders/removes them, accepts all public field metadata through typed JSON, saves immutable new versions, and explicitly activates historical versions for future writes. Schema drafts use a separate bounded journal partition and retain incomplete JSON and their source version through refresh/reload. They share record draft retention/storage limits and sign-out cleanup. Mutation failures revalidate persisted state while retaining the draft.

Selected records expose text, numeric, boolean, select and multi-select controls. Rich text is currently HTML source; references, file descriptors, JSON and repeaters use JSON controls. Representable edits feed the existing inspector/journal, retain original optimistic record versions and are staged/saved through the same database operation. Saves preserve later unstaged text and advance its version only from the acknowledged own write; discard resets its controls and journal. Invalid structured field text is reported as not yet recoverable; complete it or use the JSON inspector, which can journal incomplete text. For rich-text visual editing and dedicated relation/media/repeater widgets, open Content Studio or Full database tools; those use the existing feature islands. No new privileged platform operation was added.

## Validate

```sh
node scripts/audit-routes.mjs --check
node scripts/typecheck.mjs
node scripts/build.mjs
node --test tests/*.test.mjs
node scripts/test-server-views.mjs
node scripts/test-route-parity.mjs
node scripts/test-embedded-server-views.mjs
node scripts/test-embedded-server-views.mjs --dev
```

The tests also validate explicit sidebar ancestry, parent landing URLs, encoded Project IDs, managed capability visibility, Tenant table selection and the complete Projects list.

The tests validate the real frontend registration and built assets, malformed API responses, persisted deletion state, exact project proxy routing, permission failures and request cancellation. Browser verification should cover setup/login, project creation and start/stop, query filters with Back/Forward, deep-link reloads, mobile navigation and both dev/embedded serving. Use disposable data for lifecycle testing.

## Database grid comparison

The native Database workspace offers Glide, Tabulator and VTable over the same Project records. Choose a library above the grid or share `grid=glide|tabulator|vtable` in the URL. Glide uses a Fuzor React island; Tabulator and VTable mount directly. All three require MIT licenses at their exact pinned releases. See [the experiment notes](docs/grid-comparison.md) for setup, supported operations and limitations.

The grid libraries are pinned devDependencies of this package in the workspace lockfile; their licenses are checked at build time.

The server-view browser test uses an isolated authenticated API fixture to exercise all three MIT grids, refreshed server data, retained drafts/DOM/sidebar identity, failed-save retention, retry, staged and unstaged hard-reload recovery, prototype-named database fields, mobile Back navigation and permission failures. It also qualifies schema draft/version controls, typed record reload recovery, iframe sandboxing and both scoped service brokers, assistant approvals and inert reply text, exact-version marketplace installs in both scopes, Project uploads and provider configuration controls. The embedded and dev tests create a real disposable Platform and native App, qualify setup/login gates, render actual records, refresh a staged edit and verify its persisted database value, then create/activate an actual schema and save typed record edits after reload. They choose free ports and release their own servers, browser and temporary data.
