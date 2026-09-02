---
title: CLI
---

The public `zelavis` command starts and operates the long-running Platform OS.
Its endpoint-backed command implementation is `zelavis/cli`, importable on its
own for tooling that wants the commands without the binary.

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
- `bootstrap` creates the first Platform owner account.
- `bootstrap status` reports whether an owner still has to be created.
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
capabilities are plugins rather than hosts for the Platform itself. The
`bootstrap` command below is a different thing: it claims the first owner of an
already-running Platform, not a project scaffold.

## First Owner

A freshly installed Platform has no accounts. Until one exists there is nobody
to sign in as, so claiming the first owner is a one-time operation guarded by a
token the operator sets on the server:

```bash
ZELAVIS_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)" zelavis serve
```

The endpoint stays closed unless that variable is set, so a Platform started
without it cannot have an owner claimed by whoever reaches it first. With the
Platform running, create the owner from the same machine:

```bash
zelavis bootstrap --email owner@example.com --display-name "Owner"
```

The command prompts for the password with the terminal echo turned off. There
is deliberately no `--password` option: anything passed as an argument is
readable in shell history and in the system process list, which is not an
acceptable place for the credential that owns the Platform. Passing it is
refused rather than ignored. For unattended installs, pipe it instead:

```bash
printf '%s' "$OWNER_PASSWORD" | zelavis bootstrap --email owner@example.com --password-stdin
```

To check where an installation stands before doing anything:

```bash
zelavis bootstrap status
```

That reports whether an owner exists, whether the bootstrap token is
configured, and which credential providers are installed. The `zelavis`
distribution ships `@zelavis/app-auth-email-password`, so a default
installation can be adopted with nothing extra to install. The Platform library
itself names no provider: hosts that embed it choose their own through the
`authMethods` option, and an installation with no provider reports none rather
than pretending it can enroll an owner.

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
