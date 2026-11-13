# Email verification and password recovery

Job: Prove email ownership for password accounts and deliver password recovery by email, with single-use tokens, on the Platform and in each native App.
Date: 2026-11-13
Status: planned
Verified-at: b04fa02d95
Part: 3 of 14. Read 00-overview.md first.

To start:    Execute part 3 in .agents/plans/2026-11-13-accounts-billing-domain-automation/03-email-verification-and-password-recovery.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/03-email-verification-and-password-recovery.md. Start with its section 8.

## Progress

- [ ] 1. Confirm part 2's handover and the identity baseline.
- [ ] 2. Add the single-use account token repository.
- [ ] 3. Add account messages and the provider API additions.
- [ ] 4. Move password recovery onto tokens and email.
- [ ] 5. Add email verification and the registration policy field.
- [ ] 6. Expose the operations and the App public routes.
- [ ] 7. Add SDK and CLI parity.
- [ ] 8. Add Platform dashboard pages.
- [ ] 9. Add App site pages.
- [ ] 10. Document verification and recovery.
- [ ] 11. Self-audit.

## 0. Summary and finish line

Password accounts are created with `verified: false` and nothing ever proves the email (`packages/zelavis/src/app/identity/domain/entities.ts:8`). Recovery stores a hashed token in credential metadata and reads, compares and writes it non-atomically (`packages/zelavis/src/app/identity/providers/password.ts:171-233`), so two concurrent completions can both succeed, and the token is only delivered through a callback nobody wires. This part adds a single-use token repository with an atomic consume, builds verification and recovery emails on part 2's outbox, adds a runtime policy that can require verified email before sign-in, and adds the public pages on the Platform and on App origins.

- **In scope**: `accountTokens` repository (in-memory, System Store, Project database) with atomic `consume`, the identity `AccountMessages` port, recovery and verification flows, the `emailVerification` policy, routes, App public allowlist, SDK, CLI, dashboard and App pages, docs, tests.
- **Out of scope**: invitations (part 4, reuses the repository), MFA challenges (part 5), changing an account's email address (needs a second verification flow; recorded as a limit), magic-link sign-in.
- **Done means**: (a) password signup with an email address enqueues a verification email whose link verifies the account once; (b) with `emailVerification: "required"`, an unverified account gets `403 email_verification_required` at sign-in and at signup gets no session; owner and service accounts are exempt; (c) recovery emails a link; completing it twice concurrently succeeds exactly once and ends all sessions; (d) responses never reveal whether an account exists; (e) the same flows work on an App origin and only there for that App; (f) parity, browser, `verify`, `ci:ui` and `docs:check` pass.
- **Supplement**: updated in this run (overview section 0).
- **Sources read**: `AGENTS.md § Core Access-Control Rule`, `§ Endpoint-Backed Capability Rule`, `§ UI Package Rules`; part 2 of this plan; files below.

## 1. Context packet

**Glossary.**
- **Account token**: a high-entropy random string (32 bytes, base64url) emailed to a person; only its SHA-256 base64url hash is stored, keyed by that hash.
- **Purpose**: `"email-verification" | "password-recovery"` here; parts 4-5 add `"invitation"` and `"mfa-challenge"` / `"mfa-enrollment"`.
- **Consume**: atomically delete a valid token and return it; at most one caller ever receives it.
- **Link base**: `EmailOutbox.linkBase()` from part 2, the operator-set `linkBaseUrl`.

**Governing rules.**
> "Identity guarantees hold under concurrency, so they live in the repository, not in a check made first. … Any new identity repository must implement `mutate` and the claim primitives and pass `test/identity-atomicity.test.mjs`." `AGENTS.md § Core Access-Control Rule`
>
> "Everything that can survive a reload must be in the URL (`context.setSearch`)." `AGENTS.md § UI Package Rules` (the reset token is the exception: it lives in the fragment and is cleared from the address bar after reading, because it is a secret and must not survive a reload).

