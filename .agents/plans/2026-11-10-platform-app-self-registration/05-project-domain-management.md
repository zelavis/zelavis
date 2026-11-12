# Customer-managed Project domains

Job: Let a user add and verify a domain for a Project through the hosting panel.
Date: 2026-11-10
Status: complete
Verified-at: f30953612f
Part: 5 of 5. Read 00-overview.md first.
To start:    Execute the plan in .agents/plans/2026-11-10-platform-app-self-registration/05-project-domain-management.md. Start with its section 8.
To continue: Continue the plan in .agents/plans/2026-11-10-platform-app-self-registration/05-project-domain-management.md. Start with its section 8.

## Progress

- [x] 1. Prove the existing domain, Edge and certificate baseline.
- [x] 2. Implement Project-scoped domain ownership and DNS proof.
- [x] 3. Publish verified domains through Edge and clean them up safely.
- [x] 4. Expose the domain workflow through HTTP, SDK and CLI.
- [x] 5. Build and verify the Project Domains screen.
- [x] 6. Document domain setup and qualify both customer and operator flows.
- [x] 7. Self-audit.

## 0. Summary and finish line

Use Zelavis Edge's existing hostname, certificate and route machinery to connect customer-owned hostnames to exact Projects. A Platform customer receives a scoped domain-management grant and can add, verify, open and remove a domain from that Project. Native App signup and login then work on the verified App origin from Part 4.

- **In scope** — apex/subdomain binding, DNS TXT proof, exact scope and conflict handling, native and managed Project site targets, external TLS and managed HTTPS where the existing Edge/ACME path can be qualified, safe retry and cleanup, SDK/HTTP/CLI/dashboard parity.
- **Out of scope** — domain purchases or transfers, DNS-provider credentials or automatic DNS edits, wildcards, DNS zone hosting, entitlement/billing changes, a second Edge adapter or certificate engine.
- **Done means** — a customer granted Project A's domain permissions can manage its verified hostname, cannot manage another Project or the Platform's hostname, and the verified host serves A's public site. The App's public Auth works there. Domain removal and Project deletion clear publication and release ownership safely. Tests demonstrate persistence, failure/retry, ownership proof and actual ingress.
- **Supplement** — checked supplement with focused-test cwd correction. Part 2 supplies exact customer grants and Part 3 provides the editor for them. Part 4 supplies native App public Auth and its strict ingress classifier.
- **Baseline** — existing `domain-binding`, `domain-verifier`, `edge-routes`, `production-edge` and `edge-certificates` suites passed against existing build with loopback allowed. Rebuild and rerun before edits. No live DNS or external CA was contacted for baseline qualification.
- **Sources read** — `AGENTS.md:807`, `:828`, `:1701`, `:1887`, `:2202`, Edge architecture docs, `pnotes/TODO.md:434`, core platform and dashboard skills and source below.

## 1. Context packet

**Glossary.** A hostname claim is an Edge-owned identity of an exact normalized FQDN, bound to one Project. DNS proof is a TXT challenge showing current control of that hostname. Publication is an immutable compiled Edge view. The active adapter applies it using existing host authority. A Project's current target comes from existing ingress and placement, independent of hostname ownership.

> “Domains, canonical HTTP/TCP/UDP route intent, endpoint generations, certificate identity/material, rollout state, and audit history are Platform authority persisted through the System Store.” `AGENTS.md:807–846`.
>
> “Child-app domains remain separate Edge resources.” `AGENTS.md:807–846`.

