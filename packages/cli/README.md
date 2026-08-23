# @zelavis/cli

`@zelavis/cli` is the endpoint-backed operator CLI for Zelavis. The public
`zelavis` package injects the Platform runtime and owns the `zelavis serve`
command; this lower-level package owns reusable parsing and API clients.

## Runtime operations

The CLI is the intended home for operator-facing runtime workflows such as
installing, activating, disabling, or removing services. Those commands should
talk to official Zelavis runtime APIs and adapter-provided capabilities rather
than asking application code to pass service toggles into `new Zelavis(...)`.

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

The old framework bootstrap commands were removed with the embedded/serverless
runtime architecture. Zelavis runs as a long-lived Platform OS; framework and
deployment integrations belong in adapters or plugins.
