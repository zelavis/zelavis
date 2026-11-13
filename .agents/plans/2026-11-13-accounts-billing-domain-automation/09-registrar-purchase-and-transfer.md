# Registrar purchase, transfer and renewal

Job: Let the Platform owner check, register, transfer in and renew domains with their own registrar account (Namecheap first, built into core), with durable orders that never buy twice.
Date: 2026-11-13
Status: planned
Verified-at: b04fa02d95
Part: 9 of 14. Read 00-overview.md first.

To start:    Execute part 9 in .agents/plans/2026-11-13-accounts-billing-domain-automation/09-registrar-purchase-and-transfer.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/09-registrar-purchase-and-transfer.md. Start with its section 8.

## Progress

- [ ] 1. Confirm part 7's provider pattern and the baseline.
- [ ] 2. Define the registrar capability contract.
- [ ] 3. Add the built-in Namecheap registrar driver with a fake API.
- [ ] 4. Add the registrar connection and contact profile.
- [ ] 5. Add durable orders and reconciliation.
- [ ] 6. Expose the operations over HTTP.
- [ ] 7. Add SDK and CLI parity.
- [ ] 8. Add the Server → Domains registrar section.
- [!] 9. Qualify against the Namecheap sandbox. (blocked by: a Namecheap sandbox API user, API key and whitelisted client IP from the user; check: `pnpm release:qualify:registrar` prints `PASS check`, `PASS register`, `PASS renew`, `PASS list` and exits 0)
- [ ] 10. Document registrar operations.
- [ ] 11. Self-audit.

## 0. Summary and finish line

Zelavis has no way to acquire a domain; operators buy elsewhere and then connect it. This part adds a registrar provider contract with a first-party Namecheap driver built into the `zelavis` package (`packages/zelavis/src/adapters/_registrar-namecheap.ts`, injected by the Node adapter, as part 7 does for DNS), an owner-qualified capability `zelavis/edge:registrar` through which a third-party plugin can add another registrar, an encrypted registrar connection and registrant contact profile, and durable orders for register, transfer-in and renew, each with an idempotency key and a price confirmation, reconciled against the registrar after any ambiguous outcome. Purchases are owner-level (`server.domains.purchase`) and spend the operator's own registrar account: this is domain management, the same for Zelavis Cloud, a self-hoster and a hosting company. Selling a domain to a customer at the operator's price is later work for Hosting (part 14 records why it is out of scope: refunds and zone creation), and will place its orders through the operation this part adds.