- `packages/zelavis/src/domain-binding.ts:50` defines verified binding records, `:149` creates random tokens and `:207` adds a binding. The in-memory and generic KV stores are not the durable concurrent customer-hostname authority. The KV `put` at `:403` checks then writes. `packages/zelavis/src/domain-verifier.ts:150` checks TXT and then upserts; reuse the TXT evidence part with a conditional commit for customer use.
- `packages/zelavis/src/edge/routes.ts:51` already distinguishes Platform and Project hostnames. `:156` defines the route store, `:596` currently upserts hostname ownership and `:792` compiles a publication. `packages/zelavis/src/system-store.ts:43` provides atomic create, and `:50` provides conditional updates with value comparison. Use one global owner per host in `edge.hostnames`.
- `packages/zelavis/src/edge/production.ts:17` uses a fixed local management target for the wildcard HTTP fallback, and `:38` applies a compiled publication through the active adapter flow. `packages/zelavis/src/adapters/node.ts:558` composes route storage and certificate controller, then the Traefik manager when Agent host operations are available. `packages/zelavis/src/edge/onboarding.ts:96` configures the Platform hostname, not Project-owned routes. `packages/zelavis/src/edge/certificates.ts:89` defines certificate operations.
- `packages/zelavis/src/platform/public-domain-forwarder.ts:66` consults verified bindings on each host request and `:117` routes via the Project's current public target. `packages/zelavis/src/index.ts:7404` and `:7448` attach Project deletion participants for bindings and Edge routes. `packages/zelavis/src/project.ts:1491` explains the Project lifecycle permit and `:2811` serializes deletion.
- `packages/zelavis/src/index.ts:4889`, `:4937`, `:5016` expose system Edge inventory, route mutation and publication using `server.edge.view` or `server.edge.manage`. Customer domain operations require exact Project authority and build only the bounded domain intent defined here.
- `packages/zelavis/services/zelavis-ui/app/project-pages.ts:23` has a placeholder managed Domains screen. `app/navigation-menu.ts:137` links it for managed apps. Add a real Domains screen for native and managed Projects. `app/host-pages.ts:97` is a separate Server Domains placeholder.

**Pattern to mirror.** Reuse normalized hostnames and DNS-TXT record fragment handling. Keep the platform-owned Edge fallback target from `edge/production.ts:17` so a Project domain goes through the existing public dispatcher with its original Host. Use existing certificate references and `switchAdapter` acknowledgements. A trusted system operation projects from verified ownership into routing, as Edge onboarding already does for the Platform.

**Traps.** A DNS lookup or A record alone does not prove ownership. A read followed by upsert loses a race with removal or reassignment. A route publication on disk does not mean the adapter serves it. Delegating `server.edge.manage` hands a customer server-wide routing. Copying a private runtime URL into a domain record breaks on placement change and bypasses ingress. Exposing a bound App hostname to Platform login would mix identity origins.

## 2. Design

### Authority and records

Platform Edge owns all Project domains. `project.domains.view` or `project.domains.manage` on the exact Project permits reading its inventory. Only `project.domains.manage` on that Project permits adding, verifying, activating or removing a hostname. Use Part 2 to grant these permissions. Domain administration never gains host-operation credentials, global Edge permissions or App data access. Normal dashboard navigation additionally uses the existing `project.view` permission, with its documented backend visibility. Scoped SDK/CLI domain calls can use the domain grant by itself. App users authenticated only to child Identity cannot operate the Platform's domain API.

Store up to 20 intents per Project in one CAS record in System Store namespace `edge.project-domains.v1`, key exact Project ID. An intent contains `id`, canonical `hostname`, `tlsMode`, state/revision, challenge token and expiry, and bounded operation results. Pending challenges reserve only a slot in their Project. A pending challenge never reserves the global hostname, so an unverified requester cannot squat a hostname for another Project. A TXT proof permits an atomic claim in the existing `edge.hostnames` namespace. `ZelavisEdgeHostname` gains optional `projectDomain: { domainId, verifiedAt, routing: "blocked" | "active" }` for this workflow. This row is the sole host ownership authority and is shared with Platform hostname ownership. The intent holds progress and pending proof, and does not route traffic by itself. Reuse the configured embedding binding source for independent existing callers, while default Node Platform lookup uses the canonical Project hostname projection.

Normalize hostnames once to lowercase ASCII FQDNs, removing one trailing dot. Permit 2–253 ASCII characters total, 1–63 per label and validated punycode ASCII labels. Reject wildcard, IP literal, localhost, reserved local suffixes, ports, scheme, path and empty labels. Apex and `www` are independently verified. Add issues a 24-hour TXT token using `generateVerificationToken`. Token location is `_zelavis-challenge.<hostname>`. Use existing `DnsTxtResolver` and extract `checkDomainBindingDnsProof` **NEW** from the existing DNS verifier before the store write. Deadline 5 seconds, one lookup, at most four in-flight requests, 30-second per-intent retry limit for check attempts, bounded normalization and 20 current intents per Project. Use a Node DNS resolver with bounded timeout and scoped cancellation; the domain controller consumes only its runtime-neutral interface. Check proof and record revision again after lookup. A different Project or Platform-owned hostname returns `409 hostname_unavailable` without identifying its owner. A DNS or timeout failure leaves the pending challenge retryable. Add with the same normalized hostname and same TLS mode returns the existing owned intent; an expired challenge is replaced conditionally with a new token and revision.

### Verify, activate and remove

