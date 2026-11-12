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

## Why This Is Not Only `zelavis/app/identity`

`zelavis/app/identity` owns authentication building blocks: accounts, credentials,
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

Password sign-in is part of Zelavis rather than a plugin. An installation with
no credential provider can never create its first owner, so it is not something
an extension supplies. One provider covers both identifier kinds: an identifier
containing `@` is treated as an email address, anything else as a username. The
password primitive uses salted PBKDF2-HMAC-SHA-256 over Web Crypto, and an
unknown identifier is verified against a decoy hash so the response does not
reveal whether an account exists.

The OAuth Authorization Code flow is core too — it holds the state, nonce and
PKCE verifier, which are the parts that are dangerous to get wrong and the same
for every provider. Any OpenID Connect issuer is added by pasting its issuer
URL; a plugin declaring `zelavis/identity:oauth` is needed only for a provider that
is not OIDC, where the profile endpoint and claim mapping are real code. The
OIDC plugin under `plugins/` is now only a bearer-token authenticator for
callers already holding a token from an issuer
on top of that verifier.

## Dashboard Views

The same `/zelavis` shell can render different views depending on the current
principal:

- owner or superadmin: all projects plus server, domains, resources, security,
  marketplace, and project controls
- operator: delegated server/project controls
- reseller: projects and customers owned by that reseller
- customer: only their projects and allowed project actions

The creator ID provides attribution. Inventory and actions use explicit
permissions. Full Project inventory requires global `projects.list`,
top-level `project.view` or global wildcard authority.
Other signed-in principals see only exact `project.view` and scoped wildcard
Project grants. Deleted and tombstoned Projects are omitted. Scoped inventory
resolves at most 100 distinct IDs with four concurrent reads.

### Project domain delegation

Grant `project.domains.view` for read-only inventory, or
`project.domains.manage` to read, add, verify and remove domains. Scope each
grant to the exact Project. Also grant `project.view` for dashboard inventory
and navigation. The SDK and CLI can administer domains with the domain grant
alone. Server Edge inventory and configuration use their own
`server.edge.view` and `server.edge.manage` permissions.

This is the intended foundation for a future official Hosting Provider module.
The module should not create a separate customer permission system. It should
create customers, subscriptions, packages, and grants that feed the same core
principal model.

Access itself is a native Platform capability, implemented with the reusable
access contracts from `zelavis/core`. Its dashboard navigation is contributed by
`@zelavis/ui` through the normal service menu API on the `platform` surface,
which is reserved for bundled or statically trusted system services that belong in the
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

## Registration authority

Native Identity owns a registration policy in each runtime's own store. The
Platform keeps its policy in the System Store and each App keeps its policy in
its own database. The Platform requires a completed first-owner claim before
public enrollment. A policy revision serializes disabling registration with
password and first-time OAuth enrollment. Accounts staged by an interrupted
enrollment stay unavailable for sign-in until recovery finishes the committed
account or removes the staged writes.

A registered human starts with the Platform `customer` or App `user` role
and no grants. App users retain the per-account Tenant default. Changing one
Project's registration policy requires `project.settings.manage` for that
exact Project. The Platform gateway forwards only that permission to the App.
Platform-wide policy changes require `system.settings.manage` in system scope.

The Platform Auth settings page and each Project's Auth page edit these same
policies. The Project registration control uses the exact settings route, so
its availability is independent of provider-administration and runtime-config
reads. The Platform login page offers Create account while password enrollment
is available. Server policy also refuses an open form after registration closes.

On a native App's site origin, public password forms and self-session routes
use that App's Identity runtime. The ingress accepts only the selected App's
cookie or audience-shaped bearer. Identity verifies the token digest, expiry
and session epoch against the App's own store. Cookie mutations require the
same browser origin. The public ingress strips Platform and sibling Project
credentials and sends no Gateway authority. The Platform's authenticated
management proxy continues to strip child response cookies.

## Human access delegation

Native Identity conditionally replaces a human account's role, permissions and
concrete scoped grants. The access revision and session epoch commit together
through the account repository's atomic mutation. Repeated input at an old
revision fails with HTTP 409. An identical write at the current revision
preserves sessions.

The runtime bounds admission and serializes account administration. A locally
authenticated administrator's account authority is refreshed inside that gate.
Both old and proposed target authority must be held by the actor. Role changes
use the Platform's `customer`, `operator` and `reseller` labels, or an App's
`user` label. Elevated labels require the same actor label or a top-level
wildcard. Owner, service, pending and self-access edits are refused.

The exact Project route first reads only the named App account and intersects
the current and requested concrete permission names with the caller's exact
Project authority. The Gateway signs a digest bound to the account, conditional
input and that permission set in its existing audience-bound, single-use
envelope. The child rechecks the digest and target revision under its writer
gate. The digest keeps the 100-entry edit within local header and remote
dispatch bounds. Generic proxy authority cannot substitute for that proof.

Successful writes append a security event containing actor ID, target ID and
revision. An audit failure reports the committed revision so callers can read
the authoritative account. Credential administration and grant-bearing
creation enforce the same authority checks. Identity metadata remains confined
to its dedicated operations.

The dashboard consumes the authenticated `/runtime/access` response when
filtering menus and Project actions. A registered customer can open Projects
with an empty inventory. Assigning an exact `project.view` grant adds that
Project and its backend inspection surface. Human access drawers in Platform
and Project Users use the conditional account endpoints. Existing advanced
access remains visible, and owner, service and self edits stay protected.

## App Data Is Its Own Authority

A Project's records are not part of its control plane, and the permissions say
so:

- `project.view` carries `database.inspect` and `database.read` — an operator
  browsing an installation's tables, including other Tenants'.
- `project.runtime.manage` carries `database.write`, alongside the workload and
  storage authority that managing a runtime implies.
- `project.data.read` and `project.data.write` carry `database.read` and
  `database.write` and nothing else.

The last pair exists so an App can hold its own data without holding authority
over the Project it lives in. A Gateway request for App data forwards only those
two implications, even when the caller happens to hold Project authority as
well, so an App data path cannot spend a permission it did not come to use.

The Tenant travels the same way. The Platform resolves it from the
authenticated principal and signs it into the Gateway envelope; a Project
service reads it from the principal rather than from the request. A caller may
still name a Tenant, but naming one that is not its own requires
`database.inspect` and is otherwise refused. See [App Data](/api/app-data).

## Rule For Services

Any service or plugin that performs a privileged action should:

1. Define a capability in the service/runtime layer.
2. Expose it through a stable endpoint.
3. Declare route access requirements.
4. Optionally declare menu access requirements so the dashboard can hide
   unavailable UI.
5. Never rely on hidden dashboard state as the only protection.
