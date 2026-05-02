# Installation

Zelavis is a pnpm workspace project made of composable packages.

## Requirements

Current recommended baseline:

- Node.js
- pnpm

Some examples and adapters also target other runtimes, but the main repository workflow today is centered on pnpm and the existing workspace scripts.

## Install workspace dependencies

From the repo root:

```bash
pnpm install
```

## Common validation commands

Use these from the repo root:

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Main local dashboard workflow

For end-to-end dashboard work, prefer:

```bash
pnpm run ui:dev
```

Current behavior:

- the Zelavis runtime runs on `http://127.0.0.1:3000`
- the UI dev server runs on `http://127.0.0.1:3001`
- dashboard requests under `/zelavis` redirect to the live UI dev server mounted at `http://127.0.0.1:3001/zelavis/`

## What to read next

- [First Runtime](./first-runtime.md)
- [Dashboard Development](../guides/dashboard-development.md)
- [zelavis package](../packages/zelavis.md)