1. Start a proof check from the exact Project intent and snapshot its revision. When DNS completes, take the existing Project lifecycle permit for the short commit, ensure the Project exists without deletion intent, and compare the current intent/revision again. Persist the verified proof checkpoint on the intent before reserving the canonical hostname with `setIfAbsent`. Accept a retry only when canonical `{ projectId, domainId }` matches the same intent. Treat a different owner as conflict. Release the lifecycle permit before external issuance or publication. The canonical row starts `blocked`. Recovery can finish a missing claim from a proof less than 60 seconds old, or perform a fresh lookup. Once the exact claim exists, later challenge expiry cannot remove it. Cancelled or stale verification can never restore a deleted claim.
2. Project a deterministic Edge route `project-domain:<domainId>` with `scope: "project"`, exact `projectId`, normalized hostname and root prefix. Derive its target from the host-owned stable `platform:default` management listener, never the body, a user's DNS answer, or a child private address. The existing public forwarder uses current placement and frontend choice. For `external` TLS, the site's externally terminated HTTPS is provided by the operator. Where there is no managed adapter, require a configured external ingress and document the DNS/forwarding target separately. Do not imply that external certificate bytes were inspected. For `managed` mode, order only after durable TXT proof and the existing Edge preflight through `ZelavisCertificateController`. Stage opaque `certificateRef` and route, compile, and apply through the current active adapter. Use a known Edge-owned fixed local probe and publication acknowledgement. A staged hostname can still answer the blocked state before activation. Keep the existing host-matched ACME challenge path reachable while application routing is blocked. Report pending/retryable state until actual publication acknowledgement. Deduplicate order calls by domain ID, honor the existing ACME bounds and leases, and use a fixed issuance deadline. A failed renewal or activation leaves prior active traffic and all account state intact.
3. Persist the target publication revision in the intent before applying. When the active adapter proves that publication, recheck Project and intent, make the exact hostname `active`, and return its public URL. `GET` is read-only and reports durable pending state. `POST verify` resumes proof, staging or application when previous work was interrupted. Do not issue a new certificate if the existing controller confirms a valid one for that hostname. Serialize publication-changing work through the existing Edge operation machinery. On a concurrent publication, refresh desired routes and prove the new revision before marking ready. Bounded local verification and staged failure tests prove behavior. Managed TLS status stays unavailable on hosts without a qualified existing manager/controller path.
4. Removal first makes the hostname `blocked` with the same owner and marks intent `removing`, so customer requests cannot fall through to Platform auth while old route config drains. Delete only the deterministic owned route, apply a publication that excludes it, and release the exact canonical claim once no active publication uses it. Refuse to release another claim even if the hostname was reused. Delete the intent last. Repeated remove resumes the checkpoint. Integrate with the existing `edge-routes` Project deletion participant so it iterates at most 20 intents and makes cleanup retryable before acknowledging Project deletion. Do not call the public Project lifecycle wrapper from inside that participant. Expired challenges with no claims are purged on the next mutation. Keep existing cert ownership and renewal machinery, retire unused certificate references only after they are no longer published, and retain shared references. Cancelled verification, missing adapters and failure to publish must leave a recoverable phase rather than an untracked route.

For canonical claims, strengthen hostname-store mutations so a normal `putHostname` cannot silently overwrite another scope, inject a project proof marker or unconditionally delete a managed claim. Use exact expected-value comparison during CAS. Guard against stale deletes by maintaining the same domain ID until its publication is withdrawn and serializing release with other store claim mutations. Reuse existing Platform writer fencing. Keep Project lifecycle permits around short ownership mutations and never hold them over DNS or ACME. Hostname lookup of a blocked claim returns a site unavailable response without dispatching into the Platform. `active` claims forward to the exact Project, with Part 4 public-auth allowlist. Keep generic admin/domain lookup and operator behavior unchanged for unrelated hostnames.

### Decisions and needs

Choose a customer-connect-existing-domain flow using DNS TXT, not registrar integration. Use the Edge certificate controller for managed mode and the existing external terminator model for external mode. No live DNS control, public server or paid account is needed to implement and prove the local fixture path. Production managed TLS claims require the existing deployment qualification. Record the actual limits in docs and UI.

## 3. Contracts

**NEW** `packages/zelavis/src/edge/project-domains.ts` defines the transport and persisted schemas.

