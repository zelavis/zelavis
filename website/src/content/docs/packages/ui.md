---
title: "@zelavis/ui"
---
`@zelavis/ui` is the dashboard SPA mounted by the Zelavis runtime.

It uses React Router v7 in SPA mode and is served under the configured
dashboard root path, `/zelavis` by default. The dashboard opens to the Projects
overview; project-local pages live under `/zelavis/projects/:projectId/*`.

This is the only Zelavis dashboard application in an installation. Isolated
Zelavis App runtimes do not mount `@zelavis/ui`. The Platform shell keeps its own route
and asset bundle while reading each selected project's APIs and service menu
metadata through the control-plane proxy.

## Current Role

- dashboard shell and slide-based sidebar navigation
- Projects overview and project-local dashboard routes
- global management areas such as Marketplace, Domains, Resources, Server, and
  Security
- mobile-slot-ready route surfaces for future mobile browser and Capacitor
  shells
- service-owned dashboard navigation rendered from runtime menu metadata
- one shared Platform shell for global and project-local views

The dashboard is a client of Zelavis endpoints. Privileged behavior should live
behind runtime capabilities and versioned endpoints, not only inside React route
modules or component callbacks.

## Development

Use the mounted development flow from the repository root:

```bash
pnpm dev
```

That starts the runtime and UI dev server together so `/zelavis` behaves like
the mounted dashboard.

For package-only checks:

```bash
pnpm --filter @zelavis/ui typecheck
pnpm --filter @zelavis/ui build
```

## Related Docs

- [Dashboard Development](../guides/dashboard-development.md)
- [Mobile-Slot-Ready Dashboard](../architecture/mobile-slot-ready-dashboard.md)
- [Route Conventions](../reference/route-conventions.md)
