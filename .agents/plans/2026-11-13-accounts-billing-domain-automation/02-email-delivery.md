# Per-runtime email delivery

Job: Give the Platform and each native App its own email delivery (SMTP settings, durable outbox, test send), as the foundation for verification, recovery and invitation emails.
Date: 2026-11-13
Status: planned
Verified-at: b04fa02d95
Part: 2 of 10. Read 00-overview.md first.

To start:    Execute part 2 in .agents/plans/2026-11-13-accounts-billing-domain-automation/02-email-delivery.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/02-email-delivery.md. Start with its section 8.

## Progress

- [ ] 1. Prove the baseline at HEAD.
- [ ] 2. Define email contracts and schemas.
- [ ] 3. Add the SMTP fixture and the Node SMTP client.
- [ ] 4. Add encrypted settings storage.
- [ ] 5. Add the durable outbox and delivery loop.
- [ ] 6. Expose the email endpoint group on every runtime.
- [ ] 7. Add the exact Project Gateway routes.
- [ ] 8. Add SDK and CLI parity.
- [ ] 9. Add the dashboard settings cards.
- [ ] 10. Document email delivery.
- [ ] 11. Self-audit.

## 0. Summary and finish line

No runtime can send email today: `createPasswordProvider` accepts a `recovery.deliver` callback (`packages/zelavis/src/app/identity/providers/password.ts:45-52`) that no composition supplies. This part adds an `email` subsystem to every runtime: SMTP settings in the runtime's own System Store with the password encrypted, a durable outbox with bounded retries, a delivery loop owned by the runtime's scope, a test-send operation and a delivery listing, exposed through HTTP, SDK, CLI and the dashboard, for the Platform and (through exact Gateway routes) each App.

- **In scope**: `zelavis/app/email` module, Node SMTP submission client (STARTTLS or implicit TLS, AUTH PLAIN), settings, outbox, worker, endpoints, Gateway routes, SDK, CLI, dashboard cards, docs, tests with a local SMTP fixture.
- **Out of scope**: HTTP-API provider plugins, attachments, bulk or marketing mail, inbound mail, DKIM signing (the submission server signs), bounce processing, the identity messages themselves (parts 3-4).
- **Done means**: (a) `PUT /email/settings` stores SMTP settings and never returns the password; (b) `POST /email/test` enqueues a message that the SMTP fixture receives with correct MIME; (c) a delivery that fails transiently retries on the schedule and ends `failed` after the last attempt; (d) a pending delivery survives runtime restart and is sent once the runtime is back; (e) an App's settings and outbox are independent of the Platform's; (f) JS, HTTP and CLI parity passes `test/capability-parity.test.mjs`; (g) the dashboard cards work at desktop and mobile sizes; (h) `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check` pass.
- **Supplement**: updated in this run (overview section 0).
- **Sources read**: `AGENTS.md § Platform And App Service Boundary`, `§ Endpoint-Backed Capability Rule`, `§ TigerStyle Adaptation`, `§ Effect Version`; the files cited below.

## 1. Context packet

**Glossary.**
- **Runtime System Store**: Platform `<data>/system/zelavis.sqlite`, Project `<project>/.zelavis/runtime/zelavis.sqlite`, both from `packages/zelavis/src/adapters/node.ts:293-304`. Interface `packages/zelavis/src/system-store.ts:26-75`.
- **Delivery**: one outbox record for one message to one recipient.
- **Link base URL**: the operator-set public URL emailed links start with (parts 3-4 use it). Stored with the settings; never derived from a request.

**Governing rules.**
> "Provider tokens are stored encrypted, never returned or logged, and every use is audited." `AGENTS.md § Cloud Capacity And Alchemy`
>
> "Define one domain operation and shared input/output/error schemas, then adapt it to JS, HTTP, and CLI." `AGENTS.md § Endpoint-Backed Capability Rule`
>
> "Validate external and persisted data, preserve typed failures, bound concurrency and growing work, use scoped cleanup, and test failure paths." `AGENTS.md § TigerStyle Adaptation`

