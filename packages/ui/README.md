# @zelavis/ui

Zelavis dashboard UI packaged as a React Router 7 SPA and a Zelavis system
service.

The app is designed to be served either as a standalone dev server or mounted by
the Zelavis runtime under the dashboard root path, which defaults to `/zelavis`.

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
