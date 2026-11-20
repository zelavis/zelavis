---
layout: docs
title: "Auth"
---

# Auth

Zelavis Auth is available as `zelavis/auth`. Each runtime owns its accounts,
credentials, settings, sessions, and signing keys. Platform Auth serves the
dashboard, CLI and Platform operators. App Auth serves the users of one App
from that App's database. Platform operators manage an App through the Project
Gateway using permissions scoped to that Project.

## First owner and registration

Complete the Platform's setup wizard or run `zelavis setup` to claim the first
owner with a username, password and the installation's bootstrap token.
Bootstrap closes after the claim succeeds.

Public registration starts closed for the Platform and each App. In the
dashboard, enable it on **Auth** for the Platform or **Backend → Auth** for an
App. You can also use `GET` and `PUT /auth/registration/settings`. A write
takes `{ enabled, expectedRevision }` and a stale revision returns 409. Closing
registration stops new accounts, including first-time OAuth sign-in. Existing
users can still sign in. New Platform accounts start as `customer` and new App
accounts as `user`, with no grants or permissions.

## Invitations

Open **Server → Access → Users** for the Platform or **Users** in a Project.
Choose **Invite user**, enter an email address, and choose the role and any
Project grants. Set up [email delivery](/guides/email-delivery/) on that runtime
before sending. The email opens `/invitation` under the configured link base.
Use the link in any browser. It expires seven days after issue and works once.
Resending replaces the link and keeps the original expiry. Revoking an
invitation makes its link unusable.

An invitation can create an account while public registration is closed. New
users choose a username and password, and acceptance verifies the invited
address. When an account already owns the address, sign in as that account
before accepting. Acceptance adds the preset permissions and grants to the
account's existing access. A Platform `customer` can be promoted to the invited
role. An access change ends the account's existing sessions. Acceptance
follows the runtime's MFA policy.

The routes are relative to the runtime's versioned API. Platform and App
clients use the same Auth API at their respective origins.

| HTTP | JavaScript SDK | CLI |
| --- | --- | --- |
| `GET /auth/invitations?limit&after` | `client.auth.admin.invitations(options?)` | `zelavis auth invitations [--limit N] [--after CURSOR]` |
| `POST /auth/invitations` | `client.auth.admin.invite(input)` | `zelavis auth invite --data JSON` |
| `POST /auth/invitations/:id/resend` | `client.auth.admin.resendInvitation(id)` | `zelavis auth resend-invitation ID` |
| `DELETE /auth/invitations/:id` | `client.auth.admin.revokeInvitation(id)` | `zelavis auth revoke-invitation ID` |
| `POST /auth/invitations/accept` | `client.auth.acceptInvitation(input)` | `zelavis auth accept-invitation --data JSON` |

From the Platform, use the exact Gateway management paths at
`/runtime/projects/:projectId/auth/invitations` with the same methods and
suffixes as the first four rows. The equivalent SDK methods are
`client.projects.invitations(projectId, options?)`, `invite(projectId, input)`,
`resendInvitation(projectId, id)`, and `revokeInvitation(projectId, id)`.
Their CLI commands are `zelavis projects invitations PROJECT`,
`invite PROJECT --data JSON`, `resend-invitation PROJECT ID`, and
`revoke-invitation PROJECT ID`. Use `--json` to print the API result. Invitees
accept at the App's own origin.

Creation takes `{ email, access: { role, permissions, grants, roleAssignments } }`.
App invitations use `role: "user"`, an empty `permissions` array, grants scoped
to that App's Project and role assignments without `projectIds`. Listing returns `{ invitations, next? }` with up to 100 rows per page.
Pass `next` as the next page's `after`. Acceptance takes
`{ token, username?, password? }`. Supply credentials for a new account or
authenticate as the existing account with a browser session or bearer token.

Unknown, revoked, expired and used links return `invalid_invitation` (400).
An existing account must sign in to accept (`invitation_requires_sign_in`,
409). The inviter needs permission to administer users and delegate the preset
access (`account_access_forbidden`, 403). Creation and resend require email
delivery (`email_unavailable`, 409).
A runtime can hold at most 500 pending invitations (`invitation_limit`, 429).
Multiple invitations to the same address count separately.

## Custom roles

Open **Server → Access → Roles** for the Platform or **Roles** in a Project.
A role has an id (lowercase letters, digits and hyphens), a title, an optional
description and its permissions. A Platform role can also hold concrete grants,
such as `project.view` on one Project, and Project permissions. Those are given
on each Project an assignment names. Assign roles in an account's
**Edit access** drawer, and choose the Projects a Platform assignment covers.
A runtime holds at most 50 roles of at most 100 entries each.

