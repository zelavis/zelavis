# Self-registration, customer access and Project domains

Job: Research and plan owner-enabled public signup and login for Zelavis as a hosting panel and for Zelavis App Projects, including the user, customer and roles foundation. Let customers add domains to their Projects.
Date: 2026-11-10
Status: complete
Verified-at: f30953612f
To start:    Execute the plan in .agents/plans/2026-11-10-platform-app-self-registration/00-overview.md. Start with its section 8.
To continue: Continue the plan in .agents/plans/2026-11-10-platform-app-self-registration/00-overview.md. Start with its section 8.

## Progress

- [x] 1. Land shared registration policy and enrollment.
- [x] 2. Land human account access administration.
- [x] 3. Land the operator controls and Platform signup.
- [x] 4. Land native App public login and signup.
- [x] 5. Land customer-managed Project domains.
- [x] 6. Self-audit.

## 0. Summary and finish line

Give each Zelavis runtime its own durable switch for public account creation. An owner can open signup on the Platform for hosting customers or in one native App for its users. Both use the same identity, session and authorization contracts, with independently stored policies and accounts.

### In scope

- Registration policy, password enrollment, OAuth first-account admission, existing-user login, and JS, HTTP and CLI parity.
- Fixed low-privilege defaults for newly registered human accounts, and an authorized way to change a human account's role and concrete scoped grants.
- Operator controls on Platform Auth and Project Auth, a public Platform form, and an auth-only public surface on native App origins.
- Scoped Project domains with DNS ownership proof, verified routing, TLS state and removal.
- Embedded and deployed Node runtime paths, explicit ingress boundaries, restart behavior, browser verification and public docs.

### Out of scope

- Billing, product catalogues, paid hosting entitlements, automatic Project provisioning, reseller organizations, custom role definitions and role inheritance. Registrar purchases, transfers, DNS automation and wildcard certificates.
- Email delivery or proof of email ownership, invitations, password recovery delivery, MFA, and a public signup UI for third-party applications such as WordPress. Their private bound Zelavis identity API follows the same policy when present.

### Done means

1. A new Platform still requires its first owner. Both Platform and App registration start disabled by default. An authorized setting survives restarts and takes effect on the next request without an engine reload.
2. Password signup creates a Platform `customer` or an App `user`, plus a normal session. Neither receives an implicit grant, paid entitlement, server access, or shared Tenant membership. Existing identities can still sign in with registration disabled.
3. The owner can delegate access to an existing Project through the same scoped permission model used by the server. Signed-in customers see an empty Projects view until granted access. Direct API calls and the UI agree about what they can do.
4. Platform Login shows Create account only while enabled. A native App has a separate login and signup on its site origin, where the login and session belong to that App. Its dashboard operator controls target that exact child runtime. A disabled signup URL displays no form and a stale form is refused by the server.
5. No public App URL publishes the Platform dashboard, administrative Auth endpoints, other control-plane endpoints or credentials belonging to the Platform or another Project.
6. A customer granted `project.domains.manage` on one Project can add, verify and remove its hostname. DNS TXT proof precedes publication, a verified native App domain serves its public Auth, and removing a domain or Project withdraws its owned route. `pnpm run verify`, `pnpm run ci:ui`, and `pnpm run docs:check` pass at the end.

### Reading of the request

The first product is working user registration, login and an owner-managed access foundation on one installation and on each App, with scoped domain management for customer Projects. A future Hosting Provider service uses the registered customer account ID and assigns scoped entitlements after its own commercial workflow.

### Supplement and baseline

The existing `.agents/references/plan-writer.md` was checked at `f30953612f`. Its focused-test command was corrected to launch Node in the `zelavis` workspace, since `test/capability-parity.test.mjs:69` reads `src/cli` relative to cwd. The plans directory was empty when checked. Existing worktree edits and prior plan deletions belong to other work. No plan was removed or refreshed by this run.

Focused auth, account atomicity, API parity, Project domain and preview tests passed against the existing build from `packages/zelavis`, using `node --test --test-reporter=dot test/{app-auth-service,platform-auth-parity,auth-settings-service,identity-atomicity,capability-parity,platform-public-domain-forwarding,core-password-auth,edge-previews}.test.mjs`. Loopback tests needed execution outside the network sandbox. Each part rebuilds or checks its browser baseline before editing. The existing domain-binding, DNS verifier, Edge routes, production Edge and local ACME certificate suites also passed with loopback enabled. Browser qualification was not run during planning.

### Sources read

