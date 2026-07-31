---
title: CLI
---

`@zelavis/cli` provides command-line tools for bootstrapping, developing, and
operating Zelavis apps.

Use the CLI through a package runner when you do not want to install it globally:

```bash
pnpm dlx @zelavis/cli --help
npx @zelavis/cli --help
bunx @zelavis/cli --help
```

The package exposes a `zelavis` binary, so installed projects can also run:

```bash
zelavis --help
```

## Commands

- [Bootstrap](./bootstrap.md) - create framework-specific Zelavis endpoints for existing apps.

## Runtime Operations

The CLI is the intended layer for operator-facing runtime workflows such as
installing, activating, disabling, or removing services. Those workflows should
use official Zelavis runtime APIs and adapter-provided capabilities instead of
application code passing service toggles into `new Zelavis(...)`.

Adapter-specific behavior should stay behind adapter boundaries. The CLI can
ship first-party commands for supported adapters, but concrete host mechanics
such as local file caches or future Deno runtime setup should live in adapter
modules that the CLI orchestrates.

Runtime service management is available through the `services` command group:

```bash
zelavis services list
zelavis services register --specifier https://example.com/service.mjs
zelavis services register --specifier https://example.com/service.mjs --install
zelavis services install @zelavis/ecommerce
zelavis services disable @zelavis/ecommerce
```

The commands talk to `http://localhost:3000/zelavis` by default. Use `--url`
when the runtime is mounted elsewhere:

```bash
zelavis services list --url http://localhost:8787/zelavis
```
