# @zelavis/cli

`@zelavis/cli` provides command-line tools for bootstrapping, developing, and
operating Zelavis apps.

Use it directly through a package runner:

```bash
pnpm dlx @zelavis/cli bootstrap react-router
```

The React Router bootstrap target supports React Router 7 Framework Mode apps.
It creates a catch-all Zelavis resource route and a small server-side Zelavis
runtime module for the selected deployment adapter.

Next.js bootstrap supports both App Router and Pages Router:

```bash
pnpm dlx @zelavis/cli bootstrap nextjs
pnpm dlx @zelavis/cli bootstrap nextjs --router pages --adapter node --yes
```

For non-interactive usage:

```bash
zelavis bootstrap react-router --adapter node --yes
```

## Runtime operations

The CLI is the intended home for operator-facing runtime workflows such as
installing, activating, disabling, or removing services. Those commands should
talk to official Zelavis runtime APIs and adapter-provided capabilities rather
than asking application code to pass service toggles into `new Zelavis(...)`.

Adapter-specific behavior should stay behind adapter boundaries. The CLI can
ship first-party commands for supported adapters, but concrete host mechanics
such as local file caches, Cloudflare worker dispatch, or serverless deployment
hooks should live in adapter modules that the CLI orchestrates.

Today, `@zelavis/cli` ships bootstrap commands. Runtime service management is
available through the `services` command group:

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