**System today.**
- Repositories contract `packages/zelavis/src/app/identity/contracts/repositories.ts:93-101` (`IdentityRepositories`), backends: in-memory `packages/zelavis/src/app/identity/storage/in-memory.ts:261`, Project database `packages/zelavis/src/app/identity/storage/database.ts:303`, Platform System Store `packages/zelavis/src/platform/auth-repositories.ts:122` (namespace `zelavis.platform.auth`, `:31`; CAS helpers `:86-150`).
- Provider contract `packages/zelavis/src/app/identity/contracts/credential-provider.ts:36-127` (`CredentialRecoveryStartInput`, `CredentialRecoveryCompleteInput`, `CredentialProviderApi`, `beginRecovery`, `completeRecovery`).
- `AuthenticationService.providerApi()` `packages/zelavis/src/app/identity/services/authentication-service.ts:116-146`; `listRecoveryProviders` `:100`; `beginRecovery` `:287`; `completeRecovery` `:303`; `authenticate` `:340`.
- Recovery routes `packages/zelavis/src/app/identity/identity-service.ts:621-637` (`GET /recovery/providers`) and `:755-800` (`POST /recovery/:provider`, `POST /recovery/:provider/complete`); signup route `:589-620` (always issues a session today).
- Registration policy `packages/zelavis/src/app/identity/domain/registration.ts:7-23` (`RegistrationSettingsSchema { enabled, revision }`, `SetRegistrationSettingsInputSchema { enabled, expectedRevision }`) and `:37-58` (`RegistrationControlSchema`, `schemaVersion: 1`); `setSettings` `packages/zelavis/src/app/identity/services/registration-service.ts:164-176`; enrollment issues the session at `:446`.
- App public allowlist `packages/zelavis/src/platform/project-public-auth.ts:11-17`; App pages `packages/zelavis/services/zelavis-ui/src/identity-frontend-service.ts:7` (`identityPagePaths = ["/login", "/sign-up"]`); browser code `packages/zelavis/services/zelavis-ui/app/identity-site.ts:12` (operation allowlist).
- Platform public pages `packages/zelavis/services/zelavis-ui/src/auth-routes.ts:1-3` (`isPublicAuthPath`), screens `packages/zelavis/services/zelavis-ui/app/auth-pages.ts:28` (`loginScreen`), `:54` (`signUpScreen`); routes `packages/zelavis/services/zelavis-ui/app/dashboard-routes.ts:7-12`.
- SDK `packages/zelavis/src/sdk/fetch.ts:366-369` (`recoveryProviders`, `beginRecovery`, `completeRecovery`) and `:2276-2278`; CLI `packages/zelavis/src/cli/auth-operations.ts:26-28`.
- Atomicity tests `packages/zelavis/test/identity-atomicity.test.mjs`; registration tests run each backend (`packages/zelavis/test/identity-registration.test.mjs:25-29`).
- Part 2 handover: `EmailOutbox` (`packages/zelavis/src/app/email/contracts.ts`), exposed on the composition context in `packages/zelavis/src/index.ts` (part 2 step 6). Check it exists before starting.

**Pattern to mirror.** Atomic claims in `packages/zelavis/src/platform/auth-repositories.ts:86-120` (`setIfAbsent`, `compareAndDelete` with `updatedAt`). The password provider's decoy verify for equal timing (`password.ts:30-38`).

**Traps.**
- Reading the token record, checking it, then deleting it: two winners. Use `consume`.
- Putting the token in the query string: it reaches server logs and `Referer`. Use `#token=`, and remove it from the address bar after reading (`history.replaceState`).
- Answering recovery or resend differently for unknown identifiers (status, body or timing): always `202 { accepted: true }`; do the token issue and enqueue off the response path's timing-sensitive part (enqueue is a store write in both branches: for unknown identifiers write nothing but still run one hash).
- Verifying an account whose email changed since the token was issued: bind the token to the email and compare.
- Blocking owner sign-in by the new policy: exempt `owner` role and service principals.
- Changing `RegistrationControlSchema` incompatibly: the record exists in released alpha.45 installs. Add the new field as `Schema.optional`, absent meaning `"optional"`. That is a new optional setting, not a shim.

