# @zelavis/server

`@zelavis/server` defines a shared server-service contract and adapters that mount service APIs on Node.js and server frameworks.

It is intended to be the common integration layer for platform packages such as `@zelavis/auth`, `@zelavis/database`, and the high-level `zelavis` runtime, while remaining reusable for optional domain packages such as `@zelavis/ecommerce`.

## Core ideas

- Packages export server services with `defineServerService({ name, api: { v1: [...] } })`.
- Services may compose nested `services`, and nested services are mounted below the parent service path.
- `zelavisServer({ services, integration })` resolves routes and mounts them.
- Route prefixes and per-endpoint path overrides are applied at mount time.
- `zelavisServer(...)` returns `{ services, server }` so apps can access service instances and integration-specific return values.

## Integrations

- `@zelavis/server/integrations/node`
- `@zelavis/server/integrations/express`
- `@zelavis/server/integrations/hono`

Use the Node.js integration when Zelavis should own a standalone HTTP server. Use Express or Hono integrations when mounting Zelavis into an existing app.
