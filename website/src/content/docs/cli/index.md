---
title: CLI
---

The public `zelavis` command starts and operates the long-running Platform OS.
`@zelavis/cli` provides its reusable endpoint-backed command implementation.

Install the Platform package to get the complete command, including `serve`:

```bash
npm install --global zelavis
zelavis --help
```

Operating-system packages expose the same executable without requiring a global
Node installation:

```bash
zelavis serve
```

## Commands

- `serve` starts the Platform runtime and dashboard.
- `services list` lists service registry entries.
- `services register` registers an ESM service specifier.
- `services install` activates a registered service.
- `services disable` returns a service to the available state.

## Runtime Operations

The CLI is the intended layer for operator-facing runtime workflows such as
installing, activating, disabling, or removing services. Those workflows should
use official Zelavis runtime APIs and adapter-provided capabilities instead of
application code passing service toggles into `new Zelavis(...)`.

Adapter-specific behavior should stay behind adapter boundaries. The CLI can
ship first-party commands for supported adapters, but concrete host mechanics
such as local file caches or future Deno runtime setup should live in adapter
modules that the CLI orchestrates.

Framework bootstrap commands are intentionally absent. Zelavis is installed as
a long-running Platform OS; framework bindings are adapters and provider
capabilities are plugins rather than hosts for the Platform itself.

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