**System today.**
- Endpoint groups: `ZelavisEndpointGroup { id, basePath?, api?: Record<version, routes>, context, authenticators?, origin }` (`packages/zelavis/src/core/runtime/contracts.ts:288-299`). The runtime mounts them in `nativeEndpointGroups` (`packages/zelavis/src/index.ts:7763-7775`), next to `identityEndpointGroup` (composed for both roles at `packages/zelavis/src/index.ts:6908-6975`; `projectRole = options.role === "project"` at `:6908`).
- Settings permission convention: `system.settings.manage` (system scope) on the Platform, `project.settings.manage` (Project scope) in a Project (`packages/zelavis/src/app/identity/identity-service.ts:352-359`).
- Encryption: `encryptSecret(value, key)` / `decryptSecret(secret, key)` and `EncryptedSecret` (`packages/zelavis/src/edge/acme-crypto.ts:11`, `:79`, `:104`); per-store secret `loadPlatformMasterSecret(store)` (`packages/zelavis/src/platform/master-secret.ts:19`). Key-derivation pattern `packages/zelavis/src/assistant-provider.ts:133-135`.
- Gateway exact child routes: `registrationSettingsRoutes` (`packages/zelavis/src/platform/project-gateway.ts:670-713`) forwards `GET|PUT /projects/:projectId/auth/registration/settings` to the child's `zelavis/api/v1/auth/registration/settings` with `permissions: ["project.settings.manage"]`.
- SDK: `packages/zelavis/src/sdk/fetch.ts` (`ZelavisAuthClient` at `:350`, implementation at `:2232`; Project client methods around `:1563-1568`). CLI tables: `packages/zelavis/src/cli/auth-operations.ts` (`runTable` pattern), `packages/zelavis/src/cli/projects.ts` (usage string `:10`, `--data` gate `:170`).
- Dashboard: registration card pattern `packages/zelavis/services/zelavis-ui/app/registration-settings.ts:15-60`, used at `packages/zelavis/services/zelavis-ui/app/project-pages.ts:185`; Platform settings screen `packages/zelavis/services/zelavis-ui/app/settings-pages.ts:78`; route list `packages/zelavis/services/zelavis-ui/app/dashboard-routes.ts:7-40`.
- Parity test `packages/zelavis/test/capability-parity.test.mjs` derives operations from the OpenAPI document and requires an SDK method and CLI command for each.

**Pattern to mirror.** The Assistant provider config (`packages/zelavis/src/assistant-provider.ts`): encrypted secret, per-scope key, `hasApiKey`-style public view, never returning the secret. The registration settings route pair (`identity-service.ts:538-590`) for `expectedRevision` CAS and body limits.

**Traps.**
- Sending SMTP inside the request handler: enqueue, answer `202`, let the worker send.
- Building `From`, `To` or `Subject` from unvalidated input: CR or LF in a header is header injection. Validate addresses and reject control characters.
- Logging the SMTP transcript: it contains the password (AUTH) and message bodies (tokens in parts 3-4). Log only status codes.
- `rejectUnauthorized: false` for convenience: never. Tests inject a CA.
- A worker started with `Effect.runFork` outside the runtime scope: it outlives `Zelavis.close()`. Fork it in the runtime's scope.
- Storing message bodies in plaintext: parts 3-4 put tokens in them. Encrypt content.

## 2. Design

**Authority and scope.** Each runtime owns its email state in its own System Store. Platform operations require `system.settings.manage` (system scope); App operations inside the child require `project.settings.manage` for its Project ID; the Gateway forwards only to the exact child routes with `project.settings.manage`. Internal callers (identity, billing) enqueue through the in-process `EmailOutbox` API, never through HTTP.

**Persistence.** Namespace `zelavis.email`:
- key `settings`: `StoredEmailSettings` (section 3), written with `setIfAbsent` when absent and `compareAndSet(ns, "settings", record.updatedAt, next)` otherwise; `revision` increments per change; the request carries `expectedRevision`.
Namespace `zelavis.email.outbox`:
- key `<createdAtMs zero-padded to 15 digits>-<id>`, value `StoredDelivery`. Ordered keys make `page({ limit, after })` return oldest first.