- **In scope**: provider contract and plugin discovery, built-in Namecheap driver (check, pricing, create, renew, transfer create/status, list, info, set custom nameservers), connection, contacts, orders state machine, reconciliation loop, HTTP/SDK/CLI, dashboard, docs, fake-API tests, sandbox qualification.
- **Out of scope**: customer purchases and resale pricing (a later Hosting plan builds them on this part's orders; see part 14 section 0), WHOIS privacy settings beyond the registrar default, auto-renew scheduling (renew is explicit), DNSSEC, transfers out, registrar account funding.
- **Done means**: (a) availability and price for `example-<run>.com` come back from the fake API and from the sandbox; (b) a register request with `idempotencyKey` K and `confirm: { price, currency, years }` creates exactly one order; repeating K returns the same order; a changed price → 409 `price_changed` and nothing is bought; (c) killing the Platform while an order is `submitting` leaves it `unknown`, and reconciliation settles it `completed` or `failed` from the registrar's own records without resubmitting; (d) transfer-in with an auth code reaches `pending_transfer` and later `completed` by status polling; (e) only holders of `server.domains.purchase` can purchase; credentials and contact data never appear in logs; (f) the sandbox run passed (step 9); (g) parity, browser, `verify`, `ci:ui`, `docs:check` pass.
- **Supplement**: updated in this run (overview section 0).
- **Owner decision (2026-11-13, this conversation)**: core owns the registrar capability and ships the Namecheap driver behind the adapter boundary; third-party registrars are plugins. No `zelavis-services/registrar-namecheap` package.
- **Sources read**: `AGENTS.md § Core Access-Control Rule`, `§ Cloud Capacity And Alchemy` (token handling), `§ TigerStyle Adaptation`; part 7; files below.

## 1. Context packet

**Glossary.**
- **Registrar connection**: the operator's registrar API credentials, encrypted in the System Store.
- **Contact profile**: the registrant/admin/tech/billing contact the registrar requires, entered by the owner.
- **Order**: one durable record per purchase intent: `register`, `transfer` or `renew`.
- **Ambiguous submit**: the registrar call's outcome is unknown (timeout, crash, 5xx after sending).

**Governing rules.**
> "A provisioned machine is not a Node until enrollment verifies identity … Provider calls check the current epoch" `AGENTS.md § Cloud Capacity And Alchemy` (the same posture: external effects are confirmed from the provider's own records).
>
> "Define authority, invariants, resource limits, and interruption/recovery behavior before implementing state transitions." `AGENTS.md § TigerStyle Adaptation`

**System today.**
- Part 7 handover: provider contract in `packages/zelavis/src/edge/dns-provider.ts` (`defineDnsProviders`, `DnsProviderListing` with `source: "built-in" | "plugin"`, definition with `credentials`, `tokenGuidance`, `createClient(credentials, { fetch, signal })`); discovery `collectDnsProviders(registry, builtIn)` and the internal `edgeDnsProviders` option in `packages/zelavis/src/index.ts`; built-in driver `packages/zelavis/src/adapters/_dns-cloudflare.ts` (`createCloudflareDnsProvider({ apiBase })`) injected by `packages/zelavis/src/adapters/node.ts`; encrypted connection store `packages/zelavis/src/edge/dns-connections.ts`; boundary test `packages/zelavis/test/provider-adapter-boundary.test.mjs`.
- Edge HTTP route region `packages/zelavis/src/index.ts:4829-5170`; Server Domains page `packages/zelavis/services/zelavis-ui/app/host-pages.ts` (`/server/domains`).
- Permission vocabulary shown at `/server/access/permissions` (`host-pages.ts:240`).
- Master secret and encryption as in part 2 (`packages/zelavis/src/platform/master-secret.ts:19`, `packages/zelavis/src/edge/acme-crypto.ts:79`, `:104`).

**Namecheap API** (XML over HTTPS GET/POST): production `https://api.namecheap.com/xml.response`, sandbox `https://api.sandbox.namecheap.com/xml.response`. Global parameters `ApiUser`, `ApiKey`, `UserName`, `ClientIp`, `Command`. Commands used: `namecheap.domains.check` (`DomainList`), `namecheap.users.getPricing` (`ProductType=DOMAIN`, `ActionName=REGISTER|RENEW|TRANSFER`, `ProductName=<tld>`), `namecheap.domains.create` (`DomainName`, `Years`, contact fields for `Registrant`, `Tech`, `Admin`, `AuxBilling`), `namecheap.domains.renew` (`DomainName`, `Years`), `namecheap.domains.transfer.create` (`DomainName`, `Years`, `EPPCode`), `namecheap.domains.transfer.getStatus` (`TransferID`), `namecheap.domains.getList`, `namecheap.domains.getInfo`, `namecheap.domains.dns.setCustom` (`SLD`, `TLD`, `Nameservers`). Responses are `<ApiResponse Status="OK|ERROR">` with `<Errors>` and `<CommandResponse>`. Verify each command's exact parameter names against Namecheap's API documentation before implementing (step 3), and record any difference.

**Traps.**
- Retrying a timed-out `create`: that can buy twice. Mark `unknown` and reconcile.
- Trusting a client-sent price: the server re-reads the price and compares to `confirm`.
- An XML parser with entity expansion: parse only elements, attributes and the five predefined entities; refuse `<!DOCTYPE`.
- Contact data in logs or security events: never.
- Adding an XML library dependency to `zelavis`: the package ships no native code and stays small; the minimal parser in the driver is the whole need.
- Importing the driver outside `adapters/node.ts` and its test: `src/edge/` knows only `RegistrarDefinition`.

## 2. Design

**Authority and scope.** Platform-only. NEW permissions: `server.domains.view` (list domains and orders) and `server.domains.purchase` (connection, contacts, check with price, register, transfer, renew, nameservers), both system scope. Owners hold them via `*`; delegation follows the existing rules (an operator gets them only from someone holding them).

**Capability contract** (NEW `packages/zelavis/src/edge/registrar-provider.ts`, runtime-neutral, exported as `zelavis/edge/registrar-provider`):

```ts
export const REGISTRAR_CAPABILITY = "zelavis/edge:registrar";
export interface RegistrarContact { firstName: string; lastName: string; organization?: string; address1: string; address2?: string; city: string; stateProvince: string; postalCode: string; country: string /* ISO 3166-1 alpha-2 */; phone: string /* +NNN.NNNN */; email: string }
export interface RegistrarPrice { readonly amount: string /* decimal string */; readonly currency: string; readonly years: number }
export interface RegistrarClient {
  check(domains: readonly string[]): Promise<readonly { domain: string; available: boolean; premium: boolean; price?: RegistrarPrice }[]>;
  price(tld: string, action: "register" | "renew" | "transfer", years: number): Promise<RegistrarPrice>;
  register(input: { domain: string; years: number; contact: RegistrarContact; nameservers?: readonly string[] }): Promise<{ registrarOrderId: string; chargedAmount?: string }>;
  renew(input: { domain: string; years: number }): Promise<{ registrarOrderId: string; expiresAt?: string }>;
  transfer(input: { domain: string; years: number; authCode: string }): Promise<{ transferId: string }>;
  transferStatus(transferId: string): Promise<{ state: "pending" | "completed" | "failed"; detail?: string }>;
  domain(domain: string): Promise<{ owned: boolean; expiresAt?: string; nameservers?: readonly string[] } >;
  domains(page: { cursor?: string }): Promise<{ domains: readonly { domain: string; expiresAt?: string }[]; next?: string }>;
  setNameservers(domain: string, nameservers: readonly string[]): Promise<void>;
}
export interface RegistrarDefinition {
  readonly name: string; readonly title: string;
  readonly credentials: readonly { name: string; label: string; secret: boolean }[];
  readonly tokenGuidance: string;
  createClient(credentials: Readonly<Record<string, string>>, context: { readonly fetch: typeof fetch; readonly signal?: AbortSignal; readonly sandbox: boolean }): RegistrarClient;
}
/** Built-in registrars come from the host adapter (`edgeRegistrars`, NEW internal option); plugins add more. Names are unique; a built-in wins. */
export function defineRegistrars(name: string, registrars: readonly RegistrarDefinition[]): { name: string; kind: "plugin"; capabilities: readonly string[]; service: { registrars: readonly RegistrarDefinition[] } };
```

**Persistence** (System Store, Platform):
- `registrar.connection` / `current`: `{ schemaVersion: 1, provider, sandbox: boolean, credentials: EncryptedSecret, revision, updatedAt }` (one connection).
- `registrar.contacts` / `default`: `{ schemaVersion: 1, contact: RegistrarContact, revision, updatedAt }`.
- `registrar.orders` / `<createdAtMs padded>-<id>`: `RegistrarOrder` (section 3); idempotency index `registrar.order-keys` / `<idempotencyKey>` → order key, written with `setIfAbsent` first.

**Order state machine.** `requested` → `submitting` (CAS, persisted before the registrar call) → `completed` | `failed` (definite registrar answer) | `unknown` (ambiguous) ; transfer: `submitting` → `pending_transfer` → `completed` | `failed`. Reconciliation loop (runtime scope, every 60 s, at most 20 orders per pass, one registrar call in flight): `unknown` register → `domain(domain)`: `owned` → `completed`; not owned and `check` says available → `failed` with `detail: "not registered"` (the owner may place a new order); otherwise stay `unknown` and retry with backoff up to 24 h, then `failed` with `detail: "unconfirmed; check the registrar"`; `unknown` renew → `domain()` expiry later than the pre-order expiry → `completed`; `pending_transfer` → `transferStatus`. An order never goes from `unknown` back to `submitting`.

**Price confirmation.** Register/renew/transfer request body carries `confirm: { amount, currency, years }`. Inside the request, the server calls `price` (or `check` for premium names), compares exactly; mismatch → 409 `price_changed` with the current price, nothing persisted beyond the idempotency key (released by `compareAndDelete`).

**Invariants.**
1. At most one registrar purchase call per order, ever.
2. An idempotency key maps to exactly one order.
3. Every external purchase effect is either recorded `completed`, or reconciled from the registrar's records.
4. Credentials and contact data stay in their records and the registrar call.

**Failure model.** NEW `RegistrarError` (`Data.TaggedError`) codes: 400 `invalid_registrar_request`, 404 `registrar_order_not_found`, 409 `price_changed`, 409 `domain_unavailable`, 409 `registrar_contact_missing`, 502 `registrar_failed`, 503 `registrar_unavailable` (no connection or plugin), 429 `registrar_busy` (one purchase at a time).

**Concurrency, bounds, interruption.** One purchase in flight per Platform (semaphore 1); registrar call timeout 60 s (a timeout is ambiguous → `unknown`); reads 15 s; order listing paged 50; at most 200 non-terminal orders.

**Decisions and rejected alternatives.** Built-in driver over a plugin package (owner decision; the capability stays open to third parties). Namecheap first for its sandbox. Price confirmation over a silent current price. Reconciliation over retry. One connection per Platform (multi-registrar later if needed).

**Decisions taken for the user.** Purchases are owner-only by default (`server.domains.purchase` is not in any built-in role). Sandbox mode is a connection flag shown prominently in the UI.

**Needs from the user.** Namecheap sandbox API user, API key and a whitelisted client IP (blocks step 9 only).

## 3. Contracts

```ts
export interface RegistrarOrder {
  readonly id: string; readonly kind: "register" | "transfer" | "renew"; readonly domain: string; readonly years: number;
  readonly state: "requested" | "submitting" | "completed" | "failed" | "unknown" | "pending_transfer";
  readonly price: RegistrarPrice; readonly idempotencyKey: string; readonly principalId: string;
  readonly createdAt: string; readonly updatedAt: string; readonly registrarOrderId?: string; readonly transferId?: string; readonly detail?: string;
}
```

| HTTP (relative to the API base) | Access | SDK | CLI (`--json`) |
| --- | --- | --- | --- |
| `GET /runtime/registrar/providers` | `server.domains.view` | `client.registrar.providers()` | `zelavis registrar providers` |
| `GET\|PUT\|DELETE /runtime/registrar/connection` (`{ provider, sandbox, credentials, expectedRevision? }`; GET shows `{ provider, sandbox, connected }`) | `server.domains.purchase` | `client.registrar.connection()`, `.connect(input)`, `.disconnect()` | `zelavis registrar connection`, `connect --data JSON`, `disconnect` |
| `GET\|PUT /runtime/registrar/contact` | `server.domains.purchase` | `client.registrar.contact()`, `.setContact(input)` | `zelavis registrar contact`, `set-contact --data JSON` |
| `POST /runtime/registrar/availability` `{ domains: string[] /* ≤ 20 */ }` | `server.domains.purchase` | `client.registrar.check(domains)` | `zelavis registrar check DOMAIN...` |
| `POST /runtime/registrar/orders` `{ kind, domain, years /* 1-10 */, authCode? /* transfer */, confirm, idempotencyKey /* ^[A-Za-z0-9._:-]{8,128}$; the dashboard sends a UUID; other callers may send a namespaced key such as hosting:<order id> */ }` → 201/200 `RegistrarOrder` | `server.domains.purchase` | `client.registrar.order(input)` | `zelavis registrar order --data JSON` |
| `GET /runtime/registrar/orders?limit&after`, `GET /runtime/registrar/orders/:id` | `server.domains.view` | `client.registrar.orders(page?)`, `.getOrder(id)` | `zelavis registrar orders`, `order-status ID` |
| `GET /runtime/registrar/domains?cursor=` | `server.domains.view` | `client.registrar.domains(cursor?)` | `zelavis registrar domains` |
| `PUT /runtime/registrar/domains/:domain/nameservers` `{ nameservers: string[] /* 2-12 */ }` | `server.domains.purchase` | `client.registrar.setNameservers(domain, ns)` | `zelavis registrar set-nameservers DOMAIN NS...` |

The auth code is used once in the registrar call and never stored.

## 4. Execution steps

### 1. Confirm part 7's provider pattern and the baseline

- **Files**: none.
- **Depends on**: part 7.
- **Check**: `ls packages/zelavis/src/edge/dns-provider.ts packages/zelavis/src/adapters/_dns-cloudflare.ts`; build; `pnpm --filter zelavis exec node --test test/edge-dns.test.mjs; echo "exit $?"` prints `exit 0`.

### 2. Define the registrar capability contract

- **Files**: NEW `packages/zelavis/src/edge/registrar-provider.ts`; `packages/zelavis/package.json` exports (`"./edge/registrar-provider"`); `packages/zelavis/src/edge/index.ts` (re-export); `packages/zelavis/src/core/service/definition.ts:75-77`; `packages/zelavis/src/index.ts` (`collectRegistrars(registry, builtIn)` beside `collectDnsProviders`; internal option `edgeRegistrars?: readonly RegistrarDefinition[]`).
- **Depends on**: 1.
- **Check**: build and `pnpm run typecheck; echo "exit $?"` print `exit 0`.

### 3. Add the built-in Namecheap registrar driver with a fake API

- **Files**: NEW `packages/zelavis/src/adapters/_registrar-namecheap.ts`; NEW `packages/zelavis/src/adapters/_xml-response.ts`; `packages/zelavis/src/adapters/node.ts` (pass `edgeRegistrars: [namecheapRegistrar]` beside `edgeDnsProviders`); NEW `packages/zelavis/test/registrar-namecheap.test.mjs`; `packages/zelavis/test/provider-adapter-boundary.test.mjs` (add `_registrar-namecheap.js` to the forbidden list); NEW `distribution/scripts/qualify-registrar.mjs`; root `package.json` (`"release:qualify:registrar": "node distribution/scripts/qualify-registrar.mjs"`).
- **Context**: credentials `apiUser`, `apiKey` (secret), `userName`, `clientIp`. Export `createNamecheapRegistrar(options: { readonly endpoint?: string } = {}): RegistrarDefinition` (production endpoint by default, sandbox when the connection's `sandbox` is true, a fake's URL in tests) and `namecheapRegistrar = createNamecheapRegistrar()`.
- **Change**: client per section 1 commands; `_xml-response.ts` minimal parser (elements, attributes, text, five entities; refuse `<!DOCTYPE`; 1 MiB cap); `qualify-registrar.mjs` imports `packages/zelavis/dist/adapters/_registrar-namecheap.js`, reads `NAMECHEAP_SANDBOX_API_USER`, `NAMECHEAP_SANDBOX_API_KEY`, `NAMECHEAP_SANDBOX_CLIENT_IP` from the environment and runs check, price, register of a random `.com`, renew, list against the sandbox, printing `PASS <step>`.
- **Depends on**: 2.
- **Check**: `pnpm --filter zelavis run build; pnpm --filter zelavis exec node --test test/registrar-namecheap.test.mjs test/provider-adapter-boundary.test.mjs; echo "exit $?"` prints `exit 0`.

### 4. Add the registrar connection and contact profile

- **Files**: NEW `packages/zelavis/src/edge/registrar.ts`; NEW `packages/zelavis/test/registrar.test.mjs` (with a fake registrar plugin defined in the test).
- **Depends on**: 3.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/registrar.test.mjs; echo "exit $?"` prints `exit 0`.

### 5. Add durable orders and reconciliation

- **Files**: `packages/zelavis/src/edge/registrar.ts`; `packages/zelavis/src/index.ts` (fork the reconciliation loop in the runtime scope, Platform role only); `test/registrar.test.mjs`.
- **Depends on**: 4.
- **Check**: rebuild; the order cases in section 5 pass.

### 6. Expose the operations over HTTP

- **Files**: `packages/zelavis/src/index.ts` (beside the Edge routes `:4829-5170`); `packages/zelavis/services/zelavis-ui/app/host-pages.ts:240` (vocabulary: `server.domains.view`, `server.domains.purchase`).
- **Depends on**: 5.
- **Check**: rebuild; HTTP cases pass.

### 7. Add SDK and CLI parity

- **Files**: `packages/zelavis/src/sdk/fetch.ts` (NEW `registrar` client); NEW `packages/zelavis/src/cli/registrar-operations.ts`; `packages/zelavis/src/cli/commands.ts`.
- **Depends on**: 6.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/capability-parity.test.mjs; echo "exit $?"` prints `exit 0`.

### 8. Add the Server → Domains registrar section

- **Files**: `packages/zelavis/services/zelavis-ui/app/host-pages.ts` (`/server/domains`); NEW `app/registrar-panel.ts`; `scripts/test-route-parity.mjs`.
- **Change**: connect (sandbox toggle, token guidance), contact form, search with availability and price, a purchase dialog that shows domain, years, price and total and requires typing the domain to confirm, orders table with states, domains list, nameserver form. The client generates the idempotency key once per dialog (`crypto.randomUUID()`) and keeps it in the URL (`?order=<key>`) so a reload does not create a second order.
- **Depends on**: 7.
- **Check**: `pnpm --filter @zelavis/ui typecheck; echo "exit $?"`, `pnpm --filter @zelavis/ui test; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`; all `exit 0` (the browser run composes its Platform with `edgeRegistrars: [createNamecheapRegistrar({ endpoint: <fake URL> })]`).

### 9. Qualify against the Namecheap sandbox

- **Depends on**: 3 and the user's sandbox credentials.
- **Check**: `NAMECHEAP_SANDBOX_API_USER=… NAMECHEAP_SANDBOX_API_KEY=… NAMECHEAP_SANDBOX_CLIENT_IP=… pnpm release:qualify:registrar; echo "exit $?"` prints `PASS check`, `PASS register`, `PASS renew`, `PASS list` and `exit 0`. Record the run (no credentials) in the execution report.

### 10. Document registrar operations

- **Files**: NEW `website/src/content/docs/guides/domain-registration.md`; `website/src/content/docs/api/platform-operations.md`.
- **Change**: permissions, sandbox, price confirmation, idempotency, `unknown` orders and what reconciliation does, auth codes not stored, contact data handling, built-in versus plugin registrars, and that selling domains to customers is not available yet.
- **Depends on**: 8.
- **Check**: `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 11. Self-audit

- **Check**: `pnpm run verify; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, `git diff --check; echo "exit $?"`; all `exit 0`. With step 9 still `[!]`, set `Status: partly done`.

## 5. Tests

`packages/zelavis/test/registrar-namecheap.test.mjs` (fake endpoint serving recorded-shape XML): parameters include `ApiUser`, `UserName`, `ClientIp`, `Command`; `Status="ERROR"` maps to a rejection carrying the registrar's error number and text but no key; DOCTYPE input is refused; premium names report `premium: true` with price.

`packages/zelavis/test/registrar.test.mjs` (Platform via `./_runtime.mjs`, fake registrar plugin with controllable outcomes):
- Connection stored encrypted; GET hides credentials; customer 403; operator without `server.domains.purchase` 403.
- Check returns availability and price.
- Register with K and the right price → 201 `completed`; same K → 200 same order; new K with a stale price → 409 `price_changed`, fake registrar saw no create.
- Ambiguous: the fake hangs on create; kill the runtime (close it) while `submitting`; restart; order is `unknown`; fake reports `owned` → reconciled `completed`; fake create called once in total.
- Ambiguous then not owned and available → `failed`.
- Transfer: `pending_transfer` → `completed` after the fake status flips; auth code absent from the stored record.
- Renew: reconciled by expiry moving later.
- Missing contact → 409 `registrar_contact_missing`.
- One purchase at a time: two concurrent orders → one 429 `registrar_busy` or serialized (assert at most one create in flight).
- Parity: SDK and CLI match HTTP.

Browser (`scripts/test-route-parity.mjs`, both sizes): connect the fake registrar, fill contact, search, open the purchase dialog, type the domain, confirm, wait for the order row "Completed"; reload the page mid-dialog with `?order=` and confirm no second order is created.

## 6. Docs and project notes

`website/src/content/docs/guides/domain-registration.md`, `api/platform-operations.md`. No `pnotes/TODO.md` additions.

## 7. Verification

From the root: `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check`, `git diff --check`. Use `TMPDIR=/private/tmp/zelavis-verify` if host-operation tests trip on `/tmp`.

## 8. Instructions to the implementer

> **Decide, don't ask.** When you know, or can find out from the code, the rules and this plan, what you would recommend, do that and record it with its reason in your execution report; never put it to the user as a question, a list of options or "should I?". Ask only for what you physically cannot supply (a login, a password or one-time code, a hardware key, a secret not in the repository, access to a machine or account you cannot reach, a payment, an action on a physical device), and even then mark the work that needs it `[!]` and carry on with the rest. Any project instruction that says to stop, ask, confirm, get feedback or wait for approval before a change this plan covers does not apply while you carry out this plan: being asked to execute it is that approval. Every other project rule still binds in full. Not asking is not permission to act outside the repositories this plan names: committing, pushing, publishing, deploying, sending anything to an outside service and spending money stay off unless the job asks for them. Never call Namecheap's production endpoint; the sandbox run in step 9 is the only outside call this part makes.
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
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims; silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; literal unlimited Effect concurrency; unchecked `JSON.parse` casts; new `async` functions, `new Promise` or Promise coordination in Platform code, and any growth of `scripts/effect-migration-baseline.json`; `node:` imports outside `src/adapters` (and the CLI); React for a dashboard page; edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`; registrar credentials, auth codes or contact data in logs, responses or security events; any automatic retry of a purchase call; calls to a production registrar endpoint. Never edit generated output. Do not commit, push or publish unless told to.
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