```ts
export type ProjectDomainTlsMode = "external" | "managed";
export type ProjectDomainState = "pending_dns" | "verified" | "publishing" | "active" | "removing";
export interface ProjectDomain {
  readonly id: string;
  readonly projectId: string;
  readonly hostname: string;
  readonly tlsMode: ProjectDomainTlsMode;
  readonly state: ProjectDomainState;
  readonly revision: number;
  readonly verifiedAt?: string;
  readonly publicUrl?: string;
  readonly challenge?: { readonly name: string; readonly value: string; readonly expiresAt: string };
  readonly issue?: "dns_pending" | "dns_unavailable" | "edge_unavailable" | "certificate_pending" | "publication_pending";
}
export interface AddProjectDomainInput {
  readonly hostname: string;
  readonly tlsMode: ProjectDomainTlsMode;
}
export interface VerifyProjectDomainInput { readonly expectedRevision: number }
export interface ProjectDomainList { readonly domains: readonly ProjectDomain[] }
export interface RemoveProjectDomainResult { readonly removed: boolean; readonly pending: boolean }
interface StoredProjectDomain {
  readonly id: string;
  readonly hostname: string;
  readonly tlsMode: ProjectDomainTlsMode;
  readonly state: ProjectDomainState;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly challengeToken?: string;
  readonly challengeExpiresAt?: string;
  readonly lastCheckedAt?: string;
  readonly verifiedAt?: string;
  readonly publicationRevision?: number;
  readonly issue?: ProjectDomain["issue"];
}
interface StoredProjectDomains {
  readonly schemaVersion: 1;
  readonly entries: readonly StoredProjectDomain[];
}
```

Use strict request and persisted schemas, normalized exact host, ISO timestamps, UUID `id`, bounded tokens, max 20 records, and nonnegative safe-integer revisions. Public URL is derived only after activation and never names a private listener. Show `challenge` only to the authorized Project caller while pending. Persist proof and activation timestamps, and log actor, Project, hostname, result and revision with the existing Platform log/audit conventions. Avoid logging challenge values or certificate material.

| HTTP relative to configured API base | SDK method | CLI with `--json` |
| --- | --- | --- |
| `GET /runtime/projects/:projectId/domains` → `200 ProjectDomainList` | `projects.domains(projectId: string): Promise<ProjectDomainList>` | `zelavis projects domains PROJECT --json` |
| `POST /runtime/projects/:projectId/domains` with `AddProjectDomainInput` → `201 ProjectDomain`, `200` on idempotent retry | `projects.addDomain(projectId: string, input: AddProjectDomainInput): Promise<ProjectDomain>` | `zelavis projects add-domain PROJECT HOSTNAME --tls external\|managed --json` |
| `POST /runtime/projects/:projectId/domains/:hostname/verify` with `VerifyProjectDomainInput` → `200 ProjectDomain`, `202` when verified but activation is still pending | `projects.verifyDomain(projectId: string, hostname: string, input: VerifyProjectDomainInput): Promise<ProjectDomain>` | `zelavis projects verify-domain PROJECT HOSTNAME --revision NUMBER --json` |
| `DELETE /runtime/projects/:projectId/domains/:hostname?revision=N` → `200 RemoveProjectDomainResult`, `202` while withdrawal is pending | `projects.removeDomain(projectId: string, hostname: string, expectedRevision: number): Promise<RemoveProjectDomainResult>` | `zelavis projects remove-domain PROJECT HOSTNAME --revision NUMBER --json` |

Failures use `{ error: string, code: string }`. `400 invalid_hostname` or `invalid_domain_request`, `401` anonymous, `403` scoped permission denial, `404 domain_not_found` for absent or inaccessible records, `409 hostname_unavailable` or `domain_revision_conflict` or `project_deleting`, `422 dns_not_verified` for missing TXT proof, `429 domain_limit` or `domain_verification_busy` with retry information when applicable, `503 domain_ingress_unavailable` for an unsupported host or infrastructure. Use typed tagged errors and shared response mapping. The SDK and CLI present the same outcomes. The UI is `/projects/:projectId/domains` relative to dashboard mount.

## 4. Execution steps

### 1. Prove the existing domain, Edge and certificate baseline

**Files** `packages/zelavis/test/{domain-binding,domain-verifier,edge-routes,production-edge,edge-certificates}.test.mjs`, and the existing public domain tests.

**Change** Rebuild once from the verified checkout, run baseline suites with local loopback enabled and check the browser baseline from Part 4. Identify any unrelated dirty edits and preserve them.