Content (`subject`, `text`, `html`) is one JSON value encrypted as `EncryptedSecret` with key `${masterSecret}\u0000zelavis.email.content`. The SMTP password is encrypted with `${masterSecret}\u0000zelavis.email.smtp`. `masterSecret = loadPlatformMasterSecret(systemStore)` for the runtime's own store.

**State machine of a delivery.** `queued` → (`sending`, leased) → `delivered` | `queued` (retry with `nextAttemptAt`) | `failed`. Attempt schedule after a failed attempt: 1 min, 5 min, 30 min, 2 h, 6 h; the sixth failure is final. A permanent SMTP reply (5xx) is final at once. Lease: `leaseUntil = now + 2 min` written by CAS before sending; an expired lease counts as `queued`.

**Invariants.**
1. At most 1000 deliveries in `queued` or `sending` per runtime; `enqueue` beyond that fails `EmailOutboxFull` (counted from a per-runtime counter record `zelavis.email/outbox-count`, updated by CAS together with each state change in the same call sequence; the worker recounts from a full page walk once per hour to correct drift after a crash).
2. A delivery is sent only while its lease is held by this worker (CAS from `queued`/expired to `sending` with a fresh lease token).
3. Delivery is at least once: a crash after the SMTP server accepted and before the CAS to `delivered` resends after the lease expires. Message-ID stays the delivery ID, so receivers can deduplicate.
4. Terminal deliveries (`delivered`, `failed`) are deleted 7 days after `updatedAt` by the worker's hourly sweep, at most 200 per sweep.
5. The password and message content never leave the runtime except over the SMTP connection.

**Worker.** One fiber per runtime with `mode: "smtp"`, forked into the runtime scope (`Effect.forkScoped` in the composition). It wakes on enqueue (a `Queue.sliding(1)` signal) or every 15 s, pages the outbox 50 at a time from the start, takes due deliveries, sends at most 2 at once (`Effect.forEach(..., { concurrency: 2 })`), and stops on scope close (interrupting an in-flight send, whose lease then expires). Settings are re-read each wake.

**SMTP client** (`packages/zelavis/src/adapters/_node-smtp.ts`). Security `tls` connects with `node:tls` (port default 465); `starttls` connects with `node:net` (default 587), requires `STARTTLS` in the EHLO reply and upgrades, refusing to continue otherwise. Then `EHLO <client name>`, `AUTH PLAIN` when a username is set (refuse if not offered after TLS), `MAIL FROM:<from>`, `RCPT TO:<to>`, `DATA`, the message with dot-stuffing and CRLF, `.`, `QUIT`. Timeouts: connect 10 s, each reply 30 s, whole send 60 s. Reply lines capped at 1000 bytes and 100 lines. Certificates verified with `servername: host`; options accept `ca` for tests only. Message: `multipart/alternative` with `text/plain` and `text/html` parts, each `Content-Transfer-Encoding: base64` in 76-character lines; headers `From`, `To`, `Subject` (RFC 2047 `=?UTF-8?B?...?=` when non-ASCII), `Date`, `Message-ID: <deliveryId@fromDomain>`, `MIME-Version: 1.0`. A 4xx reply is `transient`, 5xx is `permanent`, network or timeout is `transient`.

**Failure model.**

| Tag (NEW) | When | HTTP |
| --- | --- | --- |
| `EmailSettingsInvalid` | body fails schema, bad address, header control characters | 400 `invalid_email_settings` |
| `EmailSettingsConflict` | `expectedRevision` differs | 409 `email_settings_conflict` |
| `EmailDisabled` | test send or enqueue while `mode: "disabled"` | 409 `email_disabled` |
| `EmailOutboxFull` | 1000 pending | 429 `email_outbox_full` |
| `EmailUnavailable` | store or master secret unavailable | 503 `email_unavailable` |
| `SmtpFailure { kind: "transient" \| "permanent", code?: number }` | worker only; stored on the delivery as `lastError` text without the transcript | not returned by HTTP |

SDK rejects with the existing error type carrying `status` and `code`; CLI prints the `{ error, code }` body and exits 1, as the existing tables do.

**Decisions and rejected alternatives.**
- In-house SMTP client over nodemailer: no new dependency; this subset is small and testable. Rejected an email plugin capability for now: SMTP covers the providers.
- Encrypted content in the outbox over plaintext: tokens.
- System Store outbox over the Project database for Apps: the database is App data with Tenant semantics; mail is runtime plumbing, backed up with the runtime component.