`AGENTS.md` §§ Platform And App Service Boundary, TigerStyle Adaptation, Effect Version, Endpoint-Backed Capability, Core Access-Control, UI Package Rules, Verification and Code Change Expectations. `CONTRIBUTING.md:41`, `.agents/references/plan-writer.md`, `.agents/references/tigerstyle-typescript.md`, `.agents/references/effect-v4-guidance.md`, the plan-writer, core platform and dashboard UI skills, Effect `4.0.0` local Schema and Semaphore references, `pnotes/TODO.md:464`, and the source and tests cited by each part.

## 1. Context packet

- **Native Identity** is the `zelavis/app/identity` subsystem. `packages/zelavis/src/app/identity/identity-service.ts:212` publishes `/auth`, creates accounts and credentials, and issues sessions. The Platform composes it with System Store repositories at `packages/zelavis/src/index.ts:1605`. Each Project composes it with database repositories at `packages/zelavis/src/app/app-service.ts:116`.
- **Platform owner** is the human with the `owner` role and wildcard authority created by the existing bootstrap flow. The owner is the superadmin referred to in the request. `packages/zelavis/src/platform/auth-bootstrap.ts:155` is the existing authority.
- **Roles and grants** describe the account and authorize individual operations. `packages/zelavis/src/core/runtime/contracts.ts:14` defines the shared principal. `packages/zelavis/src/core/runtime/request-dispatcher.ts:691` exports `principalHasPermission` and handles exact scope matching.
- **Auth settings service** is the bundled `@zelavis/auth` plugin. `packages/zelavis/services/zelavis-auth/src/index.ts:23` registers one Platform settings page. Its removal must leave headless Identity operational. `@zelavis/ui` owns the native Fuzor dashboard and public page presentation.
- **Gateway versus site ingress** separates signed Platform management traffic from public App traffic. `packages/zelavis/src/platform/project-gateway.ts:649` exposes the authenticated management proxy and removes child cookies. `packages/zelavis/src/platform/public-domain-forwarder.ts:140` serves Project domains and previews, with the child control plane currently blocked.

> “The base authorization contract belongs in `zelavis/core`” and “`zelavis/app/identity` owns authentication primitives: accounts, credentials, sessions, roles and permissions.” `AGENTS.md` § Core Access-Control Rule.
>
> “Define one domain operation and shared input/output/error schemas, then adapt it to JS, HTTP, and CLI.” `AGENTS.md` § Endpoint-Backed Capability Rule.

## 2. Design and product decisions

| Decision | Owner and reason |
| --- | --- |
| One identity subsystem | Native Identity owns the setting and enrollment. `zelavis/core` continues to enforce permissions. The Auth product service and Fuzor UI call native endpoints. A new core service would duplicate authority. |
| Default off | Platform and App installs start closed. The existing App startup `registration` boolean, when explicitly supplied, is the initial setting for an empty store. A saved setting has precedence. Current native Apps with no saved policy require an explicit enable after upgrading. |
| One gate for new public accounts | The password signup handler and OAuth's first-account branch consult the same durable policy. Existing credentials and authorized linking still work. Platform readiness also depends on first-owner bootstrap completion. |
| Initial roles | `customer` on Platform, `user` in an App. Both have empty `permissions` and `grants`. An App account uses its existing per-account Tenant default. |
| Account administration | Reuse `system.users.manage` and scoped `project.users.manage`. Changes are conditional and can delegate only authority the actor holds. Protect owner/service identities and the actor's own account from this operation. |
| Public access in Apps | Add an exact route and method allowlist on native App site ingress. Management proxy stays protected. Session cookie names and bearer routing are separate per App and use the same persisted SessionService verification. |
| Project domains | The Platform Edge store owns the hostname. A customer with `project.domains.manage` can claim an exact Project hostname with DNS TXT proof. `project.view` stays a separate permission. Use the existing TLS controller and external TLS mode. |
| Verification and fulfillment | Password accounts remain unverified with respect to email ownership. Hosted provisioning and entitlements must be a separate, explicitly authorized commercial workflow. |

