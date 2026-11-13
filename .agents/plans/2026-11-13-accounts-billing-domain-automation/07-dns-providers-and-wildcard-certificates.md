# DNS providers, automatic records and wildcard certificates

Job: Let an operator connect a DNS provider (Cloudflare first) so Zelavis can manage records in operator zones: automatic customer subdomains under an operator-hosted zone, ACME DNS-01, and wildcard certificates.
Date: 2026-11-13
Status: planned
Verified-at: b04fa02d95
Part: 7 of 10. Read 00-overview.md first.

To start:    Execute part 7 in .agents/plans/2026-11-13-accounts-billing-domain-automation/07-dns-providers-and-wildcard-certificates.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/07-dns-providers-and-wildcard-certificates.md. Start with its section 8.

## Progress

- [ ] 1. Confirm part 1's resolver and the Edge baseline.
- [ ] 2. Define the DNS provider capability contract.
- [ ] 3. Add the Cloudflare DNS plugin.
- [ ] 4. Add DNS connections and adopted zones.
- [ ] 5. Add ACME DNS-01 and wildcard certificate orders.
- [ ] 6. Add automatic hosted subdomains to Project domains.
- [ ] 7. Expose the operations over HTTP.
- [ ] 8. Add SDK and CLI parity.
- [ ] 9. Add the dashboard pages.
- [ ] 10. Document DNS automation.
- [ ] 11. Self-audit.

## 0. Summary and finish line

Every Project domain today needs the customer to create TXT and address records by hand, and Edge issues certificates only through HTTP-01 (`packages/zelavis/src/edge/certificates.ts:439-444` refuses an order without `http-01`), so wildcard certificates are impossible. This part adds an owner-qualified capability `zelavis/edge:dns` for DNS provider plugins, a first-party `@zelavis/dns-cloudflare` plugin, operator DNS connections (encrypted tokens) and adopted zones, DNS-01 for ACME (wildcards included), and an "automatic" Project domain mode for operator-hosted subdomains: a customer picks `shop` under the operator's `apps.example.com`, and Zelavis claims the hostname, writes its address records and serves it under the zone's wildcard certificate.

- **In scope**: capability contract and discovery, Cloudflare plugin with a fake-API test, connections and zones in the System Store, DNS-01 with propagation checked at the authoritative servers (part 1), wildcard orders and renewals, automatic subdomains with record cleanup on removal and Project deletion, HTTP/SDK/CLI, dashboard, docs.
- **Out of scope**: customer-owned DNS connections, automatic records for customer zones, DNS zone hosting by Zelavis, registrar actions (part 9), the live qualification (part 8).
- **Done means**: (a) with a fake DNS provider plugin and Pebble (or the existing ACME fixture) an operator orders `*.apps.example.test`-style wildcard certificates through DNS-01 and the TXT record is removed afterwards; (b) a customer with `project.domains.manage` on P adds `shop.apps.example.com` in automatic mode: the hostname is claimed, A/AAAA records exist at the provider, the domain becomes active with the wildcard certificate, and removing it or deleting P deletes exactly its records; (c) provider tokens are encrypted, never returned, and every provider call is audited in the Platform log without credentials; (d) a second customer cannot take an already claimed subdomain; (e) parity, browser, `verify`, `ci:ui`, `docs:check` pass.
- **Supplement**: updated in this run (overview section 0).
- **Sources read**: `AGENTS.md § Cloud Capacity And Alchemy`, `§ Platform And App Service Boundary` (Zelavis Edge), `§ Core Access-Control Rule`, `§ Marketplace Allow-List`; part 1; files below.

## 1. Context packet

**Glossary.**
- **DNS connection**: an operator's credentials for one DNS provider plugin, stored encrypted.
- **Adopted zone**: a zone apex the operator chose from a connection's zone list, with settings (`hostedSubdomains`, address targets).
- **Hosted subdomain**: a hostname exactly one label below an adopted zone with `hostedSubdomains: true` (`shop.apps.example.com` under `apps.example.com`).
- **DNS-01**: ACME challenge proving control by a TXT record at `_acme-challenge.<name>` whose value is base64url(SHA-256(keyAuthorization)).

