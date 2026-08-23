---
name: zelavis-dashboard-ui
description: Use when working on the Zelavis dashboard UI in packages/ui, including React Router v7 routes, the slide-based sidebar, mounted /zelavis dev behavior, and embedded-runtime dashboard mounting.
---

# Zelavis Dashboard UI

Use this skill for changes in:

- `packages/ui`
- embedded dashboard behavior in `packages/zelavis`
- dashboard routing, settings, theme, and navigation

## Stack

- **Router**: React Router v7 in SPA mode (`ssr: false`) — not TanStack Router
- **Styling**: Tailwind CSS v4 + shadcn/ui (Base UI components)
- **Build**: Vite via `@react-router/dev`
- **Generated types**: `.react-router/types/app/routes/+types/` — do not hand-edit
- **Route files**: `app/routes/` — edit these, typegen runs automatically

## Data loading rules

Every route that fetches data must use a `clientLoader`. Never fetch data in `useEffect` for page-level data.

```ts
// Correct — getActiveRuntimeConfig resolves through the project proxy when
// the URL is inside /projects/:projectId/, so API calls target the right runtime.
export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const data = await fetchSomething(runtime, params.id);
  return { data };
}

function MyRoute() {
  const { data } = useLoaderData<typeof clientLoader>();
}
```

> **Important:** `getRuntimeConfig()` always returns the Platform OS control runtime config. Route `clientLoader` and `clientAction` functions must use `getActiveRuntimeConfig(request)` instead so that data loads and mutations target the correct project when inside a project context. Inline component event handlers that need the runtime config should read it from root loader data via `useRouteLoaderData<typeof rootClientLoader>('root')!`.

Root loader data (`runtime`, `settings`, `databaseCollections`, `schemaCollections`) is already fetched once and available in every child route:

```ts
import type { clientLoader as rootClientLoader } from '../root';
const { runtime, settings } = useRouteLoaderData<typeof rootClientLoader>('root')!;
```

After mutations, trigger a loader rerun with `useRevalidator().revalidate()` — do not manually refetch.

For sub-component data not tied to a URL (e.g. loading related documents for a field editor), use `useFetcher` pointing at a resource route under `app/routes/api.*.tsx`.

## URL search param rules

**Everything that can survive a reload must be in the URL.** Use `useTypedSearchParams` from `app/lib/use-typed-search-params.ts` — never manage filterable or selectable state with `useState`.

```ts
// Define schema at module level (stable reference — not inside the component)
const mySchema = {
  prefix: parseAsString,
  view: parseAsStringLiteral(['grid', 'list'] as const).withDefault('grid'),
} as const;

// In component
const [params, setParams] = useTypedSearchParams(mySchema);
setParams({ prefix: 'images/' });
setParams({ view: null }); // null removes the key from the URL
```

For a single param, use the convenience wrapper:

```ts
const [prefix, setPrefix] = useTypedSearchParam('prefix', parseAsString.withDefault(''));
```

Available parsers: `parseAsString`, `parseAsStringLiteral`. Add new parsers to `use-typed-search-params.ts` following the `createParser` factory pattern — do not reach for external libraries.

`clientLoader` reads search params from `request.url` (not `useLocation`) so data loading and URL state are always in sync on reload.

## Sidebar and navigation rules

