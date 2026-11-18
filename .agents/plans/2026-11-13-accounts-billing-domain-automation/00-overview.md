# Account lifecycle, hosting billing and domain automation

Job: Plan the follow-ups to the finished self-registration plan: qualify the Project domain DNS TXT ownership check against a real TXT record in public DNS (the VPS run used test resolver injection), and build what that plan left out of scope: billing and paid hosting entitlements, email verification with email delivery, invitations, password recovery, MFA, custom role definitions, and domain purchase and DNS automation (registrar purchases, transfers, DNS automation, wildcard certificates).
Date: 2026-11-13
Status: done
Verified-at: b04fa02d95

To start:    Execute part 1 in .agents/plans/2026-11-13-accounts-billing-domain-automation/01-authoritative-dns-challenge-lookup.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/00-overview.md. Start with the first part in section 4 that is neither done nor partly done, at its section 8.

## Progress

- [x] 1. Land authoritative DNS challenge lookup. (2026-11-13)
- [x] 2. Land per-runtime email delivery. (2026-11-13)
- [x] 3. Land email verification and password recovery. (2026-11-13)
- [x] A. (2026-11-16) Land the Zelavis Auth plan (all 16 parts, completed and removed after cutover). It replaces parts 4 (invitations, now Auth invitations) and 5 (TOTP, now Auth TOTP), whose files were removed on 2026-11-14.
- [x] 6. Land custom role definitions. (2026-11-16)
- [x] 7. Land DNS providers, automatic records and wildcard certificates. (2026-11-16)
- [x] 8. Land public DNS and CA qualification. (2026-11-17. Run `1bluwknkn4m` passed all five live legs on zelavis.com with Let's Encrypt staging, off-host chain verification and complete cleanup; all local gates passed.)
- [x] 9. Land registrar purchase, transfer and renewal. (2026-11-17: all four live Namecheap sandbox checks passed using test credit; lowercase pricing fix and all final gates passed.)
- [x] 10. Land cloud capacity in core. (2026-11-17: lazy bundled adapter, stored machine policy, signed HTTPS webhook provider and dashboard/SDK/CLI parity; all final gates passed.)
- [x] 11. Land the Platform services database. (2026-11-17: private service-only storage, shared three-component backups, host-local restore/recovery and Ecommerce persistence; all required gates passed.)
- [x] 12. (2026-11-17) Land Ecommerce billing on the Platform: sealed credentials, authorized checkout/portal, atomic signed events, durable fulfillment and dashboard/docs; all required gates passed.
- [x] 13. (2026-11-18) Land approved service principals, sealed in-process access, lifecycle revocation and Marketplace/SDK/CLI parity; all required gates passed.
- [x] 14. (2026-11-18) Hosting Provider implementation, Stripe test-mode qualification (`PASS subscribe`, `PASS project`, `PASS limit`, `PASS suspend`), and all workspace/browser/docs checks passed.
- [x] 15. (2026-11-18) Self-audit across all parts passed.

## 0. Summary and finish line

The earlier plan (`2026-11-10-platform-app-self-registration`, finished and removed by this run; code in commit `7fe8fb53f4`) shipped default-closed signup, login, scoped account access, App public auth and customer Project domains. This plan completes the account lifecycle (email delivery, verification, recovery, invitations, MFA, custom roles), finishes domains (authoritative TXT checks, DNS provider automation, DNS-01 and wildcard certificates, registrar purchase and transfer, and a real public-DNS qualification run), folds the cloud capacity service (Alchemy and autoscaling) into core, and lets any operator run a hosting business: Ecommerce bills on the Platform, services can be given approved Platform permissions at install, and the `@zelavis/hosting` service turns what was paid into plans, quotas and access.

### In scope

- Project domain TXT proof read from the zone's authoritative nameservers, and a committed qualification script that proves it with a real public zone, a real TXT record and Let's Encrypt staging.
- Per-runtime email delivery (Platform and each native App), SMTP built in, durable outbox, operator settings and test send.
- Email ownership verification and password recovery delivery (done in part 3, superseded by Zelavis Auth), invitations and TOTP MFA (moved to the Zelavis Auth plan), and custom role definitions, on both the Platform and native App runtimes.
- DNS providers with a built-in Cloudflare driver and plugin discovery for others, automatic record management for operator-hosted subdomains, ACME DNS-01 and wildcard certificates.
- Operator registrar purchase, transfer-in and renewal with the operator's own account, through a built-in Namecheap driver (plugins can add registrars).
- Cloud capacity in core: `@zelavis/cloud` dissolved into a capacity adapter inside `zelavis`, loaded only when a provider is used; stored machine policy instead of `ZELAVIS_CLOUD_POLICY`; a webhook provider for datacenters without an API.
- A private services database on the Platform, so services keep durable records there.
- Ecommerce ready to bill from the Platform: authorized routes, sealed provider credentials, hosted checkout and portal, verified webhooks applied once, and a fulfillment extension point.
- Service principals: a service's manifest asks for Platform permissions, the operator approves them at install, and the service acts in-process with its own revocable service account; a service cannot be disabled while another extends it.
- The `@zelavis/hosting` service in `zelavis-services/hosting`, installed from the Marketplace and requiring Ecommerce: plan creation, billing through Ecommerce, self-service Projects within quota, suspension on lapse.
- JS SDK, HTTP and CLI parity for every new operation, dashboard pages, public docs and tests for all of it.

### Out of scope

- SMS factors (weak, and cost money per message). Passkeys moved into the Zelavis Auth plan (WebAuthn implementation).
- HTTP-API email provider plugins (Postmark, SES and Resend all accept SMTP submission, so SMTP covers them).
- Customer-owned DNS provider connections, and domain resale to customers. Reason: resale needs automatic refunds when a paid registration fails and a DNS zone created for the bought domain, each its own design; customers keep the TXT-proof flow and operator-hosted subdomains.
- Taxes, VAT invoices, refunds through Zelavis, coupons on checkout, metered usage billing, resellers and delegated Project Platforms, selling whole managed Platforms. Stripe's own dashboard handles refunds; tax is a commercial decision.
- Opening the node enrollment listener from the dashboard (a start option today; changing listeners at runtime belongs to the live-update design).
- Periodic re-verification of already verified Project domains (ownership drift). Recorded as an open limit in part 1's docs.
- Planning and real-time collaboration roadmap rows of `AGENTS.md § Project Vision`.

### Done means

1. Project domain verification reads `_zelavis-challenge.<host>` from the zone's authoritative servers: a record added after a failed check verifies on the next check without waiting for any resolver's negative cache. `pnpm release:qualify:domains` passed once against a real public zone, recorded in part 8's report.
2. An operator can configure SMTP for the Platform and, separately, for one App; a test message arrives at a local SMTP fixture in tests; deliveries survive restart and retry with bounded backoff.
3. Password signups receive a verification email; when the runtime requires verified email, unverified accounts cannot sign in; password recovery emails a single-use link whose token is consumed exactly once under concurrency. (Done in part 3; the Zelavis Auth plan replaces the mechanism: email + password accounts always verify before their first session.)
4. Invitations: see the Zelavis Auth plan's Done means 10 (its part 15).
5. TOTP MFA: see the Zelavis Auth plan's part 10 Done means.
6. An operator defines custom roles (permission bundles, optionally parameterized by Project) and assigns them within their own authority; editing a role changes members' authority on their next request.
7. With a Cloudflare connection (built-in driver), an operator-hosted subdomain gets its TXT and address records and a wildcard certificate issued by DNS-01, all removed when the domain or Project goes.
8. The owner can check, register, transfer in and renew a domain through the built-in Namecheap driver, qualified against Namecheap's sandbox; nothing is purchased twice after a crash.
9. `packages/zelavis/services/zelavis-cloud/` and `ZELAVIS_CLOUD_POLICY` are gone; the capacity bundle ships inside `zelavis`, loads only when a provider is used, and nothing in core, Edge, Platform, backends or the SDK imports a provider driver (`test/provider-adapter-boundary.test.mjs`).
10. Ecommerce on a Platform keeps its data across restarts, refuses unauthorized callers, takes payment through a hosted checkout, and applies each verified provider event once.
11. A service with a manifest principal installs only after the operator approves exactly its permissions, and disabling it revokes them.
12. An operator installs `@zelavis/hosting` (after Ecommerce); a customer subscribes through Stripe Checkout (test mode), creates Projects up to the plan's limit, and on lapse their billed Projects stop (never delete) until payment resumes.
13. `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check` and `git diff --check` pass after the last edit.

### Reading of the request

"Billing" means billing hosting customers of a Platform. After discussing it with the owner (2026-11-13, this conversation), money lives only in `@zelavis/ecommerce`, which gains what billing needs (part 12); Hosting is its own service in `zelavis-services/` that requires Ecommerce and holds no payment code (part 14), acting through a principal approved at install (part 13). "Domain purchase" is an operator capability with the operator's own registrar account. "MFA" is TOTP with recovery codes.

### Owner decisions this revision applies (2026-11-13, this conversation)

- Domains, DNS providers and registrar connections are core and available to every superadmin (Zelavis Cloud, self-hosters, hosting companies).
- Core owns each provider capability and ships its first-party drivers (Cloudflare, Namecheap, Hetzner) behind the adapter boundary in `packages/zelavis/src/adapters`; third parties add drivers as plugins through the same contract. No `zelavis-services/dns-cloudflare` or `registrar-namecheap` packages.
- `@zelavis/cloud` dissolves into core and is no longer a service; Alchemy stays behind the adapter boundary and is loaded only when a provider is used, so core stays runtime-neutral.
- Billing is solved once in Ecommerce, which stays a service; payment providers stay Ecommerce plugins.
- Hosting is its own service (`@zelavis/hosting`, not bundled, not core) with plan creation and billing features that require Ecommerce; its Marketplace entry carries the explanation "for hosting and cloud companies using Zelavis as their panel"; Zelavis Cloud runs the same code as everyone. Cloud capacity with Alchemy and autoscaling moves into core.

### Supplement and cleanup

- Revised 2026-11-14 (owner request: rebuild Auth before continuing): Zelavis Auth replaces the former `app/identity` subsystem (row A in section 4). Parts 4 and 5 moved there and their files were removed; part 4's step 2 (gaps found reviewing part 3) became its invariants I6-I8, because its cutover deletes the code those fixes targeted. Parts 6, 11 and 13 were `needs replanning`; parts 7 and 14 carried a note.
- Refreshed 2026-11-16 (Zelavis Auth plan part 16 step 9): parts 6, 11 and 13 rebuilt on Zelavis Auth and back to `planned`: part 6 keeps roles as rows of a new `roles` Auth module, checked in the writing transaction, with an in-process catalogue cache for authentication; part 11 adds the services database as the `database` component of the identity database's backups host, opened with no host of its own (`backups: false`); part 13 makes the service principal an Auth service account found through a new owner row, deleted on disable. Parts 7 and 14 had their Auth citations moved to `packages/zelavis/src/auth`.

- `.agents/references/plan-writer.md` was 17 commits behind (`f30953612f`). Updated and set to `b04fa02d95`: the compatibility rule now names the explicit Project upgrade for published layouts (`AGENTS.md § Code Change Expectations`), the dashboard reads caller authority from `runtime/access`, `test:browser` reruns the embedded suite with `--nested-auth`, browser steps wait for the page's own server-answered sign, and a new trap covers the Project host import footprint. Review and commit it.
- Conflict flagged, not changed: the supplement (citing `AGENTS.md § Repo Structure`) says to keep `pnotes/TODO.md` current; the owner retired that file in a later instruction (no additions; open items live in `.agents/plans`). Every part follows the owner: it removes finished entries it finds there and adds none.
- Conflict flagged and settled by the owner: `AGENTS.md § Core Access-Control Rule` says "What is vendor-specific stays a plugin." in its identity-provider passage. Parts 7, 9 and 10 follow the owner's newer decision for Edge and capacity drivers (built into core behind the adapter boundary) and write it into `AGENTS.md` (part 7 step 10 for Edge drivers, part 10 step 9 for capacity); identity providers stay plugins.
- Removed the finished plan `.agents/plans/2026-11-10-platform-app-self-registration/` (overview and all five parts complete). It is in Git history if needed. No other plans existed.
- Revised the same day after the owner's decisions above: parts 7 and 9 now build drivers into core, the former part 10 (a Platform billing subsystem with `@zelavis/billing-stripe`) was replaced by parts 10-14, and part headers now read "of 14". A first version of the revision bundled Hosting with a core switch page; the owner then chose a standalone service, so part 13 became the general service-principal mechanism and Hosting moved to part 14 in `zelavis-services/hosting`.

### Sources read

`AGENTS.md` (§§ Platform And App Service Boundary, Cloud Capacity And Alchemy, Marketplace Allow-List, TigerStyle Adaptation, Effect Version, Database Architecture Rules, Endpoint-Backed Capability Rule, Core Access-Control Rule, UI Package Rules, Verification, Code Change Expectations), `.agents/references/plan-writer.md`, `.agents/references/tigerstyle-typescript.md`, `.agents/references/effect-v4-guidance.md`, the removed plan's overview and Part 5, and the source and tests cited in each part.

## 1. Context packet (shared)

**Glossary.**
- **Runtime**: one `zelavis()` composition. The Platform is `role: "platform"`; each native App Project runs its own with `role: "project"` (`AGENTS.md § Platform And App Service Boundary`).
- **Runtime System Store**: the `ZelavisSystemStore` a runtime owns. The Platform's is `<data>/system/zelavis.sqlite`; a Project's is `<project>/.zelavis/runtime/zelavis.sqlite` (`packages/zelavis/src/adapters/node.ts:293-304`). Interface at `packages/zelavis/src/system-store.ts:26`: `get`, `set`, `setIfAbsent`, `compareAndSet(ns, key, expectedUpdatedAt, value, expectedValue?)`, `compareAndDelete`, `delete`, `page(ns, { limit, after })`, `list`.
- **Zelavis Auth** (replaced native Identity, 2026-11-15): `zelavis/auth`, `packages/zelavis/src/auth` (`AGENTS.md § Zelavis Auth`). Composed per runtime by `createAuthSubsystem` (`packages/zelavis/src/auth/subsystem.ts`): the Platform on its identity database (`<data>/identity-database/`), each App on its Project database, both in the Tenant `service:zelavis-auth`; every change is one `documents.transaction`. Parts 1-3 below were written against Identity and are done; their code was replaced by that plan.
- **Master secret**: `loadPlatformMasterSecret(store)` (`packages/zelavis/src/platform/master-secret.ts:19`) creates one 32-byte hex secret per store, if absent. It works on any runtime System Store, so a Project runtime gets its own. Secrets at rest use `encryptSecret`/`decryptSecret` (`packages/zelavis/src/edge/acme-crypto.ts:79`, `:104`) with a key `${masterSecret}\u0000<purpose>`, as `packages/zelavis/src/assistant-provider.ts:133-135` does.
- **Project Gateway**: the Platform's authenticated proxy into one Project runtime. Exact child routes are declared one by one in `packages/zelavis/src/platform/project-gateway.ts:670-760` (registration settings, account access).
- **App public auth**: the exact allowlist of App routes served on a verified App hostname or preview, `packages/zelavis/src/platform/project-public-auth.ts` (`pages`, `publicAuthRoutes`), with pages rendered by `packages/zelavis/services/zelavis-ui/src/identity-frontend.ts` and browser code `packages/zelavis/services/zelavis-ui/app/auth-site.ts` and `app/auth-public.ts`.

**Governing rules.**
> "Every official public Zelavis capability must be available through the official JavaScript SDK, versioned HTTP API, and CLI." `AGENTS.md § Endpoint-Backed Capability Rule`
>
> "Future official modules such as Hosting Provider must not create a separate customer permission system. Customers, resellers, operators, and owners are Zelavis principals with system, project, or service-scoped grants." `AGENTS.md § Core Access-Control Rule`
>
> "What is vendor-specific stays a plugin." `AGENTS.md § Core Access-Control Rule`
>
> "Identity guarantees hold under concurrency, so they live in the repository, not in a check made first." `AGENTS.md § Core Access-Control Rule`
>
> "Provider tokens are stored encrypted, never returned or logged, and every use is audited." `AGENTS.md § Cloud Capacity And Alchemy`
>
> "Any new Platform resource keyed by Project identity must register a cleanup participant." `AGENTS.md § Platform And App Service Boundary`

**Traps (shared).** Read-then-write for anything single-use (tokens, codes, slots) loses races: consume through a repository `mutate`. A link built from the request's `Host` header is a reset-link poisoning hole: links come from an operator-configured base URL. Secrets never appear in responses, logs, security events or URLs sent to the server (emailed links carry tokens in the URL fragment). A vendor API outside `packages/zelavis/src/adapters` is a boundary violation: first-party drivers live there and are injected by the Node adapter; third-party drivers are plugins discovered by an owner-qualified capability; payment providers are Ecommerce plugins. Promise orchestration in Platform code fails `pnpm check:effect-usage`.

## 2. Shared design decisions

| Decision | Reason |
| --- | --- |
| Each runtime owns its email settings, outbox, tokens, MFA factors and role catalogue. Nothing App-scoped lives in the Platform. | Same as the registration policy: the earlier plan rejected a Platform-held record keyed by Project for App-user policy (backup, transfer, cleanup). |
| SMTP is built in; no email provider plugin. | Recovery and verification are core account functions, like built-in password sign-in (now `packages/zelavis/src/auth/methods/email-password.ts`). Every mainstream provider accepts SMTP. |
| Emailed links come from the email settings' `linkBaseUrl`, and carry tokens in the fragment (`#token=`). | No Host-header poisoning; fragments are not sent to servers, proxies or `Referer`. |
| Single-use links and challenges are consumed once inside an Auth transaction (verification, recovery, invitations, MFA). | Superseded: parts 1-3 used one `accountTokens` repository; Zelavis Auth replaced it with upstream's email challenges and its own invitation and MFA tables, each consumed in the transaction that acts on it. |
| Core owns provider contracts (`zelavis/edge:dns`, `zelavis/edge:registrar`, `CapacityProvider`) and ships first-party drivers in `packages/zelavis/src/adapters`, injected by the Node adapter; plugins may add drivers under the owner-qualified capabilities. Payment providers stay `@zelavis/ecommerce:payments` plugins. | Owner decision (this revision); `AGENTS.md § Runtime Independence Rule` keeps vendor code in adapters; the capability model is `packages/zelavis/src/core/service/capability.ts:1-23`. |
| Billing lives in Ecommerce; Hosting turns paid subscriptions into role assignments (part 6) through public operations, as its own service principal approved at install (part 13). | No second permission system and no second billing system (`AGENTS.md § Core Access-Control Rule`; owner decision). |
| Money-moving and purchase operations are durable state machines with idempotency keys and never retried blindly after an ambiguous submit. | A crash must not buy a domain twice or charge twice. |

### Decisions taken for the user

- First DNS driver: Cloudflare (most common, token-scoped API, also hosts zelavis.com's website). First registrar driver: Namecheap (long-standing free sandbox). First payment provider for billing: Stripe through `@zelavis/ecommerce-stripe` (test mode, hosted Checkout and Customer Portal keep card data off the Platform).
- Services act on the Platform through a manifest-declared principal the operator approves at install (part 13), rather than a service account created by hand and a pasted token.
- A `webhook` capacity provider (signed HTTPS requests to the operator's automation) covers datacenters without an API; no script runs on the Platform host.
- MFA is TOTP plus ten single-use recovery codes. The owner can require it for privileged accounts or all accounts.
- Lapsed subscriptions stop the customer's billed Projects after a seven-day grace period; nothing is ever deleted automatically.
- Verified-domain drift and customer-owned DNS connections stay out of scope (section 0).

### Needs from the user

These are things the implementer cannot supply. Each blocks only the named steps, which start as `[!]` in their parts. Everything else proceeds.

- Supplied and qualified on 2026-11-17: a zone-scoped Cloudflare token, `zelavis.com`, root SSH to the existing VPS and a spare routed IPv6 address on `eth0`. Part 8's live run and cleanup passed; its credentials are not stored in this plan.
- Supplied and qualified on 2026-11-17: a separate Namecheap sandbox account, its API key and this Mac's whitelisted client IP. All four part 9 sandbox checks passed; no credential is stored in this plan.
- Supplied and qualified on 2026-11-18: a Stripe test-mode secret key (`sk_test_...`) and Stripe CLI session in the same test sandbox (`acct_1DstxnIOdKYPsoH4`). Part 14's live run and cleanup passed; no credential is stored in this plan.

## 3. Shared contracts and handover

| Part | New operations (HTTP, relative to the API base) | New records |
| --- | --- | --- |
| 1 | none (behavior change in `POST /runtime/projects/:projectId/domains/:hostname/verify`) | none |
| 2 | `GET/PUT /email/settings`, `POST /email/test`, `GET /email/deliveries`; Project: `/runtime/projects/:projectId/email/{settings,test,deliveries}` | `zelavis.email` settings, `zelavis.email.outbox` |
| 3 | `POST /auth/email/verify`, `POST /auth/email/verification`; registration settings gain `emailVerification`; recovery moves onto tokens | `accountTokens` repository |
| 4, 5 | moved to the Zelavis Auth plan (parts 15 and 10) | |
| 6 | `GET/POST /auth/roles`, `PUT/DELETE /auth/roles/:roleId`; account access gains `roleAssignments` | `roles` catalogue record |
| 7 | `/runtime/edge/dns/{providers,connections,zones}*`; Project domains gain `dns: "automatic"` | `edge.dns-connections`, `edge.dns-zones` |
| 8 | none (script `pnpm release:qualify:domains`) | none |
| 9 | `/runtime/registrar/{providers,connection,contact,availability,quote,domains,orders}*`; script `pnpm release:qualify:registrar` | `registrar.connection`, `registrar.contacts`, `registrar.orders`, `registrar.order-keys`, `registrar.active-orders` |
| 10 | `GET\|PUT /runtime/cloud/policy`; cloud connection gains `provider: "webhook"` and `endpoint` | `fabric.cloud-policy.v1`, `fabric.cloud-webhook-nodes.v1` |
| 11 | none (host-local `zelavis services-database restore`) | `<data>/services-database/` |
| 12 | `/plugins/ecommerce/{checkouts,customers/:id/portal,webhooks/:provider,fulfillment/failures}`; `/plugins/stripe/settings` | `commerce_checkouts`, ledger receipts, `commerce_fulfillment_deliveries`; `core.secrets` |
| 13 | `approvePermissions` on the service install, update and update-to-listed routes; services list gains `principal` | `zelavis.service-principals`; one service account per principal |
| 14 | `/plugins/hosting/hosting/{settings,plans,subscriptions,subscription,checkout,portal,projects}` | `hosting_settings`, `hosting_plans`, `hosting_subscriptions`, `hosting_provisions` (Hosting's Tenant) |

Each part writes its own contracts in full in its section 3.

## 4. Parts in execution order

| Part | File | Depends on | Status |
| --- | --- | --- | --- |
| 1 | `01-authoritative-dns-challenge-lookup.md` | none | done |
| 2 | `02-email-delivery.md` | none | done |
| 3 | `03-email-verification-and-password-recovery.md` | 2 | done |
| A | Zelavis Auth plan (16 parts, completed and archived after cutover; replaces 4 and 5) | 1-3 | done |
| 6 | `06-custom-roles.md` | A | done |
| 7 | `07-dns-providers-and-wildcard-certificates.md` | 1 | done |
| 8 | `08-public-dns-and-ca-qualification.md` | 1, 7; live inputs supplied and qualified | done |
| 9 | `09-registrar-purchase-and-transfer.md` | 7 (provider pattern, boundary test) | done |
| 10 | `10-cloud-capacity-in-core.md` | 7 and 9 (boundary test exists to extend; works without them) | done |
| 11 | `11-platform-services-database.md` | A (part 3, identity database backups host) | done |
| 12 | `12-ecommerce-billing-on-the-platform.md` | 11 | done |
| 13 | `13-service-principals.md` | A | done |
| 14 | `14-hosting-provider.md` | 6 (roles), 11, 12, 13 | done |

Parts edit shared files (`sdk/fetch.ts`, CLI tables, `project-gateway.ts`, `dashboard-routes.ts`), so they run one at a time, in this order, in the main checkout on `dev`. Row A (the Zelavis Auth plan) ran first; parts 6, 11 and 13 were refreshed against it on 2026-11-16 (its part 16 step 9). Parts 6 and 7 landed on 2026-11-16. Parts 8 and 9's live qualifications and final gates passed on 2026-11-17. Parts 10–13 landed on 2026-11-17/18, and Part 14's live Stripe qualification and the final cross-part self-audit passed on 2026-11-18.

## 5. End-to-end proof

After part 14: configure SMTP on the Platform and one App against the local SMTP fixture; sign up on the Platform, verify email, enable TOTP, sign out, sign in with password + code; recover the password and see the old sessions end; invite a second address with one Project grant and accept it while registration is closed; define a custom role and assign it; set a capacity policy and connect the webhook capacity provider to a fake endpoint; install Ecommerce and then Hosting (approving its permissions), subscribe through Stripe test mode, create a Project within quota, see the second over quota refused; cancel and see the Project stopped after grace. On the App origin repeat signup, verification and recovery. Connect a fake Cloudflare zone and add an automatic subdomain with a wildcard certificate. Each part's tests cover its slice; parts 8, 9 and 14 record their live qualification runs.

## 6. Docs and project notes

Each part updates the docs it names. Do not add to `pnotes/TODO.md` (owner instruction); remove any entry a part completes. Open follow-ups stay in this plan as `A<n>` lines.

## 7. Verification

From the repository root after each part and again at the end: `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check`, `git diff --check`. If host-operation tests fail on the sandbox's `/tmp` symlink, rerun with `TMPDIR=/private/tmp/zelavis-verify` (create it first). Inspect new untracked files separately; `git diff` does not show them.

## 8. Instructions to the implementer

Read this overview, then the first part in section 4 that is neither `done` nor `partly done`, and start with that part's section 8. Execute each part in a fresh session, in the main checkout on `dev`: no worktrees and no new branches (owner instruction). A part starts only after the previous part's checks pass. As each part lands, update its row in section 4, this file's `## Progress` line for it, and `Status`. A part left with only `[!]` lines counts as `partly done` and does not hold back the next part unless the next part's Depends on names the blocked work. After the last part, run line 15 (Self-audit across all parts): reread the combined diff against section 0's Done means, rerun the section 7 commands, and record the result below. Committing, pushing, publishing and deploying are separate work and stay off.

**Next-session prompt.** Apply [the repository's next-session prompt rule](../../../AGENTS.md#next-session-prompt-for-plan-execution) after any execution handoff. Use the updated status and dependencies in section 4 to name the next ready step or part, including any prerequisite plan, or this overview's final self-audit.

## Execution report

### Part 3 (2026-11-13)

Email verification and password recovery are complete on the Platform and
native Apps. The browser checks exercised both flows against local SMTP at
desktop and mobile sizes. Workspace verification, browser qualification, docs
and whitespace checks passed sequentially. Part 4 is the next planned part.

### Part 6 (2026-11-16)

Custom roles are rows of a new `roles` Auth module, checked and written in one transaction against the catalogue
revision; assignments (`roleAssignments` on account access and invitations) are expanded into principals from an
in-process copy the role routes clear. Platform and App, exact Gateway routes, SDK, CLI, dashboard pages and docs
landed. `verify`, `ci:ui`, `docs:check` and `git diff --check` passed. Part 7 is next.

### Part 7 (2026-11-16)

DNS providers (`zelavis/edge:dns`, built-in Cloudflare driver in `adapters/_dns-cloudflare.ts`), encrypted DNS
connections and adopted zones, ACME DNS-01 and wildcard certificate orders with authoritative propagation checks,
automatic hosted subdomains with persisted record IDs and exact cleanup, HTTP/SDK/CLI parity, Server → Domains and
Project → Domains dashboard pages (`qualifyDnsAutomation`), and documentation landed. `verify`, `ci:ui`, `docs:check`
and `git diff --check` passed. Part 8 is next.

### Part 8 (2026-11-16)

Partly done. The domain qualification harness passed all five loopback legs and the workspace, docs and whitespace checks. Live steps 3–5 await the Cloudflare zone and token, disposable VPS SSH access, and free IPv6 address and interface. Part 9 is ready.

### Part 8, Session 2 (2026-11-17)

Done. Run `1bluwknkn4m` qualified the packed working-tree candidate at `0e4548dbcc` against
`zelavis.com`: authoritative TXT proof while `8.8.8.8` retained a negative answer, Let's Encrypt
staging HTTP-01 and DNS-01 wildcard issuance, off-host HTTPS verification, automatic subdomain
routing and complete DNS/VPS cleanup. Existing production PIDs stayed unchanged. Fixed bundled
Marketplace host-package resolution with a reproducing regression and added a configurable
public recursive resolver after `1.1.1.1` failed the cache-retention precondition. Full workspace
verification (3,311 Zelavis passes, 30 skips), `ci:ui`, local self-test, focused tests, docs and
whitespace checks passed. Part 9 still needs its separate Namecheap sandbox inputs; part 10 is ready.

### Part 9, Session 2 (2026-11-17)

Done. The separate free Namecheap sandbox account, API access and one Mac-IP
whitelist entry were set up through Chrome with the owner's approval. The live
sandbox qualification passed availability/pricing, registration, renewal and inventory
using only test credit. Its first read-only check exposed lowercase pricing categories;
the driver now handles both that real response and the uppercase documented form,
with a reproducing regression. Full workspace verification (3,312 Zelavis passes,
30 skips), `ci:ui`, all 24 focused registrar/driver/boundary tests, docs and whitespace
checks passed. No production registrar API or real spending occurred. Part 10 is ready.


### Part 10 (2026-11-17)

Done. Dissolved the private cloud service into a lazily loaded capacity adapter in
`zelavis`, with stored revisioned machine policy, a signed HTTPS webhook provider,
shared provider-independent first-boot helpers, and dashboard/HTTP/SDK/CLI parity.
The embedded browser suite proves policy save/reload and a real local HTTPS webhook
connection at desktop/mobile sizes. Final workspace verification (3,391 Zelavis
passes, 30 skips), full `ci:ui`, docs, reference-source regressions and whitespace
checks passed. Existing changes were preserved; nothing was staged or committed.
Real Hetzner qualification remains out of scope. Part 11 is next.


### Part 11 (2026-11-17)

Done. The Node Platform opens one private services database, handed only to
services' `core.database`; runtime database capabilities/routes and environment
session persistence remain unchanged. Its `database` component joins `identity`
and `system-store` on the Platform's one backup host. Added host-local confirmed
restore with validation, live-owner refusal, failed-move rollback and interrupted
restore recovery, sharing the identity restore helper while preserving identity's
copy semantics. Ecommerce installed through the real service activation route
retains a product after a Platform restart. Full verification (Zelavis 3,398
passes, 30 skips, zero failures; Ecommerce 22 passes), `ci:ui`, docs and whitespace
checks passed. Existing changes were preserved; no branch/worktree or commit was
created. No blocker remains for part 11. Part 12 is next.


### Part 12 (2026-11-17)

Done. Added per-runtime sealed service credentials and runtime-owned worker
contributions; Ecommerce now authorizes its routes, creates hosted checkout and
portal sessions, applies signed events atomically with receipt/outbox protection,
and delivers durable per-handler fulfillment with bounded retries. Stripe reads
sealed settings, verifies exact-body signatures and supports hosted/recurring
billing, including renewal invoices and delayed checkout success. Native App
public callbacks follow a narrow product-neutral ingress convention. Payments
and Stripe pages work through opaque service frames at desktop/mobile sizes, and
package-content tests prove their generated modules ship. Final root verification
(Zelavis 3403 passes, 30 skips; Ecommerce 45 passes), `ci:ui`, docs and whitespace
checks passed. Existing changes were preserved; nothing was staged or committed.
Live Stripe test-mode qualification remains Part 14. No blocker remains for
Part 12. Part 13 is next.


### Part 13 (2026-11-18)

Done. Services declare concrete Platform permissions in their manifests; every
install path approves the actual acquired manifest within the installer's authority.
Auth owns one transactional service account per package, with sealed credentials,
revocation on disable/failure and native in-process fetch that hides credentials
from endpoint code. Added reverse dependency refusal, SDK/CLI approval and reload-safe
Marketplace consent. Regression tests cover concurrency, ownership corruption,
failed writes/activation, catalogue installs and retained-tab Project scope. Final
workspace verification (Zelavis 3,427 passes, 30 skips; Ecommerce 45 passes), full
`ci:ui`, docs and whitespace checks passed. Existing changes were preserved; no
branch/worktree or commit was created. No blocker remains for Part 13. Part 14 is
next; its live Stripe test qualification still needs the inputs named there.

### Part 14 (2026-11-18)

Partly done. The optional Hosting Provider package, service-principal
approval, plans and Auth roles, Ecommerce fulfillment, quota reservations,
grace and suspension, customer and operator pages, and docs are in the
`dev` checkout. Auth limits one plan role to 20 Projects. Local coverage
includes signed fake-provider billing, two Projects from eight concurrent
requests, recovery after grant and stop failures, and the built dashboard at
desktop and mobile sizes. Workspace verification, `ci:ui`, docs and whitespace
checks passed after the last code edit. The qualification runner is ready for
a Stripe test-mode secret key and CLI login in the same sandbox. Its live
result is required before marking Part 14 and the overview self-audit done.

### Part 14, Session 3 (2026-11-18)

Done. With the user-supplied Stripe test-mode secret key and CLI session (`acct_1DstxnIOdKYPsoH4`), updated `distribution/scripts/qualify-hosting.mjs` to handle Stripe Checkout's `elements-inner` iframe and short macOS `/tmp` socket paths, and ran `pnpm run release:qualify:hosting` (`PASS subscribe`, `PASS project`, `PASS limit`, `PASS suspend`, exit 0).

### Self-audit across all parts (2026-11-18)

Done. Re-checked all 13 Done means items across parts 1–14 (including Zelavis Auth row A and the three live qualifications: `release:qualify:domains`, `release:qualify:registrar`, and `release:qualify:hosting`), confirmed no forbidden patterns, debug leftovers, temporary files, or edits to `.claude/`, `website/public/allowlist.json`, `repos/effect/`, or `pnotes/TODO.md`, and verified `TMPDIR=/private/tmp/zelavis-verify pnpm run verify` (Zelavis 3,427 passes / 30 skips, Ecommerce 45 passes, Hosting 8 passes, zero failures), `TMPDIR=/private/tmp/zelavis-verify pnpm run ci:ui`, `pnpm run docs:check`, and `git diff --check` all pass after the last code edit.
