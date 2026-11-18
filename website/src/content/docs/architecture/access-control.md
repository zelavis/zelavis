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

## Why This Is Not Only Zelavis Auth

[Zelavis Auth](/architecture/auth/) (`zelavis/auth`) owns authentication:
accounts, credentials, sessions, and the sign-in methods (username and
password, email and password, username and passkey, OAuth with Google, Apple,
GitHub or any OpenID Connect issuer, and TOTP as a second factor). Each runtime
runs its own Auth on its own database.

`zelavis/core` owns the lower-level authorization contract because every
runtime service needs a way to declare and enforce access requirements without
depending on one authentication method.

That separation keeps the core extensible:

- a dashboard session can resolve a principal
- a service-account token can resolve a principal
- an AI agent token can resolve a principal
- a Hosting Provider customer login can resolve a principal
- a bearer authenticator plugin can resolve a principal

All of those callers still pass through the same route access checks.

## Native Request Authentication

The runtime composes `ZelavisRequestAuthenticator` implementations directly on
the standard Web `Request` boundary. No router framework owns authentication.

- Auth issues ES256 access tokens signed by the runtime's own key (public keys
  at `GET /auth/jwks`) and single-use refresh tokens; every request also reads
  the session row, so a revoked session stops authenticating at once
- App accounts, credentials, and sessions persist in the App's own Project
  database, in its Auth partition
- Platform accounts, credentials, and sessions persist separately in the
  Platform identity database
- access tokens may arrive through `Authorization: Bearer` or an HttpOnly,
  SameSite cookie that is Secure on HTTPS deployments
- bearer clients receive the token bundle directly; a response sets cookies
  only for a request carrying a matching same-origin `Origin`
- cookie-authenticated mutations require a matching same-origin `Origin`
- service-account `zvs_` tokens are stored only as SHA-256 hashes
- first-owner bootstrap requires an operator-configured high-entropy token; the
  token is never a normal login method
- optional Basic, JWT, remote-JWKS and plugin authenticators
  (`zelavis/auth:authenticator`) resolve into the same principal model
- invalid credentials produce a `401` and the appropriate
  `WWW-Authenticate` challenge

Password sign-in is part of Zelavis rather than a plugin. An installation that
cannot create its first owner is not something an extension supplies. Passwords
are hashed with PBKDF2-SHA-256 (600,000 iterations, PHC form) over Web Crypto,
and need at least 15 characters. Whether an address or username has an account
is observable through sign-up and sign-in, which are rate limited per client
address.

The OAuth Authorization Code flow is part of Auth too — it holds the state,
nonce and PKCE verifier, which are the parts that are dangerous to get wrong
and the same for every provider. Any OpenID Connect issuer is added by pasting
its issuer URL. A plugin can name issuers ahead of time by declaring
`zelavis/auth:oauth`; the operator still supplies the client credentials. The
OIDC plugin `@zelavis/app-auth-oidc` is a bearer-token authenticator for callers
already holding a token from an issuer.

## Client address

A route handler reads the caller's network address from `client.address` (absent when no trusted source supplied
one), for per-client rate limits and audit. It is a request fact, not part of the principal, and never a value the
caller chose, except from a loopback peer (local trust).

- The Node listener uses the TCP peer. A loopback peer (Zelavis's own ingress, or the installation's Edge proxy on the
  same host) may name another address: the ingress sets `x-zelavis-client-address` from what it computed and drops any
  value a client sent, and when the installation's Edge (Traefik) fronts the Platform the ingress takes the rightmost
  `x-forwarded-for` entry, which Traefik overwrites with the real peer. Any other proxy's headers are not trusted.
- An App runtime learns the address only from the Project Gateway's signed envelope (`clientAddress`, bound by the
  signature and re-signed by the worker gateway); its listener ignores the header form.
- The Bun listener does not record an address yet, so `client.address` is `undefined` there.

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
needs its first owner. `POST /zelavis/api/v1/auth/bootstrap` is disabled unless
the operator configured `ZELAVIS_BOOTSTRAP_TOKEN` or `bootstrap.token`; a
successful claim creates the owner with a username and password and issues the
first session in one transaction, so two concurrent claims create one owner.

The dashboard login screen calls the same versioned Auth endpoints as other
clients. `/zelavis/api/v1/runtime/access` requires authentication and returns
the real session principal. There is no demo-owner fallback or query-string
identity switch.

## Registration authority

Auth keeps a registration policy in each runtime's own Auth partition: the
Platform's in its identity database and each App's in its own database. The
Platform requires a completed first-owner claim before public enrollment. The
policy is read inside the sign-up transaction, so closing registration and a
concurrent sign-up (password, passkey or first-time OAuth) cannot both succeed.
Sign-up is limited to 10 an hour per client address and 60 a minute per runtime.

A registered human starts with the Platform `customer` or App `user` role
and no grants. App users retain the per-account Tenant default. Changing one
Project's registration policy requires `project.settings.manage` for that
exact Project. The Platform gateway forwards only that permission to the App.
Platform-wide policy changes require `system.settings.manage` in system scope.

The Platform Auth settings page and each Project's Auth page edit these same
policies. The Project registration control uses the exact settings route, so
its availability is independent of provider-administration and runtime-config
reads. The Platform login page offers Create account while a sign-up method is
available. Server policy also refuses an open form after registration closes.