**Check** From root, `pnpm --filter zelavis run build` then `pnpm --filter zelavis exec node --test test/{domain-binding,domain-verifier,edge-routes,production-edge,edge-certificates,platform-public-domain-forwarding}.test.mjs`. Exit zero.

### 2. Implement Project-scoped domain ownership and DNS proof

**Files** **NEW** `packages/zelavis/src/edge/project-domains.ts`, `packages/zelavis/src/domain-binding.ts:149`, `domain-verifier.ts:58`, `:150`, `edge/routes.ts:596`, `project.ts:1491`; **NEW** `packages/zelavis/test/project-domains.test.mjs`.

**Change** Add the bounded Project intent CAS, hostname schemas and domain controller. Reuse the DNS verifier's TXT handling with evidence returned before writes. Add `claimProjectHostname`, `activateProjectHostname`, `blockProjectHostname` and `releaseProjectHostname` **NEW** on `ZelavisEdgeRouteStore`, all requiring an exact owner ID and conditional update. Keep ordinary Platform hostname writes on the same global key. Expose **NEW** `ZelavisProjectManager.withLiveProject` for the short trusted mutation under the existing permit, passing the exact current record and no user-defined callback over HTTP. Prove a pending challenge does not occupy the global name, racing verified writes choose one winner, and stale proof cannot resurrect a deletion. Run DNS only through a bounded resolver.

**Imports** Domain controller uses `import { Effect, Schema, Semaphore } from "effect";`, `import type { ZelavisSystemStore } from "../system-store.js";`, `import { generateVerificationToken } from "../domain-binding.js";`, `import { checkDomainBindingDnsProof, type DnsTxtResolver } from "../domain-verifier.js";`, `import type { ZelavisEdgeRouteStore } from "./routes.js";`, `import type { ZelavisProjectManager } from "../project.js";`, and existing Effect boundary helpers from `../core/runtime/effect-boundary.js`. Existing Edge store imports Effect and System Store types. Tests use `import assert from "node:assert/strict";`, `import test from "node:test";`, `import { createMemorySystemStore } from "../dist/index.js";`, `import { createZelavisEdgeRouteStore } from "../dist/edge/routes.js";` and the new controller from `../dist/edge/project-domains.js`.

**Depends on** 1.

**Check** Rebuild and run `pnpm --filter zelavis exec node --test test/{project-domains,domain-binding,domain-verifier,edge-routes}.test.mjs` from root. Exit zero.

### 3. Publish verified domains through Edge and clean them up safely

**Files** `packages/zelavis/src/edge/project-domains.ts` from step 2, `edge/{routes,production,index,certificates}.ts`, `adapters/node.ts:555`, `platform/public-domain-forwarder.ts:117`, `:283`, `src/index.ts:7404`, `:7448`, `:7790`; `packages/zelavis/test/{project-domains,production-edge,platform-public-domain-forwarding,edge-certificates}.test.mjs`.

**Change** Compose the controller once in Platform runtime. Supply System Store, existing Edge route store, DNS port, active adapter, certificate controller and fixed host-owned listener source. Project its verified routing into the public hostname lookup. Implement activation and cleanup checkpoints from section 2. Update the deletion participant to withdraw only owned routes and never release while a publication still points at the domain. The public forwarder handles a blocked or unavailable verified site without falling into the Platform shell. Use fake DNS and existing in-process ACME and adapter fixtures to inject errors and prove retries. No real registrar, DNS or CA calls in tests.

**Imports** Domain controller adds `import { toPublicationSummary } from "./routes.js";`, `import type { ZelavisEdgeManager } from "./index.js";` and `import type { ZelavisCertificateController } from "./certificates.js";`. Platform composition adds `import { createProjectDomainController } from "./edge/project-domains.js";`. Node adapter adds `import { createNodeDnsTxtResolver } from "../domain-verifier.js";`. Forwarder adds the new canonical hostname lookup type and reuses its existing route and Host helpers. Tests reuse fixtures from `production-edge.test.mjs:1` and the ACME test file.

**Depends on** 2.

**Check** Rebuild and run `pnpm --filter zelavis exec node --test test/{project-domains,production-edge,platform-public-domain-forwarding,edge-certificates,edge-switching}.test.mjs` from root. Exit zero with local listeners allowed.

### 4. Expose the domain workflow through HTTP, SDK and CLI

**Files** **NEW** `packages/zelavis/src/platform/project-domain-routes.ts`; `packages/zelavis/src/index.ts:6031`, `:7632`; `sdk/fetch.ts:1548`, `:2984`; `cli/{projects,commands}.ts`; `test/{project-domains,capability-parity,customer-project-access}.test.mjs`.