**Decisions taken for the user.** Default `mode: "disabled"`. Retention 7 days for terminal deliveries. Recipients are shown to the operator in the listing; content never is.

**Needs from the user.** None.

## 3. Contracts

**NEW** `packages/zelavis/src/app/email/contracts.ts` (Effect `Schema`, strict decode `{ onExcessProperty: "error" }`):

```ts
const Address = Schema.String.check(Schema.isBetweenLength(3, 254), Schema.isPattern(/^[^\s@<>()",;:\\[\]\x00-\x1f]+@[^\s@<>()",;:\\[\]\x00-\x1f]+\.[^\s@<>()",;:\\[\]\x00-\x1f]+$/u));
const DisplayName = Schema.String.check(Schema.isMaxLength(100), Schema.isPattern(/^[^\x00-\x1f\x7f]*$/u));
export const EmailSettingsInputSchema = Schema.Struct({
  expectedRevision: Schema.Natural,
  mode: Schema.Literals(["disabled", "smtp"]),
  from: Schema.optional(Schema.Struct({ address: Address, name: Schema.optional(DisplayName) })),
  linkBaseUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))), // https:// or http://localhost / 127.0.0.1 only; no query or fragment
  smtp: Schema.optional(Schema.Struct({
    host: Schema.String.check(Schema.isBetweenLength(1, 253)),
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    security: Schema.Literals(["starttls", "tls"]),
    username: Schema.optional(Schema.String.check(Schema.isBetweenLength(1, 256))),
    /** Absent keeps the stored password; "" removes it. */
    password: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  })),
});
// mode "smtp" requires from, linkBaseUrl and smtp (checked after decode → EmailSettingsInvalid).
export interface EmailSettings {
  readonly revision: number;
  readonly mode: "disabled" | "smtp";
  readonly from?: { readonly address: string; readonly name?: string };
  readonly linkBaseUrl?: string;
  readonly smtp?: { readonly host: string; readonly port: number; readonly security: "starttls" | "tls"; readonly username?: string; readonly hasPassword: boolean };
  readonly updatedAt?: string;
}
export const EmailTestInputSchema = Schema.Struct({ to: Address });
export interface EmailDelivery {
  readonly id: string;
  readonly to: string;
  readonly kind: EmailKind;
  readonly state: "queued" | "sending" | "delivered" | "failed";
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextAttemptAt?: string;
  readonly lastError?: string; // one of "SMTP <3-digit code>", "timeout", "connection failed", "tls failed", "starttls unavailable", "auth unavailable"
}
export type EmailKind = "test" | "email-verification" | "password-recovery" | "invitation" | "billing";
export interface EmailDeliveryPage { readonly deliveries: readonly EmailDelivery[]; readonly next?: string }
export interface EmailMessage { readonly to: string; readonly kind: EmailKind; readonly subject: string; readonly text: string; readonly html: string }
/** In-process API other subsystems use. */
export interface EmailOutbox {
  enqueue(message: EmailMessage): Effect.Effect<{ readonly id: string }, EmailDisabled | EmailOutboxFull | EmailUnavailable>;
  /** The configured link base, or undefined when email is disabled. */
  linkBase(): Effect.Effect<URL | undefined, EmailUnavailable>;
}
```

Persisted (strict, `schemaVersion: 1`):

```ts
interface StoredEmailSettings { schemaVersion: 1; revision: number; mode: "disabled" | "smtp"; from?: {...}; linkBaseUrl?: string;
  smtp?: { host: string; port: number; security: "starttls" | "tls"; username?: string; password?: EncryptedSecret }; updatedAt: string }
interface StoredDelivery { schemaVersion: 1; id: string; to: string; kind: EmailKind; state: EmailDelivery["state"]; attempts: number;
  content: EncryptedSecret; createdAt: string; updatedAt: string; nextAttemptAt?: string; leaseToken?: string; leaseUntil?: string; lastError?: string }
```

Limits: subject ≤ 200 characters, text ≤ 64 KiB, html ≤ 128 KiB.

