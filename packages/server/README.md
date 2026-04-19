# @zelavis/server

`@zelavis/server` defines a shared server-service contract and adapters that mount service APIs on server frameworks.

It is intended to be the common server integration layer for packages such as `@zelavis/auth` and `@zelavis/ecommerce`.

## Core ideas

- Packages export server services with `defineServerService({ name, api: { v1: [...] } })`.
- Services may compose nested `services`, and nested services are mounted below the parent service path.
- `zelavisServer({ services, integration })` resolves routes and mounts them.
- Route prefixes and per-endpoint path overrides are applied at mount time.
- `zelavisServer(...)` returns `{ services, server }` so apps can access service instances and integration-specific return values.

## Integrations

- `@zelavis/server/integrations/express`
- `@zelavis/server/integrations/hono`