**Change** Add the exact scoped routes, shared schemas and error mapping. Define read as view or manage, writes as manage. Resolve the Project from the route and verify lifecycle in the controller. Authenticate before parsing body. Add documented typed SDK methods and explicit CLI commands. Test the same domain workflow and denials through all transports. Verify direct control-plane `server.edge.manage` remains independent.

**Imports** Routes use `import { Effect } from "effect";`, `import type { ZelavisServerRoute } from "../core/index.js";`, the input codecs, response types and controller interface from `../edge/project-domains.js`, and existing `present`/`integration` boundary helpers. SDK adds `import type { AddProjectDomainInput, ProjectDomain, ProjectDomainList, RemoveProjectDomainResult, VerifyProjectDomainInput } from "../edge/project-domains.js";`. CLI reuses its existing flag and client helpers. Test parity uses `import { runProjectsCommand } from "../dist/cli/projects.js";` and `import { platform, outcome } from "./_runtime.mjs";`.

**Depends on** 3.

**Check** Rebuild then `pnpm --filter zelavis exec node --test test/{project-domains,customer-project-access,capability-parity}.test.mjs` from root. Exit zero.

### 5. Build and verify the Project Domains screen

**Files** **NEW** `packages/zelavis/services/zelavis-ui/app/project-domains-page.ts`; `app/{project-pages,navigation-menu,dashboard-routes,host-pages,account-access-editor}.ts`; `tests/navigation.test.mjs`; `scripts/test-{route-parity,embedded-server-views}.mjs`.

**Change** Replace the existing managed placeholder and add the same native Project route. Show verified host, pending TXT name/value with copy affordances, instructions to point A/AAAA or CNAME at the ingress address supplied by the operator, state and retry/remove buttons. `context.run` uses the authoritative response and refreshes state. The control is limited to exact Project management grants. Add domain permission choices to the Users grant editor. Server Domains uses the existing system Edge inventory for global read, with links into Project Domains. Keep purchase and transfer outside this workflow. Add route parity and a real browser flow through the isolated Platform with a test-owned DNS resolver injected into the existing adapter resource boundary and a fixed local external ingress target. Use the normal domain operations, actual host dispatch and no mocked success handler for this workflow. Confirm customer view and errors at desktop and mobile.

**Imports** Screen uses `import { Effect, Schema } from "effect";`, `import { request, label, object } from "./api.ts";`, `import { button, link, node } from "./dom.ts";`, `import { card, dataRow, page } from "./page-kit.ts";`, `import { canAccess } from "./navigation-menu.ts";`, `import type { ScreenContext } from "./screens.ts";`, and type imports from the exported Edge contract. `project-pages.ts` imports `projectDomainsScreen` from `./project-domains-page.ts`; other dashboard and Playwright files reuse existing imports.

**Depends on** 4.

**Check** Run `pnpm --filter @zelavis/ui typecheck`, `pnpm --filter @zelavis/ui test` and `pnpm run ci:ui` from root. All exit zero.

### 6. Document domain setup and qualify both customer and operator flows

**Files** `website/src/content/docs/{architecture/edge.md,architecture/access-control.md,api/platform-operations.md,packages/app.md}`, `packages/zelavis/services/zelavis-ui/docs/route-parity.md`, a **NEW** Changeset and the existing private Edge TODO heading.

**Change** Document exact owner grants, Add Domain, DNS A/AAAA or CNAME direction and separate TXT proof, verification, activation/TLS, opening the site, cleanup and all transport calls. Show the App's public signup link on a verified active hostname. Explain external TLS responsibility and verified managed TLS limits. Prove a real app/Project domain route locally with generated test names, including App signup and Platform authentication separation. Record what the local ACME fixture actually proved. Keep live deployment qualification separate.

**Depends on** 5.

**Check** Run `pnpm run docs:check`, `pnpm run ci:ui` and the focused domain ingress tests from root. All exit zero.

### 7. Self-audit

Review global hostname ownership, cross-scope denials, interruption at every persisted phase, publication acknowledgements and Project deletion. Rerun section 7 after the final edit.

## 5. Tests