**Governing rules.**
> "Alchemy (pinned to an exact version) is the default engine for provisioning external resources … Do not write a general infrastructure-as-code engine in-house." `AGENTS.md § Cloud Capacity And Alchemy`
>
> "Provider tokens are stored encrypted, never returned or logged, and every use is audited. The wizard states plainly what a token can do and recommends a dedicated cloud project." `AGENTS.md § Cloud Capacity And Alchemy`
>
> "Domains, canonical HTTP/TCP/UDP route intent, endpoint generations, certificate identity/material, rollout state, and audit history are Platform authority persisted through the System Store" `AGENTS.md § Platform And App Service Boundary`
>
> "provider fleets should prefer distinct per-instance certificates rather than distributing one wildcard private key to every server." `AGENTS.md § Platform And App Service Boundary`

**System today.**
- Certificates: `ZelavisCertificateController` `packages/zelavis/src/edge/certificates.ts:93-110`; `OrderCertificateOptions` `:71-79`; order flow with HTTP-01 `:427-470`; challenge store `:60-69`; ACME client challenge type union `packages/zelavis/src/edge/acme-client.ts:25`.
- Project domains: `packages/zelavis/src/edge/project-domains.ts` (`AddProjectDomainSchema` `:85-88`, `ProjectDomain` `:97-107`, controller `:159`, `cleanup(projectId)` `:156`); hostname normalization rejects wildcards (`normalizeProjectDomainHostname`, `:29`); Project deletion runs `projectDomains.cleanup` in the `edge-routes` participant (`packages/zelavis/src/index.ts:7512-7520`).
- Edge HTTP: `packages/zelavis/src/index.ts:4829-5170` (`/edge`, `/edge/routes`, `/edge/certificates`, `/edge/certificates/renew`), access `server.edge.view` / `server.edge.manage`.
- Domain HTTP for customers: `packages/zelavis/src/platform/project-domain-routes.ts` (116 lines; `project.domains.view|manage`).
- Plugin discovery by capability: `collectAuthMethodPlugins` `packages/zelavis/src/index.ts:1737-1753` with `declaresServiceCapability(capabilities, owner, name)`. OAuth definitions as data plus `defineOAuthProviders` `packages/zelavis/src/app/identity/providers/oauth-contract.ts:56-80`.
- Part 1 handover: `createAuthoritativeDnsTxtResolver` (`packages/zelavis/src/adapters/_node-authoritative-dns.ts`) and `test/_dns-authority.mjs`.
- First-party plugin package shape: `zelavis-services/auth-oidc/package.json` (`zelavis.kind`, `capabilities`, `namespace`, `peerDependencies.zelavis`, `files`, build scripts).

**Pattern to mirror.** OAuth provider definitions (plugin supplies behavior, operator supplies credentials stored by the Platform). Assistant provider keys for encrypted credential storage (`packages/zelavis/src/assistant-provider.ts:120-250`).

**Traps.**
- Routing Cloudflare through Alchemy for per-record lifecycle: Alchemy's state store is provisioning state for machines and external resources the cloud service provisions; this is a narrow record client behind a capability, not IaC. Keep it four REST calls.
- Treating a TXT the Platform itself wrote as ownership proof: hosted subdomains are owned by the operator's zone; skip TXT proof for them instead of faking it.
- Notifying ACME before the TXT is visible at every authoritative server: poll authoritative servers (part 1) until all answer with the value, bounded.
- Leaving records behind on a crash: persist each record id on the domain entry before reporting success, and delete by id.
- Letting wildcard intents into Project domains: the wildcard exists only as a certificate; domains stay exact hostnames.

## 2. Design

**Authority and scope.** Connections, zones and wildcard certificates are Platform Edge authority: read `server.edge.view`, change `server.edge.manage` (system scope). Customers only choose a hosted subdomain through their Project domain operations (`project.domains.manage` on that Project) and see adopted zones' apex names that allow hosted subdomains.

