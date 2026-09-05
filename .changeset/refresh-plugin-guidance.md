---
"zelavis": patch
---

Bring the plugin API guide into the docs, and correct guidance the recent
changes made wrong.

The guide covering `package.json` classification, the three service kinds, the
SDK surface, menus, routes, commands, events and nested services now ships as
`guides/plugin-api.md` rather than living outside the repository. Two things it
carried are corrected against the source it defers to: the auth capability is
`zelavis/auth:oauth` since core auth was renamed, and `zelavis.services.add()`
is documented as a module-evaluation API, with `setup(context)` and
`context.addService` as what a service built from the registry, a database, or
platform resources uses instead.

Corrected elsewhere: `AGENTS.md` described `coreServices.dashboard.devServerUrl`
and discovery by `provider:auth`; the access-control page said password methods
are plugins under `plugins/`; two pages showed the removed `kind: "provider"`;
the service-authoring guide cited a deleted package; the CLI page used the
pre-rename `@zelavis/auth:credentials`; and the composition guide documented
`frontend: false`.

The core-platform skill gains what this work settled: capabilities name the
service that owns them, core names no capability owned by a product it does not
ship, features are not switched off in code, and the loader must carry
everything a plugin declares.
