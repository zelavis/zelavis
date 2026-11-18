---
title: Platform Operations
---

Everything the Platform does is reachable three ways that answer alike, refusals included: the HTTP route, the JS SDK (`createZelavisClient`) and the CLI. This page maps the Platform's own operations to all three. Paths are under `/zelavis/api/v1/`. The Project-level operations are in [Project files and workloads](/api/project-files-and-workloads) and [App Data](/api/app-data); the database's are in [Database](/api/database).

Answers are the Platform's own JSON, passed through by the SDK and the CLI. In the SDK their inputs and answers are the server's own TypeScript types, so a wrong field is a compile error; the CLI takes `--data` as JSON and the route validates it. `--url` and `--token` pick the Platform and the credential; `--json` prints the answer as JSON.

## Fabric

Needs `fabric.view`; planning needs `fabric.manage`.

| What | HTTP | SDK (`client.fabric.…`) | CLI (`zelavis fabric …`) |
|---|---|---|---|
| Snapshot of nodes and placements | `GET fabric/snapshot` | `snapshot()` | `snapshot` |
| Health | `GET fabric/health` | `health()` | `health` |
| Nodes, one node | `GET fabric/nodes`, `GET fabric/nodes/:nodeId` | `nodes()`, `node(id)` | `nodes`, `node ID` |
| Project placements, one | `GET fabric/placements/projects[/:projectId]` | `placements()`, `placement(projectId)` | `placements`, `placement ID` |
| Plan placements without applying them | `POST fabric/placements/projects/plan` with `{ requests }` | `plan(requests)` | `plan --data '[…]'` |
| Migrations in flight | `GET fabric/migrations` | `migrations()` | `migrations` |

## Assistant

Threads belong to the principal that made them; a change the Assistant proposes is an approval a person decides. Audit needs `server.assistant.audit`.

| What | HTTP (`runtime/assistant/…`) | SDK (`client.assistant.…`) | CLI (`zelavis assistant …`) |
|---|---|---|---|
| Audit trail | `GET audit?limit=&before=&principalId=&tool=&decision=` | `audit(query?)` | `audit [--limit N --before C --principal ID --tool NAME --audit-decision D]` |
| Platform model provider | `GET\|PUT\|DELETE provider` | `provider()`, `setProvider(body)`, `clearProvider()` | `provider`, `set-provider --data JSON`, `clear-provider` |
| A Project's own provider | `GET\|PUT\|DELETE projects/:projectId/provider` | `projectProvider(id)`, `setProjectProvider(id, body)`, `clearProjectProvider(id)` | `project-provider ID`, `set-project-provider ID --data JSON`, `clear-project-provider ID` |
| Threads | `GET threads[?projectId=]`, `POST threads`, `GET\|DELETE threads/:threadId` | `threads()`, `createThread({ title?, projectId? })`, `thread(id)`, `deleteThread(id)` | `threads [--project ID]`, `create-thread [--title T --project ID]`, `thread ID`, `delete-thread ID` |
| Send a message | `POST threads/:threadId/messages` with `{ content }` | `sendMessage(id, content)` | `send ID TEXT` |
| Read the reply as it is written | `POST threads/:threadId/messages/stream` (`text/event-stream`: `text`, `tool`, `done`, `error`) | `streamMessage(id, content)`, an async iterable of `{ event, data }` | `stream ID TEXT` |
| Decide an approval | `POST threads/:threadId/approvals/:approvalId` with `{ decision, confirm? }` | `decide(id, approvalId, { decision, confirm? })` | `decide ID APPROVAL --decision approve\|deny [--confirm ID]` |

## Deployment backends and the Agent

| What | HTTP (`runtime/…`) | SDK | CLI |
|---|---|---|---|
| Where Projects may run | `GET deployment-backends`, `POST deployment-backends/detect`, `POST deployment-backends/:id/enable\|disable\|default` | `client.deploymentBackends.list\|detect\|enable\|disable\|setDefault` | `zelavis backends list\|detect\|enable\|disable\|default [ID]` |
| What the Agent reports | `GET agent`, `GET agent/operations[/:operationId]` | `client.agent.status\|operations\|operation` | `zelavis agent status\|operations\|operation [ID]` |

