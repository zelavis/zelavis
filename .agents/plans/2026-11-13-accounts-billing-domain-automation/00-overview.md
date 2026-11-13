# Account lifecycle, hosting billing and domain automation

Job: Plan the follow-ups to the finished self-registration plan: qualify the Project domain DNS TXT ownership check against a real TXT record in public DNS (the VPS run used test resolver injection), and build what that plan left out of scope: billing and paid hosting entitlements, email verification with email delivery, invitations, password recovery, MFA, custom role definitions, and domain purchase and DNS automation (registrar purchases, transfers, DNS automation, wildcard certificates).
Date: 2026-11-13
Status: planned
Verified-at: b04fa02d95

To start:    Execute part 1 in .agents/plans/2026-11-13-accounts-billing-domain-automation/01-authoritative-dns-challenge-lookup.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/00-overview.md. Start with the first part in section 4 that is neither done nor partly done, at its section 8.

## Progress

- [ ] 1. Land authoritative DNS challenge lookup.
- [ ] 2. Land per-runtime email delivery.
- [ ] 3. Land email verification and password recovery.
- [ ] 4. Land account invitations.
- [ ] 5. Land TOTP multi-factor authentication.
- [ ] 6. Land custom role definitions.
- [ ] 7. Land DNS providers, automatic records and wildcard certificates.
- [ ] 8. Land public DNS and CA qualification.
- [ ] 9. Land registrar purchase, transfer and renewal.
- [ ] 10. Land hosting billing, entitlements and self-service Projects.
- [ ] 11. Self-audit across all parts.

## 0. Summary and finish line

The earlier plan (`2026-11-10-platform-app-self-registration`, finished and removed by this run; code in commit `7fe8fb53f4`) shipped default-closed signup, login, scoped account access, App public auth and customer Project domains. This plan completes the account lifecycle (email delivery, verification, recovery, invitations, MFA, custom roles), turns the hosting panel into something a provider can charge for (plans, subscriptions, entitlements, self-service Projects), and finishes domains (authoritative TXT checks, DNS provider automation, DNS-01 and wildcard certificates, registrar purchase and transfer, and a real public-DNS qualification run).

### In scope

- Project domain TXT proof read from the zone's authoritative nameservers, and a committed qualification script that proves it with a real public zone, a real TXT record and Let's Encrypt staging.
- Per-runtime email delivery (Platform and each native App), SMTP built in, durable outbox, operator settings and test send.
- Email ownership verification, password recovery delivery with single-use tokens, invitations, TOTP MFA with recovery codes, and custom role definitions, on both the Platform and native App runtimes.
- DNS provider plugins (Cloudflare first), automatic record management for operator-hosted subdomains, ACME DNS-01 and wildcard certificates.
- Operator registrar purchase, transfer-in and renewal through a registrar plugin (Namecheap first).
- Hosting billing: operator plans, provider-backed subscriptions (Stripe first), entitlements, self-service Project creation within quota, suspension on lapse.
- JS SDK, HTTP and CLI parity for every new operation, dashboard pages, public docs and tests for all of it.

### Out of scope

- Passkeys/WebAuthn and SMS factors (TOTP plus recovery codes is the MFA this plan ships). Reason: WebAuthn needs CBOR/COSE attestation verification, a separate design; SMS is weak and costs money per message.
- HTTP-API email provider plugins (Postmark, SES and Resend all accept SMTP submission, so SMTP covers them).
- Customer-owned DNS provider connections and customer domain purchase. Reason: both hand customer credentials or operator money to a customer flow and need per-TLD pricing and refund rules; this plan gives operators the primitives and keeps customers on the TXT-proof flow plus operator-hosted subdomains.
- Taxes, VAT invoices, refunds, coupons, metered usage billing, resellers. Stripe's own dashboard handles refunds; tax is a commercial decision.
- Periodic re-verification of already verified Project domains (ownership drift). Recorded as an open limit in part 1's docs.
- Planning and real-time collaboration roadmap rows of `AGENTS.md § Project Vision`.

### Done means