Signup and ongoing sign-in are separate operator choices. Supabase documents the same behavior for its signup toggle. OWASP recommends limiting automated auth attempts and avoiding unnecessary disclosure about account existence. This plan retains the existing immediate-session contract, so signup success versus refusal can still reveal account existence. It returns generic duplicate errors and bounds admission. [Supabase Auth configuration](https://supabase.com/docs/guides/auth/general-configuration) · [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)

### Rejected boundaries

- A separate Hosting Provider identity store would fork principals, sessions and Project grants.
- A UI-only flag would leave direct signup and OAuth account creation outside the policy.
- The existing `/runtime/projects/:projectId/proxy/*` requires Platform authority and strips child sessions. The public App form uses its site origin.
- A shared registration record keyed by Project ID in the Platform would make the control plane own App-user policy and complicate backup, transfer and cleanup.

### Needs from the user

None for planning or local implementation.

## 3. Shared contracts and handover

All additions below are **NEW** unless explicitly described as existing. Each part includes its complete route and record contracts.

| Domain | HTTP route relative to configured API base | JS SDK | CLI |
| --- | --- | --- | --- |
| Public registration availability | `GET /auth/registration` | `client.auth.registrationStatus()` | `zelavis auth registration-status --json` |
| Runtime registration policy | `GET`, `PUT /auth/registration/settings` | `client.auth.admin.registrationSettings()`, `.setRegistrationSettings(input)` | `zelavis auth registration-settings --json`, `zelavis auth set-registration-settings --data JSON --json` |
| Exact child policy | `GET`, `PUT /runtime/projects/:projectId/auth/registration/settings` | `client.projects.registrationSettings(projectId)`, `.setRegistrationSettings(projectId, input)` | `zelavis projects registration-settings PROJECT --json`, `zelavis projects set-registration-settings PROJECT --data JSON --json` |
| Public credential enrollment | Existing `POST /auth/sign-up/:provider` | Existing `client.auth.signUp`, `.signUpWithPassword` | Existing `zelavis auth sign-up PROVIDER --data JSON --json` |
| Human account access | `PUT /auth/accounts/:accountId/access` | `client.auth.admin.setAccountAccess(accountId, input)` | `zelavis auth set-account-access ACCOUNT --data JSON --json` |
| Exact child account access | `PUT /runtime/projects/:projectId/auth/accounts/:accountId/access` | `client.projects.setAccountAccess(projectId, accountId, input)` | `zelavis projects set-account-access PROJECT ACCOUNT --data JSON --json` |
| Project domain inventory and add | `GET`, `POST /runtime/projects/:projectId/domains` | `client.projects.domains`, `.addDomain` | `zelavis projects domains`, `add-domain` |
| Project domain verification and removal | `POST /runtime/projects/:projectId/domains/:hostname/verify`, `DELETE /runtime/projects/:projectId/domains/:hostname` | `client.projects.verifyDomain`, `.removeDomain` | `zelavis projects verify-domain`, `remove-domain` |

Registration is a per-runtime policy with optimistic revision and bounded enrollment slots. The slots make staged account and credential writes recoverable without a growing pending-account scan. Conditional commit and the enable/disable change serialize at the same record. Account access replaces authorized roles and grants with an account-version precondition. Neither operation accepts a caller-selected identity scope from the body.

## 4. Parts in execution order

| Part | File | Status | Handover |
| --- | --- | --- | --- |
| 1 | `01-registration-policy-and-enrollment.md` | complete | Durable policy, crash-safe enrollment and JS, HTTP and CLI, including the scoped Project settings route. |
| 2 | `02-human-account-access.md` | complete | Conditional Platform and App access edits, delegated authority checks and scoped Project inventory are verified through HTTP, SDK and CLI. |
| 3 | `03-dashboard-registration-controls.md` | complete | Uses Parts 1 and 2 operations in Auth, Access and the native dashboard login/signup views. |
| 4 | `04-native-app-public-auth.md` | complete | Verified native App login and signup, Project-specific sessions, and an exact public allowlist on verified hostnames and Edge previews. |
| 5 | `05-project-domain-management.md` | complete | Scoped DNS TXT claims, external HTTPS, managed Edge activation and withdrawal fixtures, dashboard, SDK and CLI. |
| 6 | Self-audit | complete | Reviewed the combined changes against the finish criteria and reran the focused and workspace gates. |

The split separates identity persistence and enrollment, human authorization, operator dashboard, public Project Auth ingress, and customer domain management. Each part ships and verifies its own supported interfaces.

## 5. End-to-end proof

- Bootstrap a Platform owner, confirm signup closed, enable it, create a customer, sign out and sign in, and verify the customer initially sees zero Projects. Assign one existing Project grant. Verify precisely that Project becomes visible and server actions still refuse the customer.
- Start two native Apps. Enable one, register the same identifier as a Platform user, sign in on the App origin, and prove its session and account are scoped to that App. Close signup and sign in again. The sibling remains closed. Restart the enabled App after reopening and verify persistence.
- Give the customer domain management for one Project. Add and verify its DNS TXT challenge, serve the App through that verified host, and withdraw it. Verify another Project and server-level Edge actions remain outside that grant.
- Repeat with stale setting revisions and signup forms, first-time OAuth and existing OAuth login, duplicate identifiers, partial repository writes, untrusted Host and Origin, multiple Projects on previews sharing a hostname, and denied control-plane paths.

## 6. Docs and project notes

Each part updates the nearest public docs with behavior it has proved. Keep the private `pnotes/TODO.md:434` and `:464` current during implementation per `AGENTS.md` § Repo Structure. Keep commercial lifecycle, verification delivery and custom role workflows in open work. Preserve the Project recipe and storage ownership documentation.

## 7. Verification

From the repository root, run the checks in each part in sequence, then `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check` and `git diff --check`. All must exit zero after the last edit. Inspect new plan files separately because an untracked file is absent from `git diff`.

## 8. Instructions to the implementer

Read this overview and the next unfinished part, then start with that part's section 8. Execute each part in a fresh session. The prior part must be verified before the next one uses its contracts. Update this table, checklist and `Status` as each part lands. Use `Continue` and read the previous execution report when resuming a part. Keep other worktree edits separate and preserve existing authority, runtime ownership, scoped storage and service-loading rules. After the final part, reread the combined diff against the finish line and rerun the combined gates before completing this overview. Record any changed product decision or outstanding concrete prerequisite in the corresponding part's execution report. Publishing, deployment and commits are separate work.

## Execution report

### 2026-11-11

Part 1 complete. Default-closed registration, recoverable password and OAuth enrollment, and exact Project settings are verified through the native API, SDK and CLI. The next part is `02-human-account-access.md`.

Part 2 complete. Conditional human access edits, session invalidation, delegated
account administration and scoped Project inventory are verified. The next part
is `03-dashboard-registration-controls.md`.

Part 3 complete. Platform and exact Project registration controls, public Platform
signup, conditional access drawers and grant-filtered customer navigation are
verified through the production bundle at desktop/mobile sizes and a nested
dashboard mount. The shell now consumes the authenticated access response.
The next part is `04-native-app-public-auth.md`.

Part 4 complete. Native App public Auth uses Project-specific sessions on
verified hostnames and Edge previews. The production Chromium run exercised
desktop and mobile signup, sign-out, and login after closing registration.
The focused Node suites, workspace verification, browser suite, docs and
diff checks passed. Project Auth links to the published preview. The next
part is `05-project-domain-management.md`.


Part 5 complete. Customers can use exact Project grants to add, verify and
withdraw a hostname in the dashboard, SDK or CLI. The browser suite verified
delegation through Users, the TXT workflow at both widths, native App signup
through local external HTTPS, and Platform route isolation. Managed HTTPS
issuance and publication transitions passed local fixtures. Public CA and
deployed proxy qualification remain open. All 134 focused tests and
`pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check` and
`git diff --check` passed. The remaining overview item is the whole-feature
self-audit.

### 2026-11-12

Step 6 complete. Reviewed the combined changes against all six finish criteria.
The enrollment and OAuth suites cover default-closed registration, independent
runtime policies across restart, session issuance and retry. The access tests
cover exact Project grants and scoped inventory. The production browser suite
covers the Platform and App forms, stale signup, existing login with signup
closed, hostname verification and withdrawal. Public forwarding and the
browser suite cover App session and control-plane isolation. Part 5 tracks
deployed-proxy, public CA and renewal qualification separately.

The union of the focused Node suites from Parts 1–5 passed. The dashboard
typecheck and unit tests, Auth plugin tests, `pnpm run verify`, `pnpm run ci:ui`,
`pnpm run docs:check` and `git diff --check` passed. The core suite had 2,850
passes and 30 environment-gated skips. Checked the untracked plan and source
files for whitespace and final newlines, and ran the private notes diff check.

The separate Part 5 deployment test passed hostname activation, native App
signup and route withdrawal through Traefik 3.7.13 in a disposable Linux guest
with Pebble as the test CA. Renewal issued a replacement certificate but left
the old certificate in service until an explicit Edge publish and switch.
The renewal fix and the successful Traefik rerun are recorded in Part 5.
The later VPS run completed public CA staging qualification. Let’s Encrypt
validated the disposable IPv6 hostname over HTTP-01. Off-host HTTPS clients
verified the initial certificate and both renewals. The deployed proxy test
also verified native App signup and route withdrawal. See the Part 5 report
for the test boundaries and cleanup evidence.