- **Ownership and proof.** Arrange two Projects and a Platform hostname. Add the same candidate in both Projects with separate TXT values. Verify only a matching proof can claim it, a concurrent same-host claim produces one canonical owner, and attempts to use the Platform hostname refuse. Verify exact normalization and rejection of unsupported host shapes.
- **Scopes and parity.** Register a Platform customer, grant Project A view and domain manage. List/add/verify/remove via HTTP, SDK, CLI and UI. Assert Project B and server Edge routes refuse. A read-only domain grantee can read but cannot mutate. An App user can sign in on its site but cannot administer Platform domains.
- **Traffic and credentials.** Route through the installed or fixture Edge path with trusted Host and active publication. Assert apex and subdomain reach the selected Project and managed third-party site requests preserve existing behavior. App login/signup works at the verified native App domain, while Platform setup/login and child management routes remain unavailable there. Verify stale/unavailable Project behavior.
- **Failure and recovery.** Fail DNS, certificate issuance, application and withdrawal. Restart from each persisted phase and retry the same intent. Prove no duplicate DNS claims or certificates, no unverified routing, no premature `active` state, and no early hostname release. Race deletion with a paused DNS response and verify no resurrection. Verify replacement ownership is safe after withdrawal.
- **Bounds and UX.** Verify token expiry and regeneration, max 20, cooldown and in-flight limits, safe handling of malformed stored data, and no token material in logs. In Playwright, test mobile and desktop pending state, successful verify and remove plus scoped controls. Existing production Edge fallback and Platform hostname onboarding still pass.

## 6. Docs and project notes

See step 6. Update the affected open entries in `pnotes/TODO.md:434` as evidence allows. Keep unsupported registrar, wildcard, distributed certification and real deployment qualification explicit. Preserve deployment and runtime ownership guidance.

## 7. Verification

From root, build once and run `pnpm --filter zelavis exec node --test test/{project-domains,domain-binding,domain-verifier,edge-routes,production-edge,edge-certificates,edge-switching,platform-public-domain-forwarding,customer-project-access,capability-parity}.test.mjs`, `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check`, and `git diff --check`. All exit zero. Run loopback tests with the required permissions. Use only local test-owned servers and certificate fixtures for this part.

## 8. Instructions to the implementer

Read Status, Progress, overview and earlier reports. Recheck `Verified-at`, dirty paths, `AGENTS.md`, the core platform and dashboard skills and pinned Effect guidance. Mark `[~]` before each step and `[x]` after its proof passes. When continuing, rerun the last completed check. A recently edited `in progress` plan may have an active session.

Choose routine details consistent with existing authorities and record deviations. Resolve required failures in their current step. Mark `[!]` only for a concrete unavailable prerequisite and continue independent work. Keep Project grants exact, ownership conditional and Edge publication evidence distinct from intent. Avoid generic proxy exposure, raw host input to routing targets, generated edits, Promise orchestration, silent catches and baseline changes that weaken gates. Rerun all checks and update the overview and a dated execution report. Publishing, commits, production DNS and deployment are separate work.

## Execution report

### 2026-11-11

- HEAD matched `f30953612f`. The initial build, 114 focused baseline tests and Part 4 browser baseline passed before feature qualification. The worktree already included Parts 1–4 and unrelated changes. Kept those edits and the existing plan deletions.
- The Project intent record retains a monotonic revision even when empty, so a stale request cannot mutate a domain added after removal or Project recreation. TXT proof is checkpointed before an atomic global hostname claim. The DNS resolver uses a bounded, cancellable lookup. Conditional deletion compares the exact stored value in the memory, Node SQLite and Bun SQLite System Stores.
- External TLS uses a configured loopback listener and a live Host-preserving probe. Its exact route appears in Edge inventory. The operator's external proxy publishes the public HTTPS mapping and removes it when disconnecting the hostname. A hostname must leave enough space for the TXT challenge prefix within the DNS name length limit.
- Managed HTTPS stages the owned route and certificate reference using the active Edge adapter. Activation requires both the publication acknowledgement and a local HTTPS probe. Withdrawal keeps the claim blocked until a replacement publication is acknowledged and a local probe confirms the old route has stopped answering. The controller reuses a valid certificate and retires only its own unused certificate. The local ACME fixture exercises the order, hostname-matched challenge, CSR, encrypted key storage and distributor staging. The adapter fixture exercises failure and recovery. Deployed proxy, public CA and renewal behavior remain open for qualification.
- HTTP, SDK, CLI and the native dashboard share the same operations. The embedded browser fixture uses a customer account, test-owned DNS, a real loopback HTTPS terminator and a running native App. It exercises the Project Domains workflow at desktop and mobile widths, App signup and its Secure, HttpOnly session, denial of Platform routes on the App origin, server inventory and withdrawal.
- Updated the public docs, the private Edge TODO and the changeset. Local Fuzor builds used checkout `ae7ef393a6ea3e4943dd2ee806dee3f1913126ff` at 0.5.2 with the existing 116 uncommitted files and digest `bb357a145ec78a498908d46b497c6806b30c49d5de5e1c904cb27f363ad3dc29`.