1. Project domain verification reads `_zelavis-challenge.<host>` from the zone's authoritative servers: a record added after a failed check verifies on the next check without waiting for any resolver's negative cache. `pnpm release:qualify:domains` passed once against a real public zone, recorded in part 8's report.
2. An operator can configure SMTP for the Platform and, separately, for one App; a test message arrives at a local SMTP fixture in tests; deliveries survive restart and retry with bounded backoff.
3. Password signups receive a verification email; when the runtime requires verified email, unverified accounts cannot sign in; password recovery emails a single-use link whose token is consumed exactly once under concurrency.
4. An authorized user invites an email address with preset access that the inviter could delegate; acceptance creates or extends exactly one account even while registration is closed, and a revoked or expired invitation is refused.
5. A user enrolls TOTP and gets ten recovery codes; password and OAuth sign-in then require a code; a used code or step cannot be replayed; the owner can require MFA for privileged accounts.
6. An operator defines custom roles (permission bundles, optionally parameterized by Project) and assigns them within their own authority; editing a role changes members' authority on their next request.
7. With a Cloudflare connection, an operator-hosted subdomain gets its TXT and address records and a wildcard certificate issued by DNS-01, all removed when the domain or Project goes.
8. The owner can check, register, transfer in and renew a domain through the Namecheap plugin, qualified against Namecheap's sandbox; nothing is purchased twice after a crash.
9. A customer subscribes to an operator plan through Stripe Checkout (test mode), creates Projects up to the plan's limit, and on lapse their billed Projects stop (never delete) until payment resumes.
10. `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check` and `git diff --check` pass after the last edit.

### Reading of the request

"Billing" means billing hosting customers of a Platform (the commercial workflow the earlier plan deferred to a future Hosting Provider service), not App-level ecommerce: `@zelavis/ecommerce` already serves Apps. "Domain purchase" is an operator capability. "MFA" is TOTP with recovery codes.

### Supplement and cleanup

- `.agents/references/plan-writer.md` was 17 commits behind (`f30953612f`). Updated and set to `b04fa02d95`: the compatibility rule now names the explicit Project upgrade for published layouts (`AGENTS.md § Code Change Expectations`), the dashboard reads caller authority from `runtime/access`, `test:browser` reruns the embedded suite with `--nested-auth`, browser steps wait for the page's own server-answered sign, and a new trap covers the Project host import footprint. Review and commit it.
- Conflict flagged, not changed: the supplement (citing `AGENTS.md § Repo Structure`) says to keep `pnotes/TODO.md` current; the owner retired that file in a later instruction (no additions; open items live in `.agents/plans`). Every part follows the owner: it removes finished entries it finds there and adds none.
- Removed the finished plan `.agents/plans/2026-11-10-platform-app-self-registration/` (overview and all five parts complete). It is in Git history if needed. No other plans existed.

### Sources read

`AGENTS.md` (§§ Platform And App Service Boundary, Cloud Capacity And Alchemy, Marketplace Allow-List, TigerStyle Adaptation, Effect Version, Database Architecture Rules, Endpoint-Backed Capability Rule, Core Access-Control Rule, UI Package Rules, Verification, Code Change Expectations), `.agents/references/plan-writer.md`, `.agents/references/tigerstyle-typescript.md`, `.agents/references/effect-v4-guidance.md`, the removed plan's overview and Part 5, and the source and tests cited in each part.

## 1. Context packet (shared)

**Glossary.**
- **Runtime**: one `zelavis()` composition. The Platform is `role: "platform"`; each native App Project runs its own with `role: "project"` (`AGENTS.md § Platform And App Service Boundary`).
- **Runtime System Store**: the `ZelavisSystemStore` a runtime owns. The Platform's is `<data>/system/zelavis.sqlite`; a Project's is `<project>/.zelavis/runtime/zelavis.sqlite` (`packages/zelavis/src/adapters/node.ts:293-304`). Interface at `packages/zelavis/src/system-store.ts:26`: `get`, `set`, `setIfAbsent`, `compareAndSet(ns, key, expectedUpdatedAt, value, expectedValue?)`, `compareAndDelete`, `delete`, `page(ns, { limit, after })`, `list`.
- **Native Identity**: `zelavis/app/identity`. Platform composition `packages/zelavis/src/index.ts:1619-1700` (System Store repositories); App composition `packages/zelavis/src/app/app-service.ts:118-160` (Project database repositories). Repository contracts `packages/zelavis/src/app/identity/contracts/repositories.ts:20-101`.
- **Master secret**: `loadPlatformMasterSecret(store)` (`packages/zelavis/src/platform/master-secret.ts:19`) creates one 32-byte hex secret per store, if absent. It works on any runtime System Store, so a Project runtime gets its own. Secrets at rest use `encryptSecret`/`decryptSecret` (`packages/zelavis/src/edge/acme-crypto.ts:79`, `:104`) with a key `${masterSecret}\u0000<purpose>`, as `packages/zelavis/src/assistant-provider.ts:133-135` does.
- **Project Gateway**: the Platform's authenticated proxy into one Project runtime. Exact child routes are declared one by one in `packages/zelavis/src/platform/project-gateway.ts:670-760` (registration settings, account access).
- **App public auth**: the exact allowlist of App routes served on a verified App hostname or preview, `packages/zelavis/src/platform/project-public-auth.ts:11-17`, with pages rendered by `packages/zelavis/services/zelavis-ui/src/identity-frontend.ts` and browser code `packages/zelavis/services/zelavis-ui/app/identity-site.ts`.

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

