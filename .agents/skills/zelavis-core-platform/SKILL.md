---
name: zelavis-core-platform
description: Use when changing Zelavis core packages such as zelavis, @zelavis/server, @zelavis/db, or @zelavis/auth, especially for service boundaries, adapters vs plugins, public API shape, and runtime-neutral architecture decisions.
---

# Zelavis Core Platform

Use this skill for changes in:

- `packages/zelavis`
- `packages/server`
- `packages/db`
- `packages/auth`

Start by reading `AGENTS.md` and the relevant package README before editing.

## Working rules

- Treat `zelavis()` as the main runtime entrypoint.
- Keep core packages runtime-neutral and based on standard Web APIs.
- Put framework or host behavior only in `adapters/*`.
- Put optional provider or domain capabilities only in `plugins/*`.
- Prefer tightening exports over broad `export *` surfaces.
- Preserve the service model; do not invent a parallel composition pattern.

## Design checklist

1. Start from the public API and package boundary.
2. Decide whether the change belongs in core, an adapter, or a plugin.
3. Keep defaults ergonomic, but leave escape hatches.
4. Update the nearest README when public behavior changes.
5. Add or update focused tests in the affected package.

## Validation

Run the smallest useful checks first, then broaden as needed:

```bash
pnpm --filter zelavis test
pnpm --filter @zelavis/server test
pnpm --filter @zelavis/db test
pnpm --filter @zelavis/auth test
pnpm check
```