## 2. Design

**Authority and scope.** Tokens, policy and accounts are owned by each runtime's identity repositories. Public operations (verify, resend, recover, complete) need no principal and are rate limited. The policy is changed through the existing registration settings operation (`system.settings.manage` / `project.settings.manage`).

**Persistence.** **NEW** `AccountTokenRepository` on `IdentityRepositories.accountTokens`:

```ts
export interface AccountToken {
  tokenHash: string;
  purpose: "email-verification" | "password-recovery";
  accountId: string;
  credentialId?: string;   // recovery: the password credential
  email?: string;          // verification: the address proven
  createdAt: Date;
  expiresAt: Date;
}
export interface AccountTokenRepository {
  /** Fails IdentityConflictError if the hash exists (never overwrites). */
  create(token: AccountToken): Promise<AccountToken>;
  /** Atomically deletes and returns the token when it exists, has `purpose` and `expiresAt > now`; otherwise returns null and leaves an expired one for the sweep. */
  consume(tokenHash: string, purpose: AccountToken["purpose"], now: Date): Promise<AccountToken | null>;
  /** Deletes up to `limit` expired tokens; returns how many. */
  sweep(now: Date, limit: number): Promise<number>;
}
```

System Store: namespace `zelavis.platform.auth`, key `token:<hash>`, consume = `get` then `compareAndDelete(ns, key, record.updatedAt, record.value)` (the exact-value compare makes it single-winner). Project database: the same record shape in the identity storage collection used by `database.ts` (read it to find the collection and its conditional delete). In-memory: a `Map` with synchronous delete. TTLs: verification 24 h, recovery 30 min. Sweep: hourly from the identity subsystem's scope, 200 per run.

**Policy.** `RegistrationSettingsSchema` and `SetRegistrationSettingsInputSchema` gain `emailVerification: Schema.optional(Schema.Literals(["optional", "required"]))`; output always includes it (absent stored → `"optional"`). `RegistrationControlSchema` gains the same optional field. A change bumps `revision` as `enabled` does.

**Flows.**
1. *Signup*: after `enroll` commits, when the account has an email and `EmailOutbox.linkBase()` is defined, issue a verification token and enqueue `email-verification` to that address. With `required`, `signUp` returns `{ account, credential, verificationRequired: true }` and **no session**; the route answers `201` without `set-cookie`. Enqueue failure does not undo the account (it can resend).
2. *Resend* `POST /auth/email/verification { identifier }`: public, `202 { accepted: true }` always; issues and enqueues only for an existing unverified account with an email. Rate limit through `AuthAttemptRepository` (`repositories.ts:64-71`): key `sha256("verify:" + identifier)`, 5 per hour; and a runtime-wide 60 per minute key.
3. *Verify* `POST /auth/email/verify { token }`: consume `email-verification`; `accounts.mutate(id, a => a && a.email === token.email ? { ...a, verified: true, updatedAt: now } : a)`; answer `200 { verified: true }` when changed, `400 invalid_token` otherwise. No session is issued.
4. *Sign-in gate*: providers create sessions through `api.sessions.create` (`password.ts:161`), and enrollment creates one at `registration-service.ts:446`. Put the gate in one function, `assertSessionAllowed(account)` (NEW, `services/authentication-service.ts`), called by `providerApi().sessions.create` (`authentication-service.ts:116-146`) before it creates anything, by the OAuth completion path (`:199`) and by enrollment before `:446`. It fails `AuthEmailVerificationRequired` (403 `email_verification_required`) when the policy is `required`, the account has an email, `verified` is false, and the account is neither `owner` nor a service principal. No session is ever created and then revoked. For enrollment under `required`, the gate's failure becomes the `verificationRequired: true` result instead of an error.
5. *Recovery begin* (password provider): normalize identifier; find credential; resolve the account's email (identifier if it contains `@`, else `account.email`); if both exist and messages are available, issue `password-recovery` bound to `credentialId` and enqueue. Always `202 { accepted: true }`. Same rate limits as resend with prefix `recover:`.
6. *Recovery complete*: consume `password-recovery`; load the credential by `credentialId`; refuse if absent; `hashPassword`; `credentials.update` with the new hash; `sessions.revokeAll(accountId)`; mark the account `verified: true` when the token was sent to `account.email` (the person proved the inbox). Wrong or used token → `400 invalid_token` (one message).
7. *Recovery availability*: `GET /auth/recovery/providers` lists `password` only while `EmailOutbox.linkBase()` resolves (email `mode: "smtp"`).