**Traps (shared).** Read-then-write for anything single-use (tokens, codes, slots) loses races: consume through a repository `mutate`. A link built from the request's `Host` header is a reset-link poisoning hole: links come from an operator-configured base URL. Secrets never appear in responses, logs, security events or URLs sent to the server (emailed links carry tokens in the URL fragment). A vendor API in core is a boundary violation: providers are plugins discovered by an owner-qualified capability. Promise orchestration in Platform code fails `pnpm check:effect-usage`.

## 2. Shared design decisions

| Decision | Reason |
| --- | --- |
| Each runtime owns its email settings, outbox, tokens, MFA factors and role catalogue. Nothing App-scoped lives in the Platform. | Same as the registration policy: the earlier plan rejected a Platform-held record keyed by Project for App-user policy (backup, transfer, cleanup). |
| SMTP is built in; no email provider plugin. | Recovery and verification are core account functions, like the built-in password provider (`packages/zelavis/src/app/identity/providers/password.ts:14-25`). Every mainstream provider accepts SMTP. |
| Emailed links come from the email settings' `linkBaseUrl`, and carry tokens in the fragment (`#token=`). | No Host-header poisoning; fragments are not sent to servers, proxies or `Referer`. |
| One single-use token repository (`accountTokens`) serves verification, recovery, invitation and MFA challenges. | One atomic consume primitive, implemented and atomicity-tested once per backend. |
| Vendor integrations are plugins under owner-qualified capabilities: `zelavis/edge:dns`, `zelavis/edge:registrar`, `zelavis/billing:payments`. First-party plugins live in `zelavis-services/*`. | `AGENTS.md § Core Access-Control Rule` and the capability model in `packages/zelavis/src/core/service/capability.ts:1-23`. |
| Billing is a Platform subsystem; entitlements become ordinary concrete grants. | No second permission system (`AGENTS.md § Core Access-Control Rule`). |
| Money-moving and purchase operations are durable state machines with idempotency keys and never retried blindly after an ambiguous submit. | A crash must not buy a domain twice or charge twice. |

### Decisions taken for the user

