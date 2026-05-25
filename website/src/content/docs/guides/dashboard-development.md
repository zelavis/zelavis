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

## Important package boundary

The dashboard source lives in the `@zelavis/ui` workspace package, but application users should serve the dashboard through `zelavis`.

The UI package is internal workspace infrastructure, not the public application-facing runtime entry point.

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