| HTTP (relative to the API base) | Access | SDK | CLI (`--json`) |
| --- | --- | --- | --- |
| `GET /email/settings` → 200 `EmailSettings` | settings permission | `client.email.settings()` | `zelavis email settings` |
| `PUT /email/settings` body `EmailSettingsInput` (≤ 8 KiB) → 200 `EmailSettings` | settings permission | `client.email.setSettings(input)` | `zelavis email set-settings --data JSON` |
| `POST /email/test` body `{ to }` → 202 `{ id }` | settings permission | `client.email.sendTest(to)` | `zelavis email test ADDRESS` |
| `GET /email/deliveries?limit=1..100&after=CURSOR` → 200 `EmailDeliveryPage` | settings permission | `client.email.deliveries({ limit?, after? })` | `zelavis email deliveries [--limit N] [--after CURSOR]` |
| `GET\|PUT /runtime/projects/:projectId/email/settings` | `project.settings.manage` (Project scope) | `client.projects.emailSettings(id)`, `.setEmailSettings(id, input)` | `zelavis projects email-settings PROJECT`, `set-email-settings PROJECT --data JSON` |
| `POST /runtime/projects/:projectId/email/test` | same | `client.projects.sendTestEmail(id, to)` | `zelavis projects send-test-email PROJECT ADDRESS` |
| `GET /runtime/projects/:projectId/email/deliveries` | same | `client.projects.emailDeliveries(id, { limit?, after? })` | `zelavis projects email-deliveries PROJECT [--limit N] [--after CURSOR]` |

"settings permission" = `system.settings.manage` (system scope) on the Platform, `project.settings.manage` for its Project ID in an App. Dashboard: Platform `/settings/email` (NEW route), App card on `/projects/:projectId/auth`.

## 4. Execution steps

### 1. Prove the baseline at HEAD

- **Goal**: the suites this part touches pass before editing.
- **Files**: none.
- **Depends on**: none.
- **Check**: from the root `pnpm --filter zelavis run build; echo "exit $?"`, then `pnpm --filter zelavis exec node --test --test-reporter=dot test/capability-parity.test.mjs test/identity-registration.test.mjs test/platform-auth-parity.test.mjs; echo "exit $?"`; both `exit 0`.

### 2. Define email contracts and schemas

- **Goal**: section 3's schemas, types and tagged errors exist and decode strictly.
- **Files**: **NEW** `packages/zelavis/src/app/email/contracts.ts`, **NEW** `packages/zelavis/src/app/email/errors.ts`, **NEW** `packages/zelavis/src/app/email/index.ts` (re-exports); `packages/zelavis/package.json` exports: add `"./app/email": { "types": "./dist/app/email/index.d.ts", "import": "./dist/app/email/index.js" }` after `"./app/identity"` (`package.json:63-66`).
- **Context**: errors use `Data.TaggedError` as `ProjectDomainError` does (`packages/zelavis/src/edge/project-domains.ts:125-129`). Imports: `import * as Schema from "effect/Schema"; import * as Data from "effect/Data"; import type * as Effect from "effect/Effect"; import type { EncryptedSecret } from "../../edge/acme-crypto.js";`.
- **Change**: write the schemas, `decodeEmailSettingsInput`, `decodeEmailTestInput`, `validateLinkBaseUrl(value): URL | undefined` (https, or http with host `localhost`/`127.0.0.1`/`[::1]`; no query, no fragment; path kept), and `emailSettingsJsonSchema`/`emailSettingsInputJsonSchema` via `Schema.toJsonSchemaDocument` as `registration.ts:76-83` does.
- **Depends on**: 1.
- **Check**: `pnpm --filter zelavis run build; echo "exit $?"` prints `exit 0`; schema cases are tested in step 6.

### 3. Add the SMTP fixture and the Node SMTP client