- First DNS provider: Cloudflare (most common, token-scoped API, also hosts zelavis.com's website). First registrar: Namecheap (long-standing free sandbox). First payment provider: Stripe (test mode, hosted Checkout and Customer Portal keep card data off the Platform).
- MFA is TOTP plus ten single-use recovery codes. The owner can require it for privileged accounts or all accounts.
- Lapsed subscriptions stop the customer's billed Projects after a seven-day grace period; nothing is ever deleted automatically.
- Verified-domain drift and customer-owned DNS connections stay out of scope (section 0).

### Needs from the user

These are things the implementer cannot supply. Each blocks only the named steps, which start as `[!]` in their parts. Everything else proceeds.

- A Cloudflare API token with `Zone.DNS:Edit` on one zone you control, the zone name, SSH (root) to a disposable environment on the existing VPS, and one free IPv6 address in the VPS's routed prefix with its interface name (as in the earlier run). Blocks part 8 steps 3-5.
- A Namecheap sandbox account's API user, API key and a whitelisted client IP. Blocks part 9 step 9.
- A Stripe test-mode secret key and the Stripe CLI logged in (`stripe login`) on the machine that runs the qualification. Blocks part 10 step 11.

## 3. Shared contracts and handover

| Part | New operations (HTTP, relative to the API base) | New records |
| --- | --- | --- |
| 1 | none (behavior change in `POST /runtime/projects/:projectId/domains/:hostname/verify`) | none |
| 2 | `GET/PUT /email/settings`, `POST /email/test`, `GET /email/deliveries`; Project: `/runtime/projects/:projectId/email/{settings,test,deliveries}` | `zelavis.email` settings, `zelavis.email.outbox` |
| 3 | `POST /auth/email/verify`, `POST /auth/email/verification`; registration settings gain `emailVerification`; recovery moves onto tokens | `accountTokens` repository |
| 4 | `GET/POST /auth/invitations`, `DELETE /auth/invitations/:id`, `POST /auth/invitations/accept`; Project Gateway copies | `invitations` repository |
| 5 | `/auth/mfa/{settings,totp,totp/confirm,verify,recovery-codes}`, `DELETE /auth/accounts/:accountId/mfa` | credentials `mfa.totp`, `mfa.recovery`; `CredentialRepository.mutate` |
| 6 | `GET/POST /auth/roles`, `PUT/DELETE /auth/roles/:roleId`; account access gains `roleAssignments` | `roles` catalogue record |
| 7 | `/runtime/edge/dns/connections*`, `/runtime/edge/dns/zones*`; Project domains gain `dns: "automatic"` | `edge.dns-connections`, `edge.dns-zones` |
| 8 | none (script `pnpm release:qualify:domains`) | none |
| 9 | `/runtime/registrar/{connection,availability,domains,orders}*` | `registrar.connection`, `registrar.orders` |
| 10 | `/runtime/billing/{plans,subscriptions,checkout,portal,projects,webhooks/:provider}*` | `billing.plans`, `billing.subscriptions`, `billing.provisions`, `billing.events` |

Each part writes its own contracts in full in its section 3.

## 4. Parts in execution order

| Part | File | Depends on | Status |
| --- | --- | --- | --- |
| 1 | `01-authoritative-dns-challenge-lookup.md` | none | planned |
| 2 | `02-email-delivery.md` | none | planned |
| 3 | `03-email-verification-and-password-recovery.md` | 2 | planned |
| 4 | `04-account-invitations.md` | 2, 3 (`accountTokens`) | planned |
| 5 | `05-totp-mfa.md` | 3 (`accountTokens`) | planned |
| 6 | `06-custom-roles.md` | none (lands after 5 to avoid conflicting edits in the same identity files) | planned |
| 7 | `07-dns-providers-and-wildcard-certificates.md` | 1 | planned |
| 8 | `08-public-dns-and-ca-qualification.md` | 1, 7; Needs from the user | planned |
| 9 | `09-registrar-purchase-and-transfer.md` | 7 (DNS zone link) | planned |
| 10 | `10-hosting-billing-and-entitlements.md` | 2 (receipts), 6 (plan roles) | planned |

Parts edit shared files (`identity-service.ts`, `sdk/fetch.ts`, CLI tables, `project-gateway.ts`, `dashboard-routes.ts`), so they run one at a time, in this order, in the main checkout on `dev`.

## 5. End-to-end proof

After part 10: configure SMTP on the Platform and one App against the local SMTP fixture; sign up on the Platform, verify email, enable TOTP, sign out, sign in with password + code; recover the password and see the old sessions end; invite a second address with one Project grant and accept it while registration is closed; define a custom role and assign it; subscribe through Stripe test mode, create a Project within quota, see the second over quota refused; cancel and see the Project stopped after grace. On the App origin repeat signup, verification and recovery. Connect a fake Cloudflare zone and add an automatic subdomain with a wildcard certificate. Each part's tests cover its slice; parts 8, 9 and 10 record their live qualification runs.

## 6. Docs and project notes

Each part updates the docs it names. Do not add to `pnotes/TODO.md` (owner instruction); remove any entry a part completes. Open follow-ups stay in this plan as `A<n>` lines.

## 7. Verification

From the repository root after each part and again at the end: `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check`, `git diff --check`. If host-operation tests fail on the sandbox's `/tmp` symlink, rerun with `TMPDIR=/private/tmp/zelavis-verify` (create it first). Inspect new untracked files separately; `git diff` does not show them.

## 8. Instructions to the implementer

Read this overview, then the first part in section 4 that is neither `done` nor `partly done`, and start with that part's section 8. Execute each part in a fresh session, in the main checkout on `dev`: no worktrees and no new branches (owner instruction). A part starts only after the previous part's checks pass. As each part lands, update its row in section 4, this file's `## Progress` line for it, and `Status`. A part left with only `[!]` lines counts as `partly done` and does not hold back the next part unless the next part's Depends on names the blocked work. After the last part, run line 11 (Self-audit across all parts): reread the combined diff against section 0's Done means, rerun the section 7 commands, and record the result below. Committing, pushing, publishing and deploying are separate work and stay off.

## Execution report