With none of those words, `zelavis agent` runs the Agent itself.

## Authentication

Auth operations use the `/auth` namespace. Interactive sign-in is public.
Account administration requires the runtime's users-manage permission.

| What | HTTP (`auth/…`) | SDK (`client.auth.…`) | CLI (`zelavis auth …`) |
|---|---|---|---|
| First owner | `GET bootstrap`, `POST bootstrap` | `bootstrap.status`, `bootstrap.claim` | `bootstrap status\|claim` |
| Username and password | `POST username-password/{sign-up,sign-in,change-password}` | `usernamePassword.signUp\|signIn\|changePassword` | `username-password sign-up\|sign-in\|change-password` |
| Email and password | `POST email-password/{sign-up,complete-sign-up,sign-in,change-password}` | `emailPassword.signUp\|completeSignUp\|signIn\|changePassword` | `email-password sign-up\|complete-sign-up\|sign-in\|change-password` |
| Password recovery | `POST email-password/recovery/{start,check,complete}` | `emailPassword.startRecovery\|checkRecovery\|completeRecovery` | `email-password start-recovery\|check-recovery\|complete-recovery` |
| Passkeys | `POST username-passkey/{sign-up,sign-in}/{start,finish}`, `POST username-passkey/sign-in/autofill`, `/passkeys` | `usernamePasskey`, `passkeys` | `username-passkey`, `passkeys` |
| OAuth | `GET oauth/providers`, `POST oauth/:provider/{start,redeem}`, `GET oauth/connections`, `PUT\|DELETE oauth/connections/:provider` | `oauth.providers\|start\|redeem\|connections\|configure\|remove` | `oauth providers\|start\|redeem\|connections\|configure\|remove` |
| Session | `GET\|DELETE session`, `POST session/refresh` | `session.current\|signOut\|refresh` | `session current\|sign-out\|refresh` |
| Active sessions | `GET sessions`, `DELETE sessions/:id`, `POST sessions/revoke-others` | `sessions.list\|revoke\|revokeOthers` | `sessions list\|revoke\|revoke-others` |
| MFA | `GET mfa`, `POST mfa/verify`, `POST mfa/totp[/confirm]`, `GET\|PUT mfa/policy` | `mfa.status\|verify\|startTotp\|confirmTotp\|policy\|setPolicy` | `mfa status\|verify\|start-totp\|confirm-totp\|policy\|set-policy` |
| Public methods and registration | `GET methods`, `GET\|PUT methods/settings`, `GET registration`, `GET\|PUT registration/settings` | `methods`, `registration` | `methods`, `registration` |
| Accounts and grants | `GET\|POST accounts`, `PUT accounts/:id/access`, `POST accounts/import` | `admin.accounts\|createAccount\|setAccess\|importAccounts` | `admin accounts\|create-account\|set-access\|import-accounts` |
| Custom roles | `GET\|POST roles`, `PUT\|DELETE roles/:roleId` | `admin.roles\|createRole\|updateRole\|deleteRole` | `roles\|create-role\|update-role\|delete-role` |
| Admin sessions | `GET accounts/:id/sessions`, `DELETE accounts/:id/sessions[/:sessionId]` | `admin.accountSessions\|revokeAccountSessions\|revokeAccountSession` | `admin account-sessions\|revoke-account-sessions\|revoke-account-session` |
| Signing keys | `GET jwks`, `POST keys/rotate` | `keys.jwks\|rotate` | `keys jwks\|rotate` |
| Service accounts | `/service-accounts` | `serviceAccounts` | `service-accounts` |

Use `--data JSON` for CLI request bodies and `--json` for machine-readable output.

