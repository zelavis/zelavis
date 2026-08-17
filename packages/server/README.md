# @zelavis/server

`@zelavis/server` defines a shared service contract plus a Web-first execution layer for running Zelavis APIs across Node.js and server frameworks.

It is intended to be the common adapter layer for platform packages such as `@zelavis/auth`, `@zelavis/db`, and the high-level `zelavis` runtime, while remaining reusable for optional domain packages such as `@zelavis/ecommerce`.

## Core ideas

- Packages define service entrypoints with `defineService(...)`; the normalized result is also mountable as a `ZelavisRuntimeService`.
- Core packages should expose one obvious top-level service-definition file, such as `src/auth-service.ts` or `src/database-service.ts`, so package authors can find the service entrypoint immediately.
- Services may compose nested `services`, and nested services are mounted below the parent service path.
- `zelavisServer({ services })` resolves routes once and exposes reusable runtime handlers.
- Route prefixes and per-endpoint path overrides are applied before dispatch.
- `zelavisServer(...)` returns `{ services, routes, fetch, plain, dispatch }`.

## Endpoint-backed capabilities

`@zelavis/server` is the place where Zelavis capabilities become transportable API surface. Any behavior the dashboard can perform should be mounted through a stable service endpoint as well, so CLI commands, AI agents, scripts, plugins, and external admin tools can perform the same operation.

Do not treat dashboard routes or framework-specific server actions as the authoritative implementation of platform behavior. Define the capability in the service/runtime layer, expose it through this server contract, then let the dashboard call it as a client.

Service menus may declare a dashboard `surface`. `platform` is the global
`/zelavis` management shell, while `root`, `core`, `extensions`, and `settings`
belong to Zelavis-native project dashboards. Runtime-installed marketplace
services are constrained to Extensions; privileged surfaces are for bundled or
statically trusted system services.

## Access model

`@zelavis/server` also defines the first core access-control boundary. Runtime
hosts can resolve one `ZelavisPrincipal` per request and services can declare
route-level `access` requirements.

The model is intentionally shared by core packages, the dashboard, CLI flows,
AI agents, scripts, and future official modules such as a Hosting Provider
module. A customer dashboard should not have a separate permission system:
customers, resellers, operators, and owners are all principals with roles,
permissions, and scoped grants.

Example:

```ts
{
  id: "projects.content.update",
  method: "PATCH",
  path: "/:projectId/content/:entryId",
  access: {
    permissions: ["project.content.write"],
    scope: { type: "project", projectIdParam: "projectId" },
  },
  handler({ principal, params }) {
    return {
      body: {
        principalId: principal?.id,
        projectId: params.projectId,
      },
    };
  },
}
```

That lets the same `/zelavis` dashboard shell act as:

- an owner/superadmin console when the principal has system grants
- an operator/support console when the principal has delegated grants
- a reseller console when grants are scoped to reseller-owned projects
- a customer console when grants are scoped only to that customer's projects

Hiding a dashboard menu item is only presentation. The endpoint must enforce
the same requirement because it is the authority layer.

## Runtime surfaces

- `fetch(request)` for Web and fetch-compatible runtimes
- `plain({ url, method, headers, body })` for tests and object-in/object-out embedding
- `dispatch(request)` when adapters need match metadata as well as the final `Response`
- explicit adapter helpers built around the resolved runtime when a framework-specific shape is useful

## Guarantees being targeted

- streaming `ReadableStream` responses stay stream-based through the Node and Express adapters
- repeated headers such as `set-cookie` are preserved for framework adapters and plain inspection
- binary request and response bodies stay binary instead of being coerced into text
- `multipart/form-data` bodies are preserved as form values instead of being flattened away
- `HEAD` requests can reuse `GET` handlers without sending a response body

## Adapters

- `@zelavis/server/adapters/elysia`
- `@zelavis/server/adapters/node`
- `@zelavis/server/adapters/express`
- `@zelavis/server/adapters/fastify`
- `@zelavis/server/adapters/hono`
- `@zelavis/server/adapters/h3`
- `@zelavis/server/adapters/nextjs-pages-router`

Use the Node.js adapter when Zelavis should own a standalone HTTP server. Use an Elysia plugin, Express middleware, a Fastify plugin, Hono/h3 middleware handlers, or the Next.js Pages Router adapter when mounting Zelavis into an existing self-hosted app. When embedding into a fetch-oriented Node/Bun handler such as Next.js App Router or Bun.serve, call `fetch(...)` directly and skip mount adapters entirely.

For fetch-native examples, see [examples/web-fetch](../../examples/web-fetch), [examples/bun](../../examples/bun), and [examples/nextjs](../../examples/nextjs). For mounting inside existing apps, see [examples/elysia](../../examples/elysia), [examples/fastify](../../examples/fastify), [examples/h3](../../examples/h3), and [examples/nextjs-pages-router](../../examples/nextjs-pages-router).