- The sidebar uses a Swiper-based slide navigation model — each slide is a distinct panel
- Top-level sections that have a natural entry page declare `landingUrl` in `dashboard-data.ts`; this navigates the main content area when the section is opened from the Platform root
- Add `landingUrl` to any new top-level section that has a clear entry page
- **Rule 1 (Always Change Content)**: clicking any menu item or slide must update the URL and change the content area to its own dedicated page or panel. Even parent items with child items must land on an Overview page/route of that section when opened.
- **Rule 2 (No Empty/Missing Content)**: if a specific domain feature is not yet built or is planned, a structured placeholder page/panel must still be rendered. A menu item must never be without content or act as a dead click.
- **Rule 3 (Back Button Synchronization)**: clicking the Back button on any sidebar slide must navigate both the sidebar slide and the content area back to the corresponding parent route and update the URL.
- **Rule 4 (URL State Reconstructability)**: every navigation step and sidebar slide depth must be reflected in the URL (`pathname` + `?sidebar=...`). Sharing or reloading a URL must reconstruct the exact same sidebar slide depth and active content area.
- Dynamic menu sections must stay route-backed when empty. Use `dynamicItems.emptyPath` and `dynamicItems.emptySearch` for empty dynamic sections that should open a specific content route/search view.
- Service menu `path` is the dashboard React Router URL. Service menu `page.file` is the browser-extension-style HTML entry file for iframe-backed service UI. Core services with UI routes in `@zelavis/ui` use `path` without `page`; custom service pages use concrete bundled files such as `dashboard.html`, `settings.html`, or `options.html`. If that file boots a SPA, its internal router/menu belongs inside the iframe content; the Zelavis sidebar still selects only the HTML entry file.
- Do not hand-edit the sidebar slide structure unless the task explicitly changes navigation
- Nested slide headers use a larger standard gap before the next menu content. Use `SidebarFixedActionMenu` for pinned/fixed action rows inside sidebar panels, and pass `afterHeader` when the action rows sit directly below a slide back/title header.
- Build feature surfaces as mobile-slot-ready modules. Desktop routes should compose reusable workspace/panel components, and mobile sidebar slots should be able to mount the same components later.
- Use `DashboardSlotLayout`, `DashboardSlot`, and optional route `handle.slots` metadata for route areas that naturally map to mobile slides. Prefer slot ids such as `overview`, `main`, `create`, `edit`, `inspect`, and `settings`.
- Below `lg`, the sidebar is the mobile/tablet app shell and the desktop content inset is hidden. Do not rely on the desktop content area for mobile; build reusable route panels that can be mounted into sidebar slide slots instead.
- Keep shared UI primitives aligned with the current shadcn CLI output unless there is a deliberate design-system decision. Use shadcn presets and CSS variables for theme changes; do not hand-edit generated primitives or route code for visual preferences that should come from `shadcn apply`.
- Use shared control defaults in dashboard routes. Do not pass `size="sm"`/`size="lg"` or `buttonVariants({ size: ... })` for ordinary text buttons; reserve explicit size variants for icon-only controls or a clearly distinct component primitive.
- Avoid route title blocks that repeat the breadcrumb, sidebar slide title, or active navigation item. Zelavis is a dense dashboard, not a blog/document page; content areas should usually begin with the real workspace, table, form, chart, or contextual actions.
- `Community` is content inside the first sidebar slide

## Working rules

- Use `pnpm dev` for end-to-end Zelavis runtime and dashboard work
- Treat the dashboard as a client of Zelavis endpoints. If a dashboard page can perform a platform action, the same action must exist as a server capability and endpoint.
- Do not make route modules, component callbacks, local React state, or framework-specific server actions the only implementation of privileged platform behavior.
- The mounted dashboard path is `/zelavis`, including in dev mode
- `/zelavis` opens the Projects overview. Project-scoped pages live under `/zelavis/projects/:projectId/*`; the current starter project is `/zelavis/projects/default`.
- `/zelavis/marketplace` is the global marketplace for apps, starters, and server provider plugins. `/zelavis/projects/:projectId/marketplace` is the project marketplace for Zelavis plugins.
- `/zelavis/server/domains`, `/zelavis/server/backups`, and `/zelavis/server/logs` are global server-level routes outside any project.
- Managed app projects such as WordPress/static/generic projects use hosting-style project navigation, not the Zelavis-native project navigation.
- Keep dashboard and runtime behavior aligned; dev mode must not drift from production mounting rules
- Preserve the existing design language unless the task explicitly asks for a redesign
- Be careful with layout regressions in the sidebar and header
- **No backward compatibility.** Pre-release, no public users. Remove stale shapes cleanly — no shims, no legacy fallbacks, no "for old data" branches.

## Validation

```bash
pnpm dev
pnpm --filter @zelavis/ui typecheck
pnpm --filter @zelavis/ui build
pnpm --filter @zelavis/ui test:e2e
```

After substantial UI changes, verify the mounted dashboard flow still works at:

- `http://127.0.0.1:3000/zelavis`
- `http://127.0.0.1:3001/zelavis/`