Links: `new URL("verify-email", base)` and `new URL("reset-password", base)` where `base` is `linkBase` with a trailing slash, plus `#token=<token>`. Message bodies: plain text and HTML (escaped), naming the runtime (`from.name` or "Zelavis") and the expiry, no tracking.

**Invariants.**
1. A token is used at most once (repository `consume`).
2. Verification sets `verified` only for the email the token was issued to.
3. A completed recovery invalidates every earlier session (`revokeAll` bumps `sessionEpoch`, `entities.ts:17-23`).
4. Public responses for resend and recovery are identical for existing and unknown identifiers.

**Failure model.** NEW tags in `packages/zelavis/src/app/identity/core/errors.ts`: `AuthInvalidTokenError` → 400 `invalid_token`; `AuthEmailVerificationRequiredError` → 403 `email_verification_required`; rate limit reuses the existing rate-limit error (find it in `core/errors.ts`) → 429. Map them in `authErrorResponse` (find with `rg -n "function authErrorResponse" packages/zelavis/src/app/identity`).

**Concurrency, bounds, interruption.** Consume is the only gate. A crash after consume and before the credential update leaves the old password valid and the token used; the person requests another. A crash after the update and before `revokeAll` leaves old sessions until their expiry: run `revokeAll` before `credentials.update`? No: revoking first and crashing would lock nobody out but leave the old password. Order: update password, then revoke; document the window. Sweeps are bounded. Rate limits use existing repository mutation.

**Deleted.** `RECOVERY_METADATA_KEY`, `recoveryTokenHash`'s metadata storage and `PasswordProviderOptions.recovery.deliver` in `password.ts` (replaced by tokens and messages). No fallback reading old metadata; any leftover metadata is ignored and dropped on the next credential update.

**Decisions and rejected alternatives.** A dedicated `consume` over generic `mutate`: `mutate` returns the post-state, which cannot tell "consumed" from "absent". No session from email links: a link in a mailbox must not be a login. Fragment tokens: no log or `Referer` leak.

**Decisions taken for the user.** Default `emailVerification: "optional"`. Recovery TTL 30 minutes, verification 24 hours. Completing recovery also verifies the email.

**Needs from the user.** None.

## 3. Contracts

| HTTP (relative to the API base) | Access | SDK | CLI (`--json`) |
| --- | --- | --- | --- |
| `POST /auth/email/verify` `{ token }` → 200 `{ verified: true }` / 400 `invalid_token` | public | `client.auth.verifyEmail(token)` | `zelavis auth verify-email --data '{"token":"…"}'` |
| `POST /auth/email/verification` `{ identifier }` → 202 `{ accepted: true }` | public | `client.auth.resendVerification(identifier)` | `zelavis auth resend-verification --data JSON` |
| `POST /auth/recovery/password` `{ identifier }` → 202 (existing route, new behavior) | public | existing `client.auth.beginRecovery("password", input)` | existing `zelavis auth recover password --data JSON` |
| `POST /auth/recovery/password/complete` `{ token, password }` → 204 / 400 `invalid_token` | public | existing `client.auth.completeRecovery("password", input)` | existing `zelavis auth complete-recovery password --data JSON` |
| `GET/PUT /auth/registration/settings` gains `emailVerification` | settings permission | existing | existing |
| `POST /auth/sign-up/password` → 201 `{ account, credential, verificationRequired?: true, session? }` | public | `ZelavisAuthSessionResult.session` becomes optional, `verificationRequired?: true` added | existing |