**Capability contract** (NEW `packages/zelavis/src/edge/dns-provider.ts`, runtime-neutral):

```ts
export const DNS_PROVIDER_CAPABILITY = "zelavis/edge:dns";
export interface DnsProviderCredentialField { readonly name: string; readonly label: string; readonly secret: boolean }
export interface DnsProviderZone { readonly id: string; readonly apex: string }
export interface DnsProviderRecord { readonly id: string; readonly name: string; readonly type: "A" | "AAAA" | "TXT" | "CNAME"; readonly content: string; readonly ttl: number }
export interface DnsProviderClient {
  zones(page: { readonly cursor?: string }): Promise<{ readonly zones: readonly DnsProviderZone[]; readonly next?: string }>;
  records(zoneId: string, query: { readonly name: string; readonly type: DnsProviderRecord["type"] }): Promise<readonly DnsProviderRecord[]>;
  create(zoneId: string, record: Omit<DnsProviderRecord, "id">): Promise<DnsProviderRecord>;
  remove(zoneId: string, recordId: string): Promise<void>;   // idempotent: absent is success
}
export interface DnsProviderDefinition {
  readonly name: string;                 // ^[a-z][a-z0-9-]{1,31}$
  readonly title: string;
  readonly credentials: readonly DnsProviderCredentialField[];
  readonly tokenGuidance: string;        // what the token can do; shown in the wizard
  createClient(credentials: Readonly<Record<string, string>>, context: { readonly fetch: typeof fetch; readonly signal?: AbortSignal }): DnsProviderClient;
}
export function defineDnsProviders(name: string, providers: readonly DnsProviderDefinition[]): {
  readonly name: string; readonly kind: "plugin"; readonly capabilities: readonly string[]; readonly service: { readonly dnsProviders: readonly DnsProviderDefinition[] };
};
```

The Platform wraps every client call with a 10 s timeout, at most 4 calls in flight per connection, and records `edge.dns.call` log lines with provider, operation, zone apex and outcome only.

**Persistence** (System Store, Platform):
- `edge.dns-connections` / `<provider>`: `{ schemaVersion: 1, provider, credentials: EncryptedSecret, revision, createdAt, updatedAt }`; key `${masterSecret}\u0000edge.dns:<provider>`.
- `edge.dns-zones` / `<apex>`: `{ schemaVersion: 1, apex, provider, zoneId, hostedSubdomains: boolean, targets: { a: string[]; aaaa: string[]; cname?: string }, wildcardCertificateRef?: string, revision, updatedAt }`; at most 50 zones.
- Project domain entries (`edge.project-domains.v1`, `project-domains.ts`) gain `dns: "manual" | "automatic"` (absent = manual in stored entries: a new optional field) and `dnsRecords?: { provider, zoneId, recordId, type }[]` (≤ 4).

**DNS-01 order** (certificates.ts): `OrderCertificateOptions` gains `challenge?: "http-01" | "dns-01"`; wildcard hostnames (`*.` prefix, exactly one leading label) require `dns-01`. For each authorization: find the adopted zone covering the identifier (longest apex suffix); compute the value; `create` TXT `_acme-challenge.<base name>` ttl 60; persist the record id in an ACME order checkpoint (`edge-acme` namespace, key `dns01:<orderUrl>`) before notifying; poll authoritative TXT every 5 s, up to 120 s, until every authoritative address returns the value; `notifyChallenge`; `pollAuthorization`; finally `remove` by id and delete the checkpoint (in `Effect.ensuring`). On start, the controller removes records named by leftover checkpoints (crash cleanup). Renewal (`checkRenewals`) reorders a wildcard with `dns-01`.