| HTTP | JavaScript SDK | CLI |
| --- | --- | --- |
| `GET /auth/roles` | `client.auth.admin.roles()` | `zelavis auth roles` |
| `POST /auth/roles` | `client.auth.admin.createRole(input)` | `zelavis auth create-role --data JSON` |
| `PUT /auth/roles/:roleId` | `client.auth.admin.updateRole(roleId, input)` | `zelavis auth update-role ROLE --data JSON` |
| `DELETE /auth/roles/:roleId?revision=N` | `client.auth.admin.deleteRole(roleId, expectedRevision)` | `zelavis auth delete-role ROLE --revision N` |

From the Platform, the exact Gateway paths are
`/runtime/projects/:projectId/auth/roles` with the same methods and suffixes.
Their SDK methods are `client.projects.roles(projectId)`,
`createRole(projectId, input)`, `updateRole(projectId, roleId, input)` and
`deleteRole(projectId, roleId, expectedRevision)`. Their CLI commands are
`zelavis projects roles PROJECT`, `create-role PROJECT --data JSON`,
`update-role PROJECT ROLE --data JSON` and
`delete-role PROJECT ROLE --revision N`.

A change takes
`{ id, title, description?, permissions, grants, projectPermissions, expectedRevision }`
and every route answers the catalogue `{ revision, roles }`. App roles keep
`grants` and `projectPermissions` empty. Account access edits and invitation
access carry `roleAssignments: [{ roleId, projectIds? }]`; send `[]` for none.
App assignments omit `projectIds`.

Refusals: `invalid_role` (400) for an invalid or reserved id (`owner`,
`customer`, `operator`, `reseller`, `user`, `service`, `system`) or content;
`account_access_forbidden` (403) when the caller could not give the role's
content; `role_not_found` (404); `role_exists` and `role_revision_conflict`
(409); `role_limit` (429) at 50 roles; and `roles_unavailable` (503) while a
stored role cannot be read. An access edit that assigns an unknown role answers
`role_not_found`. One that would expand past 2000 permissions and grants
answers `role_expansion_limit` (400). See
[custom roles](/architecture/access-control/#custom-roles) for how roles reach
principals.

## Sign-in methods

- Username and password issue a session after a successful password check and
  any required MFA. New passwords need at least 15 characters.
- Email and password require an emailed verification link and the proof held by
  the initiating tab. Configured email delivery enables signup and recovery.
  Open verification and recovery links in the tab that requested them.
- Username and passkey use WebAuthn at a configured origin. Set the relying
  party ID and allowed origins in Auth settings. The browser can offer a
  passkey through autocomplete or a sign-in button.
- Connect Google, GitHub, Apple or an OpenID Connect issuer in Auth settings.
  Register the callback URL shown for the runtime with the provider. The
  browser stores the flow's state in its own tab and redeems the callback
  ticket with that state. Client secrets are write-only.

An installed plugin can declare named OpenID Connect issuers with
`defineOAuthProviders` from `zelavis/auth` and the `zelavis/auth:oauth`
capability. Auth discovers the issuer's endpoints when the operator configures
its client credentials. A bearer authenticator plugin declares
`zelavis/auth:authenticator`.

`GET /auth/methods` reports which methods can sign in, create accounts and
recover credentials. The runtime's method settings control availability.
Auth applies rate limits to interactive attempts and returns 429 with
`Retry-After` when a client must wait. Auth may return 503 with
`auth_importing` during a legacy account import.

## Manage your account

Open **Account** in the dashboard or **Manage account** on the signed-in App
login page to manage your passkeys, two-factor authentication, email addresses,
password and sessions. [Account pages](/packages/ui/#your-account)

## Sessions and tokens

On Zelavis pages, access and refresh tokens are HttpOnly cookies. The
Platform's access cookie covers the dashboard mount so server-rendered views
can authenticate. App access cookies cover the App's API. Refresh cookies
cover only the runtime's `/auth/session` path. Cookies use SameSite=Lax and
are Secure on HTTPS.

Bearer clients send the access token in `Authorization: Bearer <token>`.
The ES256 access JWT expires after five minutes by default. The public keys
are available at `GET /auth/jwks`. Use `POST /auth/session/refresh` to exchange
a refresh token for a new bundle. Store the replacement immediately. Refresh
tokens are single-use and a replay revokes the session. A `noSession` result
means sign-in is required. `DELETE /auth/session` signs out.

Use service-account tokens for automation. Give each token the permissions and
Project grants needed for its job. Service accounts are independent of human
sessions and can be rotated or revoked by an authorized operator.

## Multi-factor authentication

An operator can require TOTP for privileged accounts or all accounts. If a
sign-in needs MFA, Auth supplies a challenge instead of a session. Submit an
authenticator code or a one-time backup code with that challenge. When
enrollment is required, start TOTP setup with the challenge, save the new
secret to an authenticator, and confirm with the authenticator ID and code.
Save the backup codes after successful enrollment. Passkeys already provide
user verification.

See the [HTTP, SDK and CLI operations](/api/platform-operations/#authentication)
and [upgrade behavior](/architecture/updates/).