- **Goal**: a tested SMTP submission client per section 2.
- **Files**: **NEW** `packages/zelavis/src/adapters/_node-smtp.ts`; **NEW** `packages/zelavis/test/_smtp-server.mjs`; **NEW** `packages/zelavis/test/smtp-client.test.mjs`.
- **Context**: test certificates are made with `openssl` the way `packages/zelavis/test/project-failover.test.mjs` does (read it for the exact command); the fixture serves STARTTLS and implicit TLS with that certificate and the client gets `ca`.
- **Change**: export `sendSmtp(options: { host, port, security, username?, password?, clientName: string, ca?: string | Buffer, timeouts?: { connectMs, replyMs, totalMs } }, envelope: { from: string, to: string, data: Uint8Array }): Effect.Effect<{ code: number }, SmtpFailure>` and `buildMimeMessage({ id, from, fromName?, to, subject, text, html, date }): Uint8Array`. Socket in `Effect.acquireRelease`, reply parser bounded per section 2. The fixture `startSmtpServer(t, { tls: "starttls" | "implicit", requireAuth?: { username, password }, reply?: (command) => string | undefined })` records `messages: Array<{ from, to, data: string }>` and `commands`, closes in `t.after`.
- **Depends on**: 2.
- **Check**: build, then `pnpm --filter zelavis exec node --test test/smtp-client.test.mjs; echo "exit $?"` prints `exit 0` with section 5's cases.

### 4. Add encrypted settings storage

- **Goal**: read and write `StoredEmailSettings` with CAS and encryption.
- **Files**: **NEW** `packages/zelavis/src/app/email/settings.ts`.
- **Context**: `ZelavisSystemStore` methods may return values or Promises (`system-store.ts:26-75`); wrap each call with `integration(() => store.get(...))` from `../../core/runtime/effect-boundary.js`.
- **Change**: `createEmailSettingsStore(store, masterSecret)` with `read(): Effect<StoredEmailSettings | undefined>`, `publicView(stored): EmailSettings` (`hasPassword` only), and `update(input): Effect<EmailSettings, EmailSettingsInvalid | EmailSettingsConflict | EmailUnavailable>` (absent password keeps, `""` removes). Validate persisted records on read with the strict schema; an invalid record fails `EmailUnavailable` (fail closed).
- **Depends on**: 2.
- **Check**: covered by step 6 tests.

### 5. Add the durable outbox and delivery loop

- **Goal**: `EmailOutbox` and the worker per section 2.
- **Files**: **NEW** `packages/zelavis/src/app/email/outbox.ts`, **NEW** `packages/zelavis/src/app/email/email-service.ts`.
- **Context**: the worker takes the transport as a parameter (`send: (settings, message) => Effect<void, SmtpFailure>`) so `email-service.ts` stays runtime-neutral and the Node adapter supplies `sendSmtp`. Imports `effect/Effect`, `effect/Queue`, `effect/Schedule`, `effect/Data` modules (not the barrel, matching new code in `src/edge`).
- **Change**: implement `createEmailOutbox({ store, masterSecret, now })` and `runEmailWorker({ store, masterSecret, settings, send, now }): Effect<never, never, Scope>`; `createEmailSubsystem({ store, send, now? })` returns `{ outbox: EmailOutbox, worker: Effect<...>, endpointGroup: ZelavisEndpointGroup }` (endpoint routes added in step 6). All loops paged and bounded (section 2).
- **Depends on**: 3, 4.
- **Check**: covered by step 6 tests.

### 6. Expose the email endpoint group on every runtime

- **Goal**: section 3's `/email/*` routes on the Platform and in each App runtime, with the worker in the runtime scope.
- **Files**: `packages/zelavis/src/app/email/email-service.ts`; `packages/zelavis/src/index.ts:6908-6975` (composition) and `:7763-7775` (mount list); `packages/zelavis/src/adapters/node.ts` (pass `send: sendSmtp`); **NEW** `packages/zelavis/test/email-service.test.mjs`.
- **Context**: route shape and access mirror `identity-service.ts:538-590` (`access: { permissions: [...], scope }`, `maxRequestBodyBytes`, `invalidJsonBodyCode`, `spec` with schemas, handlers returning `{ status, headers: noStore, body }`). The App's Project ID is `options.serviceContext?.platform?.metadata.projectId` (`index.ts:6933-6945`). Add a `subsystems.email?: false | { send?: ... }` option on the composition beside `subsystems.auth`; the Node adapter supplies `send`. Fork the worker with `Effect.forkScoped` inside the composition's scope.
- **Change**: build the endpoint group with `origin: { type: "subsystem", subsystem: "email" }`, `basePath: "/email"`, routes `email.settings.get`, `email.settings.set`, `email.test.send`, `email.deliveries.list`. Push it into `nativeEndpointGroups`. Expose `email: EmailOutbox | undefined` on the composition's internal context so identity (part 3) can reach it.
- **Depends on**: 5.
- **Check**: build, then `pnpm --filter zelavis exec node --test test/email-service.test.mjs; echo "exit $?"` prints `exit 0` (section 5).