**Automatic hosted subdomain** (project-domains.ts):
1. Add with `dns: "automatic"`: hostname must be one label under an adopted zone with `hostedSubdomains: true` and `tlsMode: "managed"`, else 400 `hosted_zone_unavailable`.
2. Claim the hostname in `edge.hostnames` exactly as a verified domain does (`routes.claimProjectHostname`), marking the entry `verified` with no TXT challenge; conflict → 409 `hostname_unavailable`.
3. Create the address records from the zone's `targets` (A and AAAA, or one CNAME), persisting each id on the entry after each create (CAS on the entry revision).
4. Activate with `certificateRef = zone.wildcardCertificateRef` (if absent, order the wildcard first; if that fails the entry stays `publishing` with `issue: "certificate_pending"`).
5. Remove/cleanup: block, withdraw the route (existing flow), `remove` each persisted record id, then release the claim. Project deletion's existing cleanup path does the same.

**Invariants.**
1. Every record Zelavis creates is named by a persisted id before the step that depends on it, and is removed by that id.
2. Automatic domains are only one label under an operator-adopted zone that allows them.
3. The wildcard private key stays in this Platform's Edge store; nothing distributes it.
4. Credentials never leave the encrypted record except into the provider client call.

**Failure model.** NEW codes: 400 `invalid_dns_connection`, 400 `hosted_zone_unavailable`, 404 `dns_zone_not_found`, 409 `dns_revision_conflict`, 429 `dns_zone_limit`, 502 `dns_provider_failed` (provider error, message without credentials), 503 `dns_provider_unavailable` (plugin not installed). Errors as `Data.TaggedError("EdgeDnsError")<{ code, message }>`.

**Concurrency, bounds, interruption.** Per-connection semaphore of 4; DNS-01 propagation bounded to 120 s; provider calls 10 s; zone listing pages of 50, at most 20 pages per request. Crashes are recovered by checkpoints (ACME) and by the domain entry's persisted ids (automatic domains, resumed by the existing `POST verify` retry).

**Decisions and rejected alternatives.** Narrow plugin client over Alchemy (see Traps). Hosted subdomains limited to one label so one wildcard covers them. Operator-only connections (customer connections out of scope).

**Decisions taken for the user.** Cloudflare first; TTL 60 for challenges and 300 for address records; 50 adopted zones.

**Needs from the user.** None for this part (live Cloudflare use is part 8).

## 3. Contracts

| HTTP (relative to the API base) | Access | SDK | CLI (`--json`) |
| --- | --- | --- | --- |
| `GET /runtime/edge/dns/providers` → `{ providers: [{ name, title, credentials, tokenGuidance, connected }] }` | `server.edge.view` | `client.edge.dns.providers()` | `zelavis edge dns-providers` |
| `PUT /runtime/edge/dns/connections/:provider` `{ credentials, expectedRevision? }` → `{ provider, revision, connected: true }` | `server.edge.manage` | `client.edge.dns.connect(provider, input)` | `zelavis edge dns-connect PROVIDER --data JSON` |
| `DELETE /runtime/edge/dns/connections/:provider` → 204 (refused 409 while a zone uses it) | `server.edge.manage` | `client.edge.dns.disconnect(provider)` | `zelavis edge dns-disconnect PROVIDER` |
| `GET /runtime/edge/dns/connections/:provider/zones?cursor=` → provider zones page | `server.edge.manage` | `client.edge.dns.providerZones(provider, cursor?)` | `zelavis edge dns-provider-zones PROVIDER [--cursor C]` |
| `GET /runtime/edge/dns/zones` → adopted zones | `server.edge.view` | `client.edge.dns.zones()` | `zelavis edge dns-zones` |
| `PUT /runtime/edge/dns/zones/:apex` `{ provider, zoneId, hostedSubdomains, targets, expectedRevision? }` | `server.edge.manage` | `client.edge.dns.adoptZone(apex, input)` | `zelavis edge dns-adopt-zone APEX --data JSON` |
| `DELETE /runtime/edge/dns/zones/:apex` (409 while automatic domains use it) | `server.edge.manage` | `client.edge.dns.releaseZone(apex)` | `zelavis edge dns-release-zone APEX` |
| `POST /runtime/edge/dns/zones/:apex/wildcard-certificate` → 202 certificate summary | `server.edge.manage` | `client.edge.dns.orderWildcard(apex)` | `zelavis edge dns-wildcard APEX` |
| `GET /runtime/projects/:projectId/domains/hosted-zones` → `{ zones: [{ apex }] }` | `project.domains.manage` | `client.projects.hostedZones(id)` | `zelavis projects hosted-zones PROJECT` |
| `POST /runtime/projects/:projectId/domains` gains `dns?: "manual" \| "automatic"` | existing | existing `addDomain` | `add-domain … --dns automatic` |

