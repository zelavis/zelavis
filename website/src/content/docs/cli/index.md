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
configured, and which credential providers are available. Password sign-in is
part of Zelavis, so nothing has to be installed first. One provider covers both
identifier kinds: an identifier containing `@` is treated as an email address,
anything else as a username.

## OAuth sign-in

The Authorization Code flow is part of Zelavis: it holds the state, nonce, and
PKCE verifier, which are the parts that are dangerous to get wrong and the same
for every provider. What differs per provider — endpoints and claim mapping —
is a definition, and Google, GitHub, and a generic OIDC builder ship in the box.

The credentials your installation was issued are yours to supply:

```bash
curl -X PUT https://example.com/zelavis/api/v1/auth/oauth/connections/github   -H 'content-type: application/json'   -d '{
    "clientId": "...",
    "clientSecret": "...",
    "redirectUri": "https://example.com/zelavis/api/v1/auth/oauth/github/callback"
  }'
```

The client secret is write-only: no endpoint returns it, and omitting it on a
later write keeps the stored one. A redirect URI must use `https` outside
`localhost`, because the authorization code arrives on that URL and a code is
enough to complete a sign-in.

An installation that must come up already configured can set
`ZELAVIS_AUTH_<PROVIDER>_CLIENT_ID`, `_CLIENT_SECRET`, `_REDIRECT_URI`, and
`_SCOPES` instead. Anything stored through the API wins.

To add a provider nobody has defined yet, ship a plugin declaring
`"capabilities": ["zelavis/auth:oauth"]` whose service exports
`oauthProviders`. A definition with an `issuer` must also give a `jwksUrl`: an
ID token nobody can verify is attacker-supplied JSON, so one is refused at
definition time.

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

## Product Services

Services can be dropped into a folder on the server instead of composed in
code. The Platform scans `<data directory>/product-services` at boot:

```
/var/lib/zelavis/product-services/
  acme-analytics/package.json
  @acme/theme/package.json
```

Each package needs a `package.json` with a `zelavis` block naming its `kind`,
`type: "module"`, and an `exports` entry. Scoped packages nest one level
deeper, exactly as they do in `node_modules`. Restart the Platform to pick up
changes.

Code in this folder runs with Platform authority, which is inherent to a folder
on your own server — treat adding a package there as seriously as installing
one. Discovery still refuses anything it cannot verify: an `exports` entry that
resolves outside its own package directory, a missing entry file, an invalid
manifest, an invalid capability, or a package claiming a reserved core service
name. Each is skipped with a logged reason, and a package that throws on import
is skipped too, so one bad package cannot stop the Platform from booting.

### Declaring what a plugin extends

A capability says which contract a service satisfies. Alongside the Platform's
own namespaces (`api:routes`, `provider:auth`), a capability can be owned by
the package that defines it:

```json
{
  "zelavis": {
    "kind": "plugin",
    "capabilities": ["@zelavis/auth:credentials"]
  }
}
```

This is how a provider says which plugin it extends. `provider:payments` states
what interface a plugin implements but not whose contract it is, so two
commerce plugins scanning for it would each pick up the other's providers.

There is no parent/child relationship behind this. Discovery is a flat scan,
naming an owner asks to be considered by it and grants nothing, and the owning
plugin still validates every provider against its own registration contract.

### Bundled services

The distribution seeds the services it ships into the product-services folder
the first time it starts, the way a CMS lays down its bundled plugins. They are
ordinary packages from that point on: list them, replace them, or delete them.
A deleted one stays deleted rather than reappearing on the next restart.

Packages in the folder can import `zelavis` — the running Platform is linked
into `<data directory>/product-services/node_modules` so Node's resolution
finds it, and the link always points at the Platform that loaded the package
rather than another copy on the machine.

### Frontends and their mount path

A static frontend is built once and served from wherever it is installed. Two
manifest fields make that work:

```json
{
  "zelavis": {
    "kind": "frontend",
    "frontend": {
      "runtime": "static",
      "bundle": "build/client",
      "mode": "spa",
      "assetBase": "/assets/",
      "basePathGlobal": "__ZELAVIS_BASE_PATH__"
    }
  }
}
```

`assetBase` names the prefix the bundle's own references were built against, so
the Platform can rewrite them to the real mount — including unquoted CSS
references such as `url(/assets/font.woff2)`.

`assetBase` moves references that appear in the markup. It cannot tell a
client-side router where it lives, because that is a value the bundle reads at
boot rather than a path to rewrite. `basePathGlobal` names a global the Platform
defines on the served page, holding the mount path; the bundle reads it and
configures its own router. The Platform knows nothing about what reads it, so
this works for any framework.

Without `basePathGlobal` a bundle must be built for a fixed mount, which is what
kept a frontend from being installed anywhere but the path it was built for.