### 7. Add the exact Project Gateway routes

- **Goal**: Platform operators manage one App's email through the Gateway.
- **Files**: `packages/zelavis/src/platform/project-gateway.ts` (beside `registrationSettingsRoutes`, `:670-713`); `packages/zelavis/test/email-service.test.mjs`.
- **Change**: add `emailRoutes` for `GET|PUT /projects/:projectId/email/settings`, `POST /projects/:projectId/email/test`, `GET /projects/:projectId/email/deliveries`, each forwarding to `zelavis/api/v1/email/...` with `permissions: ["project.settings.manage"]`, `allowFrontend: false`, query passed through only for `limit` and `after`. Include them in the returned route list where `registrationSettingsRoutes` is.
- **Depends on**: 6.
- **Check**: rebuild; the Gateway cases in `email-service.test.mjs` pass.

### 8. Add SDK and CLI parity

- **Goal**: section 3's SDK methods and CLI commands.
- **Files**: `packages/zelavis/src/sdk/fetch.ts` (new `ZelavisEmailClient` interface and `email:` property on the client; Project methods next to `setRegistrationSettings` at `:1567`); **NEW** `packages/zelavis/src/cli/email-operations.ts` (a `CliTable` like `auth-operations.ts`); `packages/zelavis/src/cli/commands.ts` (route `zelavis email` to it; read the file for how `auth` is routed); `packages/zelavis/src/cli/projects.ts` (usage `:10`, positional count `:146`, `--data` gate `:170`, new `case`s).
- **Change**: implement as listed; the CLI uses `bodyFlag`/`required` from `./command-table.js`. Types import from `../app/email/index.js`.
- **Depends on**: 7.
- **Check**: rebuild, `pnpm --filter zelavis exec node --test test/capability-parity.test.mjs test/email-service.test.mjs; echo "exit $?"` prints `exit 0`.

### 9. Add the dashboard settings cards

- **Goal**: operators configure email in the dashboard.
- **Files**: **NEW** `packages/zelavis/services/zelavis-ui/app/email-settings.ts`; `packages/zelavis/services/zelavis-ui/app/settings-pages.ts:78` (route `/settings/email`); `packages/zelavis/services/zelavis-ui/app/project-pages.ts:185` (card under the registration card); `packages/zelavis/services/zelavis-ui/app/dashboard-routes.ts` (add `"/settings/email"`); the settings navigation entry (find where `/settings/appearance` is linked with `rg -n "settings/appearance" packages/zelavis/services/zelavis-ui/app`); `packages/zelavis/services/zelavis-ui/scripts/test-route-parity.mjs`.
- **Context**: mirror `registration-settings.ts:15-60`: decode with `Schema`, `expectedRevision`, conflict message, `context.run`. Password input `type="password"`, empty means keep, a "Remove password" checkbox sends `""`. A "Send test email" form and a deliveries table (state, recipient, attempts, last error). Native Fuzor DOM only (`./dom.ts`, `./page-kit.ts`).
- **Change**: implement `emailSettingsCard(context, projectId?)`; Platform path `${basePath}/email/...`, Project path `${basePath}/runtime/projects/${id}/email/...`.
- **Depends on**: 8.
- **Check**: `pnpm --filter @zelavis/ui typecheck; echo "exit $?"`, `pnpm --filter @zelavis/ui test; echo "exit $?"`, then `pnpm run ci:ui; echo "exit $?"`; all `exit 0`, with the browser cases in section 5.

### 10. Document email delivery