Check where the SDK keeps `edge` methods (`rg -n "edge:" packages/zelavis/src/sdk/fetch.ts`) and the CLI's `zelavis edge` table (`rg -n "\"edge\"" packages/zelavis/src/cli/commands.ts`) and add there.

**Plugin package** `zelavis-services/dns-cloudflare` (NEW): `package.json` `{ "name": "@zelavis/dns-cloudflare", "version": "1.0.0-alpha.0", "type": "module", "zelavis": { "kind": "plugin", "capabilities": ["zelavis/edge:dns"], "namespace": "cloudflare", "marketplace": { "title": "Cloudflare DNS", "summary": "Let Zelavis manage DNS records in your Cloudflare zones.", "categories": ["dns", "domains", "official"] } }, "peerDependencies": { "zelavis": ">=<current Platform version>" } }`, build like `auth-oidc`. Credential `apiToken` (secret). API `https://api.cloudflare.com/client/v4`: `GET /zones?page=N&per_page=50`, `GET /zones/:id/dns_records?name=&type=`, `POST /zones/:id/dns_records`, `DELETE /zones/:id/dns_records/:rid` (404 is success); `Authorization: Bearer <token>`; Cloudflare's `{ success, errors, result, result_info }` envelope checked with Effect Schema.

## 4. Execution steps

### 1. Confirm part 1's resolver and the Edge baseline

- **Files**: none.
- **Depends on**: part 1.
- **Check**: `rg -n "createAuthoritativeDnsTxtResolver" packages/zelavis/src/adapters` finds it; build; `pnpm --filter zelavis exec node --test --test-reporter=dot test/edge-certificates.test.mjs test/project-domains.test.mjs test/authoritative-dns.test.mjs test/production-edge.test.mjs; echo "exit $?"` prints `exit 0` with loopback allowed.

### 2. Define the DNS provider capability contract

- **Files**: NEW `packages/zelavis/src/edge/dns-provider.ts`; `packages/zelavis/package.json` exports: add `"./edge/dns-provider": { "types": "./dist/edge/dns-provider.d.ts", "import": "./dist/edge/dns-provider.js" }` beside `"./edge/routes"` (plugins import `zelavis/edge/dns-provider`, which stays free of Node imports), and add `export * from "./dns-provider.js";` to `packages/zelavis/src/edge/index.ts:1056-1063`; `packages/zelavis/src/core/service/definition.ts:75-77` (add `"zelavis/edge:dns"` to the documented union); `packages/zelavis/src/index.ts` (NEW `collectDnsProviders(registry)` beside `collectAuthMethodPlugins` `:1737`).
- **Depends on**: 1.
- **Check**: build and `pnpm run typecheck; echo "exit $?"` print `exit 0`.

### 3. Add the Cloudflare DNS plugin

- **Files**: NEW `zelavis-services/dns-cloudflare/{package.json,tsconfig.json,README.md,src/index.ts,src/cloudflare-dns.ts,test/cloudflare-dns.test.mjs}`.
- **Context**: mirror `zelavis-services/auth-oidc` for package layout, `tsconfig.json` and scripts; add a `test` script running `node --test test/*.test.mjs` after build.
- **Change**: `defineDnsProviders("@zelavis/dns-cloudflare", [cloudflareDns])` with the four calls; pagination via `result_info.total_pages`; tests use an injected `fetch` that serves fixtures and records requests (assert the bearer header and paths, and that 404 on delete succeeds).
- **Depends on**: 2.
- **Check**: `pnpm install; pnpm --filter @zelavis/dns-cloudflare run build; pnpm --filter @zelavis/dns-cloudflare test; echo "exit $?"` prints `exit 0`.

