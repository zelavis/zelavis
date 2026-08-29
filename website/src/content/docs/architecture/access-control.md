---
title: Access Control
---
Zelavis uses one core access model for the control plane, project dashboards,
service endpoints, CLI calls, AI agents, scripts, and future official modules
such as Hosting Provider.

The dashboard is not the authority layer. Menus and project cards are filtered
for usability, but endpoint access is enforced by the server contract.

## Core Shape

The base model lives in `zelavis/core`:

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

## Why This Is Not Only `zelavis/app/auth`

`zelavis/app/auth` owns authentication building blocks: accounts, credentials,
sessions, and pluggable auth methods such as email/password, username/password,
passkeys, OAuth, SSO, API keys, or service-token providers.

`zelavis/core` owns the lower-level authorization contract because every
runtime service needs a way to declare and enforce access requirements without
depending on one authentication method.

That separation keeps the core extensible:

- a dashboard session can resolve a principal
- an API key can resolve a principal
- an AI agent token can resolve a principal
- a Hosting Provider customer login can resolve a principal
- a future SSO plugin can resolve a principal

All of those callers still pass through the same route access checks.

## Native Request Authentication

The runtime composes `ZelavisRequestAuthenticator` implementations directly on
the standard Web `Request` boundary. No router framework owns authentication.

- opaque App sessions use 256-bit random `zvs_` tokens and persist only a
  SHA-256 token digest
- App accounts, credentials, and sessions persist through the App's
  tenant-routed database boundary
- Platform accounts, credentials, and sessions persist separately in the
  System Store
- session credentials may arrive through `Authorization: Bearer` or an
  HttpOnly, SameSite cookie that is Secure on HTTPS deployments
- scripts receive the issued bearer token directly; a response sets the
  session cookie only for a request carrying a matching same-origin `Origin`
- cookie-authenticated mutations require a matching same-origin `Origin`
- first-owner bootstrap requires an operator-configured high-entropy token and
  a credential-enrollment provider; the token is never a normal login method
- optional Basic, JWT, and remote-JWKS authenticators resolve into the same
  principal model
- invalid credentials produce a `401` and the appropriate
  `WWW-Authenticate` challenge

Password methods are ordinary `provider:auth` plugins under `plugins/`, not
code embedded in the unified package. The shared Web Crypto password primitive
uses salted PBKDF2-HMAC-SHA-256. The OIDC plugin validates bearer tokens through
issuer, audience, algorithm, and JWKS checks; interactive authorization-code
login and provider-specific account linking remain endpoint workflows to add
on top of that verifier.

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

Access itself is contributed through the normal service menu API by the
product-specific `zelavis/platform` service. It is implemented with the reusable
access contracts from `zelavis/core`. Its menu uses the `platform` surface, which is
reserved for bundled or statically trusted system services that belong in the
global `/zelavis` management shell. Runtime-installed marketplace plugins still
mount under Extensions.

## Platform Bootstrap And Login

`GET /zelavis/api/v1/auth/bootstrap` reports whether the installation still
needs its first owner and which installed auth providers support credential
enrollment. `POST /zelavis/api/v1/auth/bootstrap` is disabled unless the
operator configured `ZELAVIS_BOOTSTRAP_TOKEN` or `bootstrap.token`; successful
bootstrap consumes an installed provider's enrollment contract and issues the
first owner session.

The dashboard login screen calls the same versioned Auth endpoints as other
clients. `/zelavis/api/v1/runtime/access` requires authentication and returns
the real session principal. There is no demo-owner fallback or query-string
identity switch.

## Rule For Services

Any service or plugin that performs a privileged action should:

1. Define a capability in the service/runtime layer.
2. Expose it through a stable endpoint.
3. Declare route access requirements.
4. Optionally declare menu access requirements so the dashboard can hide
   unavailable UI.
5. Never rely on hidden dashboard state as the only protection.