On a native App's site origin, public sign-in forms and self-session routes
use that App's own Auth. The ingress accepts only the selected App's access
cookie (a JWT whose issuer names that Project), refresh cookie, access-token
bearer or service token. Auth verifies the signature with the App's own key and
reads the session from the App's own database. Cookie mutations require the
same browser origin. The public ingress strips Platform and sibling Project
credentials and sends no Gateway authority. The Platform's authenticated
management proxy continues to strip child response cookies.

Email and password accounts verify their address before their first session.
Auth sends the verification and recovery messages through the runtime's email
outbox in the same transaction as the challenge, stores only SHA-256 digests of
their codes, and consumes a code once. Password recovery is bound to the
account that owned the verified address when the link was issued, and its final
transaction sets the password and ends the account's other sessions.

On App origins, the public allowlist includes the sign-in, sign-up, recovery,
verification and MFA pages and their exact Auth routes. Policy and email
settings remain behind the authenticated Project Gateway.

## Human access delegation

Auth conditionally replaces a human account's role, permissions and concrete
scoped grants with `PUT /auth/accounts/:accountId/access` and an
`expectedRevision`. A stale revision fails with HTTP 409. An identical write at
the current revision changes nothing and keeps sessions; any other change raises
the access revision and ends the account's sessions in the same transaction.

The administrator is read again inside that transaction, so authority removed a
moment ago is refused even for a request already past its route check. Both old
and proposed target authority must be held by the actor. Role changes use the
Platform's `customer`, `operator` and `reseller` labels, or an App's `user`
label. Elevated labels require the same actor label or a top-level wildcard.
Owner, service and self-access edits are refused.

The exact Project route first reads only the named App account and intersects
the current and requested concrete permission names with the caller's exact
Project authority. The Gateway signs a digest bound to the account, conditional
input and that permission set in its existing audience-bound, single-use
envelope. The child rechecks the digest and target revision inside the transaction
that writes. The digest keeps the 100-entry edit within local header and remote
dispatch bounds. Generic proxy authority cannot substitute for that proof.

Successful writes record a security event containing actor ID, target ID and
revision in the same transaction as the change. Credential administration and
grant-bearing creation enforce the same authority checks.

The dashboard consumes the authenticated `/runtime/access` response when
filtering menus and Project actions. A registered customer can open Projects
with an empty inventory. Assigning an exact `project.view` grant adds that
Project and its backend inspection surface. Human access drawers in Platform
and Project Users use the conditional account endpoints. Existing advanced
access remains visible, and owner, service and self edits stay protected.

## Custom roles

A role is a named bundle of authority in one runtime's catalogue: runtime-wide
permissions, concrete grants and, on the Platform, Project permissions. An
account holds up to 10 role assignments, each naming up to 20 Projects. An
assignment gives the role's permissions and grants. It also gives each Project
permission as a grant scoped to each Project it names. An assignment that names
no Projects gets no Project grants, never every Project. App roles hold
permissions only, and those apply to the App's own Project, as an App account's
permissions do. App assignments name no Projects.

Authority is expanded when a principal is built. Editing a role changes every
member's authority on their next request without touching their accounts or
ending their sessions. Deleting a role takes its authority away the same way.
The deleted role's assignment stays on each account until its access is next
edited. Recreating a role with the same id gives its authority to those
accounts again. Authentication expands from an in-process copy of the catalogue,
which the role routes clear after each change. An account without assignments
never reads it.

Each role change is one Auth transaction against the catalogue revision
(`expectedRevision`): of concurrent changes made against one revision, one
commits and the others get `role_revision_conflict` (409). An actor can define
or change a role only when it could give the role's whole content directly.
On the Platform it must hold each Project permission runtime-wide, because the
role can later be assigned for any Project. A change must also be delegable
from the content it replaces. An access edit expands the account's current and
proposed assignments and checks both, in the transaction that writes. The whole
access may expand to at most 2000 permissions and grants
(`role_expansion_limit`, 400). Defining roles needs `system.roles.manage` on the
Platform and `project.users.manage` in an App. Platform user administrators
with `system.users.manage` can read the catalogue to assign roles.

The Project Gateway's exact role routes check the role content against the
caller's authority in that Project. For a change, they check both the old and
the new content. The Gateway signs the operation and those permission names.
The App compares them with its own catalogue before the change. Access edits
and invitations that assign App roles are checked the same way. A stored role
that does not decode grants nothing. Role administration then answers
`roles_unavailable` (503) and logs one line naming the row. [Role operations](/packages/auth/#custom-roles)

## Invitation authority

Platform invitation management requires `system.users.manage` at system scope.
App invitation management requires `project.users.manage` on that exact
Project. Create checks that the inviter can delegate each part of the preset
access. For App invitations from the Platform, the Project Gateway verifies
the scope and signs the checked operation and input for that App. App public
origins expose `POST /auth/invitations/accept`.

Auth stores the link token's hash and queues the email in the same transaction
as the invitation. Acceptance commits the account or access change, verified
address, invitation status and session or required MFA challenge together.
For an inviter with a local account, Auth rebuilds its current authority
inside the acceptance transaction and revokes the invitation if that account
can no longer delegate the preset access. The Gateway authorizes Platform
inviters when they issue the link. The App cannot reconstruct their authority
at acceptance. Revocation and the original seven-day expiry bound the issued
invitation. [Invitation operations and dashboard workflow](/packages/auth/#invitations)

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