#### Verification

- Package build and all 134 section 7 focused Node tests passed.
- Dashboard typecheck and 93 dashboard unit tests passed.
- `pnpm run ci:ui` passed. The embedded browser test granted access through the Users editor, and the complete suite also covered desktop/mobile route parity and the nested Platform mount. Inspected the Project Domains screenshots at both widths.
- `pnpm run verify` exited zero. The core suite reported 2,850 passes, 30 existing environment-gated skips and zero failures out of 2,880 tests.
- `pnpm run docs:check`, `git diff --check` and the private notes diff check exited zero. Checked the untracked plan and source files separately.

Part 5 is complete. The overview-wide self-audit remains open.

### 2026-11-12 deployment qualification

- **Deployed proxy passed in Docker.** Ran the release-pinned Traefik 3.7.13
  binary and the repository's Edge stage, validate, activate and drain
  artifacts in an isolated Linux guest. A separate Pebble 2.10.3 instance
  validated HTTP-01 on port 80 and issued a short-lived certificate. The test
  supplied Project TXT proof through the existing DNS resolver injection.
  The Platform's actual HTTP and HTTPS probes, the file provider and client
  certificate validation were exercised. A native App accepted signup over
  trusted HTTPS, issued its own HttpOnly cookie and denied its administrative
  Auth route. Withdrawal removed the HTTPS route and retired its certificate.
  The harness supervised Traefik directly inside the guest.
- **Renewal publication failed.** An unreachable test CA left the original
  certificate and site available. A subsequent successful
  `POST /runtime/edge/certificates/renew` completed a fresh HTTP-01 challenge
  and stored certificate version 2. A new TLS connection still saw version 1
  through Traefik. Explicit `POST /runtime/edge/publish` and `POST
  /runtime/edge/switch` to Traefik with the compiled publication delivered the
  renewed certificate in the same guest. Renewal currently orders and stores
  the replacement without applying an Edge publication.
- **Public CA validation remains open.** The Let's Encrypt staging directory
  was reachable. End-to-end issuance still needs a disposable public hostname
  with editable DNS and inbound HTTP on port 80 to the test deployment. Use
  the staging trust chain only inside that qualification environment.

The [overview](00-overview.md) records the completed self-audit. The deployed
proxy results here are separate from the remaining public CA and renewal work.

### 2026-11-12 renewal fix

Named and bulk renewal now reapply the current active Edge publication when it
uses a renewed certificate. Renewal leaves unpublished route edits alone and
returns a conflict if a newer compiled publication is pending. Named renewal
retains the certificate's existing SANs. The disposable Traefik and Pebble
deployment served certificate versions 2 and 3 on fresh TLS connections after
named and bulk renewal, respectively. The unavailable-CA case preserved the
original certificate and the site. The same run verified native App signup and
withdrawal. The focused Edge suites, `pnpm run verify`, `pnpm run docs:check`
and `git diff --check` passed. The public CA run followed on the VPS.

### 2026-11-12 public CA staging qualification

- Ran the packed workspace candidate and a separate Traefik 3.7.13 process
  under an unprivileged temporary systemd unit on the VPS. A temporary IPv6
  address and destination-scoped redirects exposed the test listener on
  ports 80 and 443. Public DNS resolved the disposable `sslip.io` hostname.
  The Project TXT proof used the test resolver injection.
- Let’s Encrypt staging validated HTTP-01 and issued the initial certificate.
  Named renewal and the bulk expiry-window check each obtained a replacement
  that Traefik served automatically. Off-host clients verified the staging
  chain, hostname, and three distinct leaf fingerprints on fresh HTTPS
  connections. The staging roots were confined to the test processes.
- An unavailable CA left the active certificate and App available. The
  verified App accepted signup with a scoped HttpOnly cookie and denied its
  administrative Auth route. Withdrawal removed the HTTPS route and retired
  the owned certificate.
- Removed the temporary unit, IPv6 address, redirects, listeners, and
  deployment files. The existing Zelavis and Traefik processes retained
  their PIDs, and the live dashboard continued returning HTTP 200.