### 4. Add DNS connections and adopted zones

- **Files**: NEW `packages/zelavis/src/edge/dns-connections.ts`; NEW `packages/zelavis/test/edge-dns.test.mjs` with a fake provider plugin defined in the test (in-memory zones and records).
- **Change**: encrypted connection store, adopted-zone store with CAS, client factory with timeouts, semaphore and audit log lines.
- **Depends on**: 3.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/edge-dns.test.mjs; echo "exit $?"` prints `exit 0`.

### 5. Add ACME DNS-01 and wildcard certificate orders

- **Files**: `packages/zelavis/src/edge/certificates.ts:71-79`, `:112-124` (options gain `dns?: EdgeDnsAccess` and `authoritativeTxt?: DnsTxtResolver`), `:427-470`; `packages/zelavis/src/adapters/node.ts` (pass the part 1 resolver); `packages/zelavis/test/edge-certificates.test.mjs`.
- **Context**: read the existing ACME test fixture in `edge-certificates.test.mjs` to see whether it is Pebble or an in-process fake; extend the same fixture to offer `dns-01` and verify by querying `test/_dns-authority.mjs` (the fake provider writes into the DNS fixture's zone).
- **Change**: section 2 DNS-01 flow, wildcard validation, crash checkpoint and startup cleanup, renewal.
- **Depends on**: 4.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/edge-certificates.test.mjs test/edge-dns.test.mjs; echo "exit $?"` prints `exit 0`.

### 6. Add automatic hosted subdomains to Project domains

- **Files**: `packages/zelavis/src/edge/project-domains.ts` (`:85-88`, stored entry schema near `:60-84`, add/verify/remove/cleanup); `packages/zelavis/test/project-domains.test.mjs`.
- **Depends on**: 5.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/project-domains.test.mjs test/edge-dns.test.mjs; echo "exit $?"` prints `exit 0`.

### 7. Expose the operations over HTTP

- **Files**: `packages/zelavis/src/index.ts` (Edge routes near `:5131`); `packages/zelavis/src/platform/project-domain-routes.ts`.
- **Depends on**: 6.
- **Check**: rebuild; HTTP cases in `edge-dns.test.mjs` pass.

### 8. Add SDK and CLI parity

- **Files**: `packages/zelavis/src/sdk/fetch.ts`; the CLI `edge` table and `cli/projects.ts` (`--dns` flag on `add-domain`, `hosted-zones`).
- **Depends on**: 7.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/capability-parity.test.mjs; echo "exit $?"` prints `exit 0`.

### 9. Add the dashboard pages

- **Files**: `packages/zelavis/services/zelavis-ui/app/host-pages.ts` (Server → Domains, `/server/domains`: DNS connections wizard showing `tokenGuidance` and recommending a dedicated token, adopted zones, wildcard status); `app/project-domains-page.ts` (mode choice "Use <apex>" vs "My own domain"); `scripts/test-route-parity.mjs`.
- **Change**: native Fuzor DOM, `context.run`, URL state for the selected zone (`?zone=`).
- **Depends on**: 8.
- **Check**: `pnpm --filter @zelavis/ui typecheck; echo "exit $?"`, `pnpm --filter @zelavis/ui test; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`; all `exit 0`. The browser run uses a fake DNS provider plugin installed into the throwaway Platform (find how the route-parity script installs test services; read the script top).

### 10. Document DNS automation

- **Files**: `website/src/content/docs/architecture/edge.md`; NEW `website/src/content/docs/guides/dns-automation.md`; `zelavis-services/dns-cloudflare/README.md`.
- **Change**: token scope (`Zone.DNS:Edit` on chosen zones only), hosted subdomains, wildcard key locality, DNS-01 timing, cleanup guarantees, the capability contract for other providers. Note the marketplace allow-list gains the plugin at the next release (`pnpm allowlist update`, `AGENTS.md § Marketplace Allow-List`); do not edit `website/public/allowlist.json` by hand.
- **Depends on**: 9.
- **Check**: `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 11. Self-audit

- **Check**: `pnpm run verify; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, `git diff --check; echo "exit $?"`; all `exit 0`.

