---
title: "zelavis/core"
---
`zelavis/core` is a public subpath of the unified `zelavis` package. It defines
the shared server service contract and Web-first runtime surface.

## Current role

Packages expose server services through a shared contract, and the runtime
exposes Web-standard handlers plus a standalone Node HTTP adapter.

## Core ideas

- packages export services as plain `ZelavisRuntimeService` object literals
- core packages should expose one obvious top-level service-definition file so package authors can find the service entrypoint without hunting through nested folders
- services can compose nested services
- `createServiceRuntime(...)` resolves routes once and exposes reusable runtime handlers
- `zelavis/runtimes/node` adapts the resolved runtime to a standalone Node HTTP server

## Runtime surfaces

Current runtime surfaces include:

- `fetch(request)`
- `plain({ ... })`
- `dispatch(request)`

The high-level runtime also uses `zelavis/core` for runtime introspection,
service-registry operations, service menu discovery, and service-owned page
documents. This metadata remains available in headless project runtimes, so the
single Platform `@zelavis/ui` dashboard can render a selected project's menus
without that project serving another dashboard application.

## Fabric Control Plane

Fabric is the server-owned scaling subsystem for node inventory, project
placement, routing, balancing, migration, recovery, and future replication
coordination. It lives inside `zelavis/core`, not as a separate package.

The Platform OS exposes its current read capabilities under
`/zelavis/api/v1/fabric/*`. The dashboard reaches them from the regular Server
area rather than through a standalone Fabric service menu item.

## Access Model

`zelavis/core` defines the shared access-control vocabulary for Zelavis
capabilities. A runtime can resolve a `ZelavisPrincipal` for a request, and a
service route can declare `access` requirements such as required roles,
permissions, and a scope.

Scopes can be system-wide, project-scoped, or service-scoped. Project-scoped
requirements can bind to route params, so a route such as
`/:projectId/content/:entryId` can require a grant for exactly that project.

This is core to the future hosting-provider direction. A first-party Hosting
Provider module should use the same principal and grant model for owners,
operators, resellers, and customers. A customer logging into `/zelavis` should
see only the projects and actions their grants allow, while the endpoints also
enforce those same permissions.

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

Dashboard filtering is presentation only. The endpoint remains the authority
layer.

## Why it matters

This subpath is the transport boundary that keeps domain packages mountable without baking framework logic into each package.

It is also the boundary that keeps dashboard behavior automatable. If the dashboard can perform a platform action, the same action should be exposed through a service endpoint so the CLI, AI agents, scripts, plugins, and external admin tools can call it too.

## Related docs

- [zelavis](./zelavis.md)
- [Endpoint-Backed Capabilities](../architecture/endpoint-backed-capabilities.md)
- [Node adapter](../adapters/node.md)
- [Service Authoring](../guides/service-authoring.md)
