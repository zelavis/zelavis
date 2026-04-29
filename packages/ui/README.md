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

For the local dashboard dev loop, start both the TanStack dev server and the
Node runtime from the workspace root:

```bash
pnpm run ui:dev
```

That starts the UI on `http://127.0.0.1:3001`, starts the Zelavis Node example
on `http://127.0.0.1:3000`, proxies UI API calls back to Zelavis, and lets the
runtime redirect `/zelavis` dashboard requests to the live UI dev server.

The script prefers ports `3000` and `3001`, but if either is already in use it
automatically picks the next available local port and wires both processes
together with the selected origins.

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

Until that wiring exists, this package is build-ready but is not yet served by `zelavis()`.

## Notes

The current routes and demo components come from the starter and are temporary. They can be replaced as the real dashboard shape lands.