`CredentialRecoveryCompleteInput` changes from `{ identifier, token }` to `{ token: string; password: string }` (the token names the credential). Request bodies ≤ 4096 bytes, token string 43 characters base64url.

`CredentialProviderApi` gains:

```ts
tokens: {
  issue(input: { purpose: AccountToken["purpose"]; accountId: string; credentialId?: string; email?: string; ttlMs: number }): Promise<{ token: string; expiresAt: Date }>;
  consume(token: string, purpose: AccountToken["purpose"]): Promise<AccountToken | null>;
};
messages?: { send(input: { kind: "email-verification" | "password-recovery"; to: string; token: string; expiresAt: Date }): Promise<void> };
```

App public allowlist adds `POST /auth/email/verify`, `/auth/email/verification`, `/auth/recovery/password`, `/auth/recovery/password/complete`, `GET /auth/recovery/providers`; pages `/forgot-password`, `/reset-password`, `/verify-email`. Platform public pages add the same three paths.

## 4. Execution steps

### 1. Confirm part 2's handover and the identity baseline

- **Goal**: `EmailOutbox` exists and identity suites pass.
- **Files**: none.
- **Change**: `rg -n "export interface EmailOutbox" packages/zelavis/src/app/email` must find it; read part 2's execution report.
- **Depends on**: part 2.
- **Check**: `pnpm --filter zelavis run build; echo "exit $?"`, `pnpm --filter zelavis exec node --test --test-reporter=dot test/identity-registration.test.mjs test/identity-atomicity.test.mjs test/core-password-auth.test.mjs test/app-auth-service.test.mjs test/email-service.test.mjs; echo "exit $?"`; both `exit 0`.

### 2. Add the single-use account token repository

- **Goal**: `accountTokens` on all three backends with atomic `consume`.
- **Files**: `packages/zelavis/src/app/identity/domain/entities.ts` (add `AccountToken`), `contracts/repositories.ts` (add `AccountTokenRepository`, field `accountTokens`), `storage/in-memory.ts:261`, `storage/database.ts:303`, `packages/zelavis/src/platform/auth-repositories.ts:122`; `packages/zelavis/test/identity-atomicity.test.mjs`.
- **Change**: implement per section 2. Add atomicity tests: 32 concurrent `consume` calls for one token across each backend → exactly one non-null; expired → null; wrong purpose → null and token still consumable with the right purpose; `create` with an existing hash → `IdentityConflictError`.
- **Depends on**: 1.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/identity-atomicity.test.mjs; echo "exit $?"` prints `exit 0`.

### 3. Add account messages and the provider API additions

- **Goal**: identity can issue tokens and enqueue identity emails.
- **Files**: **NEW** `packages/zelavis/src/app/identity/services/account-messages.ts`; `contracts/credential-provider.ts:52-81`; `services/authentication-service.ts:116-146`; `core/create-identity.ts:32-53` (option `messages?: AccountMessagesPort`); `packages/zelavis/src/index.ts` (Platform identity composition `:1619-1700` and App `:6924-6950` pass the runtime's `EmailOutbox` from part 2); `packages/zelavis/src/app/app-service.ts:118-160`.
- **Change**: `createAccountMessages(outbox: EmailOutbox, runtimeName: string): AccountMessagesPort` building subject, text and HTML per kind, with HTML escaping; `providerApi()` adds `tokens` (hash with SHA-256 base64url; random 32 bytes) and `messages` when the port exists.
- **Depends on**: 2.
- **Check**: rebuild; `pnpm --filter zelavis run build; echo "exit $?"` and `pnpm --filter zelavis exec node --test test/core-password-auth.test.mjs; echo "exit $?"` print `exit 0`.

### 4. Move password recovery onto tokens and email

- **Goal**: recovery per section 2 flows 5-7; old metadata path deleted.
- **Files**: `packages/zelavis/src/app/identity/providers/password.ts:28`, `:40-53`, `:81-94`, `:171-234`; `contracts/credential-provider.ts:46-50`; `identity-service.ts:621-637`; **NEW** `packages/zelavis/test/identity-recovery.test.mjs`.
- **Change**: rewrite `beginRecovery`/`completeRecovery` with `api.tokens` and `api.messages`; always attach them (no `options.recovery` gate); delete `RECOVERY_METADATA_KEY`. Recovery providers route filters on email availability.
- **Depends on**: 3.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/identity-recovery.test.mjs test/core-password-auth.test.mjs; echo "exit $?"` prints `exit 0`.

