---
title: Environment Variables
---
This page documents the current environment variables used by Zelavis runtime and dashboard development flows.

## Runtime

### `ZELAVIS_UI_DEV_SERVER`

Used by the `zelavis` dashboard core service when you want dashboard requests to redirect to a live UI dev server instead of serving embedded built assets.

Notes:

- Point this at the mounted dashboard base URL, not just the bare dev-server origin, when the UI dev server is mounted below `/zelavis`.
- `pnpm dev` wires this automatically.

## UI package development

### `ZELAVIS_DEV_SERVER`

Used by `@zelavis/ui` during standalone Vite development to decide which backend origin should receive proxied API requests.

Default:

```txt
http://127.0.0.1:3000
```

Example:

```bash
ZELAVIS_DEV_SERVER=http://127.0.0.1:3333 pnpm --filter @zelavis/ui dev
```

### `ZELAVIS_UI_BASE_PATH`

Used by `@zelavis/ui` to mount the standalone UI dev server under a production-style dashboard base path.

Example:

```bash
ZELAVIS_UI_BASE_PATH=/zelavis/ pnpm --filter @zelavis/ui dev
```

Notes:

- Leave it unset for a root-mounted standalone UI dev server.
- `pnpm dev` sets this automatically so the live dashboard dev flow runs under `/zelavis/`.

## Related docs

- [Dashboard Development](../guides/dashboard-development.md)
- [Dashboard Settings](./dashboard-settings.md)
- [Route Conventions](./route-conventions.md)
