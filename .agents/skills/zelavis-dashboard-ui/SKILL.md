---
name: zelavis-dashboard-ui
description: Use when working on the Zelavis dashboard UI in packages/ui, including React Router v7 routes, the slide-based sidebar, mounted /zelavis dev behavior, and embedded-runtime dashboard integration.
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
// Correct
export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const runtime = await getRuntimeConfig(); // cached after first call — always fast
  const data = await fetchSomething(runtime, params.id);
  return { data };
}

function MyRoute() {
  const { data } = useLoaderData<typeof clientLoader>();
}
```

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

## Sidebar rules

- The sidebar uses a Swiper-based slide navigation model — each slide is a distinct panel
- Top-level sections that have a natural entry page declare `landingUrl` in `dashboard-data.ts`; this navigates the main content area when the section is opened from the Platform root
- Add `landingUrl` to any new top-level section that has a clear entry page
- Do not hand-edit the sidebar slide structure unless the task explicitly changes navigation
- `Community` is content inside the first sidebar slide

## Working rules

- Use `pnpm run ui:dev` for end-to-end dashboard work
- The mounted dashboard path is `/zelavis`, including in dev mode
- `/zelavis` opens the Projects overview. Project-scoped pages live under `/zelavis/projects/:projectId/*`; the current starter project is `/zelavis/projects/default`.
- `/zelavis/marketplace` is the global marketplace for apps, starters, and server integrations. `/zelavis/projects/:projectId/marketplace` is the project marketplace for Zelavis plugins.
- Managed app projects such as WordPress/static/generic projects use hosting-style project navigation, not the Zelavis-native project navigation.
- Keep dashboard and runtime behavior aligned; dev mode must not drift from production mounting rules
- Preserve the existing design language unless the task explicitly asks for a redesign
- Be careful with layout regressions in the sidebar and header
- **No backward compatibility.** Pre-release, no public users. Remove stale shapes cleanly — no shims, no legacy fallbacks, no "for old data" branches.

## Validation

```bash
pnpm run ui:dev
pnpm --filter @zelavis/ui typecheck
pnpm --filter @zelavis/ui build
pnpm --filter @zelavis/ui test:e2e
```

After substantial UI changes, verify the mounted dashboard flow still works at:

- `http://127.0.0.1:3000/zelavis`
- `http://127.0.0.1:3001/zelavis/`