### 5. Add email verification and the registration policy field

- **Goal**: flows 1-4 and the `emailVerification` setting.
- **Files**: `domain/registration.ts:7-58`; `services/registration-service.ts:108-110`, `:164-176`, `:399-459`; `services/authentication-service.ts:199`, `:340`; `core/errors.ts`; **NEW** `packages/zelavis/test/identity-email-verification.test.mjs`.
- **Change**: as section 2. Keep `schemaVersion: 1`; new field optional.
- **Depends on**: 4.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/identity-email-verification.test.mjs test/identity-registration.test.mjs; echo "exit $?"` prints `exit 0`.

### 6. Expose the operations and the App public routes

- **Goal**: HTTP routes of section 3 on every runtime and on App origins.
- **Files**: `packages/zelavis/src/app/identity/identity-service.ts` (new routes beside `:755-800`, signup response `:610-619`); `packages/zelavis/src/platform/project-public-auth.ts:11-17`; `packages/zelavis/test/platform-public-domain-forwarding.test.mjs`.
- **Change**: add `auth.email.verify` and `auth.email.verification.resend` with `maxRequestBodyBytes: 4096`; signup omits `set-cookie` and `session` when `verificationRequired`. Extend the allowlist sets.
- **Depends on**: 5.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/platform-public-domain-forwarding.test.mjs test/identity-email-verification.test.mjs; echo "exit $?"` prints `exit 0`.

### 7. Add SDK and CLI parity

- **Goal**: section 3 SDK and CLI forms.
- **Files**: `packages/zelavis/src/sdk/fetch.ts:350-370`, `:2232-2280`; `packages/zelavis/src/cli/auth-operations.ts:5`, `:12-48`.
- **Change**: add `verifyEmail`, `resendVerification`; make `ZelavisAuthSessionResult.session` optional with `verificationRequired?: true` (find the type with `rg -n "ZelavisAuthSessionResult" packages/zelavis/src/sdk/fetch.ts`), then fix every caller the typecheck reports (`pnpm run typecheck` from root). CLI actions `verify-email`, `resend-verification`.
- **Depends on**: 6.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/capability-parity.test.mjs; echo "exit $?"`; `pnpm run typecheck; echo "exit $?"`; both `exit 0`.

### 8. Add Platform dashboard pages

- **Goal**: Forgot password, Reset password and Verify email on the Platform.
- **Files**: `packages/zelavis/services/zelavis-ui/app/auth-pages.ts` (new screens after `:110`), `packages/zelavis/services/zelavis-ui/src/auth-routes.ts:2`, `app/dashboard-routes.ts:7-12`, `app/screens.ts` (route to the screens; find where `signUpScreen` is dispatched), `app/registration-settings.ts` (add the "Require verified email" control), `scripts/test-embedded-server-views.mjs` or `scripts/test-route-parity.mjs`.
- **Change**: Login shows "Forgot password?" only when `GET /auth/recovery/providers` includes `password`. `/reset-password` reads `location.hash` token, clears it with `history.replaceState`, asks for the new password twice, posts to complete, then links to Login. `/verify-email` reads the token, posts verify, shows the result. Signup with `verificationRequired` shows "Check your email". Login maps `email_verification_required` to a message with a Resend button.
- **Depends on**: 7.
- **Check**: `pnpm --filter @zelavis/ui typecheck; echo "exit $?"`, `pnpm --filter @zelavis/ui test; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`; all `exit 0`.

### 9. Add App site pages

- **Goal**: the same three pages on App origins.
- **Files**: `packages/zelavis/services/zelavis-ui/src/identity-frontend-service.ts:7` (add paths and their renderers), `app/identity-site.ts:12` (operations `recovery/password`, `recovery/password/complete`, `email/verify`, `email/verification`), `scripts/build-identity-site.mjs` if pages are generated there (check), `scripts/test-embedded-server-views.mjs`.
- **Change**: mirror step 8 in the server-rendered identity site; the forms post to the App's own API base (`main[data-api]`).
- **Depends on**: 8.
- **Check**: as step 8.

### 10. Document verification and recovery

- **Goal**: docs match behavior.
- **Files**: `website/src/content/docs/packages/auth.md` (recovery section near `:231`), `website/src/content/docs/architecture/access-control.md`, `website/src/content/docs/guides/email-delivery.md` (from part 2).
- **Change**: flows, token lifetimes, single use, fragment links, the policy, owner exemption, "email change is not supported yet".
- **Depends on**: 9.
- **Check**: `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 11. Self-audit