Registration settings return `{ enabled, revision }`. A write takes
`{ enabled, expectedRevision }` and returns 409 for a stale revision.
Platform settings require `system.settings.manage`. For a running App, use
`GET` or `PUT /runtime/projects/:projectId/auth/registration/settings`,
`client.projects.registrationSettings(projectId)` or
`client.projects.setRegistrationSettings(projectId, input)`, and
`zelavis projects registration-settings PROJECT --json` or
`zelavis projects set-registration-settings PROJECT --data JSON --json`.
These routes require `project.settings.manage` scoped to that Project.

Account access replacement takes
`{ expectedRevision, role, permissions, grants, roleAssignments }` and returns
`{ accountId, accessRevision, role, permissions, grants, roleAssignments }`.
Each assignment is `{ roleId, projectIds? }` and names a
[custom role](/packages/auth/#custom-roles); send `[]` for none.
Administrative account reads include `accessRevision`, initially zero.
Platform edits require `system.users.manage` in system scope and use the
`customer`, `operator` or `reseller` label. Each existing and proposed capability
must be delegable by the caller. Access changes invalidate old sessions.
An identical replacement preserves the revision and sessions.
Stale input returns `account_access_conflict` (409). Failed audit persistence
after a committed edit returns `account_access_audit_failed` (503) and its
`accessRevision`.

For App accounts, use
`PUT /runtime/projects/:projectId/auth/accounts/:accountId/access`,
`client.projects.setAccountAccess(projectId, accountId, input)`, or
`zelavis projects set-account-access PROJECT ACCOUNT --data JSON --json`.
This requires exact `project.users.manage`, role `user`, empty `permissions`
and grants for that same App.

`GET /runtime/projects`, `client.projects.list()` and
`zelavis projects list --json` require authentication. Global `projects.list`
and top-level `project.view` preserve full inventory. Other callers see only
Projects named by exact `project.view` or scoped wildcard grants, up to 100
distinct IDs. A customer with no such grants receives an empty list.
Project view includes backend inspection, database reads and storage reads.

Public signup starts closed and returns `registration_closed` (403) until
enabled and, on the Platform, until first-owner bootstrap finishes. Returning
users can still sign in. Username signup returns HTTP 200 and issues a session when any required MFA completes. Email signup issues a session after email verification. New accounts receive the Platform `customer` role or the App `user` role, with no implicit grants.

## Email delivery

Each runtime sends its own mail over SMTP. The Platform's needs `system.settings.manage` (system scope); an App's
needs `project.settings.manage` on that exact Project. The SMTP password is never returned (`smtp.hasPassword`), and
the deliveries listing never carries message content. See [Email Delivery](/guides/email-delivery) for the fields,
retries and limits.

| What | HTTP | SDK | CLI |
| --- | --- | --- | --- |
| Settings | `GET email/settings`, `PUT email/settings` | `client.email.settings()`, `client.email.setSettings(input)` | `zelavis email settings`, `zelavis email set-settings --data JSON` |
| Test send (202) | `POST email/test` | `client.email.sendTest(to)` | `zelavis email test ADDRESS` |
| Deliveries | `GET email/deliveries?limit&after` | `client.email.deliveries({ limit, after })` | `zelavis email deliveries [--limit N] [--after CURSOR]` |
| An App's settings | `GET\|PUT runtime/projects/:projectId/email/settings` | `client.projects.emailSettings(id)`, `client.projects.setEmailSettings(id, input)` | `zelavis projects email-settings PROJECT`, `zelavis projects set-email-settings PROJECT --data JSON` |
| An App's test send | `POST runtime/projects/:projectId/email/test` | `client.projects.sendTestEmail(id, to)` | `zelavis projects send-test-email PROJECT ADDRESS` |
| An App's deliveries | `GET runtime/projects/:projectId/email/deliveries` | `client.projects.emailDeliveries(id, { limit, after })` | `zelavis projects email-deliveries PROJECT [--limit N] [--after CURSOR]` |

## Project domains

Paths below are relative to the configured API base. Reads accept
`project.domains.view` or `project.domains.manage` on the exact Project.
Mutations, and the list of hosted zones a subdomain can be taken under
([DNS automation](../guides/dns-automation.md)), require `project.domains.manage` on that Project.

| HTTP | SDK | CLI |
| --- | --- | --- |
| `GET /runtime/projects/:projectId/domains` | `client.projects.domains(projectId)` | `zelavis projects domains PROJECT --json` |
| `POST /runtime/projects/:projectId/domains` | `client.projects.addDomain(projectId, { hostname, tlsMode, dns? })` | `zelavis projects add-domain PROJECT HOSTNAME --tls external\|managed [--dns manual\|automatic] --json` |
| `GET /runtime/projects/:projectId/domains/hosted-zones` | `client.projects.hostedZones(projectId)` | `zelavis projects hosted-zones PROJECT --json` |
| `POST /runtime/projects/:projectId/domains/:hostname/verify` | `client.projects.verifyDomain(projectId, hostname, { expectedRevision })` | `zelavis projects verify-domain PROJECT HOSTNAME --revision N --json` |
| `DELETE /runtime/projects/:projectId/domains/:hostname?revision=N` | `client.projects.removeDomain(projectId, hostname, revision)` | `zelavis projects remove-domain PROJECT HOSTNAME --revision N --json` |

Add accepts a hostname and TLS mode. It returns the DNS TXT challenge with
`201`, or the existing domain with `200` on an idempotent retry. List returns
`{ domains }`. Use the current domain revision when verifying or removing.
Verify returns `200` with `publicUrl` when active, or `202` when proof has
succeeded and activation is pending. Remove returns `{ removed, pending }`,
with `202` while withdrawal is still pending.

Refresh the inventory after a revision conflict or failed proof. Domain errors
carry `{ error, code }`. A conflicting hostname returns
`hostname_unavailable` without identifying its owner. Missing or unavailable
TXT proof returns `dns_not_verified`. Check the `Retry-After` header after a
`429` with `domain_verification_busy`. A verified hostname can return
`domain_ingress_unavailable` until the operator configures the selected TLS
mode. See [Project hostname setup](../architecture/edge.md#connect-a-project-hostname).



## Registrar

Platform-only, using the operator's own account. Inventory and order reads need
system-scoped `server.domains.view`; all other operations need
`server.domains.purchase`. See [Domain registration](../guides/domain-registration.md)
for contacts, sandbox mode, price confirmation and uncertain-order recovery.

| HTTP (`runtime/registrar/…`) | SDK (`client.registrar.…`) | CLI (`zelavis registrar …`) |
|---|---|---|
| `GET providers` | `providers()` | `providers` |
| `GET connection` | `connection()` | `connection` |
| `PUT connection` `{ provider, sandbox, credentials, expectedRevision? }` | `connect(input)` | `connect --data JSON` |
| `DELETE connection` | `disconnect()` | `disconnect` |
| `GET contact` | `contact()` | `contact` |
| `PUT contact` `{ contact, expectedRevision? }` | `setContact(input)` | `set-contact --data JSON` |
| `POST availability` `{ domains }` (1–20) | `check(domains)` | `check DOMAIN...` |
| `POST quote` `{ domain, kind, years }` | `quote(input)` | `quote --data JSON` |
| `POST orders` `{ kind, domain, years, authCode?, confirm, idempotencyKey }` | `order(input)` | `order --data JSON` |
| `GET orders?limit&after` (at most 50) | `orders(page?)` | `orders [--limit N --after CURSOR]` |
| `GET orders/:id` | `getOrder(id)` | `order-status ID` |
| `GET domains?cursor` | `domains(cursor?)` | `domains [--cursor CURSOR]` |
| `PUT domains/:domain/nameservers` `{ nameservers }` (2–12) | `setNameservers(domain, ns)` | `set-nameservers DOMAIN NS...` |

`confirm` is `{ amount, currency, years }`, with the total amount as a decimal
string. A new order returns 201; replaying its key returns 200 and the same
order. Keys use 8–128 letters, digits, `.`, `_`, `:` or `-`. Requests cannot
change an existing key's intent. A changed quote returns 409 `price_changed`
with the current `price`. Orders report their provider, sandbox flag and state;
their contact, transfer code and credentials are never included. Connection
reads return only status, provider, sandbox and revision. Contact reads require
purchase permission and return the private profile. Nameserver changes and
disconnection return 204. All responses use `Cache-Control: no-store`.

Failed/uncertain submissions are never retried automatically. An unresolved
order prevents another order for the domain or changing the original registrar
connection. Renewals need a recorded previous expiry; after an ambiguous call,
only a later registrar expiry proves completion. Unconfirmed outcomes remain
`unknown` after 24 hours. There is no manual resolution operation yet.


## Runtime, services and extensions

| What | HTTP (`runtime/…`) | SDK | CLI |
|---|---|---|---|
| Configuration, the caller's access | `GET config`, `GET access` | `client.runtime.config()`, `client.runtime.access()` | `zelavis runtime config`, `zelavis runtime access` |
| Dashboard settings | `GET settings`, `PATCH settings` | `client.runtime.settings()`, `client.runtime.updateSettings(body)` | `zelavis runtime settings`, `zelavis runtime update-settings --data JSON` |
| Register, install or disable a service | `POST services`, `PATCH services/:name` | `client.services.register(body)`, `client.services.update(name, body)` | `zelavis services register --specifier S [--install]`, `services install\|disable NAME` |
| Services that extend another | `GET extensions?owner=` | `client.services.extensions(owner?)` | `zelavis extensions [--for SERVICE]` |

## Environment sessions

Remote environment sessions and their processes. `update-session` needs the session's `expectedVersion`.

| What | HTTP (`runtime/environment/…`) | SDK (`client.environment.…`) | CLI (`zelavis environment …`) |
|---|---|---|---|
| Identity, health | `GET`, `GET health` | `identity()`, `health()` | `identity`, `health` |
| Sessions | `POST sessions`, `GET\|PATCH\|DELETE sessions/:id` | `createSession(body?)`, `getSession(id)`, `updateSession(id, body)`, `closeSession(id)` | `create-session [--data]`, `session ID`, `update-session ID --data`, `close-session ID` |
| Usage, events | `POST sessions/:id/usage`, `GET sessions/:id/events?after=&limit=` | `recordUsage(id, body)`, `readEvents(id, { after?, limit? })` | `usage ID --data`, `events ID [--after CURSOR --limit N]` |
| Processes | `POST sessions/:id/processes`, `GET processes/:id`, `POST processes/:id/operations` | `startProcess(id, body)`, `getProcess(id)`, `operateProcess(id, body)` | `start-process ID --data`, `process ID`, `operate-process ID --data` |

## Edge hostnames and certificates

The Edge's status, switching, routes and publishing were already in all three forms (`zelavis edge …`). The rest:

| What | HTTP (`runtime/edge/…`) | SDK (`client.edge.…`) | CLI (`zelavis edge …`) |
|---|---|---|---|
| Check a hostname before onboarding it | `GET onboard/preflight?hostname=` | `preflightHostname(host)` | `preflight HOST` |
| Onboard a hostname | `POST onboard` with `{ mode, hostname?, localTargetUrl? }` | `onboardHostname(body)` | `onboard --mode M [--hostname H] [--local-target-url U]` |
| Certificates | `GET certificates`, `POST certificates/renew` with `{ hostname?, renewIfWithinDays? }` | `certificates()`, `renewCertificates(body?)` | `certificates`, `renew [--hostname H] [--renew-if-within-days N]` |

Renewal reapplies the active Edge publication when it uses a renewed
certificate. If a newer route publication is pending, renewal stores the
certificate and returns a conflict. Apply the intended publication to serve the
replacement certificate.
