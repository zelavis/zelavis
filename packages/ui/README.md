# @zelavis/ui

Zelavis dashboard UI packaged as a React Router 7 SPA and a Zelavis system
service.

The app is designed to be served either as a standalone dev server or mounted by
the Zelavis runtime under the dashboard root path, which defaults to `/zelavis`.
That root opens the Projects overview; project-local dashboard pages are routed
under `/zelavis/projects/:projectId/*`.
The global marketplace and server management routes live outside projects, while
project-specific plugins install through `/zelavis/projects/:projectId/marketplace`.
Managed app projects such as WordPress, static sites, or generic apps use
hosting-style navigation instead of Zelavis-native Auth/Database/Content plugin
navigation.

## Dashboard Boundary

The dashboard is a client of Zelavis endpoints. It should never be the only
place where a platform action exists.

When adding dashboard features, put authoritative behavior behind a server
capability and endpoint first, then have the UI call that capability. Security
checks, resource metrics, domains, backups, service installs, project settings,
database mutations, and hosting actions must stay scriptable outside the
dashboard through the API.

## Mobile-Ready Slots

Dashboard feature surfaces should be built as reusable workspace or panel
components, then composed by routes. The desktop content area and future
mobile/sidebar slide slots should share those same components instead of
forking behavior.

Below the dashboard desktop breakpoint (`lg`), the sidebar becomes the app shell
and the desktop content inset is hidden. Phone and smaller tablet experiences
should therefore come from slide navigation and route slots, not from squeezing
the desktop workspace into a narrow viewport.

Use `DashboardSlotLayout` and `DashboardSlot` from
`app/components/DashboardSlots.tsx` when a route naturally breaks into
mobile-ready areas such as:

- `overview`
- `main`
- `create`
- `edit`
- `inspect`
- `settings`

Routes may declare `handle.slots` metadata so the responsive sidebar/mobile app
shell can later discover which pieces can be mounted into slide slots. Keep
data loading in route `clientLoader`s or resource routes, not inside duplicated
mobile-only components.

## Assistant UI

The Assistant workspace uses the official assistant-ui Thread component with a
custom Zelavis runtime adapter. It does not use the Vercel AI SDK or Assistant
Cloud. Threads and messages come from the Platform OS runtime API, and the same
chat workspace is mounted in the desktop content area and compact mobile
sidebar slots. The utility navigation follows Projects -> project -> Chats so
mobile does not need a separate chat navigation model.

Keep assistant-ui on the presentation side of the boundary. Provider calls,
thread persistence, tools, approvals, and privileged operations belong behind
Zelavis capabilities and endpoints.

## Service

`@zelavis/ui/service` exports the dashboard service definition helpers used by the
main `zelavis` runtime:

```ts
import { createZelavisDashboardService } from "@zelavis/ui/service";
```

The service declares `app: { mount: "/", mode: "spa" }` and ships the built
dashboard bundle from this package. The runtime decides the effective mount
(`/zelavis` by default) and turns the service `app` field into SPA routes.

## Development

```bash
pnpm --filter ./packages/ui dev
pnpm --filter ./packages/ui dev:mounted
```

`dev:mounted` sets `ZELAVIS_UI_BASE_PATH=/zelavis/` so generated assets and
client routes match the runtime-mounted dashboard path.

## Build And Validation

```bash
pnpm --filter ./packages/ui typecheck
pnpm --filter ./packages/ui test
pnpm --filter ./packages/ui build
```

The app uses React Router route config in `app/routes.ts`; route modules live in
`app/routes/*`. Keep route wiring there rather than introducing generated router
trees or framework-specific route shells.

Key route scopes:

- `/zelavis` for Projects
- `/zelavis/marketplace` for global apps, starters, and server provider plugins
- `/zelavis/projects/:projectId/*` for project-local pages
- `/zelavis/server/*` for domains, backups, logs, and server operations
