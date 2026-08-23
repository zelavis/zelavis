---
title: Access Control
---
Zelavis uses one core access model for the control plane, project dashboards,
service endpoints, CLI calls, AI agents, scripts, and future official modules
such as Hosting Provider.

The dashboard is not the authority layer. Menus and project cards are filtered
for usability, but endpoint access is enforced by the server contract.

## Core Shape

The base model lives in `@zelavis/server`:

- a `ZelavisPrincipal` represents the caller
- roles describe broad identity shape such as owner, operator, reseller, or customer
- permissions describe concrete capabilities
- grants attach permissions to a scope
- access requirements are declared on routes and service-owned menu items

Scopes can be:

- `system` for owner/operator actions that affect the whole Zelavis instance
- `project` for project, site, app, and customer-owned resources
- `service` for service/plugin-owned capabilities

Example route requirement:

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

## Why This Is Not Only `@zelavis/app/auth`

`@zelavis/app/auth` owns authentication building blocks: accounts, credentials,
sessions, and pluggable auth methods such as email/password, username/password,
passkeys, OAuth, SSO, API keys, or service-token providers.

`@zelavis/server` owns the lower-level authorization contract because every
runtime service needs a way to declare and enforce access requirements without
depending on one authentication method.

That separation keeps the core extensible:

- a dashboard session can resolve a principal
- an API key can resolve a principal
- an AI agent token can resolve a principal
- a Hosting Provider customer login can resolve a principal
- a future SSO plugin can resolve a principal

All of those callers still pass through the same route access checks.

## Dashboard Views

The same `/zelavis` shell can render different views depending on the current
principal:

- owner or superadmin: all projects plus server, domains, resources, security,
  marketplace, and project controls
- operator: delegated server/project controls
- reseller: projects and customers owned by that reseller
- customer: only their projects and allowed project actions

This is the intended foundation for a future official Hosting Provider module.
The module should not create a separate customer permission system. It should
create customers, subscriptions, packages, and grants that feed the same core
principal model.

Access itself is contributed through the normal service menu API by the core
`@zelavis/server` service. Its menu uses the `platform` surface, which is
reserved for bundled or statically trusted system services that belong in the
global `/zelavis` management shell. Runtime-installed marketplace plugins still
mount under Extensions.

## Current Demo Mode

The dashboard currently has a development/demo switch so the shape can be
tested before real login flows are wired:

- `/zelavis` shows the owner-shaped console
- `/zelavis?as=owner` also shows the owner-shaped console
- `/zelavis?as=customer` shows a customer-shaped console

Customer mode is intentionally limited. It shows only the projects and
project-local menus granted to the demo customer. This is not production
authentication; it is a visible proof of the authorization shape.

## Rule For Services

Any service or plugin that performs a privileged action should:

1. Define a capability in the service/runtime layer.
2. Expose it through a stable endpoint.
3. Declare route access requirements.
4. Optionally declare menu access requirements so the dashboard can hide
   unavailable UI.
5. Never rely on hidden dashboard state as the only protection.