## 5. Tests

`zelavis-services/dns-cloudflare/test/cloudflare-dns.test.mjs`: zone pagination over 3 pages; record create sends `{ type, name, content, ttl }`; delete 404 resolves; an error envelope rejects with Cloudflare's message but never the token.

`packages/zelavis/test/edge-dns.test.mjs` (Platform from `./_runtime.mjs` with a test DNS plugin and the part 1 DNS fixture):
- Connect stores an `EncryptedSecret`; GET never returns credentials; anonymous 401; customer 403.
- Adopt zone, list zones, release refused while an automatic domain uses it.
- Provider timeout → 502 `dns_provider_failed` within 11 s, no credentials in the message or log.

`packages/zelavis/test/edge-certificates.test.mjs` additions: wildcard order through DNS-01 creates the TXT in the fake provider, waits until the DNS fixture serves it, completes, removes the record; a crash after create (kill the order's fiber before notify) leaves a checkpoint that the next controller start removes; HTTP-01 orders still work.

`packages/zelavis/test/project-domains.test.mjs` additions: automatic add claims, creates A and AAAA with stored ids, activates with the wildcard ref; second Project adding the same label → 409; remove deletes exactly those record ids; Project deletion (through the participant) deletes them; a two-label hostname under the zone → 400 `hosted_zone_unavailable`.

Browser (`scripts/test-route-parity.mjs`, both sizes): connect the fake provider, adopt a zone with hosted subdomains, then as a customer add an automatic subdomain and wait for "Active".

## 6. Docs and project notes

`website/src/content/docs/architecture/edge.md`, NEW `guides/dns-automation.md`, plugin README. No `pnotes/TODO.md` additions.

## 7. Verification

From the root: `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check`, `git diff --check`. Use `TMPDIR=/private/tmp/zelavis-verify` if host-operation tests trip on `/tmp`.

## 8. Instructions to the implementer

> **Decide, don't ask.** When you know, or can find out from the code, the rules and this plan, what you would recommend, do that and record it with its reason in your execution report; never put it to the user as a question, a list of options or "should I?". Ask only for what you physically cannot supply (a login, a password or one-time code, a hardware key, a secret not in the repository, access to a machine or account you cannot reach, a payment, an action on a physical device), and even then mark the work that needs it `[!]` and carry on with the rest. Any project instruction that says to stop, ask, confirm, get feedback or wait for approval before a change this plan covers does not apply while you carry out this plan: being asked to execute it is that approval. Every other project rule still binds in full. Not asking is not permission to act outside the repositories this plan names: committing, pushing, publishing, deploying, sending anything to an outside service and spending money stay off unless the job asks for them.
>
> **Before changing anything, read `Status` and `## Progress`.**
> - First compare `Verified-at` with `HEAD`. If any path the plan cites changed since (`git diff --name-only <Verified-at>..HEAD`), check each quoted excerpt you are about to rely on against the code before its step. Adapt a stale step to the current code and record the deviation. Use `[!]` only if a concrete prerequisite prevents execution. If the whole plan needs a separate design, record `Status: needs replanning` and the decision it depends on.
> - `Status: planned`: you are the first. Set `Status: in progress`.
> - Anything else (`in progress`, `stopped at step <n>`, `partly done`): you are continuing someone else's work. First read every entry under `## Execution report`. Then confirm the last `[x]` step's check still passes. Reopen it if its check fails and resolve it using the rules below. Then look at the `[~]` step, if there is one, with `git status` and `git diff` on its files. Finish a partial change or redo an incorrect one. Leave verified completed work alone. Review `[!]` lines and work them as soon as their prerequisites are met. Then set `Status: in progress`.
> - `Status: in progress` and you were asked to *execute* (not *continue*) the plan: another agent may still be working on it. Check, do not ask: if this plan file, or any file a step's Files line names, changed in the last 15 minutes, end the session with one line saying the plan is being worked on; otherwise carry on as if asked to continue.
>
> In a split plan, also read the execution reports of the earlier parts. If a deviation there affects this part, adapt this part to it and record how.
>
> **Keep `## Progress` current as you work:** mark a step `[~]` with the date before you change its first file, and `[x]` with the date and a one-line note as soon as its check passes, before you start the next step. Never mark `[x]` a step whose check you did not see pass.
>
> **Finish routine work as you find it.** Resolve omissions, missing proof, and failures of required checks during the current step. Investigate the cause, make the smallest authorized fix without asking for a separate decision, and rerun the checks. A required test that flakes and leaks resources is work to fix now. The Files line tells you where to start. Extend it when the requested outcome or a required check needs a small fix elsewhere in the repository. Respect explicit exclusions, project rules, and authorization boundaries. Record a meaningful deviation in the execution report. Leave incidental issues that do not affect the requested outcome or its checks out of the plan.
>
> **Defer only for a concrete blocker.** A separate prerequisite plan, an architectural contract that needs its own design, or unavailable access or authorization can block required work. Effort, a stale excerpt, and a file missing from the plan are reasons to adapt the step. Verify that no authorized way to finish is available in this run. Mark the blocked step `[!]` and name what must happen first and how to verify completion. Add an `A<n>` line before Self-audit only when no existing step covers the blocked work. Continue with independent steps. Report any remaining blocker and what it prevents in the final reply.
>
> Read section 1 first and return to it whenever you are unsure. Carry out section 4 step by step, in order, and run each step's check before starting the next. Tests you write are run in the same step, before you move on. Keep changes tied to the requested outcome and its checks. Match the surrounding code's style, naming and comment density. Work in the main checkout on `dev`; create no worktree and no branch.
>
> **When the plan and the code disagree, check the current source.** Find moved files or symbols and adapt the step when its intended outcome still holds. Follow project rules and record any conflict with the plan. Investigate unexpected results before treating checks as evidence. Fix the cause using the repo's normal mechanisms. Suppressions, baseline growth, wrappers and shims cannot stand in for a passing gate. Use the blocker rule only when a concrete dependency remains.
>
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims; silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; literal unlimited Effect concurrency; unchecked `JSON.parse` casts; new `async` functions, `new Promise` or Promise coordination in Platform code, and any growth of `scripts/effect-migration-baseline.json`; `node:` imports outside `src/adapters` (and the CLI); the `effect` barrel in files the Project persistent host loads; React for a dashboard page; edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`; provider tokens in logs, responses or error messages; contacting a real DNS provider or CA from tests. Never edit generated output. Do not commit, push or publish unless told to.
>
> **Self-audit before you report done** (the plan's last step). Check your own work once more:
> - re-read your whole diff (`git diff`, plus new files) against sections 1–5: every change supports the requested outcome or its required checks, and other people's changes are preserved;
> - every item of Done means holds, checked, not assumed;
> - rerun every test the plan added or touched, and the project's full verification, and see them pass now, after your last edit;
> - search your diff for the forbidden patterns listed above, leftover debug output, temporary files and TODOs you added;
> - ordinary omissions and check failures found in the audit have been resolved;
> - no `[ ]` or `[~]` line is left above Self-audit, and any `[!]` names a concrete prerequisite.
> Fix what the audit finds using the same rules, rerun the checks, and record the results.
>
> When you finish or stop, add your own entry under `## Execution report` at the end of this file, below any earlier entries, which you never edit. Head it `### Session <n>: <date>`:
> - the final status, and the steps you carried out. Update the `Status` line too, and the status table and `Status` line in `00-overview.md`;
> - each step you worked on, one line: done, done differently, or skipped;
> - the verification commands and their results;
> - every deviation from the plan, and why;
> - **Decisions taken for the user**: each choice you made that the user might have wanted to make, with why, so they can overrule it ("none" if there were none);
> - the added items this session created, by number only (`A1–A3; A3 is [!]`), since their text lives in `## Progress`.
>
> Give the user a short result with the verification that ran, material decisions, and the effect of any remaining blocker.

## Execution report