- **Goal**: Done means holds.
- **Change**: section 8 self-audit list.
- **Check**: `pnpm run verify; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, `git diff --check; echo "exit $?"`; all `exit 0`.

## 5. Tests

`test/identity-recovery.test.mjs` (each backend, as `identity-registration.test.mjs:25-29`; outbox stub recording messages, or the real outbox with the SMTP fixture from part 2):
- Begin for an email identifier → one `password-recovery` message whose link is `<linkBase>/reset-password#token=…`; begin for an unknown identifier → same 202 body, no message.
- Complete with the token and a new password → old password fails, new works, every earlier session is rejected.
- Two concurrent completes with one token → one 204, one 400 `invalid_token`.
- Expired token (injected `now`) → 400.
- Username-only account → 202, no message.
- Email disabled → `GET /auth/recovery/providers` excludes `password`; begin still 202 and sends nothing.
- Rate limit: sixth begin within an hour for one identifier → still 202, no sixth message.

`test/identity-email-verification.test.mjs`:
- Signup with email, policy optional → session issued, verification message sent; verify → `verified: true`; reuse → 400.
- Policy required → signup 201 with `verificationRequired: true`, no cookie; sign-in → 403 `email_verification_required`; after verify, sign-in works.
- Owner and service accounts sign in under `required` while unverified.
- Token for an old email after the account's email changed in the store → 400, `verified` unchanged.
- Settings CAS: setting `emailVerification` bumps revision; stale revision → 409; a stored control without the field reads as `"optional"`.
- App runtime: policy and tokens independent from the Platform's.

`test/platform-public-domain-forwarding.test.mjs`: the new public routes reach the App on its verified host; `/auth/accounts` and settings routes stay refused there.

Browser (`scripts/test-embedded-server-views.mjs`, Playwright chromium, 1440×1000 and 390×844): with the SMTP fixture, Forgot password → read the link from the fixture → open it → reset → sign in with the new password; signup under `required` shows the check-email message, the emailed link verifies, then login succeeds. Repeat on an App origin in the existing App public auth flow. Wait for each page's own result message before reading state back.

## 6. Docs and project notes

`website/src/content/docs/packages/auth.md`, `architecture/access-control.md`, `guides/email-delivery.md`. No `pnotes/TODO.md` additions.

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
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims; silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; literal unlimited Effect concurrency; unchecked `JSON.parse` casts; new `async` functions, `new Promise` or Promise coordination in Platform code, and any growth of `scripts/effect-migration-baseline.json`; `node:` imports outside `src/adapters` (and the CLI); the `effect` barrel in files the Project persistent host loads; React for a dashboard page; edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`; tokens, passwords or message bodies in logs, responses, URLs sent to a server, or security events. Never edit generated output. Do not commit, push or publish unless told to.
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
