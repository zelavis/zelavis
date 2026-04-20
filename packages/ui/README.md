# @zelavis/ui

TanStack Start workspace package for the Zelavis dashboard UI.

This package is the source app for the dashboard experience that will be served by the `zelavis` package under the configured root path, for example `/zelavis`. It is intentionally kept separate from the server runtime while the dashboard is being built, so the UI can use Vite, React, TanStack Router, and Tailwind without forcing those tools into the core server API.

## Scripts

```bash
pnpm --filter @zelavis/ui dev
pnpm --filter @zelavis/ui typecheck
pnpm --filter @zelavis/ui test
pnpm --filter @zelavis/ui test:e2e
pnpm --filter @zelavis/ui build
```

The production build runs TanStack Start in SPA mode and writes browser assets to `dist/client`.

## Local API Proxy

When the UI runs through Vite, API calls to `/api/*` are proxied to a local
Zelavis server at `http://127.0.0.1:3000/zelavis/api/*`.

Start the backend in another terminal:

```bash
pnpm example:nodejs
```

Override the target with `ZELAVIS_DEV_SERVER` when the backend runs elsewhere:

```bash
ZELAVIS_DEV_SERVER=http://127.0.0.1:3333 pnpm --filter @zelavis/ui dev
```

## Shipping Plan

The dashboard should be shipped through the high-level `zelavis` package, not imported by application users directly.

Planned flow:

1. Build this package as a static SPA artifact.
2. Include the built client assets in the publishable dashboard artifact.
3. Teach the core dashboard service in `zelavis` to serve the SPA shell at the configured dashboard root.
4. Serve dashboard assets below that same configured root, so custom roots such as `/admin` or `/backend` work without rebuilding the UI.
5. Keep dashboard API calls relative to the configured Zelavis API prefix.

Until that wiring exists, this package is build-ready but is not yet served by `zelavisServer`.

## Notes

The current routes and demo components come from the starter and are temporary. They can be replaced as the real dashboard shape lands.
