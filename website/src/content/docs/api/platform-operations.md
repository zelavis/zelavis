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

Accounts, sessions and security events need the auth manage permission; the sign-in ceremonies are open. Service accounts keep their own commands (`zelavis auth service-accounts …`, `client.auth.admin.serviceAccounts…`).

| What | HTTP (`auth/…`) | SDK (`client.auth.…`) | CLI (`zelavis auth …`) |
|---|---|---|---|
| Providers | `GET providers`, `GET oauth/providers`, `GET recovery/providers` | `providers()`, `oauthProviders()`, `recoveryProviders()` | `providers`, `oauth-providers`, `recovery-providers` |
| Registration availability | `GET registration` | `registrationStatus()` | `registration-status --json` |
| Runtime registration settings | `GET registration/settings`, `PUT registration/settings` | `admin.registrationSettings()`, `admin.setRegistrationSettings(input)` | `registration-settings --json`, `set-registration-settings --data JSON --json` |
| Sign up, sign in | `POST sign-up/:provider`, `POST authenticate/:provider` | `signUp(provider, body)`, `signIn(provider, body)` | `sign-up PROVIDER --data`, `sign-in PROVIDER --data` |
| Start an OAuth sign-in or link | `POST oauth/:provider/start`, `POST oauth/:provider/link/start` | `signInWithOAuth(p)`, `linkIdentity(p)` | `oauth-start P`, `link-start P` |
| The current session | `GET session`, `POST session/rotate`, `DELETE session` | `getSession()`, `refreshSession()`, `signOut()` | `session`, `refresh`, `sign-out` |
| The account's own sessions | `GET sessions`, `DELETE sessions/:sessionId` | `sessions()`, `revokeSession(id)` | `sessions`, `revoke-session ID` |
| Credential recovery | `POST recovery/:provider`, `POST recovery/:provider/complete` | `beginRecovery(p, body)`, `completeRecovery(p, body)` | `recover P --data`, `complete-recovery P --data` |
| Accounts | `GET accounts[?accountId=]`, `POST accounts` (`{ id, email \| username, … }`), `POST credentials` | `admin.accounts(accountId?)`, `admin.createAccount(body)`, `admin.createCredentials(body)` | `accounts [ACCOUNT]`, `create-account --data`, `create-credentials --data` |
| Human account access | `PUT accounts/:accountId/access` | `admin.setAccountAccess(accountId, input)` | `set-account-access ACCOUNT --data JSON --json` |
| An account's sessions | `GET accounts/:id/sessions`, `DELETE accounts/:id/sessions[/:sessionId]` | `admin.accountSessions(id)`, `admin.revokeAccountSessions(id)`, `admin.revokeAccountSession(id, sessionId)` | `account-sessions ID`, `revoke-account-sessions ID`, `revoke-account-session ID SESSION` |
| Security events | `GET security/events` | `admin.securityEvents()` | `security-events` |
| OAuth connections | `GET oauth/connections`, `PUT\|DELETE oauth/connections/:provider` | `admin.oauthConnections()`, `admin.configureOAuth(p, body)`, `admin.removeOAuth(p)` | `oauth-connections`, `configure-oauth P --data`, `remove-oauth P` |
| First owner | `GET bootstrap`, `POST bootstrap` (needs the bootstrap token) | `bootstrapStatus()`, `bootstrap(body)` | `bootstrap-status`, `bootstrap --data`; the interactive `zelavis bootstrap` and `zelavis setup` remain |

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
`{ expectedRevision, role, permissions, grants }` and returns
`{ accountId, accessRevision, role, permissions, grants }`.
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
users can still sign in. A successful signup returns HTTP 201 with a session
and either the Platform `customer` role or the App `user` role, with no implicit grants.

## Project domains

Paths below are relative to the configured API base. Reads accept
`project.domains.view` or `project.domains.manage` on the exact Project.
Mutations require `project.domains.manage` on that Project.

| HTTP | SDK | CLI |
| --- | --- | --- |
| `GET /runtime/projects/:projectId/domains` | `client.projects.domains(projectId)` | `zelavis projects domains PROJECT --json` |
| `POST /runtime/projects/:projectId/domains` | `client.projects.addDomain(projectId, { hostname, tlsMode })` | `zelavis projects add-domain PROJECT HOSTNAME --tls external\|managed --json` |
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