- **Goal**: operators know how to configure email and what it guarantees.
- **Files**: **NEW** `website/src/content/docs/guides/email-delivery.md`; `website/src/content/docs/api/platform-operations.md` (add the operations); `website/astro.config.mjs` sidebar if guides are listed explicitly (check).
- **Change**: settings fields, STARTTLS vs TLS, link base URL purpose, at-least-once delivery and Message-ID, retry schedule, 1000 pending limit, 7-day retention, per-App independence, all three transport forms.
- **Depends on**: 9.
- **Check**: `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 11. Self-audit

- **Goal**: Done means holds.
- **Change**: section 8 self-audit list.
- **Check**: `pnpm run verify; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, `git diff --check; echo "exit $?"`; all `exit 0`.

## 5. Tests

`test/smtp-client.test.mjs` (fixture `_smtp-server.mjs`):
- STARTTLS with AUTH: message arrives; `commands` show `EHLO`, `STARTTLS`, `AUTH PLAIN` after TLS; data has `Content-Type: multipart/alternative`, both parts base64, `Message-ID: <id@from-domain>`.
- Implicit TLS works on its own port.
- Server without STARTTLS while `security: "starttls"` → `SmtpFailure` `permanent`, no `AUTH` sent in the clear (assert `commands`).
- 451 on `RCPT` → `transient` with `code: 451`; 550 → `permanent`.
- Silent server → `transient` within `replyMs`.
- Dot-stuffing: a text line starting with `.` arrives intact.
- Non-ASCII subject encodes as RFC 2047 and decodes back.
- Header injection: subject containing `\r\nBcc:` is refused before connecting.

`test/email-service.test.mjs` (Platform via `platform` from `./_runtime.mjs`, a Project runtime via the composition used by `test/identity-registration.test.mjs:36`):
- Settings CAS: PUT with revision 0 succeeds, a second PUT with 0 → 409 `email_settings_conflict`; GET never contains `password`, shows `hasPassword: true`; raw store record holds an `EncryptedSecret`, not the plaintext.
- `mode: "smtp"` without `linkBaseUrl` → 400; `linkBaseUrl: "http://example.com"` → 400; `"https://panel.example.com/zelavis"` accepted.
- Test send → 202; fixture receives one message; deliveries shows `delivered`.
- Retry: fixture answers 451 twice then accepts; with an injected clock the delivery goes `queued` (attempt 1), `queued` (2), `delivered`; `nextAttemptAt` matches 1 min then 5 min.
- Final failure: 550 → `failed` after one attempt with `lastError: "SMTP 550"`.
- Restart: enqueue with the fixture stopped; close the runtime; restart against the same store with the fixture up; message arrives once.
- Lease: two workers over one memory store and one fixture send a message once.
- Outbox full: 1000 queued → the next enqueue fails 429 `email_outbox_full`.
- Authorization: anonymous → 401; a customer without `system.settings.manage` → 403.
- App independence: the Platform and one App configure different fixtures; each test send reaches only its own fixture; the Gateway route needs `project.settings.manage` on that exact Project (another Project's grant → 403).
- Parity: SDK and CLI give the same results as HTTP for settings get/set and test send.

Browser (`packages/zelavis/services/zelavis-ui/scripts/test-route-parity.mjs`): visit `/settings/email` at 1440×1000 and 390×844; fill SMTP settings pointing at a fixture started by the script, save, wait for "Email settings saved.", send a test, wait for the delivery row to show "Delivered". On `/projects/parity-lab/auth` the App card loads and saves. Add `"/settings/email"` to `dashboard-routes.ts` so the parity loop visits it.

## 6. Docs and project notes

`website/src/content/docs/guides/email-delivery.md` (NEW), `website/src/content/docs/api/platform-operations.md`, `packages/zelavis/README.md` if it lists subsystems (check). No `pnotes/TODO.md` additions.

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
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims; silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; literal unlimited Effect concurrency; unchecked `JSON.parse` casts; new `async` functions, `new Promise` or Promise coordination in Platform code, and any growth of `scripts/effect-migration-baseline.json`; `node:` imports outside `src/adapters` (and the CLI); the `effect` barrel in files the Project persistent host loads; React for a dashboard page; edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`; secrets or message bodies in logs, responses or security events. Never edit generated output. Do not commit, push or publish unless told to.
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
