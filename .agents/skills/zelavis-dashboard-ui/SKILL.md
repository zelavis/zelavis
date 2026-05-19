---
name: zelavis-dashboard-ui
description: Use when working on the Zelavis dashboard UI in packages/ui, including TanStack Start routes, the slide-based sidebar, mounted /zelavis dev behavior, and embedded-runtime dashboard integration.
---

# Zelavis Dashboard UI

Use this skill for changes in:

- `packages/ui`
- embedded dashboard behavior in `packages/zelavis`
- dashboard routing, settings, theme, and navigation

## Working rules

- Use `pnpm run ui:dev` for end-to-end dashboard work.
- The mounted dashboard path is `/zelavis`, including in dev mode.
- Do not hand-edit `packages/ui/src/routeTree.gen.ts`.
- Keep the existing slide-based sidebar model intact unless the task explicitly changes navigation structure.
- Keep dashboard and runtime behavior aligned; dev mode should not drift from production mounting rules.

## UI expectations

- Preserve the current design language unless the task asks for a redesign.
- Prefer existing shadcn/TanStack patterns already in the package.
- Be careful with layout regressions in the sidebar and header.
- Treat `Community` as content inside the first sidebar slide.

## Validation

Use the smallest relevant checks:

```bash
pnpm run ui:dev
pnpm --filter @zelavis/ui typecheck
pnpm --filter @zelavis/ui build
pnpm --filter @zelavis/ui test:e2e
```

After substantial UI changes, verify the mounted dashboard flow still works at:

- `http://127.0.0.1:3000/zelavis`
- `http://127.0.0.1:3001/zelavis/`
