---
title: Dashboard Development
---
This guide documents the current recommended workflow for dashboard work.

## Preferred workflow

Use:

```bash
pnpm run ui:dev
```

Current behavior:

- the Zelavis runtime runs on port `3000`
- the UI dev server runs on port `3001`
- dashboard requests under `/zelavis` redirect to the live UI dev server
- the live UI dev server is mounted at `http://127.0.0.1:3001/zelavis/` for parity with production routing
- `/zelavis` opens Projects, global Marketplace and Server live outside projects, and project-local pages live under `/zelavis/projects/:projectId/*`

## Important package boundary

The dashboard source lives in the `@zelavis/ui` monorepo package, but application users should serve the dashboard through `zelavis`.

The UI package is internal repo infrastructure, not the public application-facing runtime entry point.

The dashboard is also not the authority layer for platform behavior. When adding
a dashboard feature, implement the domain capability and endpoint first, then
have the dashboard call it. A feature that can only be performed from React
route code is not a finished Zelavis platform feature.

## Mobile-slot-ready route structure

Build dashboard routes so desktop pages and future mobile/sidebar slides can
reuse the same feature pieces.

The recommended shape is:

- keep route-level data loading in `clientLoader` or resource routes
- extract reusable feature or panel components for the feature
- compose those pieces in the route for the desktop content area
- wrap mobile-ready regions with `DashboardSlotLayout` and `DashboardSlot`
- declare optional `handle.slots` metadata when the route naturally maps to
  mobile slide slots

Good slot boundaries are `overview`, `main`, `create`, `edit`, `inspect`, and
`settings`. Avoid making a second mobile-only version of forms, builders,
schema panels, charts, or operational workflows.

## Embedded dashboard behavior

The `@zelavis/ui` package embeds built dashboard assets into its dashboard
service during its build process.

That means:

- editing UI source alone does not update embedded runtime assets
- when you need the embedded dashboard updated, rebuild `@zelavis/ui` or run the
  normal `zelavis` package build, which builds the UI package first

```bash
pnpm --filter zelavis build
```

## Generated files

Do not hand-edit generated router output in the UI package.

Change route source files under the UI source tree and let the normal build/dev workflow regenerate what is needed.

## Recommended validation

For UI-only validation:

```bash
pnpm --filter @zelavis/ui typecheck
pnpm --filter @zelavis/ui build
```

For embedded runtime validation:

```bash
pnpm --filter zelavis build
```
