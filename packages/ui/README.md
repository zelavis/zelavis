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
